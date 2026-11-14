/**
 * 流式 ZIP 读取核心：只把 EOCD 与中央目录读入内存，条目数据按需从 `ZipByteSource` 流式读取、解压并校验。
 *
 * 解析语义对齐 `zip 0.6.6` `ZipArchive<File>`：从文件尾向前找 EOCD；EOCD 前 20 字节若是 ZIP64
 * 定位器则改用 ZIP64 EOCD；按 EOCD 实际位置推算前置数据偏移；条目元数据只信中央目录，本地头只用来
 * 定位数据起点；读完条目时校验 CRC（`Invalid checksum`）。
 */
import {
  CENTRAL_DIRECTORY_HEADER_SIGNATURE, CENTRAL_DIRECTORY_HEADER_SIZE, END_OF_CENTRAL_DIRECTORY_SIGNATURE,
  END_OF_CENTRAL_DIRECTORY_SIZE, FLAG_ENCRYPTED, FLAG_UTF8, LOCAL_FILE_HEADER_SIGNATURE, LOCAL_FILE_HEADER_SIZE,
  METHOD_DEFLATED, METHOD_STORED, ZIP64_BYTES_THR, ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE,
  ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIZE, ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE,
  ZIP64_END_OF_CENTRAL_DIRECTORY_SIZE, ZIP64_EXTRA_FIELD_ID, ZipFormatError, decodeEntryName, readSafeU64, view,
  type ZipCompressionMethod,
} from './format.ts';
import { observeStream, readAllBytes, readExactly, sourceRangeStream, throughTransform, webZipCodec, type ZipByteSource, type ZipCodec } from './io.ts';

const READ_CHUNK = 1 << 20;
const DEFAULT_MAX_CENTRAL_DIRECTORY_BYTES = 256 * 1024 * 1024;

export interface ZipEntry {
  readonly index: number;
  /** 中央目录中的原始条目名（已按标志位解码）。 */
  readonly name: string;
  /** `ZipFile::is_dir`：名称以 `/` 或 `\` 结尾。 */
  readonly isDirectory: boolean;
  readonly method: number;
  readonly compression: ZipCompressionMethod | 'unsupported';
  readonly size: number;
  readonly compressedSize: number;
  readonly crc32: number;
  readonly flags: number;
  readonly versionMadeBy: number;
  readonly versionNeeded: number;
  readonly dosTime: number;
  readonly dosDate: number;
  readonly externalAttributes: number;
  /** 本地头的绝对偏移（已加上前置数据偏移）。 */
  readonly localHeaderOffset: number;
}

export interface ZipReaderOpenOptions {
  /** 条目数超过该值时在读取中央目录前失败。 */
  maxEntries?: number;
  /** 中央目录字节上限（防止伪造的超大中央目录占满内存）。默认 256 MiB。 */
  maxCentralDirectoryBytes?: number;
  /** 条目数超限时的错误工厂；默认抛 `ZipFormatError`。 */
  tooManyEntries?: (count: number, max: number) => Error;
  /** 默认 `webZipCodec`。 */
  codec?: ZipCodec;
}

export interface ZipEntryStreamOptions {
  /**
   * 每产出一段解压数据前调用；抛错即中止流（用于跨条目的实际解压预算）。
   * `total` 是本条目累计字节数。
   */
  onData?: (chunkBytes: number, total: number) => void;
}

export class ZipEntrySizeMismatchError extends Error {
  readonly expected: number;
  readonly actual: number;
  /** 实际字节数超过声明值时流被提前中止，`actual` 为中止时的下界。 */
  readonly truncated: boolean;
  constructor(entry: ZipEntry, actual: number, truncated: boolean) {
    super(`ZIP entry ${JSON.stringify(entry.name)} size mismatch: expected=${entry.size}, actual=${truncated ? '>' : ''}${actual}`);
    this.name = 'ZipEntrySizeMismatchError';
    this.expected = entry.size;
    this.actual = actual;
    this.truncated = truncated;
  }
}

