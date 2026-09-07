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

// ---------------------------------------------------------------------------
// Entry point / dispatch (§7)
// ---------------------------------------------------------------------------

export function renderForm(schemaElement, formEngine, depth = 0) {
  switch (schemaElement.kind) {
    case 'GroupContainer':
      return buildGroupContainer(schemaElement, formEngine, depth);
    case 'SequenceContainer':
      return buildSequenceContainer(schemaElement, formEngine, depth);
    case 'RadioGroup':
      return buildRadioGroup(schemaElement, formEngine, depth);
    default:
      if (schemaElement.isRepeating) return buildRepeatingSection(schemaElement, formEngine, depth);
      return buildLeafControl(schemaElement, formEngine, depth);
  }
}

// ---------------------------------------------------------------------------
// Container rendering (§7 "Container Rendering")
// ---------------------------------------------------------------------------

function buildGroupContainer(element, formEngine, depth) {
  const fieldset = document.createElement('fieldset');
  fieldset.classList.add('group-container', `depth-${Math.min(depth, 4)}`);
  fieldset.dataset.path = element.elementPath;
  fieldset.dataset.containerPath = element.elementPath; // §18 Context Menu targets this
  fieldset.dataset.schemaPath = element.elementPath;

  const legend = document.createElement('legend');
  legend.textContent = element.resolvedLabel;
  fieldset.appendChild(legend);

  for (const child of element.children) {
    fieldset.appendChild(renderForm(child, formEngine, depth + 1));
  }

  return fieldset;
}

function buildSequenceContainer(element, formEngine, depth) {
  if (element.isRepeating) return buildRepeatingSection(element, formEngine, depth);

  // Non-repeating SequenceContainer: the shape a choice OPTION wrapper takes
  // (isGeneratedWrapper=true, isRepeating=false) — a plain, unlabeled grouping div.
  const div = document.createElement('div');
  div.classList.add('sequence-container');
  div.dataset.path = element.elementPath;
  for (const child of element.children) {
    div.appendChild(renderForm(child, formEngine, depth + 1));
  }
  return div;
}

// ---------------------------------------------------------------------------
// Repeating Section (§7 "Repeating Section", "Path Rewriting", "Inflation")
// ---------------------------------------------------------------------------

function buildRepeatingSection(element, formEngine, depth) {
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
    const { instanceDiv, removeBtn } = appendRepeatingInstance(element, formEngine, instancesContainer, depth);
    registerControlsUnder(instanceDiv, formEngine);
    wireRemoveButton(removeBtn, element, formEngine, instancesContainer, instanceDiv);
    formEngine.setRepeatingInstanceCount(element.elementName, instancesContainer.children.length);
    // Phase 4 TODO: record a RepeatingInstanceAddAction via undoService (§14).
  });
  wrapper.appendChild(addBtn);

  // Used by inflateRepeatingSections (below), which must add instances without
  // going through the interactive click handler above — the FormState's count
  // is already correct on restore, so nothing here should bump it again.
  wrapper._appendInstanceForInflation = () => {
    const { instanceDiv, removeBtn } = appendRepeatingInstance(element, formEngine, instancesContainer, depth);
    wireRemoveButton(removeBtn, element, formEngine, instancesContainer, instanceDiv);
    return instanceDiv;
  };

  return wrapper;
}

function appendRepeatingInstance(element, formEngine, instancesContainer, depth) {
  const index = instancesContainer.children.length;
  const instanceDiv = document.createElement('div');
  instanceDiv.classList.add('repeating-instance');

  for (const child of element.children) {
    instanceDiv.appendChild(renderForm(child, formEngine, depth + 1));
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

function wireRemoveButton(removeBtn, element, formEngine, instancesContainer, instanceDiv) {
  removeBtn.addEventListener('click', () => {
    const instancePath = instanceDiv.dataset.instancePath;
    // §22 invariant 10/15: purge stored state BEFORE removing the DOM element —
    // Phase 4 TODO: snapshot values here first, for RepeatingInstanceRemoveAction (§14).
    formEngine.unregisterControlsUnderPath(instancePath);
    formEngine.purgeValuesUnderPathPrefix(instancePath);
    instanceDiv.remove();
    reindexInstances(element, formEngine, instancesContainer);
    formEngine.setRepeatingInstanceCount(element.elementName, instancesContainer.children.length);
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
 * Renames every data-path / data-choice-path / data-instance-path value under
 * `oldPrefix` (exact match, or continuing with `.` or `[`) to the same suffix
 * under `newPrefix`. `basePath` (in rewriteInstancePaths below) is always
 * schemaElement.elementPath of the repeating node being instantiated — an exact
 * prefix of everything inside it by construction — never a name guessed out of
 * the path string.
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

function buildRadioGroup(element, formEngine, depth) {
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
      contentDiv.appendChild(renderForm(child, formEngine, depth + 1));
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

  for (const b of branches) {
    b.radioInput.addEventListener('change', () => {
      showBranch(b.option.elementPath);
      formEngine.setRadioSelection(wrapper.dataset.choicePath, b.option.elementPath);
      // Phase 4 TODO: record a RadioBranchSwapAction (§14) — read oldBranch from
      // wrapper.dataset.selectedBranch BEFORE calling showBranch() above (the
      // spec's fixed keyboard-selection approach: change fires uniformly for
      // mouse, Space/Enter, and arrow-key navigation, so no separate mousedown
      // snapshot is needed).
    });
  }

  if (!element.isRequired) {
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.classList.add('clear-selection-btn');
    clearBtn.textContent = 'Clear selection';
    clearBtn.addEventListener('click', () => {
      for (const b of branches) {
        b.radioInput.checked = false;
        b.contentDiv.style.display = 'none';
      }
      delete wrapper.dataset.selectedBranch;
      formEngine.setRadioSelection(wrapper.dataset.choicePath, null);
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

function buildLeafControl(element, formEngine, depth) {
  const wrapper = document.createElement('div');
  wrapper.classList.add('field-wrapper');
  wrapper.dataset.path = element.elementPath;

  const label = document.createElement('label');
  label.textContent = element.resolvedLabel;
  if (element.isRequired) label.classList.add('required');

  const colorBorder = document.createElement('div');
  colorBorder.classList.add('color-border'); // Phase 4 (§9) paints R/G/Y here

  const input = controlFactory.create(element);
  input.addEventListener('change', () => {
    // Read the CURRENT dataset.path, not a value captured at creation time — if
    // this control later becomes part of a repeating instance whose path gets
    // rewritten (or re-indexed after a sibling removal), edits after that point
    // must land under the corrected path, not a stale one baked into a closure.
    formEngine.setValue(wrapper.dataset.path, controlFactory.getControlValue(input, element));
  });

  wrapper.append(label, colorBorder, input);

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
    validate: () => ({ valid: true }), // Phase 5 TODO: real field-level validation (§16)
    setColorState: () => {}, // Phase 4 TODO: coloring.js wires this in (§9)
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
