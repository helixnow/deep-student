/**
 * APKG 的最小 ZIP 读写实现（`apkg_exporter_service.rs:1866-2072` 的 `zip` crate 用法，
 * 以及 `apkg_importer_service.rs` 的 `ZipArchive` 只读扫描）。
 *
 * APKG 是一个 zip 包：`collection.anki2` + `media` + 数字命名的媒体条目。
 * 这里只实现 stored / deflate 条目、无加密、无 zip64 的普通包，读写语义与 `zip` crate
 * 的 `FileOptions::default()`（deflated + 1980-01-01 时间戳）一致。
 *
 * 归档大小受 `MAX_APKG_ARCHIVE_BYTES`（256 MiB）限制，远小于 4 GiB，因此不需要 zip64。
 * 字节层只依赖 `Uint8Array`（`src/bytes.ts`）与纯函数 CRC-32；deflate 由本地运行时端口提供
 * （桌面 `node:zlib`，移动端不注入——APKG 能力降级）。
 */
import { crc32 } from '../../../platform/util/crc32.ts';
import { decodeUtf8Lossy } from '../../../platform/util/utf8.ts';
import { concatBytes, latin1Decode, readU16LE, readU32LE, writeU16LE, writeU32LE } from './bytes.ts';
import { ankiLocalRuntime } from './local-runtime.ts';

export { crc32 };

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const VERSION_NEEDED = 20;
const METHOD_DEFLATE = 8;
const FLAG_UTF8 = 0x0800;
/** 1980-01-01 00:00:00（DOS 时间），与 `zip::DateTime::default()` 一致。 */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

const UTF8_ENCODER = new TextEncoder();

/** 打包为 zip（所有条目 deflate 压缩）。 */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const centralEntries: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = UTF8_ENCODER.encode(entry.name);
    const compressed = ankiLocalRuntime().deflateRaw(entry.data);
    const checksum = crc32(entry.data);

    const local = new Uint8Array(30);
    writeU32LE(local, LOCAL_HEADER_SIGNATURE, 0);
    writeU16LE(local, VERSION_NEEDED, 4);
    writeU16LE(local, FLAG_UTF8, 6);
    writeU16LE(local, METHOD_DEFLATE, 8);
    writeU16LE(local, DOS_TIME, 10);
    writeU16LE(local, DOS_DATE, 12);
    writeU32LE(local, checksum, 14);
    writeU32LE(local, compressed.length, 18);
    writeU32LE(local, entry.data.length, 22);
    writeU16LE(local, name.length, 26);
    writeU16LE(local, 0, 28);
    chunks.push(local, name, compressed);

    const central = new Uint8Array(46);
    writeU32LE(central, CENTRAL_HEADER_SIGNATURE, 0);
    writeU16LE(central, VERSION_NEEDED, 4);
    writeU16LE(central, VERSION_NEEDED, 6);
    writeU16LE(central, FLAG_UTF8, 8);
    writeU16LE(central, METHOD_DEFLATE, 10);
    writeU16LE(central, DOS_TIME, 12);
    writeU16LE(central, DOS_DATE, 14);
    writeU32LE(central, checksum, 16);
    writeU32LE(central, compressed.length, 20);
    writeU32LE(central, entry.data.length, 24);
    writeU16LE(central, name.length, 28);
    writeU16LE(central, 0, 30);
    writeU16LE(central, 0, 32);
    writeU16LE(central, 0, 34);
    writeU16LE(central, 0, 36);
    writeU32LE(central, 0, 38);
    writeU32LE(central, offset, 42);
    centralEntries.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralDirectory = concatBytes(centralEntries);
  const eocd = new Uint8Array(22);
  writeU32LE(eocd, EOCD_SIGNATURE, 0);
  writeU16LE(eocd, 0, 4);
  writeU16LE(eocd, 0, 6);
  writeU16LE(eocd, entries.length, 8);
  writeU16LE(eocd, entries.length, 10);
  writeU32LE(eocd, centralDirectory.length, 12);
  writeU32LE(eocd, offset, 16);
  writeU16LE(eocd, 0, 20);

  return concatBytes([...chunks, centralDirectory, eocd]);
}

// ============================================================================
// 有界归档扫描（`apkg_importer_service.rs:453-528`、`1150-1184` 的 `ZipArchive` 用法）
// ============================================================================

/** 归档扫描/条目读取失败原因：与 Rust 侧错误码映射一一对应。 */
export type ZipErrorKind = 'archive' | 'open' | 'limit' | 'decompress';

