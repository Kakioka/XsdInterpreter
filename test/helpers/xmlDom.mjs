// test/helpers/xmlDom.mjs — a minimal XML DOM for running js/core/ in Node.
//
// dev/IMPROVEMENT_BACKLOG.md B.2. Four core modules reach for an XML DOM —
// flattener.js and xmlReader.js (DOMParser), xmlWriter.js
// (document.implementation.createDocument + XMLSerializer), and parser.js
// (which consumes the flattener's Document) — so without one, the only
// headless-testable core modules are the ones that take hand-built
// SchemaElement literals, which is the least interesting half.
//
// B.2 suggests `linkedom` as a devDependency for this. This shim exists
// instead, for the same reason js/core/packager.js hand-rolls a ZIP writer
// rather than vendoring JSZip (CLAUDE.md, "No build system"): `node --test`
// then works on a clean checkout with no install step and no network, which is
// the whole point of making core/ testable. loadXmlDom() still prefers linkedom
// when it happens to be installed, so swapping to it later is a one-line
// decision, not a rewrite.
//
// It implements ONLY what js/core/ actually calls, and it is loud rather than
// lenient: an unsupported CSS selector throws instead of quietly returning
// null, because a shim that silently answers "no match" would turn a real
// regression into a passing test. The browser harnesses in dev/*.html remain
// the ground truth; these tests are the fast feedback loop.
//
// Deliberate browser-behavior matches, each of which core code depends on:
//   - A malformed document comes back as a <parsererror> root rather than a
//     throw, which is what flattener.js's assertNoParserError checks for.
//   - A CSS type selector matches on LOCAL name, ignoring namespace (CSS with
//     no default namespace declared matches any namespace) — that is why
//     xmlReader.js's `:scope > Name` queries work against namespaced packets.
//   - getElementsByTagName matches the QUALIFIED name, getElementsByTagNameNS
//     matches {namespace, localName}.
//   - Setting textContent to '' leaves the element childless (it does not add
//     an empty text node), so it serializes as <Foo/> — which is exactly how a
//     required-but-empty field comes out of xmlWriter.js.

const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

class XAttr {
  constructor(qualifiedName, value, namespaceURI) {
    const { prefix, localName } = splitName(qualifiedName);
    this.name = qualifiedName;
    this.nodeName = qualifiedName;
    this.prefix = prefix;
    this.localName = localName;
    this.namespaceURI = namespaceURI ?? null;
    this.value = value;
  }
}

class XNode {
  constructor(ownerDocument) {
    this.ownerDocument = ownerDocument ?? null;
    this.parentNode = null;
    this.childNodes = [];
  }

  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }

  get firstElementChild() {
    return this.children[0] ?? null;
  }

  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i !== -1) this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  /** Element and text descendants only — comments and PIs contribute nothing,
   *  same as the DOM spec. */
  get textContent() {
    let out = '';
    for (const child of this.childNodes) {
      if (child.nodeType === 3) out += child.data;
      else if (child.nodeType === 1) out += child.textContent;
    }
    return out;
  }

  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    // '' deliberately leaves the node childless — see the file header.
    if (value !== '' && value != null) this.appendChild(new XText(this.ownerDocument, String(value)));
  }

  // --- queries (shared by Element and Document) --------------------------

  getElementsByTagName(qualifiedName) {
    const wildcard = qualifiedName === '*';
    return collectDescendants(this, (el) => wildcard || el.nodeName === qualifiedName);
  }

  getElementsByTagNameNS(namespaceURI, localName) {
    const anyNs = namespaceURI === '*';
    const anyName = localName === '*';
    return collectDescendants(
      this,
      (el) => (anyNs || el.namespaceURI === (namespaceURI || null)) && (anyName || el.localName === localName)
    );
  }

  querySelector(selector) {
    return runSelector(this, selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    return runSelector(this, selector);
  }
}

class XText extends XNode {
  constructor(ownerDocument, data) {
    super(ownerDocument);
    this.nodeType = 3;
    this.nodeName = '#text';
    this.data = data;
  }

  cloneNode() {
    return new XText(this.ownerDocument, this.data);
  }
}

class XComment extends XNode {
  constructor(ownerDocument, data) {
    super(ownerDocument);
    this.nodeType = 8;
    this.nodeName = '#comment';
    this.data = data;
  }

  cloneNode() {
    return new XComment(this.ownerDocument, this.data);
  }
}

class XElement extends XNode {
  constructor(ownerDocument, namespaceURI, qualifiedName) {
    super(ownerDocument);
    this.nodeType = 1;
    const { prefix, localName } = splitName(qualifiedName);
    this.namespaceURI = namespaceURI ?? null;
    this.prefix = prefix;
    this.localName = localName;
    this.nodeName = qualifiedName;
    /** @type {XAttr[]} — an array satisfies both `.length` and iteration,
     *  which is all core/ asks of a NamedNodeMap. */
    this.attributes = [];
  }

