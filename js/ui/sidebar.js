// js/ui/sidebar.js — Nav tree, nav filter, form add/remove.
//
// See web-implementation-spec.md §13 (Page Layout) and §20 (Form Switch Flow).
// IMPLEMENTATION_PLAN.md Phase 3.3; dev/IMPLEMENTATION_ORDER.md Phase 5
// (parity 3.2, backlog D.3).
//
// Rendering only. What the tree contains — hierarchy, labels, numbering,
// which rows are removable, what the filter keeps — is js/core/navModel.js.
// Groups are <details>, so collapsing is native and needs no state of ours
// beyond remembering which ones the user closed across rebuilds.

import { chooseOne } from './chooseRootDialog.js';
import { buildNavModel, filterNavModel, actionableNodes, isAddableSection } from '../core/navModel.js';

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

function countInstances(instanceKeys, section) {
  return instanceKeys.filter((k) => k.formName.toLowerCase() === section.elementName.toLowerCase()).length;
}

// Module state — the sidebar is a singleton, like every other ui/ panel.
const collapsedGroups = new Set(); // section elementNames the user closed
let filterQuery = '';
let lastRender = null; // the arguments of the last buildNavTree, so the filter can re-render

/** Tooltip: everything the label may have truncated or left out. */
function tooltipFor(node) {
  const lines = [];
  if (node.section) {
    lines.push(node.section.description ? `${node.section.elementName} — ${node.section.description}` : node.section.elementName);
    if (node.type === 'instance' && node.key.instanceId !== node.key.formName) lines.push(`Instance: ${node.key.instanceId}`);
    lines.push(node.isRequired ? 'Required' : 'Optional');
    if (node.section.sourceSchemaFile) lines.push(node.section.sourceSchemaFile);
  } else {
    lines.push(node.label);
  }
  return lines.join('\n');
}

function renderNodes(nodes, activeInstanceKey, handlers, filtering) {
  const frag = document.createDocumentFragment();
  for (const node of nodes) {
    const li = document.createElement('li');
    li.title = tooltipFor(node);

    if (node.type === 'group') {
      li.className = 'nav-group';
      li.dataset.section = node.section.elementName;
      const details = document.createElement('details');
      // While filtering, every group shown is open: it is only there because
      // something inside it matched.
      details.open = filtering || !collapsedGroups.has(node.section.elementName);
      details.addEventListener('toggle', () => {
        if (filtering) return;
        if (details.open) collapsedGroups.delete(node.section.elementName);
        else collapsedGroups.add(node.section.elementName);
      });
      const summary = document.createElement('summary');
      summary.className = `nav-group-label ${node.isRequired ? 'nav-required' : 'nav-optional'}`;
      summary.textContent = node.label;
      const ul = document.createElement('ul');
      ul.className = 'nav-group-children';
      ul.appendChild(renderNodes(node.children, activeInstanceKey, handlers, filtering));
      details.append(summary, ul);
      li.appendChild(details);
      frag.appendChild(li);
      continue;
    }

    li.tabIndex = 0;
    const label = document.createElement('span');
    label.className = 'nav-tree-label';
    label.textContent = node.label;
    li.appendChild(label);

    if (node.type === 'missing') {
      li.className = 'nav-item nav-missing nav-required';
      li.dataset.section = node.section.elementName;
      li.title += '\nNo instance yet — click to add one.';
      const hint = document.createElement('span');
      hint.className = 'nav-missing-hint';
      hint.textContent = '+ add';
      li.appendChild(hint);
      li.addEventListener('click', () => handlers.onAdd?.(node.section.elementName));
    } else {
      li.className = `nav-item ${node.isRequired ? 'nav-required' : 'nav-optional'}`;
      li.dataset.key = node.key.toString();
      if (activeInstanceKey && node.key.equals(activeInstanceKey)) li.classList.add('active');
      if (handlers.onRemove && node.removable) {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'nav-tree-remove-btn';
        removeBtn.textContent = '×';
        removeBtn.title = `Remove ${node.label}`;
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation(); // don't also trigger onSelect via the li's own click handler
          handlers.onRemove(node.key);
        });
        li.appendChild(removeBtn);
      }
      li.addEventListener('click', () => handlers.onSelect(node.key));
    }
    li.addEventListener('keydown', (e) => {
      if (e.target !== li || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      li.click();
    });
    frag.appendChild(li);
  }
  return frag;
}

