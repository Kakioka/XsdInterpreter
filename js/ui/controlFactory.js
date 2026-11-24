// js/ui/controlFactory.js — Creates individual input elements.
//
// See web-implementation-spec.md §7 (Form Rendering — Control Factory).
// IMPLEMENTATION_PLAN.md Phase 3.1.
//
// Schema facets become native attributes (parity 1.8) — `maxlength`,
// `minlength`, `pattern`, `min`, `max`, `step` — computed in one place by
// js/core/facets.js's inputConstraints. Of these only `maxlength` on a text
// input actually stops typing; the rest give the browser's own spinner, date
// picker bounds and accessibility tree the schema's limits, while the
// authoritative check stays validateFieldValue (on blur, and in coloring).

import { inputConstraints, rejectsEdit } from '../core/facets.js';

export function create(element) {
  switch (element.kind) {
    case 'TextInput':
      return createTextInput(element);
    case 'NumericInput':
    case 'DecimalInput':
      return createNumberInput(element);
    case 'DatePicker':
      return createDateInput(element);
    case 'Checkbox':
      return createCheckbox();
    case 'Dropdown':
      return createSelect(element);
    default:
      return createTextInput(element); // defensive fallback — every ElementKind above is a leaf kind
  }
}

function createTextInput(element) {
  const input = document.createElement('input');
  input.type = 'text';
  const c = inputConstraints(element);
  if (c.maxLength !== undefined) input.maxLength = c.maxLength;
  if (c.minLength !== undefined) input.minLength = c.minLength;
  if (c.pattern !== undefined) input.pattern = c.pattern;
  return input;
}

function createNumberInput(element) {
  const input = document.createElement('input');
  input.type = 'number';
  const c = inputConstraints(element);
  input.step = c.step;
  if (c.min !== undefined) input.min = c.min;
  if (c.max !== undefined) input.max = c.max;
  if (c.maxTotalDigits !== undefined || c.maxLength !== undefined) guardTypingLimit(input, c);
  return input;
}

/**
 * Browsers ignore `maxlength` on <input type="number">, so totalDigits (and a
 * rare maxLength on a numeric type) is enforced by refusing the keystroke that
 * crosses it: on `input`, an over-limit value is put back to the previous one.
 * The WPF controls do the same with a character-count MaxLength; counting
 * digits keeps the sign and point from eating the budget. Only edits that
 * make the overrun worse are refused (see rejectsEdit), so a too-long value
 * loaded from XML can still be deleted back under the limit.
 *
 * Registered here, at creation, so it runs before formRenderer's listeners —
 * nothing downstream ever sees the rejected value. `lastOk` only advances on
 * a value the browser could parse: mid-typing states like "-" read back as ''
 * with `badInput` set, and restoring one of those would blank the field.
 */
function guardTypingLimit(input, constraints) {
  let lastOk = '';
  input.addEventListener('focus', () => { lastOk = input.value; });
  input.addEventListener('input', () => {
    if (rejectsEdit(lastOk, input.value, constraints)) {
      input.value = lastOk;
    } else if (!input.validity.badInput) {
      lastOk = input.value;
    }
  });
}

function createDateInput(element) {
  const input = document.createElement('input');
  input.type = element.xsdDataType === 'xs:dateTime' ? 'datetime-local' : 'date';
  const c = inputConstraints(element);
  if (c.min !== undefined) input.min = c.min;
  if (c.max !== undefined) input.max = c.max;
  return input;
}

function createCheckbox() {
  const input = document.createElement('input');
  input.type = 'checkbox';
  return input;
}

function createSelect(element) {
  const select = document.createElement('select');
  const blank = document.createElement('option');
  blank.value = '';
  select.appendChild(blank);
  for (const opt of element.enumerationValues) {
    const optionEl = document.createElement('option');
    optionEl.value = opt.value;
    optionEl.textContent = opt.label;
    select.appendChild(optionEl);
  }
  return select;
}

// <input type="datetime-local"> has no concept of a UTC/offset designator —
// its .value is always a bare "YYYY-MM-DDTHH:mm[:ss]" local wall-clock string.
// MeF xs:dateTime patterns, though, require one (e.g. the common
// `[1-9][0-9]{3}\-.+T[^\.]+(Z|[\+\-].+)` restriction), so the browser's raw
// value can never satisfy field validation on its own — it has to be
// converted at the DOM boundary, both ways: append a fixed 'Z' (treat the
// picker's wall-clock value as UTC) when reading out, and strip any
// Z/offset suffix when writing in, since the control silently blanks itself
// (input.value becomes '') on a string it can't parse.
function isDateTimePicker(element) {
  return element.kind === 'DatePicker' && element.xsdDataType === 'xs:dateTime';
}

export function getControlValue(input, element) {
  if (element.kind === 'Checkbox') return input.checked;
  if (isDateTimePicker(element) && input.value) {
    const withSeconds = input.value.length === 16 ? `${input.value}:00` : input.value;
    return `${withSeconds}Z`;
  }
  return input.value;
}

export function setControlValue(input, element, value) {
  if (element.kind === 'Checkbox') {
    input.checked = value === true || value === 'true';
  } else if (isDateTimePicker(element) && value) {
    input.value = String(value).replace(/(Z|[+-]\d{2}:?\d{2})$/, '');
  } else {
    input.value = value == null ? '' : value;
  }
}
