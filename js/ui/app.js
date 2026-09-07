// js/ui/app.js — Bootstrap, wiring, global event bus.
//
// See web-implementation-spec.md §20 (Application Bootstrap, Schema Load Flow,
// Form Switch Flow, Radio Selection Fixed-Point Loop), §13 (Loading Overlay,
// Splitter, Zoom), §9 (Coloring Service), §12 (Theming), §14 (Undo/Redo), §15
// (Search), §17 (Test Data Fill), §18 (Context Menu), §21 (Debug Panel).
// IMPLEMENTATION_PLAN.md Phase 3.3 (schema/XML load, form switch, add
// instance), Phase 4 (coloring, undo), Phase 6 (search, test data fill,
// context menu), Phase 7 (theming, layout polish, debug panel).

import { scanForBom, stripBom, findRootFileCandidates, flattenFromRoot } from '../core/flattener.js';
import { SchemaParser, findRootElementCandidates, analyzePacket, joinPath } from '../core/parser.js';
import { FormEngine, FormInstanceKey } from '../core/formEngine.js';
import { readPacket } from '../core/xmlReader.js';
import { buildPacketXml } from '../core/xmlWriter.js';
import { UndoService, FormAddAction, FillTestDataAction, ContainerFillAction, ContainerClearAction, ClearAllAction } from '../core/undoService.js';
import { generateValues } from '../core/testDataFiller.js';
import * as formRenderer from './formRenderer.js';
import * as toolbar from './toolbar.js';
import * as sidebar from './sidebar.js';
import * as coloringUi from './coloring.js';
import * as undoUi from './undo.js';
import * as validationUi from './validation.js';
import * as searchUi from './search.js';
import * as contextMenuUi from './contextMenu.js';
import * as themeUi from './theme.js';
import * as debugUi from './debug.js';
import * as packagingUi from './packaging.js';

const appState = {
  manifest: null,
  currentInstanceKey: null,
  flatDoc: null,
  targetNamespace: null, // from flattener.flattenFromRoot (§3); threaded into buildPacketXml (§10) on Save XML
  schemaParser: null,
  formEngine: new FormEngine(),
  undoService: new UndoService(),
  instanceKeys: [], // ordered FormInstanceKey[] — the nav tree's source of truth
};

// Set by toolbar.wireSaveStatus in init() — called explicitly at the points
// below where currentInstanceKey/dirty state change WITHOUT already going
// through a controlValueChanged/undoService 'changed' event (a form switch;
// a successful Save XML clearing the dirty flag).
let refreshSaveStatus = () => {};

// ---------------------------------------------------------------------------
// Loading / busy overlay (§13) — must actually paint before heavy sync work runs
// ---------------------------------------------------------------------------

function showOverlay(message) {
  document.getElementById('loading-text').textContent = message;
  document.getElementById('loading-overlay').classList.remove('hidden');
}

function hideOverlay() {
  document.getElementById('loading-overlay').classList.add('hidden');
}

async function withBusyOverlay(message, work) {
  showOverlay(message);
  await new Promise(requestAnimationFrame); // let the browser paint the overlay...
  await new Promise(requestAnimationFrame); // ...a second frame for reliability across browsers
  try {
    return await work();
  } finally {
    hideOverlay();
  }
}

// ---------------------------------------------------------------------------
// Schema Load Flow (§20)
// ---------------------------------------------------------------------------

