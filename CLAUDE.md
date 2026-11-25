# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser rewrite of a .NET 9 / WPF desktop app. It reads a folder of XSD schemas, generates a
data-entry form from them, and produces valid XML — aimed at non-technical users filling out
large, deeply-nested documents without hand-editing XML.

**The web tool is deliberately domain-agnostic: any XSD in, usable form, valid XML out.** The
WPF original did not have that freedom — it served one department and was tuned to that
department's filing standards and daily conveniences. When replicating a feature, replicate the
*schema-shape logic*; do not carry over hardcoded element names, fixed date ranges, a specific
archive layout, or a specific attribute name standing in for instance identity. Where such a
capability is worth having, it belongs in configuration or a swappable profile. See
`dev/PARITY_GAP_ANALYSIS.md` → *Scope of parity — generic behavior only* for the split, and its
*Open question for the spec* for the one place this conflicts with the authoritative spec.

**No build system.** No `package.json`, no bundler, no transpiler, no dependencies. Plain ES
modules loaded by `index.html` via `<script type="module">`. Do not introduce a build step or a
dependency without asking — "zero dependencies" is a deliberate constraint (the target
environment is secure and offline), and `js/core/packager.js` hand-rolls a ZIP writer on
`CompressionStream` specifically to avoid vendoring JSZip.

Deployed via GitHub Pages: https://kakioka.github.io/XsdInterpreter/

## Running and testing

There is no CLI test runner and no build step. Everything runs in the browser, served over
HTTP — ES modules and the theme `fetch()` calls both fail on `file://`.

**The developer uses the Live Server extension in VS Code** (`ritwickdey.LiveServer`). To run
the app or a test harness: right-click the `.html` file in the Explorer → **Open with Live
Server** (or click **Go Live** in the status bar, then navigate). It serves the workspace root
at `http://127.0.0.1:5500/`, so paths are `http://127.0.0.1:5500/index.html` and
`http://127.0.0.1:5500/dev/phase4-check.html`. Live Server auto-reloads on save, so editing a
module and re-checking is just Ctrl+S — no restart.

Don't suggest `python -m http.server` or `npx serve` as the normal workflow; they're only a
fallback if Live Server isn't running and the user can't start it.

### `node --test` — the headless suites (`test/`)

`js/core/` is testable in Node, with no install step and no network:

```
npm test            # node --test "test/**/*.test.mjs"
node --test "test/formEngine.test.mjs"      # one file
node --test --test-name-pattern "round-trip" "test/**/*.test.mjs"
```

There is still **no runtime dependency and no build step** — `package.json` exists only so
Node treats `.js` as ESM and `npm test` has somewhere to live; `dependencies` and
`devDependencies` are both empty and must stay that way.

`test/helpers/xmlDom.mjs` is a hand-rolled XML DOM (DOMParser / XMLSerializer /
`document.implementation`) covering exactly what `flattener.js`, `parser.js`, `xmlReader.js` and
`xmlWriter.js` call — same reasoning as `packager.js`'s hand-rolled ZIP writer. It prefers
`linkedom` if that is ever installed, and `test/xmlDom.test.mjs` self-tests it against the
browser behaviors core code depends on. **An unsupported CSS selector throws** rather than
returning null, so add support there rather than working around it in the module under test.

What is covered: flattener, parser, xmlReader/xmlWriter (including the full fixture round-trip),
facets (pattern→maxLength derivation, the native input constraints `controlFactory` applies),
formEngine, coloringService, undoService, searchService, testDataFiller, exportProfile, instanceIdentity, packager (ZIP bytes
parsed back out of the central directory), autosaveStore, plus `test/moduleGraph.test.mjs` — a
static check that every import resolves, every named import exists, `js/core/` imports no
`js/ui/`, and `index.html` still declares every container the UI builds into. That last one is
the closest thing this repo has to a compiler.

`test/coloringService.test.mjs` is where the activation-context rules live now (parity 1.1–1.3,
done): it covers the colors *and* the error list, since both come out of one `analyzeForm` call.
The two `KNOWN-WRONG` characterization tests that used to pin the pre-Phase-1 behavior did their
job and were replaced by assertions of the new rules — don't reintroduce them.

