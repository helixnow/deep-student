import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  CloudStorage,
  DownloadProgressCallback,
  FileInfo,
  ListOutcome,
  UploadProgressCallback,
} from '../../sync-providers/api.ts';
// boundary-allow cross-plugin-impl: test MemoryCloud double throws real CloudStorageError
import { CloudStorageError } from '../../sync-providers/src/errors.ts';

/**
 * 内存版 `CloudStorage`（仅测试使用）。
 *
 * 对应 Rust 测试里的 `MemoryStorage`：租约、repo_check 巡检等算法直接对
 * `CloudStorage` 接口编程，用内存实现即可验证真实生产实现，不需要网络。
 */
interface Entry {
  data: Uint8Array;
  modified: number;
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export class MemoryCloud implements CloudStorage {
  readonly files = new Map<string, Entry>();
  /** 这些前缀的 LIST 结果被标记为截断（fail-closed 场景）。 */
  readonly truncatedPrefixes = new Set<string>();
  readonly name: string;

  constructor(name = 'memory-cloud') { this.name = name; }

  providerName(): string { return this.name; }

  instanceBindingHint(): string { return this.name; }

  async checkConnection(): Promise<void> {}

  async put(key: string, data: Uint8Array): Promise<void> {
    this.files.set(key, { data: new Uint8Array(data), modified: Date.now() });
  }

  async get(key: string): Promise<Uint8Array | null> {
    const entry = this.files.get(key);
    return entry === undefined ? null : new Uint8Array(entry.data);
  }

  async getRange(key: string, offset: number, length: number): Promise<Uint8Array> {
    if (length === 0) return new Uint8Array(0);
    const data = await this.get(key);
    if (data === null) throw new CloudStorageError('NotFound', `云端对象 ${key} 不存在`);
    if (offset + length > data.byteLength) {
      throw new CloudStorageError('Configuration', `内存 Range 请求越界：${key} ${offset}+${length} > ${data.byteLength}`);
    }
    return data.slice(offset, offset + length);
  }

  async getBounded(key: string, maxBytes: number): Promise<Uint8Array | null> {
    const data = await this.get(key);
    if (data !== null && data.byteLength > maxBytes) {
      throw new Error(`对象 ${key} 声明 ${data.byteLength} 字节，超过 ${maxBytes} 字节预算`);
    }
    return data;
  }

  async list(prefix: string): Promise<FileInfo[]> {
    return [...this.files.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, entry]) => this.info(key, entry))
      .sort((left, right) => Date.parse(right.lastModified) - Date.parse(left.lastModified));
  }

  async listOutcome(prefix: string): Promise<ListOutcome> {
    const truncated = [...this.truncatedPrefixes].some(candidate => prefix.startsWith(candidate));
    return { files: await this.list(prefix), truncated };
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }

  async stat(key: string): Promise<FileInfo | null> {
    const entry = this.files.get(key);
    return entry === undefined ? null : this.info(key, entry);
  }

  async exists(key: string): Promise<boolean> {
    return this.files.has(key);
  }

  async putFile(key: string, localPath: string, progress?: UploadProgressCallback | null): Promise<string> {
    const data = await readFile(localPath);
    await this.put(key, data);
    progress?.(data.byteLength, data.byteLength);
    return sha256(data);
  }

  async verifyRemoteObjectSize(key: string, expectedSize: number): Promise<void> {
    const info = await this.stat(key);
    if (info === null) throw new Error(`云端对象 ${key} 不存在`);
    if (info.size !== expectedSize) {
      throw new Error(`云端对象 ${key} 大小 ${info.size} 字节，期望 ${expectedSize} 字节`);
    }
  }

  supportsConditionalPut(): boolean { return false; }

  async putIfAbsent(key: string, data: Uint8Array): Promise<boolean> {
    if (this.files.has(key)) return false;
    await this.put(key, data);
    return true;
  }

  supportsResumableDownload(): boolean { return false; }

  async getFileResumable(_key: string, _dest: string, _resumeFrom: number): Promise<number> {
    throw new Error('memory cloud 不支持续传下载');
  }

  supportsPrefixRead(): boolean { return false; }

  async getPrefix(key: string, prefixLen: number): Promise<Uint8Array | null> {
    const data = await this.get(key);
    return data === null ? null : data.subarray(0, Math.min(prefixLen, data.byteLength));
  }

  async getFile(
    key: string,
    localPath: string,
    expectedChecksum?: string | null,
    progress?: DownloadProgressCallback | null,
  ): Promise<string> {
    const data = await this.get(key);
    if (data === null) throw new Error(`云端对象 ${key} 不存在`);
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, data);
    progress?.(data.byteLength, data.byteLength);
    const checksum = sha256(data);
    if (expectedChecksum != null && expectedChecksum !== checksum) {
      throw new Error(`校验失败: 期望 ${expectedChecksum}, 实际 ${checksum}`);
    }
    return checksum;
  }

  putAt(key: string, data: Uint8Array, modified = Date.now()): void {
    this.files.set(key, { data: new Uint8Array(data), modified });
  }

  insertRaw(key: string, data: string | Uint8Array): void {
    this.files.set(key, {
      data: typeof data === 'string' ? Buffer.from(data, 'utf8') : new Uint8Array(data),
      modified: Date.now(),
    });
  }

  removeRaw(key: string): void {
    this.files.delete(key);
  }

  keys(): string[] { return [...this.files.keys()].sort(); }

  bytes(key: string): Uint8Array | null {
    const entry = this.files.get(key);
    return entry === undefined ? null : new Uint8Array(entry.data);
  }

  text(key: string): string | null {
    const bytes = this.bytes(key);
    return bytes === null ? null : Buffer.from(bytes).toString('utf8');
  }

  /** 云端 key → bytes 的稳定快照，用于断言巡检只读。 */
  snapshot(): Map<string, string> {
    return new Map([...this.files.entries()].map(([key, entry]) => [key, Buffer.from(entry.data).toString('base64')]));
  }

  private info(key: string, entry: Entry): FileInfo {
    return {
      key,
      size: entry.data.byteLength,
      lastModified: new Date(entry.modified).toISOString(),
      etag: null,
    };
  }
}

/**
 * 续传下载 test double：第一次调用写入 `chunk` 字节后失败，后续从已有前缀
 * 继续；`failures` 控制失败次数（0 = 永远失败）。
 */
export class FlakyResumableCloud extends MemoryCloud {
  readonly resumeStarts: number[] = [];
  private readonly chunkBytes: number;
  private readonly failures: number;

  constructor(chunkBytes: number, failures: number) {
    super('memory-resumable');
    this.chunkBytes = chunkBytes;
    this.failures = failures;
  }

  override supportsResumableDownload(): boolean { return true; }

  override async getFileResumable(
    key: string,
    dest: string,
    resumeFrom: number,
    progress?: DownloadProgressCallback | null,
  ): Promise<number> {
    this.resumeStarts.push(resumeFrom);
    const data = await this.get(key);
    if (data === null) throw new Error(`云端对象 ${key} 不存在`);
    await mkdir(dirname(dest), { recursive: true });
    const shouldFail = this.failures === 0 || this.resumeStarts.length <= this.failures;
    if (shouldFail) {
      const end = Math.min(resumeFrom + this.chunkBytes, data.byteLength);
      await appendFile(dest, data.subarray(resumeFrom, end));
      progress?.(end, data.byteLength);
      throw new Error('模拟续传中断');
    }
    await appendFile(dest, data.subarray(resumeFrom));
    progress?.(data.byteLength, data.byteLength);
    return resumeFrom;
  }
}
