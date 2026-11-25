// test/instanceIdentity.test.mjs — where a repeatable form's instance id comes
// from: parser.js's selectInstanceIdSource, js/core/instanceIdentity.js, and
// the remembered-id half of js/core/settingsStore.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

import { installLocalStorage, repoPath, emptyFormState } from './helpers/env.mjs';
import { loadXmlDom } from './helpers/xmlDom.mjs';

await loadXmlDom();
installLocalStorage();
const { SchemaParser, analyzePacket, selectInstanceIdSource } = await import('../js/core/parser.js');
const { flattenFromRoot } = await import('../js/core/flattener.js');
const { readPacket } = await import('../js/core/xmlReader.js');
const { buildPacketXml } = await import('../js/core/xmlWriter.js');
const { FormInstanceKey, keyOf } = await import('../js/core/formEngine.js');
const { findInstanceIdAttribute, generateInstanceId, canHoldInstanceId } = await import('../js/core/instanceIdentity.js');
const store = await import('../js/core/settingsStore.js');

/** A packet with one repeatable form, Log, carrying the given attributes. */
function packet(attributes, setting = null, types = '') {
  const doc = new DOMParser().parseFromString(
    `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">${types}
       <xs:element name="Root"><xs:complexType><xs:sequence><xs:element ref="Log" maxOccurs="unbounded"/></xs:sequence></xs:complexType></xs:element>
       <xs:element name="Log"><xs:complexType><xs:sequence><xs:element name="Title" type="xs:string"/></xs:sequence>${attributes}</xs:complexType></xs:element>
     </xs:schema>`,
    'application/xml'
  );
  const parser = new SchemaParser(doc, 'Root', setting);
  const manifest = analyzePacket(doc, 'Root');
  return { parser, manifest, idAttr: findInstanceIdAttribute(parser.parseGlobalElement('Log')) };
}
const attr = (name, type = 'xs:string', use = 'optional') => `<xs:attribute name="${name}" type="${type}" use="${use}"/>`;
const sourceOf = (attributes, setting) => packet(attributes, setting).idAttr?.elementName ?? null;

test('heuristic: xs:ID type, then required id-like, then optional id-like', () => {
  assert.equal(sourceOf(attr('recordId', 'xs:string', 'required') + attr('anchor', 'xs:ID')), 'anchor');
  assert.equal(sourceOf(attr('softwareId') + attr('recordId', 'xs:string', 'required')), 'recordId');
  assert.equal(sourceOf(attr('version') + attr('record_id')), 'record_id');
  assert.equal(sourceOf(attr('id')), 'id');
  assert.equal(sourceOf(attr('lineNum', 'xs:integer', 'required')), null);
});

test('heuristic: words ending in "id" and references to other elements are not ids', () => {
  assert.equal(sourceOf(attr('paid', 'xs:string', 'required') + attr('valid')), null);
  assert.equal(sourceOf(attr('referenceDocumentId') + attr('ownerId', 'xs:IDREF')), null);
});

test('override: a named attribute, or none at all', () => {
  const attributes = attr('recordId') + attr('lineNum', 'xs:integer');
  assert.equal(sourceOf(attributes, { mode: 'attribute', name: 'lineNum' }), 'lineNum');
  assert.equal(sourceOf(attributes, { mode: 'attribute', name: 'absent' }), null);
  assert.equal(sourceOf(attributes, { mode: 'none' }), null);
  assert.equal(sourceOf(attributes, { mode: 'auto' }), 'recordId');
  assert.equal(selectInstanceIdSource([]), null);
});

