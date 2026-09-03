# Web Implementation Specification — XML Form Editor

## Purpose

This document is a complete implementation guide for rebuilding the XML Form Editor as a browser-based application using vanilla HTML, CSS, and JavaScript (no frameworks, no build tools required). It describes every system, algorithm, data structure, and behavioral rule needed to produce a functionally equivalent tool.

The application runs entirely in the browser. No server is required. All file I/O uses the browser's File System Access API (with `<input type="file">` fallbacks). XSD parsing, form generation, XML reading/writing, and all business logic run client-side in JavaScript.

---

## 1. High-Level Architecture

The application is a single-page application (SPA) consisting of one HTML file that loads a set of JavaScript modules and one CSS file.

```
index.html
css/
  main.css
js/
  core/
    flattener.js        — XSD include/import resolution → flat DOM
    parser.js           — Flat XSD DOM → SchemaElement tree
    formEngine.js       — Central state manager
    coloringService.js  — R/G/Y completeness logic
    xmlWriter.js        — Form state → XML string
    xmlReader.js        — XML string → form state
    searchService.js    — Cross-form field text search
    testDataFiller.js   — Auto-fill with valid sample values
    undoService.js      — Command stack (undo/redo)
    packager.js         — MeF submission ZIP builder (uses JSZip)
  ui/
    app.js              — Bootstrap, wiring, global event bus
    toolbar.js          — Toolbar button handlers
    sidebar.js          — Nav tree, form add/remove
    formRenderer.js     — SchemaElement tree → DOM controls
    controlFactory.js   — Creates individual input elements
    coloring.js         — Applies R/G/Y borders to DOM controls
    search.js           — Search panel UI
    validation.js       — Validation panel UI
    undo.js             — Undo/redo UI wiring
    contextMenu.js      — Container right-click fill/clear
    theme.js            — Theme loading and CSS variable application
    debug.js            — Debug panel (developer mode)
```

All `js/core/` modules are pure logic with no DOM dependencies. All `js/ui/` modules depend on the DOM. This mirrors the Core/UI separation in the original desktop application.

---

## 2. Data Models

All models are plain JavaScript objects. Use JSDoc comments for type documentation.

### SchemaElement

```js
/**
 * @typedef {Object} SchemaElement
 * @property {string}   elementName
 * @property {string}   resolvedLabel       — human-readable label
 * @property {string}   documentation       — tooltip/help text
 * @property {string}   lineNumber          — display-only, never emitted to XML
 * @property {string}   kind                — see ElementKind
 * @property {string}   xsdDataType         — e.g. 'xs:string', 'xs:date'
 * @property {string}   originalTypeName    — before base resolution
 * @property {boolean}  isRequired
 * @property {number}   minOccurs
 * @property {number|null} maxOccurs        — null = unbounded
 * @property {boolean}  isRepeating
 * @property {boolean}  isGeneratedWrapper  — synthetic Choice/Entry node
 * @property {EnumerationOption[]} enumerationValues
 * @property {ValidationRule[]}   validationRules
 * @property {SchemaElement[]}    children
 * @property {string}   elementPath         — dot-notation, e.g. "Form.Section.Field"
 * @property {string}   instanceLabel       — display label for repeating instances
 */
```

### ElementKind (string enum)

```
'TextInput' | 'NumericInput' | 'DecimalInput' | 'DatePicker' |
'Checkbox' | 'Dropdown' | 'GroupContainer' | 'SequenceContainer' | 'RadioGroup'
```

### FormState

```js
/**
 * @typedef {Object} FormState
 * @property {Object.<string, any>} fieldValues       — path → value (case-insensitive keys)
 * @property {Object.<string, number>} repeatingInstanceCounts — basePath → count
 * @property {Object.<string, string|null>} radioSelections   — choicePath → selectedBranchPath
 * @property {boolean} isDirty
 */
```

### FormInstanceKey

```js
/**
 * @typedef {Object} FormInstanceKey
 * @property {string} formName    — schema element name
 * @property {string} instanceId  — same as formName for non-repeatable;
 *                                   UUID for repeatable instances
 */
// Equality: case-insensitive on both fields
// toString: "formName" for non-repeatable, "formName#instanceId" for repeatable
```

### PacketManifest

```js
/**
 * @typedef {Object} PacketManifest
 * @property {string} packetName
 * @property {PacketSection[]} sections
 * @property {string[]} allForms   — flat list of all form element names
 */

/**
 * @typedef {Object} PacketSection
 * @property {string}  elementName
 * @property {string}  description
 * @property {boolean} isRequired
 * @property {boolean} isRepeatable
 * @property {number}  maxOccurs       — -1 = unbounded
 * @property {PacketSection[]} childForms
 */
```

### ValidationRule

```js
/**
 * @typedef {Object} ValidationRule
 * @property {string} kind    — 'minLength'|'maxLength'|'pattern'|'minInclusive'|'maxInclusive'|'totalDigits'|'fractionDigits'
 * @property {string} value
 */
```

### EnumerationOption

```js
/**
 * @typedef {Object} EnumerationOption
 * @property {string} value
 * @property {string} label
 */
```

### FieldColorState

```
'Red' | 'Green' | 'Yellow'
```

---

## 3. XSD Flattening

**File:** `js/core/flattener.js`

The browser cannot read the filesystem directly. The user selects a folder via `<input type="file" webkitdirectory>` or the File System Access API `showDirectoryPicker()`. The application receives a list of `File` objects.

### Algorithm

```
flattenFromRoot(files, rootFileName):
  1. Build a map: filename → file text content (read all files upfront with FileReader / file.text())
  2. Parse the root file as an XML DOM using DOMParser
  3. Recursively resolve xs:include and xs:import:
     a. For each xs:include[@schemaLocation]:
        — Find the referenced file in the map (by basename)
        — Parse it, inline all its top-level children into the root document
        — Remove the xs:include element
        — Recurse into the included document first (depth-first)
     b. For each xs:import[@schemaLocation]:
        — If schemaLocation looks like a URL (starts with http), log a warning and skip
        — Otherwise treat same as xs:include
        — Missing import files: log warning and skip (non-fatal)
        — Missing include files: throw an error (fatal)
  4. Strip UTF-8 BOM (U+FEFF) from all file text before parsing
     — If any file contains U+FEFF, report them to the user before proceeding
     — Offer to strip them automatically
  5. Return the merged XSD as a single DOM Document
```

### BOM Detection

Before step 1, scan all `.xsd` file text contents for U+FEFF (both as leading BOM and interior zero-width no-break space). If found, show a modal listing the affected files with an option to clean and continue or cancel.

```js
function scanForBom(fileTextMap) {
  const affected = [];
  for (const [name, text] of fileTextMap) {
    const hasLeadingBom = text.charCodeAt(0) === 0xFEFF;
    const hasInterior = text.indexOf('\uFEFF') >= (hasLeadingBom ? 1 : 0);
    if (hasLeadingBom || hasInterior)
      affected.push({ name, hasLeadingBom, hasInterior });
  }
  return affected;
}

function stripBom(text) {
  return text.replace(/\uFEFF/g, '');
}
```

