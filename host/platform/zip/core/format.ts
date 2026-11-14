/**
 * ZIP 结构常量与编码细节，按 `zip 0.6.6`（Rust 端 `default-features = false, features = ["deflate"]`）
 * 的写出布局：`FileOptions::default()` 不带 `time` feature 时时间戳固定为 1980-01-01 00:00:00，
 * 文件 `0o100644`、目录 `0o40755`，`version made by` = Unix(3) << 8 | 46。
 *
 * 可移植：只用 ECMAScript、`Uint8Array` / `DataView` 与 `TextEncoder` / `TextDecoder`。
 */

export const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
export const CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
export const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
export const ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06064b50;
export const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE = 0x07064b50;

export const LOCAL_FILE_HEADER_SIZE = 30;
export const CENTRAL_DIRECTORY_HEADER_SIZE = 46;
export const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
export const ZIP64_END_OF_CENTRAL_DIRECTORY_SIZE = 56;
export const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIZE = 20;
export const ZIP64_EXTRA_FIELD_ID = 0x0001;

/** `spec::ZIP64_BYTES_THR`：32 位字段的上限，同时也是“值在 ZIP64 扩展字段里”的哨兵。 */
export const ZIP64_BYTES_THR = 0xffff_ffff;
/** `spec::ZIP64_ENTRY_THR`：EOCD 条目数字段的上限与哨兵。 */
export const ZIP64_ENTRY_THR = 0xffff;

export const FLAG_ENCRYPTED = 0x0001;
export const FLAG_DATA_DESCRIPTOR = 0x0008;
export const FLAG_UTF8 = 0x0800;

export const METHOD_STORED = 0;
export const METHOD_DEFLATED = 8;

/** `zip::write::DEFAULT_VERSION`。 */
export const DEFAULT_VERSION = 46;
export const VERSION_MADE_BY = (3 << 8) | DEFAULT_VERSION;
export const VERSION_NEEDED_DEFAULT = 20;
export const VERSION_NEEDED_ZIP64 = 45;

/** `DateTime::default()` = 1980-01-01 00:00:00。 */
export const DOS_TIME_DEFAULT = 0;
export const DOS_DATE_DEFAULT = (1 << 5) | 1;

export const UNIX_FILE_EXTERNAL_ATTRIBUTES = ((0o100000 | 0o644) << 16) >>> 0;
export const UNIX_DIRECTORY_EXTERNAL_ATTRIBUTES = ((0o040000 | 0o755) << 16) >>> 0;

export type ZipCompressionMethod = 'stored' | 'deflated';

/** `ZipError` 的 Display 分类（`zip 0.6.6`）。 */
export class ZipFormatError extends Error {
  readonly kind: 'InvalidArchive' | 'UnsupportedArchive' | 'Io';
  constructor(kind: ZipFormatError['kind'], message: string) {
    super(kind === 'InvalidArchive'
      ? `invalid Zip archive: ${message}`
      : kind === 'UnsupportedArchive' ? `unsupported Zip archive: ${message}` : message);
    this.name = 'ZipFormatError';
    this.kind = kind;
  }
}

/** slicing-by-8 查表：纯 JS 的 CRC-32（IEEE），桌面适配层可换成 zlib 原生实现。 */
const CRC32_TABLES = (() => {
  const tables = new Uint32Array(8 * 256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    tables[i] = value >>> 0;
  }
  for (let i = 0; i < 256; i += 1) {
    for (let slice = 1; slice < 8; slice += 1) {
      const previous = tables[(slice - 1) * 256 + i]!;
      tables[slice * 256 + i] = (previous >>> 8) ^ tables[previous & 0xff]!;
    }
  }
  return tables;
})();