`js/ui/` is not covered here (it touches the DOM at module scope); the browser harnesses below
remain the ground truth for rendering, and the live render stage genuinely earns its keep.

### Browser harnesses (`dev/*.html`)

Self-contained check harnesses, one per implementation phase:

| Harness | Covers |
|---|---|
| `dev/phase1-check.html` | flattener, parser, packet analyzer |
| `dev/phase2-check.html` | FormEngine, xmlWriter/xmlReader round-trip |
| `dev/phase3-check.html` | form rendering, repeating sections, radio groups |
| `dev/phase4-check.html` | coloringService + undoService |
| `dev/phase5-check.html` – `dev/phase8-check.html` | validation, search, test-data fill, theming, debug panel, packaging |
| `dev/phase9-check.html` | unmodeled-XSD-construct audit (see *Document hierarchy* below) |

Each prints `PASS`/`FAIL` rows plus a summary count at the top, logs every failure to the
devtools console, and several render into a live visible DOM stage below the results for visual
sanity-checking.

Practical notes for an agent:

- **You cannot read a harness's results yourself** unless you drive a browser. Changing logic
  covered only by a harness means asking the user to open it and report the summary line, or
  saying which harness to check — don't claim a change is verified when nothing ran it. For
  `js/core/` changes, run `npm test` first: it covers the same ground headlessly and you can
  read the result.
- **No way to run one harness assertion in isolation.** To narrow down, comment out `check()`
  calls in the harness's inline `<script type="module">` block, or add a temporary `check()`
  next to the area under test. (`node --test --test-name-pattern` does this properly for the
  headless suites.)
- Harnesses and `node --test` suites alike import and drive the **real** modules through the
  same entry points `app.js` uses — never reimplement logic in a test. When you change
  behavior, update every covering suite/harness in the same commit.
- There is no harness for `js/ui/app.js`'s own orchestration (schema load, form switch, save).
  Those paths are only exercised by using `index.html` against `sample-schemas/`.

## Document hierarchy — read this before trusting any other doc

1. **`web-implementation-spec.md`** (~1,930 lines) is the **source of truth** for algorithms and
   behavior. It overrides `WALKTHROUGH.md`, this file, the reference implementation's behavior,
   and your own judgment about what "correct" means — unless the user says otherwise.
   - Caveat: the spec's inline JS code blocks have historically contained bugs the real code
     deliberately fixes. Where a module departs from the spec's literal code, there is a comment
     explaining why — read the comment before "fixing" it back. (§9 and §16 were rewritten in
     Phase 1 of `dev/IMPLEMENTATION_ORDER.md` and now match the code, including the two
     long-standing bugs in §16's `validateField` block — the missing `break`s and the
     optional-only empty short-circuit.)
2. **`IMPLEMENTATION_PLAN.md`** is the working document: ordered phases, each scoped to a small
   set of spec `§` sections, with acceptance criteria. The intended workflow is to open *only*
   the `§` sections a phase lists rather than re-reading the whole spec.
3. **`sample-schemas/WALKTHROUGH.md`** traces every XSD construct in the fixture set through
   parse → SchemaElement → render → FormEngine paths → XML output. It doubles as the
   traceability matrix the phase acceptance criteria reference.
4. **`dev/PARITY_GAP_ANALYSIS.md`** — every known behavioral divergence from the reference WPF
   app, tiered by cost, with a suggested sequencing. **Check this before investigating a
   suspected bug in coloring, validation, packaging, or search** — it is probably already
   documented there with the behavior it should have instead.
5. **`dev/IMPROVEMENT_BACKLOG.md`** — work that goes *beyond* the original: limitations the WPF
   app has that shouldn't be inherited, plus web-platform capabilities it couldn't have. Scoped
   for after replication, with two exceptions called out there as worth doing regardless
   (autosave/crash recovery and an error boundary — both are data-loss protection). Several
   entries are cheapest to do *during* specific parity work rather than after; check it before
   starting a Tier 1 item.
6. **`dev/PHASE9_DRYRUN_FINDINGS.md`** — per-construct evidence for XSD features the parser
   doesn't model (`xs:union`, substitution groups, wildcards, `xs:redefine`, …). **Its summary
   table is stale**: findings #0 and #11 have since been fixed.
