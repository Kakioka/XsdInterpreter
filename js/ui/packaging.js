// js/ui/packaging.js — "Create Submission Package" dialog.
//
// See web-implementation-spec.md §19 (Packaging). IMPLEMENTATION_PLAN.md
// Phase 8. Not in §23's file listing (only js/core/packager.js is named
// there), but every other multi-step UI concern in this codebase — search,
// validation, the context menu, the debug panel — gets its own js/ui/*.js
// file built the same way: index.html gives it one empty container
// (#package-dialog-overlay) and this module builds the real DOM into it on
// first wire, same pattern as debug.js/contextMenu.js.
//
// §19 workflow steps 3 and 4 name two distinct kinds of "validate": the
// dialog's OWN fields (SubmissionId, EFIN, ...) are hard-blocking (step 3),
// while the PACKET's data against the XSD is a skippable warning (step 4,
// "option to continue or cancel"). This module keeps that split literally:
// packager.validatePackagingSettings() blocks the Create click outright;
// validation.validateSchema() (Phase 5) only prompts a confirm().

import { validateSchema } from './validation.js';
import * as packager from '../core/packager.js';
import * as toolbar from './toolbar.js';

let _appState = null;
let _buildPacketXml = null; // () => string — app.js's own flush-and-serialize logic (shared with Save XML)
let _withBusyOverlay = null; // (message, work) => Promise — app.js's busy-overlay wrapper (§13)

function isEmptyValue(value) {
  return value === undefined || value === null || value === '';
}

/** Gates the toolbar's "Create Submission Package" button: a schema must be
 *  loaded AND at least one field/radio selection somewhere in the packet must
 *  have data — an empty packet has nothing worth zipping up (§19 step 1). */
function packetHasData(formEngine) {
  for (const state of formEngine.getAllFormStates().values()) {
    if (Object.values(state.fieldValues).some((v) => !isEmptyValue(v))) return true;
    if (Object.keys(state.radioSelections).length > 0) return true;
  }
  return false;
}

export function refreshCreatePackageButton(appState) {
  const btn = document.getElementById('create-package-btn');
  if (!btn) return;
  btn.disabled = !appState.manifest || !packetHasData(appState.formEngine);
}

/**
 * @param {{appState: object,
 *   buildPacketXml: () => string,
 *   withBusyOverlay: (message: string, work: () => Promise<any>) => Promise<any>}} ctx
 */
export function wirePackaging({ appState, buildPacketXml, withBusyOverlay }) {
  _appState = appState;
  _buildPacketXml = buildPacketXml;
  _withBusyOverlay = withBusyOverlay;

  const overlay = document.getElementById('package-dialog-overlay');
  if (!overlay) return;
  buildDialog(overlay);

  document.getElementById('create-package-btn')?.addEventListener('click', openDialog);

  // Re-evaluate enablement on every mutation path (dirtyChanged covers fills/
  // clears/instance add-remove/undo-redo per formEngine.js's own comment on
  // setDirty; controlValueChanged covers a plain field edit, which doesn't by
  // itself flip isDirty until blur — see toolbar.js's wireSaveStatus for the
  // same reasoning).
  appState.formEngine.addEventListener('dirtyChanged', () => refreshCreatePackageButton(appState));
  appState.formEngine.addEventListener('controlValueChanged', () => refreshCreatePackageButton(appState));
  refreshCreatePackageButton(appState);
}

// ---------------------------------------------------------------------------
// Dialog shell
// ---------------------------------------------------------------------------

const FIELD_SPECS = [
  { id: 'submissionId', label: 'Submission ID', maxLength: 20, placeholder: '13 digits + 7 alphanumeric' },
  { id: 'efin', label: 'EFIN', maxLength: 6 },
  { id: 'taxYear', label: 'Tax Year', maxLength: 4 },
  { id: 'governmentCode', label: 'Government Code', maxLength: 4 },
  { id: 'submissionType', label: 'Submission Type', placeholder: 'e.g. HIN11' },
];

const INDIVIDUAL_FIELD_SPECS = [
  { id: 'primarySSN', label: 'Primary SSN', maxLength: 9 },
  { id: 'primaryNameControl', label: 'Primary Name Control', maxLength: 4 },
  { id: 'spouseSSN', label: 'Spouse SSN (optional)', maxLength: 9 },
  { id: 'spouseNameControl', label: 'Spouse Name Control (optional)', maxLength: 4 },
];

