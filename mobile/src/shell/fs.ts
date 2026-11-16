/**
 * 移动端 `plugin:fs|*` 与 `plugin:resources|close` 处理（对应 `@tauri-apps/plugin-fs`）。
 *
 * 所有路径严格限制在 OPFS `/deep-student/**` 沙箱内，匹配 Tauri v2 的 JSON/二进制混合线协议
 * （包括 `write_file` / `write_text_file` 的 `application/octet-stream` + `headers.path/options` 载荷）。
 */
import {
  getDefaultOpfsRoot,
  normalizeSandboxPath,
  opfsCopyFile,
  opfsEnsureDir,
  opfsExists,
  opfsOpenFileHandle,
  opfsReadDir,
  opfsReadFile,
  opfsRemove,
  opfsRename,
  opfsStat,
  opfsWriteFile,
  readBlobBytes,
  type OpfsFileHandle,
  type OpfsRootGetter,
} from './opfs.ts';
import { optRecord, parseJsonArgs, reqNumber, reqString, type MobilePluginHandler } from './plugin-args.ts';

interface OpenFileResource {
  readonly handle: OpfsFileHandle;
  readonly path: string;
  readonly read: boolean;
  readonly write: boolean;
  readonly append: boolean;
  pos: number;
}

function parseWriteHeaders(headers: Record<string, string>): {
  path: string;
  options: Record<string, unknown> | null;
} {
  const encodedPath = headers.path;
  if (typeof encodedPath !== 'string' || encodedPath === '') {
    throw new Error('missing file path');
  }
  let path: string;
  try {
    path = decodeURIComponent(encodedPath);
  } catch {
    throw new Error('path is not a valid UTF-8');
  }
  let options: Record<string, unknown> | null = null;
  if (typeof headers.options === 'string' && headers.options !== '' && headers.options !== 'undefined') {
    try {
      const parsed = JSON.parse(headers.options) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        options = parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore malformed options header, matching desktop fs plugin behavior.
    }
  }
  return { path, options };
}

function encodeReadChunkWithLength(chunk: Uint8Array): Uint8Array {
  const out = new Uint8Array(chunk.byteLength + 8);
  out.set(chunk, 0);
  new DataView(out.buffer, out.byteOffset, out.byteLength).setBigUint64(chunk.byteLength, BigInt(chunk.byteLength), false);
  return out;
}

