/**
 * `ctx.files` 移动端实现：OPFS（Origin Private File System），运行在 Host 所在的 Web Worker 里。接口见 ./api.ts。
 *
 * 映射：POSIX 风味的绝对路径按组件对应 OPFS 根目录下的目录句柄，`/deep-student/a.txt` = `<OPFS>/deep-student/a.txt`。
 * SQLite 的 `opfs-sahpool` 目录（`.deep-student`）不在任何允许根内，数据库只能经 `ctx.storage` 访问。
 *
 * 与桌面实现的差异（都按显式规则处理，不静默降级）：
 * - 包含判断只有词法一道：OPFS 没有符号链接，词法路径就是真实路径；
 * - 写入用 `FileSystemSyncAccessHandle`（只在 Worker 中可用），同一文件同时只能有一个写入者，
 *   被占用时抛 `Other`（`osCode` = `NoModificationAllowedError`）；没有同步访问句柄时抛 `UnsupportedOnPlatform`；
 *   `openFile` 的写入模式在 `close()` 之前一直占用；`read` 模式不取同步访问句柄，每次读取用 `getFile()` 的当前内容；
 * - `writeAtomic`、`openWrite({ mode: 'atomic' })` 与文件 `rename` 用 `FileSystemFileHandle.move()`（覆盖已有文件，原子）；
 *   目录句柄没有 `move()`（Chromium）时目录 `rename` 抛 `UnsupportedOnPlatform`，不退化成复制 + 删除；
 * - `grant()` 抛 `UnsupportedOnPlatform`：用户选择的文件在移动端经外壳以内容传入，不是 OPFS 路径；
 * - `unixMode` / `durable` / `followSymlinks` 没有对应概念：写入总会 `flush()`，`stat().unixMode` 与 `createdMs` 为 null，
 *   目录的 `size` 与 `modifiedMs` 为 0（OPFS 不记录目录元数据）；
 * - 独占写（`exclusive`、`overwrite: false`）是先查后写，Host 单 Worker 内没有并发写者时等价。
 */
import { UNSUPPORTED_ON_PLATFORM_PREFIX, unsupportedOnPlatformMessage } from '../errors/unsupported-on-platform.ts';
import {
  FileError,
  type DirEntry,
  type FileErrorKind,
  type FileGrant,
  type FileOperation,
  type FileOperations,
  type FileRoot,
  type FileScope,
  type FilesService,
  type FileStat,
  type OpenFileMode,
  type RandomAccessFile,
  type WalkEntry,
  type WalkOptions,
} from './api.ts';
import {
  childOf,
  defaultBackupRoot,
  formatPath,
  isWithin,
  parseAbsolute,
  parseRelative,
  relativePath,
  samePath,
  type ParsedPath,
  type PathProblem,
} from './path.ts';

