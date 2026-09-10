// js/ui/toolbar.js — Toolbar button handlers, plus the rest of §13's Page
// Layout wiring that doesn't warrant its own file: the sidebar splitter,
// zoom, and the status bar's save-state indicator (Phase 7.2).
//
// See web-implementation-spec.md §13 (Page Layout — Toolbar HTML, Resizable
// Sidebar Splitter, Zoom) and §24 (Browser Compatibility Notes — File System
// Access API with <input webkitdirectory> fallback). IMPLEMENTATION_PLAN.md
// Phase 3.3 (toolbar), Phase 7.2 (splitter/zoom/status bar).
//
// Note: unlike the toolbar HTML sketched in §13, `load-xml-btn` and
// `add-form-btn` start `disabled` here (index.html) and get enabled only once
// a schema is loaded — reading XML or adding a form instance both require a
// manifest/parser to already exist, so enabling them earlier would just be an
// invitation to click something that can't do anything yet.

/**
 * Recursively walks a directory handle, collecting every .xsd file underneath
 * it (including nested subfolders) keyed by its path relative to the chosen
 * root. A real MeF schema set nests root candidates and includes/imports
 * arbitrarily deep (e.g. Individual2025/State Schemas/<StateAbbr>/Root/...),
 * so a single-level scan of the chosen folder would silently miss files that
 * live in sibling/cousin folders — the flattener needs the whole tree.
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} relativePath path prefix accumulated so far (empty at the root)
 * @param {Map<string,string>} map filename → text, filled in place
 */
async function walkDirectoryForXsd(dirHandle, relativePath, map) {
  for await (const [name, handle] of dirHandle.entries()) {
    const entryPath = relativePath ? `${relativePath}/${name}` : name;
    if (handle.kind === 'directory') {
      await walkDirectoryForXsd(handle, entryPath, map);
    } else if (handle.kind === 'file' && name.toLowerCase().endsWith('.xsd')) {
      const file = await handle.getFile();
      map.set(entryPath, await file.text());
    }
  }
}

/** @returns {Promise<Map<string,string>>} path (relative to the chosen folder) → text, .xsd files only */
export async function pickSchemaFileTextMap(folderInputEl) {
  if (window.showDirectoryPicker) {
    const dirHandle = await window.showDirectoryPicker();
    const map = new Map();
    await walkDirectoryForXsd(dirHandle, '', map);
    return map;
  }
  return new Promise((resolve, reject) => {
    folderInputEl.value = '';
    folderInputEl.onchange = async () => {
      try {
        // <input webkitdirectory> already recurses the whole subtree on its own;
        // keep each file's relative path (rather than bare name) as the map key
        // so same-named files in different folders don't clobber one another.
        const files = Array.from(folderInputEl.files).filter((f) => f.name.toLowerCase().endsWith('.xsd'));
        const map = new Map();
        for (const f of files) map.set(f.webkitRelativePath || f.name, await f.text());
        resolve(map);
      } catch (err) {
        reject(err);
      }
    };
    folderInputEl.click();
  });
}

/** @returns {Promise<string>} the selected file's text content */
export function pickXmlFileText(xmlInputEl) {
  return new Promise((resolve, reject) => {
    xmlInputEl.value = '';
    xmlInputEl.onchange = async () => {
      try {
        const file = xmlInputEl.files[0];
        if (!file) { reject(new Error('No file selected')); return; }
        resolve(await file.text());
      } catch (err) {
        reject(err);
      }
    };
    xmlInputEl.click();
  });
}

/** Blob + temporary <a download> — works in every target browser (§24),
 *  unlike showSaveFilePicker which is Chrome/Edge-only. */
export function downloadXmlString(xmlString, filename) {
  downloadBlob(new Blob([xmlString], { type: 'application/xml' }), filename);
}

