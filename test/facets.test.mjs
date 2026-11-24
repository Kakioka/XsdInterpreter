// test/facets.test.mjs — js/core/facets.js, plus the three facets parity 1.9
// added end-to-end: parser extraction → validateFieldValue → the native input
// constraints parity 1.8 derives from them (js/ui/controlFactory.js applies
// those; this is the headless half — the attribute-setting itself is a
// one-liner per key and is covered by using index.html).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveMaxLengthFromPattern,
  inputConstraints,
  rejectsEdit,
  totalDigitCount,
  fractionDigitCount,
  isHtmlCompatiblePattern,
} from '../js/core/facets.js';
import { validateFieldValue } from '../js/core/coloringService.js';
import { generateValues } from '../js/core/testDataFiller.js';
import { loadXmlDom } from './helpers/xmlDom.mjs';

await loadXmlDom();
const { flattenFromRoot } = await import('../js/core/flattener.js');
const { SchemaParser } = await import('../js/core/parser.js');

const rules = (...pairs) => pairs.map(([kind, value]) => ({ kind, value }));
const leaf = (kind, validationRules, extra = {}) => ({ kind, validationRules, ...extra });

// ---------------------------------------------------------------------------
// pattern → maxLength
// ---------------------------------------------------------------------------

test('deriveMaxLengthFromPattern: bounded patterns from the production schema set', () => {
  const cases = [
    ['[0-9]{9}', 9],
    ['[A-Z]{2}[0-9]{4}', 6],
    ['[0-9]{1,6}', 6],
    ['([0-1]{1})', 1],
    ['[A-Za-z0-9]{1}|[A-Za-z0-9]{2}|[A-Za-z0-9]{15}', 15],
    ['[0-9]{5}(([0-9]{4})|([0-9]{7}))?', 12],
    ['[0-9]{2}|[  ]{2}|[0-9][ ]', 2],
    ['[01].[0-9]{4}', 6],
    ['[1-9][0-9]{3}-((0[1-9])|(1[0-2]))', 7],
    ['[1-9][0-9](0[1-9]|1[0-2])([0-9]{4})-([0-9]{5}[1-9]|[0-9]{4}[1-9]0|[1-9]00000)', 15],
    ['[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}', 15],
    ['[A-Z][A-Z\\- ]{0,3}', 4],
    ['[0-9]{4}[A-Z]{0,1}', 5],
    ['efile', 5],
    ['\\d{3}-\\d{2}-\\d{4}', 11],
    ['\\p{Lu}{2}', 2], // a \p{…} block is one atom, not "\p" + a {Lu} quantifier
    ['[a-z-[aeiou]]{3}', 3], // XSD class subtraction is still one class
    ['^[0-9]{3}$', 3], // anchors are zero-width, matching how validation compiles patterns
  ];
  for (const [pattern, expected] of cases) {
    assert.equal(deriveMaxLengthFromPattern(pattern), expected, pattern);
  }
});

test('deriveMaxLengthFromPattern: unbounded or malformed patterns give null', () => {
  for (const pattern of [
    '[a-zA-Z]+',
    '[A-Za-z0-9]*',
    '([A-Za-z] ?)*[A-Za-z]',
    '[1-9][0-9]{3}\\-.*',
    '[0-9]{2,}',
    '(abc',
    'abc)',
    '[abc',
    'abc\\',
    '',
  ]) {
    assert.equal(deriveMaxLengthFromPattern(pattern), null, pattern);
  }
});

// ---------------------------------------------------------------------------
// Parser extraction
// ---------------------------------------------------------------------------

function parseInline(body, globalTypes = '') {
  const xsd = `<?xml version="1.0"?>
    <xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
      ${globalTypes}
      <xs:element name="Root"><xs:complexType><xs:sequence>${body}</xs:sequence></xs:complexType></xs:element>
    </xs:schema>`;
  const { doc } = flattenFromRoot(new Map([['Root.xsd', xsd]]), 'Root.xsd');
  const root = new SchemaParser(doc, 'Root').parseGlobalElement('Root');
  return Object.fromEntries(root.children.map((c) => [c.elementName, c]));
}

const restricted = (name, base, facets) =>
  `<xs:element name="${name}"><xs:simpleType><xs:restriction base="${base}">${facets}</xs:restriction></xs:simpleType></xs:element>`;

