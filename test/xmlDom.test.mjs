// test/xmlDom.test.mjs — self-test for the XML DOM shim in ./helpers/xmlDom.mjs.
//
// The shim is test infrastructure, so it gets its own tests: a silently wrong
// shim would make every other suite report confidently about behavior the
// browser does not actually have. Each assertion below pins one browser
// behavior that js/core/ depends on — the list in the shim's file header.
//
// Skipped automatically when linkedom is installed and takes precedence, since
// these assertions are about THIS implementation.

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadXmlDom } from './helpers/xmlDom.mjs';

const source = await loadXmlDom();
const shimOnly = { skip: source !== 'shim' ? `an XML DOM is being provided by ${source}` : false };

const XS_NS = 'http://www.w3.org/2001/XMLSchema';

test('parses elements, attributes, text and nesting', () => {
  const doc = new DOMParser().parseFromString(
    '<?xml version="1.0"?><root a="1" b="two"><child>text</child><empty/></root>',
    'application/xml'
  );
  assert.equal(doc.documentElement.nodeName, 'root');
  assert.equal(doc.documentElement.getAttribute('a'), '1');
  assert.equal(doc.documentElement.getAttribute('b'), 'two');
  assert.equal(doc.documentElement.getAttribute('missing'), null);
  assert.equal(doc.documentElement.hasAttribute('a'), true);
  assert.equal(doc.documentElement.hasAttribute('nope'), false);
  assert.equal(doc.documentElement.children.length, 2);
  assert.equal(doc.documentElement.children[0].textContent, 'text');
  assert.equal(doc.documentElement.children[1].children.length, 0);
});

test('resolves namespace prefixes so getElementsByTagNameNS works on a prefixed schema', () => {
  const doc = new DOMParser().parseFromString(
    `<xs:schema xmlns:xs="${XS_NS}" targetNamespace="urn:t">
       <xs:include schemaLocation="Other.xsd"/>
       <xs:complexType name="AddressType"><xs:sequence/></xs:complexType>
     </xs:schema>`,
    'application/xml'
  );

  assert.equal(doc.documentElement.localName, 'schema');
  assert.equal(doc.documentElement.nodeName, 'xs:schema');
  assert.equal(doc.documentElement.namespaceURI, XS_NS);
  assert.equal(doc.documentElement.getAttribute('targetNamespace'), 'urn:t');

  assert.equal(doc.getElementsByTagNameNS(XS_NS, 'include').length, 1);
  assert.equal(doc.getElementsByTagNameNS(XS_NS, 'complexType').length, 1);
  assert.equal(doc.getElementsByTagNameNS('urn:wrong', 'include').length, 0);
  // getElementsByTagName matches the QUALIFIED name, unlike the NS variant.
  assert.equal(doc.getElementsByTagName('xs:include').length, 1);
  assert.equal(doc.getElementsByTagName('include').length, 0);
});

test('a CSS type selector matches on local name, ignoring namespace', () => {
  const doc = new DOMParser().parseFromString(
    `<xs:schema xmlns:xs="${XS_NS}"><xs:complexType name="AddressType"/><xs:complexType name="Other"/></xs:schema>`,
    'application/xml'
  );
  // This is why xmlReader.js's `:scope > Name` queries work on namespaced packets.
  assert.ok(doc.querySelector('complexType[name="AddressType"]'));
  assert.equal(doc.querySelector('complexType[name="Nope"]'), null);
  assert.equal(doc.querySelectorAll('complexType').length, 2);
});

test(':scope > Name matches only direct children', () => {
  const doc = new DOMParser().parseFromString('<root><a><a>inner</a></a><b/></root>', 'application/xml');
  const root = doc.documentElement;
  assert.equal(root.querySelectorAll(':scope > a').length, 1);
  assert.equal(root.querySelectorAll('a').length, 2, 'the un-scoped form is a descendant search');
  assert.equal(root.querySelector(':scope > a').textContent, 'inner');
  assert.equal(root.querySelector(':scope > nope'), null);
});

test('an unsupported selector throws rather than silently returning nothing', shimOnly, () => {
  const doc = new DOMParser().parseFromString('<root><a/></root>', 'application/xml');
  assert.throws(() => doc.querySelector('a > b'), /unsupported selector/);
  assert.throws(() => doc.querySelector('.some-class'), /unsupported selector/);
});

test('malformed XML yields a <parsererror> document, not a throw', () => {
  const doc = new DOMParser().parseFromString('<root><unclosed></root>', 'application/xml');
  assert.equal(doc.getElementsByTagName('parsererror').length, 1);
  assert.match(doc.getElementsByTagName('parsererror')[0].textContent, /\S/);
});

test('entity references and CDATA decode into text', () => {
  const doc = new DOMParser().parseFromString(
    '<root><a>a &amp; b &lt;c&gt; &#65; &#x42;</a><b><![CDATA[raw < & >]]></b></root>',
    'application/xml'
  );
  assert.equal(doc.querySelector('a').textContent, 'a & b <c> A B');
  assert.equal(doc.querySelector('b').textContent, 'raw < & >');
});

test('comments are preserved as nodes but excluded from children and textContent', () => {
  const doc = new DOMParser().parseFromString('<root><!-- note -->text<a/></root>', 'application/xml');
  assert.equal(doc.documentElement.children.length, 1);
  assert.equal(doc.documentElement.textContent, 'text');
});