/** Same download mechanism as downloadXmlString, generalized to any Blob —
 *  used by packaging.js for the submission ZIP (§19). */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * @param {{onSchemaFilesSelected: (fileTextMap: Map<string,string>) => Promise<void>,
 *          onXmlTextSelected: (xmlText: string) => Promise<void>,
 *          onSaveXmlRequested: () => void}} handlers
 */
export function wireToolbar({ onSchemaFilesSelected, onXmlTextSelected, onSaveXmlRequested }) {
  const folderInput = document.getElementById('schema-folder-input');
  const xmlInput = document.getElementById('xml-file-input');

  async function loadSchemaClicked() {
    try {
      const fileTextMap = await pickSchemaFileTextMap(folderInput);
      if (fileTextMap.size === 0) return; // user cancelled, or picked a folder with no .xsd files
      await onSchemaFilesSelected(fileTextMap);
    } catch (err) {
      if (err?.name === 'AbortError') return; // user cancelled the directory picker
      console.error(err);
      window.alert(`Failed to load schema: ${err.message}`);
    }
  }
  document.getElementById('load-schema-btn')?.addEventListener('click', loadSchemaClicked);
  document.getElementById('load-schema-menu-btn')?.addEventListener('click', loadSchemaClicked);

  document.getElementById('load-xml-btn')?.addEventListener('click', async () => {
    try {
      const xmlText = await pickXmlFileText(xmlInput);
      await onXmlTextSelected(xmlText);
    } catch (err) {
      console.error(err);
      window.alert(`Failed to load XML: ${err.message}`);
    }
  });

  document.getElementById('save-xml-btn')?.addEventListener('click', () => onSaveXmlRequested());
}

/** Buttons that only make sense once a schema is loaded. */
export function setSchemaDependentButtonsEnabled(enabled) {
  for (const id of ['save-xml-btn', 'load-xml-btn', 'add-form-btn', 'validate-btn', 'fill-all-btn', 'fill-required-btn', 'clear-all-btn']) {
    const el = document.getElementById(id);
    if (el) el.disabled = !enabled;
  }
}

export function setStatus(text) {
  const el = document.getElementById('top-status');
  if (el) el.textContent = text;
}

// ---------------------------------------------------------------------------
// Resizable Sidebar Splitter (§13 "Resizable Sidebar Splitter")
// ---------------------------------------------------------------------------

const SIDEBAR_WIDTH_KEY = 'xmlEditor.sidebarWidth';
const MIN_SIDEBAR_WIDTH = 150;
const MAX_SIDEBAR_WIDTH = 500;

export function wireSplitter() {
  const splitter = document.getElementById('splitter');
  const sidebar = document.getElementById('sidebar');
  if (!splitter || !sidebar) return;

  let saved;
  try {
    saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  } catch {
    saved = 0;
  }
  if (saved > 0) sidebar.style.width = `${clamp(saved, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH)}px`;

  splitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebar.getBoundingClientRect().width;
    document.body.classList.add('resizing-splitter');

    function onMove(ev) {
      const width = clamp(startWidth + (ev.clientX - startX), MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
      sidebar.style.width = `${width}px`;
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('resizing-splitter');
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebar.getBoundingClientRect().width));
      } catch {
        // ignore — resizing still works for this session
      }
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

// ---------------------------------------------------------------------------
// Zoom (§13 "Zoom")
// ---------------------------------------------------------------------------

const ZOOM_KEY = 'xmlEditor.zoomLevel';
const MIN_ZOOM = 50;
const MAX_ZOOM = 200;
const ZOOM_STEP = 10;

function applyZoom(percent) {
  const host = document.getElementById('form-content-host');
  const indicator = document.getElementById('zoom-indicator');
  const clamped = clamp(percent, MIN_ZOOM, MAX_ZOOM);
  if (host) host.style.transform = `scale(${clamped / 100})`;
  if (indicator) indicator.textContent = `${clamped}%`;
  try {
    localStorage.setItem(ZOOM_KEY, String(clamped));
  } catch {
    // ignore — zoom still works for this session
  }
  return clamped;
}

