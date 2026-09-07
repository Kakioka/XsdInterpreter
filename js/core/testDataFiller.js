// js/core/testDataFiller.js — Auto-fill with valid sample values.
//
// See web-implementation-spec.md §17 (Test Data Fill), including the
// RegexSampleGenerator for pattern-constrained fields. Implemented in
// IMPLEMENTATION_PLAN.md Phase 6.2.
//
// Pure logic, no DOM dependencies. Reuses the same shared predicates
// (joinPath, isTransparent, isAttribute, isLeaf, isRepeatingContentContainer)
// from parser.js, and the same recursive-dispatch shape, as
// coloringService.js/validation.js's validateSchema/xmlWriter/xmlReader — the
// filler has to agree with all of them on what the schema means and what a
// field's own path is, or generated values would land under keys nothing else
// ever reads.

import { joinPath, isTransparent, isAttribute, isLeaf, isRepeatingContentContainer } from './parser.js';

// ---------------------------------------------------------------------------
// RegexSampleGenerator (§17 "Pattern-Based Generation")
// ---------------------------------------------------------------------------

/**
 * A deliberately small regex-FRAGMENT interpreter — not a real regex engine —
 * that's "just enough to produce a valid sample for common XSD patterns" per
 * §17. Supports exactly the bullet list the spec gives: literal characters,
 * `[...]` character classes (pick the first character in the first range/char
 * listed), `\d` (emit "0"), `{n}`/`{n,m}` quantifiers (repeat the LOWER bound
 * — {n,m}'s upper bound is intentionally ignored, same as the spec's own
 * "repeat n times" wording for both forms), `?` (0 occurrences), `(...)`
 * groups (recurse, and can themselves be quantified), and `|` alternation
 * (always take the first branch — the rest is scanned past, never evaluated).
 *
 * WALKTHROUGH.md's own illustrative example — `generate("[A-Z]{2}[0-9]{4}")`
 * → `"AB0000"` — expects the two letter-class repetitions to advance through
 * the alphabet (A, then B) while the digit-class repetitions all stay "0".
 * That's an asymmetric rule this implementation does not special-case: every
 * repeated character-class pick is the SAME "first in range" character each
 * time (the plain, literal reading of the bullet list above), so this
 * generator produces "AA0000" instead. IMPLEMENTATION_PLAN.md's own Phase 6
 * acceptance criterion already treats WALKTHROUGH's example as illustrative
 * rather than exact — "PacketId → AB0000-shaped" — and "AA0000" is equally
 * pattern-valid (still 2 uppercase letters + 4 digits), which is what
 * actually matters for Phase 5's validator to accept it.
 */
export const RegexSampleGenerator = {
  generate(pattern) {
    if (!pattern) return '';
    try {
      return parseSequence(String(pattern), 0).text;
    } catch {
      return ''; // malformed/unsupported pattern — fail soft rather than throw
    }
  },
};

/** Parses one alternative (the spec always picks the first) starting at
 *  `start`, stopping at an unmatched `)` (left for the caller — a group — to
 *  consume) or the end of the string. If a `|` is hit at this nesting depth,
 *  the rest of the alternatives are scanned past (never evaluated) up to the
 *  matching `)`/end, since only the first branch is ever used. */
function parseSequence(str, start) {
  let i = start;
  let text = '';
  while (i < str.length && str[i] !== ')') {
    if (str[i] === '|') {
      i = skipRemainingAlternatives(str, i);
      break;
    }
    const atom = parseAtom(str, i);
    const quant = parseQuantifier(str, atom.end);
    if (quant) {
      text += atom.text.repeat(Math.max(0, quant.min));
      i = quant.end;
    } else {
      text += atom.text;
      i = atom.end;
    }
  }
  return { text, end: i };
}

function skipRemainingAlternatives(str, i) {
  let depth = 0;
  while (i < str.length) {
    const ch = str[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) break;
      depth--;
    }
    i++;
  }
  return i;
}

function parseAtom(str, i) {
  const ch = str[i];
  if (ch === '(') {
    const inner = parseSequence(str, i + 1); // inner.end points AT the ')'
    return { text: inner.text, end: inner.end + 1 };
  }
  if (ch === '[') {
    const close = str.indexOf(']', i + 1);
    const body = close === -1 ? str.slice(i + 1) : str.slice(i + 1, close);
    return { text: firstCharOfClass(body), end: close === -1 ? str.length : close + 1 };
  }
  if (ch === '\\') {
    const next = str[i + 1];
    return { text: next === 'd' ? '0' : next ?? '', end: i + 2 };
  }
  return { text: ch, end: i + 1 };
}

/** "[a-z]: pick first in range" — the first range's start character, or the
 *  first literal character if the class doesn't open with a range. Negated
 *  classes (`[^...]`) have no positive range to sample from; this codebase's
 *  sample schemas never use one, so it's a defensive, never-exercised
 *  fallback rather than a real implementation. */
