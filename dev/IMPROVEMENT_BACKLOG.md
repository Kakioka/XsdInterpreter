# Improvement backlog — beyond parity

**Nothing in this file is a parity item.** Parity work lives in `dev/PARITY_GAP_ANALYSIS.md` and
should land first; this is the list of places where the WPF original is *not* a ceiling, noted
while doing the comparison so they don't get lost.

Two kinds of entry here:

- **Don't-inherit** — limitations the original has (several documented by its own
  `project-context.md` §16 "Known Limitations") that there is no reason to faithfully reproduce.
  Catching these during replication is cheaper than fixing them after.
- **Beyond-parity** — capabilities the web platform makes available that a WPF desktop app
  couldn't have, plus maintainability work the comparison made visible.

A third lens cuts across both: the web tool aims to be **domain-agnostic** where the original
served one department (see `dev/PARITY_GAP_ANALYSIS.md` → *Scope of parity — generic behavior
only*). That raises the priority of anything which lets the tool cope with schemas nobody
anticipated — C.2 especially — and lowers the value of polishing features that only made sense
for one organization's workflow.

Ordered within each section by value-per-effort as judged at write time (2026-11-18), not by
dependency.

---

## A. Don't inherit these

### A.1 Repeating-instance counts are keyed by bare element name — collision risk

`FormEngine.getRepeatingInstanceCount(basePath)` / `setRepeatingInstanceCount(basePath, count)`
take a parameter *named* `basePath`, but **every caller passes `element.elementName`** — a bare,
unqualified name (`formRenderer.js:119`, `:180`, `:258`; `app.js:417`; `undoService.js:43` and
four more). `coloringService`, `validation`, `xmlWriter`, and `xmlReader` all read
`state.repeatingInstanceCounts[elementName.toLowerCase()]` directly, so the convention is at
least self-consistent.

This is the WPF app's own documented limitation —

> `_repeatingCounts` keyed by bare schema ElementPathBase (no indices). Same nested repeater
> under multiple parent instances → counts collide (last-write-wins). Tolerable today.

— except **the web version is strictly worse**: WPF keys by `ElementPathBase` (the full dotted
path, minus indices), which at least distinguishes `A.List.ListEntry` from `B.List.ListEntry`.
Keying by bare `elementName` does not. Two sibling containers in the same form each holding a
repeating child of the same name share one count.

In practice synthetic entry wrappers are named `{Parent}Entry`, so they're usually unique by
construction, which is why this hasn't bitten yet. It will the first time a schema repeats a
*named* element (rather than wrapping it in an anonymous sequence) under two different parents —
an idiom the parser already handles correctly in every other respect.

**Do:** key by the full runtime path, indices included, the same way `fieldValues` and
`radioSelections` already are. Rename the parameter to match reality in the meantime — a
parameter called `basePath` that must receive a bare name is a trap. Touches the same six
modules as any shape change (see B.1), so it pairs naturally with that work.

### A.2 Two near-identical tree walks kept in sync by hand — **DONE**

> **Done** in Phase 1 of `dev/IMPLEMENTATION_ORDER.md`, alongside parity 1.1–1.3 as this entry
> recommended. `coloringService.analyzeForm(schemaElement, state)` returns `{colors, errors}`
> from one traversal; `js/ui/validation.js`'s `validateSchema` iterates the instance keys, stamps
> form/instance identity on each error and appends the reader's unmatched fields, and dispatches
> on no schema shapes at all. `web-implementation-spec.md` §9 and §16 were rewritten to describe
> the merged walk. A side effect worth noting: the structural validation walk is now in `js/core/`
> and therefore covered by `node --test` rather than only by a browser harness.

The WPF app walks the schema tree twice with almost the same logic: once for coloring
(`ComputeRecursive`) and once for completeness errors (`CollectCompletenessRecursive`). Its
invariant §13 #47 exists *purely* to warn that the two must be changed together — that's a
design smell documented as a rule.

