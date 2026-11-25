// test/exportProfile.test.mjs — js/core/exportProfile.js, plus the bundled profile.
//
// Two halves: the mechanism, driven by a deliberately un-tax-like profile so a
// domain assumption creeping back into the code fails here; and the bundled
// MeF profile, checked as data against the rules it carries over.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { repoPath } from './helpers/env.mjs';
import { loadXmlDom } from './helpers/xmlDom.mjs';

await loadXmlDom();
const { unrememberedFieldIds, validateProfile, validateProfileValues, validateProfileFiles, activeValues, renderDocument, planArchive, validatePackage } = await import(
  '../js/core/exportProfile.js'
);

const mef = JSON.parse(await readFile(repoPath('export-profiles', 'mef-state.profile.json'), 'utf8'));

const library = {
  formatVersion: 1,
  id: 'library',
  name: 'Library deposit',
  archiveName: '{packetName}-{shelf}.zip',
  limits: { maxEntryPathLength: 20 },
  fields: [
    { id: 'shelf', label: 'Shelf', required: true, pattern: '[A-Z]{2}', patternMessage: 'must be two capitals.' },
    { id: 'kind', label: 'Kind', type: 'select', required: true, options: [{ value: 'book' }, { value: 'map' }] },
    { id: 'scale', label: 'Scale', required: true, when: { field: 'kind', equals: 'map' } },
    { id: 'scaleNote', label: 'Scale note', required: true, when: { field: 'scale', notBlank: true } },
  ],
  fileGroups: [{ id: 'scans', label: 'Scans', multiple: true, maxCount: 2, uniqueNames: true, required: true }],
  entries: [
    { type: 'packet', path: '{shelf}/{packetName}.xml' },
    { type: 'document', path: 'card.xml', document: { name: 'Card', children: [{ name: 'Shelf', value: '{shelf}' }, { name: 'Scale', value: '1:{scale}', when: { field: 'kind', equals: 'map' } }] } },
    { type: 'files', group: 'scans', path: 'scans/{fileName}' },
    { type: 'directory', path: 'scans/' },
    { type: 'directory', path: 'extra/' },
  ],
};
const book = { shelf: 'AB', kind: 'book' };
const scans = (...names) => ({ scans: names.map((name) => ({ name })) });
const fieldsOf = (errors) => errors.map((e) => e.field);
const without = (key, replacement) => ({ ...library, [key]: replacement });

test('a well-formed profile passes validateProfile', () => {
  assert.deepEqual(validateProfile(library), []);
});

test('validateProfile reports malformed profiles instead of throwing', () => {
  for (const bad of [null, [], 'x', 3, {}, without('formatVersion', 2), without('entries', []), without('entries', [null]), without('entries', 'x'), without('limits', 4)]) {
    assert.ok(validateProfile(bad).length > 0, JSON.stringify(bad));
  }
  const badFields = [
    { id: 'a b', label: 'x' },
    { id: 'shelf' },
    { id: 'r', label: 'x', remember: 'false' },
    { id: 'fileName', label: 'reserved' },
    { id: 'p', label: 'x', pattern: '(' },
    { id: 's', label: 'x', type: 'select' },
    { id: 'w', label: 'x', when: { field: 'later', equals: '1' } },
    { id: 'c', label: 'x', when: { field: 'shelf' } },
  ];
  for (const field of badFields) {
    assert.ok(validateProfile(without('fields', [...library.fields, field])).length > 0, JSON.stringify(field));
  }
  const badEntries = [
    { type: 'packet' },
    { type: 'nope', path: 'x' },
    { type: 'packet', path: '{unknown}.xml' },
    { type: 'packet', path: '{fileName}.xml' },
    { type: 'packet', path: 'dir/' },
    { type: 'files', group: 'nope', path: 'x' },
    { type: 'directory', path: 'x' },
    { type: 'document', path: 'x.xml' },
    { type: 'document', path: 'x.xml', document: { name: '1bad' } },
    { type: 'document', path: 'x.xml', document: { name: 'A', prefix: 'p' } },
    { type: 'document', path: 'x.xml', document: { name: 'A', children: [{ name: 'B', value: '{nope}' }] } },
  ];
  for (const entry of badEntries) {
    assert.ok(validateProfile(without('entries', [entry])).length > 0, JSON.stringify(entry));
  }
});

