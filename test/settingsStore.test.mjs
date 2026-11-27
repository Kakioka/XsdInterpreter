// test/settingsStore.test.mjs — js/core/settingsStore.js's storage plumbing:
// plain preferences, xmlEditor.lastSchema (parity 3.6), and the one-notice
// failure reporting that replaces a dozen silent catch blocks (backlog B.4).
//
// The failure listener is module state and reports once per page, so each
// test that needs a clean slate imports its own module instance (a query
// string makes Node load the file again).

import test from 'node:test';
import assert from 'node:assert/strict';

import { installLocalStorage } from './helpers/env.mjs';

let instance = 0;
async function freshStore() {
  return import(`../js/core/settingsStore.js?instance=${++instance}`);
}

test('preferences round-trip as strings; a missing one reads null', async () => {
  const backing = installLocalStorage();
  const store = await freshStore();
  assert.equal(store.loadPreference('xmlEditor.zoomLevel'), null);
  assert.equal(store.savePreference('xmlEditor.zoomLevel', 120), true);
  assert.equal(backing.get('xmlEditor.zoomLevel'), '120');
  assert.equal(store.loadPreference('xmlEditor.zoomLevel'), '120');
});

test('lastSchema stores what was loaded, under the spec key', async () => {
  const backing = installLocalStorage();
  const store = await freshStore();
  assert.equal(store.loadLastSchema(), null);
  const when = new Date('2026-11-26T10:00:00Z');
  store.saveLastSchema({ folderName: 'sample-schemas', rootFileName: 'SamplePacket.xsd', rootElementName: 'SamplePacket', packetName: 'SamplePacket' }, when);
  assert.ok(backing.has('xmlEditor.lastSchema'));
  assert.deepEqual(store.loadLastSchema(), {
    folderName: 'sample-schemas',
    rootFileName: 'SamplePacket.xsd',
    rootElementName: 'SamplePacket',
    packetName: 'SamplePacket',
    loadedAt: '2026-11-26T10:00:00.000Z',
  });
});

const INFO = { folderName: 'sample-schemas', rootFileName: 'SamplePacket.xsd', rootElementName: 'SamplePacket', packetName: 'SamplePacket' };
const DATA_KEYS = ['xmlEditor.lastSchema', 'xmlEditor.schemaSettings', 'xmlEditor.lastPackagingSettings', 'xmlEditor.exportProfiles'];
const PROFILE = { id: 'p', fields: [] };

function fillEveryDataKey(store) {
  store.saveLastSchema(INFO);
  store.updateSchemaSettings('k', { instanceIdSource: { mode: 'none' } });
  store.saveLastPackagingSettings(PROFILE, { efin: '123456' });
  store.saveUserProfiles([PROFILE]);
}

test('data is stored by default', async () => {
  const backing = installLocalStorage();
  const store = await freshStore();
  assert.equal(store.isDataStored(), true);
  fillEveryDataKey(store);
  for (const key of DATA_KEYS) assert.ok(backing.has(key), key);
});

test('turning data storage off deletes every data key, and nothing new is written', async () => {
  const backing = installLocalStorage();
  const store = await freshStore();
  fillEveryDataKey(store);
  store.savePreference('xmlEditor.zoomLevel', 120);

  assert.equal(store.setDataStored(false), true);
  assert.equal(store.isDataStored(), false);
  assert.equal(backing.get('xmlEditor.storeData'), 'false', 'the choice itself is kept');
  for (const key of DATA_KEYS) assert.equal(backing.has(key), false, `${key} deleted`);
  assert.equal(backing.get('xmlEditor.zoomLevel'), '120', 'display preferences are not data');

  fillEveryDataKey(store);
  store.rememberInstanceIds('k', '<Doc/>', [{ formName: 'Log', instanceId: 'Log-1' }]);
  for (const key of DATA_KEYS) assert.equal(backing.has(key), false, `${key} not rewritten`);
});

