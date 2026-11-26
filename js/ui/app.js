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
import {
  SchemaParser,
  findRootElementCandidates,
  analyzePacket,
  joinPath,
  sortInstanceKeys,
  insertInstanceKey,
  siblingIndexOf,
} from '../core/parser.js';
import { FormEngine, FormInstanceKey, createEmptyFormState, keyOf } from '../core/formEngine.js';
import { readPacket } from '../core/xmlReader.js';
import { buildPacketXml } from '../core/xmlWriter.js';
import { UndoService, FormAddAction, FormRemoveAction, FillTestDataAction, ContainerFillAction, ContainerClearAction, ClearAllAction } from '../core/undoService.js';
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
import * as schemaSettingsUi from './schemaSettings.js';
import * as autosaveUi from './autosave.js';
import { installErrorBoundary } from './errorBoundary.js';
import { computeSchemaKey } from '../core/autosaveStore.js';
import { findInstanceIdAttribute, generateInstanceId } from '../core/instanceIdentity.js';
import { schemaSettingsKey, loadSchemaSettings, rememberInstanceIds, recallInstanceIds } from '../core/settingsStore.js';
import { chooseOne } from './chooseRootDialog.js';

const appState = {
  manifest: null,
  currentInstanceKey: null,
  flatDoc: null,
  schemaSource: null, // {fileTextMap, rootFileName, rootElementName} — what Switch Root re-runs against
  targetNamespace: null, // from flattener.flattenFromRoot (§3); threaded into buildPacketXml (§10) on Save XML
  sourceFiles: null, // from flattener.flattenFromRoot — which file declared each component (§5 sourceSchemaFile)
  schemaParser: null,
  schemaSettingsKey: null, // settingsStore.js — which schema the per-schema settings belong to
  formEngine: new FormEngine(),
  undoService: new UndoService(),
  // FormInstanceKey[] in MANIFEST order (parser.js sortInstanceKeys) — the nav
  // tree's source of truth and the order buildPacketXml writes. Insert with
  // insertInstanceKey, never push, or a form lands out of schema order.
  instanceKeys: [],
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
  // Write the outgoing schema's latest edits under ITS key now: setSchemaIdentity
  // (via activateRootElement) drops any write still pending in the debounce.
  if (appState.manifest) await autosaveUi.flushAutosave();
  const loaded = await withBusyOverlay('Parsing schema…', async () => {
    const bomHits = scanForBom(fileTextMap);
    if (bomHits.length > 0) {
      const proceed = window.confirm(
        `These files contain a byte-order mark, which can break XSD parsing:\n\n${bomHits
          .map((h) => h.name)
          .join('\n')}\n\nStrip it and continue?`
      );
      if (!proceed) return false;
      for (const hit of bomHits) fileTextMap.set(hit.name, stripBom(fileTextMap.get(hit.name)));
    }

    const rootFileCandidates = findRootFileCandidates(fileTextMap);
    const rootFileName = await chooseOne(
      rootFileCandidates,
      'Could not determine a root schema file — every file is referenced by another via xs:include/xs:import.',
      'Multiple possible root schema files found. Which one is the packet root?'
    );
    if (!rootFileName) return false;

    const { doc: flatDoc, targetNamespace, sourceFiles } = flattenFromRoot(fileTextMap, rootFileName);
    appState.flatDoc = flatDoc;
    appState.targetNamespace = targetNamespace;
    appState.sourceFiles = sourceFiles;

    const rootElementCandidates = findRootElementCandidates(flatDoc);
    const rootElementName = await chooseOne(
      rootElementCandidates,
      'Could not determine a root packet element — every global element is referenced by another via xs:element ref=.',
      'Multiple possible root elements found. Which one is the packet root?'
    );
    if (!rootElementName) return false;

    // Kept for Switch Root, which re-runs only the root-element step below
    // against the already-flattened document (parity 1.6).
    appState.schemaSource = { fileTextMap, rootFileName, rootElementName };
    activateRootElement(rootElementName);
    toolbar.setStatus(`Loaded ${appState.manifest.packetName}`);
    return true;
  });

  // Recovery prompt goes here, not inside the callback: withBusyOverlay's
  // loading overlay is still up in there, and anything modal shown underneath
  // it silently swallows its own clicks (the trap documented on
  // #choose-root-dialog-overlay in css/main.css).
  if (loaded) await autosaveUi.offerRecovery();
}

