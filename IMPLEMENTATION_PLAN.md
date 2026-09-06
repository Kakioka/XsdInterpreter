# Implementation Plan — XML Form Editor (Web)

This is the day-to-day working document. `web-implementation-spec.md` (~1,850 lines) is
the source of truth for exact algorithms and pseudocode, but it's too large to re-read in
full at every step. This plan breaks the build into ordered phases, each scoped to a small
set of spec sections (`§N`), with its own acceptance criteria — so the workflow per phase is:

1. Open **only** the `§` sections listed for that phase.
2. Build it.
3. Check it off against that phase's acceptance criteria (many map directly to
   `sample-schemas/WALKTHROUGH.md`'s numbered checklist, reused as a traceability matrix below).
4. Move on — don't re-read the whole spec "just in case" between phases.

`sample-schemas/` (`SamplePacket.xsd`, `SampleCommonTypes.xsd`, `SampleGroups.xsd`,
`SamplePacket.xml`, `WALKTHROUGH.md`) is the fixture set for every phase below. Nothing here
needs a real IRS/state schema yet — that's Phase 9, explicitly gated on obtaining one.

Build order follows the spec's own Core/UI split (§1): pure logic with no DOM first, so it's
testable (console or a tiny script) before there's anything to look at in a browser.

---

## Phase 0 — Scaffold

**Do:** `index.html` shell, `css/main.css` stub, empty `js/core/*.js` / `js/ui/*.js` files per
the file list, ES module wiring (`<script type="module">`), one default `.theme.json`.

**Spec refs:** §1, §23. (Skip §13's HTML structure for now beyond the bare `<div id="app">` —
real markup lands in Phase 3.)

**Done when:** page loads with zero console errors and nothing else.

---

## Phase 1 — Core Parsing Pipeline (no UI)

Goal: sample XSD folder → validated `SchemaElement` tree + `PacketManifest`. Provable from a
console/script without any rendering.

| Step | Build | Spec refs |
|---|---|---|
| 1.1 | Flattener: include/import resolution, BOM scan/strip, `targetNamespace` capture | §3 |
| 1.2 | `TypeLookupTable` + parser: kind assignment, synthetic `RadioGroup`/`SequenceContainer` nodes, `xs:attribute` support (+ `isInstanceIdSource`), `xs:group` expansion, `xs:all` transparency, inline-simpleType base resolution | §2, §4 |
| 1.3 | Packet analyzer: `analyzePacket`, root-file detection and root-element detection (both "not referenced anywhere else" — no naming convention) | §5, §8 (path/`joinPath` convention — the parser sets `elementPath` using it) |

**Done when:** a script loads the three sample `.xsd` files, flattens, parses, and analyzes
them, and the printed output matches `WALKTHROUGH.md` §§1–13, 15, 20 by inspection (dropdown
options, validation rules, synthetic wrapper names, attribute placement, group expansion,
root element found automatically with no ambiguity for `SamplePacket`).

---

## Phase 2 — FormEngine + XML Writer/Reader (still no UI)

Goal: `SamplePacket.xml` → `FormState` maps → XML string round-trip, entirely headless.

| Step | Build | Spec refs |
|---|---|---|
| 2.1 | `FormEngine`: register/unregister controls, active-form persist-then-clear rule, case-insensitive path lookups | §6 |
| 2.2 | `xmlReader`: attribute reads, the repeating-content-container special case (outer element's tag repeats, not the Entry wrapper's), choice-branch detection, unmatched-field collection | §11 |
| 2.3 | `xmlWriter`: mirrored — attribute writes, `syncInstanceIdAttribute`, namespace-aware element creation, choice-branch writing with the "explicit selection first, first-populated-branch fallback" rule | §10 |

