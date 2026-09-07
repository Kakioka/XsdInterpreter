// js/ui/contextMenu.js — Container right-click fill/clear.
//
// See web-implementation-spec.md §18 (Context Menu), §17 "Scoped Fill", §22
// invariant 22. Implemented in IMPLEMENTATION_PLAN.md Phase 6.3.
//
// This module only RESOLVES a right-clicked container into (a) the
// SchemaElement subtree it corresponds to and (b) the runtime path prefix its
// fields live under — the actual FormEngine merge + DOM refresh for fill, and
// the purge + DOM reset for clear, are app.js's job (fillActiveForm /
// clearActiveFormSection), passed in here as callbacks, the same wiring
// pattern undo.js/validation.js/search.js already use (a ctx object holding
// appState plus app.js's own orchestration functions).

let _appState = null;
let _fillActiveForm = null;
let _clearActiveFormSection = null;
let _menuEl = null;

/**
 * @param {{appState: object,
 *   fillActiveForm: (schemaElement:object, parentPath:string, options:object) => void,
 *   clearActiveFormSection: (containerPath:string, containerEl:Element) => void}} ctx
 */
export function wireContextMenu({ appState, fillActiveForm, clearActiveFormSection }) {
  _appState = appState;
  _fillActiveForm = fillActiveForm;
  _clearActiveFormSection = clearActiveFormSection;
  _menuEl = document.getElementById('context-menu');
  if (!_menuEl) return;

  document.addEventListener('contextmenu', (e) => {
    const containerHeader = e.target.closest('[data-container-path]');
    if (!containerHeader) return;
    e.preventDefault();
    // Deviates slightly from §18's literal snippet — which passes the two
    // dataset STRINGS (containerPath, schemaPath) — by passing the element
    // itself instead; it carries both strings via .dataset and lets
    // runScopedClear reset the DOM scoped to the exact node that was
    // right-clicked, rather than re-querying for one that merely shares the
    // same path (never ambiguous today, but avoids relying on that).
    showContextMenu(e.clientX, e.clientY, containerHeader);
  });

  document.addEventListener('click', () => hideContextMenu());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideContextMenu();
  });
}

function showContextMenu(x, y, containerEl) {
  if (!_menuEl || !_appState?.currentInstanceKey) return;
  _menuEl.innerHTML = '';

  const actions = [
    ['Fill All Fields in This Section', () => runScopedFill(containerEl, {})],
    ['Fill Required Fields Only in This Section', () => runScopedFill(containerEl, { requiredOnly: true })],
    ['Clear This Section', () => runScopedClear(containerEl)],
  ];
  for (const [label, handler] of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      handler();
      hideContextMenu();
    });
    _menuEl.appendChild(btn);
  }

  _menuEl.classList.remove('hidden');
  // Position at the click point, then clamp so it never overflows the
  // viewport (§18) — measured AFTER an initial placement, since the menu's
  // real size depends on the buttons just added above.
  _menuEl.style.left = `${x}px`;
  _menuEl.style.top = `${y}px`;
  const rect = _menuEl.getBoundingClientRect();
  const maxX = Math.max(0, window.innerWidth - rect.width - 4);
  const maxY = Math.max(0, window.innerHeight - rect.height - 4);
  _menuEl.style.left = `${Math.min(x, maxX)}px`;
  _menuEl.style.top = `${Math.min(y, maxY)}px`;
}

export function hideContextMenu() {
  _menuEl?.classList.add('hidden');
}

/**
 * Resolves a container's STATIC schema path (data-schema-path — deliberately
 * never rewritten with `[i]` indices, see formRenderer.js's rewritePathPrefix
 * comment) to the matching SchemaElement node, by walking the tree one
 * segment at a time from the form root. Every segment — including synthetic
 * ones (Entry/OptionN/ChoiceGroup wrappers) — is a real elementName in the
 * tree (§8), so a plain per-segment name match is sufficient; no special-
 * casing for RadioGroup/transparent nodes is needed here, same as
 * validateSchema/coloringService's tree walks don't need it either.
 */
function findSchemaNode(rootElement, staticPath) {
  const segments = staticPath.split('.').map((s) => s.replace(/\[\d+\]$/, '')); // defensive strip; schemaPath shouldn't carry indices at all
  if (!rootElement || segments[0]?.toLowerCase() !== rootElement.elementName.toLowerCase()) return null;
  let node = rootElement;
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i].toLowerCase();
    const found = node.children.find((c) => c.elementName.toLowerCase() === seg);
    if (!found) return null;
    node = found;
  }
  return node;
}

function runScopedFill(containerEl, options) {
  const schemaPath = containerEl.dataset.schemaPath;
  const containerPath = containerEl.dataset.containerPath;
  if (!schemaPath || !containerPath || !_appState?.schemaParser || !_appState.currentInstanceKey || !_fillActiveForm) return;

  const rootElement = _appState.schemaParser.parseGlobalElement(_appState.currentInstanceKey.formName);
  const node = findSchemaNode(rootElement, schemaPath);
  if (!node) return;

  const lastDot = containerPath.lastIndexOf('.');
  const parentPath = lastDot === -1 ? '' : containerPath.slice(0, lastDot);
  _fillActiveForm(node, parentPath, options);
}

function runScopedClear(containerEl) {
  const containerPath = containerEl.dataset.containerPath;
  if (!containerPath || !_clearActiveFormSection) return;
  _clearActiveFormSection(containerPath, containerEl);
}
