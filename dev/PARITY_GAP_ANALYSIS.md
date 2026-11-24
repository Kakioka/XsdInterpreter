# Parity gap analysis — XsdInterpreter (web) vs. Generalized_XML_Editor (WPF)

**Reference implementation:** `C:\Users\PC\Documents\GitHub\Generalized_XML_Editor`
(.NET 9 / WPF, ~29,700 LOC C# across 160 source files, plus `.kiro/steering/project-context.md`
as its own authoritative feature inventory).

**This implementation:** XsdInterpreter (vanilla ES modules, ~7,000 LOC JS + 1,138 LOC CSS
across 24 modules), built against `web-implementation-spec.md`.

**Method:** every subsystem named in the WPF app's `project-context.md` (§2 folders, §16
"Working End-to-End", §18 undo actions, §19 schema diff) was located in the web codebase and
compared behavior-for-behavior against the C# source. Findings below are grouped by what the
fix actually costs, not by subsystem.

**Caveat on authority:** `web-implementation-spec.md` is the authoritative document for this
rewrite. Several gaps below are features the WPF app has that **the spec does not describe at
all** (field sizing, schema diff, pattern describer, date shorthand, theme background images,
`elementStyles`). Those are collected in Tier 4 — for each, the spec needs amending *before*
implementation, since building them now means writing behavior the spec doesn't sanction.

**Scope of parity — behavior only.** Only the WPF app's *observable behavior and
functionality* need replicating. Its implementation does not. Every C# file, class name, and
method named below is cited as a **specification of what the feature does** — the authoritative
answer to "what should happen here?" — never as a structure to mirror. Execution should be
whatever is idiomatic for the web: native HTML input attributes and constraint validation
instead of per-control `ApplyRuleLimits` methods, CSS classes and custom properties instead of
`DynamicResource` brushes and `Adorner`s, nested lists or `<details>` instead of a `TreeView`,
plain objects instead of DTO classes, and a well-maintained browser library (or a small
purpose-built module) instead of a line-by-line translation of a C# helper. Judge a fix by
whether a user could tell the two apps apart, not by how closely the code resembles the
original.

**Scope of parity — generic behavior only.** The web tool aims to be **as domain-agnostic as
possible**: any XSD in, a usable form, valid XML out. The WPF app did not have that freedom —
it had to satisfy one department's filing standards and was deliberately tuned for that
department's day-to-day convenience. So its feature set splits in two, and only the first half
is a parity target:

- **Generic capability** — flattening, parsing, form generation, completeness coloring,
  validation, undo, search, test-data fill, theming, round-trip XML. All of this is schema-shape
  logic with no domain knowledge in it. **Replicate fully.**
- **Domain-specific behavior** — a particular submission-package layout, a particular manifest
  document, hardcoded field names that always get filled, date ranges pinned to specific years,
  a specific attribute name carrying instance identity. **Do not hardcode.** Where the
  capability is worth having, it belongs behind configuration or a pluggable profile so that
  *any* organization's conventions can be expressed, not just the original department's.

Entries below marked **[domain-specific]** are in that second category: the gap is real, but
closing it by copying the original's hardcoded answer would make the web tool less general than
it is trying to be. Each one names the generic mechanism to build instead.

Note that this creates a tension with the authoritative spec, which is not domain-neutral:
§19 specifies a submission-packaging workflow and manifest shape for one filing program, §25 is
a readiness checklist for it, and §4 hardcodes a `documentId` attribute name as the
instance-identity convention. **Resolving that is the spec owner's call, not an implementation
decision** — flagged at the end of this document under *Open question for the spec*.

---

## Tier 1 — Behavioral divergences (the web app is already wrong, not just incomplete)

These are the highest-value fixes: the feature exists on both sides but produces different
answers. Each is a user-visible difference on the *existing* sample schema set.

### 1.1 Coloring has no activation context (`parentIsActiveOrRequired`) — **DONE**

**The single largest semantic divergence in the codebase.**

