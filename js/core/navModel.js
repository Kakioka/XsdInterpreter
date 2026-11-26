// js/core/navModel.js — the sidebar nav tree as data: hierarchy, labels,
// numbering, required/optional, and the filter.
//
// See dev/PARITY_GAP_ANALYSIS.md 3.2 and dev/IMPROVEMENT_BACKLOG.md D.3.
// dev/IMPLEMENTATION_ORDER.md Phase 5.
//
// Pure: (manifest, instanceKeys) → a tree of plain nodes, which js/ui/sidebar.js
// only renders. Everything a user could tell apart between this tree and the
// WPF one is decided here, so it is covered by `node --test`
// (test/navModel.test.mjs) rather than only by looking at the page.
//
// There is no stored tree to keep in sync: appState.instanceKeys is in manifest
// order (parser.js sortInstanceKeys / insertInstanceKey), so the tree is
// rebuilt from scratch on every structural change and renumbering — WPF's
// RenumberTreeItemsForFormName — happens by construction.

/**
 * @typedef {{type: 'group', section: object, label: string, isRequired: boolean, children: NavNode[]}} NavGroup
 *   A wrapper section (e.g. ReturnDataState): never a form itself, only a heading.
 * @typedef {{type: 'instance', section: object|null, key: object, label: string, isRequired: boolean,
 *   ordinal: number|null, removable: boolean}} NavInstance
 *   One form instance. `ordinal` is its 1-based number among its form's
 *   instances when there is more than one, else null.
 * @typedef {{type: 'missing', section: object, label: string, isRequired: true}} NavMissing
 *   A required form with no instance yet (a required repeatable form starts
 *   with none) — shown so the requirement is visible, and clickable to add one.
 * @typedef {NavGroup|NavInstance|NavMissing} NavNode
 */

/** Parity 3.2: the section's documentation, falling back to its element name. */
export function sectionLabel(section) {
  return section.description || section.elementName;
}

/**
 * Optional forms, and every instance of a repeatable one (it exists only
 * because it was added or loaded), can be removed. A required non-repeatable
 * form always has exactly its one instance.
 */
export function isRemovableSection(section) {
  return !!section && (section.isRepeatable || !section.isRequired);
}

/** Same rule as sidebar's "+ Add" menu: repeatable up to maxOccurs, or optional
 *  and not yet present. */
export function isAddableSection(section, instanceCount) {
  if (section.isRepeatable) return section.maxOccurs === -1 || instanceCount < section.maxOccurs;
  return !section.isRequired && instanceCount === 0;
}

/**
 * @param {{sections: object[]}|null} manifest
 * @param {{formName: string, instanceId: string, toString(): string}[]} instanceKeys
 * @returns {NavNode[]}
 */
export function buildNavModel(manifest, instanceKeys) {
  const keysByForm = new Map();
  for (const key of instanceKeys) {
    const name = key.formName.toLowerCase();
    if (!keysByForm.has(name)) keysByForm.set(name, []);
    keysByForm.get(name).push(key);
  }
  const placed = new Set();

  // `required` is whether this section is required AND everything above it is:
  // a required form inside an optional wrapper is only needed once that
  // wrapper is in use, so it gets no "missing" placeholder of its own (the same
  // activation rule coloring applies inside a form, §22 invariant 30).
  function walk(sections, ancestorsRequired) {
    const nodes = [];
    for (const section of sections || []) {
      const required = ancestorsRequired && section.isRequired;
      if (section.childForms?.length) {
        const children = walk(section.childForms, required);
        if (children.length > 0) {
          nodes.push({ type: 'group', section, label: sectionLabel(section), isRequired: section.isRequired, children });
        }
        continue;
      }
      const keys = keysByForm.get(section.elementName.toLowerCase()) || [];
      keys.forEach((key, i) => {
        placed.add(key);
        const ordinal = keys.length > 1 ? i + 1 : null;
        nodes.push({
          type: 'instance',
          section,
          key,
          label: ordinal ? `${sectionLabel(section)} (${ordinal})` : sectionLabel(section),
          isRequired: section.isRequired,
          ordinal,
          removable: isRemovableSection(section),
        });
      });
      if (keys.length === 0 && required) {
        nodes.push({ type: 'missing', section, label: sectionLabel(section), isRequired: true });
      }
    }
    return nodes;
  }

  const nodes = walk(manifest?.sections, true);

  // A key naming no manifest form shouldn't exist, but if it does it still gets
  // a row: dropping it would hide stored data with no way back to it.
  for (const key of instanceKeys) {
    if (placed.has(key)) continue;
    nodes.push({ type: 'instance', section: null, key, label: key.toString(), isRequired: false, ordinal: null, removable: false });
  }
  return nodes;
}

function normalize(text) {
  return String(text ?? '').toLowerCase();
}

/** The text a row can be found by: what it shows, its element name, its full
 *  description, and (for a repeatable instance) its instance id. */
function searchableText(node) {
  const parts = [node.label];
  if (node.section) parts.push(node.section.elementName, node.section.description);
  if (node.type === 'instance' && node.key.instanceId !== node.key.formName) parts.push(node.key.instanceId);
  return normalize(parts.join('\n'));
}

/**
 * Backlog D.3. Keeps every row whose text contains `query` (case-insensitive),
 * plus the groups leading to it. A group that matches by its own name keeps
 * all of its rows — filtering "ReturnData" should show what is in it.
 * @param {NavNode[]} nodes
 * @param {string} query
 * @returns {NavNode[]} a pruned copy; `nodes` itself when the query is blank
 */
export function filterNavModel(nodes, query) {
  const q = normalize(query).trim();
  if (!q) return nodes;
  const prune = (list) => {
    const out = [];
    for (const node of list) {
      if (node.type === 'group') {
        if (searchableText(node).includes(q)) out.push(node);
        else {
          const children = prune(node.children);
          if (children.length > 0) out.push({ ...node, children });
        }
      } else if (searchableText(node).includes(q)) {
        out.push(node);
      }
    }
    return out;
  };
  return prune(nodes);
}

/** Depth-first rows a user can act on (instances and missing placeholders) —
 *  what Enter in the filter box picks the first of. */
export function actionableNodes(nodes, out = []) {
  for (const node of nodes) {
    if (node.type === 'group') actionableNodes(node.children, out);
    else out.push(node);
  }
  return out;
}
