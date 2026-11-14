/**
 * 流式 ZIP 写入核心：写入 `ZipByteSink`（随机访问），条目数据边读边压缩，不在内存中拼整包。
 *
 * 布局与 `zip 0.6.6` `ZipWriter<File>` 一致：本地头先写占位，条目结束后回填 CRC 与大小
 * （不使用数据描述符），中央目录按需带 ZIP64 扩展字段，条目数或偏移越界时写 ZIP64 EOCD。
 * 已知条目大小（`sizeHint`）可能越过 4GiB 时自动按 `large_file=true` 写出。
 */
import {
  CENTRAL_DIRECTORY_HEADER_SIGNATURE, CENTRAL_DIRECTORY_HEADER_SIZE, DOS_DATE_DEFAULT, DOS_TIME_DEFAULT,
  END_OF_CENTRAL_DIRECTORY_SIGNATURE, END_OF_CENTRAL_DIRECTORY_SIZE, FLAG_UTF8, LOCAL_FILE_HEADER_SIGNATURE,
  LOCAL_FILE_HEADER_SIZE, METHOD_DEFLATED, METHOD_STORED, UNIX_DIRECTORY_EXTERNAL_ATTRIBUTES,
  UNIX_FILE_EXTERNAL_ATTRIBUTES, VERSION_MADE_BY, VERSION_NEEDED_DEFAULT, VERSION_NEEDED_ZIP64,
  ZIP64_BYTES_THR, ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE, ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIZE,
  ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE, ZIP64_END_OF_CENTRAL_DIRECTORY_SIZE, ZIP64_ENTRY_THR,
  ZIP64_EXTRA_FIELD_ID, ZipFormatError, concatBytes, encodeUtf8, isAscii, view, writeU64, type ZipCompressionMethod,
} from './format.ts';
import { observeStream, throughTransform, toReadableStream, webZipCodec, type ZipByteSink, type ZipChunkSource, type ZipCodec } from './io.ts';

const FLUSH_THRESHOLD = 1 << 20;

export interface ZipEntryOptions {
  /** 默认 `deflated`（`zip 0.6.6` 启用 deflate feature 时的默认方法）。 */
  compression?: ZipCompressionMethod;
  /** 压缩级别；省略时为 zlib 默认级别（6），与 `FileOptions::default()` 的 flate2 默认一致。 */
  level?: number;
  /** 强制按 `large_file=true` 写出本地头 ZIP64 扩展字段。 */
  zip64?: boolean;
  /** 每段未压缩数据写入前回调（例如同一遍读取里顺带计算 SHA-256）；抛错即放弃该条目。 */
  onData?: (chunk: Uint8Array) => void;
}

export interface ZipStreamEntryOptions extends ZipEntryOptions {
  /** 预期的未压缩字节数，用于决定是否需要本地头 ZIP64 字段。 */
  sizeHint?: number;
}

export interface ZipWrittenEntry {
  readonly name: string;
  readonly size: number;
  readonly compressedSize: number;
  readonly crc32: number;
}

export interface ZipWriterOptions {
  /** 默认 `webZipCodec`。 */
  codec?: ZipCodec;
  /** 状态错误里使用的类名（桌面适配层沿用 `ZipFileWriter`）。 */
  label?: string;
}

export type ZipWriterState = 'open' | 'failed' | 'finished';

interface CentralRecord {
  readonly nameBytes: Uint8Array;
  readonly flags: number;
  readonly method: number;
  readonly crc32: number;
  readonly size: number;
  readonly compressedSize: number;
  readonly headerStart: number;
  readonly externalAttributes: number;
}

function deflateBound(size: number): number {
  return size + Math.floor(size / 4096) + Math.floor(size / 16384) + Math.floor(size / 33_554_432) + 1024;
}

// RUST-FIX(RF-W08-zip64-large-entry-without-error): Rust 导出用 large_file=false，任何 >=4GiB 的文件都让导出失败。
function needsLargeFile(size: number | undefined, method: number): boolean {
  if (size === undefined) return false;
  return size >= ZIP64_BYTES_THR || (method === METHOD_DEFLATED && deflateBound(size) >= ZIP64_BYTES_THR);
}