---

## 4. Schema Parsing

**File:** `js/core/parser.js`

Parses the flat XSD DOM into a `SchemaElement` tree.

### TypeLookupTable

Build before parsing. Walk the flat document and index:
- Named `xs:complexType` elements by `name` attribute
- Named `xs:simpleType` elements by `name` attribute
- Named `xs:group` elements by `name` attribute

```js
class TypeLookupTable {
  constructor(flatDoc) {
    this.complexTypes = new Map();  // name → XElement
    this.simpleTypes  = new Map();  // name → XElement
    this.groups       = new Map();  // name → XElement
    this._build(flatDoc);
  }
  _build(doc) { /* walk xs:complexType, xs:simpleType, xs:group */ }
  getComplexType(name) { return this.complexTypes.get(name.toLowerCase()); }
  getSimpleType(name)  { return this.simpleTypes.get(name.toLowerCase()); }
  getGroup(name)       { return this.groups.get(name.toLowerCase()); }
  resolveUltimateBaseType(typeName) {
    // Follow xs:restriction base chains until a primitive is reached
    // e.g. DateType → xs:date; StringType50 → xs:string
  }
}
```

### Kind Assignment

Given a `SchemaElement` with its parsed data type and structural context, assign `kind`:

```
if (context is xs:choice)         → 'RadioGroup'
if (context is anon xs:sequence with maxOccurs > 1) → 'SequenceContainer' (isRepeating=true)
if (context is xs:all)            → treat as non-repeating sequence (transparent)
if (context is xs:group ref)      → expand inline (transparent)
if (has named complexType)        → 'GroupContainer'
if (xsdDataType is xs:boolean)    → 'Checkbox'
if (enumerationValues.length > 0) → 'Dropdown'
if (xsdDataType is xs:date or xs:dateTime) → 'DatePicker'
if (xsdDataType is xs:integer, xs:int, xs:long, xs:short, xs:byte, xs:nonNegativeInteger, etc.) → 'NumericInput'
if (xsdDataType is xs:decimal)    → 'DecimalInput'
default                           → 'TextInput'
```

**Inline simpleType resolution:** When an element has `xs:simpleType/xs:restriction[@base]`, resolve the base through `resolveUltimateBaseType` before kind assignment. This ensures named types like `DateType` (which restricts `xs:date`) are recognized as date pickers.

### Synthetic Nodes

- `RadioGroup`: creates a wrapper element named `{ParentName}Choice`. Each `xs:choice` branch becomes `{ChoiceName}Option1`, `{ChoiceName}Option2`, etc. All option elements have `isGeneratedWrapper = true`.
- `SequenceContainer` (repeating): creates a wrapper element named `{ParentName}Entry` with `isGeneratedWrapper = true`.

### Transparency

A node is transparent if `isGeneratedWrapper === true || kind === 'RadioGroup' || kind === 'SequenceContainer'`. Transparent nodes do not emit their own XML tag.

### xs:attribute Support

After resolving a `complexType`'s children, also collect `xs:attribute` elements (including those inherited from base types via `xs:extension`). Each attribute becomes a `SchemaElement` using the same kind-assignment rules. Attributes are prepended to the parent's `children` array. Skip duplicates by name.

### xs:group Expansion

When encountering `xs:group ref="SomeName"`, look up the group in `TypeLookupTable.getGroup(name)` and inline its contained model group (the first `xs:sequence`, `xs:all`, or `xs:choice` child). The group itself produces no `SchemaElement`. Recurse to handle nested group refs.

### Global Element Lookup

`parseGlobalElement(name)`:
1. Find `xs:element[@name=name]` at top level of the flat document.
2. If not found, search inline elements declared within the root element's `complexType/sequence/all` — supports single-root schemas where child forms are inline.

### Path Building

Path format: dot-separated element names. Example: `ReturnDataState.N11.N11Choice.AdjustedGrossIncome`

Synthetic segments ARE included in paths. Repeating instances use bracket notation: `SomeList[0].Field`, `SomeList[1].Field`.

---

## 5. Packet Analysis

**File:** `js/core/parser.js` (or a separate `packetAnalyzer.js`)

After flattening, find the root element and walk its content model to discover all form sections.

```
analyzePacket(flatDoc, rootElementName):
  1. Find xs:element[@name=rootElementName]
  2. Recursively walk its complexType children
  3. For each xs:element ref or name declaration:
     — Read ref first, then name (supports both reference-style and inline-declaration-style schemas)
     — Create PacketSection with isRequired (minOccurs >= 1), isRepeatable (maxOccurs > 1 or unbounded)
     — Recurse into child sections
  4. Return PacketManifest { packetName, sections, allForms }
```

**Root detection:** Scan the flat document for `xs:element` declarations at the top level that appear to be root candidates — elements that are not referenced as children of any other element, or elements with a specific naming convention.

---

## 6. Form Engine

**File:** `js/core/formEngine.js`

The central state manager. All form state lives here. The UI reads from and writes to this service.

```js
class FormEngine {
  // storedStates: Map<string, FormState>  (key = instanceKey.toString(), case-insensitive)
  // registeredControls: Map<string, ControlRef>  (key = elementPath)
  // activeInstanceKey: FormInstanceKey | null

  registerControl(path, controlRef) {}
  unregisterControlsUnderPath(prefix) {}

  setActiveForm(instanceKey) {
    // 1. Persist current registered controls' values into storedStates
    // 2. Clear registeredControls
    // 3. Set activeInstanceKey
  }

  restoreActiveForm() {
    // Push stored values onto registered controls by path (case-insensitive match)
  }

  getValue(path)          {}
  setValue(path, value)   {}   // fires controlValueChanged event
  setValueSilently(path, value) {}  // no event
  getAllValues()          {}   // returns copy of all stored values for active form
  setAllValues(dict)      {}

  getRepeatingInstanceCount(basePath) {}
  setRepeatingInstanceCount(basePath, count) {}

  getRadioSelections()              {}
  setRadioSelections(dict)          {}
  setRadioSelection(path, branch)   {}

  purgeValuesUnderPathPrefix(prefix) {}  // removes all keys starting with prefix

  get isDirty()   {}
  setDirty(val)   {}

  getAllFormStates()        {}   // returns copy of all storedStates
  getFormState(instanceKey) {}
  restoreFormState(instanceKey, state) {}
  purgeFormState(instanceKey) {}

  // Event
  // controlValueChanged: CustomEvent with detail { path }
}
```

**Critical rules:**
- `setActiveForm` MUST persist the current state before clearing `registeredControls`.
- All path lookups are case-insensitive. Normalize keys by calling `.toLowerCase()` before Map operations.
- `RadioGroup` controls are NOT registered as form controls. Their selections are tracked separately in `radioSelections`.

---

## 7. Form Rendering

**File:** `js/ui/formRenderer.js`

Takes a `SchemaElement` and produces a DOM subtree. Attaches all controls to the Form Engine.

### Entry Point

