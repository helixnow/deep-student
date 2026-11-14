import { sha256Hex } from './hashing.ts';
import { dirname } from '../../../platform/util/path.ts';
import { concatBytes } from './bytes.ts';
import { fs } from './local-fs.ts';
import type { CloudStorage, FileInfo, ListOutcome, UploadProgressCallback, DownloadProgressCallback, StatusHook } from '../api.ts';
import { CloudStorageError, ioError } from './errors.ts';

declare module '../api.ts' {
  interface CloudStorage {
    getRange(remotePath: string, offset: number, length: number): Promise<Uint8Array>;
  }
}

export const CHUNK_SIZE = 8 * 1024 * 1024;
export const MIN_MULTIPART_SIZE = 16 * 1024 * 1024;
export const MEMORY_GET_STALL_SECS = 90;
export const MEMORY_GET_BUDGET_EXCEEDED = '超出调用方内存预算';
export const MEMORY_GET_DEFAULT_BUDGET_BYTES = 256 * 1024 * 1024;
export const RESUMABLE_DOWNLOAD_UNSUPPORTED = '该云存储后端不支持断点续传下载（fail-closed）：请整包重新下载，或改用支持续传的 WebDAV';

let statusHook: StatusHook | null = null;
let cancelToken: AbortSignal | null = null;
export function setStatusHook(hook: StatusHook): void { statusHook = hook; }
export function clearStatusHook(): void { statusHook = null; }
export function reportStatus(message: string): void { statusHook?.(message); }
export function setCancelToken(signal: AbortSignal): void { cancelToken = signal; }
export function clearCancelToken(): void { cancelToken = null; }
export function syncCancelSignal(): AbortSignal | undefined { return cancelToken ?? undefined; }
export function isSyncCancelled(): boolean { return cancelToken?.aborted ?? false; }
export async function cancellableSleep(milliseconds: number): Promise<void> {
  const signal = cancelToken;
  try { await sleepWithSignal(milliseconds, signal); }
  catch (error) {
    if (signal?.aborted) throw new CloudStorageError('Unknown', '云同步已取消');
    throw error;
  }
}

/** `timers/promises` `setTimeout(ms, undefined, { signal })`：取消时立即拒绝。 */
function sleepWithSignal(milliseconds: number, signal: AbortSignal | null): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error('aborted')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    if (signal?.aborted) { clearTimeout(timer); reject(new Error('aborted')); return; }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function ensureMemoryGetMatchesDeclaredLen(provider: string, key: string, actual: number, declared: number | bigint | null): void {
  if (declared !== null && BigInt(actual) !== BigInt(declared)) {
    throw new CloudStorageError('Network', `${provider} 内存对象下载不完整或对象已变更：${key} 声明 ${declared} 字节，实际收到 ${actual} 字节，已拒绝（请重试）`);
  }
}
export function ensureDeclaredLenWithinBudget(provider: string, key: string, declared: number | bigint | null, maxBytes: number): void {
  if (declared !== null && declared > maxBytes) {
    throw new CloudStorageError('Network', `${provider} 内存对象声明长度${MEMORY_GET_BUDGET_EXCEEDED}：${key} 声明 ${declared} 字节 > 预算 ${maxBytes} 字节，已在读取响应体前拒绝`);
  }
}
export function ensureReceivedWithinBudget(provider: string, key: string, received: number, maxBytes: number): void {
  if (received > maxBytes) {
    throw new CloudStorageError('Network', `${provider} 内存对象下载${MEMORY_GET_BUDGET_EXCEEDED}：${key} 累计 ${received} 字节 > 预算 ${maxBytes} 字节，已中断传输`);
  }
}

export class BoundedMemoryBody {
  private provider: string;
  private key: string;
  private maxBytes: number;
  private chunks: Uint8Array[] = [];
  private length = 0;
  constructor(provider: string, key: string, maxBytes: number) {
    this.provider = provider; this.key = key; this.maxBytes = maxBytes;
  }
  push(chunk: Uint8Array): void {
    ensureReceivedWithinBudget(this.provider, this.key, this.length + chunk.byteLength, this.maxBytes);
    this.chunks.push(Uint8Array.from(chunk));
    this.length += chunk.byteLength;
  }
  len(): number { return this.length; }
  intoBytes(): Uint8Array { return concatBytes(this.chunks, this.length); }
}