const BUSINESS_FIELD_SPECS = [
  { id: 'ein', label: 'EIN', maxLength: 9 },
  { id: 'businessNameControl', label: 'Business Name Control', maxLength: 4 },
];

function buildTextField(spec) {
  const wrap = document.createElement('div');
  wrap.className = 'field-wrapper';
  const label = document.createElement('label');
  label.textContent = spec.label;
  label.htmlFor = `package-field-${spec.id}`;
  const input = document.createElement('input');
  input.type = 'text';
  input.id = `package-field-${spec.id}`;
  if (spec.maxLength) input.maxLength = spec.maxLength;
  if (spec.placeholder) input.placeholder = spec.placeholder;
  wrap.append(label, input);
  return wrap;
}

function buildFileField(id, label, multiple) {
  const wrap = document.createElement('div');
  wrap.className = 'field-wrapper';
  const labelEl = document.createElement('label');
  labelEl.textContent = label;
  labelEl.htmlFor = `package-field-${id}`;
  const input = document.createElement('input');
  input.type = 'file';
  input.id = `package-field-${id}`;
  if (multiple) input.multiple = true;
  wrap.append(labelEl, input);
  return wrap;
}

function buildDialog(overlay) {
  overlay.innerHTML = '';

  const dialog = document.createElement('div');
  dialog.id = 'package-dialog';

  const header = document.createElement('div');
  header.id = 'package-dialog-header';
  const title = document.createElement('span');
  title.textContent = 'Create Submission Package';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', closeDialog);
  header.append(title, closeBtn);

  const body = document.createElement('div');
  body.id = 'package-dialog-body';
  for (const spec of FIELD_SPECS) body.appendChild(buildTextField(spec));

  const categoryWrap = document.createElement('div');
  categoryWrap.className = 'field-wrapper';
  const categoryLabel = document.createElement('label');
  categoryLabel.textContent = 'Category';
  categoryLabel.htmlFor = 'package-field-category';
  const categorySelect = document.createElement('select');
  categorySelect.id = 'package-field-category';
  for (const value of ['Individual', 'Business']) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    categorySelect.appendChild(opt);
  }
  categoryWrap.append(categoryLabel, categorySelect);
  body.appendChild(categoryWrap);

  const individualGroup = document.createElement('div');
  individualGroup.id = 'package-individual-fields';
  for (const spec of INDIVIDUAL_FIELD_SPECS) individualGroup.appendChild(buildTextField(spec));
  body.appendChild(individualGroup);

  const businessGroup = document.createElement('div');
  businessGroup.id = 'package-business-fields';
  businessGroup.className = 'hidden';
  for (const spec of BUSINESS_FIELD_SPECS) businessGroup.appendChild(buildTextField(spec));
  body.appendChild(businessGroup);

  categorySelect.addEventListener('change', () => {
    individualGroup.classList.toggle('hidden', categorySelect.value !== 'Individual');
    businessGroup.classList.toggle('hidden', categorySelect.value !== 'Business');
  });

  body.appendChild(buildTextField({ id: 'irsSubmissionId', label: 'IRS Submission ID (optional)', maxLength: 20 }));
  body.appendChild(buildFileField('stateAttachments', 'State Attachment Files (0–50)', true));
  body.appendChild(buildFileField('federalReturnFile', 'Federal Return XML (optional)', false));
  body.appendChild(buildFileField('federalAttachments', 'Federal Attachment Files (0–50)', true));

  const errorList = document.createElement('ul');
  errorList.id = 'package-dialog-errors';
  body.appendChild(errorList);

  const footer = document.createElement('div');
  footer.id = 'package-dialog-footer';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', closeDialog);
  const createBtn = document.createElement('button');
  createBtn.type = 'button';
  createBtn.id = 'package-create-btn';
  createBtn.textContent = 'Create Package';
  createBtn.addEventListener('click', handleCreateClicked);
  footer.append(cancelBtn, createBtn);

  dialog.append(header, body, footer);
  overlay.appendChild(dialog);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });
}

