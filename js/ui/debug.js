// js/ui/debug.js — Debug panel (developer mode).
//
// See web-implementation-spec.md §21 (Debug Panel). IMPLEMENTATION_PLAN.md
// Phase 7.3.
//
// Like contextMenu.js's #context-menu, index.html gives this module just an
// empty `<div id="debug-panel" class="hidden"></div>` — the tab structure is
// built here on first wire, not sketched in the page's static HTML.
//
// Reads appState fresh on every render (currentInstanceKey/formEngine/
// schemaParser) rather than caching it the way coloring.js does — this only
// (re)renders on a toggle, a tab click, or a 200ms-debounced value-change
// event (§21 "Refresh"), so there's no hot path here to optimize against.

let _appState = null;
let _activeTab = 'fields';
let _selectedSchemaPath = null; // Schema Tree tab's clicked-node detail selection
let _debounceTimer = null;

const TABS = [
  { id: 'fields', label: 'Fields' },
  { id: 'schema', label: 'Schema Tree' },
  { id: 'state', label: 'State' },
  { id: 'export', label: 'Export' },
];

export function wireDebug({ appState }) {
  _appState = appState;
  const panel = document.getElementById('debug-panel');
  if (!panel) return;

  buildShell(panel);
  document.getElementById('debug-toggle-btn')?.addEventListener('click', togglePanel);

  document.addEventListener('keydown', (e) => {
    if (isOverlayVisible()) return; // §13: overlay is the real guard against shortcuts firing mid-operation
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || !e.shiftKey || e.key.toLowerCase() !== 'd') return;
    e.preventDefault();
    togglePanel();
  });

  // §21 "Refresh: debounce 200ms on formEngine.controlValueChanged. No-op when
  // panel is hidden" — checked inside render() itself, not here, so a render
  // triggered some OTHER way (tab click, panel open) isn't accidentally skipped.
  appState.formEngine.addEventListener('controlValueChanged', () => {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(render, 200);
  });
}

function isOverlayVisible() {
  const overlay = document.getElementById('loading-overlay');
  return !!overlay && !overlay.classList.contains('hidden');
}

function isPanelVisible() {
  return !document.getElementById('debug-panel')?.classList.contains('hidden');
}

export function togglePanel() {
  const panel = document.getElementById('debug-panel');
  if (!panel) return;
  panel.classList.toggle('hidden');
  if (isPanelVisible()) render();
}

// ---------------------------------------------------------------------------
// Shell: header, tab bar, resize handle, body host
// ---------------------------------------------------------------------------

function buildShell(panel) {
  panel.innerHTML = '';

  const resizeHandle = document.createElement('div');
  resizeHandle.id = 'debug-resize-handle';
  wireResizeHandle(resizeHandle, panel);
  panel.appendChild(resizeHandle);

  const header = document.createElement('div');
  header.id = 'debug-panel-header';
  const title = document.createElement('span');
  title.textContent = 'Debug Panel';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', togglePanel);
  header.append(title, closeBtn);
  panel.appendChild(header);

  const tabBar = document.createElement('div');
  tabBar.id = 'debug-panel-tabs';
  for (const tab of TABS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'debug-tab-btn';
    btn.textContent = tab.label;
    btn.dataset.tab = tab.id;
    btn.addEventListener('click', () => {
      _activeTab = tab.id;
      render();
    });
    tabBar.appendChild(btn);
  }
  panel.appendChild(tabBar);

  const body = document.createElement('div');
  body.id = 'debug-panel-body';
  panel.appendChild(body);
}

