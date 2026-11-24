// js/core/coloringService.js — R/G/Y completeness coloring AND completeness
// error collection, computed by ONE activation-aware walk.
//
// See web-implementation-spec.md §9 (Coloring Service), §16 (Full Structural
// Schema Validation), §22 invariants 6, 7, 12.
// dev/IMPLEMENTATION_ORDER.md Phase 1 (parity 1.1 + 1.2 + 1.3, backlog A.2 + A.3).
//
// Pure logic, no DOM dependencies. js/ui/coloring.js applies the computed
// FieldColorState values to actual DOM elements; js/ui/validation.js wraps the
// error list with form/instance identity and renders the validation panel.
//
// ---------------------------------------------------------------------------
// Why one walk (backlog A.2)
// ---------------------------------------------------------------------------
// This file used to compute colors only, with js/ui/validation.js's
// validateSchema running a second, near-identical walk for completeness
// errors — the arrangement the WPF original has, whose invariant §13 #47
// exists purely to warn that the two must be edited together. They computed
// the same predicates from the same inputs and could (and did) contradict each
// other: parity 1.3's "coloring says Green, validation says occurrence error"
// was exactly that. `analyzeForm` emits both a color map and an error list from
// one traversal, so a contradiction is no longer expressible.
//
// The facet switch is likewise single-sourced now (backlog A.3):
// `validateFieldValue` is the one implementation, re-exported by
// js/ui/validation.js as `validateField`, and `isFieldValid` is a
// verdict-only wrapper over it.
//
// ---------------------------------------------------------------------------
// Activation context (parity 1.1 / 1.2 / 1.3)
// ---------------------------------------------------------------------------
// A required field only *demands* a value once the user is actually working in
// the part of the form that contains it. The walk threads one boolean,
// `parentIsActiveOrRequired`, recomputed at every container as
//
//     thisIsActiveOrRequired = element.isRequired ? parentIsActiveOrRequired
//                                                 : isActivated(element)
//
// seeded `true` at the form root (form roots are always a required context).
// A required-but-empty leaf in an INACTIVE context colors Yellow and reports
// nothing; in an active context it colors Red and reports a completeness
// error. Without this, a freshly loaded form paints large swaths of red and
// Validate reports hundreds of errors for optional sections the user has never
// opened.
//
// This deliberately supersedes §9's and §16's literal pseudocode, which has no
// activation concept and rolls container colors up purely from child colors.
// Those sections have been rewritten to describe the behavior below; the
// decision ladder here is the authority on what the colors mean.
//
// Two places where this implementation departs from the WPF reference, both
// deliberate:
//
//  1. Container completeness requires each leaf to be non-empty AND valid,
//     where WPF checks presence only. §9's "a filled-but-invalid field is Red"
//     rule has to survive the roll-up, or a container full of malformed values
//     would read Green.
//  2. An unchecked checkbox (boolean `false`) counts as *answered* but not as
//     *engagement* — see `hasEnteredValue`. WPF treats `false` as no value at
//     all and then needs per-call-site checkbox exceptions to compensate.

import { joinPath, isTransparent, isAttribute, isLeaf } from './parser.js';
import { totalDigitCount, fractionDigitCount } from './facets.js';

export function isEmpty(value) {
  return value === undefined || value === null || value === '';
}

export function hasValue(value) {
  return !isEmpty(value);
}

/**
 * "The user has put something here" — the predicate behind activation,
 * `hasAnyDescendantValue`, and the populated-branch count.
 *
 * Distinct from `hasValue` in exactly one case: a rendered-but-untouched
 * checkbox. FormEngine's flush writes boolean `false` for every unchecked
 * checkbox the moment a form renders (controlFactory's getControlValue returns
 * `input.checked`), so counting that as a value would activate every container
 * holding a checkbox and defeat the whole activation context. An unchecked box
 * still counts as COMPLETE (see `isLeafComplete`) — it's answered, just not
 * evidence that the user engaged with the section.
 */
function hasEnteredValue(value) {
  return !isEmpty(value) && value !== false;
}

/**
 * Minimal stand-in for the spec's `patternDescriber.describe(rule.value)` —
 * no such describer exists yet (parity 2.3 builds it), so this gives every
 * pattern-format error a readable message rather than dumping a raw regex.
 */
