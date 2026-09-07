// js/ui/app.js — Bootstrap, wiring, global event bus.
//
// See web-implementation-spec.md §20 (Application Bootstrap, Schema Load Flow,
// Form Switch Flow, Radio Selection Fixed-Point Loop), §13 (Loading Overlay),
// §9 (Coloring Service), §14 (Undo/Redo). IMPLEMENTATION_PLAN.md Phase 3.3
// (schema/XML load, form switch, add instance) and Phase 4 (coloring, undo).
//
// Validation, search, context menus, and theming are still later phases.

import { scanForBom, stripBom, findRootFileCandidates, flattenFromRoot } from '../core/flattener.js';
import { SchemaParser, findRootElementCandidates, analyzePacket } from '../core/parser.js';
import { FormEngine, FormInstanceKey } from '../core/formEngine.js';
import { readPacket } from '../core/xmlReader.js';
import { buildPacketXml } from '../core/xmlWriter.js';
import { UndoService, FormAddAction } from '../core/undoService.js';
import * as formRenderer from './formRenderer.js';
import * as toolbar from './toolbar.js';
import * as sidebar from './sidebar.js';
import * as coloringUi from './coloring.js';
import * as undoUi from './undo.js';

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

  // Phase 5/6 TODO: wireContextMenus, refreshSearchContext, closeValidationPanel.

  appState.currentInstanceKey = instanceKey;
  sidebar.updateNavTreeActiveState(document.getElementById('nav-tree'), instanceKey);
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

async function saveXml() {
  if (!appState.manifest) return;
  await withBusyOverlay('Building XML…', async () => {
    appState.formEngine.flushRegisteredControls(); // capture an in-progress edit that hasn't fired `change` yet
    const allFormStates = appState.formEngine.getAllFormStates();
    const xmlString = buildPacketXml(appState.manifest, allFormStates, appState.instanceKeys, appState.schemaParser, appState.targetNamespace);
    toolbar.downloadXmlString(xmlString, `${appState.manifest.packetName}.xml`);
    toolbar.setStatus('Saved');
  });
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
}

init();

export { appState };
