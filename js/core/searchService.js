// js/core/searchService.js — Cross-form field text search.
//
// See web-implementation-spec.md §15 (Search — Search Service). Implemented in
// IMPLEMENTATION_PLAN.md Phase 6.1.
//
// Pure logic, no DOM dependencies. js/ui/search.js provides the panel UI.
//
// Searches the STATIC schema tree (labels/documentation as parsed, not live
// form data), so unlike validateSchema/coloringService/xmlWriter/xmlReader
// this does NOT need to thread a runtime path through repeating instances —
// element.elementPath (set once at parse time — §4/§8) is already the right
// path to report for every node, since it's a schema DEFINITION search, not a
// per-instance data search. A result's elementPath has no `[i]` segments even
// for a field inside a repeating section; js/ui/search.js's click-to-navigate
// falls back to a prefix match against the rendered DOM (landing on the first
// instance) to handle that, which is as much precision as this feature needs.

export function matchesQuery(text, query, caseSensitive) {
  if (!text || !query) return false;
  return caseSensitive ? text.includes(query) : text.toLowerCase().includes(query.toLowerCase());
}

/**
 * @param {object} element - SchemaElement (form root or any subtree)
 * @param {string} formName
 * @param {string} query
 * @param {{caseSensitive?:boolean, searchInDocs?:boolean, lineNumberMode?:boolean}} options
 * @param {Array} results - appended to in place
 */
export function walkForSearch(element, formName, query, options, results) {
  const text = options.searchInDocs ? element.documentation : element.resolvedLabel;
  const match = options.lineNumberMode
    // element.lineNumber comes from the schema annotation's <LineNumber> child
    // (parser.js getLineNumber) — '' for elements with no such annotation.
    ? element.lineNumber !== '' && String(element.lineNumber) === String(query)
    : matchesQuery(text, query, options.caseSensitive);

  if (match) {
    results.push({
      formName,
      elementPath: element.elementPath,
      label: element.resolvedLabel,
      lineNumber: element.lineNumber,
      documentation: element.documentation,
    });
  }

  for (const child of element.children) walkForSearch(child, formName, query, options, results);
}

/**
 * @param {string} query
 * @param {string[]} formNames - distinct form names to search (schema is
 *   shared across every instance of a repeatable form, so this takes form
 *   NAMES, not FormInstanceKeys — the caller dedupes).
 * @param {{parseGlobalElement:(name:string)=>object|null}} schemaParser
 * @param {object} [options]
 * @returns {Array<{formName:string, elementPath:string, label:string, lineNumber:string, documentation:string}>}
 */
export function search(query, formNames, schemaParser, options = {}) {
  const results = [];
  if (!query) return results;
  for (const formName of formNames) {
    const schemaElement = schemaParser.parseGlobalElement(formName);
    if (schemaElement) walkForSearch(schemaElement, formName, query, options, results);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Highlight target resolution (parity 1.7)
// ---------------------------------------------------------------------------

/** A rendered node's data-path with every repeat index removed — the form a
 *  search result's static `elementPath` can be compared against.
 *  `List.ListEntry[1].Field` → `List.ListEntry.Field`. */
export function staticPathOf(runtimePath) {
  return runtimePath.replace(/\[\d+\]/g, '');
}

/** The result's own path, then each ancestor up to the outermost segment, in
 *  the order js/ui/search.js tries them: a field the DOM doesn't show (an
 *  unselected radio branch, a repeating section with no rows) is highlighted
 *  through the nearest ancestor that IS shown. */
export function highlightCandidatePaths(elementPath) {
  if (!elementPath) return [];
  const segments = elementPath.split('.');
  const candidates = [];
  for (let n = segments.length; n > 0; n--) candidates.push(segments.slice(0, n).join('.'));
  return candidates;
}