  get tagName() {
    return this.nodeName;
  }

  getAttribute(qualifiedName) {
    const attr = this.attributes.find((a) => a.name === qualifiedName);
    return attr ? attr.value : null;
  }

  hasAttribute(qualifiedName) {
    return this.attributes.some((a) => a.name === qualifiedName);
  }

  setAttribute(qualifiedName, value) {
    const existing = this.attributes.find((a) => a.name === qualifiedName);
    if (existing) existing.value = String(value);
    else this.attributes.push(new XAttr(qualifiedName, String(value), null));
  }

  getAttributeNS(namespaceURI, localName) {
    const attr = this.attributes.find((a) => a.namespaceURI === namespaceURI && a.localName === localName);
    return attr ? attr.value : null;
  }

  cloneNode(deep) {
    const copy = new XElement(this.ownerDocument, this.namespaceURI, this.nodeName);
    copy.attributes = this.attributes.map((a) => new XAttr(a.name, a.value, a.namespaceURI));
    if (deep) for (const child of this.childNodes) copy.appendChild(child.cloneNode(true));
    return copy;
  }
}

class XDocument extends XNode {
  constructor() {
    super(null);
    this.nodeType = 9;
    this.nodeName = '#document';
    this.ownerDocument = this;
    this.implementation = new XDOMImplementation();
  }

  get documentElement() {
    return this.children[0] ?? null;
  }

  createElement(qualifiedName) {
    return new XElement(this, null, qualifiedName);
  }

  createElementNS(namespaceURI, qualifiedName) {
    return new XElement(this, namespaceURI, qualifiedName);
  }

  createTextNode(data) {
    return new XText(this, data);
  }

  createComment(data) {
    return new XComment(this, data);
  }

  importNode(node, deep) {
    const copy = node.cloneNode(deep);
    reparentTo(copy, this);
    return copy;
  }

  cloneNode(deep) {
    const copy = new XDocument();
    if (deep) for (const child of this.childNodes) copy.appendChild(child.cloneNode(true));
    return copy;
  }
}

class XDOMImplementation {
  /** qualifiedName '' → a document with no documentElement yet, which is what
   *  xmlWriter.js's buildPacketXml relies on. */
  createDocument(namespaceURI, qualifiedName, _doctype = null) {
    const doc = new XDocument();
    if (qualifiedName) doc.appendChild(new XElement(doc, namespaceURI ?? null, qualifiedName));
    return doc;
  }
}

function reparentTo(node, doc) {
  node.ownerDocument = doc;
  for (const child of node.childNodes) reparentTo(child, doc);
}

function splitName(qualifiedName) {
  const i = qualifiedName.indexOf(':');
  return i === -1
    ? { prefix: null, localName: qualifiedName }
    : { prefix: qualifiedName.slice(0, i), localName: qualifiedName.slice(i + 1) };
}

function collectDescendants(root, predicate) {
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      if (predicate(child)) out.push(child);
      walk(child);
    }
  };
  walk(root);
  // Static, not live. Every core/ call site either wraps the result in
  // Array.from() before mutating (flattener.js) or only reads it, so a static
  // array is the safe choice; a live list would be the riskier shim.
  return out;
}

// ---------------------------------------------------------------------------
// Selectors — only the forms js/core/ and the tests actually use
// ---------------------------------------------------------------------------

const SELECTOR_PATTERN = /^([A-Za-z_][\w.-]*|\*)(?:\[([\w.:-]+)\s*=\s*"([^"]*)"\])?$/;

function parseSelector(selector) {
  const trimmed = String(selector).trim();
  const scoped = /^:scope\s*>\s*(.+)$/.exec(trimmed);
  const simple = (scoped ? scoped[1] : trimmed).trim();
  const m = SELECTOR_PATTERN.exec(simple);
  if (!m) {
    throw new Error(
      `xmlDom test shim: unsupported selector ${JSON.stringify(selector)}. ` +
        'Supported forms: "Name", "Name[attr=\\"value\\"]", ":scope > Name". ' +
        'Add support here rather than working around it in the module under test.'
    );
  }
  return { directChild: !!scoped, name: m[1], attrName: m[2], attrValue: m[3] };
}

function runSelector(root, selector) {
  const { directChild, name, attrName, attrValue } = parseSelector(selector);
  // CSS type selectors match the LOCAL name here: with no default namespace
  // declared for the selector, a type selector matches that local name in any
  // namespace — see the file header.
  const matches = (el) =>
    (name === '*' || el.localName === name) && (attrName === undefined || el.getAttribute(attrName) === attrValue);
  return directChild ? root.children.filter(matches) : collectDescendants(root, matches);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const NAMED_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    // An undeclared entity is left verbatim rather than treated as a parse
    // error; no fixture uses one, and guessing is worse than passing it through.
    return NAMED_ENTITIES[body] ?? whole;
  });
}

