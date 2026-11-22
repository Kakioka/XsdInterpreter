// test/coloringService.test.mjs — js/core/coloringService.js.
//
// The pure half of dev/phase4-check.html's section A and dev/phase5-check.html's
// section C, widened: `analyzeForm` is a pure function over (SchemaElement,
// FormState) that returns BOTH the color map and the completeness/format error
// list, so the container/radio/repeating aggregation paths and the whole
// validation walk can be exercised directly here rather than only through
// rendered DOM.
//
// The two `KNOWN-WRONG` characterization tests that used to live here (no
// activation context; a required repeating section with zero instances coloring
// Green) have been replaced by assertions of the behavior Phase 1 of
// dev/IMPLEMENTATION_ORDER.md introduced — parity 1.1, 1.2 and 1.3 in
// dev/PARITY_GAP_ANALYSIS.md. Their job was to make the rewrite acknowledge
// each change; it did.

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeColor, isFieldValid, validateFieldValue, isEmpty, hasValue, computeAllColors, analyzeForm } from '../js/core/coloringService.js';
import { loadSamplePipeline, emptyFormState } from './helpers/env.mjs';

const { parser } = await loadSamplePipeline();

// ---------------------------------------------------------------------------
// Synthetic trees. The fixture set has no optional container holding a
// required field (every container in SamplePacket.xsd is minOccurs=1), which
// is precisely the shape the activation context exists for — so the activation
// tests build their own minimal nodes rather than contorting a fixture.
// ---------------------------------------------------------------------------

function node(elementName, elementPath, overrides = {}) {
  return {
    elementName,
    elementPath,
    kind: 'TextInput',
    isRequired: false,
    isRepeating: false,
    isGeneratedWrapper: false,
    minOccurs: 0,
    maxOccurs: 1,
    validationRules: [],
    children: [],
    ...overrides,
  };
}

function container(elementName, elementPath, isRequired, children, overrides = {}) {
  return node(elementName, elementPath, { kind: 'GroupContainer', isRequired, minOccurs: isRequired ? 1 : 0, children, ...overrides });
}

function leaf(elementName, elementPath, isRequired, overrides = {}) {
  return node(elementName, elementPath, { isRequired, minOccurs: isRequired ? 1 : 0, ...overrides });
}

/** Root (required)
 *    RequiredField      required leaf
 *    OptionalSection    optional container — has a required child, so filling
 *                       anything inside it ACTIVATES it
 *      SectionRequired  required leaf
 *      SectionOptional  optional leaf
 *    AllOptionalSection optional container whose children are ALL optional,
 *                       so filling one never activates it
 *      OptA / OptB      optional leaves (OptA caps at 2 characters)
 */
function activationTree() {
  return container('Root', 'Root', true, [
    leaf('RequiredField', 'Root.RequiredField', true),
    container('OptionalSection', 'Root.OptionalSection', false, [
      leaf('SectionRequired', 'Root.OptionalSection.SectionRequired', true),
      leaf('SectionOptional', 'Root.OptionalSection.SectionOptional', false),
    ]),
    container('AllOptionalSection', 'Root.AllOptionalSection', false, [
      leaf('OptA', 'Root.AllOptionalSection.OptA', false, { validationRules: [{ kind: 'maxLength', value: '2' }] }),
      leaf('OptB', 'Root.AllOptionalSection.OptB', false),
    ]),
  ]);
}

const paths = (errors) => errors.map((e) => `${e.kind}:${e.path}`);

// ---------------------------------------------------------------------------
// Field-level predicates
// ---------------------------------------------------------------------------

test('isEmpty / hasValue treat undefined, null and "" as empty and nothing else', () => {
  for (const v of [undefined, null, '']) {
    assert.equal(isEmpty(v), true);
    assert.equal(hasValue(v), false);
  }
  for (const v of [0, false, 'x', ' ']) {
    assert.equal(isEmpty(v), false, `${JSON.stringify(v)} is a value, not emptiness`);
  }
});

