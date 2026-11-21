# Implementation order — post-parity-analysis work

`dev/PARITY_GAP_ANALYSIS.md` and `dev/IMPROVEMENT_BACKLOG.md` each carry their own internal
sequencing ("Suggested sequencing" / "Suggested ordering"), written from one document's point of
view. This file merges both into one execution order, so items that touch the same code land in
the same pass instead of being revisited twice. It supersedes neither source doc — every item
below links back to the section with the actual rationale, decision table, or code citation.
`IMPLEMENTATION_PLAN.md` (Phases 0–10) is unrelated and already complete; this picks up where
that left off.

Legend: **P** = `dev/PARITY_GAP_ANALYSIS.md` item, **B** = `dev/IMPROVEMENT_BACKLOG.md` item.

---

## Phase 0 — Foundation (start immediately, no dependencies)

Pure data-loss protection and tooling. Nothing below depends on these, but they cost nothing to
do first and the backlog calls both "worth doing soonest regardless of parity status."

- **B.3** Error boundary — global `window.onerror`/`unhandledrejection` handler, recoverable
  error panel, "download current state as XML."
- **C.1** Autosave/crash recovery — `IndexedDB` persistence of `getAllFormStates()` on debounce;
  `beforeunload` warning as an immediate stopgap.
- **B.2** Make `js/core/` testable under `node --test` — do this *before* Phase 1, not after.
  It turns the Phase 1 rewrite from "read the C# carefully" into "port the WPF xUnit
  characterization tests," and it's cheap (7 of 10 core modules need no shim at all).

---

## Phase 1 — Activation-context rewrite (highest-value item in either document)

One root cause, three symptoms, two files that must change together — do all of it in one pass:

- **P 1.1 + 1.2 + 1.3** — thread `parentIsActiveOrRequired` through `coloringService.js` and
  `validation.js`; fix the zero-instance-repeating-section-colors-Green bug as part of the same
  decision-ladder rewrite.
- **B A.2** — while both walks are already open for surgery, merge `computeAllColors` and
  `validateSchema` into one walk emitting both a color map and an error list. Doing this after
  the fact means re-touching the same lines twice.
- **B A.3** — same reasoning for the duplicated facet switch: merge `validateField` /
  `isFieldValid` into one exported `core/` predicate now, since Phase 2 (below) would otherwise
  add three new facets to both copies.

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