function openDialog() {
  const overlay = document.getElementById('package-dialog-overlay');
  if (!overlay) return;
  prefillFromLastSettings();
  document.getElementById('package-dialog-errors').innerHTML = '';
  overlay.classList.remove('hidden');
}

function closeDialog() {
  document.getElementById('package-dialog-overlay')?.classList.add('hidden');
}

function prefillFromLastSettings() {
  const saved = packager.loadLastPackagingSettings();
  const category = saved?.category === 'Business' ? 'Business' : 'Individual';
  document.getElementById('package-field-category').value = category;
  document.getElementById('package-individual-fields').classList.toggle('hidden', category !== 'Individual');
  document.getElementById('package-business-fields').classList.toggle('hidden', category !== 'Business');
  for (const spec of [...FIELD_SPECS, ...INDIVIDUAL_FIELD_SPECS, ...BUSINESS_FIELD_SPECS, { id: 'irsSubmissionId' }]) {
    const input = document.getElementById(`package-field-${spec.id}`);
    if (input) input.value = saved?.[spec.id] ?? '';
  }
}

// ---------------------------------------------------------------------------
// Gather + validate + build
// ---------------------------------------------------------------------------

function textValue(id) {
  return document.getElementById(`package-field-${id}`)?.value.trim() ?? '';
}

function gatherSettings() {
  const stateAttachments = Array.from(document.getElementById('package-field-stateAttachments')?.files ?? []);
  const federalAttachments = Array.from(document.getElementById('package-field-federalAttachments')?.files ?? []);
  const federalReturnFiles = document.getElementById('package-field-federalReturnFile')?.files ?? [];
  return {
    submissionId: textValue('submissionId'),
    efin: textValue('efin'),
    taxYear: textValue('taxYear'),
    governmentCode: textValue('governmentCode'),
    submissionType: textValue('submissionType'),
    category: document.getElementById('package-field-category').value,
    primarySSN: textValue('primarySSN'),
    primaryNameControl: textValue('primaryNameControl'),
    spouseSSN: textValue('spouseSSN'),
    spouseNameControl: textValue('spouseNameControl'),
    ein: textValue('ein'),
    businessNameControl: textValue('businessNameControl'),
    irsSubmissionId: textValue('irsSubmissionId'),
    stateAttachments,
    stateAttachmentCount: stateAttachments.length,
    federalReturnFile: federalReturnFiles[0] ?? null,
    federalAttachments,
    federalAttachmentCount: federalAttachments.length,
  };
}

function renderErrors(errors) {
  const list = document.getElementById('package-dialog-errors');
  list.innerHTML = '';
  for (const err of errors) {
    const li = document.createElement('li');
    li.textContent = err.message;
    list.appendChild(li);
  }
}

async function handleCreateClicked() {
  const settings = gatherSettings();
  const settingsErrors = packager.validatePackagingSettings(settings);
  if (settingsErrors.length > 0) {
    renderErrors(settingsErrors);
    return;
  }
  renderErrors([]);

  // §19 step 4: schema-validity warnings are a confirm-to-continue, not a
  // block — this packet may legitimately be filed incomplete during testing.
  if (_appState.manifest && _appState.schemaParser) {
    _appState.formEngine.flushRegisteredControls();
    const schemaErrors = validateSchema(_appState.instanceKeys, _appState.formEngine.getAllFormStates(), _appState.schemaParser);
    if (schemaErrors.length > 0) {
      const proceed = window.confirm(
        `This packet has ${schemaErrors.length} validation issue(s) (missing/invalid fields, unresolved choices, etc.). Create the package anyway?`
      );
      if (!proceed) return;
    }
  }

  await _withBusyOverlay('Building submission package…', async () => {
    const packetXml = _buildPacketXml();
    const packetFileName = `${_appState.manifest.packetName}.xml`;
    const { blob, filename } = await packager.buildSubmissionPackage({
      settings,
      packetXml,
      packetFileName,
      stateAttachments: settings.stateAttachments,
      federalReturnFile: settings.federalReturnFile,
      federalAttachments: settings.federalAttachments,
    });
    toolbar.downloadBlob(blob, filename);
    packager.saveLastPackagingSettings(settings);
    toolbar.setStatus(`Created ${filename}`);
  });

  closeDialog();
}
