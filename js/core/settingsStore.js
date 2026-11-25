// js/core/settingsStore.js — localStorage-backed settings used by core features.
//
// dev/IMPLEMENTATION_ORDER.md Phase 3 (parity 1.4 + 1.5): one notion of
// per-schema settings, shared by the instance-id source and the export
// profile choice.
//
// Nothing here throws: a blocked or full localStorage means a setting doesn't
// outlive the session, never that a feature stops working. Writers return
// whether the write stuck.

import { textFingerprint } from './autosaveStore.js';
import { unrememberedFieldIds } from './exportProfile.js';

const SCHEMA_SETTINGS_KEY = 'xmlEditor.schemaSettings';
const PACKAGING_KEY = 'xmlEditor.lastPackagingSettings'; // §12 / §19
const PROFILES_KEY = 'xmlEditor.exportProfiles';

const MAX_REMEMBERED_DOCUMENTS = 20;

function read(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
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
