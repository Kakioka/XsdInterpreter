# Sample Schema Walkthrough

This document traces every XSD construct in the sample schema set through the
full pipeline: parse → SchemaElement tree → form render → FormEngine paths →
XML output. Use it alongside `SamplePacket.xsd`, `SampleCommonTypes.xsd`,
`SampleGroups.xsd`, and `SamplePacket.xml`.

Each section names the XSD construct, shows the relevant snippet, states what
the parser produces, what the UI renders, what path keys look like in FormEngine,
and what the XML writer emits.

---

## 1. xs:include (Multi-File Flattening)

**Where:** `SamplePacket.xsd` lines 1–2 of schema declarations

```xml
<xs:include schemaLocation="SampleCommonTypes.xsd"/>
<xs:include schemaLocation="SampleGroups.xsd"/>
```

**What the flattener does:**
1. Loads `SampleCommonTypes.xsd` and `SampleGroups.xsd` as text.
2. Scans each for BOM/ZWNBSP — strips U+FEFF before parsing.
3. Parses each as an XML DOM.
4. Inlines all top-level children (`xs:simpleType`, `xs:complexType`, `xs:group`)
   into the root document's `xs:schema` element.
5. Removes the `xs:include` elements.
6. The result is a single merged XSD document — `TypeLookupTable` sees all
   named types and groups as if they were declared in one file.

**What fails if not implemented:** `TypeLookupTable.getComplexType("AddressType")`
returns null → every `AddressType` reference fails → those elements get
`TextInput` instead of `GroupContainer`.

---

## 2. Named SimpleType → Dropdown (StatusType)

**Where:** `SampleCommonTypes.xsd`

```xml
<xs:simpleType name="StatusType">
  <xs:restriction base="xs:string">
    <xs:enumeration value="Active"/>
    <xs:enumeration value="Inactive"/>
    <xs:enumeration value="Pending"/>
    <xs:enumeration value="Closed"/>
  </xs:restriction>
</xs:simpleType>
```

**Used by:** `SampleHeader/PacketStatus`

```xml
<xs:element name="PacketStatus" type="StatusType"/>
```

**Parse result:**
```
SchemaElement {
  elementName:       "PacketStatus"
  kind:              "Dropdown"
  isRequired:        true
  enumerationValues: [
    { value: "Active",   label: "Active" },
    { value: "Inactive", label: "Inactive" },
    { value: "Pending",  label: "Pending" },
    { value: "Closed",   label: "Closed" }
  ]
  elementPath:       "SampleHeader.PacketStatus"
}
```

**Rendered control:** `<select>` with 5 options (blank + 4 values).

**FormEngine path:** `"SampleHeader.PacketStatus"` → `"active"` (value from XML)

**XML emitted:**
```xml
<PacketStatus>Active</PacketStatus>
```

---

## 3. Named SimpleType with Pattern → TextInput + ValidationRule

**Where:** `SampleCommonTypes.xsd`

```xml
<xs:simpleType name="CodeStringType">
  <xs:restriction base="xs:string">
    <xs:pattern value="[A-Z]{2}[0-9]{4}"/>
    <xs:maxLength value="6"/>
  </xs:restriction>
</xs:simpleType>
```

**Used by:** `SampleHeader/PacketId`

**Parse result:**
```
SchemaElement {
  elementName:      "PacketId"
  kind:             "TextInput"
  isRequired:       true
  validationRules:  [
    { kind: "pattern",   value: "[A-Z]{2}[0-9]{4}" },
    { kind: "maxLength", value: "6" }
  ]
  elementPath:      "SampleHeader.PacketId"
}
```

**Rendered control:** `<input type="text" maxlength="6">`. On blur, validate
against `^[A-Z]{2}[0-9]{4}$`. Invalid → show error message, set left border red.

**TestDataFiller:** `RegexSampleGenerator.generate("[A-Z]{2}[0-9]{4}")` → `"AB0000"`

**XML emitted:**
```xml
<PacketId>HI2025</PacketId>
```

---

## 4. Inline SimpleType Base Resolution (DatePicker chain)

**Where:** `SamplePacket.xsd` — `ExpiryDate` element in `SampleHeader`

```xml
<xs:element name="ExpiryDate" minOccurs="0">
  <xs:simpleType>
    <xs:restriction base="SampleDateType"/>
  </xs:simpleType>
</xs:element>
```

`SampleDateType` is defined in `SampleCommonTypes.xsd`:

```xml
<xs:simpleType name="SampleDateType">
  <xs:restriction base="xs:date"/>
</xs:simpleType>
```

**The resolution chain:**
```
ExpiryDate inline simpleType
  → restriction base = "SampleDateType"
  → TypeLookupTable.resolveUltimateBaseType("SampleDateType")
      SampleDateType restricts xs:date
      xs:date is a primitive → stop
  → xsdDataType = "xs:date"
  → kind = "DatePicker"
```