/**
 * The half of the Schema Load Flow that depends on the root ELEMENT, run
 * against `appState.flatDoc`: parser + manifest, a blank FormEngine, cleared
 * undo history (§22 invariant 23), nav tree, autosave identity, first form.
 * Shared by loadSchema and switchRoot. Synchronous — callers wrap it in
 * withBusyOverlay and call autosaveUi.offerRecovery() after the overlay is down.
 */
function activateRootElement(rootElementName) {
  const { fileTextMap, rootFileName } = appState.schemaSource;
  const flatDoc = appState.flatDoc;
  appState.schemaSource.rootElementName = rootElementName;

  appState.schemaSettingsKey = schemaSettingsKey(appState.targetNamespace, rootFileName, rootElementName);
  const { instanceIdSource } = loadSchemaSettings(appState.schemaSettingsKey);
  appState.schemaParser = new SchemaParser(flatDoc, rootElementName, instanceIdSource);
  appState.manifest = analyzePacket(flatDoc, rootElementName, { sourceFiles: appState.sourceFiles });

  appState.formEngine.reset();
  appState.undoService.clearHistory(); // §22 invariant 23
  appState.instanceKeys = buildInitialInstanceKeys(appState.manifest);
  appState.currentInstanceKey = null;

  document.getElementById('load-schema-prompt')?.remove();
  // A root with no required leaf forms renders nothing below, so the previous
  // root's form must not be left on screen bound to state that no longer exists.
  document.getElementById('form-content-host').innerHTML = '';
  validationUi.closeValidationPanel();
  const { packetName, schemaVersion, schemaVersionAttribute } = appState.manifest;
  sidebar.setCurrentRootLabel(document.getElementById('current-root-label'), packetName, schemaVersion, schemaVersionAttribute);
  sidebar.resetNavFilter(document.getElementById('nav-filter'), true);
  rebuildNavTree();
  toolbar.setSchemaDependentButtonsEnabled(true);
  packagingUi.refreshCreatePackageButton(appState); // formEngine.reset() above doesn't fire dirtyChanged/controlValueChanged

  // Autosave keys its snapshot by schema identity (C.1), so it can only be
  // told what that is once the root file/element are actually settled. This
  // also puts autosave on hold until offerRecovery() settles: clearHistory()
  // above and switchToForm() below both schedule a write of the blank state,
  // which would otherwise overwrite the snapshot the recovery prompt offers.
  // So it must stay AFTER clearHistory() (setSchemaIdentity cancels the write
  // that schedules), and every caller must end in offerRecovery().
  autosaveUi.setSchemaIdentity(computeSchemaKey(fileTextMap, rootFileName, rootElementName), appState.manifest.packetName);

  if (appState.instanceKeys.length > 0) switchToForm(appState.instanceKeys[0]);
  refreshSaveStatus();
}

/**
 * File → Switch Root (parity 1.6): pick a different root element from the
 * already-loaded schema set without re-reading the folder. Like the WPF
 * app's SwitchRoot, this starts the new root blank and clears undo history.
 *
 * The current root's work isn't lost: autosave snapshots are keyed per root
 * element, so it is flushed under the current key first and offered back on
 * switching to that root again.
 */
async function switchRoot() {
  if (!appState.flatDoc || !appState.schemaSource) return;
  const current = appState.schemaSource.rootElementName;
  const candidates = findRootElementCandidates(appState.flatDoc);
  if (candidates.length < 2) {
    window.alert(
      candidates.length === 1
        ? `${candidates[0]} is the only root element this schema set declares, so there is nothing to switch to.`
        : 'Could not determine a root packet element — every global element is referenced by another via xs:element ref=.'
    );
    return;
  }

  const chosen = await chooseOne(candidates, '', `Switch root element (currently ${current}):`, current);
  if (!chosen || chosen === current) return;

  // Any entered data counts, not just the dirty flag: a field mid-edit hasn't
  // flipped it yet, and data loaded from an XML file is clean but still on
  // screen. Flushing first is what makes the mid-edit value visible here.
  appState.formEngine.flushRegisteredControls();
  const hasWork = [...appState.formEngine.getAllFormStates().values()].some(
    (s) =>
      s.isDirty ||
      Object.values(s.fieldValues || {}).some((v) => !isEmptyValue(v) && v !== false) || // an unticked checkbox stores false
      Object.values(s.radioSelections || {}).some(Boolean)
  );
  if (
    hasWork &&
    !window.confirm(
      `Switching to ${chosen} starts a blank packet and clears undo history.\n\n` +
        `Unsaved work on ${appState.manifest.packetName} is kept in this browser's autosave and offered back if you switch to it again. Continue?`
    )
  ) {
    return;
  }

  await autosaveUi.flushAutosave(); // under the CURRENT root's key — activateRootElement moves it
  const switched = await withBusyOverlay('Switching root…', async () => {
    activateRootElement(chosen);
    toolbar.setStatus(`Switched root to ${appState.manifest.packetName}`);
    return true;
  });
  if (switched) await autosaveUi.offerRecovery();
}

