// js/core/xmlWriter.js — Form state → XML string.
//
// See web-implementation-spec.md §10 (XML Writing).
// IMPLEMENTATION_PLAN.md Phase 2.3.
//
// Pure logic beyond building/serializing an XML Document (createElementNS,
// XMLSerializer — browser globals, not app-specific DOM rendering).

import { isTransparent, isAttribute, isLeaf, isRepeatingContentContainer, isChoiceOnlyContainer, joinPath, findSectionAncestry } from './parser.js';
import { keyOf } from './formEngine.js';

export function isEmpty(value) {
  return value === undefined || value === null || value === '';
}

export function formatValue(value, schemaElement) {
  if (schemaElement.kind === 'Checkbox') {
    // The X/blank-enum checkbox idiom (parser.js assignLeafKind's
    // isXEnumCheckboxType) has no valid "false" text — its enumeration only
    // ever allows the literal "X" — so buildNodes below only calls this for
    // value === true on that flavor; a real xsd:boolean still needs both.
    return schemaElement.xsdDataType === 'xs:boolean' ? (value ? 'true' : 'false') : 'X';
  }
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

  // Leaf forms nested under a wrapper section (e.g. FormN11/SchCR under
  // ReturnDataState) must be written inside that wrapper's own element, not as
  // direct children of the packet root — memoized per wrapper path so every
  // leaf sharing the same wrapper reuses the one element instance.
  const wrapperElByPath = new Map();
  function resolveTargetParent(formName) {
    const ancestry = findSectionAncestry(manifest.sections, formName) || [];
    let parent = root;
    let pathKey = '';
    for (const name of ancestry) {
      pathKey = pathKey ? `${pathKey}.${name}` : name;
      let wrapperEl = wrapperElByPath.get(pathKey);
      if (!wrapperEl) {
        wrapperEl = createElement(name);
        parent.appendChild(wrapperEl);
        wrapperElByPath.set(pathKey, wrapperEl);
      }
      parent = wrapperEl;
    }
    return parent;
  }

  for (const instanceKey of orderedInstanceKeys) {
    const state = allFormStates.get(keyOf(instanceKey)) ?? allFormStates.get(instanceKey.toString());
    if (!state) continue;
    const schemaElement = schemaParser.parseGlobalElement(instanceKey.formName);
    if (!schemaElement) continue;
    syncInstanceIdAttribute(schemaElement, state, instanceKey);
    buildNodes(resolveTargetParent(instanceKey.formName), schemaElement, state);
  }

  return prettyPrintXml(new XMLSerializer().serializeToString(root));
}

/**
 * Reformats a compact, single-line XML string (as XMLSerializer produces it)
 * into one element per line, indented by nesting depth — readability only, no
 * semantic change. Safe to do as a pure string/token pass, no re-parse
 * needed: XML well-formedness requires a literal `<` inside attribute/text
 * content to be escaped as `&lt;`, so a `<...>` token match can never
 * straddle real content by accident. This app's tree has no mixed content
 * (§22 scope), so every leaf's open tag, text, and close tag tokenize as ONE
 * unit (`<PacketId>AA0000</PacketId>`, matched whole by the first
 * alternative below, INCLUDING when empty — `<Foo></Foo>`) and land on a
 * single line — no whitespace is ever introduced INSIDE a value, only
 * BETWEEN sibling container elements (insignificant whitespace a reader's
 * `textContent`/`.children` walk already ignores — see xmlReader.js).
 */