test('real schema set: every repeatable form still resolves to the attribute it always used', async () => {
  const files = new Map();
  for (const entry of await readdir(repoPath('sample-schemas', 'SampleSchema'), { recursive: true })) {
    if (entry.endsWith('.xsd')) files.set(entry.replaceAll('\\', '/'), await readFile(repoPath('sample-schemas', 'SampleSchema', entry), 'utf8'));
  }
  const { doc } = flattenFromRoot(files, 'HIIndividual/IndividualReturnHIN11.xsd');
  const parser = new SchemaParser(doc, 'ReturnState');
  const manifest = analyzePacket(doc, 'ReturnState');
  const forms = [];
  const walk = (sections) => sections.forEach((s) => (s.childForms.length ? walk(s.childForms) : s.isRepeatable && forms.push(s.elementName)));
  walk(manifest.sections);
  assert.ok(forms.length > 10, `found ${forms.length}`);
  for (const form of forms) {
    const element = parser.parseGlobalElement(form);
    const declares = element.children.some((c) => c.isAttribute && c.elementName === 'documentId');
    assert.equal(findInstanceIdAttribute(element)?.elementName ?? null, declares ? 'documentId' : null, form);
  }
});

test('generated ids are legal for the attribute that will carry them', () => {
  const generate = (type, taken, types) => generateInstanceId('Log', packet(attr('recordId', type), null, types).idAttr, taken);
  assert.equal(generate('xs:ID'), 'Log-1');
  assert.equal(generate('xs:positiveInteger'), '1');
  assert.equal(generate('xs:positiveInteger', ['1', '2']), '3');
  assert.equal(generate('xs:string', ['log-1']), 'Log-2', 'case-insensitive, like FormInstanceKey');
  const short = '<xs:simpleType name="Short"><xs:restriction base="xs:string"><xs:maxLength value="3"/></xs:restriction></xs:simpleType>';
  assert.equal(generate('Short', [], short), '1');
  assert.equal(generateInstanceId('Log', null), 'Log-1');
});

test('canHoldInstanceId refuses values that would be invalid XML', () => {
  const holds = (type, id) => canHoldInstanceId(packet(attr('recordId', type)).idAttr, id);
  assert.equal(holds('xs:ID', '9f1c'), false);
  assert.equal(holds('xs:integer', 'Log-1'), false);
  assert.equal(holds('xs:string', 'Log-1'), true);
});

test('reading uses the chosen attribute, and generates stable ids where it is absent', () => {
  const { parser, manifest } = packet(attr('recordId'));
  const xml = '<Root><Log recordId="A"><Title>1</Title></Log><Log><Title>2</Title></Log></Root>';
  const keys = () => [...readPacket(xml, manifest, parser).keys()];
  assert.deepEqual(keys(), ['Log#A', 'Log#Log-1']);
  assert.deepEqual(keys(), keys());
});

test('duplicate identity values never drop a form, and round-trip unchanged', () => {
  const { parser, manifest } = packet(attr('recordId'));
  const states = readPacket('<Root><Log recordId="A"><Title>1</Title></Log><Log recordId="a"><Title>2</Title></Log><Log recordId="Log"><Title>3</Title></Log></Root>', manifest, parser);
  assert.equal(states.size, 3);
  const keys = [...states.keys()].map((k) => FormInstanceKey.parse(k));
  assert.equal(new Set(keys.map(keyOf)).size, 3);
  const written = new DOMParser().parseFromString(buildPacketXml(manifest, states, keys, parser), 'application/xml');
  assert.deepEqual([...written.documentElement.children].map((el) => el.getAttribute('recordId')), ['A', 'a', 'Log']);
});

test('the writer backfills an id only where it is legal', () => {
  const write = (type, id) => {
    const { parser, manifest } = packet(attr('recordId', type));
    const key = new FormInstanceKey('Log', id);
    const xml = buildPacketXml(manifest, new Map([[key.toString(), emptyFormState({ 'log.title': 'x' })]]), [key], parser);
    return new DOMParser().parseFromString(xml, 'application/xml').documentElement.children[0].getAttribute('recordId');
  };
  assert.equal(write('xs:string', 'Log-1'), 'Log-1');
  assert.equal(write('xs:integer', 'Log-1'), null);
});

