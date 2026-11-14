/**
 * 备份 ZIP 的文件读写：归档本身、条目源文件和解压临时文件都经 `files.openFile` 的定位句柄
 * （W14 `RandomAccessFile`，结构上就是 `zip/core` 的 `ZipByteSource` + `ZipByteSink`），编解码用 `zip/core`。
 * 不 import Node 模块：桌面传 `ctx.files` + zlib 编解码，移动端传 OPFS 上的 `ctx.files` + Web 编解码。
 */
import { FileError, type FileGrant, type RandomAccessFile } from '../../../platform/files/api.ts';
import {
  sourceRangeStream, ZipReader, ZipWriter,
  type ZipChunkSource, type ZipCodec, type ZipEntry, type ZipEntryOptions, type ZipEntryStreamOptions,
  type ZipReaderOpenOptions, type ZipStreamEntryOptions, type ZipWrittenEntry,
} from '../../../platform/zip/core/index.ts';

const READ_CHUNK = 1 << 20;

/** 定位句柄中 ZIP 读写用到的部分。 */
export type ArchiveHandle = Pick<RandomAccessFile, 'size' | 'read' | 'write' | 'sync' | 'close'>;

/** `ctx.files` 中 ZIP 读写用到的部分；`isAllowed` / `grant` 只有完整的 `FilesService` 才有。 */
export interface ArchiveFiles {
  openFile(path: string, options?: { mode?: 'read' | 'exclusive' }): Promise<ArchiveHandle>;
  rm(path: string, options?: { force?: boolean }): Promise<void>;
  isAllowed?(path: string): Promise<boolean>;
  grant?(path: string): FileGrant;
}

export interface ArchiveIo {
  readonly files: ArchiveFiles;
  readonly codec: ZipCodec;
}

/**
 * 在调用期间放行用户选择的导入/导出路径，返回撤销函数。
 * 每次调用各持一份 grant：`isAllowed` 为 true 可能只是另一个进行中的操作临时放行了同一目录，
 * grant 没有引用计数，它先撤销后本操作就会失去放行。
 * 移动端没有 grant：允许根内照常访问，根外路径在这里抛 `UnsupportedOnPlatform`。
 */
export async function allowPath(files: ArchiveFiles, path: string): Promise<() => void> {
  if (files.isAllowed === undefined || files.grant === undefined) return () => undefined;
  const allowed = await files.isAllowed(path);
  let grant: FileGrant;
  try {
    grant = files.grant(path);
  } catch (error) {
    if (allowed && error instanceof FileError && error.kind === 'UnsupportedOnPlatform') return () => undefined;
    throw error;
  }
  return () => grant.revoke();
}

export interface ArchiveFileEntryOptions extends ZipEntryOptions {
  /** 打开源文件后、写入任何字节前回调；抛错即放弃该条目。 */
  verifyOpened?: (size: number, isFile: boolean) => void;
}

/** 直接写入目标文件的流式 ZIP；目标用 `exclusive` 打开，已存在时失败、不覆盖。 */
export class ArchiveWriter {
  readonly path: string;
  private readonly files: ArchiveFiles;
  private readonly handle: ArchiveHandle;
  private readonly core: ZipWriter;
  private closed: 'finished' | 'aborted' | null = null;

  private constructor(io: ArchiveIo, path: string, handle: ArchiveHandle) {
    this.path = path;
    this.files = io.files;
    this.handle = handle;
    this.core = new ZipWriter(handle, { codec: io.codec, label: 'ZipFileWriter' });
  }

  static async create(io: ArchiveIo, path: string): Promise<ArchiveWriter> {
    return new ArchiveWriter(io, path, await io.files.openFile(path, { mode: 'exclusive' }));
  }

  addDirectory(name: string): Promise<void> {
    this.assertNotClosed();
    return this.core.addDirectory(name);
  }

  addBuffer(name: string, data: Uint8Array | string, options: ZipEntryOptions = {}): Promise<ZipWrittenEntry> {
    this.assertNotClosed();
    return this.core.addBytes(name, data, options);
  }

  addStream(name: string, source: ZipChunkSource, options: ZipStreamEntryOptions = {}): Promise<ZipWrittenEntry> {
    this.assertNotClosed();
    return this.core.addStream(name, source, options);
  }

  /** 流式写入一个文件，读到 EOF 为止；返回的 `size` 是实际读到的字节数，调用方据此判断文件是否在导出期间变化。 */
  async addFile(name: string, sourcePath: string, options: ArchiveFileEntryOptions = {}): Promise<ZipWrittenEntry> {
    this.assertNotClosed();
    let source: ArchiveHandle;
    try {
      source = await this.files.openFile(sourcePath);
    } catch (error) {
      // fs `open(dir, 'r')` 成功后由 `isFile` 判定；`openFile` 对目录直接抛 `IsADirectory`。
      if (error instanceof FileError && error.kind === 'IsADirectory') options.verifyOpened?.(0, false);
      throw error;
    }
    try {
      options.verifyOpened?.(source.size, true);
      const chunks = sourceRangeStream(source, 0, undefined, READ_CHUNK);
      return await this.core.addStream(name, chunks, { ...options, sizeHint: source.size });
    } finally {
      await source.close();
    }
  }

  /** 写中央目录与 EOCD，可选 `sync()` 后关闭。返回 ZIP 总字节数。 */
  async finish(options: { sync?: boolean } = {}): Promise<number> {
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
    await this.files.rm(this.path, { force: true }).catch(() => undefined);
  }

  private assertNotClosed(): void {
    if (this.closed !== null) throw new Error(`ZipFileWriter is ${this.closed}`);
  }
}

/** 只读中央目录、条目按需流式解压的 ZIP 读取器。 */
export class ArchiveReader {
  readonly path: string;
  readonly fileSize: number;
  readonly entries: readonly ZipEntry[];
  private readonly handle: ArchiveHandle;
  private readonly core: ZipReader;
  private closed = false;

  private constructor(path: string, handle: ArchiveHandle, core: ZipReader) {
    this.path = path;
    this.handle = handle;
    this.core = core;
    this.fileSize = core.size;
    this.entries = core.entries;
  }

  static async open(io: ArchiveIo, path: string, options: Omit<ZipReaderOpenOptions, 'codec'> = {}): Promise<ArchiveReader> {
    const handle = await io.files.openFile(path);
    try {
      return new ArchiveReader(path, handle, await ZipReader.open(handle, { ...options, codec: io.codec }));
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  has(name: string): boolean {
    return this.core.has(name);
  }

  find(name: string): ZipEntry | undefined {
    return this.core.find(name);
  }

  async openEntry(entry: ZipEntry, options: ZipEntryStreamOptions = {}): Promise<ReadableStream<Uint8Array>> {
    if (this.closed) throw new Error('ZipFileReader is closed');
    return this.core.openEntry(entry, options);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }
}

/** 把流从偏移 0 起顺序写入句柄，返回写入字节数；写入失败时取消流（停止解压与读取）。 */
export async function writeStreamToFile(source: ReadableStream<Uint8Array>, handle: ArchiveHandle): Promise<number> {
  const reader = source.getReader();
  let position = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return position;
      await handle.write(value, position);
      position += value.length;
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
}
