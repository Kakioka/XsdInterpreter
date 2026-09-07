// js/ui/validation.js — Field-Level Validation, Full Structural Schema
// Validation, and the Validation Panel.
//
// See web-implementation-spec.md §16 (Validation), §22 invariants 4, 5.
// IMPLEMENTATION_PLAN.md Phase 5.
//
// Per §23's File Structure Reference there is no separate js/core/validation.js
// — validateField/validateSchema live here, pure and DOM-free (no `document`
// access anywhere above the "Validation Panel" section below), exactly like
// coloringService.js's split from coloring.js but folded into one file since
// that's the file the spec names. They reuse the exact same shared predicates
// (joinPath, isTransparent, isAttribute, isLeaf, isRepeatingContentContainer)
// from parser.js that coloringService.js/xmlWriter.js/xmlReader.js already do
// — the validator, the coloring service, the writer, and the reader all have
// to agree on what the schema means, and staying structurally parallel is how
// that's enforced rather than assumed.

import { joinPath, isTransparent, isAttribute, isLeaf, isRepeatingContentContainer } from '../core/parser.js';
import { FormInstanceKey, keyOf } from '../core/formEngine.js';

// ---------------------------------------------------------------------------
// Field-Level Validation (§16 "Field-Level Validation")
// ---------------------------------------------------------------------------

export function isEmpty(value) {
  return value === undefined || value === null || value === '';
}

/**
 * Minimal stand-in for the spec's `patternDescriber.describe(rule.value)` —
 * no such describer exists anywhere else in this codebase or spec, so this
 * gives every pattern-format error a readable (if generic) message rather
 * than dumping a raw regex at the user.
 */
const patternDescriber = {
  describe(pattern) {
    return `Must match the required format (pattern: ${pattern})`;
  },
};

/**
 * §16 `validateField`. Two deliberate departures from the spec's literal code
 * block, both already precedented by coloringService.js's `isFieldValid` — the
 * same validator's "standalone, lighter-weight" sibling built in Phase 4:
 *
 * 1. The spec's switch has no `break` between cases, which in real JS falls
 *    through into every later case's condition check too (misapplying, e.g.,
 *    a minLength rule's own `rule.value` as if it were also a maxLength
 *    threshold). `isFieldValid` already carries the `break` this needs.
 * 2. The spec short-circuits empty values only `if (isEmpty(value) &&
 *    !element.isRequired)`, so an empty REQUIRED value falls through into the
 *    rule loop — e.g. `String(undefined).length` failing a minLength check —
 *    producing a spurious format message ("Min length: 6") for a field whose
 *    actual problem is completeness, not format. `isFieldValid` already
 *    short-circuits unconditionally on emptiness ("emptiness is a
 *    completeness concern, not a validity one" — §22 invariant 4); this does
 *    the same, leaving completeness errors to validateNode/coloringService,
 *    which both already check isEmpty+isRequired themselves before ever
 *    calling into this function.
 */