/**
 * @param {HTMLElement} navTreeEl
 * @param {import('../core/formEngine.js').FormInstanceKey[]} instanceKeys in manifest order
 * @param {import('../core/formEngine.js').FormInstanceKey|null} activeInstanceKey
 * @param {(key: import('../core/formEngine.js').FormInstanceKey) => void} onSelect
 * @param {{sections: object[]}|null} [manifest]
 * @param {(key: import('../core/formEngine.js').FormInstanceKey) => void} [onRemove]
 * @param {(sectionName: string) => void} [onAdd] — a "missing" placeholder row was clicked
 */
export function buildNavTree(navTreeEl, instanceKeys, activeInstanceKey, onSelect, manifest, onRemove, onAdd) {
  lastRender = { navTreeEl, instanceKeys, activeInstanceKey, onSelect, manifest, onRemove, onAdd };
  const nodes = filterNavModel(buildNavModel(manifest, instanceKeys), filterQuery);
  navTreeEl.innerHTML = '';
  navTreeEl.appendChild(renderNodes(nodes, activeInstanceKey, { onSelect, onRemove, onAdd }, !!filterQuery.trim()));
  if (nodes.length === 0 && filterQuery.trim()) {
    const li = document.createElement('li');
    li.className = 'nav-empty';
    li.textContent = 'No forms match the filter.';
    navTreeEl.appendChild(li);
  }
}

export function updateNavTreeActiveState(navTreeEl, instanceKey) {
  if (lastRender) lastRender.activeInstanceKey = instanceKey;
  const target = instanceKey.toString();
  navTreeEl.querySelectorAll('li.nav-item').forEach((li) => {
    const isActive = li.dataset.key === target;
    li.classList.toggle('active', isActive);
    if (!isActive) return;
    // Reached some other way than a click (search, validation, undo): make
    // sure it isn't sitting inside a group the user collapsed.
    for (let el = li.parentElement; el && el !== navTreeEl; el = el.parentElement) {
      if (el.tagName === 'DETAILS' && !el.open) el.open = true;
    }
    li.scrollIntoView?.({ block: 'nearest' });
  });
}

/** Parity 3.2/3.3: the root's name, plus the schema version when it declares one. */
export function setCurrentRootLabel(labelEl, packetName, schemaVersion = '', schemaVersionAttribute = null) {
  labelEl.textContent = packetName ? `Root: ${packetName}${schemaVersion ? `  •  ${schemaVersion}` : ''}` : '';
  labelEl.title = schemaVersion
    ? `Schema version ${schemaVersion}${schemaVersionAttribute ? ` (written as ${schemaVersionAttribute}="${schemaVersion}" on the packet root)` : ''}`
    : '';
}

/**
 * Backlog D.3: the filter box above the nav tree. Re-renders from the last
 * buildNavTree arguments; Enter opens the first matching row, Escape clears.
 * @param {HTMLInputElement} inputEl
 */
export function wireNavFilter(inputEl) {
  if (!inputEl) return;
  const rerender = () => {
    if (!lastRender) return;
    const r = lastRender;
    buildNavTree(r.navTreeEl, r.instanceKeys, r.activeInstanceKey, r.onSelect, r.manifest, r.onRemove, r.onAdd);
  };
  inputEl.addEventListener('input', () => {
    filterQuery = inputEl.value;
    rerender();
  });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && inputEl.value) {
      e.preventDefault();
      inputEl.value = '';
      filterQuery = '';
      rerender();
    } else if (e.key === 'Enter' && lastRender) {
      e.preventDefault();
      const first = actionableNodes(filterNavModel(buildNavModel(lastRender.manifest, lastRender.instanceKeys), filterQuery))[0];
      if (!first) return;
      if (first.type === 'missing') lastRender.onAdd?.(first.section.elementName);
      else lastRender.onSelect(first.key);
    }
  });
}

/** Enables the filter for a loaded schema, and clears what the previous one had typed. */
export function resetNavFilter(inputEl, enabled) {
  filterQuery = '';
  collapsedGroups.clear();
  if (!inputEl) return;
  inputEl.value = '';
  inputEl.disabled = !enabled;
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
    const addable = collectLeafSections(manifest.sections).filter((s) => isAddableSection(s, countInstances(instanceKeys, s)));

    const labelFor = (s) => (s.description ? `${s.elementName} — ${s.description}` : s.elementName);
    const labelToName = new Map(addable.map((s) => [labelFor(s), s.elementName]));
    const chosenLabel = await chooseOne([...labelToName.keys()], 'No more forms available to add.', 'Add a new instance of which form?');
    if (chosenLabel) onAdd(labelToName.get(chosenLabel));
  });
}
