// js/ui/formRenderer.js — SchemaElement tree → DOM controls.
//
// See web-implementation-spec.md §7 (Form Rendering).
// IMPLEMENTATION_PLAN.md Phase 3.2.
//
// Registration timing (deliberate deviation from the spec's literal pseudocode):
// buildLeafControl does NOT call formEngine.registerControl directly. It only
// stashes a controlRef on the wrapper element (wrapper._controlRef). Every
// caller of renderForm is responsible for calling registerControlsUnder() on
// the finished subtree exactly once, AFTER any repeating-instance path
// rewriting has happened. Registering inline (as the spec literally shows)
// would register every leaf under its UNINDEXED elementPath — since indices
// only exist once a repeating instance is placed at a known position — and
// then rewriteInstancePaths would silently strand those registrations under
// the wrong (stale) key with no re-registration step described anywhere.
// Centralizing registration after rewriting avoids that entirely.

import * as controlFactory from './controlFactory.js';
import * as coloring from './coloring.js';
import { validateField } from './validation.js';
import { FieldValueChangeAction, RadioBranchSwapAction, RepeatingInstanceAddAction, RepeatingInstanceRemoveAction } from '../core/undoService.js';

// ---------------------------------------------------------------------------
// Entry point / dispatch (§7)
// ---------------------------------------------------------------------------

/** @param {import('../core/undoService.js').UndoService} [undoService] — optional;
 *  omitted entirely by callers that don't need undo recording (e.g. dev/*-check.html
 *  test harnesses), which is why every recording site below guards with `?.`. */
export function renderForm(schemaElement, formEngine, depth = 0, undoService = null) {
  switch (schemaElement.kind) {
    case 'GroupContainer':
      return buildGroupContainer(schemaElement, formEngine, depth, undoService);
    case 'SequenceContainer':
      return buildSequenceContainer(schemaElement, formEngine, depth, undoService);
    case 'RadioGroup':
      return buildRadioGroup(schemaElement, formEngine, depth, undoService);
    default:
      if (schemaElement.isRepeating) return buildRepeatingSection(schemaElement, formEngine, depth, undoService);
      return buildLeafControl(schemaElement, formEngine, depth, undoService);
  }
}

// ---------------------------------------------------------------------------
// Container rendering (§7 "Container Rendering")
// ---------------------------------------------------------------------------

function buildGroupContainer(element, formEngine, depth, undoService) {
  const fieldset = document.createElement('fieldset');
  fieldset.classList.add('group-container', `depth-${Math.min(depth, 4)}`);
  fieldset.dataset.path = element.elementPath;
  fieldset.dataset.containerPath = element.elementPath; // §18 Context Menu targets this
  fieldset.dataset.schemaPath = element.elementPath;

  const legend = document.createElement('legend');
  legend.textContent = element.resolvedLabel;
  fieldset.appendChild(legend);

  for (const child of element.children) {
    fieldset.appendChild(renderForm(child, formEngine, depth + 1, undoService));
  }

  return fieldset;
}

function buildSequenceContainer(element, formEngine, depth, undoService) {
  if (element.isRepeating) return buildRepeatingSection(element, formEngine, depth, undoService);

  // Non-repeating SequenceContainer: the shape a choice OPTION wrapper takes
  // (isGeneratedWrapper=true, isRepeating=false) — a plain, unlabeled grouping div.
  const div = document.createElement('div');
  div.classList.add('sequence-container');
  div.dataset.path = element.elementPath;
  for (const child of element.children) {
    div.appendChild(renderForm(child, formEngine, depth + 1, undoService));
  }
  return div;
}

// ---------------------------------------------------------------------------
// Repeating Section (§7 "Repeating Section", "Path Rewriting", "Inflation")
// ---------------------------------------------------------------------------

