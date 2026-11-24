// js/core/facets.js — XSD constraining facets: everything derived FROM a
// SchemaElement's validationRules rather than checked against them.
//
// The facet switch itself (value → {valid, message}) stays in
// coloringService.validateFieldValue (backlog A.3). This module holds the
// pieces several callers need on top of it:
//
//   - deriveMaxLengthFromPattern — parser.js synthesizes a maxLength rule from
//     a pattern when no maxLength/length facet exists (parity 1.9; the WPF
//     ValidationRuleExtractor does the same). Field sizing (parity 2.1) will
//     read that synthesized rule too.
//   - inputConstraints — the native <input> attributes a leaf control should
//     carry (parity 1.8), consumed by js/ui/controlFactory.js.
//   - rejectsEdit — the one hard limit a native attribute can't express
//     on <input type="number"> (browsers ignore `maxlength` there).
//   - totalDigitCount / fractionDigitCount — shared by validation and the
//     typing guard so the two can never disagree about what "a digit" is.
//
// Zero DOM: plain strings and numbers in, plain objects out.

/** Every facet parser.js extracts as a ValidationRule (spec §2). Order here is
 *  irrelevant — rules keep their source order. */
export const VALIDATION_FACETS = Object.freeze([
  'length', 'minLength', 'maxLength', 'pattern',
  'minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive',
  'totalDigits', 'fractionDigits',
]);

// ---------------------------------------------------------------------------
// pattern → maxLength
// ---------------------------------------------------------------------------

class Unbounded extends Error {}

/**
 * The longest string an XSD `pattern` can match, or null when it has none
 * (any `*`, `+` or `{n,}`) or the pattern is malformed.
 *
 * Errs toward OVER-estimating wherever the pattern is unusual, never under:
 * the result becomes a hard `maxlength`, so a figure that is too small would
 * stop the user typing a value the schema accepts. Over-estimating only
 * loosens a typing limit the validator still backs up.
 *
 * `^` and `$` are skipped as zero-width. In XSD regex they are literal
 * characters, but validateFieldValue compiles patterns as JS regexes where
 * they anchor, so skipping them keeps this consistent with what validation
 * actually accepts.
 */
export function deriveMaxLengthFromPattern(pattern) {
  if (typeof pattern !== 'string' || pattern === '') return null;
  const state = { s: pattern, i: 0 };
  try {
    const max = parseAlternation(state, false);
    return state.i === pattern.length ? max : null; // stray ')' — malformed
  } catch {
    return null; // Unbounded, or an unterminated class/group
  }
}

function parseAlternation(state, inGroup) {
  let max = parseBranch(state, inGroup);
  while (state.s[state.i] === '|') {
    state.i++;
    max = Math.max(max, parseBranch(state, inGroup));
  }
  return max;
}

function parseBranch(state, inGroup) {
  const { s } = state;
  let total = 0;
  while (state.i < s.length) {
    const c = s[state.i];
    if (c === '|') break;
    if (c === ')') {
      if (inGroup) break;
      throw new SyntaxError('unbalanced )');
    }
    let atom;
    if (c === '^' || c === '$') {
      state.i++;
      continue;
    } else if (c === '(') {
      state.i++;
      atom = parseAlternation(state, true);
      if (s[state.i] !== ')') throw new SyntaxError('unterminated group');
      state.i++;
    } else if (c === '[') {
      state.i = skipCharClass(s, state.i);
      atom = 1;
    } else if (c === '\\') {
      state.i = skipEscape(s, state.i);
      atom = 1;
    } else {
      state.i++;
      atom = 1;
    }
    total += atom * parseQuantifierMax(state);
  }
  return total;
}

/** Index just past the class opening at `i`. Nested `[` only occurs in XSD as
 *  character-class subtraction (`[a-z-[aeiou]]`), so depth-counting is exact. */
function skipCharClass(s, i) {
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return i + 1;
  }
  throw new SyntaxError('unterminated character class');
}

/** Index just past the escape at `i`, including `\p{…}` / `\P{…}` blocks. */
function skipEscape(s, i) {
  if ((s[i + 1] === 'p' || s[i + 1] === 'P') && s[i + 2] === '{') {
    const close = s.indexOf('}', i + 3);
    if (close < 0) throw new SyntaxError('unterminated \\p{}');
    return close + 1;
  }
  if (i + 1 >= s.length) throw new SyntaxError('trailing backslash');
  return i + 2;
}