```js
function renderForm(schemaElement, formEngine, depth = 0) → HTMLElement
```

### Dispatch

```js
switch (element.kind) {
  case 'GroupContainer':   return buildGroupContainer(element, depth);
  case 'SequenceContainer': return buildSequenceContainer(element, depth);
  case 'RadioGroup':       return buildRadioGroup(element, depth);
  default:
    if (element.isRepeating) return buildRepeatingSection(element, depth);
    return buildLeafControl(element, depth);
}
```

### Container Rendering

**GroupContainer:** Renders a `<fieldset>` with a `<legend>` containing `resolvedLabel`. Background color interpolates based on depth (see §12 Theming). Recursively renders children.

**SequenceContainer:** Same as GroupContainer but wraps a `<div class="sequence-container">`. If `isRepeating`, renders as a repeating section (see below).

**Repeating Section:** Renders a `<div class="repeating-section">` containing:
- An `<h4>` label
- A container `<div id="instances-{path}">` for instance children
- An "Add {label}" button and per-instance "Remove" buttons
- Instance count is tracked in FormEngine

On add: create a new instance div, re-run `renderForm` for the element with an index appended to the path, call `rewriteInstancePaths`, register all child controls.

On remove: `purgeValuesUnderPathPrefix(instancePath)` BEFORE removing the DOM element. Record undo action.

**RadioGroup:** Renders a `<div class="radio-group">` containing:
- A `<label>` header for the choice name
- For each option: a `<label><input type="radio">` and a content div (initially `display:none`)
- Selecting a radio button shows that branch's content div and hides others
- Values in hidden branches are preserved in FormEngine; only the selected branch is shown

Optional radio groups show a "Clear selection" button that sets the radio selection to null.

### Leaf Control Rendering

```js
function buildLeafControl(element, depth) {
  const wrapper = document.createElement('div');
  wrapper.classList.add('field-wrapper');
  wrapper.dataset.path = element.elementPath;

  const label = document.createElement('label');
  label.textContent = element.resolvedLabel;
  if (element.isRequired) label.classList.add('required');

  const colorBorder = document.createElement('div');
  colorBorder.classList.add('color-border');   // 2px left border for R/G/Y

  const input = controlFactory.create(element);
  input.addEventListener('change', () => {
    formEngine.setValue(element.elementPath, getControlValue(input, element));
  });

  wrapper.append(label, colorBorder, input);
  if (element.documentation) {
    const tooltip = document.createElement('span');
    tooltip.classList.add('tooltip');
    tooltip.textContent = element.documentation;
    wrapper.append(tooltip);
  }
  if (element.lineNumber) {
    const ln = document.createElement('span');
    ln.classList.add('line-number');
    ln.textContent = element.lineNumber;
    wrapper.append(ln);
  }

  formEngine.registerControl(element.elementPath, {
    getValue: () => getControlValue(input, element),
    setValue: (v) => setControlValue(input, element, v),
    validate: () => validateControl(input, element),
    setColorState: (state) => applyColorBorder(colorBorder, state),
    elementPath: element.elementPath
  });

  return wrapper;
}
```

### Control Factory

**File:** `js/ui/controlFactory.js`

```js
function create(element) {
  switch (element.kind) {
    case 'TextInput':    return createTextInput(element);
    case 'NumericInput': return createNumberInput(element);
    case 'DecimalInput': return createDecimalInput(element);
    case 'DatePicker':   return createDateInput(element);
    case 'Checkbox':     return createCheckbox(element);
    case 'Dropdown':     return createSelect(element);
  }
}
```

- `TextInput`: `<input type="text">` with `maxlength` from ValidationRules if present
- `NumericInput`: `<input type="number" step="1">`
- `DecimalInput`: `<input type="number" step="any">`
- `DatePicker`: `<input type="date">` (for `xs:date`) or `<input type="datetime-local">` (for `xs:dateTime`)
- `Checkbox`: `<input type="checkbox">`
- `Dropdown`: `<select>` with an empty first `<option>` + one `<option>` per `EnumerationOption`

### Path Rewriting

After rendering a repeating instance at index `i`, walk all `data-path` attributes within it and replace the base path segment with the indexed version:

```
"SomeList.Field" → "SomeList[0].Field"
```

Use a regex: `/(\w+)(\.)` → check if the segment is the repeating base, then append `[i]`.

This must process parents before children in DOM order.

### Inflation (Restore from FormState)

When switching to a form that has stored state with repeating instances, inflate the DOM to match the stored counts before calling `restoreActiveForm`:

```
for each (basePath, count) in storedState.repeatingInstanceCounts:
  while currentDomInstanceCount(basePath) < count:
    addInstance(basePath)
```

This is a fixed-point loop (cap 20 passes) because adding outer instances may reveal inner repeating sections.

---

## 8. Path Conventions

- Separator: `.` (dot)
- Repeating index: `BaseName[0]`, `BaseName[1]`, etc.
- Synthetic segments ARE included: `N11Choice`, `N11ChoiceOption1`, `SomeListEntry`
- All lookups are case-insensitive
- `RadioGroup` path = the generated `{Parent}Choice` element's path
- The selected branch path prefix stored in `radioSelections` is the **bare** (non-indexed) path used at schema parse time. When looking up which branch is selected for a runtime-indexed radio group, strip the instance index from the runtime path to compare against the bare stored path.

---

## 9. Coloring Service

**File:** `js/core/coloringService.js`

Computes `FieldColorState` for every registered field based on completeness and validity rules.

### Color Rules

```
computeColor(element, value, allValues, radioSelections):
  if (!element.isRequired and isEmpty(value)):
    return null   // no color for untouched optional leaf
  if (!element.isRequired and hasValue(value)):
    if isValid(element, value): return 'Yellow'   // optional + filled
    else: return 'Red'
  if (element.isRequired):
    if isEmpty(value): return 'Red'
    if !isValid(element, value): return 'Red'
    return 'Green'
```

### Container Coloring

```
computeContainerColor(containerElement, allValues, radioSelections):
  if (containerElement.isRequired):
    if all required-context children are Green: return 'Green'
    if any child is Red: return 'Red'
    return 'Yellow'
  else (optional container):
    childColors = computeChildColors(...)
    if childColors is empty (no values at all): return null
    if all children are Green: return 'Green'   // strict: ALL must be complete
    if any child is Red: return 'Red'
    return 'Yellow'
```

**Radio branch coloring:** Only evaluate the selected branch. Hidden branches are ignored.

**Optional child poisoning:** An optional container whose children have been activated (any values entered) counts toward parent completeness. An incomplete optional child poisons the required parent to Yellow/Red.

### Coloring Index

Build a flat `Map<path, controlRef>` after each form render (`rebuildColorableIndex()`). On value change, recompute all colors in O(n) by walking the index rather than the DOM tree.

**Debounce:** On rapid value changes (typing), debounce the recompute by 50ms using `setTimeout`/`clearTimeout`.

### Applying Color to DOM