function buildRepeatingSection(element, formEngine, depth, undoService) {
  const wrapper = document.createElement('div');
  wrapper.classList.add('repeating-section');
  wrapper.dataset.path = element.elementPath;

  const heading = document.createElement('h4');
  heading.textContent = element.resolvedLabel;
  wrapper.appendChild(heading);

  const instancesContainer = document.createElement('div');
  instancesContainer.classList.add('repeating-instances');
  // A data attribute, not an id: the same schema node renders once per instance
  // of an OUTER repeating section too (a nested repeating list inside each
  // outer instance), which would make a real `id` here collide document-wide.
  // Nothing queries this by selector — buildRepeatingSection already holds a
  // direct reference — so it's just a debugging aid.
  instancesContainer.dataset.instancesFor = element.elementPath;
  wrapper.appendChild(instancesContainer);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.classList.add('add-btn');
  addBtn.textContent = `Add ${element.resolvedLabel}`;
  addBtn.addEventListener('click', () => {
    if (undoService?.isReplaying) return; // §22 invariant 13 — defensive; Add is only ever user-clicked
    const { instanceDiv, removeBtn } = appendRepeatingInstance(element, formEngine, instancesContainer, depth, undoService);
    registerControlsUnder(instanceDiv, formEngine);
    wireRemoveButton(removeBtn, element, formEngine, instancesContainer, instanceDiv, undoService);
    const addedIndex = instancesContainer.children.length - 1;
    formEngine.setRepeatingInstanceCount(element.elementName, instancesContainer.children.length);
    const oldDirty = formEngine.isDirty;
    formEngine.setDirty(true);
    undoService?.recordAction(new RepeatingInstanceAddAction({
      instanceKey: formEngine.activeInstanceKey,
      elementPathBase: element.elementPath,
      addedIndex,
      oldDirty,
      newDirty: true,
    }));
    coloring.refreshAfterStructuralChange();
  });
  wrapper.appendChild(addBtn);

  // Used by inflateRepeatingSections (below), which must add instances without
  // going through the interactive click handler above — the FormState's count
  // is already correct on restore, so nothing here should bump it again.
  wrapper._appendInstanceForInflation = () => {
    const { instanceDiv, removeBtn } = appendRepeatingInstance(element, formEngine, instancesContainer, depth, undoService);
    wireRemoveButton(removeBtn, element, formEngine, instancesContainer, instanceDiv, undoService);
    return instanceDiv;
  };

  return wrapper;
}

function appendRepeatingInstance(element, formEngine, instancesContainer, depth, undoService) {
  const index = instancesContainer.children.length;
  const instanceDiv = document.createElement('div');
  instanceDiv.classList.add('repeating-instance');

  for (const child of element.children) {
    instanceDiv.appendChild(renderForm(child, formEngine, depth + 1, undoService));
  }

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.classList.add('remove-btn');
  removeBtn.textContent = 'Remove';
  instanceDiv.appendChild(removeBtn);

  instancesContainer.appendChild(instanceDiv);
  rewriteInstancePaths(instanceDiv, element.elementPath, index);
  instanceDiv.dataset.instancePath = `${element.elementPath}[${index}]`;

  return { instanceDiv, removeBtn };
}

function wireRemoveButton(removeBtn, element, formEngine, instancesContainer, instanceDiv, undoService) {
  removeBtn.addEventListener('click', () => {
    if (undoService?.isReplaying) return; // §22 invariant 13
    const instancePath = instanceDiv.dataset.instancePath;
    const removedIndex = Number(instancePath.slice(instancePath.lastIndexOf('[') + 1, -1));
    // §22 invariant 15: snapshot BEFORE purgeValuesUnderPathPrefix destroys the data.
    const snapshot = formEngine.snapshotUnderPathPrefix(instancePath);
    const oldDirty = formEngine.isDirty;
    // §22 invariant 10: purge stored state BEFORE removing the DOM element.
    formEngine.unregisterControlsUnderPath(instancePath);
    formEngine.purgeValuesUnderPathPrefix(instancePath);
    instanceDiv.remove();
    reindexInstances(element, formEngine, instancesContainer);
    formEngine.setRepeatingInstanceCount(element.elementName, instancesContainer.children.length);
    formEngine.setDirty(true);
    undoService?.recordAction(new RepeatingInstanceRemoveAction({
      instanceKey: formEngine.activeInstanceKey,
      elementPathBase: element.elementPath,
      removedIndex,
      fieldValueSnapshot: snapshot.fieldValues,
      radioBranchSelections: snapshot.radioSelections,
      oldDirty,
      newDirty: true,
    }));
    coloring.refreshAfterStructuralChange();
  });
}

/** Renumbers remaining instances after a removal (instance [1] becomes [0], etc.),
 *  renaming both the DOM paths and the underlying FormEngine-stored values. */
function reindexInstances(element, formEngine, instancesContainer) {
  Array.from(instancesContainer.children).forEach((instanceDiv, newIndex) => {
    const oldPath = instanceDiv.dataset.instancePath;
    const newPath = `${element.elementPath}[${newIndex}]`;
    if (oldPath === newPath) return;
    rewritePathPrefix(instanceDiv, oldPath, newPath);
    formEngine.renamePathPrefix(oldPath, newPath);
    formEngine.unregisterControlsUnderPath(oldPath);
    instanceDiv.dataset.instancePath = newPath;
    registerControlsUnder(instanceDiv, formEngine);
  });
}

