// js/core/instanceIdentity.js — where a repeatable form's instance id comes from.
//
// See web-implementation-spec.md §4 (Instance-id source), §10, §11.
// dev/PARITY_GAP_ANALYSIS.md 1.5, dev/IMPLEMENTATION_ORDER.md Phase 3.
//
// WHICH attribute carries identity is chosen by parser.js (it is a question
// about the schema's shape): selectInstanceIdSource, driven by a per-schema
// setting. This module is the other half — given that choice, turn an XML
// element or a newly added form into an id:
//
// - A value in the identity attribute is the id.
// - Otherwise an id is generated. When there is an attribute to hold it, the
//   generated id has to be a legal value for that attribute, because the
//   writer backfills it into the XML. (A UUID, the old answer, is neither a
//   legal xs:ID when it starts with a digit, nor an integer, nor within a
//   typical 30-character id limit.)
// - A form with no identity attribute gets the same generated ids, and they
//   never reach the XML. js/core/settingsStore.js remembers which ids a saved
//   document was written with, so loading it again restores them.

import { isAttribute } from './parser.js';
import { validateFieldValue } from './coloringService.js';

/** @returns {object|null} the attribute SchemaElement that carries `formElement`'s identity */
export function findInstanceIdAttribute(formElement) {
  return formElement?.children.find((c) => isAttribute(c) && c.isInstanceIdSource) ?? null;
}

const NUMERIC_KINDS = new Set(['NumericInput', 'DecimalInput']);

/** Can `id` legally be written into `idAttr`? */
export function canHoldInstanceId(idAttr, id) {
  if (idAttr.kind === 'Checkbox' || idAttr.kind === 'DatePicker') return false;
  if (idAttr.kind === 'Dropdown' && !idAttr.enumerationValues.some((e) => e.value === id)) return false;
  if (NUMERIC_KINDS.has(idAttr.kind) && !/^[+-]?\d+$/.test(id)) return false;
  // xs:ID is an NCName: no leading digit, no colon or spaces.
  if (idAttr.xsdDataType === 'xs:ID' && !/^[\p{L}_][\p{L}\p{N}_.-]*$/u.test(id)) return false;
  try {
    return validateFieldValue(id, idAttr).valid;
  } catch {
    return false; // an XSD pattern that isn't a JS regex: can't vouch for the value
  }
}

/**
 * The first free id for a new instance: "IRSW2-1", "IRSW2-2", … or a bare
 * number where the attribute can't hold that. Deterministic, so reading the
 * same document twice produces the same ids.
 *
 * @param {string} formName
 * @param {object|null} idAttr from findInstanceIdAttribute
 * @param {Iterable<string>} taken ids already in use by this form
 */
export function generateInstanceId(formName, idAttr, taken = []) {
  const used = new Set([...taken].map((id) => String(id).toLowerCase()));
  const templates = [(n) => `${formName}-${n}`, (n) => String(n), (n) => `ID${n}`];
  const usable = idAttr ? templates.find((t) => canHoldInstanceId(idAttr, t(1))) : null;
  // Nothing fits the attribute (a fixed format we can't guess): the id still
  // identifies the instance in the editor, and the writer won't backfill it.
  const make = usable ?? templates[0];
  let n = 1;
  while (used.has(make(n).toLowerCase())) n++;
  return make(n);
}

/**
 * One id per element of a repeatable form, in document order, all distinct.
 * Two elements sharing an identity value is invalid data, but collapsing them
 * into one form instance would silently drop a whole form on load; the later
 * ones get a generated id instead and keep their attribute value as read.
 *
 * @param {Element[]} elements
 * @param {string} formName
 * @param {object|null} idAttr
 * @param {string[]} [remembered] ids this exact document was saved with
 */
export function assignInstanceIds(elements, formName, idAttr, remembered = []) {
  // The form's own name means "non-repeatable" in FormInstanceKey, so it can
  // never be an instance's id even if the document uses it as one.
  const used = new Set([formName.toLowerCase()]);
  const ids = new Array(elements.length).fill(null);
  const claim = (i, id) => {
    if (!id || used.has(id.toLowerCase())) return;
    used.add(id.toLowerCase());
    ids[i] = id;
  };
  if (idAttr) elements.forEach((el, i) => claim(i, (el.getAttribute(idAttr.elementName) ?? '').trim()));
  if (remembered.length === elements.length) {
    elements.forEach((el, i) => {
      if (ids[i] === null) claim(i, remembered[i]);
    });
  }
  elements.forEach((el, i) => {
    if (ids[i] === null) claim(i, generateInstanceId(formName, idAttr, used));
  });
  return ids;
}
