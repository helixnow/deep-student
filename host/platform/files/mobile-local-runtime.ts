import type { LocalFs as ProviderFiles } from '../../plugins/sync-providers/src/local-fs.ts';
import { handleZipSink } from '../../plugins/sync-providers/src/local-fs.ts';
import { ZipWriter } from '../zip/core/index.ts';
/**
 * Mobile implementation of the synchronous local-runtime ports used by `vfs`, `vfs-repos`, `notes`,
 * `qbank`, `anki`, `sync` and `chat`.
 *
 * Those ports mirror `node:fs` because the Rust side is synchronous (`std::fs`), while the mobile
 * Host has only the asynchronous `ctx.files` (OPFS). This module bridges the two with an in-memory
 * virtual tree:
 *
 * - the tree indexes disk-backed File snapshots in the background on plugin startup (`slots/`, `notes_assets/`,
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
import type { DirEntry, FilesService, FileKind, LocalFileSnapshot } from './api.ts';
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
import { createHasherSync } from '../crypto/sync.ts';
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
  let state: 'memory' | 'file' | 'disposed' = 'memory';
  return {
    path: () => {
      if (state === 'memory') {
        tree.writeBytes(path, concatenate(entry.chunks, entry.received));
        state = 'file';
        entry.chunks.length = 0;
      }
      return path;
    },
    name: () => entry.name,
    size: () => entry.received,
    readBounded: maxBytes => {
      if (entry.received > maxBytes) throw new Error(`File too large: ${entry.received} > ${maxBytes}`);
      if (state === 'disposed') throw ENOENT(path);
      return state === 'file' ? tree.readBytes(path) : concatenate(entry.chunks, entry.received);
    },
    dispose: () => {
      if (state === 'file') tree.removeForce(path);
      state = 'disposed';
      entry.chunks.length = 0;
    },
  };
}

/** The six plugin ports plus the chat port, all sharing one in-memory tree. */
export interface MobileLocalRuntimeBundle {
  readonly vfs: VfsLocalRuntime;
  readonly notes: NotesLocalRuntime;
  readonly qbank: QbankLocalRuntime;
  readonly anki: AnkiLocalRuntime;
  readonly sync: SyncLocalRuntime;
  readonly providerFiles: ProviderFiles;
  flushPending(): Promise<void>;
  loadPersistedFile(path: string): Promise<void>;
  readonly vfsRepos: VfsReposLocalRuntime;
  readonly chat: ChatLocalFs;
}

export interface MobileLocalRuntimeOptions {
  /** `readBundledText` for the anki port (builtin templates are a plugin data file, not OPFS). */
  readonly readBundledText?: (name: string) => string;
  readonly log?: { warn(message: string): void; debug?(message: string): void };
}

type Content = Uint8Array | LocalFileSnapshot;
const contentSize = (content: Content) => content instanceof Uint8Array ? content.byteLength : content.size;
const readContent = (content: Content, start?: number, end?: number) =>
  content instanceof Uint8Array ? content.slice(start, end) : content.read(start, end);

interface FileNode {
  readonly kind: 'file';
  data: Content;
  readers: number;
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
  readonly data?: Content;
  readonly reader?: FileNode;
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

  // OPFS File snapshots become unreadable when their entry is replaced. Readers of the
  // same version share one node; detach its bytes only while that version is still in use.
  private preserveReaders(node: Node | undefined): void {
    if (node?.kind === 'file' && node.readers && !(node.data instanceof Uint8Array)) {
      node.data = readContent(node.data);
    }
  }

  private setFile(path: string, data: Content, localMutation = true): FileNode {
    this.ensureDirs(dirname(path));
    const existing = this.nodes.get(path);
    this.preserveReaders(existing);
    const mtimeMs = existing?.mtimeMs ?? Date.now();
    const node: FileNode = { kind: 'file', readers: 0, data, mtimeMs: data instanceof Uint8Array ? mtimeMs : data.modifiedMs };
    this.nodes.set(path, node);
    if (localMutation) this.locallyWritten.add(path);
    return node;
  }