7. **`dev/IMPLEMENTATION_ORDER.md`** — the merged execution order across `PARITY_GAP_ANALYSIS.md`
   and `IMPROVEMENT_BACKLOG.md`'s own (separate) sequencing sections. Check this before picking
   what to work on next; it groups items that touch the same code into one pass instead of two.

## Reference implementation

`C:\Users\PC\Documents\GitHub\Generalized_XML_Editor` is the WPF app this project replicates
(~29,700 LOC C#). Its `.kiro/steering/project-context.md` is a complete, maintained feature
inventory — folders, data pipeline, 48 numbered invariants, undo action table, schema diff
architecture. **Read that file rather than grepping C# source** when answering "what does the
original do here?".

Nothing in this repo references the older project, so the link isn't discoverable from the code.

**Replicate behavior, not implementation — and only generic behavior.** Two limits on the
original's authority:

- It is the authority on *what* the tool does for anything **schema-shape-driven**: form
  generation, completeness coloring, validation semantics, undo, search, round-trip XML. It has
  no authority over *how* this codebase achieves that — don't mirror its class structure,
  naming or layering.
- It is **not** an authority on its own domain conventions (see *What this is*). A hardcoded
  element name, a fixed date range, a specific archive layout, a `documentId` attribute standing
  in for instance identity — those answered one department's requirements. Replicate the
  capability as configuration; don't bake in the answer.

Use what the web does well:

| WPF mechanism | Web equivalent to reach for |
|---|---|
| Per-control `ApplyRuleLimits()` methods | native `maxlength` / `min` / `max` / `step` / `pattern` attributes |
| `DynamicResource` brushes, `ThemeApplicator` | CSS custom properties on `:root` (already how `theme.js` works) |
| `Adorner`, `Behavior`, attached properties | CSS pseudo-elements, `dataset`, event delegation |
| `TreeView` / `TreeViewItem` + tag objects | nested `<ul>` or `<details>`, driven off `manifest.sections` |
| DTO classes and enums | plain objects, string literals |
| DI container with 25 registrations | module imports; `appState` passed explicitly |
| `Dispatcher.BeginInvoke(ContextIdle)` | `requestAnimationFrame` / microtask |
| `Task.Run` for slow sync work | `await`-yield before the work so the overlay paints (see `withBusyOverlay`) |
| ClosedXML, JSZip-style vendored libs | a maintained browser library, or nothing — check the zero-dependency rule first |

A C# file cited in a plan or issue is a *specification of behavior*. Judge a change by whether a
user could tell the two apps apart, not by how closely the code resembles the original.

## Architecture

### Core/UI split

`js/core/` is pure logic with **zero DOM dependencies**; `js/ui/` owns the DOM. This mirrors the
WPF app's Core/UI project boundary and is the one structural rule to not break. (`DOMParser`,
`XMLSerializer`, and `CompressionStream` count as bytes-and-strings APIs, not DOM — `core/`
modules use them freely.)

### The pipeline

```
folder of .xsd
  → flattener.js      resolve xs:include/xs:import into one flat XSD DOM; BOM scan/strip;
                      capture targetNamespace
  → parser.js         flat DOM → SchemaElement tree (TypeLookupTable, kind assignment,
                      synthetic nodes) + PacketManifest (analyzePacket)
  → formRenderer.js   SchemaElement tree → DOM
  → formEngine.js     central state: per-instance FormState, registered controls
  → xmlWriter.js      FormState map → XML string
```

`js/ui/app.js` is the only orchestrator — it holds `appState` and owns `loadSchema`,
`switchToForm`, `addFormInstance`, `removeFormInstance`, `loadXmlText`, `saveXml`,
`restoreFromSnapshot`. Every other `ui/` module is wired from its `init()` and receives the
pieces it needs. There is no framework
and no reactive layer; `FormEngine` extends `EventTarget` and fires `controlValueChanged` /
`dirtyChanged`.

### The five-way parallel structure (the main maintenance hazard)

The schema tree's structural shapes — transparent wrappers, repeating content containers,
choice-only containers, radio groups — are dispatched on **independently** in five modules:

`parser.js` · `formRenderer.js` · `xmlWriter.js` · `xmlReader.js` · `coloringService.js`

