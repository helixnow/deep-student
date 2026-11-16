/**
 * 移动端主线程 OPFS（Origin Private File System）沙箱辅助模块。
 *
 * 所有文件操作均限制在 `/deep-student/**` 沙箱目录内，拒绝 `..` 路径穿越与沙箱外路径；
 * `main.ts`（dialog picks / backup）、`dialog.ts`（save staging）、`fs.ts`（`plugin:fs|*`）
 * 与 `opener.ts`（OPFS 导出 / 分享）共用此模块，避免重复逻辑。
 */
import { resolveMobileBaseDirectory } from './path.ts';

export const OPFS_SANDBOX_ROOT = '/deep-student';

export interface OpfsFileSnapshot {
  readonly size: number;
  readonly lastModified: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  slice(start?: number, end?: number): Blob;
}

export interface OpfsWritableFileStream {
  write(data: Blob | BufferSource | string): Promise<void>;
  close(): Promise<void>;
}

export interface OpfsFileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<OpfsWritableFileStream>;
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

export type OpfsRootGetter = () => Promise<OpfsDirectoryHandle>;

/** Read bytes from a `Blob` / `File`, falling back to `FileReader` in environments without `Blob.prototype.arrayBuffer` (e.g. jsdom). */
export async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      resolve(result instanceof ArrayBuffer ? new Uint8Array(result) : new Uint8Array(0));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob bytes'));
    reader.readAsArrayBuffer(blob);
  });
}

export async function getDefaultOpfsRoot(): Promise<OpfsDirectoryHandle> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    throw new Error('当前环境不支持 OPFS 存储');
  }
  return await navigator.storage.getDirectory() as unknown as OpfsDirectoryHandle;
}

/**
 * 规范化并校验路径，确保其严格位于 `/deep-student` 或 `/deep-student/**` 沙箱之内。
 * 拒绝 `..` 遍历、空字节与非法 URL scheme。
 */
export function normalizeSandboxPath(rawPath: string, baseDir?: unknown): string {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new Error('invalid path: expected non-empty string');
  }
  if (rawPath.includes('\0')) {
    throw new Error('invalid path: contains null byte');
  }

  let candidate = rawPath;
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(candidate);
  if (schemeMatch) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(candidate);
    } catch {
      throw new Error(`URL is not a valid path: ${rawPath}`);
    }
    if (parsedUrl.protocol !== 'file:') {
      throw new Error(`URL is not a valid path: ${rawPath}`);
    }
    candidate = decodeURIComponent(parsedUrl.pathname);
  }

  if (candidate.split(/[\\/]/).includes('..')) {
    throw new Error('cannot traverse directory, rewrite the path without the use of `../`');
  }

  let combined = candidate.replace(/\\/g, '/');
  if (!combined.startsWith('/')) {
    if (baseDir !== undefined && baseDir !== null) {
      const base = resolveMobileBaseDirectory(baseDir);
      combined = `${base}/${combined}`;
    } else {
      throw new Error(`forbidden path: ${rawPath}`);
    }
  }

  const parts = combined.split('/').filter(part => part !== '' && part !== '.');
  const normalized = `/${parts.join('/')}`;
  if (normalized !== OPFS_SANDBOX_ROOT && !normalized.startsWith(`${OPFS_SANDBOX_ROOT}/`)) {
    throw new Error(`forbidden path: ${rawPath}`);
  }
  return normalized;
}

export function isSandboxPath(rawPath: string): boolean {
  try {
    normalizeSandboxPath(rawPath);
    return true;
  } catch {
    return false;
  }
}

export function splitSandboxParts(normalizedPath: string): string[] {
  return normalizedPath.split('/').filter(Boolean);
}

type OpfsChildEntry =
  | { readonly kind: 'file'; readonly handle: OpfsFileHandle }
  | { readonly kind: 'directory'; readonly handle: OpfsDirectoryHandle };

async function getDirectoryAt(
  root: OpfsDirectoryHandle,
  parts: readonly string[],
  create: boolean,
): Promise<OpfsDirectoryHandle> {
  let dir = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create });
  }
  return dir;
}

async function findChild(parent: OpfsDirectoryHandle, name: string): Promise<OpfsChildEntry | null> {
  try {
    return { kind: 'file', handle: await parent.getFileHandle(name) };
  } catch (error) {
    const errName = (error as { name?: unknown } | null)?.name;
    if (errName === 'NotFoundError') return null;
    if (errName !== 'TypeMismatchError') throw error;
  }
  try {
    return { kind: 'directory', handle: await parent.getDirectoryHandle(name) };
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === 'NotFoundError') return null;
    throw error;
  }
}