/**
 * Renames every data-path / data-choice-path / data-instance-path / data-
 * container-path value under `oldPrefix` (exact match, or continuing with `.`
 * or `[`) to the same suffix under `newPrefix`. `basePath` (in
 * rewriteInstancePaths below) is always schemaElement.elementPath of the
 * repeating node being instantiated — an exact prefix of everything inside it
 * by construction — never a name guessed out of the path string.
 *
 * data-container-path (§18 Context Menu) is deliberately included here — it's
 * the RUNTIME field-value path a container's scoped fill/clear operates on, so
 * it must pick up the same `[i]` indices data-path does once the container
 * lands inside a repeating instance. data-schema-path is deliberately NOT
 * rewritten: it's the STATIC schema-tree lookup key (§18/§4's SchemaElement
 * tree has no concept of instance indices), and contextMenu.js relies on it
 * staying that way to resolve the container back to a SchemaElement node.
 */
function rewritePathPrefix(rootEl, oldPrefix, newPrefix) {
  const rewriteAttr = (attrSelector, datasetKey) => {
    rootEl.querySelectorAll(`[${attrSelector}]`).forEach((el) => {
      const p = el.dataset[datasetKey];
      if (p === oldPrefix || p.startsWith(`${oldPrefix}.`) || p.startsWith(`${oldPrefix}[`)) {
        el.dataset[datasetKey] = newPrefix + p.slice(oldPrefix.length);
      }
    });
  };
  rewriteAttr('data-path', 'path');
  rewriteAttr('data-choice-path', 'choicePath');
  rewriteAttr('data-instance-path', 'instancePath');
  rewriteAttr('data-container-path', 'containerPath');
}

function rewriteInstancePaths(instanceRootEl, basePath, index) {
  rewritePathPrefix(instanceRootEl, basePath, `${basePath}[${index}]`);
}

/**
 * When switching to a form whose stored state has repeating instances, inflate
 * the DOM to match the stored counts before formEngine.restoreActiveForm() runs.
 * Fixed-point loop (cap 20 passes): adding an outer instance can reveal a nested
 * repeating section that itself needs inflating.
 */
export function inflateRepeatingSections(formEl, formEngine) {
  let changed = true;
  let passes = 0;
  while (changed && passes < 20) {
    changed = false;
    formEl.querySelectorAll('.repeating-section').forEach((sectionEl) => {
      const entryName = lastPathSegment(sectionEl.dataset.path);
      const targetCount = formEngine.getRepeatingInstanceCount(entryName);
      const instancesContainer = sectionEl.querySelector('.repeating-instances');
      while (instancesContainer.children.length < targetCount) {
        sectionEl._appendInstanceForInflation();
        changed = true;
      }
    });
    passes++;
  }
}

function lastPathSegment(path) {
  const idx = path.lastIndexOf('.');
  return idx === -1 ? path : path.slice(idx + 1);
}

// ---------------------------------------------------------------------------
// RadioGroup (§7 "RadioGroup")
// ---------------------------------------------------------------------------