/** The default method bodies in traits.rs, shared by concrete network transports. */
export abstract class CloudStorageBase implements CloudStorage {
  protected validateRange(offset: number, length: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0
      || !Number.isSafeInteger(offset + length)) {
      throw new CloudStorageError('Configuration', 'Range offset/length 必须是非负安全整数，且区间不能溢出');
    }
  }
  async getRange(_remotePath: string, offset: number, length: number): Promise<Uint8Array> {
    this.validateRange(offset, length);
    if (length === 0) return new Uint8Array(0);
    throw new CloudStorageError('Configuration', `${this.providerName()} 不支持定长 Range 读取`);
  }
  abstract providerName(): string;
  abstract checkConnection(): Promise<void>;
  abstract put(key: string, data: Uint8Array): Promise<void>;
  abstract get(key: string): Promise<Uint8Array | null>;
  abstract list(prefix: string): Promise<FileInfo[]>;
  abstract delete(key: string): Promise<void>;
  abstract stat(key: string): Promise<FileInfo | null>;
  instanceBindingHint(): string { return this.providerName(); }
  async getBounded(key: string, maxBytes: number): Promise<Uint8Array | null> {
    const data = await this.get(key);
    if (data !== null) ensureReceivedWithinBudget(this.providerName(), key, data.byteLength, maxBytes);
    return data;
  }
  async listOutcome(prefix: string): Promise<ListOutcome> { return { files: await this.list(prefix), truncated: false }; }
  async exists(key: string): Promise<boolean> { return (await this.stat(key)) !== null; }
  async putFile(key: string, localPath: string, progress?: UploadProgressCallback | null): Promise<string> {
    const data = await fs.readFile(localPath).catch(error => { throw new CloudStorageError('FileSystem', `读取文件失败: ${ioError(error)}`); });
    progress?.(0, data.byteLength);
    const checksum = sha256Hex(data);
    await this.put(key, data);
    progress?.(data.byteLength, data.byteLength);
    return checksum;
  }
  async verifyRemoteObjectSize(key: string, expectedSize: number): Promise<void> {
    const info = await this.stat(key);
    if (info !== null && info.size === expectedSize) return;
    // traits.rs:458,465 intentionally ignores deletion failures.
    await Promise.allSettled([this.delete(key)]);
    throw new CloudStorageError('Unknown', info === null
      ? '云端对象上传后不存在，已停止并不得报成功'
      : `云端对象上传后大小不一致：本地 ${expectedSize} 字节，远端 ${info.size} 字节，已停止并不得报成功`);
  }
  supportsConditionalPut(): boolean { return false; }
  async putIfAbsent(_key: string, _data: Uint8Array): Promise<boolean> {
    throw new CloudStorageError('Configuration', `云存储后端 ${this.providerName()} 不支持条件写（put_if_absent）；调用方应先检查 supports_conditional_put，不支持时改走租约认领协议（e2ee_claim）`);
  }
  supportsResumableDownload(): boolean { return false; }
  async getFileResumable(_key: string, _dest: string, _resumeFrom: number, _progress?: DownloadProgressCallback | null): Promise<number> {
    throw new CloudStorageError('Configuration', RESUMABLE_DOWNLOAD_UNSUPPORTED);
  }
  supportsPrefixRead(): boolean { return false; }
  async getPrefix(_key: string, _prefixLen: number): Promise<Uint8Array | null> {
    throw new CloudStorageError('Configuration', `云存储后端 ${this.providerName()} 不支持对象前缀读取（get_prefix）；调用方应先检查 supports_prefix_read，不支持时回退整文件下载路径`);
  }
  async getFile(key: string, localPath: string, expectedChecksum?: string | null, progress?: DownloadProgressCallback | null): Promise<string> {
    const info = await this.stat(key);
    if (info === null) throw new CloudStorageError('NotFound', '云端文件不存在');
    const total = info.size;
    progress?.(0, total);
    const data = await this.get(key);
    if (data === null) throw new CloudStorageError('NotFound', '云端文件不存在');
    if (data.byteLength !== total) {
      throw new CloudStorageError('Network', `下载不完整或云端对象已变更：声明 ${total} 字节，实际收到 ${data.byteLength} 字节，已拒绝保存（请重试）`);
    }
    progress?.(Math.floor(total / 2), total);
    const checksum = sha256Hex(data);
    if (expectedChecksum != null && checksum !== expectedChecksum) {
      throw new CloudStorageError('Validation', `校验和不匹配: 期望 ${expectedChecksum.slice(0, 8)}, 实际 ${checksum.slice(0, 8)}`);
    }
    await fs.mkdir(dirname(localPath), { recursive: true }).catch(error => { throw new CloudStorageError('FileSystem', `创建目录失败: ${ioError(error)}`); });
    const file = await fs.open(localPath, 'w').catch(error => { throw new CloudStorageError('FileSystem', `创建文件失败: ${ioError(error)}`); });
    try {
      await file.writeFile(data).catch(error => { throw new CloudStorageError('FileSystem', `写入文件失败: ${ioError(error)}`); });
    } finally { await file.close(); }
    progress?.(total, total);
    return checksum;
  }
}