/** 创建 `plugin:fs|*` 与 `plugin:resources|close` 共用资源表的处理器。 */
export function createMobileFsHandlers(getRoot: OpfsRootGetter = getDefaultOpfsRoot): {
  fs: MobilePluginHandler;
  resources: MobilePluginHandler;
} {
  let nextRid = 1;
  const openFiles = new Map<number, OpenFileResource>();

  const getResource = (rid: number): OpenFileResource => {
    const res = openFiles.get(rid);
    if (!res) throw new Error(`invalid resource id: ${rid}`);
    return res;
  };

  const fsHandler: MobilePluginHandler = async ({ command, payload, headers }) => {
    if (command === 'write_file' || command === 'write_text_file') {
      const { path, options } = parseWriteHeaders(headers);
      let data: Uint8Array;
      if (payload.contentType === 'application/octet-stream') {
        data = payload.data;
      } else {
        const body = JSON.parse(payload.data) as unknown;
        if (!Array.isArray(body)) {
          throw new Error('unexpected invoke body for write_file');
        }
        data = Uint8Array.from(body as number[]);
      }
      await opfsWriteFile(path, data, {
        baseDir: options?.baseDir,
        append: options?.append === true,
        create: options?.create !== false,
        createNew: options?.createNew === true,
        createParents: false,
        mimeType: command === 'write_text_file' ? 'text/plain;charset=utf-8' : 'application/octet-stream',
        getRoot,
      });
      return null;
    }

    const args = parseJsonArgs(payload, 'fs');
    const options = optRecord(args, 'options');

    switch (command) {
      case 'read_file':
      case 'read_text_file': {
        const file = await opfsReadFile(reqString(args, 'path', command), {
          baseDir: options?.baseDir,
          getRoot,
        });
        return readBlobBytes(file);
      }
      case 'exists':
        return opfsExists(reqString(args, 'path', command), {
          baseDir: options?.baseDir,
          getRoot,
        });
      case 'mkdir':
        await opfsEnsureDir(reqString(args, 'path', command), {
          baseDir: options?.baseDir,
          recursive: options?.recursive === true,
          getRoot,
        });
        return null;
      case 'remove':
        await opfsRemove(reqString(args, 'path', command), {
          baseDir: options?.baseDir,
          recursive: options?.recursive === true,
          getRoot,
        });
        return null;
      case 'read_dir':
        return opfsReadDir(reqString(args, 'path', command), {
          baseDir: options?.baseDir,
          getRoot,
        });
      case 'stat':
      case 'lstat':
        return opfsStat(reqString(args, 'path', command), {
          baseDir: options?.baseDir,
          getRoot,
        });
      case 'copy_file':
        await opfsCopyFile(reqString(args, 'fromPath', command), reqString(args, 'toPath', command), {
          fromBaseDir: options?.fromPathBaseDir,
          toBaseDir: options?.toPathBaseDir,
          getRoot,
        });
        return null;
      case 'rename':
        await opfsRename(reqString(args, 'oldPath', command), reqString(args, 'newPath', command), {
          oldBaseDir: options?.oldPathBaseDir,
          newBaseDir: options?.newPathBaseDir,
          getRoot,
        });
        return null;
      case 'create': {
        const path = reqString(args, 'path', command);
        await opfsWriteFile(path, new Uint8Array(0), {
          baseDir: options?.baseDir,
          create: true,
          createParents: false,
          getRoot,
        });
        const opened = await opfsOpenFileHandle(path, { baseDir: options?.baseDir, getRoot });
        const rid = nextRid++;
        openFiles.set(rid, { handle: opened.handle, path: opened.normalized, read: false, write: true, append: false, pos: 0 });
        return rid;
      }
      case 'open': {
        const path = reqString(args, 'path', command);
        const read = options?.read !== false;
        const write = options?.write === true;
        const append = options?.append === true;
        const truncate = options?.truncate === true;
        const create = options?.create === true;
        const createNew = options?.createNew === true;
        if (!read && !write && !append) {
          throw new Error('invalid open options');
        }
        if (!write && !append && (truncate || create || createNew)) {
          throw new Error('invalid open options: write access required');
        }
        if (createNew) {
          if (await opfsExists(path, { baseDir: options?.baseDir, getRoot })) {
            throw new Error(`file already exists: ${normalizeSandboxPath(path, options?.baseDir)}`);
          }
          await opfsWriteFile(path, new Uint8Array(0), {
            baseDir: options?.baseDir,
            create: true,
            createNew: true,
            createParents: false,
            getRoot,
          });
        } else if (truncate || (create && !(await opfsExists(path, { baseDir: options?.baseDir, getRoot })))) {
          await opfsWriteFile(path, new Uint8Array(0), {
            baseDir: options?.baseDir,
            create: create || truncate,
            createParents: false,
            getRoot,
          });
        }
        const opened = await opfsOpenFileHandle(path, { baseDir: options?.baseDir, create: false, getRoot });
        const file = await opened.handle.getFile();
        const rid = nextRid++;
        openFiles.set(rid, {
          handle: opened.handle,
          path: opened.normalized,
          read,
          write,
          append,
          pos: append ? file.size : 0,
        });
        return rid;
      }
      case 'read': {
        const res = getResource(reqNumber(args, 'rid', command));
        if (!res.read) throw new Error('file handle is not opened for reading');
        const len = Math.max(0, Math.trunc(reqNumber(args, 'len', command)));
        const file = await res.handle.getFile();
        const slice = file.slice(res.pos, res.pos + len);
        const chunk = await readBlobBytes(slice);
        res.pos += chunk.byteLength;
        return encodeReadChunkWithLength(chunk);
      }
      case 'write': {
        const res = getResource(reqNumber(args, 'rid', command));
        if (!res.write && !res.append) throw new Error('file handle is read-only');
        const rawData = args.data;
        if (!Array.isArray(rawData)) {
          throw new Error('invalid args `data` for command `write`: expected byte array');
        }
        const patch = Uint8Array.from(rawData as number[]);
        const current = await readBlobBytes(await res.handle.getFile());
        const offset = res.append ? current.byteLength : res.pos;
        const nextLen = Math.max(current.byteLength, offset + patch.byteLength);
        const updated = new Uint8Array(nextLen);
        updated.set(current, 0);
        updated.set(patch, offset);
        await opfsWriteFile(res.path, updated, { createParents: false, getRoot });
        if (!res.append) res.pos += patch.byteLength;
        return patch.byteLength;
      }
      case 'seek': {
        const res = getResource(reqNumber(args, 'rid', command));
        const offset = Math.trunc(reqNumber(args, 'offset', command));
        const whence = reqNumber(args, 'whence', command);
        let next: number;
        if (whence === 0) next = offset;
        else if (whence === 1) next = res.pos + offset;
        else if (whence === 2) next = (await res.handle.getFile()).size + offset;
        else throw new Error(`invalid seek whence: ${whence}`);
        if (next < 0) throw new Error('invalid seek offset before start of file');
        res.pos = next;
        return next;
      }
      case 'fstat': {
        const res = getResource(reqNumber(args, 'rid', command));
        return opfsStat(res.path, { getRoot });
      }
      case 'truncate':
      case 'ftruncate': {
        const len = typeof args.len === 'number' && Number.isFinite(args.len) ? Math.max(0, Math.trunc(args.len)) : 0;
        const targetPath = command === 'ftruncate'
          ? getResource(reqNumber(args, 'rid', command)).path
          : normalizeSandboxPath(reqString(args, 'path', command), options?.baseDir);
        const current = await readBlobBytes(await opfsReadFile(targetPath, { getRoot }));
        const next = new Uint8Array(len);
        next.set(current.subarray(0, Math.min(len, current.byteLength)), 0);
        await opfsWriteFile(targetPath, next, { createParents: false, getRoot });
        return null;
      }
      case 'size': {
        const info = await opfsStat(reqString(args, 'path', command), { baseDir: options?.baseDir, getRoot });
        return info.size;
      }
      default:
        throw new Error(`unsupported fs command "${command}"`);
    }
  };

  const resourcesHandler: MobilePluginHandler = ({ command, payload }) => {
    const args = parseJsonArgs(payload, 'resources');
    if (command !== 'close') {
      throw new Error(`unsupported resources command "${command}"`);
    }
    const rid = reqNumber(args, 'rid', command);
    openFiles.delete(rid);
    return null;
  };

  return { fs: fsHandler, resources: resourcesHandler };
}
