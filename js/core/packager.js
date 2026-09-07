// js/core/packager.js — MeF submission ZIP builder.
//
// See web-implementation-spec.md §19 (Packaging). Implemented in
// IMPLEMENTATION_PLAN.md Phase 8. Note: the manifest XML shape described in §19
// is a placeholder pending a real IRS/state MeF schema — see §25 / Phase 9.
//
// Deviates from §19's suggested implementation in one way: rather than vendor
// JSZip (an external dependency this project otherwise has none of — §23/§24
// are all plain ES modules, no bundler), the ZIP container itself is built by
// hand using the browser's native CompressionStream API (§24 names this as
// the explicit alternative: "feasible but complex" — the "complex" part is
// entirely the well-defined, testable ZIP format below, not anything
// app-specific). Falls back to uncompressed ("stored") entries in browsers
// without CompressionStream, so packaging still works, just without deflate.
//
// Pure logic — no `document` access anywhere in this file (the one browser
// global used, CompressionStream, is a streams-and-bytes API, not a DOM one;
// same category as DOMParser/XMLSerializer elsewhere in this codebase).

// ---------------------------------------------------------------------------
// Packaging Settings Validation (§19 workflow step 3 — "Validate all
// required fields", the dialog's OWN fields; this is deliberately separate
// from js/ui/validation.js's validateSchema, which checks the PACKET's data
// against the XSD — see js/ui/packaging.js, which runs both and treats this
// function's output as blocking and validateSchema's as a skippable warning,
// matching §19 workflow steps 3 and 4 respectively).
// ---------------------------------------------------------------------------

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

/**
 * @param {object} settings see js/ui/packaging.js's gatherSettings() for the
 *   full shape; only the fields validated below are read here.
 * @returns {Array<{field: string, message: string}>} empty when settings pass
 */