export function prettyPrintXml(xmlString) {
  const tokenPattern = /<([\w.:-]+)(?:\s[^>]*)?>[^<]*<\/\1>|<[^>]+>/g;
  const tokens = xmlString.match(tokenPattern) ?? [];
  let depth = 0;
  const out = [];
  for (const token of tokens) {
    const isLeafPair = /^<([\w.:-]+)(?:\s[^>]*)?>[^<]*<\/\1>$/.test(token);
    const isClosing = !isLeafPair && /^<\//.test(token);
    const isSelfClosing = !isLeafPair && /\/>$/.test(token);
    const isDeclaration = /^<\?/.test(token);
    if (isClosing) depth = Math.max(0, depth - 1);
    out.push(depth > 0 ? '  '.repeat(depth) + token : token);
    if (!isLeafPair && !isClosing && !isSelfClosing && !isDeclaration) depth++;
  }
  return out.join('\n');
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

  if (schemaElement.isRepeating && schemaElement.isGeneratedWrapper) {
    // Same anonymous-repeating-<xs:sequence> idiom as isRepeatingContentContainer
    // above, but this Entry wrapper is only ONE of several structural siblings
    // under its parent, so that check's "parent's ONLY child" gate fails (e.g.
    // AuthenticationHeader.xsd's Submission: a maxOccurs="3" sequence sitting
    // next to a separate xs:choice for NoFinancialProduct/RefundProductCd).
    // There's no "outer element's tag repeats" trick available here — the
    // parent's own tag must appear exactly once — so instead each repetition's
    // fields are appended directly to `parentEl` (the Entry wrapper never
    // emits a tag of its own either way, same as above), one after another at
    // successively `[i]`-indexed paths, in schema order.
    const entryPath = joinPath(path, schemaElement.elementName);
    const count = state.repeatingInstanceCounts[schemaElement.elementName.toLowerCase()] ?? 0;
    for (let i = 0; i < count; i++) {
      for (const grandchild of schemaElement.children) {
        buildNodes(parentEl, grandchild, state, `${entryPath}[${i}]`);
      }
    }
    return;
  }

  if (schemaElement.isRepeating && !schemaElement.isGeneratedWrapper) {
    // A REAL (non-synthetic) repeating element — e.g. HI's "DependentInformation"
    // (maxOccurs=99, parser.js's _finishComplexType). Unlike the generated-Entry
    // case above, this element keeps its own XML tag each repetition — there's
    // no separate wrapper, the element itself is both the repeating unit and
    // the field holder — and unlike isRepeatingContentContainer it's typically
    // one of several structural siblings under its parent, not the parent's
    // sole child, so the "outer tag repeats, Entry doesn't" trick doesn't apply
    // here either: this element's OWN tag is what repeats.
    const count = state.repeatingInstanceCounts[schemaElement.elementName.toLowerCase()] ?? 0;
    const entryPath = joinPath(path, schemaElement.elementName);
    for (let i = 0; i < count; i++) {
      const el = createElement(schemaElement.elementName);
      writeContainerBody(el, schemaElement, state, `${entryPath}[${i}]`);
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
    // The X/blank-enum checkbox idiom (see formatValue above) has no valid
    // "false" text to fall back on, so unchecked always means "omit the
    // element" — same as any other empty optional field — never an empty
    // <Field/>. A real xsd:boolean Checkbox is unaffected: isEmpty(false) is
    // false, so it keeps writing an explicit true/false either way.
    const isUncheckedXEnum = schemaElement.kind === 'Checkbox' && schemaElement.xsdDataType !== 'xs:boolean' && value !== true;
    const noValue = isUncheckedXEnum || isEmpty(value);
    if (noValue && !schemaElement.isRequired) return; // omit optional empty
    const el = createElement(schemaElement.elementName);
    if (!noValue) el.textContent = formatValue(value, schemaElement);
    parentEl.appendChild(el);
    return;
  }

  // Container
  const el = createElement(schemaElement.elementName);
  writeContainerBody(el, schemaElement, state, currentPath);
  if (el.children.length > 0 || el.attributes.length > 0 || schemaElement.isRequired) {
    parentEl.appendChild(el);
  }
}

/** Writes schemaElement's own attributes onto `el`, then its non-attribute
 *  children as child nodes — shared by the generic Container branch above and
 *  the real-repeating-element branch, which needs the exact same body once
 *  per `[i]`-indexed instance rather than once at an unindexed path. */
function writeContainerBody(el, schemaElement, state, currentPath) {
  for (const attr of schemaElement.children.filter(isAttribute)) {
    const attrValue = state.fieldValues[joinPath(currentPath, attr.elementName).toLowerCase()];
    if (!isEmpty(attrValue)) el.setAttribute(attr.elementName, formatValue(attrValue, attr));
  }
  for (const child of schemaElement.children.filter((c) => !isAttribute(c))) {
    buildNodes(el, child, state, currentPath);
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
        // Stored as the option's own STATIC elementPath, matching the format
        // state.radioSelections values already use (set by formRenderer.js's
        // setRadioSelection call) — never the runtime, index-bearing
        // `optionPath` computed just above, which the comparison below would
        // never match once an index is involved (this RadioGroup sitting
        // inside a repeating instance).
        selectedBranch = option.elementPath;
        break;
      }
    }
  }
  if (!selectedBranch) return;
  const selectedOption = choiceElement.children.find((c) => pathsMatch(c.elementPath, selectedBranch));
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
