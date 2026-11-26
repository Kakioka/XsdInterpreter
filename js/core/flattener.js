// js/core/flattener.js — XSD include/import resolution → flat DOM.
//
// See web-implementation-spec.md §3 (XSD Flattening).
// IMPLEMENTATION_PLAN.md Phase 1.1.
//
// Pure logic: takes an already-read Map<filename, text> (the app reads File objects to
// text in a separate step — see spec §20 Schema Load Flow step 3) and produces a single
// merged xs:schema DOM Document. No DOM dependency beyond DOMParser, which is a browser
// global — this module is meant to run in the browser, not Node.

const XS_NS = 'http://www.w3.org/2001/XMLSchema';

/** Strip a directory prefix (either slash style) off a path, leaving just the filename. */
function basename(path) {
  return path.split(/[\\/]/).pop();
}

// ---------------------------------------------------------------------------
// BOM detection / stripping (spec §3 "BOM Detection")
// ---------------------------------------------------------------------------

/**
 * @param {Map<string,string>} fileTextMap
 * @returns {{name: string, hasLeadingBom: boolean, hasInterior: boolean}[]}
 */
export function scanForBom(fileTextMap) {
  const affected = [];
  for (const [name, text] of fileTextMap) {
    const hasLeadingBom = text.charCodeAt(0) === 0xfeff;
    // Search from past the leading BOM, not "indexOf >= 1": with a leading
    // BOM indexOf returns 0, so interior marks after it went unreported
    // (parity 1.11).
    const hasInterior = text.indexOf('\uFEFF', hasLeadingBom ? 1 : 0) !== -1;
    if (hasLeadingBom || hasInterior) affected.push({ name, hasLeadingBom, hasInterior });
  }
  return affected;
}

export function stripBom(text) {
  return text.replace(/\uFEFF/g, '');
}

// ---------------------------------------------------------------------------
// Root file detection (spec §20 Schema Load Flow step 5 — "not referenced
// anywhere else", no naming convention)
// ---------------------------------------------------------------------------

/**
 * A file is a root candidate if no other file's xs:include/xs:import ever
 * names it as a schemaLocation target.
 * @param {Map<string,string>} fileTextMap
 * @returns {string[]} the filenames (keys of fileTextMap) that are root candidates
 */
export function findRootFileCandidates(fileTextMap) {
  const referenced = new Set();
  for (const text of fileTextMap.values()) {
    const doc = new DOMParser().parseFromString(stripBom(text), 'application/xml');
    for (const tag of ['include', 'import']) {
      for (const node of doc.getElementsByTagNameNS(XS_NS, tag)) {
        const loc = node.getAttribute('schemaLocation');
        if (loc) referenced.add(basename(loc).toLowerCase());
      }
    }
  }
  return [...fileTextMap.keys()].filter((name) => !referenced.has(basename(name).toLowerCase()));
}

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

function assertNoParserError(doc, label) {
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error(`Failed to parse ${label} as XML: ${err.textContent.trim()}`);
}

function findFileKey(fileTextMap, schemaLocation) {
  const base = basename(schemaLocation).toLowerCase();
  for (const key of fileTextMap.keys()) {
    if (basename(key).toLowerCase() === base) return key;
  }
  return null;
}

/** The `sourceFiles` key for a top-level schema component: its kind plus its
 *  name, e.g. "element:FormN11" or "complexType:AddressType". */
export function sourceFileKey(localName, name) {
  return `${localName}:${name}`;
}

/**
 * @param {Map<string,string>} fileTextMap filename → raw file text (already read)
 * @param {string} rootFileName key into fileTextMap to start from
 * @returns {{doc: Document, targetNamespace: string|null, sourceFiles: Map<string,string>}}
 *   `sourceFiles` maps sourceFileKey(kind, name) of every named top-level
 *   component to the fileTextMap key of the file that declared it (parity 3.3's
 *   PacketSection.sourceSchemaFile). Kept beside the document rather than as an
 *   attribute on it, so nothing that walks the flat DOM can trip over it.
 */