class XmlParseError extends Error {}

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[-A-Za-z0-9_:.]/;

function parseXml(text) {
  const doc = new XDocument();
  let i = 0;

  const fail = (message) => {
    throw new XmlParseError(`${message} at offset ${i}`);
  };
  const peek = (s) => text.startsWith(s, i);

  const readName = () => {
    const start = i;
    if (i >= text.length || !NAME_START.test(text[i])) fail('expected a name');
    while (i < text.length && NAME_CHAR.test(text[i])) i++;
    return text.slice(start, i);
  };
  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };

  /** [prefix -> namespaceURI] scopes, innermost last; '' is the default namespace. */
  const nsScopes = [{ xml: XML_NS, xmlns: XMLNS_NS }];
  const lookupNs = (prefix) => {
    for (let s = nsScopes.length - 1; s >= 0; s--) {
      if (Object.prototype.hasOwnProperty.call(nsScopes[s], prefix)) return nsScopes[s][prefix];
    }
    return null;
  };

  const skipMisc = () => {
    for (;;) {
      skipSpace();
      if (peek('<?')) {
        const end = text.indexOf('?>', i);
        if (end === -1) fail('unterminated processing instruction');
        i = end + 2;
      } else if (peek('<!--')) {
        const end = text.indexOf('-->', i);
        if (end === -1) fail('unterminated comment');
        i = end + 3;
      } else if (peek('<!DOCTYPE')) {
        // Good enough for a well-formed external-id doctype; an internal
        // subset containing '>' would need real bracket matching, and no
        // schema or packet fixture has one.
        const end = text.indexOf('>', i);
        if (end === -1) fail('unterminated doctype');
        i = end + 1;
      } else {
        return;
      }
    }
  };

  function parseElement() {
    if (!peek('<')) fail('expected an element');
    i++; // '<'
    const qualifiedName = readName();

    const attrs = [];
    const declaredNs = {};
    for (;;) {
      skipSpace();
      if (peek('/>') || peek('>')) break;
      const attrName = readName();
      skipSpace();
      if (text[i] !== '=') fail(`expected '=' after attribute ${attrName}`);
      i++;
      skipSpace();
      const quote = text[i];
      if (quote !== '"' && quote !== "'") fail(`expected a quoted value for attribute ${attrName}`);
      i++;
      const end = text.indexOf(quote, i);
      if (end === -1) fail(`unterminated value for attribute ${attrName}`);
      const rawValue = text.slice(i, end);
      i = end + 1;
      const value = decodeEntities(rawValue);
      if (attrName === 'xmlns') declaredNs[''] = value || null;
      else if (attrName.startsWith('xmlns:')) declaredNs[attrName.slice(6)] = value || null;
      attrs.push({ name: attrName, value });
    }

    nsScopes.push(declaredNs);
    const { prefix, localName } = splitName(qualifiedName);
    const elementNs = prefix ? lookupNs(prefix) : lookupNs('');
    const el = new XElement(doc, elementNs, qualifiedName);
    for (const attr of attrs) {
      const split = splitName(attr.name);
      // Unprefixed attributes are in no namespace, never the default one.
      const attrNs = attr.name === 'xmlns' ? XMLNS_NS : split.prefix ? lookupNs(split.prefix) : null;
      el.attributes.push(new XAttr(attr.name, attr.value, attrNs));
    }

    if (peek('/>')) {
      i += 2;
      nsScopes.pop();
      return el;
    }
    i++; // '>'

    for (;;) {
      if (i >= text.length) fail(`unclosed element <${qualifiedName}>`);
      if (peek('</')) {
        i += 2;
        const closing = readName();
        if (closing !== qualifiedName) fail(`mismatched closing tag </${closing}>, expected </${qualifiedName}>`);
        skipSpace();
        if (text[i] !== '>') fail('expected ">" to close an end tag');
        i++;
        nsScopes.pop();
        return el;
      }
      if (peek('<!--')) {
        const end = text.indexOf('-->', i);
        if (end === -1) fail('unterminated comment');
        el.appendChild(new XComment(doc, text.slice(i + 4, end)));
        i = end + 3;
        continue;
      }
      if (peek('<![CDATA[')) {
        const end = text.indexOf(']]>', i);
        if (end === -1) fail('unterminated CDATA section');
        el.appendChild(new XText(doc, text.slice(i + 9, end)));
        i = end + 3;
        continue;
      }
      if (peek('<?')) {
        const end = text.indexOf('?>', i);
        if (end === -1) fail('unterminated processing instruction');
        i = end + 2;
        continue;
      }
      if (peek('<')) {
        el.appendChild(parseElement());
        continue;
      }
      const next = text.indexOf('<', i);
      const raw = text.slice(i, next === -1 ? text.length : next);
      i = next === -1 ? text.length : next;
      // Whitespace-only text nodes are kept, same as a real XML parser —
      // parser.js's `.children` walks skip them, textContent includes them.
      if (raw.length > 0) el.appendChild(new XText(doc, decodeEntities(raw)));
    }
  }

  skipMisc();
  if (i >= text.length) fail('no root element');
  doc.appendChild(parseElement());
  skipMisc();
  return doc;
}

