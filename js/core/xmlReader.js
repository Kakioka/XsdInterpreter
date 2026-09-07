// js/core/xmlReader.js — XML string → form state.
//
// See web-implementation-spec.md §11 (XML Reading).
// IMPLEMENTATION_PLAN.md Phase 2.2.
//
// Pure logic beyond DOMParser (a browser global, not app-specific DOM rendering).

import { isTransparent, isAttribute, isLeaf, isRepeatingContentContainer, isChoiceOnlyContainer, joinPath } from './parser.js';
import { FormInstanceKey, createEmptyFormState } from './formEngine.js';

function generateUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Fallback for environments without crypto.randomUUID (shouldn't be needed in
  // any modern browser this app targets — see spec §24 Browser Compatibility Notes).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function parseValue(rawText, schemaElement) {
  if (schemaElement.kind === 'Checkbox') return rawText.trim().toLowerCase() === 'true';
  return rawText.trim();
}

/**
 * The set of XML tag names that could legitimately appear as a DIRECT child for
 * a given list of schema children — used only for unmatched-field detection.
 * Not simply each child's own elementName: a RadioGroup (bare or wrapped in an
 * isChoiceOnlyContainer, e.g. EntityTypeChoice) never appears as a tag itself —
 * every one of ITS options' descendant leaf names is a possible direct child
 * instead, recursively (a branch can itself contain a nested choice-only
 * container, e.g. IdTypeChoice inside EntityTypeChoice's Individual branch).
 */
function possibleDirectChildTagNames(children) {
  const names = new Set();
  for (const child of children) {
    if (isAttribute(child)) continue;
    const radioGroup = child.kind === 'RadioGroup' ? child : isChoiceOnlyContainer(child) ? child.children.find((c) => !isAttribute(c)) : null;
    if (radioGroup) {
      for (const option of radioGroup.children) {
        for (const name of possibleDirectChildTagNames(option.children)) names.add(name);
      }
    } else {
      names.add(child.elementName.toLowerCase());
    }
  }
  return names;
}

/**
 * @param {string} xmlString
 * @param {{sections: {elementName:string, isRepeatable:boolean}[]}} manifest
 * @param {{parseGlobalElement:(name:string)=>object|null}} schemaParser
 * @returns {Map<string, object>} key.toString() (natural case — see note below) → FormState
 *
 * Keyed by the NATURAL-CASE FormInstanceKey.toString(), not the lowercased
 * keyOf() FormEngine uses internally — this lets a caller recover the original
 * form name / instance id casing via FormInstanceKey.parse(key) when merging
 * into FormEngine (whose own restoreFormState() re-applies keyOf() itself, so
 * its case-insensitivity guarantee (§6) is unaffected either way).
 */
export function readPacket(xmlString, manifest, schemaParser) {
  const doc = new DOMParser().parseFromString(xmlString, 'application/xml');
  const parserError = doc.getElementsByTagName('parsererror')[0];
  if (parserError) throw new Error(`Failed to parse XML: ${parserError.textContent.trim()}`);

  const result = new Map();

  for (const section of manifest.sections) {
    const elements = doc.documentElement.querySelectorAll(`:scope > ${section.elementName}`);
    for (const el of elements) {
      const instanceId = section.isRepeatable ? el.getAttribute('documentId') || generateUUID() : section.elementName;
      const key = new FormInstanceKey(section.elementName, instanceId);
      const schemaElement = schemaParser.parseGlobalElement(section.elementName);
      if (!schemaElement) continue; // unresolvable section — nothing to read it into
      const state = extractFormState(el, schemaElement);
      result.set(key.toString(), state);
    }
  }

  return result;
}

/**
 * `xmlEl` is already the element that corresponds to `schemaElement` itself
 * (e.g. the matched <SampleEventLog documentId="EVT-001"> node) — there is no
 * extra querySelector step to "find" it, unlike every recursive call below.
 */
export function extractFormState(xmlEl, schemaElement) {
  const state = createEmptyFormState();
  walkContainerBody(xmlEl, schemaElement, schemaElement.elementName, state);
  return state;
}

/**
 * Reads schemaElement's own attributes off xmlEl, then walks its non-attribute
 * children. `currentPath` is schemaElement's OWN full path (not its parent's).
 */