function centralZip64Extra(record: CentralRecord): Uint8Array {
  const fields: number[] = [];
  // 32 位字段写入 0xFFFFFFFF 时读取方必须能在扩展字段里找到真实值，因此边界值本身也进 ZIP64。
  if (record.size >= ZIP64_BYTES_THR) fields.push(record.size);
  if (record.compressedSize >= ZIP64_BYTES_THR) fields.push(record.compressedSize);
  if (record.headerStart >= ZIP64_BYTES_THR) fields.push(record.headerStart);
  if (fields.length === 0) return new Uint8Array(0);
  const extra = new Uint8Array(4 + fields.length * 8);
  const v = view(extra);
  v.setUint16(0, ZIP64_EXTRA_FIELD_ID, true);
  v.setUint16(2, fields.length * 8, true);
  fields.forEach((value, index) => writeU64(v, 4 + index * 8, value));
  return extra;
}

function clamp32(value: number): number {
  return value >= ZIP64_BYTES_THR ? ZIP64_BYTES_THR : value;
}

export class ZipWriter {
  private readonly sink: ZipByteSink;
  private readonly codec: ZipCodec;
  private readonly label: string;
  private readonly records: CentralRecord[] = [];
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  /** 已写入 sink 的字节数；`pending` 从该偏移开始。 */
  private flushedOffset = 0;
  private busy = false;
  private currentState: ZipWriterState = 'open';

  constructor(sink: ZipByteSink, options: ZipWriterOptions = {}) {
    this.sink = sink;
    this.codec = options.codec ?? webZipCodec;
    this.label = options.label ?? 'ZipWriter';
  }

  get state(): ZipWriterState {
    return this.currentState;
  }

  /** 已写出（含缓冲）的字节数。 */
  get offset(): number {
    return this.flushedOffset + this.pendingBytes;
  }

  get entryCount(): number {
    return this.records.length;
  }

  /** `ZipWriter::add_directory`：末尾不是 `/` 或 `\` 时补 `/`，固定 Stored。 */
  async addDirectory(name: string): Promise<void> {
    const withSlash = name.endsWith('/') || name.endsWith('\\') ? name : `${name}/`;
    await this.run(async () => {
      await this.writeEntry(withSlash, null, METHOD_STORED, undefined, false, UNIX_DIRECTORY_EXTERNAL_ATTRIBUTES);
    });
  }

  /** 字符串按 UTF-8 编码。 */
  async addBytes(name: string, data: Uint8Array | string, options: ZipEntryOptions = {}): Promise<ZipWrittenEntry> {
    const bytes = typeof data === 'string' ? encodeUtf8(data) : data;
    return this.addStream(name, bytes.length === 0 ? [] : [bytes], { ...options, sizeHint: bytes.length });
  }

  async addStream(name: string, source: ZipChunkSource, options: ZipStreamEntryOptions = {}): Promise<ZipWrittenEntry> {
    const method = (options.compression ?? 'deflated') === 'deflated' ? METHOD_DEFLATED : METHOD_STORED;
    const large = options.zip64 === true || needsLargeFile(options.sizeHint, method);
    return this.run(() => this.writeEntry(name, source, method, options.level, large, UNIX_FILE_EXTERNAL_ATTRIBUTES, options.onData));
  }

