/**
 * Mobile implementation of the synchronous local-runtime ports used by `vfs`, `vfs-repos`, `notes`,
 * `qbank`, `anki`, `sync` and `chat`.
 *
 * Those ports mirror `node:fs` because the Rust side is synchronous (`std::fs`), while the mobile
 * Host has only the asynchronous `ctx.files` (OPFS). This module bridges the two with an in-memory
 * virtual tree:
 *
 * - the tree hydrates in the background from OPFS on plugin startup (`slots/`, `notes_assets/`,
 *   `chat_v2_temp/`, `chat_v2_artifacts/`, `textbooks/`, `recovery/`, `tmp/`, `attachments/`);
 * - every synchronous probe (`exists`, `isFile`, `isDir`, `fileLen`, `readFileSync`/`readBytes`,
 *   `readText`, `readDir`, `stat`, ...) is answered from that tree without touching the network;
 * - every mutation updates the tree first and then flushes to OPFS asynchronously, so command
 *   results do not wait for storage while the bytes still survive a reload.
 *
 * Portability: this file must stay free of `node:*` imports — `scripts/portability/scan.mjs
 * --profile host/profiles/mobile.json` includes it through each plugin's `mobile.ts` entry.
 *
 * Operations that need Node-only capabilities (zstd, worker threads) keep throwing
 * `local filesystem unavailable: <op>`, exactly like the
 * previous default ports, so those commands keep their explicit degradation.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { DirEntry, FilesService, FileKind } from './api.ts';
import { isVirtualUri } from '../storage/file-names.ts';
import type { LocalRuntime as VfsLocalRuntime, LocalStats as VfsLocalStats, LocalBigStats as VfsLocalBigStats,
  LocalDirent as VfsLocalDirent, LocalAsyncHandle as VfsLocalAsyncHandle, LocalPath as VfsLocalPath } from '../../plugins/vfs/src/local-runtime.ts';
import type { NotesLocalRuntime, LocalStat as NotesLocalStat, LocalDirEntry as NotesLocalDirEntry,
  LocalPathClassification } from '../../plugins/notes/src/local-runtime.ts';
import type { QbankLocalRuntime, LocalReadHandle as QbankLocalReadHandle,
  LocalWriteHandle as QbankLocalWriteHandle } from '../../plugins/qbank/src/local-runtime.ts';
import type { AnkiLocalRuntime, LocalStat as AnkiLocalStat } from '../../plugins/anki/src/local-runtime.ts';
import type { LocalRuntime as SyncLocalRuntime, LocalStats as SyncLocalStats,
  LocalBigStats as SyncLocalBigStats, LocalAsyncHandle as SyncLocalAsyncHandle } from '../../plugins/sync/src/local-runtime.ts';
import type { VfsReposLocalRuntime, LocalStat as VfsReposLocalStat,
  LocalReadHandle as VfsReposLocalReadHandle, LocalWriteHandle as VfsReposLocalWriteHandle,
  LocalZipArchive, LocalWorkerHandle, LocalWorkerOptions } from '../../plugins/vfs-repos/src/local-runtime.ts';
import type { ChatLocalFs, LocalStat as ChatLocalStat,
  LocalReadHandle as ChatLocalReadHandle, LocalWriteHandle as ChatLocalWriteHandle } from '../../plugins/chat/src/local-fs.ts';
import { Disposer } from '../../kernel/api.ts';
import type { SqlExecutor } from '../storage/api.ts';
import type { NoteAssetRetention, PreparedDeletionIntent } from '../storage/node.ts';
import { decodeBase64Standard } from '../util/portable.ts';
import pako from 'pako';
import { ZipArchiveReader } from '../../plugins/anki/src/apkg-zip.ts';

interface MobileStagedUpload {
  name: string;
  total: number;
  received: number;
  chunks: Uint8Array[];
}

const stagedUploads = new Map<string, MobileStagedUpload>();

export function beginMobileStagedUpload(name: string, totalSize: number): string {
  if (!Number.isSafeInteger(totalSize) || totalSize < 0) throw new Error('Invalid upload size');
  const uploadId = globalThis.crypto.randomUUID();
  stagedUploads.set(uploadId, { name, total: totalSize, received: 0, chunks: [] });
  return uploadId;
}

export function appendMobileStagedUpload(uploadId: string, offset: number, data: string | Uint8Array): number {
  const entry = stagedUploads.get(uploadId);
  if (!entry) throw new Error(`Unknown or expired upload: ${uploadId}`);
  if (offset !== entry.received) throw new Error(`Unexpected chunk offset ${offset} (expected ${entry.received})`);
  let bytes: Uint8Array;
  if (typeof data === 'string') {
    const decoded = decodeBase64Standard(data);
    if (decoded.error !== undefined) throw new Error(`Invalid chunk base64: ${decoded.error}`);
    bytes = new Uint8Array(decoded.bytes);
  } else bytes = data.slice();
  if (bytes.byteLength > 16 * 1024 * 1024) throw new Error('Chunk too large');
  if (entry.received + bytes.byteLength > entry.total) {
    abortMobileStagedUpload(uploadId);
    throw new Error('Chunk exceeds declared size');
  }
  entry.chunks.push(bytes);
  entry.received += bytes.byteLength;
  return entry.received;
}

export function abortMobileStagedUpload(uploadId: string): void {
  stagedUploads.delete(uploadId);
}

export function takeMobileStagedUpload(uploadId: string, tree: MobileLocalRuntime): ReturnType<VfsLocalRuntime['takeStagedUpload']> {
  const entry = stagedUploads.get(uploadId);
  if (!entry) throw new Error(`Unknown or expired upload: ${uploadId}`);
  stagedUploads.delete(uploadId);
  if (entry.received !== entry.total) throw new Error(`Upload incomplete: received ${entry.received} of ${entry.total} bytes`);
  const path = tree.resolvePath(`tmp/staged_uploads/${uploadId}.part`);
  tree.writeBytes(path, concatenate(entry.chunks, entry.received));
  return {
    path: () => path,
    name: () => entry.name,
    size: () => entry.received,
    readBounded: maxBytes => {
      if (entry.received > maxBytes) throw new Error(`File too large: ${entry.received} > ${maxBytes}`);
      return tree.readBytes(path);
    },
    dispose: () => tree.removeForce(path),
  };
}

/** The six plugin ports plus the chat port, all sharing one in-memory tree. */
export interface MobileLocalRuntimeBundle {
  readonly vfs: VfsLocalRuntime;
  readonly notes: NotesLocalRuntime;
  readonly qbank: QbankLocalRuntime;
  readonly anki: AnkiLocalRuntime;
  readonly sync: SyncLocalRuntime;
  readonly vfsRepos: VfsReposLocalRuntime;
  readonly chat: ChatLocalFs;
}

