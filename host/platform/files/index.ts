/**
 * `ctx.files` 桌面实现（`node:fs/promises`）与 Cordis 插件。接口见 ./api.ts，语义与移动端方案见 ../API.md「files」。
 *
 * 每次操作两道包含判断：
 * 1. 词法：规范化后的绝对路径（或作用域内相对路径）必须在某个允许根（以及作用域根）之内；
 * 2. 真实路径：目标的真实路径（解析符号链接；不存在的尾部组件按词法拼接）必须在某个允许根的真实路径之内。
 *    跟随型操作（读、写、stat、列目录、复制）解析到目标本身；条目型操作（rm、rename、lstat、mkdir）
 *    只解析父目录，因此可以删除指向根外的符号链接本身，但不能经由它读写。
 * 两次判断之间存在 TOCTOU 窗口，这里只防误用，不防与本进程竞争的恶意本地程序。
 */
import type { Stats } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { appendFile, chmod, copyFile, lstat, mkdir, open, readdir, realpath, rm, rmdir, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { definePlugin } from '../../kernel/api.ts';
import { UNSUPPORTED_ON_PLATFORM_PREFIX } from '../errors/unsupported-on-platform.ts';
import type { PathsService } from '../paths/api.ts';
import { atomicWriteFile } from '../util/durable-fs.ts';
import { errnoCode, ioMessage, rustJoin } from '../paths/compat.ts';
import { fsyncDirectory, renameWithRetry } from '../util/durable-fs.ts';
import {
  FileError,
  type DirEntry,
  type FileErrorKind,
  type FileGrant,
  type FileKind,
  type FileOperation,
  type FileOperations,
  type FileRoot,
  type FileScope,
  type FilesService,
  type FileStat,
  type OpenFileMode,
  type PathFlavor,
  type RandomAccessFile,
  type WalkEntry,
  type WalkOptions,
} from './api.ts';
import {
  childOf,
  defaultBackupRoot,
  formatPath,
  isWithin,
  parentOf,
  parseAbsolute,
  parseRelative,
  relativePath,
  samePath,
  type ParsedPath,
  type PathProblem,
} from './path.ts';

export type * from './api.ts';
export { FileError, isFileNotFound } from './api.ts';
export * from './path.ts';

const KIND_BY_CODE: Record<string, FileErrorKind> = {
  ENOENT: 'NotFound',
  EEXIST: 'AlreadyExists',
  EACCES: 'PermissionDenied',
  EPERM: 'PermissionDenied',
  ENOTDIR: 'NotADirectory',
  EISDIR: 'IsADirectory',
  ERR_FS_EISDIR: 'IsADirectory',
  ENOTEMPTY: 'DirectoryNotEmpty',
  ENOSPC: 'StorageFull',
  EDQUOT: 'StorageFull',
  EROFS: 'ReadOnlyFilesystem',
  EXDEV: 'CrossesDevices',
  ENAMETOOLONG: 'InvalidPath',
};

const DEFAULT_CHUNK = 64 * 1024;

function toFileError(operation: FileOperation, path: string, error: unknown): unknown {
  if (error instanceof FileError) return error;
  if (error instanceof Error && error.name === 'AbortError') return error;
  const code = errnoCode(error);
  const kind = (code !== undefined ? KIND_BY_CODE[code] : undefined) ?? 'Other';
  return new FileError(kind, operation, path, ioMessage(error), { osCode: code ?? null, cause: error });
}

function problemError(operation: FileOperation, path: string, problem: PathProblem): FileError {
  return new FileError(problem.kind === 'escape' ? 'OutsideRoots' : 'InvalidPath', operation, path, problem.reason);
}

function kindOf(entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileKind {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isFile()) return 'file';
  if (entry.isDirectory()) return 'directory';
  return 'other';
}

function nonNegativeInteger(value: number | undefined, name: string, operation: FileOperation, path: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new FileError('Other', operation, path, `${name} must be a non-negative safe integer, got ${value}`);
  }
}

async function writeFully(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
    offset += bytesWritten;
  }
}

const OPEN_FLAGS: Record<OpenFileMode, string | number> = {
  read: 'r',
  readWrite: 'r+',
  create: fsConstants.O_RDWR | fsConstants.O_CREAT,
  truncate: 'w+',
  exclusive: 'wx+',
};