export function validateField(value, element) {
  if (isEmpty(value)) return { valid: true };
  for (const rule of element.validationRules || []) {
    switch (rule.kind) {
      case 'minLength':
        if (String(value).length < Number(rule.value)) return { valid: false, message: `Min length: ${rule.value}` };
        break;
      case 'maxLength':
        if (String(value).length > Number(rule.value)) return { valid: false, message: `Max length: ${rule.value}` };
        break;
      case 'pattern':
        if (!new RegExp(`^(?:${rule.value})$`).test(String(value))) return { valid: false, message: patternDescriber.describe(rule.value) };
        break;
      case 'minInclusive':
        if (Number(value) < Number(rule.value)) return { valid: false, message: `Min value: ${rule.value}` };
        break;
      case 'maxInclusive':
        if (Number(value) > Number(rule.value)) return { valid: false, message: `Max value: ${rule.value}` };
        break;
      case 'totalDigits':
        if (String(value).replace(/[-.]/g, '').replace(/^0+(?=\d)/, '').length > Number(rule.value))
          return { valid: false, message: `Max total digits: ${rule.value}` };
        break;
      case 'fractionDigits': {
        const frac = String(value).split('.')[1] || '';
        if (frac.length > Number(rule.value)) return { valid: false, message: `Max decimal places: ${rule.value}` };
        break;
      }
      default:
        break;
    }
  }
  if (element.kind === 'DatePicker' && !isEmpty(value) && isNaN(Date.parse(value))) return { valid: false, message: 'Invalid date' };
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Full Structural Schema Validation (§16 "Full Structural Schema Validation")
// ---------------------------------------------------------------------------

function hasDataUnder(pathPrefix, fieldValues) {
  const p = pathPrefix.toLowerCase();
  return Object.entries(fieldValues).some(([k, v]) => (k === p || k.startsWith(`${p}.`) || k.startsWith(`${p}[`)) && !isEmpty(v));
}

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
    const state = allFormStates.get(keyOf(instanceKey)) ?? allFormStates.get(instanceKey.toString());
    if (!state) continue;
    const schemaElement = schemaParser.parseGlobalElement(instanceKey.formName);
    if (!schemaElement) continue;
    validateNode(schemaElement, state, '', errors, instanceKey.formName, instanceKey.toString());
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

function validateNode(element, state, path, errors, formName, instanceKeyStr) {
  if (element.kind === 'RadioGroup') return validateRadioGroup(element, state, path, errors, formName, instanceKeyStr);
  if (isRepeatingContentContainer(element)) return validateRepeatingContentContainer(element, state, path, errors, formName, instanceKeyStr);

  if (isTransparent(element)) {
    for (const child of element.children) validateNode(child, state, path, errors, formName, instanceKeyStr);
    return;
  }

  if (isAttribute(element)) {
    const value = state.fieldValues[joinPath(path, element.elementName).toLowerCase()];
    if (element.isRequired && isEmpty(value)) {
      errors.push(makeError(formName, instanceKeyStr, joinPath(path, element.elementName), 'completeness', 'Required attribute is missing'));
    } else if (!isEmpty(value)) {
      const r = validateField(value, element);
      if (!r.valid) errors.push(makeError(formName, instanceKeyStr, joinPath(path, element.elementName), 'format', r.message));
    }
    return;
  }

  const currentPath = joinPath(path, element.elementName);

  if (isLeaf(element)) {
    const value = state.fieldValues[currentPath.toLowerCase()];
    if (isEmpty(value)) {
      if (element.isRequired) errors.push(makeError(formName, instanceKeyStr, currentPath, 'completeness', 'Required field is empty'));
      return;
    }
    const r = validateField(value, element);
    if (!r.valid) errors.push(makeError(formName, instanceKeyStr, currentPath, 'format', r.message));
    return;
  }

  // Container: recurse; a required container with zero populated required
  // descendants still surfaces as individual completeness errors from those
  // descendants, so no separate "container is empty" check is needed here.
  for (const attr of element.children.filter(isAttribute)) validateNode(attr, state, currentPath, errors, formName, instanceKeyStr);
  for (const child of element.children.filter((c) => !isAttribute(c))) validateNode(child, state, currentPath, errors, formName, instanceKeyStr);
}

function validateRadioGroup(element, state, path, errors, formName, instanceKeyStr) {
  const choicePath = joinPath(path, element.elementName);
  const selected = state.radioSelections[choicePath.toLowerCase()];
  const populatedCount = element.children.filter((opt) => hasDataUnder(joinPath(choicePath, opt.elementName), state.fieldValues)).length;

  if (!selected && element.isRequired) {
    errors.push(makeError(formName, instanceKeyStr, choicePath, 'completeness', 'A selection is required'));
  } else if (populatedCount > 1) {
    errors.push(makeError(formName, instanceKeyStr, choicePath, 'choice', 'More than one option has data — only one branch may be populated'));
  }

  if (selected) {
    const opt = element.children.find((c) => joinPath(choicePath, c.elementName).toLowerCase() === String(selected).toLowerCase());
    if (opt) {
      // §22 invariant 29: the option wrapper emits no XML tag but its NAME
      // still contributes a path segment to its children's field keys.
      // Recursing with bare `choicePath` here — which is what §16's own
      // literal pseudocode does — is exactly the earlier-draft bug invariant
      // 29 calls out: every field inside any selected branch would be looked
      // up at a key nothing registers a control at (coloringService.js's
      // colorOfRadioGroup and xmlWriter.js/xmlReader.js already get this
      // right; this brings validateNode in line with them).
      const optPath = joinPath(choicePath, opt.elementName);
      for (const child of opt.children) validateNode(child, state, optPath, errors, formName, instanceKeyStr);
    }
  }
}

function validateRepeatingContentContainer(element, state, path, errors, formName, instanceKeyStr) {
  const entryWrapper = element.children.find((c) => !isAttribute(c));
  const count = state.repeatingInstanceCounts[entryWrapper.elementName.toLowerCase()] ?? 0;
  const outerPath = joinPath(path, element.elementName);

  if (count < element.minOccurs) {
    errors.push(makeError(formName, instanceKeyStr, outerPath, 'occurrence', `At least ${element.minOccurs} required, found ${count}`));
  }
  if (element.maxOccurs != null && count > element.maxOccurs) {
    errors.push(makeError(formName, instanceKeyStr, outerPath, 'occurrence', `At most ${element.maxOccurs} allowed, found ${count}`));
  }

  const entryPath = joinPath(outerPath, entryWrapper.elementName);
  for (let i = 0; i < count; i++) {
    for (const grandchild of entryWrapper.children) validateNode(grandchild, state, `${entryPath}[${i}]`, errors, formName, instanceKeyStr);
  }
}

function makeError(formName, instanceKeyStr, path, kind, message) {
  return { formName, instanceKey: instanceKeyStr, path, kind, message };
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