The web app inherited the split (`coloringService.computeAllColors` vs
`validation.validateSchema`) and so inherited the hazard.

**Do:** when adding the activation context (parity 1.1 + 1.2 — which must touch both walks
anyway), merge them into **one** walk that emits both a color map and an error list. The two
already compute the same predicates from the same inputs; doing it once removes the whole class
of "coloring says green, validation says error" contradiction (exactly the symptom in parity
1.3). This is the single best moment to do it — don't fix the two walks separately and then try
to merge them later.

### A.3 Facet validation is duplicated — **DONE**

> **Done** in the same pass. `coloringService.validateFieldValue(value, element)` returns
> `{valid, message}` and is the only facet switch in the codebase; `validation.js` re-exports it
> as `validateField` and `isFieldValid` is a verdict-only wrapper for the coloring path. Parity
> 1.9's three new facets are now a one-place change.

`validation.js`'s `validateField` and `coloringService.js`'s `isFieldValid` are the same facet
switch with different return shapes, and both carry comments acknowledging it. Parity 1.9 adds
three facets and will have to add them twice.

**Do:** one exported predicate in `core/` returning `{valid, message}`; let the coloring path
ignore `message`.

### A.4 Undo is a bounded 50-entry stack with no visibility

Matches WPF. On a form with hundreds of fields, 50 entries is a few minutes of work, and there's
no indication when the oldest entry falls off or any way to see what's on the stack.

**Do:** raise or remove the cap (actions store only paths/values/flags — they're cheap), and
consider an undo-history list. Low effort, and the action classes already carry enough
description to label entries.

### A.5 Schema diff line numbers would come from the flattened document

WPF known limitation: diff output reports line numbers from the flattened doc, not the original
`.xsd` files, which makes them useless for navigating to the source.

**Do:** if the diff is built (parity 2.2), carry `{sourceFile, line}` through flattening from
the start rather than retrofitting it. The flattener needs a `_sourceFile` annotation for the
diff anyway.

### A.6 Two WPF limitations that disappear for free on the web

Noted so nobody spends time on them:

- **Schema diff dedup key may throw on edge-case characters** — WPF uses `XName.Get` as a
  dictionary key. A JS `Map` key is an arbitrary string; the failure mode doesn't exist.
- **Validation panel doesn't disambiguate repeatable-form instances** — already fixed here.
  `renderResults` groups by `err.instanceKey`, not form name, so `SampleEventLog#EVT-001` and
  `#EVT-002` get separate headers. **Don't regress this.** (The group *header* still prints the
  raw `FormName#<uuid>` string — that's parity item 3.2's labeling fix, not a grouping bug.)

---

## B. Architecture and maintainability

### B.1 Collapse the five-way shape dispatch into one visitor

**The highest-value structural change available.** Documented in `CLAUDE.md` as the main
maintenance hazard: `parser.js`, `formRenderer.js`, `xmlWriter.js`, `xmlReader.js` and
`coloringService.js` each independently dispatch on the same structural shapes (transparent
wrappers, repeating content containers, choice-only containers, radio groups, attributes,
leaves). It was six until A.2 merged the coloring and completeness-error walks —
`ui/validation.js` no longer dispatches on shapes at all.

This isn't hypothetical — the evidence is in the codebase's history. `coloringService.js`'s
`colorOfNode` and `validation.js`'s `validateNode` each carried **near-identical 10-line
comments** explaining the same fix (the `isRepeatingContentContainer` parent-shape gate being
too narrow), because the same bug had to be found and fixed separately in each; A.2 collapsed
those two into the one comment now in `walkNode`. `dev/PHASE9_DRYRUN_FINDINGS.md` finding #0
describes its own scope as "the same five-way parallel structure `isRepeatingContentContainer`
already has to keep in sync."