async function resolveEntry(root: OpfsDirectoryHandle, normalizedPath: string): Promise<{
  parent: OpfsDirectoryHandle | null;
  name: string | null;
  entry: OpfsChildEntry;
}> {
  const parts = splitSandboxParts(normalizedPath);
  const name = parts.pop();
  if (!name) {
    return { parent: null, name: null, entry: { kind: 'directory', handle: root } };
  }
  const parent = await getDirectoryAt(root, parts, false);
  const entry = await findChild(parent, name);
  if (!entry) {
    throw new Error(`no such file or directory: ${normalizedPath}`);
  }
  return { parent, name, entry };
}

export async function opfsEnsureDir(
  path: string,
  options: { recursive?: boolean; getRoot?: OpfsRootGetter; baseDir?: unknown } = {},
): Promise<OpfsDirectoryHandle> {
  const normalized = normalizeSandboxPath(path, options.baseDir);
  const root = await (options.getRoot ?? getDefaultOpfsRoot)();
  const parts = splitSandboxParts(normalized);
  const recursive = options.recursive ?? true;
  if (recursive) {
    return getDirectoryAt(root, parts, true);
  }
  const name = parts.pop();
  if (!name) return root;
  const parent = await getDirectoryAt(root, parts, false);
  const existing = await findChild(parent, name);
  if (existing !== null) {
    throw new Error(`file already exists: ${normalized}`);
  }
  return parent.getDirectoryHandle(name, { create: true });
}

export async function opfsReadFile(
  path: string,
  options: { getRoot?: OpfsRootGetter; baseDir?: unknown } = {},
): Promise<File> {
  const normalized = normalizeSandboxPath(path, options.baseDir);
  const root = await (options.getRoot ?? getDefaultOpfsRoot)();
  const { entry } = await resolveEntry(root, normalized);
  if (entry.kind !== 'file') {
    throw new Error(`is a directory: ${normalized}`);
  }
  return entry.handle.getFile();
}

export interface OpfsWriteOptions {
  readonly mimeType?: string;
  readonly append?: boolean;
  readonly create?: boolean;
  readonly createNew?: boolean;
  readonly createParents?: boolean;
  readonly baseDir?: unknown;
  readonly getRoot?: OpfsRootGetter;
}

export async function opfsWriteFile(
  path: string,
  data: Blob | Uint8Array | ArrayBuffer,
  options: OpfsWriteOptions | string = {},
): Promise<void> {
  const resolvedOpts: OpfsWriteOptions = typeof options === 'string' ? { mimeType: options } : options;
  const normalized = normalizeSandboxPath(path, resolvedOpts.baseDir);
  const parts = splitSandboxParts(normalized);
  const name = parts.pop();
  if (!name) throw new Error(`is a directory: ${normalized}`);

  const root = await (resolvedOpts.getRoot ?? getDefaultOpfsRoot)();
  const parent = await getDirectoryAt(root, parts, resolvedOpts.createParents ?? true);
  const existing = await findChild(parent, name);
  if (existing?.kind === 'directory') {
    throw new Error(`is a directory: ${normalized}`);
  }
  if (resolvedOpts.createNew === true && existing !== null) {
    throw new Error(`file already exists: ${normalized}`);
  }
  if (resolvedOpts.create === false && existing === null) {
    throw new Error(`no such file or directory: ${normalized}`);
  }

  const handle = existing?.handle ?? await parent.getFileHandle(name, { create: true });
  const mimeType = resolvedOpts.mimeType ?? 'application/octet-stream';

  if (resolvedOpts.append === true && existing !== null) {
    const prevBytes = await readBlobBytes(await existing.handle.getFile());
    const nextBytes = data instanceof Uint8Array
      ? data
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : await readBlobBytes(data);
    const merged = new Uint8Array(prevBytes.byteLength + nextBytes.byteLength);
    merged.set(prevBytes, 0);
    merged.set(nextBytes, prevBytes.byteLength);
    const writable = await handle.createWritable();
    try {
      await writable.write(new Blob([merged], { type: mimeType }));
    } finally {
      await writable.close();
    }
    return;
  }

  const writable = await handle.createWritable();
  try {
    // Keep Blob streaming intact without calling file.arrayBuffer().
    if (data instanceof Blob) {
      await writable.write(data);
    } else {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      await writable.write(new Blob([copy], { type: mimeType }));
    }
  } finally {
    await writable.close();
  }
}

export async function opfsExists(
  path: string,
  options: { getRoot?: OpfsRootGetter; baseDir?: unknown } = {},
): Promise<boolean> {
  const normalized = normalizeSandboxPath(path, options.baseDir);
  const root = await (options.getRoot ?? getDefaultOpfsRoot)();
  try {
    await resolveEntry(root, normalized);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('no such file or directory:')) {
      return false;
    }
    if ((error as { name?: unknown } | null)?.name === 'NotFoundError') {
      return false;
    }
    throw error;
  }
}