const patternDescriber = {
  describe(pattern) {
    return `Must match the required format (pattern: ${pattern})`;
  },
};

/**
 * Sign of (value − bound) for a range facet, or NaN when the two can't be
 * compared (which then fails no check — an unparseable value is the date or
 * number check's business, not the range check's).
 *
 * Date kinds compare as strings: xs:date / xs:dateTime lexical forms of the
 * same shape sort chronologically, and a bound with a different shape than
 * the value (one with a timezone, one without) is NaN rather than a guess.
 */
function compareToBound(value, bound, element) {
  if (element.kind === 'DatePicker') {
    const v = String(value).trim();
    const b = String(bound).trim();
    if (v.length !== b.length) return NaN;
    return v < b ? -1 : v > b ? 1 : 0;
  }
  const v = Number(value);
  const b = Number(bound);
  if (!Number.isFinite(v) || !Number.isFinite(b)) return NaN;
  return Math.sign(v - b);
}

/**
 * §16 `validateField` — the single facet switch for the whole codebase
 * (backlog A.3). Two deliberate departures from the spec's literal code block:
 *
 * 1. The spec's switch has no `break` between cases, which in real JS falls
 *    through into every later case's condition too (misapplying, e.g., a
 *    minLength rule's `rule.value` as if it were also a maxLength threshold).
 * 2. The spec short-circuits empty values only `if (isEmpty(value) &&
 *    !element.isRequired)`, so an empty REQUIRED value falls through into the
 *    rule loop — e.g. `String(undefined).length` failing a minLength check —
 *    producing a spurious format message for a field whose actual problem is
 *    completeness. Emptiness is a completeness concern, not a validity one
 *    (§22 invariant 4), so it short-circuits unconditionally here; the walk
 *    below checks emptiness itself before ever calling in.
 *
 * Range facets compare through `compareToBound`, not a bare `Number()`: on a
 * date field `Number('2024-01-01')` is NaN, every comparison against NaN is
 * false, and a min/maxInclusive on an xs:date used to pass silently.
 */
export function validateFieldValue(value, element) {
  if (isEmpty(value)) return { valid: true };
  const text = String(value);
  for (const rule of element.validationRules || []) {
    switch (rule.kind) {
      case 'length':
        if (text.length !== Number(rule.value)) return { valid: false, message: `Exact length: ${rule.value}` };
        break;
      case 'minLength':
        if (text.length < Number(rule.value)) return { valid: false, message: `Min length: ${rule.value}` };
        break;
      case 'maxLength':
        if (text.length > Number(rule.value)) return { valid: false, message: `Max length: ${rule.value}` };
        break;
      case 'pattern':
        if (!new RegExp(`^(?:${rule.value})$`).test(text)) return { valid: false, message: patternDescriber.describe(rule.value) };
        break;
      case 'minInclusive':
        if (compareToBound(text, rule.value, element) < 0) return { valid: false, message: `Min value: ${rule.value}` };
        break;
      case 'maxInclusive':
        if (compareToBound(text, rule.value, element) > 0) return { valid: false, message: `Max value: ${rule.value}` };
        break;
      case 'minExclusive':
        if (compareToBound(text, rule.value, element) <= 0) return { valid: false, message: `Must be greater than ${rule.value}` };
        break;
      case 'maxExclusive':
        if (compareToBound(text, rule.value, element) >= 0) return { valid: false, message: `Must be less than ${rule.value}` };
        break;
      case 'totalDigits':
        if (totalDigitCount(text) > Number(rule.value)) return { valid: false, message: `Max total digits: ${rule.value}` };
        break;
      case 'fractionDigits':
        if (fractionDigitCount(text) > Number(rule.value)) return { valid: false, message: `Max decimal places: ${rule.value}` };
        break;
      default:
        break;
    }
  }
  if (element.kind === 'DatePicker' && isNaN(Date.parse(value))) return { valid: false, message: 'Invalid date' };
  return { valid: true };
}

/** Verdict-only form of validateFieldValue, for the coloring path (which has
 *  no use for the message). */
export function isFieldValid(element, value) {
  return validateFieldValue(value, element).valid;
}

/**
 * §9 "Color Rules" — one leaf (or attribute) field's own color, now
 * activation-aware. Yellow marks "nothing is being asked of you here" as
 * distinctly as Red marks "this is wrong": a required field is only Red once
 * its subtree is active. Every leaf always has some color, never none.
 */