async function loadSchema(fileTextMap) {
  await withBusyOverlay('Parsing schema…', async () => {
    const bomHits = scanForBom(fileTextMap);
    if (bomHits.length > 0) {
      const proceed = window.confirm(
        `These files contain a byte-order mark, which can break XSD parsing:\n\n${bomHits
          .map((h) => h.name)
          .join('\n')}\n\nStrip it and continue?`
      );
      if (!proceed) return;
      for (const hit of bomHits) fileTextMap.set(hit.name, stripBom(fileTextMap.get(hit.name)));
    }

    const rootFileCandidates = findRootFileCandidates(fileTextMap);
    const rootFileName = await chooseOne(
      rootFileCandidates,
      'Could not determine a root schema file — every file is referenced by another via xs:include/xs:import.',
      'Multiple possible root schema files found. Which one is the packet root?'
    );
    if (!rootFileName) return;

    const { doc: flatDoc, targetNamespace } = flattenFromRoot(fileTextMap, rootFileName);
    appState.flatDoc = flatDoc;
    appState.targetNamespace = targetNamespace;

    const rootElementCandidates = findRootElementCandidates(flatDoc);
    const rootElementName = await chooseOne(
      rootElementCandidates,
      'Could not determine a root packet element — every global element is referenced by another via xs:element ref=.',
      'Multiple possible root elements found. Which one is the packet root?'
    );
    if (!rootElementName) return;

    appState.schemaParser = new SchemaParser(flatDoc, rootElementName);
    appState.manifest = analyzePacket(flatDoc, rootElementName);

    appState.formEngine.reset();
    appState.undoService.clearHistory(); // §22 invariant 23
    appState.instanceKeys = buildInitialInstanceKeys(appState.manifest);
    appState.currentInstanceKey = null;

    document.getElementById('load-schema-prompt')?.remove();
    sidebar.setCurrentRootLabel(document.getElementById('current-root-label'), appState.manifest.packetName);
    rebuildNavTree();
    toolbar.setSchemaDependentButtonsEnabled(true);
    packagingUi.refreshCreatePackageButton(appState); // formEngine.reset() above doesn't fire dirtyChanged/controlValueChanged
    toolbar.setStatus(`Loaded ${appState.manifest.packetName}`);

    if (appState.instanceKeys.length > 0) switchToForm(appState.instanceKeys[0]);
  });
}

/** One non-repeatable-form key per non-repeatable section, in manifest order.
 *  Repeatable sections start with zero instances until XML load or "+ Add". */
function buildInitialInstanceKeys(manifest) {
  const keys = [];
  const walk = (sections) => {
    for (const section of sections) {
      if (!section.isRepeatable) keys.push(new FormInstanceKey(section.elementName));
      if (section.childForms?.length) walk(section.childForms);
    }
  };
  walk(manifest.sections);
  return keys;
}

/** candidates.length === 1 → auto-pick. 0 → alert + null. >1 → prompt (a real
 *  "Choose Root" modal is a later polish pass — see spec §20 step 6/9). */
async function chooseOne(candidates, emptyMessage, multipleMessage) {
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    window.alert(emptyMessage);
    return null;
  }
  const chosen = window.prompt(`${multipleMessage}\n(${candidates.join(', ')})`, candidates[0]);
  return chosen && candidates.includes(chosen) ? chosen : null;
}

// ---------------------------------------------------------------------------
// Form Switch Flow (§20)
// ---------------------------------------------------------------------------

/**
 * @param {FormInstanceKey} instanceKey
 * @param {(formEngine: FormEngine) => void} [mutateState] — undoService's ONLY
 *   hook into the render pipeline (§14): called right after `instanceKey`
 *   becomes FormEngine's active form (so getRepeatingInstanceCount/
 *   renamePathPrefix/etc. all resolve against it) and right before the schema
 *   is parsed and the DOM is rebuilt from scratch — every undo/redo Action
 *   mutates state through this same single hook rather than patching the live
 *   DOM directly, which is what makes undo work correctly across a form
 *   switch "for free" (see undoService.js's file-level comment).
 */
