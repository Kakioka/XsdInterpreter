// js/core/parser.js — Flat XSD DOM → SchemaElement tree, plus Packet Analysis.
//
// See web-implementation-spec.md §2 (Data Models), §4 (Schema Parsing),
// §5 (Packet Analysis), §8 (Path Conventions).
// IMPLEMENTATION_PLAN.md Phase 1.2 (parsing) and Phase 1.3 (packet analysis).
//
// Pure logic, no DOM dependency beyond reading the already-flattened XSD DOM
// (produced by js/core/flattener.js). This module is also home to the shared
// path/tree helper predicates (joinPath, isTransparent, isAttribute, isLeaf,
// isRepeatingContentContainer) reused later by js/core/xmlWriter.js and
// js/core/xmlReader.js — see spec §10 "Shared Helper Predicates".

const XS_NS = 'http://www.w3.org/2001/XMLSchema';

const XS_BUILTIN_TYPES = new Set([
  'string', 'boolean', 'decimal', 'float', 'double', 'duration', 'dateTime', 'time', 'date',
  'gYearMonth', 'gYear', 'gMonthDay', 'gDay', 'gMonth', 'hexBinary', 'base64Binary', 'anyURI',
  'QName', 'NOTATION', 'normalizedString', 'token', 'language', 'NMTOKEN', 'NMTOKENS', 'Name',
  'NCName', 'ID', 'IDREF', 'IDREFS', 'ENTITY', 'ENTITIES', 'integer', 'nonPositiveInteger',
  'negativeInteger', 'long', 'int', 'short', 'byte', 'nonNegativeInteger', 'unsignedLong',
  'unsignedInt', 'unsignedShort', 'unsignedByte', 'positiveInteger', 'anySimpleType', 'anyType',
]);

const NUMERIC_INTEGER_TYPES = new Set([
  'integer', 'int', 'long', 'short', 'byte', 'nonPositiveInteger', 'negativeInteger',
  'nonNegativeInteger', 'positiveInteger', 'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte',
]);

const VALIDATION_RULE_TAGS = new Set([
  'minLength', 'maxLength', 'pattern', 'minInclusive', 'maxInclusive', 'totalDigits', 'fractionDigits',
]);

const MODEL_GROUP_TAGS = new Set(['sequence', 'choice', 'all', 'group']);

// ---------------------------------------------------------------------------
// Shared path / tree helpers (spec §8, §10) — also used by xmlWriter / xmlReader
// ---------------------------------------------------------------------------

/** Extend a path with one more segment. Never string-concatenate '.' by hand — see §8. */
export function joinPath(prefix, name) {
  return prefix ? `${prefix}.${name}` : name;
}

/** Every kind==='SequenceContainer' node this parser has ever produced (the
 *  repeating-Entry idiom, a choice-option wrapper) is ALSO isGeneratedWrapper —
 *  so checking isGeneratedWrapper alone is equivalent for those, and correctly
 *  excludes a REAL, non-synthetic repeating element (kind==='GroupContainer',
 *  isRepeating=true — see _finishComplexType) from being treated as tagless. */
export function isTransparent(el) {
  return el.isGeneratedWrapper || el.kind === 'RadioGroup';
}

export function isAttribute(el) {
  return el.isAttribute === true;
}

export function isLeaf(el) {
  return el.children.length === 0;
}

/** The non-attribute children of a SchemaElement — attributes don't participate
 *  in "is this container's entire structural content just one special child"
 *  checks below (a hypothetical attribute alongside the special child is not
 *  exercised by the sample schema, but there's no reason to let its mere
 *  presence break detection). */
function structuralChildren(el) {
  return el.children.filter((c) => !isAttribute(c));
}

/**
 * True for the "anonymous repeating sequence" idiom (spec §4 Synthetic Nodes):
 * a named, non-repeating container whose entire content model is a single
 * synthetic, transparent, repeating Entry wrapper (e.g. PriorNameList → PriorNameListEntry).
 */
export function isRepeatingContentContainer(el) {
  const kids = structuralChildren(el);
  return kids.length === 1 && kids[0].isRepeating && kids[0].isGeneratedWrapper;
}

/**
 * The choice-analogue of isRepeatingContentContainer: a named element whose
 * entire content model is a single bare xs:choice (e.g. EntityTypeChoice,
 * PaymentMethodChoice — named only to host the choice, no sibling fields of
 * its own). Confirmed against sample-schemas/SamplePacket.xml: OrgLegalName /
 * BankRoutingNumber etc. appear directly under the GRANDPARENT element with no
 * <EntityTypeChoice>/<PaymentMethodChoice> wrapper tag in the actual XML at all
 * — only WALKTHROUGH.md's illustrative snippet shows the wrapper, which this
 * fixture-driven behavior overrides as the authoritative contract (Phase 2).
 * The outer element's name still contributes a path segment for FormEngine/UI
 * purposes (e.g. "SampleEntityForm.EntityTypeChoice.EntityTypeChoiceChoice...")
 * — it just never becomes an XML tag, exactly like isRepeatingContentContainer's
 * Entry wrapper never becomes one.
 */
export function isChoiceOnlyContainer(el) {
  const kids = structuralChildren(el);
  return kids.length === 1 && kids[0].kind === 'RadioGroup';
}