export function wireZoom() {
  let saved;
  try {
    saved = Number(localStorage.getItem(ZOOM_KEY));
  } catch {
    saved = 0;
  }
  let current = applyZoom(saved > 0 ? saved : 100);

  function isOverlayVisible() {
    const overlay = document.getElementById('loading-overlay');
    return !!overlay && !overlay.classList.contains('hidden');
  }

  document.addEventListener('keydown', (e) => {
    if (isOverlayVisible()) return; // §13: overlay is the real guard against shortcuts firing mid-operation
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      current = applyZoom(current + ZOOM_STEP);
    } else if (e.key === '-') {
      e.preventDefault();
      current = applyZoom(current - ZOOM_STEP);
    } else if (e.key === '0') {
      e.preventDefault();
      current = applyZoom(100);
    }
  });

  document.getElementById('form-area')?.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey || isOverlayVisible()) return;
      e.preventDefault();
      current = applyZoom(current + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
    },
    { passive: false }
  );
}

// ---------------------------------------------------------------------------
// Layout: Wrap vs. Stack (§13 toolbar — #layout-toggle-btn)
// ---------------------------------------------------------------------------
//
// Schema-independent, same as theme (index.html's own comment on the Theme
// toolbar group) — enabled here at bootstrap rather than through
// setSchemaDependentButtonsEnabled. "Wrap" lets sibling fields in a
// container flow into a multi-column grid; "Stack" is the plain one-
// field-per-row layout every container renders as unstyled (see the
// "Layout: Wrap mode" block in css/main.css for exactly what the
// `body.layout-wrap` class changes). The button's label always names the
// CURRENTLY active mode, matching the zoom indicator / save-status
// conventions just above.

const LAYOUT_MODE_KEY = 'xmlEditor.layoutMode';

function applyLayoutMode(mode) {
  document.body.classList.toggle('layout-wrap', mode === 'wrap');
  const btn = document.getElementById('layout-toggle-btn');
  if (btn) btn.textContent = mode === 'wrap' ? 'Layout: Wrap' : 'Layout: Stack';
  try {
    localStorage.setItem(LAYOUT_MODE_KEY, mode);
  } catch {
    // ignore — toggle still works for this session
  }
  return mode;
}

export function wireLayoutToggle() {
  const btn = document.getElementById('layout-toggle-btn');
  if (!btn) return;
  let saved;
  try {
    saved = localStorage.getItem(LAYOUT_MODE_KEY);
  } catch {
    saved = null;
  }
  let current = applyLayoutMode(saved === 'stack' ? 'stack' : 'wrap'); // defaults to Wrap, matching the button's static HTML label
  btn.disabled = false;
  btn.addEventListener('click', () => {
    current = applyLayoutMode(current === 'wrap' ? 'stack' : 'wrap');
  });
}

// ---------------------------------------------------------------------------
// Status bar — save-state indicator (§13 Page Layout diagram: "[Not saved]")
// ---------------------------------------------------------------------------

export function setSaveStatus(text) {
  const el = document.getElementById('save-status');
  if (el) el.textContent = text;
}

/** Reflects FormEngine's per-form isDirty flag into the status bar. Listens to
 *  'dirtyChanged' (fired by formEngine.setDirty on every actual flip — fills,
 *  clears, edits, undo/redo, instance add/remove all go through it) rather
 *  than 'controlValueChanged', which for text-like fields fires BEFORE the
 *  dirty flag itself flips true (see formEngine.js's setDirty comment). */
export function wireSaveStatus(appState) {
  function refresh() {
    if (!appState.currentInstanceKey) {
      setSaveStatus('Not saved');
      return;
    }
    const state = appState.formEngine.getFormState(appState.currentInstanceKey);
    setSaveStatus(state?.isDirty ? 'Not saved' : 'Saved');
  }
  appState.formEngine.addEventListener('dirtyChanged', refresh);
  refresh();
  return refresh;
}
