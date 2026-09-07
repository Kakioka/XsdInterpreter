# Phase 9 dry-run findings — MeF readiness gap audit

**Status: not real Phase 9.** Per `IMPLEMENTATION_PLAN.md`, Phase 9 is explicitly gated on
obtaining an actual IRS/state MeF schema, and no such schema has been provided to this
project. This document (and its companion harness, [`dev/phase9-check.html`](phase9-check.html))
is a **dry run**: it exercises the §25 "MeF Real-World Readiness Checklist" constructs, plus
one extra construct found along the way, as synthetic XSD/XML fixtures run through the real
`flattener.js` / `parser.js` / `xmlReader.js` / `xmlWriter.js` / `validation.js` modules — so
every finding below is demonstrated empirically (open the harness via a local server and read
the pass/fail rows), not just inferred from reading the source.

**Nothing here has been fixed.** Per §25's own framing and the parser's inline comments (e.g.
`getStructuralContainer`'s note in `js/core/parser.js`), the right shape for handling several
of these constructs depends on how a real schema actually uses them — guessing now risks
building the wrong abstraction. This is the punch list for the day a real schema arrives, now
backed by concrete evidence of what happens today instead of just a checklist of construct
names.

Open `dev/phase9-check.html` via a local server (Live Server or equivalent) to run the harness
live and see each finding's evidence.

---

## Findings

### 0. Directly-repeating elements without the sequence-wrapper idiom — data loss (new finding, not in §25)

The app's only modeled repetition idiom is the "anonymous repeating sequence" pattern (§4):
a **named container** whose sole content is a repeating `<xs:sequence maxOccurs="unbounded">`
(e.g. `PriorNameList` → synthetic `PriorNameListEntry`). A schema that instead repeats an
element **directly** — `<xs:element name="Item" maxOccurs="unbounded">`, no wrapping sequence
— is arguably the more common real-world idiom, and it is not modeled at all:

- `SchemaElement.isRepeating` is never set for this shape (`_buildSchemaElementForDecl` in
  `js/core/parser.js` never populates it from the particle's own `maxOccurs`), even though
  `maxOccurs` itself is correctly recorded as `null` (unbounded).
- `xmlReader.js`'s container/leaf paths use `xmlEl.querySelector` (singular) — reading 3
  `<Item>` siblings silently keeps only the first; the other two are dropped with **no**
  `unmatchedFields` entry, since the tag name is a recognized child.
- `xmlWriter.js`'s container/leaf paths only ever emit one element regardless of how many
  logical repeats exist in `fieldValues` (which has no room for more than one value at this
  path in the first place — there's no `[i]` index for it).

**Severity:** high. If a real MeF schema uses this idiom anywhere (very likely for repeating
attachments/line items), affected fields silently lose all but the first occurrence on load,
and any edit only ever writes one occurrence back out — a correctness bug with no user-visible
warning.

**Scope to fix:** extend `_buildSchemaElementForDecl`/`_parseParticleElement` to recognize
`maxOccurs > 1` (or `unbounded`) on the particle itself and either (a) synthesize the same
kind of Entry-wrapper treatment used for sequences, or (b) model it as first-class repetition
without a synthetic name segment. Whichever shape is chosen must be mirrored in
`xmlReader.js`, `xmlWriter.js`, `coloringService.js`, `validation.js`, and `formRenderer.js` —
the same five-way parallel structure `isRepeatingContentContainer` already has to keep in sync.

### 1. `attributeFormDefault="qualified"` (§25 bullet 1)

Never read anywhere (not in `flattener.js`, not in `parser.js`). Consequences, both confirmed:

- **Reading**: `xmlReader.js`'s `walkContainerBody` calls `xmlEl.getAttribute(attr.elementName)`
  — a plain, non-namespace-aware lookup. A namespace-qualified attribute (as
  `attributeFormDefault="qualified"` requires, e.g. `<t:Foo t:Code="ABC">`) is invisible to it;
  `getAttribute('Code')` returns `null` and the value is silently lost.
- **Writing**: `xmlWriter.js`'s container branch calls `el.setAttribute(attr.elementName, ...)`
  — always unqualified, regardless of what `attributeFormDefault` the target schema declares.

**Severity:** high if any real schema in scope uses `attributeFormDefault="qualified"` (state
MeF schemas vary on this per §25's own note) — every attribute on every form would read back
empty and write out non-conformant.

### 2. `xsi:schemaLocation` on output (§25 bullet 1)

Confirmed absent: `buildPacketXml` never sets it, never declares the `xsi` namespace prefix.
Whether this is actually required by the submission channel is unverified either way — it's a
one-line addition to `buildPacketXml` once confirmed necessary.

### 3. Multiple namespaces mixed in one packet (§25 bullet 1)

`flattenFromRoot` records only the **root file's own** `targetNamespace`; an `xs:import`ed
file's distinct `targetNamespace` is discarded the moment its top-level declarations are
inlined into the root document (`inlineTopLevelChildren` does a raw `importNode`, no namespace
bookkeeping). Confirmed: the parsed `SchemaElement` tree carries no per-element namespace at
all, and `buildPacketXml` accepts exactly one `targetNamespace` for the entire output document
— an element that schema-belongs to a second namespace (e.g. a federal element embedded in a
state packet) gets written under the state packet's single namespace instead, silently wrong.

**Severity:** high if federal/state mixing is real for any target packet (§25 flags this as
an open question) — this is a structural gap, not a one-line fix; the `SchemaElement` model,
`xmlWriter`, and `xmlReader` would all need per-node namespace awareness.

### 4. `xs:union` / `xs:list` simple types (§25 bullet 2)

Both rely on `<xs:restriction>` for enumerations/validation rules and ultimate-base
resolution; a union/list type has no `xs:restriction` child. Confirmed: such a field silently
degrades to `kind: 'TextInput'` with zero validation rules and zero enumeration options — no
crash, no warning, just quietly loses all type semantics. A secondary, sharper bug: the raw
type name (e.g. `"FlexType"`) leaks into `xsdDataType` unresolved, breaking the otherwise
universal invariant that `xsdDataType` is always an `xs:`-prefixed primitive.

### 5. Identity constraints: `xs:key` / `xs:unique` / `xs:keyref` (§25 bullet 2)

Confirmed harmless to parse (they're siblings of `xs:complexType` under an `xs:element`, never
visited by `_finishComplexType`) but entirely invisible downstream. `validation.js` has no
error `kind` for a uniqueness/reference violation at all (`completeness` / `format` /
`occurrence` / `choice` / `unmatched` are the complete list) — confirmed empirically: two
repeating entries with an identical "key" field value pass `validateSchema` with zero errors.

### 6. Substitution groups (§25 bullet 2)

`ref="AbstractHead"` resolves only to the abstract head element's own (typically empty)
declaration — the app has no concept of substitution-group membership, so it never considers
that a *member* element (`substitutionGroup="AbstractHead"`) is what can legally appear
instead. Confirmed: the head renders as an unlabeled, content-less text field, and real,
schema-valid XML using a member tag (e.g. `<CheckPayment>`) is flagged as an **unmatched**
(unrecognized) field — a false positive that would show up in the Validation panel as if the
data were wrong when it isn't.

### 7. Wildcards: `xs:any` / `xs:anyAttribute` (§25 bullet 2)

Both are simply not among the tag names any parsing branch checks for, so they contribute
nothing to the `SchemaElement` tree (no placeholder, no warning). Confirmed downstream
consequences: an attribute legally permitted by `xs:anyAttribute` is read nowhere (not even
into `fieldValues`, since attribute reading is driven off the schema's own declared attribute
list); an element legally permitted by `xs:any` is flagged **unmatched** on read — another
false positive, structurally identical to the substitution-group case above.

### 8. Mixed content models (§25 bullet 2)

`mixed="true"` is never read from `xs:complexType`. Confirmed: interspersed text nodes
alongside child elements are read nowhere (`walkContainerBody`/`walkElement` only ever walk
`.children`, never text nodes) and — a stronger, round-trip-level finding — are **not
recoverable even indirectly**: reading such a document into `FormState` and writing it back
out via `buildPacketXml` reproduces only the child elements; the surrounding text is gone for
good, silently, with no error at either the read or write step.

### 9. `xsi:nil` (§25 bullet 2)

Never inspected anywhere. Confirmed: `<Foo xsi:nil="true"/>` and `<Foo></Foo>` (plain empty)
read into byte-for-byte identical `FormState` — the nil signal (explicitly no value vs. merely
empty) is completely indistinguishable in this app, and is never re-emitted on write-back
either (there's no code path that could set the attribute even if it wanted to).

### 10. `xs:redefine` (§25 bullet 2)

`flattener.js`'s `resolveIncludesAndImports` only looks for `xs:include`/`xs:import` tags by
localName — `xs:redefine` is left completely untouched in the flat document, so the file it
points at is **never merged in at all** (contrast with include/import, which recursively
resolve and inline, then `.remove()` the directive element). Worse, even the redefinition's
own inline type override (nested *inside* `<xs:redefine>`) is invisible to `TypeLookupTable`,
which only scans **direct** children of `<xs:schema>` for `complexType`/`simpleType`/`group`.
Confirmed: an element typed by a redefined complex type falls all the way through to the
"unknown type name" fallback path and silently becomes an unlabeled, content-less
`TextInput` — losing the base type's fields, the redefinition's added fields, and the
relationship between them, with no error surfaced anywhere.

### 11. `complexType` inheritance via `xs:complexContent`/`xs:extension` (§25 bullet 2)

This one was already flagged inline in `js/core/parser.js`'s `getStructuralContainer` comment
as unverified — now confirmed by direct test: `_collectAttributes`/`findTopLevelModelGroup`
are only ever pointed at the `<xs:extension>` node itself, never at the named base type it
references. A derived complex type's own new field/attribute show up fine; the **base type's**
field and attribute are silently absent from the parsed tree, with nothing hinting at the
missing data — this is a real inheritance chain silently truncated to one level, still
un-followed even for a chain of depth 1.

---

## Summary table

| # | Construct | §25 ref | Confirmed behavior | Severity if present in real schema |
|---|---|---|---|---|
| 0 | Directly-repeating element (no seq wrapper) | — (found here) | Only first occurrence read; only one ever written | High |
| 1 | `attributeFormDefault="qualified"` | bullet 1 | Attributes silently unread/unwritten | High |
| 2 | `xsi:schemaLocation` on output | bullet 1 | Never emitted | Low–Medium (verify need) |
| 3 | Multi-namespace packet | bullet 1 | Second namespace discarded; output mis-namespaced | High |
| 4 | `xs:union` / `xs:list` | bullet 2 | Degrades to unlabeled, unvalidated TextInput | Medium |
| 5 | `xs:key`/`xs:unique`/`xs:keyref` | bullet 2 | Ignored; duplicates pass validation | Medium |
| 6 | `substitutionGroup` | bullet 2 | Member tags flagged as false-positive "unmatched" | Medium–High |
| 7 | `xs:any`/`xs:anyAttribute` | bullet 2 | Wildcard content flagged as false-positive "unmatched" | Medium–High |
| 8 | Mixed content | bullet 2 | Interspersed text permanently lost, even round-trip | Medium |
| 9 | `xsi:nil` | bullet 2 | Indistinguishable from empty; never preserved | Low–Medium |
| 10 | `xs:redefine` | bullet 2 | Redefined file never merged; type silently unresolved | High (if used) |
| 11 | `xs:complexContent`/`xs:extension` | bullet 2 | Base type's fields/attributes silently dropped | High (if used) |

None of this blocks anything — the tool still works correctly against the sample schema set,
which uses none of these constructs. This is the concrete evidence to work from the moment a
real schema is available, replacing guesswork with "here's exactly what breaks and why."
