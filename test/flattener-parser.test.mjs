// test/flattener-parser.test.mjs — js/core/flattener.js + js/core/parser.js.
//
// Ported from dev/phase1-check.html, which checks parser output against the
// facts documented in sample-schemas/WALKTHROUGH.md. The browser harness stays
// as-is (it also dumps the parsed trees for manual spot-checking); this is the
// headless half, so a parser change can be checked without opening a browser.

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadSamplePipeline, loadSampleSchemaFiles, findByName } from './helpers/env.mjs';
import { loadXmlDom } from './helpers/xmlDom.mjs';

const pipeline = await loadSamplePipeline();
const { flatDoc, parser, manifest } = pipeline;

test('BOM scan reports nothing for the clean sample files', async () => {
  const { scanForBom, stripBom } = await import('../js/core/flattener.js');
  assert.deepEqual(scanForBom(await loadSampleSchemaFiles()), []);

  // The scan/strip pair itself, on a file that does have one.
  const withBom = `﻿<?xml version="1.0"?><root/>`;
  const hits = scanForBom(new Map([['Bommed.xsd', withBom]]));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, 'Bommed.xsd');
  assert.equal(stripBom(withBom).startsWith('<?xml'), true);
});

test('BOM scan reports interior marks whether or not a leading BOM is present (parity 1.11)', async () => {
  const { scanForBom, stripBom } = await import('../js/core/flattener.js');
  const BOM = '﻿';
  const files = new Map([
    ['LeadingOnly.xsd', `${BOM}<root/>`],
    ['InteriorOnly.xsd', `<root>${BOM}</root>`],
    ['Both.xsd', `${BOM}<root>${BOM}</root>`],
    ['Clean.xsd', '<root/>'],
  ]);
  const byName = Object.fromEntries(scanForBom(files).map((h) => [h.name, h]));
  assert.deepEqual(Object.keys(byName).sort(), ['Both.xsd', 'InteriorOnly.xsd', 'LeadingOnly.xsd']);
  assert.deepEqual(byName['LeadingOnly.xsd'], { name: 'LeadingOnly.xsd', hasLeadingBom: true, hasInterior: false });
  assert.deepEqual(byName['InteriorOnly.xsd'], { name: 'InteriorOnly.xsd', hasLeadingBom: false, hasInterior: true });
  assert.deepEqual(byName['Both.xsd'], { name: 'Both.xsd', hasLeadingBom: true, hasInterior: true });
  assert.equal(stripBom(files.get('Both.xsd')), '<root></root>');
});

test('root file detection finds exactly SamplePacket.xsd', () => {
  assert.deepEqual(pipeline.rootFileCandidates, ['SamplePacket.xsd']);
});

test('flattening produces one Document, inlines xs:include, and captures targetNamespace', () => {
  assert.ok(flatDoc instanceof Document);
  assert.equal(pipeline.targetNamespace, null); // the sample set declares none
  // AddressType lives in SampleCommonTypes.xsd — visible here only if the
  // xs:include was actually inlined (§3).
  assert.ok(flatDoc.querySelector('complexType[name="AddressType"]'));
  // …and the include/import directives themselves are gone afterwards.
  assert.equal(flatDoc.getElementsByTagNameNS('http://www.w3.org/2001/XMLSchema', 'include').length, 0);
});

test('flattening a malformed file surfaces a parse error rather than a silent empty tree', async () => {
  await loadXmlDom();
  const { flattenFromRoot } = await import('../js/core/flattener.js');
  assert.throws(
    () => flattenFromRoot(new Map([['Broken.xsd', '<xs:schema><unclosed></xs:schema>']]), 'Broken.xsd'),
    /Failed to parse Broken\.xsd as XML/
  );
});

test('flattening fails loudly on a missing xs:include target', async () => {
  const { flattenFromRoot } = await import('../js/core/flattener.js');
  const root = `<?xml version="1.0"?>
    <xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
      <xs:include schemaLocation="NotHere.xsd"/>
    </xs:schema>`;
  assert.throws(() => flattenFromRoot(new Map([['Root.xsd', root]]), 'Root.xsd'), /Missing xs:include target/);
});

test('root element detection finds exactly SamplePacket', () => {
  assert.deepEqual(pipeline.rootElementCandidates, ['SamplePacket']);
});

