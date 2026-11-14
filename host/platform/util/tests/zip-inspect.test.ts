import { describe, expect, it } from 'vitest';
import { ZipArchive, ZipError, writeZip, zipEnclosedName } from '../node.ts';

// zip 0.6.6 read.rs: by_index_with_optional_password / find_content / make_crypto_reader,
// ZipFile::unix_mode / enclosed_name. Metadata only: no inflate, no CRC.
const archive = () => writeZip([
  { name: 'a.txt', data: 'hello', options: { unixPermissions: 0o640 } },
  { name: 'dir/', directory: true },
  { name: 'b.txt', data: 'world', options: { compression: 'stored' } },
]);
/** Byte offset of central-directory header `index`. */
function central(bytes: Buffer, index: number): number {
  let position = bytes.readUInt32LE(bytes.length - 22 + 16);
  for (let i = 0; i < index; i++) position += 46 + bytes.readUInt16LE(position + 28) + bytes.readUInt16LE(position + 30) + bytes.readUInt16LE(position + 32);
  return position;
}
const zipError = (run: () => unknown) => {
  try { run(); } catch (error) { if (error instanceof ZipError) return [error.kind, error.message]; throw error; }
  throw new Error('no error');
};

describe('ZipArchive.inspectByIndex', () => {
  it('returns unix_mode and enclosed_name without inflating or checking CRC', () => {
    const bytes = archive();
    bytes.writeUInt32LE(0xdeadbeef, central(bytes, 0) + 16); // wrong CRC is not checked by by_index
    const zip = ZipArchive.from(bytes);
    expect(zip.inspectByIndex(0)).toMatchObject({ index: 0, name: 'a.txt', unixMode: 0o100640, enclosedName: 'a.txt', size: 5 });
    expect(zip.inspectByIndex(1)).toMatchObject({ name: 'dir/', unixMode: 0o040755, isDirectory: true });
    expect(() => zip.read('a.txt')).toThrow('CRC32 mismatch');
  });

  it('exposes symlink modes and the DOS / unknown-system / zero-attribute branches', () => {
    const bytes = archive();
    bytes.writeUInt32LE((0o120777 << 16) >>> 0, central(bytes, 0) + 38);
    bytes.writeUInt16LE((0 << 8) | 20, central(bytes, 1) + 4); // DOS
    bytes.writeUInt32LE(0x10 | 0x01, central(bytes, 1) + 38);  // directory + read-only
    bytes.writeUInt32LE(0, central(bytes, 2) + 38);
    const zip = ZipArchive.from(bytes);
    const symlink = zip.inspectByIndex(0).unixMode!;
    expect(symlink & 0o170000).toBe(0o120000);
    expect(zip.inspectByIndex(1).unixMode).toBe((0o040000 | 0o0775) & 0o0555);
    expect(zip.inspectByIndex(2).unixMode).toBeNull();
    bytes.writeUInt16LE((2 << 8) | 20, central(bytes, 1) + 4); // other system
    expect(ZipArchive.from(bytes).inspectByIndex(1).unixMode).toBeNull();
    bytes.writeUInt16LE(20, central(bytes, 1) + 4);
    bytes.writeUInt32LE(0x20, central(bytes, 1) + 38); // DOS regular file
    expect(ZipArchive.from(bytes).inspectByIndex(1).unixMode).toBe(0o100000 | 0o0664);
  });

  it('keeps by_index error order: FileNotFound, encrypted, local header, unsupported method', () => {
    const bytes = archive();
    const zip = () => ZipArchive.from(bytes);
    expect(zipError(() => zip().inspectByIndex(3))).toEqual(['FileNotFound', 'specified file not found in archive']);
    // Encrypted wins over a broken local header and an unsupported method.
    bytes.writeUInt16LE(99, central(bytes, 0) + 10);
    const local = bytes.readUInt32LE(central(bytes, 0) + 42);
    bytes.writeUInt32LE(0, local);
    bytes.writeUInt16LE(1, central(bytes, 0) + 8);
    expect(zipError(() => zip().inspectByIndex(0))).toEqual(['UnsupportedArchive', 'unsupported Zip archive: Password required to decrypt file']);
    bytes.writeUInt16LE(0, central(bytes, 0) + 8);
    expect(zipError(() => zip().inspectByIndex(0))).toEqual(['InvalidArchive', 'invalid Zip archive: Invalid local file header']);
    bytes.writeUInt32LE(0x04034b50, local);
    expect(zipError(() => zip().inspectByIndex(0))).toEqual(['UnsupportedArchive', 'unsupported Zip archive: Compression method not supported']);
    bytes.writeUInt32LE(bytes.length - 2, central(bytes, 2) + 42); // local header past EOF → io UnexpectedEof
    expect(zipError(() => zip().inspectByIndex(2))).toEqual(['Io', 'failed to fill whole buffer']);
  });
});

describe('zipEnclosedName (Rust Path::components per platform)', () => {
  it('unix: only "/" separates; backslashes and inner ".." that stay inside are allowed', () => {
    expect(zipEnclosedName('a/../b', 'linux')).toBe('a/../b');
    expect(zipEnclosedName('a\\..\\..\\b', 'linux')).toBe('a\\..\\..\\b');
    expect(zipEnclosedName('C:/x', 'linux')).toBe('C:/x');
    expect(zipEnclosedName('./a//b/', 'linux')).toBe('./a//b/');
    for (const bad of ['/etc/passwd', '../a', 'a/../../b', 'a\0b']) expect(zipEnclosedName(bad, 'linux')).toBeNull();
  });
  it('windows: "\\\\" and "/" separate; drive prefixes and leading separators are rejected', () => {
    expect(zipEnclosedName('a\\..\\b', 'win32')).toBe('a\\..\\b');
    for (const bad of ['a\\..\\..\\b', 'C:\\x', 'c:x', '\\x', '/x', '\\\\server\\share\\x']) expect(zipEnclosedName(bad, 'win32')).toBeNull();
  });
});
