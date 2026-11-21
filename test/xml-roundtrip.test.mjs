// test/xml-roundtrip.test.mjs — js/core/xmlReader.js + js/core/xmlWriter.js.
//
// Ported from dev/phase2-check.html. The round-trip assertion (read the
// fixture, write it back, re-read, diff every FormState) is the single most
// load-bearing check in the project: it is what catches a change to one of the
// six parallel shape-dispatch sites (CLAUDE.md, "The six-way parallel
// structure") that silently works in one direction only.

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadSamplePipeline, loadSampleXml, field, radio, emptyFormState } from './helpers/env.mjs';

const { parser, manifest, targetNamespace } = await loadSamplePipeline();
const { readPacket } = await import('../js/core/xmlReader.js');
const { buildPacketXml, buildNodes, prettyPrintXml } = await import('../js/core/xmlWriter.js');
const { FormInstanceKey } = await import('../js/core/formEngine.js');

const xmlText = await loadSampleXml();
const read1 = readPacket(xmlText, manifest, parser);

function dictEqual(a, b) {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((k, i) => k === bk[i] && a[k] === b[k]);
}

test('readPacket finds every form instance in the fixture', () => {
  assert.equal(read1.size, 6, `keys: ${[...read1.keys()].join(', ')}`);
});

test('SampleHeader: typed values, attribute-derived fields, xs:all order independence', () => {
  const header = read1.get('SampleHeader');
  assert.equal(field(header, 'SampleHeader.PacketId'), 'HI2025');
  assert.equal(field(header, 'SampleHeader.EffectiveDateTime'), '2024-03-15T09:00:00');
  assert.equal(field(header, 'SampleHeader.ExpiryDate'), '2025-12-31');
  assert.equal(field(header, 'SampleHeader.IsAmended'), false); // a real boolean, not the string "false"

  assert.equal(field(header, 'SampleHeader.PrimaryContact.MailingAddress.addressKind'), 'Mailing');
  // An optional element absent from the XML stays absent, not empty-string.
  assert.equal(field(header, 'SampleHeader.PrimaryContact.EmailAddress'), undefined);

  // ReviewerCode precedes InternalNotes in the file; xs:all means either order reads.
  assert.equal(field(header, 'SampleHeader.ReviewerCode'), 'AB1234');
  assert.equal(field(header, 'SampleHeader.InternalNotes'), 'Initial test submission created for developer verification.');
});

test('unmatched fields are collected rather than dropped', () => {
  // SampleHeader's own definition does NOT reference xs:group ref="AuditStampGroup"
  // (only SampleEntityForm, SampleSummary and — via NestedRefGroup —
  // SampleFinancialForm do), so the 4 Audit* elements under <SampleHeader> in
  // the fixture are genuinely unmatched, same as UnknownLegacyField. That is a
  // pre-existing inconsistency between SamplePacket.xml and its XSD, not a
  // reader bug — dev/phase2-check.html carries the same note.
  const header = read1.get('SampleHeader');
  assert.equal(header.unmatchedFields.length, 5);
  assert.ok(
    header.unmatchedFields.some((u) => u.xmlPath === 'SampleHeader.UnknownLegacyField' && u.value === 'some_legacy_value')
  );
});

test('SampleEntityForm: radio selections store static option paths, unselected branches stay absent', () => {
  const entity = read1.get('SampleEntityForm');
  const choicePath = 'SampleEntityForm.EntityTypeChoice.EntityTypeChoiceChoice';

  assert.equal(radio(entity, choicePath), `${choicePath}.EntityTypeChoiceChoiceOption2`);
  assert.equal(field(entity, `${choicePath}.EntityTypeChoiceChoiceOption2.OrgLegalName`), 'Acme Sample Corporation');
  assert.equal(field(entity, `${choicePath}.EntityTypeChoiceChoiceOption2.OrgFoundedYear`), '1998');

  // The unselected branch is absent, not null/empty — including its own nested choice.
  assert.equal(field(entity, `${choicePath}.EntityTypeChoiceChoiceOption1.IndividualFirstName`), undefined);
  assert.equal(radio(entity, `${choicePath}.EntityTypeChoiceChoiceOption1.IdTypeChoice.IdTypeChoiceChoice`), undefined);
});