test('validateFieldValue is the single facet switch; isFieldValid is its verdict-only form', () => {
  const element = { validationRules: [{ kind: 'maxLength', value: '2' }] };
  assert.deepEqual(validateFieldValue('abc', element), { valid: false, message: 'Max length: 2' });
  assert.deepEqual(validateFieldValue('ab', element), { valid: true });
  assert.equal(isFieldValid(element, 'abc'), false);
  assert.equal(isFieldValid(element, 'ab'), true);
});

test('isFieldValid: an empty value is always valid (emptiness is a completeness concern)', () => {
  const element = { validationRules: [{ kind: 'minLength', value: '5' }] };
  assert.equal(isFieldValid(element, ''), true);
  assert.equal(isFieldValid(element, 'abc'), false);
});

test('isFieldValid enforces each facet kind', () => {
  const rule = (kind, value) => ({ validationRules: [{ kind, value }] });

  assert.equal(isFieldValid(rule('minLength', '3'), 'ab'), false);
  assert.equal(isFieldValid(rule('minLength', '3'), 'abc'), true);
  assert.equal(isFieldValid(rule('maxLength', '3'), 'abcd'), false);
  assert.equal(isFieldValid(rule('maxLength', '3'), 'abc'), true);

  // Patterns are anchored on both ends, so a partial match is invalid.
  assert.equal(isFieldValid(rule('pattern', '[A-Z]{2}\\d{4}'), 'AB1234'), true);
  assert.equal(isFieldValid(rule('pattern', '[A-Z]{2}\\d{4}'), 'xAB1234x'), false);

  assert.equal(isFieldValid(rule('minInclusive', '0'), '-1'), false);
  assert.equal(isFieldValid(rule('minInclusive', '0'), '0'), true);
  assert.equal(isFieldValid(rule('maxInclusive', '100'), '101'), false);

  assert.equal(isFieldValid(rule('fractionDigits', '2'), '1.234'), false);
  assert.equal(isFieldValid(rule('fractionDigits', '2'), '1.23'), true);

  assert.equal(isFieldValid(rule('totalDigits', '4'), '12345'), false);
  assert.equal(isFieldValid(rule('totalDigits', '4'), '1234'), true);
  // Leading zeros and sign/decimal punctuation don't count toward totalDigits.
  assert.equal(isFieldValid(rule('totalDigits', '4'), '-012.34'), true);

  // An unknown rule kind is ignored rather than failing the field — the facet
  // extraction in parser.js may know kinds this switch doesn't yet.
  assert.equal(isFieldValid(rule('whiteSpace', 'collapse'), 'x'), true);
});

test('isFieldValid rejects an unparseable date for a DatePicker', () => {
  assert.equal(isFieldValid({ kind: 'DatePicker', validationRules: [] }, 'not-a-date'), false);
  assert.equal(isFieldValid({ kind: 'DatePicker', validationRules: [] }, '2025-12-31'), true);
});

test('computeColor: a required empty field is Red only in an ACTIVE context (parity 1.1)', () => {
  const required = { isRequired: true, validationRules: [] };
  const optional = { isRequired: false, validationRules: [] };

  assert.equal(computeColor(required, '', true), 'Red');
  assert.equal(computeColor(required, '', false), 'Yellow', 'nothing is being asked of the user here yet');
  assert.equal(computeColor(required, ''), 'Red', 'active is the default — an unqualified leaf is in a required context');

  assert.equal(computeColor(optional, '', true), 'Yellow');
  assert.equal(computeColor(optional, '', false), 'Yellow');

  assert.equal(computeColor(optional, 'x', false), 'Green', 'filled + valid is Green whether required, optional, active or not');
  assert.equal(computeColor({ isRequired: false, validationRules: [{ kind: 'maxLength', value: '1' }] }, 'xx', false), 'Red', 'filled + invalid is Red regardless of context');
});

// ---------------------------------------------------------------------------
// Activation context (parity 1.1 / 1.2)
// ---------------------------------------------------------------------------

