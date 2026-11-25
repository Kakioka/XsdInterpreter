// js/core/packager.js — ZIP writer and package assembly.
//
// See web-implementation-spec.md §19 (Packaging). What goes into a package —
// fields, layout, manifest — is an export profile's business
// (js/core/exportProfile.js, export-profiles/); this module only turns a
// planned archive into bytes.
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

import { planArchive, validatePackage } from './exportProfile.js';

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
// Package assembly
// ---------------------------------------------------------------------------

/**
 * @param {object} params
 * @param {object} params.profile a profile that passes validateProfile
 * @param {object} params.values field values by field id
 * @param {Object<string, File[]>} [params.files] picked files by file group id
 * @param {string} params.packetXml the built Packet_XML string (§10 buildPacketXml)
 * @param {string} params.packetName manifest.packetName
 * @returns {Promise<{blob: Blob, filename: string}>}
 * @throws when the values or files don't satisfy the profile — callers show
 *   validatePackage's errors first; this is the backstop against writing a
 *   package that breaks its own rules.
 */
export async function buildPackage({ profile, values, files = {}, packetXml, packetName }) {
  const errors = validatePackage(profile, values, files, packetName);
  if (errors.length > 0) throw new Error(`Cannot create the package: ${errors.map((e) => e.message).join(' ')}`);

  const encoder = new TextEncoder();
  const { filename, entries: planned } = planArchive(profile, values, files, packetName);
  const entries = [];
  for (const entry of planned) {
    let data = new Uint8Array(0); // directory
    if (entry.type === 'files') data = new Uint8Array(await entry.file.arrayBuffer());
    else if (entry.type === 'document') data = encoder.encode(entry.text);
    else if (entry.type === 'packet') {
      const declare = entry.xmlDeclaration && !packetXml.startsWith('<?xml');
      data = encoder.encode(declare ? `<?xml version="1.0" encoding="UTF-8"?>\n${packetXml}` : packetXml);
    }
    entries.push({ name: entry.path, data });
  }
  return { blob: await buildZip(entries), filename };
}