function randomAccessFile(handle: FileHandle, path: string, mode: OpenFileMode, initialSize: number): RandomAccessFile {
  let size = initialSize;
  let closed = false;
  const live = (operation: FileOperation): void => {
    if (closed) throw new FileError('Other', operation, path, 'file handle is closed');
  };
  const writable = (operation: FileOperation): void => {
    live(operation);
    if (mode === 'read') throw new FileError('PermissionDenied', operation, path, 'file handle is read-only');
  };
  return {
    path,
    mode,
    get size() {
      return size;
    },
    async read(position, length) {
      live('read');
      nonNegativeInteger(position, 'position', 'read', path);
      nonNegativeInteger(length, 'length', 'read', path);
      try {
        const buffer = new Uint8Array(Math.min(length, Math.max(0, (await handle.stat()).size - position)));
        let filled = 0;
        while (filled < buffer.length) {
          const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, position + filled);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        return filled === buffer.length ? buffer : buffer.subarray(0, filled);
      } catch (error) {
        throw toFileError('read', path, error);
      }
    },
    async write(data, position) {
      writable('write');
      nonNegativeInteger(position, 'position', 'write', path);
      if (data.length === 0) return;
      try {
        let written = 0;
        while (written < data.length) {
          const { bytesWritten } = await handle.write(data, written, data.length - written, position + written);
          if (bytesWritten <= 0) throw new Error(`write made no progress at ${position + written}`);
          written += bytesWritten;
        }
      } catch (error) {
        throw toFileError('write', path, error);
      }
      size = Math.max(size, position + data.length);
    },
    async truncate(length) {
      writable('truncate');
      nonNegativeInteger(length, 'size', 'truncate', path);
      try {
        await handle.truncate(length);
      } catch (error) {
        throw toFileError('truncate', path, error);
      }
      size = length;
    },
    async sync() {
      live('sync');
      if (mode === 'read') return;
      try {
        await handle.sync();
      } catch (error) {
        throw toFileError('sync', path, error);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await handle.close();
      } catch (error) {
        throw toFileError('close', path, error);
      }
    },
  };
}

/** 一次操作的目标：调用方原始输入、规范化后的绝对路径，以及可选的作用域边界。 */
interface Target {
  readonly input: string;
  readonly parsed: ParsedPath;
  readonly abs: string;
  readonly boundary: ParsedPath | null;
}

export interface NodeFilesOptions {
  readonly roots: readonly FileRoot[];
  /**
   * 操作系统行为（Unix 权限位、目录 fsync、win32 rename 重试）的唯一来源；插件传 `ctx.app.platform`，默认
   * `process.platform`。
   */
  readonly platform?: NodeJS.Platform;
  /** 路径语法，默认由 `platform` 决定；只在需要解析另一平台路径时单独指定。 */
  readonly flavor?: PathFlavor;
  /** `FilesService.backupRoot`；插件传 `ctx.paths.recoveryBackupsDir`，缺省为 `appData` 根下的 `recovery/backups`。 */
  readonly backupRoot?: string;
}

/** `ctx.paths` → 默认允许根（`FileRootName` 的含义见 api.ts）。 */
export function standardRoots(paths: PathsService, platform: NodeJS.Platform): FileRoot[] {
  const sep = platform === 'win32' ? '\\' : '/';
  const os = paths.os;
  const legacy = [...new Set([os.dataLocal, os.data, os.config, os.home, os.temp])].map((dir) => rustJoin(dir, sep, 'deep-student'));
  return [
    { name: 'appData', path: paths.appDataDir },
    { name: 'appLocalData', path: paths.appLocalDataDir },
    { name: 'appConfig', path: paths.appConfigDir },
    { name: 'appCache', path: paths.appCacheDir },
    { name: 'appLog', path: paths.appLogDir },
    { name: 'temp', path: os.temp },
    ...legacy.map((path): FileRoot => ({ name: 'legacy', path })),
  ];
}

