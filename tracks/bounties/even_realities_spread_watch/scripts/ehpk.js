import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';

// Record layout produced by the pinned Even Hub CLI's EHPK v1 writer.
const header = Buffer.from('4548504b0100010014000000', 'hex');
const key = Buffer.from('EVEN REALITIES');
const footerSize = 68;
const fileLimit = 2 * 1024 * 1024;
export const archiveLimit = 16 * 1024 * 1024;
const decode = (bytes) => bytes.map((value, index) => value ^ key[index % key.length]);
const invalid = () => { throw new Error('INVALID_EHPK'); };

export function readEhpk(data, allowedFiles) {
  if (data.length < 20 + footerSize || data.length > archiveLimit ||
      !data.subarray(0, header.length).equals(header) || data.readUInt32LE(16) !== 0) invalid();
  const end = data.length - footerSize;
  if (data.readUInt32LE(end) !== 0xbaa9bae3 ||
      !createHash('sha512').update(data.subarray(0, end)).digest().equals(data.subarray(end + 4))) invalid();

  const allowedDirs = new Set();
  for (const name of allowedFiles) {
    for (let slash = name.indexOf('/'); slash !== -1; slash = name.indexOf('/', slash + 1)) {
      allowedDirs.add(name.slice(0, slash));
    }
  }
  const count = data.readUInt32LE(12);
  if (count > allowedFiles.size + allowedDirs.size) invalid();
  const names = new Set();
  const files = new Map();
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  let offset = 20;
  let expanded = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 8 > end) invalid();
    const signature = data.readUInt32LE(offset);
    const directory = signature === 0xbaa9bae5;
    if (!directory && signature !== 0xbaa9bae4) invalid();
    const size = directory ? 8 : 16;
    if (offset + size > end) invalid();
    const packed = directory ? 0 : data.readUInt32LE(offset + 4);
    const length = directory ? 0 : data.readUInt32LE(offset + 8);
    const kind = data.readUInt16LE(offset + size - 4);
    const nameLength = data.readUInt16LE(offset + size - 2);
    if (kind !== (directory ? 0xaabd : 0xb701) || nameLength === 0 || nameLength > 255 ||
        length > fileLimit || offset + size + nameLength + packed > end) invalid();
    offset += size;
    const name = utf8.decode(decode(data.subarray(offset, offset + nameLength)));
    const allowed = directory ? allowedDirs : allowedFiles;
    if (!allowed.has(name)) throw new Error('EHPK_ALLOWLIST');
    if (names.has(name)) invalid();
    names.add(name);
    offset += nameLength;
    if (!directory) {
      expanded += length;
      if (!packed || expanded > archiveLimit) invalid();
      const content = zstdDecompressSync(decode(data.subarray(offset, offset + packed)), {
        maxOutputLength: Math.max(1, length),
      });
      if (content.length !== length) invalid();
      files.set(name, content);
      offset += packed;
    }
  }
  if (offset !== end) invalid();
  for (const name of names) {
    const slash = name.lastIndexOf('/');
    if (slash !== -1 && !names.has(name.slice(0, slash))) invalid();
  }
  return files;
}