function switchToForm(instanceKey, mutateState) {
  // captureRadioSelectionsIntoFormEngine() from the spec's flow is a no-op here:
  // radio selections are written to formEngine immediately on `change` (see
  // formRenderer's buildRadioGroup), unlike field values, which is why
  // FormEngine.setActiveForm below only needs to flush field values, not radios.
  appState.formEngine.setActiveForm(instanceKey);
  if (mutateState) mutateState(appState.formEngine);

  const schemaElement = appState.schemaParser.parseGlobalElement(instanceKey.formName);
  if (!schemaElement) {
    window.alert(`Could not resolve schema for form "${instanceKey.formName}".`);
    return;
  }

  const formEl = formRenderer.renderForm(schemaElement, appState.formEngine, 0, appState.undoService);
  formRenderer.inflateRepeatingSections(formEl, appState.formEngine);

  const host = document.getElementById('form-content-host');
  host.innerHTML = '';
  host.appendChild(formEl);

  // Registration must happen after inflation (repeating instances need their
  // paths rewritten first) and before restoreActiveForm (which needs the
  // controls to exist in the registry to push values into) — see
  // formRenderer.js's file-level comment on registration timing.
  formRenderer.registerControlsUnder(formEl, appState.formEngine);
  appState.formEngine.restoreActiveForm();
  formRenderer.selectRadioGroupBranches(formEl, appState.formEngine.getFormState(instanceKey));

  coloringUi.setActiveContext(schemaElement, appState.formEngine, instanceKey);
  coloringUi.rebuildColorableIndex(formEl);
  coloringUi.applyAllColors();

  validationUi.closeValidationPanel(); // stale results from the PREVIOUS form shouldn't linger after navigating away
  // Search and the context menu need no per-switch refresh: search re-derives
  // its form-name list from appState.instanceKeys at search time (init()
  // wires its document-level listeners once), and the context menu resolves
  // its target container fresh from each contextmenu event.

  appState.currentInstanceKey = instanceKey;
  sidebar.updateNavTreeActiveState(document.getElementById('nav-tree'), instanceKey);
  refreshSaveStatus();
}

function rebuildNavTree() {
  sidebar.buildNavTree(document.getElementById('nav-tree'), appState.instanceKeys, appState.currentInstanceKey, switchToForm);
}

function addFormInstance(sectionName) {
  const instanceId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `new-${Date.now()}`;
  const key = new FormInstanceKey(sectionName, instanceId);
  const priorInstanceKey = appState.currentInstanceKey;
  appState.instanceKeys.push(key);
  const insertPosition = appState.instanceKeys.length - 1;
  rebuildNavTree();
  switchToForm(key);
  appState.undoService.recordAction(new FormAddAction({ instanceKey: key, priorInstanceKey, insertPosition, oldDirty: false, newDirty: true }));
}

// ---------------------------------------------------------------------------
// Load / Save XML (built on Phase 2's xmlReader.js / xmlWriter.js)
// ---------------------------------------------------------------------------

async function loadXmlText(xmlText) {
  if (!appState.manifest) return;
  await withBusyOverlay('Reading XML…', async () => {
    const stateMap = readPacket(xmlText, appState.manifest, appState.schemaParser); // key.toString() (natural case) → FormState — see xmlReader.js
    appState.formEngine.reset();
    appState.undoService.clearHistory(); // §22 invariant 23

    const orderedKeys = [];
    const walkSections = (sections) => {
      for (const section of sections) {
        const matching = [...stateMap.keys()].map((k) => FormInstanceKey.parse(k)).filter((k) => k.formName === section.elementName);
        if (matching.length > 0) orderedKeys.push(...matching);
        else if (!section.isRepeatable) orderedKeys.push(new FormInstanceKey(section.elementName));
        if (section.childForms?.length) walkSections(section.childForms);
      }
    };
    walkSections(appState.manifest.sections);

    for (const [keyStr, state] of stateMap) {
      appState.formEngine.restoreFormState(FormInstanceKey.parse(keyStr), state);
    }
    appState.instanceKeys = orderedKeys;
    appState.currentInstanceKey = null;

    rebuildNavTree();
    packagingUi.refreshCreatePackageButton(appState); // formEngine.reset() above doesn't fire dirtyChanged/controlValueChanged
    toolbar.setStatus(`Loaded XML (${stateMap.size} form instance${stateMap.size === 1 ? '' : 's'})`);

    const allUnmatched = [...stateMap.values()].flatMap((s) => s.unmatchedFields);
    if (allUnmatched.length > 0) {
      // Phase 6+ TODO: a real panel instead of alert() (§11 "Unmatched Fields").
      window.alert(
        `Loaded with ${allUnmatched.length} field(s) not recognized by the schema:\n\n${allUnmatched
          .map((u) => `${u.xmlPath} = ${u.value}`)
          .join('\n')}`
      );
    }

    if (appState.instanceKeys.length > 0) switchToForm(appState.instanceKeys[0]);
  });
}

