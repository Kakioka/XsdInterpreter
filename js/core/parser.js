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

export function isTransparent(el) {
  return el.isGeneratedWrapper || el.kind === 'RadioGroup' || el.kind === 'SequenceContainer';
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

function getDocumentation(el) {
  const annotation = firstChild(el, 'annotation');
  if (!annotation) return '';
  const doc = firstChild(annotation, 'documentation');
  if (!doc) return '';
  return (doc.textContent || '').trim().replace(/\s+/g, ' ');
}

/** "IndividualFirstName" → "Individual First Name". Not spec-mandated (§2 only says
 *  "human-readable label") — a plausible camelCase splitter, easy to swap later. */
export function humanizeLabel(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
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
 * Full xs:extension inheritance chains are flagged as unverified/TODO pending a
 * real schema — see web-implementation-spec.md §25.
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

function assignLeafKind(xsdDataType, enumerationValues) {
  const local = stripPrefix(xsdDataType || 'xs:string');
  if (local === 'boolean') return 'Checkbox';
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
    this._build(flatDoc);
  }

  _build(doc) {
    for (const child of doc.documentElement.children) {
      const name = child.getAttribute('name');
      if (!name) continue;
      if (child.localName === 'complexType') this.complexTypes.set(name.toLowerCase(), child);
      else if (child.localName === 'simpleType') this.simpleTypes.set(name.toLowerCase(), child);
      else if (child.localName === 'group') this.groups.set(name.toLowerCase(), child);
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
    const typeAttr = defEl.getAttribute('type');
    const inlineSimpleType = firstChild(defEl, 'simpleType');
    const inlineComplexType = firstChild(defEl, 'complexType');

    const base = {
      elementName,
      documentation,
      lineNumber: '', // display-only; no source-position info survives a DOMParser parse — left blank until/unless a real need for it shows up
      isRequired: occurs.minOccurs >= 1,
      minOccurs: occurs.minOccurs,
      maxOccurs: occurs.maxOccurs,
      elementPath,
    };

    if (inlineComplexType) return this._finishComplexType(base, inlineComplexType);

    if (typeAttr) {
      const namedComplexType = this.types.getComplexType(typeAttr);
      if (namedComplexType) {
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
    const container = getStructuralContainer(complexTypeEl);
    const attributes = this._collectAttributes(container, base.elementPath);
    const topGroup = findTopLevelModelGroup(container);
    const modelChildren = topGroup ? this._parseModelGroup(topGroup, base.elementPath) : [];
    return createSchemaElement({
      ...base,
      kind: 'GroupContainer',
      children: [...attributes, ...modelChildren], // attributes prepended — see §4
    });
  }

  _collectAttributes(containerEl, ownerPath) {
    return children(containerEl, 'attribute').map((attrEl) => {
      const name = attrEl.getAttribute('name');
      const use = attrEl.getAttribute('use') || 'optional';
      const typeAttr = attrEl.getAttribute('type');
      const inlineSimpleType = firstChild(attrEl, 'simpleType');
      const attrBase = {
        elementName: name,
        documentation: getDocumentation(attrEl),
        lineNumber: '',
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

  _parseChoiceGroup(choiceEl, parentPath) {
    const parentName = lastSegment(parentPath);
    const choiceName = `${parentName}Choice`;
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
    const result = [];
    for (const child of groupEl.children) {
      if (child.localName === 'element') result.push(this._parseParticleElement(child, parentPath));
      else if (child.localName === 'group') result.push(...this._parseGroupRef(child, parentPath));
      else if (child.localName === 'choice') result.push(this._parseChoiceGroup(child, parentPath));
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
 * @param {Document} flatDoc
 * @returns {string[]}
 */
export function findRootElementCandidates(flatDoc) {
  const globalNames = new Set();
  for (const child of flatDoc.documentElement.children) {
    if (child.localName === 'element' && child.hasAttribute('name')) globalNames.add(child.getAttribute('name'));
  }
  const referenced = new Set();
  for (const el of flatDoc.getElementsByTagNameNS(XS_NS, 'element')) {
    const ref = el.getAttribute('ref');
    if (ref) referenced.add(stripPrefix(ref));
  }
  return [...globalNames].filter((n) => !referenced.has(n));
}

function buildSection(particleEl, flatDoc) {
  const ref = particleEl.getAttribute('ref');
  const elementName = ref ? stripPrefix(ref) : particleEl.getAttribute('name');
  const { minOccurs, maxOccurs: maxOccursRaw } = parseOccurs(particleEl);
  const maxOccurs = maxOccursRaw == null ? -1 : maxOccursRaw;

  let description = '';
  if (ref) {
    const globalEl = findGlobalElementInDoc(flatDoc, elementName);
    description = globalEl ? getDocumentation(globalEl) : '';
  } else {
    description = getDocumentation(particleEl);
  }

  return {
    elementName,
    description,
    isRequired: minOccurs >= 1,
    isRepeatable: maxOccurs === -1 || maxOccurs > 1,
    maxOccurs,
    childForms: [], // not populated for the flat sample packet (every section is a leaf form)
  };
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