test('a required field inside an untouched OPTIONAL container colors Yellow and reports nothing (parity 1.1 / 1.2)', () => {
  const { colors, errors } = analyzeForm(activationTree(), emptyFormState());

  assert.equal(colors.get('root.optionalsection'), 'Yellow', 'an untouched optional section is not incomplete');
  assert.equal(colors.get('root.optionalsection.sectionrequired'), 'Yellow', 'and neither is the required field inside it');

  // The form root itself IS a required context, so its own required child does report.
  assert.equal(colors.get('root.requiredfield'), 'Red');
  assert.equal(colors.get('root'), 'Red');
  assert.deepEqual(paths(errors), ['completeness:Root.RequiredField']);
});

test('filling anything inside an optional container activates it, and its required siblings turn Red', () => {
  const state = emptyFormState({ 'root.requiredfield': 'done', 'root.optionalsection.sectionoptional': 'typed' });
  const { colors, errors } = analyzeForm(activationTree(), state);

  assert.equal(colors.get('root.optionalsection.sectionrequired'), 'Red');
  assert.equal(colors.get('root.optionalsection'), 'Red');
  assert.deepEqual(paths(errors), ['completeness:Root.OptionalSection.SectionRequired']);
});

test('a container whose children are ALL optional never activates (the all-optional-children exception)', () => {
  const state = emptyFormState({ 'root.requiredfield': 'done', 'root.alloptionalsection.opta': 'x' });
  const { colors, errors } = analyzeForm(activationTree(), state);

  // Partially filled: nothing is incomplete, but there is still something left
  // to fill, so strict completeness holds it at Yellow rather than Green.
  assert.equal(colors.get('root.alloptionalsection'), 'Yellow');
  assert.deepEqual(paths(errors), []);

  // Filling every child turns it Green — §9's "optional child poisoning" rule
  // survives for optional and inactive containers.
  const full = emptyFormState({ ...state.fieldValues, 'root.alloptionalsection.optb': 'y' });
  assert.equal(analyzeForm(activationTree(), full).colors.get('root.alloptionalsection'), 'Green');
});

test('a format error on a filled field reports even in an inactive context — only emptiness is gated', () => {
  const state = emptyFormState({ 'root.requiredfield': 'done', 'root.alloptionalsection.opta': 'too long' });
  const { colors, errors } = analyzeForm(activationTree(), state);

  assert.equal(colors.get('root.alloptionalsection.opta'), 'Red');
  assert.deepEqual(paths(errors), ['format:Root.AllOptionalSection.OptA']);
});

test('an unchecked checkbox is complete but is not engagement, so it cannot activate a container', () => {
  const tree = container('Root', 'Root', true, [
    container('OptionalSection', 'Root.OptionalSection', false, [
      leaf('Flag', 'Root.OptionalSection.Flag', false, { kind: 'Checkbox' }),
      leaf('Needed', 'Root.OptionalSection.Needed', true),
    ]),
  ]);
  // FormEngine's flush writes `false` for every unchecked checkbox the moment
  // a form renders; if that counted as a value, every container holding one
  // would activate itself and the whole activation context would collapse.
  const { colors, errors } = analyzeForm(tree, emptyFormState({ 'root.optionalsection.flag': false }));

  assert.equal(colors.get('root.optionalsection.flag'), 'Green', 'an unchecked box is answered');
  assert.equal(colors.get('root.optionalsection.needed'), 'Yellow', 'but the section is still untouched');
  assert.deepEqual(paths(errors), []);
});

// ---------------------------------------------------------------------------
// Leaves and containers over the real fixture set
// ---------------------------------------------------------------------------

