// js/core/coloringService.js — R/G/Y completeness logic.
//
// See web-implementation-spec.md §9 (Coloring Service), §22 invariants 6, 7, 12.
// IMPLEMENTATION_PLAN.md Phase 4.1.
//
// Pure logic, no DOM dependencies. js/ui/coloring.js applies the computed
// FieldColorState values to actual DOM elements.
//
// Mirrors validateSchema/validateNode's tree-walking dispatch order (§16) and
// reuses the exact same shared predicates (joinPath, isTransparent, isAttribute,
// isLeaf, isRepeatingContentContainer) from parser.js — the coloring walker, the
// validator, the writer, and the reader all have to agree on what the schema
// means, and staying structurally parallel is how that's enforced.

import { joinPath, isTransparent, isAttribute, isLeaf, isRepeatingContentContainer } from './parser.js';

export function isEmpty(value) {
  return value === undefined || value === null || value === '';
}

export function hasValue(value) {
  return !isEmpty(value);
}

/**
 * Same ValidationRule kinds as the real field-level validator (§16's
 * validateField, built in Phase 5) — coloring only needs a valid/invalid
 * verdict, not a message, so this is a standalone, lighter-weight check rather
 * than an import from validation.js (which doesn't exist yet). Keep the rule
 * semantics in sync with validateField if either one changes.
 */
export function isFieldValid(element, value) {
  if (isEmpty(value)) return true; // emptiness is a completeness concern (computeColor), not a validity one
  for (const rule of element.validationRules || []) {
    switch (rule.kind) {
      case 'minLength':
        if (String(value).length < Number(rule.value)) return false;
        break;
      case 'maxLength':
        if (String(value).length > Number(rule.value)) return false;
        break;
      case 'pattern':
        if (!new RegExp(`^(?:${rule.value})$`).test(String(value))) return false;
        break;
      case 'minInclusive':
        if (Number(value) < Number(rule.value)) return false;
        break;
      case 'maxInclusive':
        if (Number(value) > Number(rule.value)) return false;
        break;
      case 'totalDigits':
        if (String(value).replace(/[-.]/g, '').replace(/^0+(?=\d)/, '').length > Number(rule.value)) return false;
        break;
      case 'fractionDigits': {
        const frac = String(value).split('.')[1] || '';
        if (frac.length > Number(rule.value)) return false;
        break;
      }
      default:
        break;
    }
  }
  if (element.kind === 'DatePicker' && isNaN(Date.parse(value))) return false;
  return true;
}

/** §9 "Color Rules" — one leaf (or attribute) field's own color. Knows nothing
 *  about siblings/containers. Yellow marks "optional and empty" (a field the
 *  user is free to leave alone) as distinctly as Red marks "required and
 *  empty" — every leaf always has some color, never none. */
export function computeColor(element, value) {
  if (isEmpty(value)) return element.isRequired ? 'Red' : 'Yellow';
  return isFieldValid(element, value) ? 'Green' : 'Red';
}

/**
 * §9 "Container Coloring". Every child always has some color now (leaves
 * never come back null — see computeColor), so an empty `childColors` only
 * happens for a container with no scoreable descendants at all.
 */
export function computeContainerColor(isRequired, childColors) {
  if (childColors.length === 0) return isRequired ? 'Green' : 'Yellow';
  if (childColors.every((c) => c === 'Green')) return 'Green';
  if (childColors.some((c) => c === 'Red')) return 'Red';
  return 'Yellow';
}

/**
 * Computes FieldColorState for every colorable node in the tree — leaf fields,
 * attributes, containers, repeating instances, and radio groups alike — keyed
 * by the SAME lower-cased, fully-indexed path convention FormEngine uses (§8).
 * `state` is a FormState-shaped object: { fieldValues, radioSelections,
 * repeatingInstanceCounts } (all already lower-cased, per FormEngine's own
 * storage convention — pass formEngine.getFormState(instanceKey) directly).
 *
 * js/ui/coloring.js applies whichever of these entries have a DOM target in
 * the current render; entries with no matching element are simply unused.
 */
export function computeAllColors(schemaElement, state) {
  const result = new Map();
  colorOfNode(schemaElement, '', state, result);
  return result;
}

