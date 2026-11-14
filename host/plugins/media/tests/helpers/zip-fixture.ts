/**
 * Test-only ZIP fixture builder mirroring the Rust tests' `zip_package` helper.
 * Stored entries by default; `{ deflate: true }` compresses every entry the way
 * the zip crate's default options do.
 */
import { deflateRawSync } from 'node:zlib';

export interface ZipFixtureOptions {
  deflate?: boolean;
}

export function zipPackage(
  parts: ReadonlyArray<readonly [string, string | Uint8Array]>,
  options: ZipFixtureOptions = {},
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of parts) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const method = options.deflate === true ? 8 : 0;
    const stored = method === 8 ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x0403_4b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x0201_4b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, stored);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + stored.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x0605_4b50, 0);
  eocd.writeUInt16LE(parts.length, 8);
  eocd.writeUInt16LE(parts.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}