test('computeAllColors over SampleHeader: leaf colors follow emptiness then validity', () => {
  const header = parser.parseGlobalElement('SampleHeader');

  let colors = computeAllColors(header, emptyFormState());
  assert.equal(colors.get('sampleheader.packetid'), 'Red', 'required + empty, in the form root context');

  colors = computeAllColors(header, emptyFormState({ 'sampleheader.packetid': 'ab1234' }));
  assert.equal(colors.get('sampleheader.packetid'), 'Red', 'filled but pattern-invalid');

  colors = computeAllColors(header, emptyFormState({ 'sampleheader.packetid': 'AB1234' }));
  assert.equal(colors.get('sampleheader.packetid'), 'Green');
});

test('an active REQUIRED container goes Green once its required children are complete (parity 1.1)', () => {
  const entity = parser.parseGlobalElement('SampleEntityForm');
  const prefix = 'SampleEntityForm.RegisteredAddress'; // minOccurs=1, so required

  const allRequiredFilled = emptyFormState({
    [`${prefix}.StreetLine1`.toLowerCase()]: '123 Main St',
    [`${prefix}.City`.toLowerCase()]: 'Honolulu',
    [`${prefix}.StateCode`.toLowerCase()]: 'HI0000',
    [`${prefix}.PostalCode`.toLowerCase()]: '96814',
  });
  // Pre-Phase-1 this was Yellow: the old roll-up required EVERY child to be
  // Green, so an untouched optional StreetLine2 held the container back. A
  // required container now reads Green as soon as nothing REQUIRED is missing.
  assert.equal(computeAllColors(entity, allRequiredFilled).get(prefix.toLowerCase()), 'Green');

  // Filling the optional child and attribute too keeps it Green.
  const everythingFilled = emptyFormState({
    ...allRequiredFilled.fieldValues,
    [`${prefix}.StreetLine2`.toLowerCase()]: 'Suite 100',
    [`${prefix}.addressKind`.toLowerCase()]: 'Physical',
  });
  assert.equal(computeAllColors(entity, everythingFilled).get(prefix.toLowerCase()), 'Green');

  // Breaking one required child's FORMAT flips the container back to Red:
  // container completeness requires each leaf to be present AND valid, which
  // is how §9's filled-but-invalid rule survives the roll-up.
  const broken = emptyFormState({ ...everythingFilled.fieldValues, [`${prefix}.PostalCode`.toLowerCase()]: 'not-digits' });
  assert.equal(computeAllColors(entity, broken).get(prefix.toLowerCase()), 'Red');

  // And one missing required child is still Red.
  const partial = emptyFormState({ [`${prefix}.StreetLine1`.toLowerCase()]: '123 Main St' });
  assert.equal(computeAllColors(entity, partial).get(prefix.toLowerCase()), 'Red');
});

// ---------------------------------------------------------------------------
// Radio groups
// ---------------------------------------------------------------------------

test('radio groups: only the SELECTED branch is evaluated; hidden branch data is ignored (§9)', () => {
  const entity = parser.parseGlobalElement('SampleEntityForm');
  const choicePath = 'SampleEntityForm.EntityTypeChoice.EntityTypeChoiceChoice';
  const option2 = `${choicePath}.EntityTypeChoiceChoiceOption2`;

  // Unselected and required, in the form root's active context.
  assert.equal(computeAllColors(entity, emptyFormState()).get(choicePath.toLowerCase()), 'Red');

  // Selected, but the branch's own required fields are empty.
  const selectedEmpty = emptyFormState({}, { [choicePath.toLowerCase()]: option2 });
  assert.equal(computeAllColors(entity, selectedEmpty).get(choicePath.toLowerCase()), 'Red');

  // Selected branch's required fields satisfied; its optional OrgFoundedYear
  // is untouched. A required radio group's Green threshold is "required
  // covered", same as a required container's.
  const selectedFilled = emptyFormState(
    { [`${option2}.OrgLegalName`.toLowerCase()]: 'Acme Test Co', [`${option2}.OrgType`.toLowerCase()]: 'Corporation' },
    { [choicePath.toLowerCase()]: option2 }
  );
  let colors = computeAllColors(entity, selectedFilled);
  assert.equal(colors.get(choicePath.toLowerCase()), 'Green');
  // The branch wrapper itself is colored too (ui/coloring.js indexes
  // .branch-content[data-path]) and is optional, so it holds at Yellow until
  // OrgFoundedYear is filled as well.
  assert.equal(colors.get(option2.toLowerCase()), 'Yellow');

  // Now put a value in the HIDDEN Option1 branch while leaving ITS other
  // required fields empty. Only the selected branch counts, so the group must
  // stay Green.
  const withHiddenBranchData = emptyFormState(
    {
      ...selectedFilled.fieldValues,
      [`${choicePath}.EntityTypeChoiceChoiceOption1.IndividualFirstName`.toLowerCase()]: 'Jane',
    },
    { [choicePath.toLowerCase()]: option2 }
  );
  assert.equal(computeAllColors(entity, withHiddenBranchData).get(choicePath.toLowerCase()), 'Green');
});

