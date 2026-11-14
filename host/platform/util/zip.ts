/**
 * ZIP 读写（桌面专用子模块）：语义参照 `zip 0.6.6`（项目只启用 `deflate`，即 Stored/Deflated；
 * 无 ZIP64 写入/加密）。依赖 `node:zlib` 与 `Buffer`，不属于可移植入口；只经桌面入口 `node.ts` 导出。
 *
 * 新代码用可移植的 `platform/zip/core`（异步、流式、ZIP64）：在共同支持的选项上两者写出的字节相同、
 * 互相可读（`tests/zip-core-equivalence.test.ts`）。本文件只为仍是同步调用的导入方保留，迁完后删除。
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { crc32 } from './crc32.ts';

/** ZIP 压缩方法：与项目启用的 `zip 0.6` feature 一致（Stored + Deflated）。 */
export type ZipCompression = 'stored' | 'deflated';

export interface ZipFileOptions {
  /** 默认 `deflated`（`zip::write::FileOptions::default()`）。 */
  compression?: ZipCompression;
  /** Unix 权限；默认文件 0o644、目录 0o755（`zip 0.6` 默认值）。 */
  unixPermissions?: number;
  /** 最后修改时间；默认 1980-01-01（未启用 `time` feature 的 zip 0.6）。 */
  lastModified?: Date;
}

/** 中央目录中的条目元数据。 */
export interface ZipEntryInfo {
  readonly name: string;
  readonly compression: ZipCompression | 'unsupported';
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly crc32: number;
  readonly isDirectory: boolean;
  readonly lastModified: Date;
}

/** `ZipArchive.inspectByIndex` 的结果（`by_index` 的 `ZipFile` 元数据）。 */
export interface ZipIndexEntry extends ZipEntryInfo {
  readonly index: number;
  /** `ZipFile::unix_mode()`：Unix 取 external_attributes >> 16，DOS 由属性位合成，其他系统 / 属性为 0 → null。 */
  readonly unixMode: number | null;
  /** `ZipFile::enclosed_name()`：不安全路径 → null，否则为原条目名。 */
  readonly enclosedName: string | null;
}

/** `ZipArchive.read` 的选项。 */
export interface ZipReadOptions {
  /** 解压后的最大字节数；超过时 `node:zlib` 抛 `ERR_BUFFER_TOO_LARGE`。 */
  maxOutputLength?: number;
  /** 是否校验 CRC-32（默认 true，与 `zip 0.6` 的 `ZipFile` 读取一致）。 */
  verifyCrc?: boolean;
}

/** 一次 ZIP 写入的条目（`ZipWriter` 内部使用，也可直接传给 `writeZip`）。 */
export interface ZipInputEntry {
  readonly name: string;
  readonly data?: Uint8Array | string;
  readonly options?: ZipFileOptions;
  readonly directory?: boolean;
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const UTF8_FLAG = 0x0800;
const ZIP64_THRESHOLD = 0xffffffff;
const UNIX_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;
const DOS_DEFAULT = Date.UTC(1980, 0, 1);

/** `zip 0.6` 未启用 `time` feature 时的 DOS 时间（1980-01-01）。 */
function dosDateTime(value: Date | undefined): { time: number; date: number } {
  const date = value ?? new Date(DOS_DEFAULT);
  const year = date.getUTCFullYear();
  if (year < 1980 || year > 2107) {
    throw new RangeError(`ZIP DOS timestamp year out of range: ${year}`);
  }
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hour = date.getUTCHours();
  const minute = date.getUTCMinutes();
  const second = date.getUTCSeconds();
  return {
    time: (second >> 1) | (minute << 5) | (hour << 11),
    date: day | (month << 5) | ((year - 1980) << 9),
  };
}

function dosToDate(datePart: number, timePart: number): Date {
  const year = ((datePart >> 9) & 0x7f) + 1980;
  const month = (datePart >> 5) & 0x0f;
  const day = datePart & 0x1f;
  const hour = (timePart >> 11) & 0x1f;
  const minute = (timePart >> 5) & 0x3f;
  const second = (timePart & 0x1f) << 1;
  return new Date(Date.UTC(year, Math.max(0, month - 1), day, hour, minute, second));
}

function isAscii(value: string): boolean {
  return /^[\x00-\x7f]*$/.test(value);
}

interface WrittenEntry extends ZipEntryInfo {
  readonly externalAttributes: number;
  readonly localOffset: number;
  readonly method: number;
  readonly flags: number;
  readonly time: number;
  readonly date: number;
}

/** 与 `zip::ZipWriter` 相同的最小写入器：Stored/Deflated，无 ZIP64/加密。 */
export class ZipWriter {
  private readonly locals: Buffer[] = [];
  private readonly entries: WrittenEntry[] = [];
  private offset = 0;
  private finished = false;