// ---------------------------------------------------------------------------
// Small DOM/string utilities local to this module
// ---------------------------------------------------------------------------

function firstChild(el, localName) {
  for (const child of el.children) {
    if (child.localName === localName) return child;
  }
  return null;
}

function children(el, localName) {
  return Array.from(el.children).filter((c) => c.localName === localName);
}

function stripPrefix(qname) {
  const idx = qname.indexOf(':');
  return idx === -1 ? qname : qname.slice(idx + 1);
}

function isXsPrimitive(qname) {
  return XS_BUILTIN_TYPES.has(stripPrefix(qname));
}

function lastSegment(path) {
  const idx = path.lastIndexOf('.');
  return idx === -1 ? path : path.slice(idx + 1);
}

function parseOccurs(particleEl) {
  const minOccurs = particleEl.hasAttribute('minOccurs') ? parseInt(particleEl.getAttribute('minOccurs'), 10) : 1;
  const maxOccursRaw = particleEl.getAttribute('maxOccurs');
  const maxOccurs = maxOccursRaw == null ? 1 : maxOccursRaw === 'unbounded' ? null : parseInt(maxOccursRaw, 10);
  return { minOccurs, maxOccurs };
}

function getAnnotationDocumentation(el) {
  const annotation = firstChild(el, 'annotation');
  if (!annotation) return null;
  return firstChild(annotation, 'documentation');
}

// Most schema annotations here are structured (<Description>/<FormNumber>/<LineNumber>/
// <ELFFieldNumber> children rather than bare text) — the Description child is the only
// piece meant for the tooltip, so it's read on its own rather than via doc.textContent,
// which would otherwise concatenate every sibling's text (including FormNumber/LineNumber/
// ELFFieldNumber) into one run-on string. A few annotations are still plain text (no
// Description child), so that's kept as the fallback.
function getDocumentation(el) {
  const doc = getAnnotationDocumentation(el);
  if (!doc) return '';
  const description = firstChild(doc, 'Description');
  const text = description ? description.textContent : doc.textContent;
  return (text || '').trim().replace(/\s+/g, ' ');
}

// ELFFieldNumber is deliberately ignored — not needed for display.
function getLineNumber(el) {
  const doc = getAnnotationDocumentation(el);
  if (!doc) return '';
  const lineNumberEl = firstChild(doc, 'LineNumber');
  return lineNumberEl ? (lineNumberEl.textContent || '').trim() : '';
}

/** "IndividualFirstName" → "Individual First Name". Not spec-mandated (§2 only says
 *  "human-readable label") — a plausible camelCase splitter, easy to swap later. */
export function humanizeLabel(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
}

/**
 * The <xsd:extension>/<xsd:restriction> inside a complexType's <xsd:simpleContent>
 * wrapper, if present — the "value with XML attributes" idiom this schema set uses
 * throughout for money amounts referencing a worksheet (e.g. FormN11.xsd's
 * MedicalAndDentalDeduction: <xsd:extension base="USAmountNNType"> plus a
 * referenceDocumentId/referenceDocumentName xsd:attribute pair). Neither
 * _resolveEffectiveAttributeEls nor _resolveEffectiveParticles (both
 * complexContent-only) ever look inside a simpleContent wrapper, so left
 * unhandled in _buildSchemaElementForDecl this produced a GroupContainer with
 * zero attributes AND zero model children — an empty box with no way to enter
 * the value at all. See _buildSchemaElementForDecl's use of this for the fix:
 * treated as a plain leaf of the extension's own base type instead.
 */
function getSimpleContentExtension(complexTypeEl) {
  const simpleContent = firstChild(complexTypeEl, 'simpleContent');
  if (!simpleContent) return null;
  return firstChild(simpleContent, 'extension') || firstChild(simpleContent, 'restriction');
}

function findTopLevelModelGroup(containerEl) {
  for (const child of containerEl.children) {
    if (MODEL_GROUP_TAGS.has(child.localName)) return child;
  }
  return null;
}

/**
 * Resolves to the element actually holding attributes/content-model particles.
 * NOTE: does not merge a complexContent/extension base type's own attributes or
 * model — only what's declared directly on the extension/restriction node itself.
 * Only used for the packet-analysis section walk (analyzePacket) and the
 * packet root's own inline-declaration search (_findInlineDeclaration) — a
 * packet's wrapper/root elements aren't themselves extension-based in any
 * schema seen so far, so the gap doesn't reach them. A real MeF *leaf form*
 * almost always IS extension-based, which is why SchemaParser._finishComplexType
 * uses _resolveEffectiveParticles/_resolveEffectiveAttributeEls below instead
 * of this function, to actually follow the base-type chain when rendering.
 */
function getStructuralContainer(complexTypeEl) {
  const wrapper = firstChild(complexTypeEl, 'complexContent') || firstChild(complexTypeEl, 'simpleContent');
  if (!wrapper) return complexTypeEl;
  return firstChild(wrapper, 'extension') || firstChild(wrapper, 'restriction') || complexTypeEl;
}

function findGlobalElementInDoc(flatDoc, name) {
  for (const child of flatDoc.documentElement.children) {
    if (child.localName === 'element' && child.getAttribute('name') === name) return child;
  }
  return null;
}