A change to how one shape is recognized or walked must be mirrored in all five, or data silently
disappears in one direction only (the classic symptom: a field renders and colors fine but never
reaches the XML, or loads from XML into a path nothing is registered at). The shared predicates
`isTransparent`, `isAttribute`, `isLeaf`, `isRepeatingContentContainer`, and
`isChoiceOnlyContainer` all live in `js/core/parser.js` and are imported by the rest — add new
shape tests there, not locally.

It was six until Phase 1 merged the coloring and completeness-error walks (backlog A.2):
`coloringService.analyzeForm` now returns `{colors, errors}` from one traversal, and
`ui/validation.js` dispatches on nothing — it iterates instance keys, stamps form identity on
each error, and renders the panel. The facet switch is single-sourced the same way (backlog
A.3): `coloringService.validateFieldValue` is the one implementation, re-exported by
`validation.js` as `validateField` and wrapped verdict-only as `isFieldValid`. Phase 7's
`walkSchema` refactor starts from these five.

### Path conventions (`§8`)

Dot-separated, with `[i]` for repeat indices:
`PacketRoot.MainForm.MainFormChoice.SomeAmount`, `PriorNameList.PriorNameListEntry[0].FormerName`.

- Synthetic segments (`…Choice`, `…Entry`, `…OptionN`) **are** part of path keys even though
  those nodes emit no XML tag.
- Always extend paths with `joinPath(prefix, name)`. A bare `path + '.' + name` produces a
  leading-dot key at a form root (where `path` is `''`) that matches nothing.
- `FormEngine` lowercases every key; use `keyOf(instanceKey)` for state-map lookups.
- Only *inner* repeating sections index with `[i]`. Multiple instances of a repeatable **form**
  live in separate `FormState` entries keyed by distinct `FormInstanceKey` — there is no
  top-level `[0]`.

### Form identity: `FormInstanceKey`

`{formName, instanceId}`, equality case-insensitive on both. `instanceId === formName` for
non-repeatable forms; the identity attribute's value or a generated id (`FormName-n`)
for repeatable instances. It is the universal identity across `FormEngine` state routing, every undo action,
the nav tree, and `buildPacketXml`'s ordered key list. Never key form state by bare form name.

### Radio selections store *static* paths

`formState.radioSelections[choicePath]` holds the selected option's **`elementPath` as parsed**
— not an index-bearing runtime path — even when `choicePath` itself carries an `[i]`.
`formRenderer`'s `showBranch`/`selectRadioGroupBranches`, `coloringService`'s `colorOfRadioGroup`,
`validation`'s `validateRadioGroup`, and `xmlWriter`'s `buildChoiceNodes` all compare against
`option.elementPath` directly. Reconstructing a candidate with
`joinPath(choicePath, option.elementName)` looks right and silently never matches inside a
repeating section.

### Form switch ordering (`app.js switchToForm`)

The sequence is load-bearing and non-obvious:

```
setActiveForm (persists prior values, then clears registration)
  → mutateState hook          ← undo/redo's ONLY entry point into the pipeline
  → parseGlobalElement → renderForm
  → inflateRepeatingSections  (rewrites paths with [i])
  → registerControlsUnder     (must be after inflation, before restore)
  → restoreActiveForm         (pushes values onto controls)
  → selectRadioGroupBranches  (fixed-point loop, nested branches)
  → coloring: setActiveContext → rebuildColorableIndex → applyAllColors
```

### Undo/redo

Command pattern, ten action classes in `js/core/undoService.js`, two bounded 50-entry stacks.
Actions store **paths, values, keys and flags only** — never live DOM or control references.
They mutate state through `switchToForm`'s `mutateState` callback and let the DOM rebuild from
scratch, which is what makes cross-form undo work without patching live DOM. Every recording
site must check `undoService.isReplaying` and skip.

### Data-loss protection (`errorBoundary.js`, `autosave.js` / `autosaveStore.js`)

Both exist because FormEngine state lives only in memory and the browser can take the tab away
(`dev/IMPROVEMENT_BACKLOG.md` B.3 and C.1). Neither is in `web-implementation-spec.md`.

- `installErrorBoundary()` is the **first** statement in `init()`, so a throw in a later init
  step still surfaces. Its panel's real job is the two download buttons; each is independently
  try/caught because `buildPacketXml` is itself a plausible source of the crash being reported,
  and the raw-state JSON dump is the last-resort path with no schema dependency at all. The
  session's crash log is also reachable from the debug panel's **Errors** tab, since the panel
  itself is dismissable.
