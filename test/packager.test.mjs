// test/packager.test.mjs — js/core/packager.js.
//
// Node 20+ provides TextEncoder, Blob and CompressionStream natively, so the
// hand-rolled ZIP writer runs here unchanged; only localStorage needs a stub
// (three settings-persistence call sites). That makes the ZIP container — the
// one piece of this codebase where a byte-level mistake produces a file that
// simply won't open — checkable without a browser and without downloading
// anything.
//
// NOTE: the settings validation and manifest fields asserted below encode one
// organization's filing rules as literals (CLAUDE.md, "Known-wrong areas";
// dev/PARITY_GAP_ANALYSIS.md 1.4 is the export-profile mechanism that should
// replace them). These are characterization tests of current behavior, so the
// Phase 3 configuration work has a safety net — not an endorsement of the
// rules being hardcoded.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installLocalStorage } from './helpers/env.mjs';

installLocalStorage();

const {
  validatePackagingSettings,
  buildManifestXml,
  saveLastPackagingSettings,
  loadLastPackagingSettings,
  crc32,
  buildZip,
  buildSubmissionPackage,
} = await import('../js/core/packager.js');

const VALID_SETTINGS = {
  submissionId: '1234567890123ABCDEF0',
  efin: '123456',
  taxYear: '2024',
  governmentCode: 'HIHI',
  submissionType: 'StateReturn',
  category: 'Individual',
  primarySSN: '123456789',
  primaryNameControl: 'SMIT',
};