export function flattenFromRoot(fileTextMap, rootFileName) {
  const rootText = fileTextMap.get(rootFileName);
  if (rootText == null) throw new Error(`Root file not found: ${rootFileName}`);

  const rootDoc = new DOMParser().parseFromString(stripBom(rootText), 'application/xml');
  assertNoParserError(rootDoc, rootFileName);

  const targetNamespace = rootDoc.documentElement.getAttribute('targetNamespace') || null;

  // Guards against inlining the same file's types twice (diamond includes) — not
  // exercised by the sample schema set, but cheap insurance against duplicate
  // globals if a real schema set ever has one.
  const alreadyInlined = new Set([rootFileName.toLowerCase()]);

  // Recorded for a file's OWN components before its includes are resolved, and
  // first-wins: that is the order components end up in the flat document
  // (own children first, inlined ones appended after), so on a duplicate name
  // the file recorded here is the one findGlobalElementInDoc would find.
  const sourceFiles = new Map();
  function recordOwnComponents(doc, fileKey) {
    for (const child of doc.documentElement.children) {
      const name = child.getAttribute('name');
      if (!name) continue;
      const key = sourceFileKey(child.localName, name);
      if (!sourceFiles.has(key)) sourceFiles.set(key, fileKey);
    }
  }

  function parseFile(fileKey) {
    const doc = new DOMParser().parseFromString(stripBom(fileTextMap.get(fileKey)), 'application/xml');
    assertNoParserError(doc, fileKey);
    return doc;
  }

  function inlineTopLevelChildren(targetDoc, sourceDoc) {
    const targetSchema = targetDoc.documentElement;
    for (const child of Array.from(sourceDoc.documentElement.children)) {
      targetSchema.appendChild(targetDoc.importNode(child, true));
    }
  }

  // Depth-first: an included/imported file's OWN includes/imports are resolved
  // (and inlined into ITS document) before that file's top-level children are
  // in turn inlined into the caller's document — see spec §3 step 3a.
  function resolveIncludesAndImports(doc, currentFileLabel) {
    recordOwnComponents(doc, currentFileLabel);
    for (const includeEl of Array.from(doc.getElementsByTagNameNS(XS_NS, 'include'))) {
      const loc = includeEl.getAttribute('schemaLocation');
      const fileKey = loc && findFileKey(fileTextMap, loc);
      if (!fileKey) {
        throw new Error(`Missing xs:include target "${loc}" (referenced from ${currentFileLabel})`);
      }
      if (!alreadyInlined.has(fileKey.toLowerCase())) {
        alreadyInlined.add(fileKey.toLowerCase());
        const includedDoc = parseFile(fileKey);
        resolveIncludesAndImports(includedDoc, fileKey);
        inlineTopLevelChildren(doc, includedDoc);
      }
      includeEl.remove();
    }

    for (const importEl of Array.from(doc.getElementsByTagNameNS(XS_NS, 'import'))) {
      const loc = importEl.getAttribute('schemaLocation');
      if (!loc) {
        importEl.remove();
        continue;
      }
      if (/^https?:\/\//i.test(loc)) {
        console.warn(`xs:import schemaLocation looks like a URL — skipping (non-fatal): ${loc}`);
        importEl.remove();
        continue;
      }
      const fileKey = findFileKey(fileTextMap, loc);
      if (!fileKey) {
        console.warn(`Missing xs:import target "${loc}" (referenced from ${currentFileLabel}) — skipping (non-fatal)`);
        importEl.remove();
        continue;
      }
      if (!alreadyInlined.has(fileKey.toLowerCase())) {
        alreadyInlined.add(fileKey.toLowerCase());
        const importedDoc = parseFile(fileKey);
        resolveIncludesAndImports(importedDoc, fileKey);
        inlineTopLevelChildren(doc, importedDoc);
      }
      importEl.remove();
    }
  }

  resolveIncludesAndImports(rootDoc, rootFileName);

  return { doc: rootDoc, targetNamespace, sourceFiles };
}