test('analyzePacket builds the expected PacketManifest (§5)', () => {
  assert.equal(manifest.packetName, 'SamplePacket');
  assert.deepEqual(manifest.allForms, [
    'SampleHeader',
    'SampleEntityForm',
    'SampleFinancialForm',
    'SampleEventLog',
    'SampleSummary',
  ]);

  const eventLog = manifest.sections.find((s) => s.elementName === 'SampleEventLog');
  assert.equal(eventLog.isRepeatable, true);
  assert.equal(eventLog.maxOccurs, -1);

  const header = manifest.sections.find((s) => s.elementName === 'SampleHeader');
  assert.equal(header.isRequired, true);
  assert.equal(header.isRepeatable, false);
});

test('SampleHeader: facets, kind assignment and type chains (WALKTHROUGH items 2,3,4,6,9,12)', () => {
  const header = parser.parseGlobalElement('SampleHeader');
  assert.equal(header.elementPath, 'SampleHeader');

  const packetId = findByName(header, 'PacketId');
  assert.equal(packetId.kind, 'TextInput');
  assert.deepEqual(
    packetId.validationRules.map((r) => r.kind),
    ['pattern', 'maxLength'] // source order, not sorted
  );
  assert.equal(packetId.validationRules[1].value, '6');

  const packetStatus = findByName(header, 'PacketStatus');
  assert.equal(packetStatus.kind, 'Dropdown');
  assert.equal(packetStatus.enumerationValues.length, 4);
  assert.equal(packetStatus.enumerationValues[0].value, 'Active');

  // A 2-level type chain: SampleDateType → xs:date.
  const expiryDate = findByName(header, 'ExpiryDate');
  assert.equal(expiryDate.kind, 'DatePicker');
  assert.equal(expiryDate.xsdDataType, 'xs:date');

  assert.equal(findByName(header, 'IsAmended').kind, 'Checkbox');

  // xs:all is transparent: its children hang off SampleHeader directly.
  assert.ok(header.children.includes(findByName(header, 'InternalNotes')));
  assert.ok(header.children.includes(findByName(header, 'ReviewerCode')));

  const primaryContact = findByName(header, 'PrimaryContact');
  assert.equal(primaryContact.kind, 'GroupContainer');
  assert.equal(findByName(primaryContact, 'MailingAddress').kind, 'GroupContainer');
});

test('SampleEntityForm: choices, nesting, attributes, repeats, groups (WALKTHROUGH items 7,8,9,10,11,13)', () => {
  const entityForm = parser.parseGlobalElement('SampleEntityForm');

  assert.equal(findByName(entityForm, 'EntityTypeChoice').kind, 'GroupContainer');
  const choiceGroup = findByName(entityForm, 'EntityTypeChoiceChoice');
  assert.equal(choiceGroup.kind, 'RadioGroup');
  assert.equal(choiceGroup.isGeneratedWrapper, false);

  const option1 = findByName(entityForm, 'EntityTypeChoiceChoiceOption1');
  assert.equal(option1.kind, 'SequenceContainer');
  assert.equal(option1.isGeneratedWrapper, true);
  assert.equal(findByName(entityForm, 'EntityTypeChoiceChoiceOption2').kind, 'SequenceContainer');

  // A nested choice keeps the whole synthetic path chain, including the
  // enclosing option wrapper (§8 — synthetic segments ARE path segments).
  const nestedChoice = findByName(entityForm, 'IdTypeChoiceChoice');
  assert.equal(nestedChoice.kind, 'RadioGroup');
  assert.equal(
    nestedChoice.elementPath,
    'SampleEntityForm.EntityTypeChoice.EntityTypeChoiceChoice.EntityTypeChoiceChoiceOption1.IdTypeChoice.IdTypeChoiceChoice'
  );

  // Attributes are prepended to the child list (§4).
  const registeredAddress = findByName(entityForm, 'RegisteredAddress');
  assert.equal(registeredAddress.kind, 'GroupContainer');
  assert.equal(registeredAddress.children.length, 6);
  assert.equal(registeredAddress.children[0].isAttribute, true);

  const entry = findByName(entityForm, 'PriorNameListEntry');
  assert.equal(entry.kind, 'SequenceContainer');
  assert.equal(entry.isRepeating, true);
  assert.equal(entry.isGeneratedWrapper, true);
  assert.equal(entry.children.length, 3);
  assert.equal(entry.elementPath, 'SampleEntityForm.PriorNameList.PriorNameListEntry');

  for (const name of ['AuditCreatedBy', 'AuditCreatedDate', 'AuditModifiedBy', 'AuditModifiedDate']) {
    assert.ok(
      entityForm.children.some((c) => c.elementName === name),
      `xs:group ref="AuditStampGroup" should inline ${name} directly into SampleEntityForm`
    );
  }
});