async function readZipEntries(blob) {
  // Parse the central directory rather than trusting the local headers, since
  // that is what a real unzip tool reads to list contents.
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const decoder = new TextDecoder();

  // End of central directory: signature 0x06054b50, scanned from the tail.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.notEqual(eocd, -1, 'no end-of-central-directory record found');

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    assert.equal(view.getUint32(offset, true), 0x02014b50, 'bad central directory header signature');
    const compressionMethod = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.push({ name, compressionMethod, crc, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { bytes, view, entries };
}

test('validatePackagingSettings accepts a well-formed settings object', () => {
  assert.deepEqual(validatePackagingSettings(VALID_SETTINGS), []);
});

test('validatePackagingSettings reports each missing required field by name', () => {
  const errors = validatePackagingSettings({});
  const fields = errors.map((e) => e.field);
  for (const field of ['submissionId', 'efin', 'taxYear', 'governmentCode', 'submissionType', 'category']) {
    assert.ok(fields.includes(field), `${field} should be reported as required`);
  }
  for (const error of errors) {
    assert.match(error.message, /\S/, 'every error carries a message the dialog can show');
  }
});

test('validatePackagingSettings enforces the format of each field', () => {
  const bad = (overrides) => validatePackagingSettings({ ...VALID_SETTINGS, ...overrides }).map((e) => e.field);

  assert.deepEqual(bad({ submissionId: 'too-short' }), ['submissionId']);
  assert.deepEqual(bad({ submissionId: '12345678901234567890' }), [], '20 chars, 13 digits then 7 alphanumerics');
  assert.deepEqual(bad({ efin: '12345' }), ['efin']);
  assert.deepEqual(bad({ efin: '12345a' }), ['efin']);
  assert.deepEqual(bad({ taxYear: '24' }), ['taxYear']);
  assert.deepEqual(bad({ governmentCode: 'HI' }), ['governmentCode']);
});

test('the required field set depends on the category', () => {
  // Individual needs SSN + name control; Business needs EIN + business name
  // control instead, and neither set is demanded of the other.
  const individual = validatePackagingSettings({ ...VALID_SETTINGS, primarySSN: undefined, primaryNameControl: undefined }).map((e) => e.field);
  assert.deepEqual(individual.sort(), ['primaryNameControl', 'primarySSN']);

  const business = validatePackagingSettings({
    submissionId: VALID_SETTINGS.submissionId,
    efin: VALID_SETTINGS.efin,
    taxYear: VALID_SETTINGS.taxYear,
    governmentCode: VALID_SETTINGS.governmentCode,
    submissionType: VALID_SETTINGS.submissionType,
    category: 'Business',
    ein: '123456789',
    businessNameControl: 'ACME',
  });
  assert.deepEqual(business, [], 'a complete Business submission needs no Individual fields');
});

test('attachment counts are capped at 50 each', () => {
  assert.deepEqual(validatePackagingSettings({ ...VALID_SETTINGS, stateAttachmentCount: 50 }), []);
  assert.deepEqual(
    validatePackagingSettings({ ...VALID_SETTINGS, stateAttachmentCount: 51, federalAttachmentCount: 51 }).map((e) => e.field),
    ['stateAttachments', 'federalAttachments']
  );
});

test('whitespace-only values count as blank, not as present', () => {
  assert.ok(validatePackagingSettings({ ...VALID_SETTINGS, efin: '   ' }).some((e) => e.field === 'efin'));
});

test('buildManifestXml produces well-formed XML carrying the settings', () => {
  const xml = buildManifestXml(VALID_SETTINGS);
  assert.match(xml, /^<\?xml/);
  assert.ok(xml.includes(VALID_SETTINGS.submissionId));
  assert.ok(xml.includes(VALID_SETTINGS.efin));
  assert.ok(xml.includes(VALID_SETTINGS.taxYear));
});

test('last-used settings round-trip through localStorage, minus the un-serializable file lists', () => {
  saveLastPackagingSettings({
    ...VALID_SETTINGS,
    stateAttachments: ['not serializable'],
    federalReturnFile: { name: 'x' },
    federalAttachments: [],
    stateAttachmentCount: 3,
    federalAttachmentCount: 1,
  });

  const loaded = loadLastPackagingSettings();
  assert.equal(loaded.submissionId, VALID_SETTINGS.submissionId);
  assert.equal(loaded.efin, VALID_SETTINGS.efin);
  for (const dropped of ['stateAttachments', 'federalReturnFile', 'federalAttachments', 'stateAttachmentCount', 'federalAttachmentCount']) {
    assert.equal(loaded[dropped], undefined, `${dropped} must not be persisted`);
  }
});

test('a localStorage that throws degrades to no persistence rather than an exception', () => {
  installLocalStorage({ throwOnAccess: true });
  assert.doesNotThrow(() => saveLastPackagingSettings(VALID_SETTINGS));
  assert.equal(loadLastPackagingSettings(), null);
  installLocalStorage(); // restore a working stub for the rest of the file
});

test('crc32 matches the known CRC-32 of "123456789"', () => {
  // The standard check value for CRC-32/ISO-HDLC.
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('buildZip writes a readable central directory with correct CRCs and sizes', async () => {
  const encoder = new TextEncoder();
  const payload = encoder.encode('hello '.repeat(200)); // compressible enough to actually deflate
  const blob = await buildZip([
    { name: 'manifest.xml', data: encoder.encode('<manifest/>') },
    { name: 'nested/folder/packet.xml', data: payload },
  ]);

  assert.equal(blob.type, 'application/zip');
  const { entries } = await readZipEntries(blob);
  assert.deepEqual(
    entries.map((e) => e.name),
    ['manifest.xml', 'nested/folder/packet.xml']
  );

  const packet = entries.find((e) => e.name === 'nested/folder/packet.xml');
  assert.equal(packet.uncompressedSize, payload.length);
  assert.equal(packet.crc, crc32(payload));
  // CompressionStream exists in Node 20+, so this entry should be deflated (8)
  // rather than stored (0) — and smaller than it started.
  assert.equal(packet.compressionMethod, 8);
  assert.ok(packet.compressedSize < packet.uncompressedSize);
});

test('buildZip local headers agree with the central directory', async () => {
  const encoder = new TextEncoder();
  const blob = await buildZip([{ name: 'a.txt', data: encoder.encode('contents of a') }]);
  const { view, entries } = await readZipEntries(blob);
  const [entry] = entries;

  assert.equal(view.getUint32(entry.localOffset, true), 0x04034b50, 'local file header signature');
  assert.equal(view.getUint32(entry.localOffset + 14, true), entry.crc, 'CRC must match the central directory');
  assert.equal(view.getUint32(entry.localOffset + 18, true), entry.compressedSize);
  assert.equal(view.getUint32(entry.localOffset + 22, true), entry.uncompressedSize);
});

test('buildZip handles an empty entry list', async () => {
  const blob = await buildZip([]);
  const { entries } = await readZipEntries(blob);
  assert.deepEqual(entries, []);
});

test('buildSubmissionPackage bundles the packet XML and a manifest under one archive', async () => {
  const { blob, filename } = await buildSubmissionPackage({
    settings: VALID_SETTINGS,
    packetXml: '<SamplePacket><SampleHeader/></SamplePacket>',
    packetFileName: 'SamplePacket.xml',
  });

  assert.match(filename, /\.zip$/);
  assert.ok(filename.includes(VALID_SETTINGS.submissionId), 'the archive is named after the submission');

  const { entries } = await readZipEntries(blob);
  assert.ok(entries.length >= 2, `expected at least a manifest and the packet, got ${entries.map((e) => e.name).join(', ')}`);
  assert.ok(
    entries.some((e) => e.name.endsWith('SamplePacket.xml')),
    `packet XML missing from ${entries.map((e) => e.name).join(', ')}`
  );
  assert.ok(
    entries.some((e) => /manifest\.xml$/i.test(e.name)),
    `manifest missing from ${entries.map((e) => e.name).join(', ')}`
  );
  // Every entry uses forward slashes — a backslash in a ZIP path is a classic
  // Windows-authored-archive bug that some tools refuse to extract.
  for (const entry of entries) assert.ok(!entry.name.includes('\\'), `${entry.name} uses a backslash`);
});