> **Resolved** in Phase 1 of `dev/IMPLEMENTATION_ORDER.md`. `js/core/coloringService.js` threads
> `parentIsActiveOrRequired` from the form root down and implements the decision ladder below;
> `web-implementation-spec.md` §9 was rewritten to specify it (it previously described the pure
> roll-up) and §22 gained invariant 30. Two additions beyond the reference, both documented in
> the module header: container completeness requires each leaf to be present **and valid** (so
> §9's filled-but-invalid-is-Red rule survives the roll-up), and an unchecked checkbox counts as
> *answered* but not as *engagement* (the reference treats boolean `false` as no value at all and
> then needs per-call-site checkbox exceptions). Covered by `test/coloringService.test.mjs`.

WPF `Core/Coloring/ColoringService.cs` threads a boolean `parentIsActiveOrRequired` down the
whole walk (`ComputeRecursive` → `RecurseChild`), recomputed at each container as:

```csharp
bool thisIsActiveOrRequired = element.IsRequired
    ? parentIsActiveOrRequired
    : IsActivated(element, effectivePath, ctx);
```

Web `js/core/coloringService.js` has no such concept. `computeContainerColor(isRequired, childColors)`
is a pure bottom-up roll-up of child colors. Concrete consequences:

| Scenario | WPF | Web today |
|---|---|---|
| Required leaf inside an **untouched optional** container | Yellow (`ComputeLeafColor`: required + `!parentIsActiveOrRequired` → Yellow) | **Red** |
| That optional container itself, untouched | Yellow (`!hasAnyDescendantValue` → Yellow) | **Red** (inherits the Red leaf) |
| **Required** container, all required children filled, optional children empty | **Green** (`allRequiredChildrenComplete ? Green : Red`) | **Yellow** (needs *every* child Green) |
| Optional container with only optional children, one filled | Yellow — `IsActivated` returns false when `!Children.Any(c => c.IsRequired)` (the "Section 20 exception") | depends on roll-up; no equivalent rule |

Net effect: a freshly loaded form in the web app paints large swaths of red that the WPF app
paints yellow, and required containers never reach green until optional fields are filled too.

**Action:** replicate the activation semantics. The shape below is one way to get there, not a
required structure — what must match is the decision table above:

- thread an "is this subtree active?" flag down the walk, seeded `true` at the form root (WPF
  invariant §13 #16: "form roots are always required-context");
- implement the activation test (including the all-optional-children exception) and a
  "has any descendant value" query;
- replace `computeContainerColor`'s roll-up with the WPF decision ladder: inactive →
  Yellow / Red / Green / Yellow by `hasAnyDescendantValue` + `allRequiredChildrenComplete` +
  strict `AreAllChildrenCompleteIndexed`; active+required → `allRequiredChildrenComplete ? Green : Red`;
  active+optional → the same ladder as inactive;
- give `computeColor` the activation flag for leaves (WPF `ComputeLeafColor`).

### 1.2 Validation reports required-field errors the WPF app suppresses — **DONE**

> **Resolved** in the same pass, and more directly than this entry proposed: the two walks were
> merged (backlog A.2), so the gating is not threaded through a second function at all —
> `analyzeForm` emits the color map and the error list together. `js/ui/validation.js` keeps only
> the packet-level work. One deliberate divergence, decided with the user: an explicitly selected
> radio branch counts as activation for **errors as well as colors**. The reference's completeness
> walk skips radio groups under inactive containers while its coloring walk treats the selection
> as activation, so it paints a selected branch's required fields Red while Validate stays silent
> and Save XML emits the incomplete branch without warning.

Same root cause, second walk. WPF invariant §13 #47 states *both* walks are activation-gated;
`CollectCompletenessRecursive` skips a required leaf when `!parentIsActiveOrRequired`, and
recurses into non-leaf children only so deeper *self-activated* optional containers are still
found.

`js/ui/validation.js`'s `validateNode` has no gating — it reports "Required field is empty"
for every required leaf anywhere in the tree, including inside optional containers the user
never touched. On any large real-world form that is hundreds of false positives, and it fires in three
places that share the function: Validate, Save XML's pre-save warning, and packaging's
validation gate.

**Action:** thread the same activation flag through `validateNode` / `validateRadioGroup` /
`validateRepeatingEntry`. The one non-obvious rule to match from
`CollectCompletenessRecursive`: when a container is *inactive*, still recurse into its non-leaf
children (skipping leaves and radio groups), so a deeper optional container that the user *has*
filled is found and reported. Whether that is one function with a flag or two functions is an
implementation choice; which errors come out is not.

### 1.3 A required repeating section with zero instances colors **Green** — **DONE**

> **Resolved** in the same pass. Zero instances now yields Red (required *and* active) or Yellow,
> never Green, and a container-shaped node with no children is Yellow rather than Green too. The
> coloring/validation contradiction this entry describes is no longer expressible, since both
> come from one walk.

`colorOfRepeatingEntry` with `count === 0` produces `instanceColors = []`, and
`computeContainerColor(isRequired, [])` returns `isRequired ? 'Green' : 'Yellow'` — so a
required, empty repeating section reads as *complete*.

WPF has a dedicated `EmptyRepeatingColor` for exactly this case: a container is Red only when
required AND in an active context, otherwise Yellow. Never Green.

`validateRepeatingEntry` *does* catch it (`count < minOccurs` → occurrence error), so coloring
and the validation panel actively contradict each other today.

**Action:** make the zero-instance case return Red-or-Yellow (Red only when required *and*
active), never Green — and more generally make `computeContainerColor(required, [])` never
return Green for a container-shaped node.

### 1.4 Packaging is hardcoded to one organization's conventions — and hardcoded wrongly **[domain-specific]**

Under the generalized goal, the defect here is **not** "the output doesn't match the original
department's rules." It is that `js/core/packager.js` has *no configuration layer at all*: the
archive layout, the metadata field set, every field's validation regex, and the manifest
document's element names are all literals in the module. What those literals encode is a
partial, inconsistent copy of one filing program's requirements — so the current state is the
worst of both worlds. It is neither general nor correct for the one case it was written for.

Evidence that it isn't correct for that case either, from `Core/Packaging/`:

- **Archive layout.** The original builds a five-prefix tree (a `manifest/` directory, an `xml/`
  directory whose entry is named after the submission id, an always-present `attachment/`
  directory entry even when empty, and a nested pair of directories for a secondary/companion
  return and its attachments). `buildSubmissionPackage` emits a flat archive with everything at
  the root. It also drops two hard constraints the original enforces: no duplicate filenames
  within an attachment group, and no archive entry path longer than 64 characters.
- **Manifest document.** Different root element name, no namespace where the original declares
  one, several renamed elements, a category code (`BUS`) that isn't in the original's
  six-value enumeration, one optional element missing entirely, and a looser regex on an
  identifier the original constrains precisely.
- **Metadata model.** The original treats *entity category* and *identifier type* as two
  independent axes — a third identifier option exists for entities with no permanent identifier
  assigned. The web dialog collapses both into one two-value radio, so that third case cannot
  be expressed at all.

**Action — build the generic mechanism, not the specific answer.** Packaging should become an
**export profile**: a declarative description of an archive layout plus a metadata schema,
selected by the user, with the organization-specific values living in data rather than in
`packager.js`. Concretely:

1. Keep `buildZip` as-is — it is generic, correct, and already supports directory entries.
2. Give it a profile describing entry paths as templates (`xml/{submissionId}.xml`), which
   directories must exist even when empty, and the per-group constraints (max count, max entry
   path length, filename uniqueness). The two constraints above become profile *values*, not
   module constants.
3. Drive the metadata dialog from a field-definition list (name, label, required, pattern,
   max length, conditional-on-another-field) rather than hand-written markup plus a hand-written
   `validatePackagingSettings` ladder. This is the same problem the app already solves for
   schema-driven forms — the dialog should be generated the way every other form is.
4. Express the manifest as a template (or let the user supply the manifest's own XSD and reuse
   the existing form engine to fill it — the most general answer, and nearly free given what
   already exists).
5. Ship the original department's rules as **one bundled profile**, so nothing is lost and the
   existing workflow keeps working. Its specifics then live in a profile file where they can be
   audited and corrected against the real publication, rather than being mixed into app logic.

If a profile system is more than is wanted right now, the minimum viable version is: move every
literal out of `packager.js` into one exported config object. That alone makes the domain
assumptions visible and swappable, and it is a prerequisite for any of the above.

### 1.5 Instance identity is tied to a hardcoded attribute name **[domain-specific]**

Spec §4 makes `documentId` — a specific attribute name from one schema family — the convention
by which a repeatable form's instance identity is read on load (`isInstanceIdSource`), and
`xmlWriter.syncInstanceIdAttribute` writes it back. The spec acknowledges the limit in passing:
"Schemas that use a different attribute name for this purpose need to adjust this convention
accordingly" — i.e. edit the code.

For a tool meant to accept arbitrary schemas, that is a hard stop: load any schema whose
repeatable elements identify instances by a differently-named attribute (`id`, `recordId`,
`lineNum`, or nothing at all) and instance identity silently falls back to generated UUIDs,
which then don't round-trip through the XML.

**Action:** make the instance-id source a per-schema setting rather than a constant — a
heuristic (first attribute of type `ID`, or the first required attribute whose name ends in
`Id`) plus an explicit override the user can set once per schema, persisted alongside the other
per-schema settings. Also handle "no identity attribute exists" as a first-class case rather
than an accident: generated ids are fine, they just need to be stored outside the XML so a
round-trip is stable.

### 1.6 `#switch-root-btn` is dead markup

`index.html` ships a "Switch Root" File-menu item. No module references `switch-root` anywhere
in `js/` — the button is enabled by `setSchemaDependentButtonsEnabled` and then does nothing.
The WPF counterpart (`MainWindow.SchemaLoading.cs` SwitchRoot) re-runs root selection against
the already-loaded flat document and clears undo history.

**Action:** wire it — re-run `findRootElementCandidates` + `chooseOne` against the cached
`appState.flatDoc`, then redo the `SchemaParser` / `analyzePacket` / `formEngine.reset()` /
`undoService.clearHistory()` sequence from `loadSchema`. (Or remove the button —
clickable-but-inert is the worst of the three options.)

### 1.7 Search silently fails on anything not currently rendered

`highlightPath` resolves `[data-path]`, adds `search-highlight`, and calls `scrollIntoView`.
Unselected radio branches are `display: none` (still in the DOM), and repeating instances with
count 0 aren't in the DOM at all — so clicking those results produces *no* visible feedback.

The WPF app addressed this explicitly (commit `4b6cc13`, "Improved search highlighting to
highlight parent if searched child isnt currently rendered").

**Action:** when the resolved target has no layout box (`offsetParent === null`) or resolves to
nothing, walk up the schema ancestry and highlight the nearest rendered ancestor container
instead; show a status line when even that fails.

### 1.8 Input controls don't apply schema constraints as hard limits — **DONE**

> **Done** in Phase 2 of `dev/IMPLEMENTATION_ORDER.md`: `js/core/facets.js`'s `inputConstraints`
> computes the native attributes, `controlFactory.js` sets them, and a digit-counting `input`
> guard enforces `totalDigits` on number inputs (where `maxlength` is ignored).

WPF leaf controls each run `ApplyRuleLimits()` / `ApplyHardLimits()` at bind time:

- `TextInputControl` — `maxLength`, **`length`** (sets both max and min), `minLength`, `pattern`
- `NumericInputControl` — `minInclusive`, `maxInclusive`, **`minExclusive`**, **`maxExclusive`**,
  `totalDigits` → `MaxLength = totalDigits + 1`
- `DecimalInputControl` — the same, plus `fractionDigits`

`js/ui/controlFactory.js` applies only `maxLength`, and only to text inputs. Numeric/decimal
inputs get no `min`/`max`/`maxlength` at all, so out-of-range values are typeable and are only
caught on blur.

**Action:** the web gets this nearly free — set the native `maxlength`, `min`, `max`, `step`,
and `pattern` attributes in `controlFactory.create*` from the rule set, rather than reproducing
WPF's per-control `ApplyRuleLimits` plumbing. Note `minExclusive`/`maxExclusive` have no native
equivalent and need a nudge (`min = value + smallest step`) or a blur check. Depends on 1.9.

### 1.9 Four XSD facets are never extracted — **DONE**

> **Done** in the same pass: the three facets are extracted and validated, and the
> pattern→`maxLength` derivation is a `{derived: true}` rule appended by `parser.js`.

`js/core/parser.js`'s `VALIDATION_RULE_TAGS` covers `minLength`, `maxLength`, `pattern`,
`minInclusive`, `maxInclusive`, `totalDigits`, `fractionDigits`.
`Core/Parsing/ValidationRuleExtractor.cs` also extracts **`minExclusive`**, **`maxExclusive`**,
and **`length`** — and derives a synthetic `maxLength` from a `pattern` when neither
`maxLength` nor `length` is present (used by both validation *and* field sizing).

`validateField` likewise has no `minExclusive` / `maxExclusive` / `length` cases.

**Action:** add the three facets to `VALIDATION_RULE_TAGS`, `validateField`, and `isFieldValid`
(`coloringService.js` keeps its own copy of the switch — keep both in sync); add the same
pattern→maxLength derivation, since field sizing (2.1) depends on it too.

### 1.10 `ValidationRule.userFriendlyMessage` has no web equivalent

WPF `ValidationRule` carries an optional `UserFriendlyMessage` that controls prefer over the
generic fallback. The web `validationRules` objects are `{kind, value}` only, so every message
is machine-generated ("Min length: 6"). Related to Tier 4's pattern describer.

### 1.11 BOM scan misses an interior ZWNBSP when a leading BOM is also present

`scanForBom` uses `text.indexOf('\uFEFF') >= (hasLeadingBom ? 1 : 0)`. With a leading BOM,
`indexOf` returns 0 and `0 >= 1` is false — so `hasInterior` reports false even when interior
marks exist. Cosmetic only (`stripBom` removes all of them regardless), but the reported
diagnosis is wrong.

**Action:** `text.indexOf('\uFEFF', hasLeadingBom ? 1 : 0) !== -1`.

---

## Tier 2 — Whole subsystems present in WPF, absent in web

### 2.1 Field sizing (`Core/UIGeneration/FieldSizeResolver.cs`, 344 LOC) — *spec gap, see Tier 4*

Five categories (Tiny / Small / Medium / Large / Full) resolved per leaf from schema
constraints, with a JSON override file. The heuristic, verbatim from the C#:

- `Checkbox` → by `ResolvedLabel.Length`: ≤10 Tiny, ≤20 Small, ≤35 Medium, else Large
- `DatePicker` → always Medium
- `Dropdown` → by longest enum value length: ≤5 Tiny, ≤25 Medium, ≤45 Large, else Full
- `TextInput` → by `maxLength`: ≤2 Tiny, ≤20 Medium, ≤50 Large, else Full
- `NumericInput` / `DecimalInput` → by `totalDigits`: ≤10 Medium, else Large
- fallback: Full

Without this, the web app's "Layout: Wrap" mode flows uniformly-sized fields — the WPF app's
segmented WrapPanel is what makes wrap mode readable. `css/main.css` has no `.size-*` classes.

The spec *references* `xmlEditor.fieldSizeOverrides` in §12 Settings Persistence but never
defines sizing. **The spec must define the categories and their CSS widths first.**

### 2.2 Schema diff / "Compare Schema Packages" (~2,100 LOC C# + 2 dialogs) — *spec gap*

A complete 9-phase pipeline, documented in `project-context.md` §19, absent from both the web
app and the spec:

| C# file | Role |
|---|---|
| `XsdFlattener.FlattenAllAsync` | root-agnostic flatten of *all* `.xsd`, dedup, `_sourceFile` annotation, subdirectory-prefix entry-point filter |
| `XsdCatalogBuilder` (551) | flat doc → `XsdCatalog` (global elements, complex/simple types, groups, attribute groups); second-tier `_sourceFile` prefix filter |
| `CatalogComparer` (695) | deep recursive compare; children matched **by name** (so a rename shows as remove+add); reorder detection via `PositionIndex`; facet and enumeration set diffs |
| `SchemaDiffFormatter` (303) | grouped ADDITIONS / REMOVALS / MODIFICATIONS text report |
| `SchemaDiffExporter` (328) + `SimpleWorkbook` (313) | XLSX export, append-to-existing or new; headers `Change Number \| Version Number \| Date \| Schema \| Line No \| Action \| Comments`; change-number format `{year}.0.{n}` |
| `SchemaDiffService` | orchestrator |
| `DiffConfirmationDialogue` (121) | old dir / new dir / optional subdirectory prefix, with validation |
| `DiffPreviewWindow` (235) | monospaced read-only report + two export buttons |

Web approach: ClosedXML has no browser equivalent, and the C# `SimpleWorkbook` exists only
because ClosedXML was too heavy — on the web, reach for SheetJS (or ship CSV, if the consumer
of these reports tolerates it) rather than hand-rolling an XLSX writer a second time. The
comparison itself is pure logic and belongs in `js/core/`; the report view is a plain `<pre>`.
The **two-tier prefix filter** is the one piece worth matching rule-for-rule — it's subtle, and
§19 of `project-context.md` explains why each tier exists.

Also missing from the web flattener: the `_sourceFile` relative-path annotation the whole
pipeline (and `PacketSection.SourceSchemaFile`) depends on.

### 2.3 Pattern describer (`Core/Parsing/PatternDescriber.cs`, 725 LOC) — *spec gap*

Converts XSD regexes into human-readable text via a 7-stage resolution order: known-pattern
JSON table (embedded + external override at `{ExeDir}/Parsing/known-patterns.json`) → literal
alternation → fixed template → char class + quantifier → dot quantifier → atom walker →
`"Format: {pattern}"` fallback.

`js/ui/validation.js` has an explicit placeholder acknowledging this:

```js
const patternDescriber = { describe: (p) => `Must match the required format (pattern: ${p})` };
```

The spec names `patternDescriber.describe(rule.value)` in §16's code block but never defines it.

**Action (after spec amendment):** copy the known-pattern JSON table first — it is pure data,
genuinely reusable as-is, and carries most of the value. The later stages are regex-analysis
heuristics worth rebuilding in whatever form reads cleanly in JS; the C# staging order is a
useful guide to *which* patterns matter, not a structure to reproduce.

### 2.4 Date shorthand (`Core/Parsing/DateShorthandParser.cs`, 105 LOC) — *spec gap*

Character-scanner (no regex) for compound relative-date expressions such as `+1y-3m+5d`: units
`d`/`m`/`y`, optional per-segment sign, base date defaulting to today, overflow-guarded at
6-digit amounts. Wired into `DatePickerControl.OnDatePickerPreviewKeyDown`. Zero occurrences of
"shorthand" in the web codebase or the spec.

### 2.5 Label resolution chain (`Core/LabelResolution/`, 3 classes)

`ChainedLabelResolver` → `XsdDocumentationLabelResolver` → `FallbackLabelResolver` (90 LOC).
The web app has a single `humanizeLabel(name)` in `parser.js` with no documentation-first
strategy and no pluggable chain.

**Action:** verify which resolver actually wins on the large fixture set in
`sample-schemas/SampleSchema/`. If documentation is
preferred there and the web app is splitting CamelCase instead, every label on every form is
wrong. Cheap to check, potentially high-impact.

### 2.6 `xs:redefine`, `xs:union`/`xs:list`, identity constraints, substitution groups, wildcards, mixed content, `xsi:nil`

Already inventoried with per-construct evidence in `dev/PHASE9_DRYRUN_FINDINGS.md`. Two of its
twelve findings — #0 (directly-repeating elements) and #11 (`complexContent`/`extension`) —
have since been **fixed**: `_finishComplexType` now sets `isRepeating` from the referencing
particle's `maxOccurs`, and `_resolveEffectiveParticles`/`_resolveEffectiveAttributeEls` follow
the base chain. **That document's summary table is stale and should be updated.** The remaining
ten findings stand.

These matter *more* for a domain-agnostic tool, not less: a tool that accepts arbitrary schemas
cannot assume its input avoids the constructs it doesn't model. The spec's §25 now cites a real
production schema set, so Phase 9's "gated on obtaining a real schema" precondition is at least
partly satisfied — these can be scheduled. See also C.2 in `dev/IMPROVEMENT_BACKLOG.md`: a real
validator removes most of this list at once, which is the more general fix than hand-modelling
each construct.

---

## Tier 3 — Feature-level gaps within subsystems that do exist

### 3.1 Theming: 17 of 35 color tokens

`themes/default.theme.json` defines 17 colors. `Docs/theme-template.theme.json` defines 35
(11 required + 24 optional). The 18 missing:

`addButtonBorder`, `addButtonForeground`, `addButtonHover`, `removeButtonBorder`,
`removeButtonForeground`, `disabledBackground`, `disabledBorder`, `disabledText`,
`navRequiredText`, `navOptionalText`, `overlayBackground`, `searchHighlightBackground`,
`searchHighlightBorder`, `validationErrorText`, `validationHighlightBackground`,
`validationHighlightBorder`, `validationPanelBackground`, `validationPanelBorder`.

Also absent: `elementStyles` (inert in WPF too — safe to skip); the three **background image**
areas (`backgroundImage` / `toolbarBackgroundImage` / `sidebarBackgroundImage`, each
`{filePath, opacity}` with a `{ThemeAssetsFolder}` placeholder — *spec gap*, §12 doesn't
mention them); the bundled **Christmas** theme; the theme ⓘ info icon with custom-theme
directions; and `ThemeTokenAdorner` / `ThemeOverlayService` (the developer token-inspection
overlay — arguably belongs in the debug panel for the web port).

Depth colors (5 interpolated levels) **are** implemented correctly in `theme.js`.

### 3.2 Sidebar nav tree is flat where WPF is hierarchical

| WPF (`MainWindow.Navigation.cs`) | Web (`js/ui/sidebar.js`) |
|---|---|
| `TreeView`, grouping nodes for wrapper sections (`ReturnDataState`), `IsExpanded = true` | flat `<ul><li>` |
| Label = `PacketSection.Description`, falling back to `ElementName` | label = `key.toString()` |
| Repeatable instances labeled `Name (1)`, `Name (2)`, contiguously **renumbered** on every add/remove (`RenumberTreeItemsForFormName`) | `FormName#<uuid>` — the raw GUID is shown to the user |
| Required vs. optional color-coded (`CreateNavLabel` + `navRequiredText`/`navOptionalText`) | uniform |
| Positional insertion under the parent section (`TreeInsertPosition { ParentSection, ChildIndex }`), preserved across undo/redo | always appended; `FormAddAction.insertPosition = length - 1` |
| Right-click → Remove context menu | `×` button |
| `_programRequiredElements` override set forces certain sections to render as required | none |
| `stateSchemaVersion` appended to `CurrentRootLabel` | not extracted, not shown |

**Action:** labeling and renumbering are the user-visible half and are cheap. The hierarchy and
positional insertion touch `FormAddAction`/`FormRemoveAction` and should be done together with
3.3. Web mechanism: nested `<ul>` (or `<details>` for collapsibility) driven off
`manifest.sections`, with the required/optional distinction as a CSS class — no need for a
`TreeViewItem`-equivalent object graph or a `NavItemTag` analogue, since `instanceKeys` plus
`findSection` already carry everything the WPF tag held.

### 3.3 `PacketManifest` is missing two fields

`analyzePacket` returns `{packetName, sections, allForms}`. WPF `PacketManifest` also carries
**`SchemaVersion`** (`PacketAnalyzer.ExtractSchemaVersion` reads the `stateSchemaVersion`
attribute declaration off the packet root; displayed in the sidebar), and `PacketSection`
carries **`SourceSchemaFile`**.

`stateSchemaVersion` appears nowhere in `js/` — neither extracted nor emitted on the packet
root.

### 3.4 Test data fill: three gaps

- **Always-fill list [domain-specific]** — WPF keeps a hardcoded `AlwaysFillNames` set of two
  element names that get filled regardless of `IsRequired` or the filter predicate, because
  downstream processing rejected the packet without them. The *mechanism* is worth having (some
  schemas have fields that are technically optional but practically mandatory); the two
  literal names are not. Build it as a user-editable, per-schema list, empty by default — not a
  constant in `testDataFiller.js`.
- **Date range from facets** — `GenerateDate` reads `minInclusive`/`maxInclusive` and returns
  the **midpoint**. Fully generic and worth replicating. Its fallback range when no facets exist
  is pinned to specific past years, which is domain convenience — prefer something
  schema-independent (e.g. a window around today, or today itself).
- **Deterministic seed** — WPF uses a fixed RNG seed for reproducible fills. Worth matching if
  fills are ever compared across runs, and it makes the harnesses' expected values stable.

### 3.5 Dialogs still using `window.confirm` / `window.alert`

| WPF dialog | Web today |
|---|---|
| `BomCleanupDialogue.xaml` — lists affected files, one-click cleanup | `window.confirm` with filenames joined by newlines |
| `UnmatchedFieldsWindow.xaml` — sortable list of unmatched XML paths | `window.alert`, with an in-code `Phase 6+ TODO` |
| `DiffConfirmationDialogue` / `DiffPreviewWindow` | n/a (see 2.2) |

The web app already has a good pattern for this (`#choose-root-dialog-overlay`,
`#package-dialog-overlay` — both built dynamically into an empty div), so these are mechanical
ports. Note that unmatched fields *do* also surface in the validation panel as
`kind: 'unmatched'`, so the alert is partly redundant.

### 3.6 Settings persistence: two spec'd keys unimplemented

Spec §12 lists four `localStorage` keys. Implemented: `xmlEditor.activeTheme`,
`xmlEditor.lastPackagingSettings` — plus four unspec'd extras (`layoutMode`, `zoomLevel`,
`sidebarWidth`, `debugPanelWidth`). Missing: **`xmlEditor.lastSchema`** and
**`xmlEditor.fieldSizeOverrides`** (the latter blocked on 2.1).

WPF `AppSettings` additionally persists `RecentSchemas` (a list) and `LastUsedSchemaName`.

### 3.7 Smaller control-level behaviors

- **"Now" button** — `TextInputControl.OnNowButtonClick` stamps
  `DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")` into `xs:dateTime` text fields and clears
  the validation error. The web app renders `xs:dateTime` as `<input type="datetime-local">`
  with Z-suffix translation at the DOM boundary — a defensible divergence, but there is no
  one-click "now" and no way to type a timestamp in the exact lexical form a schema's pattern
  demands.
- **Click tooltip** — WPF `UI/Behaviors/ClickTooltip.cs` (259 LOC) is a click-to-pin tooltip.
  The web app uses a plain `.tooltip` span (hover only).
- **Crash logging** — WPF commit `7c084b4` added crash logging, wired in `App.xaml.cs`. The web
  app has no `window.onerror` / `unhandledrejection` handler.

---

## Tier 4 — Spec amendments required before implementation

Per the project's own rule that `web-implementation-spec.md` is authoritative, these cannot be
built as "parity work" until the spec describes them. Each needs a spec section written first:

| Feature | WPF source | Spec status |
|---|---|---|
| Field sizing (5 categories + override JSON) | `FieldSizeResolver.cs` | §12 names the localStorage key only; no definition |
| Schema diff pipeline | `Core/SchemaDiff/` (7 files) + 2 dialogs | not mentioned |
| Pattern describer | `PatternDescriber.cs` + `known-patterns.json` | §16 *calls* `patternDescriber.describe()` without defining it |
| Date shorthand input | `DateShorthandParser.cs` | not mentioned |
| Theme background images (3 areas) | `ThemeApplicator` + `BackgroundImageSettings` | not mentioned in §12 |
| Theme `elementStyles` | `ThemeApplicator` | not mentioned (inert in WPF — recommend *not* adding) |
| Label resolver chain | `Core/LabelResolution/` | §4 implies a single `humanizeLabel` |

---

## Suggested sequencing

`dev/IMPLEMENTATION_ORDER.md` supersedes this list — it merges it with the improvement
backlog's own ordering. Kept here for the rationale.

1. ~~**1.1 + 1.2 + 1.3 together.**~~ **Done** — they shared one root cause (no activation
   context) and touched the two walks that had to stay in lockstep (WPF invariant §13 #47), so
   they were done in one pass, which also merged those two walks into one.
2. ~~**1.9 → 1.8.**~~ **Done** — facet extraction, then native input limits.
3. **1.4 + 1.5.** The two domain-specific items. Both are really "move hardcoded assumptions
   into configuration"; doing them together keeps one notion of per-schema settings.
4. **1.6 + 1.7 + 1.11.** Small, independent, each a visible bug.
5. **3.2 + 3.3.** Nav tree labeling/renumbering plus the manifest fields it displays.
6. **3.1 + 3.5 + 3.6.** Theme tokens, the two real dialogs, the two missing settings keys.
7. **Spec amendments (Tier 4)**, then 2.1 (field sizing) and 2.3 (pattern describer) — both
   materially improve how a large, densely-constrained form reads.
8. **2.2 (schema diff)** last. It is the largest single item (~2,100 LOC equivalent) and is
   wholly independent of the form editor; it also needs the `_sourceFile` flattener annotation
   built first.
9. **2.6 / Phase 9 constructs**, scheduled against the large fixture set. Refresh
   `dev/PHASE9_DRYRUN_FINDINGS.md`'s summary table first — two of its findings are already
   fixed.

## Open question for the spec

`web-implementation-spec.md` is authoritative, and it is **not domain-neutral.** Three places
bake one organization's conventions into the specification itself:

| Spec location | What it assumes |
|---|---|
| §19 Packaging | A specific submission-package workflow, archive layout and manifest document for one filing program |
| §25 Readiness checklist | Framed entirely as "work through this before trusting output against a real schema from that program" |
| §4 (and §2, §11) | `documentId` as *the* attribute name carrying repeatable-instance identity, with a note to "adjust this convention" for other schemas |

The generalized goal and the spec disagree here, and the spec wins by default. **This is the
spec owner's decision, not an implementation one.** Three possible resolutions, in rough order
of effort:

1. **Leave the spec alone; treat §19/§25 as one bundled profile.** Cheapest. The generic
   mechanisms in 1.4/1.5 get built; the spec's specifics become that profile's data. Nothing in
   the spec becomes wrong, it just stops being the *only* answer.
2. **Amend §19 to specify the profile mechanism**, and move the current contents to an appendix
   as the reference profile. Makes the spec match the goal, and gives Tier 4's other amendments
   a precedent to follow.
3. **Split the spec** into a domain-neutral core and a separate profiles document. Most honest
   long-term, most work now, and probably premature before a second profile exists to prove the
   abstraction.

Option 1 is recommended — it unblocks all the work in 1.4/1.5 without a speculative
restructuring, and option 2 or 3 stays available once a real second profile exists.

Worth noting: §25's checklist of unmodeled constructs (`xs:union`, substitution groups,
wildcards, `xs:redefine`, mixed content, `xsi:nil`, identity constraints) is **fully generic and
becomes more important, not less**, under the domain-agnostic goal. Only its framing is
program-specific; its content is a straightforward "constructs this parser doesn't handle" list.

## Deliberate non-goals

- `elementStyles` — inert dead code in WPF by its own documentation.
- Roslyn theme scripting — deferred in WPF too (`script` / `scriptEnabled` retained for forward
  compatibility, never executed).
- WPF's own "Not Yet Implemented" list (multi-schema selection screen, multi-instance
  disambiguation in the validation panel, full file-packet-creator UI) — not parity gaps, since
  the reference app doesn't have them either.
- **Any convenience tuned to one organization's workflow** — hardcoded field names, pinned date
  ranges, a fixed set of "program required" elements that override the schema's own
  `minOccurs`, shorthand input syntaxes carried over from a predecessor tool. Where the
  underlying capability is generally useful it appears above as a configurable mechanism; the
  specific values are not parity targets.

## What already matches

Recorded so these aren't re-audited: the flattener (`xs:include`/`xs:import` inlining, URL-import
skip, BOM scan), the parser's kind assignment and synthetic-node/transparency rules,
`xs:attribute` / `xs:group` / `xs:all` / `xs:attributeGroup` handling, inline-simpleType base
resolution, inline-element fallback, `FormInstanceKey` semantics, the FormEngine contract, all
**ten** undo action classes with the `isReplaying` guard, the XML writer's explicit-radio-selection
preference, per-instance XML round-trip with duplicate-documentId counting, unmatched-field
collection, the radio fixed-point selection loop, inflation, path rewriting, zoom, the splitter,
the wrap/stack layout toggle, the container context menu (fill all / fill required / clear), the
debug panel (4 tabs, TSV copy, JSON export, 200 ms debounce), cross-form search with
case/docs/line-number modes, and the validation panel with click-to-navigate.