/** 增量 CRC-32（IEEE）；`previous` 为上一段结果。 */
export function crc32Update(data: Uint8Array, previous = 0): number {
  const t = CRC32_TABLES;
  let crc = (previous ^ 0xffffffff) >>> 0;
  let i = 0;
  const fast = data.length - (data.length % 8);
  for (; i < fast; i += 8) {
    const low = (crc ^ (data[i]! | (data[i + 1]! << 8) | (data[i + 2]! << 16) | (data[i + 3]! << 24))) >>> 0;
    crc = t[7 * 256 + (low & 0xff)]! ^ t[6 * 256 + ((low >>> 8) & 0xff)]!
      ^ t[5 * 256 + ((low >>> 16) & 0xff)]! ^ t[4 * 256 + (low >>> 24)]!
      ^ t[3 * 256 + data[i + 4]!]! ^ t[2 * 256 + data[i + 5]!]!
      ^ t[256 + data[i + 6]!]! ^ t[data[i + 7]!]!;
  }
  for (; i < data.length; i += 1) crc = (crc >>> 8) ^ t[(crc ^ data[i]!) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

export function isAscii(value: string): boolean {
  return !/[\u0080-\uffff]/.test(value);
}

export function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** 读取 u64 并要求不超过 `Number.MAX_SAFE_INTEGER`（2^53 字节远超任何本地文件）。 */
export function readSafeU64(bytes: DataView, offset: number): number {
  const value = bytes.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipFormatError('InvalidArchive', 'ZIP64 value exceeds supported range');
  }
  return Number(value);
}

export function writeU64(bytes: DataView, offset: number, value: number): void {
  bytes.setBigUint64(offset, BigInt(value), true);
}

export function concatBytes(chunks: readonly Uint8Array[], total?: number): Uint8Array {
  const length = total ?? chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });

export function encodeUtf8(text: string): Uint8Array {
  return utf8Encoder.encode(text);
}

const CP437_HIGH = [
  '\u00c7', '\u00fc', '\u00e9', '\u00e2', '\u00e4', '\u00e0', '\u00e5', '\u00e7', '\u00ea', '\u00eb', '\u00e8', '\u00ef', '\u00ee', '\u00ec', '\u00c4', '\u00c5',
  '\u00c9', '\u00e6', '\u00c6', '\u00f4', '\u00f6', '\u00f2', '\u00fb', '\u00f9', '\u00ff', '\u00d6', '\u00dc', '\u00a2', '\u00a3', '\u00a5', '\u20a7', '\u0192',
  '\u00e1', '\u00ed', '\u00f3', '\u00fa', '\u00f1', '\u00d1', '\u00aa', '\u00ba', '\u00bf', '\u2310', '\u00ac', '\u00bd', '\u00bc', '\u00a1', '\u00ab', '\u00bb',
  '\u2591', '\u2592', '\u2593', '\u2502', '\u2524', '\u2561', '\u2562', '\u2556', '\u2555', '\u2563', '\u2551', '\u2557', '\u255d', '\u255c', '\u255b', '\u2510',
  '\u2514', '\u2534', '\u252c', '\u251c', '\u2500', '\u253c', '\u255e', '\u255f', '\u255a', '\u2554', '\u2569', '\u2566', '\u2560', '\u2550', '\u256c', '\u2567',
  '\u2568', '\u2564', '\u2565', '\u2559', '\u2558', '\u2552', '\u2553', '\u256b', '\u256a', '\u2518', '\u250c', '\u2588', '\u2584', '\u258c', '\u2590', '\u2580',
  '\u03b1', '\u00df', '\u0393', '\u03c0', '\u03a3', '\u03c3', '\u00b5', '\u03c4', '\u03a6', '\u0398', '\u03a9', '\u03b4', '\u221e', '\u03c6', '\u03b5', '\u2229',
  '\u2261', '\u00b1', '\u2265', '\u2264', '\u2320', '\u2321', '\u00f7', '\u2248', '\u00b0', '\u2219', '\u00b7', '\u221a', '\u207f', '\u00b2', '\u25a0', '\u00a0',
];

/** 条目名解码：UTF-8 标志位置位时按 UTF-8（替换非法序列），否则按 CP437（同 `zip 0.6.6`）。 */
export function decodeEntryName(bytes: Uint8Array, utf8: boolean): string {
  if (utf8) return utf8Decoder.decode(bytes);
  let out = '';
  for (const byte of bytes) out += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80]!;
  return out;
}