test('SampleEntityForm: repeating instances index with [i] and count by bare entry name', () => {
  const entity = read1.get('SampleEntityForm');
  assert.equal(field(entity, 'SampleEntityForm.RegisteredAddress.addressKind'), 'Physical');
  assert.equal(entity.repeatingInstanceCounts['priornamelistentry'], 2);
  assert.equal(field(entity, 'SampleEntityForm.PriorNameList.PriorNameListEntry[0].FormerName'), 'Acme Sample Industries');
  assert.equal(field(entity, 'SampleEntityForm.PriorNameList.PriorNameListEntry[1].FormerName'), 'Acme Widgets LLC');
  assert.equal(field(entity, 'SampleEntityForm.PriorNameList.PriorNameListEntry[1].NameChangeReason'), undefined);
  assert.equal(field(entity, 'SampleEntityForm.AuditCreatedBy'), 'dataentry1');
  assert.equal(field(entity, 'SampleEntityForm.AuditModifiedBy'), undefined);
});

test('SampleFinancialForm: branch selection, repeats, nested group inlining', () => {
  const financial = read1.get('SampleFinancialForm');
  const choicePath = 'SampleFinancialForm.PaymentMethodChoice.PaymentMethodChoiceChoice';
  assert.equal(radio(financial, choicePath), `${choicePath}.PaymentMethodChoiceChoiceOption1`);
  assert.equal(financial.repeatingInstanceCounts['lineitemsentry'], 2);
  assert.equal(field(financial, 'SampleFinancialForm.LineItems.LineItemsEntry[0].LineCategory'), 'A');
  assert.equal(field(financial, 'SampleFinancialForm.LineItems.LineItemsEntry[1].LineCategory'), undefined);
  assert.equal(field(financial, 'SampleFinancialForm.AuditModifiedBy'), 'manager1');
  assert.equal(field(financial, 'SampleFinancialForm.IsActive'), true);
  assert.equal(field(financial, 'SampleFinancialForm.IsConfidential'), false);
});

test('repeatable form instances become distinct FormInstanceKeys with independent state', () => {
  const evt1 = read1.get('SampleEventLog#EVT-001');
  const evt2 = read1.get('SampleEventLog#EVT-002');
  assert.ok(evt1 && evt2);

  // documentId both identifies the instance AND remains a readable field.
  assert.equal(field(evt1, 'SampleEventLog.documentId'), 'EVT-001');
  assert.equal(field(evt2, 'SampleEventLog.documentId'), 'EVT-002');

  assert.equal(field(evt1, 'SampleEventLog.EventTitle'), 'Initial Submission Received');
  assert.equal(field(evt2, 'SampleEventLog.EventTitle'), 'Amendment Filed');
  assert.equal(field(evt1, 'SampleEventLog.IsConfidential'), undefined);
  assert.equal(field(evt2, 'SampleEventLog.IsConfidential'), true);
});

test('SampleSummary loads through the inline-element fallback', () => {
  const summary = read1.get('SampleSummary');
  assert.ok(summary);
  assert.equal(field(summary, 'SampleSummary.TotalAmount'), '125000.00');
  assert.equal(field(summary, 'SampleSummary.AuditCreatedBy'), 'system');
});

test('buildPacketXml output is pretty-printed without disturbing values', () => {
  const orderedKeys = [...read1.keys()].map((k) => FormInstanceKey.parse(k));
  const writtenXml = buildPacketXml(manifest, read1, orderedKeys, parser, targetNamespace);

  assert.ok(writtenXml.includes('\n'));
  const lines = writtenXml.split('\n');
  const indentOf = (line) => line.match(/^ */)[0].length;
  const headerLine = lines.findIndex((l) => l.trim() === '<SampleHeader>');
  const packetIdLine = lines.findIndex((l) => l.trim().startsWith('<PacketId>'));
  assert.notEqual(headerLine, -1);
  assert.notEqual(packetIdLine, -1);
  assert.ok(indentOf(lines[packetIdLine]) > indentOf(lines[headerLine]));

  // A leaf's open tag, text and close tag stay on one line — no whitespace is
  // ever introduced inside a value.
  assert.match(writtenXml, /^\s*<PacketId>[^<]*<\/PacketId>$/m);
  assert.equal(new DOMParser().parseFromString(writtenXml, 'application/xml').getElementsByTagName('parsererror').length, 0);
});

test('prettyPrintXml keeps leaf pairs intact and de-indents closing tags', () => {
  assert.equal(prettyPrintXml('<Root><Empty></Empty></Root>'), '<Root>\n  <Empty></Empty>\n</Root>');
  assert.equal(prettyPrintXml('<A><B>x</B></A>'), '<A>\n  <B>x</B>\n</A>');
});