  /** 写中央目录与 EOCD 并全部写入 sink。返回 ZIP 总字节数。 */
  async finish(): Promise<number> {
    return this.run(async () => {
      const centralStart = this.offset;
      for (const record of this.records) this.push(this.centralHeader(record));
      await this.flushIfNeeded();
      const centralSize = this.offset - centralStart;
      const count = this.records.length;
      // RUST-FIX(RF-W08-zip64-eocd-at-65535-entries): zip 0.6.6 在恰好 65535 条时写 0xFFFF 哨兵却不写 ZIP64 记录，JSZip 等读不了。
      if (count >= ZIP64_ENTRY_THR || centralStart >= ZIP64_BYTES_THR || centralSize >= ZIP64_BYTES_THR) {
        const zip64End = new Uint8Array(ZIP64_END_OF_CENTRAL_DIRECTORY_SIZE);
        const e = view(zip64End);
        e.setUint32(0, ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
        writeU64(e, 4, ZIP64_END_OF_CENTRAL_DIRECTORY_SIZE - 12);
        e.setUint16(12, 46, true);
        e.setUint16(14, 46, true);
        e.setUint32(16, 0, true);
        e.setUint32(20, 0, true);
        writeU64(e, 24, count);
        writeU64(e, 32, count);
        writeU64(e, 40, centralSize);
        writeU64(e, 48, centralStart);
        this.push(zip64End);
        const locator = new Uint8Array(ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIZE);
        const l = view(locator);
        l.setUint32(0, ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE, true);
        l.setUint32(4, 0, true);
        writeU64(l, 8, centralStart + centralSize);
        l.setUint32(16, 1, true);
        this.push(locator);
      }
      const end = new Uint8Array(END_OF_CENTRAL_DIRECTORY_SIZE);
      const d = view(end);
      d.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
      d.setUint16(4, 0, true);
      d.setUint16(6, 0, true);
      d.setUint16(8, Math.min(count, ZIP64_ENTRY_THR), true);
      d.setUint16(10, Math.min(count, ZIP64_ENTRY_THR), true);
      d.setUint32(12, clamp32(centralSize), true);
      d.setUint32(16, clamp32(centralStart), true);
      d.setUint16(20, 0, true);
      this.push(end);
      await this.flush();
      this.currentState = 'finished';
      return this.flushedOffset;
    });
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.currentState !== 'open') throw new Error(`${this.label} is ${this.currentState}`);
    if (this.busy) throw new Error(`${this.label} does not support concurrent writes`);
    this.busy = true;
    try {
      return await operation();
    } catch (error) {
      this.currentState = 'failed';
      throw error;
    } finally {
      this.busy = false;
    }
  }