function extractEnumerations(restrictionEl) {
  return children(restrictionEl, 'enumeration').map((e) => {
    const value = e.getAttribute('value');
    return { value, label: value };
  });
}

function extractValidationRules(restrictionEl) {
  const rules = [];
  for (const child of restrictionEl.children) {
    if (VALIDATION_RULE_TAGS.has(child.localName)) {
      rules.push({ kind: child.localName, value: child.getAttribute('value') });
    }
  }
  return rules;
}

/**
 * MeF/e-file schemas commonly model an optional checkbox as a string type
 * restricted to the single enumeration value "X" (e.g. Common/efileTypes.xsd's
 * CheckboxType, reused ~150 times across the sample schema set) rather than a
 * real xsd:boolean — checked is the element present with value "X", unchecked
 * is the element simply omitted from the XML entirely (never a literal blank
 * value). A one-option "(blank) / X" dropdown is technically faithful to that
 * but reads as meaningless to a user; a real checkbox is what they expect, as
 * long as the false→omit / true→"X" translation happens at the XML boundary
 * instead of writing a "true"/"false" that would violate the enumeration —
 * see xmlWriter.js's buildNodes/formatValue and xmlReader.js's parseValue,
 * which branch on xsdDataType !== 'xs:boolean' to do exactly that.
 */
function isXEnumCheckboxType(enumerationValues) {
  return enumerationValues.length === 1 && enumerationValues[0].value.trim().toUpperCase() === 'X';
}

function assignLeafKind(xsdDataType, enumerationValues) {
  const local = stripPrefix(xsdDataType || 'xs:string');
  if (local === 'boolean') return 'Checkbox';
  if (isXEnumCheckboxType(enumerationValues)) return 'Checkbox';
  if (enumerationValues.length > 0) return 'Dropdown';
  if (local === 'date' || local === 'dateTime') return 'DatePicker';
  if (NUMERIC_INTEGER_TYPES.has(local)) return 'NumericInput';
  if (local === 'decimal') return 'DecimalInput';
  return 'TextInput';
}

// ---------------------------------------------------------------------------
// SchemaElement factory (spec §2)
// ---------------------------------------------------------------------------

export function createSchemaElement(fields) {
  return {
    elementName: fields.elementName,
    resolvedLabel: fields.resolvedLabel ?? humanizeLabel(fields.elementName),
    documentation: fields.documentation ?? '',
    lineNumber: fields.lineNumber ?? '',
    kind: fields.kind,
    xsdDataType: fields.xsdDataType ?? null,
    originalTypeName: fields.originalTypeName ?? null,
    isRequired: !!fields.isRequired,
    minOccurs: fields.minOccurs ?? 1,
    maxOccurs: fields.maxOccurs === undefined ? 1 : fields.maxOccurs,
    isRepeating: !!fields.isRepeating,
    isGeneratedWrapper: !!fields.isGeneratedWrapper,
    isAttribute: !!fields.isAttribute,
    isInstanceIdSource: !!fields.isInstanceIdSource,
    enumerationValues: fields.enumerationValues ?? [],
    validationRules: fields.validationRules ?? [],
    children: fields.children ?? [],
    elementPath: fields.elementPath,
    instanceLabel: fields.instanceLabel ?? '',
  };
}

// ---------------------------------------------------------------------------
// TypeLookupTable (spec §4)
// ---------------------------------------------------------------------------

export class TypeLookupTable {
  constructor(flatDoc) {
    this.complexTypes = new Map();
    this.simpleTypes = new Map();
    this.groups = new Map();
    this.attributeGroups = new Map();
    this._build(flatDoc);
  }

  _build(doc) {
    for (const child of doc.documentElement.children) {
      const name = child.getAttribute('name');
      if (!name) continue;
      if (child.localName === 'complexType') this.complexTypes.set(name.toLowerCase(), child);
      else if (child.localName === 'simpleType') this.simpleTypes.set(name.toLowerCase(), child);
      else if (child.localName === 'group') this.groups.set(name.toLowerCase(), child);
      else if (child.localName === 'attributeGroup') this.attributeGroups.set(name.toLowerCase(), child);
    }
  }

  getComplexType(name) {
    return name ? this.complexTypes.get(name.toLowerCase()) : undefined;
  }

  getSimpleType(name) {
    return name ? this.simpleTypes.get(name.toLowerCase()) : undefined;
  }

  getGroup(name) {
    return name ? this.groups.get(name.toLowerCase()) : undefined;
  }

  getAttributeGroup(name) {
    return name ? this.attributeGroups.get(name.toLowerCase()) : undefined;
  }

  /**
   * Follows xs:restriction base chains through named simpleTypes until a
   * primitive is reached, e.g. resolveUltimateBaseType("SampleDateType") → "xs:date".
   * Unknown / unresolvable names are returned unchanged.
   */
  resolveUltimateBaseType(typeName, seen = new Set()) {
    if (!typeName) return typeName;
    if (isXsPrimitive(typeName)) return `xs:${stripPrefix(typeName)}`;
    const key = typeName.toLowerCase();
    if (seen.has(key)) return typeName; // guard against a restriction cycle
    seen.add(key);
    const simpleType = this.getSimpleType(typeName);
    if (!simpleType) return typeName; // unknown type name — leave as-is
    const restriction = firstChild(simpleType, 'restriction');
    const base = restriction && restriction.getAttribute('base');
    if (!base) return typeName;
    return this.resolveUltimateBaseType(base, seen);
  }
}

