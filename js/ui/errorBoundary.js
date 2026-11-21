// js/ui/errorBoundary.js — global error boundary and in-session crash log.
//
// dev/IMPROVEMENT_BACKLOG.md B.3 ("No error boundary"), the web counterpart of
// the WPF app's crash logging (commit 7c084b4, wired in App.xaml.cs). Nothing
// in web-implementation-spec.md covers this — it's an addition, not parity
// work, and it sits in Phase 0 of dev/IMPLEMENTATION_ORDER.md purely as
// data-loss protection.
//
// The failure this exists for: a throw partway through app.js's switchToForm
// leaves a half-built DOM in #form-content-host with appState.currentInstanceKey
// already reassigned. Nothing surfaces, the UI is simply dead, and the user's
// unsaved work is still sitting in FormEngine with no way to reach it. So the
// panel's first job is not the message — it's the two download buttons, which
// read state straight out of FormEngine and hand it back as a file.
//
// Both download paths are independently fallible (buildPacketXml is itself a
// plausible source of the crash being reported), so each gets its own
// try/catch and the failure of one never hides the other. The raw-state JSON
// dump has no schema dependency at all, which makes it the last-resort path
// that still works when the whole write pipeline is broken.
//
// Built into #error-boundary-overlay on first use, same empty-container
// pattern as #debug-panel / #context-menu / #choose-root-dialog-overlay.

import { downloadBlob } from './toolbar.js';

const MAX_LOG_ENTRIES = 25;

/** @type {Array<{when: Date, source: string, name: string, message: string, stack: string}>} */
const errorLog = [];

let hooks = null;
let reporting = false; // re-entrancy guard: a throw inside the boundary itself must not recurse

export function getErrorLog() {
  return errorLog.slice();
}

function describe(error) {
  if (error instanceof Error) {
    return { name: error.name || 'Error', message: error.message || String(error), stack: error.stack || '' };
  }
  // A non-Error rejection value (a thrown string, a rejected fetch response, …)
  // has no stack to offer; keep whatever string form it has rather than
  // printing "[object Object]".
  let message;
  try {
    message = typeof error === 'string' ? error : JSON.stringify(error);
  } catch {
    message = String(error);
  }
  return { name: 'Error', message: message ?? String(error), stack: '' };
}

/**
 * Records an error and shows (or updates) the recovery panel. Exported so a
 * caller that already has a try/catch can route a swallowed-but-serious error
 * here instead of only console.error-ing it.
 * @param {unknown} error
 * @param {string} source - how it reached us ('window.onerror', 'unhandledrejection', or a caller's own label)
 */
export function reportError(error, source = 'reportError') {
  if (reporting) return;
  reporting = true;
  try {
    const entry = { when: new Date(), source, ...describe(error) };
    errorLog.push(entry);
    if (errorLog.length > MAX_LOG_ENTRIES) errorLog.shift();
    console.error(`[errorBoundary:${source}]`, error);

    // The crash may well have happened inside withBusyOverlay's work callback
    // on a path that never reaches its finally (or inside an un-awaited
    // promise started from there), which would leave the modal loading overlay
    // covering the page — including this panel. Clear it first.
    document.getElementById('loading-overlay')?.classList.add('hidden');

    showPanel(entry);
  } catch (boundaryError) {
    console.error('[errorBoundary] failed while reporting an error', boundaryError);
  } finally {
    reporting = false;
  }
}

// ---------------------------------------------------------------------------
// Recovery actions
// ---------------------------------------------------------------------------

function timestampSuffix() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function setActionNote(text, isError) {
  const note = document.getElementById('error-boundary-note');
  if (!note) return;
  note.textContent = text;
  note.classList.toggle('error', !!isError);
}

function downloadRecoveryXml() {
  const noSchemaMessage = 'No schema is loaded, so there is no XML to build. Use "Download raw state" instead.';
  if (!hooks?.getRecoveryXml) {
    setActionNote(noSchemaMessage, true);
    return;
  }
  try {
    const xml = hooks.getRecoveryXml();
    if (!xml) {
      setActionNote(noSchemaMessage, true);
      return;
    }
    const name = `${hooks.getPacketName?.() || 'recovered'}-recovered-${timestampSuffix()}.xml`;
    downloadBlob(new Blob([xml], { type: 'application/xml' }), name);
    setActionNote(`Downloaded ${name}.`, false);
  } catch (err) {
    // Entirely expected when the reported crash IS in the write pipeline —
    // say so plainly and point at the path that doesn't go through it.
    console.error('[errorBoundary] building recovery XML failed', err);
    setActionNote(
      `Could not build XML (${describe(err).message}). Use "Download raw state" instead — it does not go through the XML writer.`,
      true
    );
  }
}

