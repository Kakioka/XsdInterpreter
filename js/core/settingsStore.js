// js/core/settingsStore.js — localStorage-backed settings used by core features.
//
// dev/IMPLEMENTATION_ORDER.md Phase 3 (parity 1.4 + 1.5): one notion of
// per-schema settings, shared by the instance-id source and the export
// profile choice.
//
// Nothing here throws: a blocked or full localStorage means a setting doesn't
// outlive the session, never that a feature stops working. Writers return
// whether the write stuck.
//
// Phase 6 (backlog B.4): every localStorage access in the app goes through
// this module — the UI's own preferences (theme, zoom, layout, panel widths)
// use loadPreference/savePreference below — so a failure is detected in one
// place. The first one is reported to the listener set with
// onStorageFailure, once; the UI turns that into a single quiet notice.
//
// Data vs. preferences: the user can switch off storing their data in this
// browser (setDataStored). "Data" is anything that comes from their schemas,
// files or entries — the keys in DATA_KEYS below, plus autosave's IndexedDB
// snapshots, which ui/autosave.js gates on isDataStored(). While it is off
// those keys live in memory for the session instead, so every feature still
// works until the page closes; nothing is written. Display preferences
// (theme, zoom, layout, panel widths) and the switch itself are not data and
// are always stored.

import { textFingerprint } from './autosaveStore.js';
import { unrememberedFieldIds } from './exportProfile.js';

const SCHEMA_SETTINGS_KEY = 'xmlEditor.schemaSettings';
const PACKAGING_KEY = 'xmlEditor.lastPackagingSettings'; // §12 / §19
const PROFILES_KEY = 'xmlEditor.exportProfiles';
const LAST_SCHEMA_KEY = 'xmlEditor.lastSchema'; // §12
const STORE_DATA_KEY = 'xmlEditor.storeData';

const DATA_KEYS = [SCHEMA_SETTINGS_KEY, PACKAGING_KEY, PROFILES_KEY, LAST_SCHEMA_KEY];
/** key → raw string, for DATA_KEYS while storing is off */
const sessionData = new Map();

const MAX_REMEMBERED_DOCUMENTS = 20;

// ---------------------------------------------------------------------------
// Storage access and failure reporting
// ---------------------------------------------------------------------------

let failureListener = null;
let failureReported = false;
let lastFailure = null;

function reportFailure(err) {
  lastFailure = err;
  if (failureReported || !failureListener) return;
  failureReported = true;
  failureListener(err);
}

/**
 * Called once, with the first storage error — whether it happened before or
 * after the listener was set, so a probe at startup that ran first is not
 * lost. Later failures are not reported: one notice is the point.
 */
export function onStorageFailure(listener) {
  failureListener = listener;
  if (lastFailure && !failureReported) reportFailure(lastFailure);
}

/**
 * Whether settings will outlive this page: a write-then-remove round trip, so
 * a storage that reads fine but refuses writes (Safari private mode used to,
 * a full quota does) also counts as unavailable. Reports a failure.
 */
export function probeSettingsStorage() {
  const probeKey = 'xmlEditor.__probe';
  try {
    localStorage.setItem(probeKey, '1');
    localStorage.removeItem(probeKey);
    return true;
  } catch (err) {
    reportFailure(err);
    return false;
  }
}

function readRaw(key) {
  try {
    return localStorage.getItem(key);
  } catch (err) {
    reportFailure(err);
    return null;
  }
}

function writeRaw(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    reportFailure(err);
    return false;
  }
}

function removeRaw(key) {
  try {
    localStorage.removeItem(key);
    return true;
  } catch (err) {
    reportFailure(err);
    return false;
  }
}

function isSessionOnly(key) {
  return DATA_KEYS.includes(key) && !isDataStored();
}

function read(key) {
  const raw = isSessionOnly(key) ? sessionData.get(key) ?? null : readRaw(key);
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null; // a corrupt value is not a storage failure
  }
}