test('a field whose condition is off neither validates nor has a value, and turns its dependents off', () => {
  assert.deepEqual(activeValues(library, { ...book, scale: '50', scaleNote: 'left over' }), book);
  assert.deepEqual(validateProfileValues(library, book), []);
  assert.deepEqual(fieldsOf(validateProfileValues(library, { ...book, kind: 'map' })), ['scale']);
  assert.deepEqual(fieldsOf(validateProfileValues(library, { ...book, kind: 'map', scale: '50' })), ['scaleNote']);
});

test('required, pattern and option rules, with the profile’s own wording', () => {
  assert.deepEqual(fieldsOf(validateProfileValues(library, {})), ['shelf', 'kind']);
  assert.deepEqual(fieldsOf(validateProfileValues(library, { ...book, shelf: '   ' })), ['shelf']);
  assert.equal(validateProfileValues(library, { ...book, shelf: 'ABC' })[0].message, 'Shelf must be two capitals.');
  assert.deepEqual(fieldsOf(validateProfileValues(library, { ...book, kind: 'globe' })), ['kind']);
});

test('file groups: required, count, and case-insensitive name uniqueness', () => {
  assert.deepEqual(validateProfileFiles(library, scans('a.png', 'b.png')), []);
  assert.equal(validateProfileFiles(library, {}).length, 1);
  assert.equal(validateProfileFiles(library, scans('a', 'b', 'c')).length, 1);
  assert.equal(validateProfileFiles(library, scans('a.png', 'A.PNG')).length, 1);
});

test('planArchive resolves templates and lists only otherwise-empty directories', () => {
  const plan = planArchive(library, book, scans('a.png'), 'Deposit');
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.filename, 'Deposit-AB.zip');
  assert.deepEqual(plan.entries.map((e) => e.path), ['AB/Deposit.xml', 'card.xml', 'scans/a.png', 'extra/']);
});

test('planArchive rejects long, colliding and unsafe paths', () => {
  const messages = (profile, values, files) => planArchive(profile, values, files, 'Deposit').errors.map((e) => e.message).join('\n');
  assert.match(messages(library, book, scans('a-rather-long-name.png')), /too long/);
  const colliding = without('entries', [{ type: 'files', group: 'scans', path: 'same.png' }]);
  assert.match(messages(colliding, book, scans('a', 'b')), /same\.png/);
  for (const shelf of ['..', 'a/../../b', 'a\\b', '', '/abs']) {
    assert.match(messages(library, { ...book, shelf }, scans('a')), /not a valid/, shelf);
  }
  assert.match(messages({ ...library, archiveName: '{shelf}' }, { ...book, shelf: '' }, scans('a')), /file name/);
});

test('validatePackage reports path problems only once values and files are right', () => {
  assert.deepEqual(fieldsOf(validatePackage(library, { ...book, shelf: '../x' }, scans('a'), 'Deposit')), ['shelf']);
  assert.deepEqual(validatePackage(library, book, scans('a'), 'Deposit'), []);
});

test('renderDocument escapes values, honors conditions, omits blanks and nests', () => {
  const node = {
    name: 'Root',
    namespace: 'urn:x',
    attributes: { code: '{a}', blank: '{b}' },
    children: [{ name: 'A', value: '{a}' }, { name: 'B', value: '{b}' }, { name: 'Outer', children: [{ name: 'B', value: '{b}' }] }, { name: 'C', value: 'x', when: { field: 'b', notBlank: true } }],
  };
  const root = new DOMParser().parseFromString(renderDocument(node, { a: '<&">', b: '' }), 'application/xml').documentElement;
  assert.equal(root.namespaceURI, 'urn:x');
  assert.equal(root.getAttribute('code'), '<&">');
  assert.equal(root.getAttribute('blank'), null);
  assert.deepEqual([...root.children].map((c) => c.localName), ['A']);
  assert.equal(root.children[0].textContent, '<&">');
});

// ---------------------------------------------------------------------------
// The bundled profile
// ---------------------------------------------------------------------------

const ssn = {
  submissionId: '1234567890123abcdef0', efin: '123456', taxYear: '2024', governmentCode: 'HIST', submissionType: 'HIN11',
  category: 'IND', identityType: 'SSN', primarySSN: '123456789', primaryNameControl: 'SMIT',
};
const manifestOf = (values) => {
  const { text } = planArchive(mef, values, {}, 'P').entries.find((e) => e.path === 'manifest/manifest.xml');
  return new DOMParser().parseFromString(text, 'application/xml').documentElement;
};
const namesOf = (root) => [...root.children].map((c) => c.localName);