- `autosave.js` writes a debounced snapshot keyed by schema identity, and **`offerRecovery()` is
  called after `withBusyOverlay` returns**, never inside it — a modal shown under the loading
  overlay swallows its own clicks (see the comment on `#choose-root-dialog-overlay` in
  `css/main.css`). `setSchemaIdentity` is called after `undoService.clearHistory()` for the
  opposite reason: `clearHistory` fires `changed`, which autosave listens to, and a blank-state
  write must not land before the stored snapshot has been read.
- A successful Save XML calls `clearSnapshot()`. Every store function resolves rather than
  rejects on a storage failure; the one quiet notice goes to `#autosave-status`.

### Configuration, not literals (`exportProfile.js`, `instanceIdentity.js`, `settingsStore.js`)

- Packaging rules live in `export-profiles/*.profile.json`, interpreted by
  `js/core/exportProfile.js`; `packager.js` only writes ZIPs. The packaging dialog is generated
  from the profile. Don't add a program-specific field, path or regex to JS. Profiles can be
  user files, so anything new in the format needs a check in `validateProfile`.
- Which attribute identifies a repeatable form's instance is `parser.js`'s
  `selectInstanceIdSource` (heuristic, or the per-schema override in File → Schema Settings).
  Generated ids must be legal for that attribute, because the writer backfills them.
- `settingsStore.js` is the only module in `core/` allowed to use `localStorage`
  (`moduleGraph.test.mjs` enforces it). Per-schema settings are keyed more loosely than autosave
  snapshots, so they survive a schema revision.

### Fixtures

- `sample-schemas/SamplePacket.xsd` + `SampleCommonTypes.xsd` + `SampleGroups.xsd` +
  `SamplePacket.xml` — the synthetic set every phase and harness is written against. Exercises
  one of each construct; documented construct-by-construct in `WALKTHROUGH.md`.
- `sample-schemas/SampleSchema/` — a **real production schema set**: 42 `.xsd` across a nested
  multi-folder tree. Its value is its shape and scale, not its subject matter: production schema
  sets are routinely nested this way, so any folder-scanning code must recurse rather than
  listing only the chosen directory. Use it to check that something works at realistic size.

## Invariants

`web-implementation-spec.md` §22 lists 30 numbered behavioral invariants; the WPF app's
`project-context.md` §13 lists 48. Read §22 before changing anything in the write/read/coloring
path. The ones most often broken in practice:

- Transparent nodes (`isGeneratedWrapper`, `RadioGroup`, `SequenceContainer`) never emit an XML
  tag — but their names still contribute path segments.
- A repeating content container's **own** name is the tag that repeats; its synthetic `…Entry`
  wrapper never appears in XML at all.
- Purge state (`purgeValuesUnderPathPrefix`) *before* removing a repeating instance's DOM, and
  snapshot for undo *before* purging.
- `isValid` ≠ completeness. Emptiness is a completeness concern; format rules are a validity
  concern. Both are collected by Validate.
- Coloring and validation are **activation-gated** (§22 invariant 30) and share one walk. A
  required-but-empty field only paints Red and reports an error where its subtree is active; a
  container-shaped node is never Green on emptiness alone; an explicit radio selection and an
  existing repeating row each count as activation.
- Rebuild the colorable index on structural change only, never on every value change (coloring
  recompute is 50 ms debounced).
- The undo stack is cleared on schema load, root switch and XML load. Form add/remove are
  undoable and must *not* clear it.

## Known-wrong areas

Do not treat current behavior as correct in these places — see `dev/PARITY_GAP_ANALYSIS.md`
Tier 1 for the behavior each one should have instead:

- **The bundled export profile is unverified.** `export-profiles/mef-state.profile.json` carries
  over the original app's rules; nobody has checked it against the published manifest schema.
- `dev/phase6-check.html` and `dev/phase9-check.html` throw partway, and one `phase7-check.html`
  row fails ("all 4 tab buttons"). All three predate Phase 3 of `dev/IMPLEMENTATION_ORDER.md`.
- `#switch-root-btn` in `index.html` is wired to nothing.