export interface OpfsDirEntryInfo {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymlink: boolean;
}

export async function opfsReadDir(
  path: string,
  options: { getRoot?: OpfsRootGetter; baseDir?: unknown } = {},
): Promise<OpfsDirEntryInfo[]> {
  const normalized = normalizeSandboxPath(path, options.baseDir);
  const root = await (options.getRoot ?? getDefaultOpfsRoot)();
  const { entry } = await resolveEntry(root, normalized);
  if (entry.kind !== 'directory') {
    throw new Error(`not a directory: ${normalized}`);
  }
  const items: OpfsDirEntryInfo[] = [];
  for await (const [name, handle] of entry.handle.entries()) {
    items.push({
      name,
      isDirectory: handle.kind === 'directory',
      isFile: handle.kind === 'file',
      isSymlink: false,
    });
  }
  items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return items;
}

export interface OpfsStatInfo {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymlink: boolean;
  readonly size: number;
  readonly mtime: number | null;
  readonly atime: number | null;
  readonly birthtime: number | null;
  readonly readonly: boolean;
  readonly fileAttributes: null;
  readonly dev: null;
  readonly ino: null;
  readonly mode: null;
  readonly nlink: null;
  readonly uid: null;
  readonly gid: null;
  readonly rdev: null;
  readonly blksize: null;
  readonly blocks: null;
}

export async function opfsStat(
  path: string,
  options: { getRoot?: OpfsRootGetter; baseDir?: unknown } = {},
): Promise<OpfsStatInfo> {
  const normalized = normalizeSandboxPath(path, options.baseDir);
  const root = await (options.getRoot ?? getDefaultOpfsRoot)();
  const { entry } = await resolveEntry(root, normalized);
  const baseNulls = {
    isSymlink: false,
    readonly: false,
    fileAttributes: null,
    dev: null,
    ino: null,
    mode: null,
    nlink: null,
    uid: null,
    gid: null,
    rdev: null,
    blksize: null,
    blocks: null,
  } as const;
  if (entry.kind === 'directory') {
    return {
      isFile: false,
      isDirectory: true,
      size: 0,
      mtime: null,
      atime: null,
      birthtime: null,
      ...baseNulls,
    };
  }
  const file = await entry.handle.getFile();
  const mtime = Number.isFinite(file.lastModified) ? Math.trunc(file.lastModified) : null;
  return {
    isFile: true,
    isDirectory: false,
    size: file.size,
    mtime,
    atime: mtime,
    birthtime: null,
    ...baseNulls,
  };
}

export async function opfsRemove(
  path: string,
  options: { recursive?: boolean; getRoot?: OpfsRootGetter; baseDir?: unknown } = {},
): Promise<void> {
  const normalized = normalizeSandboxPath(path, options.baseDir);
  if (normalized === OPFS_SANDBOX_ROOT) {
    throw new Error('forbidden path: cannot remove sandbox root');
  }
  const root = await (options.getRoot ?? getDefaultOpfsRoot)();
  const { parent, name, entry } = await resolveEntry(root, normalized);
  if (!parent || !name) {
    throw new Error('forbidden path: cannot remove sandbox root');
  }
  if (entry.kind === 'directory' && options.recursive !== true) {
    for await (const _ of entry.handle.entries()) {
      throw new Error(`directory not empty: ${normalized}`);
    }
  }
  await parent.removeEntry(name, { recursive: options.recursive === true });
}

export async function opfsCopyFile(
  fromPath: string,
  toPath: string,
  options: { fromBaseDir?: unknown; toBaseDir?: unknown; getRoot?: OpfsRootGetter } = {},
): Promise<void> {
  const fromNorm = normalizeSandboxPath(fromPath, options.fromBaseDir);
  const toNorm = normalizeSandboxPath(toPath, options.toBaseDir);
  const getRoot = options.getRoot ?? getDefaultOpfsRoot;
  const file = await opfsReadFile(fromNorm, { getRoot });
  await opfsWriteFile(toNorm, file, { createParents: false, getRoot });
}

async function copyDirectoryRecursive(
  src: OpfsDirectoryHandle,
  destParent: OpfsDirectoryHandle,
  destName: string,
): Promise<void> {
  const destDir = await destParent.getDirectoryHandle(destName, { create: true });
  for await (const [childName, handle] of src.entries()) {
    if (handle.kind === 'file') {
      const file = await handle.getFile();
      const target = await destDir.getFileHandle(childName, { create: true });
      const writable = await target.createWritable();
      try {
        await writable.write(file);
      } finally {
        await writable.close();
      }
    } else {
      await copyDirectoryRecursive(handle, destDir, childName);
    }
  }
}

