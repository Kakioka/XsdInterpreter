// js/ui/autosave.js — debounced autosave, unload warning, crash recovery.
//
// dev/IMPROVEMENT_BACKLOG.md C.1. The persistence itself lives in
// js/core/autosaveStore.js (zero DOM); this file owns the three parts that
// need the page: when to write, warning before an unload that would lose
// work, and the prompt that offers a found snapshot back.
//
// Autosave is a safety net, so nothing here is allowed to interfere with data
// entry: every write is fire-and-forget, a storage failure is reported once in
// the status bar and then never again, and no code path awaits a write before
// letting the user keep typing.

import {
  isAutosaveAvailable,
  buildSnapshot,
  snapshotHasWork,
  putSnapshot,
  getSnapshot,
  deleteSnapshot,
  pruneSnapshots,
} from '../core/autosaveStore.js';

/** Long enough that continuous typing doesn't write on every keystroke, short
 *  enough that a crash costs at most a sentence of work. */
const DEBOUNCE_MS = 1500;

let state = null; // set by wireAutosave
let debounceTimer = null;
let reportedUnavailable = false;

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function setAutosaveStatus(text, title) {
  const el = document.getElementById('autosave-status');
  if (!el) return;
  el.textContent = text;
  el.title = title || '';
}

function reportUnavailableOnce() {
  if (reportedUnavailable) return;
  reportedUnavailable = true;
  setAutosaveStatus(
    'Autosave off',
    'Browser storage is unavailable (private browsing, or site data blocked), so work in progress cannot be recovered after a crash. Save XML regularly.'
  );
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function currentSnapshot() {
  const { appState, schemaKey, packetName } = state;
  if (!schemaKey) return null;
  return buildSnapshot({
    schemaKey,
    packetName,
    instanceKeys: appState.instanceKeys,
    formStates: appState.formEngine.getAllFormStates(),
  });
}

async function writeNow() {
  if (!state?.schemaKey || state.recoveryPending) return;
  // Capture an in-progress edit that hasn't fired `change` yet — the same
  // reason saveXml and buildCurrentPacketXml flush first (§6, §22 invariant 3).
  // Without this, autosave lags one field behind whatever is focused, which is
  // exactly the field the user was working on when the tab died.
  state.appState.formEngine.flushRegisteredControls();
  const snapshot = currentSnapshot();
  if (!snapshot) return;
  const ok = await putSnapshot(snapshot);
  if (!ok) {
    reportUnavailableOnce();
    return;
  }
  setAutosaveStatus(`Autosaved ${new Date().toLocaleTimeString()}`, 'Work in progress is stored in this browser and offered back if the tab closes unexpectedly.');
}

/** Debounced. Wired to FormEngine's value/dirty events and undoService's
 *  'changed' in wireAutosave below, which between them cover every way state
 *  changes — a caller that finds a path they don't cover should export this
 *  rather than reaching for a timer of its own. */
function scheduleAutosave() {
  if (!state?.schemaKey || state.recoveryPending) return;
  if (!isAutosaveAvailable()) {
    reportUnavailableOnce();
    return;
  }
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    writeNow().catch((err) => {
      console.warn('[autosave] write failed', err);
      reportUnavailableOnce();
    });
  }, DEBOUNCE_MS);
}

/** Writes immediately, skipping the debounce. Page hide calls it
 *  fire-and-forget (an unload handler can't await anything, but an IndexedDB
 *  write started there usually still completes); app.js's switchRoot awaits
 *  it, so the write lands under the outgoing root's key before the key moves.
 *  Never rejects. */
export function flushAutosave() {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  return writeNow().catch(() => reportUnavailableOnce());
}

/** Called after a successful Save XML — the work is on disk now, so a
 *  recovery prompt on the next load would be offering back something the user
 *  already has. */
export async function clearSnapshot() {
  if (!state?.schemaKey) return;
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  await deleteSnapshot(state.schemaKey);
  setAutosaveStatus('Autosave ready', 'Work in progress is stored in this browser and offered back if the tab closes unexpectedly.');
}

// ---------------------------------------------------------------------------
// Schema identity
// ---------------------------------------------------------------------------

/**
 * Told to autosave which schema the current session is working against; until
 * this is called there is nothing to key a snapshot by, so scheduleAutosave()
 * is a no-op. Call from app.js's loadSchema once the manifest exists.
 */