**Done when:** reading `SamplePacket.xml` into `FormState` and writing it back out reproduces
the original data (order-insensitive under `xs:all`; required-but-empty fields still emitted
per the writer's rule). Use the table at the bottom of this doc to confirm items 8, 16, 18,
19, 21, 24, 25, 27.

**Watch for** (these were bugs in earlier spec drafts, now fixed — don't reintroduce them):
leading-dot path keys from concatenating `path + '.' + name` instead of `joinPath` (§8); the
Entry wrapper's own name leaking into emitted XML instead of its parent's (§22 invariant 25).

---

## Phase 3 — Rendering + Basic Interaction (first pixels)

Goal: render a chosen form, edit values, see them in `FormEngine`; switch forms with no
state bleed between instances.

| Step | Build | Spec refs |
|---|---|---|
| 3.1 | `controlFactory`: one input element per `ElementKind` | §7 (Control Factory) |
| 3.2 | `formRenderer`: dispatch, container/leaf/repeating-section/radio-group rendering, exact-prefix path rewriting on instance add | §7 |
| 3.3 | Minimal `app.js`/`toolbar.js`/`sidebar.js`: load-schema button → nav tree → `switchToForm`, radio fixed-point loop on restore, loading overlay wired per the busy-overlay spec (including the double-`requestAnimationFrame` paint-yield — a naive `showOverlay(); doWork();` will not actually show it) | §13 (Page Layout + Loading Overlay), §20 (Schema Load Flow, Form Switch Flow, Radio Selection loop) |

**Done when:** you can load the sample schema in a real browser, click through the nav tree,
edit fields, add/remove repeating instances, and pick radio branches — and switching between
`SampleEventLog#EVT-001` / `#EVT-002` never bleeds values between them (item 18). Loading
the schema shows a blocking spinner the whole time, not a frozen tab.

---

## Phase 4 — Coloring + Undo/Redo

| Step | Build | Spec refs |
|---|---|---|
| 4.1 | `coloringService` + `coloring.js`: R/G/Y rules, container coloring incl. optional-child-poisons-required-parent, 50ms debounce, index rebuilt only on structural change | §9, §22 invariants 6, 7, 12 |
| 4.2 | `undoService` + `undo.js`: all action types, `isReplaying` guard everywhere an action is recorded, radio-swap `oldBranch` read from the group's own current-selection state (not a `mousedown` snapshot — that misses keyboard-driven swaps) | §14, §22 invariants 13, 14 |

**Done when:** colors match hand-computed expectations for a handful of `WALKTHROUGH.md`
fields; undo/redo survives a form switch, a repeating-instance removal, and a **keyboard-only**
radio branch swap (arrow keys, no mouse) without corrupting `oldBranch` (item 26).

---

## Phase 5 — Full Schema Validation

Not just field facets — structural conformance, since output has to actually be filed.

| Step | Build | Spec refs |
|---|---|---|
| 5.1 | `validateField`: all `ValidationRule` kinds including `totalDigits`/`fractionDigits` | §16 (Field-Level Validation) |
| 5.2 | `validateSchema`: occurrence bounds, single-populated-branch choice enforcement, unmatched-field surfacing | §16 (Full Structural Schema Validation) |
| 5.3 | `validation.js` panel: click-to-navigate, completeness vs. format errors visually distinct | §16 (Validation Panel), §22 invariants 4, 5 |

**Done when:** deliberately broken test data (empty required field, two populated choice
branches, an out-of-range repeating count) is caught by `validateSchema`. Covers items 22, 23.

**Scope reminder:** this validates everything the parser models — not generic arbitrary XSD
(`xs:union`/`xs:list`, identity constraints, substitution groups, wildcards, mixed content).
Those are out of scope until Phase 9 shows they're actually needed. See §25.

---

## Phase 6 — Search, Test Data Fill, Context Menu

| Step | Build | Spec refs |
|---|---|---|
| 6.1 | `searchService` + `search.js`: cross-form search, line-number mode, cross-form navigation | §15 |
| 6.2 | `testDataFiller`: per-kind generation, `RegexSampleGenerator` for patterned fields | §17 |
| 6.3 | `contextMenu.js`: scoped fill/clear, empty-fields-only merge | §18, §22 invariant 22 |

**Done when:** "Fill Required Fields Only" on `SampleEntityForm` produces schema-valid data
per Phase 5's validator, including a pattern field (item 3, `PacketId` → `AB0000`-shaped).

---

## Phase 7 — Theming, Layout Polish, Debug Panel

| Step | Build | Spec refs |
|---|---|---|
| 7.1 | `theme.js`: theme JSON loading, CSS variable application, depth-color interpolation | §12 |
| 7.2 | Splitter, zoom (accept the known `transform: scale()` clipping risk for now — see §13), status bar | §13 |
| 7.3 | `debug.js`: Fields/Schema Tree/State/Export tabs, 200ms debounce | §21 |

**Done when:** themes swap live, sidebar width and zoom persist across reload, debug panel
reflects live field state.

---

## Phase 8 — Packaging (MeF Submission ZIP)

**Build:** `packager.js` with JSZip — dialog, validation, ZIP layout, download.

**Spec refs:** §19.

**Important caveat carried forward, not resolved here:** the manifest XML shape in §19 is an
approximation, not sourced from a real schema (§25). Build the mechanism (dialog → validate →
zip → download) now; treat the manifest's exact element set as a placeholder to be corrected
in Phase 9.

**Done when:** a ZIP downloads with the documented file layout against sample data. Don't
block on manifest accuracy yet.

---

## Phase 9 — Real MeF Schema Hardening (gated on external input)

Not schedulable work — it starts the moment a real state or IRS MeF schema is obtained. Work
through the checklist in §25 of the spec against it:

- Confirm `attributeFormDefault`, whether `xsi:schemaLocation` is expected on output, whether
  a packet ever mixes multiple namespaces.
- Check for constructs the parser doesn't model yet: `xs:union`/`xs:list`, `xs:key`/`xs:unique`/
  `xs:keyref`, substitution groups, `xs:any`/`xs:anyAttribute`, mixed content, `xsi:nil`,
  complex-type `xs:extension` chains. Extend the parser (and Phase 5's validator, since it
  walks the same tree) if any are present.
- Source the actual manifest schema for Phase 8's packager and correct it.
- Sanity-check flatten/parse/render/validate performance at real MeF scale (thousands of
  elements, many included files) — revisit the Web Worker follow-up from §13 if load times
  are bad.

---

## Phase 10 — Accessibility

Deferred by decision (not an oversight) until the tool works end-to-end. Scope per §26:
ARIA roles/labels for the custom radio-group and repeating-section widgets, keyboard/focus
management for add/remove and panel open/close, a non-color-dependent cue alongside the R/G/Y
completeness borders.

---

## Traceability: `WALKTHROUGH.md` checklist → phase

| # | Feature | Phase |
|---|---|---|
| 1 | xs:include flattening | 1.1 |
| 2 | Named simpleType → Dropdown | 1.2 |
| 3 | Named simpleType → TextInput + pattern | 1.2 / 5.1 / 6.2 |
| 4 | Inline simpleType chain → DatePicker | 1.2 |
| 5 | xs:dateTime → DatePicker | 1.2 / 3.1 |
| 6 | xs:boolean → Checkbox | 1.2 |
| 7 | Named complexType → GroupContainer | 1.2 / 3.2 |
| 8 | xs:attribute on complexType | 1.2 / 2.2 / 2.3 / 3.2 |
| 9 | xs:choice → RadioGroup | 1.2 / 2.3 / 3.2 |
| 10 | Nested xs:choice | 1.2 / 3.2 |
| 11 | Fixed-point loop | 3.3 |
| 12 | xs:all transparent | 1.2 |
| 13 | xs:group ref → expansion | 1.2 |
| 14 | xs:group + xs:all (double transparent) | 1.2 |
| 15 | Nested xs:group ref | 1.2 |
| 16 | SequenceContainer | 1.2 / 2.2 / 2.3 / 3.2 |
| 17 | Nested container in repeating | 3.2 |
| 18 | Repeatable form | 1.3 / 2.2 / 3.3 |
| 19 | FormInstanceKey from documentId | 2.2 / 2.3 |
| 20 | Inline element fallback | 1.2 / 1.3 |
| 21 | Unmatched fields | 2.2 / 3.3 |
| 22 | DecimalInput + range rules | 5.1 |
| 23 | NumericInput + range rules | 5.1 |
| 24 | Optional field omission | 2.3 |
| 25 | Required empty field → XML emitted | 2.3 |
| 26 | Undo across form switch | 4.2 |
| 27 | Round-trip | 2 (core) / 3 (full UI regression, retest at the end) |

---

## What this plan deliberately does not re-derive

Anything settled in the spec's §22 "Known Behavioral Rules and Invariants" (27 numbered
rules) applies throughout — it's short enough to keep open as a standing reference across all
phases, unlike the rest of the document. When in doubt about a specific rule during any
phase, check §22 first before the phase's own spec-ref sections.