export async function opfsRename(
  oldPath: string,
  newPath: string,
  options: { oldBaseDir?: unknown; newBaseDir?: unknown; getRoot?: OpfsRootGetter } = {},
): Promise<void> {
  const fromNorm = normalizeSandboxPath(oldPath, options.oldBaseDir);
  const toNorm = normalizeSandboxPath(newPath, options.newBaseDir);
  if (fromNorm === OPFS_SANDBOX_ROOT || toNorm === OPFS_SANDBOX_ROOT) {
    throw new Error('forbidden path: cannot rename sandbox root');
  }
  if (fromNorm === toNorm) return;

  const root = await (options.getRoot ?? getDefaultOpfsRoot)();
  const src = await resolveEntry(root, fromNorm);
  if (!src.parent || !src.name) {
    throw new Error('forbidden path: cannot rename sandbox root');
  }
  const destParts = splitSandboxParts(toNorm);
  const destName = destParts.pop()!;
  const destParent = await getDirectoryAt(root, destParts, false);

  if (typeof src.entry.handle.move === 'function') {
    try {
      await src.entry.handle.move(destParent, destName);
      return;
    } catch (error) {
      if ((error as { name?: unknown } | null)?.name !== 'NotAllowedError') {
        throw error;
      }
    }
  }

  if (src.entry.kind === 'file') {
    const file = await src.entry.handle.getFile();
    const destHandle = await destParent.getFileHandle(destName, { create: true });
    const writable = await destHandle.createWritable();
    try {
      await writable.write(file);
    } finally {
      await writable.close();
    }
    await src.parent.removeEntry(src.name);
    return;
  }

  await copyDirectoryRecursive(src.entry.handle, destParent, destName);
  await src.parent.removeEntry(src.name, { recursive: true });
}

export async function opfsOpenFileHandle(
  path: string,
  options: { create?: boolean; baseDir?: unknown; getRoot?: OpfsRootGetter } = {},
): Promise<{ normalized: string; handle: OpfsFileHandle }> {
  const normalized = normalizeSandboxPath(path, options.baseDir);
  const parts = splitSandboxParts(normalized);
  const name = parts.pop();
  if (!name) throw new Error(`is a directory: ${normalized}`);
  const root = await (options.getRoot ?? getDefaultOpfsRoot)();
  const parent = await getDirectoryAt(root, parts, false);
  const existing = await findChild(parent, name);
  if (existing?.kind === 'directory') {
    throw new Error(`is a directory: ${normalized}`);
  }
  if (existing === null && options.create !== true) {
    throw new Error(`no such file or directory: ${normalized}`);
  }
  const handle = existing?.handle ?? await parent.getFileHandle(name, { create: true });
  return { normalized, handle };
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  zip: 'application/zip',
  apkg: 'application/octet-stream',
  json: 'application/json',
  md: 'text/markdown;charset=utf-8',
  txt: 'text/plain;charset=utf-8',
  csv: 'text/csv;charset=utf-8',
  html: 'text/html;charset=utf-8',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

export function inferMimeType(fileName: string, fallback = 'application/octet-stream'): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? fallback;
}

/** 把 OPFS 里的文件交给系统：Web Share → File System Access → 浏览器下载。 */
export async function saveOpfsFileToSystem(
  path: string,
  fileName: string,
  mimeType?: string,
  getRoot: OpfsRootGetter = getDefaultOpfsRoot,
): Promise<{ method: string }> {
  const file = await opfsReadFile(path, { getRoot });
  const resolvedType = mimeType ?? (file.type || inferMimeType(fileName));
  const shareFile = new File([file], fileName, { type: resolvedType });

  const navigatorWithShare = navigator as Navigator & {
    canShare?(data?: ShareData): boolean;
    share?(data?: ShareData): Promise<void>;
  };
  if (navigatorWithShare.canShare?.({ files: [shareFile] }) === true && typeof navigatorWithShare.share === 'function') {
    await navigatorWithShare.share({ files: [shareFile], title: fileName });
    return { method: 'share' };
  }

  const picker = (window as unknown as {
    showSaveFilePicker?: (options: {
      suggestedName?: string;
      types?: Array<{ description?: string; accept: Record<string, string[]> }>;
    }) => Promise<{ createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }> }>;
  }).showSaveFilePicker;
  if (typeof picker === 'function') {
    const ext = fileName.includes('.') ? `.${fileName.split('.').pop()!.toLowerCase()}` : '';
    const acceptMime = resolvedType.split(';')[0]!.trim() || 'application/octet-stream';
    const handle = await picker.call(window, {
      suggestedName: fileName,
      ...(ext ? { types: [{ description: fileName, accept: { [acceptMime]: [ext] } }] } : {}),
    });
    const writable = await handle.createWritable();
    await writable.write(shareFile);
    await writable.close();
    return { method: 'save-picker' };
  }

  const url = URL.createObjectURL(shareFile);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { method: 'download' };
}