const parsed = parseInline(
  restricted('Cusip', 'xs:string', '<xs:length value="9"/>') +
    restricted('Over1000', 'xs:integer', '<xs:totalDigits value="15"/><xs:minExclusive value="1000"/>') +
    restricted('Below', 'xs:decimal', '<xs:maxExclusive value="100"/><xs:fractionDigits value="2"/>') +
    restricted('Ssn', 'xs:string', '<xs:pattern value="[0-9]{9}"/>') +
    restricted('Pin', 'xs:string', '<xs:pattern value="[0-9]{4}"/><xs:pattern value="[0-9]{6}"/>') +
    restricted('Explicit', 'xs:string', '<xs:pattern value="[0-9]{9}"/><xs:maxLength value="20"/>') +
    restricted('WithLength', 'xs:string', '<xs:pattern value="[0-9]{9}"/><xs:length value="9"/>') +
    restricted('Free', 'xs:string', '<xs:pattern value="[A-Z]+"/>'),
);

test('parser extracts length, minExclusive and maxExclusive in source order', () => {
  assert.deepEqual(parsed.Cusip.validationRules, rules(['length', '9']));
  assert.deepEqual(parsed.Over1000.validationRules, rules(['totalDigits', '15'], ['minExclusive', '1000']));
  assert.deepEqual(parsed.Below.validationRules, rules(['maxExclusive', '100'], ['fractionDigits', '2']));
});

test('parser synthesizes a maxLength from a bounded pattern, appended last and flagged derived', () => {
  assert.deepEqual(parsed.Ssn.validationRules, [
    { kind: 'pattern', value: '[0-9]{9}' },
    { kind: 'maxLength', value: '9', derived: true },
  ]);
  // Several pattern facets are alternatives: the longest wins.
  assert.deepEqual(parsed.Pin.validationRules.at(-1), { kind: 'maxLength', value: '6', derived: true });
});

test('no synthesized maxLength when maxLength or length is explicit, or the pattern is unbounded', () => {
  for (const name of ['Explicit', 'WithLength', 'Free']) {
    assert.equal(parsed[name].validationRules.filter((r) => r.derived).length, 0, name);
  }
  assert.deepEqual(parsed.Explicit.validationRules.map((r) => r.kind), ['pattern', 'maxLength']);
});

test('several patterns in one restriction become one alternation rule', () => {
  assert.deepEqual(parsed.Pin.validationRules[0], { kind: 'pattern', value: '([0-9]{4})|([0-9]{6})' });
  const el = parsed.Pin;
  assert.equal(validateFieldValue('1234', el).valid, true);
  assert.equal(validateFieldValue('123456', el).valid, true);
  assert.equal(validateFieldValue('12345', el).valid, false);
});

// ---------------------------------------------------------------------------
// Facet inheritance down a named-type chain
// ---------------------------------------------------------------------------

const namedType = (name, base, facets) =>
  `<xs:simpleType name="${name}"><xs:restriction base="${base}">${facets}</xs:restriction></xs:simpleType>`;

const inherited = parseInline(
  '<xs:element name="PosAmount" type="DecimalAmountPosType"/>' +
    '<xs:element name="Short" type="ShortTextType"/>' +
    '<xs:element name="Code" type="CodeType"/>' +
    '<xs:element name="State" type="StateSubsetType"/>' +
    '<xs:element name="StateAll" type="StateType"/>' +
    '<xs:element name="Ratio" type="TwoPlaceRatioType"/>' +
    '<xs:element name="Count" type="xs:positiveInteger"/>' +
    '<xs:element name="PosCount" type="CountType"/>' +
    '<xs:element name="Loop" type="LoopAType"/>' +
    restricted('InlineOnNamed', 'ShortTextType', '<xs:minLength value="2"/>'),
  // Mirrors the production set's USDecimalAmountPosType → DecimalNNType chain.
  namedType('DecimalNNType', 'xs:decimal', '<xs:fractionDigits value="2"/><xs:minInclusive value="0.00"/>') +
    namedType('DecimalAmountPosType', 'DecimalNNType', '<xs:totalDigits value="17"/><xs:minExclusive value="0"/>') +
    namedType('TextType', 'xs:string', '<xs:pattern value="[A-Za-z0-9 ]*"/>') +
    namedType('ShortTextType', 'TextType', '<xs:maxLength value="35"/>') +
    namedType('CodeType', 'ShortTextType', '<xs:maxLength value="10"/><xs:pattern value="[A-Z]{3}"/>') +
    namedType('StateType', 'xs:string', '<xs:enumeration value="CA"/><xs:enumeration value="HI"/><xs:enumeration value="NY"/>') +
    namedType('StateSubsetType', 'StateType', '<xs:enumeration value="HI"/>') +
    namedType('RatioType', 'xs:decimal', '<xs:fractionDigits value="5"/><xs:minInclusive value="0.00000"/><xs:maxInclusive value="1.00000"/>') +
    namedType('TwoPlaceRatioType', 'RatioType', '<xs:fractionDigits value="2"/>') +
    namedType('CountType', 'xs:positiveInteger', '<xs:totalDigits value="3"/>') +
    namedType('LoopAType', 'LoopBType', '<xs:maxLength value="5"/>') +
    namedType('LoopBType', 'LoopAType', '<xs:minLength value="1"/>'),
);