test('bundled profile: valid, and accepts a complete submission', () => {
  assert.deepEqual(validateProfile(mef), []);
  assert.deepEqual(validatePackage(mef, ssn, {}, 'P'), []);
});

test('bundled profile: personal identifiers are not remembered', () => {
  assert.deepEqual(unrememberedFieldIds(mef), ['primarySSN', 'spouseSSN', 'tempId']);
});

test('bundled profile: field rules', () => {
  const bad = (overrides) => fieldsOf(validateProfileValues(mef, { ...ssn, ...overrides }));
  assert.deepEqual(bad({ submissionId: '1234567890123ABCDEF0' }), ['submissionId'], 'uppercase suffix');
  assert.deepEqual(bad({ efin: '12345a' }), ['efin']);
  assert.deepEqual(bad({ governmentCode: 'HI' }), ['governmentCode']);
  assert.deepEqual(bad({ category: 'BUS' }), ['category']);
  assert.deepEqual(bad({ primaryNameControl: 'smit' }), ['primaryNameControl']);
  assert.deepEqual(bad({ spouseSSN: '987654321' }), ['spouseNameControl'], 'required once a spouse SSN is given');
  assert.deepEqual(bad({ irsSubmissionId: 'short' }), ['irsSubmissionId']);
});

test('bundled profile: category and identity type are independent axes', () => {
  const temp = { ...ssn, category: 'PART', identityType: 'TempID', tempId: 'A12345678' };
  assert.deepEqual(validateProfileValues(mef, temp), []);
  assert.deepEqual(namesOf(manifestOf(temp)), ['SubmissionId', 'EFIN', 'TaxYr', 'GovernmentCd', 'StateSubmissionTyp', 'SubmissionCategoryCd', 'TempID']);
  const ein = { ...ssn, category: 'IND', identityType: 'EIN', ein: '123456789', businessNameControl: 'ACME' };
  assert.deepEqual(namesOf(manifestOf(ein)).slice(-2), ['FederalEIN', 'BusinessNameControlTxt']);
});

test('bundled profile: manifest root, namespace and element order', () => {
  const root = manifestOf({ ...ssn, spouseSSN: '987654321', spouseNameControl: 'SMIT', irsSubmissionId: ssn.submissionId, stateSchemaVersionNum: 'v1' });
  assert.equal(root.localName, 'StateSubmissionManifest');
  assert.equal(root.namespaceURI, 'http://www.irs.gov/efile');
  assert.deepEqual(namesOf(root).slice(6), ['PrimarySSN', 'PrimaryNameControlTxt', 'SpouseSSN', 'SpouseNameControlTxt', 'IRSSubmissionId', 'StateSchemaVersionNum']);
});

test('bundled profile: archive layout, empty and full', () => {
  const paths = (files) => planArchive(mef, ssn, files, 'P').entries.map((e) => e.path);
  assert.deepEqual(paths({}), ['manifest/manifest.xml', `xml/${ssn.submissionId}.xml`, 'attachment/', 'irs/xml/']);
  assert.deepEqual(paths({ stateAttachments: [{ name: 'a.pdf' }], federalReturnFile: [{ name: 'anything.xml' }], federalAttachments: [{ name: 'f.pdf' }] }), [
    'manifest/manifest.xml',
    `xml/${ssn.submissionId}.xml`,
    'attachment/a.pdf',
    'irs/xml/submission.xml',
    'irs/attachment/f.pdf',
  ]);
});

test('bundled profile: attachment count, duplicate names, 64-character paths', () => {
  const errors = (names) => validatePackage(mef, ssn, { stateAttachments: names.map((name) => ({ name })) }, 'P');
  assert.equal(errors(Array.from({ length: 50 }, (_, i) => `${i}.pdf`)).length, 0);
  assert.equal(errors(Array.from({ length: 51 }, (_, i) => `${i}.pdf`)).length, 1);
  assert.equal(errors(['a.pdf', 'A.pdf']).length, 1);
  assert.equal(errors([`${'x'.repeat(64 - 'attachment/'.length)}`]).length, 0);
  assert.equal(errors([`${'x'.repeat(65 - 'attachment/'.length)}`]).length, 1);
});