/** One instance key per required, non-repeatable LEAF form (e.g. FormN11), in
 *  manifest order — a wrapper section (childForms.length > 0, e.g.
 *  ReturnDataState) never gets its own key, only its leaf descendants do.
 *  Everything else (repeatable forms, and optional non-repeatable forms like
 *  SchCR) starts absent and is only created via XML load or "+ Add". */
function buildInitialInstanceKeys(manifest) {
  const keys = [];
  const walk = (sections) => {
    for (const section of sections) {
      if (section.childForms?.length) {
        walk(section.childForms);
      } else if (!section.isRepeatable && section.isRequired) {
        keys.push(new FormInstanceKey(section.elementName));
      }
    }
  };
  walk(manifest.sections);
  return keys;
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
  sidebar.buildNavTree(
    document.getElementById('nav-tree'),
    appState.instanceKeys,
    appState.currentInstanceKey,
    switchToForm,
    appState.manifest,
    removeFormInstance,
    addFormInstance // a required form's "missing" placeholder row
  );
}

/** An id no instance of this form uses, either as its key or as a value typed
 *  into its identity attribute. */
function newInstanceId(formName) {
  const idAttr = findInstanceIdAttribute(appState.schemaParser.parseGlobalElement(formName));
  const taken = [];
  for (const key of appState.instanceKeys.filter((k) => k.formName === formName)) {
    taken.push(key.instanceId);
    const typed = idAttr && appState.formEngine.getFormState(key)?.fieldValues[joinPath(formName, idAttr.elementName).toLowerCase()];
    if (typed) taken.push(typed);
  }
  return generateInstanceId(formName, idAttr, taken);
}

function addFormInstance(sectionName) {
  // Non-repeatable forms (e.g. optional single-instance schedules like SchCR)
  // use the formName itself as the instanceId — same convention as every
  // other non-repeatable key (§2) — so the nav tree shows "SchCR", not a
  // generated id. Only a genuinely repeatable section needs a synthetic
  // per-instance id.
  const section = sidebar.findSection(appState.manifest?.sections, sectionName);
  const instanceId = section?.isRepeatable ? newInstanceId(sectionName) : sectionName;
  const key = new FormInstanceKey(sectionName, instanceId);
  const priorInstanceKey = appState.currentInstanceKey;
  // Positional insertion (parity 3.2): after the form's last instance, or at
  // its manifest position if it has none. The recorded position is the index
  // among its own instances — everything else about where it sits follows from
  // the manifest, so that is all undo/redo needs to put it back.
  const insertPosition = insertInstanceKey(appState.manifest.sections, appState.instanceKeys, key);
  rebuildNavTree();
  switchToForm(key);
  appState.undoService.recordAction(new FormAddAction({ instanceKey: key, priorInstanceKey, insertPosition, oldDirty: false, newDirty: true }));
}

/** Sidebar nav-tree "×" button — the counterpart to addFormInstance above, for
 *  optional forms (§14 FormRemoveAction). sidebar.js only shows the button for
 *  removable entries (repeatable instances, or non-repeatable optional
 *  sections), so no removability check is needed here. */
function removeFormInstance(instanceKey) {
  if (appState.undoService.isReplaying) return; // §22 invariant 13
  const flatIndex = appState.instanceKeys.findIndex((k) => k.equals(instanceKey));
  if (flatIndex === -1) return;
  const originalPosition = siblingIndexOf(appState.instanceKeys, instanceKey); // same meaning as FormAddAction.insertPosition

  const wasActive = !!appState.currentInstanceKey && appState.currentInstanceKey.equals(instanceKey);
  const existingState = appState.formEngine.getFormState(instanceKey);
  const stateSnapshot = JSON.parse(JSON.stringify(existingState || createEmptyFormState()));
  const oldDirty = existingState ? existingState.isDirty : false;

  appState.instanceKeys = appState.instanceKeys.filter((k) => !k.equals(instanceKey));
  const postRemovalActiveKey = wasActive
    ? appState.instanceKeys[flatIndex] || appState.instanceKeys[flatIndex - 1] || appState.instanceKeys[0] || null
    : null;

  rebuildNavTree();
  // Switch away BEFORE purging: setActiveForm's flush would otherwise silently
  // recreate the FormState we're about to delete (same ordering fix as
  // FormRemoveAction.redo() in undoService.js).
  if (wasActive) {
    if (postRemovalActiveKey) {
      switchToForm(postRemovalActiveKey);
    } else {
      appState.currentInstanceKey = null;
      document.getElementById('form-content-host').innerHTML = '';
      refreshSaveStatus();
    }
  }
  appState.formEngine.purgeFormState(instanceKey);

  appState.undoService.recordAction(
    new FormRemoveAction({ instanceKey, stateSnapshot, originalPosition, wasActive, postRemovalActiveKey, oldDirty, newDirty: true })
  );
}