  addFile(name: string, data: Uint8Array | string, options: ZipFileOptions = {}): this {
    return this.add(name, data, options, false);
  }

  addDirectory(name: string, options: ZipFileOptions = {}): this {
    // zip 0.6 `add_directory` 只在末尾不是 `/` 或 `\` 时补 `/`。
    const withSlash = name.endsWith('/') || name.endsWith('\\') ? name : `${name}/`;
    return this.add(withSlash, new Uint8Array(0), { ...options, compression: 'stored' }, true);
  }

  private add(name: string, data: Uint8Array | string, options: ZipFileOptions, directory: boolean): this {
    if (this.finished) throw new Error('ZipWriter was already closed');
    if (name.length === 0) throw new RangeError('ZIP entry name must not be empty');
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const compression: ZipCompression = directory ? 'stored' : options.compression ?? 'deflated';
    const method = compression === 'deflated' ? 8 : 0;
    const compressed = method === 8 ? deflateRawSync(bytes) : bytes;
    if (bytes.length > ZIP64_THRESHOLD || compressed.length > ZIP64_THRESHOLD) {
      throw new RangeError('ZIP64 archives are not supported by host/platform/util');
    }
    const crc = crc32(bytes);
    const nameBytes = Buffer.from(name, 'utf8');
    if (nameBytes.length > 0xffff) throw new RangeError('ZIP entry name too long');
    const flags = isAscii(name) ? 0 : UTF8_FLAG;
    const dir = directory || name.endsWith('/') || name.endsWith('\\');
    const permissions = dir
      ? (options.unixPermissions ?? 0o755) & 0o777
      : (options.unixPermissions ?? 0o644) & 0o777;
    const externalAttributes = (((dir ? UNIX_DIRECTORY : UNIX_FILE) | permissions) << 16) >>> 0;
    const stamp = dosDateTime(options.lastModified);

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);

    const localOffset = this.offset;
    this.locals.push(local, compressed);
    this.offset += local.length + compressed.length;
    this.entries.push({
      name,
      compression,
      method,
      compressedSize: compressed.length,
      size: bytes.length,
      crc32: crc,
      isDirectory: dir,
      lastModified: dosToDate(stamp.date, stamp.time),
      externalAttributes,
      localOffset,
      flags,
      time: stamp.time,
      date: stamp.date,
    });
    return this;
  }