test('radio groups: two populated branches is reported, and an unselected required group is', () => {
  const entity = parser.parseGlobalElement('SampleEntityForm');
  const choicePath = 'SampleEntityForm.EntityTypeChoice.EntityTypeChoiceChoice';
  const option1 = `${choicePath}.EntityTypeChoiceChoiceOption1`;
  const option2 = `${choicePath}.EntityTypeChoiceChoiceOption2`;

  const unselected = analyzeForm(entity, emptyFormState()).errors.filter((e) => e.path === choicePath);
  assert.deepEqual(unselected, [{ path: choicePath, kind: 'completeness', message: 'A selection is required' }]);

  const bothPopulated = emptyFormState(
    {
      [`${option1}.IndividualFirstName`.toLowerCase()]: 'Jane',
      [`${option2}.OrgLegalName`.toLowerCase()]: 'Acme Test Co',
      [`${option2}.OrgType`.toLowerCase()]: 'Corporation',
    },
    { [choicePath.toLowerCase()]: option2 }
  );
  const choiceErrors = analyzeForm(entity, bothPopulated).errors.filter((e) => e.kind === 'choice');
  assert.equal(choiceErrors.length, 1);
  assert.match(choiceErrors[0].message, /only one branch/);
});

test('an explicitly selected branch is an active context even inside an untouched optional container', () => {
  // The reference app disagrees with itself here: its coloring walk treats the
  // selection as activation while its completeness walk skips radio groups
  // under inactive containers, so the branch paints Red and Validate says
  // nothing. One walk, one answer — both follow the coloring side.
  const optionPath = 'Root.OptionalSection.Choice.Option1';
  const tree = container('Root', 'Root', true, [
    container('OptionalSection', 'Root.OptionalSection', false, [
      node('Choice', 'Root.OptionalSection.Choice', {
        kind: 'RadioGroup',
        isRequired: false,
        children: [
          node('Option1', optionPath, {
            kind: 'SequenceContainer',
            isGeneratedWrapper: true,
            children: [leaf('BranchRequired', `${optionPath}.BranchRequired`, true)],
          }),
        ],
      }),
    ]),
  ]);

  const unselected = analyzeForm(tree, emptyFormState());
  // An unselected branch isn't walked at all, so its fields get no color —
  // they're hidden in the DOM, and ui/coloring.js clears the classes of any
  // indexed element the map has no entry for.
  assert.equal(unselected.colors.has(`${optionPath}.BranchRequired`.toLowerCase()), false);
  assert.equal(unselected.colors.get('root.optionalsection.choice'), 'Yellow', 'an optional unselected group is fine to leave alone');
  assert.deepEqual(paths(unselected.errors), [], 'nothing selected, nothing asked for');

  const selected = analyzeForm(tree, emptyFormState({}, { 'root.optionalsection.choice': optionPath }));
  assert.equal(selected.colors.get(`${optionPath}.BranchRequired`.toLowerCase()), 'Red');
  assert.deepEqual(paths(selected.errors), [`completeness:${optionPath}.BranchRequired`]);
});