```js
function applyColorBorder(colorBorderEl, state) {
  colorBorderEl.className = 'color-border';
  if (state === 'Red')    colorBorderEl.classList.add('color-red');
  if (state === 'Green')  colorBorderEl.classList.add('color-green');
  if (state === 'Yellow') colorBorderEl.classList.add('color-yellow');
}
```

CSS:
```css
.color-border { width: 3px; min-height: 100%; flex-shrink: 0; border-radius: 2px; }
.color-border.color-red    { background: var(--coloring-incomplete); }
.color-border.color-green  { background: var(--coloring-complete); }
.color-border.color-yellow { background: var(--coloring-optional); }
```

---

## 10. XML Writing

**File:** `js/core/xmlWriter.js`

Produces a well-formed XML string from all FormState data.

### Algorithm

```js
function buildPacketXml(manifest, allFormStates, orderedInstanceKeys):
  root = createElement(manifest.packetName)
  for each instanceKey in orderedInstanceKeys:
    state = allFormStates.get(instanceKey.toString())
    schemaElement = parser.parseGlobalElement(instanceKey.formName)
    buildNodes(root, schemaElement, state)
  return serializeToString(root)

function buildNodes(parentEl, schemaElement, state, path = ''):
  if (isTransparent(schemaElement)):
    if (schemaElement.kind === 'RadioGroup'):
      buildChoiceNodes(parentEl, schemaElement, state, path)
    else:
      for each child in schemaElement.children:
        buildNodes(parentEl, child, state, path)
    return

  if (schemaElement.isRepeating):
    count = state.repeatingInstanceCounts[schemaElement.elementName] ?? 1
    for i in 0..count-1:
      el = createElement(schemaElement.elementName)
      for each child in schemaElement.children:
        buildNodes(el, child, state, path + '[' + i + ']')
      parentEl.appendChild(el)
    return

  value = state.fieldValues[path + '.' + schemaElement.elementName]  // case-insensitive
  if (isLeaf(schemaElement)):
    if (isEmpty(value) and !schemaElement.isRequired): return  // omit optional empty
    el = createElement(schemaElement.elementName)
    if (!isEmpty(value)): el.textContent = formatValue(value, schemaElement)
    parentEl.appendChild(el)
    return

  // Container
  el = createElement(schemaElement.elementName)
  for each child in schemaElement.children:
    buildNodes(el, child, state, path + '.' + schemaElement.elementName)
  if (el.children.length > 0 || schemaElement.isRequired):
    parentEl.appendChild(el)
```

### Choice (Radio) Branch Writing

```js
function buildChoiceNodes(parentEl, choiceElement, state, path):
  choicePath = path + '.' + choiceElement.elementName
  selectedBranch = state.radioSelections[choicePath]
  if (!selectedBranch):
    // Fallback: find first option that has any data
    for each option in choiceElement.children:
      if hasDataUnder(option.elementPath, state.fieldValues):
        selectedBranch = option.elementPath
        break
  if (!selectedBranch): return
  selectedOption = choiceElement.children.find(c => pathsMatch(c.elementPath, selectedBranch))
  if (!selectedOption): return
  for each child in selectedOption.children:
    buildNodes(parentEl, child, state, path)
```

### Value Formatting

- `Checkbox`: `true` → `"true"`, `false` → `"false"`
- `DatePicker`: emit as-is (browser date inputs use ISO format `YYYY-MM-DD`)
- Others: `String(value).trim()`

---

## 11. XML Reading

**File:** `js/core/xmlReader.js`

Parses an XML file back into FormState for all forms.

### Algorithm

```js
function readPacket(xmlString, manifest, schemaParser):
  doc = new DOMParser().parseFromString(xmlString, 'application/xml')
  result = new Map()  // instanceKey.toString() → FormState

  for each section in manifest.sections:
    elements = doc.querySelectorAll(section.elementName)  // handles repeating
    for (i, el) of elements.entries():
      instanceId = el.getAttribute('documentId') || el.getAttribute('id') || generateUUID()
      key = new FormInstanceKey(section.elementName, section.isRepeatable ? instanceId : section.elementName)
      schemaElement = schemaParser.parseGlobalElement(section.elementName)
      state = extractFormState(el, schemaElement, '')
      result.set(key.toString(), state)

  return result

function extractFormState(xmlEl, schemaElement, path):
  state = { fieldValues: {}, repeatingInstanceCounts: {}, radioSelections: {}, isDirty: false }
  walkElement(xmlEl, schemaElement, path, state)
  return state

function walkElement(xmlEl, schemaElement, path, state):
  if (isTransparent(schemaElement)):
    // For choice: determine which branch's children are present in XML
    if (schemaElement.kind === 'RadioGroup'):
      for each option of schemaElement.children:
        for each child of option.children:
          xmlChild = xmlEl.querySelector(child.elementName)
          if (xmlChild):
            state.radioSelections[path + '.' + schemaElement.elementName] = option.elementPath
            walkElement(xmlEl, option, path, state)  // recurse into that branch
            break
    else:
      for each child of schemaElement.children:
        walkElement(xmlEl, child, path, state)
    return

  if (schemaElement.isRepeating):
    instances = xmlEl.querySelectorAll(':scope > ' + schemaElement.elementName)
    state.repeatingInstanceCounts[schemaElement.elementName] = instances.length
    for (i, inst) of instances.entries():
      for each child of schemaElement.children:
        walkElement(inst, child, path + '[' + i + ']', state)
    return

  if (isLeaf(schemaElement)):
    childEl = xmlEl.querySelector(':scope > ' + schemaElement.elementName)
    if (childEl):
      key = (path + '.' + schemaElement.elementName).replace(/^\./, '')
      state.fieldValues[key.toLowerCase()] = parseValue(childEl.textContent, schemaElement)
    else:
      // Track as unmatched if it appeared in XML but not in schema
    return

  childEl = xmlEl.querySelector(':scope > ' + schemaElement.elementName)
  if (childEl):
    for each child of schemaElement.children:
      walkElement(childEl, child, path + '.' + schemaElement.elementName, state)
```

### Unmatched Fields

During reading, collect any XML element text content that could not be matched to a schema path. Report these to the user after load via a modal or panel.

---

## 12. Theming

**File:** `js/ui/theme.js`

Themes are JSON files (`.theme.json`) loaded via `<input type="file">` or a built-in theme selector.

### Theme JSON Format

```json
{
  "name": "Default",
  "colors": {
    "windowBackground":    "#F5F5F5",
    "panelBackground":     "#FFFFFF",
    "controlBackground":   "#FFFFFF",
    "controlBorder":       "#DDDDDD",
    "primaryText":         "#333333",
    "secondaryText":       "#666666",
    "accentColor":         "#3A7BD5",
    "buttonBackground":    "#FFFFFF",
    "buttonText":          "#333333",
    "selectionBackground": "#3A7BD5",
    "selectionText":       "#FFFFFF",
    "coloringIncomplete":  "#D32F2F",
    "coloringComplete":    "#2E7D32",
    "coloringOptional":    "#F9A825",
    "lineNumberText":      "#888888",
    "addButtonBackground": "#4A8C6F",
    "removeButtonBackground": "#A34A5A"
  }
}
```

