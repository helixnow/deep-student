/**
 * 桌面文件适配层：把可移植核心（`../core`）接到 Node 文件句柄与 zlib 上。
 *
 * - `nodeZipCodec`：zlib raw deflate/inflate（支持压缩级别，256 KiB 输出块）与原生 `zlib.crc32`；
 * - `fileZipSource` / `fileZipSink`：按偏移读写 `FileHandle`（异步 I/O）；
 * - `ZipFileWriter` / `ZipFileReader`：按路径打开文件的便捷包装，API 与迁移前一致
 *   （`openEntryStream` 返回 Node `Readable`、`readEntry` 返回 `Buffer`），另有返回 Web 流的 `openEntry`。
 */
import { open, rm, type FileHandle } from 'node:fs/promises';
import { Duplex, Readable } from 'node:stream';
import * as zlib from 'node:zlib';
import { crc32Update } from '../core/format.ts';
import { sourceRangeStream, type ZipByteSink, type ZipByteSource, type ZipChunkSource, type ZipCodec, type ZipTransform } from '../core/io.ts';
import { ZipReader, type ZipEntry, type ZipEntryStreamOptions, type ZipReaderOpenOptions } from '../core/reader.ts';
import { ZipWriter, type ZipEntryOptions, type ZipStreamEntryOptions, type ZipWrittenEntry } from '../core/writer.ts';

const READ_CHUNK = 1 << 20;
const ZLIB_CHUNK = 256 * 1024;

const nativeCrc32 = (zlib as { crc32?: (data: Uint8Array, value?: number) => number }).crc32;

/**
 * `Duplex.toWeb` 的读端取消后不再检查已取消：pull 已排好的 `resume` 仍会把 zlib 缓冲里的块
 * enqueue 进已关闭的 controller，抛出未捕获的 ERR_INVALID_STATE。取消前先停掉 flowing。
 */
function zlibTransform(stream: zlib.DeflateRaw | zlib.InflateRaw): ZipTransform {
  const pair = Duplex.toWeb(stream) as unknown as ZipTransform;
  const reader = pair.readable.getReader();
  const readable = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      stream.pause();
      return reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
  return { readable, writable: pair.writable };
}

export const nodeZipCodec: ZipCodec = {
  deflateRaw(level) {
    return zlibTransform(zlib.createDeflateRaw({ chunkSize: ZLIB_CHUNK, ...(level === undefined ? {} : { level }) }));
  },
  inflateRaw() {
    return zlibTransform(zlib.createInflateRaw({ chunkSize: ZLIB_CHUNK }));
  },
  crc32: nativeCrc32 === undefined ? crc32Update : (data, previous) => nativeCrc32(data, previous) >>> 0,
};

