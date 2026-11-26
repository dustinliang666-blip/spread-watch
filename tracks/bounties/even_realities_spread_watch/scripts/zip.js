import { deflateRawSync, inflateRawSync, crc32 } from 'node:zlib';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const MAX_FILE = 2 * 1024 * 1024;
const MAX_TOTAL = 16 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function verify(valid) {
  if (!valid) throw new Error('Malformed or unsupported ZIP');
}

export function createZip(files) {
  const locals = [];
  const directory = [];
  let offset = 0;
  for (const [name, data] of files) {
    const path = Buffer.from(name);
    const packed = deflateRawSync(data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(path.length, 26);
    locals.push(local, path, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL);
    local.copy(central, 4, 4, 6);
    local.copy(central, 6, 4, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, path);
    offset += local.length + path.length + packed.length;
  }
  const central = Buffer.concat(directory);
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(END);
  footer.writeUInt16LE(files.size, 8);
  footer.writeUInt16LE(files.size, 10);
  footer.writeUInt32LE(central.length, 12);
  footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, footer]);
}

export function unzip(zip) {
  verify(zip.length >= 22 && zip.length <= MAX_TOTAL);
  const footer = zip.length - 22;
  const count = zip.readUInt16LE(footer + 10);
  const start = zip.readUInt32LE(footer + 16);
  verify(zip.readUInt32LE(footer) === END && zip.readUInt32LE(footer + 4) === 0 &&
    zip.readUInt16LE(footer + 8) === count && zip.readUInt16LE(footer + 20) === 0 &&
    count > 0 && count <= 256 && start + zip.readUInt32LE(footer + 12) === footer);
  const entries = [];
  const files = new Map();
  let total = 0;
  for (let index = 0, cursor = start; index < count; index += 1) {
    verify(cursor + 46 <= footer && zip.readUInt32LE(cursor) === CENTRAL);
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const checksum = zip.readUInt32LE(cursor + 16);
    const packed = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const len = zip.readUInt16LE(cursor + 28);
    const offset = zip.readUInt32LE(cursor + 42);
    const fileType = zip.readUInt32LE(cursor + 38) >>> 28;
    const end = cursor + 46 + len;
    verify((flags & ~0x800) === 0 && (method === 0 || method === 8) && len > 0 && end <= footer &&
      zip.readUInt16LE(cursor + 30) === 0 && zip.readUInt32LE(cursor + 32) === 0 &&
      (fileType === 0 || fileType === 8) && size <= MAX_FILE && total + size <= MAX_TOTAL);
    const name = utf8.decode(zip.subarray(cursor + 46, end));
    const dataAt = offset + 30 + len;
    verify(!files.has(name) && dataAt + packed <= start && zip.readUInt32LE(offset) === LOCAL &&
      zip.subarray(offset + 4, offset + 28).equals(zip.subarray(cursor + 6, cursor + 30)) &&
      zip.readUInt16LE(offset + 28) === 0 &&
      zip.subarray(offset + 30, dataAt).equals(zip.subarray(cursor + 46, end)));
    const encoded = zip.subarray(dataAt, dataAt + packed);
    const inflated = method === 0 ? { buffer: encoded } : inflateRawSync(encoded, { maxOutputLength: size || 1, info: true });
    const data = inflated.buffer;
    verify(data.length === size && crc32(data) === checksum && (method === 0 || inflated.engine.bytesWritten === packed));
    files.set(name, data);
    entries.push([offset, dataAt + packed]);
    total += size;
    cursor = end;
    if (index === count - 1) verify(cursor === footer);
  }
  let cursor = 0;
  for (const [from, to] of entries.sort(([a], [b]) => a - b)) {
    verify(from === cursor);
    cursor = to;
  }
  verify(cursor === start);
  return files;
}