function downloadRawState() {
  try {
    const dump = {
      savedAt: new Date().toISOString(),
      packetName: hooks?.getPacketName?.() ?? null,
      errors: errorLog.map((e) => ({ when: e.when.toISOString(), source: e.source, name: e.name, message: e.message, stack: e.stack })),
      state: hooks?.getStateJson?.() ?? null,
    };
    const name = `${hooks?.getPacketName?.() || 'recovered'}-state-${timestampSuffix()}.json`;
    downloadBlob(new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' }), name);
    setActionNote(`Downloaded ${name}. It holds every field value as raw JSON — keep it even though it isn't directly loadable.`, false);
  } catch (err) {
    console.error('[errorBoundary] dumping raw state failed', err);
    setActionNote(`Could not dump state (${describe(err).message}). Copy the error details below and report them.`, true);
  }
}

function detailsText() {
  return errorLog
    .map((e) => `[${e.when.toISOString()}] (${e.source}) ${e.name}: ${e.message}\n${e.stack || '(no stack)'}`)
    .join('\n\n');
}

async function copyDetails() {
  try {
    await navigator.clipboard.writeText(detailsText());
    setActionNote('Error details copied to the clipboard.', false);
  } catch {
    // Clipboard access is permission-gated and unavailable over plain http in
    // some browsers; the <pre> below is already selectable, so just say so.
    setActionNote('Could not access the clipboard — select the details below and copy manually.', true);
  }
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function buildPanel(overlay) {
  overlay.innerHTML = '';

  const dialog = document.createElement('div');
  dialog.id = 'error-boundary-dialog';

  const header = document.createElement('div');
  header.id = 'error-boundary-header';
  const title = document.createElement('span');
  title.textContent = 'Something went wrong';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '✕';
  closeBtn.title = 'Dismiss and keep working';
  closeBtn.addEventListener('click', hidePanel);
  header.append(title, closeBtn);

  const body = document.createElement('div');
  body.id = 'error-boundary-body';

  const lead = document.createElement('p');
  lead.id = 'error-boundary-lead';
  lead.textContent =
    'The app hit an unexpected error. Your entered data is still in memory — download it now, before anything else.';

  const actions = document.createElement('div');
  actions.id = 'error-boundary-actions';
  const xmlBtn = document.createElement('button');
  xmlBtn.type = 'button';
  xmlBtn.id = 'error-boundary-download-xml-btn';
  xmlBtn.textContent = 'Download work in progress (XML)';
  xmlBtn.addEventListener('click', downloadRecoveryXml);
  const stateBtn = document.createElement('button');
  stateBtn.type = 'button';
  stateBtn.id = 'error-boundary-download-state-btn';
  stateBtn.textContent = 'Download raw state (JSON)';
  stateBtn.addEventListener('click', downloadRawState);
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.textContent = 'Copy error details';
  copyBtn.addEventListener('click', copyDetails);
  actions.append(xmlBtn, stateBtn, copyBtn);

  const note = document.createElement('p');
  note.id = 'error-boundary-note';

  const details = document.createElement('details');
  details.id = 'error-boundary-details';
  const summary = document.createElement('summary');
  summary.id = 'error-boundary-summary';
  const pre = document.createElement('pre');
  pre.id = 'error-boundary-stack';
  details.append(summary, pre);

  body.append(lead, actions, note, details);

  const footer = document.createElement('div');
  footer.id = 'error-boundary-footer';
  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.textContent = 'Dismiss and keep working';
  dismissBtn.addEventListener('click', hidePanel);
  const reloadBtn = document.createElement('button');
  reloadBtn.type = 'button';
  reloadBtn.textContent = 'Reload the app';
  // Deliberately not behind a confirm() — the panel's whole premise is that
  // the download buttons above are how the user keeps their work, and
  // autosave.js's beforeunload handler still fires on a reload while anything
  // is dirty, so the browser asks on our behalf.
  reloadBtn.addEventListener('click', () => window.location.reload());
  footer.append(dismissBtn, reloadBtn);

  dialog.append(header, body, footer);
  overlay.appendChild(dialog);
}

function showPanel(entry) {
  const overlay = document.getElementById('error-boundary-overlay');
  // Harnesses (dev/*.html) don't include the container; the console.error in
  // reportError is the whole report there.
  if (!overlay) return;
  if (!overlay.firstElementChild) buildPanel(overlay);

  const count = errorLog.length;
  document.getElementById('error-boundary-summary').textContent =
    count === 1
      ? `${entry.name}: ${entry.message}`
      : `${entry.name}: ${entry.message} (${count} errors this session — expand for all)`;
  document.getElementById('error-boundary-stack').textContent = detailsText();
  setActionNote('', false);

  const xmlBtn = document.getElementById('error-boundary-download-xml-btn');
  if (xmlBtn) xmlBtn.disabled = !hooks?.getRecoveryXml;

  overlay.classList.remove('hidden');
}

function hidePanel() {
  document.getElementById('error-boundary-overlay')?.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * Call as the FIRST thing in app.js's init(), before any other wiring — a
 * throw in a later init() step is exactly the kind of dead-UI-with-no-message
 * failure this is here to surface.
 *
 * @param {{getRecoveryXml?: () => string|null,
 *          getStateJson?: () => unknown,
 *          getPacketName?: () => string|null}} [recoveryHooks]
 *   All optional and all called inside try/catch — the boundary degrades to
 *   "show the message, offer no downloads" rather than failing to install.
 */
export function installErrorBoundary(recoveryHooks = {}) {
  hooks = recoveryHooks;

  window.addEventListener('error', (e) => {
    // A failed <img>/<script>/<link> load also fires 'error' at window on the
    // capture path, but carries no `error` and targets an element rather than
    // the window — those aren't app crashes and shouldn't open the panel.
    if (e.target && e.target !== window) return;
    reportError(e.error ?? e.message, 'window.onerror');
  });

  window.addEventListener('unhandledrejection', (e) => {
    reportError(e.reason, 'unhandledrejection');
  });
}
