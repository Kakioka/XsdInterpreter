// js/ui/coloring.js — Applies R/G/Y borders to DOM controls.
//
// See web-implementation-spec.md §9 (Coloring Service — Coloring Index,
// Debounce, Applying Color to DOM), §22 invariant 12 (rebuild the index only on
// a structural change, use the existing index for plain value changes) and
// invariant 19 (50ms debounce on the full recompute). IMPLEMENTATION_PLAN.md
// Phase 4.1.
//
// Module-level singleton: at any moment there is exactly one rendered form
// (the active instance), so tracking its schemaElement/formEngine/instanceKey/
// index here — rather than threading them through every call site — matches
// how formEngine.js itself already tracks a single activeInstanceKey.

import { computeAllColors } from '../core/coloringService.js';

let _index = new Map(); // lower-cased path -> DOM element to paint
let _formEl = null;
let _schemaElement = null;
let _formEngine = null;
let _instanceKey = null;
let _debounceTimer = null;

/** Call once per form render (switchToForm), after registerControlsUnder/
 *  restoreActiveForm/selectRadioGroupBranches have all run. */
export function setActiveContext(schemaElement, formEngine, instanceKey) {
  _schemaElement = schemaElement;
  _formEngine = formEngine;
  _instanceKey = instanceKey;
}

export function clearActiveContext() {
  _schemaElement = null;
  _formEngine = null;
  _instanceKey = null;
  _formEl = null;
  _index = new Map();
  clearTimeout(_debounceTimer);
}

/**
 * §9 "Coloring Index" — a flat path→element map built after every form render
 * or structural change, so a plain value-change recompute can walk it in O(n)
 * instead of re-querying the DOM tree each time.
 */
export function rebuildColorableIndex(formEl) {
  _formEl = formEl;
  const index = new Map();

  formEl.querySelectorAll('.field-wrapper[data-path]').forEach((wrapper) => {
    // Not `:scope > .color-border`: the border lives inside the wrapper's
    // .field-control group (see formRenderer.js buildLeafControl), not as a
    // direct child of .field-wrapper.
    const border = wrapper.querySelector('.color-border');
    if (border) index.set(wrapper.dataset.path.toLowerCase(), border);
  });
  formEl.querySelectorAll('fieldset.group-container[data-path]').forEach((el) => {
    index.set(el.dataset.path.toLowerCase(), el);
  });
  formEl.querySelectorAll('.sequence-container[data-path]').forEach((el) => {
    index.set(el.dataset.path.toLowerCase(), el);
  });
  formEl.querySelectorAll('.repeating-instance[data-instance-path]').forEach((el) => {
    index.set(el.dataset.instancePath.toLowerCase(), el);
  });
  formEl.querySelectorAll('.radio-group[data-choice-path]').forEach((el) => {
    index.set(el.dataset.choicePath.toLowerCase(), el);
  });
  formEl.querySelectorAll('.branch-content[data-path]').forEach((el) => {
    index.set(el.dataset.path.toLowerCase(), el);
  });

  _index = index;
}

function applyColorClass(el, color) {
  el.classList.remove('color-red', 'color-green', 'color-yellow');
  if (color === 'Red') el.classList.add('color-red');
  else if (color === 'Green') el.classList.add('color-green');
  else if (color === 'Yellow') el.classList.add('color-yellow');
}

/** Immediate (non-debounced) full recompute + repaint. Used for the initial
 *  paint after a render and for changes that already happened synchronously
 *  (radio branch swap, add/remove instance) — see §22 invariant 19. */
export function applyAllColors() {
  if (!_schemaElement || !_formEngine || !_instanceKey) return;
  const state = _formEngine.getFormState(_instanceKey);
  if (!state) return;
  const colorMap = computeAllColors(_schemaElement, state);
  for (const [path, el] of _index) {
    applyColorClass(el, colorMap.has(path) ? colorMap.get(path) : null);
  }
}

/** §9 "Debounce": rapid typing coalesces into one recompute 50ms after the
 *  last keystroke, rather than recomputing on every change event. */
export function scheduleColorRecompute() {
  clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(applyAllColors, 50);
}

/** Structural changes (add/remove repeating instance) change which DOM
 *  elements exist, so the index itself — not just the colors — is stale and
 *  must be rebuilt from the current form root before repainting. */
export function refreshAfterStructuralChange() {
  if (_formEl) rebuildColorableIndex(_formEl);
  applyAllColors();
}