/** Max repetitions of the preceding atom; consumes the quantifier if any. */
function parseQuantifierMax(state) {
  const { s } = state;
  const c = s[state.i];
  if (c === '?') { state.i++; return 1; }
  if (c === '*' || c === '+') throw new Unbounded();
  if (c === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(s.slice(state.i));
    if (!m) return 1; // not a quantifier — the '{' is parsed as a literal next
    state.i += m[0].length;
    if (m[2] === undefined) return Number(m[1]); // {n}
    if (m[3] === '') throw new Unbounded(); // {n,}
    return Number(m[3]); // {n,m}
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Digit counting (totalDigits / fractionDigits)
// ---------------------------------------------------------------------------

/** Digits counted against `totalDigits`: sign and point removed, leading
 *  zeros not significant. (Same rule validateFieldValue has always applied.) */
export function totalDigitCount(value) {
  return String(value).replace(/[-+.]/g, '').replace(/^0+(?=\d)/, '').length;
}

export function fractionDigitCount(value) {
  return (String(value).split('.')[1] || '').length;
}

// ---------------------------------------------------------------------------
// Native input constraints (parity 1.8)
// ---------------------------------------------------------------------------

/** The flag a browser compiles an `<input pattern>` with: `v` where supported
 *  (all current engines), `u` before that. A pattern that fails to compile
 *  under it is ignored by the browser with a console error, so we test first. */
const HTML_PATTERN_FLAGS = (() => {
  try { new RegExp('', 'v'); return 'v'; } catch { return 'u'; }
})();

/** Whether `pattern` is usable as an HTML `pattern` attribute. XSD patterns
 *  that are valid JS regexes in legacy mode can still fail under `v` (an
 *  unescaped `-` at the end of a class, `[a-z-[aeiou]]` subtraction, …);
 *  those keep their validateFieldValue check and just lose the native one. */
export function isHtmlCompatiblePattern(pattern) {
  try {
    new RegExp(`^(?:${pattern})$`, HTML_PATTERN_FLAGS);
    return true;
  } catch {
    return false;
  }
}

function ruleValue(rules, kind) {
  const r = rules.find((x) => x.kind === kind);
  return r ? r.value : undefined;
}

function finiteNumber(v) {
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * A range bound moved onto the input's lexical grid (multiples of
 * 10^-fractionDigits), as a string — the only values a user can actually enter.
 *
 *   inclusive: the nearest grid point on the allowed side (ceil for a min,
 *              floor for a max). A bound already on the grid keeps its own
 *              string untouched, so large values never pass through float.
 *              This matters once facets are inherited: RatioType's
 *              minInclusive "0.00000" under a derived fractionDigits 2 is
 *              "0.00" — the same number, in a form the field accepts.
 *   exclusive: the next grid point strictly past the bound — the "nudge"
 *              that turns minExclusive/maxExclusive into a native min/max.
 *
 * Only defined where the grid is discrete: integers, or decimals with a
 * fractionDigits facet. A decimal without one has no grid, so inclusive
 * bounds pass through as written and exclusive ones are left to
 * validateFieldValue alone.
 */
function boundOnGrid(raw, direction, fractionDigits, exclusive) {
  const text = String(raw).trim();
  if (!exclusive && fractionDigitCount(text) <= fractionDigits) return text;
  const scale = 10 ** fractionDigits;
  // Round the scaled bound first so float noise (0.1 * 100 = 10.000000000000002)
  // can't skip or add a grid point.
  const scaled = Math.round(Number(text) * scale * 1e6) / 1e6;
  let point;
  if (exclusive) point = direction > 0 ? Math.floor(scaled) + 1 : Math.ceil(scaled) - 1;
  else point = direction > 0 ? Math.ceil(scaled) : Math.floor(scaled);
  return (point / scale).toFixed(fractionDigits);
}

/** Of two candidate bounds (strings or undefined), the tighter one. */
function tighter(a, b, direction) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return direction > 0 ? (Number(a) >= Number(b) ? a : b) : (Number(a) <= Number(b) ? a : b);
}

/**
 * The native attributes and typing limits for one leaf's control. Every key is
 * optional; absent means "don't set it":
 *
 *   TextInput      maxLength, minLength, pattern
 *   NumericInput   min, max, step ('1'), maxTotalDigits, maxLength (typing guard)
 *   DecimalInput   min, max, step, maxTotalDigits, maxLength (typing guard)
 *   DatePicker     min, max (xs:date only — see below)
 *
 * `length` sets both maxLength and minLength. A maxLength synthesized from a
 * pattern is already a plain maxLength rule by the time it gets here.
 */
export function inputConstraints(element) {
  const rules = element.validationRules || [];
  const out = {};

  switch (element.kind) {
    case 'TextInput': {
      const length = finiteNumber(ruleValue(rules, 'length'));
      const maxLen = finiteNumber(ruleValue(rules, 'maxLength'));
      const minLen = finiteNumber(ruleValue(rules, 'minLength'));
      const maxes = [length, maxLen].filter((n) => n !== undefined);
      const mins = [length, minLen].filter((n) => n !== undefined);
      if (maxes.length) out.maxLength = Math.min(...maxes);
      if (mins.length) out.minLength = Math.max(...mins);
      const pattern = ruleValue(rules, 'pattern');
      if (pattern && isHtmlCompatiblePattern(pattern)) out.pattern = pattern;
      break;
    }

    case 'NumericInput':
    case 'DecimalInput': {
      const isInteger = element.kind === 'NumericInput';
      const fd = isInteger ? 0 : finiteNumber(ruleValue(rules, 'fractionDigits'));
      out.step = fd === undefined ? 'any' : fd === 0 ? '1' : (10 ** -fd).toFixed(fd);

      const bound = (kind, direction, exclusive) => {
        const raw = ruleValue(rules, kind);
        if (finiteNumber(raw) === undefined) return undefined;
        if (fd === undefined) return exclusive ? undefined : String(raw).trim();
        return boundOnGrid(raw, direction, fd, exclusive);
      };
      out.min = tighter(bound('minInclusive', +1, false), bound('minExclusive', +1, true), +1);
      out.max = tighter(bound('maxInclusive', -1, false), bound('maxExclusive', -1, true), -1);

      const td = finiteNumber(ruleValue(rules, 'totalDigits'));
      if (td !== undefined) out.maxTotalDigits = td;
      const maxLen = finiteNumber(ruleValue(rules, 'maxLength') ?? ruleValue(rules, 'length'));
      if (maxLen !== undefined) out.maxLength = maxLen;
      break;
    }

    case 'DatePicker': {
      // Only xs:date: its facet values are already in <input type="date">'s
      // YYYY-MM-DD form. An xs:dateTime bound carries a Z/offset the
      // datetime-local control can't represent (see controlFactory.js), and
      // the exclusive bounds would need a calendar nudge — both stay
      // validation-only.
      if (element.xsdDataType === 'xs:date') {
        const isPlainDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim());
        const minInc = ruleValue(rules, 'minInclusive');
        const maxInc = ruleValue(rules, 'maxInclusive');
        if (isPlainDate(minInc)) out.min = minInc.trim();
        if (isPlainDate(maxInc)) out.max = maxInc.trim();
      }
      break;
    }

    default:
      break;
  }

  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/**
 * Whether the edit `previous` → `next` should be refused for breaking a hard
 * typing limit from inputConstraints — the check behind controlFactory's
 * input guard for number inputs, where the browser ignores `maxlength`.
 *
 * Only an edit that makes things WORSE is refused. A value loaded from XML (or
 * restored by undo) can already be over the limit, and the user must still be
 * able to delete their way back under it.
 *
 * Range and pattern are deliberately not typing limits: a partially typed
 * value is routinely out of range on its way to being in range.
 */
export function rejectsEdit(previous, next, constraints) {
  const prev = previous ?? '';
  const text = next ?? '';
  if (constraints.maxLength !== undefined && text.length > constraints.maxLength && text.length > prev.length) return true;
  if (constraints.maxTotalDigits !== undefined) {
    const digits = totalDigitCount(text);
    if (digits > constraints.maxTotalDigits && digits > totalDigitCount(prev)) return true;
  }
  return false;
}
