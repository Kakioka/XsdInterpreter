// test/testDataFiller.test.mjs — js/core/testDataFiller.js.
//
// generateValues is pure (§17's own file comment says so), so this is the
// headless half of dev/phase6-check.html's fill coverage. The assertions that
// matter most are the contract ones: that every generated value is keyed
// exactly like FormEngine.fieldValues, that generated values actually SATISFY
// the facets they were generated from, and that the returned dicts contain
// only what this call newly decided — app.js's fillActiveForm merges them in
// on that basis.

import test from 'node:test';
import assert from 'node:assert/strict';

import { generateValues, RegexSampleGenerator } from '../js/core/testDataFiller.js';
import { isFieldValid } from '../js/core/coloringService.js';
import { loadSamplePipeline, findByName } from './helpers/env.mjs';

const { parser } = await loadSamplePipeline();

/** Walk a SchemaElement tree collecting leaves, with the runtime path each
 *  one's value would be stored at (repeating sections use instance 0). */
function collectLeaves(element, parentPath, out = []) {
  const path = parentPath ? `${parentPath}.${element.elementName}` : element.elementName;
  if (!element.children || element.children.length === 0) out.push({ element, path });
  else for (const child of element.children) collectLeaves(child, path, out);
  return out;
}

test('RegexSampleGenerator produces a string matching the pattern it was given', () => {
  for (const pattern of ['[A-Z]{2}\\d{4}', '\\d{6}', '[0-9]{3}-[0-9]{2}-[0-9]{4}', '[A-Z][a-z]+']) {
    const sample = RegexSampleGenerator.generate(pattern);
    assert.equal(typeof sample, 'string');
    assert.match(sample, new RegExp(`^(?:${pattern})$`), `generated ${JSON.stringify(sample)} for ${pattern}`);
  }
});

test('values are keyed exactly like FormEngine.fieldValues: full path, lower-cased (§8)', () => {
  const header = parser.parseGlobalElement('SampleHeader');
  const { values } = generateValues(header, {});
  assert.ok(Object.keys(values).length > 0);
  for (const key of Object.keys(values)) {
    assert.equal(key, key.toLowerCase(), `${key} must be lower-cased`);
    assert.ok(key.startsWith('sampleheader.'), `${key} must be a full path rooted at the form`);
    assert.ok(!key.startsWith('.'), 'a leading dot means joinPath was bypassed');
  }
});

test('every generated value passes the facets it was generated from', () => {
  // The single most useful property of a test-data filler: filling a form must
  // not leave it reading invalid.
  for (const formName of ['SampleHeader', 'SampleEntityForm', 'SampleFinancialForm', 'SampleEventLog', 'SampleSummary']) {
    const form = parser.parseGlobalElement(formName);
    const { values } = generateValues(form, {});
    for (const { element, path } of collectLeaves(form, '')) {
      const value = values[path.toLowerCase()];
      if (value === undefined) continue;
      assert.ok(
        isFieldValid(element, value),
        `${formName}: generated ${JSON.stringify(value)} for ${path} fails its own validation rules`
      );
    }
  }
});

test('requiredOnly fills required fields and leaves optional ones alone', () => {
  const header = parser.parseGlobalElement('SampleHeader');
  const { values } = generateValues(header, { requiredOnly: true });

  const required = findByName(header, 'PacketId');
  const optional = findByName(header, 'InternalNotes');
  assert.equal(required.isRequired, true);
  assert.equal(optional.isRequired, false);

  assert.notEqual(values['sampleheader.packetid'], undefined);
  assert.equal(values['sampleheader.internalnotes'], undefined);
});

test('an explicit filter overrides requiredOnly', () => {
  const header = parser.parseGlobalElement('SampleHeader');
  const { values } = generateValues(header, { requiredOnly: true, filter: (el) => el.elementName === 'InternalNotes' });
  assert.notEqual(values['sampleheader.internalnotes'], undefined);
  assert.equal(values['sampleheader.packetid'], undefined, 'the explicit filter must win');
});

test('a Dropdown is filled with one of its own enumeration values', () => {
  const header = parser.parseGlobalElement('SampleHeader');
  const status = findByName(header, 'PacketStatus');
  const { values } = generateValues(header, {});
  const filled = values['sampleheader.packetstatus'];
  assert.ok(
    status.enumerationValues.some((e) => e.value === filled),
    `${JSON.stringify(filled)} is not one of ${status.enumerationValues.map((e) => e.value).join('/')}`
  );
});

