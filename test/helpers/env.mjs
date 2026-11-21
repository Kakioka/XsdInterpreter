// test/helpers/env.mjs — shared setup for the node --test suites.
//
// dev/IMPROVEMENT_BACKLOG.md B.2. Node 20+ already provides TextEncoder, Blob,
// crypto.randomUUID and CompressionStream natively, so the only things js/core/
// needs filled in are an XML DOM (see ./xmlDom.mjs) and localStorage, which
// js/core/packager.js uses for its three settings-persistence call sites.
//
// Fixture loading mirrors what the browser harnesses do with fetch(): the same
// sample-schemas/ files, through the same module entry points, so a test here
// and a row in dev/phase1-check.html are checking the same thing.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { loadXmlDom } from './xmlDom.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const SAMPLE_SCHEMA_FILES = ['SamplePacket.xsd', 'SampleCommonTypes.xsd', 'SampleGroups.xsd'];

/** A localStorage with just the surface packager.js uses. Also the seam for
 *  testing the "storage throws" path the real code guards against. */
export function installLocalStorage({ throwOnAccess = false } = {}) {
  const store = new Map();
  const guard = () => {
    if (throwOnAccess) throw new Error('localStorage is unavailable');
  };
  globalThis.localStorage = {
    getItem(key) {
      guard();
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      guard();
      store.set(key, String(value));
    },
    removeItem(key) {
      guard();
      store.delete(key);
    },
    clear() {
      guard();
      store.clear();
    },
    get length() {
      return store.size;
    },
  };
  return store;
}

export function repoPath(...segments) {
  return path.join(REPO_ROOT, ...segments);
}

/** @returns {Promise<Map<string,string>>} filename → text, as the flattener takes it */
export async function loadSampleSchemaFiles(filenames = SAMPLE_SCHEMA_FILES) {
  const map = new Map();
  for (const name of filenames) {
    map.set(name, await readFile(repoPath('sample-schemas', name), 'utf8'));
  }
  return map;
}

export function loadSampleXml() {
  return readFile(repoPath('sample-schemas', 'SamplePacket.xml'), 'utf8');
}

/**
 * The full flatten → parse → analyze pipeline over the sample schema set, the
 * same four calls dev/phase1-check.html makes. Installs the XML DOM first, so
 * a test file only needs to await this.
 */
export async function loadSamplePipeline() {
  const domSource = await loadXmlDom();
  const { findRootFileCandidates, flattenFromRoot } = await import('../../js/core/flattener.js');
  const { SchemaParser, findRootElementCandidates, analyzePacket } = await import('../../js/core/parser.js');

  const fileTextMap = await loadSampleSchemaFiles();
  const rootFileCandidates = findRootFileCandidates(fileTextMap);
  const { doc: flatDoc, targetNamespace } = flattenFromRoot(fileTextMap, rootFileCandidates[0]);
  const rootElementCandidates = findRootElementCandidates(flatDoc);
  const rootElementName = rootElementCandidates[0];
  const parser = new SchemaParser(flatDoc, rootElementName);
  const manifest = analyzePacket(flatDoc, rootElementName);

  return {
    domSource,
    fileTextMap,
    rootFileCandidates,
    rootFileName: rootFileCandidates[0],
    flatDoc,
    targetNamespace,
    rootElementCandidates,
    rootElementName,
    parser,
    manifest,
  };
}

/** Depth-first search of a SchemaElement tree by element name — the same
 *  helper every browser harness defines inline. */
export function findByName(root, name) {
  if (!root) return null;
  if (root.elementName === name) return root;
  for (const child of root.children || []) {
    const found = findByName(child, name);
    if (found) return found;
  }
  return null;
}

/** FormState's dicts are keyed lower-case (§8 / FormEngine's storage rule), so
 *  tests read through these rather than lower-casing paths by hand. */
export function field(state, path) {
  return state.fieldValues[path.toLowerCase()];
}

export function radio(state, path) {
  return state.radioSelections[path.toLowerCase()];
}

export function emptyFormState(fieldValues = {}, radioSelections = {}, repeatingInstanceCounts = {}) {
  return { fieldValues, radioSelections, repeatingInstanceCounts, unmatchedFields: [], isDirty: false };
}