/** Shared by Save XML and packaging.js's "Create Submission Package" (§19) —
 *  both need the exact same flush-then-serialize sequence to get the
 *  packet's current, in-progress-edit-included state as an XML string. */
function buildCurrentPacketXml() {
  appState.formEngine.flushRegisteredControls(); // capture an in-progress edit that hasn't fired `change` yet
  const allFormStates = appState.formEngine.getAllFormStates();
  return buildPacketXml(appState.manifest, allFormStates, appState.instanceKeys, appState.schemaParser, appState.targetNamespace);
}

async function saveXml() {
  if (!appState.manifest) return;

  // Warn about remaining validation issues (§16) but don't block the save —
  // same "warn, allow anyway" pattern as packaging.js's Create Submission
  // Package confirm, since a save can legitimately capture in-progress,
  // intentionally-incomplete work.
  appState.formEngine.flushRegisteredControls();
  const schemaErrors = validationUi.validateSchema(appState.instanceKeys, appState.formEngine.getAllFormStates(), appState.schemaParser);
  if (schemaErrors.length > 0) {
    const proceed = window.confirm(
      `This packet has ${schemaErrors.length} validation issue(s) (missing/invalid fields, unresolved choices, etc.). Save anyway?`
    );
    if (!proceed) return;
  }

  await withBusyOverlay('Building XML…', async () => {
    const xmlString = buildCurrentPacketXml();
    const allFormStates = appState.formEngine.getAllFormStates();
    toolbar.downloadXmlString(xmlString, `${appState.manifest.packetName}.xml`);
    toolbar.setStatus('Saved');
    // §13 status bar: a completed Save XML writes EVERY stored form's state to
    // the file, so every one of them (not just the active form) is clean now.
    for (const state of allFormStates.values()) state.isDirty = false;
    refreshSaveStatus();
  });
}

// ---------------------------------------------------------------------------
// Test Data Fill (§17) — the FormEngine-merge + DOM-refresh glue shared by
// the toolbar's whole-form Fill buttons and contextMenu.js's scoped ones.
// testDataFiller.generateValues itself is pure/no-DOM (§17's own file-level
// comment); this is the part of §17 that isn't.
// ---------------------------------------------------------------------------

function isEmptyValue(value) {
  return value === undefined || value === null || value === '';
}

/**
 * @param {object} schemaElement - the whole active form's root (toolbar Fill
 *   All/Required) or a specific container subtree within it (contextMenu.js's
 *   scoped fill).
 * @param {string} parentPath - the runtime path prefix `schemaElement` itself
 *   sits under ('' for the form root — this is also how "whole form" vs.
 *   "scoped" is told apart below, since only the form root itself is ever
 *   called with an empty parentPath).
 * @param {object} options - passed through to generateValues (requiredOnly/filter).
 */