// ---------------------------------------------------------------------------
// SchemaParser (spec §4)
// ---------------------------------------------------------------------------

export class SchemaParser {
  constructor(flatDoc, rootElementName = null) {
    this.flatDoc = flatDoc;
    this.types = new TypeLookupTable(flatDoc);
    this.rootElementName = rootElementName;
  }

  setRootElementName(name) {
    this.rootElementName = name;
  }

  /**
   * §4 "Global Element Lookup": try a top-level xs:element[@name], then fall
   * back to an inline declaration nested inside the packet root's own content
   * model (supports schemas where child forms are declared inline, e.g. §4's
   * SampleSummary case).
   */
  parseGlobalElement(name) {
    const globalEl = findGlobalElementInDoc(this.flatDoc, name);
    if (globalEl) {
      return this._buildSchemaElementForDecl(globalEl, name, '', { minOccurs: 1, maxOccurs: 1 });
    }
    const inline = this._findInlineDeclaration(name);
    if (inline) {
      return this._buildSchemaElementForDecl(inline.el, name, '', { minOccurs: inline.minOccurs, maxOccurs: inline.maxOccurs });
    }
    return null;
  }

  _findInlineDeclaration(name) {
    if (!this.rootElementName) return null;
    const rootEl = findGlobalElementInDoc(this.flatDoc, this.rootElementName);
    if (!rootEl) return null;
    const complexType = firstChild(rootEl, 'complexType');
    if (!complexType) return null;
    const topGroup = findTopLevelModelGroup(getStructuralContainer(complexType));
    if (!topGroup) return null;
    const found = this._searchParticlesForInlineElement(topGroup, name);
    return found ? { el: found, ...parseOccurs(found) } : null;
  }

  _searchParticlesForInlineElement(groupEl, name) {
    for (const child of groupEl.children) {
      if (child.localName === 'element' && !child.hasAttribute('ref') && child.getAttribute('name') === name) {
        return child;
      }
      if (child.localName === 'sequence' || child.localName === 'choice' || child.localName === 'all') {
        const found = this._searchParticlesForInlineElement(child, name);
        if (found) return found;
      }
      // Deliberately does not descend into xs:group ref= here — an inline-fallback
      // target declared inside a referenced group is an edge case not exercised
      // by the sample schema set.
    }
    return null;
  }

  /** defEl carries the definition (type/children/documentation); occurs carries the
   *  cardinality from wherever this element was actually referenced (a ref= particle's
   *  own minOccurs/maxOccurs, never the global declaration's, per XSD semantics). */
  _buildSchemaElementForDecl(defEl, elementName, parentPath, occurs) {
    const elementPath = joinPath(parentPath, elementName);
    const documentation = getDocumentation(defEl);
    const lineNumber = getLineNumber(defEl);
    const typeAttr = defEl.getAttribute('type');
    const inlineSimpleType = firstChild(defEl, 'simpleType');
    const inlineComplexType = firstChild(defEl, 'complexType');

    const base = {
      elementName,
      documentation,
      lineNumber,
      isRequired: occurs.minOccurs >= 1,
      minOccurs: occurs.minOccurs,
      maxOccurs: occurs.maxOccurs,
      elementPath,
    };

    if (inlineComplexType) {
      const simpleContentExt = getSimpleContentExtension(inlineComplexType);
      if (simpleContentExt) return this._finishSimpleType(base, simpleContentExt.getAttribute('base'), null);
      return this._finishComplexType(base, inlineComplexType);
    }

    if (typeAttr) {
      const namedComplexType = this.types.getComplexType(typeAttr);
      if (namedComplexType) {
        const simpleContentExt = getSimpleContentExtension(namedComplexType);
        if (simpleContentExt) return this._finishSimpleType(base, simpleContentExt.getAttribute('base'), null);
        base.originalTypeName = typeAttr;
        return this._finishComplexType(base, namedComplexType);
      }
      return this._finishSimpleType(base, typeAttr, inlineSimpleType);
    }

    if (inlineSimpleType) return this._finishSimpleType(base, null, inlineSimpleType);

    // No type / complexType / simpleType at all: XSD implies anySimpleType.
    // Pragmatically treated as a plain string field.
    return createSchemaElement({ ...base, kind: 'TextInput', xsdDataType: 'xs:string' });
  }

  _finishSimpleType(base, typeAttr, inlineSimpleTypeEl) {
    let enumerationValues = [];
    let validationRules = [];
    let ultimateBase;

    if (inlineSimpleTypeEl) {
      const restriction = firstChild(inlineSimpleTypeEl, 'restriction');
      const restrictionBase = restriction ? restriction.getAttribute('base') : null;
      ultimateBase = this.types.resolveUltimateBaseType(restrictionBase);
      if (restriction) {
        enumerationValues = extractEnumerations(restriction);
        validationRules = extractValidationRules(restriction);
      }
      base.originalTypeName = restrictionBase;
    } else {
      const namedSimpleType = this.types.getSimpleType(typeAttr);
      if (namedSimpleType) {
        const restriction = firstChild(namedSimpleType, 'restriction');
        if (restriction) {
          enumerationValues = extractEnumerations(restriction);
          validationRules = extractValidationRules(restriction);
        }
      }
      ultimateBase = this.types.resolveUltimateBaseType(typeAttr);
      base.originalTypeName = typeAttr;
    }

    const xsdDataType = ultimateBase || 'xs:string';
    return createSchemaElement({
      ...base,
      xsdDataType,
      enumerationValues,
      validationRules,
      kind: assignLeafKind(xsdDataType, enumerationValues),
    });
  }