The 11 required tokens are the first 11. The rest are optional; if absent, defaults are used.

### Applying a Theme

All UI colors are CSS custom properties (variables). Applying a theme means writing to `:root`:

```js
function applyTheme(theme) {
  const root = document.documentElement;
  const defaults = getDefaultColors();
  const colors = Object.assign({}, defaults, theme.colors);
  for (const [key, value] of Object.entries(colors)) {
    root.style.setProperty('--' + camelToKebab(key), value);
  }
  // Derive 5 depth-level background colors (interpolate between panelBackground and windowBackground)
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    root.style.setProperty('--depth-color-' + i, interpolateColor(colors.panelBackground, colors.windowBackground, t));
  }
  saveThemePreference(theme.name);
}
```

### CSS Variable Usage

All CSS in `main.css` references only variables:

```css
body             { background: var(--window-background); color: var(--primary-text); }
.toolbar         { background: var(--panel-background); border-bottom: 1px solid var(--control-border); }
.sidebar         { background: var(--panel-background); border-right: 1px solid var(--control-border); }
input, select    { background: var(--control-background); border-color: var(--control-border); color: var(--primary-text); }
button           { background: var(--button-background); color: var(--button-text); }
button:hover     { filter: brightness(0.95); }
.depth-0         { background: var(--depth-color-0); }
.depth-1         { background: var(--depth-color-1); }
/* ... */
fieldset legend  { color: var(--primary-text); font-weight: bold; }
.line-number     { color: var(--line-number-text); font-family: monospace; }
.add-btn         { background: var(--add-button-background); color: white; }
.remove-btn      { background: var(--remove-button-background); color: white; }
```

### Settings Persistence