test('radio groups: a stale/unresolvable selection yields null rather than throwing', () => {
  const entity = parser.parseGlobalElement('SampleEntityForm');
  const choicePath = 'SampleEntityForm.EntityTypeChoice.EntityTypeChoiceChoice';
  const colors = computeAllColors(entity, emptyFormState({}, { [choicePath.toLowerCase()]: 'Some.Path.That.No.Longer.Exists' }));
  assert.equal(colors.get(choicePath.toLowerCase()), null);
});

// ---------------------------------------------------------------------------
// Repeating sections
// ---------------------------------------------------------------------------

test('repeating sections: each instance is colored at its own [i] path, in an active context', () => {
  const entity = parser.parseGlobalElement('SampleEntityForm');
  const entryPath = 'sampleentityform.priornamelist.priornamelistentry';

  const state = emptyFormState(
    {
      // The entry's required fields are FormerName and NameUsedUntil;
      // NameChangeReason is optional. Instance [0] satisfies both required
      // ones, instance [1] neither.
      [`${entryPath}[0].formername`]: 'First',
      [`${entryPath}[0].nameuseduntil`]: '2020-01-01',
    },
    {},
    { priornamelistentry: 2 }
  );
  const { colors, errors } = analyzeForm(entity, state);

  // An existing row is always an active context — the user created it — and
  // the entry wrapper is required, so "required covered" is the Green bar.
  assert.equal(colors.get(`${entryPath}[0]`), 'Green');
  assert.equal(colors.get(`${entryPath}[1]`), 'Red');
  assert.equal(colors.get(entryPath), 'Red', 'any instance Red → the whole list Red');
  assert.deepEqual(
    paths(errors).filter((p) => p.toLowerCase().includes('priorname')),
    ['completeness:SampleEntityForm.PriorNameList.PriorNameListEntry[1].FormerName', 'completeness:SampleEntityForm.PriorNameList.PriorNameListEntry[1].NameUsedUntil']
  );

  // Filling every field of the one remaining instance rolls Green all the way
  // up through the entry wrapper to PriorNameList.
  const complete = emptyFormState(
    { ...state.fieldValues, [`${entryPath}[0].namechangereason`]: 'Rebrand' },
    {},
    { priornamelistentry: 1 }
  );
  const completeColors = computeAllColors(entity, complete);
  assert.equal(completeColors.get(`${entryPath}[0]`), 'Green');
  assert.equal(completeColors.get(entryPath), 'Green');
  assert.equal(completeColors.get('sampleentityform.priornamelist'), 'Green');
});

test('a blank row the user just added is Red and reports — it must not reach the XML silently', () => {
  const entity = parser.parseGlobalElement('SampleEntityForm');
  const entryPath = 'sampleentityform.priornamelist.priornamelistentry';
  const { colors, errors } = analyzeForm(entity, emptyFormState({}, {}, { priornamelistentry: 1 }));

  assert.equal(colors.get(`${entryPath}[0]`), 'Red');
  assert.equal(colors.get('sampleentityform.priornamelist'), 'Red', 'adding a row activates the optional list that holds it');
  assert.deepEqual(
    paths(errors).filter((p) => p.toLowerCase().includes('priorname')),
    ['completeness:SampleEntityForm.PriorNameList.PriorNameListEntry[0].FormerName', 'completeness:SampleEntityForm.PriorNameList.PriorNameListEntry[0].NameUsedUntil']
  );
});

test('an OPTIONAL repeating section with zero instances colors Yellow and reports nothing', () => {
  const entity = parser.parseGlobalElement('SampleEntityForm');
  // PriorNameList itself is minOccurs="0" — nothing is incomplete about
  // leaving it alone, so it must not read Red, and its entry wrapper's own
  // minOccurs=1 must not become an occurrence error either (parity 1.2).
  const { colors, errors } = analyzeForm(entity, emptyFormState());
  assert.equal(colors.get('sampleentityform.priornamelist'), 'Yellow');
  assert.equal(colors.get('sampleentityform.priornamelist.priornamelistentry'), 'Yellow');
  assert.deepEqual(
    paths(errors).filter((p) => p.toLowerCase().includes('priorname')),
    []
  );
});