function firstCharOfClass(body) {
  let b = body;
  if (b.startsWith('^')) b = b.slice(1);
  if (b.length === 0) return 'X';
  if (b.length >= 3 && b[1] === '-') return b[0];
  return b[0] === '\\' ? b[1] ?? 'X' : b[0];
}

function parseQuantifier(str, i) {
  const ch = str[i];
  if (ch === '?') return { min: 0, end: i + 1 };
  if (ch === '*') return { min: 0, end: i + 1 }; // not in §17's bullet list; a harmless extension for robustness
  if (ch === '+') return { min: 1, end: i + 1 };
  if (ch === '{') {
    const close = str.indexOf('}', i + 1);
    if (close === -1) return null;
    const min = Number(str.slice(i + 1, close).split(',')[0]);
    return { min: Number.isFinite(min) ? min : 1, end: close + 1 };
  }
  return null; // no quantifier — exactly one occurrence, same as plain regex semantics
}

// ---------------------------------------------------------------------------
// Per-Kind Value Generation (§17 "Per-Kind Value Generation")
// ---------------------------------------------------------------------------

function findRule(element, kind) {
  return (element.validationRules || []).find((r) => r.kind === kind);
}

/** Defensive clamp applied to every TextInput-shaped value (name-heuristic OR
 *  pattern-generated) so a co-present minLength/maxLength rule can never be
 *  violated by the generator's own output, even though the fixture set's own
 *  patterns already happen to produce exactly-fitting lengths on their own. */
function clampToLengthRules(value, element) {
  const maxLen = findRule(element, 'maxLength');
  const minLen = findRule(element, 'minLength');
  let v = value;
  if (maxLen && v.length > Number(maxLen.value)) v = v.slice(0, Number(maxLen.value));
  if (minLen && v.length < Number(minLen.value)) v = v.padEnd(Number(minLen.value), 'X');
  return v;
}

/** "Generate a value based on the element name" (§17) — a small, plainly
 *  best-effort keyword heuristic, not an attempt at real NLP. */
function nameBasedTextSample(elementName) {
  const n = elementName.toLowerCase();
  if (n.includes('email')) return 'test@example.com';
  if (n.includes('phone')) return '8085551234';
  if (n.includes('address') || n.includes('street')) return '123 TEST ST';
  if (n.includes('city')) return 'Testville';
  if (n.includes('name')) return 'TESTNAME';
  if (n.includes('title')) return 'Test Title';
  return 'TEST VALUE';
}

function generateLeafValue(element) {
  switch (element.kind) {
    case 'TextInput': {
      const patternRule = findRule(element, 'pattern');
      const raw = patternRule ? RegexSampleGenerator.generate(patternRule.value) : nameBasedTextSample(element.elementName);
      return clampToLengthRules(raw, element);
    }
    case 'NumericInput': {
      const minRule = findRule(element, 'minInclusive');
      return minRule ? String(Math.trunc(Number(minRule.value))) : '1';
    }
    case 'DecimalInput': {
      const minRule = findRule(element, 'minInclusive');
      return minRule ? String(minRule.value) : '0.00';
    }
    case 'DatePicker':
      return element.xsdDataType === 'xs:dateTime' ? '2024-01-01T00:00:00' : '2024-01-01';
    case 'Checkbox':
      return true;
    case 'Dropdown':
      return element.enumerationValues?.[0]?.value ?? '';
    default:
      return clampToLengthRules(nameBasedTextSample(element.elementName), element);
  }
}

// ---------------------------------------------------------------------------
// generateValues (§17 "Algorithm") — recursive tree walk
// ---------------------------------------------------------------------------

function getEffectiveFilter(options) {
  if (options.filter) return options.filter;
  if (options.requiredOnly) return (el) => el.isRequired;
  return null;
}

function fillLeaf(element, path, values, options) {
  const filter = getEffectiveFilter(options);
  if (filter && !filter(element)) return;
  values[path.toLowerCase()] = generateLeafValue(element);
}

/** Picks (or reuses) the branch to fill: an existing selection in
 *  `options.radioSelections` is always honored and descended into — even
 *  under a `requiredOnly` filter, since once a branch IS selected its own
 *  required fields still need values for a clean validation. Only when there
 *  is NO existing selection does `requiredOnly` skip an optional group
 *  entirely, rather than forcing a pick nothing actually requires. */
