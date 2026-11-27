// test/autosaveStore.test.mjs — js/core/autosaveStore.js (C.1).
//
// Node has no IndexedDB, so the persistence functions are covered only for
// their "storage unavailable" contract here — which is the contract that
// actually matters, because autosave is a safety net and must never be the
// thing that breaks data entry. The pure parts (schema identity, snapshot
// serialization) are covered properly.
//
// The IndexedDB round-trip itself is browser-only; dev/phase4-check.html is
// where that belongs if it ever needs a harness.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isAutosaveAvailable,
  computeSchemaKey,
  buildSnapshot,
  snapshotHasWork,
  putSnapshot,
  getSnapshot,
  listSnapshots,
  deleteSnapshot,
  deleteAllSnapshots,
  pruneSnapshots,
} from '../js/core/autosaveStore.js';
import { FormEngine, FormInstanceKey, keyOf } from '../js/core/formEngine.js';

const files = () =>
  new Map([
    ['SamplePacket.xsd', '<schema>root</schema>'],
    ['SampleCommonTypes.xsd', '<schema>types</schema>'],
  ]);

test('computeSchemaKey is stable regardless of Map insertion order', () => {
  const reversed = new Map([...files().entries()].reverse());
  assert.equal(computeSchemaKey(files(), 'SamplePacket.xsd', 'SamplePacket'), computeSchemaKey(reversed, 'SamplePacket.xsd', 'SamplePacket'));
});

test('computeSchemaKey changes with the root file, the root element, or the file set', () => {
  const base = computeSchemaKey(files(), 'SamplePacket.xsd', 'SamplePacket');

  assert.notEqual(base, computeSchemaKey(files(), 'Other.xsd', 'SamplePacket'));
  assert.notEqual(base, computeSchemaKey(files(), 'SamplePacket.xsd', 'OtherRoot'));

  const extraFile = files();
  extraFile.set('Extra.xsd', '<schema/>');
  assert.notEqual(base, computeSchemaKey(extraFile, 'SamplePacket.xsd', 'SamplePacket'));

  const differentSize = files();
  differentSize.set('SampleCommonTypes.xsd', '<schema>types and more</schema>');
  assert.notEqual(base, computeSchemaKey(differentSize, 'SamplePacket.xsd', 'SamplePacket'));
});

test('computeSchemaKey carries the root names in the clear, for debuggability', () => {
  assert.match(computeSchemaKey(files(), 'SamplePacket.xsd', 'SamplePacket'), /^SamplePacket\.xsd#SamplePacket#[0-9a-f]{8}$/);
});

test('buildSnapshot captures instance keys in natural case and states under FormEngine keys', () => {
  const engine = new FormEngine();
  const header = new FormInstanceKey('SampleHeader');
  const log = new FormInstanceKey('SampleEventLog', 'EVT-001');

  engine.setActiveForm(header);
  engine.setValue('SampleHeader.PacketId', 'AB1234');
  engine.setDirty(true);
  engine.setActiveForm(log);
  engine.setRadioSelection('SampleEventLog.KindChoice', 'SampleEventLog.KindChoice.Option1');
  engine.setRepeatingInstanceCount('Entry', 2);

  const snapshot = buildSnapshot({
    schemaKey: 'k',
    packetName: 'SamplePacket',
    instanceKeys: [header, log],
    formStates: engine.getAllFormStates(),
  });

  assert.deepEqual(snapshot.instanceKeys, ['SampleHeader', 'SampleEventLog#EVT-001']);
  assert.equal(snapshot.packetName, 'SamplePacket');
  assert.equal(snapshot.formStateCount, 2);
  assert.ok(Date.parse(snapshot.savedAt) > 0);

  // The states dict is keyed the way FormEngine keys it, so a restore can pair
  // the two halves back up (see app.js's restoreFromSnapshot).
  assert.ok(keyOf(header) in snapshot.formStates);
  assert.equal(snapshot.formStates[keyOf(header)].fieldValues['sampleheader.packetid'], 'AB1234');
  assert.equal(snapshot.formStates[keyOf(header)].isDirty, true);
  assert.equal(snapshot.formStates[keyOf(log)].radioSelections['sampleeventlog.kindchoice'], 'SampleEventLog.KindChoice.Option1');
  assert.equal(snapshot.formStates[keyOf(log)].repeatingInstanceCounts.entry, 2);
});

test('buildSnapshot deep-copies the dicts, so later edits do not mutate the snapshot', () => {
  const engine = new FormEngine();
  const key = new FormInstanceKey('F');
  engine.setActiveForm(key);
  engine.setValue('F.A', 'before');

  const snapshot = buildSnapshot({ schemaKey: 'k', packetName: 'P', instanceKeys: [key], formStates: engine.getAllFormStates() });
  engine.setValue('F.A', 'after');

  assert.equal(snapshot.formStates[keyOf(key)].fieldValues['f.a'], 'before');
});

test('buildSnapshot output survives a structured-clone-equivalent round-trip', () => {
  const engine = new FormEngine();
  const key = new FormInstanceKey('F');
  engine.setActiveForm(key);
  engine.setValue('F.Flag', true);
  engine.setValue('F.Text', 'x');

  const snapshot = buildSnapshot({ schemaKey: 'k', packetName: 'P', instanceKeys: [key], formStates: engine.getAllFormStates() });
  // IndexedDB uses structured clone; JSON is the stricter test and also proves
  // nothing non-serializable (a function, a DOM node, a Map) leaked in.
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
});

test('snapshotHasWork distinguishes real work from freshly-loaded blank forms', () => {
  assert.equal(snapshotHasWork(null), false);
  assert.equal(snapshotHasWork({}), false);
  assert.equal(snapshotHasWork({ formStates: {} }), false);
  assert.equal(
    snapshotHasWork({ formStates: { f: { fieldValues: {}, radioSelections: {}, repeatingInstanceCounts: { entry: 3 } } } }),
    false,
    'added-but-empty rows alone are not work worth offering back'
  );
  assert.equal(snapshotHasWork({ formStates: { f: { fieldValues: { 'f.a': 'typed' }, radioSelections: {} } } }), true);
  assert.equal(snapshotHasWork({ formStates: { f: { fieldValues: {}, radioSelections: { 'f.c': 'opt' } } } }), true);
});

test('with no IndexedDB, every persistence call resolves harmlessly instead of throwing', async () => {
  assert.equal(isAutosaveAvailable(), false, 'Node has no IndexedDB — that is the point of this test');

  assert.equal(await putSnapshot({ schemaKey: 'k' }), false);
  assert.equal(await getSnapshot('k'), null);
  assert.deepEqual(await listSnapshots(), []);
  assert.equal(await pruneSnapshots(), 0);
  await assert.doesNotReject(deleteSnapshot('k'));
  await assert.doesNotReject(deleteAllSnapshots());
});
