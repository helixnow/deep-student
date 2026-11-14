/**
 * In-memory `CloudStorage` test double (mirrors the Rust `MemoryStorage` used by
 * verified_publish / bad_object / e2ee_claim / sync_manager unit tests).
 */

import { open, stat, writeFile } from 'node:fs/promises';
import type { FileInfo, ListOutcome } from '../api.ts';
import { CloudStorageError } from '../src/errors.ts';
import { CloudStorageBase } from '../src/traits.ts';
import { chronoAutoSiZ } from '../src/time.ts';

interface Entry {
  data: Uint8Array;
  modified: number;
}

export class MemoryStorage extends CloudStorageBase {
  readonly files = new Map<string, Entry>();
  /** Keys whose next PUT flips the last byte, emulating a half packet / gateway rewrite. */
  readonly corruptOnPut = new Set<string>();
  readonly corruptPrefixes: string[] = [];
  readonly conditionalPut = false;
  prefixRead = false;
  resumable = false;
  putLog: string[] = [];
  deleted: string[] = [];
  readonly rangeRequests: Array<{ path: string; offset: number; length: number }> = [];

  readonly name;

  constructor(name = 'memory') { super();
    this.name = name; }

  override providerName(): string { return this.name; }

  override async checkConnection(): Promise<void> {}

  override async put(key: string, data: Uint8Array): Promise<void> {
    this.putLog.push(key);
    const stored = new Uint8Array(data);
    if (this.corruptOnPut.has(key) || this.corruptPrefixes.some(prefix => key.startsWith(prefix))) {
      if (stored.byteLength > 0) stored[stored.byteLength - 1] = (stored[stored.byteLength - 1] ?? 0) ^ 0xff;
    }
    this.files.set(key, { data: stored, modified: Date.now() });
  }

  override async get(key: string): Promise<Uint8Array | null> {
    const entry = this.files.get(key);
    return entry === undefined ? null : new Uint8Array(entry.data);
  }

  override async getRange(key: string, offset: number, length: number): Promise<Uint8Array> {
    this.validateRange(offset, length);
    if (length === 0) return new Uint8Array(0);
    this.rangeRequests.push({ path: key, offset, length });
    const entry = this.files.get(key);
    if (entry === undefined) throw new CloudStorageError('NotFound', '云端文件不存在');
    if (offset + length > entry.data.byteLength) throw new CloudStorageError('Configuration', '内存 Range 请求越界');
    return entry.data.slice(offset, offset + length);
  }

  override async list(prefix: string): Promise<FileInfo[]> {
    return [...this.files.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, entry]) => this.info(key, entry))
      .sort((left, right) => Date.parse(right.lastModified) - Date.parse(left.lastModified));
  }

  /** Insert with an explicit timestamp so "newest wins" ordering is deterministic. */
  putAt(key: string, data: Uint8Array, modified: number): void {
    this.files.set(key, { data: new Uint8Array(data), modified });
  }

  override async listOutcome(prefix: string): Promise<ListOutcome> {
    return { files: await this.list(prefix), truncated: false };
  }

  override async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.files.delete(key);
  }

  override async stat(key: string): Promise<FileInfo | null> {
    const entry = this.files.get(key);
    return entry === undefined ? null : this.info(key, entry);
  }

  override supportsConditionalPut(): boolean { return this.conditionalPut; }

  override async putIfAbsent(key: string, data: Uint8Array): Promise<boolean> {
    if (this.files.has(key)) return false;
    await this.put(key, data);
    return true;
  }

  override supportsPrefixRead(): boolean { return this.prefixRead; }

  override async getPrefix(key: string, prefixLen: number): Promise<Uint8Array | null> {
    const data = await this.get(key);
    return data === null ? null : data.subarray(0, Math.min(prefixLen, data.byteLength));
  }

  override supportsResumableDownload(): boolean { return this.resumable; }

  keys(): string[] { return [...this.files.keys()].sort(); }

  bytes(key: string): Uint8Array | null {
    const entry = this.files.get(key);
    return entry === undefined ? null : new Uint8Array(entry.data);
  }

  text(key: string): string | null {
    const bytes = this.bytes(key);
    return bytes === null ? null : Buffer.from(bytes).toString('utf8');
  }

  private info(key: string, entry: Entry): FileInfo {
    return { key, size: entry.data.byteLength, lastModified: chronoAutoSiZ(entry.modified), etag: null };
  }
}