  _finishComplexType(base, complexTypeEl) {
    const attributeEls = this._resolveEffectiveAttributeEls(complexTypeEl);
    const attributes = this._collectAttributes(attributeEls, base.elementPath);
    const particles = this._resolveEffectiveParticles(complexTypeEl);
    const modelChildren = this._parseParticlesFromList(particles, base.elementPath);
    // A real (non-synthetic) repeating GROUP — e.g. MeF's very common
    // `<xsd:element name="DependentInformation" type="HIDependentType"
    // minOccurs="0" maxOccurs="99"/>` idiom, one of several siblings in its
    // parent's sequence. base.maxOccurs is already the resolved numeric value
    // from the REFERENCING particle's own maxOccurs (occurs.maxOccurs from
    // parseOccurs — null means unbounded, matching _parseSequenceGroup's own
    // isRepeatingSeq check). Distinct from the anonymous-inline-sequence
    // idiom (kind: 'SequenceContainer', isGeneratedWrapper: true): this
    // element keeps its own tag/kind and is never transparent — see
    // isTransparent and buildGroupContainer/xmlWriter/xmlReader's handling of
    // "isRepeating && !isGeneratedWrapper".
    const isRepeating = base.maxOccurs == null || base.maxOccurs > 1;
    return createSchemaElement({
      ...base,
      kind: 'GroupContainer',
      isRepeating,
      children: [...attributes, ...modelChildren], // attributes prepended — see §4
    });
  }

  /**
   * A complexType's OWN top-level particles — a plain sequence/all's .children
   * (its actual field declarations), or a bare choice/group ref kept as a
   * single particle so callers always get a flat, uniform particle list.
   */
  _ownParticles(containerEl) {
    const topGroup = findTopLevelModelGroup(containerEl);
    if (!topGroup) return [];
    if (topGroup.localName === 'sequence' || topGroup.localName === 'all') {
      return Array.from(topGroup.children).filter((c) => c.localName !== 'annotation');
    }
    return [topGroup]; // bare xs:choice or xs:group ref as the entire content model
  }

  /**
   * Resolves a complexType's EFFECTIVE particle list, following
   * complexContent/xs:extension base chains: the base type's own particles
   * come first, then this type's own local additions (XSD extension
   * semantics). This is what lets a MeF-style form declared as
   * `<extension base="FormN11Type">` — where every field lives on the
   * separately-named base complexType and the extension itself only adds
   * attributes — actually render its fields; without following the chain,
   * `_ownParticles` on the extension node alone finds nothing and the form
   * renders empty. xs:restriction at the complex-type level isn't exercised
   * by any schema this parser has been run against; kept as the old,
   * unmerged (own-particles-only) fallback.
   */
  _resolveEffectiveParticles(complexTypeEl) {
    const complexContent = firstChild(complexTypeEl, 'complexContent');
    if (!complexContent) return this._ownParticles(complexTypeEl);
    const extensionEl = firstChild(complexContent, 'extension');
    if (!extensionEl) return this._ownParticles(firstChild(complexContent, 'restriction') || complexTypeEl);
    const baseComplexType = this.types.getComplexType(extensionEl.getAttribute('base'));
    const baseParticles = baseComplexType ? this._resolveEffectiveParticles(baseComplexType) : [];
    return [...baseParticles, ...this._ownParticles(extensionEl)];
  }

  /** Direct xs:attribute children plus every xs:attributeGroup ref's own
   *  attributes (resolved recursively, in case a group references another). */
  _ownAttributeEls(containerEl) {
    const direct = children(containerEl, 'attribute');
    const fromGroups = children(containerEl, 'attributeGroup').flatMap((refEl) => {
      const groupDecl = this.types.getAttributeGroup(stripPrefix(refEl.getAttribute('ref') || ''));
      return groupDecl ? this._ownAttributeEls(groupDecl) : [];
    });
    return [...direct, ...fromGroups];
  }

  /** Same base-chain-following shape as _resolveEffectiveParticles, for attributes. */
  _resolveEffectiveAttributeEls(complexTypeEl) {
    const complexContent = firstChild(complexTypeEl, 'complexContent');
    if (!complexContent) return this._ownAttributeEls(complexTypeEl);
    const extensionEl = firstChild(complexContent, 'extension');
    if (!extensionEl) return this._ownAttributeEls(firstChild(complexContent, 'restriction') || complexTypeEl);
    const baseComplexType = this.types.getComplexType(extensionEl.getAttribute('base'));
    const baseAttrs = baseComplexType ? this._resolveEffectiveAttributeEls(baseComplexType) : [];
    return [...baseAttrs, ...this._ownAttributeEls(extensionEl)];
  }