function wireResizeHandle(handle, panel) {
  const STORAGE_KEY = 'xmlEditor.debugPanelWidth';
  let saved;
  try {
    saved = Number(localStorage.getItem(STORAGE_KEY));
  } catch {
    saved = 0;
  }
  if (saved > 0) panel.style.width = `${saved}px`;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panel.getBoundingClientRect().width;
    function onMove(ev) {
      const width = Math.min(Math.max(startWidth - (ev.clientX - startX), 260), window.innerWidth * 0.8);
      panel.style.width = `${width}px`;
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try {
        localStorage.setItem(STORAGE_KEY, String(panel.getBoundingClientRect().width));
      } catch {
        // ignore — resizing still works for this session
      }
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ---------------------------------------------------------------------------
// Render dispatch
// ---------------------------------------------------------------------------

function render() {
  if (!isPanelVisible()) return; // §21 "No-op when panel is hidden"
  const panel = document.getElementById('debug-panel');
  panel?.querySelectorAll('.debug-tab-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === _activeTab));

  const body = document.getElementById('debug-panel-body');
  if (!body) return;
  body.innerHTML = '';

  switch (_activeTab) {
    case 'fields':
      body.appendChild(renderFieldsTab());
      break;
    case 'schema':
      body.appendChild(renderSchemaTab());
      break;
    case 'state':
      body.appendChild(renderStateTab());
      break;
    case 'export':
      body.appendChild(renderExportTab());
      break;
  }
}

// ---------------------------------------------------------------------------
// Fields tab — Path | Kind | Required | Value
// ---------------------------------------------------------------------------

/** Resolves a runtime (possibly `[i]`-indexed) field path back to its static
 *  SchemaElement node, the same index-stripping per-segment walk contextMenu.js
 *  uses for container paths — a RadioGroup's selected option is just another
 *  named child here, so no special-casing is needed for it either (§22
 *  invariant 29: the option's name is a real path segment). */
function resolveSchemaNode(rootElement, path) {
  if (!rootElement || !path) return null;
  const segments = path.split('.').map((s) => s.replace(/\[\d+\]$/, ''));
  if (segments[0]?.toLowerCase() !== rootElement.elementName.toLowerCase()) return null;
  let node = rootElement;
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i].toLowerCase();
    const found = node.children?.find((c) => c.elementName.toLowerCase() === seg);
    if (!found) return null;
    node = found;
  }
  return node;
}

/** @returns {Array<{path:string, kind:string, required:boolean, value:*}>} */
function collectFieldRows() {
  const formEngine = _appState?.formEngine;
  const instanceKey = _appState?.currentInstanceKey;
  if (!formEngine || !instanceKey) return [];
  const rootElement = _appState.schemaParser?.parseGlobalElement(instanceKey.formName);

  const rows = [];
  for (const controlRef of formEngine.registeredControls.values()) {
    const path = controlRef.elementPath;
    const node = resolveSchemaNode(rootElement, path);
    rows.push({
      path,
      kind: node?.kind ?? '(unknown)',
      required: !!node?.isRequired,
      value: controlRef.getValue(),
    });
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  return rows;
}

function renderFieldsTab() {
  const wrap = document.createElement('div');
  if (!_appState?.currentInstanceKey) {
    wrap.textContent = 'No form is active.';
    return wrap;
  }
  const rows = collectFieldRows();
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>Path</th><th>Kind</th><th>Required</th><th>Value</th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(row.path)}</td><td>${escapeHtml(row.kind)}</td><td>${row.required ? 'Yes' : 'No'}</td><td>${escapeHtml(formatValue(row.value))}</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'No controls are currently registered.';
    wrap.appendChild(empty);
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// Schema Tree tab — collapsible tree of the active form's SchemaElement tree
// ---------------------------------------------------------------------------

function renderSchemaTab() {
  const wrap = document.createElement('div');
  const instanceKey = _appState?.currentInstanceKey;
  const rootElement = instanceKey ? _appState.schemaParser?.parseGlobalElement(instanceKey.formName) : null;
  if (!rootElement) {
    wrap.textContent = 'No form is active.';
    return wrap;
  }

  const treeHost = document.createElement('div');
  treeHost.id = 'debug-tree-host';
  treeHost.appendChild(buildTreeNode(rootElement));
  wrap.appendChild(treeHost);

  const detail = document.createElement('pre');
  detail.id = 'debug-tree-detail';
  detail.textContent = _selectedSchemaPath ? describeNode(resolveSchemaNode(rootElement, _selectedSchemaPath)) : 'Click a node above to see its full details.';
  wrap.appendChild(detail);

  return wrap;
}

function buildTreeNode(element, path = element.elementName) {
  const li = document.createElement('div');
  li.className = 'debug-tree-node';

  const hasChildren = element.children && element.children.length > 0;
  const label = document.createElement('span');
  label.className = 'debug-tree-label';
  if (path === _selectedSchemaPath) label.classList.add('selected');
  label.textContent = `${hasChildren ? '▾' : '•'} ${element.elementName} (${element.kind})`;
  label.addEventListener('click', () => {
    _selectedSchemaPath = path;
    render();
  });
  li.appendChild(label);

  if (hasChildren) {
    const childrenHost = document.createElement('div');
    for (const child of element.children) {
      childrenHost.appendChild(buildTreeNode(child, `${path}.${child.elementName}`));
    }
    li.appendChild(childrenHost);
  }

  return li;
}

function describeNode(node) {
  if (!node) return '(node not found)';
  const { children, ...rest } = node;
  return JSON.stringify({ ...rest, childCount: children?.length ?? 0 }, null, 2);
}

// ---------------------------------------------------------------------------
// State tab — repeating counts, radio selections, stored forms list
// ---------------------------------------------------------------------------

function renderStateTab() {
  const wrap = document.createElement('div');
  const formEngine = _appState?.formEngine;
  if (!formEngine) {
    wrap.textContent = 'No schema loaded.';
    return wrap;
  }

  const storedList = document.createElement('div');
  const storedHeading = document.createElement('h5');
  storedHeading.textContent = `Stored form instances (${formEngine.storedStates.size})`;
  storedList.appendChild(storedHeading);
  const ul = document.createElement('ul');
  for (const [key, state] of formEngine.storedStates) {
    const li = document.createElement('li');
    const isActive = _appState.currentInstanceKey && key === _appState.currentInstanceKey.toString().toLowerCase();
    li.textContent = `${key}${isActive ? ' (active)' : ''} — dirty: ${state.isDirty}`;
    ul.appendChild(li);
  }
  storedList.appendChild(ul);
  wrap.appendChild(storedList);

  const instanceKey = _appState.currentInstanceKey;
  if (instanceKey) {
    const state = formEngine.getFormState(instanceKey);
    wrap.appendChild(labeledPre('Repeating instance counts (active form)', state?.repeatingInstanceCounts ?? {}));
    wrap.appendChild(labeledPre('Radio selections (active form)', state?.radioSelections ?? {}));
  }

  return wrap;
}

function labeledPre(label, obj) {
  const wrap = document.createElement('div');
  const heading = document.createElement('h5');
  heading.textContent = label;
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(obj, null, 2);
  wrap.append(heading, pre);
  return wrap;
}

// ---------------------------------------------------------------------------
// Export tab — Copy TSV, Export JSON
// ---------------------------------------------------------------------------

function renderExportTab() {
  const wrap = document.createElement('div');

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.textContent = 'Copy TSV';
  copyBtn.addEventListener('click', async () => {
    const tsv = fieldsToTsv(collectFieldRows());
    try {
      await navigator.clipboard.writeText(tsv);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => (copyBtn.textContent = 'Copy TSV'), 1200);
    } catch (err) {
      window.alert(`Could not copy to clipboard: ${err.message}`);
    }
  });

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.textContent = 'Export JSON';
  exportBtn.addEventListener('click', () => downloadJson(buildExportData()));

  wrap.append(copyBtn, exportBtn);
  return wrap;
}

function fieldsToTsv(rows) {
  const header = ['Path', 'Kind', 'Required', 'Value'].join('\t');
  const lines = rows.map((r) => [r.path, r.kind, r.required ? 'Yes' : 'No', formatValue(r.value)].join('\t'));
  return [header, ...lines].join('\n');
}

function buildExportData() {
  const formEngine = _appState?.formEngine;
  const instanceKey = _appState?.currentInstanceKey;
  const state = formEngine && instanceKey ? formEngine.getFormState(instanceKey) : null;
  return {
    activeInstanceKey: instanceKey ? instanceKey.toString() : null,
    fields: collectFieldRows(),
    repeatingInstanceCounts: state?.repeatingInstanceCounts ?? {},
    radioSelections: state?.radioSelections ?? {},
    storedFormInstances: formEngine ? [...formEngine.storedStates.keys()] : [],
    exportedAt: new Date().toISOString(),
  };
}

function downloadJson(obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'debug-state.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function formatValue(value) {
  if (value === undefined) return '';
  if (value === null) return 'null';
  return String(value);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