export function setSchemaIdentity(schemaKey, packetName) {
  if (!state) return;
  // Hold every write until offerRecovery() has settled. The schema load
  // around this call clears undo history and renders the first form, both of
  // which schedule a write — of the BLANK state, which would land under this
  // key while the recovery prompt is still open and overwrite the very
  // snapshot being offered. A write already pending from before the switch
  // would land under the new key too, so it's dropped (switchRoot flushes
  // its outgoing root before getting here). Page-hide flushes are held as
  // well: a tab dying with the prompt open is exactly when the stored copy
  // matters.
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  state.recoveryPending = true;
  state.schemaKey = schemaKey;
  state.packetName = packetName;
  if (!isAutosaveAvailable()) {
    reportUnavailableOnce();
    return;
  }
  // Stays this way if the load throws before offerRecovery() runs: the
  // half-built state shouldn't be written over a good snapshot, and the
  // status says so rather than claiming autosave is running.
  setAutosaveStatus('Autosave paused', 'Checking this browser for unsaved work on this schema before autosaving resumes.');
  // Housekeeping, not on the autosave path: keep the current schema's snapshot
  // whatever its age, prune everything else down to the cap.
  pruneSnapshots({ keepSchemaKey: schemaKey }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Recovery prompt
// ---------------------------------------------------------------------------

function describeAge(savedAt) {
  const ms = Date.now() - Date.parse(savedAt);
  if (!Number.isFinite(ms) || ms < 0) return 'recently';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Built into #recovery-dialog-overlay on first use, same empty-container
 *  pattern as #choose-root-dialog-overlay. Resolves true to restore. */
function askToRestore(snapshot) {
  const overlay = document.getElementById('recovery-dialog-overlay');
  if (!overlay) {
    // Harnesses don't include the container; fall back to the same
    // question through a confirm() rather than silently discarding work.
    return Promise.resolve(window.confirm(`Unsaved work from ${describeAge(snapshot.savedAt)} was found. Restore it?`));
  }

  overlay.innerHTML = '';
  const dialog = document.createElement('div');
  dialog.id = 'recovery-dialog';

  const header = document.createElement('div');
  header.id = 'recovery-dialog-header';
  header.textContent = 'Unsaved work found';

  const body = document.createElement('div');
  body.id = 'recovery-dialog-body';
  const lead = document.createElement('p');
  const formCount = snapshot.instanceKeys?.length ?? 0;
  lead.textContent = `This browser has unsaved work for ${snapshot.packetName || 'this packet'}, autosaved ${describeAge(
    snapshot.savedAt
  )} (${formCount} form${formCount === 1 ? '' : 's'}). Restore it?`;
  const detail = document.createElement('p');
  detail.className = 'hint';
  detail.textContent = 'Discarding deletes the stored copy. Restoring replaces the blank forms just loaded.';
  body.append(lead, detail);

  const footer = document.createElement('div');
  footer.id = 'recovery-dialog-footer';
  const discardBtn = document.createElement('button');
  discardBtn.type = 'button';
  discardBtn.textContent = 'Discard';
  const restoreBtn = document.createElement('button');
  restoreBtn.type = 'button';
  restoreBtn.id = 'recovery-dialog-restore-btn';
  restoreBtn.textContent = 'Restore';
  footer.append(discardBtn, restoreBtn);

  dialog.append(header, body, footer);
  overlay.appendChild(dialog);
  overlay.classList.remove('hidden');
  restoreBtn.focus();

  return new Promise((resolve) => {
    const settle = (value) => {
      overlay.classList.add('hidden');
      resolve(value);
    };
    discardBtn.addEventListener('click', () => settle(false));
    restoreBtn.addEventListener('click', () => settle(true));
  });
}

/**
 * Looks for a snapshot matching the just-loaded schema and, if it holds any
 * actual work, offers it back. Call AFTER the loading overlay has come down —
 * app.js's loadSchema runs inside withBusyOverlay, and a modal shown from
 * inside that has to out-rank it (the trap documented on
 * #choose-root-dialog-overlay in css/main.css).
 *
 * @returns {Promise<boolean>} true if the caller's restore callback ran
 */
export async function offerRecovery() {
  if (!state?.schemaKey) return false;
  try {
    if (!isAutosaveAvailable()) return false;
    const snapshot = await getSnapshot(state.schemaKey);
    if (!snapshot || !snapshotHasWork(snapshot)) return false;

    const restore = await askToRestore(snapshot);
    if (!restore) {
      await deleteSnapshot(state.schemaKey);
      return false;
    }
    // Release the hold BEFORE restoring, so the restore's own state changes
    // schedule a write of the restored work like any other edit would.
    releaseRecoveryHold();
    state.restoreSnapshot(snapshot);
    return true;
  } finally {
    releaseRecoveryHold();
  }
}

function releaseRecoveryHold() {
  if (!state?.recoveryPending) return;
  state.recoveryPending = false;
  if (isAutosaveAvailable() && !reportedUnavailable) {
    setAutosaveStatus('Autosave ready', 'Work in progress is stored in this browser and offered back if the tab closes unexpectedly.');
  }
  // Anything typed while the prompt was up (nothing, normally — it's modal)
  // or left over from the load gets written now under the settled key.
  if (hasUnsavedWork()) scheduleAutosave();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function hasUnsavedWork() {
  if (!state?.appState?.formEngine) return false;
  for (const formState of state.appState.formEngine.getAllFormStates().values()) {
    if (formState.isDirty) return true;
  }
  return false;
}

/**
 * @param {object} args
 * @param {object} args.appState app.js's live appState
 * @param {(snapshot: object) => void} args.restoreSnapshot app.js's applier —
 *   rebuilds instanceKeys + FormEngine state from a snapshot and re-renders.
 */
export function wireAutosave({ appState, restoreSnapshot }) {
  state = { appState, restoreSnapshot, schemaKey: null, packetName: null, recoveryPending: false };

  // Value edits and dirty flips cover ordinary data entry; undoService's
  // 'changed' covers undo/redo, which mutates state without going through
  // either (it replays through switchToForm's mutateState hook instead).
  appState.formEngine.addEventListener('controlValueChanged', scheduleAutosave);
  appState.formEngine.addEventListener('dirtyChanged', scheduleAutosave);
  appState.undoService.addEventListener('changed', scheduleAutosave);

  // The immediate stopgap C.1 asks for, independent of whether IndexedDB
  // works at all: a browser-native "are you sure" whenever closing the tab
  // would drop unsaved values.
  window.addEventListener('beforeunload', (e) => {
    if (!hasUnsavedWork()) return;
    flushAutosave();
    e.preventDefault();
    e.returnValue = ''; // required by older browsers to actually show the prompt
  });

  // beforeunload doesn't fire when the OS discards a backgrounded tab, which
  // is one of the exact scenarios C.1 names; pagehide does.
  window.addEventListener('pagehide', () => {
    if (hasUnsavedWork()) flushAutosave();
  });

  if (!isAutosaveAvailable()) reportUnavailableOnce();
}
