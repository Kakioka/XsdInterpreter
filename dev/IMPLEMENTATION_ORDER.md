# Implementation order — post-parity-analysis work

`dev/PARITY_GAP_ANALYSIS.md` and `dev/IMPROVEMENT_BACKLOG.md` each carry their own internal
sequencing ("Suggested sequencing" / "Suggested ordering"), written from one document's point of
view. This file merges both into one execution order, so items that touch the same code land in
the same pass instead of being revisited twice. It supersedes neither source doc — every item
below links back to the section with the actual rationale, decision table, or code citation.
`IMPLEMENTATION_PLAN.md` (Phases 0–10) is unrelated and already complete; this picks up where
that left off.
Keep an eye out for possible improvements. We should be flexible, and look to utilize the strengths of the this implementation rather than working around the constraints of the C# one. When an opportunity for improvement is noted, discuss with the user. 

Legend: **P** = `dev/PARITY_GAP_ANALYSIS.md` item, **B** = `dev/IMPROVEMENT_BACKLOG.md` item.

---

## Phase 0 — Foundation — **DONE**

Pure data-loss protection and tooling. Nothing below depends on these, but they cost nothing to
do first and the backlog calls both "worth doing soonest regardless of parity status."

- ~~**B.3** Error boundary~~ — `js/ui/errorBoundary.js`: `window.onerror` +
  `unhandledrejection`, a dismissable panel offering "download work in progress (XML)" and a
  schema-independent raw-state JSON dump, plus a bounded in-session crash log. Installed as the
  first statement of `app.js`'s `init()`.
- ~~**C.1** Autosave/crash recovery~~ — `js/core/autosaveStore.js` (IndexedDB, zero DOM) +
  `js/ui/autosave.js` (1.5 s debounce, `beforeunload`/`pagehide`, recovery prompt).
  `app.js`'s `restoreFromSnapshot` applies a snapshot; a successful Save XML clears it.