export interface MobileLocalRuntimeOptions {
  /** `readBundledText` for the anki port (builtin templates are a plugin data file, not OPFS). */
  readonly readBundledText?: (name: string) => string;
  readonly log?: { warn(message: string): void; debug?(message: string): void };
}

interface FileNode {
  readonly kind: 'file';
  data: Uint8Array;
  mtimeMs: number;
}

interface DirNode {
  readonly kind: 'directory';
  mtimeMs: number;
}

type Node = FileNode | DirNode;

interface OpenHandle {
  readonly path: string;
  readonly mode: 'read' | 'write' | 'append';
  position: number;
  readonly data?: Uint8Array;
}

function unavailable(operation: string): never {
  throw new Error(`local filesystem unavailable: ${operation}`);
}

function ioError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

const ENOENT = (path: string) => ioError('ENOENT', `ENOENT: no such file or directory, open '${path}'`);
const EISDIR = (path: string) => ioError('EISDIR', `EISDIR: illegal operation on a directory, '${path}'`);
const ENOTDIR = (path: string) => ioError('ENOTDIR', `ENOTDIR: not a directory, '${path}'`);
const ENOTEMPTY = (path: string) => ioError('ENOTEMPTY', `ENOTEMPTY: directory not empty, '${path}'`);
const EEXIST = (path: string) => ioError('EEXIST', `EEXIST: file already exists, '${path}'`);

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function concatenate(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

/** Keep the bounded inflate contract used by APKG entry reads. */
function inflateRaw(bytes: Uint8Array, maxOutputLength?: number): Uint8Array {
  if (maxOutputLength === undefined) return pako.inflateRaw(bytes);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inflater = new pako.Inflate({ raw: true });
  inflater.onData = (chunk: Uint8Array) => {
    total += chunk.length;
    if (total > maxOutputLength) {
      throw ioError('ERR_BUFFER_TOO_LARGE', `Inflated data exceeds ${maxOutputLength} bytes`);
    }
    chunks.push(chunk);
  };
  inflater.push(bytes, true);
  if (inflater.err) throw new Error(inflater.msg || 'Invalid raw deflate data');
  return concatenate(chunks, total);
}

/** Kids of a normalized absolute path, sorted by name (UTF-16 code units, like the desktop port). */
function basename(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  if (index <= 0) return '/';
  return path.slice(0, index);
}

/** Ports for the seven plugins, sharing one {@link MemoryTree}. */
export class MobileLocalRuntime {
  private readonly dataDir: string;
  private readonly files: () => FilesService | undefined;
  private readonly log?: MobileLocalRuntimeOptions['log'];
  private readonly readBundledText?: (name: string) => string;
  private readonly nodes = new Map<string, Node>();
  /** Paths mutated while hydration was running: the OPFS scan must not overwrite them. */
  private readonly locallyWritten = new Set<string>();
  private readonly handles = new Map<number, OpenHandle>();
  private nextFd = 1;
  private flushChain: Promise<void> = Promise.resolve();
  private hydration: Promise<void> | null = null;
  private hydrated = false;

  constructor(dataDir: string, files: () => FilesService | undefined, options: MobileLocalRuntimeOptions = {}) {
    this.dataDir = dataDir.replace(/\/+$/, '') || '/';
    this.files = files;
    this.log = options.log;
    this.readBundledText = options.readBundledText;
    this.nodes.set(this.root, { kind: 'directory', mtimeMs: Date.now() });
  }

  /** OPFS side of the port; absent only before the files plugin has provided its service. */
  private get service(): FilesService | undefined {
    try { return this.files(); }
    catch { return undefined; }
  }

  private get root(): string { return '/'; }

  // ------------------------------------------------------------------ path algebra

  /** Lexical POSIX normalization; relative inputs resolve against the app data dir. */
  resolvePath(input: string | Uint8Array): string {
    let raw = typeof input === 'string' ? input : decodeUtf8(input);
    raw = raw.replaceAll('\\', '/');
    if (!raw.startsWith('/')) raw = `${this.dataDir}/${raw}`;
    const out: string[] = [];
    for (const part of raw.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') { out.pop(); continue; }
      out.push(part);
    }
    return `/${out.join('/')}`;
  }

  private ensureDirs(path: string): void {
    let current = '/';
    for (const part of path.split('/')) {
      if (part === '') continue;
      current = current === '/' ? `/${part}` : `${current}/${part}`;
      if (!this.nodes.has(current)) this.nodes.set(current, { kind: 'directory', mtimeMs: Date.now() });
    }
  }

  private setFile(path: string, data: Uint8Array, localMutation = true): void {
    this.ensureDirs(dirname(path));
    const existing = this.nodes.get(path);
    const mtimeMs = existing?.mtimeMs ?? Date.now();
    this.nodes.set(path, { kind: 'file', data, mtimeMs });
    if (localMutation) this.locallyWritten.add(path);
  }

  private node(path: string): Node {
    const input = this.resolvePath(path);
    const node = this.nodes.get(input);
    if (node === undefined) throw ENOENT(input);
    return node;
  }

  private fileNode(path: string): FileNode {
    const node = this.node(path);
    if (node.kind === 'directory') throw EISDIR(this.resolvePath(path));
    return node;
  }

  private dirNode(path: string): DirNode {
    const node = this.node(path);
    if (node.kind === 'file') throw ENOTDIR(this.resolvePath(path));
    return node;
  }

  private childNames(path: string): string[] {
    const prefix = path === '/' ? '/' : `${path}/`;
    const names: string[] = [];
    for (const key of this.nodes.keys()) {
      if (key === path || !key.startsWith(prefix)) continue;
      if (key.slice(prefix.length).includes('/')) continue;
      names.push(basename(key));
    }
    return names.sort();
  }

  /** Synchronous OPFS flush; writes are ordered and failures never undo the in-memory change. */
  private enqueue(operation: () => Promise<void>): void {
    if (this.service === undefined) return;
    this.flushChain = this.flushChain.then(operation).catch((error: unknown) => {
      this.log?.warn(`mobile local runtime flush failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  // ------------------------------------------------------------------ background hydration

  /**
   * Starts (once) the OPFS scan that seeds the in-memory tree. If `ctx.files` is not published yet the
   * scan is retried by the next plugin that shares this instance, instead of latching an empty tree.
   */
  startHydration(): Promise<void> {
    if (this.hydration === null) {
      this.hydration = this.hydrate().then(() => {
        if (!this.hydrated) this.hydration = null;
      });
    }
    return this.hydration;
  }

  get isHydrated(): boolean { return this.hydrated; }

  private async hydrate(): Promise<void> {
    const files = this.service;
    if (files === undefined) return;
    // Only roots a synchronous port actually reads. `recovery/` and `tmp/` hold backup ZIPs and
    // picked archives; hydrating them would duplicate tens of megabytes into the Worker for nothing.
    const roots = [
      `${this.dataDir}/slots`,
      `${this.dataDir}/notes_assets`,
      `${this.dataDir}/chat_v2_temp`,
      `${this.dataDir}/chat_v2_artifacts`,
      `${this.dataDir}/textbooks`,
      `${this.dataDir}/attachments`,
    ];
    for (const root of roots) {
      try {
        if (!(await files.exists(root).catch(() => false))) continue;
        this.ensureDirs(this.resolvePath(root));
        for await (const entry of walkEntries(files, root)) {
          const path = this.resolvePath(entry.path);
          if (entry.kind === 'directory') {
            this.ensureDirs(path);
            continue;
          }
          if (entry.kind !== 'file') continue;
          if (this.locallyWritten.has(path)) continue;
          try {
            const bytes = await files.readBytes(entry.path);
            if (!this.locallyWritten.has(path)) this.setFile(path, bytes, false);
          } catch (error) {
            this.log?.warn(`mobile local runtime could not hydrate ${entry.path}: ${
              error instanceof Error ? error.message : String(error)}`);
          }
        }
      } catch (error) {
        this.log?.warn(`mobile local runtime could not scan ${root}: ${
          error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.hydrated = true;
  }

  // ------------------------------------------------------------------ synchronous file primitives

  exists(path: string | Uint8Array): boolean {
    return this.nodes.has(this.resolvePath(path));
  }

  isFile(path: string): boolean {
    return this.nodes.get(this.resolvePath(path))?.kind === 'file';
  }

  isDir(path: string): boolean {
    return this.nodes.get(this.resolvePath(path))?.kind === 'directory';
  }

  fileLen(path: string): number {
    const node = this.nodes.get(this.resolvePath(path));
    return node?.kind === 'file' ? node.data.byteLength : 0;
  }

  readBytes(path: string): Uint8Array {
    return this.fileNode(path).data.slice();
  }

  readText(path: string): string {
    return decodeUtf8(this.fileNode(path).data);
  }

  statPath(path: string | Uint8Array): Node & { size: number; mtimeMs: number } {
    const node = this.node(this.resolvePath(path));
    return Object.assign(node, { size: node.kind === 'file' ? node.data.byteLength : 0 });
  }

  readDirNames(path: string): string[] {
    this.dirNode(path);
    return this.childNames(this.resolvePath(path));
  }

  readDirKind(path: string): Array<{ name: string; kind: FileKind }> {
    const dir = this.resolvePath(path);
    this.dirNode(dir);
    return this.childNames(dir).map(name => ({
      name,
      kind: this.nodes.get(`${dir === '/' ? '' : dir}/${name}`)!.kind,
    }));
  }

  mkdirp(path: string): void {
    this.ensureDirs(this.resolvePath(path));
    const target = this.resolvePath(path);
    this.enqueue(async () => { await this.service?.mkdir(target, { recursive: true }); });
  }

  writeBytes(path: string, bytes: Uint8Array, options?: { readonly exclusive?: boolean }): void {
    const target = this.resolvePath(path);
    if (options?.exclusive === true && this.nodes.has(target)) throw EEXIST(target);
    this.setFile(target, bytes.slice());
    this.enqueue(async () => {
      await this.service?.writeBytes(target, bytes, { createParents: true, ...(options?.exclusive === true ? { exclusive: true } : {}) });
    });
  }

  writeText(path: string, text: string): void {
    this.writeBytes(path, encodeUtf8(text));
  }

  appendBytes(path: string, bytes: Uint8Array): void {
    const target = this.resolvePath(path);
    const existing = this.nodes.get(target);
    const next = existing?.kind === 'file'
      ? concatenate([existing.data, bytes], existing.data.byteLength + bytes.byteLength)
      : bytes.slice();
    this.setFile(target, next);
    this.enqueue(async () => {
      if (existing?.kind === 'file') await this.service?.append(target, bytes, { createParents: true });
      else await this.service?.writeBytes(target, next, { createParents: true });
    });
  }

  unlink(path: string): void {
    const target = this.resolvePath(path);
    const node = this.nodes.get(target);
    if (node === undefined) throw ENOENT(target);
    if (node.kind === 'directory') throw EISDIR(target);
    this.nodes.delete(target);
    this.locallyWritten.add(target);
    this.enqueue(async () => { await this.service?.rm(target, { force: true }); });
  }

  rmdir(path: string): void {
    const target = this.resolvePath(path);
    this.dirNode(target);
    if (this.childNames(target).length > 0) throw ENOTEMPTY(target);
    this.nodes.delete(target);
    this.locallyWritten.add(target);
    this.enqueue(async () => { await this.service?.rm(target, { recursive: false, force: true }); });
  }

  removeDirAll(path: string): void {
    const target = this.resolvePath(path);
    const prefix = target === '/' ? '/' : `${target}/`;
    for (const key of [...this.nodes.keys()]) {
      if (key === target || key.startsWith(prefix)) { this.nodes.delete(key); this.locallyWritten.add(key); }
    }
    this.enqueue(async () => { await this.service?.rm(target, { recursive: true, force: true }); });
  }

  removeForce(path: string): void {
    const target = this.resolvePath(path);
    this.nodes.delete(target);
    this.locallyWritten.add(target);
    this.enqueue(async () => { await this.service?.rm(target, { force: true }); });
  }

  /** `rm` / `rmSync` semantics: directories need `recursive` or must be empty. */
  removePath(path: string, options: { readonly recursive?: boolean; readonly force?: boolean } = {}): void {
    const target = this.resolvePath(path);
    const node = this.nodes.get(target);
    if (node === undefined) {
      if (options.force === true) return;
      throw ENOENT(target);
    }
    if (node.kind === 'file') {
      this.nodes.delete(target);
      this.locallyWritten.add(target);
      this.enqueue(async () => { await this.service?.rm(target, { force: true }); });
      return;
    }
    if (options.recursive === true) { this.removeDirAll(target); return; }
    if (this.childNames(target).length > 0) throw ENOTEMPTY(target);
    this.nodes.delete(target);
    this.locallyWritten.add(target);
    this.enqueue(async () => {
      await this.service?.rm(target, { recursive: false, force: options.force === true });
    });
  }

  rename(from: string, to: string): void {
    const source = this.resolvePath(from);
    const target = this.resolvePath(to);
    const node = this.nodes.get(source);
    if (node === undefined) throw ENOENT(source);
    this.ensureDirs(dirname(target));
    this.locallyWritten.add(source);
    this.locallyWritten.add(target);
    if (node.kind === 'directory') {
      const prefix = `${source}/`;
      const moves = [...this.nodes.entries()].filter(([key]) => key === source || key.startsWith(prefix));
      for (const [key] of moves) this.nodes.delete(key);
      for (const [key, value] of moves) {
        this.nodes.set(`${target}${key.slice(source.length)}`, value);
        this.locallyWritten.add(`${target}${key.slice(source.length)}`);
      }
    } else {
      this.nodes.delete(source);
      this.nodes.set(target, node);
    }
    this.enqueue(async () => { await this.service?.rename(source, target, { overwrite: true, createParents: true }); });
  }

  copyFile(from: string, to: string): void {
    const source = this.fileNode(from).data.slice();
    const target = this.resolvePath(to);
    this.setFile(target, source);
    this.enqueue(async () => { await this.service?.copyFile(this.resolvePath(from), target, { overwrite: true, createParents: true }); });
  }

  /** `mkdtemp`: caller passes the prefix; the random component is appended. */
  async makeTempDir(prefix: string): Promise<string> {
    const path = `${prefix}${Math.random().toString(36).slice(2, 10)}`;
    this.mkdirp(path);
    return this.resolvePath(path);
  }

  // ------------------------------------------------------------------ fd-based reads / writes

  openFd(path: string, flags: string, mode?: { readonly exclusive?: boolean }): number {
    const target = this.resolvePath(path);
    const exclusive = flags.includes('x') || mode?.exclusive === true;
    if (exclusive && this.nodes.has(target)) throw EEXIST(target);
    if (flags.includes('w')) this.setFile(target, new Uint8Array(0));
    const node = this.nodes.get(target);
    if (node === undefined && !flags.includes('w') && !flags.includes('a')) throw ENOENT(target);
    if (node?.kind === 'directory') throw EISDIR(target);
    const fd = this.nextFd++;
    const writing = flags.includes('w') || flags.includes('a');
    this.handles.set(fd, {
      path: target, mode: writing ? (flags.includes('a') ? 'append' : 'write') : 'read', position: 0,
      data: node?.kind === 'file' ? node.data : new Uint8Array(0),
    });
    return fd;
  }

  readFd(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number {
    const handle = this.handles.get(fd);
    if (handle === undefined) throw ioError('EBADF', `EBADF: bad file descriptor, read`);
    const data = handle.data ?? new Uint8Array(0);
    const start = position ?? handle.position;
    if (start >= data.byteLength) return 0;
    const count = Math.min(length, data.byteLength - start);
    buffer.set(data.subarray(start, start + count), offset);
    if (position === null) handle.position += count;
    return count;
  }

  writeFd(fd: number, buffer: Uint8Array, offset: number, length: number): number {
    const handle = this.handles.get(fd);
    if (handle === undefined) throw ioError('EBADF', `EBADF: bad file descriptor, write`);
    if (handle.mode === 'read') throw ioError('EBADF', 'EBADF: bad file descriptor, write');
    const chunk = buffer.slice(offset, offset + length);
    const handleData = handle.data ?? new Uint8Array(0);
    const next = handle.mode === 'append'
      ? concatenate([handleData, chunk], handleData.byteLength + chunk.byteLength)
      : (() => {
        const required = handle.position + chunk.byteLength;
        const out = new Uint8Array(Math.max(required, handleData.byteLength));
        out.set(handleData, 0);
        out.set(chunk, handle.position);
        return out;
      })();
    if (handle.mode === 'write') handle.position += chunk.byteLength;
    this.setFile(handle.path, next);
    this.handles.set(fd, { ...handle, data: next });
    return length;
  }

  closeFd(fd: number): void {
    const handle = this.handles.get(fd);
    this.handles.delete(fd);
    if (handle === undefined || handle.mode === 'read' || handle.data === undefined) return;
    const target = handle.path;
    const bytes = handle.data.slice();
    this.enqueue(async () => { await this.service?.writeBytes(target, bytes, { createParents: true }); });
  }

  statFd(fd: number) {
    const handle = this.handles.get(fd);
    if (handle === undefined) throw ioError('EBADF', 'EBADF: bad file descriptor, fstat');
    return this.statShape(handle.path);
  }

  async openAsync(path: string, flags: string): Promise<VfsLocalAsyncHandle> {
    const fd = this.openFd(path, flags);
    return {
      stat: async () => this.statShape(path),
      read: async (buffer, offset = 0, length = buffer.byteLength, position = null) => ({
        bytesRead: this.readFd(fd, buffer, offset, length, position),
      }),
      close: async () => { this.closeFd(fd); },
    };
  }

  // ------------------------------------------------------------------ stat shapes

  statShape(path: string | Uint8Array, kindOverride?: FileKind) {
    const target = this.resolvePath(path);
    const node = this.nodes.get(target);
    const kind: FileKind = kindOverride ?? node?.kind ?? (() => { throw ENOENT(target); })();
    const size = node?.kind === 'file' ? node.data.byteLength : 0;
    const mtimeMs = node?.mtimeMs ?? 0;
    return {
      kind,
      size,
      mtimeMs,
      dev: 0,
      ino: 0,
      modifiedMs: mtimeMs,
      createdMs: null as number | null,
      unixMode: null as number | null,
      isFile: () => kind === 'file',
      isDirectory: () => kind === 'directory',
      isSymbolicLink: () => false,
    };
  }

  statBigShape(path: string | Uint8Array) {
    const shape = this.statShape(path);
    return {
      ...shape,
      size: BigInt(shape.size),
      mtimeNs: BigInt(Math.trunc(shape.mtimeMs)) * 1_000_000n,
    };
  }

  // ------------------------------------------------------------------ plugin views

  /** Shared port object; `createMobileLocalRuntime` returns the per-plugin surface of this. */
  views(): MobileLocalRuntimeBundle {
    const tree = this;
    const stat = (path: string | Uint8Array) => tree.statShape(path);
    const bigStat = (path: string | Uint8Array) => tree.statBigShape(path);
    const dirent = (path: string, name: string) => {
      const kind = tree.readDirKind(path).find(entry => entry.name === name)?.kind ?? 'other';
      return {
        name, kind,
        isFile: () => kind === 'file',
        isDirectory: () => kind === 'directory',
        isSymbolicLink: () => false,
      };
    };

    const vfs: VfsLocalRuntime = {
      existsSync: path => tree.exists(path),
      readFileSync: path => tree.readBytes(path),
      writeFileSync: (path, data) => tree.writeBytes(path, data),
      mkdirSync: (path) => { tree.mkdirp(path); return undefined; },
      rmSync: (path, options) => { tree.removePath(path, options); },
      renameSync: (from, to) => tree.rename(from, to),
      renameSyncWithRetry: (from, to) => tree.rename(from, to),
      statSync: path => stat(path) as unknown as VfsLocalStats,
      statBigSync: path => bigStat(path) as unknown as VfsLocalBigStats,
      lstatSync: path => stat(path) as unknown as VfsLocalStats,
      realpathSync: path => tree.resolvePath(path),
      readdirSync: path => tree.readDirNames(path),
      readdirDirentsSync: (path): VfsLocalDirent[] =>
        tree.readDirKind(path).map(entry => dirent(path, entry.name)),
      openSync: (path, flags) => tree.openFd(path, flags),
      readSync: (fd, buffer, offset, length, position) => tree.readFd(fd, buffer, offset, length, position),
      writeSync: (fd, buffer, offset, length) => tree.writeFd(fd, buffer, offset, length),
      closeSync: fd => tree.closeFd(fd),
      fstatSync: fd => tree.statFd(fd) as unknown as VfsLocalStats,
      copyFileSync: (from, to) => tree.copyFile(from, to),
      tmpDir: () => `${tree.dataDir}/tmp`,
      homeDir: () => tree.dataDir,
      mkdtemp: prefix => tree.makeTempDir(prefix),
      statBig: async path => bigStat(path) as unknown as VfsLocalBigStats,
      open: (path, flags) => tree.openAsync(path, flags),
      writeFile: async (path, data) => { tree.writeBytes(path, data); },
      readFileBounded: async (path, maxBytes) => tree.readBytes(path).slice(0, maxBytes + 1),
      rm: async (path, options) => { tree.removePath(path, options); },
      deviceIdEnv: () => null,
      takeStagedUpload: uploadId => takeMobileStagedUpload(uploadId, tree),
    };

    const notes: NotesLocalRuntime = {
      exists: path => tree.exists(path),
      stat: path => stat(path) as NotesLocalStat,
      lstat: path => stat(path) as NotesLocalStat,
      realpath: path => tree.resolvePath(path),
      realpathNative: path => tree.resolvePath(path),
      readDirNames: path => tree.readDirNames(path),
      readDir: (path): NotesLocalDirEntry[] => tree.readDirKind(path),
      readBytes: path => tree.readBytes(path),
      writeBytes: (path, bytes, options) => tree.writeBytes(path, bytes, options),
      mkdirp: path => tree.mkdirp(path),
      rmdir: path => tree.rmdir(path),
      unlink: path => tree.unlink(path),
      classifyPath: rawPath => classifyPath(rawPath),
      assetLocalPathFromKey: key => assetLocalPathFromKey(key),
      deleteAssetWithJournal: (_activeDir, _key, localPath) => {
        if (!tree.exists(localPath)) return false;
        tree.removeForce(localPath);
        return true;
      },
      prepareAssetDeletion: (_conn: SqlExecutor, _activeDir, key, localPath): PreparedDeletionIntent => ({
        operation_id: globalThis.crypto.randomUUID(), entity_key: key, local_path: localPath,
        expected_hash: null, size: null,
      }),
      finishAssetDeletion: (_conn, _activeDir, intent) => { tree.removeForce(intent.local_path); },
      recoverAssetDeletions: () => 0,
      registerNoteAssetRetention: (_retention: NoteAssetRetention): Disposer => new Disposer(() => undefined),
      createWorkerPool: () => null,
      copyFileVerified: async (source, target) => {
        if (isVirtualUri(source)) unavailable(`copy ${source}`);
        tree.copyFile(source, target);
      },
    };

    const qbank: QbankLocalRuntime = {
      exists: path => tree.exists(path),
      stat: path => stat(path) as NotesLocalStat,
      removeFile: path => tree.unlink(path),
      writeFile: (path, bytes) => tree.writeBytes(path, bytes),
      mkdirp: path => tree.mkdirp(path),
      readFile: path => tree.readBytes(path),
      openRead: (path): QbankLocalReadHandle => {
        const fd = tree.openFd(path, 'r');
        return {
          size: () => tree.fileLen(path),
          read: buffer => tree.readFd(fd, buffer, 0, buffer.byteLength, null),
          close: () => tree.closeFd(fd),
        };
      },
      openWrite: (path): QbankLocalWriteHandle => {
        const fd = tree.openFd(path, 'w');
        return {
          write: bytes => { tree.writeFd(fd, bytes, 0, bytes.byteLength); },
          close: () => tree.closeFd(fd),
        };
      },
      deflateRaw: bytes => pako.deflateRaw(bytes),
      mkdirpAsync: async path => { tree.mkdirp(path); },
      writeFileAsync: async (path, bytes) => { tree.writeBytes(path, bytes); },
      renameAsync: async (from, to) => { tree.rename(from, to); },
      copyFileVerified: async (source, target) => {
        if (isVirtualUri(source)) unavailable(`copy ${source}`);
        tree.copyFile(source, target);
      },
    };

    const anki: AnkiLocalRuntime = {
      exists: path => tree.exists(path),
      stat: path => stat(path) as AnkiLocalStat,
      lstat: path => stat(path) as AnkiLocalStat,
      realpath: path => tree.resolvePath(path),
      readBytes: path => tree.readBytes(path),
      writeBytes: (path, bytes, options) => tree.writeBytes(path, bytes, options),
      writeText: (path, text) => tree.writeText(path, text),
      mkdirp: path => tree.mkdirp(path),
      rename: (from, to) => tree.rename(from, to),
      remove: path => tree.removeForce(path),
      removeDir: path => tree.removeDirAll(path),
      readBundledText: name => {
        if (tree.readBundledText !== undefined) return tree.readBundledText(name);
        return unavailable(`read bundled ${name}`);
      },
      writeFile: async (path, text) => { tree.writeText(path, text); },
      mkdirpAsync: async path => { tree.mkdirp(path); },
      removeAsync: async path => { tree.removeForce(path); },
      copyFileVerified: async (source, target) => {
        if (isVirtualUri(source)) unavailable(`copy ${source}`);
        tree.copyFile(source, target);
      },
      deflateRaw: bytes => pako.deflateRaw(bytes),
      inflateRaw,
      zstdDecompress: () => unavailable('zstd'),
      probeTcp: async () => ({ message: 'local Anki desktop is unavailable on this platform' }),
    };

    const sync: SyncLocalRuntime = {
      existsSync: path => tree.exists(path),
      statSync: path => stat(path) as SyncLocalStats,
      statBigSync: path => bigStat(path) as SyncLocalBigStats,
      lstatSync: path => stat(path) as SyncLocalStats,
      readdirSync: path => tree.readDirNames(textPath(path)),
      readdirSyncRaw: path => tree.readDirNames(textPath(path)).map(name => encodeUtf8(name)),
      mkdirSync: (path) => { tree.mkdirp(path); return undefined; },
      rmSync: (path, options) => { tree.removePath(path, options); },
      copyFileSync: (from, to) => tree.copyFile(from, to),
      readFileSync: path => tree.readBytes(path),
      openSync: (path, flags) => tree.openFd(path, flags),
      writeSync: (fd, buffer, offset, length) => tree.writeFd(fd, buffer, offset, length),
      closeSync: fd => tree.closeFd(fd),
      tmpDir: () => `${tree.dataDir}/tmp`,
      mkdtemp: prefix => tree.makeTempDir(prefix),
      mkdir: async path => { tree.mkdirp(path); return undefined; },
      stat: async path => stat(path) as SyncLocalStats,
      statBig: async path => bigStat(path) as SyncLocalBigStats,
      rename: async (from, to) => { tree.rename(from, to); },
      rm: async (path, options) => { tree.removePath(path, options); },
      writeFile: async (path, data) => { tree.writeBytes(path, data); },
      open: async (path, flags): Promise<SyncLocalAsyncHandle> => {
        const fd = tree.openFd(path, flags);
        return { close: async () => { tree.closeFd(fd); } };
      },
    };

    const vfsRepos: VfsReposLocalRuntime = {
      platform: 'linux',
      exists: path => tree.exists(path),
      stat: path => stat(path) as VfsReposLocalStat,
      lstat: path => stat(path) as VfsReposLocalStat,
      realpath: path => tree.resolvePath(path),
      readFile: path => tree.readBytes(path),
      appendFile: (path, bytes) => tree.appendBytes(path, bytes),
      mkdirp: path => tree.mkdirp(path),
      rename: (from, to) => tree.rename(from, to),
      remove: path => tree.unlink(path),
      removeForce: path => tree.removeForce(path),
      removeDirForce: path => tree.removeDirAll(path),
      readdir: path => tree.readDirNames(path),
      openWrite: (path): VfsReposLocalWriteHandle => {
        const fd = tree.openFd(path, 'w');
        return {
          write: bytes => { tree.writeFd(fd, bytes, 0, bytes.byteLength); },
          close: () => tree.closeFd(fd),
        };
      },
      openRead: (path): VfsReposLocalReadHandle => {
        const fd = tree.openFd(path, 'r');
        return {
          size: () => tree.fileLen(path),
          read: buffer => tree.readFd(fd, buffer, 0, buffer.byteLength, null),
          close: () => tree.closeFd(fd),
        };
      },
      readZip: (bytes): LocalZipArchive => {
        const archive = ZipArchiveReader.open(bytes);
        return { entries: Array.from({ length: archive.length }, (_, index) => {
          const entry = archive.entry(index);
          return { name: entry.name, size: entry.declaredSize };
        }) };
      },
      sleepSync: () => undefined,
      spawnWorker: (_options: LocalWorkerOptions): LocalWorkerHandle => unavailable('worker'),
    };

    const chat: ChatLocalFs = {
      platform: 'linux',
      homeDir: () => tree.dataDir,
      exists: path => tree.exists(path),
      stat: path => stat(path) as ChatLocalStat,
      statMtimeNs: path => {
        const node = tree.nodes.get(tree.resolvePath(path));
        return node === undefined ? null : BigInt(Math.trunc(node.mtimeMs)) * 1_000_000n;
      },
      lstat: path => stat(path) as ChatLocalStat,
      realpath: path => tree.resolvePath(path),
      readBytes: path => tree.readBytes(path),
      openRead: (path): ChatLocalReadHandle => {
        const fd = tree.openFd(path, 'r');
        return {
          size: () => tree.fileLen(path),
          read: buffer => tree.readFd(fd, buffer, 0, buffer.byteLength, null),
          close: () => tree.closeFd(fd),
        };
      },
      openExclusive: (path): ChatLocalWriteHandle => {
        const fd = tree.openFd(path, 'wx');
        return {
          write: bytes => { tree.writeFd(fd, bytes, 0, bytes.byteLength); },
          close: () => tree.closeFd(fd),
        };
      },
      mkdirp: path => tree.mkdirp(path),
      mkdirExclusive: path => {
        const target = tree.resolvePath(path);
        if (tree.exists(target)) return false;
        tree.mkdirp(target);
        return true;
      },
      writeTextIgnoring: (path, text) => {
        try { tree.writeText(path, text); return true; }
        catch { return false; }
      },
      writeText: (path, text) => tree.writeText(path, text),
      unlink: path => tree.unlink(path),
      removeForce: path => tree.removeForce(path),
      removeDirForce: path => tree.removeDirAll(path),
    };

    return { vfs, notes, qbank, anki, sync, vfsRepos, chat };
  }

  // ------------------------------------------------------------------ helpers exposed for tests

  /** Snapshot of every file currently in the tree (tests / diagnostics). */
  snapshot(): Array<DirEntry> {
    return [...this.nodes.entries()].map(([path, node]): DirEntry => ({
      name: basename(path), path, kind: node.kind === 'file' ? 'file' : 'directory',
    })).sort((a, b) => a.path.localeCompare(b.path));
  }
}

/** Wraps `walk` because `FilesService.walk` is an async iterable, not a promise. */
async function* walkEntries(files: FilesService, root: string) {
  yield* files.walk(root, { includeDirectories: true });
}

/** `unified_file_manager::classify_path` without the node-only canonicalisation. */
function classifyPath(rawPath: string): LocalPathClassification {
  const trimmed = rawPath.replace(/^\0+|\0+$/g, '').trim();
  if (trimmed === '') throw new Error('path must not be empty');
  if (isVirtualUri(trimmed)) return { kind: 'virtual', uri: trimmed };
  if (trimmed.includes('://')) return { kind: 'virtual', uri: trimmed };
  const local = trimmed.startsWith('file://') ? trimmed.slice('file://'.length) : trimmed;
  return { kind: 'local', path: local };
}

/** `file_deletion_queue.rs:145`: only the `active/` / `app_data/` namespaces map to local paths. */
function assetLocalPathFromKey(key: string): string {
  const local = key.startsWith('active/') ? key.slice('active/'.length)
    : key.startsWith('app_data/') ? key.slice('app_data/'.length)
      : null;
  if (local === null) throw new Error(`asset key is outside the local namespace: ${key}`);
  if (local.startsWith('/') || local.split('/').some(part => part === '..')) {
    throw new Error(`asset key is not a safe relative path: ${key}`);
  }
  return local;
}

function textPath(path: string | Uint8Array): string {
  return typeof path === 'string' ? path : decodeUtf8(path);
}

const runtimes = new Map<string, { bundle: MobileLocalRuntimeBundle; runtime: MobileLocalRuntime }>();

/**
 * Returns the shared mobile runtime for this app data dir, creating it on first use. Every plugin
 * entry calls this so `vfs`, `notes`, `qbank`, `anki`, `sync`, `vfs-repos` and `chat` see one tree.
 */
export function mobileLocalRuntime(ctx: Context, options: MobileLocalRuntimeOptions = {}): MobileLocalRuntimeBundle {
  const dataDir = ctx.app.dataDir;
  const log = options.log ?? ctx.logger('files.mobile');
  const cached = runtimes.get(dataDir);
  // Hydration is background work: plugin startup must not wait for a large OPFS scan.
  const hydrate = (runtime: MobileLocalRuntime): void => {
    void runtime.startHydration().catch((error: unknown) => {
      log.warn(`mobile local runtime hydration failed: ${
        error instanceof Error ? error.message : String(error)}`);
    });
  };
  if (cached !== undefined) {
    hydrate(cached.runtime);
    return cached.bundle;
  }
  const runtime = new MobileLocalRuntime(dataDir, () => {
    return ctx.reflect.get('files', false) as FilesService | undefined;
  }, { ...options, log });
  const bundle = runtime.views();
  runtimes.set(dataDir, { bundle, runtime });
  hydrate(runtime);
  return bundle;
}

/** Test hook: drop the shared instances (no-op in production). */
export function resetMobileLocalRuntime(): void {
  runtimes.clear();
  stagedUploads.clear();
}