test('whitespace text nodes are kept, so .children walks skip them and textContent does not', () => {
  const doc = new DOMParser().parseFromString('<root>\n  <a>x</a>\n</root>', 'application/xml');
  assert.equal(doc.documentElement.children.length, 1);
  assert.match(doc.documentElement.textContent, /^\s+x\s+$/);
});

test('appendChild moves a node, remove() detaches it', () => {
  const doc = new DOMParser().parseFromString('<root><a><moved/></a><b/></root>', 'application/xml');
  const moved = doc.querySelector('moved');
  const b = doc.querySelector('b');

  b.appendChild(moved);
  assert.equal(doc.querySelector('a').children.length, 0, 'appendChild detaches from the old parent');
  assert.equal(b.children.length, 1);

  moved.remove();
  assert.equal(b.children.length, 0);
  assert.equal(doc.querySelector('moved'), null);
});

test('cloneNode and importNode deep-copy without aliasing', () => {
  const source = new DOMParser().parseFromString('<root><a x="1"><b>text</b></a></root>', 'application/xml');
  const target = new DOMParser().parseFromString('<other/>', 'application/xml');

  const imported = target.importNode(source.querySelector('a'), true);
  target.documentElement.appendChild(imported);

  assert.equal(target.querySelector('b').textContent, 'text');
  assert.equal(target.querySelector('a').getAttribute('x'), '1');

  imported.setAttribute('x', '2');
  assert.equal(source.querySelector('a').getAttribute('x'), '1', 'the source must be untouched');

  const shallow = source.querySelector('a').cloneNode(false);
  assert.equal(shallow.children.length, 0);
});

test('setting textContent to "" leaves the element childless, so it serializes as <Foo/>', () => {
  // xmlWriter.js emits a required-but-empty field by creating an element and
  // never setting textContent at all; this pins the related DOM rule.
  const doc = document.implementation.createDocument(null, 'Root', null);
  const el = doc.createElement('Foo');
  el.textContent = 'x';
  assert.equal(el.childNodes.length, 1);
  el.textContent = '';
  assert.equal(el.childNodes.length, 0);
  doc.documentElement.appendChild(el);
  assert.equal(new XMLSerializer().serializeToString(doc.documentElement), '<Root><Foo/></Root>');
});

test('implementation.createDocument with qualifiedName "" has no documentElement yet', () => {
  const doc = document.implementation.createDocument(null, '', null);
  assert.equal(doc.documentElement, null);
  const root = doc.createElement('Root');
  doc.appendChild(root);
  assert.equal(doc.documentElement, root);
});

test('serialization escapes text and attribute values', () => {
  const doc = document.implementation.createDocument(null, 'Root', null);
  const el = doc.createElement('Field');
  el.textContent = 'a & b < c > d';
  el.setAttribute('note', 'he said "hi" & left');
  doc.documentElement.appendChild(el);

  const xml = new XMLSerializer().serializeToString(doc.documentElement);
  assert.ok(xml.includes('a &amp; b &lt; c &gt; d'));
  assert.ok(xml.includes('note="he said &quot;hi&quot; &amp; left"'));
  // And it round-trips back to the original values.
  const reparsed = new DOMParser().parseFromString(xml, 'application/xml');
  assert.equal(reparsed.querySelector('Field').textContent, 'a & b < c > d');
  assert.equal(reparsed.querySelector('Field').getAttribute('note'), 'he said "hi" & left');
});

test('a default namespace is declared once on the outermost element in it', () => {
  const doc = document.implementation.createDocument('urn:t', '', null);
  const root = doc.createElementNS('urn:t', 'Root');
  const child = doc.createElementNS('urn:t', 'Child');
  child.textContent = 'v';
  root.appendChild(child);
  doc.appendChild(root);

  const xml = new XMLSerializer().serializeToString(root);
  assert.equal(xml, '<Root xmlns="urn:t"><Child>v</Child></Root>');

  const reparsed = new DOMParser().parseFromString(xml, 'application/xml');
  assert.equal(reparsed.documentElement.namespaceURI, 'urn:t');
  assert.equal(reparsed.querySelector('Child').namespaceURI, 'urn:t');
});

test('attributes expose .length and iterate with name/value', () => {
  const doc = new DOMParser().parseFromString('<root a="1" b="2"/>', 'application/xml');
  const el = doc.documentElement;
  assert.equal(el.attributes.length, 2);
  assert.deepEqual([...el.attributes].map((a) => [a.name, a.value]), [['a', '1'], ['b', '2']]);
  el.setAttribute('a', 'changed');
  assert.equal(el.attributes.length, 2, 'setAttribute on an existing name must not duplicate it');
  assert.equal(el.getAttribute('a'), 'changed');
});

test('getElementsByTagNameNS returns a static list safe to mutate while iterating', shimOnly, () => {
  const doc = new DOMParser().parseFromString(
    `<xs:schema xmlns:xs="${XS_NS}"><xs:include/><xs:include/></xs:schema>`,
    'application/xml'
  );
  const includes = doc.getElementsByTagNameNS(XS_NS, 'include');
  assert.equal(includes.length, 2);
  for (const el of includes) el.remove();
  assert.equal(includes.length, 2, 'the captured list must not shrink under us');
  assert.equal(doc.getElementsByTagNameNS(XS_NS, 'include').length, 0);
});