  private async releasePersistedBytes(path: string, node: FileNode): Promise<void> {
    const files = this.service;
    if (!files?.openLocalSnapshot || this.nodes.get(path) !== node) return;
    const snapshot = await files.openLocalSnapshot(path);
    if (this.nodes.get(path) === node) node.data = snapshot;
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
            const content = files.openLocalSnapshot ? await files.openLocalSnapshot(entry.path) : await files.readBytes(entry.path);
            if (!this.locallyWritten.has(path)) this.setFile(path, content, false);
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
    return node?.kind === 'file' ? contentSize(node.data) : 0;
  }

  readBytes(path: string): Uint8Array {
    return readContent(this.fileNode(path).data);
  }

  readText(path: string): string {
    return decodeUtf8(this.readBytes(path));
  }

  statPath(path: string | Uint8Array): Node & { size: number; mtimeMs: number } {
    const node = this.node(this.resolvePath(path));
    return Object.assign(node, { size: node.kind === 'file' ? contentSize(node.data) : 0 });
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
    const node = this.setFile(target, bytes.slice());
    this.enqueue(async () => {
      if (options?.exclusive) await this.service?.writeBytes(target, bytes, { createParents: true, exclusive: true });
      else await this.service?.writeAtomic(target, bytes, { createParents: true });
      await this.releasePersistedBytes(target, node);
    });
  }