function fillActiveForm(schemaElement, parentPath, options) {
  if (appState.undoService.isReplaying) return; // §22 invariant 13
  if (!appState.currentInstanceKey) return;
  const instanceKey = appState.currentInstanceKey;
  const state = appState.formEngine.getFormState(instanceKey);
  if (!state) return;

  const isWholeForm = parentPath === '';
  const containerPath = isWholeForm ? null : joinPath(parentPath, schemaElement.elementName);
  const snapshot = () =>
    isWholeForm
      ? { fieldValues: { ...state.fieldValues }, radioSelections: { ...state.radioSelections }, repeatingInstanceCounts: { ...state.repeatingInstanceCounts } }
      : appState.formEngine.snapshotUnderPathPrefix(containerPath);
  const before = snapshot();

  const generated = generateValues(schemaElement, {
    ...options,
    parentPath,
    instanceCounts: state.repeatingInstanceCounts,
    radioSelections: state.radioSelections,
  });

  // §17 "Only empty fields are filled (merge against existing values)" — §22
  // invariant 22 states this for the context menu specifically, but applying
  // it to the toolbar-level Fill buttons too avoids ever silently overwriting
  // data the user already entered, regardless of which entry point filled it.
  let changed = false;
  for (const [path, value] of Object.entries(generated.values)) {
    if (isEmptyValue(state.fieldValues[path])) {
      state.fieldValues[path] = value;
      changed = true;
    }
  }
  for (const [choicePath, branchPath] of Object.entries(generated.radioSelections)) {
    if (!state.radioSelections[choicePath]) {
      state.radioSelections[choicePath] = branchPath;
      changed = true;
    }
  }
  if (!changed) return;

  const oldDirty = appState.formEngine.isDirty;
  appState.formEngine.setDirty(true);
  const after = snapshot();
  appState.undoService.recordAction(
    isWholeForm
      ? new FillTestDataAction({ instanceKey, before, after, oldDirty, newDirty: true })
      : new ContainerFillAction({ instanceKey, containerPath, before, after, oldDirty, newDirty: true })
  );

  // restoreActiveForm only PUSHES values it finds onto matching registered
  // controls — it never needs to CREATE anything, so this alone is enough to
  // reflect newly-filled values into the currently-rendered DOM (unlike
  // clearActiveFormSection below, which deletes values restoreActiveForm has
  // no way to reflect).
  appState.formEngine.restoreActiveForm();
  const formEl = document.getElementById('form-content-host').firstElementChild;
  if (formEl) {
    formRenderer.selectRadioGroupBranches(formEl, state);
    coloringUi.applyAllColors();
  }
}

/**
 * §18 "Clear This Section" / §22 invariant 22's counterpart for clearing.
 * Purges FormEngine state under `containerPath`, then resets the actual
 * rendered controls scoped to `containerEl` directly — restoreActiveForm
 * can't do this half (it only pushes values that still EXIST; it has no way
 * to reflect a deletion), so the DOM reset here is explicit. Repeating
 * instance COUNTS under the prefix are left alone on purpose (purge only
 * touches fieldValues/radioSelections for a full-path-qualified prefix like
 * this one, since repeatingInstanceCounts is keyed by bare entry name, not a
 * path — see FormEngine.purgeValuesUnderPathPrefix) — "clear the content,
 * keep the rows", not "un-add" repeating instances the user added.
 */
function clearActiveFormSection(containerPath, containerEl) {
  if (appState.undoService.isReplaying) return; // §22 invariant 13
  if (!appState.currentInstanceKey) return;
  const instanceKey = appState.currentInstanceKey;
  const before = appState.formEngine.snapshotUnderPathPrefix(containerPath);
  const oldDirty = appState.formEngine.isDirty;

  appState.formEngine.purgeValuesUnderPathPrefix(containerPath);
  appState.formEngine.setDirty(true);
  appState.undoService.recordAction(new ContainerClearAction({ instanceKey, containerPath, before, oldDirty, newDirty: true }));

  containerEl.querySelectorAll('.field-wrapper').forEach((wrapper) => {
    if (!wrapper._controlRef) return;
    wrapper._controlRef.setValue(''); // '' blanks text/numeric/decimal/date/dropdown AND unchecks a checkbox — see controlFactory.setControlValue
    wrapper._controlRef.validate?.(); // clear any stale format-error text now that the field is empty (§16)
  });
  containerEl.querySelectorAll('.radio-group').forEach((rgEl) => {
    rgEl.querySelectorAll('input[type="radio"]').forEach((r) => {
      r.checked = false;
    });
    rgEl.querySelectorAll(':scope > .branch-content').forEach((bc) => {
      bc.style.display = 'none';
    });
    delete rgEl.dataset.selectedBranch;
  });

  coloringUi.applyAllColors();
}

/**
 * Toolbar "Clear All" (§14 ClearAllAction) — clearActiveFormSection's
 * whole-form counterpart: blanks every field value and radio selection in
 * the ACTIVE form, everywhere (not just one container subtree). Repeating
 * instance COUNTS are left alone on purpose, same "clear the content, keep
 * the rows" rule as clearActiveFormSection — ClearAllAction.redo() mirrors
 * this by only ever resetting fieldValues/radioSelections, never counts.
 */
