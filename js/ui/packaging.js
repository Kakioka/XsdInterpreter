// js/ui/packaging.js — "Create Submission Package" dialog.
//
// See web-implementation-spec.md §19 (Packaging), dev/PARITY_GAP_ANALYSIS.md
// 1.4. The dialog is generated from an export profile (js/core/exportProfile.js,
// export-profiles/README.md) the same way forms are generated from a schema:
// nothing here knows what any particular package contains. index.html gives it
// one empty container (#package-dialog-overlay) and this module builds the DOM
// into it, same pattern as debug.js/contextMenu.js.
//
// §19 workflow steps 3 and 4 name two distinct kinds of "validate": the
// dialog's OWN fields and files are hard-blocking (step 3), while the PACKET's
// data against the XSD is a skippable warning (step 4, "option to continue or
// cancel"). This module keeps that split literally: exportProfile's
// validatePackage() blocks the Create click outright;
// validation.validateSchema() only asks for confirmation (dialogs.js).

import { validateSchema } from './validation.js';
import { buildPackage } from '../core/packager.js';
import { validateProfile, validatePackage, activeValues, isBlank } from '../core/exportProfile.js';
import * as settingsStore from '../core/settingsStore.js';
import * as toolbar from './toolbar.js';
import { confirmAction } from './dialogs.js';
import { openModal, closeModal } from './modal.js';

// Resolved against this module, not the page — see theme.js.
const BUNDLED_PROFILE_URLS = [new URL('../../export-profiles/mef-state.profile.json', import.meta.url)];

let _appState = null;
let _buildPacketXml = null; // () => string — app.js's own flush-and-serialize logic (shared with Save XML)
let _withBusyOverlay = null; // (message, work) => Promise — app.js's busy-overlay wrapper (§13)

let _onPacketWritten = null; // (xmlString) => void — told once a package has been handed over

let bundledProfiles = null; // loaded once, on first open
let userProfiles = []; // survives the session even if localStorage doesn't
let activeProfile = null;

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
 *   withBusyOverlay: (message: string, work: () => Promise<any>) => Promise<any>,
 *   onPacketWritten?: (xmlString: string) => void}} ctx
 */