  private writeDurableFile(path: string, bytes: Uint8Array, sha256?: string): Promise<void> {
    const target = this.resolvePath(path);
    const operation = this.flushChain.then(async () => {
      const service = this.service;
      if (!service) throw new Error('Mobile asset storage is unavailable');
      const existing = await service.exists(target) ? await service.stat(target) : null;
      if (existing && existing.kind !== 'file') throw EISDIR(target);
      let matches = false;
      if (sha256 && existing?.size === bytes.byteLength) {
        const hash = createHasherSync('SHA-256');
        const reader = (await service.openRead(target)).getReader();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            hash.update(chunk.value);
          }
          matches = hash.digestHex() === sha256;
        } finally { reader.releaseLock(); }
      }
      if (!matches) {
        // The old node is visible to synchronous open() until durable publication completes.
        const old = this.nodes.get(target);
        if (old?.kind === 'file' && !(old.data instanceof Uint8Array)) old.data = readContent(old.data);
        await service.writeAtomic(target, bytes, { createParents: true });
      }
      const persisted = await service.stat(target);
      if (persisted.kind !== 'file' || persisted.size !== bytes.byteLength) throw new Error(`Mobile asset was not completely persisted: ${target}`);
      await this.releasePersistedBytes(target, this.setFile(target, bytes));
    });
    // Other staged writes can proceed after a failed upload; the caller still sees the rejection.
    this.flushChain = operation.catch(() => undefined);
    return operation;
  }

  writeText(path: string, text: string): void {
    this.writeBytes(path, encodeUtf8(text));
  }

  appendBytes(path: string, bytes: Uint8Array): void {
    const target = this.resolvePath(path);
    const existing = this.nodes.get(target);
    const next = existing?.kind === 'file'
      ? concatenate([readContent(existing.data), bytes], contentSize(existing.data) + bytes.byteLength)
      : bytes.slice();
    const node = this.setFile(target, next);
    this.enqueue(async () => {
      if (existing?.kind === 'file') await this.service?.append(target, bytes, { createParents: true });
      else await this.service?.writeBytes(target, next, { createParents: true });
      await this.releasePersistedBytes(target, node);
    });
  }

  unlink(path: string): void {
    const target = this.resolvePath(path);
    const node = this.nodes.get(target);
    if (node === undefined) throw ENOENT(target);
    if (node.kind === 'directory') throw EISDIR(target);
    this.preserveReaders(this.nodes.get(target));
    this.nodes.delete(target);
    this.locallyWritten.add(target);
    this.enqueue(async () => { await this.service?.rm(target, { force: true }); });
  }

  rmdir(path: string): void {
    const target = this.resolvePath(path);
    this.dirNode(target);
    if (this.childNames(target).length > 0) throw ENOTEMPTY(target);
    this.preserveReaders(this.nodes.get(target));
    this.nodes.delete(target);
    this.locallyWritten.add(target);
    this.enqueue(async () => { await this.service?.rm(target, { recursive: false, force: true }); });
  }

  removeDirAll(path: string): void {
    const target = this.resolvePath(path);
    const prefix = target === '/' ? '/' : `${target}/`;
    for (const key of [...this.nodes.keys()]) {
      if (key === target || key.startsWith(prefix)) {
        this.preserveReaders(this.nodes.get(key));
        this.nodes.delete(key);
        this.locallyWritten.add(key);
      }
    }
    this.enqueue(async () => { await this.service?.rm(target, { recursive: true, force: true }); });
  }

  removeForce(path: string): void {
    const target = this.resolvePath(path);
    this.preserveReaders(this.nodes.get(target));
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
      this.preserveReaders(node);
      this.nodes.delete(target);
      this.locallyWritten.add(target);
      this.enqueue(async () => { await this.service?.rm(target, { force: true }); });
      return;
    }
    if (options.recursive === true) { this.removeDirAll(target); return; }
    if (this.childNames(target).length > 0) throw ENOTEMPTY(target);
    this.preserveReaders(this.nodes.get(target));
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
        this.preserveReaders(this.nodes.get(target + key.slice(source.length)));
        this.nodes.set(`${target}${key.slice(source.length)}`, value);
        this.locallyWritten.add(`${target}${key.slice(source.length)}`);
      }
    } else {
      this.preserveReaders(this.nodes.get(target));
      this.nodes.delete(source);
      this.nodes.set(target, node);
    }
    // OPFS invalidates a File snapshot after its underlying entry moves.
    const moved = [...this.nodes.entries()].filter(([key, value]) =>
      (key === target || key.startsWith(target + '/')) && value.kind === 'file');
    for (const [, value] of moved) if (value.kind === 'file' && !(value.data instanceof Uint8Array)) {
      value.data = readContent(value.data);
    }
    this.enqueue(async () => {
      await this.service?.rename(source, target, { overwrite: true, createParents: true });
      for (const [key, value] of moved) if (value.kind === 'file') await this.releasePersistedBytes(key, value);
    });
  }

  copyFile(from: string, to: string): void {
    const source = this.readBytes(from);
    const target = this.resolvePath(to);
    const node = this.setFile(target, source);
    this.enqueue(async () => {
      await this.service?.copyFile(this.resolvePath(from), target, { overwrite: true, createParents: true });
      await this.releasePersistedBytes(target, node);
    });
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
    const reader = !writing && node?.kind === 'file' ? node : undefined;
    if (reader) reader.readers++;
    this.handles.set(fd, {
      reader,
      path: target, mode: writing ? (flags.includes('a') ? 'append' : 'write') : 'read', position: 0,
      data: writing ? (node?.kind === 'file' ? node.data : new Uint8Array(0)) : undefined,
    });
    return fd;
  }

  readFd(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number {
    const handle = this.handles.get(fd);
    if (handle === undefined) throw ioError('EBADF', `EBADF: bad file descriptor, read`);
    const data = handle.reader?.data ?? handle.data ?? new Uint8Array(0);
    const start = position ?? handle.position;
    if (start >= contentSize(data)) return 0;
    const count = Math.min(length, contentSize(data) - start);
    buffer.set(data instanceof Uint8Array ? data.subarray(start, start + count) : data.read(start, start + count), offset);
    if (position === null) handle.position += count;
    return count;
  }

  writeFd(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null = null): number {
    const handle = this.handles.get(fd);
    if (handle === undefined) throw ioError('EBADF', `EBADF: bad file descriptor, write`);
    if (handle.mode === 'read') throw ioError('EBADF', 'EBADF: bad file descriptor, write');
    const chunk = buffer.slice(offset, offset + length);
    const handleData = !handle.data ? new Uint8Array(0) : handle.data instanceof Uint8Array ? handle.data : handle.data.read();
    const next = handle.mode === 'append'
      ? concatenate([handleData, chunk], handleData.byteLength + chunk.byteLength)
      : (() => {
        const start = position ?? handle.position;
        const required = start + chunk.byteLength;
        const out = new Uint8Array(Math.max(required, handleData.byteLength));
        out.set(handleData, 0);
        out.set(chunk, start);
        return out;
      })();
    if (handle.mode === 'write' && position === null) handle.position += chunk.byteLength;
    this.setFile(handle.path, next);
    this.handles.set(fd, { ...handle, data: next });
    return length;
  }

  closeFd(fd: number): void {
    const handle = this.handles.get(fd);
    this.handles.delete(fd);
    if (handle?.reader) handle.reader.readers--;
    if (handle === undefined || handle.mode === 'read' || handle.data === undefined) return;
    const target = handle.path;
    const bytes = readContent(handle.data);
    const node = this.fileNode(target);
    this.enqueue(async () => {
      await this.service?.writeBytes(target, bytes, { createParents: true });
      await this.releasePersistedBytes(target, node);
    });
  }

  statFd(fd: number) {
    const handle = this.handles.get(fd);
    if (handle === undefined) throw ioError('EBADF', 'EBADF: bad file descriptor, fstat');
    return this.statShape(handle.path, undefined, handle.reader);
  }

  async openAsync(path: string, flags: string): Promise<VfsLocalAsyncHandle> {
    const fd = this.openFd(path, flags);
    return {
      stat: async () => this.statFd(fd),
      read: async (buffer, offset = 0, length = buffer.byteLength, position = null) => ({
        bytesRead: this.readFd(fd, buffer, offset, length, position),
      }),
      close: async () => { this.closeFd(fd); },
    };
  }

  // ------------------------------------------------------------------ stat shapes

  statShape(path: string | Uint8Array, kindOverride?: FileKind, openedNode?: FileNode) {
    const target = this.resolvePath(path);
    const node = openedNode ?? this.nodes.get(target);
    const kind: FileKind = kindOverride ?? node?.kind ?? (() => { throw ENOENT(target); })();
    const size = node?.kind === 'file' ? contentSize(node.data) : 0;
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
      writeFile: (path, data) => tree.writeDurableFile(path, data),
      readFileBounded: async (path, maxBytes) => readContent(tree.fileNode(path).data, 0, maxBytes + 1),
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
      async ensureAssetPersisted(path) {
        const target = tree.resolvePath(path);
        await tree.flushChain;
        const service = tree.service;
        if (!service) throw new Error('Mobile asset storage is unavailable');
        const entry = await service.stat(target);
        if (entry.kind !== 'file' || entry.size !== tree.fileLen(target)) {
          throw new Error('Mobile asset was not completely persisted');
        }
      },
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
      writeFileAsync: (path, bytes) => tree.writeDurableFile(path, bytes),
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
      writeFile: (path, text) => tree.writeDurableFile(path, encodeUtf8(text)),
      async persistFile(path) {
        const bytes = tree.readBytes(path);
        await tree.writeDurableFile(path, bytes, createHasherSync('SHA-256').update(bytes).digestHex());
      },
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
      writeFile: (path, data) => tree.writeDurableFile(path, data),
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
      writeDurableFile: (path, bytes, sha256) => tree.writeDurableFile(path, bytes, sha256),
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

    const providerFiles: ProviderFiles = {
      constants: { O_APPEND: 1024, O_CREAT: 64, O_WRONLY: 1 },
      tmpDir: sync.tmpDir, mkdtemp: sync.mkdtemp,
      async mkdir(path) { tree.mkdirp(path); return undefined; },
      async stat(path) { return stat(path); },
      async lstat(path) { return stat(path); },
      async readFile(path) { return tree.readBytes(path); },
      writeFile: (path, bytes) => tree.writeDurableFile(path, bytes),
      async copyFile(from, to) { await tree.writeDurableFile(to, tree.readBytes(from)); },
      async link(from, to) {
        if (tree.exists(to)) throw EEXIST(to);
        const bytes = tree.readBytes(from);
        const files = tree.service;
        if (!files) throw new Error('Mobile storage is unavailable');
        await tree.flushChain;
        await files.writeBytes(to, bytes, { exclusive: true, createParents: true });
        if ((await files.stat(to)).size !== bytes.length) throw new Error('Incomplete mobile file copy');
        const path = tree.resolvePath(to);
        await tree.releasePersistedBytes(path, tree.setFile(path, bytes));
      },
      async rename(from, to) { tree.rename(from, to); await tree.flushChain; },
      async unlink(path) { tree.unlink(path); await tree.flushChain; },
      async rm(path, options) { tree.removePath(path, options); await tree.flushChain; },
      async rmdir(path) { tree.removePath(path); await tree.flushChain; },
      async readdir(path) { return tree.readDirNames(path); },
      async *readChunks(path, chunkSize) {
        if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new RangeError('Invalid chunk size');
        const fd = tree.openFd(path, 'r');
        try {
          const { size } = tree.statFd(fd);
          for (let offset = 0; offset < size; offset += chunkSize) {
            const chunk = new Uint8Array(Math.min(chunkSize, size - offset));
            tree.readFd(fd, chunk, 0, chunk.length, offset);
            yield chunk;
          }
        } finally { tree.closeFd(fd); }
      },
      async open(path, flags = 'r') {
        const mode = typeof flags === 'number' ? (flags & 1024 ? 'a' : flags & 1 ? 'w' : 'r') : flags;
        const fd = tree.openFd(path, mode);
        const writable = mode.includes('w') || mode.includes('a');
        let closed = false;
        return {
          stat: async () => tree.statFd(fd),
          async read(buffer, offset = 0, length = buffer.length - offset, position = null) {
            return { bytesRead: tree.readFd(fd, buffer, offset, length, position) };
          },
          async write(bytes, offset = 0, length = bytes.length - offset, position = null) {
            return { bytesWritten: tree.writeFd(fd, bytes, offset, length, position) };
          },
          async writeFile(bytes) { tree.writeFd(fd, bytes, 0, bytes.length, null); },
          async sync() { if (writable) await tree.writeDurableFile(path, tree.readBytes(path)); },
          async close() {
            if (closed) return;
            closed = true;
            if (writable) tree.handles.delete(fd);
            else tree.closeFd(fd);
            if (writable) await tree.writeDurableFile(path, tree.readBytes(path));
          },
        };
      },
      async createZipWriter(path) {
        const handle = await providerFiles.open(path, 'wx');
        const zip = new ZipWriter(handleZipSink(handle));
        return {
          async addFile(name, source) { await zip.addStream(name, providerFiles.readChunks(source, 256 * 1024)); },
          async finish() { try { return await zip.finish(); } finally { await handle.close(); } },
          async abort() { try { await handle.close(); } finally { await providerFiles.rm(path, { force: true }); } },
        };
      },
    };
    return {
      vfs, notes, qbank, anki, sync, providerFiles, vfsRepos, chat,
      flushPending: () => tree.flushChain,
      async loadPersistedFile(path) {
        if (!tree.service) throw new Error('Mobile storage is unavailable');
        const target = tree.resolvePath(path);
        tree.setFile(target, tree.service.openLocalSnapshot ? await tree.service.openLocalSnapshot(target) : await tree.service.readBytes(target));
      },
    };
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