/** 归档读取错误（调用方按 `kind` 映射到 APKG 错误码与文案）。 */
export class ZipError extends Error {
  readonly kind: ZipErrorKind;
  constructor(kind: ZipErrorKind, message: string) {
    super(message);
    this.name = 'ZipError';
    this.kind = kind;
  }
}

/** 中央目录里的一个条目（位于 zip 索引空间的固定位置）。 */
export interface ZipArchiveEntry {
  readonly index: number;
  readonly name: string;
  readonly method: number;
  /** 中央目录声明的解压后字节数（`ZipFile::size()`）。 */
  readonly declaredSize: number;
  readonly compressedSize: number;
  readonly crc: number;
  readonly localHeaderOffset: number;
}

const METHOD_STORE = 0;

/**
 * 只读 zip 归档：先完整扫描中央目录（条目数、名称、声明大小），
 * 再按索引/名称做有界读取。`by_name` 语义与 `zip` crate 一致——重名时取最后一个。
 */
export class ZipArchiveReader {
  private readonly data: Uint8Array;
  private readonly entries: readonly ZipArchiveEntry[];
  private readonly lastIndexByName: Map<string, number>;

  private constructor(data: Uint8Array, entries: ZipArchiveEntry[], lastIndexByName: Map<string, number>) {
    this.data = data;
    this.entries = entries;
    this.lastIndexByName = lastIndexByName;
  }

  /** 解析中央目录；失败抛 {@link ZipError}（kind = `archive`）。 */
  static open(data: Uint8Array): ZipArchiveReader {
    const eocd = findEocd(data);
    if (eocd < 0) {
      throw new ZipError('archive', 'invalid Zip archive: Could not find central directory end');
    }
    const entryCount = readU16LE(data, eocd + 10);
    const centralSize = readU32LE(data, eocd + 12);
    const centralOffset = readU32LE(data, eocd + 16);
    if (centralOffset + centralSize > data.length) {
      throw new ZipError('archive', 'invalid Zip archive: central directory is out of bounds');
    }

    const entries: ZipArchiveEntry[] = [];
    const lastIndexByName = new Map<string, number>();
    let cursor = centralOffset;
    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > data.length) {
        throw new ZipError('archive', 'invalid Zip archive: truncated central directory');
      }
      if (readU32LE(data, cursor) !== CENTRAL_HEADER_SIGNATURE) {
        throw new ZipError('archive', 'invalid Zip archive: Invalid central directory header signature');
      }
      const flags = readU16LE(data, cursor + 8);
      const method = readU16LE(data, cursor + 10);
      const crc = readU32LE(data, cursor + 16);
      const compressedSize = readU32LE(data, cursor + 20);
      const declaredSize = readU32LE(data, cursor + 24);
      const nameLength = readU16LE(data, cursor + 28);
      const extraLength = readU16LE(data, cursor + 30);
      const commentLength = readU16LE(data, cursor + 32);
      const localHeaderOffset = readU32LE(data, cursor + 42);
      if (cursor + 46 + nameLength > data.length) {
        throw new ZipError('archive', 'invalid Zip archive: truncated entry name');
      }
      const nameBytes = data.subarray(cursor + 46, cursor + 46 + nameLength);
      const name = decodeEntryName(nameBytes, flags);
      entries.push({ index, name, method, declaredSize, compressedSize, crc, localHeaderOffset });
      // `zip` crate 的 `name_to_index` 后写覆盖先写，因此 `by_name` 取最后一个。
      lastIndexByName.set(name, index);
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return new ZipArchiveReader(data, entries, lastIndexByName);
  }

  get length(): number {
    return this.entries.length;
  }

  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /** `archive.by_index(index)`：索引越界 / 本地头损坏时抛 {@link ZipError}（kind = `open`）。 */
  entry(index: number): ZipArchiveEntry {
    const entry = this.entries[index];
    if (entry === undefined) {
      throw new ZipError('open', `invalid Zip archive: could not find directory entry ${index}`);
    }
    return entry;
  }

  /** `archive.by_name(name)` 的索引（重名取最后一个）；不存在返回 undefined。 */
  findLastIndexByName(name: string): number | undefined {
    return this.lastIndexByName.get(name);
  }

  /**
   * 读取一个条目并解压。
   *
   * - 传入 `limit` 时最多接受 `limit` 字节（`read_zip_entry_bounded` 的 `limit+1` 语义），
   *   超出抛 kind = `limit`；
   * - 不传 `limit` 时以中央目录声明大小为上界（`zip` crate 会校验解压尺寸），
   *   超出或 CRC 不符抛 kind = `decompress`。
   */
  readEntry(index: number, limit?: number): Uint8Array {
    const entry = this.entry(index);
    if (entry.localHeaderOffset + 30 > this.data.length) {
      throw new ZipError('open', 'invalid Zip archive: truncated local file header');
    }
    if (readU32LE(this.data, entry.localHeaderOffset) !== LOCAL_HEADER_SIGNATURE) {
      throw new ZipError('open', 'invalid Zip archive: Invalid local file header signature');
    }
    const localNameLength = readU16LE(this.data, entry.localHeaderOffset + 26);
    const localExtraLength = readU16LE(this.data, entry.localHeaderOffset + 28);
    const dataStart = entry.localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > this.data.length) {
      throw new ZipError('decompress', 'invalid Zip archive: entry data is out of bounds');
    }
    const payload = this.data.subarray(dataStart, dataEnd);

    if (entry.method !== METHOD_STORE && entry.method !== METHOD_DEFLATE) {
      throw new ZipError('decompress', `unsupported Zip compression method ${entry.method}`);
    }

    const maxOutputLength = (limit ?? entry.declaredSize) + 1;
    let bytes: Uint8Array;
    if (entry.method === METHOD_STORE) {
      bytes = payload.slice();
    } else {
      try {
        bytes = ankiLocalRuntime().inflateRaw(payload, maxOutputLength);
      } catch (error) {
        if (errorCode(error) === 'ERR_BUFFER_TOO_LARGE') {
          throw new ZipError(limit === undefined ? 'decompress' : 'limit', 'invalid Zip archive: uncompressed size exceeds the declared size');
        }
        throw new ZipError('decompress', errorText(error));
      }
    }

    if (limit !== undefined && bytes.length > limit) {
      throw new ZipError('limit', `entry exceeds the ${limit} byte limit`);
    }
    if (limit === undefined && bytes.length > entry.declaredSize) {
      throw new ZipError('decompress', 'invalid Zip archive: uncompressed size exceeds the declared size');
    }
    if (crc32(bytes) !== entry.crc) {
      throw new ZipError('decompress', 'invalid Zip archive: Invalid checksum');
    }
    return bytes;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code as string | undefined : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** zip 通用标志位第 11 位：文件名为 UTF-8；否则按单字节编码解码（CP437 的 ASCII 子集）。 */