  private async writeEntry(
    name: string,
    source: ZipChunkSource | null,
    method: number,
    level: number | undefined,
    large: boolean,
    externalAttributes: number,
    onData?: (chunk: Uint8Array) => void,
  ): Promise<ZipWrittenEntry> {
    if (name.length === 0) throw new RangeError('ZIP entry name must not be empty');
    const nameBytes = encodeUtf8(name);
    if (nameBytes.length > 0xffff) throw new RangeError('ZIP entry name too long');
    const flags = isAscii(name) ? 0 : FLAG_UTF8;
    const headerStart = this.offset;

    const header = new Uint8Array(LOCAL_FILE_HEADER_SIZE + nameBytes.length + (large ? 20 : 0));
    const h = view(header);
    h.setUint32(0, LOCAL_FILE_HEADER_SIGNATURE, true);
    h.setUint16(4, large || headerStart > ZIP64_BYTES_THR ? VERSION_NEEDED_ZIP64 : VERSION_NEEDED_DEFAULT, true);
    h.setUint16(6, flags, true);
    h.setUint16(8, method, true);
    h.setUint16(10, DOS_TIME_DEFAULT, true);
    h.setUint16(12, DOS_DATE_DEFAULT, true);
    h.setUint32(14, 0, true);
    h.setUint32(18, large ? ZIP64_BYTES_THR : 0, true);
    h.setUint32(22, large ? ZIP64_BYTES_THR : 0, true);
    h.setUint16(26, nameBytes.length, true);
    h.setUint16(28, large ? 20 : 0, true);
    header.set(nameBytes, LOCAL_FILE_HEADER_SIZE);
    if (large) {
      h.setUint16(LOCAL_FILE_HEADER_SIZE + nameBytes.length, ZIP64_EXTRA_FIELD_ID, true);
      h.setUint16(LOCAL_FILE_HEADER_SIZE + nameBytes.length + 2, 16, true);
    }
    this.push(header);
    const dataStart = this.offset;

    let crc = 0;
    let size = 0;
    if (source !== null) {
      const codec = this.codec;
      let stream = observeStream(toReadableStream(source), {
        chunk(chunk) {
          onData?.(chunk);
          crc = codec.crc32(chunk, crc);
          size += chunk.length;
        },
      });
      if (method === METHOD_DEFLATED) stream = throughTransform(stream, codec.deflateRaw(level));
      const reader = stream.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          this.push(value);
          await this.flushIfNeeded();
        }
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        throw error;
      }
    }
    const compressedSize = this.offset - dataStart;
    if (!large && (size > ZIP64_BYTES_THR || compressedSize > ZIP64_BYTES_THR)) {
      throw new ZipFormatError('Io', 'Large file option has not been set');
    }

    const patch = new Uint8Array(large ? 20 : 12);
    const p = view(patch);
    p.setUint32(0, crc, true);
    if (large) {
      writeU64(p, 4, size);
      writeU64(p, 12, compressedSize);
      await this.patchAt(header, headerStart, 14, patch.subarray(0, 4));
      await this.patchAt(header, headerStart, LOCAL_FILE_HEADER_SIZE + nameBytes.length + 4, patch.subarray(4));
    } else {
      p.setUint32(4, compressedSize, true);
      p.setUint32(8, size, true);
      await this.patchAt(header, headerStart, 14, patch);
    }

    this.records.push({ nameBytes, flags, method, crc32: crc, size, compressedSize, headerStart, externalAttributes });
    return { name, size, compressedSize, crc32: crc };
  }

  private centralHeader(record: CentralRecord): Uint8Array {
    const extra = centralZip64Extra(record);
    const zip64 = record.size > ZIP64_BYTES_THR || record.compressedSize > ZIP64_BYTES_THR || record.headerStart > ZIP64_BYTES_THR;
    const header = new Uint8Array(CENTRAL_DIRECTORY_HEADER_SIZE + record.nameBytes.length + extra.length);
    const h = view(header);
    h.setUint32(0, CENTRAL_DIRECTORY_HEADER_SIGNATURE, true);
    h.setUint16(4, VERSION_MADE_BY, true);
    h.setUint16(6, zip64 ? VERSION_NEEDED_ZIP64 : VERSION_NEEDED_DEFAULT, true);
    h.setUint16(8, record.flags, true);
    h.setUint16(10, record.method, true);
    h.setUint16(12, DOS_TIME_DEFAULT, true);
    h.setUint16(14, DOS_DATE_DEFAULT, true);
    h.setUint32(16, record.crc32, true);
    h.setUint32(20, clamp32(record.compressedSize), true);
    h.setUint32(24, clamp32(record.size), true);
    h.setUint16(28, record.nameBytes.length, true);
    h.setUint16(30, extra.length, true);
    h.setUint16(32, 0, true);
    h.setUint16(34, 0, true);
    h.setUint16(36, 0, true);
    h.setUint32(38, record.externalAttributes, true);
    h.setUint32(42, clamp32(record.headerStart), true);
    header.set(record.nameBytes, CENTRAL_DIRECTORY_HEADER_SIZE);
    header.set(extra, CENTRAL_DIRECTORY_HEADER_SIZE + record.nameBytes.length);
    return header;
  }

  /** 头部仍在缓冲区时直接改内存，否则按偏移回写 sink。 */
  private async patchAt(header: Uint8Array, headerStart: number, relative: number, bytes: Uint8Array): Promise<void> {
    if (headerStart >= this.flushedOffset) {
      header.set(bytes, relative);
      return;
    }
    await this.sink.write(bytes, headerStart + relative);
  }

  private push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
  }

  private async flushIfNeeded(): Promise<void> {
    if (this.pendingBytes >= FLUSH_THRESHOLD) await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.pendingBytes === 0) return;
    const data = this.pending.length === 1 ? this.pending[0]! : concatBytes(this.pending, this.pendingBytes);
    const position = this.flushedOffset;
    this.pending = [];
    this.pendingBytes = 0;
    await this.sink.write(data, position);
    this.flushedOffset = position + data.length;
  }
}
