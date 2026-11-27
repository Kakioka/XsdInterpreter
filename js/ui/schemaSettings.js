// js/ui/schemaSettings.js — "Schema Settings" dialog: the per-schema override
// for which attribute identifies an instance of a repeatable form.
//
// dev/PARITY_GAP_ANALYSIS.md 1.5. The heuristic is parser.js's
// selectInstanceIdSource; persistence is settingsStore.js. Built into the
// <dialog id="schema-settings-overlay"> on open and shown with modal.js.

import { isAttribute } from '../core/parser.js';
import { findInstanceIdAttribute } from '../core/instanceIdentity.js';
import { updateSchemaSettings, isDataStored } from '../core/settingsStore.js';
import * as toolbar from './toolbar.js';
import { openModal, closeModal } from './modal.js';

let _appState = null;

function repeatableForms(sections, out = []) {
  for (const section of sections) {
    if (section.childForms?.length) repeatableForms(section.childForms, out);
    else if (section.isRepeatable) out.push(section.elementName);
  }
  return out;
}

// Select values: "auto", "none", or "attribute:<name>".
function toSetting(value) {
  return value.startsWith('attribute:') ? { mode: 'attribute', name: value.slice('attribute:'.length) } : { mode: value };
}

function fromSetting(setting) {
  if (setting?.mode === 'attribute') return `attribute:${setting.name}`;
  return setting?.mode === 'none' ? 'none' : 'auto';
}

function closeDialog() {
  closeModal(document.getElementById('schema-settings-overlay'));
}

function addOption(select, value, text) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = text;
  select.appendChild(opt);
}

function openDialog() {
  const overlay = document.getElementById('schema-settings-overlay');
  const { manifest, schemaParser } = _appState;
  if (!overlay || !manifest) return;
  overlay.innerHTML = '';

  const formNames = repeatableForms(manifest.sections);
  const attributeNames = new Set();
  for (const name of formNames) {
    for (const attr of schemaParser.parseGlobalElement(name)?.children.filter(isAttribute) ?? []) attributeNames.add(attr.elementName);
  }

  const dialog = document.createElement('div');
  dialog.id = 'schema-settings-dialog';
  const header = document.createElement('div');
  header.id = 'schema-settings-header';
  header.textContent = `Schema settings: ${manifest.packetName}`;

  const body = document.createElement('div');
  body.id = 'schema-settings-body';
  const label = document.createElement('label');
  label.htmlFor = 'schema-settings-id-source';
  label.textContent = 'Attribute that identifies each copy of a repeatable form';
  const select = document.createElement('select');
  select.id = 'schema-settings-id-source';
  addOption(select, 'auto', 'Detect automatically');
  for (const name of [...attributeNames].sort()) addOption(select, `attribute:${name}`, name);
  addOption(select, 'none', 'None (keep ids out of the XML)');
  const current = fromSetting(schemaParser.instanceIdSource);
  // A stored choice this version of the schema no longer declares still shows.
  if (![...select.options].some((o) => o.value === current)) addOption(select, current, `${schemaParser.instanceIdSource.name} (not in this schema)`);
  select.value = current;

  const list = document.createElement('ul');
  list.id = 'schema-settings-forms';
  const renderForms = () => {
    list.innerHTML = '';
    const before = schemaParser.instanceIdSource;
    schemaParser.instanceIdSource = toSetting(select.value); // preview through the real resolution
    try {
      for (const name of formNames) {
        const li = document.createElement('li');
        li.textContent = `${name}: ${findInstanceIdAttribute(schemaParser.parseGlobalElement(name))?.elementName ?? 'no identity attribute'}`;
        list.appendChild(li);
      }
    } finally {
      schemaParser.instanceIdSource = before;
    }
    if (formNames.length === 0) list.textContent = 'This schema has no repeatable forms.';
  };
  select.addEventListener('change', renderForms);
  renderForms();

  const note = document.createElement('p');
  note.className = 'hint';
  note.textContent = 'Remembered for this schema. Forms already open keep their current ids.';
  body.append(label, select, list, note);

  const footer = document.createElement('div');
  footer.id = 'schema-settings-footer';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', closeDialog);
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.id = 'schema-settings-save-btn';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', () => {
    schemaParser.instanceIdSource = toSetting(select.value);
    const stored = updateSchemaSettings(_appState.schemaSettingsKey, { instanceIdSource: schemaParser.instanceIdSource });
    toolbar.setStatus(
      !stored
        ? 'Schema settings apply to this session only (browser storage is unavailable)'
        : isDataStored()
          ? 'Schema settings saved'
          : 'Schema settings apply to this session only (not storing data in this browser)'
    );
    closeDialog();
  });
  footer.append(cancelBtn, saveBtn);

  dialog.append(header, body, footer);
  overlay.appendChild(dialog);
  select.autofocus = true;
  openModal(overlay);
}

export function wireSchemaSettings({ appState }) {
  _appState = appState;
  document.getElementById('schema-settings-btn')?.addEventListener('click', openDialog);
}