test('round-trip: write the packet back out, re-read it, and diff every FormState', () => {
  const orderedKeys = [...read1.keys()].map((k) => FormInstanceKey.parse(k));
  const writtenXml = buildPacketXml(manifest, read1, orderedKeys, parser, targetNamespace);
  const read2 = readPacket(writtenXml, manifest, parser);

  assert.equal(read2.size, read1.size);
  for (const key of read1.keys()) {
    const before = read1.get(key);
    const after = read2.get(key);
    assert.ok(after, `${key} disappeared on round-trip`);
    assert.ok(dictEqual(before.fieldValues, after.fieldValues), `${key}: fieldValues differ`);
    assert.ok(dictEqual(before.radioSelections, after.radioSelections), `${key}: radioSelections differ`);
    assert.ok(dictEqual(before.repeatingInstanceCounts, after.repeatingInstanceCounts), `${key}: repeatingInstanceCounts differ`);
  }

  // The one expected asymmetry: the 5 fields that aren't in the schema are
  // reported unmatched on the way in and simply never written back out.
  assert.equal(read1.get('SampleHeader').unmatchedFields.length, 5);
  assert.equal(read2.get('SampleHeader').unmatchedFields.length, 0);
});

test('a required-but-empty field is still emitted (WALKTHROUGH item 25)', () => {
  const headerSchema = parser.parseGlobalElement('SampleHeader');
  const state = emptyFormState({ 'sampleheader.packetid': '' });
  const scratchDoc = document.implementation.createDocument(null, 'Scratch', null);
  buildNodes(scratchDoc.documentElement, headerSchema, state);
  const emitted = scratchDoc.documentElement.querySelector('PacketId');
  assert.ok(emitted, 'a required field must be emitted even when empty, not omitted');
  assert.equal(emitted.textContent, '');
});

test('an optional empty field is omitted entirely', () => {
  const headerSchema = parser.parseGlobalElement('SampleHeader');
  const state = emptyFormState({ 'sampleheader.internalnotes': '' });
  const scratchDoc = document.implementation.createDocument(null, 'Scratch', null);
  buildNodes(scratchDoc.documentElement, headerSchema, state);
  assert.equal(scratchDoc.documentElement.querySelector('InternalNotes'), null);
});

test('documentId is backfilled from FormInstanceKey.instanceId when never typed', () => {
  const eventLogSchema = parser.parseGlobalElement('SampleEventLog');
  const state = emptyFormState({ 'sampleeventlog.eventtitle': 'x' });
  const key = new FormInstanceKey('SampleEventLog', 'EVT-999');
  const written = buildPacketXml(
    manifest,
    new Map([[key.toString(), state]]),
    [key],
    { parseGlobalElement: () => eventLogSchema },
    targetNamespace
  );
  const doc = new DOMParser().parseFromString(written, 'application/xml');
  assert.equal(doc.querySelector('SampleEventLog').getAttribute('documentId'), 'EVT-999');
});

test('a repeating section writes the OUTER tag per instance, never the synthetic Entry wrapper', () => {
  // §22: "a repeating content container's own name is the tag that repeats; its
  // synthetic …Entry wrapper never appears in XML at all."
  const entitySchema = parser.parseGlobalElement('SampleEntityForm');
  const state = emptyFormState(
    {
      'sampleentityform.priornamelist.priornamelistentry[0].formername': 'First',
      'sampleentityform.priornamelist.priornamelistentry[1].formername': 'Second',
    },
    {},
    { priornamelistentry: 2 }
  );
  const scratchDoc = document.implementation.createDocument(null, 'Scratch', null);
  buildNodes(scratchDoc.documentElement, entitySchema, state);

  assert.equal(scratchDoc.documentElement.querySelectorAll('PriorNameListEntry').length, 0);
  const lists = scratchDoc.documentElement.querySelectorAll('PriorNameList');
  assert.equal(lists.length, 2);
  assert.equal(lists[0].querySelector('FormerName').textContent, 'First');
  assert.equal(lists[1].querySelector('FormerName').textContent, 'Second');
});

test('targetNamespace is applied to the written document when the schema declares one', () => {
  const headerSchema = parser.parseGlobalElement('SampleHeader');
  const key = new FormInstanceKey('SampleHeader');
  const written = buildPacketXml(
    manifest,
    new Map([[key.toString(), emptyFormState({ 'sampleheader.packetid': 'AB1234' })]]),
    [key],
    { parseGlobalElement: () => headerSchema },
    'urn:test:ns'
  );
  assert.match(written, /xmlns="urn:test:ns"/);
  const doc = new DOMParser().parseFromString(written, 'application/xml');
  assert.equal(doc.documentElement.namespaceURI, 'urn:test:ns');
  // And a namespaced document still reads back — xmlReader's `:scope > Name`
  // queries match on local name, so they are namespace-agnostic by design.
  assert.equal(doc.querySelector('PacketId').textContent, 'AB1234');
});