test('radioSelections reports only NEWLY chosen branches, not ones already set', () => {
  const entity = parser.parseGlobalElement('SampleEntityForm');
  const choicePath = 'sampleentityform.entitytypechoice.entitytypechoicechoice';

  const fresh = generateValues(entity, {});
  assert.notEqual(fresh.radioSelections[choicePath], undefined, 'an unselected choice gets a branch picked');

  const existing = `SampleEntityForm.EntityTypeChoice.EntityTypeChoiceChoice.EntityTypeChoiceChoiceOption2`;
  const reused = generateValues(entity, { radioSelections: { [choicePath]: existing } });
  assert.equal(reused.radioSelections[choicePath], undefined, 'an existing selection is reused, not re-reported');
  // …and the fill goes into the branch the user already chose.
  assert.notEqual(reused.values[`${existing}.orglegalname`.toLowerCase()], undefined);
});

test('only the selected branch of a choice is filled', () => {
  const entity = parser.parseGlobalElement('SampleEntityForm');
  const choicePath = 'sampleentityform.entitytypechoice.entitytypechoicechoice';
  const option1 = 'SampleEntityForm.EntityTypeChoice.EntityTypeChoiceChoice.EntityTypeChoiceChoiceOption1';
  const option2 = 'SampleEntityForm.EntityTypeChoice.EntityTypeChoiceChoice.EntityTypeChoiceChoiceOption2';

  const { values } = generateValues(entity, { radioSelections: { [choicePath]: option2 } });
  assert.notEqual(values[`${option2}.orglegalname`.toLowerCase()], undefined);
  assert.equal(values[`${option1}.individualfirstname`.toLowerCase()], undefined, 'the hidden branch must stay empty');
});

test('repeating sections fill the instances that exist, at their [i] paths', () => {
  const entity = parser.parseGlobalElement('SampleEntityForm');
  const entryPath = 'sampleentityform.priornamelist.priornamelistentry';

  const { values } = generateValues(entity, { instanceCounts: { priornamelistentry: 2 } });
  assert.notEqual(values[`${entryPath}[0].formername`], undefined);
  assert.notEqual(values[`${entryPath}[1].formername`], undefined);
  assert.equal(values[`${entryPath}[2].formername`], undefined);
  // Never at an un-indexed path — nothing is ever stored there at runtime.
  assert.equal(values[`${entryPath}.formername`], undefined);
});

test('instanceCounts reports only counts RAISED above what was passed in', () => {
  const entity = parser.parseGlobalElement('SampleEntityForm');
  // PriorNameList is minOccurs="0", so a zero count needs no raising.
  const { instanceCounts } = generateValues(entity, { instanceCounts: { priornamelistentry: 2 } });
  assert.equal(instanceCounts.priornamelistentry, undefined, 'an already-sufficient count must not be reported');
});

test('a scoped fill (parentPath set) produces paths under that container only', () => {
  const entity = parser.parseGlobalElement('SampleEntityForm');
  const address = findByName(entity, 'RegisteredAddress');
  const { values } = generateValues(address, { parentPath: 'SampleEntityForm' });

  assert.ok(Object.keys(values).length > 0);
  for (const key of Object.keys(values)) {
    assert.ok(key.startsWith('sampleentityform.registeredaddress.'), `${key} escaped the scoped container`);
  }
});

test('an attribute child is filled like any other leaf', () => {
  const eventLog = parser.parseGlobalElement('SampleEventLog');
  const { values } = generateValues(eventLog, {});
  // documentId is an attribute AND the instance-id source; it still gets a value.
  assert.notEqual(values['sampleeventlog.documentid'], undefined);
});

test('a Checkbox is filled with a boolean, not a string', () => {
  const header = parser.parseGlobalElement('SampleHeader');
  const isAmended = findByName(header, 'IsAmended');
  assert.equal(isAmended.kind, 'Checkbox');
  assert.equal(isAmended.xsdDataType, 'xs:boolean');
  const { values } = generateValues(header, {});
  assert.equal(typeof values['sampleheader.isamended'], 'boolean');
});
