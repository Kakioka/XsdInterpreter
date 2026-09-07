// js/core/xmlWriter.js — Form state → XML string.
//
// See web-implementation-spec.md §10 (XML Writing).
// IMPLEMENTATION_PLAN.md Phase 2.3.
//
// Pure logic beyond building/serializing an XML Document (createElementNS,
// XMLSerializer — browser globals, not app-specific DOM rendering).

import { isTransparent, isAttribute, isLeaf, isRepeatingContentContainer, isChoiceOnlyContainer, joinPath } from './parser.js';
import { keyOf } from './formEngine.js';

export function isEmpty(value) {
  return value === undefined || value === null || value === '';
}

export function formatValue(value, schemaElement) {
  if (schemaElement.kind === 'Checkbox') return value ? 'true' : 'false';
  return String(value).trim();
}

function hasDataUnder(pathPrefix, fieldValues) {
  const p = pathPrefix.toLowerCase();
  return Object.entries(fieldValues).some(([k, v]) => (k === p || k.startsWith(`${p}.`) || k.startsWith(`${p}[`)) && !isEmpty(v));
}

function pathsMatch(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

// Namespace-aware element creation (§10 "Namespace-Aware Element Creation").
// Module-scoped for the duration of one buildPacketXml call so buildNodes/
// buildChoiceNodes below don't need a namespace parameter threaded through
// every call.
let _doc = null;
let _targetNamespace = null;

function createElement(tagName) {
  return _targetNamespace ? _doc.createElementNS(_targetNamespace, tagName) : _doc.createElement(tagName);
}

/** Ensures the written XML carries the same instance id the reader would derive
 *  on reload (§11), even if the user never touched the documentId field. */
export function syncInstanceIdAttribute(schemaElement, state, instanceKey) {
  const idAttr = schemaElement.children.find((c) => isAttribute(c) && c.isInstanceIdSource);
  if (!idAttr || instanceKey.instanceId === instanceKey.formName) return; // non-repeatable form: no synthetic id
  const key = joinPath(schemaElement.elementName, idAttr.elementName).toLowerCase();
  if (isEmpty(state.fieldValues[key])) state.fieldValues[key] = instanceKey.instanceId;
}

/**
 * @param {{packetName: string}} manifest
 * @param {Map<string, object>} allFormStates FormState lookup — accepts either
 *   FormEngine's own lowercased keyOf(instanceKey) keys or xmlReader's natural-case
 *   instanceKey.toString() keys (see xmlReader.js readPacket doc comment); both are
 *   tried so this function works with either source without the caller normalizing.
 * @param {import('./formEngine.js').FormInstanceKey[]} orderedInstanceKeys
 * @param {{parseGlobalElement: (name:string)=>object|null}} schemaParser
 * @param {string|null} [targetNamespace]
 * @returns {string}
 */
export function buildPacketXml(manifest, allFormStates, orderedInstanceKeys, schemaParser, targetNamespace = null) {
  _targetNamespace = targetNamespace || null;
  _doc = document.implementation.createDocument(_targetNamespace, '', null); // qualifiedName '' → no document element yet
  const root = createElement(manifest.packetName);
  _doc.appendChild(root);

  for (const instanceKey of orderedInstanceKeys) {
    const state = allFormStates.get(keyOf(instanceKey)) ?? allFormStates.get(instanceKey.toString());
    if (!state) continue;
    const schemaElement = schemaParser.parseGlobalElement(instanceKey.formName);
    if (!schemaElement) continue;
    syncInstanceIdAttribute(schemaElement, state, instanceKey);
    buildNodes(root, schemaElement, state);
  }

  return new XMLSerializer().serializeToString(root);
}

/**
 * `path` is always the prefix to prepend to `schemaElement`'s OWN name — i.e. the
 * full path of schemaElement's parent, never schemaElement's own path. Every
 * extension of it MUST go through joinPath (§8) to avoid a leading-dot key.
 */
export function buildNodes(parentEl, schemaElement, state, path = '') {
  if (schemaElement.kind === 'RadioGroup') {
    buildChoiceNodes(parentEl, schemaElement, state, path);
    return;
  }

  if (isRepeatingContentContainer(schemaElement)) {
    const entryWrapper = schemaElement.children.find((c) => !isAttribute(c));
    const entryPath = joinPath(joinPath(path, schemaElement.elementName), entryWrapper.elementName);
    const count = state.repeatingInstanceCounts[entryWrapper.elementName.toLowerCase()] ?? 0;
    for (let i = 0; i < count; i++) {
      const el = createElement(schemaElement.elementName); // outer container's name repeats, not the Entry wrapper's
      for (const grandchild of entryWrapper.children) {
        buildNodes(el, grandchild, state, `${entryPath}[${i}]`);
      }
      parentEl.appendChild(el);
    }
    return;
  }

  if (isChoiceOnlyContainer(schemaElement)) {
    // A named element whose entire content model is a bare xs:choice (e.g.
    // EntityTypeChoice) never emits its own tag either — see isChoiceOnlyContainer
    // in parser.js. Its name still becomes a path segment for the RadioGroup child.
    const radioGroup = schemaElement.children.find((c) => !isAttribute(c));
    buildChoiceNodes(parentEl, radioGroup, state, joinPath(path, schemaElement.elementName));
    return;
  }

  if (isTransparent(schemaElement)) {
    // generated wrappers with no special handling above (e.g. choice options)
    for (const child of schemaElement.children) buildNodes(parentEl, child, state, path);
    return;
  }

  if (isAttribute(schemaElement)) return; // written by the parent container below, never visited directly

  const currentPath = joinPath(path, schemaElement.elementName);

  if (isLeaf(schemaElement)) {
    const value = state.fieldValues[currentPath.toLowerCase()];
    if (isEmpty(value) && !schemaElement.isRequired) return; // omit optional empty
    const el = createElement(schemaElement.elementName);
    if (!isEmpty(value)) el.textContent = formatValue(value, schemaElement);
    parentEl.appendChild(el);
    return;
  }

  // Container
  const el = createElement(schemaElement.elementName);
  for (const attr of schemaElement.children.filter(isAttribute)) {
    const attrValue = state.fieldValues[joinPath(currentPath, attr.elementName).toLowerCase()];
    if (!isEmpty(attrValue)) el.setAttribute(attr.elementName, formatValue(attrValue, attr));
  }
  for (const child of schemaElement.children.filter((c) => !isAttribute(c))) {
    buildNodes(el, child, state, currentPath);
  }
  if (el.children.length > 0 || el.attributes.length > 0 || schemaElement.isRequired) {
    parentEl.appendChild(el);
  }
}

export function buildChoiceNodes(parentEl, choiceElement, state, path) {
  const choicePath = joinPath(path, choiceElement.elementName);
  let selectedBranch = state.radioSelections[choicePath.toLowerCase()];
  if (!selectedBranch) {
    // Fallback: find first option that has any data (backward compat — §22 invariant 17)
    for (const option of choiceElement.children) {
      const optionPath = joinPath(choicePath, option.elementName);
      if (hasDataUnder(optionPath, state.fieldValues)) {
        selectedBranch = optionPath;
        break;
      }
    }
  }
  if (!selectedBranch) return;
  const selectedOption = choiceElement.children.find((c) => pathsMatch(joinPath(choicePath, c.elementName), selectedBranch));
  if (!selectedOption) return;
  // The option wrapper emits no XML tag of its own (still transparent — see
  // isTransparent), but its NAME still contributes a path segment for field
  // value lookups, matching the SchemaElement tree's own elementPath (§8:
  // "Synthetic segments ARE included in paths" explicitly lists OptionN as an
  // example) — parser.js builds every leaf's elementPath through the option,
  // so xmlReader/xmlWriter must key fieldValues the same way or values will
  // never reach the rendered controls that get registered at elementPath.
  const optionPath = joinPath(choicePath, selectedOption.elementName);
  for (const child of selectedOption.children) {
    buildNodes(parentEl, child, state, optionPath);
  }
}