**Do:** one `walkSchema(element, path, visitor)` in `js/core/`, owning shape recognition,
path construction via `joinPath`, repeating-instance expansion, and radio-branch resolution.
Each concern supplies a visitor with `onLeaf` / `onAttribute` / `onContainerEnter` /
`onContainerExit` / `onRadioGroup` callbacks. A new structural shape is then recognized once.

Caveats worth planning for: the writer and reader traverse in opposite directions (tree→XML vs
XML→tree), so they may need a second walker rather than sharing one; and `formRenderer` needs to
build DOM in parallel with the walk. Start with the four read-only consumers
(coloring, validation, writer, test-data fill) and judge from there.

### B.2 Make the `core/` layer testable in Node

**Status: done** (Phase 0). `npm test` →
`node --test "test/**/*.test.mjs"`. Implemented WITHOUT the `linkedom` devDependency suggested
below — `test/helpers/xmlDom.mjs` hand-rolls the XML DOM instead, so the suite runs on a clean
checkout with no install and no network, and defers to `linkedom` if it is ever added.
`dependencies` and `devDependencies` in `package.json` are both empty.

Right now **nothing can verify a change without a human opening a browser and reading
PASS/FAIL rows** — a real drag on both human and agent iteration, and the reason `CLAUDE.md` has
to tell agents not to claim a change is verified.

The fix is unusually cheap, because the zero-DOM rule for `js/core/` was enforced. Actual
browser-global usage across all ten core modules:

| Global | Modules | Node 20+ |
|---|---|---|
| `TextEncoder`, `Blob`, `crypto`, `CompressionStream` | packager, xmlReader | **native** |
| `localStorage` | packager (3 call sites, settings persistence only) | 5-line stub |
| `DOMParser`, `XMLSerializer`, `document` | flattener, xmlReader, xmlWriter | needs `linkedom` (devDependency) |

So seven of ten core modules run under `node --test` today with no shims at all, and the other
three need one small XML-DOM package used only in tests.

**Do:** port the existing harness assertions for `core/` into `node --test` files; keep browser
harnesses for the `ui/` layer, where they earn their keep (the live render stage is genuinely
useful). Add a `package.json` with **devDependencies only** — this does not violate the
zero-dependency rule, which is about what ships to the browser.

Follow-on: once `core/` is headless, the Tier 1 coloring/validation rewrite becomes a
characterization-test exercise instead of a careful-reading exercise. The WPF app has ~25 xUnit
coloring characterization tests to mine for cases.

### B.3 No error boundary

**Status: done** (Phase 0) — `js/ui/errorBoundary.js`.

There's no `window.onerror` or `unhandledrejection` handler. A throw partway through
`switchToForm` leaves a half-built DOM in `#form-content-host` with `appState.currentInstanceKey`
already reassigned — the UI is dead with no message, and the user's unsaved state is still in
`FormEngine` but unreachable. WPF added crash logging for the same reason (commit `7c084b4`).

**Do:** global handlers that show a recoverable error panel, and offer "download current state
as XML" so work in progress isn't lost to a bug. Pairs with C.1.

### B.4 `localStorage` failures are silently swallowed everywhere

Eleven `try { … } catch {}` blocks with empty bodies and a comment that the feature "still works
for this session." Correct behavior, but the user is never told their theme/zoom/layout won't
persist.

**Do:** detect once at startup and surface a single quiet notice, rather than failing silently
eleven times.

---

## C. Capabilities the desktop app couldn't have

### C.1 Autosave and crash recovery — treat as required, not optional

**Status: done** (Phase 0) — `js/core/autosaveStore.js` + `js/ui/autosave.js`.

**This is a regression the web introduces, not just a missing nicety.** The WPF app held state
in a process the user deliberately closed. A browser tab can be closed by accident, crash, or be
discarded by the OS under memory pressure — and `FormEngine` state lives only in memory. Hours
of data entry on a multi-form packet vanish with no warning and no recovery.