/** `File` 中用到的部分（`getFile()` 返回调用时刻的快照）。 */
export interface OpfsFile {
  readonly size: number;
  readonly lastModified: number;
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

/** `FileSystemSyncAccessHandle` 中用到的部分。 */
export interface OpfsSyncAccessHandle {
  read(buffer: Uint8Array, options?: { at?: number }): number;
  write(buffer: Uint8Array, options?: { at?: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

export interface OpfsFileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<OpfsFile>;
  /** 只在专用 Worker 中存在。 */
  createSyncAccessHandle?(): Promise<OpfsSyncAccessHandle>;
  /** 覆盖同名文件；不是所有引擎都提供。 */
  move?(parent: OpfsDirectoryHandle, name: string): Promise<void>;
}

export interface OpfsDirectoryHandle {
  readonly kind: 'directory';
  readonly name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterable<[string, OpfsFileHandle | OpfsDirectoryHandle]>;
  move?(parent: OpfsDirectoryHandle, name: string): Promise<void>;
}

export interface OpfsFilesOptions {
  /** `navigator.storage.getDirectory()`。 */
  readonly root: OpfsDirectoryHandle;
  readonly roots: readonly FileRoot[];
  /** `FilesService.backupRoot`；缺省为 `appData` 根下的 `recovery/backups`。 */
  readonly backupRoot?: string;
}

const DEFAULT_CHUNK = 64 * 1024;

/** 移动端允许根：都在 `AppInfo.dataDir`（`/deep-student`）之下；`appLocalData` 与 storage-mobile 的 `local/` 一致。没有 `legacy`。 */
export function mobileRoots(dataDir: string): FileRoot[] {
  const base = dataDir.replace(/\/+$/, '');
  return [
    { name: 'appData', path: base },
    { name: 'appLocalData', path: `${base}/local` },
    { name: 'appConfig', path: `${base}/config` },
    { name: 'appCache', path: `${base}/cache` },
    { name: 'appLog', path: `${base}/logs` },
    { name: 'temp', path: `${base}/tmp` },
  ];
}

const MESSAGES: Partial<Record<FileErrorKind, string>> = {
  NotFound: 'No such file or directory',
  AlreadyExists: 'File exists',
  NotADirectory: 'Not a directory',
  IsADirectory: 'Is a directory',
  DirectoryNotEmpty: 'Directory not empty',
  StorageFull: 'No space left on device',
};

function fault(kind: FileErrorKind, operation: FileOperation, path: string, osCode: string | null = null, cause?: unknown): FileError {
  return new FileError(kind, operation, path, MESSAGES[kind] ?? kind, { osCode, cause });
}

function unsupported(operation: FileOperation, path: string, capability: string, detail: string): FileError {
  return new FileError('UnsupportedOnPlatform', operation, path, unsupportedOnPlatformMessage(capability, 'mobile', detail));
}

/**
 * DOMException → FileError。`TypeMismatchError` 的含义取决于期望的句柄类型：
 * 期望目录得到文件是 `NotADirectory`，期望文件得到目录是 `IsADirectory`。
 */
function toFileError(operation: FileOperation, path: string, error: unknown, expected: 'file' | 'directory' = 'directory'): unknown {
  if (error instanceof FileError) return error;
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  if (name === 'AbortError') return error;
  const osCode = typeof name === 'string' ? name : null;
  switch (name) {
    case 'NotFoundError': return fault('NotFound', operation, path, osCode, error);
    case 'TypeMismatchError': return fault(expected === 'directory' ? 'NotADirectory' : 'IsADirectory', operation, path, osCode, error);
    case 'InvalidModificationError': return fault('DirectoryNotEmpty', operation, path, osCode, error);
    case 'QuotaExceededError': return fault('StorageFull', operation, path, osCode, error);
    case 'TypeError': return new FileError('InvalidPath', operation, path, error instanceof Error ? error.message : String(error), { osCode, cause: error });
    case 'NoModificationAllowedError':
      return new FileError('Other', operation, path, 'file is locked by another writer', { osCode, cause: error });
    default:
      return new FileError('Other', operation, path, error instanceof Error ? error.message : String(error), { osCode, cause: error });
  }
}

function problemError(operation: FileOperation, path: string, problem: PathProblem): FileError {
  return new FileError(problem.kind === 'escape' ? 'OutsideRoots' : 'InvalidPath', operation, path, problem.reason);
}

function nonNegativeInteger(value: number | undefined, name: string, operation: FileOperation, path: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new FileError('Other', operation, path, `${name} must be a non-negative safe integer, got ${value}`);
  }
}

function randomSuffix(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function writeAll(handle: OpfsSyncAccessHandle, data: Uint8Array, at: number): number {
  let offset = 0;
  while (offset < data.length) {
    const written = handle.write(data.subarray(offset), { at: at + offset });
    if (written <= 0) throw new Error(`sync access handle wrote ${written} bytes`);
    offset += written;
  }
  return at + offset;
}

interface HandleGuard {
  live(operation: FileOperation): void;
  writable(operation: FileOperation): void;
  close(): boolean;
}

function handleGuard(path: string, mode: OpenFileMode): HandleGuard {
  let closed = false;
  const live = (operation: FileOperation): void => {
    if (closed) throw new FileError('Other', operation, path, 'file handle is closed');
  };
  return {
    live,
    writable(operation) {
      live(operation);
      if (mode === 'read') throw new FileError('PermissionDenied', operation, path, 'file handle is read-only');
    },
    close() {
      const wasOpen = !closed;
      closed = true;
      return wasOpen;
    },
  };
}

function checkRange(operation: FileOperation, path: string, values: Record<string, number>): void {
  for (const [name, value] of Object.entries(values)) nonNegativeInteger(value, name, operation, path);
}

/** 只读句柄：不占用同步访问句柄，每次读取取 `getFile()` 的当前快照（文件被删后抛 `NotFound`）。 */
function readOnlyFile(handle: OpfsFileHandle, path: string, size: number): RandomAccessFile {
  const guard = handleGuard(path, 'read');
  return {
    path,
    mode: 'read',
    size,
    async read(position, length) {
      guard.live('read');
      checkRange('read', path, { position, length });
      try {
        const file = await handle.getFile();
        return new Uint8Array(await file.slice(position, position + length).arrayBuffer());
      } catch (error) {
        throw toFileError('read', path, error, 'file');
      }
    },
    async write() {
      guard.writable('write');
    },
    async truncate() {
      guard.writable('truncate');
    },
    async sync() {
      guard.live('sync');
    },
    async close() {
      guard.close();
    },
  };
}

/** 读写句柄：持有同步访问句柄直到 `close()`。 */
function syncAccessFile(sah: OpfsSyncAccessHandle, path: string, mode: OpenFileMode, initialSize: number): RandomAccessFile {
  const guard = handleGuard(path, mode);
  let size = initialSize;
  return {
    path,
    mode,
    get size() {
      return size;
    },
    async read(position, length) {
      guard.live('read');
      checkRange('read', path, { position, length });
      try {
        const buffer = new Uint8Array(Math.min(length, Math.max(0, sah.getSize() - position)));
        let filled = 0;
        while (filled < buffer.length) {
          const count = sah.read(buffer.subarray(filled), { at: position + filled });
          if (count <= 0) break;
          filled += count;
        }
        return filled === buffer.length ? buffer : buffer.subarray(0, filled);
      } catch (error) {
        throw toFileError('read', path, error, 'file');
      }
    },
    async write(data, position) {
      guard.writable('write');
      checkRange('write', path, { position });
      if (data.length === 0) return;
      try {
        writeAll(sah, data, position);
      } catch (error) {
        throw toFileError('write', path, error, 'file');
      }
      size = Math.max(size, position + data.length);
    },
    async truncate(length) {
      guard.writable('truncate');
      checkRange('truncate', path, { size: length });
      try {
        sah.truncate(length);
      } catch (error) {
        throw toFileError('truncate', path, error, 'file');
      }
      size = length;
    },
    async sync() {
      guard.live('sync');
      try {
        sah.flush();
      } catch (error) {
        throw toFileError('sync', path, error, 'file');
      }
    },
    async close() {
      if (!guard.close()) return;
      try {
        sah.flush();
      } catch (error) {
        throw toFileError('close', path, error, 'file');
      } finally {
        sah.close();
      }
    },
  };
}

interface Target {
  readonly input: string;
  readonly parsed: ParsedPath;
  readonly boundary: ParsedPath | null;
}

type Entry =
  | { readonly kind: 'file'; readonly handle: OpfsFileHandle; readonly parent: OpfsDirectoryHandle }
  | { readonly kind: 'directory'; readonly handle: OpfsDirectoryHandle; readonly parent: OpfsDirectoryHandle | null };

export function createOpfsFiles(options: OpfsFilesOptions): FilesService {
  const flavor = 'posix' as const;
  const opfs = options.root;
  const roots = options.roots.map((root) => {
    const { parsed, problem } = parseAbsolute(root.path, flavor);
    if (parsed === null) throw new FileError('InvalidPath', 'grant', root.path, `invalid root ${root.name}: ${problem?.reason}`);
    return { root, parsed };
  });
  const backupRoot = options.backupRoot ?? defaultBackupRoot(options.roots, flavor);

  const lastName = (target: Target): string | undefined => target.parsed.parts[target.parsed.parts.length - 1];

  async function dirAt(parts: readonly string[], create: boolean, operation: FileOperation, path: string): Promise<OpfsDirectoryHandle> {
    let dir = opfs;
    for (const part of parts) {
      try {
        dir = await dir.getDirectoryHandle(part, { create });
      } catch (error) {
        throw toFileError(operation, path, error, 'directory');
      }
    }
    return dir;
  }

  async function parentDir(target: Target, create: boolean, operation: FileOperation): Promise<OpfsDirectoryHandle> {
    return dirAt(target.parsed.parts.slice(0, -1), create, operation, target.input);
  }

  /** 子项查找；不存在返回 null。 */
  async function child(parent: OpfsDirectoryHandle, name: string, operation: FileOperation, path: string): Promise<Entry | null> {
    try {
      return { kind: 'file', handle: await parent.getFileHandle(name), parent };
    } catch (error) {
      const code = (error as { name?: unknown }).name;
      if (code === 'NotFoundError') return null;
      if (code !== 'TypeMismatchError') throw toFileError(operation, path, error);
    }
    try {
      return { kind: 'directory', handle: await parent.getDirectoryHandle(name), parent };
    } catch (error) {
      if ((error as { name?: unknown }).name === 'NotFoundError') return null;
      throw toFileError(operation, path, error);
    }
  }

  async function entryAt(target: Target, operation: FileOperation): Promise<Entry> {
    const name = lastName(target);
    if (name === undefined) return { kind: 'directory', handle: opfs, parent: null };
    const found = await child(await parentDir(target, false, operation), name, operation, target.input);
    if (found === null) throw fault('NotFound', operation, target.input);
    return found;
  }

  async function openSah(handle: OpfsFileHandle, operation: FileOperation, path: string): Promise<OpfsSyncAccessHandle> {
    if (typeof handle.createSyncAccessHandle !== 'function') {
      throw unsupported(operation, path, 'OPFS writes', 'FileSystemSyncAccessHandle exists only in a dedicated Worker');
    }
    try {
      return await handle.createSyncAccessHandle();
    } catch (error) {
      throw toFileError(operation, path, error, 'file');
    }
  }

  /**
   * 打开（必要时创建）文件并取得同步访问句柄。`exclusive` 时已存在抛 `AlreadyExists`；`mustExist` 时不存在抛 `NotFound`；
   * 目标是目录抛 `IsADirectory`。取句柄失败时删掉本次新建的空文件，失败的写入不留痕迹。
   */
  async function writableFile(target: Target, operation: FileOperation, createParents: boolean, exclusive: boolean, mustExist = false): Promise<OpfsSyncAccessHandle> {
    const name = lastName(target);
    if (name === undefined) throw fault('IsADirectory', operation, target.input);
    const parent = await parentDir(target, createParents, operation);
    const existing = await child(parent, name, operation, target.input);
    if (existing !== null && exclusive) throw fault('AlreadyExists', operation, target.input);
    if (existing === null && mustExist) throw fault('NotFound', operation, target.input);
    if (existing?.kind === 'directory') throw fault('IsADirectory', operation, target.input);
    let handle: OpfsFileHandle;
    try {
      handle = existing?.handle as OpfsFileHandle | undefined ?? await parent.getFileHandle(name, { create: true });
    } catch (error) {
      throw toFileError(operation, target.input, error, 'file');
    }
    try {
      return await openSah(handle, operation, target.input);
    } catch (error) {
      if (existing === null) await removeQuietly(parent, name);
      throw error;
    }
  }

  /** 清理临时文件或失败写入新建的空文件；清理失败返回 false，由调用方抛出原始错误。 */
  async function removeQuietly(parent: OpfsDirectoryHandle, name: string): Promise<boolean> {
    try {
      await parent.removeEntry(name);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Android System WebView (Chromium) exposes `FileSystemFileHandle.prototype.move`,
   * but `StoragePartitionImpl::GetFileSystemAccessPermissionContext()` returns nullptr,
   * making `handle.move(parent, name)` reject with `DOMException(NotAllowedError)`.
   * Fall back to SyncAccessHandle copy + removeEntry in that exact WebView case.
   */
  async function moveFileWithWebViewFallback(
    sourceParent: OpfsDirectoryHandle,
    sourceName: string,
    sourceHandle: OpfsFileHandle,
    destParent: OpfsDirectoryHandle,
    destName: string,
    operation: FileOperation,
    path: string,
  ): Promise<void> {
    try {
      await sourceHandle.move!(destParent, destName);
      return;
    } catch (error) {
      if ((error as { name?: unknown } | null)?.name !== 'NotAllowedError') throw error;
    }
    const file = await sourceHandle.getFile();
    const destHandle = await destParent.getFileHandle(destName, { create: true });
    const destSah = await openSah(destHandle, operation, path);
    try {
      destSah.truncate(0);
      for (let pos = 0; pos < file.size; pos += DEFAULT_CHUNK) {
        const chunk = new Uint8Array(await file.slice(pos, pos + DEFAULT_CHUNK).arrayBuffer());
        writeAll(destSah, chunk, pos);
      }
      destSah.flush();
    } finally {
      destSah.close();
    }
    await sourceParent.removeEntry(sourceName);
  }

  /** 写同目录临时文件后 `move()` 覆盖目标；失败删除临时文件，目标保持原样。 */
  async function atomicReplace(target: Target, operation: FileOperation, createParents: boolean, write: (handle: OpfsSyncAccessHandle) => Promise<void>): Promise<void> {
    const name = lastName(target);
    if (name === undefined) throw fault('IsADirectory', operation, target.input);
    const parent = await parentDir(target, createParents, operation);
    if ((await child(parent, name, operation, target.input))?.kind === 'directory') throw fault('IsADirectory', operation, target.input);
    const tempName = `${name.startsWith('.') ? name : `.${name}`}.${randomSuffix()}.tmp`;
    let temp: OpfsFileHandle;
    try {
      temp = await parent.getFileHandle(tempName, { create: true });
    } catch (error) {
      throw toFileError(operation, target.input, error, 'file');
    }
    try {
      if (typeof temp.move !== 'function') throw unsupported(operation, target.input, 'atomic replace', 'FileSystemFileHandle.move() is missing');
      const sah = await openSah(temp, operation, target.input);
      try {
        await write(sah);
        sah.flush();
      } finally {
        sah.close();
      }
      await moveFileWithWebViewFallback(parent, tempName, temp, parent, name, operation, target.input);
    } catch (error) {
      await removeQuietly(parent, tempName);
      throw toFileError(operation, target.input, error, 'file');
    }
  }

  function isRootPath(target: Target): boolean {
    if (target.boundary !== null && samePath(target.parsed, target.boundary, flavor)) return true;
    return roots.some((entry) => samePath(target.parsed, entry.parsed, flavor));
  }

  async function sortedEntries(dir: OpfsDirectoryHandle, operation: FileOperation, path: string): Promise<[string, 'file' | 'directory'][]> {
    const out: [string, 'file' | 'directory'][] = [];
    try {
      for await (const [name, handle] of dir.entries()) out.push([name, handle.kind]);
    } catch (error) {
      throw toFileError(operation, path, error);
    }
    return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  type Display = (parsed: ParsedPath) => string;

  function makeOperations(resolve: (input: string, operation: FileOperation) => Target, display: Display): FileOperations {
    async function readBytesAt(target: Target, maxBytes: number | undefined, signal: AbortSignal | undefined): Promise<Uint8Array> {
      nonNegativeInteger(maxBytes, 'maxBytes', 'read', target.input);
      signal?.throwIfAborted();
      const entry = await entryAt(target, 'read');
      if (entry.kind === 'directory') throw fault('IsADirectory', 'read', target.input);
      try {
        const file = await entry.handle.getFile();
        if (maxBytes !== undefined && file.size > maxBytes) {
          throw new FileError('TooLarge', 'read', target.input, `file is larger than ${maxBytes} bytes`);
        }
        const bytes = new Uint8Array(await file.slice().arrayBuffer());
        signal?.throwIfAborted();
        if (maxBytes !== undefined && bytes.length > maxBytes) {
          throw new FileError('TooLarge', 'read', target.input, `file is larger than ${maxBytes} bytes`);
        }
        return bytes;
      } catch (error) {
        throw toFileError('read', target.input, error, 'file');
      }
    }

    async function* walkFrom(start: Target, options: WalkOptions): AsyncGenerator<WalkEntry> {
      const entry = await entryAt(start, 'walk');
      if (entry.kind !== 'directory') throw fault('NotADirectory', 'walk', start.input);
      const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
      const includeDirectories = options.includeDirectories ?? true;
      async function* visit(dir: OpfsDirectoryHandle, parsed: ParsedPath, depth: number): AsyncGenerator<WalkEntry> {
        for (const [name, kind] of await sortedEntries(dir, 'walk', display(parsed))) {
          const childPath = childOf(parsed, name);
          if (kind !== 'directory' || includeDirectories) {
            yield { name, path: display(childPath), kind, relativePath: relativePath(childPath, start.parsed), depth };
          }
          if (kind === 'directory' && depth < maxDepth) {
            let sub: OpfsDirectoryHandle;
            try {
              sub = await dir.getDirectoryHandle(name);
            } catch (error) {
              throw toFileError('walk', display(childPath), error);
            }
            yield* visit(sub, childPath, depth + 1);
          }
        }
      }
      yield* visit(entry.handle, start.parsed, 1);
    }

    async function writeWhole(target: Target, operation: FileOperation, data: Uint8Array, createParents: boolean, exclusive: boolean, append: boolean): Promise<void> {
      const sah = await writableFile(target, operation, createParents, exclusive);
      try {
        if (!append) sah.truncate(0);
        writeAll(sah, data, append ? sah.getSize() : 0);
        sah.flush();
      } catch (error) {
        throw toFileError(operation, target.input, error, 'file');
      } finally {
        sah.close();
      }
    }

    const operations: FileOperations = {
      async readBytes(path, options = {}) {
        return readBytesAt(resolve(path, 'read'), options.maxBytes, options.signal);
      },

      async readText(path, options = {}) {
        const target = resolve(path, 'read');
        const bytes = await readBytesAt(target, options.maxBytes, options.signal);
        if (options.invalidUtf8 !== 'error') return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
        try {
          return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch {
          throw new FileError('InvalidData', 'read', target.input, 'stream did not contain valid UTF-8');
        }
      },

      async writeBytes(path, data, options = {}) {
        await writeWhole(resolve(path, 'write'), 'write', data, options.createParents ?? false, options.exclusive ?? false, false);
      },

      async writeText(path, text, options = {}) {
        await operations.writeBytes(path, new TextEncoder().encode(text), options);
      },

      async append(path, data, options = {}) {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        await writeWhole(resolve(path, 'append'), 'append', bytes, options.createParents ?? false, false, true);
      },

      async writeAtomic(path, data, options = {}) {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        await atomicReplace(resolve(path, 'writeAtomic'), 'writeAtomic', options.createParents ?? false, async (sah) => {
          writeAll(sah, bytes, 0);
        });
      },

      async openRead(path, options = {}) {
        const target = resolve(path, 'openRead');
        nonNegativeInteger(options.start, 'start', 'openRead', target.input);
        nonNegativeInteger(options.end, 'end', 'openRead', target.input);
        const chunkSize = options.chunkSize ?? DEFAULT_CHUNK;
        if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new FileError('Other', 'openRead', target.input, `chunkSize must be a positive integer, got ${chunkSize}`);
        const entry = await entryAt(target, 'openRead');
        if (entry.kind === 'directory') throw fault('IsADirectory', 'openRead', target.input);
        let file: OpfsFile;
        try {
          file = await entry.handle.getFile();
        } catch (error) {
          throw toFileError('openRead', target.input, error, 'file');
        }
        let position = options.start ?? 0;
        const end = Math.min(options.end ?? file.size, file.size);
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            const want = Math.min(chunkSize, end - position);
            if (want <= 0) {
              controller.close();
              return;
            }
            try {
              const chunk = new Uint8Array(await file.slice(position, position + want).arrayBuffer());
              position += chunk.length;
              if (chunk.length === 0) controller.close();
              else controller.enqueue(chunk);
            } catch (error) {
              controller.error(toFileError('openRead', target.input, error, 'file'));
            }
          },
        }, { highWaterMark: 0 });
      },

      async openWrite(path, options = {}) {
        const target = resolve(path, 'openWrite');
        const mode = options.mode ?? 'overwrite';
        const createParents = options.createParents ?? false;
        if (mode === 'atomic') {
          const name = lastName(target);
          if (name === undefined) throw fault('IsADirectory', 'openWrite', target.input);
          const parent = await parentDir(target, createParents, 'openWrite');
          if ((await child(parent, name, 'openWrite', target.input))?.kind === 'directory') throw fault('IsADirectory', 'openWrite', target.input);
          const tempName = `${name.startsWith('.') ? name : `.${name}`}.${randomSuffix()}.tmp`;
          let temp: OpfsFileHandle;
          let sah: OpfsSyncAccessHandle;
          try {
            temp = await parent.getFileHandle(tempName, { create: true });
            if (typeof temp.move !== 'function') throw unsupported('openWrite', target.input, 'atomic replace', 'FileSystemFileHandle.move() is missing');
            sah = await openSah(temp, 'openWrite', target.input);
          } catch (error) {
            await removeQuietly(parent, tempName);
            throw toFileError('openWrite', target.input, error, 'file');
          }
          let position = 0;
          return new WritableStream<Uint8Array>({
            write(chunk) {
              try {
                position = writeAll(sah, chunk, position);
              } catch (error) {
                throw toFileError('openWrite', target.input, error, 'file');
              }
            },
            async close() {
              try {
                sah.flush();
                sah.close();
                await moveFileWithWebViewFallback(parent, tempName, temp, parent, name, 'openWrite', target.input);
              } catch (error) {
                await removeQuietly(parent, tempName);
                throw toFileError('openWrite', target.input, error, 'file');
              }
            },
            async abort() {
              sah.close();
              await removeQuietly(parent, tempName);
            },
          });
        }
        const sah = await writableFile(target, 'openWrite', createParents, mode === 'exclusive');
        let position: number;
        try {
          if (mode === 'append') position = sah.getSize();
          else {
            sah.truncate(0);
            position = 0;
          }
        } catch (error) {
          sah.close();
          throw toFileError('openWrite', target.input, error, 'file');
        }
        return new WritableStream<Uint8Array>({
          write(chunk) {
            try {
              position = writeAll(sah, chunk, position);
            } catch (error) {
              throw toFileError('openWrite', target.input, error, 'file');
            }
          },
          close() {
            try {
              sah.flush();
            } catch (error) {
              throw toFileError('openWrite', target.input, error, 'file');
            } finally {
              sah.close();
            }
          },
          abort() {
            sah.close();
          },
        });
      },

      async openFile(path, options = {}) {
        const target = resolve(path, 'openFile');
        const mode = options.mode ?? 'read';
        if (mode === 'read') {
          const entry = await entryAt(target, 'openFile');
          if (entry.kind === 'directory') throw fault('IsADirectory', 'openFile', target.input);
          try {
            return readOnlyFile(entry.handle, target.input, (await entry.handle.getFile()).size);
          } catch (error) {
            throw toFileError('openFile', target.input, error, 'file');
          }
        }
        const creates = mode !== 'readWrite';
        const sah = await writableFile(target, 'openFile', creates && (options.createParents ?? false), mode === 'exclusive', !creates);
        try {
          if (mode === 'truncate') sah.truncate(0);
          return syncAccessFile(sah, target.input, mode, sah.getSize());
        } catch (error) {
          sah.close();
          throw toFileError('openFile', target.input, error, 'file');
        }
      },

      async stat(path) {
        const target = resolve(path, 'stat');
        const entry = await entryAt(target, 'stat');
        if (entry.kind === 'directory') return { kind: 'directory', size: 0, modifiedMs: 0, createdMs: null, unixMode: null } satisfies FileStat;
        try {
          const file = await entry.handle.getFile();
          return { kind: 'file', size: file.size, modifiedMs: file.lastModified, createdMs: null, unixMode: null } satisfies FileStat;
        } catch (error) {
          throw toFileError('stat', target.input, error, 'file');
        }
      },

      async exists(path) {
        const target = resolve(path, 'stat');
        try {
          await entryAt(target, 'stat');
          return true;
        } catch (error) {
          if (error instanceof FileError && error.kind === 'InvalidPath') throw error;
          return false;
        }
      },

      async readDir(path) {
        const target = resolve(path, 'readDir');
        const entry = await entryAt(target, 'readDir');
        if (entry.kind !== 'directory') throw fault('NotADirectory', 'readDir', target.input);
        return (await sortedEntries(entry.handle, 'readDir', target.input))
          .map(([name, kind]): DirEntry => ({ name, path: display(childOf(target.parsed, name)), kind }));
      },

      walk(path, options = {}) {
        return walkFrom(resolve(path, 'walk'), options);
      },

      async mkdir(path, options = {}) {
        const target = resolve(path, 'mkdir');
        const name = lastName(target);
        if (options.recursive ?? true) {
          if (name !== undefined) {
            const parent = await dirAt(target.parsed.parts.slice(0, -1), true, 'mkdir', target.input);
            if ((await child(parent, name, 'mkdir', target.input))?.kind === 'file') throw fault('AlreadyExists', 'mkdir', target.input);
          }
          await dirAt(target.parsed.parts, true, 'mkdir', target.input);
          return;
        }
        if (name === undefined) throw fault('AlreadyExists', 'mkdir', target.input);
        const parent = await parentDir(target, false, 'mkdir');
        if ((await child(parent, name, 'mkdir', target.input)) !== null) throw fault('AlreadyExists', 'mkdir', target.input);
        try {
          await parent.getDirectoryHandle(name, { create: true });
        } catch (error) {
          throw toFileError('mkdir', target.input, error);
        }
      },

      async rename(from, to, options = {}) {
        const source = resolve(from, 'rename');
        const destination = resolve(to, 'rename');
        const entry = await entryAt(source, 'rename');
        const destName = lastName(destination);
        if (entry.parent === null || destName === undefined) throw new FileError('InvalidPath', 'rename', source.input, 'cannot rename the OPFS root');
        if (samePath(source.parsed, destination.parsed, flavor)) return;
        if (typeof entry.handle.move !== 'function') {
          throw unsupported('rename', source.input, `${entry.kind} rename`, `this engine has no ${entry.kind === 'directory' ? 'FileSystemDirectoryHandle' : 'FileSystemFileHandle'}.move(); copy and remove explicitly`);
        }
        const destParent = await parentDir(destination, options.createParents ?? false, 'rename');
        const occupant = await child(destParent, destName, 'rename', destination.input);
        if (occupant !== null && options.overwrite === false) throw fault('AlreadyExists', 'rename', destination.input);
        if (occupant?.kind === 'directory') throw fault(entry.kind === 'file' ? 'IsADirectory' : 'DirectoryNotEmpty', 'rename', destination.input);
        if (occupant?.kind === 'file' && entry.kind === 'directory') throw fault('NotADirectory', 'rename', destination.input);
        try {
          if (entry.kind === 'file') {
            await moveFileWithWebViewFallback(entry.parent, entry.handle.name, entry.handle, destParent, destName, 'rename', source.input);
          } else {
            await entry.handle.move(destParent, destName);
          }
        } catch (error) {
          throw toFileError('rename', source.input, error, 'file');
        }
      },

      async copyFile(from, to, options = {}) {
        const source = resolve(from, 'copyFile');
        const destination = resolve(to, 'copyFile');
        const entry = await entryAt(source, 'copyFile');
        if (entry.kind === 'directory') throw fault('IsADirectory', 'copyFile', source.input);
        if (samePath(source.parsed, destination.parsed, flavor)) return;
        let file: OpfsFile;
        try {
          file = await entry.handle.getFile();
        } catch (error) {
          throw toFileError('copyFile', source.input, error, 'file');
        }
        const sah = await writableFile(destination, 'copyFile', options.createParents ?? false, options.overwrite === false);
        try {
          sah.truncate(0);
          for (let position = 0; position < file.size; position += DEFAULT_CHUNK) {
            writeAll(sah, new Uint8Array(await file.slice(position, position + DEFAULT_CHUNK).arrayBuffer()), position);
          }
          sah.flush();
        } catch (error) {
          throw toFileError('copyFile', source.input, error, 'file');
        } finally {
          sah.close();
        }
      },

      async rm(path, options = {}) {
        const target = resolve(path, 'rm');
        if (isRootPath(target)) throw new FileError('InvalidPath', 'rm', target.input, 'refusing to remove an allowed root or scope root');
        let entry: Entry;
        try {
          entry = await entryAt(target, 'rm');
        } catch (error) {
          if (options.force && error instanceof FileError && error.kind === 'NotFound') return;
          throw error;
        }
        if (entry.parent === null) throw new FileError('InvalidPath', 'rm', target.input, 'refusing to remove the OPFS root');
        try {
          await entry.parent.removeEntry(entry.handle.name, entry.kind === 'directory' && options.recursive ? { recursive: true } : {});
        } catch (error) {
          throw toFileError('rm', target.input, error);
        }
      },
    };
    return operations;
  }

  function lexicalTarget(input: string, operation: FileOperation): Target {
    const { parsed, problem } = parseAbsolute(input, flavor);
    if (parsed === null) throw problemError(operation, input, problem!);
    if (!roots.some((entry) => isWithin(parsed, entry.parsed, flavor))) {
      throw new FileError('OutsideRoots', operation, input, 'path is outside the allowed roots');
    }
    return { input, parsed, boundary: null };
  }

  function createScope(rootTarget: Target): FileScope {
    const resolveRelative = (relative: string, operation: FileOperation): Target => {
      const { parts, problem } = parseRelative(relative, flavor);
      if (parts === null) throw problemError(operation, relative, problem!);
      return { input: relative, parsed: childOf(rootTarget.parsed, ...parts), boundary: rootTarget.parsed };
    };
    const operations = makeOperations(resolveRelative, (parsed) => relativePath(parsed, rootTarget.parsed));
    return {
      ...operations,
      root: formatPath(rootTarget.parsed, flavor),
      resolve: (relative) => formatPath(resolveRelative(relative, 'scope').parsed, flavor),
      scope: (relative) => createScope({ ...resolveRelative(relative, 'scope'), boundary: null }),
    };
  }

  return {
    ...makeOperations(lexicalTarget, (parsed) => formatPath(parsed, flavor)),
    flavor,
    get roots() {
      return roots.map((entry) => entry.root);
    },
    async isAllowed(path) {
      try {
        lexicalTarget(path, 'stat');
        return true;
      } catch {
        return false;
      }
    },
    scope(directory) {
      return createScope(lexicalTarget(directory, 'scope'));
    },
    grant(path): FileGrant {
      throw unsupported('grant', path, 'files.grant', 'user-selected files arrive through the shell as content, not as OPFS paths');
    },
    get backupRoot() {
      if (backupRoot === null) throw new FileError('UnsupportedOnPlatform', 'scope', '', `${UNSUPPORTED_ON_PLATFORM_PREFIX}files.backupRoot needs an appData root`);
      return backupRoot;
    },
  };
}