function decodeEntryName(bytes: Uint8Array, flags: number): string {
  return (flags & FLAG_UTF8) !== 0 ? decodeUtf8Lossy(bytes) : latin1Decode(bytes);
}

/** 读取 zip 全部条目（APKG 测试与诊断用）。 */
export function readZip(data: Uint8Array): Map<string, Uint8Array> {
  const eocdOffset = findEocd(data);
  if (eocdOffset < 0) throw new Error('不是有效的 zip 文件');
  const entryCount = readU16LE(data, eocdOffset + 10);
  const centralOffset = readU32LE(data, eocdOffset + 16);

  const entries = new Map<string, Uint8Array>();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (readU32LE(data, cursor) !== CENTRAL_HEADER_SIGNATURE) {
      throw new Error('zip 中央目录损坏');
    }
    const method = readU16LE(data, cursor + 10);
    const compressedSize = readU32LE(data, cursor + 20);
    const nameLength = readU16LE(data, cursor + 28);
    const extraLength = readU16LE(data, cursor + 30);
    const commentLength = readU16LE(data, cursor + 32);
    const localOffset = readU32LE(data, cursor + 42);
    const name = decodeUtf8Lossy(data.subarray(cursor + 46, cursor + 46 + nameLength));

    if (readU32LE(data, localOffset) !== LOCAL_HEADER_SIGNATURE) {
      throw new Error('zip 本地文件头损坏');
    }
    const localNameLength = readU16LE(data, localOffset + 26);
    const localExtraLength = readU16LE(data, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const payload = data.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === METHOD_DEFLATE
      ? ankiLocalRuntime().inflateRaw(payload)
      : payload.slice());

    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEocd(data: Uint8Array): number {
  const lowest = Math.max(0, data.length - 65_557);
  for (let offset = data.length - 22; offset >= lowest; offset -= 1) {
    if (readU32LE(data, offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}
