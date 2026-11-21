// js/core/autosaveStore.js — IndexedDB persistence of in-progress form state.
//
// dev/IMPROVEMENT_BACKLOG.md C.1 ("Autosave and crash recovery — treat as
// required, not optional"): the WPF app held state in a process the user
// deliberately closed, whereas a browser tab can be closed by accident, crash,
// or be discarded by the OS under memory pressure — and FormEngine state lives
// only in memory. This is the regression the web introduces, so it's Phase 0
// work in dev/IMPLEMENTATION_ORDER.md, not a nicety.
//
// Pure logic, no DOM — IndexedDB is a storage API available in workers, the
// same bytes-and-strings category as localStorage in packager.js and
// CompressionStream/DOMParser elsewhere in core/. js/ui/autosave.js owns the
// debounce, the beforeunload warning and the recovery prompt.
//
// Every function here resolves rather than rejects on a storage failure
// (private browsing, a blocked origin, a quota error, no IndexedDB at all).
// Autosave is a safety net: it must never be the thing that breaks data entry.
// Callers get `false`/`null` and decide whether to say anything — see
// ui/autosave.js, which surfaces one quiet notice instead of failing per-write.

const DB_NAME = 'xmlEditorAutosave';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';

/** One snapshot per schema identity, overwritten in place — the point is
 *  "recover the work I was doing", not a version history. */
const SNAPSHOT_KEY_PATH = 'schemaKey';

const MAX_SNAPSHOTS = 10;
const MAX_SNAPSHOT_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function isAutosaveAvailable() {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

// ---------------------------------------------------------------------------
// Schema identity
// ---------------------------------------------------------------------------

/** FNV-1a, 32-bit. Enough to tell two schema sets apart; not a security hash. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * A stable identity for "this schema set, rooted here", used as the snapshot's
 * primary key so recovery is only ever offered against the schema the work was
 * entered under.
 *
 * Deliberately derived from file names + sizes rather than full file contents:
 * a real schema set is tens of files and megabytes, this runs on the schema
 * load path, and a content hash would throw the snapshot away on a cosmetic
 * whitespace edit. The looser key does mean a same-length edit won't
 * invalidate a snapshot, which is survivable: a FormState field value whose
 * path no longer exists in the schema is simply never visited by
 * formRenderer/xmlWriter, so a partially-stale snapshot degrades to "the
 * fields that still exist come back" rather than to corrupt output.
 *
 * @param {Map<string,string>} fileTextMap path → text, as the flattener takes it
 * @param {string} rootFileName
 * @param {string} rootElementName
 * @returns {string}
 */
export function computeSchemaKey(fileTextMap, rootFileName, rootElementName) {
  const files = [...fileTextMap.entries()]
    .map(([name, text]) => `${name}:${text.length}`)
    .sort()
    .join('|');
  return `${rootFileName}#${rootElementName}#${fnv1a(files)}`;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * FormState is already JSON-shaped (plain dicts of strings/booleans/numbers
 * plus the unmatchedFields array), so this is a structural copy rather than a
 * conversion — but going through plain objects explicitly keeps the stored
 * shape independent of whatever FormEngine happens to hold, and keeps
 * IndexedDB's structured clone away from anything it can't serialize.
 *
 * @param {object} args
 * @param {string} args.schemaKey from computeSchemaKey
 * @param {string} args.packetName manifest.packetName, for the recovery prompt
 * @param {Array<{toString: () => string}>} args.instanceKeys appState.instanceKeys, IN ORDER
 * @param {Map<string, object>} args.formStates formEngine.getAllFormStates()
 * @returns {object} the snapshot record
 */
export function buildSnapshot({ schemaKey, packetName, instanceKeys, formStates }) {
  const states = {};
  for (const [storedKey, state] of formStates) {
    states[storedKey] = {
      fieldValues: { ...state.fieldValues },
      repeatingInstanceCounts: { ...state.repeatingInstanceCounts },
      radioSelections: { ...state.radioSelections },
      unmatchedFields: (state.unmatchedFields || []).map((u) => ({ ...u })),
      isDirty: !!state.isDirty,
    };
  }
  return {
    schemaKey,
    packetName: packetName ?? null,
    savedAt: new Date().toISOString(),
    // Natural case, not keyOf()'s lower case: switchToForm feeds
    // instanceKey.formName straight to parseGlobalElement, which looks the
    // element up by its exact schema name (§2/§8). The states dict above is
    // keyed the way FormEngine keys it (lower-cased) and is re-paired with
    // these on restore — see ui/autosave.js's restore handler.
    instanceKeys: instanceKeys.map((k) => k.toString()),
    formStates: states,
    formStateCount: Object.keys(states).length,
  };
}

/** True when a snapshot holds anything worth offering to restore. */
export function snapshotHasWork(snapshot) {
  if (!snapshot?.formStates) return false;
  return Object.values(snapshot.formStates).some(
    (s) => Object.keys(s.fieldValues || {}).length > 0 || Object.keys(s.radioSelections || {}).length > 0
  );
}

// ---------------------------------------------------------------------------
// IndexedDB plumbing
// ---------------------------------------------------------------------------

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (!isAutosaveAvailable()) {
      resolve(null);
      return;
    }
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null); // some browsers throw outright in private-browsing mode
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: SNAPSHOT_KEY_PATH });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      console.warn('[autosaveStore] could not open IndexedDB', request.error);
      resolve(null);
    };
    // Another tab holding an older version open blocks the upgrade; don't hang
    // the caller's promise forever waiting for it to close.
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/** Runs `work(store)` in one transaction and resolves with its request's
 *  result, or with `fallback` if anything at all goes wrong. */
