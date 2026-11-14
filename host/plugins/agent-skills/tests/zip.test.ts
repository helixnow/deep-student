import { describe, expect, it } from 'vitest';
import { buildZip, decodeCp437, readZipEntries, readZipEntry } from '../src/zip.ts';

function withCentralFlags(zip: Uint8Array, flags: number): Uint8Array {
  const bytes = Buffer.from(zip);
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt16LE(flags, central + 8);
  const local = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  bytes.writeUInt16LE(flags, local + 6);
  return new Uint8Array(bytes);
}

describe('zip.rs compatibility', () => {
  it('writes zip_0_6_file_options_default_headers', () => {
    const bytes = buildZip([{ name: 'SKILL.md', bytes: new TextEncoder().encode('# skill\n') }]);
    const central = Buffer.from(bytes).indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(central).toBeGreaterThan(0);
    expect(Buffer.from(bytes).readUInt16LE(central + 4)).toBe((3 << 8) | 46);
    expect(Buffer.from(bytes).readUInt16LE(central + 6)).toBe(20);
    expect(Buffer.from(bytes).readUInt16LE(central + 12)).toBe(0);
    expect(Buffer.from(bytes).readUInt16LE(central + 14)).toBe(0x21);
    expect(Buffer.from(bytes).readUInt32LE(central + 38)).toBe(0o100644 * 0x10000);
  });

  it('decodeCp437_matches_zip_cp437_table', () => {
    expect(decodeCp437(Uint8Array.from([0x80, 0x82, 0x9e, 0xe1, 0xff]))).toBe('Çé₧ß\u00a0');
  });

  it('readZipEntries_falls_back_to_cp437_without_utf8_flag', () => {
    const bytes = buildZip([{ name: 'cafX.txt', bytes: new TextEncoder().encode('x') }]);
    const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const central = view.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const centralName = view.subarray(central + 46, central + 46 + 8);
    expect(centralName.toString()).toBe('cafX.txt');
    view.writeUInt8(0x82, central + 46 + 3);
    const entries = readZipEntries(bytes);
    expect(entries[0]!.name).toBe('café.txt');
    expect(entries[0]!.flags & 0x0800).toBe(0);
  });

  it('readZipEntry_rejects_encrypted_entry_like_zip_crate', () => {
    const encrypted = withCentralFlags(
      buildZip([{ name: 'SKILL.md', bytes: new TextEncoder().encode('secret') }]),
      0x0001,
    );
    const entry = readZipEntries(encrypted)[0]!;
    expect(() => readZipEntry(encrypted, entry))
      .toThrow('Zip read error: unsupported Zip archive: Password required to decrypt file');
  });

  it('readZipEntry_rejects_data_descriptor_entry_like_zip_crate', () => {
    const streamed = withCentralFlags(
      buildZip([{ name: 'SKILL.md', bytes: new TextEncoder().encode('streamed') }]),
      0x0008,
    );
    const entry = readZipEntries(streamed)[0]!;
    expect(() => readZipEntry(streamed, entry))
      .toThrow('Zip read error: unsupported Zip archive: The file length is not available in the local header');
  });
});