  finish(): Buffer {
    if (this.finished) throw new Error('ZipWriter was already closed');
    this.finished = true;
    if (this.entries.length > 0xffff) throw new RangeError('ZIP64 archives are not supported by host/platform/util');
    if (this.offset > ZIP64_THRESHOLD) throw new RangeError('ZIP64 archives are not supported by host/platform/util');
    const central: Buffer[] = [];
    let centralSize = 0;
    for (const entry of this.entries) {
      const nameBytes = Buffer.from(entry.name, 'utf8');
      const header = Buffer.alloc(46 + nameBytes.length);
      header.writeUInt32LE(CENTRAL_SIGNATURE, 0);
      // system=Unix(3), version made by=46（zip 0.6 DEFAULT_VERSION）。
      header.writeUInt16LE((3 << 8) | 46, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(entry.flags, 8);
      header.writeUInt16LE(entry.method, 10);
      header.writeUInt16LE(entry.time, 12);
      header.writeUInt16LE(entry.date, 14);
      header.writeUInt32LE(entry.crc32, 16);
      header.writeUInt32LE(entry.compressedSize, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(nameBytes.length, 28);
      header.writeUInt16LE(0, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(entry.externalAttributes, 38);
      header.writeUInt32LE(entry.localOffset, 42);
      nameBytes.copy(header, 46);
      central.push(header);
      centralSize += header.length;
    }
    const centralOffset = this.offset;
    const centralDirectory = Buffer.concat(central, centralSize);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralOffset, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat([...this.locals, centralDirectory, eocd]);
  }
}

/** 一次性写入 ZIP。 */
export function writeZip(entries: readonly ZipInputEntry[]): Buffer {
  const writer = new ZipWriter();
  for (const entry of entries) {
    if (entry.directory === true) writer.addDirectory(entry.name, entry.options);
    else writer.addFile(entry.name, entry.data ?? new Uint8Array(0), entry.options);
  }
  return writer.finish();
}

function cp437(byte: number): string {
  if (byte < 0x80) return String.fromCharCode(byte);
  return CP437_HIGH[byte - 0x80]!;
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

interface RawEntry extends ZipEntryInfo {
  readonly localOffset: number;
  readonly flags: number;
  readonly versionMadeBy: number;
  readonly externalAttributes: number;
}

/** `zip 0.6.6` `ZipError`，`message` 为其 Display。 */
export class ZipError extends Error {
  readonly kind: 'Io' | 'InvalidArchive' | 'UnsupportedArchive' | 'FileNotFound';
  constructor(kind: ZipError['kind'], message: string) {
    super(message);
    this.name = 'ZipError';
    this.kind = kind;
  }
}

/** `ZipFile::unix_mode`（zip 0.6.6 read.rs）：external_attributes 为 0 → None；System 由 version_made_by 高字节决定。 */
function unixMode(versionMadeBy: number, externalAttributes: number): number | null {
  if (externalAttributes === 0) return null;
  const system = versionMadeBy >> 8;
  if (system === 3) return externalAttributes >>> 16;
  if (system === 0) {
    let mode = (externalAttributes & 0x10) === 0x10 ? 0o040000 | 0o0775 : 0o100000 | 0o0664;
    if ((externalAttributes & 0x01) === 0x01) mode &= 0o0555;
    return mode;
  }
  return null;
}

/**
 * `ZipFile::enclosed_name`：含 NUL、Prefix、RootDir 或 `..` 超出根 → null，否则返回原名称。
 * 组件划分按 Rust `Path::components` 的平台语义：Unix 只以 `/` 分隔（`\\` 是普通字符）；
 * Windows 以 `/` 与 `\\` 分隔，盘符 `C:` 与前导分隔符分别是 Prefix / RootDir。
 */
export function zipEnclosedName(name: string, platform: NodeJS.Platform = process.platform): string | null {
  if (name.includes('\0')) return null;
  const windows = platform === 'win32';
  if (windows ? /^([A-Za-z]:|[\\/])/.test(name) : name.startsWith('/')) return null;
  let depth = 0;
  for (const part of name.split(windows ? /[\\/]/ : '/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (depth === 0) return null; depth -= 1; } else depth += 1;
  }
  return name;
}

function decodeName(bytes: Buffer, utf8Flag: boolean): string {
  if (utf8Flag) return bytes.toString('utf8');
  let out = '';
  for (const byte of bytes) out += cp437(byte);
  return out;
}

function findEocd(buffer: Buffer): number {
  const earliest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let index = buffer.length - 22; index >= earliest; index -= 1) {
    if (buffer.readUInt32LE(index) === EOCD_SIGNATURE) return index;
  }
  throw new Error('invalid Zip archive: End of Central Directory not found');
}

function parseCentralEntries(buffer: Buffer, offset: number, count: number): RawEntry[] {
  const entries: RawEntry[] = [];
  let position = offset;
  for (let index = 0; index < count; index += 1) {
    if (position + 46 > buffer.length || buffer.readUInt32LE(position) !== CENTRAL_SIGNATURE) {
      throw new Error('invalid Zip archive: Invalid Central Directory header');
    }
    const versionMadeBy = buffer.readUInt16LE(position + 4);
    const flags = buffer.readUInt16LE(position + 8);
    const method = buffer.readUInt16LE(position + 10);
    const timePart = buffer.readUInt16LE(position + 12);
    const datePart = buffer.readUInt16LE(position + 14);
    const crc = buffer.readUInt32LE(position + 16);
    let compressedSize = buffer.readUInt32LE(position + 20);
    let size = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const externalAttributes = buffer.readUInt32LE(position + 38);
    let localOffset = buffer.readUInt32LE(position + 42);
    const nameStart = position + 46;
    const extraStart = nameStart + nameLength;
    const commentStart = extraStart + extraLength;
    if (commentStart + commentLength > buffer.length) throw new Error('invalid Zip archive: truncated central directory');
    const extra = buffer.subarray(extraStart, commentStart);
    let extraPosition = 0;
    while (extraPosition + 4 <= extra.length) {
      const kind = extra.readUInt16LE(extraPosition);
      const length = extra.readUInt16LE(extraPosition + 2);
      const valueStart = extraPosition + 4;
      if (valueStart + length > extra.length) break;
      if (kind === 0x0001) {
        let cursor = valueStart;
        const readU64 = (): number | null => {
          if (cursor + 8 > valueStart + length) return null;
          const value = Number(extra.readBigUInt64LE(cursor));
          cursor += 8;
          return value;
        };
        if (size === ZIP64_THRESHOLD) size = readU64() ?? size;
        if (compressedSize === ZIP64_THRESHOLD) compressedSize = readU64() ?? compressedSize;
        if (localOffset === ZIP64_THRESHOLD) localOffset = readU64() ?? localOffset;
      }
      extraPosition = valueStart + length;
    }
    const name = decodeName(buffer.subarray(nameStart, extraStart), (flags & UTF8_FLAG) !== 0);
    const compression: ZipCompression | 'unsupported' = method === 0 ? 'stored' : method === 8 ? 'deflated' : 'unsupported';
    entries.push({
      name,
      compression,
      method,
      compressedSize,
      size,
      crc32: crc,
      isDirectory: name.endsWith('/') || name.endsWith('\\'),
      lastModified: dosToDate(datePart, timePart),
      localOffset,
      flags,
      versionMadeBy,
      externalAttributes,
    });
    position = commentStart + commentLength;
  }
  return entries;
}

/** 只读 ZIP 归档；读取条目时校验 CRC（同 `zip::ZipFile`）。 */
export class ZipArchive {
  private readonly buffer: Buffer;
  readonly entries: readonly ZipEntryInfo[];
  private readonly raw: readonly RawEntry[];

  private constructor(
    buffer: Buffer,
    entries: readonly ZipEntryInfo[],
    raw: readonly RawEntry[],
  ) {
    this.buffer = buffer;
    this.entries = entries;
    this.raw = raw;
  }

  static from(bytes: Uint8Array): ZipArchive {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = findEocd(buffer);
    let count = buffer.readUInt16LE(eocd + 10);
    let centralSize = buffer.readUInt32LE(eocd + 12);
    let centralOffset = buffer.readUInt32LE(eocd + 16);
    if (count === 0xffff || centralSize === ZIP64_THRESHOLD || centralOffset === ZIP64_THRESHOLD) {
      if (eocd >= 20 && buffer.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIGNATURE) {
        const zip64Offset = Number(buffer.readBigUInt64LE(eocd - 20 + 8));
        if (zip64Offset + 56 <= buffer.length && buffer.readUInt32LE(zip64Offset) === ZIP64_EOCD_SIGNATURE) {
          count = Number(buffer.readBigUInt64LE(zip64Offset + 32));
          centralSize = Number(buffer.readBigUInt64LE(zip64Offset + 40));
          centralOffset = Number(buffer.readBigUInt64LE(zip64Offset + 48));
        }
      }
    }
    if (centralOffset + centralSize > buffer.length) throw new Error('invalid Zip archive: central directory out of bounds');
    const raw = parseCentralEntries(buffer, centralOffset, count);
    return new ZipArchive(buffer, raw, raw);
  }

  /** 按名称查找（同名条目返回第一个，与 `ZipArchive::by_name` 一致）。 */
  entry(name: string): ZipEntryInfo | null {
    return this.raw.find(entry => entry.name === name) ?? null;
  }

  /**
   * `ZipArchive::by_index(i)` 的元数据面（zip 0.6.6，无密码）：不解压、不校验 CRC。
   * 错误顺序与 Rust 相同：越界 FileNotFound → 加密 PASSWORD_REQUIRED → 本地头（`find_content`）
   * → 不支持的压缩方法。`enclosedName` 默认按当前平台的 Rust `Path` 语义。
   */
  inspectByIndex(index: number, options: { platform?: NodeJS.Platform } = {}): ZipIndexEntry {
    const raw = Number.isInteger(index) && index >= 0 ? this.raw[index] : undefined;
    if (raw === undefined) throw new ZipError('FileNotFound', 'specified file not found in archive');
    if ((raw.flags & 1) !== 0) throw new ZipError('UnsupportedArchive', 'unsupported Zip archive: Password required to decrypt file');
    const position = raw.localOffset;
    // find_content：read_u32 签名（不足 4 字节 → io UnexpectedEof），seek 22，再读两个 u16。
    if (position + 4 > this.buffer.length) throw new ZipError('Io', 'failed to fill whole buffer');
    if (this.buffer.readUInt32LE(position) !== LOCAL_SIGNATURE) throw new ZipError('InvalidArchive', 'invalid Zip archive: Invalid local file header');
    if (position + 30 > this.buffer.length) throw new ZipError('Io', 'failed to fill whole buffer');
    if (raw.compression === 'unsupported') throw new ZipError('UnsupportedArchive', 'unsupported Zip archive: Compression method not supported');
    return {
      name: raw.name, compression: raw.compression, method: raw.method, compressedSize: raw.compressedSize, size: raw.size,
      crc32: raw.crc32, isDirectory: raw.isDirectory, lastModified: raw.lastModified,
      index, unixMode: unixMode(raw.versionMadeBy, raw.externalAttributes),
      enclosedName: zipEnclosedName(raw.name, options.platform),
    };
  }

  read(nameOrEntry: string | ZipEntryInfo, options: ZipReadOptions = {}): Buffer {
    const target = typeof nameOrEntry === 'string' ? this.entry(nameOrEntry) : nameOrEntry;
    if (target === null) throw new Error(`Zip archive has no entry named ${JSON.stringify(nameOrEntry)}`);
    const raw = this.raw.find(entry => entry === target) ?? this.raw.find(entry => entry.name === target.name);
    if (raw === undefined) throw new Error(`Zip archive has no entry named ${JSON.stringify(target.name)}`);
    if ((raw.flags & 1) !== 0) throw new Error('encrypted Zip entries are not supported');
    if (raw.compression === 'unsupported') throw new Error(`unsupported Zip compression method ${raw.method}`);
    const position = raw.localOffset;
    if (position + 30 > this.buffer.length || this.buffer.readUInt32LE(position) !== LOCAL_SIGNATURE) {
      throw new Error('invalid Zip archive: Invalid local file header');
    }
    const nameLength = this.buffer.readUInt16LE(position + 26);
    const extraLength = this.buffer.readUInt16LE(position + 28);
    const start = position + 30 + nameLength + extraLength;
    const end = start + raw.compressedSize;
    if (start > this.buffer.length || end > this.buffer.length) throw new Error('invalid Zip archive: truncated entry data');
    const compressed = this.buffer.subarray(start, end);
    let data: Buffer;
    if (raw.method === 0) data = Buffer.from(compressed);
    else {
      data = inflateRawSync(compressed, options.maxOutputLength === undefined ? {} : { maxOutputLength: options.maxOutputLength });
    }
    if (options.verifyCrc !== false && crc32(data) !== raw.crc32) {
      throw new Error(`invalid Zip archive: CRC32 mismatch for ${JSON.stringify(raw.name)}`);
    }
    return data;
  }
}

/** 打开只读 ZIP。 */
export function readZip(bytes: Uint8Array): ZipArchive {
  return ZipArchive.from(bytes);
}
