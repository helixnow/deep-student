/**
 * Minimal ZIP reader/writer used by the skill package kernel.
 *
 * Rust uses the `zip` crate (skills.rs:1386–1535, skill_taps.rs). The host has no
 * Rust runtime, so this module re-implements the subset the migration needs:
 * end-of-central-directory preflight (including ZIP64/multi-disk rejection),
 * central-directory parsing, stored/deflate extraction, and a deterministic
 * writer for tap repacking.
 *
 * Writer parameters mirror `zip` 0.6.6 `FileOptions::default()` with
 * `Deflated` + `DateTime::default()`: version-made-by `(Unix<<8)|46`, version
 * needed 20, external attributes `0o100644 << 16`, level 6, MS-DOS 1980-01-01.
 * The deflate stream itself still comes from zlib instead of miniz_oxide, so
 * bytes may differ even with identical parameters; see SPEC.md.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { crc32Of, decodeCp437, readZipEntries, zipEntryCountPreflight, type ZipEntry } from './zip-entries.ts';

// The central-directory reader is portable (`zip-entries.ts`) because the mobile host and
// `fetch-executor`'s DOCX sniff need it without `node:zlib`; re-exported here unchanged.
export { decodeCp437, readZipEntries, zipEntryCountPreflight, crc32Of, type ZipEntry } from './zip-entries.ts';

// The scan limits are shared with the mobile installer (`src/mobile/zip.ts`).
export {
  DEFAULT_ZIP_SCAN_LIMITS, MAX_SKILL_PACKAGE_ZIP_BYTES, type ZipScanLimits,
} from './package-core.ts';

export class ZipBudgetExceeded extends Error {
  override name = 'ZipBudgetExceeded';
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

function invalid(message: string): never {
  throw new Error(`Invalid zip: ${message}`);
}

function entryCompressedBytes(bytes: Buffer, entry: ZipEntry): Buffer {
  const local = entry.localHeaderOffset;
  if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== LOCAL_SIGNATURE) {
    throw new Error(`Zip read error: invalid local file header for ${entry.name}`);
  }
  const nameLen = bytes.readUInt16LE(local + 26);
  const extraLen = bytes.readUInt16LE(local + 28);
  const start = local + 30 + nameLen + extraLen;
  return bytes.subarray(start, start + entry.compressedSize);
}

/**
 * Read one entry. `budget` mirrors `Read::take`: when the decompressed stream
 * reaches the budget, `ZipBudgetExceeded` is thrown (the Rust caller reads
 * budget+1 bytes and then compares it against the explicit limits).
 */
export function readZipEntry(zipBytes: Uint8Array, entry: ZipEntry, budget?: number): Uint8Array {
  if ((entry.flags & 0x0001) !== 0) {
    throw new Error('Zip read error: unsupported Zip archive: Password required to decrypt file');
  }
  if ((entry.flags & 0x0008) !== 0) {
    throw new Error('Zip read error: unsupported Zip archive: The file length is not available in the local header');
  }
  const bytes = Buffer.from(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const compressed = entryCompressedBytes(bytes, entry);
  let data: Buffer;
  if (entry.method === 0) {
    data = budget === undefined ? compressed : compressed.subarray(0, budget);
  } else if (entry.method === 8) {
    const options = budget === undefined ? {} : { maxOutputLength: Math.max(1, budget) };
    try {
      data = inflateRawSync(compressed, options);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new ZipBudgetExceeded('zip entry exceeded read budget');
      throw new Error(`Zip read error: ${(error as Error).message}`);
    }
  } else {
    throw new Error(`Zip read error: compression method ${entry.method} not supported`);
  }
  const truncated = budget !== undefined && data.length >= budget;
  if (!truncated) {
    const actual = crc32Of(data);
    if (actual !== entry.crc32) throw new Error(`Zip read error: invalid checksum for ${entry.name}`);
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export interface ZipWriteEntry {
  name: string;
  bytes: Uint8Array;
}

const DOS_DATE_1980_01_01 = 0x0021;
const DOS_TIME_MIDNIGHT = 0x0000;
/** `(System::Unix as u16) << 8 | zip::types::DEFAULT_VERSION (46)`. */
const VERSION_MADE_BY_UNIX = (3 << 8) | 46;
const VERSION_NEEDED_DEFLATE = 20;
/** `FileOptions::default()` permissions fallback `0o100644 << 16`. */
const EXTERNAL_ATTRIBUTES = 0o100644 * 0x10000;

/** Build a deterministic deflate zip. Used for tap repacking and tests. */
export function buildZip(files: readonly ZipWriteEntry[]): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const raw = Buffer.from(file.bytes);
    // flate2 `Compression::default()` is level 6.
    const data = deflateRawSync(raw, { level: 6 });
    const crc = crc32Of(raw);
    const flags = /[^\x00-\x7f]/.test(file.name) ? 0x0800 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(VERSION_NEEDED_DEFLATE, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME_MIDNIGHT, 10);
    local.writeUInt16LE(DOS_DATE_1980_01_01, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(VERSION_MADE_BY_UNIX, 4);
    central.writeUInt16LE(VERSION_NEEDED_DEFLATE, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME_MIDNIGHT, 12);
    central.writeUInt16LE(DOS_DATE_1980_01_01, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(EXTERNAL_ATTRIBUTES, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + data.length;
  }
  const centralOffset = offset;
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return new Uint8Array(Buffer.concat([...localParts, central, eocd]));
}