/** Wraps a storage and corrupts matching keys on write. */
export class CorruptingStorage extends CloudStorageBase {
  private readonly inner: MemoryStorage;
  private readonly corruptIf: (key: string) => boolean;

  constructor(
    inner: MemoryStorage,
    corruptIf: (key: string) => boolean,
  ) { super();
    this.inner = inner;
    this.corruptIf = corruptIf; }

  override providerName(): string { return 'memory-corrupting'; }
  override instanceBindingHint(): string { return this.inner.instanceBindingHint(); }
  override async checkConnection(): Promise<void> { await this.inner.checkConnection(); }

  override async put(key: string, data: Uint8Array): Promise<void> {
    const stored = new Uint8Array(data);
    if (this.corruptIf(key) && stored.byteLength > 0) stored[stored.byteLength - 1] = (stored[stored.byteLength - 1] ?? 0) ^ 0xff;
    await this.inner.put(key, stored);
  }

  override async get(key: string): Promise<Uint8Array | null> { return this.inner.get(key); }
  override async getRange(key: string, offset: number, length: number): Promise<Uint8Array> { return this.inner.getRange(key, offset, length); }
  override async getBounded(key: string, maxBytes: number): Promise<Uint8Array | null> { return this.inner.getBounded(key, maxBytes); }
  override async list(prefix: string): Promise<FileInfo[]> { return this.inner.list(prefix); }
  override async listOutcome(prefix: string): Promise<ListOutcome> { return this.inner.listOutcome(prefix); }
  override async delete(key: string): Promise<void> { await this.inner.delete(key); }
  override async stat(key: string): Promise<FileInfo | null> { return this.inner.stat(key); }
  override supportsConditionalPut(): boolean { return this.inner.supportsConditionalPut(); }
  override supportsPrefixRead(): boolean { return this.inner.supportsPrefixRead(); }
  override async getPrefix(key: string, prefixLen: number): Promise<Uint8Array | null> { return this.inner.getPrefix(key, prefixLen); }
}


/**
 * Resumable variant used by the R09 download-resume tests: it appends from the
 * requested offset, can fail once after N bytes (keeping a complete prefix), and
 * can ignore the offset (a server answering 200 instead of 206).
 */
export class ResumableMemoryStorage extends MemoryStorage {
  failAfterBytes: number | null = null;
  ignoreResume = false;
  readonly resumeRequests: number[] = [];

  constructor() {
    super('memory-resumable-r09');
    this.resumable = true;
  }

  override async getFileResumable(
    key: string,
    dest: string,
    resumeFrom: number,
    progress?: ((done: number, total: number) => void) | null,
  ): Promise<number> {
    this.resumeRequests.push(resumeFrom);
    const data = await this.get(key);
    if (data === null) throw new CloudStorageError('NotFound', '云端文件不存在');
    const total = data.byteLength;
    if (resumeFrom > total) {
      throw new CloudStorageError('FileSystem', '断点不能大于云端对象');
    }

    const actualStart = this.ignoreResume ? 0 : resumeFrom;
    let remaining = data.subarray(actualStart);
    const failAfter = this.failAfterBytes;
    this.failAfterBytes = null;
    let interrupted = false;
    if (failAfter !== null && failAfter < remaining.byteLength) {
      remaining = remaining.subarray(0, failAfter);
      interrupted = true;
    }

    if (actualStart > 0) {
      const existing = await stat(dest).then(info => info.size).catch(() => 0);
      if (existing !== actualStart) {
        throw new CloudStorageError('FileSystem', '断点文件必须恰好有 resume_from 字节');
      }
      const handle = await open(dest, 'a');
      try {
        await handle.write(remaining);
      } finally {
        await handle.close();
      }
    } else {
      await writeFile(dest, remaining);
    }
    progress?.(actualStart + remaining.byteLength, total);
    if (interrupted) {
      throw new CloudStorageError('Network', '模拟传输中断（断点保留，可重试续传）');
    }
    return actualStart;
  }
}