- ~~**B.2** `node --test` for `js/core/`~~ — `npm test` runs 152 assertions across 10 suites
  with **no dependencies installed**: `test/helpers/xmlDom.mjs` is a hand-rolled XML DOM rather
  than the suggested `linkedom` (same rationale as `packager.js`'s hand-rolled ZIP writer), and
  it defers to `linkedom` if that is ever added. Also includes
  `test/moduleGraph.test.mjs`, a static import/export and Core-UI-boundary check — the nearest
  thing this repo has to a compiler. See CLAUDE.md → *Running and testing*.

**Found while doing B.2:** commit `9c566d2`'s `_ownParticles` refactor had regressed the
anonymous-repeating-`xs:sequence` idiom (§4 Synthetic Nodes) — a repeating top-level sequence
was flattened, dropping the synthetic `…Entry` wrapper and `isRepeating`, so `PriorNameList` /
`LineItems` rendered as one non-repeating row and every value landed at an un-indexed path.
Fixed in `parser.js` by keeping a repeating sequence whole as one particle, with the
repeating test factored into a shared `isRepeatingParticle` helper. `dev/phase1-check.html` and
`dev/phase2-check.html` were already asserting the correct behavior and would have been
reporting FAIL.

The two `KNOWN-WRONG` characterization tests the coloring suite carried — pinning the
pre-activation behavior so the rewrite had to acknowledge each change — did their job in Phase 1
and were replaced by assertions of the new rules.

---

## Phase 1 — Activation-context rewrite — **DONE**

One root cause, three symptoms, two files that had to change together — all done in one pass:

- ~~**P 1.1 + 1.2 + 1.3**~~ — `js/core/coloringService.js` threads `parentIsActiveOrRequired`
  from the form root down, through the reference's decision ladder; zero-instance repeating
  sections are Red-or-Yellow, never Green.
- ~~**B A.2**~~ — `analyzeForm(schemaElement, state)` → `{colors, errors}`, one traversal.
  `js/ui/validation.js` keeps only the packet-level work (instance keys, error identity,
  unmatched fields, the panel) and no longer dispatches on schema shapes, so Phase 7 starts from
  five parallel walkers instead of six.
- ~~**B A.3**~~ — `validateFieldValue` is the single facet switch; `validateField` is a
  re-export and `isFieldValid` a verdict-only wrapper. Phase 2's three new facets are a
  one-place change.

**Spec rewritten, not just code:** `web-implementation-spec.md` §9 and §16 described the old
pure roll-up and the old ungated walk, so they were rewritten in the same pass (the user's
call) and §22 gained invariant 30. The spec is the source of truth per CLAUDE.md, so leaving it
describing superseded algorithms would have made every later phase argue with it.

**Decisions taken beyond a literal port of the reference,** each documented where the code is:

- An explicit radio selection, and an existing repeating instance, each count as activation for
  **errors as well as colors**. The reference's coloring walk says so while its completeness walk
  does not, so it paints a selected branch's required fields Red while Validate stays silent and
  Save XML emits the incomplete branch unwarned. (The repeating case is not even a divergence:
  the reference derives instance counts from the values themselves, so `count > 0` always implied
  a value was present — this codebase stores counts explicitly and can represent a blank added
  row.)
- Container completeness requires each leaf to be present **and valid**, where the reference
  checks presence only — otherwise §9's filled-but-invalid-is-Red rule would not survive the
  roll-up.
- An unchecked checkbox (boolean `false`) counts as *answered* but not as *engagement*. The
  reference treats `false` as no value at all, which is why it carries checkbox exceptions at
  several call sites; here it would otherwise activate every container holding a checkbox the
  moment a form rendered.

**Found while doing this:** `dev/phase5-check.html`'s section E asserted an occurrence error for
the fixture's two `<PriorNameList>` entries, read against the OUTER element's `maxOccurs=1`.
That row has never passed — occurrence bounds are checked against the repeating node (the
synthetic `PriorNameListEntry`, whose `<xs:sequence maxOccurs="unbounded">` allows any number),
and `parser.js` deliberately leaves reconciling those two independent numbers open. The row was
corrected to assert the real contract, with the bounds check itself now covered headlessly.

---

## Phase 2 — Facet extraction and input hardening

- **P 1.9** — extract `minExclusive`, `maxExclusive`, `length`; add the pattern→`maxLength`
  derivation (feeds Phase 8's field sizing too).
- **P 1.8** — set native `maxlength`/`min`/`max`/`step`/`pattern` attributes from the now-complete
  rule set.

---

## Phase 3 — Domain-specific behavior → configuration

Both items are "move a hardcoded assumption into data," and share one notion of per-schema
settings — do together.

- **P 1.4** — packaging export-profile mechanism (archive layout + metadata schema as data, not
  literals in `packager.js`); ship the original department's rules as the one bundled profile.
- **P 1.5** — configurable instance-id source (heuristic + per-schema override), replacing the
  hardcoded `documentId` convention.

---

## Phase 4 — Small independent fixes (no ordering constraint between them)

- **P 1.6** — wire `#switch-root-btn` or remove it.
- **P 1.7** — search falls back to nearest rendered ancestor when the target has no layout box.
- **P 1.11** — BOM interior-mark scan off-by-one.
- **B A.4** — raise or remove the 50-entry undo cap.

---

## Phase 5 — Nav tree and manifest

- **P 3.2** — hierarchical nav tree, instance labeling/renumbering, positional insertion.
- **P 3.3** — `PacketManifest.schemaVersion` + `PacketSection.sourceSchemaFile`.
- **B D.3** — nav tree filter (needs 3.2's hierarchy to be worth doing).

---

## Phase 6 — Theming, dialogs, settings

- **P 3.1** — remaining 18 theme tokens.
- **P 3.5** — replace `window.confirm`/`window.alert` with real dialogs (BOM cleanup, unmatched
  fields) using the existing dynamic-overlay pattern.
- **P 3.6** — the two unimplemented `localStorage` keys (`xmlEditor.lastSchema`,
  `xmlEditor.fieldSizeOverrides` — latter blocked on Phase 8).
- **B B.4** — surface `localStorage` failures with one quiet notice instead of swallowing them
  in eleven places.

---

## Phase 7 — Structural refactor milestone

The largest architectural item in either document. Do it here, not earlier: Phase 1 already
merged coloring+validation into one walk (A.2), so this unification starts from five dispatch
sites instead of six.

- **B B.1** — collapse the remaining parallel shape dispatch (`parser.js`, `formRenderer.js`,
  `xmlWriter.js`, `xmlReader.js`, the merged coloring/validation walk) into one `walkSchema`
  visitor. Start with the read-only consumers per B.1's own note; the writer/reader may need a
  second walker since they traverse in opposite directions.
- **B A.1** — fix repeating-instance-count keying (bare `elementName` → full runtime path) in the
  same pass, since it touches the identical six modules.

---

## Phase 8 — Spec amendments, then field sizing and pattern description

`web-implementation-spec.md` is authoritative, so the spec sections below must be written before
any of this is "parity work" rather than invention — see Tier 4 in `PARITY_GAP_ANALYSIS.md`.

1. Write the spec sections: field sizing categories + CSS widths, pattern-describer behavior,
   date shorthand (if wanted), theme background images, label resolver chain.
2. **P 2.1** — field sizing (5 categories, override JSON).
3. **P 2.3** — pattern describer (known-pattern table first — pure data, reusable as-is).
4. **P 1.10** — `ValidationRule.userFriendlyMessage` equivalent, alongside 2.3.
5. **B D.4** — richer format guidance (example value, `inputmode`/`autocomplete` hints) — free
   follow-on once the pattern describer exists.

---

## Phase 9 — Schema diff

- **P 2.2** — the full diff pipeline. Needs the flattener's `_sourceFile` relative-path
  annotation built first.
- **B A.5** — carry `{sourceFile, line}` through flattening **from the start** of this phase, not
  retrofitted afterward — it's the one WPF limitation worth fixing rather than inheriting, and
  only cheap if designed in from day one.
- **B D.6** — "new since schema version X" badges — point the diff engine at two versions of the
  same loaded schema instead of two folders; nearly free once 2.2 exists.

---

## Phase 10 — Unmodeled XSD constructs

- Refresh `dev/PHASE9_DRYRUN_FINDINGS.md`'s summary table first (two of its twelve findings are
  already fixed and it currently says otherwise).
- **B C.2** — before hand-modeling the remaining ten findings one construct at a time, evaluate
  a WASM XSD validator (libxml2/Xerces). Per the backlog, this is "the more general fix than
  hand-modeling each construct" and is arguably the single most valuable item in that document
  under the domain-agnostic goal — spike it before committing to more manual construct work.
- **P 2.6** — whatever constructs remain unaddressed by C.2, scheduled against
  `sample-schemas/SampleSchema/`.

---

## Phase 11 — Platform capabilities (independent of everything above; can run in parallel)

No ordering constraint between these five; sequence by whichever is most useful at the time.

- **B C.3** — Web Workers for flatten/parse (the spec itself flags this at scale).
- **B C.4** — installable offline PWA.
- **B C.5** — File System Access API (save-in-place, recent-schemas list).
- **B C.6** — drag-and-drop schema folder.
- **B C.7** — deep links.

---

## Phase 12 — Accessibility and remaining UX polish

- **B D.2** — "jump to next incomplete field." Flagged in the backlog as "probably the single
  highest-impact UX addition for real data entry" and depends on nothing but correct coloring
  (Phase 1) — pull this earlier than Phase 12 if a quick, high-visibility win is wanted sooner.
- **B D.1** — non-color completeness cues, ARIA roles/labels, focus management (spec §26).
- **B D.5** — collapsible containers. Must use `hidden`/`display`, never unmount — coloring's DOM
  index and `registerControlsUnder` depend on nodes staying put (same constraint Phase 7's B.1
  work needs to respect if it changes how controls are registered).

---

## Standing reminder

**B A.6** needs no scheduled work — it's already correct; it's listed in the backlog purely as a
"don't regress this" flag (validation panel disambiguates repeatable-form instances by
`instanceKey` already).

Re-run the **Revisit note** at the end of `dev/IMPROVEMENT_BACKLOG.md` once Phase 10 closes out:
at that point most of Tiers 1–3 are done and it's the right moment for a from-scratch look at
web-native capabilities, including whether Phase 7's structural refactor changes the
React-vs-vanilla calculus for the UI layer.
