// js/ui/sidebar.js — Nav tree, form add/remove.
//
// See web-implementation-spec.md §13 (Page Layout) and §20 (Form Switch Flow).
// IMPLEMENTATION_PLAN.md Phase 3.3.

/**
 * @param {HTMLElement} navTreeEl
 * @param {import('../core/formEngine.js').FormInstanceKey[]} instanceKeys
 * @param {import('../core/formEngine.js').FormInstanceKey|null} activeInstanceKey
 * @param {(key: import('../core/formEngine.js').FormInstanceKey) => void} onSelect
 */
export function buildNavTree(navTreeEl, instanceKeys, activeInstanceKey, onSelect) {
  navTreeEl.innerHTML = '';
  for (const key of instanceKeys) {
    const li = document.createElement('li');
    li.textContent = key.toString();
    li.dataset.key = key.toString();
    if (activeInstanceKey && key.equals(activeInstanceKey)) li.classList.add('active');
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
