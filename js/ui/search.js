// js/ui/search.js — Search panel UI.
//
// See web-implementation-spec.md §15 (Search — Search UI). Implemented in
// IMPLEMENTATION_PLAN.md Phase 6.1.

import { search as runSearch } from '../core/searchService.js';

let _appState = null;
let _switchToForm = null;
let _lastHighlighted = null;

/**
 * @param {{appState: object, switchToForm: (instanceKey:import('../core/formEngine.js').FormInstanceKey) => void}} ctx
 *   Same ctx shape as undo.js's wireUndo / validation.js's wireValidation.
 */
export function wireSearch({ appState, switchToForm }) {
  _appState = appState;
  _switchToForm = switchToForm;

  const input = document.getElementById('search-input');
  const resultList = document.getElementById('search-result-list');
  const caseSensitiveEl = document.getElementById('search-case-sensitive');
  const includeDocsEl = document.getElementById('search-include-docs');
  const lineNumberModeEl = document.getElementById('search-line-number-mode');
  if (!input || !resultList) return;

  function runAndRender() {
    if (!_appState?.manifest) {
      resultList.innerHTML = '';
      return;
    }
    const query = input.value.trim();
    const options = {
      caseSensitive: caseSensitiveEl?.checked,
      searchInDocs: includeDocsEl?.checked,
      lineNumberMode: lineNumberModeEl?.checked,
    };
    // The schema is shared across every instance of a repeatable form —
    // search each distinct form NAME once, not once per instance.
    const formNames = [...new Set(_appState.instanceKeys.map((k) => k.formName))];
    const results = query ? runSearch(query, formNames, _appState.schemaParser, options) : [];
    renderResults(results, resultList);
  }

  input.addEventListener('input', runAndRender);
  caseSensitiveEl?.addEventListener('change', runAndRender);
  includeDocsEl?.addEventListener('change', runAndRender);
  lineNumberModeEl?.addEventListener('change', runAndRender);
  document.getElementById('close-search-btn')?.addEventListener('click', closeSearchPanel);

  document.addEventListener('keydown', (e) => {
    const panel = document.getElementById('search-panel');
    if (e.key === 'Escape' && panel && !panel.classList.contains('hidden')) {
      closeSearchPanel();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.key.toLowerCase() !== 'f') return;
    if (isOverlayVisible()) return; // §13: the overlay is the real guard against keyboard shortcuts firing mid-operation
    e.preventDefault(); // block the browser's own native find
    openSearchPanel();
    input.focus();
    input.select();
  });
}

function isOverlayVisible() {
  const overlay = document.getElementById('loading-overlay');
  return !!overlay && !overlay.classList.contains('hidden');
}

export function openSearchPanel() {
  document.getElementById('search-panel')?.classList.remove('hidden');
}

export function closeSearchPanel() {
  document.getElementById('search-panel')?.classList.add('hidden');
  clearHighlight();
}

function renderResults(results, listEl) {
  listEl.innerHTML = '';
  for (const result of results) {
    const li = document.createElement('li');
    li.className = 'search-result';

    const formLabel = document.createElement('span');
    formLabel.className = 'search-result-form';
    formLabel.textContent = result.formName;

    const fieldLabel = document.createElement('span');
    fieldLabel.className = 'search-result-label';
    fieldLabel.textContent = result.label;

    li.append(formLabel, fieldLabel);
    li.addEventListener('click', () => navigateToResult(result));
    listEl.appendChild(li);
  }
}

/** Cross-form: switches forms first (staying on the CURRENT instance if it's
 *  already the right form, rather than jumping to a different instance of a
 *  repeatable form out from under the user), then highlights after render. */
function navigateToResult(result) {
  if (!_appState || !_switchToForm) return;
  const current = _appState.currentInstanceKey;
  const sameForm = (k) => k.formName.toLowerCase() === result.formName.toLowerCase();
  const target = (current && sameForm(current) ? current : null) ?? _appState.instanceKeys.find(sameForm);
  if (!target) return;
  if (!current || !current.equals(target)) _switchToForm(target);
  highlightPath(document.getElementById('form-content-host'), result.elementPath);
}

function clearHighlight() {
  _lastHighlighted?.classList.remove('search-highlight');
  _lastHighlighted = null;
}

/** §15 "Highlight": adds `search-highlight` to the matching `.field-wrapper`
 *  and scrolls it into view. `result.elementPath` is the STATIC schema path
 *  (no `[i]` — see searchService.js's file comment), so an exact match is
 *  tried first and a prefix match (landing on the first instance) falls back
 *  for a field inside a repeating section. */
function highlightPath(rootEl, path) {
  clearHighlight();
  if (!rootEl || !path) return;
  const target =
    rootEl.querySelector(`[data-path="${path}"]`) ||
    rootEl.querySelector(`[data-choice-path="${path}"]`) ||
    rootEl.querySelector(`[data-path^="${path}"]`) ||
    rootEl.querySelector(`[data-choice-path^="${path}"]`);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('search-highlight');
  _lastHighlighted = target;
}