test('while off, the session keeps working from memory — including what was stored before', async () => {
  installLocalStorage();
  const store = await freshStore();
  store.updateSchemaSettings('k', { instanceIdSource: { mode: 'none' } });
  store.setDataStored(false);

  assert.deepEqual(store.loadSchemaSettings('k').instanceIdSource, { mode: 'none' }, 'carried over');
  store.updateSchemaSettings('k', { exportProfileId: 'p' });
  assert.equal(store.loadSchemaSettings('k').exportProfileId, 'p');
  store.saveLastPackagingSettings(PROFILE, { efin: '123456' });
  assert.deepEqual(store.loadLastPackagingSettings('p'), { efin: '123456' });
  store.rememberInstanceIds('k', '<Doc/>', [{ formName: 'Log', instanceId: 'Log-1' }]);
  assert.deepEqual(store.recallInstanceIds('k', '<Doc/>'), { Log: ['Log-1'] });
});

test('the choice survives a reload; a fresh page with storage off starts with nothing', async () => {
  const backing = installLocalStorage();
  (await freshStore()).setDataStored(false);
  backing.set('xmlEditor.lastSchema', JSON.stringify({ ...INFO, loadedAt: '' })); // e.g. written by an older tab
  const reloaded = await freshStore();
  assert.equal(reloaded.isDataStored(), false);
  assert.equal(reloaded.loadLastSchema(), null, 'a stray stored record is not read while off');
});

test('turning it back on writes out what the session accumulated', async () => {
  const backing = installLocalStorage();
  const store = await freshStore();
  store.setDataStored(false);
  store.saveLastSchema(INFO);
  store.updateSchemaSettings('k', { exportProfileId: 'p' });

  assert.equal(store.setDataStored(true), true);
  assert.equal(store.isDataStored(), true);
  assert.equal(JSON.parse(backing.get('xmlEditor.lastSchema')).folderName, 'sample-schemas');
  assert.equal(JSON.parse(backing.get('xmlEditor.schemaSettings')).k.exportProfileId, 'p');
});

test('lastSchema: an unrecognizable stored value reads as nothing', async () => {
  const backing = installLocalStorage();
  const store = await freshStore();
  backing.set('xmlEditor.lastSchema', 'not json');
  assert.equal(store.loadLastSchema(), null);
  backing.set('xmlEditor.lastSchema', '{"folderName": 3}');
  assert.equal(store.loadLastSchema(), null);
});

test('probe succeeds on working storage and leaves nothing behind', async () => {
  const backing = installLocalStorage();
  const store = await freshStore();
  let reported = 0;
  store.onStorageFailure(() => reported++);
  assert.equal(store.probeSettingsStorage(), true);
  assert.equal(backing.size, 0);
  assert.equal(reported, 0);
});

test('blocked storage: nothing throws, and the failure is reported exactly once', async () => {
  installLocalStorage({ throwOnAccess: true });
  const store = await freshStore();
  const reports = [];
  store.onStorageFailure((err) => reports.push(err));

  assert.equal(store.probeSettingsStorage(), false);
  assert.equal(store.savePreference('xmlEditor.zoomLevel', 120), false);
  assert.equal(store.loadPreference('xmlEditor.zoomLevel'), null);
  assert.equal(store.saveLastSchema({ folderName: 'x', rootFileName: 'a.xsd', rootElementName: 'A', packetName: 'A' }), false);
  assert.equal(store.loadLastSchema(), null);
  assert.deepEqual(store.loadSchemaSettings('k'), {});
  assert.equal(store.updateSchemaSettings('k', { a: 1 }), false);
  assert.equal(store.setDataStored(false), false, 'the choice itself could not be stored');

  assert.equal(reports.length, 1);
  assert.match(reports[0].message, /unavailable/);
});

test('a failure before the listener is set is still reported when it is', async () => {
  installLocalStorage({ throwOnAccess: true });
  const store = await freshStore();
  store.loadPreference('xmlEditor.activeTheme'); // e.g. theme restore running before the notice is wired
  let reported = 0;
  store.onStorageFailure(() => reported++);
  assert.equal(reported, 1);
  store.savePreference('xmlEditor.activeTheme', 'Dark');
  assert.equal(reported, 1);
});

test('a corrupt JSON value is not a storage failure', async () => {
  const backing = installLocalStorage();
  const store = await freshStore();
  let reported = 0;
  store.onStorageFailure(() => reported++);
  backing.set('xmlEditor.schemaSettings', '{broken');
  assert.deepEqual(store.loadSchemaSettings('k'), {});
  assert.equal(reported, 0);
});