export function wirePackaging({ appState, buildPacketXml, withBusyOverlay, onPacketWritten = null }) {
  _onPacketWritten = onPacketWritten;
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

  // At startup rather than on first open: values that should never have been
  // stored shouldn't wait for the dialog. A failure here resurfaces on open.
  loadProfiles().catch(() => {});
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

async function loadProfiles() {
  if (bundledProfiles) return;
  // First, so a bundled profile that won't load doesn't take the user's own down with it.
  userProfiles = settingsStore.loadUserProfiles().filter((p) => validateProfile(p).length === 0);
  const loaded = [];
  for (const url of BUNDLED_PROFILE_URLS) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url.pathname} could not be loaded (${response.status}).`);
    loaded.push(await response.json());
  }
  bundledProfiles = loaded;
  settingsStore.forgetUnrememberedValues(allProfiles());
}

function allProfiles() {
  return [...(bundledProfiles ?? []), ...userProfiles];
}

function rememberChoice() {
  if (_appState.schemaSettingsKey) settingsStore.updateSchemaSettings(_appState.schemaSettingsKey, { exportProfileId: activeProfile.id });
}

/** The profile chosen for this schema, else the first available. */
function preferredProfile() {
  const key = _appState.schemaSettingsKey;
  const preferredId = key ? settingsStore.loadSchemaSettings(key).exportProfileId : undefined;
  const profiles = allProfiles();
  return profiles.find((p) => p.id === preferredId) ?? profiles[0] ?? null;
}

async function handleProfileFile(event) {
  const file = event.target.files[0];
  event.target.value = ''; // so picking the same (edited) file again still fires change
  if (!file) return;
  let profile;
  try {
    profile = JSON.parse(await file.text());
  } catch {
    renderErrors([{ message: `${file.name} is not valid JSON.` }]);
    return;
  }
  const problems = validateProfile(profile);
  if (problems.length === 0 && (bundledProfiles ?? []).some((p) => p.id === profile.id)) {
    problems.push(`The id "${profile.id}" belongs to a bundled profile. Give this one a different id.`);
  }
  if (problems.length > 0) {
    renderErrors(problems.map((message) => ({ message: `${file.name}: ${message}` })));
    return;
  }
  userProfiles = [...userProfiles.filter((p) => p.id !== profile.id), profile];
  const stored = settingsStore.saveUserProfiles(userProfiles);
  settingsStore.forgetUnrememberedValues(allProfiles());
  selectProfile(profile);
  rememberChoice();
  if (!stored) renderErrors([{ message: 'Browser storage is unavailable, so this profile will have to be loaded again next time.' }]);
  else if (!settingsStore.isDataStored()) renderErrors([{ message: 'Not storing data in this browser, so this profile will have to be loaded again next time.' }]);
}

function removeActiveProfile() {
  if (!userProfiles.includes(activeProfile)) return;
  userProfiles = userProfiles.filter((p) => p !== activeProfile);
  settingsStore.saveUserProfiles(userProfiles);
  selectProfile(preferredProfile());
}

// ---------------------------------------------------------------------------
// Dialog shell
// ---------------------------------------------------------------------------

function button(text, onClick, id) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = text;
  if (id) btn.id = id;
  btn.addEventListener('click', onClick);
  return btn;
}

function buildDialog(overlay) {
  overlay.innerHTML = '';

  const dialog = document.createElement('div');
  dialog.id = 'package-dialog';

  const header = document.createElement('div');
  header.id = 'package-dialog-header';
  const title = document.createElement('span');
  title.textContent = 'Create Submission Package';
  header.append(title, button('✕', closeDialog));

  const body = document.createElement('div');
  body.id = 'package-dialog-body';

  const profileRow = document.createElement('div');
  profileRow.className = 'field-wrapper';
  const profileLabel = document.createElement('label');
  profileLabel.textContent = 'Package profile';
  profileLabel.htmlFor = 'package-profile-select';
  const profileSelect = document.createElement('select');
  profileSelect.id = 'package-profile-select';
  profileSelect.addEventListener('change', () => {
    selectProfile(allProfiles().find((p) => p.id === profileSelect.value));
    rememberChoice();
  });
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.id = 'package-profile-file';
  fileInput.accept = '.json,application/json';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', handleProfileFile);
  profileRow.append(profileLabel, profileSelect, fileInput);

  const profileActions = document.createElement('div');
  profileActions.id = 'package-profile-actions';
  profileActions.append(button('Load profile…', () => fileInput.click()), button('Remove profile', removeActiveProfile, 'package-profile-remove-btn'));

  const description = document.createElement('p');
  description.id = 'package-profile-description';
  description.className = 'hint';

  const fields = document.createElement('div');
  fields.id = 'package-dialog-fields';
  fields.addEventListener('input', refreshFieldVisibility);
  fields.addEventListener('change', refreshFieldVisibility);

  const errorList = document.createElement('ul');
  errorList.id = 'package-dialog-errors';
  body.append(profileRow, profileActions, description, fields, errorList);

  const footer = document.createElement('div');
  footer.id = 'package-dialog-footer';
  footer.append(button('Cancel', closeDialog), button('Create Package', handleCreateClicked, 'package-create-btn'));

  dialog.append(header, body, footer);
  overlay.appendChild(dialog);
}

async function openDialog() {
  const overlay = document.getElementById('package-dialog-overlay');
  if (!overlay) return;
  renderErrors([]);
  openModal(overlay);
  let failure = null;
  try {
    await loadProfiles();
  } catch (err) {
    failure = err;
  }
  selectProfile(preferredProfile());
  if (failure) renderErrors([{ message: `Could not load the bundled package profiles: ${failure.message}` }]);
}

function closeDialog() {
  closeModal(document.getElementById('package-dialog-overlay'));
}

// ---------------------------------------------------------------------------
// Profile-driven fields
// ---------------------------------------------------------------------------

function buildRow(id, labelText, control, hint) {
  const wrap = document.createElement('div');
  wrap.className = 'field-wrapper';
  wrap.dataset.profileField = id;
  const label = document.createElement('label');
  label.textContent = labelText;
  control.id = `package-field-${id}`;
  label.htmlFor = control.id;
  wrap.append(label, control);
  if (hint) control.title = hint;
  return wrap;
}

function buildField(field, saved) {
  let control;
  if (field.type === 'select') {
    control = document.createElement('select');
    for (const option of field.options) {
      const opt = document.createElement('option');
      opt.value = option.value;
      opt.textContent = option.label ?? option.value;
      control.appendChild(opt);
    }
    const initial = [saved, field.default].find((v) => field.options.some((o) => o.value === v));
    control.value = initial ?? field.options[0].value;
  } else {
    control = document.createElement('input');
    control.type = 'text';
    if (field.maxLength) control.maxLength = field.maxLength;
    if (field.remember === false) control.autocomplete = 'off'; // the browser's own form history counts as storage too
    control.placeholder = field.placeholder ?? field.hint ?? '';
    control.value = saved ?? field.default ?? '';
  }
  return buildRow(field.id, field.required ? field.label : `${field.label} (optional)`, control, field.hint);
}

function buildFileGroup(group) {
  const control = document.createElement('input');
  control.type = 'file';
  control.multiple = group.multiple === true;
  if (group.accept) control.accept = group.accept;
  const limit = group.multiple && group.maxCount ? `, up to ${group.maxCount}` : '';
  return buildRow(group.id, group.required ? `${group.label}${limit}` : `${group.label} (optional${limit})`, control);
}

function buildHeading(text) {
  const heading = document.createElement('h3');
  heading.className = 'package-section-heading';
  heading.textContent = text;
  return heading;
}

/** Makes `profile` the one being filled in and regenerates the dialog's fields. */
function selectProfile(profile) {
  activeProfile = profile;
  const select = document.getElementById('package-profile-select');
  select.innerHTML = '';
  for (const p of allProfiles()) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    select.appendChild(opt);
  }
  if (profile) select.value = profile.id;
  document.getElementById('package-profile-description').textContent = profile?.description ?? '';
  document.getElementById('package-profile-remove-btn').classList.toggle('hidden', !userProfiles.includes(profile));
  document.getElementById('package-create-btn').disabled = !profile;

  const host = document.getElementById('package-dialog-fields');
  host.innerHTML = '';
  if (!profile) return;
  renderErrors([]);

  const saved = settingsStore.loadLastPackagingSettings(profile.id) ?? {};
  let section = null;
  for (const field of profile.fields ?? []) {
    if (field.section && field.section !== section) host.appendChild(buildHeading(field.section));
    section = field.section ?? section;
    host.appendChild(buildField(field, saved[field.id]));
  }
  if (profile.fileGroups?.length) host.appendChild(buildHeading('Files'));
  for (const group of profile.fileGroups ?? []) host.appendChild(buildFileGroup(group));
  refreshFieldVisibility();
}

function gatherValues() {
  const values = {};
  for (const field of activeProfile.fields ?? []) values[field.id] = document.getElementById(`package-field-${field.id}`)?.value ?? '';
  return values;
}

function gatherFiles() {
  const files = {};
  for (const group of activeProfile.fileGroups ?? []) files[group.id] = Array.from(document.getElementById(`package-field-${group.id}`)?.files ?? []);
  return files;
}

function refreshFieldVisibility() {
  if (!activeProfile) return;
  const active = activeValues(activeProfile, gatherValues());
  for (const field of activeProfile.fields ?? []) {
    const row = document.querySelector(`#package-dialog-fields [data-profile-field="${field.id}"]`);
    row?.classList.toggle('hidden', !(field.id in active));
  }
}

