// js/ui/validation.js — the validation entry point and the Validation Panel.
//
// See web-implementation-spec.md §16 (Validation), §22 invariants 4, 5.
// dev/IMPLEMENTATION_ORDER.md Phase 1 (backlog A.2 + A.3).
//
// Per §23's File Structure Reference there is no separate js/core/validation.js,
// so this is the file the spec names for `validateField` and `validateSchema`
// — but neither algorithm lives here any more:
//
//  * `validateField` IS `coloringService.validateFieldValue`, re-exported. The
//    facet switch used to exist twice, here and as `isFieldValid` in the
//    coloring service, each with a comment acknowledging the other (backlog
//    A.3). One copy, one place.
//  * `validateSchema` no longer walks the schema tree at all. The structural
//    walk is `coloringService.analyzeForm`, which emits the color map and the
//    error list from a single activation-aware traversal (backlog A.2). What
//    is left here is the packet-level part the core walk can't know about:
//    iterating the ordered instance keys, tagging each error with its form and
//    instance identity, and appending the unmatched fields an XML load
//    recorded on the FormState.
//
// Everything above the "Validation Panel" section below is still pure and
// DOM-free (no `document` access), exactly as before.

import { validateFieldValue, analyzeForm } from '../core/coloringService.js';
import { FormInstanceKey, keyOf, createEmptyFormState } from '../core/formEngine.js';

export { validateFieldValue as validateField };

// ---------------------------------------------------------------------------
// Full Structural Schema Validation (§16 "Full Structural Schema Validation")
// ---------------------------------------------------------------------------

/**
 * @param {import('../core/formEngine.js').FormInstanceKey[]} orderedInstanceKeys
 * @param {Map<string, object>} allFormStates — same lookup shape xmlWriter's
 *   buildPacketXml accepts (keyOf(instanceKey) or instanceKey.toString() keys).
 * @param {{parseGlobalElement: (name:string)=>object|null}} schemaParser
 * @returns {Array<{formName:string, instanceKey:string, path:string, kind:string, message:string}>}
 */