function buildRadioGroup(element, formEngine, depth, undoService) {
  const wrapper = document.createElement('div');
  wrapper.classList.add('radio-group');
  wrapper.dataset.choicePath = element.elementPath;

  const header = document.createElement('label');
  header.classList.add('radio-group-header');
  header.textContent = element.resolvedLabel;
  wrapper.appendChild(header);

  const branches = element.children.map((option) => {
    const optionLabel = document.createElement('label');
    optionLabel.classList.add('radio-option-label');

    const radioInput = document.createElement('input');
    radioInput.type = 'radio';
    radioInput.name = element.elementPath; // shared name → mutually exclusive; arbitrary strings are valid here
    radioInput.dataset.optionPath = option.elementPath;

    optionLabel.append(radioInput, document.createTextNode(` ${option.resolvedLabel || option.elementName}`));
    wrapper.appendChild(optionLabel);

    const contentDiv = document.createElement('div');
    contentDiv.classList.add('branch-content');
    contentDiv.style.display = 'none';
    contentDiv.dataset.path = option.elementPath;
    for (const child of option.children) {
      contentDiv.appendChild(renderForm(child, formEngine, depth + 1, undoService));
    }
    wrapper.appendChild(contentDiv);

    return { radioInput, contentDiv, option };
  });

  function showBranch(optionPath) {
    const target = optionPath.toLowerCase();
    for (const b of branches) {
      const isSelected = b.option.elementPath.toLowerCase() === target;
      b.contentDiv.style.display = isSelected ? '' : 'none';
      if (isSelected) b.radioInput.checked = true;
    }
    wrapper.dataset.selectedBranch = optionPath;
  }

  function recordSwap(oldBranch, newBranch) {
    if (!undoService?.isReplaying && oldBranch !== newBranch) {
      const oldDirty = formEngine.isDirty;
      formEngine.setDirty(true);
      undoService?.recordAction(new RadioBranchSwapAction({
        instanceKey: formEngine.activeInstanceKey,
        radioGroupPath: wrapper.dataset.choicePath,
        oldBranch,
        newBranch,
        oldDirty,
        newDirty: true,
      }));
    }
    coloring.applyAllColors(); // immediate — the branch toggle already happened synchronously
  }

  for (const b of branches) {
    b.radioInput.addEventListener('change', () => {
      // §14 fix: read the PREVIOUS selection from the group's own current-selection
      // state before mutating it — NOT from a separate `mousedown` snapshot, which
      // misses every keyboard-driven swap (arrow keys fire `change` with no
      // preceding `mousedown`). `change` itself already fires uniformly for mouse
      // clicks, Space/Enter, and arrow-key navigation.
      const oldBranch = wrapper.dataset.selectedBranch ?? null;
      showBranch(b.option.elementPath);
      formEngine.setRadioSelection(wrapper.dataset.choicePath, b.option.elementPath);
      recordSwap(oldBranch, b.option.elementPath);
    });
  }

  if (!element.isRequired) {
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.classList.add('clear-selection-btn');
    clearBtn.textContent = 'Clear selection';
    clearBtn.addEventListener('click', () => {
      const oldBranch = wrapper.dataset.selectedBranch ?? null;
      for (const b of branches) {
        b.radioInput.checked = false;
        b.contentDiv.style.display = 'none';
      }
      delete wrapper.dataset.selectedBranch;
      formEngine.setRadioSelection(wrapper.dataset.choicePath, null);
      recordSwap(oldBranch, null);
    });
    wrapper.appendChild(clearBtn);
  }

  // Stashed for selectRadioGroupBranches' fixed-point restore pass — lets it
  // reflect a stored selection into the UI without re-triggering a formEngine write.
  wrapper._showBranch = showBranch;

  return wrapper;
}

/**
 * §20 "Radio Selection (Fixed-Point Loop)". Called after formEngine.restoreActiveForm()
 * so radioSelections are already the authoritative source — this only reflects
 * them into the UI (shows/hides branch-content divs), it never writes back to
 * formEngine. Fixed-point because a just-revealed branch can itself contain a
 * nested radio group that also needs its stored selection applied.
 */
export function selectRadioGroupBranches(rootEl, formState) {
  let changed = true;
  let passes = 0;
  while (changed && passes < 10) {
    changed = selectRadioGroupBranchesPass(rootEl, formState);
    passes++;
  }
}

function selectRadioGroupBranchesPass(rootEl, formState) {
  let anyChanged = false;
  rootEl.querySelectorAll('.radio-group').forEach((rgEl) => {
    if (rgEl.dataset.selectedBranch) return; // already selected in a prior pass
    const choicePath = rgEl.dataset.choicePath; // already the fully-indexed runtime path — see §8
    const storedBranch = formState.radioSelections[choicePath.toLowerCase()];
    if (storedBranch) {
      rgEl._showBranch(storedBranch);
      anyChanged = true;
    }
    // else: optional group with no stored selection — leave unselected.
  });
  return anyChanged;
}

// ---------------------------------------------------------------------------
// Leaf Control Rendering (§7 "Leaf Control Rendering")
// ---------------------------------------------------------------------------

