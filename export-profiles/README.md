# Export profiles

An export profile tells **Create Submission Package** what to ask for and how to lay out the
ZIP. The app has no packaging rules of its own: everything specific to one organization is in
a profile. `mef-state.profile.json` is the one bundled profile. Load others from the packaging
dialog; they are remembered in the browser, and the profile you choose is remembered per schema.

`mef-state` carries over the original desktop app's rules. It has **not** been checked against
the published manifest schema. Do that before a real submission.

## Format

| Property | Meaning |
|---|---|
| `formatVersion` | `1` |
| `id`, `name`, `description` | Identity and display text. Loading a profile replaces a loaded one with the same `id`. |
| `archiveName` | Template for the ZIP's file name |
| `limits.maxEntryPathLength` | Longest allowed path inside the archive (optional) |
| `fields` | Metadata to collect, in order |
| `fileGroups` | Files to collect |
| `entries` | What goes in the archive |

**Templates** (`archiveName`, entry paths, document values and attributes) may use `{fieldId}`
and `{packetName}`; a `files` path may also use `{fileName}`.

**Fields**: `id`, `label`, `section` (heading), `type` (`text` or `select`), `options`
(`[{value, label}]`), `required`, `maxLength`, `pattern` (regular expression matching the whole
value), `patternMessage` (reads on from the label: "must be 4 digits."), `placeholder`, `hint`,
`default`, `when`, `remember`.

Set `"remember": false` on anything sensitive. Its value is used for the package being created and
never saved in the browser; a value saved before the flag was added is deleted.

**Conditions** (`when`, on fields, entries and document elements): one condition, or a list that
must all hold. Each names an earlier `field` and one of `equals`, `in` (a list), or
`"notBlank": true`. A field whose condition doesn't hold is hidden, not validated, and blank
everywhere else.

**File groups**: `id`, `label`, `multiple`, `required`, `maxCount`, `uniqueNames`, `accept`.

**Entries**, by `type`:

- `packet`: the XML being edited. `"xmlDeclaration": true` adds an XML declaration.
- `document`: XML built from `document`, which is `{name, namespace, prefix, attributes, value,
  children, when}`. `namespace` and `prefix` go on the root and apply throughout. Blank elements
  are omitted.
- `files`: every file in `group`.
- `directory`: listed explicitly when nothing else is in it. The path ends with `/`.