export function validatePackagingSettings(settings) {
  const errors = [];
  const require = (field, label) => {
    if (isBlank(settings[field])) errors.push({ field, message: `${label} is required.` });
  };

  require('submissionId', 'Submission ID');
  if (!isBlank(settings.submissionId) && !/^\d{13}[A-Za-z0-9]{7}$/.test(settings.submissionId)) {
    errors.push({ field: 'submissionId', message: 'Submission ID must be 20 characters: 13 digits followed by 7 alphanumeric characters.' });
  }

  require('efin', 'EFIN');
  if (!isBlank(settings.efin) && !/^\d{6}$/.test(settings.efin)) {
    errors.push({ field: 'efin', message: 'EFIN must be exactly 6 digits.' });
  }

  require('taxYear', 'Tax Year');
  if (!isBlank(settings.taxYear) && !/^\d{4}$/.test(settings.taxYear)) {
    errors.push({ field: 'taxYear', message: 'Tax Year must be exactly 4 digits.' });
  }

  require('governmentCode', 'Government Code');
  if (!isBlank(settings.governmentCode) && String(settings.governmentCode).length !== 4) {
    errors.push({ field: 'governmentCode', message: 'Government Code must be exactly 4 characters.' });
  }

  require('submissionType', 'Submission Type');

  if (settings.category !== 'Individual' && settings.category !== 'Business') {
    errors.push({ field: 'category', message: 'Category must be Individual or Business.' });
  } else if (settings.category === 'Individual') {
    require('primarySSN', 'Primary SSN');
    if (!isBlank(settings.primarySSN) && !/^\d{9}$/.test(settings.primarySSN)) {
      errors.push({ field: 'primarySSN', message: 'Primary SSN must be exactly 9 digits.' });
    }
    require('primaryNameControl', 'Primary Name Control');
    if (!isBlank(settings.primaryNameControl) && String(settings.primaryNameControl).length > 4) {
      errors.push({ field: 'primaryNameControl', message: 'Primary Name Control must be at most 4 characters.' });
    }
    if (!isBlank(settings.spouseSSN) && !/^\d{9}$/.test(settings.spouseSSN)) {
      errors.push({ field: 'spouseSSN', message: 'Spouse SSN must be exactly 9 digits.' });
    }
    if (!isBlank(settings.spouseNameControl) && String(settings.spouseNameControl).length > 4) {
      errors.push({ field: 'spouseNameControl', message: 'Spouse Name Control must be at most 4 characters.' });
    }
  } else {
    require('ein', 'EIN');
    if (!isBlank(settings.ein) && !/^\d{9}$/.test(settings.ein)) {
      errors.push({ field: 'ein', message: 'EIN must be exactly 9 digits.' });
    }
    require('businessNameControl', 'Business Name Control');
    if (!isBlank(settings.businessNameControl) && String(settings.businessNameControl).length > 4) {
      errors.push({ field: 'businessNameControl', message: 'Business Name Control must be at most 4 characters.' });
    }
  }

  if (!isBlank(settings.irsSubmissionId) && String(settings.irsSubmissionId).length !== 20) {
    errors.push({ field: 'irsSubmissionId', message: 'IRS Submission ID must be exactly 20 characters.' });
  }

  if ((settings.stateAttachmentCount ?? 0) > 50) {
    errors.push({ field: 'stateAttachments', message: 'At most 50 state attachment files are allowed.' });
  }
  if ((settings.federalAttachmentCount ?? 0) > 50) {
    errors.push({ field: 'federalAttachments', message: 'At most 50 federal attachment files are allowed.' });
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Manifest XML (§19 "Manifest XML")
// ---------------------------------------------------------------------------

function xmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

function tag(name, value) {
  return isBlank(value) ? '' : `  <${name}>${xmlEscape(value)}</${name}>\n`;
}

/** @param {object} settings @returns {string} */
export function buildManifestXml(settings) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<StateManifest>\n';
  xml += tag('SubmissionId', settings.submissionId);
  xml += tag('EFIN', settings.efin);
  xml += tag('TaxYear', settings.taxYear);
  xml += tag('GovernmentCd', settings.governmentCode);
  xml += tag('StateSubmissionTyp', settings.submissionType);
  xml += tag('SubmissionCategoryCd', settings.category === 'Individual' ? 'IND' : settings.category === 'Business' ? 'BUS' : '');
  if (settings.category === 'Individual') {
    xml += tag('PrimarySSN', settings.primarySSN);
    xml += tag('PrimaryNameControlTxt', settings.primaryNameControl);
    xml += tag('SpouseSSN', settings.spouseSSN);
    xml += tag('SpouseNameControlTxt', settings.spouseNameControl);
  } else if (settings.category === 'Business') {
    xml += tag('EIN', settings.ein);
    xml += tag('BusinessNameControlTxt', settings.businessNameControl);
  }
  xml += tag('IRSSubmissionId', settings.irsSubmissionId);
  xml += '</StateManifest>';
  return xml;
}

// ---------------------------------------------------------------------------
// Last-used dialog settings persistence (§19 "Persist last-used dialog
// values to localStorage.xmlEditor.lastPackagingSettings")
// ---------------------------------------------------------------------------

const SETTINGS_STORAGE_KEY = 'xmlEditor.lastPackagingSettings';

/** File lists aren't JSON-serializable/rehydratable, so only the text fields
 *  round-trip — attachments are always re-picked per package. */
export function saveLastPackagingSettings(settings) {
  const { stateAttachments, federalReturnFile, federalAttachments, stateAttachmentCount, federalAttachmentCount, ...persistable } = settings;
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(persistable));
  } catch {
    // ignore — packaging still works for this session
  }
}

export function loadLastPackagingSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ZIP container (hand-rolled — see file header comment)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** @param {Uint8Array} bytes @returns {number} unsigned 32-bit CRC-32 */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** @returns {Promise<Uint8Array|null>} null when CompressionStream isn't available (caller stores instead) */
async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}

/** DOS date/time fields the ZIP local/central headers require. */
function dosDateTime(date = new Date()) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const dosYear = Math.max(0, date.getFullYear() - 1980);
  const dosDate = ((dosYear & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, date: dosDate };
}

/**
 * Builds a ZIP archive (local file headers + central directory + end-of-
 * central-directory record, per the standard ZIP format) from raw entries.
 * Each entry is deflated individually when CompressionStream is available
 * and actually shrinks the data, else stored uncompressed.
 *
 * @param {Array<{name: string, data: Uint8Array}>} entries
 * @returns {Promise<Blob>}
 */
