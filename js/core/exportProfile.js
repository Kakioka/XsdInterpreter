// js/core/exportProfile.js — interprets an export profile: a declarative
// description of a package's metadata fields, file groups and archive layout.
//
// See web-implementation-spec.md §19. dev/PARITY_GAP_ANALYSIS.md 1.4.
//
// Nothing in this module or in packager.js knows about any particular filing
// program; that all lives in export-profiles/*.profile.json (format
// documented in export-profiles/README.md). Pure logic, no DOM.

export const PROFILE_FORMAT_VERSION = 1;

/** Template names the app supplies, alongside every field id. */
const RESERVED_IDS = new Set(['packetName', 'fileName']);
const TOKEN = /\{([^{}]*)\}/g;
const SIMPLE_ID = /^[A-Za-z_][\w-]*$/;
const NCNAME = /^[\p{L}_][\p{L}\p{N}_.-]*$/u;

export function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function asArray(value) {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function fullMatch(pattern, value) {
  return new RegExp(`^(?:${pattern})$`).test(value);
}

// ---------------------------------------------------------------------------
// Profile validation — profiles can be user-supplied files
// ---------------------------------------------------------------------------

/** @returns {string[]} problems with the profile itself; empty when usable */
export function validateProfile(profile) {
  if (!isObject(profile)) return ['The file is not an export profile (expected a JSON object).'];
  const errors = [];
  if (profile.formatVersion !== PROFILE_FORMAT_VERSION) errors.push(`formatVersion must be ${PROFILE_FORMAT_VERSION}.`);
  for (const key of ['id', 'name', 'archiveName']) {
    if (typeof profile[key] !== 'string' || isBlank(profile[key])) errors.push(`"${key}" is required.`);
  }
  for (const key of ['fields', 'fileGroups', 'entries']) {
    if (profile[key] !== undefined && !Array.isArray(profile[key])) errors.push(`"${key}" must be a list.`);
    else if ((profile[key] ?? []).some((item) => !isObject(item))) errors.push(`Every item in "${key}" must be an object.`);
  }
  if (profile.limits !== undefined && !isObject(profile.limits)) errors.push('"limits" must be an object.');
  if (errors.length > 0) return errors; // the rest assumes this much

  const fieldIds = new Set();
  const groupIds = new Set();

  const checkId = (id, owner) => {
    if (typeof id !== 'string' || !SIMPLE_ID.test(id)) errors.push(`${owner}: id must be a simple name.`);
    else if (fieldIds.has(id) || groupIds.has(id) || RESERVED_IDS.has(id)) errors.push(`${owner}: id is already in use.`);
  };
  const checkLabel = (label, owner) => {
    if (typeof label !== 'string' || isBlank(label)) errors.push(`${owner}: label is required.`);
  };
  const checkWhen = (when, owner) => {
    for (const cond of asArray(when)) {
      // Fields may only depend on ones declared before them, which rules out
      // cycles and lets activeValues resolve everything in one pass.
      if (!isObject(cond) || !fieldIds.has(cond.field)) errors.push(`${owner}: condition refers to unknown or later field "${cond?.field}".`);
      else if (!('equals' in cond) && !Array.isArray(cond.in) && cond.notBlank !== true) errors.push(`${owner}: condition needs equals, in or notBlank.`);
    }
  };
  const checkTemplate = (template, owner, extra) => {
    for (const [, name] of String(template).matchAll(TOKEN)) {
      if (!fieldIds.has(name) && name !== 'packetName' && name !== extra) errors.push(`${owner}: unknown placeholder {${name}}.`);
    }
  };
  const checkNode = (node, owner) => {
    if (!isObject(node) || typeof node.name !== 'string' || !NCNAME.test(node.name)) {
      errors.push(`${owner}: every document element needs a valid name.`);
      return;
    }
    checkWhen(node.when, owner);
    checkTemplate(node.value ?? '', owner);
    if (node.attributes !== undefined && !isObject(node.attributes)) errors.push(`${owner}: attributes must be an object.`);
    else {
      for (const [name, value] of Object.entries(node.attributes ?? {})) {
        if (!NCNAME.test(name)) errors.push(`${owner}: invalid attribute name "${name}".`);
        checkTemplate(value, owner);
      }
    }
    if (node.children !== undefined && !Array.isArray(node.children)) errors.push(`${owner}: children must be a list.`);
    else for (const child of node.children ?? []) checkNode(child, owner);
  };

  for (const field of profile.fields ?? []) {
    const owner = `Field "${field.id}"`;
    checkId(field.id, owner);
    checkLabel(field.label, owner);
    if (field.type !== undefined && field.type !== 'text' && field.type !== 'select') errors.push(`${owner}: type must be text or select.`);
    const optionsOk = Array.isArray(field.options) && field.options.length > 0 && field.options.every((o) => isObject(o) && typeof o.value === 'string');
    if (field.type === 'select' && !optionsOk) errors.push(`${owner}: a select needs options, each with a value.`);
    // Strict, so a typo like "false" can't quietly mean "store it".
    if (field.remember !== undefined && typeof field.remember !== 'boolean') errors.push(`${owner}: remember must be true or false.`);
    if (field.maxLength !== undefined && !isPositiveInteger(field.maxLength)) errors.push(`${owner}: maxLength must be a positive whole number.`);
    if (field.pattern !== undefined) {
      try {
        fullMatch(field.pattern, '');
      } catch {
        errors.push(`${owner}: pattern is not a valid regular expression.`);
      }
    }
    checkWhen(field.when, owner);
    fieldIds.add(field.id);
  }

  for (const group of profile.fileGroups ?? []) {
    const owner = `File group "${group.id}"`;
    checkId(group.id, owner);
    checkLabel(group.label, owner);
    if (group.maxCount !== undefined && !isPositiveInteger(group.maxCount)) errors.push(`${owner}: maxCount must be a positive whole number.`);
    groupIds.add(group.id);
  }

  checkTemplate(profile.archiveName, 'archiveName');
  const maxPath = profile.limits?.maxEntryPathLength;
  if (maxPath !== undefined && !isPositiveInteger(maxPath)) errors.push('limits.maxEntryPathLength must be a positive whole number.');

  if (!profile.entries?.length) errors.push('"entries" must describe at least one archive entry.');
  for (const entry of profile.entries ?? []) {
    const owner = `Entry "${entry.path}"`;
    if (typeof entry.path !== 'string' || isBlank(entry.path)) {
      errors.push(`${owner}: path is required.`);
      continue;
    }
    checkWhen(entry.when, owner);
    checkTemplate(entry.path, owner, entry.type === 'files' ? 'fileName' : undefined);
    if (entry.type === 'document') {
      checkNode(entry.document, owner);
      const { prefix, namespace } = entry.document ?? {};
      if (namespace !== undefined && typeof namespace !== 'string') errors.push(`${owner}: namespace must be text.`);
      if (prefix !== undefined && (typeof prefix !== 'string' || !NCNAME.test(prefix))) errors.push(`${owner}: invalid namespace prefix.`);
      if (prefix !== undefined && isBlank(namespace)) errors.push(`${owner}: a prefix needs a namespace.`);
    } else if (entry.type === 'files') {
      if (!groupIds.has(entry.group)) errors.push(`${owner}: unknown file group "${entry.group}".`);
    } else if (entry.type === 'directory') {
      if (!entry.path.endsWith('/')) errors.push(`${owner}: a directory path must end with "/".`);
    } else if (entry.type !== 'packet') {
      errors.push(`${owner}: type must be packet, document, files or directory.`);
    }
    if (entry.type !== 'directory' && entry.path.endsWith('/')) errors.push(`${owner}: only a directory path may end with "/".`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Conditions and values
// ---------------------------------------------------------------------------

function conditionHolds(when, active) {
  return asArray(when).every((cond) => {
    const value = active[cond.field] ?? '';
    if (cond.notBlank === true && isBlank(value)) return false;
    if ('equals' in cond && value !== cond.equals) return false;
    if (Array.isArray(cond.in) && !cond.in.includes(value)) return false;
    return true;
  });
}

/**
 * Trimmed values of the fields that currently apply. A field whose `when`
 * doesn't hold has no value at all — whatever was typed into it before the
 * user changed the controlling field neither validates nor reaches the
 * package, and fields that depend on it are off in turn.
 */
export function activeValues(profile, values) {
  const active = {};
  for (const field of profile.fields ?? []) {
    if (conditionHolds(field.when, active)) active[field.id] = String(values?.[field.id] ?? '').trim();
  }
  return active;
}

/** Ids of the fields whose values must never be stored (`remember: false`). */
export function unrememberedFieldIds(profile) {
  return (profile.fields ?? []).filter((f) => f.remember === false).map((f) => f.id);
}

/** @returns {Array<{field: string, message: string}>} empty when the values pass */
export function validateProfileValues(profile, values) {
  const active = activeValues(profile, values);
  const errors = [];
  for (const field of profile.fields ?? []) {
    if (!(field.id in active)) continue;
    const value = active[field.id];
    const fail = (message) => errors.push({ field: field.id, message: `${field.label} ${message}` });
    if (value === '') {
      if (field.required) fail('is required.');
    } else if (field.type === 'select' && !field.options.some((o) => o.value === value)) {
      fail('must be one of the listed options.');
    } else if (field.maxLength !== undefined && value.length > field.maxLength) {
      fail(`must be at most ${field.maxLength} characters.`);
    } else if (field.pattern !== undefined && !fullMatch(field.pattern, value)) {
      fail(field.patternMessage || 'is not in the expected format.');
    }
  }
  return errors;
}

/** Per-group constraints. @param {Object<string, Array<{name: string}>>} files by group id */
export function validateProfileFiles(profile, files) {
  const errors = [];
  for (const group of profile.fileGroups ?? []) {
    const picked = files?.[group.id] ?? [];
    const fail = (message) => errors.push({ field: group.id, message: `${group.label}: ${message}` });
    if (group.required && picked.length === 0) fail('a file is required.');
    const max = group.multiple ? group.maxCount : 1;
    if (max !== undefined && picked.length > max) fail(`at most ${max} allowed (${picked.length} selected).`);
    if (group.uniqueNames) {
      const names = picked.map((f) => f.name.toLowerCase());
      for (const name of new Set(names.filter((n, i) => names.indexOf(n) !== i))) fail(`more than one file is named ${name}.`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

function fillTemplate(template, context) {
  return String(template).replace(TOKEN, (_, name) => context[name] ?? '');
}

function xmlEscape(value) {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

function renderNode(node, context, prefix, depth, isRoot) {
  if (!conditionHolds(node.when, context)) return '';
  const indent = '  '.repeat(depth);
  const tag = prefix ? `${prefix}:${node.name}` : node.name;
  let attributes = '';
  for (const [name, template] of Object.entries(node.attributes ?? {})) {
    const value = fillTemplate(template, context);
    if (!isBlank(value)) attributes += ` ${name}="${xmlEscape(value)}"`;
  }
  const body = node.children
    ? node.children.map((c) => renderNode(c, context, prefix, depth + 1, false)).join('')
    : xmlEscape(fillTemplate(node.value ?? '', context));
  if (isBlank(body) && attributes === '' && !isRoot) return ''; // a blank optional field has no element
  const xmlns = isRoot && node.namespace ? ` xmlns${prefix ? `:${prefix}` : ''}="${xmlEscape(node.namespace)}"` : '';
  const content = node.children ? `\n${body}${indent}` : body;
  return `${indent}<${tag}${xmlns}${attributes}>${content}</${tag}>\n`;
}

/** Renders a profile entry's `document` to XML text. Elements left blank are omitted. */
export function renderDocument(documentNode, context) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${renderNode(documentNode, context, documentNode.prefix ?? '', 0, true)}`;
}

// ---------------------------------------------------------------------------
// Archive planning
// ---------------------------------------------------------------------------

/** Templates interpolate typed values and picked file names, so a resolved
 *  path is untrusted input: no climbing out of the archive, no names that
 *  can't be extracted on some platform. */
function isSafeEntryPath(path) {
  const segments = path.replace(/\/$/, '').split('/');
  return !segments.some((s) => s.trim() === '' || s === '.' || s === '..') && !/[\u0000-\u001f\\:*?"<>|]/.test(path);
}

/**
 * Resolves a profile against actual values and files into the list of archive
 * entries, without reading any file contents.
 *
 * @param {object} profile
 * @param {object} values raw field values by field id
 * @param {Object<string, Array<{name: string}>>} files picked files by group id
 * @param {string} packetName
 * @returns {{filename: string, errors: Array<{field: string|null, message: string}>,
 *   entries: Array<{path: string, type: string, file?: object, text?: string, xmlDeclaration?: boolean}>}}
 */
export function planArchive(profile, values, files, packetName) {
  const context = { ...activeValues(profile, values), packetName };
  const errors = [];
  const entries = [];
  const fail = (message) => errors.push({ field: null, message });
  const included = profile.entries.filter((entry) => conditionHolds(entry.when, context));

  for (const entry of included.filter((e) => e.type !== 'directory')) {
    if (entry.type === 'files') {
      for (const file of files?.[entry.group] ?? []) {
        entries.push({ type: 'files', path: fillTemplate(entry.path, { ...context, fileName: file.name }), file });
      }
      continue;
    }
    const planned = { type: entry.type, path: fillTemplate(entry.path, context) };
    if (entry.type === 'document') planned.text = renderDocument(entry.document, context);
    else planned.xmlDeclaration = entry.xmlDeclaration === true;
    entries.push(planned);
  }

  // A directory is listed explicitly only when nothing in it implies it.
  for (const entry of included.filter((e) => e.type === 'directory')) {
    const path = fillTemplate(entry.path, context);
    if (!entries.some((e) => e.path.startsWith(path))) entries.push({ type: 'directory', path });
  }

  const maxLength = profile.limits?.maxEntryPathLength;
  const seen = new Set();
  for (const { path } of entries) {
    if (!isSafeEntryPath(path)) fail(`"${path}" is not a valid path inside the package.`);
    if (maxLength !== undefined && path.length > maxLength) fail(`Path too long (${path.length} characters, at most ${maxLength}): ${path}`);
    const key = path.toLowerCase();
    if (seen.has(key)) fail(`More than one file would be stored as ${path}.`);
    seen.add(key);
  }

  const filename = fillTemplate(profile.archiveName, context);
  if (filename.includes('/') || !isSafeEntryPath(filename)) fail(`"${filename}" is not a valid package file name.`);
  return { filename, entries, errors };
}

/** Everything that blocks creating a package, in the order to show it. */
export function validatePackage(profile, values, files, packetName) {
  const errors = [...validateProfileValues(profile, values), ...validateProfileFiles(profile, files)];
  // Path problems are consequences of bad values or files; until those are
  // right they would only repeat them.
  return errors.length > 0 ? errors : planArchive(profile, values, files, packetName).errors;
}
