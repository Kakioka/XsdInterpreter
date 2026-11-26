// test/navModel.test.mjs — dev/IMPLEMENTATION_ORDER.md Phase 5.
//
// The nav tree as data (js/core/navModel.js), the manifest-order helpers it
// and the XML writer rely on (parser.js sortInstanceKeys / insertInstanceKey),
// and the two PacketManifest fields parity 3.3 added. js/ui/sidebar.js only
// renders what buildNavModel returns, so this is where the tree's behavior is
// pinned down.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

import { loadSamplePipeline, loadSampleXml, repoPath } from './helpers/env.mjs';

const pipeline = await loadSamplePipeline();
const { flattenFromRoot, sourceFileKey } = await import('../js/core/flattener.js');
const { analyzePacket, sortInstanceKeys, insertInstanceKey, siblingIndexOf, SchemaParser } = await import('../js/core/parser.js');
const { buildNavModel, filterNavModel, actionableNodes, sectionLabel, isAddableSection } = await import('../js/core/navModel.js');
const { FormInstanceKey } = await import('../js/core/formEngine.js');
const { readPacket } = await import('../js/core/xmlReader.js');
const { buildPacketXml } = await import('../js/core/xmlWriter.js');

// The production set (sample-schemas/SampleSchema/): nested folders, a
// ReturnDataState wrapper, a fixed stateSchemaVersion on the root.
const prodFiles = new Map();
for (const entry of await readdir(repoPath('sample-schemas', 'SampleSchema'), { recursive: true })) {
  if (entry.endsWith('.xsd')) prodFiles.set(entry.replaceAll('\\', '/'), await readFile(repoPath('sample-schemas', 'SampleSchema', entry), 'utf8'));
}
const prodFlat = flattenFromRoot(prodFiles, 'HIIndividual/IndividualReturnHIN11.xsd');
const prod = analyzePacket(prodFlat.doc, 'ReturnState', prodFlat);

const K = (formName, instanceId) => new FormInstanceKey(formName, instanceId);
const strings = (keys) => keys.map(String);

// ---------------------------------------------------------------------------
// PacketManifest: schemaVersion, sourceSchemaFile (parity 3.3)
// ---------------------------------------------------------------------------

test('flattener records the declaring file of every top-level component', () => {
  const { sourceFiles } = pipeline;
  assert.equal(sourceFiles.get(sourceFileKey('element', 'SamplePacket')), 'SamplePacket.xsd');
  assert.ok([...sourceFiles.values()].includes('SampleCommonTypes.xsd'));
  assert.equal(prodFlat.sourceFiles.get(sourceFileKey('element', 'FormN11')), 'HIIndividual/HIForms/FormN11.xsd', 'nested folders keep their relative path');
});

test('sourceSchemaFile: a ref section names its global element file; an inline one, the file holding it', () => {
  const header = pipeline.manifest.sections.find((s) => s.elementName === 'SampleHeader');
  const summary = pipeline.manifest.sections.find((s) => s.elementName === 'SampleSummary');
  assert.equal(header.sourceSchemaFile, 'SamplePacket.xsd');
  assert.equal(summary.sourceSchemaFile, 'SamplePacket.xsd', 'inline-declared inside the root element');

  const returnData = prod.sections.find((s) => s.elementName === 'ReturnDataState');
  assert.equal(returnData.sourceSchemaFile, 'HIIndividual/ReturnDataHIN11.xsd');
  assert.equal(returnData.childForms.find((s) => s.elementName === 'IRSW2').sourceSchemaFile, 'StateIndividual/IRSForms/IRSW2.xsd');
});

test('sourceSchemaFile is empty, not wrong, when analyzePacket is not given the flatten result', () => {
  const bare = analyzePacket(prodFlat.doc, 'ReturnState');
  assert.equal(bare.sections[0].sourceSchemaFile, '');
});

test('schemaVersion: a fixed …Version attribute on the packet root wins', () => {
  assert.equal(prod.schemaVersion, 'HIIndividual2025V1.0');
  assert.equal(prod.schemaVersionAttribute, 'stateSchemaVersion');
  assert.deepEqual(prod.fixedAttributes, [{ name: 'stateSchemaVersion', value: 'HIIndividual2025V1.0' }]);
});