export function validateSchema(orderedInstanceKeys, allFormStates, schemaParser) {
  const errors = [];
  for (const instanceKey of orderedInstanceKeys) {
    // A form the user never switched into has no entry in allFormStates at all
    // (FormEngine only creates a FormState lazily, in setActiveForm — see
    // formEngine.js) — that must NOT be treated as "nothing to check". It's
    // exactly as unfilled as a form that WAS visited and left blank, so an
    // empty FormState stands in for it here rather than skipping the
    // instanceKey outright, which used to silently drop every never-rendered
    // form's required-field completeness errors from Validate/Save/Package
    // alike (all three share this one function).
    const state = allFormStates.get(keyOf(instanceKey)) ?? allFormStates.get(instanceKey.toString()) ?? createEmptyFormState();
    const schemaElement = schemaParser.parseGlobalElement(instanceKey.formName);
    if (!schemaElement) continue;

    for (const error of analyzeForm(schemaElement, state).errors) {
      errors.push({ formName: instanceKey.formName, instanceKey: instanceKey.toString(), ...error });
    }

    for (const u of state.unmatchedFields) {
      errors.push({
        formName: instanceKey.formName,
        instanceKey: instanceKey.toString(),
        path: u.xmlPath,
        kind: 'unmatched',
        message: `Unrecognized element in source XML: ${u.xmlPath}`,
      });
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Validation Panel (§16 "Validation Panel")
// ---------------------------------------------------------------------------

const KIND_LABELS = { completeness: 'Missing', format: 'Invalid', occurrence: 'Count', choice: 'Choice', unmatched: 'Unrecognized' };

let _appState = null;
let _switchToForm = null;

/**
 * @param {{appState: object, switchToForm: (instanceKey:import('../core/formEngine.js').FormInstanceKey) => void}} ctx
 *   Same shape as undo.js's wireUndo ctx — appState carries formEngine/
 *   schemaParser/instanceKeys/currentInstanceKey, switchToForm is app.js's own
 *   real navigation function so a validation click-through re-renders the
 *   target form exactly the way the nav tree would.
 */
export function wireValidation({ appState, switchToForm }) {
  _appState = appState;
  _switchToForm = switchToForm;
  document.getElementById('validate-btn')?.addEventListener('click', runValidationFromToolbar);
  document.getElementById('close-validation-btn')?.addEventListener('click', closeValidationPanel);
}

function runValidationFromToolbar() {
  if (!_appState?.manifest) return;
  _appState.formEngine.flushRegisteredControls(); // catch an in-progress edit that hasn't reached `blur`/`change` yet
  const allFormStates = _appState.formEngine.getAllFormStates();
  const errors = validateSchema(_appState.instanceKeys, allFormStates, _appState.schemaParser);
  renderResults(errors);
}

export function closeValidationPanel() {
  document.getElementById('validation-panel')?.classList.add('collapsed');
}

function renderResults(errors) {
  const listEl = document.getElementById('validation-error-list');
  const summaryEl = document.getElementById('validation-summary');
  const panelEl = document.getElementById('validation-panel');
  if (!listEl || !summaryEl || !panelEl) return;
  listEl.innerHTML = '';

  if (errors.length === 0) {
    summaryEl.textContent = 'Clean bill of health — no validation errors.';
    const li = document.createElement('li');
    li.className = 'validation-clean';
    li.textContent = 'All loaded forms pass validation.';
    listEl.appendChild(li);
    panelEl.classList.remove('collapsed');
    return;
  }

  summaryEl.textContent = `${errors.length} issue${errors.length === 1 ? '' : 's'} found`;

  // Grouped by form (§16 step 2) — the specific instance (not just the form
  // NAME) when the form is a repeatable one, so e.g. SampleEventLog#EVT-001
  // and #EVT-002 get their own headers instead of being merged together.
  const byInstance = new Map();
  for (const err of errors) {
    if (!byInstance.has(err.instanceKey)) byInstance.set(err.instanceKey, []);
    byInstance.get(err.instanceKey).push(err);
  }

  for (const [instanceKeyStr, group] of byInstance) {
    const header = document.createElement('li');
    header.className = 'validation-group-header';
    header.textContent = `${instanceKeyStr} (${group.length})`;
    listEl.appendChild(header);

    for (const err of group) {
      const li = document.createElement('li');
      li.className = 'validation-error';

      const badge = document.createElement('span');
      badge.className = `validation-kind-badge validation-kind-${err.kind}`;
      badge.textContent = KIND_LABELS[err.kind] || err.kind;

      const message = document.createElement('span');
      message.className = 'validation-message';
      message.textContent = err.message;

      const pathEl = document.createElement('span');
      pathEl.className = 'validation-path';
      pathEl.textContent = err.path;

      li.append(badge, message, pathEl);
      li.addEventListener('click', () => navigateToError(err));
      listEl.appendChild(li);
    }
  }

  panelEl.classList.remove('collapsed');
}

function navigateToError(err) {
  if (!_appState || !_switchToForm) return;
  const targetKey = FormInstanceKey.parse(err.instanceKey || err.formName);
  if (!_appState.currentInstanceKey || !_appState.currentInstanceKey.equals(targetKey)) {
    _switchToForm(targetKey);
  }
  // switchToForm rebuilds #form-content-host synchronously, so the target
  // element (if any) already exists by the time this next line runs.
  highlightPath(document.getElementById('form-content-host'), err.path);
}

function highlightPath(rootEl, path) {
  if (!rootEl || !path) return;
  const target =
    rootEl.querySelector(`[data-path="${path}"]`) ||
    rootEl.querySelector(`[data-choice-path="${path}"]`) ||
    rootEl.querySelector(`[data-instance-path="${path}"]`);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.remove('validation-flash');
  void target.offsetWidth; // force reflow so re-clicking the same error restarts the flash
  target.classList.add('validation-flash');
  target.addEventListener('animationend', () => target.classList.remove('validation-flash'), { once: true });
  const input = target.matches('input, select') ? target : target.querySelector('input, select');
  input?.focus({ preventScroll: true });
}
