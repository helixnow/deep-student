/**
 * Portable ZIP central-directory reader (names + metadata only; no decompression).
 *
 * `zip.ts` keeps the Node-only pieces (`node:zlib` inflate/deflate and `Buffer`-based entry
 * reads) and re-exports everything here, so desktop behaviour and its tests are unchanged.
 * The mobile host and `fetch-executor`'s DOCX sniff only need the entry list, which this
 * module reads with `DataView` and Web-standard `TextDecoder`.
 *
 * Byte layout and error texts mirror `zip 0.6.6` (`ZipArchive::new`), same as `zip.ts`.
 */

export interface ZipEntry {
  name: string;
  isDirectory: boolean;
  /** Declared uncompressed size from the central directory (can be forged). */
  size: number;
  compressedSize: number;
  method: number;
  flags: number;
  crc32: number;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_FIXED_BYTES = 22;
const MAX_ZIP_COMMENT_BYTES = 0xffff;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;

function invalid(message: string): never {
  throw new Error(`Invalid zip: ${message}`);
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Port of skills.rs:1340 `zip_entry_count_preflight`. */
export function zipEntryCountPreflight(zipBytes: Uint8Array): number {
  const bytes = view(zipBytes);
  if (bytes.byteLength < EOCD_FIXED_BYTES) {
    return invalid('missing end-of-central-directory record');
  }
  const searchStart = Math.max(0, bytes.byteLength - (EOCD_FIXED_BYTES + MAX_ZIP_COMMENT_BYTES));
  const searchEnd = bytes.byteLength - EOCD_FIXED_BYTES;
  for (let offset = searchEnd; offset >= searchStart; offset--) {
    if (bytes.getUint32(offset, true) !== EOCD_SIGNATURE) continue;
    const commentLen = bytes.getUint16(offset + 20, true);
    if (offset + EOCD_FIXED_BYTES + commentLen !== bytes.byteLength) continue;
    if (offset >= 20 && bytes.getUint32(offset - 20, true) === ZIP64_LOCATOR_SIGNATURE) {
      throw new Error('ZIP64 skill packages are not supported');
    }
    const diskNumber = bytes.getUint16(offset + 4, true);
    const centralDisk = bytes.getUint16(offset + 6, true);
    const entriesOnDisk = bytes.getUint16(offset + 8, true);
    const totalEntries = bytes.getUint16(offset + 10, true);
    if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
      throw new Error('Multi-disk skill packages are not supported');
    }
    if (totalEntries === 0xffff) {
      throw new Error('ZIP64 skill packages are not supported');
    }
    return totalEntries;
  }
  return invalid('missing end-of-central-directory record');
}

interface EndOfCentralDirectory {
  totalEntries: number;
  centralSize: number;
  centralOffset: number;
}

function findEndOfCentralDirectory(bytes: DataView): EndOfCentralDirectory {
  if (bytes.byteLength < EOCD_FIXED_BYTES) invalid('missing end-of-central-directory record');
  const searchStart = Math.max(0, bytes.byteLength - (EOCD_FIXED_BYTES + MAX_ZIP_COMMENT_BYTES));
  const searchEnd = bytes.byteLength - EOCD_FIXED_BYTES;
  for (let offset = searchEnd; offset >= searchStart; offset--) {
    if (bytes.getUint32(offset, true) !== EOCD_SIGNATURE) continue;
    const commentLen = bytes.getUint16(offset + 20, true);
    if (offset + EOCD_FIXED_BYTES + commentLen !== bytes.byteLength) continue;
    return {
      totalEntries: bytes.getUint16(offset + 10, true),
      centralSize: bytes.getUint32(offset + 12, true),
      centralOffset: bytes.getUint32(offset + 16, true),
    };
  }
  return invalid('missing end-of-central-directory record');
}

const CP437_HIGH = [
  0x00c7, 0x00fc, 0x00e9, 0x00e2, 0x00e4, 0x00e0, 0x00e5, 0x00e7,
  0x00ea, 0x00eb, 0x00e8, 0x00ef, 0x00ee, 0x00ec, 0x00c4, 0x00c5,
  0x00c9, 0x00e6, 0x00c6, 0x00f4, 0x00f6, 0x00f2, 0x00fb, 0x00f9,
  0x00ff, 0x00d6, 0x00dc, 0x00a2, 0x00a3, 0x00a5, 0x20a7, 0x0192,
  0x00e1, 0x00ed, 0x00f3, 0x00fa, 0x00f1, 0x00d1, 0x00aa, 0x00ba,
  0x00bf, 0x2310, 0x00ac, 0x00bd, 0x00bc, 0x00a1, 0x00ab, 0x00bb,
  0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x2561, 0x2562, 0x2556,
  0x2555, 0x2563, 0x2551, 0x2557, 0x255d, 0x255c, 0x255b, 0x2510,
  0x2514, 0x2534, 0x252c, 0x251c, 0x2500, 0x253c, 0x255e, 0x255f,
  0x255a, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256c, 0x2567,
  0x2568, 0x2564, 0x2565, 0x2559, 0x2558, 0x2552, 0x2553, 0x256b,
  0x256a, 0x2518, 0x250c, 0x2588, 0x2584, 0x258c, 0x2590, 0x2580,
  0x03b1, 0x00df, 0x0393, 0x03c0, 0x03a3, 0x03c3, 0x00b5, 0x03c4,
  0x03a6, 0x0398, 0x03a9, 0x03b4, 0x221e, 0x03c6, 0x03b5, 0x2229,
  0x2261, 0x00b1, 0x2265, 0x2264, 0x2320, 0x2321, 0x00f7, 0x2248,
  0x00b0, 0x2219, 0x00b7, 0x221a, 0x207f, 0x00b2, 0x25a0, 0x00a0,
] as const;

/** `zip::cp437::FromCp437` — CP437 when the UTF-8 flag is clear. */
export function decodeCp437(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += String.fromCodePoint(byte < 0x80 ? byte : CP437_HIGH[byte - 0x80]!);
  }
  return out;
}