function fillRadioGroup(element, path, values, radioSelections, options) {
  const choicePath = joinPath(path, element.elementName);
  const existing = options.radioSelections?.[choicePath.toLowerCase()];
  const filter = getEffectiveFilter(options);
  if (!existing && filter && !element.isRequired) return;

  const firstOption = element.children[0];
  if (!firstOption) return;

  let targetOption;
  if (existing) {
    targetOption = element.children.find((o) => joinPath(choicePath, o.elementName).toLowerCase() === String(existing).toLowerCase());
    if (!targetOption) return; // stale/unresolvable selection — defensive, not expected in practice
  } else {
    targetOption = firstOption;
    radioSelections[choicePath.toLowerCase()] = joinPath(choicePath, targetOption.elementName);
  }

  // §22 invariant 29: the option wrapper emits no XML tag but its NAME still
  // contributes a path segment to its children's field keys — recursing with
  // bare `choicePath` here (instead of joinPath(choicePath, targetOption.elementName))
  // was exactly the earlier-draft bug invariant 29 calls out, and would
  // silently strand every generated value under the selected branch at a key
  // nothing registered ever reads.
  const optionPath = joinPath(choicePath, targetOption.elementName);
  for (const child of targetOption.children) walkElement(child, optionPath, values, radioSelections, options);
}

/** Only fills instances that ALREADY exist (per `options.instanceCounts`,
 *  keyed the same way FormEngine.repeatingInstanceCounts is — bare entry
 *  name, lowercased) — this module never creates a repeating instance itself
 *  (that's an interactive Add-button/DOM operation, out of scope for a
 *  pure/no-DOM value generator); the caller decides whether to Add first. */
function fillRepeatingContentContainer(element, path, values, radioSelections, options) {
  const entryWrapper = element.children.find((c) => !isAttribute(c));
  const outerPath = joinPath(path, element.elementName);

  for (const attr of element.children.filter(isAttribute)) walkElement(attr, outerPath, values, radioSelections, options);

  const entryPath = joinPath(outerPath, entryWrapper.elementName);
  const count = options.instanceCounts?.[entryWrapper.elementName.toLowerCase()] ?? 0;
  for (let i = 0; i < count; i++) {
    for (const child of entryWrapper.children) walkElement(child, `${entryPath}[${i}]`, values, radioSelections, options);
  }
}

function walkElement(element, path, values, radioSelections, options) {
  if (element.kind === 'RadioGroup') return fillRadioGroup(element, path, values, radioSelections, options);
  if (isRepeatingContentContainer(element)) return fillRepeatingContentContainer(element, path, values, radioSelections, options);

  if (isTransparent(element)) {
    for (const child of element.children) walkElement(child, path, values, radioSelections, options);
    return;
  }

  if (isAttribute(element)) {
    fillLeaf(element, joinPath(path, element.elementName), values, options);
    return;
  }

  const currentPath = joinPath(path, element.elementName);

  if (isLeaf(element)) {
    fillLeaf(element, currentPath, values, options);
    return;
  }

  // Container: attributes then structural children, same order as
  // validateNode/buildNodes/walkContainerBody.
  for (const attr of element.children.filter(isAttribute)) walkElement(attr, currentPath, values, radioSelections, options);
  for (const child of element.children.filter((c) => !isAttribute(c))) walkElement(child, currentPath, values, radioSelections, options);
}

/**
 * @param {object} element - a SchemaElement subtree to generate values for
 *   (the whole form's root for a toolbar-level fill, or a specific container
 *   node found within it for a scoped context-menu fill).
 * @param {object} [options]
 * @param {boolean} [options.requiredOnly=false] - equivalent to `filter: el => el.isRequired`
 *   when no explicit `filter` is given.
 * @param {(el:object)=>boolean} [options.filter] - overrides `requiredOnly` when given.
 * @param {Record<string, number>} [options.instanceCounts] - CURRENT
 *   repeatingInstanceCounts (bare entry name, lowercased) — only existing
 *   instances get filled, none are created.
 * @param {Record<string, string>} [options.radioSelections] - CURRENT
 *   radioSelections (choicePath, lowercased → optionPath) — an existing
 *   selection is reused rather than overridden.
 * @param {string} [options.parentPath=''] - the runtime path PREFIX `element`
 *   itself sits under (its parent's own path) — '' for a whole-form fill
 *   where `element` IS the form root, or the container's actual parent path
 *   for a scoped fill.
 * @returns {{values: Record<string,*>, radioSelections: Record<string,string>}}
 *   `values` is keyed exactly like FormEngine.fieldValues (full path,
 *   lowercased). `radioSelections` here holds only the selections THIS call
 *   newly chose (not ones it merely reused from `options.radioSelections`) —
 *   callers merge both dicts into FormEngine themselves (§17 "Only empty
 *   fields are filled" — that merge decision belongs to the caller, not here).
 */
export function generateValues(element, options = {}) {
  const values = {};
  const radioSelections = {};
  walkElement(element, options.parentPath || '', values, radioSelections, options);
  return { values, radioSelections };
}
