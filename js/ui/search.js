// js/ui/search.js — Search panel UI.
//
// See web-implementation-spec.md §15 (Search — Search UI). Implemented in
// IMPLEMENTATION_PLAN.md Phase 6.1.

import { search as runSearch, staticPathOf, highlightCandidatePaths } from '../core/searchService.js';

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
  if (!target) {
    setSearchStatus(`${result.formName} has no form in this packet yet — add one to see “${result.label}”.`);
    return;
  }
  if (!current || !current.equals(target)) _switchToForm(target);
  highlightResult(document.getElementById('form-content-host'), result);
}

function clearHighlight() {
  _lastHighlighted?.classList.remove('search-highlight');
  _lastHighlighted = null;
  setSearchStatus('');
}

function setSearchStatus(text) {
  const el = document.getElementById('search-status');
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

/** Has a layout box — false for anything under a `display: none` ancestor
 *  (an unselected radio branch). `offsetParent` would also say null for the
 *  position:fixed case, which is why this asks for client rects instead. */
function isRendered(el) {
  return el.getClientRects().length > 0;
}

/**
 * §15 "Highlight", plus parity 1.7's fallback: adds `search-highlight` to the
 * node for `result.elementPath` and scrolls it into view. That path is STATIC
 * (no `[i]` — see searchService.js's file comment), so rendered paths are
 * compared with their indices stripped, which lands on the first instance of
 * a field inside a repeating section.
 *
 * When the field isn't on screen — inside an unselected radio branch
 * (`display: none`) or a repeating section with no rows (not in the DOM at
 * all) — the nearest rendered ancestor is highlighted instead and the status
 * line says why, rather than the click doing nothing visible.
 */
function highlightResult(rootEl, result) {
  clearHighlight();
  if (!rootEl || !result?.elementPath) return;

  const byStaticPath = new Map();
  rootEl.querySelectorAll('[data-path], [data-choice-path]').forEach((el) => {
    for (const p of [el.dataset.path, el.dataset.choicePath]) {
      if (!p) continue;
      const key = staticPathOf(p).toLowerCase();
      if (!byStaticPath.has(key)) byStaticPath.set(key, []);
      byStaticPath.get(key).push(el);
    }
  });

  const candidates = highlightCandidatePaths(result.elementPath);
  for (const [depth, candidate] of candidates.entries()) {
    const target = (byStaticPath.get(candidate.toLowerCase()) ?? []).find(isRendered);
    if (!target) continue;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('search-highlight');
    _lastHighlighted = target;
    if (depth > 0) {
      setSearchStatus(`“${result.label}” isn't shown right now (an unselected option or an empty list) — highlighted the section that contains it.`);
    }
    return;
  }
  setSearchStatus(`“${result.label}” couldn't be located on this form.`);
}