function colorOfNode(element, parentPath, state, result) {
  if (element.kind === 'RadioGroup') return colorOfRadioGroup(element, parentPath, state, result);
  if (isRepeatingContentContainer(element)) return colorOfRepeatingContentContainer(element, parentPath, state, result);

  const path = joinPath(parentPath, element.elementName);

  // Transparent wrapper nodes (generated Entry/Option wrappers, choice-only
  // containers' own RadioGroup child, etc.) still contribute a path segment
  // (§22 invariants 24/29) but are never leaves themselves — always fall
  // through to the children-aggregate branch below, even if (degenerately)
  // childless, rather than misreading them as an empty leaf field.
  if (!isTransparent(element) && (isAttribute(element) || isLeaf(element))) {
    const value = state.fieldValues[path.toLowerCase()];
    const color = computeColor(element, value);
    result.set(path.toLowerCase(), color);
    return color;
  }

  const childColors = colorOfChildren(element, path, state, result);
  const color = computeContainerColor(element.isRequired, childColors);
  result.set(path.toLowerCase(), color);
  return color;
}

function colorOfChildren(element, path, state, result) {
  const colors = [];
  for (const child of element.children) {
    const c = colorOfNode(child, path, state, result);
    if (c !== null) colors.push(c);
  }
  return colors;
}

/** §9 "Radio branch coloring": only the SELECTED branch is evaluated — hidden
 *  branches are ignored entirely (confirmed against WALKTHROUGH.md §18: "Only
 *  Option2's children are evaluated for completeness. Option1's fields
 *  (hidden) are ignored by the coloring service."). */
function colorOfRadioGroup(element, parentPath, state, result) {
  const choicePath = joinPath(parentPath, element.elementName);
  const selectedTarget = state.radioSelections[choicePath.toLowerCase()];
  let color;
  if (!selectedTarget) {
    // Unselected reads the same as an empty leaf (§9's computeColor): Red if
    // required, Yellow if this choice is optional to leave alone.
    color = element.isRequired ? 'Red' : 'Yellow';
  } else {
    const option = element.children.find((o) => joinPath(choicePath, o.elementName).toLowerCase() === String(selectedTarget).toLowerCase());
    if (option) {
      const optionPath = joinPath(choicePath, option.elementName);
      const childColors = colorOfChildren(option, optionPath, state, result);
      color = computeContainerColor(option.isRequired, childColors);
    } else {
      color = null; // stale/unresolvable selection — defensive, not expected in practice
    }
  }
  result.set(choicePath.toLowerCase(), color);
  return color;
}

/**
 * The coloring-side counterpart of validateNode's isRepeatingContentContainer
 * branch (§16): `element` is the named, non-repeating container (e.g.
 * PriorNameList) whose sole structural child is the synthetic, repeating Entry
 * wrapper. Each instance's own children are aggregated first (using the
 * ENTRY's isRequired — an untouched, freshly-added blank instance colors
 * Yellow if the entry is optional, same symmetry as an untouched optional
 * leaf); those per-instance colors then roll up into one overall color for
 * `element` itself, alongside any of its own attributes, using ELEMENT's
 * isRequired.
 */
function colorOfRepeatingContentContainer(element, parentPath, state, result) {
  const path = joinPath(parentPath, element.elementName);
  const attributes = element.children.filter(isAttribute);
  const entryWrapper = element.children.find((c) => !isAttribute(c));
  const entryPath = joinPath(path, entryWrapper.elementName);
  const count = state.repeatingInstanceCounts[entryWrapper.elementName.toLowerCase()] ?? 0;

  const outerChildColors = [];
  for (const attr of attributes) {
    const c = colorOfNode(attr, path, state, result);
    if (c !== null) outerChildColors.push(c);
  }

  const instanceColors = [];
  for (let i = 0; i < count; i++) {
    const instancePath = `${entryPath}[${i}]`;
    const childColors = colorOfChildren(entryWrapper, instancePath, state, result);
    const instanceColor = computeContainerColor(entryWrapper.isRequired, childColors);
    result.set(instancePath.toLowerCase(), instanceColor);
    if (instanceColor !== null) instanceColors.push(instanceColor);
  }

  const entryOverallColor = computeContainerColor(element.isRequired, instanceColors);
  result.set(entryPath.toLowerCase(), entryOverallColor); // matches entryWrapper.elementPath, in case anything keys off it directly
  if (entryOverallColor !== null) outerChildColors.push(entryOverallColor);

  const color = computeContainerColor(element.isRequired, outerChildColors);
  result.set(path.toLowerCase(), color);
  return color;
}