interface DirectoryLocation {
  readonly archiveOffset: number;
  readonly directoryStart: number;
  readonly directorySize: number;
  readonly count: number;
}

async function locateCentralDirectory(source: ZipByteSource): Promise<DirectoryLocation> {
  const fileSize = source.size;
  if (fileSize < END_OF_CENTRAL_DIRECTORY_SIZE) throw new ZipFormatError('InvalidArchive', 'Invalid zip header');
  const tailLength = Math.min(fileSize, END_OF_CENTRAL_DIRECTORY_SIZE + 0xffff + ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIZE);
  const tailStart = fileSize - tailLength;
  const tail = view(await readExactly(source, tailStart, tailLength));
  let eocd = -1;
  const searchFloor = Math.max(0, tail.byteLength - END_OF_CENTRAL_DIRECTORY_SIZE - 0xffff);
  for (let index = tail.byteLength - END_OF_CENTRAL_DIRECTORY_SIZE; index >= searchFloor; index -= 1) {
    if (tail.getUint32(index, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) { eocd = index; break; }
  }
  if (eocd < 0) throw new ZipFormatError('InvalidArchive', 'Could not find central directory end');
  const cdeStart = tailStart + eocd;
  const diskNumber = tail.getUint16(eocd + 4, true);
  const diskWithDirectory = tail.getUint16(eocd + 6, true);
  if (diskNumber !== diskWithDirectory) {
    // boundary-allow todo-marker: zip 0.6.6 ZipError::UnsupportedArchive text verbatim.
    throw new ZipFormatError('UnsupportedArchive', 'Support for multi-disk files is not implemented');
  }
  const count32 = tail.getUint16(eocd + 8, true);
  const size32 = tail.getUint32(eocd + 12, true);
  const offset32 = tail.getUint32(eocd + 16, true);

  const locatorAt = eocd - ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIZE;
  if (locatorAt >= 0 && tail.getUint32(locatorAt, true) === ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE) {
    const nominal = readSafeU64(tail, locatorAt + 8);
    const searchUpperBound = cdeStart - 60;
    if (searchUpperBound < 0) throw new ZipFormatError('InvalidArchive', 'File cannot contain ZIP64 central directory end');
    if (nominal > searchUpperBound) throw new ZipFormatError('InvalidArchive', 'Could not find ZIP64 central directory end');
    // `Zip64CentralDirectoryEnd::find_and_parse` 从名义偏移向后逐字节找签名，以兼容前置数据。
    const windowLength = searchUpperBound - nominal + ZIP64_END_OF_CENTRAL_DIRECTORY_SIZE;
    const window = view(await readExactly(source, nominal, Math.min(windowLength, fileSize - nominal)));
    let found = -1;
    for (let index = 0; index + ZIP64_END_OF_CENTRAL_DIRECTORY_SIZE <= window.byteLength && nominal + index <= searchUpperBound; index += 1) {
      if (window.getUint32(index, true) === ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE) { found = index; break; }
    }
    if (found < 0) throw new ZipFormatError('InvalidArchive', 'Could not find ZIP64 central directory end');
    const zip64DiskNumber = window.getUint32(found + 16, true);
    const zip64DiskWithDirectory = window.getUint32(found + 20, true);
    if (zip64DiskNumber !== zip64DiskWithDirectory) {
      // boundary-allow todo-marker: zip 0.6.6 ZipError::UnsupportedArchive text verbatim.
      throw new ZipFormatError('UnsupportedArchive', 'Support for multi-disk files is not implemented');
    }
    const archiveOffset = found;
    const count = readSafeU64(window, found + 32);
    const directorySize = readSafeU64(window, found + 40);
    const directoryStart = readSafeU64(window, found + 48) + archiveOffset;
    return { archiveOffset, directoryStart, directorySize, count };
  }

  const archiveOffset = cdeStart - size32 - offset32;
  if (archiveOffset < 0) throw new ZipFormatError('InvalidArchive', 'Invalid central directory size or offset');
  return { archiveOffset, directoryStart: offset32 + archiveOffset, directorySize: size32, count: count32 };
}

function parseCentralDirectory(bytes: Uint8Array, count: number, archiveOffset: number): ZipEntry[] {
  const buffer = view(bytes);
  const entries: ZipEntry[] = [];
  let position = 0;
  for (let index = 0; index < count; index += 1) {
    if (position + CENTRAL_DIRECTORY_HEADER_SIZE > buffer.byteLength
      || buffer.getUint32(position, true) !== CENTRAL_DIRECTORY_HEADER_SIGNATURE) {
      throw new ZipFormatError('InvalidArchive', 'Invalid Central Directory header');
    }
    const versionMadeBy = buffer.getUint16(position + 4, true);
    const versionNeeded = buffer.getUint16(position + 6, true);
    const flags = buffer.getUint16(position + 8, true);
    const method = buffer.getUint16(position + 10, true);
    const dosTime = buffer.getUint16(position + 12, true);
    const dosDate = buffer.getUint16(position + 14, true);
    const crc = buffer.getUint32(position + 16, true);
    let compressedSize = buffer.getUint32(position + 20, true);
    let size = buffer.getUint32(position + 24, true);
    const nameLength = buffer.getUint16(position + 28, true);
    const extraLength = buffer.getUint16(position + 30, true);
    const commentLength = buffer.getUint16(position + 32, true);
    const externalAttributes = buffer.getUint32(position + 38, true);
    let localOffset = buffer.getUint32(position + 42, true);
    const nameStart = position + CENTRAL_DIRECTORY_HEADER_SIZE;
    const extraStart = nameStart + nameLength;
    const next = extraStart + extraLength + commentLength;
    if (next > buffer.byteLength) throw new ZipFormatError('InvalidArchive', 'Invalid Central Directory header');

    let cursor = extraStart;
    const extraEnd = extraStart + extraLength;
    while (cursor + 4 <= extraEnd) {
      const kind = buffer.getUint16(cursor, true);
      const length = buffer.getUint16(cursor + 2, true);
      const valueStart = cursor + 4;
      const valueEnd = valueStart + length;
      if (valueEnd > extraEnd) break;
      if (kind === ZIP64_EXTRA_FIELD_ID) {
        let field = valueStart;
        const take = (): number | null => {
          if (field + 8 > valueEnd) return null;
          const value = readSafeU64(buffer, field);
          field += 8;
          return value;
        };
        if (size === ZIP64_BYTES_THR) size = take() ?? size;
        if (compressedSize === ZIP64_BYTES_THR) compressedSize = take() ?? compressedSize;
        if (localOffset === ZIP64_BYTES_THR) localOffset = take() ?? localOffset;
      }
      cursor = valueEnd;
    }

    const name = decodeEntryName(bytes.subarray(nameStart, extraStart), (flags & FLAG_UTF8) !== 0);
    entries.push({
      index,
      name,
      isDirectory: name.endsWith('/') || name.endsWith('\\'),
      method,
      compression: method === METHOD_STORED ? 'stored' : method === METHOD_DEFLATED ? 'deflated' : 'unsupported',
      size,
      compressedSize,
      crc32: crc,
      flags,
      versionMadeBy,
      versionNeeded,
      dosTime,
      dosDate,
      externalAttributes,
      localHeaderOffset: localOffset + archiveOffset,
    });
    position = next;
  }
  return entries;
}

export class ZipReader {
  readonly size: number;
  readonly entries: readonly ZipEntry[];
  private readonly source: ZipByteSource;
  private readonly codec: ZipCodec;
  private readonly byName: Map<string, ZipEntry>;

  private constructor(source: ZipByteSource, codec: ZipCodec, entries: ZipEntry[]) {
    this.source = source;
    this.codec = codec;
    this.size = source.size;
    this.entries = entries;
    // `names_map.insert` 按顺序覆盖：同名条目 `by_name` 命中最后一个。
    this.byName = new Map(entries.map(entry => [entry.name, entry]));
  }

  /** 只读 EOCD 与中央目录；`source` 的生命周期由调用方管理。 */
  static async open(source: ZipByteSource, options: ZipReaderOpenOptions = {}): Promise<ZipReader> {
    const location = await locateCentralDirectory(source);
    if (options.maxEntries !== undefined && location.count > options.maxEntries) {
      throw options.tooManyEntries?.(location.count, options.maxEntries)
        ?? new ZipFormatError('InvalidArchive', `too many entries: ${location.count} > ${options.maxEntries}`);
    }
    const maxDirectory = options.maxCentralDirectoryBytes ?? DEFAULT_MAX_CENTRAL_DIRECTORY_BYTES;
    if (location.directorySize > maxDirectory) {
      throw new ZipFormatError('InvalidArchive', `central directory too large: ${location.directorySize} > ${maxDirectory}`);
    }
    if (location.directoryStart + location.directorySize > source.size) {
      throw new ZipFormatError('InvalidArchive', 'Invalid central directory size or offset');
    }
    const directory = location.directorySize === 0
      ? new Uint8Array(0)
      : await readExactly(source, location.directoryStart, location.directorySize);
    return new ZipReader(source, options.codec ?? webZipCodec, parseCentralDirectory(directory, location.count, location.archiveOffset));
  }

  /** `ZipArchive::file_names().any(..)`。 */
  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** `ZipArchive::by_name`。 */
  find(name: string): ZipEntry | undefined {
    return this.byName.get(name);
  }

  /**
   * 打开条目的解压流。流在产出超过中央目录声明大小的数据前即报错（防解压炸弹），
   * 结束时校验大小与 CRC。取消返回的流会一并停止解压和读取。
   */
  async openEntry(entry: ZipEntry, options: ZipEntryStreamOptions = {}): Promise<ReadableStream<Uint8Array>> {
    if ((entry.flags & FLAG_ENCRYPTED) !== 0) {
      throw new ZipFormatError('UnsupportedArchive', 'Password required to decrypt file');
    }
    const header = view(await readExactly(this.source, entry.localHeaderOffset, LOCAL_FILE_HEADER_SIZE));
    if (header.getUint32(0, true) !== LOCAL_FILE_HEADER_SIGNATURE) {
      throw new ZipFormatError('InvalidArchive', 'Invalid local file header');
    }
    if (entry.compression === 'unsupported') {
      throw new ZipFormatError('UnsupportedArchive', 'Compression method not supported');
    }
    const dataStart = entry.localHeaderOffset + LOCAL_FILE_HEADER_SIZE + header.getUint16(26, true) + header.getUint16(28, true);
    if (dataStart + entry.compressedSize > this.source.size) {
      throw new ZipFormatError('Io', 'failed to fill whole buffer');
    }
    let stream = sourceRangeStream(this.source, dataStart, entry.compressedSize, READ_CHUNK);
    if (entry.compression === 'deflated') stream = throughTransform(stream, this.codec.inflateRaw());

    const codec = this.codec;
    let total = 0;
    let crc = 0;
    return observeStream(stream, {
      chunk(chunk) {
        // RUST-FIX(RF-W08-zip-entry-overflow-aborts-early): zip 0.6.6 不按声明大小截断解压输出，Rust 读到 EOF 才比较。
        if (total + chunk.length > entry.size) throw new ZipEntrySizeMismatchError(entry, total + chunk.length, true);
        options.onData?.(chunk.length, total + chunk.length);
        total += chunk.length;
        crc = codec.crc32(chunk, crc);
      },
      end() {
        if (total !== entry.size) throw new ZipEntrySizeMismatchError(entry, total, false);
        if (crc !== entry.crc32) throw new ZipFormatError('Io', 'Invalid checksum');
      },
    });
  }

  /** 读出整个条目（只用于小条目，例如 manifest）。 */
  async readEntry(entry: ZipEntry): Promise<Uint8Array> {
    return readAllBytes(await this.openEntry(entry));
  }
}