**Do:** persist `getAllFormStates()` to IndexedDB on a debounce, keyed by schema + packet, and
offer recovery on next load. `beforeunload` warning when dirty is a one-liner worth having
immediately, as a stopgap.

### C.2 Real XSD validation via WASM

**Under the domain-agnostic goal this is arguably the single most valuable item in this file.**

The one capability where the web port is genuinely behind: WPF had `System.Xml.Schema` doing
real schema validation (`XmlValidatorService`, 476 LOC, plus path translation to map validator
errors back to control paths). The browser has no XSD validator, so `validateSchema` is a
hand-rolled structural approximation that can only check what `parser.js` models — which is
exactly why `dev/PHASE9_DRYRUN_FINDINGS.md` has ten open findings about constructs that are
"invisible to `validateSchema`."

That gap was tolerable when the input was one known schema family whose constructs could be
enumerated and hand-modelled. It is not tolerable for a tool that accepts **arbitrary** XSD:
hand-modelling every construct any schema might use is unbounded work, and every one missed
fails silently. Delegating the final correctness check to a real validator is the only approach
that scales to unknown input — it turns "we don't model this" from a silent data-loss bug into a
reported error.

**Do:** evaluate a WASM build of libxml2 or Xerces to validate the generated XML against the
original (unflattened) schema set. This would close most of Phase 9 in one move — unmodeled
constructs stop being silent, because the real validator sees them even though the form renderer
doesn't. Keep the hand-rolled walk for *live* per-field feedback; use the real validator at
Validate/Save/Package time.

Worth a spike before committing: WASM bundle size against the offline-deployment constraint, and
whether the error paths can be translated back to control paths the way WPF's
`TranslateToControlPath` did.

### C.3 Web Workers for flatten/parse

The spec flags this itself (§13 Loading Overlay, §25 Scale). The production fixture set is
already 42 files; the spec notes real-world schemas "commonly run to thousands of elements
across dozens of included files." Flatten and parse are synchronous and block the main thread — `withBusyOverlay`
currently just yields two frames so the spinner paints, which doesn't help once the work takes
seconds.

**Do:** `core/` is DOM-free, so flattener + parser move into a Worker almost unchanged (same
property that makes B.2 easy). Gives a real progress bar instead of an indeterminate spinner.

### C.4 Installable offline PWA

The target environment is described as "a secure offline Windows environment (no network
dependencies)" — which is what the EXE was *for*. A service worker plus a manifest gets the same
property with no installer, no admin rights, and no per-machine deployment: the strongest
argument for the web rewrite existing, and currently unexploited.

### C.5 File System Access API

Saving is download-only today, and spec §12 notes the last schema folder "can't re-open
automatically due to browser security." That's true of a path string, but not of a handle —
`showDirectoryPicker`/`showSaveFilePicker` handles persist in IndexedDB and can be re-granted
with one click.

**Do:** save-in-place to the same XML file (no more `packet (3).xml` in Downloads), and a recent-
schemas list that actually reopens. Chromium-only, so keep the `webkitdirectory` fallback.

### C.6 Drag-and-drop schema folder

Mentioned in spec §24 as an alternative to `showDirectoryPicker`, never implemented.
`DataTransferItem.webkitGetAsEntry()` reads a dropped directory recursively. Small, and a better
first-run experience than a file dialog.

### C.7 Deep links

A URL hash encoding `{form instance, field path}` makes "look at this field" shareable between
colleagues reviewing the same packet — impossible in the desktop app. Cheap, given that
`switchToForm` + the search panel's `highlightPath` already do all the work.

---

## D. UX improvements over the original

### D.1 R/G/Y completeness is signaled by color alone

Deferred in spec §26 (Accessibility), and the WPF app had no accessibility story either — so
this is an improvement, not a parity gap. The core completeness signal, the thing the whole tool
is organized around, is invisible to colorblind users and to screen readers.

