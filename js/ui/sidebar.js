// js/ui/sidebar.js — Nav tree, form add/remove.
//
// See web-implementation-spec.md §13 (Page Layout) and §20 (Form Switch Flow).
// IMPLEMENTATION_PLAN.md Phase 3.3.

/** Finds a manifest section (possibly nested under childForms) by elementName. */
function findSection(sections, formName) {
  for (const s of sections || []) {
    if (s.elementName === formName) return s;
    if (s.childForms?.length) {
      const found = findSection(s.childForms, formName);
      if (found) return found;
    }
  }
  return null;
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
 * Wires the sidebar's single "+ Add" button. When more than one section is
 * repeatable, `window.prompt` stands in for a proper picker for now — the
 * sample schema only has one repeatable section (SampleEventLog), so this
 * rarely matters yet; revisit with a real dropdown/modal in a later UI pass.
 * @param {HTMLButtonElement} addBtn
 * @param {() => {sections: {elementName:string, isRepeatable:boolean}[]}|null} getManifest
 *   a getter (not a static object) so this always sees the current schema —
 *   the button is wired once at bootstrap, before any schema is loaded
 * @param {(sectionName: string) => void} onAdd
 */
export function wireAddFormButton(addBtn, getManifest, onAdd) {
  addBtn.addEventListener('click', () => {
    const manifest = getManifest();
    if (!manifest) return;
    const repeatable = manifest.sections.filter((s) => s.isRepeatable);
    if (repeatable.length === 0) {
      window.alert('No repeatable forms in this schema to add another instance of.');
      return;
    }
    if (repeatable.length === 1) {
      onAdd(repeatable[0].elementName);
      return;
    }
    const names = repeatable.map((s) => s.elementName).join(', ');
    const chosen = window.prompt(`Add a new instance of which form?\n(${names})`, repeatable[0].elementName);
    if (chosen && repeatable.some((s) => s.elementName === chosen)) onAdd(chosen);
  });
}