test('SampleFinancialForm: numeric facets, branches, nested group refs (WALKTHROUGH items 3,9,11,12,15,16,18)', () => {
  const financialForm = parser.parseGlobalElement('SampleFinancialForm');

  const taxRate = findByName(financialForm, 'TaxRate');
  assert.equal(taxRate.kind, 'DecimalInput');
  assert.deepEqual(taxRate.validationRules.map((r) => r.kind).sort(), [
    'fractionDigits',
    'maxInclusive',
    'minInclusive',
  ]);

  assert.equal(findByName(financialForm, 'ItemCount').kind, 'NumericInput');

  const paymentChoice = findByName(financialForm, 'PaymentMethodChoiceChoice');
  assert.equal(paymentChoice.kind, 'RadioGroup');
  assert.equal(paymentChoice.children.length, 3);

  const lineItemsEntry = findByName(financialForm, 'LineItemsEntry');
  assert.equal(lineItemsEntry.isRepeating, true);
  assert.equal(lineItemsEntry.children.length, 4);

  for (const name of ['AuditCreatedBy', 'AuditCreatedDate', 'AuditModifiedBy', 'AuditModifiedDate', 'IsActive', 'IsVerified', 'IsConfidential']) {
    assert.ok(
      financialForm.children.some((c) => c.elementName === name),
      `nested xs:group ref="NestedRefGroup" should inline ${name} directly`
    );
  }
});

test('SampleEventLog: instance-id attribute and double group/xs:all transparency (WALKTHROUGH items 6,11,16,18)', () => {
  const eventLog = parser.parseGlobalElement('SampleEventLog');

  const documentId = eventLog.children.find((c) => c.elementName === 'documentId');
  assert.equal(documentId.isAttribute, true);
  assert.equal(documentId.isInstanceIdSource, true);

  for (const name of ['IsActive', 'IsVerified', 'IsConfidential']) {
    const child = eventLog.children.find((c) => c.elementName === name);
    assert.ok(child, `FlagsGroup (group + xs:all) should inline ${name} directly`);
    assert.equal(child.kind, 'Checkbox');
  }

  const eventType = findByName(eventLog, 'EventType');
  assert.equal(eventType.kind, 'Dropdown');
  assert.equal(eventType.enumerationValues.length, 4);
});

test('SampleSummary resolves through the inline-element fallback (§4)', () => {
  const summary = parser.parseGlobalElement('SampleSummary');
  assert.ok(summary, 'SampleSummary is not a global element and must be found inline');
  assert.equal(summary.elementPath, 'SampleSummary'); // a form root has no leading dot
  assert.equal(summary.children.length, 7); // 3 own fields + 4 AuditStampGroup fields
  assert.equal(findByName(summary, 'TotalRecordCount').kind, 'NumericInput');
  assert.equal(findByName(summary, 'TotalAmount').kind, 'DecimalInput');
});

test('shared shape predicates agree with the parsed tree (the six-way dispatch contract)', async () => {
  const { isTransparent, isAttribute, isLeaf, isRepeatingContentContainer, isChoiceOnlyContainer, joinPath } =
    await import('../js/core/parser.js');

  const entityForm = parser.parseGlobalElement('SampleEntityForm');

  // joinPath is the rule every path extension must go through (§8): at a form
  // root the prefix is '', and naive concatenation would produce '.Name'.
  assert.equal(joinPath('', 'SampleHeader'), 'SampleHeader');
  assert.equal(joinPath('SampleHeader', 'PacketId'), 'SampleHeader.PacketId');

  assert.equal(isTransparent(findByName(entityForm, 'EntityTypeChoiceChoice')), true); // RadioGroup
  assert.equal(isTransparent(findByName(entityForm, 'EntityTypeChoiceChoiceOption1')), true); // generated wrapper
  assert.equal(isAttribute(findByName(entityForm, 'addressKind')), true);
  assert.equal(isLeaf(findByName(entityForm, 'FormerName')), true);
  assert.equal(isLeaf(findByName(entityForm, 'RegisteredAddress')), false);
  assert.equal(isRepeatingContentContainer(findByName(entityForm, 'PriorNameList')), true);
  assert.equal(isChoiceOnlyContainer(findByName(entityForm, 'EntityTypeChoice')), true);
  assert.equal(isChoiceOnlyContainer(findByName(entityForm, 'RegisteredAddress')), false);
});