async function withStore(mode, work, fallback) {
  const db = await openDb();
  if (!db) return fallback;
  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(STORE_NAME, mode);
    } catch {
      resolve(fallback);
      return;
    }
    let result = fallback;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => {
      console.warn('[autosaveStore] transaction failed', tx.error);
      resolve(fallback);
    };
    tx.onabort = () => resolve(fallback);
    try {
      const request = work(tx.objectStore(STORE_NAME));
      if (request) request.onsuccess = () => { result = request.result; };
    } catch (err) {
      console.warn('[autosaveStore] store operation threw', err);
      try { tx.abort(); } catch { /* already aborting */ }
      resolve(fallback);
    }
  });
}

/** @returns {Promise<boolean>} whether the write landed */
export async function putSnapshot(snapshot) {
  const stored = await withStore('readwrite', (store) => store.put(snapshot), null);
  return stored !== null;
}

/** @returns {Promise<object|null>} */
export async function getSnapshot(schemaKey) {
  return (await withStore('readonly', (store) => store.get(schemaKey), null)) ?? null;
}

export async function deleteSnapshot(schemaKey) {
  // `delete` resolves with undefined on success, so withStore's result can't
  // distinguish it from the failure fallback; the transaction completing is
  // the signal, which oncomplete already gates.
  await withStore('readwrite', (store) => store.delete(schemaKey), null);
}

/** @returns {Promise<object[]>} newest first */
export async function listSnapshots() {
  const all = (await withStore('readonly', (store) => store.getAll(), null)) ?? [];
  return all.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
}

/**
 * Drops snapshots that are too old or too numerous, so a user who works
 * through many schema sets doesn't accumulate unbounded storage. Called once
 * per schema load, never on the autosave path itself.
 * @returns {Promise<number>} how many were removed
 */
export async function pruneSnapshots({ maxAgeMs = MAX_SNAPSHOT_AGE_MS, maxCount = MAX_SNAPSHOTS, keepSchemaKey = null } = {}) {
  const snapshots = await listSnapshots();
  const cutoff = Date.now() - maxAgeMs;
  const doomed = [];
  let kept = 0;
  for (const snapshot of snapshots) {
    if (snapshot.schemaKey === keepSchemaKey) {
      kept++;
      continue;
    }
    const savedAtMs = Date.parse(snapshot.savedAt);
    const tooOld = Number.isFinite(savedAtMs) && savedAtMs < cutoff;
    if (tooOld || kept >= maxCount) doomed.push(snapshot.schemaKey);
    else kept++;
  }
  for (const schemaKey of doomed) await deleteSnapshot(schemaKey);
  return doomed.length;
}
