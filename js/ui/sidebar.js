// js/ui/sidebar.js — Nav tree, form add/remove.
//
// See web-implementation-spec.md §13 (Page Layout) and §20 (Form Switch Flow).
// IMPLEMENTATION_PLAN.md Phase 3.3.

import { chooseOne } from './chooseRootDialog.js';

/** Finds a manifest section (possibly nested under childForms) by elementName. */
export function findSection(sections, formName) {
  for (const s of sections || []) {
    if (s.elementName === formName) return s;
    if (s.childForms?.length) {
      const found = findSection(s.childForms, formName);
      if (found) return found;
    }
  }
  return null;
}

/** Flattens a manifest section tree down to its leaf forms — a wrapper section
 *  (childForms.length > 0, e.g. ReturnDataState) is never itself addable, only
 *  its leaf descendants (FormN11, SchCR, ...) are. */
function collectLeafSections(sections, out = []) {
  for (const s of sections || []) {
    if (s.childForms?.length) collectLeafSections(s.childForms, out);
    else out.push(s);
  }
  return out;
}

/** A repeatable leaf is always addable (up to maxOccurs, if bounded). A
 *  non-repeatable leaf is addable only when optional and not already present —
 *  required non-repeatable forms (e.g. FormN11) are pre-instantiated at load
 *  and never appear here. */
function isAddableSection(section, instanceKeys) {
  const count = instanceKeys.filter((k) => k.formName.toLowerCase() === section.elementName.toLowerCase()).length;
  if (section.isRepeatable) return section.maxOccurs === -1 || count < section.maxOccurs;
  return !section.isRequired && count === 0;
}

/**
 * A form instance is deletable from the nav tree when it's optional — either
 * a repeatable section's instance (it only exists because the user "+ Add"ed
 * it) or a non-repeatable section whose own minOccurs is 0. A required
 * non-repeatable section always has exactly one instance and can't be removed.
 */
function isRemovable(manifest, key) {
  const section = manifest ? findSection(manifest.sections, key.formName) : null;
  return !!section && (section.isRepeatable || !section.isRequired);
}

/**
 * @param {HTMLElement} navTreeEl
 * @param {import('../core/formEngine.js').FormInstanceKey[]} instanceKeys
 * @param {import('../core/formEngine.js').FormInstanceKey|null} activeInstanceKey
 * @param {(key: import('../core/formEngine.js').FormInstanceKey) => void} onSelect
 * @param {{sections: object[]}|null} [manifest] — used to decide which entries are removable
 * @param {(key: import('../core/formEngine.js').FormInstanceKey) => void} [onRemove]
 */
export function buildNavTree(navTreeEl, instanceKeys, activeInstanceKey, onSelect, manifest, onRemove) {
  navTreeEl.innerHTML = '';
  for (const key of instanceKeys) {
    const li = document.createElement('li');
    li.dataset.key = key.toString();
    if (activeInstanceKey && key.equals(activeInstanceKey)) li.classList.add('active');

    const label = document.createElement('span');
    label.className = 'nav-tree-label';
    label.textContent = key.toString();
    li.appendChild(label);

    if (onRemove && isRemovable(manifest, key)) {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'nav-tree-remove-btn';
      removeBtn.textContent = '×';
      removeBtn.title = `Remove ${key.toString()}`;
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // don't also trigger onSelect via the li's own click handler
        onRemove(key);
      });
      li.appendChild(removeBtn);
    }

    li.addEventListener('click', () => onSelect(key));
    navTreeEl.appendChild(li);
  }
}

export function updateNavTreeActiveState(navTreeEl, instanceKey) {
  const target = instanceKey.toString();
  navTreeEl.querySelectorAll('li').forEach((li) => {
    li.classList.toggle('active', li.dataset.key === target);
  });
}

export function setCurrentRootLabel(labelEl, packetName) {
  labelEl.textContent = packetName ? `Root: ${packetName}` : '';
}

/**
 * Wires the sidebar's single "+ Add" button to a dropdown of every addable
 * leaf form — every form nested under a wrapper section (e.g. ReturnDataState)
 * plus any top-level repeatable/optional section, minus whatever is already
 * present and can't be added again. Reuses chooseRootDialog's generic
 * chooseOne() picker (auto-picks when there's exactly one candidate).
 * @param {HTMLButtonElement} addBtn
 * @param {() => {sections: object[]}|null} getManifest
 *   a getter (not a static object) so this always sees the current schema —
 *   the button is wired once at bootstrap, before any schema is loaded
 * @param {() => import('../core/formEngine.js').FormInstanceKey[]} getInstanceKeys
 * @param {(sectionName: string) => void} onAdd
 */
export function wireAddFormButton(addBtn, getManifest, getInstanceKeys, onAdd) {
  addBtn.addEventListener('click', async () => {
    const manifest = getManifest();
    if (!manifest) return;
    const instanceKeys = getInstanceKeys() || [];
    const addable = collectLeafSections(manifest.sections).filter((s) => isAddableSection(s, instanceKeys));

    const labelFor = (s) => (s.description ? `${s.elementName} — ${s.description}` : s.elementName);
    const labelToName = new Map(addable.map((s) => [labelFor(s), s.elementName]));
    const chosenLabel = await chooseOne([...labelToName.keys()], 'No more forms available to add.', 'Add a new instance of which form?');
    if (chosenLabel) onAdd(labelToName.get(chosenLabel));
  });
}