test('schemaVersion: falls back to xs:schema/@version, and is empty when neither exists', async () => {
  assert.equal(pipeline.manifest.schemaVersion, '', 'the synthetic fixture declares no version');
  assert.equal(pipeline.manifest.schemaVersionAttribute, null);

  const xsd = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" version="3.2">
    <xs:element name="Root"><xs:complexType><xs:sequence><xs:element name="A" type="xs:string"/></xs:sequence>
      <xs:attribute name="kind" type="xs:string" fixed="always"/></xs:complexType></xs:element></xs:schema>`;
  const flat = flattenFromRoot(new Map([['Root.xsd', xsd]]), 'Root.xsd');
  const m = analyzePacket(flat.doc, 'Root', flat);
  assert.equal(m.schemaVersion, '3.2');
  assert.equal(m.schemaVersionAttribute, null, 'a fixed attribute without "version" in its name is not a version');
  assert.deepEqual(m.fixedAttributes, [{ name: 'kind', value: 'always' }], 'but it is still written on the root');
});

// ---------------------------------------------------------------------------
// Manifest order
// ---------------------------------------------------------------------------

const SAMPLE = pipeline.manifest.sections; // Header, Entity, Financial, EventLog (repeatable), Summary

test('sortInstanceKeys: manifest order across forms, stable within one form, unknown forms last', () => {
  const keys = [K('SampleSummary'), K('SampleEventLog', 'b'), K('Nope'), K('SampleHeader'), K('SampleEventLog', 'a')];
  assert.deepEqual(strings(sortInstanceKeys(SAMPLE, keys)), [
    'SampleHeader',
    'SampleEventLog#b',
    'SampleEventLog#a',
    'SampleSummary',
    'Nope',
  ]);
});

test('insertInstanceKey: a first instance lands at its manifest position, not the end', () => {
  const keys = [K('SampleHeader'), K('SampleEntityForm'), K('SampleFinancialForm'), K('SampleSummary')];
  const landed = insertInstanceKey(SAMPLE, keys, K('SampleEventLog', 'x'));
  assert.equal(landed, 0);
  assert.deepEqual(strings(keys), ['SampleHeader', 'SampleEntityForm', 'SampleFinancialForm', 'SampleEventLog#x', 'SampleSummary']);
});

test('insertInstanceKey: later instances append after their siblings, or go where asked', () => {
  const keys = [K('SampleHeader'), K('SampleEventLog', 'a'), K('SampleEventLog', 'b'), K('SampleSummary')];
  assert.equal(insertInstanceKey(SAMPLE, keys, K('SampleEventLog', 'c')), 2);
  assert.equal(insertInstanceKey(SAMPLE, keys, K('SampleEventLog', 'first'), 0), 0);
  assert.equal(insertInstanceKey(SAMPLE, keys, K('SampleEventLog', 'far'), 99), 4, 'past the end is clamped');
  assert.deepEqual(strings(keys), [
    'SampleHeader',
    'SampleEventLog#first',
    'SampleEventLog#a',
    'SampleEventLog#b',
    'SampleEventLog#c',
    'SampleEventLog#far',
    'SampleSummary',
  ]);
  assert.equal(siblingIndexOf(keys, K('SampleEventLog', 'b')), 2);
  assert.equal(siblingIndexOf(keys, K('SampleSummary')), 0);
  assert.equal(siblingIndexOf(keys, K('SampleEventLog', 'gone')), -1);
});

test('insertInstanceKey finds the position inside a wrapper section', () => {
  const keys = [K('AuthenticationHeader'), K('ReturnHeaderState'), K('FormN11')];
  insertInstanceKey(prod.sections, keys, K('BinaryAttachment', 'att'));
  insertInstanceKey(prod.sections, keys, K('IRSW2', 'w2'));
  insertInstanceKey(prod.sections, keys, K('SchCR'));
  assert.deepEqual(strings(keys), ['AuthenticationHeader', 'ReturnHeaderState', 'FormN11', 'SchCR', 'IRSW2#w2', 'BinaryAttachment#att']);
});

// ---------------------------------------------------------------------------
// buildNavModel (parity 3.2)
// ---------------------------------------------------------------------------

/** Compact view of a model: [label, flags] for rows, [label, children] for groups. */
function outline(nodes) {
  return nodes.map((n) =>
    n.type === 'group' ? { group: n.label, children: outline(n.children) } : `${n.type === 'missing' ? '? ' : ''}${n.label}${n.removable ? ' ×' : ''}`
  );
}

test('wrapper sections become groups holding their forms, in manifest order', () => {
  const keys = [K('AuthenticationHeader'), K('ReturnHeaderState'), K('FormN11'), K('SchCR'), K('BinaryAttachment', 'a1')];
  assert.deepEqual(outline(buildNavModel(prod, keys)), [
    'AuthenticationHeader',
    'ReturnHeaderState',
    { group: 'ReturnDataState', children: ['FormN11', 'SCHEDULE OF TAX CREDITS ×'] },
    'Binary Attachment ×',
  ]);
});

test('labels use the description, falling back to the element name', () => {
  const schCR = prod.sections[2].childForms.find((s) => s.elementName === 'SchCR');
  assert.equal(sectionLabel(schCR), 'SCHEDULE OF TAX CREDITS');
  assert.equal(sectionLabel(prod.sections[0]), 'AuthenticationHeader');
});

test('repeatable instances are numbered contiguously, and a lone one is not numbered', () => {
  const base = [K('AuthenticationHeader'), K('ReturnHeaderState'), K('FormN11')];
  const w2s = (...ids) => [...base, ...ids.map((id) => K('IRSW2', id))];
  const w2Rows = (keys) => buildNavModel(prod, keys)[2].children.filter((n) => n.section.elementName === 'IRSW2');

  assert.deepEqual(w2Rows(w2s('x')).map((n) => [n.label, n.ordinal]), [['IRS Form W-2', null]]);
  assert.deepEqual(
    w2Rows(w2s('x', 'y', 'z')).map((n) => n.label),
    ['IRS Form W-2 (1)', 'IRS Form W-2 (2)', 'IRS Form W-2 (3)']
  );
  // Removing the middle one renumbers what is left — no gap at (2).
  assert.deepEqual(
    w2Rows(w2s('x', 'z')).map((n) => [n.label, n.key.instanceId]),
    [['IRS Form W-2 (1)', 'x'], ['IRS Form W-2 (2)', 'z']]
  );
});

test('required vs optional is carried on every row', () => {
  const nodes = buildNavModel(prod, [K('AuthenticationHeader'), K('ReturnHeaderState'), K('FormN11'), K('SchCR')]);
  const rd = nodes[2];
  assert.equal(rd.isRequired, true);
  assert.deepEqual(rd.children.map((n) => [n.section.elementName, n.isRequired, n.removable]), [
    ['FormN11', true, false],
    ['SchCR', false, true],
  ]);
});

test('a required form with no instance gets a "missing" placeholder row', () => {
  const keys = [K('SampleHeader'), K('SampleEntityForm'), K('SampleFinancialForm'), K('SampleSummary')];
  const nodes = buildNavModel(pipeline.manifest, keys);
  assert.deepEqual(
    nodes.map((n) => `${n.type}:${n.section.elementName}`),
    ['instance:SampleHeader', 'instance:SampleEntityForm', 'instance:SampleFinancialForm', 'missing:SampleEventLog', 'instance:SampleSummary']
  );
  const withOne = buildNavModel(pipeline.manifest, [...keys.slice(0, 3), K('SampleEventLog', 'e1'), keys[3]]);
  assert.ok(!withOne.some((n) => n.type === 'missing'), 'the placeholder goes once an instance exists');
});

test('no placeholder for a required form inside an OPTIONAL wrapper (activation, §22 invariant 30)', () => {
  const manifest = {
    sections: [
      {
        elementName: 'OptionalWrapper', description: '', isRequired: false, isRepeatable: false, maxOccurs: 1,
        childForms: [{ elementName: 'Inner', description: '', isRequired: true, isRepeatable: true, maxOccurs: -1, childForms: [] }],
      },
    ],
  };
  assert.deepEqual(buildNavModel(manifest, []), [], 'and an empty group is not shown at all');
});

test('a key naming no manifest form still gets a row', () => {
  const nodes = buildNavModel(pipeline.manifest, [K('SampleHeader'), K('Ghost', 'g1')]);
  const ghost = nodes.at(-1);
  assert.equal(ghost.type, 'instance');
  assert.equal(ghost.label, 'Ghost#g1');
  assert.equal(ghost.removable, false);
});

test('isAddableSection: repeatable up to maxOccurs; non-repeatable only when optional and absent', () => {
  assert.equal(isAddableSection({ isRepeatable: true, maxOccurs: -1 }, 40), true);
  assert.equal(isAddableSection({ isRepeatable: true, maxOccurs: 2 }, 2), false);
  assert.equal(isAddableSection({ isRepeatable: false, isRequired: false }, 0), true);
  assert.equal(isAddableSection({ isRepeatable: false, isRequired: false }, 1), false);
  assert.equal(isAddableSection({ isRepeatable: false, isRequired: true }, 0), false);
});

// ---------------------------------------------------------------------------
// filterNavModel (backlog D.3)
// ---------------------------------------------------------------------------

const PROD_KEYS = [
  K('AuthenticationHeader'), K('ReturnHeaderState'), K('FormN11'), K('SchCR'),
  K('IRSW2', 'W2-employer-a'), K('IRSW2', 'W2-employer-b'), K('BinaryAttachment', 'att1'),
];

test('filter keeps matching rows and the groups leading to them', () => {
  const model = buildNavModel(prod, PROD_KEYS);
  assert.deepEqual(outline(filterNavModel(model, 'w-2')), [{ group: 'ReturnDataState', children: ['IRS Form W-2 (1) ×', 'IRS Form W-2 (2) ×'] }]);
  assert.deepEqual(outline(filterNavModel(model, 'BINARY')), ['Binary Attachment ×'], 'case-insensitive');
});

test('filter matches element name, description and instance id, not just the label', () => {
  const model = buildNavModel(prod, PROD_KEYS);
  assert.deepEqual(actionableNodes(filterNavModel(model, 'schcr')).map((n) => n.section.elementName), ['SchCR']);
  assert.deepEqual(actionableNodes(filterNavModel(model, 'employer-b')).map((n) => n.label), ['IRS Form W-2 (2)'], 'numbering is the unfiltered one');
});

test('filter on a group name keeps everything in that group', () => {
  const model = buildNavModel(prod, PROD_KEYS);
  const [rd] = filterNavModel(model, 'returndata');
  assert.equal(rd.children.length, 4);
});

test('a blank filter returns the model untouched; no match returns nothing', () => {
  const model = buildNavModel(prod, PROD_KEYS);
  assert.equal(filterNavModel(model, '   '), model);
  assert.deepEqual(filterNavModel(model, 'zzz-no-such-form'), []);
});

// ---------------------------------------------------------------------------
// The writer side of manifest order and fixed root attributes
// ---------------------------------------------------------------------------

test('buildPacketXml writes forms in manifest order whatever order the keys arrive in', async () => {
  const states = readPacket(await loadSampleXml(), pipeline.manifest, pipeline.parser);
  const keys = [...states.keys()].map((k) => FormInstanceKey.parse(k)).reverse();
  const xml = buildPacketXml(pipeline.manifest, states, keys, pipeline.parser, pipeline.targetNamespace);
  const root = new DOMParser().parseFromString(xml, 'application/xml').documentElement;
  const tags = [...root.children].map((c) => c.localName);
  assert.deepEqual(tags, ['SampleHeader', 'SampleEntityForm', 'SampleFinancialForm', 'SampleEventLog', 'SampleEventLog', 'SampleSummary']);
  const ids = [...root.children].filter((c) => c.localName === 'SampleEventLog').map((c) => c.getAttribute('documentId'));
  assert.deepEqual(ids, [...states.keys()].filter((k) => k.startsWith('SampleEventLog')).map((k) => FormInstanceKey.parse(k).instanceId).reverse(),
    'instances of one form keep the order they were given in');
});

test('buildPacketXml stamps the packet root with its fixed attributes', () => {
  const parser = new SchemaParser(prodFlat.doc, 'ReturnState');
  const xml = buildPacketXml(prod, new Map(), [], parser, prodFlat.targetNamespace);
  const root = new DOMParser().parseFromString(xml, 'application/xml').documentElement;
  assert.equal(root.localName, 'ReturnState');
  assert.equal(root.getAttribute('stateSchemaVersion'), 'HIIndividual2025V1.0');
});