function write(key, value) {
  if (isSessionOnly(key)) {
    sessionData.set(key, JSON.stringify(value));
    return true; // it "stuck" as far as the session goes, which is what was asked for
  }
  return writeRaw(key, JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Whether the user's data is stored at all
// ---------------------------------------------------------------------------

let storeDataCache = null;

/** On unless the user has turned it off. */
export function isDataStored() {
  storeDataCache ??= readRaw(STORE_DATA_KEY) !== 'false';
  return storeDataCache;
}

/**
 * Off: everything in DATA_KEYS moves out of localStorage into memory, so the
 * session carries on with the same settings and nothing is left behind. On:
 * whatever the session accumulated is written out, as if it had been stored
 * all along. Autosave snapshots are ui/autosave.js's to delete or resume.
 *
 * @returns {boolean} whether every write stuck
 */
export function setDataStored(store) {
  let ok = writeRaw(STORE_DATA_KEY, store ? 'true' : 'false');
  if (store) {
    storeDataCache = true;
    for (const [key, raw] of sessionData) ok = writeRaw(key, raw) && ok;
    sessionData.clear();
  } else {
    for (const key of DATA_KEYS) {
      const raw = readRaw(key);
      if (raw !== null) sessionData.set(key, raw);
      ok = removeRaw(key) && ok;
    }
    storeDataCache = false;
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Plain preferences (theme, zoom, layout, panel widths)
// ---------------------------------------------------------------------------

/** @returns {string|null} */
export function loadPreference(key) {
  return readRaw(key);
}

/** @returns {boolean} whether the write stuck */
export function savePreference(key, value) {
  return writeRaw(key, String(value));
}

// ---------------------------------------------------------------------------
// Last-used schema (§12 xmlEditor.lastSchema)
// ---------------------------------------------------------------------------

/**
 * Informational only: a page cannot reopen a folder by name, so this is shown
 * on the load prompt to remind the user which one they had open. Like every
 * data key, held in memory only while isDataStored() is off.
 *
 * @param {{folderName: string|null, rootFileName: string, rootElementName: string, packetName: string}} info
 */
export function saveLastSchema({ folderName, rootFileName, rootElementName, packetName }, now = new Date()) {
  return write(LAST_SCHEMA_KEY, {
    folderName: folderName || null,
    rootFileName,
    rootElementName,
    packetName,
    loadedAt: now.toISOString(),
  });
}

/** @returns {{folderName: string|null, rootFileName: string, rootElementName: string, packetName: string, loadedAt: string}|null} */
export function loadLastSchema() {
  const stored = read(LAST_SCHEMA_KEY);
  return stored && typeof stored.rootFileName === 'string' ? stored : null;
}

// ---------------------------------------------------------------------------
// Per-schema settings
// ---------------------------------------------------------------------------

/**
 * Which schema a setting belongs to. Looser than autosave's computeSchemaKey
 * on purpose: that one changes whenever any file's size does, and a choice
 * made once per schema should survive the next revision of it. Only the root
 * file's base name is used, since the folder picker and its <input> fallback
 * disagree about whether paths include the chosen folder.
 */
export function schemaSettingsKey(targetNamespace, rootFileName, rootElementName) {
  return [targetNamespace || '', rootFileName.split(/[\\/]/).pop(), rootElementName].join('#');
}

/** @returns {object} {} when nothing is stored */
export function loadSchemaSettings(schemaKey) {
  return read(SCHEMA_SETTINGS_KEY)?.[schemaKey] ?? {};
}

/** Merges `patch` into the schema's stored settings. */
export function updateSchemaSettings(schemaKey, patch) {
  const all = read(SCHEMA_SETTINGS_KEY) ?? {};
  all[schemaKey] = { ...all[schemaKey], ...patch };
  return write(SCHEMA_SETTINGS_KEY, all);
}

/**
 * Remembers the instance ids a document was written with, keyed by the
 * document's own text — the only place to keep them for a form whose schema
 * declares no identity attribute. A document that was edited elsewhere no
 * longer matches and gets freshly generated ids, which is correct: there is
 * no telling which instance became which.
 *
 * @param {string} schemaKey
 * @param {string} xmlText exactly as written to disk
 * @param {Array<{formName: string, instanceId: string}>} instanceKeys in document order
 */
export function rememberInstanceIds(schemaKey, xmlText, instanceKeys) {
  const ids = {};
  for (const key of instanceKeys) {
    if (key.instanceId === key.formName) continue;
    (ids[key.formName] ??= []).push(key.instanceId);
  }
  const fingerprint = textFingerprint(xmlText);
  const others = (loadSchemaSettings(schemaKey).savedDocuments ?? []).filter((d) => d.fingerprint !== fingerprint);
  const savedDocuments = Object.keys(ids).length > 0 ? [{ fingerprint, ids }, ...others] : others;
  return updateSchemaSettings(schemaKey, { savedDocuments: savedDocuments.slice(0, MAX_REMEMBERED_DOCUMENTS) });
}

/** @returns {Object<string, string[]>} form name → ids, {} for an unknown document */
export function recallInstanceIds(schemaKey, xmlText) {
  const fingerprint = textFingerprint(xmlText);
  return loadSchemaSettings(schemaKey).savedDocuments?.find((d) => d.fingerprint === fingerprint)?.ids ?? {};
}

// ---------------------------------------------------------------------------
// Export profiles and last-used packaging values
// ---------------------------------------------------------------------------

function omit(values, ids) {
  return Object.fromEntries(Object.entries(values).filter(([id]) => !ids.includes(id)));
}

/** Field values only — files can't be persisted, so they are re-picked each
 *  time — and never a field the profile marks `remember: false`. */
export function saveLastPackagingSettings(profile, values) {
  const byProfile = read(PACKAGING_KEY)?.byProfile ?? {};
  return write(PACKAGING_KEY, { byProfile: { ...byProfile, [profile.id]: omit(values, unrememberedFieldIds(profile)) } });
}

/**
 * Deletes stored values the profiles say must not be remembered: ones saved
 * before the flag existed, or before a profile added it. The pre-profile
 * format doesn't say whose values it holds, so every profile's list applies.
 */
export function forgetUnrememberedValues(profiles) {
  const stored = read(PACKAGING_KEY);
  if (!stored) return true;
  if (!stored.byProfile) return write(PACKAGING_KEY, omit(stored, profiles.flatMap(unrememberedFieldIds)));
  const byProfile = { ...stored.byProfile };
  for (const profile of profiles) {
    if (byProfile[profile.id]) byProfile[profile.id] = omit(byProfile[profile.id], unrememberedFieldIds(profile));
  }
  return write(PACKAGING_KEY, { byProfile });
}

/** @returns {object|null} */
export function loadLastPackagingSettings(profileId) {
  const stored = read(PACKAGING_KEY);
  if (!stored) return null;
  // Before profiles existed this key held one flat object of values. Offering
  // it to any profile is harmless: ids the profile doesn't declare are ignored.
  return stored.byProfile ? stored.byProfile[profileId] ?? null : stored;
}

/** Profiles the user loaded from a file. Unvalidated — the caller checks them. */
export function loadUserProfiles() {
  const stored = read(PROFILES_KEY);
  return Array.isArray(stored) ? stored : [];
}

export function saveUserProfiles(profiles) {
  return write(PROFILES_KEY, profiles);
}