  _collectAttributes(attrEls, ownerPath) {
    return attrEls.map((attrEl) => {
      const name = attrEl.getAttribute('name');
      const use = attrEl.getAttribute('use') || 'optional';
      const typeAttr = attrEl.getAttribute('type');
      const inlineSimpleType = firstChild(attrEl, 'simpleType');
      const attrBase = {
        elementName: name,
        documentation: getDocumentation(attrEl),
        lineNumber: getLineNumber(attrEl),
        isRequired: use === 'required',
        minOccurs: use === 'required' ? 1 : 0,
        maxOccurs: 1,
        elementPath: joinPath(ownerPath, name),
        isAttribute: true,
        isInstanceIdSource: name.toLowerCase() === 'documentid',
      };
      return this._finishSimpleType(attrBase, typeAttr, inlineSimpleType);
    });
  }

  /** Dispatches on the tag of a model-group node. Returns an ARRAY of SchemaElement
   *  children to splice into the caller's children list (xs:all / xs:group ref are
   *  transparent and can contribute many; xs:choice always contributes exactly one
   *  synthetic RadioGroup node, still wrapped in an array for uniform splicing). */
  _parseModelGroup(groupEl, parentPath) {
    switch (groupEl.localName) {
      case 'sequence':
        return this._parseSequenceGroup(groupEl, parentPath);
      case 'choice':
        return [this._parseChoiceGroup(groupEl, parentPath)];
      case 'all':
        return this._parseParticleList(groupEl, parentPath); // xs:all is a transparent non-repeating sequence — §4
      case 'group':
        return this._parseGroupRef(groupEl, parentPath); // xs:group ref is transparent — §4
      default:
        return [];
    }
  }

  _parseSequenceGroup(seqEl, parentPath) {
    const { minOccurs, maxOccurs } = parseOccurs(seqEl);
    const isRepeatingSeq = seqEl.getAttribute('maxOccurs') === 'unbounded' || (maxOccurs != null && maxOccurs > 1);

    if (!isRepeatingSeq) {
      // Plain (non-repeating) sequence: its particles become direct children of the parent.
      return this._parseParticleList(seqEl, parentPath);
    }

    // Anonymous repeating sequence idiom (§4 Synthetic Nodes): the OUTER element's
    // own tag is what actually repeats in XML (see xmlWriter §10 / xmlReader §11) —
    // this synthetic Entry wrapper exists only so FormEngine paths have a segment
    // to attach the `[i]` index to.
    //
    // NOTE for Phase 5 (validation): minOccurs/maxOccurs here reflect the
    // <xs:sequence> particle's own attributes (default minOccurs=1 per XSD when
    // unspecified), which is a distinct number from the outer element's own
    // minOccurs/maxOccurs (e.g. PriorNameList itself is minOccurs="0"). Reconciling
    // "0 required entries because the outer element is optional" vs. "this literal
    // XSD attribute defaults to 1" is a validator-level judgment call, not a parser one.
    const parentName = lastSegment(parentPath);
    const entryName = `${parentName}Entry`;
    const entryPath = joinPath(parentPath, entryName);
    return [
      createSchemaElement({
        elementName: entryName,
        documentation: '',
        lineNumber: '',
        kind: 'SequenceContainer',
        isRequired: minOccurs >= 1,
        minOccurs,
        maxOccurs,
        isRepeating: true,
        isGeneratedWrapper: true,
        children: this._parseParticleList(seqEl, entryPath),
        elementPath: entryPath,
      }),
    ];
  }

  /**
   * `choiceIndex` disambiguates multiple xs:choice particles sitting as
   * SIBLINGS under the same parent (e.g. Common/ReturnHeader.xsd's
   * PaidPreparerInformationGrp: PTIN/STIN/PreparerSSN, then separately
   * PreparerFirmEIN/MissingEINReasonCd, then a US/Foreign address choice,
   * then a phone-number choice — four independent xs:choice blocks, all
   * direct children of the same complexType sequence). Without it every one
   * of them computes the exact same `${parentName}Choice` name — and, worse,
   * the exact same `choicePath`/`elementPath` — from `parentPath` alone, so
   * they'd not only render identical "...Choice" headers but actually share
   * one FormEngine radioSelections key and even (via `${choiceName}Option${i+1}`)
   * per-option elementPaths, making them literally the same field: selecting
   * an option in ONE of the choices would overwrite/appear to select an
   * option in every other one. Defaults to 1 (unnumbered "...Choice") so a
   * parent with only one xs:choice — the overwhelmingly common case — keeps
   * its existing name/path exactly as before; only the 2nd, 3rd, etc. sibling
   * choice under the same parent gets a numbered suffix, from
   * _parseParticlesFromList's own per-parent counter.
   */
  _parseChoiceGroup(choiceEl, parentPath, choiceIndex = 1) {
    const parentName = lastSegment(parentPath);
    const choiceName = choiceIndex > 1 ? `${parentName}Choice${choiceIndex}` : `${parentName}Choice`;
    const choicePath = joinPath(parentPath, choiceName);
    const { minOccurs, maxOccurs } = parseOccurs(choiceEl);

    const branches = Array.from(choiceEl.children).filter((c) => MODEL_GROUP_TAGS.has(c.localName) || c.localName === 'element');
    const options = branches.map((branchEl, i) => {
      const optionName = `${choiceName}Option${i + 1}`;
      const optionPath = joinPath(choicePath, optionName);
      let optionChildren;
      if (branchEl.localName === 'sequence') optionChildren = this._parseParticleList(branchEl, optionPath);
      else if (branchEl.localName === 'element') optionChildren = [this._parseParticleElement(branchEl, optionPath)];
      else if (branchEl.localName === 'group') optionChildren = this._parseGroupRef(branchEl, optionPath);
      else if (branchEl.localName === 'all') optionChildren = this._parseParticleList(branchEl, optionPath);
      else if (branchEl.localName === 'choice') optionChildren = [this._parseChoiceGroup(branchEl, optionPath)];
      else optionChildren = [];

      return createSchemaElement({
        elementName: optionName,
        documentation: '',
        lineNumber: '',
        kind: 'SequenceContainer',
        isRequired: false,
        minOccurs: 1,
        maxOccurs: 1,
        isRepeating: false,
        isGeneratedWrapper: true,
        children: optionChildren,
        elementPath: optionPath,
      });
    });

    return createSchemaElement({
      elementName: choiceName,
      documentation: '',
      lineNumber: '',
      kind: 'RadioGroup',
      isRequired: minOccurs >= 1,
      minOccurs,
      maxOccurs,
      isRepeating: false,
      isGeneratedWrapper: false, // RadioGroup's own kind makes it transparent — see isTransparent()
      children: options,
      elementPath: choicePath,
    });
  }