test('facets are inherited from every named base type, most-derived first', () => {
  assert.deepEqual(
    inherited.PosAmount.validationRules,
    rules(['totalDigits', '17'], ['minExclusive', '0'], ['fractionDigits', '2'], ['minInclusive', '0.00']),
  );
  // The inherited fractionDigits is what lets the exclusive bound reach the control.
  assert.deepEqual(inputConstraints(inherited.PosAmount), { step: '0.01', min: '0.01', maxTotalDigits: 17 });
  assert.equal(validateFieldValue('0', inherited.PosAmount).valid, false);
  assert.equal(validateFieldValue('0.001', inherited.PosAmount).valid, false, 'inherited fractionDigits applies');
  assert.equal(validateFieldValue('0.01', inherited.PosAmount).valid, true);
});

test('a restated facet replaces the base one; patterns accumulate across steps instead', () => {
  assert.deepEqual(inherited.Code.validationRules, rules(['maxLength', '10'], ['pattern', '[A-Z]{3}'], ['pattern', '[A-Za-z0-9 ]*']));
  assert.equal(validateFieldValue('ABC', inherited.Code).valid, true);
  assert.equal(validateFieldValue('ABCD', inherited.Code).valid, false);
});

test('a derived maxLength is synthesized from the tightest bounded pattern in the chain', () => {
  const el = parseInline(
    '<xs:element name="Z" type="ZipType"/>',
    namedType('PrintableType', 'xs:string', '<xs:pattern value="[!-~]*"/>') +
      namedType('ZipType', 'PrintableType', '<xs:pattern value="[0-9]{5}"/>'),
  ).Z;
  assert.deepEqual(el.validationRules.at(-1), { kind: 'maxLength', value: '5', derived: true });
});

test('an inline simpleType restricting a named type inherits from it', () => {
  assert.deepEqual(inherited.InlineOnNamed.validationRules, rules(['minLength', '2'], ['maxLength', '35'], ['pattern', '[A-Za-z0-9 ]*']));
});

test('enumerations come from the most-derived step that has any', () => {
  assert.deepEqual(inherited.State.enumerationValues.map((e) => e.value), ['HI']);
  assert.deepEqual(inherited.StateAll.enumerationValues.map((e) => e.value), ['CA', 'HI', 'NY']);
  const plain = parseInline('<xs:element name="S" type="ShortStateType"/>', namedType('StateType', 'xs:string', '<xs:enumeration value="CA"/><xs:enumeration value="HI"/>') + namedType('ShortStateType', 'StateType', '<xs:maxLength value="2"/>')).S;
  assert.equal(plain.kind, 'Dropdown', 'a restriction that only adds maxLength keeps the base enumeration');
  assert.deepEqual(plain.enumerationValues.map((e) => e.value), ['CA', 'HI']);
});

test('inclusive bounds are snapped onto the derived fractionDigits grid', () => {
  // RatioType's "0.00000" under fractionDigits 2: the same number, in a form the field accepts.
  assert.deepEqual(inputConstraints(inherited.Ratio), { step: '0.01', min: '0.00', max: '1.00' });
  const off = leaf('DecimalInput', rules(['minInclusive', '0.005'], ['maxInclusive', '9.999'], ['fractionDigits', '2']));
  assert.deepEqual(inputConstraints(off), { step: '0.01', min: '0.01', max: '9.99' });
});

test('nothing is inferred from a built-in type the schema did not restrict', () => {
  assert.deepEqual(inherited.Count.validationRules, []);
  assert.equal('min' in inputConstraints(inherited.Count), false);
  assert.equal(validateFieldValue('-5', inherited.Count).valid, true);
  assert.deepEqual(inherited.PosCount.validationRules, rules(['totalDigits', '3']));
});

test('a restriction cycle terminates', () => {
  assert.deepEqual(inherited.Loop.validationRules, rules(['maxLength', '5'], ['minLength', '1']));
});

// ---------------------------------------------------------------------------
// Validation of the three new facets
// ---------------------------------------------------------------------------