export function computeColor(element, value, parentIsActiveOrRequired = true) {
  if (!isEmpty(value)) return isFieldValid(element, value) ? 'Green' : 'Red';
  if (element.isRequired) return parentIsActiveOrRequired ? 'Red' : 'Yellow';
  return 'Yellow';
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * The one walk. Returns a color for every colorable node in the tree — leaf
 * fields, attributes, containers, repeating instances, radio groups and
 * selected branches alike — keyed by the SAME lower-cased, fully-indexed path
 * convention FormEngine uses (§8), plus the completeness/format/occurrence/
 * choice errors found on the way down.
 *
 * `state` is a FormState-shaped object: { fieldValues, radioSelections,
 * repeatingInstanceCounts } (all already lower-cased, per FormEngine's own
 * storage convention — pass formEngine.getFormState(instanceKey) directly).
 *
 * Errors carry `{ path, kind, message }` only; js/ui/validation.js adds form
 * and instance identity, which is a packet-level concern this walk knows
 * nothing about.
 *
 * @returns {{colors: Map<string, string|null>, errors: Array<{path:string, kind:string, message:string}>}}
 */
export function analyzeForm(schemaElement, state) {
  const ctx = { state, colors: new Map(), errors: [] };
  // Form roots are always a required context — there is no outer container to
  // have activated them, and a form the user navigated to is by definition
  // one they are working in.
  walkNode(schemaElement, '', true, ctx);
  return { colors: ctx.colors, errors: ctx.errors };
}

/** Colors only — js/ui/coloring.js's entry point. */
export function computeAllColors(schemaElement, state) {
  return analyzeForm(schemaElement, state).colors;
}

// ---------------------------------------------------------------------------
// State access
// ---------------------------------------------------------------------------

function valueAt(ctx, path) {
  return ctx.state.fieldValues[path.toLowerCase()];
}

function hasEnteredValueAt(ctx, path) {
  return hasEnteredValue(valueAt(ctx, path));
}

/** A leaf counts as complete when it holds a value that also passes its own
 *  facets — see departure (1) in the file header. */
function isLeafComplete(ctx, element, path) {
  const value = valueAt(ctx, path);
  return !isEmpty(value) && isFieldValid(element, value);
}

/**
 * Instance counts are still keyed by the repeating node's BARE elementName,
 * not its runtime path — FormEngine's own storage convention. That is backlog
 * A.1 (two sibling lists of the same name under different parents share a
 * count) and is scheduled for Phase 7, where the same fix touches all the
 * modules that write the key. Reading it through one helper here is what makes
 * that a one-line change.
 */
function instanceCount(ctx, element) {
  return ctx.state.repeatingInstanceCounts[element.elementName.toLowerCase()] ?? 0;
}

/**
 * Transparent wrapper nodes (generated Entry/Option wrappers, a choice-only
 * container's RadioGroup child) still contribute a path segment (§22
 * invariants 24/29) but are never leaves themselves — a degenerately childless
 * one must not be misread as an empty leaf field.
 */
function isLeafLike(element) {
  return !isTransparent(element) && (isAttribute(element) || isLeaf(element));
}

/**
 * Resolves a RadioGroup's current selection to one of its option wrappers.
 *
 * `state.radioSelections[choicePath]` holds the option's own STATIC
 * `elementPath` as parsed (that's what formRenderer's setRadioSelection
 * stores), not an index-bearing runtime path, even when `choicePath` itself IS
 * index-bearing inside a repeating instance. Comparing against
 * `option.elementPath` directly — rather than reconstructing a candidate via
 * joinPath(choicePath, option.elementName), which looks right and silently
 * never matches once an index is involved — is what formRenderer's
 * showBranch/selectRadioGroupBranches and xmlWriter's buildChoiceNodes already
 * do.
 */
function selectedOption(ctx, radioGroup, choicePath) {
  const selected = ctx.state.radioSelections[choicePath.toLowerCase()];
  if (!selected) return { selected: null, option: null, optionPath: null };
  const option = radioGroup.children.find((o) => o.elementPath.toLowerCase() === String(selected).toLowerCase()) ?? null;
  return { selected, option, optionPath: option ? joinPath(choicePath, option.elementName) : null };
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

function setColor(ctx, path, color) {
  ctx.colors.set(path.toLowerCase(), color);
  return color;
}

function pushError(ctx, path, kind, message) {
  ctx.errors.push({ path, kind, message });
}

function walkNode(element, parentPath, active, ctx) {
  if (element.kind === 'RadioGroup') return walkRadioGroup(element, parentPath, active, ctx);

  const path = joinPath(parentPath, element.elementName);

  // Checked before the leaf/container split and regardless of what the PARENT
  // looks like — matching formRenderer's own per-child dispatch rule. Gating
  // on the parent's shape instead (isRepeatingContentContainer) misses an
  // anonymous repeating xs:sequence that sits ALONGSIDE sibling content, e.g.
  // AuthenticationHeader.xsd's Submission: a maxOccurs="3" sequence next to a
  // separate xs:choice. Walking such a wrapper once at an un-indexed path
  // reads every field inside it as permanently empty, since every real value
  // lives under an `[i]` path (see formRenderer's rewriteInstancePaths). This
  // also covers a REAL, non-synthetic repeating element (kind
  // 'GroupContainer', isGeneratedWrapper=false) like HI's
  // DependentInformation, which needs no special handling either way.
  if (element.isRepeating) return walkRepeating(element, path, active, ctx);

  if (isLeafLike(element)) return walkLeaf(element, path, active, ctx);
  return walkContainer(element, path, active, ctx);
}

function walkLeaf(element, path, active, ctx) {
  const value = valueAt(ctx, path);

  if (isEmpty(value)) {
    if (element.isRequired && active) {
      pushError(ctx, path, 'completeness', isAttribute(element) ? 'Required attribute is missing' : 'Required field is empty');
    }
  } else {
    // A filled field that breaks its own facets is wrong whether or not its
    // subtree is active — the user typed it, so activation isn't in question.
    const result = validateFieldValue(value, element);
    if (!result.valid) pushError(ctx, path, 'format', result.message);
  }

  return setColor(ctx, path, computeColor(element, value, active));
}

function walkContainer(element, path, active, ctx) {
  const thisActive = element.isRequired ? active : isActivated(ctx, element, path);
  const color = setColor(ctx, path, containerColor(ctx, element, path, active));

  // Always recurse for colors (every rendered control needs one), and let each
  // child's own gate decide whether it may report. A leaf's and a radio
  // group's completeness errors both require an active context, so an inactive
  // container falls silent without a separate skip — while a deeper,
  // SELF-activated optional container inside it is still found and reported,
  // which is the one non-obvious rule of the reference's completeness walk.
  for (const child of element.children) walkNode(child, path, thisActive, ctx);

  return color;
}

/**
 * §9 "Container Coloring" — the decision ladder that replaced the old pure
 * roll-up of child colors.
 *
 *   active AND required  → every required descendant complete ? Green : Red
 *   otherwise            → untouched            → Yellow
 *                          required descendant incomplete → Red
 *                          EVERY descendant complete       → Green
 *                          otherwise                       → Yellow
 *
 * The second ladder covers both "this subtree isn't active yet" and "this
 * container is optional": neither can demand anything, so an untouched one
 * reads Yellow, and a touched one only reaches Green on strict completeness.
 * A required container, once active, goes Green as soon as nothing REQUIRED is
 * missing — empty optional children no longer hold it at Yellow (which is the
 * single most visible change of this rewrite, and the reference behavior).
 */
function containerColor(ctx, element, path, active) {
  // Nothing to complete, so nothing to report as complete either (parity 1.3:
  // a container-shaped node never reads Green on emptiness alone).
  if (!element.children || element.children.length === 0) return 'Yellow';

  const requiredComplete = allRequiredChildrenComplete(ctx, element, path);
  if (active && element.isRequired) return requiredComplete ? 'Green' : 'Red';

  if (!hasAnyDescendantValue(ctx, element, path)) return 'Yellow';
  if (!requiredComplete) return 'Red';
  if (allChildrenComplete(ctx, element, path)) return 'Green';
  return 'Yellow';
}

/**
 * A repeating node — a synthetic `…Entry` wrapper, or a real element with
 * maxOccurs > 1 — at its own (un-indexed) path. Colors each instance at
 * `path[i]`, then the node itself from the aggregate.
 */
function walkRepeating(element, path, active, ctx) {
  const count = instanceCount(ctx, element);
  const min = element.minOccurs ?? 0;

  // Too FEW entries is a completeness concern, so it's gated on activation
  // like any other required-but-empty finding (parity 1.2): an untouched
  // optional section's unmet minimum is not the user's problem yet. Too MANY
  // is a data error the schema forbids outright, so it always reports.
  if (count < min && active) pushError(ctx, path, 'occurrence', `At least ${min} required, found ${count}`);
  if (element.maxOccurs != null && count > element.maxOccurs) {
    pushError(ctx, path, 'occurrence', `At most ${element.maxOccurs} allowed, found ${count}`);
  }

  if (count === 0) {
    // parity 1.3: never Green. The old code aggregated an empty child-color
    // list and `computeContainerColor(isRequired, [])` answered Green, so a
    // required list the user had never added a row to read as complete — while
    // the validator reported an occurrence error for the same node.
    const color = isLeafLike(element)
      ? computeColor(element, undefined, active)
      : element.isRequired && active
        ? 'Red'
        : 'Yellow';
    return setColor(ctx, path, color);
  }

  const instanceColors = [];
  for (let i = 0; i < count; i++) {
    const instancePath = `${path}[${i}]`;
    // An instance exists only because the user clicked Add or an XML load
    // created it, so each one walks in an ACTIVE context: its required fields
    // are Red when empty and do report. (In the reference this is implicit —
    // it derives instance counts from the values themselves, so count > 0
    // always implied a value was present and the enclosing container was
    // therefore already activated. This codebase stores counts explicitly and
    // so can represent a blank added row, which must not be allowed to reach
    // the XML silently.)
    instanceColors.push(isLeafLike(element) ? walkLeaf(element, instancePath, true, ctx) : walkContainer(element, instancePath, true, ctx));
  }

  // Aggregate: any Red → Red; all Green → Green; otherwise Yellow.
  let color = 'Green';
  if (instanceColors.some((c) => c === 'Red')) color = 'Red';
  else if (!instanceColors.every((c) => c === 'Green')) color = 'Yellow';
  return setColor(ctx, path, color);
}

/**
 * §9 "Radio branch coloring": only the SELECTED branch is walked. Hidden
 * branches are ignored entirely (WALKTHROUGH.md §18: "Only Option2's children
 * are evaluated for completeness. Option1's fields (hidden) are ignored by the
 * coloring service.") — which also means data stranded in a branch the user
 * swapped away from never activates anything. The one place it is still read
 * is the populated-branch count below, where two populated branches is itself
 * the error being reported.
 */
function walkRadioGroup(element, parentPath, active, ctx) {
  const choicePath = joinPath(parentPath, element.elementName);
  const { selected, option, optionPath } = selectedOption(ctx, element, choicePath);

  let color;
  if (selected && !option) {
    color = null; // stale/unresolvable selection — defensive, not expected in practice
  } else if (!option) {
    // Unselected reads like an empty leaf: Red if required AND active, else Yellow.
    color = element.isRequired && active ? 'Red' : 'Yellow';
  } else {
    const complete = isBranchComplete(ctx, option, optionPath);
    if (element.isRequired || active) {
      color = complete ? 'Green' : 'Red';
    } else if (complete && isBranchStrictlyComplete(ctx, option, optionPath)) {
      color = 'Green';
    } else {
      color = complete ? 'Yellow' : 'Red';
    }
  }
  setColor(ctx, choicePath, color);

  const populatedBranches = element.children.filter((o) => hasEnteredDataUnder(ctx, joinPath(choicePath, o.elementName))).length;
  if (!selected && element.isRequired && active) {
    pushError(ctx, choicePath, 'completeness', 'A selection is required');
  } else if (populatedBranches > 1) {
    pushError(ctx, choicePath, 'choice', 'More than one option has data — only one branch may be populated');
  }

  if (option) {
    // An explicit selection IS activation — the user engaged with this radio
    // group, so the branch they chose has to be filled in regardless of
    // whether anything else around it is active. The reference makes exactly
    // this call in its coloring walk but not in its completeness walk, so it
    // paints a selected branch's required fields Red while Validate stays
    // silent about them and Save XML emits the incomplete branch without a
    // warning. One walk, one answer: both follow the coloring side.
    walkBranch(ctx, option, optionPath);
  }

  return color;
}

/** The selected branch's own subtree, always in an active context (see the
 *  call site). `option` is a transparent OptionN wrapper whose name is still a
 *  path segment (§22 invariant 29) — recursing with the bare `choicePath`, as
 *  §16's own earlier pseudocode did, looks up every field inside the branch at
 *  a key nothing is ever registered at. */
function walkBranch(ctx, option, optionPath) {
  if (isLeafLike(option)) return walkLeaf(option, optionPath, true, ctx);
  if (option.isRepeating) return walkRepeating(option, optionPath, true, ctx);
  const color = setColor(ctx, optionPath, containerColor(ctx, option, optionPath, true));
  for (const child of option.children) walkNode(child, optionPath, true, ctx);
  return color;
}

// ---------------------------------------------------------------------------
// Activation and completeness predicates
// ---------------------------------------------------------------------------

/**
 * Has the user engaged with this container? A container is active when it is
 * required, or when something inside it has been filled in — with one
 * exception carried over from the reference: a container whose children are
 * ALL optional never activates, because filling one optional field there
 * cannot make any sibling mandatory.
 */
function isActivated(ctx, element, path) {
  if (element.isRequired) return true;
  if (!hasAnyDescendantValue(ctx, element, path)) return false;
  return element.children.some((c) => c.isRequired);
}

function hasAnyDescendantValue(ctx, element, path) {
  for (const child of element.children) {
    const childPath = joinPath(path, child.elementName);

    if (child.kind === 'RadioGroup') {
      const { option, optionPath } = selectedOption(ctx, child, childPath);
      if (!option) continue;
      if (isLeafLike(option) ? hasEnteredValueAt(ctx, optionPath) : hasAnyDescendantValue(ctx, option, optionPath)) return true;
      continue;
    }

    if (child.isRepeating) {
      // An existing instance counts on its own, even blank: the row exists
      // because somebody created it. See walkRepeating's instance comment.
      if (instanceCount(ctx, child) > 0) return true;
      continue;
    }

    if (isLeafLike(child)) {
      if (hasEnteredValueAt(ctx, childPath)) return true;
      continue;
    }

    if (hasAnyDescendantValue(ctx, child, childPath)) return true;
  }
  return false;
}

/** Prefix scan over the raw value map, for "does this radio branch hold data"
 *  — the one question that has to see branches the structural walk skips. */
function hasEnteredDataUnder(ctx, pathPrefix) {
  const prefix = pathPrefix.toLowerCase();
  for (const [key, value] of Object.entries(ctx.state.fieldValues)) {
    if (key !== prefix && !key.startsWith(`${prefix}.`) && !key.startsWith(`${prefix}[`)) continue;
    if (hasEnteredValue(value)) return true;
  }
  return false;
}

/**
 * Is everything this container REQUIRES present? Drives the Green/Red split
 * for an active required container.
 *
 * Optional children normally can't block — but an optional child the user has
 * already activated and left half-finished is effectively Red, and must keep
 * its parent off Green.
 */
function allRequiredChildrenComplete(ctx, element, path) {
  for (const child of element.children) {
    const childPath = joinPath(path, child.elementName);

    if (!child.isRequired) {
      if (isLeafLike(child)) continue; // an untouched optional field never blocks

      if (child.kind === 'RadioGroup') {
        const { option, optionPath } = selectedOption(ctx, child, childPath);
        if (option && !isBranchComplete(ctx, option, optionPath)) return false; // selected but unfinished
        continue;
      }

      if (child.isRepeating) {
        const count = instanceCount(ctx, child);
        for (let i = 0; i < count; i++) {
          const instancePath = `${childPath}[${i}]`;
          if (isLeafLike(child)) {
            if (!isLeafComplete(ctx, child, instancePath)) return false; // the row exists, so finish it
          } else if (!allRequiredChildrenComplete(ctx, child, instancePath)) {
            return false;
          }
        }
        continue;
      }

      if (isActivated(ctx, child, childPath) && !allRequiredChildrenComplete(ctx, child, childPath)) return false;
      continue;
    }

    // --- required children ---

    if (child.kind === 'RadioGroup') {
      const { option, optionPath } = selectedOption(ctx, child, childPath);
      if (!option || !isBranchComplete(ctx, option, optionPath)) return false;
      continue;
    }

    if (child.isRepeating) {
      const count = instanceCount(ctx, child);
      if (count === 0) return false; // parity 1.3: a required list with no rows is not complete
      for (let i = 0; i < count; i++) {
        const instancePath = `${childPath}[${i}]`;
        if (isLeafLike(child)) {
          if (!isLeafComplete(ctx, child, instancePath)) return false;
        } else {
          if (!allRequiredChildrenComplete(ctx, child, instancePath)) return false;
          if (!hasAnyDescendantValue(ctx, child, instancePath)) return false; // an existing row can't be entirely blank
        }
      }
      continue;
    }

    if (isLeafLike(child)) {
      if (!isLeafComplete(ctx, child, childPath)) return false;
      continue;
    }

    if (!allRequiredChildrenComplete(ctx, child, childPath)) return false;
  }

  return true;
}

/**
 * Strict completeness: EVERY child, optional ones included, is complete in its
 * own right. This is what keeps §9's "optional child poisoning" alive for
 * optional and inactive containers — they only reach Green once there is
 * genuinely nothing left to fill in. A container with no children is never
 * strictly complete.
 */
function allChildrenComplete(ctx, element, path) {
  if (!element.children || element.children.length === 0) return false;

  for (const child of element.children) {
    const childPath = joinPath(path, child.elementName);

    if (child.kind === 'RadioGroup') {
      const { option, optionPath } = selectedOption(ctx, child, childPath);
      if (!option || !isBranchStrictlyComplete(ctx, option, optionPath)) return false;
      continue;
    }

    if (child.isRepeating) {
      const count = instanceCount(ctx, child);
      if (count === 0) return false;
      for (let i = 0; i < count; i++) {
        const instancePath = `${childPath}[${i}]`;
        if (isLeafLike(child)) {
          if (!isLeafComplete(ctx, child, instancePath)) return false;
        } else {
          if (!allChildrenComplete(ctx, child, instancePath)) return false;
          if (!hasAnyDescendantValue(ctx, child, instancePath)) return false;
        }
      }
      continue;
    }

    if (isLeafLike(child)) {
      if (!isLeafComplete(ctx, child, childPath)) return false;
      continue;
    }

    if (!allChildrenComplete(ctx, child, childPath)) return false;
    if (!hasAnyDescendantValue(ctx, child, childPath)) return false;
  }

  return true;
}

/**
 * A selected branch is complete when everything it requires is filled AND
 * something in it actually has a value. The value requirement is what stops a
 * branch of nothing but empty optional fields from turning a required radio
 * group Green the instant a button is clicked.
 */
function isBranchComplete(ctx, option, optionPath) {
  if (option.isRepeating) return repeatingBranchComplete(ctx, option, optionPath, allRequiredChildrenComplete);
  if (isLeafLike(option)) return isLeafComplete(ctx, option, optionPath);
  return allRequiredChildrenComplete(ctx, option, optionPath) && hasAnyDescendantValue(ctx, option, optionPath);
}

/** isBranchComplete's strict counterpart — every field in the branch, not just
 *  the required ones. Only an OPTIONAL radio group in an inactive context asks
 *  for this much before it will read Green. */
function isBranchStrictlyComplete(ctx, option, optionPath) {
  if (option.isRepeating) return repeatingBranchComplete(ctx, option, optionPath, allChildrenComplete);
  if (isLeafLike(option)) return isLeafComplete(ctx, option, optionPath);
  return allChildrenComplete(ctx, option, optionPath) && hasAnyDescendantValue(ctx, option, optionPath);
}

/** A repeating branch's path is un-indexed at this point, so expand it: every
 *  instance must pass, and zero instances is never complete. */
function repeatingBranchComplete(ctx, option, optionPath, childrenComplete) {
  const count = instanceCount(ctx, option);
  if (count === 0) return false;
  for (let i = 0; i < count; i++) {
    const instancePath = `${optionPath}[${i}]`;
    if (isLeafLike(option)) {
      if (!isLeafComplete(ctx, option, instancePath)) return false;
    } else {
      if (!childrenComplete(ctx, option, instancePath)) return false;
      if (!hasAnyDescendantValue(ctx, option, instancePath)) return false;
    }
  }
  return true;
}