**What fails if chain not followed:** `base="SampleDateType"` is not a known
primitive, so the parser falls through to the default `TextInput`. The field
renders as a text box instead of a date picker, and date format validation never
runs.

**Parse result:**
```
SchemaElement {
  elementName:   "ExpiryDate"
  kind:          "DatePicker"
  xsdDataType:   "xs:date"
  isRequired:    false
  elementPath:   "SampleHeader.ExpiryDate"
}
```

**XML emitted** (when value present):
```xml
<ExpiryDate>2025-12-31</ExpiryDate>
```

**XML emitted** (when value absent, optional): element omitted entirely.

---

## 5. xs:boolean → Checkbox

**Where:** `SamplePacket.xsd` — `IsAmended` in `SampleHeader`

```xml
<xs:element name="IsAmended" type="xs:boolean"/>
```

**Parse result:**
```
SchemaElement {
  elementName: "IsAmended"
  kind:        "Checkbox"
  isRequired:  true
  elementPath: "SampleHeader.IsAmended"
}
```

**Rendered control:** `<input type="checkbox">`. Value stored as boolean `true`/`false`.
Undo records immediately on change (no focus cycle needed for checkboxes).

**XML emitted:**
```xml
<IsAmended>false</IsAmended>
```

---

## 6. Named ComplexType → GroupContainer

**Where:** `SampleCommonTypes.xsd` — `AddressType`

```xml
<xs:complexType name="AddressType">
  <xs:attribute name="addressKind" type="xs:string" use="optional"/>
  <xs:sequence>
    <xs:element name="StreetLine1" type="ShortStringType"/>
    <xs:element name="StreetLine2" type="ShortStringType" minOccurs="0"/>
    <xs:element name="City" type="ShortStringType"/>
    <xs:element name="StateCode" type="CodeStringType"/>
    <xs:element name="PostalCode">...</xs:element>
  </xs:sequence>
</xs:complexType>
```

**Used by:** `SampleEntityForm/RegisteredAddress`

**Parse result (abbreviated):**
```
SchemaElement {
  elementName: "RegisteredAddress"
  kind:        "GroupContainer"
  isRequired:  true
  elementPath: "SampleEntityForm.RegisteredAddress"
  children: [
    SchemaElement { elementName: "addressKind", kind: "TextInput",  isRequired: false },  ← xs:attribute
    SchemaElement { elementName: "StreetLine1", kind: "TextInput",  isRequired: true  },
    SchemaElement { elementName: "StreetLine2", kind: "TextInput",  isRequired: false },
    SchemaElement { elementName: "City",        kind: "TextInput",  isRequired: true  },
    SchemaElement { elementName: "StateCode",   kind: "TextInput",  isRequired: true  },
    SchemaElement { elementName: "PostalCode",  kind: "TextInput",  isRequired: true  }
  ]
}
```

**xs:attribute note:** `addressKind` is prepended to the children list, before
`StreetLine1`. In the XML it is written as an attribute, not a child element:
```xml
<RegisteredAddress addressKind="Physical">
  <StreetLine1>456 Corporate Drive</StreetLine1>
  ...
```

**Rendered control:** `<fieldset>` with `<legend>Registered Address</legend>`,
depth-colored background, containing child controls. `addressKind` renders as
a TextInput field inside the fieldset.

**FormEngine paths:**
```
"SampleEntityForm.RegisteredAddress.addressKind"   → "Physical"
"SampleEntityForm.RegisteredAddress.StreetLine1"   → "456 Corporate Drive"
"SampleEntityForm.RegisteredAddress.StreetLine2"   → "Suite 200"
"SampleEntityForm.RegisteredAddress.City"          → "Honolulu"
"SampleEntityForm.RegisteredAddress.StateCode"     → "HI0001"
"SampleEntityForm.RegisteredAddress.PostalCode"    → "96814"
```

---

## 7. xs:choice → RadioGroup

**Where:** `SamplePacket.xsd` — `EntityTypeChoice` in `SampleEntityForm`

```xml
<xs:element name="EntityTypeChoice">
  <xs:complexType>
    <xs:choice>
      <xs:sequence>  <!-- Branch 1: Individual -->
        <xs:element name="IndividualFirstName" .../>
        ...
      </xs:sequence>
      <xs:sequence>  <!-- Branch 2: Organization -->
        <xs:element name="OrgLegalName" .../>
        ...
      </xs:sequence>
    </xs:choice>
  </xs:complexType>
</xs:element>
```