Use `localStorage` to persist:
- `xmlEditor.activeTheme` — theme name
- `xmlEditor.lastSchema` — last-used schema folder name (informational only; can't re-open automatically due to browser security)
- `xmlEditor.lastPackagingSettings` — last-used packaging dialog values (JSON)
- `xmlEditor.fieldSizeOverrides` — field sizing overrides (JSON)

---

## 13. Page Layout

```
┌─────────────────────────────────────────────────────────────┐
│  TOOLBAR                                                    │
│  [File ▾] [Fill ▾] | [Validate] | [↶] [↷] | [Clear] |     │
│  [Layout] | [Theme ▾]                    [status text]      │
├──────────────┬──────────────────────────────────────────────┤
│  SIDEBAR     │  FORM AREA                                   │
│  ┌─────────┐ │  ┌────────────────────────────────────────┐ │
│  │ Forms   │ │  │                                        │ │
│  │ + Add   │ │  │  (form content scrolls here)           │ │
│  ├─────────┤ │  │                                        │ │
│  │ Form A  │ │  └────────────────────────────────────────┘ │
│  │ Form B  │ │                                              │
│  │ Form C ▸│ │                                              │
│  └─────────┘ │                                              │
├──────────────┴──────────────────────────────────────────────┤
│  VALIDATION PANEL (collapsed by default)                    │
├─────────────────────────────────────────────────────────────┤
│  STATUS BAR    [Zoom: 100%]                 [Not saved]     │
└─────────────────────────────────────────────────────────────┘
```

### HTML Structure

```html
<body>
  <div id="app">
    <div id="toolbar">...</div>
    <div id="main-content">
      <div id="sidebar">
        <div id="sidebar-header">
          <span>Forms</span>
          <button id="add-form-btn">+ Add</button>
        </div>
        <div id="current-root-label"></div>
        <ul id="nav-tree"></ul>
      </div>
      <div id="splitter"></div>
      <div id="form-area">
        <div id="form-content-host">
          <!-- Initial state: load schema button -->
          <div id="load-schema-prompt">
            <button id="load-schema-btn">Load Schema Folder</button>
            <p>Select a folder containing XSD files to begin.</p>
          </div>
        </div>
      </div>
    </div>
    <div id="validation-panel" class="collapsed">
      <div id="validation-header">
        <span id="validation-summary"></span>
        <button id="close-validation-btn">✕</button>
      </div>
      <ul id="validation-error-list"></ul>
    </div>
    <div id="status-bar">
      <span id="zoom-indicator">100%</span>
      <span id="save-status">Not saved</span>
    </div>
    <div id="loading-overlay" class="hidden">
      <div id="loading-spinner"></div>
      <span id="loading-text">Loading...</span>
    </div>
    <div id="search-panel" class="hidden">...</div>
    <div id="debug-panel" class="hidden">...</div>
  </div>
</body>
```

### Toolbar HTML

```html
<div id="toolbar">
  <div class="toolbar-group">
    <div class="dropdown-menu">
      <button class="menu-btn">File ▾</button>
      <div class="dropdown-content">
        <button id="load-schema-menu-btn">Load Schema Folder</button>
        <button id="switch-root-btn" disabled>Switch Root</button>
        <hr>
        <button id="save-xml-btn" disabled>Save XML</button>
        <button id="load-xml-btn">Load XML</button>
        <hr>
        <button id="create-package-btn" disabled>Create Submission Package</button>
      </div>
    </div>
    <div class="dropdown-menu">
      <button class="menu-btn">Fill Test Data ▾</button>
      <div class="dropdown-content">
        <button id="fill-all-btn" disabled>Fill All Fields</button>
        <button id="fill-required-btn" disabled>Fill Required Fields Only</button>
      </div>
    </div>
  </div>
  <div class="toolbar-separator"></div>
  <div class="toolbar-group">
    <button id="validate-btn" disabled>Validate</button>
  </div>
  <div class="toolbar-separator"></div>
  <div class="toolbar-group">
    <button id="undo-btn" disabled>↶ Undo</button>
    <button id="redo-btn" disabled>↷ Redo</button>
  </div>
  <div class="toolbar-separator"></div>
  <div class="toolbar-group">
    <button id="clear-all-btn" disabled>Clear All</button>
  </div>
  <div class="toolbar-separator"></div>
  <div class="toolbar-group">
    <button id="layout-toggle-btn">Layout: Wrap</button>
  </div>
  <div class="toolbar-separator"></div>
  <div class="toolbar-group">
    <label>Theme:</label>
    <select id="theme-select"></select>
    <button id="load-theme-btn">Load Theme File</button>
  </div>
  <span id="top-status" class="toolbar-status">Ready</span>
</div>
```

### Resizable Sidebar Splitter

Implement with `mousedown`/`mousemove`/`mouseup` on `#splitter`. Store sidebar width in `localStorage`.

### Zoom

Implement via `transform: scale(N)` on `#form-content-host`. Ctrl+Plus, Ctrl+Minus, Ctrl+0. Also Ctrl+Wheel. Display current percentage in `#zoom-indicator`. Range: 50%–200%.

---

## 14. Undo / Redo System

**File:** `js/core/undoService.js`

Command pattern. Each user action produces an action object with `undo()` and `redo()` methods. Two bounded arrays act as stacks (max 50 entries each).

```js
class UndoService {
  constructor() {
    this._undoStack = [];
    this._redoStack = [];
    this._isReplaying = false;
    this._maxSize = 50;
  }

  get isReplaying() { return this._isReplaying; }

  recordAction(action) {
    if (this._isReplaying) return;
    this._undoStack.push(action);
    if (this._undoStack.length > this._maxSize)
      this._undoStack.shift();
    this._redoStack = [];
    this._notifyChanged();
  }

  undo(ctx) {
    if (!this._undoStack.length) return;
    this._isReplaying = true;
    try {
      const action = this._undoStack.pop();
      action.undo(ctx);
      this._redoStack.push(action);
    } finally {
      this._isReplaying = false;
      this._notifyChanged();
    }
  }

  redo(ctx) { /* mirror of undo */ }
  clearHistory() { this._undoStack = []; this._redoStack = []; this._notifyChanged(); }

  suppressRecording() {
    // Returns a disposable that sets/restores _isReplaying
    // Use with try/finally
  }
}
```

### Action Objects

**FieldValueChangeAction**
- Trigger: `blur` event on text/number/date inputs; `change` on checkbox/select (immediate)
- Records: `{ instanceKey, path, oldValue, newValue, oldDirty, newDirty }`
- For text inputs: stash value on `focus`, compare on `blur`, skip if unchanged

**RadioBranchSwapAction**
- Trigger: `change` on radio `<input>` elements
- Records: `{ instanceKey, radioGroupPath, oldBranch, newBranch, oldDirty, newDirty }`
- Required groups skip the initial auto-selection (not undoable)
- Store previous branch on `mousedown` / just before change fires

**RepeatingInstanceAddAction**
- Trigger: "Add" button click
- Records: `{ instanceKey, elementPathBase, addedIndex, oldDirty, newDirty }`

**RepeatingInstanceRemoveAction**
- Trigger: "Remove" button click
- Records: snapshot of all field values, repeating counts, and radio selections under the instance path, captured BEFORE `purgeValuesUnderPathPrefix` is called
- `{ instanceKey, elementPathBase, removedIndex, fieldValueSnapshot, nestedRepeatingCounts, radioBranchSelections, oldDirty, newDirty }`

**FillTestDataAction**
- Records: pre/post snapshots of all field values, repeating counts, radio selections for the active form

**ClearAllAction**
- Records: pre-clear snapshot of field values and radio selections

**ContainerFillAction**
- Records: pre/post snapshots scoped to the container path prefix
- On undo/redo: reconcile repeating counts within scope, then restore scoped values and radio selections (merge pattern: remove scoped keys, add target scoped keys)

**ContainerClearAction**
- Records: pre-clear snapshot of values and radio selections scoped to container path

**FormAddAction**
- Records: `{ instanceKey, priorInstanceKey, insertPosition, oldDirty, newDirty }`
- `insertPosition`: `{ parentFormName, childIndex }` — where in the sidebar nav tree the item was added

**FormRemoveAction**
- Records: `{ instanceKey, stateSnapshot, originalPosition, wasActive, postRemovalActiveKey, oldDirty, newDirty }`
- `stateSnapshot` is a deep clone of the FormState at time of removal

### Critical Invariant

All recording sites MUST check `undoService.isReplaying` and skip recording when true. This prevents replay actions from being recorded onto the undo stack.

Stack is cleared on: schema load, root switch, XML load. Form add/remove are undoable and do NOT clear the stack.

---

## 15. Search

**File:** `js/core/searchService.js`, `js/ui/search.js`

### Search Service

```js
class SearchService {
  search(query, allForms, options):
    // options: { caseSensitive, searchInDocs, lineNumberMode }
    results = []
    for each form in allForms:
      schemaElement = parser.parseGlobalElement(form)
      walkForSearch(schemaElement, query, options, results)
    return results  // SearchResult[]

  walkForSearch(element, query, options, results):
    text = options.searchInDocs ? element.documentation : element.resolvedLabel
    lineNum = element.lineNumber
    match = options.lineNumberMode
      ? lineNum === query
      : matchesQuery(text, query, options.caseSensitive)
    if (match):
      results.push({ formName, elementPath, label, lineNumber, documentation })
    for each child: walkForSearch(child, ...)
}
```

### Search UI

A slide-in panel (Ctrl+F):
- Text input
- Checkboxes: Case sensitive, Include documentation, Line number mode
- Result list: click to navigate to that form and highlight the field

**Highlight:** Add class `search-highlight` to the matching `.field-wrapper`. On navigation, scroll the element into view (`el.scrollIntoView({ behavior: 'smooth', block: 'center' })`).

**Cross-form:** Clicking a result from a different form calls `switchToForm(formName)` first, then highlights after the form renders.

---

## 16. Validation

**File:** `js/ui/validation.js`

### Field-Level Validation

On `blur` (or immediately for select/checkbox), run the field's validation rules:

```js
function validateField(value, element) {
  if (!value && !element.isRequired) return { valid: true };
  for (const rule of element.validationRules) {
    switch (rule.kind) {
      case 'minLength': if (String(value).length < +rule.value) return { valid: false, message: `Min length: ${rule.value}` };
      case 'maxLength': if (String(value).length > +rule.value) return { valid: false, message: `Max length: ${rule.value}` };
      case 'pattern':   if (!new RegExp('^' + rule.value + '$').test(String(value))) return { valid: false, message: patternDescriber.describe(rule.value) };
      case 'minInclusive': if (+value < +rule.value) return { valid: false, message: `Min value: ${rule.value}` };
      case 'maxInclusive': if (+value > +rule.value) return { valid: false, message: `Max value: ${rule.value}` };
    }
  }
  return { valid: true };
}
```

Show error text below the input. Set the input's border to `var(--coloring-incomplete)`.

### Schema Validation (XSD)

The browser cannot use a native XSD validator. Implement a JavaScript XSD validator against the flat schema or use the field-level validation rules already extracted. For format errors (date, number) use `isNaN()` / `Date.parse()`.

Optionally, use a library like `libxmljs` (via WASM) or `xsd-schema-validator` if a dependency is acceptable. If staying fully vanilla, rely entirely on the extracted `ValidationRules`.

### Validation Panel

When "Validate" is clicked, collect all validation errors across all forms:
1. For each form: get all stored field values, run `validateField` on each, collect errors with path and message.
2. Also check completeness: any required field with an empty value is a completeness error (not a format error).
3. Show results in `#validation-panel` (expand it). Each error is clickable: navigates to the form and highlights the field.

### Validator Path Translation

When displaying validation errors, paths in raw XML validator output contain element names without synthetic segments. Translate them by walking the schema tree and injecting `Choice`, `OptionN`, `Entry` segments to produce the control path used in the Form Engine.

---

## 17. Test Data Fill

**File:** `js/core/testDataFiller.js`

Generates valid sample values for all fields in a `SchemaElement` tree.

### Algorithm

```js
function generateValues(element, options = {}) {
  // options: { requiredOnly: false, filter: null, instanceCounts: {}, radioSelections: {} }
  const values = {};
  const chosenSelections = {};
  walkElement(element, '', values, chosenSelections, options, null);
  return { values, radioSelections: chosenSelections };
}
```

### Per-Kind Value Generation

- `TextInput`: Generate a value based on the element name (e.g., name-containing elements get "TESTNAME", address gets "123 TEST ST"). If a `pattern` ValidationRule exists, generate a matching string.
- `NumericInput`: Use `minInclusive` as base if present, else `1`.
- `DecimalInput`: Use `minInclusive` or `0.00`.
- `DatePicker`: Use a fixed recent date (e.g., `"2024-01-01"`).
- `Checkbox`: `true`.
- `Dropdown`: Pick the first `EnumerationOption.value`.

### Pattern-Based Generation (RegexSampleGenerator)

For fields with `pattern` ValidationRules, generate a minimal matching string:

```
- Literal characters: emit as-is
- [a-z]: pick first in range
- \d: emit "0"
- {n}: repeat n times
- {n,m}: repeat n times
- ?: skip (treat as 0 occurrences)
- |: pick first alternative
- (.): recurse
```

This does not need to be a full regex engine — just enough to produce a valid sample for common XSD patterns.

### Scoped Fill (Container Context Menu)

Right-clicking a `GroupContainer` or `SequenceContainer` header shows a context menu:
- "Fill All Fields in This Section"
- "Fill Required Fields Only in This Section"
- "Clear This Section"

These call `generateValues` with `parentPath` set to the container's path and an optional `filter: el => el.isRequired`.

Only empty fields are filled (merge against existing values).

---

## 18. Context Menu

**File:** `js/ui/contextMenu.js`

Use a custom `<div id="context-menu">` that appears on `contextmenu` events on container headers.

```js
document.addEventListener('contextmenu', (e) => {
  const containerHeader = e.target.closest('[data-container-path]');
  if (!containerHeader) return;
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY, containerHeader.dataset.containerPath, containerHeader.dataset.schemaPath);
});

document.addEventListener('click', () => hideContextMenu());
```

Dismiss on outside click. Position the menu so it doesn't overflow the viewport.

---

## 19. Packaging (MeF Submission ZIP)

**File:** `js/core/packager.js`

Uses the [JSZip](https://stuk.github.io/jszip/) library (the one acceptable external dependency given the complexity of ZIP creation; alternatively use the browser's `CompressionStream` API for a native approach).

### Workflow

1. User clicks "Create Submission Package" (enabled only when schema loaded and form has data)
2. Show a modal dialog collecting:
   - SubmissionId (20 chars: 13 digits + 7 alphanumeric)
   - EFIN (6 digits)
   - Tax Year (4 digits)
   - Government Code (4 chars)
   - Submission Type (e.g. "HIN11")
   - Category (Individual / Business)
   - Primary SSN / Name Control (Individual) OR EIN / Business Name Control (Business)
   - Spouse SSN / Name Control (optional)
   - IRS Submission ID (optional)
   - State attachment files (0–50, via `<input type="file" multiple>`)
   - Federal return XML (optional, single file)
   - Federal attachment files (0–50)
3. Validate all required fields
4. Show validation warnings (option to continue or cancel)
5. Prompt for save location via `showSaveFilePicker` (or generate a download via `URL.createObjectURL`)
6. Build the ZIP:
   ```
   [SubmissionId].zip
   ├── manifest.xml
   ├── [PacketName].xml          (the Packet_XML)
   ├── [attachment1.pdf]
   ├── [attachment2.pdf]
   ├── federal/
   │   ├── federal_return.xml
   │   └── [fed_attachment.pdf]
   ```
7. Trigger download

### Manifest XML

Generate an IRS-formatted manifest XML. The exact structure follows the MeF StateManifest schema. Key elements:

```xml
<StateManifest>
  <SubmissionId>[20-char id]</SubmissionId>
  <EFIN>[6-digit EFIN]</EFIN>
  <TaxYear>[4-digit year]</TaxYear>
  <GovernmentCd>[4-char code]</GovernmentCd>
  <StateSubmissionTyp>[type]</StateSubmissionTyp>
  <SubmissionCategoryCd>[IND|BUS]</SubmissionCategoryCd>
  <!-- For IND: -->
  <PrimarySSN>[9 digits]</PrimarySSN>
  <PrimaryNameControlTxt>[4 chars]</PrimaryNameControlTxt>
  <!-- Optional spouse: -->
  <SpouseSSN>...</SpouseSSN>
  <SpouseNameControlTxt>...</SpouseNameControlTxt>
  <!-- For BUS: -->
  <EIN>[9 digits]</EIN>
  <BusinessNameControlTxt>[4 chars]</BusinessNameControlTxt>
  <!-- Optional: -->
  <IRSSubmissionId>[20 chars]</IRSSubmissionId>
</StateManifest>
```

Persist last-used dialog values to `localStorage.xmlEditor.lastPackagingSettings`.

---

## 20. Application Bootstrap

**File:** `js/ui/app.js`

```js
// 1. Load settings from localStorage
// 2. Apply saved theme (or default)
// 3. Wire all toolbar button click handlers
// 4. Wire keyboard shortcuts (Ctrl+Z, Ctrl+Y, Ctrl+F, Ctrl+Shift+V, Ctrl+0/+/-, Ctrl+Wheel)
// 5. Wire file input handlers
// 6. Render initial "Load Schema" prompt in form area
// 7. Expose global app state object for inter-module communication

const appState = {
  manifest: null,
  currentInstanceKey: null,
  flatDoc: null,
  schemaParser: null,
  formEngine: new FormEngine(),
  undoService: new UndoService(),
  // ...
};
```

### Schema Load Flow

```
1. User clicks "Load Schema Folder"
2. Browser shows folder picker (showDirectoryPicker or <input webkitdirectory>)
3. Read all .xsd files as text → Map<filename, text>
4. Scan for BOM/ZWNBSP → show BomCleanupModal if found → optionally strip
5. Detect root XSD files (those not referenced by any other XSD in the set,
   or the one with a reference to the top-level packet element)
6. If multiple roots detected, show a "Choose Root" modal
7. flatDoc = flattener.flattenFromRoot(files, rootFileName)
8. parser = new SchemaParser(flatDoc)
9. manifest = analyzePacket(flatDoc, rootElementName)
10. undoService.clearHistory()
11. formEngine.reset()
12. buildNavTree(manifest)
13. Enable toolbar buttons
14. Switch to first form
```

### Form Switch Flow

```
switchToForm(instanceKey):
1. captureRadioSelectionsIntoFormEngine()
2. formEngine.setActiveForm(instanceKey)
3. schemaElement = parser.parseGlobalElement(instanceKey.formName)
4. formEl = formRenderer.renderForm(schemaElement, formEngine)
5. inflateRepeatingSections(formEl, formEngine.getFormState(instanceKey))
6. document.getElementById('form-content-host').innerHTML = ''
7. document.getElementById('form-content-host').appendChild(formEl)
8. formEngine.restoreActiveForm()
9. selectRadioGroupBranches(formEl, formEngine.getFormState(instanceKey))  ← fixed-point loop
10. wireUndoTracking(formEl)
11. wireContextMenus(formEl)
12. rebuildColorableIndex(formEl)
13. applyAllColors()
14. refreshSearchContext()
15. updateNavTreeActiveState(instanceKey)
16. closeValidationPanel()
```

### Radio Selection (Fixed-Point Loop)

```js
function selectRadioGroupBranches(rootEl, formState) {
  const normalisedKeys = buildNormalisedKeySet(formState.fieldValues);
  let changed = true;
  let passes = 0;
  while (changed && passes < 10) {
    changed = selectRadioGroupBranchesPass(rootEl, formState, normalisedKeys);
    if (changed) {
      // Force layout recalculation so newly visible branches are queryable
      // In the browser, just querying display:none elements is sufficient;
      // no layout flush needed. Set display:block THEN query children.
    }
    passes++;
  }
}

function selectRadioGroupBranchesPass(rootEl, formState, normalisedKeys) {
  let anyChanged = false;
  rootEl.querySelectorAll('.radio-group').forEach(rgEl => {
    const choicePath = rgEl.dataset.choicePath;
    if (rgEl.dataset.selectedBranch) return;  // already selected in prior pass
    const storedBranch = formState.radioSelections[choicePath];
    if (storedBranch) {
      selectBranch(rgEl, storedBranch);
      anyChanged = true;
    } else {
      // Optional group: check if any branch has data keys
      // If none, leave unselected
    }
  });
  return anyChanged;
}
```

---

## 21. Debug Panel

**File:** `js/ui/debug.js`

Toggled by Ctrl+Shift+D. A resizable panel on the right side of the screen (use CSS flexbox, collapsible via `display:none`).

Tabs:
- **Fields** — table of all registered controls: Path | Kind | Required | Value
- **Schema Tree** — collapsible tree view of the parsed SchemaElement tree for the active form; click a node to see full details
- **State** — repeating counts, radio selections, stored forms list
- **Export** — "Copy TSV" button, "Export JSON" button (download `debug-state.json`)

Refresh: debounce 200ms on `formEngine.controlValueChanged`. No-op when panel is hidden.

---

## 22. Known Behavioral Rules and Invariants

These rules are critical for correctness. Violating them produces incorrect XML or broken state.

1. **Transparent nodes never emit XML tags.** Generated wrappers (`isGeneratedWrapper=true`), `RadioGroup`, and `SequenceContainer` skip their own tag and emit only their children's tags.

2. **Radio group controls are not form controls.** They are not registered in FormEngine. Their state lives in `radioSelections`, not `fieldValues`.

3. **Form switch clears registered controls.** `setActiveForm` persists current values first, then clears the registration map. This is required because the DOM is replaced on every form switch.

4. **IsValid ≠ completeness.** A field is invalid if its value violates a format rule. A field is incomplete if it is required and empty. These are separate concerns.

5. **Validation collects both completeness errors and format errors.**

6. **Optional containers go Green only when ALL children are Green.** An optional container with any Yellow or Red child is itself Yellow or Red.

7. **Activated optional children poison required parents.** A required parent is not complete if it has an optional child with data that is itself incomplete.

8. **Line numbers are display-only.** Never included in generated XML.

9. **Branch swaps preserve values.** Hidden branch values remain in FormEngine. Only the selected branch is written to XML.

10. **Remove must purge orphaned state.** Call `purgeValuesUnderPathPrefix(instancePath)` BEFORE removing the DOM element for a repeating instance.

11. **Inflation fixed-point.** Restoring nested repeating sections requires multiple passes. Cap at 20.

12. **Coloring index.** Rebuild the path→controlRef index after every form render or structural change (add/remove instance). Do not rebuild on every value change — use the existing index.

13. **Undo IsReplaying guard.** Every event handler that records an undo action MUST check `undoService.isReplaying` first.

14. **Undo actions store no live DOM references.** Store paths, values, counts, and flags. Resolve controls by path at replay time.

15. **Remove snapshot timing.** Snapshot instance values BEFORE calling purgeValuesUnderPathPrefix. After purge the values are gone.

16. **Scoped radio merge pattern.** When restoring scoped radio selections: (1) get all current selections, (2) remove all keys whose path starts with the container prefix, (3) add back the target snapshot's scoped keys. Out-of-scope selections are never disturbed.

17. **XML writer prefers explicit radio selection.** Check `formState.radioSelections[choicePath]` first. Only fall back to "first branch with data" heuristic when no explicit selection exists (backward compat with old saved files).

18. **xs:import missing files are non-fatal.** Log a warning and skip. xs:include missing files are fatal (throw).

19. **Coloring debounce.** On rapid typing, debounce the full coloring recompute by 50ms. Format error highlighting on the input itself is immediate (no debounce).

20. **FormInstanceKey equality is case-insensitive** on both FormName and InstanceId.

21. **BOM scan runs before flatten.** Strip U+FEFF from all XSD text before parsing. XSD parsers fail in non-obvious ways on interior BOM characters.

22. **Context menu fill only fills empty fields.** Do not overwrite fields that already have a value.

23. **Undo stack cleared on schema load, root switch, XML load.** Form add/remove are undoable — they do NOT clear the stack.

---

## 23. File Structure Reference

```
index.html
css/
  main.css
js/
  core/
    flattener.js
    parser.js
    formEngine.js
    coloringService.js
    xmlWriter.js
    xmlReader.js
    searchService.js
    testDataFiller.js
    undoService.js
    packager.js
  ui/
    app.js
    toolbar.js
    sidebar.js
    formRenderer.js
    controlFactory.js
    coloring.js
    search.js
    validation.js
    undo.js
    contextMenu.js
    theme.js
    debug.js
themes/
  default.theme.json
  dark.theme.json
  high-contrast.theme.json
  ocean-blue.theme.json
```

All JS files use ES modules (`<script type="module">`). No transpiler or bundler required.

---

## 24. Browser Compatibility Notes

- **File System Access API** (`showDirectoryPicker`, `showSaveFilePicker`): Supported in Chrome/Edge 86+. For Firefox fallback, use `<input type="file" webkitdirectory>` for reading and `URL.createObjectURL` + `<a download>` for saving.
- **DOMParser / XMLSerializer**: Available in all modern browsers. Use for XSD parsing and XML serialization.
- **CSS Custom Properties**: Available in all modern browsers.
- **ES Modules**: Available in all modern browsers. No bundler needed.
- **localStorage**: Use for settings persistence. No server, no cookies needed.
- **Drag-and-drop folder**: As an alternative to `showDirectoryPicker`, support dragging a folder onto the drop zone. Use `DataTransferItem.webkitGetAsEntry()` to read directory contents recursively.
- **ZIP creation**: JSZip (MIT license) is the recommended library. It is the only external dependency. Alternatively, use the native `CompressionStream` API (Chrome 80+, Firefox 113+) with manual ZIP format construction — feasible but complex.