test('no identity attribute: ids survive save and reload, outside the XML', () => {
  const { parser, manifest } = packet('');
  const keys = ['Log-2', 'Log-5'].map((id) => new FormInstanceKey('Log', id));
  const states = new Map(keys.map((k, i) => [k.toString(), emptyFormState({ 'log.title': `t${i}` })]));
  const xml = buildPacketXml(manifest, states, keys, parser);
  assert.doesNotMatch(xml, /Log-/);

  store.rememberInstanceIds('schema', xml, keys);
  const reload = (text) => [...readPacket(text, manifest, parser, store.recallInstanceIds('schema', text)).keys()];
  assert.deepEqual(reload(xml), ['Log#Log-2', 'Log#Log-5']);
  assert.deepEqual(reload(`<?xml version="1.0" encoding="UTF-8"?>\r\n${xml.replaceAll('\n', '\r\n')}`), ['Log#Log-2', 'Log#Log-5'], 'packaged or re-saved copy');
  assert.deepEqual(reload(xml.replace('t0', 'edited')), ['Log#Log-1', 'Log#Log-2'], 'an edited document is not recognized');
  assert.deepEqual(store.recallInstanceIds('other schema', xml), {});
});

test('schema settings: one key across folder-picker path styles, merged, bounded', () => {
  assert.equal(store.schemaSettingsKey('urn:x', 'Folder/a/Root.xsd', 'R'), store.schemaSettingsKey('urn:x', 'a/Root.xsd', 'R'));
  assert.notEqual(store.schemaSettingsKey('urn:x', 'Root.xsd', 'R'), store.schemaSettingsKey(null, 'Root.xsd', 'R'));
  store.updateSchemaSettings('s', { instanceIdSource: { mode: 'none' } });
  store.updateSchemaSettings('s', { exportProfileId: 'p' });
  for (let i = 0; i < 25; i++) store.rememberInstanceIds('s', `<r>${i}</r>`, [new FormInstanceKey('Log', `${i}`)]);
  const settings = store.loadSchemaSettings('s');
  assert.deepEqual(settings.instanceIdSource, { mode: 'none' });
  assert.equal(settings.exportProfileId, 'p');
  assert.equal(settings.savedDocuments.length, 20);
  assert.deepEqual(store.recallInstanceIds('s', '<r>24</r>'), { Log: ['24'] });
});

test('packaging values are kept per profile, and pre-profile values still load', () => {
  store.saveLastPackagingSettings({ id: 'a' }, { x: '1' });
  store.saveLastPackagingSettings({ id: 'b' }, { x: '2' });
  assert.deepEqual(store.loadLastPackagingSettings('a'), { x: '1' });
  assert.equal(store.loadLastPackagingSettings('c'), null);
  localStorage.setItem('xmlEditor.lastPackagingSettings', '{"efin":"123456"}');
  assert.deepEqual(store.loadLastPackagingSettings('a'), { efin: '123456' });
});

test('remember: false values are never stored, and earlier stored ones are deleted', () => {
  const KEY = 'xmlEditor.lastPackagingSettings';
  const profile = { id: 'a', fields: [{ id: 'secret', remember: false }, { id: 'x' }] };
  store.saveLastPackagingSettings(profile, { secret: '123456789', x: '1' });
  assert.doesNotMatch(localStorage.getItem(KEY), /secret|123456789/);
  assert.deepEqual(store.loadLastPackagingSettings('a'), { x: '1' });

  for (const old of [{ secret: '123456789', x: '1' }, { byProfile: { a: { secret: '123456789', x: '1' }, other: { x: '2' } } }]) {
    localStorage.setItem(KEY, JSON.stringify(old));
    store.forgetUnrememberedValues([profile]);
    assert.doesNotMatch(localStorage.getItem(KEY), /secret|123456789/);
    assert.deepEqual(store.loadLastPackagingSettings('a'), { x: '1' }, 'the rest is kept');
  }
  assert.deepEqual(store.loadLastPackagingSettings('other'), { x: '2' });
});

test('unusable storage degrades to no persistence rather than an exception', () => {
  installLocalStorage({ throwOnAccess: true });
  assert.equal(store.updateSchemaSettings('s', {}), false);
  assert.deepEqual(store.loadSchemaSettings('s'), {});
  assert.equal(store.saveLastPackagingSettings({ id: 'a' }, {}), false);
  assert.equal(store.loadLastPackagingSettings('a'), null);
  assert.deepEqual(store.loadUserProfiles(), []);
  installLocalStorage();
});