  _parseGroupRef(groupRefEl, parentPath) {
    const ref = groupRefEl.getAttribute('ref');
    if (!ref) return [];
    const groupDecl = this.types.getGroup(stripPrefix(ref));
    if (!groupDecl) {
      console.warn(`Unresolved xs:group ref="${ref}"`);
      return [];
    }
    const inner = findTopLevelModelGroup(groupDecl);
    return inner ? this._parseModelGroup(inner, parentPath) : [];
  }

  _parseParticleList(groupEl, parentPath) {
    return this._parseParticlesFromList(Array.from(groupEl.children), parentPath);
  }

  /** Same dispatch as _parseParticleList, over a plain particle array instead
   *  of a single group element's .children — shared with _finishComplexType's
   *  extension-chain merge, which has no single DOM group element to hand it. */
  _parseParticlesFromList(particles, parentPath) {
    const result = [];
    let choiceCount = 0;
    for (const child of particles) {
      if (child.localName === 'element') result.push(this._parseParticleElement(child, parentPath));
      else if (child.localName === 'group') result.push(...this._parseGroupRef(child, parentPath));
      // choiceCount disambiguates multiple xs:choice siblings under this same
      // parent — see _parseChoiceGroup's own comment on why that's needed.
      else if (child.localName === 'choice') result.push(this._parseChoiceGroup(child, parentPath, ++choiceCount));
      else if (child.localName === 'sequence') result.push(...this._parseSequenceGroup(child, parentPath));
      else if (child.localName === 'all') result.push(...this._parseParticleList(child, parentPath));
      // 'annotation' and anything else: ignored here (documentation is read via getDocumentation on the owning element)
    }
    return result;
  }

  _parseParticleElement(particleEl, parentPath) {
    const ref = particleEl.getAttribute('ref');
    let defEl = particleEl;
    let elementName;
    if (ref) {
      elementName = stripPrefix(ref);
      const globalEl = findGlobalElementInDoc(this.flatDoc, elementName);
      if (!globalEl) throw new Error(`Unresolved xs:element ref="${ref}"`);
      defEl = globalEl;
    } else {
      elementName = particleEl.getAttribute('name');
    }
    return this._buildSchemaElementForDecl(defEl, elementName, parentPath, parseOccurs(particleEl));
  }
}

// ---------------------------------------------------------------------------
// Packet Analysis (spec §5)
// ---------------------------------------------------------------------------

/**
 * Root candidates are global elements never targeted by any xs:element ref=
 * anywhere in the flat document — no naming convention (§5, §20).
 *
 * Extension beyond the literal spec algorithm: a global element declared as
 * `type="SomeType"` is ALSO excluded when SomeType is reused as an
 * xs:extension/xs:restriction base elsewhere. That pattern (e.g. IRS MeF's
 * ReturnHeader/ReturnHeaderType, extended by each state's own
 * ReturnHeaderState element) declares the base element only so other schemas
 * can inherit its type — it's a template, never `ref=`'d, but also never
 * meant to be instantiated as a standalone root — so without this it wrongly
 * shows up as a second "root candidate" alongside the real root.
 * @param {Document} flatDoc
 * @returns {string[]}
 */
export function findRootElementCandidates(flatDoc) {
  const globalNames = new Set();
  const typeByGlobalName = new Map();
  for (const child of flatDoc.documentElement.children) {
    if (child.localName === 'element' && child.hasAttribute('name')) {
      globalNames.add(child.getAttribute('name'));
      if (child.hasAttribute('type')) typeByGlobalName.set(child.getAttribute('name'), stripPrefix(child.getAttribute('type')));
    }
  }
  const referenced = new Set();
  for (const el of flatDoc.getElementsByTagNameNS(XS_NS, 'element')) {
    const ref = el.getAttribute('ref');
    if (ref) referenced.add(stripPrefix(ref));
  }
  const extendedBaseTypes = new Set();
  for (const tag of ['extension', 'restriction']) {
    for (const el of flatDoc.getElementsByTagNameNS(XS_NS, tag)) {
      const base = el.getAttribute('base');
      if (base) extendedBaseTypes.add(stripPrefix(base));
    }
  }
  return [...globalNames].filter((n) => {
    if (referenced.has(n)) return false;
    const type = typeByGlobalName.get(n);
    if (type && extendedBaseTypes.has(type)) return false;
    return true;
  });
}

