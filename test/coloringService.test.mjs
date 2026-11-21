// test/coloringService.test.mjs — js/core/coloringService.js.
//
// The pure half of dev/phase4-check.html's section A, widened: the browser
// harness reaches most coloring rules only through rendered DOM, whereas
// computeAllColors is a pure function over (SchemaElement, FormState) and can
// be exercised directly here — including the container/radio/repeating
// aggregation paths and the known-wrong cases CLAUDE.md flags.
//
// NOTE: several assertions below pin CURRENT behavior that
// dev/PARITY_GAP_ANALYSIS.md Tier 1 says is wrong (no activation context; a
// required repeating section with zero instances colors Green). They are
// marked, and are here on purpose: Phase 1 of dev/IMPLEMENTATION_ORDER.md is
// the activation-context rewrite, and a characterization test that fails
// loudly when that behavior changes is exactly what makes that rewrite safe.

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeColor, computeContainerColor, isFieldValid, isEmpty, hasValue, computeAllColors } from '../js/core/coloringService.js';
import { loadSamplePipeline, emptyFormState } from './helpers/env.mjs';

const { parser } = await loadSamplePipeline();

test('isEmpty / hasValue treat undefined, null and "" as empty and nothing else', () => {
  for (const v of [undefined, null, '']) {
    assert.equal(isEmpty(v), true);
    assert.equal(hasValue(v), false);
  }
  for (const v of [0, false, 'x', ' ']) {
    assert.equal(isEmpty(v), false, `${JSON.stringify(v)} is a value, not emptiness`);
  }
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

test('computeColor: Red for required-and-empty, Yellow for optional-and-empty, Green for filled-and-valid (§9)', () => {
  const required = { isRequired: true, validationRules: [] };
  const optional = { isRequired: false, validationRules: [] };
  assert.equal(computeColor(required, ''), 'Red');
  assert.equal(computeColor(optional, ''), 'Yellow');
  assert.equal(computeColor(optional, 'x'), 'Green', 'filled + valid is Green whether required or not');
  assert.equal(computeColor({ isRequired: false, validationRules: [{ kind: 'maxLength', value: '1' }] }, 'xx'), 'Red');
});

test('computeContainerColor: all-Green wins, any-Red loses, otherwise Yellow', () => {
  assert.equal(computeContainerColor(true, ['Green', 'Green']), 'Green');
  assert.equal(computeContainerColor(true, ['Green', 'Red']), 'Red');
  assert.equal(computeContainerColor(true, ['Green', 'Yellow']), 'Yellow');
  assert.equal(computeContainerColor(true, ['Yellow', 'Red']), 'Red');
  // No scoreable descendants at all: a required container reads Green, an
  // optional one Yellow.
  assert.equal(computeContainerColor(true, []), 'Green');
  assert.equal(computeContainerColor(false, []), 'Yellow');
});

test('computeAllColors over SampleHeader: leaf colors follow emptiness then validity', () => {
  const header = parser.parseGlobalElement('SampleHeader');

  let colors = computeAllColors(header, emptyFormState());
  assert.equal(colors.get('sampleheader.packetid'), 'Red', 'required + empty');

  colors = computeAllColors(header, emptyFormState({ 'sampleheader.packetid': 'ab1234' }));
  assert.equal(colors.get('sampleheader.packetid'), 'Red', 'filled but pattern-invalid');

  colors = computeAllColors(header, emptyFormState({ 'sampleheader.packetid': 'AB1234' }));
  assert.equal(colors.get('sampleheader.packetid'), 'Green');
});

test('computeAllColors over a container: one untouched optional child caps it at Yellow', () => {
  const entity = parser.parseGlobalElement('SampleEntityForm');
  const prefix = 'SampleEntityForm.RegisteredAddress';

  const allRequiredFilled = emptyFormState({
    [`${prefix}.StreetLine1`.toLowerCase()]: '123 Main St',
    [`${prefix}.City`.toLowerCase()]: 'Honolulu',
    [`${prefix}.StateCode`.toLowerCase()]: 'HI0000',
    [`${prefix}.PostalCode`.toLowerCase()]: '96814',
  });
  assert.equal(computeAllColors(entity, allRequiredFilled).get(prefix.toLowerCase()), 'Yellow');

  // Filling the last optional child (and its optional attribute) turns it Green.
  const everythingFilled = emptyFormState({
    ...allRequiredFilled.fieldValues,
    [`${prefix}.StreetLine2`.toLowerCase()]: 'Suite 100',
    [`${prefix}.addressKind`.toLowerCase()]: 'Physical',
  });
  assert.equal(computeAllColors(entity, everythingFilled).get(prefix.toLowerCase()), 'Green');

  // Breaking one required child's format flips the container back to Red.
  const broken = emptyFormState({ ...everythingFilled.fieldValues, [`${prefix}.PostalCode`.toLowerCase()]: 'not-digits' });
  assert.equal(computeAllColors(entity, broken).get(prefix.toLowerCase()), 'Red');
});

test('radio groups: only the SELECTED branch is evaluated; hidden branch data is ignored (§9)', () => {
  const entity = parser.parseGlobalElement('SampleEntityForm');
  const choicePath = 'SampleEntityForm.EntityTypeChoice.EntityTypeChoiceChoice';
  const option2 = `${choicePath}.EntityTypeChoiceChoiceOption2`;

  // Unselected and required reads like an empty required leaf.
  assert.equal(computeAllColors(entity, emptyFormState()).get(choicePath.toLowerCase()), 'Red');

  // Selected, but the branch's own required fields are empty.
  const selectedEmpty = emptyFormState({}, { [choicePath.toLowerCase()]: option2 });
  assert.equal(computeAllColors(entity, selectedEmpty).get(choicePath.toLowerCase()), 'Red');

  // Selected branch satisfied; its optional OrgFoundedYear is untouched → Yellow.
  const selectedFilled = emptyFormState(
    { [`${option2}.OrgLegalName`.toLowerCase()]: 'Acme Test Co', [`${option2}.OrgType`.toLowerCase()]: 'Corporation' },
    { [choicePath.toLowerCase()]: option2 }
  );
  assert.equal(computeAllColors(entity, selectedFilled).get(choicePath.toLowerCase()), 'Yellow');

  // Now put a value in the HIDDEN Option1 branch while leaving ITS other
  // required fields empty. If coloring aggregated both branches this would go
  // Red; only the selected branch counts, so it must stay Yellow.
  const withHiddenBranchData = emptyFormState(
    {
      ...selectedFilled.fieldValues,
      [`${choicePath}.EntityTypeChoiceChoiceOption1.IndividualFirstName`.toLowerCase()]: 'Jane',
    },
    { [choicePath.toLowerCase()]: option2 }
  );
  assert.equal(computeAllColors(entity, withHiddenBranchData).get(choicePath.toLowerCase()), 'Yellow');
});

test('radio groups: a stale/unresolvable selection yields null rather than throwing', () => {
  const entity = parser.parseGlobalElement('SampleEntityForm');
  const choicePath = 'SampleEntityForm.EntityTypeChoice.EntityTypeChoiceChoice';
  const colors = computeAllColors(entity, emptyFormState({}, { [choicePath.toLowerCase()]: 'Some.Path.That.No.Longer.Exists' }));
  assert.equal(colors.get(choicePath.toLowerCase()), null);
});

test('repeating sections: each instance is colored at its own [i] path', () => {
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
  const colors = computeAllColors(entity, state);

  assert.equal(colors.get(`${entryPath}[0]`), 'Yellow', 'required fields filled, optional one untouched');
  assert.equal(colors.get(`${entryPath}[1]`), 'Red');

  // Filling the optional field too turns instance [0] Green, and the per-
  // instance colors roll up into the entry wrapper and then PriorNameList.
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

test('an OPTIONAL repeating section with zero instances colors Yellow', () => {
  const entity = parser.parseGlobalElement('SampleEntityForm');
  // PriorNameList itself is minOccurs="0" — nothing is incomplete about
  // leaving it alone, so it must not read Red.
  const colors = computeAllColors(entity, emptyFormState());
  assert.equal(colors.get('sampleentityform.priornamelist'), 'Yellow');
});

test('KNOWN-WRONG (parity 1.3): a REQUIRED repeating section with zero instances colors Green', () => {
  // Characterization test, not an endorsement. computeContainerColor(true, [])
  // returns Green, so a required list the user has never added a row to reads
  // as complete. dev/PARITY_GAP_ANALYSIS.md Tier 1 says it should be Red;
  // Phase 1 of dev/IMPLEMENTATION_ORDER.md is where that changes, and this
  // assertion is here to fail loudly when it does.
  const requiredEmptyList = {
    elementName: 'List',
    elementPath: 'List',
    kind: 'GroupContainer',
    isRequired: true,
    isRepeating: false,
    isGeneratedWrapper: false,
    validationRules: [],
    children: [
      {
        elementName: 'ListEntry',
        elementPath: 'List.ListEntry',
        kind: 'SequenceContainer',
        isRequired: true,
        isRepeating: true,
        isGeneratedWrapper: true,
        validationRules: [],
        children: [
          {
            elementName: 'Name',
            elementPath: 'List.ListEntry.Name',
            kind: 'TextInput',
            isRequired: true,
            isRepeating: false,
            isGeneratedWrapper: false,
            validationRules: [],
            children: [],
          },
        ],
      },
    ],
  };
  const colors = computeAllColors(requiredEmptyList, emptyFormState());
  assert.equal(colors.get('list'), 'Green');
});

test('KNOWN-WRONG (parity 1.1): a required field inside an untouched OPTIONAL container still colors Red', () => {
  // No activation context is threaded through the walk (CLAUDE.md,
  // "Known-wrong areas"), so a required field the user has no reason to have
  // visited yet paints Red. The WPF original shows Yellow. Same purpose as the
  // test above: pin it so Phase 1 has to acknowledge the change.
  const entity = parser.parseGlobalElement('SampleEntityForm');
  const colors = computeAllColors(entity, emptyFormState());
  // PriorNameListEntry.FormerName is required, inside optional PriorNameList —
  // but with zero instances there is no [i] path at all, so check the
  // equivalent shape that IS reachable: RegisteredAddress is itself optional
  // while its StreetLine1 child is required.
  assert.equal(colors.get('sampleentityform.registeredaddress.streetline1'), 'Red');
});
