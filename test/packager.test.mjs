// test/packager.test.mjs — js/core/packager.js.
//
// Node 20+ provides TextEncoder, Blob and CompressionStream natively, so the
// hand-rolled ZIP writer runs here unchanged. That makes the ZIP container — the
// one piece of this codebase where a byte-level mistake produces a file that
// simply won't open — checkable without a browser and without downloading
// anything. Profile rules themselves are covered in exportProfile.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';

import { crc32, buildZip, buildPackage } from '../js/core/packager.js';

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

const PROFILE = {
  formatVersion: 1,
  id: 'p',
  name: 'P',
  archiveName: '{code}.zip',
  fields: [{ id: 'code', label: 'Code', required: true }],
  fileGroups: [{ id: 'extra', label: 'Extra', multiple: true }],
  entries: [
    { type: 'packet', path: 'data/{packetName}.xml', xmlDeclaration: true },
    { type: 'document', path: 'manifest.xml', document: { name: 'M', children: [{ name: 'Code', value: '{code}' }] } },
    { type: 'files', group: 'extra', path: 'extra/{fileName}' },
    { type: 'directory', path: 'extra/' },
  ],
};
const INPUT = { profile: PROFILE, values: { code: ' X1 ' }, packetXml: '<Packet/>', packetName: 'Packet' };

/** Reads one stored (method 0) entry's bytes back out of the archive. */
function storedText({ bytes, view, entries }, name) {
  const entry = entries.find((e) => e.name === name);
  assert.equal(entry.compressionMethod, 0);
  const start = entry.localOffset + 30 + view.getUint16(entry.localOffset + 26, true);
  return new TextDecoder().decode(bytes.subarray(start, start + entry.compressedSize));
}

test('buildPackage writes the planned entries, including an empty directory', async () => {
  const { blob, filename } = await buildPackage(INPUT);
  assert.equal(filename, 'X1.zip');
  const zip = await readZipEntries(blob);
  assert.deepEqual(zip.entries.map((e) => e.name), ['data/Packet.xml', 'manifest.xml', 'extra/']);
  const directory = zip.entries.at(-1);
  assert.equal(directory.uncompressedSize, 0);
  assert.equal(directory.compressionMethod, 0, 'a directory entry must be stored, not deflated');
  assert.equal(storedText(zip, 'data/Packet.xml'), '<?xml version="1.0" encoding="UTF-8"?>\n<Packet/>');
});

test('buildPackage copies picked files byte for byte', async () => {
  const { blob } = await buildPackage({ ...INPUT, files: { extra: [new File(['abc'], 'a.txt')] } });
  const zip = await readZipEntries(blob);
  assert.deepEqual(zip.entries.map((e) => e.name), ['data/Packet.xml', 'manifest.xml', 'extra/a.txt']);
  assert.equal(storedText(zip, 'extra/a.txt'), 'abc');
});

test('buildPackage refuses input that breaks the profile', async () => {
  await assert.rejects(buildPackage({ ...INPUT, values: {} }), /Code is required/);
});