test('length requires the exact character count', () => {
  const el = leaf('TextInput', rules(['length', '9']));
  assert.equal(validateFieldValue('12345678', el).valid, false);
  assert.equal(validateFieldValue('1234567890', el).valid, false);
  assert.equal(validateFieldValue('123456789', el).valid, true);
  assert.equal(validateFieldValue('12345678', el).message, 'Exact length: 9');
});

test('minExclusive / maxExclusive reject the bound itself', () => {
  const over = leaf('NumericInput', rules(['minExclusive', '1000']));
  assert.equal(validateFieldValue('1000', over).valid, false);
  assert.equal(validateFieldValue('1000', over).message, 'Must be greater than 1000');
  assert.equal(validateFieldValue('1001', over).valid, true);

  const under = leaf('DecimalInput', rules(['maxExclusive', '100']));
  assert.equal(validateFieldValue('100', under).valid, false);
  assert.equal(validateFieldValue('100.00', under).valid, false);
  assert.equal(validateFieldValue('99.99', under).valid, true);
  assert.equal(validateFieldValue('100', under).message, 'Must be less than 100');
});

test('range facets on a date compare chronologically instead of silently passing', () => {
  const el = leaf('DatePicker', rules(['minInclusive', '2020-01-01'], ['maxExclusive', '2030-01-01']), { xsdDataType: 'xs:date' });
  assert.equal(validateFieldValue('2019-12-31', el).valid, false);
  assert.equal(validateFieldValue('2020-01-01', el).valid, true);
  assert.equal(validateFieldValue('2029-12-31', el).valid, true);
  assert.equal(validateFieldValue('2030-01-01', el).valid, false);
});

test('a range facet on a non-numeric value fails no range check (the value check owns that)', () => {
  const el = leaf('TextInput', rules(['minExclusive', '5']));
  assert.equal(validateFieldValue('abc', el).valid, true);
});

test('digit counting is shared by validation and the typing guard', () => {
  assert.equal(totalDigitCount('-0012.50'), 4); // leading zeros are not significant
  assert.equal(totalDigitCount('+123'), 3);
  assert.equal(fractionDigitCount('12.345'), 3);
  assert.equal(fractionDigitCount('12'), 0);
});

// ---------------------------------------------------------------------------
// Native input constraints (parity 1.8)
// ---------------------------------------------------------------------------

test('TextInput: length sets both bounds; the tighter of length/maxLength/minLength wins', () => {
  assert.deepEqual(inputConstraints(leaf('TextInput', rules(['length', '9']))), { maxLength: 9, minLength: 9 });
  assert.deepEqual(inputConstraints(leaf('TextInput', rules(['minLength', '2'], ['maxLength', '35']))), { maxLength: 35, minLength: 2 });
  assert.deepEqual(inputConstraints(leaf('TextInput', [])), {});
});

test('TextInput: the pattern attribute is set only when the browser could compile it', () => {
  assert.equal(inputConstraints(leaf('TextInput', rules(['pattern', '[0-9]{9}']))).pattern, '[0-9]{9}');
  assert.equal(inputConstraints(leaf('TextInput', rules(['pattern', "[A-Za-z0-9'\\-]+"]))).pattern, "[A-Za-z0-9'\\-]+");
  // Valid in legacy JS regex mode (so validation still checks it), invalid
  // under the `v` flag browsers use for `pattern` — an unescaped trailing '-'.
  assert.equal(isHtmlCompatiblePattern('[a-]'), false);
  assert.equal('pattern' in inputConstraints(leaf('TextInput', rules(['pattern', '[a-]']))), false);
  assert.equal(validateFieldValue('b', leaf('TextInput', rules(['pattern', '[a-]']))).valid, false);
});

test('NumericInput: integer step, inclusive bounds, exclusive bounds nudged one step in', () => {
  assert.deepEqual(
    inputConstraints(leaf('NumericInput', rules(['minInclusive', '0'], ['maxInclusive', '99']))),
    { step: '1', min: '0', max: '99' },
  );
  assert.deepEqual(
    inputConstraints(leaf('NumericInput', rules(['totalDigits', '15'], ['minExclusive', '1000']))),
    { step: '1', min: '1001', maxTotalDigits: 15 },
  );
  // Both kinds of bound present: the tighter one wins.
  assert.equal(inputConstraints(leaf('NumericInput', rules(['minInclusive', '5'], ['minExclusive', '10']))).min, '11');
  assert.equal(inputConstraints(leaf('NumericInput', rules(['minInclusive', '50'], ['minExclusive', '10']))).min, '50');
});