function buildLeafControl(element, formEngine, depth, undoService) {
  const wrapper = document.createElement('div');
  wrapper.classList.add('field-wrapper');
  wrapper.dataset.path = element.elementPath;

  const label = document.createElement('label');
  label.textContent = element.resolvedLabel;
  if (element.isRequired) label.classList.add('required');

  const colorBorder = document.createElement('div');
  colorBorder.classList.add('color-border'); // js/ui/coloring.js paints R/G/Y here (§9)

  const input = controlFactory.create(element);

  // §16 "Field-Level Validation": error text below the input, input border
  // set to the incomplete color — a distinct visual concern from the
  // color-border strip above, which reflects overall R/G/Y completeness
  // rather than this field's own format validity (§22 invariant 4).
  const errorText = document.createElement('span');
  errorText.classList.add('field-error');
  errorText.hidden = true;

  function runFieldValidation() {
    const result = validateField(controlFactory.getControlValue(input, element), element);
    input.classList.toggle('invalid', !result.valid);
    errorText.textContent = result.valid ? '' : result.message;
    errorText.hidden = result.valid;
    return result;
  }

  // §14 "FieldValueChangeAction": Checkbox/Dropdown commit-and-record immediately
  // on `change` (no intermediate typing state to debounce). Text/Numeric/Decimal/
  // DatePicker instead stash the pre-edit value on `focus` and only record on
  // `blur` if it actually changed — the commit to FormEngine itself still rides
  // the existing `change` listener below (which already fires at blur-time for
  // these input types), this just adds the undo bookkeeping around it.
  const isImmediateKind = element.kind === 'Checkbox' || element.kind === 'Dropdown';
  function recordValueChange(oldValue, newValue) {
    if (undoService?.isReplaying) return; // §22 invariant 13
    if (oldValue === newValue) return;
    const oldDirty = formEngine.isDirty;
    formEngine.setDirty(true);
    undoService?.recordAction(new FieldValueChangeAction({
      instanceKey: formEngine.activeInstanceKey,
      path: wrapper.dataset.path,
      oldValue,
      newValue,
      oldDirty,
      newDirty: true,
    }));
  }

  if (!isImmediateKind) {
    let stashedValue = null;
    input.addEventListener('focus', () => {
      stashedValue = controlFactory.getControlValue(input, element);
    });
    input.addEventListener('blur', () => {
      recordValueChange(stashedValue, controlFactory.getControlValue(input, element));
      runFieldValidation(); // §16: run on blur for text/numeric/decimal/date fields
    });
  }

  input.addEventListener('change', () => {
    if (isImmediateKind) {
      recordValueChange(formEngine.getValue(wrapper.dataset.path), controlFactory.getControlValue(input, element));
      runFieldValidation(); // §16: run immediately for select/checkbox
    }
    // Read the CURRENT dataset.path, not a value captured at creation time — if
    // this control later becomes part of a repeating instance whose path gets
    // rewritten (or re-indexed after a sibling removal), edits after that point
    // must land under the corrected path, not a stale one baked into a closure.
    formEngine.setValue(wrapper.dataset.path, controlFactory.getControlValue(input, element));
  });

  // colorBorder and input are grouped in their own flex container so that
  // wrap mode's flex-wrap (§13) never breaks the row between them — without
  // this, a narrow wrap-mode column can fit "label + colorBorder" on one
  // line and push "input" alone onto the next, leaving the color strip
  // stranded next to the label instead of the input it actually describes.
  const controlGroup = document.createElement('div');
  controlGroup.classList.add('field-control');
  controlGroup.append(colorBorder, input);

  wrapper.append(label, controlGroup, errorText);

  if (element.documentation) {
    const tooltip = document.createElement('span');
    tooltip.classList.add('tooltip');
    tooltip.textContent = element.documentation;
    wrapper.append(tooltip);
  }
  if (element.lineNumber) {
    const ln = document.createElement('span');
    ln.classList.add('line-number');
    ln.textContent = element.lineNumber;
    wrapper.append(ln);
  }

  // See the file-level comment: registration is centralized in registerControlsUnder,
  // not done here, so it always happens after any repeating-instance path rewriting.
  wrapper._controlRef = {
    getValue: () => controlFactory.getControlValue(input, element),
    setValue: (v) => controlFactory.setControlValue(input, element, v),
    validate: runFieldValidation,
  };

  return wrapper;
}

/**
 * Registers every leaf control under `rootEl` with formEngine, keyed by each
 * wrapper's CURRENT data-path (i.e. after any repeating-instance rewriting has
 * already happened). Call this once per render pass: after the top-level
 * renderForm + inflateRepeatingSections in switchToForm, and once per
 * interactive "Add" click (scoped to just the new instance).
 */
export function registerControlsUnder(rootEl, formEngine) {
  rootEl.querySelectorAll('.field-wrapper[data-path]').forEach((wrapper) => {
    if (wrapper._controlRef) {
      formEngine.registerControl(wrapper.dataset.path, { ...wrapper._controlRef, elementPath: wrapper.dataset.path });
    }
  });
}