**Do:** pair every border color with a non-color cue — an icon or a short text badge on
containers, `aria-invalid` + `aria-describedby` on fields. Also in §26's scope: ARIA roles for
the custom `.radio-group` widget, focus management when panels open/close, and keyboard handling
for repeating add/remove.

### D.2 "Jump to next incomplete field"

R/G/Y tells you *that* a 400-field form is incomplete, not *where*. Users currently scroll
hunting for red. The coloring pass already computes the full color map — the next red leaf in
document order is free information.

**Do:** a toolbar button plus a keybind, cycling red leaves in order. Probably the single
highest-impact UX addition for real data entry.

### D.3 Nav tree filter

A real packet has dozens of forms. A filter box over the nav tree, once it's hierarchical
(parity 3.2), is a few lines.

### D.4 Richer format guidance

Parity 2.3 brings back WPF's pattern→prose describer. The web can go further with the same
parsed pattern: an example value ("e.g. `123-45-6789`"), an input mask or
`inputmode`/`autocomplete` hint, and inline format text under the field rather than only an
error after the fact. Turns a format rule from a post-hoc complaint into guidance.

### D.5 Collapsible containers / progressive disclosure

Large generated forms render as one enormous scroll. Collapsible containers that remember their state
per form, with auto-expand on a search or validation jump, would help — note that collapsing
must not unmount, or coloring's DOM index and `registerControlsUnder` break (use
`hidden`/`display`, as the radio branches already do).

### D.6 "New since schema version X" badges

Once the schema diff engine exists (parity 2.2), it can be pointed at *two versions of the
loaded schema* instead of two folders, and the result rendered inline as badges on changed
fields. For anyone migrating existing data to a newer schema version that is the actual question
they have, and neither app answers it today. A genuine beyond-parity feature that the diff work
unlocks nearly for free.

---

## Suggested ordering

| When | Items | Why then |
|---|---|---|
| **During** parity Tier 1 | A.2, A.3 | They touch the exact code being rewritten anyway; merging the walks after fixing them twice is wasted work |
| **Before** parity Tier 1 | B.2 | Headless `core/` tests turn the coloring rewrite from careful reading into characterization testing — the WPF xUnit suite supplies the cases |
| Alongside any shape change | A.1, B.1 | Both are six-module edits; batch them |
| Early, independent | C.1 (autosave), B.3 (error boundary) | Pure data-loss protection; no dependency on parity work |
| After parity | C.2, C.3, D.1, D.2 | Each is a standalone project |
| With the diff work | A.5, D.6 | A.5 must be designed in from the start, not retrofitted |
| Opportunistic | A.4, A.6, B.4, C.5, C.6, C.7, D.3, D.4, D.5 | Small, isolated |

**C.1 and B.3 are the two worth doing soonest regardless of parity status** — everything else on
this list costs time, but those two are about not losing a user's work.

---

## Revisit note (2026-11-20)

Once parity (`dev/PARITY_GAP_ANALYSIS.md` Tiers 1–3) is substantially closed, re-examine this
backlog with fresh eyes specifically for web-platform tools and practices that have no WPF
analogue at all — not just the C/D items already listed here, which were found by diffing
against the C# app's own feature set. The original can only suggest improvements shaped like
itself; a second pass should ask what a web-native rebuild would do that the reference app
structurally couldn't, without using it as the starting point. Candidates worth scoping at that
point (illustrative, not a commitment): streaming/progressive rendering for very large forms,
URL-addressable state beyond deep links (C.7), service-worker-based update/versioning strategy
for the PWA (C.4), and whatever the state of in-browser WASM validators (C.2) looks like by then.
At that point also revisit whether UI-layer architecture (React vs. the current vanilla
renderer) is still the right call — see the 2026-11-20 conversation where this was assessed as
not yet justified, pending `B.1`'s core-layer refactor landing first.