export async function buildZip(entries) {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const uncompressed = entry.data;
    const crc = crc32(uncompressed);
    const deflated = await deflateRaw(uncompressed);
    const useDeflate = !!deflated && deflated.length < uncompressed.length;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate ? deflated : uncompressed;

    const localHeader = new DataView(new ArrayBuffer(30));
    localHeader.setUint32(0, 0x04034b50, true);
    localHeader.setUint16(4, 20, true); // version needed to extract
    localHeader.setUint16(6, 0, true); // general purpose flags
    localHeader.setUint16(8, method, true);
    localHeader.setUint16(10, time, true);
    localHeader.setUint16(12, date, true);
    localHeader.setUint32(14, crc, true);
    localHeader.setUint32(18, payload.length, true);
    localHeader.setUint32(22, uncompressed.length, true);
    localHeader.setUint16(26, nameBytes.length, true);
    localHeader.setUint16(28, 0, true); // extra field length
    localParts.push(new Uint8Array(localHeader.buffer), nameBytes, payload);

    const centralHeader = new DataView(new ArrayBuffer(46));
    centralHeader.setUint32(0, 0x02014b50, true);
    centralHeader.setUint16(4, 20, true); // version made by
    centralHeader.setUint16(6, 20, true); // version needed to extract
    centralHeader.setUint16(8, 0, true); // general purpose flags
    centralHeader.setUint16(10, method, true);
    centralHeader.setUint16(12, time, true);
    centralHeader.setUint16(14, date, true);
    centralHeader.setUint32(16, crc, true);
    centralHeader.setUint32(20, payload.length, true);
    centralHeader.setUint32(24, uncompressed.length, true);
    centralHeader.setUint16(28, nameBytes.length, true);
    centralHeader.setUint16(30, 0, true); // extra field length
    centralHeader.setUint16(32, 0, true); // comment length
    centralHeader.setUint16(34, 0, true); // disk number start
    centralHeader.setUint16(36, 0, true); // internal file attributes
    centralHeader.setUint32(38, 0, true); // external file attributes
    centralHeader.setUint32(42, offset, true); // offset of local header
    centralParts.push(new Uint8Array(centralHeader.buffer), nameBytes);

    offset += 30 + nameBytes.length + payload.length; // local header is always 30 bytes
  }

  const centralDirSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const centralDirOffset = offset;

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true); // disk number
  eocd.setUint16(6, 0, true); // disk where central directory starts
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralDirSize, true);
  eocd.setUint32(16, centralDirOffset, true);
  eocd.setUint16(20, 0, true); // comment length

  return new Blob([...localParts, ...centralParts, new Uint8Array(eocd.buffer)], { type: 'application/zip' });
}

// ---------------------------------------------------------------------------
// Full package assembly (§19 "Build the ZIP" layout)
// ---------------------------------------------------------------------------

async function fileToBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

/**
 * @param {object} params
 * @param {object} params.settings — see js/ui/packaging.js gatherSettings()
 * @param {string} params.packetXml — the built Packet_XML string (§10 buildPacketXml)
 * @param {string} params.packetFileName — `${manifest.packetName}.xml`
 * @param {File[]} [params.stateAttachments]
 * @param {File|null} [params.federalReturnFile]
 * @param {File[]} [params.federalAttachments]
 * @returns {Promise<{blob: Blob, filename: string}>}
 */
export async function buildSubmissionPackage({ settings, packetXml, packetFileName, stateAttachments = [], federalReturnFile = null, federalAttachments = [] }) {
  const encoder = new TextEncoder();
  const entries = [
    { name: 'manifest.xml', data: encoder.encode(buildManifestXml(settings)) },
    { name: packetFileName, data: encoder.encode(packetXml) },
  ];

  for (const file of stateAttachments) entries.push({ name: file.name, data: await fileToBytes(file) });
  if (federalReturnFile) entries.push({ name: 'federal/federal_return.xml', data: await fileToBytes(federalReturnFile) });
  for (const file of federalAttachments) entries.push({ name: `federal/${file.name}`, data: await fileToBytes(file) });

  const blob = await buildZip(entries);
  return { blob, filename: `${settings.submissionId}.zip` };
}