class DOMParser {
  parseFromString(markup, _mimeType) {
    try {
      return parseXml(String(markup));
    } catch (err) {
      // Browser behavior: a malformed document still comes back as a Document,
      // with a <parsererror> element in it. flattener.js and xmlReader.js both
      // detect failure that way rather than by catching.
      const doc = new XDocument();
      const errorEl = new XElement(doc, 'http://www.mozilla.org/newlayout/xml/parsererror.xml', 'parsererror');
      errorEl.appendChild(new XText(doc, err instanceof Error ? err.message : String(err)));
      doc.appendChild(errorEl);
      return doc;
    }
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return escapeText(s).replace(/"/g, '&quot;');
}

function serializeNode(node, inheritedDefaultNs, inScopePrefixes) {
  if (node.nodeType === 3) return escapeText(node.data);
  if (node.nodeType === 8) return `<!--${node.data}-->`;
  if (node.nodeType === 9) return node.documentElement ? serializeNode(node.documentElement, null, {}) : '';
  if (node.nodeType !== 1) return '';

  const declarations = [];
  let defaultNs = inheritedDefaultNs;
  const prefixes = { ...inScopePrefixes };

  if (!node.prefix) {
    if ((node.namespaceURI ?? null) !== (inheritedDefaultNs ?? null)) {
      declarations.push(` xmlns="${escapeAttr(node.namespaceURI ?? '')}"`);
      defaultNs = node.namespaceURI ?? null;
    }
  } else if (node.namespaceURI && prefixes[node.prefix] !== node.namespaceURI) {
    declarations.push(` xmlns:${node.prefix}="${escapeAttr(node.namespaceURI)}"`);
    prefixes[node.prefix] = node.namespaceURI;
  }

  let attrText = '';
  for (const attr of node.attributes) {
    if (attr.name === 'xmlns' || attr.name.startsWith('xmlns:')) {
      // An explicit declaration already present on the element wins over the
      // derived one above, so don't emit it twice.
      const derived = attr.name === 'xmlns' ? ` xmlns="${escapeAttr(attr.value)}"` : null;
      if (derived && declarations.length && declarations[0].startsWith(' xmlns=')) declarations.shift();
      if (attr.name === 'xmlns') defaultNs = attr.value || null;
      else prefixes[attr.name.slice(6)] = attr.value;
    }
    attrText += ` ${attr.name}="${escapeAttr(attr.value)}"`;
  }

  const open = `<${node.nodeName}${declarations.join('')}${attrText}`;
  if (node.childNodes.length === 0) return `${open}/>`;
  const inner = node.childNodes.map((child) => serializeNode(child, defaultNs, prefixes)).join('');
  return `${open}>${inner}</${node.nodeName}>`;
}

class XMLSerializer {
  serializeToString(node) {
    return serializeNode(node, null, {});
  }
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

/**
 * Installs the XML DOM globals js/core/ expects, preferring `linkedom` if it
 * happens to be installed (B.2's own suggestion) and falling back to the shim
 * above otherwise. Idempotent; safe to call from every test file.
 * @returns {Promise<'linkedom'|'shim'>} which implementation is in place
 */
export async function loadXmlDom() {
  if (globalThis.__xmlDomSource) return globalThis.__xmlDomSource;

  try {
    const linkedom = await import('linkedom');
    if (linkedom?.DOMParser && linkedom?.XMLSerializer) {
      globalThis.DOMParser = linkedom.DOMParser;
      globalThis.XMLSerializer = linkedom.XMLSerializer;
      if (linkedom.Document) globalThis.Document = linkedom.Document;
      globalThis.document = new linkedom.DOMParser().parseFromString('<root/>', 'text/xml');
      globalThis.__xmlDomSource = 'linkedom';
      return 'linkedom';
    }
  } catch {
    // Not installed — expected, and the whole reason the shim exists.
  }

  globalThis.DOMParser = DOMParser;
  globalThis.XMLSerializer = XMLSerializer;
  globalThis.Document = XDocument;
  globalThis.Element = XElement;
  // xmlWriter.js reaches for `document.implementation.createDocument`; it never
  // touches anything else on `document`.
  globalThis.document = new XDocument();
  globalThis.__xmlDomSource = 'shim';
  return 'shim';
}