test('a REQUIRED repeating section with zero instances colors Red, never Green (parity 1.3)', () => {
  // Before Phase 1 this was Green: colorOfRepeatingEntry aggregated an empty
  // instance list and computeContainerColor(true, []) answered Green, so a
  // required list the user had never added a row to read as COMPLETE — while
  // the validator simultaneously reported an occurrence error for it. The two
  // walks are one walk now, so that contradiction is not expressible.
  const tree = container('List', 'List', true, [
    node('ListEntry', 'List.ListEntry', {
      kind: 'SequenceContainer',
      isRequired: true,
      isRepeating: true,
      isGeneratedWrapper: true,
      minOccurs: 1,
      maxOccurs: null,
      children: [leaf('Name', 'List.ListEntry.Name', true)],
    }),
  ]);

  const { colors, errors } = analyzeForm(tree, emptyFormState());
  assert.equal(colors.get('list.listentry'), 'Red');
  assert.equal(colors.get('list'), 'Red');
  assert.deepEqual(paths(errors), ['occurrence:List.ListEntry']);
  assert.match(errors[0].message, /At least 1 required, found 0/);
});

test('occurrence bounds: too few is activation-gated, too many always reports', () => {
  const entry = (overrides) =>
    container('List', 'List', false, [
      node('ListEntry', 'List.ListEntry', {
        kind: 'SequenceContainer',
        isRepeating: true,
        isGeneratedWrapper: true,
        isRequired: true,
        minOccurs: 2,
        maxOccurs: 3,
        children: [leaf('Name', 'List.ListEntry.Name', false)],
        ...overrides,
      }),
    ]);

  // Untouched optional list: its minimum is not the user's problem yet.
  assert.deepEqual(paths(analyzeForm(entry({}), emptyFormState()).errors), []);

  // One row added — the list is active now, and one row is below the minimum.
  const under = analyzeForm(entry({}), emptyFormState({}, {}, { listentry: 1 })).errors;
  assert.deepEqual(paths(under), ['occurrence:List.ListEntry']);
  assert.match(under[0].message, /At least 2 required, found 1/);

  // Over the maximum is a data error the schema forbids outright.
  const over = analyzeForm(entry({}), emptyFormState({}, {}, { listentry: 4 })).errors;
  assert.equal(over.filter((e) => /At most 3 allowed, found 4/.test(e.message)).length, 1);
});

// ---------------------------------------------------------------------------
// One walk, two outputs (backlog A.2)
// ---------------------------------------------------------------------------

test('analyzeForm returns the colors and the errors from one traversal, and they agree', () => {
  const entity = parser.parseGlobalElement('SampleEntityForm');
  const { colors, errors } = analyzeForm(entity, emptyFormState());

  assert.ok(colors.size > 0 && errors.length > 0);
  // Every completeness error's path is colored Red, and nothing colored Green
  // carries an error — the class of contradiction merging the walks removes.
  for (const err of errors) {
    assert.equal(colors.get(err.path.toLowerCase()), 'Red', `${err.path} reports "${err.message}" but is colored ${colors.get(err.path.toLowerCase())}`);
  }
  const errorPaths = new Set(errors.map((e) => e.path.toLowerCase()));
  for (const [path, color] of colors) {
    if (color === 'Green') assert.equal(errorPaths.has(path), false, `${path} is Green but also reports an error`);
  }
});

test('computeAllColors is analyzeForm\'s color map — the colors-only entry point', () => {
  const header = parser.parseGlobalElement('SampleHeader');
  const state = emptyFormState({ 'sampleheader.packetid': 'AB1234' });
  assert.deepEqual([...computeAllColors(header, state)], [...analyzeForm(header, state).colors]);
});