export function createNodeFiles(options: NodeFilesOptions): FilesService {
  const platform = options.platform ?? process.platform;
  const posix = platform !== 'win32';
  const flavor: PathFlavor = options.flavor ?? (posix ? 'posix' : 'win32');

  interface RootEntry { readonly root: FileRoot; readonly parsed: ParsedPath }
  const parseRoot = (root: FileRoot): RootEntry => {
    const { parsed, problem } = parseAbsolute(root.path, flavor);
    if (parsed === null) throw new FileError('InvalidPath', 'grant', root.path, `invalid root ${root.name}: ${problem?.reason}`);
    return { root, parsed };
  };
  const fixedRoots = options.roots.map(parseRoot);
  const backupRoot = options.backupRoot ?? defaultBackupRoot(options.roots, flavor);
  const grants = new Map<symbol, RootEntry>();
  const activeRoots = (): RootEntry[] => [...fixedRoots, ...grants.values()];

  // 真实路径缓存（只缓存根与作用域根；目标路径每次重新解析）。
  const realCache = new Map<string, Promise<ParsedPath>>();

  /** 真实路径：最深的已存在祖先 `realpath` 后拼接其余组件。`followFinal=false` 时只解析父目录。 */
  async function realOf(parsed: ParsedPath, followFinal: boolean): Promise<ParsedPath> {
    const tail = !followFinal && parsed.parts.length > 0 ? parsed.parts.slice(-1) : [];
    let probe: ParsedPath | null = tail.length > 0 ? parentOf(parsed) : parsed;
    const rest: string[] = [];
    while (probe !== null) {
      try {
        const real = parseAbsolute(await realpath(formatPath(probe, flavor)), flavor).parsed;
        if (real === null) break;
        return childOf(real, ...rest, ...tail);
      } catch (error) {
        const code = errnoCode(error);
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
        if (probe.parts.length === 0) break;
        rest.unshift(probe.parts[probe.parts.length - 1]!);
        probe = parentOf(probe);
      }
    }
    return parsed;
  }

  function cachedReal(parsed: ParsedPath): Promise<ParsedPath> {
    const key = formatPath(parsed, flavor);
    let cached = realCache.get(key);
    if (cached === undefined) {
      cached = realOf(parsed, true);
      realCache.set(key, cached);
      cached.catch(() => realCache.delete(key));
    }
    return cached;
  }

  function lexicalTarget(input: string, operation: FileOperation): Target {
    const { parsed, problem } = parseAbsolute(input, flavor);
    if (parsed === null) throw problemError(operation, input, problem!);
    if (!activeRoots().some((entry) => isWithin(parsed, entry.parsed, flavor))) {
      throw new FileError('OutsideRoots', operation, input, 'path is outside the allowed roots');
    }
    return { input, parsed, abs: formatPath(parsed, flavor), boundary: null };
  }

  async function confine(target: Target, operation: FileOperation, followFinal: boolean): Promise<Target> {
    let real: ParsedPath;
    try {
      real = await realOf(target.parsed, followFinal);
    } catch (error) {
      throw toFileError(operation, target.input, error);
    }
    if (target.boundary !== null && !isWithin(real, await cachedReal(target.boundary), flavor)) {
      throw new FileError('OutsideRoots', operation, target.input, 'path resolves outside the scope through a symbolic link');
    }
    for (const entry of activeRoots()) {
      if (isWithin(real, await cachedReal(entry.parsed), flavor)) return target;
    }
    throw new FileError('OutsideRoots', operation, target.input, 'path resolves outside the allowed roots through a symbolic link');
  }

  const parentAbs = (target: Target): string => formatPath(parentOf(target.parsed) ?? target.parsed, flavor);

  async function ensureParent(target: Target, operation: FileOperation, enabled: boolean | undefined): Promise<void> {
    if (!enabled) return;
    try {
      await mkdir(parentAbs(target), { recursive: true });
    } catch (error) {
      throw toFileError(operation, target.input, error);
    }
  }

  function tempSibling(target: Target): string {
    const name = target.parsed.parts[target.parsed.parts.length - 1] ?? 'root';
    return formatPath(childOf(parentOf(target.parsed) ?? target.parsed, `.${name}.${randomBytes(6).toString('hex')}.tmp`), flavor);
  }

  function toStat(info: Stats): FileStat {
    return {
      kind: kindOf(info),
      size: info.size,
      modifiedMs: info.mtimeMs,
      createdMs: info.birthtimeMs > 0 ? info.birthtimeMs : null,
      unixMode: posix ? info.mode & 0o7777 : null,
    };
  }

  function isRootPath(target: Target): boolean {
    if (target.boundary !== null && samePath(target.parsed, target.boundary, flavor)) return true;
    return activeRoots().some((entry) => samePath(target.parsed, entry.parsed, flavor));
  }

  /** 列目录与遍历时把条目路径换成调用方视角（绝对或相对作用域）。 */
  type Display = (parsed: ParsedPath) => string;

  function makeOperations(resolve: (input: string, operation: FileOperation) => Target, display: Display): FileOperations {
    async function readBytesAt(target: Target, maxBytes: number | undefined, signal: AbortSignal | undefined): Promise<Uint8Array> {
      nonNegativeInteger(maxBytes, 'maxBytes', 'read', target.input);
      await confine(target, 'read', true);
      try {
        const handle = await open(target.abs, 'r');
        try {
          if (maxBytes !== undefined && (await handle.stat()).size > maxBytes) {
            throw new FileError('TooLarge', 'read', target.input, `file is larger than ${maxBytes} bytes`);
          }
          const buffer = await handle.readFile(signal ? { signal } : {});
          if (maxBytes !== undefined && buffer.length > maxBytes) {
            throw new FileError('TooLarge', 'read', target.input, `file is larger than ${maxBytes} bytes`);
          }
          return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        } finally {
          await handle.close();
        }
      } catch (error) {
        throw toFileError('read', target.input, error);
      }
    }

    async function* walkFrom(start: Target, options: WalkOptions): AsyncGenerator<WalkEntry> {
      await confine(start, 'walk', true);
      const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
      const includeDirectories = options.includeDirectories ?? true;
      async function* visit(dir: ParsedPath, depth: number): AsyncGenerator<WalkEntry> {
        let entries;
        try {
          entries = await readdir(formatPath(dir, flavor), { withFileTypes: true });
        } catch (error) {
          throw toFileError('walk', display(dir), error);
        }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
          const child = childOf(dir, entry.name);
          const kind = kindOf(entry);
          if (kind !== 'directory' || includeDirectories) {
            yield { name: entry.name, path: display(child), kind, relativePath: relativePath(child, start.parsed), depth };
          }
          if (kind === 'directory' && depth < maxDepth) yield* visit(child, depth + 1);
        }
      }
      yield* visit(start.parsed, 1);
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
        const target = await confine(resolve(path, 'write'), 'write', true);
        await ensureParent(target, 'write', options.createParents);
        try {
          await writeFile(target.abs, data, { flag: options.exclusive ? 'wx' : 'w', mode: options.unixMode ?? 0o666 });
        } catch (error) {
          throw toFileError('write', target.input, error);
        }
      },

      async writeText(path, text, options = {}) {
        await operations.writeBytes(path, new TextEncoder().encode(text), options);
      },

      async append(path, data, options = {}) {
        const target = await confine(resolve(path, 'append'), 'append', true);
        await ensureParent(target, 'append', options.createParents);
        try {
          await appendFile(target.abs, typeof data === 'string' ? new TextEncoder().encode(data) : data, { mode: options.unixMode ?? 0o666 });
        } catch (error) {
          throw toFileError('append', target.input, error);
        }
      },

      async writeAtomic(path, data, options = {}) {
        const target = await confine(resolve(path, 'writeAtomic'), 'writeAtomic', true);
        await ensureParent(target, 'writeAtomic', options.createParents);
        const mode = options.unixMode;
        try {
          await atomicWriteFile(target.abs, data, {
            mode: mode ?? 0o600,
            ...(mode !== undefined && posix ? { beforeRename: (temp: string) => chmod(temp, mode) } : {}),
          });
          if (options.durable && posix) await fsyncDirectory(parentAbs(target), { platform });
        } catch (error) {
          throw toFileError('writeAtomic', target.input, error);
        }
      },

      async openRead(path, options = {}) {
        const target = await confine(resolve(path, 'openRead'), 'openRead', true);
        nonNegativeInteger(options.start, 'start', 'openRead', target.input);
        nonNegativeInteger(options.end, 'end', 'openRead', target.input);
        const chunkSize = options.chunkSize ?? DEFAULT_CHUNK;
        if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new FileError('Other', 'openRead', target.input, `chunkSize must be a positive integer, got ${chunkSize}`);
        let handle: FileHandle;
        try {
          handle = await open(target.abs, 'r');
          if ((await handle.stat()).isDirectory()) {
            await handle.close();
            throw Object.assign(new Error('Is a directory'), { code: 'EISDIR' });
          }
        } catch (error) {
          throw toFileError('openRead', target.input, error);
        }
        let position = options.start ?? 0;
        const end = options.end;
        let closed = false;
        const close = async () => {
          if (closed) return;
          closed = true;
          await handle.close();
        };
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const want = end === undefined ? chunkSize : Math.min(chunkSize, end - position);
              if (want <= 0) {
                await close();
                controller.close();
                return;
              }
              const buffer = new Uint8Array(want);
              const { bytesRead } = await handle.read(buffer, 0, want, position);
              if (bytesRead === 0) {
                await close();
                controller.close();
                return;
              }
              position += bytesRead;
              controller.enqueue(bytesRead === want ? buffer : buffer.subarray(0, bytesRead));
            } catch (error) {
              await close();
              controller.error(toFileError('openRead', target.input, error));
            }
          },
          async cancel() {
            await close();
          },
        }, { highWaterMark: 0 });
      },

      async openWrite(path, options = {}) {
        const target = await confine(resolve(path, 'openWrite'), 'openWrite', true);
        await ensureParent(target, 'openWrite', options.createParents);
        const mode = options.mode ?? 'overwrite';
        const temp = mode === 'atomic' ? tempSibling(target) : null;
        const flag = mode === 'append' ? 'a' : mode === 'overwrite' ? 'w' : 'wx';
        let handle: FileHandle;
        try {
          handle = await open(temp ?? target.abs, flag, options.unixMode ?? (temp ? 0o600 : 0o666));
        } catch (error) {
          throw toFileError('openWrite', target.input, error);
        }
        const discard = async () => {
          try {
            await handle.close();
          } finally {
            if (temp !== null) await rm(temp, { force: true });
          }
        };
        return new WritableStream<Uint8Array>({
          async write(chunk) {
            try {
              await writeFully(handle, chunk);
            } catch (error) {
              // An errored WritableStream does not invoke the sink's abort().
              await discard().catch(() => undefined);
              throw toFileError('openWrite', target.input, error);
            }
          },
          async close() {
            try {
              if (temp !== null) await handle.sync();
              await handle.close();
              if (temp !== null) await renameWithRetry(temp, target.abs, { platform });
            } catch (error) {
              await discard().catch(() => undefined);
              throw toFileError('openWrite', target.input, error);
            }
          },
          async abort() {
            await discard();
          },
        });
      },

      async openFile(path, options = {}) {
        const target = await confine(resolve(path, 'openFile'), 'openFile', true);
        const mode = options.mode ?? 'read';
        if (mode !== 'read' && mode !== 'readWrite') await ensureParent(target, 'openFile', options.createParents);
        let handle: FileHandle;
        try {
          handle = await open(target.abs, OPEN_FLAGS[mode], options.unixMode ?? 0o666);
        } catch (error) {
          throw toFileError('openFile', target.input, error);
        }
        try {
          const info = await handle.stat();
          if (info.isDirectory()) throw Object.assign(new Error('Is a directory'), { code: 'EISDIR' });
          return randomAccessFile(handle, target.input, mode, info.size);
        } catch (error) {
          await handle.close().catch(() => undefined);
          throw toFileError('openFile', target.input, error);
        }
      },

      async stat(path, options = {}) {
        const follow = options.followSymlinks ?? true;
        const target = await confine(resolve(path, 'stat'), 'stat', follow);
        try {
          return toStat(follow ? await stat(target.abs) : await lstat(target.abs));
        } catch (error) {
          throw toFileError('stat', target.input, error);
        }
      },

      async exists(path) {
        const target = resolve(path, 'stat');
        try {
          await confine(target, 'stat', true);
          await stat(target.abs);
          return true;
        } catch (error) {
          if (error instanceof FileError && (error.kind === 'OutsideRoots' || error.kind === 'InvalidPath')) throw error;
          return false;
        }
      },

      async readDir(path) {
        const target = await confine(resolve(path, 'readDir'), 'readDir', true);
        let entries;
        try {
          entries = await readdir(target.abs, { withFileTypes: true });
        } catch (error) {
          throw toFileError('readDir', target.input, error);
        }
        return entries
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          .map((entry): DirEntry => ({ name: entry.name, path: display(childOf(target.parsed, entry.name)), kind: kindOf(entry) }));
      },

      walk(path, options = {}) {
        return walkFrom(resolve(path, 'walk'), options);
      },

      async mkdir(path, options = {}) {
        const target = await confine(resolve(path, 'mkdir'), 'mkdir', false);
        try {
          await mkdir(target.abs, { recursive: options.recursive ?? true });
        } catch (error) {
          throw toFileError('mkdir', target.input, error);
        }
      },

      async rename(from, to, options = {}) {
        const source = await confine(resolve(from, 'rename'), 'rename', false);
        const destination = await confine(resolve(to, 'rename'), 'rename', false);
        await ensureParent(destination, 'rename', options.createParents);
        try {
          if (options.overwrite === false) {
            const occupied = await lstat(destination.abs).then(() => true, (error: unknown) => {
              if (errnoCode(error) === 'ENOENT') return false;
              throw error;
            });
            if (occupied) throw new FileError('AlreadyExists', 'rename', destination.input, 'destination already exists');
          }
          // RUST-FIX(RF-W14-files-rename-retry): Rust 在 win32 上能以 POSIX 语义替换被占用的目标；这里与 openWrite atomic 一样退避重试。
          await renameWithRetry(source.abs, destination.abs, { platform });
        } catch (error) {
          throw toFileError('rename', source.input, error);
        }
      },

      async copyFile(from, to, options = {}) {
        const source = await confine(resolve(from, 'copyFile'), 'copyFile', true);
        const destination = await confine(resolve(to, 'copyFile'), 'copyFile', true);
        await ensureParent(destination, 'copyFile', options.createParents);
        try {
          await copyFile(source.abs, destination.abs, options.overwrite === false ? fsConstants.COPYFILE_EXCL : 0);
        } catch (error) {
          throw toFileError('copyFile', errnoCode(error) === 'EEXIST' ? destination.input : source.input, error);
        }
      },

      async rm(path, options = {}) {
        const target = await confine(resolve(path, 'rm'), 'rm', false);
        if (isRootPath(target)) throw new FileError('InvalidPath', 'rm', target.input, 'refusing to remove an allowed root or scope root');
        try {
          let info: Stats;
          try {
            info = await lstat(target.abs);
          } catch (error) {
            if (options.force && errnoCode(error) === 'ENOENT') return;
            throw error;
          }
          if (info.isDirectory() && !options.recursive) await rmdir(target.abs);
          else await rm(target.abs, { recursive: options.recursive ?? false, force: options.force ?? false });
        } catch (error) {
          throw toFileError('rm', target.input, error);
        }
      },
    };
    return operations;
  }

  function createScope(rootTarget: Target): FileScope {
    const resolveRelative = (relative: string, operation: FileOperation): Target => {
      const { parts, problem } = parseRelative(relative, flavor);
      if (parts === null) throw problemError(operation, relative, problem!);
      const parsed = childOf(rootTarget.parsed, ...parts);
      return { input: relative, parsed, abs: formatPath(parsed, flavor), boundary: rootTarget.parsed };
    };
    const operations = makeOperations(resolveRelative, (parsed) => relativePath(parsed, rootTarget.parsed));
    return {
      ...operations,
      root: rootTarget.abs,
      resolve: (relative) => resolveRelative(relative, 'scope').abs,
      scope: (relative) => createScope({ ...resolveRelative(relative, 'scope'), boundary: null }),
    };
  }

  const absoluteOperations = makeOperations(lexicalTarget, (parsed) => formatPath(parsed, flavor));

  const service: FilesService = {
    ...absoluteOperations,
    flavor,
    get roots() {
      return activeRoots().map((entry) => entry.root);
    },
    async isAllowed(path) {
      try {
        await confine(lexicalTarget(path, 'stat'), 'stat', true);
        return true;
      } catch {
        return false;
      }
    },
    scope(directory) {
      return createScope(lexicalTarget(directory, 'scope'));
    },
    grant(path): FileGrant {
      const entry = parseRoot({ name: 'granted', path });
      const id = Symbol(path);
      grants.set(id, entry);
      return { path, revoke: () => void grants.delete(id) };
    },
    get backupRoot() {
      if (backupRoot === null) throw new FileError('UnsupportedOnPlatform', 'scope', '', `${UNSUPPORTED_ON_PLATFORM_PREFIX}files.backupRoot needs an appData root`);
      return backupRoot;
    },
  };
  return service;
}

/** Cordis 插件：`ctx.files`（桌面）。允许根与备份根取自 `ctx.paths`。 */
export default definePlugin({
  meta: { id: 'dstu.platform.files', lane: 'W14-portable', provides: ['files'], platforms: ['desktop'] },
  inject: ['paths'],
  apply(ctx: Context) {
    ctx.reflect.provide('files', createNodeFiles({
      roots: standardRoots(ctx.paths, ctx.app.platform), platform: ctx.app.platform, backupRoot: ctx.paths.recoveryBackupsDir,
    }));
  },
});