// ---------------------------------------------------------------------------
// Load / Save XML (built on Phase 2's xmlReader.js / xmlWriter.js)
// ---------------------------------------------------------------------------

async function loadXmlText(xmlText) {
  if (!appState.manifest) return;
  await withBusyOverlay('Reading XML…', async () => {
    const rememberedIds = recallInstanceIds(appState.schemaSettingsKey, xmlText);
    const stateMap = readPacket(xmlText, appState.manifest, appState.schemaParser, rememberedIds); // key.toString() (natural case) → FormState — see xmlReader.js
    appState.formEngine.reset();
    appState.undoService.clearHistory(); // §22 invariant 23

    const orderedKeys = [];
    const walkSections = (sections) => {
      for (const section of sections) {
        if (section.childForms?.length) {
          walkSections(section.childForms);
          continue;
        }
        const matching = [...stateMap.keys()].map((k) => FormInstanceKey.parse(k)).filter((k) => k.formName === section.elementName);
        if (matching.length > 0) orderedKeys.push(...matching);
        else if (!section.isRepeatable && section.isRequired) orderedKeys.push(new FormInstanceKey(section.elementName));
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

/**
 * Applies a js/core/autosaveStore.js snapshot (C.1 crash recovery) — the same
 * shape of operation as loadXmlText above, just sourced from IndexedDB instead
 * of a file, and so it follows the same sequence: reset, clear history, restore
 * every FormState, re-derive the nav tree, switch to the first instance.
 *
 * Passed to autosave.wireAutosave as its `restoreSnapshot` callback; never
 * called directly, because only autosave.js knows whether the user agreed.
 */
function restoreFromSnapshot(snapshot) {
  if (!appState.manifest) return;
  appState.formEngine.reset();
  appState.undoService.clearHistory(); // §22 invariant 23 — a restore is a state load, same as an XML load

  const keys = (snapshot.instanceKeys || []).map((k) => FormInstanceKey.parse(k));
  // The snapshot records instanceKeys in natural case (parseGlobalElement needs
  // the exact schema name) but its formStates dict under FormEngine's own
  // lower-cased keyOf() keys, so the two halves are re-paired here.
  const remaining = new Map(Object.entries(snapshot.formStates || {}));
  for (const key of keys) {
    const stored = keyOf(key);
    if (remaining.has(stored)) {
      appState.formEngine.restoreFormState(key, remaining.get(stored));
      remaining.delete(stored);
    }
  }
  // A stored state with no matching instance key shouldn't happen, but keep it
  // rather than silently dropping entered data — it just isn't reachable from
  // the nav tree (its parsed form name is lower-cased, so it is deliberately
  // never switched to).
  for (const [storedKey, state] of remaining) appState.formEngine.restoreFormState(FormInstanceKey.parse(storedKey), state);

  // A snapshot from before instanceKeys were kept in manifest order may hold
  // them in add order; sorting is stable, so instances keep their own order.
  appState.instanceKeys = sortInstanceKeys(appState.manifest.sections, keys);
  appState.currentInstanceKey = null;

  rebuildNavTree();
  packagingUi.refreshCreatePackageButton(appState); // formEngine.reset() above doesn't fire dirtyChanged/controlValueChanged
  toolbar.setStatus(`Restored autosaved work (${keys.length} form instance${keys.length === 1 ? '' : 's'})`);

  if (appState.instanceKeys.length > 0) switchToForm(appState.instanceKeys[0]);
  else refreshSaveStatus();
}

/** Shared by Save XML and packaging.js's "Create Submission Package" (§19) —
 *  both need the exact same flush-then-serialize sequence to get the
 *  packet's current, in-progress-edit-included state as an XML string. */
function buildCurrentPacketXml() {
  appState.formEngine.flushRegisteredControls(); // capture an in-progress edit that hasn't fired `change` yet
  const allFormStates = appState.formEngine.getAllFormStates();
  return buildPacketXml(appState.manifest, allFormStates, appState.instanceKeys, appState.schemaParser, appState.targetNamespace);
}

/** Call once a document has actually been handed to the user (Save XML, a
 *  package): instance ids the XML can't carry are remembered beside it, so
 *  loading that same file back gives every instance the id it had. */
function rememberWrittenDocument(xmlString) {
  const states = appState.formEngine.getAllFormStates();
  const written = appState.instanceKeys.filter((k) => states.has(keyOf(k)));
  rememberInstanceIds(appState.schemaSettingsKey, xmlString, written);
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
    rememberWrittenDocument(xmlString);
    toolbar.setStatus('Saved');
    // The work is on disk now, so the autosave snapshot would only serve to
    // offer back on the next load something the user already has (C.1).
    autosaveUi.clearSnapshot();
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

  let changed = false;
  let formEl = document.getElementById('form-content-host').firstElementChild;

  // §17 "required repeating sections" inflation: generateValues raises a
  // required repeating section's target count above what currently exists
  // (testDataFiller.js's fillRepeatingEntry — its own minOccurs, e.g.
  // AuthenticationHeader.xsd's Submission needing 1-3 SubmissionEntry rows)
  // but never creates the DOM rows itself. Only done for a whole-form fill:
  // a scoped/container fill's snapshot (formEngine.snapshotUnderPathPrefix)
  // can't capture repeatingInstanceCounts (keyed by bare entry name, not
  // path — see its own comment), so ContainerFillAction's undo/redo has no
  // way to reflect an inflation here, unlike FillTestDataAction's, whose
  // snapshot already includes the full dict and whose undo/redo re-renders
  // the whole form from it (see switchToForm).
  if (isWholeForm && formEl) {
    for (const [entryName, count] of Object.entries(generated.instanceCounts)) {
      if (count > (state.repeatingInstanceCounts[entryName] ?? 0)) {
        appState.formEngine.setRepeatingInstanceCount(entryName, count);
        changed = true;
      }
    }
    if (changed) {
      formRenderer.inflateRepeatingSections(formEl, appState.formEngine);
      formRenderer.registerControlsUnder(formEl, appState.formEngine);
    }
  }

  // §17 "Only empty fields are filled (merge against existing values)" — §22
  // invariant 22 states this for the context menu specifically, but applying
  // it to the toolbar-level Fill buttons too avoids ever silently overwriting
  // data the user already entered, regardless of which entry point filled it.
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
  // FIRST, before any other wiring: a throw in one of the init steps below is
  // exactly the dead-UI-with-no-message failure the boundary exists to surface
  // (dev/IMPROVEMENT_BACKLOG.md B.3).
  installErrorBoundary({
    getRecoveryXml: () => (appState.manifest ? buildCurrentPacketXml() : null),
    getStateJson: () => ({
      instanceKeys: appState.instanceKeys.map((k) => k.toString()),
      formStates: Object.fromEntries(appState.formEngine.getAllFormStates()),
    }),
    getPacketName: () => appState.manifest?.packetName ?? null,
  });
  autosaveUi.wireAutosave({ appState, restoreSnapshot: restoreFromSnapshot });

  toolbar.wireToolbar({
    onSchemaFilesSelected: loadSchema,
    onXmlTextSelected: loadXmlText,
    onSaveXmlRequested: saveXml,
  });
  document.getElementById('switch-root-btn')?.addEventListener('click', () => {
    switchRoot().catch((err) => {
      console.error(err);
      window.alert(`Failed to switch root: ${err.message}`);
    });
  });
  sidebar.wireAddFormButton(document.getElementById('add-form-btn'), () => appState.manifest, () => appState.instanceKeys, addFormInstance);
  sidebar.wireNavFilter(document.getElementById('nav-filter'));

  // §9 coloring: debounced on typing (invariant 19), immediate elsewhere (radio
  // swap / add / remove already call coloringUi directly from formRenderer.js).
  appState.formEngine.addEventListener('controlValueChanged', () => coloringUi.scheduleColorRecompute());

  undoUi.wireUndo(appState.undoService, { appState, switchToForm, rebuildNavTree });
  validationUi.wireValidation({ appState, switchToForm });
  searchUi.wireSearch({ appState, switchToForm });
  contextMenuUi.wireContextMenu({ appState, fillActiveForm, clearActiveFormSection });
  debugUi.wireDebug({ appState });
  packagingUi.wirePackaging({ appState, buildPacketXml: buildCurrentPacketXml, withBusyOverlay, onPacketWritten: rememberWrittenDocument });
  schemaSettingsUi.wireSchemaSettings({ appState });
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