**Parse result — synthetic node tree:**
```
SchemaElement {
  elementName:        "EntityTypeChoice"
  kind:               "GroupContainer"
  isGeneratedWrapper: false
  elementPath:        "SampleEntityForm.EntityTypeChoice"
  children: [
    SchemaElement {
      elementName:        "EntityTypeChoiceChoice"    ← synthetic wrapper, name = {Parent}Choice
      kind:               "RadioGroup"
      isGeneratedWrapper: false
      isTransparent:      true                        ← RadioGroup is transparent
      elementPath:        "SampleEntityForm.EntityTypeChoice.EntityTypeChoiceChoice"
      children: [
        SchemaElement {                               ← Option1 wrapper
          elementName:        "EntityTypeChoiceChoiceOption1"
          kind:               "SequenceContainer"
          isGeneratedWrapper: true                    ← never emits XML tag
          children: [
            SchemaElement { elementName: "IndividualFirstName", kind: "TextInput" },
            SchemaElement { elementName: "IndividualLastName",  kind: "TextInput" },
            SchemaElement { elementName: "IndividualBirthDate", kind: "DatePicker" },
            SchemaElement { elementName: "IdTypeChoice", kind: "GroupContainer",   ← nested choice (see §8)
              children: [ ... ] }
          ]
        },
        SchemaElement {                               ← Option2 wrapper
          elementName:        "EntityTypeChoiceChoiceOption2"
          kind:               "SequenceContainer"
          isGeneratedWrapper: true
          children: [
            SchemaElement { elementName: "OrgLegalName",    kind: "TextInput"  },
            SchemaElement { elementName: "OrgType",         kind: "Dropdown"   },
            SchemaElement { elementName: "OrgFoundedYear",  kind: "NumericInput" }
          ]
        }
      ]
    }
  ]
}
```

**Rendered control:**
```
<div class="radio-group" data-choice-path="SampleEntityForm.EntityTypeChoice.EntityTypeChoiceChoice">
  <label>Entity Type Choice</label>
  <label><input type="radio" name="..."> Option 1 (Individual)</label>
  <div class="branch-content" style="display:none">  ← hidden until selected
    [IndividualFirstName input]
    [IndividualLastName input]
    [IndividualBirthDate date]
    [IdTypeChoice radio group]  ← nested radio group, invisible until this branch opens
  </div>
  <label><input type="radio" name="..."> Option 2 (Organization)</label>
  <div class="branch-content">  ← visible (selected in sample XML)
    [OrgLegalName input]
    [OrgType select]
    [OrgFoundedYear number]
  </div>
</div>
```

**FormEngine state from sample XML:**
```
radioSelections["SampleEntityForm.EntityTypeChoice.EntityTypeChoiceChoice"]
  = "SampleEntityForm.EntityTypeChoice.EntityTypeChoiceChoice.EntityTypeChoiceChoiceOption2"

fieldValues["SampleEntityForm.EntityTypeChoice.EntityTypeChoiceChoiceOption2.OrgLegalName"]
  = "Acme Sample Corporation"
fieldValues["SampleEntityForm.EntityTypeChoice.EntityTypeChoiceChoiceOption2.OrgType"]
  = "Corporation"
fieldValues["SampleEntityForm.EntityTypeChoice.EntityTypeChoiceChoiceOption2.OrgFoundedYear"]
  = "1998"
```

**XML writer:**
- Consults `radioSelections` → Option2 selected.
- Emits only Option2's children directly under `EntityTypeChoice` (Option wrappers are transparent).
- Individual branch fields are NOT emitted even if they have stored values.

```xml
<EntityTypeChoice>
  <OrgLegalName>Acme Sample Corporation</OrgLegalName>
  <OrgType>Corporation</OrgType>
  <OrgFoundedYear>1998</OrgFoundedYear>
</EntityTypeChoice>
```

**Coloring:**
- Only Option2's children are evaluated for completeness.
- Option1's fields (hidden) are ignored by the coloring service.

---

## 8. Nested xs:choice → Nested RadioGroup (Fixed-Point Loop)

**Where:** `SamplePacket.xsd` — `IdTypeChoice` inside the Individual branch of `EntityTypeChoice`

```xml
<!-- Inside EntityTypeChoiceChoiceOption1 (Individual branch): -->
<xs:element name="IdTypeChoice">
  <xs:complexType>
    <xs:choice>
      <xs:sequence>  <!-- Passport -->
        <xs:element name="PassportNumber" .../>
        <xs:element name="PassportCountry" .../>
      </xs:sequence>
      <xs:sequence>  <!-- Driver License -->
        <xs:element name="DriverLicenseNumber" .../>
        <xs:element name="DriverLicenseState"  .../>
      </xs:sequence>
    </xs:choice>
  </xs:complexType>
</xs:element>
```

**The rendering problem this creates:**
The `IdTypeChoice` RadioGroup lives inside the Individual branch panel, which has
`display:none` until the user selects the Individual radio button. On XML load,
`selectRadioGroupBranches()` must restore all radio selections. But:

1. Pass 1: The outer `EntityTypeChoiceChoice` RadioGroup is found and Organization
   branch is selected. Individual branch remains `display:none`.
2. The `IdTypeChoice` RadioGroup is inside the Individual panel — it is not
   queryable via the DOM while hidden... but in browsers, unlike WPF, hidden
   elements ARE present in the DOM and CAN be queried with `querySelectorAll`.

**Browser vs. WPF difference:**
In WPF, `VisualTreeHelper` cannot traverse collapsed panels — hence the fixed-point
loop. In the browser, hidden elements are accessible. However, the fixed-point
loop is still recommended to handle cases where branch content is dynamically
inserted (e.g., a branch's DOM is created lazily when first selected). Implement
it for correctness even if a single pass works for eager rendering.

**FormEngine paths for IdTypeChoice (Individual branch — NOT selected in sample XML):**
These paths exist in FormEngine but are never emitted to XML because the outer
branch (Individual) is not selected:
```
radioSelections["...EntityTypeChoice.EntityTypeChoiceChoice.EntityTypeChoiceChoiceOption1.IdTypeChoice.IdTypeChoiceChoice"]
  → null  (no selection — Individual branch is not active)
```

**XML writer behavior:**
Since EntityTypeChoiceChoiceOption1 (Individual) is not the selected branch,
the writer never enters it. `IdTypeChoice` is never evaluated, never emitted.

---

## 9. xs:all → Transparent Non-Repeating Sequence

**Where:** `SamplePacket.xsd` — `InternalNotes` and `ReviewerCode` in `SampleHeader`

```xml
<xs:all>
  <xs:element name="InternalNotes"  type="ShortStringType" minOccurs="0"/>
  <xs:element name="ReviewerCode"   type="CodeStringType"  minOccurs="0"/>
</xs:all>
```

**Parse result:** The `xs:all` wrapper is treated as a transparent non-repeating
sequence. No `SchemaElement` is created for the `xs:all` itself. Its children
are promoted directly into the parent (`SampleHeader`):

```
SampleHeader.children includes:
  ...
  SchemaElement { elementName: "InternalNotes", kind: "TextInput", isRequired: false }
  SchemaElement { elementName: "ReviewerCode",  kind: "TextInput", isRequired: false }
```

**FormEngine paths:**
```
"SampleHeader.InternalNotes" → "Initial test submission..."
"SampleHeader.ReviewerCode"  → "AB1234"
```

**XML emitted:**
```xml
<InternalNotes>Initial test submission created for developer verification.</InternalNotes>
<ReviewerCode>AB1234</ReviewerCode>
```

**XML order note:** Because `xs:all` allows any order, the XML file has
`<ReviewerCode>` before `<InternalNotes>`. The reader must handle this. The
writer emits them in `SchemaElement.children` order (which matches the XSD
declaration order), not the XML file's order.

---

## 10. xs:group ref → Transparent Group Expansion (AuditStampGroup)

**Where:** `SamplePacket.xsd` — at the end of `SampleEntityForm`

```xml
<xs:group ref="AuditStampGroup"/>
```

`AuditStampGroup` is defined in `SampleGroups.xsd`:

```xml
<xs:group name="AuditStampGroup">
  <xs:sequence>
    <xs:element name="AuditCreatedBy"    .../>
    <xs:element name="AuditCreatedDate"  type="xs:date"/>
    <xs:element name="AuditModifiedBy"   minOccurs="0" .../>
    <xs:element name="AuditModifiedDate" type="xs:date" minOccurs="0"/>
  </xs:sequence>
</xs:group>
```

**Parse result:** `ExpandGroupRef("AuditStampGroup")` looks up the group,
finds its `xs:sequence`, and inlines the 4 child elements directly into
`SampleEntityForm.children`. No `SchemaElement` is created for the group.

```
SampleEntityForm.children includes (at end):
  SchemaElement { elementName: "AuditCreatedBy",    kind: "TextInput",  isRequired: true  }
  SchemaElement { elementName: "AuditCreatedDate",  kind: "DatePicker", isRequired: true  }
  SchemaElement { elementName: "AuditModifiedBy",   kind: "TextInput",  isRequired: false }
  SchemaElement { elementName: "AuditModifiedDate", kind: "DatePicker", isRequired: false }
```

**FormEngine paths:**
```
"SampleEntityForm.AuditCreatedBy"    → "dataentry1"
"SampleEntityForm.AuditCreatedDate"  → "2024-01-12"
"SampleEntityForm.AuditModifiedBy"   → (empty — absent in XML)
"SampleEntityForm.AuditModifiedDate" → (empty — absent in XML)
```

**XML emitted:**
```xml
<AuditCreatedBy>dataentry1</AuditCreatedBy>
<AuditCreatedDate>2024-01-12</AuditCreatedDate>
<!-- AuditModifiedBy and AuditModifiedDate omitted — optional with no value -->
```

---

## 11. xs:group with xs:all → Double Transparency (FlagsGroup)

**Where:** `SampleGroups.xsd`

```xml
<xs:group name="FlagsGroup">
  <xs:all>
    <xs:element name="IsActive"       type="xs:boolean"/>
    <xs:element name="IsVerified"     type="xs:boolean"/>
    <xs:element name="IsConfidential" type="xs:boolean" minOccurs="0"/>
  </xs:all>
</xs:group>
```

**Used by:** `SampleEventLog` via `<xs:group ref="FlagsGroup"/>`

**Parse result:** Two levels of transparency:
1. The `xs:group ref` is transparent (no SchemaElement created for group).
2. The `xs:all` inside is transparent (no SchemaElement created for xs:all).
3. The three boolean children are inlined directly into `SampleEventLog.children`.

```
SampleEventLog.children includes:
  ...
  SchemaElement { elementName: "IsActive",       kind: "Checkbox", isRequired: true  }
  SchemaElement { elementName: "IsVerified",     kind: "Checkbox", isRequired: true  }
  SchemaElement { elementName: "IsConfidential", kind: "Checkbox", isRequired: false }
```

**FormEngine paths (instance 1, documentId=EVT-001):**
```
"SampleEventLog.IsActive"       → "true"
"SampleEventLog.IsVerified"     → "false"
"SampleEventLog.IsConfidential" → (absent — optional, not in EVT-001)
```

**XML emitted (EVT-001):**
```xml
<IsActive>true</IsActive>
<IsVerified>false</IsVerified>
<!-- IsConfidential omitted — optional, no value -->
```

---

## 12. Nested xs:group ref → Recursive Expansion (NestedRefGroup)

**Where:** `SamplePacket.xsd` — at the end of `SampleFinancialForm`

```xml
<xs:group ref="NestedRefGroup"/>
```

`NestedRefGroup` (in `SampleGroups.xsd`) references both other groups:

```xml
<xs:group name="NestedRefGroup">
  <xs:sequence>
    <xs:group ref="AuditStampGroup"/>
    <xs:group ref="FlagsGroup"/>
  </xs:sequence>
</xs:group>
```

**Parse result:** Recursive expansion:
```
ExpandGroupRef("NestedRefGroup")
  → finds NestedRefGroup's xs:sequence
  → ParseChildren on sequence:
      xs:group ref="AuditStampGroup" → ExpandGroupRef("AuditStampGroup")
          → AuditCreatedBy, AuditCreatedDate, AuditModifiedBy, AuditModifiedDate
      xs:group ref="FlagsGroup" → ExpandGroupRef("FlagsGroup")
          → xs:all (transparent) → IsActive, IsVerified, IsConfidential
  → 7 elements inlined directly into SampleFinancialForm.children
```

**No SchemaElement is ever created for NestedRefGroup, AuditStampGroup, FlagsGroup,
or the xs:sequence/xs:all wrappers.**

**FormEngine paths:**
```
"SampleFinancialForm.AuditCreatedBy"    → "finance1"
"SampleFinancialForm.AuditCreatedDate"  → "2024-02-01"
"SampleFinancialForm.AuditModifiedBy"   → "manager1"
"SampleFinancialForm.AuditModifiedDate" → "2024-03-01"
"SampleFinancialForm.IsActive"          → "true"
"SampleFinancialForm.IsVerified"        → "true"
"SampleFinancialForm.IsConfidential"    → "false"
```

---

## 13. Repeating xs:sequence → SequenceContainer

**Where:** `SamplePacket.xsd` — `PriorNameList` in `SampleEntityForm`

```xml
<xs:element name="PriorNameList" minOccurs="0">
  <xs:complexType>
    <xs:sequence maxOccurs="unbounded">
      <xs:element name="FormerName"       type="ShortStringType"/>
      <xs:element name="NameUsedUntil"    type="xs:date"/>
      <xs:element name="NameChangeReason" minOccurs="0" .../>
    </xs:sequence>
  </xs:complexType>
</xs:element>
```

**Parse result:** Anonymous `xs:sequence` with `maxOccurs="unbounded"` inside
a named element → `SequenceContainer` with `isRepeating=true`.

A synthetic entry wrapper is generated:

```
SchemaElement {
  elementName:        "PriorNameList"
  kind:               "GroupContainer"   ← the outer named element
  isRequired:         false
  elementPath:        "SampleEntityForm.PriorNameList"
  children: [
    SchemaElement {
      elementName:        "PriorNameListEntry"    ← synthetic: {Parent}Entry
      kind:               "SequenceContainer"
      isRepeating:        true
      isGeneratedWrapper: true                    ← transparent, no XML tag
      elementPath:        "SampleEntityForm.PriorNameList.PriorNameListEntry"
      children: [
        SchemaElement { elementName: "FormerName",       kind: "TextInput",  isRequired: true  },
        SchemaElement { elementName: "NameUsedUntil",    kind: "DatePicker", isRequired: true  },
        SchemaElement { elementName: "NameChangeReason", kind: "TextInput",  isRequired: false }
      ]
    }
  ]
}
```

**Inflation from sample XML:**
The XML contains 2 `<PriorNameList>` elements.
`RepeatingInstanceCounts["PriorNameListEntry"] = 2` (keyed by the synthetic entry name).
The renderer inflates 2 instance rows before `restoreActiveForm()`.

**FormEngine paths:**
```
"SampleEntityForm.PriorNameList.PriorNameListEntry[0].FormerName"       → "Acme Sample Industries"
"SampleEntityForm.PriorNameList.PriorNameListEntry[0].NameUsedUntil"    → "2010-06-30"
"SampleEntityForm.PriorNameList.PriorNameListEntry[0].NameChangeReason" → "Rebranding..."
"SampleEntityForm.PriorNameList.PriorNameListEntry[1].FormerName"       → "Acme Widgets LLC"
"SampleEntityForm.PriorNameList.PriorNameListEntry[1].NameUsedUntil"    → "1998-12-31"
"SampleEntityForm.PriorNameList.PriorNameListEntry[1].NameChangeReason" → (absent — optional)
```

**XML emitted:**
```xml
<PriorNameList>
  <FormerName>Acme Sample Industries</FormerName>
  <NameUsedUntil>2010-06-30</NameUsedUntil>
  <NameChangeReason>Rebranding to reflect expanded services.</NameChangeReason>
</PriorNameList>
<PriorNameList>
  <FormerName>Acme Widgets LLC</FormerName>
  <NameUsedUntil>1998-12-31</NameUsedUntil>
</PriorNameList>
```

**Note:** Each repeating instance is written as a separate `<PriorNameList>` element
(the transparent `PriorNameListEntry` wrapper emits no tag). The `NameChangeReason`
on instance [1] is absent because it is optional and has no value.

**Remove invariant:** When the user removes instance [0], the implementation must:
1. Capture values snapshot BEFORE purge.
2. Call `purgeValuesUnderPathPrefix("...PriorNameListEntry[0]")`.
3. Re-index remaining instances: [1] becomes [0].
4. Remove the DOM row.
5. Record `RepeatingInstanceRemoveAction`.

---

## 14. Repeatable Top-Level Form (SampleEventLog)

**Where:** `SamplePacket.xsd` packet root

```xml
<xs:element ref="SampleEventLog" minOccurs="1" maxOccurs="unbounded"/>
```

**What this means for PacketAnalyzer:**
`PacketSection { elementName: "SampleEventLog", isRepeatable: true, maxOccurs: -1 }`

**What this means for FormInstanceKey:**
Each `<SampleEventLog>` element in the XML produces a distinct `FormInstanceKey`:

```
FormInstanceKey { formName: "SampleEventLog", instanceId: "EVT-001" }
FormInstanceKey { formName: "SampleEventLog", instanceId: "EVT-002" }
```

The `instanceId` is read from the `documentId` attribute. If absent or duplicate,
a new UUID is minted.

**Nav tree appearance:**
```
Forms
├── SampleHeader
├── SampleEntityForm
├── SampleFinancialForm
├── SampleEventLog          ← first instance: "SampleEventLog#EVT-001" or displayed label
├── SampleEventLog          ← second instance: "SampleEventLog#EVT-002"
└── SampleSummary
```

**State isolation:** Switching between the two SampleEventLog instances must
restore each one's independent field values. They do NOT share FormState.

`SampleEventLog#EVT-001` has `RequiresFollowUp=false`, `IsConfidential` absent.
`SampleEventLog#EVT-002` has `RequiresFollowUp=true`, `IsConfidential=true`.

If switching instances causes values to bleed between them, `setActiveForm`
is not persisting state before clearing `registeredControls`.

**FormEngine paths (EVT-001):**
```
"SampleEventLog.EventTitle"        → "Initial Submission Received"
"SampleEventLog.EventDate"         → "2024-03-15"
"SampleEventLog.EventType"         → "Submission"
"SampleEventLog.EventSeverity"     → "1"
"SampleEventLog.EventDescription"  → "First submission..."
"SampleEventLog.RequiresFollowUp"  → "false"
"SampleEventLog.IsActive"          → "true"
"SampleEventLog.IsVerified"        → "false"
```

**XML emitted:**
```xml
<SampleEventLog documentId="EVT-001">
  <EventTitle>Initial Submission Received</EventTitle>
  <EventDate>2024-03-15</EventDate>
  <EventType>Submission</EventType>
  <EventSeverity>1</EventSeverity>
  <EventDescription>First submission of the sample packet.</EventDescription>
  <RequiresFollowUp>false</RequiresFollowUp>
  <IsActive>true</IsActive>
  <IsVerified>false</IsVerified>
</SampleEventLog>
```

---

## 15. Inline Element Fallback (SampleSummary)

**Where:** `SamplePacket.xsd` — `SampleSummary` declared inside `SamplePacket`'s sequence

```xml
<xs:element name="SamplePacket">
  <xs:complexType>
    <xs:sequence>
      ...
      <xs:element name="SampleSummary" minOccurs="1" maxOccurs="1">
        <xs:complexType>
          <xs:sequence>
            <xs:element name="TotalRecordCount" type="CountType"/>
            <xs:element name="TotalAmount"      type="PositiveAmountType"/>
            <xs:element name="SummaryNotes"     type="ShortStringType" minOccurs="0"/>
            <xs:group ref="AuditStampGroup"/>
          </xs:sequence>
        </xs:complexType>
      </xs:element>
    </xs:sequence>
  </xs:complexType>
</xs:element>
```

**There is no top-level `<xs:element name="SampleSummary">` in the schema.**

**What `parseGlobalElement("SampleSummary")` must do:**
1. Search top-level `xs:element[@name="SampleSummary"]` — not found.
2. Fallback: search inline elements within the root element's `complexType/sequence/all`.
3. Find the inline declaration → parse it as if it were a global element.

**What fails without the fallback:** `parseGlobalElement("SampleSummary")` returns
null → nav tree item exists but clicking it throws an error or renders a blank form.

**Parse result:**
```
SchemaElement {
  elementName: "SampleSummary"
  kind:        "GroupContainer"
  elementPath: "SampleSummary"
  children: [
    SchemaElement { elementName: "TotalRecordCount", kind: "NumericInput",  isRequired: true  },
    SchemaElement { elementName: "TotalAmount",      kind: "DecimalInput",  isRequired: true  },
    SchemaElement { elementName: "SummaryNotes",     kind: "TextInput",     isRequired: false },
    SchemaElement { elementName: "AuditCreatedBy",   kind: "TextInput",     isRequired: true  },  ← expanded
    SchemaElement { elementName: "AuditCreatedDate", kind: "DatePicker",    isRequired: true  },
    SchemaElement { elementName: "AuditModifiedBy",  kind: "TextInput",     isRequired: false },
    SchemaElement { elementName: "AuditModifiedDate",kind: "DatePicker",    isRequired: false }
  ]
}
```

---

## 16. xs:attribute on a Repeatable Form Element (SampleEventLog.documentId)

**Where:** `SamplePacket.xsd` — `SampleEventLog` complexType

```xml
<xs:complexType>
  <xs:attribute name="documentId" type="xs:string" use="optional"/>
  <xs:sequence>
    <xs:element name="EventTitle" .../>
    ...
  </xs:sequence>
</xs:complexType>
```

**Dual role:** `documentId` serves two purposes:
1. As a `SchemaElement` child (TextInput) rendered in the form — user can edit it.
2. As the source for `FormInstanceKey.InstanceId` on XML load.

**XML reader behavior:**
When reading `<SampleEventLog documentId="EVT-001">`:
1. Read `documentId` attribute → `instanceId = "EVT-001"`.
2. Build `FormInstanceKey { formName: "SampleEventLog", instanceId: "EVT-001" }`.
3. Also store `"SampleEventLog.documentId" → "EVT-001"` in `fieldValues` so the
   field shows the correct value when the form is rendered.

**Round-trip:** When writing XML, emit `documentId` as an attribute on the
`<SampleEventLog>` element AND as a registered field value. The writer must
handle attributes specially — read `addressKind` from `fieldValues` and emit
as an XML attribute, not a child element.

---

## 17. Unmatched Fields (UnknownLegacyField)

**Where:** `SamplePacket.xml` — inside `<SampleHeader>`

```xml
<UnknownLegacyField>some_legacy_value</UnknownLegacyField>
```

There is no `UnknownLegacyField` in the schema.

**XML reader behavior:**
While walking `SampleHeader`, the reader encounters `<UnknownLegacyField>`.
It finds no matching `SchemaElement` child in `SampleHeader.children`.

Expected behavior:
1. Record `UnmatchedXmlField { formName: "SampleHeader", xmlPath: "SampleHeader.UnknownLegacyField", value: "some_legacy_value" }`.
2. Continue loading all other fields — do NOT abort.
3. After load completes, show the unmatched fields list to the user.

**What breaks if not implemented:** Either the reader crashes on unknown elements,
or it silently drops them with no user notification. Either way the developer
cannot trust their XML reader.

---

## 18. Decimal and Numeric Validation Rules

**Where:** `SampleCommonTypes.xsd` — `PercentType`, `PositiveAmountType`, `CountType`

```xml
<xs:simpleType name="PercentType">
  <xs:restriction base="xs:decimal">
    <xs:minInclusive value="0.00"/>
    <xs:maxInclusive value="100.00"/>
    <xs:fractionDigits value="2"/>
  </xs:restriction>
</xs:simpleType>
```

**ValidationRules extracted:**
```js
[
  { kind: "minInclusive",   value: "0.00"   },
  { kind: "maxInclusive",   value: "100.00" },
  { kind: "fractionDigits", value: "2"      }
]
```

**Used by:** `SampleFinancialForm.TaxRate`

**Validation on input:** On blur:
- `parseFloat(value) < 0.00` → error "Minimum value: 0.00"
- `parseFloat(value) > 100.00` → error "Maximum value: 100.00"
- More than 2 decimal places → error (fractionDigits)

**Sample value in XML:** `<TaxRate>8.25</TaxRate>` — valid (≥0, ≤100, 2 decimal places).

---

## 19. Complete Feature Coverage Checklist

Use this as a test checklist when verifying an implementation against the sample files.

| # | Feature | XSD Location | XML Location | Test |
|---|---------|-------------|-------------|------|
| 1 | xs:include flattening | SamplePacket.xsd lines 1–2 | — | AddressType resolves |
| 2 | Named simpleType → Dropdown | StatusType in CommonTypes | PacketStatus=Active | `<select>` renders with 4 options |
| 3 | Named simpleType → TextInput + pattern | CodeStringType | PacketId=HI2025 | Pattern validation fires on bad input |
| 4 | Inline simpleType chain → DatePicker | ExpiryDate in SampleHeader | ExpiryDate=2025-12-31 | Date picker renders, not text input |
| 5 | xs:dateTime → DatePicker | EffectiveDateTime | EffectiveDateTime=2024-03-15T09:00:00 | datetime-local input |
| 6 | xs:boolean → Checkbox | IsAmended, IsExtension | IsAmended=false | Checkbox renders; false loads unchecked |
| 7 | Named complexType → GroupContainer | AddressType | RegisteredAddress | fieldset with legend |
| 8 | xs:attribute on complexType | addressKind on AddressType | addressKind="Physical" | Text input inside fieldset; emitted as XML attribute |
| 9 | xs:choice → RadioGroup | EntityTypeChoice | OrgLegalName present | Two radio buttons; Org branch shown |
| 10 | Nested xs:choice | IdTypeChoice | (Individual not selected) | Inner radio group in Individual panel |
| 11 | Fixed-point loop | SelectRadioGroupBranches | — | No missing branch selections after load |
| 12 | xs:all transparent | InternalNotes, ReviewerCode | Both present (reversed order) | Both fields readable in any XML order |
| 13 | xs:group ref → expansion | AuditStampGroup | AuditCreatedBy etc. in SampleEntityForm | 4 fields render directly in form |
| 14 | xs:group + xs:all (double transparent) | FlagsGroup | IsActive, IsVerified in SampleEventLog | 3 checkboxes render directly |
| 15 | Nested xs:group ref | NestedRefGroup | 7 fields in SampleFinancialForm | AuditStamp + Flags all render |
| 16 | SequenceContainer | PriorNameList | 2 entries | 2 rows inflate; Add/Remove buttons work |
| 17 | Nested container in repeating | LineItems | 2 entries | Each entry renders |
| 18 | Repeatable form | SampleEventLog x2 | EVT-001, EVT-002 | 2 nav tree entries; independent state |
| 19 | FormInstanceKey from documentId | SampleEventLog | documentId="EVT-001" | InstanceId = "EVT-001" |
| 20 | Inline element fallback | SampleSummary | SampleSummary element | Form renders (not blank) |
| 21 | Unmatched fields | — | UnknownLegacyField | Unmatched fields dialog appears; other fields still load |
| 22 | DecimalInput + range rules | PercentType, PositiveAmountType | TaxRate=8.25 | Decimal input; out-of-range triggers error |
| 23 | NumericInput + range rules | CountType, YearType | TaxYear=2024, ItemCount=2 | Integer input; range validation |
| 24 | Optional field omission | StreetLine2, EmailAddress, etc. | Multiple absent optionals | Fields blank; no error; XML omits them |
| 25 | Required empty field → XML emitted | Any required field cleared | — | Empty required element still appears in XML |
| 26 | Undo across form switch | — | — | Undo after switching forms restores correct form |
| 27 | Round-trip | All forms | SamplePacket.xml | Save → reload produces identical values |