/** 按偏移读取文件句柄；不持有句柄。`size` 只用于 ZIP 读取定位，读取本身读到真实 EOF 为止。 */
export function fileZipSource(handle: FileHandle, size: number): ZipByteSource {
  return {
    size,
    async read(position, length) {
      const buffer = Buffer.allocUnsafe(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return filled === length ? buffer : buffer.subarray(0, filled);
    },
  };
}

export function fileZipSink(handle: FileHandle): ZipByteSink {
  return {
    async write(data, position) {
      let written = 0;
      while (written < data.length) {
        const { bytesWritten } = await handle.write(data, written, data.length - written, position + written);
        if (bytesWritten <= 0) throw new Error('ZIP write made no progress');
        written += bytesWritten;
      }
    },
  };
}

export interface ZipFileEntryOptions extends ZipEntryOptions {
  /** 打开源文件后、写入任何字节前回调；抛错即放弃该条目。 */
  verifyOpened?: (size: number, isFile: boolean) => void;
}

export interface ZipWriterFinishOptions {
  /** 关闭前 `fsync`（`File::sync_all`）。默认 true。 */
  sync?: boolean;
}

export interface ZipWriterCreateOptions {
  /** 默认 `wx`：目标已存在时失败，避免覆盖。 */
  flags?: 'w' | 'wx';
}

/** 直接写入目标文件的流式 ZIP 写入器（异步 I/O，不在内存中拼整包）。 */
export class ZipFileWriter {
  readonly path: string;
  private readonly handle: FileHandle;
  private readonly core: ZipWriter;
  private closed: 'finished' | 'aborted' | null = null;

  private constructor(path: string, handle: FileHandle) {
    this.path = path;
    this.handle = handle;
    this.core = new ZipWriter(fileZipSink(handle), { codec: nodeZipCodec, label: 'ZipFileWriter' });
  }

  static async create(path: string, options: ZipWriterCreateOptions = {}): Promise<ZipFileWriter> {
    const handle = await open(path, options.flags ?? 'wx');
    return new ZipFileWriter(path, handle);
  }

  /** 已写出（含缓冲）的字节数。 */
  get offset(): number {
    return this.core.offset;
  }

  get entryCount(): number {
    return this.core.entryCount;
  }

  addDirectory(name: string): Promise<void> {
    this.assertNotClosed();
    return this.core.addDirectory(name);
  }

  addBuffer(name: string, data: Uint8Array | string, options: ZipEntryOptions = {}): Promise<ZipWrittenEntry> {
    this.assertNotClosed();
    return this.core.addBytes(name, data, options);
  }

  /** `source` 可以是 Node `Readable`、任意（异步）可迭代对象或 `ReadableStream`。 */
  addStream(name: string, source: ZipChunkSource, options: ZipStreamEntryOptions = {}): Promise<ZipWrittenEntry> {
    this.assertNotClosed();
    return this.core.addStream(name, source, options);
  }

  /**
   * 流式写入磁盘文件。返回的 `size` 是实际读到的字节数（读到 EOF，同 `std::io::copy`），
   * 调用方据此判断文件是否在导出期间变化。
   */
  async addFile(name: string, sourcePath: string, options: ZipFileEntryOptions = {}): Promise<ZipWrittenEntry> {
    this.assertNotClosed();
    const source = await open(sourcePath, 'r');
    try {
      const stat = await source.stat();
      options.verifyOpened?.(stat.size, stat.isFile());
      const chunks = sourceRangeStream(fileZipSource(source, stat.size), 0, undefined, READ_CHUNK);
      return await this.core.addStream(name, chunks, { ...options, sizeHint: stat.size });
    } finally {
      await source.close();
    }
  }

  /** 写中央目录与 EOCD，可选 fsync 后关闭。返回 ZIP 总字节数。 */
  async finish(options: ZipWriterFinishOptions = {}): Promise<number> {
    this.assertNotClosed();
    const total = await this.core.finish();
    if (options.sync !== false) await this.handle.sync();
    await this.handle.close();
    this.closed = 'finished';
    return total;
  }

  /** 关闭句柄并删除目标文件（失败路径的清理，不抛错）。 */
  async abort(): Promise<void> {
    if (this.closed !== null) return;
    this.closed = 'aborted';
    await this.handle.close().catch(() => undefined);
    await rm(this.path, { force: true }).catch(() => undefined);
  }

  private assertNotClosed(): void {
    if (this.closed !== null) throw new Error(`ZipFileWriter is ${this.closed}`);
  }
}

/** 按路径打开的流式 ZIP 读取器：只读中央目录，条目按需流式解压。 */
export class ZipFileReader {
  readonly path: string;
  readonly fileSize: number;
  readonly entries: readonly ZipEntry[];
  private readonly handle: FileHandle;
  private readonly core: ZipReader;
  private closed = false;

  private constructor(path: string, handle: FileHandle, core: ZipReader) {
    this.path = path;
    this.handle = handle;
    this.core = core;
    this.fileSize = core.size;
    this.entries = core.entries;
  }

  static async open(path: string, options: Omit<ZipReaderOpenOptions, 'codec'> = {}): Promise<ZipFileReader> {
    const handle = await open(path, 'r');
    try {
      const stat = await handle.stat();
      const core = await ZipReader.open(fileZipSource(handle, stat.size), { ...options, codec: nodeZipCodec });
      return new ZipFileReader(path, handle, core);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  /** `ZipArchive::file_names().any(..)`。 */
  has(name: string): boolean {
    return this.core.has(name);
  }

  /** `ZipArchive::by_name`。 */
  find(name: string): ZipEntry | undefined {
    return this.core.find(name);
  }

  /** 条目解压流（Web 流）；语义见 `ZipReader.openEntry`。 */
  async openEntry(entry: ZipEntry, options: ZipEntryStreamOptions = {}): Promise<ReadableStream<Uint8Array>> {
    if (this.closed) throw new Error('ZipFileReader is closed');
    return this.core.openEntry(entry, options);
  }

  /** 同 `openEntry`，返回 Node `Readable`。 */
  async openEntryStream(entry: ZipEntry, options: ZipEntryStreamOptions = {}): Promise<Readable> {
    return Readable.fromWeb(await this.openEntry(entry, options) as Parameters<typeof Readable.fromWeb>[0]);
  }

  /** 读出整个条目（只用于小条目，例如 manifest）。 */
  async readEntry(entry: ZipEntry): Promise<Buffer> {
    if (this.closed) throw new Error('ZipFileReader is closed');
    const bytes = await this.core.readEntry(entry);
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }
}