function buildSection(particleEl, flatDoc) {
  const ref = particleEl.getAttribute('ref');
  const elementName = ref ? stripPrefix(ref) : particleEl.getAttribute('name');
  const { minOccurs, maxOccurs: maxOccursRaw } = parseOccurs(particleEl);
  const maxOccurs = maxOccursRaw == null ? -1 : maxOccursRaw;

  let description = '';
  let childForms = [];
  if (ref) {
    const globalEl = findGlobalElementInDoc(flatDoc, elementName);
    description = globalEl ? getDocumentation(globalEl) : '';
    childForms = globalEl ? buildChildFormSections(globalEl, flatDoc) : [];
  } else {
    description = getDocumentation(particleEl);
  }

  return {
    elementName,
    description,
    isRequired: minOccurs >= 1,
    isRepeatable: maxOccurs === -1 || maxOccurs > 1,
    maxOccurs,
    childForms,
  };
}

/**
 * A global element like MeF's ReturnDataState is a pure "list of forms" wrapper —
 * its content model is nothing but xs:element ref= particles pointing at other
 * global forms (FormN11, SchCR, IRSW2, ...) — as opposed to a leaf form (e.g.
 * FormN11 itself), whose fields are always declared inline (name=, with an
 * actual data type), never ref=. Recursing only when EVERY particle in the
 * model group is ref-style stops exactly at real forms without exploding into
 * their field-level structure, and naturally supports arbitrary wrapper depth.
 */
function buildChildFormSections(globalEl, flatDoc) {
  const complexType = firstChild(globalEl, 'complexType');
  const topGroup = complexType ? findTopLevelModelGroup(getStructuralContainer(complexType)) : null;
  if (!topGroup || !isRefStyleModelGroup(topGroup)) return [];
  return walkSectionParticles(topGroup, flatDoc);
}

function isRefStyleModelGroup(groupEl) {
  let hasAny = false;
  for (const child of groupEl.children) {
    if (child.localName === 'element') {
      hasAny = true;
      if (!child.hasAttribute('ref')) return false;
    } else if (child.localName === 'sequence' || child.localName === 'all' || child.localName === 'choice') {
      if (!isRefStyleModelGroup(child)) return false;
    }
  }
  return hasAny;
}

function walkSectionParticles(groupEl, flatDoc) {
  const sections = [];
  for (const child of groupEl.children) {
    if (child.localName === 'element') {
      sections.push(buildSection(child, flatDoc));
    } else if (child.localName === 'sequence' || child.localName === 'all') {
      sections.push(...walkSectionParticles(child, flatDoc));
    } else if (child.localName === 'choice') {
      // A choice of whole packet sections isn't exercised by the sample schema;
      // fold every branch's sections in as siblings (best-effort).
      for (const branch of child.children) {
        if (branch.localName === 'sequence' || branch.localName === 'all') sections.push(...walkSectionParticles(branch, flatDoc));
        else if (branch.localName === 'element') sections.push(buildSection(branch, flatDoc));
      }
    }
    // xs:group ref at the packet root: not exercised by the sample schema, left unhandled for now.
  }
  return sections;
}

function collectAllFormNames(sections) {
  const names = [];
  const walk = (list) => {
    for (const s of list) {
      names.push(s.elementName);
      if (s.childForms.length) walk(s.childForms);
    }
  };
  walk(sections);
  return names;
}

/**
 * Ancestor wrapper elementNames (root-first) leading to the leaf section named
 * `formName`, e.g. ["ReturnDataState"] for "FormN11" — or null if not found.
 * Used by xmlReader/xmlWriter to locate/create the correct nesting parent for
 * a leaf form's XML content instead of always reading from/writing to the
 * packet root directly.
 */
export function findSectionAncestry(sections, formName, trail = []) {
  for (const s of sections) {
    if (s.elementName.toLowerCase() === formName.toLowerCase()) return trail;
    if (s.childForms?.length) {
      const found = findSectionAncestry(s.childForms, formName, [...trail, s.elementName]);
      if (found) return found;
    }
  }
  return null;
}

/**
 * @param {Document} flatDoc
 * @param {string} rootElementName
 * @returns {{packetName: string, sections: object[], allForms: string[]}}
 */
export function analyzePacket(flatDoc, rootElementName) {
  const rootEl = findGlobalElementInDoc(flatDoc, rootElementName);
  if (!rootEl) throw new Error(`Root element not found: ${rootElementName}`);
  const complexType = firstChild(rootEl, 'complexType');
  const topGroup = complexType ? findTopLevelModelGroup(getStructuralContainer(complexType)) : null;
  const sections = topGroup ? walkSectionParticles(topGroup, flatDoc) : [];
  return { packetName: rootElementName, sections, allForms: collectAllFormNames(sections) };
}
