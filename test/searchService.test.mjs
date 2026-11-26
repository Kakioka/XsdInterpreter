// test/searchService.test.mjs — js/core/searchService.js.
//
// Search walks the STATIC schema tree (labels/documentation as parsed), so
// unlike the coloring/validation/write/read walks it needs no runtime paths
// and is entirely testable headless.

import test from 'node:test';
import assert from 'node:assert/strict';

import { matchesQuery, walkForSearch, search, staticPathOf, highlightCandidatePaths } from '../js/core/searchService.js';
import { loadSamplePipeline } from './helpers/env.mjs';

const { parser, manifest } = await loadSamplePipeline();
const formNames = manifest.allForms;

test('matchesQuery honours caseSensitive and treats empty text/query as no match', () => {
  assert.equal(matchesQuery('Packet Identifier', 'packet', false), true);
  assert.equal(matchesQuery('Packet Identifier', 'packet', true), false);
  assert.equal(matchesQuery('Packet Identifier', 'Packet', true), true);
  assert.equal(matchesQuery('', 'packet', false), false);
  assert.equal(matchesQuery('Packet Identifier', '', false), false);
  assert.equal(matchesQuery(undefined, 'packet', false), false);
});

test('an empty query returns nothing rather than everything', () => {
  assert.deepEqual(search('', formNames, parser), []);
});

test('search finds fields by resolved label across every form', () => {
  const results = search('Name', formNames, parser);
  assert.ok(results.length > 0);
  for (const result of results) {
    assert.ok(formNames.includes(result.formName));
    assert.ok(result.elementPath.startsWith(result.formName), 'every result path is rooted at its form');
    assert.match(result.label, /Name/);
  }
  // FormerName lives inside a repeating section; its reported path carries no
  // [i] segment, because this is a schema-definition search (searchService's
  // own file comment) — ui/search.js prefix-matches to land on instance [0].
  const formerName = results.find((r) => r.elementPath.endsWith('.FormerName'));
  assert.ok(formerName);
  assert.ok(!formerName.elementPath.includes('['));
});

test('searchInDocs switches the matched text from label to documentation', () => {
  const header = parser.parseGlobalElement('SampleHeader');

  // "digits only" appears in PhoneNumber's documentation and in no label.
  const inDocs = [];
  walkForSearch(header, 'SampleHeader', 'digits only', { searchInDocs: true }, inDocs);
  assert.ok(
    inDocs.some((r) => r.elementPath === 'SampleHeader.PrimaryContact.PhoneNumber'),
    'documentation mode must match documentation text'
  );

  const inLabels = [];
  walkForSearch(header, 'SampleHeader', 'digits only', { searchInDocs: false }, inLabels);
  assert.deepEqual(inLabels, [], 'label mode must NOT fall back to documentation');

  // And the reverse: a label-only phrase isn't found in documentation mode.
  const labelOnly = [];
  walkForSearch(header, 'SampleHeader', 'Is Amended', { searchInDocs: false }, labelOnly);
  assert.ok(labelOnly.some((r) => r.elementPath === 'SampleHeader.IsAmended'));
  const notInDocs = [];
  walkForSearch(header, 'SampleHeader', 'Is Amended', { searchInDocs: true }, notInDocs);
  assert.deepEqual(notInDocs, []);
});

test('lineNumberMode matches a line-number annotation exactly, never substring', () => {
  const entity = parser.parseGlobalElement('SampleEntityForm');

  // Collect the line numbers the fixture actually annotates, then look one up.
  const annotated = [];
  const collect = (el) => {
    if (el.lineNumber !== '') annotated.push(el);
    for (const child of el.children) collect(child);
  };
  collect(entity);

  if (annotated.length === 0) {
    // No annotation in this fixture: the mode must then match nothing at all
    // rather than falling back to label matching.
    const results = [];
    walkForSearch(entity, 'SampleEntityForm', '1', { lineNumberMode: true }, results);
    assert.deepEqual(results, []);
    return;
  }

  const target = annotated[0];
  const exact = [];
  walkForSearch(entity, 'SampleEntityForm', String(target.lineNumber), { lineNumberMode: true }, exact);
  assert.ok(exact.some((r) => r.elementPath === target.elementPath));

  // A line number never matches as a substring of another one.
  const bogus = [];
  walkForSearch(entity, 'SampleEntityForm', `${target.lineNumber}999`, { lineNumberMode: true }, bogus);
  assert.deepEqual(bogus, []);
});

test('search tolerates a form name the parser cannot resolve', () => {
  assert.deepEqual(search('Name', ['NoSuchForm'], parser), []);
});

test('each result carries the fields ui/search.js renders', () => {
  const [result] = search('Packet', formNames, parser);
  assert.ok(result);
  for (const key of ['formName', 'elementPath', 'label', 'lineNumber', 'documentation']) {
    assert.ok(key in result, `result is missing ${key}`);
  }
});

test('staticPathOf strips every repeat index so rendered paths compare to result paths (parity 1.7)', () => {
  assert.equal(staticPathOf('F.List.ListEntry[1].Field'), 'F.List.ListEntry.Field');
  assert.equal(staticPathOf('F.Outer[0].Inner[12].Leaf'), 'F.Outer.Inner.Leaf');
  assert.equal(staticPathOf('F.Plain'), 'F.Plain');
});

test('highlightCandidatePaths lists the path then each ancestor, nearest first', () => {
  assert.deepEqual(highlightCandidatePaths('F.Choice.Option1.Field'), ['F.Choice.Option1.Field', 'F.Choice.Option1', 'F.Choice', 'F']);
  assert.deepEqual(highlightCandidatePaths('F'), ['F']);
  assert.deepEqual(highlightCandidatePaths(''), []);
});

test("every ancestor in a result's fallback chain is a real schema node on the sample packet", () => {
  // The walk-up only helps if each step lands on something the renderer
  // stamps a data-path on — i.e. result paths are built from their ancestors'.
  for (const formName of formNames) {
    const root = parser.parseGlobalElement(formName);
    if (!root) continue;
    const known = new Set();
    const collect = (el) => {
      known.add(el.elementPath);
      el.children.forEach(collect);
    };
    collect(root);
    for (const r of search('a', [formName], parser)) {
      assert.equal(staticPathOf(r.elementPath), r.elementPath, 'result paths are static');
      for (const candidate of highlightCandidatePaths(r.elementPath)) {
        assert.ok(known.has(candidate), `${candidate} (from ${r.elementPath}) is not a schema node`);
      }
    }
  }
});