export function walkContainerBody(xmlEl, schemaElement, currentPath, state) {
  for (const attr of schemaElement.children.filter(isAttribute)) {
    const raw = xmlEl.getAttribute(attr.elementName);
    if (raw !== null) {
      state.fieldValues[joinPath(currentPath, attr.elementName).toLowerCase()] = parseValue(raw, attr);
    }
  }

  const knownChildNames = possibleDirectChildTagNames(schemaElement.children);
  for (const domChild of xmlEl.children) {
    if (!knownChildNames.has(domChild.tagName.toLowerCase())) {
      state.unmatchedFields.push({
        formName: schemaElement.elementName,
        xmlPath: joinPath(currentPath, domChild.tagName),
        value: domChild.textContent,
      });
    }
  }

  for (const child of schemaElement.children.filter((c) => !isAttribute(c))) {
    walkElement(xmlEl, child, currentPath, state);
  }
}

/**
 * `xmlEl` is the PARENT DOM element (schemaElement's tag, if any, is a *child*
 * of xmlEl). `path` is that parent's own full path — the prefix schemaElement's
 * name gets joined onto. This mirrors buildNodes' path contract exactly (§10).
 */
export function walkElement(xmlEl, schemaElement, path, state) {
  if (schemaElement.kind === 'RadioGroup') {
    const choicePath = joinPath(path, schemaElement.elementName);
    for (const option of schemaElement.children) {
      const firstRealChild = option.children.find((c) => !isAttribute(c));
      if (firstRealChild && xmlEl.querySelector(`:scope > ${firstRealChild.elementName}`)) {
        const optionPath = joinPath(choicePath, option.elementName);
        state.radioSelections[choicePath.toLowerCase()] = optionPath;
        // Option wrapper emits no XML tag (still transparent), but its name
        // still contributes a path segment for field keys — see the matching
        // note in xmlWriter.js's buildChoiceNodes; must mirror it exactly so
        // reads and writes (and rendered controls, keyed by elementPath) agree.
        for (const grandchild of option.children) {
          walkElement(xmlEl, grandchild, optionPath, state);
        }
        break;
      }
    }
    return;
  }

  if (isRepeatingContentContainer(schemaElement)) {
    const entryWrapper = schemaElement.children.find((c) => !isAttribute(c));
    const instances = xmlEl.querySelectorAll(`:scope > ${schemaElement.elementName}`);
    const entryPath = joinPath(joinPath(path, schemaElement.elementName), entryWrapper.elementName);
    state.repeatingInstanceCounts[entryWrapper.elementName.toLowerCase()] = instances.length;
    instances.forEach((inst, i) => {
      for (const grandchild of entryWrapper.children) {
        walkElement(inst, grandchild, `${entryPath}[${i}]`, state);
      }
    });
    return;
  }

  if (isChoiceOnlyContainer(schemaElement)) {
    // A named element whose entire content model is a bare xs:choice (e.g.
    // EntityTypeChoice) never appears as an XML tag either — see
    // isChoiceOnlyContainer in parser.js. xmlEl stays the same (its RadioGroup
    // child's branch fields are direct children of xmlEl, not of a wrapper);
    // only the path gains this element's name as a segment.
    const radioGroup = schemaElement.children.find((c) => !isAttribute(c));
    walkElement(xmlEl, radioGroup, joinPath(path, schemaElement.elementName), state);
    return;
  }

  if (isTransparent(schemaElement)) {
    // Defensive fallback; no current construct reaches this (RadioGroup and the
    // repeating-content-container / choice-only-container shapes are all
    // handled above already).
    for (const child of schemaElement.children) walkElement(xmlEl, child, path, state);
    return;
  }

  if (isAttribute(schemaElement)) return; // read by the parent's walkContainerBody, never visited directly

  const currentPath = joinPath(path, schemaElement.elementName);

  if (isLeaf(schemaElement)) {
    const childEl = xmlEl.querySelector(`:scope > ${schemaElement.elementName}`);
    if (childEl) state.fieldValues[currentPath.toLowerCase()] = parseValue(childEl.textContent, schemaElement);
    // else: absent from XML — leave unset; completeness/coloring will flag it if required
    return;
  }

  // Container
  const childEl = xmlEl.querySelector(`:scope > ${schemaElement.elementName}`);
  if (childEl) walkContainerBody(childEl, schemaElement, currentPath, state);
}
