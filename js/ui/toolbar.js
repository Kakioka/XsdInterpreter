// js/ui/toolbar.js — Toolbar button handlers.
//
// See web-implementation-spec.md §13 (Page Layout — Toolbar HTML) and §24
// (Browser Compatibility Notes — File System Access API with <input
// webkitdirectory> fallback). IMPLEMENTATION_PLAN.md Phase 3.3.
//
// Note: unlike the toolbar HTML sketched in §13, `load-xml-btn` and
// `add-form-btn` start `disabled` here (index.html) and get enabled only once
// a schema is loaded — reading XML or adding a form instance both require a
// manifest/parser to already exist, so enabling them earlier would just be an
// invitation to click something that can't do anything yet.

/** @returns {Promise<Map<string,string>>} filename → text, .xsd files only */
export async function pickSchemaFileTextMap(folderInputEl) {
  if (window.showDirectoryPicker) {
    const dirHandle = await window.showDirectoryPicker();
    const map = new Map();
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === 'file' && name.toLowerCase().endsWith('.xsd')) {
        const file = await handle.getFile();
        map.set(name, await file.text());
      }
    }
    return map;
  }
  return new Promise((resolve, reject) => {
    folderInputEl.value = '';
    folderInputEl.onchange = async () => {
      try {
        const files = Array.from(folderInputEl.files).filter((f) => f.name.toLowerCase().endsWith('.xsd'));
        const map = new Map();
        for (const f of files) map.set(f.name, await f.text());
        resolve(map);
      } catch (err) {
        reject(err);
      }
    };
    folderInputEl.click();
  });
}

/** @returns {Promise<string>} the selected file's text content */
export function pickXmlFileText(xmlInputEl) {
  return new Promise((resolve, reject) => {
    xmlInputEl.value = '';
    xmlInputEl.onchange = async () => {
      try {
        const file = xmlInputEl.files[0];
        if (!file) { reject(new Error('No file selected')); return; }
        resolve(await file.text());
      } catch (err) {
        reject(err);
      }
    };
    xmlInputEl.click();
  });
}

/** Blob + temporary <a download> — works in every target browser (§24),
 *  unlike showSaveFilePicker which is Chrome/Edge-only. */
export function downloadXmlString(xmlString, filename) {
  const blob = new Blob([xmlString], { type: 'application/xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * @param {{onSchemaFilesSelected: (fileTextMap: Map<string,string>) => Promise<void>,
 *          onXmlTextSelected: (xmlText: string) => Promise<void>,
 *          onSaveXmlRequested: () => void}} handlers
 */
export function wireToolbar({ onSchemaFilesSelected, onXmlTextSelected, onSaveXmlRequested }) {
  const folderInput = document.getElementById('schema-folder-input');
  const xmlInput = document.getElementById('xml-file-input');

  async function loadSchemaClicked() {
    try {
      const fileTextMap = await pickSchemaFileTextMap(folderInput);
      if (fileTextMap.size === 0) return; // user cancelled, or picked a folder with no .xsd files
      await onSchemaFilesSelected(fileTextMap);
    } catch (err) {
      if (err?.name === 'AbortError') return; // user cancelled the directory picker
      console.error(err);
      window.alert(`Failed to load schema: ${err.message}`);
    }
  }
  document.getElementById('load-schema-btn')?.addEventListener('click', loadSchemaClicked);
  document.getElementById('load-schema-menu-btn')?.addEventListener('click', loadSchemaClicked);

  document.getElementById('load-xml-btn')?.addEventListener('click', async () => {
    try {
      const xmlText = await pickXmlFileText(xmlInput);
      await onXmlTextSelected(xmlText);
    } catch (err) {
      console.error(err);
      window.alert(`Failed to load XML: ${err.message}`);
    }
  });

  document.getElementById('save-xml-btn')?.addEventListener('click', () => onSaveXmlRequested());
}

/** Buttons that only make sense once a schema is loaded. */
export function setSchemaDependentButtonsEnabled(enabled) {
  for (const id of ['save-xml-btn', 'load-xml-btn', 'add-form-btn', 'validate-btn', 'fill-all-btn', 'fill-required-btn']) {
    const el = document.getElementById(id);
    if (el) el.disabled = !enabled;
  }
}

export function setStatus(text) {
  const el = document.getElementById('top-status');
  if (el) el.textContent = text;
}