function clearActiveForm() {
  if (appState.undoService.isReplaying) return; // §22 invariant 13
  if (!appState.currentInstanceKey) return;
  const instanceKey = appState.currentInstanceKey;
  const state = appState.formEngine.getFormState(instanceKey);
  if (!state) return;
  if (Object.keys(state.fieldValues).length === 0 && Object.keys(state.radioSelections).length === 0) return; // nothing to clear

  // Unlike clearActiveFormSection's containerPath-scoped snapshot (which
  // deliberately omits repeatingInstanceCounts — see
  // formEngine.snapshotUnderPathPrefix), ClearAllAction.undo() restores
  // repeatingInstanceCounts WHOLESALE from `before`, so it must be captured
  // here even though redo() never touches it — otherwise undo would wipe out
  // every repeating row the user had added instead of just restoring content.
  const before = {
    fieldValues: { ...state.fieldValues },
    radioSelections: { ...state.radioSelections },
    repeatingInstanceCounts: { ...state.repeatingInstanceCounts },
  };
  const oldDirty = appState.formEngine.isDirty;

  state.fieldValues = {};
  state.radioSelections = {};
  appState.formEngine.setDirty(true);
  appState.undoService.recordAction(new ClearAllAction({ instanceKey, before, oldDirty, newDirty: true }));

  const formEl = document.getElementById('form-content-host').firstElementChild;
  if (!formEl) return;
  formEl.querySelectorAll('.field-wrapper').forEach((wrapper) => {
    if (!wrapper._controlRef) return;
    wrapper._controlRef.setValue(''); // '' blanks text/numeric/decimal/date/dropdown AND unchecks a checkbox — see controlFactory.setControlValue
    wrapper._controlRef.validate?.(); // clear any stale format-error text now that the field is empty (§16)
  });
  formEl.querySelectorAll('.radio-group').forEach((rgEl) => {
    rgEl.querySelectorAll('input[type="radio"]').forEach((r) => {
      r.checked = false;
    });
    rgEl.querySelectorAll(':scope > .branch-content').forEach((bc) => {
      bc.style.display = 'none';
    });
    delete rgEl.dataset.selectedBranch;
  });

  coloringUi.applyAllColors();
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function init() {
  toolbar.wireToolbar({
    onSchemaFilesSelected: loadSchema,
    onXmlTextSelected: loadXmlText,
    onSaveXmlRequested: saveXml,
  });
  sidebar.wireAddFormButton(document.getElementById('add-form-btn'), () => appState.manifest, addFormInstance);

  // §9 coloring: debounced on typing (invariant 19), immediate elsewhere (radio
  // swap / add / remove already call coloringUi directly from formRenderer.js).
  appState.formEngine.addEventListener('controlValueChanged', () => coloringUi.scheduleColorRecompute());

  undoUi.wireUndo(appState.undoService, { appState, switchToForm, rebuildNavTree });
  validationUi.wireValidation({ appState, switchToForm });
  searchUi.wireSearch({ appState, switchToForm });
  contextMenuUi.wireContextMenu({ appState, fillActiveForm, clearActiveFormSection });
  debugUi.wireDebug({ appState });
  packagingUi.wirePackaging({ appState, buildPacketXml: buildCurrentPacketXml, withBusyOverlay });
  themeUi.wireTheme();
  toolbar.wireSplitter();
  toolbar.wireZoom();
  toolbar.wireLayoutToggle();
  refreshSaveStatus = toolbar.wireSaveStatus(appState);

  document.getElementById('fill-all-btn')?.addEventListener('click', () => {
    if (!appState.currentInstanceKey) return;
    const schemaElement = appState.schemaParser.parseGlobalElement(appState.currentInstanceKey.formName);
    if (schemaElement) fillActiveForm(schemaElement, '', {});
  });
  document.getElementById('fill-required-btn')?.addEventListener('click', () => {
    if (!appState.currentInstanceKey) return;
    const schemaElement = appState.schemaParser.parseGlobalElement(appState.currentInstanceKey.formName);
    if (schemaElement) fillActiveForm(schemaElement, '', { requiredOnly: true });
  });
  document.getElementById('clear-all-btn')?.addEventListener('click', () => clearActiveForm());
}

init();

export { appState };