// ---------------------------------------------------------------------------
// Validate + build
// ---------------------------------------------------------------------------

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
  if (!activeProfile) return;
  const profile = activeProfile;
  const values = gatherValues();
  const files = gatherFiles();
  const packetName = _appState.manifest.packetName;
  const errors = validatePackage(profile, values, files, packetName);
  renderErrors(errors);
  if (errors.length > 0) {
    document.getElementById('package-dialog-errors').scrollIntoView({ block: 'nearest' });
    return;
  }

  // §19 step 4: schema-validity warnings are a confirm-to-continue, not a
  // block — this packet may legitimately be filed incomplete during testing.
  if (_appState.manifest && _appState.schemaParser) {
    _appState.formEngine.flushRegisteredControls();
    const schemaErrors = validateSchema(_appState.instanceKeys, _appState.formEngine.getAllFormStates(), _appState.schemaParser);
    if (schemaErrors.length > 0) {
      const proceed = await confirmAction(
        'Package with validation issues?',
        `This packet has ${schemaErrors.length} validation issue${schemaErrors.length === 1 ? '' : 's'} (missing or invalid fields, unresolved choices, and so on). Validate lists them.`,
        { confirmLabel: 'Create anyway' }
      );
      if (!proceed) return;
    }
  }

  await _withBusyOverlay('Building submission package…', async () => {
    const packetXml = _buildPacketXml();
    const { blob, filename } = await buildPackage({ profile, values, files, packetXml, packetName });
    toolbar.downloadBlob(blob, filename);
    _onPacketWritten?.(packetXml);
    // Blank values are kept too: clearing an optional field should stick.
    settingsStore.saveLastPackagingSettings(profile, Object.fromEntries(Object.entries(values).map(([k, v]) => [k, isBlank(v) ? '' : v.trim()])));
    toolbar.setStatus(`Created ${filename}`);
  });

  closeDialog();
}
