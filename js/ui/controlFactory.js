// js/ui/controlFactory.js — Creates individual input elements.
//
// See web-implementation-spec.md §7 (Form Rendering — Control Factory).
// IMPLEMENTATION_PLAN.md Phase 3.1.

export function create(element) {
  switch (element.kind) {
    case 'TextInput':
      return createTextInput(element);
    case 'NumericInput':
      return createNumberInput();
    case 'DecimalInput':
      return createDecimalInput();
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

function findRule(element, kind) {
  return element.validationRules.find((r) => r.kind === kind);
}

function createTextInput(element) {
  const input = document.createElement('input');
  input.type = 'text';
  const maxLength = findRule(element, 'maxLength');
  if (maxLength) input.maxLength = Number(maxLength.value);
  return input;
}

function createNumberInput() {
  const input = document.createElement('input');
  input.type = 'number';
  input.step = '1';
  return input;
}

function createDecimalInput() {
  const input = document.createElement('input');
  input.type = 'number';
  input.step = 'any';
  return input;
}

function createDateInput(element) {
  const input = document.createElement('input');
  input.type = element.xsdDataType === 'xs:dateTime' ? 'datetime-local' : 'date';
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

export function getControlValue(input, element) {
  if (element.kind === 'Checkbox') return input.checked;
  return input.value;
}

export function setControlValue(input, element, value) {
  if (element.kind === 'Checkbox') {
    input.checked = value === true || value === 'true';
  } else {
    input.value = value == null ? '' : value;
  }
}