function decodeEntryName(raw: Uint8Array, flags: number): string {
  // The zip crate decodes CP437 when the UTF-8 flag is absent and lossy UTF-8
  // when it is present.
  return (flags & 0x0800) !== 0 ? new TextDecoder('utf-8').decode(raw) : decodeCp437(raw);
}

/** Parse the central directory. Throws `Invalid zip: …` like `ZipArchive::new`. */
export function readZipEntries(zipBytes: Uint8Array): ZipEntry[] {
  const bytes = view(zipBytes);
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd.totalEntries === 0xffff) throw new Error('ZIP64 skill packages are not supported');
  if (eocd.centralOffset + eocd.centralSize > bytes.byteLength) invalid('central directory out of bounds');
  const entries: ZipEntry[] = [];
  let offset = eocd.centralOffset;
  for (let index = 0; index < eocd.totalEntries; index++) {
    if (offset + 46 > bytes.byteLength || bytes.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      invalid('invalid central directory header');
    }
    const flags = bytes.getUint16(offset + 8, true);
    const method = bytes.getUint16(offset + 10, true);
    const crc = bytes.getUint32(offset + 16, true);
    const compressedSize = bytes.getUint32(offset + 20, true);
    const size = bytes.getUint32(offset + 24, true);
    const nameLen = bytes.getUint16(offset + 28, true);
    const extraLen = bytes.getUint16(offset + 30, true);
    const commentLen = bytes.getUint16(offset + 32, true);
    const localHeaderOffset = bytes.getUint32(offset + 42, true);
    if (offset + 46 + nameLen > bytes.byteLength) invalid('truncated central directory name');
    const name = decodeEntryName(zipBytes.subarray(offset + 46, offset + 46 + nameLen), flags);
    entries.push({
      name,
      isDirectory: name.endsWith('/'),
      size,
      compressedSize,
      method,
      flags,
      crc32: crc,
      localHeaderOffset,
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
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

export function crc32Of(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