test('DecimalInput: step from fractionDigits; exclusive bounds nudged only on a discrete grid', () => {
  assert.deepEqual(
    inputConstraints(leaf('DecimalInput', rules(['maxExclusive', '100'], ['fractionDigits', '2']))),
    { step: '0.01', max: '99.99' },
  );
  assert.equal(inputConstraints(leaf('DecimalInput', rules(['minExclusive', '0.1'], ['fractionDigits', '2']))).min, '0.11');
  assert.equal(inputConstraints(leaf('DecimalInput', rules(['fractionDigits', '0']))).step, '1');
  // No fractionDigits → no "next value" above an exclusive bound; left to validation.
  assert.deepEqual(inputConstraints(leaf('DecimalInput', rules(['minExclusive', '0'], ['totalDigits', '17']))), { step: 'any', maxTotalDigits: 17 });
});

test('DatePicker: plain xs:date bounds become min/max; dateTime and exclusive bounds do not', () => {
  const date = rules(['minInclusive', '2020-01-01'], ['maxInclusive', '2030-12-31']);
  assert.deepEqual(inputConstraints(leaf('DatePicker', date, { xsdDataType: 'xs:date' })), { min: '2020-01-01', max: '2030-12-31' });
  assert.deepEqual(inputConstraints(leaf('DatePicker', rules(['minInclusive', '2020-01-01T00:00:00Z']), { xsdDataType: 'xs:dateTime' })), {});
  assert.deepEqual(inputConstraints(leaf('DatePicker', rules(['minExclusive', '2020-01-01']), { xsdDataType: 'xs:date' })), {});
});

test('rejectsEdit refuses only edits that push past a limit or deepen an overrun', () => {
  const c = { maxTotalDigits: 5 };
  assert.equal(rejectsEdit('12345', '123456', c), true);
  assert.equal(rejectsEdit('1234', '12345', c), false);
  assert.equal(rejectsEdit('-1234', '-12345', c), false, 'sign does not count as a digit');
  assert.equal(rejectsEdit('123.4', '123.45', c), false, 'point does not count as a digit');
  // Already over (loaded from XML): deleting back toward the limit is allowed.
  assert.equal(rejectsEdit('1234567', '123456', c), false);
  assert.equal(rejectsEdit('1234567', '12345678', c), true);
  assert.equal(rejectsEdit('', '', c), false);

  const len = { maxLength: 3 };
  assert.equal(rejectsEdit('abc', 'abcd', len), true);
  assert.equal(rejectsEdit('abcde', 'abcd', len), false);
});

// ---------------------------------------------------------------------------
// Test-data fill honors the new facets
// ---------------------------------------------------------------------------

test('generated values satisfy length and the exclusive bounds', () => {
  const values = generateValues(
    {
      elementName: 'Root', kind: 'Section', children: [parsed.Cusip, parsed.Over1000, parsed.Below],
      validationRules: [], enumerationValues: [], isRequired: true, elementPath: 'Root',
    },
    {},
  ).values;
  for (const el of [parsed.Cusip, parsed.Over1000, parsed.Below]) {
    const value = values[`root.${el.elementName.toLowerCase()}`];
    assert.ok(value !== undefined, `${el.elementName} was filled`);
    assert.equal(validateFieldValue(value, el).valid, true, `${el.elementName} = ${JSON.stringify(value)}`);
  }
});

test('generated values satisfy inherited facets, padding with a pattern-legal character', () => {
  const port = parseInline(
    '<xs:element name="Port" type="PortType"/><xs:element name="Ratio" type="TwoPlaceRatioType"/>',
    namedType('NumericType', 'xs:string', '<xs:pattern value="[0-9]*"/>') +
      namedType('PortType', 'NumericType', '<xs:minLength value="1"/><xs:maxLength value="5"/>') +
      namedType('RatioType', 'xs:decimal', '<xs:fractionDigits value="5"/><xs:minInclusive value="0.00000"/>') +
      namedType('TwoPlaceRatioType', 'RatioType', '<xs:fractionDigits value="2"/>'),
  );
  const root = {
    elementName: 'Root', kind: 'Section', children: [port.Port, port.Ratio],
    validationRules: [], enumerationValues: [], isRequired: true, elementPath: 'Root',
  };
  const { values } = generateValues(root, {});
  assert.equal(values['root.port'], '0');
  assert.equal(values['root.ratio'], '0.00');
  for (const el of [port.Port, port.Ratio]) {
    assert.equal(validateFieldValue(values[`root.${el.elementName.toLowerCase()}`], el).valid, true, el.elementName);
  }
});
