/**
 * S3-compatible transport (s3.rs) on top of the official `@aws-sdk/client-s3`.
 *
 * Rust uses `aws-sdk-s3`; the JS SDK is the same code base and therefore keeps
 * the behaviours a hand-written client lost: standard retry (3 attempts,
 * throttling/transient classification, `x-amz-retry-after`), SigV4, endpoint
 * rules (including endpoint path prefixes), connection/attempt timeouts and
 * `force_path_style`.
 *
 * Deliberate SDK settings copied from s3.rs:200-207:
 * - `requestChecksumCalculation: WHEN_REQUIRED` / `responseChecksumValidation:
 *   WHEN_REQUIRED`, because COS/OSS/MinIO reject the CRC32 trailer that
 *   `behavior_version_latest` adds to every PutObject.
 * - endpoint bucket-prefix normalisation (`{bucket}.{provider-service-host}`)
 *   before constructing the client, so the SDK never doubles the bucket.
 *
 * Application-level behaviour that is *not* the SDK's job is preserved:
 * 10 000-part planning, stale multipart cleanup, per-part retry inside one
 * put_file, `Content-Range` fail-closed resume/prefix reads and remote-size
 * verification after every upload.
 */

import { sha256Hasher } from './hashing.ts';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { createS3RequestHandler } from './s3_http.ts';
import type { FileInfo, DownloadProgressCallback, UploadProgressCallback, S3Config } from '../api.ts';
import { concatBytes } from './bytes.ts';
import { CloudStorageError, ioError } from './errors.ts';
import { openFile, randomTempName, renameOver, statFile, type OpenFile } from './fsutil.ts';
import { fs } from './local-fs.ts';
import { defaultLogSink, type LogSink } from './logging.ts';
import { calculateFileHash } from './resume.ts';
import {
  BoundedMemoryBody,
  CHUNK_SIZE,
  CloudStorageBase,
  MEMORY_GET_DEFAULT_BUDGET_BYTES,
  MEMORY_GET_STALL_SECS,
  MIN_MULTIPART_SIZE,
  cancellableSleep,
  ensureDeclaredLenWithinBudget,
  ensureMemoryGetMatchesDeclaredLen,
  syncCancelSignal,
} from './traits.ts';
import { chronoAutoSiZ } from './time.ts';
import { parseContentRangeStart } from './webdav.ts';

export const MAX_MULTIPART_PARTS = 10_000;
export const MULTIPART_PART_ATTEMPTS = 3;
export const MULTIPART_STALE_SECS = 6 * 3600;
export const MAX_PART_SIZE = 5 * 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
const CONNECT_TIMEOUT_MS = 30_000;
const ATTEMPT_TIMEOUT_MS = 120_000;

/** s3.rs:42: grow the part size so 10 000 parts always suffice; reject beyond S3's limit. */
export function planMultipartPartSize(fileSize: number): number {
  const minPart = Math.ceil(fileSize / MAX_MULTIPART_PARTS);
  const partSize = Math.max(CHUNK_SIZE, Math.ceil(minPart / MIB) * MIB);
  if (partSize > MAX_PART_SIZE) {
    throw new CloudStorageError('Validation', `文件过大（${fileSize} 字节）：即使使用 5GiB 分块也会超过 S3 的 10000 分块限制`);
  }
  return partSize;
}

/** s3.rs:55. */
export function plannedPartCount(fileSize: number, partSize: number): number {
  return Math.max(Math.ceil(fileSize / partSize), 1);
}

/** s3.rs:86: strip a provider bucket-prefixed host so the SDK-side join does not double it. */
export function normalizeEndpoint(endpoint: string, bucket: string, log?: LogSink): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  const withScheme = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
  const bucketName = bucket.trim();
  if (!bucketName) return withScheme;
  let url: URL;
  try { url = new URL(withScheme); } catch { return withScheme; }
  const host = url.hostname;
  const prefix = `${bucketName}.`;
  if (host.startsWith(prefix)) {
    const rest = host.slice(prefix.length);
    if (isKnownProviderServiceHost(rest)) {
      url.hostname = rest;
      log?.info(`[CloudStorage::S3] endpoint 中检测到 bucket 前缀域名，已归一化为服务端点: ${host} -> ${rest}`);
      return url.href.replace(/\/+$/, '');
    }
  }
  return withScheme;
}

/** s3.rs:123: only provider-defined `{bucket}.{service-host}` shapes, never a guess. */
export function isKnownProviderServiceHost(host: string): boolean {
  const labels = host.split('.');
  if (labels.length === 4 && labels[0] === 'cos' && labels[2] === 'myqcloud' && labels[3] === 'com') return Boolean(labels[1]);
  if (labels.length === 3 && labels[1] === 'aliyuncs' && labels[2] === 'com') return Boolean(labels[0]!.startsWith('oss-') && labels[0]!.length > 4);
  if (labels.length === 3 && labels[0] === 's3' && labels[1] === 'bitiful' && labels[2] === 'net') return true;
  if (labels.length === 3 && labels[0] === 's3' && labels[1] === 'amazonaws' && labels[2] === 'com') return true;
  if (labels.length === 4 && labels[0] === 's3' && labels[2] === 'amazonaws' && labels[3] === 'com') return Boolean(labels[1]);
  if (labels.length === 3 && labels[1] === 'amazonaws' && labels[2] === 'com') return Boolean(labels[0]!.startsWith('s3-') && labels[0]!.length > 3);
  return false;
}

/** s3.rs:147: configured region wins; blank means infer from the endpoint, else us-east-1. */
export function resolveRegion(configured: string | null | undefined, endpoint: string): string {
  const trimmed = configured?.trim();
  if (trimmed) return trimmed;
  let host: string;
  try { host = new URL(endpoint).hostname.toLowerCase(); } catch { return 'us-east-1'; }
  const labels = host.split('.');
  let region: string | null = null;
  if (labels.length === 4 && labels[0] === 'cos' && labels[2] === 'myqcloud' && labels[3] === 'com') region = labels[1]!;
  else if (labels.length === 4 && labels[0] === 's3' && labels[2] === 'amazonaws' && labels[3] === 'com') region = labels[1]!;
  else if (labels.length === 3 && labels[1] === 'amazonaws' && labels[2] === 'com' && labels[0]!.startsWith('s3-')) region = labels[0]!.slice(3);
  return region ? region : 'us-east-1';
}

/** s3.rs:266: a missing header means the server ignored Range (honest restart from 0). */
export function resumeActualStart(resumeFrom: number, contentRange: string | null): number {
  if (contentRange === null) return 0;
  const start = parseContentRangeStart(contentRange);
  if (start === resumeFrom) return start;
  throw new CloudStorageError('Network', `S3 服务端返回的续传起点与请求不一致（fail-closed，拒绝错位追加）：请求 bytes=${resumeFrom}-，Content-Range=${JSON.stringify(contentRange)}`);
}

/** s3.rs:279: a missing `Initiated` is not stale, so in-flight uploads are never aborted. */
export function multipartUploadIsStale(initiatedEpochSecs: number | null, nowEpochSecs: number): boolean {
  return initiatedEpochSecs !== null && nowEpochSecs - initiatedEpochSecs >= MULTIPART_STALE_SECS;
}

export interface S3StorageOptions {
  /** Injected by `index.ts`; tests can install a recorder. */
  logger?: LogSink;
  /** Test seam for SDK client settings (for example `maxAttempts: 1`). */
  clientConfig?: Partial<S3ClientConfig>;
}

interface AwsErrorShape {
  name?: string;
  message?: string;
  code?: string;
  Code?: string;
  $metadata?: { httpStatusCode?: number };
}

function awsErrorShape(error: unknown): AwsErrorShape {
  return error as AwsErrorShape;
}

/** Service-error Display equivalent: `Code: Message`, falling back to the HTTP status. */
export function s3ErrorDetail(error: unknown): string {
  const shape = awsErrorShape(error);
  const code = shape.Code ?? shape.code ?? shape.name;
  const message = shape.message;
  if (code && message && message !== code && message !== 'UnknownError') return `${code}: ${message}`;
  if (code && code !== 'Error' && code !== 'UnknownError') return code;
  if (message && message !== 'UnknownError') return message;
  const status = shape.$metadata?.httpStatusCode;
  return status === undefined ? String(error) : `HTTP ${status}`;
}

function isNoSuchKey(error: unknown): boolean {
  const shape = awsErrorShape(error);
  return shape.name === 'NoSuchKey' || shape.Code === 'NoSuchKey';
}

function isNotFound(error: unknown): boolean {
  const shape = awsErrorShape(error);
  return shape.name === 'NotFound' || shape.$metadata?.httpStatusCode === 404;
}

/** GetObject `Body` from `createS3RequestHandler` (a Node stream when a test installs another handler). */
type ObjectBody = AsyncIterable<Uint8Array> & { destroy(): void };

function bodyOf(output: { Body?: unknown }): ObjectBody {
  const body = output.Body as Partial<ObjectBody> | null | undefined;
  if (body === null || body === undefined || typeof body[Symbol.asyncIterator] !== 'function' || typeof body.destroy !== 'function') {
    throw new CloudStorageError('Network', 'S3 响应缺少响应体');
  }
  return body as ObjectBody;
}

/** Iterate a response body with a per-chunk stall guard. */
async function* readChunks(body: ObjectBody, stallMs: number | null, stallMessage: string): AsyncGenerator<Uint8Array> {
  const iterator = body[Symbol.asyncIterator]();
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let result: IteratorResult<unknown>;
      try {
        const next = iterator.next();
        result = stallMs === null
          ? await next
          : await Promise.race([
            next,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                body.destroy();
                reject(new CloudStorageError('Network', stallMessage));
              }, stallMs);
            }),
          ]);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
      if (result.done) return;
      const chunk = result.value as Uint8Array;
      yield chunk;
    }
  } finally {
    body.destroy();
  }
}

export class S3Storage extends CloudStorageBase {
  private readonly endpoint: string;
  private readonly bucket: string;
  private readonly root: string;
  private readonly region: string;
  private readonly client: S3Client;
  private readonly log: LogSink;

  constructor(config: S3Config, root: string, options: S3StorageOptions = {}) {
    super();
    this.log = options.logger ?? defaultLogSink();
    if (!config.endpoint.trim()) throw new CloudStorageError('Validation', 'S3 endpoint 不能为空');
    if (!config.bucket.trim()) throw new CloudStorageError('Validation', 'S3 bucket 不能为空');
    this.endpoint = normalizeEndpoint(config.endpoint, config.bucket, this.log);
    this.bucket = config.bucket;
    this.root = root.replace(/^\/+|\/+$/g, '');
    this.region = resolveRegion(config.region, this.endpoint);
    this.client = new S3Client({
      region: this.region,
      endpoint: this.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.pathStyle ?? false,
      maxAttempts: 3,
      retryMode: 'standard',
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      requestHandler: createS3RequestHandler({ connectionTimeoutMs: CONNECT_TIMEOUT_MS, requestTimeoutMs: ATTEMPT_TIMEOUT_MS }),
      ...options.clientConfig,
    });
  }

  override providerName(): string { return 'S3'; }

  override instanceBindingHint(): string {
    return `s3|endpoint=${this.endpoint}|bucket=${this.bucket}|root=${this.root}`;
  }

  /** s3.rs:232. */
  fullKey(key: string): string {
    const trimmed = key.replace(/^\/+/, '');
    return this.root ? `${this.root}/${trimmed}` : trimmed;
  }

  /** s3.rs:242. */
  relativeKey(fullKey: string): string {
    const prefix = this.root ? `${this.root}/` : '';
    return prefix && fullKey.startsWith(prefix) ? fullKey.slice(prefix.length) : fullKey;
  }

  private logTarget(): LogSink {
    return this.log;
  }

  override async checkConnection(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), { abortSignal: syncCancelSignal() });
    } catch (error) {
      throw new CloudStorageError('Network', `S3 连接检测失败: ${s3ErrorDetail(error)}`);
    }
  }

  override async putFile(key: string, localPath: string, progress?: UploadProgressCallback | null): Promise<string> {
    let fileSize: number;
    try { fileSize = (await statFile(localPath)).size; }
    catch (error) { throw new CloudStorageError('FileSystem', `读取文件元信息失败: ${ioError(error)}`); }
    const fullKey = this.fullKey(key);
    progress?.(0, fileSize);

    if (fileSize < MIN_MULTIPART_SIZE) {
      const checksum = await calculateFileHash(localPath);
      let body: Uint8Array;
      try { body = await fs.readFile(localPath); }
      catch (error) { throw new CloudStorageError('FileSystem', `读取文件失败: ${ioError(error)}`); }
      try {
        await this.client.send(new PutObjectCommand({
          Bucket: this.bucket,
          Key: fullKey,
          Body: body,
          ContentLength: body.byteLength,
        }), { abortSignal: syncCancelSignal() });
      } catch (error) {
        throw new CloudStorageError('Network', `S3 上传失败: ${s3ErrorDetail(error)}`);
      }
      progress?.(fileSize, fileSize);
      await this.verifyRemoteObjectSize(key, fileSize);
      return checksum;
    }

    const partSize = planMultipartPartSize(fileSize);
    const plannedParts = plannedPartCount(fileSize, partSize);
    this.logTarget().debug(`[CloudStorage::S3] multipart 上传 ${fullKey}: ${fileSize} 字节，计划 ${plannedParts} 块 × ${partSize} 字节`);
    await this.abortStaleMultipartUploads(fullKey);

    let uploadId: string;
    try {
      const created = await this.client.send(new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: fullKey,
      }), { abortSignal: syncCancelSignal() });
      if (!created.UploadId) throw new CloudStorageError('Unknown', 'S3 分块上传未返回 upload_id');
      uploadId = created.UploadId;
    } catch (error) {
      if (error instanceof CloudStorageError) throw error;
      throw new CloudStorageError('Network', `S3 创建分块上传失败: ${s3ErrorDetail(error)}`);
    }

    let checksum: string;
    try {
      const handle = await openFile(localPath, 'r');
      const hasher = sha256Hasher();
      const completed: CompletedPart[] = [];
      const buffer = new Uint8Array(partSize);
      let partNumber = 1;
      let uploaded = 0;
      try {
        for (;;) {
          let bytesRead = 0;
          for (;;) {
            if (bytesRead >= partSize) break;
            const chunk = await handle.read(buffer, bytesRead, partSize - bytesRead);
            if (chunk === 0) break;
            bytesRead += chunk;
          }
          if (bytesRead === 0) break;
          if (partNumber > MAX_MULTIPART_PARTS) {
            throw new CloudStorageError('Validation', 'S3 分块数超过 10000 的限制（文件可能在上传期间被修改变大）');
          }
          const part = buffer.subarray(0, bytesRead);
          hasher.update(part);
          const etag = await this.uploadPartWithRetry(fullKey, uploadId, partNumber, part);
          completed.push({ PartNumber: partNumber, ETag: etag });
          uploaded += bytesRead;
          progress?.(uploaded, fileSize);
          partNumber += 1;
        }
      } finally { await handle.close(); }

      try {
        await this.client.send(new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: fullKey,
          UploadId: uploadId,
          MultipartUpload: { Parts: completed },
        }), { abortSignal: syncCancelSignal() });
      } catch (error) {
        throw new CloudStorageError('Network', `S3 完成分块上传失败: ${s3ErrorDetail(error)}`);
      }
      checksum = hasher.digestHex();
    } catch (error) {
      // Rust s3.rs:560: abort failures are ignored, the original upload error wins.
      // Cleanup must still reach S3 when the task's cancellation signal is already aborted.
      await this.client.send(new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: fullKey,
        UploadId: uploadId,
      })).catch(() => undefined);
      throw error;
    }

    progress?.(fileSize, fileSize);
    await this.verifyRemoteObjectSize(key, fileSize);
    return checksum;
  }

  /** s3.rs:286: stale in-progress uploads are aborted; listing/abort failures never block. */
  async abortStaleMultipartUploads(fullKey: string): Promise<void> {
    const nowEpochSecs = Math.floor(Date.now() / 1000);
    let keyMarker: string | null = null;
    let uploadIdMarker: string | null = null;
    for (;;) {
      let output;
      try {
        output = await this.client.send(new ListMultipartUploadsCommand({
          Bucket: this.bucket,
          Prefix: fullKey,
          ...(keyMarker === null ? {} : { KeyMarker: keyMarker }),
          ...(uploadIdMarker === null ? {} : { UploadIdMarker: uploadIdMarker }),
        }), { abortSignal: syncCancelSignal() });
      } catch (error) {
        this.logTarget().warn(`[CloudStorage::S3] 列举未完成 multipart 失败（不阻断本次上传）: ${s3ErrorDetail(error)}`);
        return;
      }

      for (const upload of output.Uploads ?? []) {
        if (upload.Key !== fullKey) continue;
        const uploadId = upload.UploadId;
        if (!uploadId) continue;
        const initiated = upload.Initiated ? Math.floor(upload.Initiated.getTime() / 1000) : null;
        const initiatedEpoch = initiated === null || Number.isNaN(initiated) ? null : initiated;
        if (!multipartUploadIsStale(initiatedEpoch, nowEpochSecs)) continue;
        try {
          await this.client.send(new AbortMultipartUploadCommand({
            Bucket: this.bucket,
            Key: fullKey,
            UploadId: uploadId,
          }), { abortSignal: syncCancelSignal() });
          this.logTarget().info(`[CloudStorage::S3] 已中止陈旧 multipart key=${fullKey} upload_id=${uploadId}`);
        } catch (error) {
          this.logTarget().warn(`[CloudStorage::S3] 中止陈旧 multipart 失败 key=${fullKey}: ${s3ErrorDetail(error)}`);
        }
      }

      if (output.IsTruncated !== true) break;
      keyMarker = output.NextKeyMarker ?? null;
      uploadIdMarker = output.NextUploadIdMarker ?? null;
      if (keyMarker === null) break;
    }
  }

  /** s3.rs:355: per-part retry inside one put_file; a new upload_id is never reused. */
  private async uploadPartWithRetry(fullKey: string, uploadId: string, partNumber: number, chunk: Uint8Array): Promise<string> {
    let lastError: string | null = null;
    for (let attempt = 1; attempt <= MULTIPART_PART_ATTEMPTS; attempt++) {
      try {
        const output = await this.client.send(new UploadPartCommand({
          Bucket: this.bucket,
          Key: fullKey,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: chunk,
          ContentLength: chunk.byteLength,
        }), { abortSignal: syncCancelSignal() });
        if (!output.ETag) throw new CloudStorageError('Unknown', 'S3 分块上传未返回 ETag');
        return output.ETag;
      } catch (error) {
        if (syncCancelSignal()?.aborted) throw new CloudStorageError('Unknown', '云同步已取消');
        if (error instanceof CloudStorageError) throw error;
        lastError = s3ErrorDetail(error);
        if (attempt < MULTIPART_PART_ATTEMPTS) {
          this.logTarget().warn(`[CloudStorage::S3] 分块 ${partNumber} 第 ${attempt}/${MULTIPART_PART_ATTEMPTS} 次失败，将重试同一分块: ${lastError}`);
          await cancellableSleep(1000 * 2 ** (attempt - 1));
        }
      }
    }
    throw new CloudStorageError('Network', `S3 分块上传失败（已重试 ${MULTIPART_PART_ATTEMPTS} 次）: ${lastError ?? ''}`);
  }

  override async getFile(key: string, localPath: string, expectedChecksum?: string | null, progress?: DownloadProgressCallback | null): Promise<string> {
    const info = await this.stat(key);
    if (info === null) throw new CloudStorageError('NotFound', '云端文件不存在');
    const totalSize = info.size;
    progress?.(0, totalSize);

    let body: ObjectBody;
    try {
      const output = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
      }), { abortSignal: syncCancelSignal() });
      body = bodyOf(output);
    } catch (error) {
      throw new CloudStorageError('Network', `S3 下载失败: ${s3ErrorDetail(error)}`);
    }

    const tempPath = await randomTempName(localPath, '.download-', '');
    let handle: OpenFile;
    try { handle = await openFile(tempPath, 'w'); }
    catch (error) { body.destroy(); throw error; }
    const hasher = sha256Hasher();
    let downloaded = 0;
    try {
      for await (const chunk of readChunks(body, null, '')) {
        await handle.write(chunk);
        hasher.update(chunk);
        downloaded += chunk.byteLength;
        progress?.(downloaded, totalSize);
      }
      await handle.sync();
    } catch (error) {
      await handle.close(); await handle.remove();
      if (error instanceof CloudStorageError) throw error;
      throw new CloudStorageError('Network', `读取 S3 响应失败: ${s3ErrorDetail(error)}`);
    }
    await handle.close();

    if (downloaded !== totalSize) {
      await handle.remove();
      throw new CloudStorageError('Network', `S3 下载不完整或对象已变更：声明 ${totalSize} 字节，实际收到 ${downloaded} 字节，已拒绝保存（请重试）`);
    }
    const checksum = hasher.digestHex();
    if (expectedChecksum != null && expectedChecksum !== checksum) {
      await handle.remove();
      throw new CloudStorageError('Validation', `校验失败：期望 ${expectedChecksum}, 实际 ${checksum}`);
    }
    await renameOver(tempPath, localPath);
    return checksum;
  }

  override supportsResumableDownload(): boolean { return true; }

  override async getFileResumable(key: string, dest: string, resumeFrom: number, progress?: DownloadProgressCallback | null): Promise<number> {
    const info = await this.stat(key);
    if (info === null) throw new CloudStorageError('NotFound', '云端文件不存在');
    const totalSize = info.size;
    if (resumeFrom > totalSize) {
      throw new CloudStorageError('Validation', `本地断点（${resumeFrom} 字节）大于云端对象（${totalSize} 字节），断点无效，请删除断点文件后整包重新下载`);
    }
    progress?.(resumeFrom, totalSize);
    if (resumeFrom === totalSize) return resumeFrom;

    let body: ObjectBody;
    let contentRange: string | null;
    try {
      const output = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
        ...(resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : {}),
      }), { abortSignal: syncCancelSignal() });
      body = bodyOf(output);
      contentRange = output.ContentRange ?? null;
    } catch (error) {
      throw new CloudStorageError('Network', `S3 续传下载失败: ${s3ErrorDetail(error)}`);
    }
    let actualStart: number;
    try { actualStart = resumeActualStart(resumeFrom, contentRange); }
    catch (error) { body.destroy(); throw error; }
    if (actualStart === 0 && resumeFrom > 0) {
      this.logTarget().warn(`S3 服务端未按 Range 续传（无匹配 Content-Range），已丢弃本地断点从零重下: ${key}`);
    }

    let handle: OpenFile;
    try { handle = await openFile(dest, actualStart > 0 ? 'a' : 'w'); }
    catch (error) { body.destroy(); throw error; }
    if (actualStart > 0) {
      const existing = await handle.stat();
      if (existing.size !== actualStart) {
        await handle.close();
        body.destroy();
        throw new CloudStorageError('FileSystem', `断点文件大小（${existing.size} 字节）与续传起点（${actualStart} 字节）不一致，拒绝错位追加`);
      }
    }
    let written = actualStart;
    try {
      for await (const chunk of readChunks(body, MEMORY_GET_STALL_SECS * 1000, 'S3 续传下载停滞超过 90 秒，连接可能已断开（已写入的断点保留，可重试续传）')) {
        if (written + chunk.byteLength > totalSize) {
          throw new CloudStorageError('Validation', `云端对象返回超过声明大小（${totalSize} 字节）的数据，拒绝写入（对象可能已被并发修改）`);
        }
        await handle.write(chunk);
        written += chunk.byteLength;
        progress?.(written, totalSize);
      }
      await handle.sync();
    } finally { await handle.close(); }

    if (written !== totalSize) {
      throw new CloudStorageError('Network', `S3 下载在 ${written}/${totalSize} 字节处中断（已写入的断点保留，可重试续传）`);
    }
    return actualStart;
  }

  override supportsPrefixRead(): boolean { return true; }

  override async getPrefix(key: string, prefixLen: number): Promise<Uint8Array | null> {
    if (prefixLen === 0) return new Uint8Array();
    let body: ObjectBody;
    let contentRange: string | null;
    try {
      const output = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
        Range: `bytes=0-${prefixLen - 1}`,
      }), { abortSignal: syncCancelSignal() });
      body = bodyOf(output);
      contentRange = output.ContentRange ?? null;
    } catch (error) {
      if (isNoSuchKey(error)) return null;
      throw new CloudStorageError('Network', `S3 前缀读取失败: ${s3ErrorDetail(error)}`);
    }

    if (contentRange !== null && parseContentRangeStart(contentRange) !== 0) {
      body.destroy();
      throw new CloudStorageError('Network', `S3 服务端返回的前缀起点不是 0（fail-closed，拒绝错位字节）：请求 bytes=0-，Content-Range=${JSON.stringify(contentRange)}`);
    }

    const parts: Uint8Array[] = [];
    let length = 0;
    try {
      for await (const chunk of readChunks(body, MEMORY_GET_STALL_SECS * 1000, 'S3 前缀读取停滞超过 90 秒，连接可能已断开')) {
        const need = Math.min(prefixLen - length, chunk.byteLength);
        parts.push(chunk.subarray(0, need));
        length += need;
        if (length >= prefixLen) break;
      }
    } catch (error) {
      if (error instanceof CloudStorageError) throw error;
      throw new CloudStorageError('Network', `读取 S3 响应失败: ${s3ErrorDetail(error)}`);
    }
    return concatBytes(parts, length);
  }

  override async put(key: string, data: Uint8Array): Promise<void> {
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
        Body: data,
        ContentLength: data.byteLength,
      }), { abortSignal: syncCancelSignal() });
    } catch (error) {
      throw new CloudStorageError('Network', `S3 上传失败: ${s3ErrorDetail(error)}`);
    }
  }

  override async get(key: string): Promise<Uint8Array | null> {
    return this.getBounded(key, MEMORY_GET_DEFAULT_BUDGET_BYTES);
  }

  override async getRange(key: string, offset: number, length: number): Promise<Uint8Array> {
    this.validateRange(offset, length);
    if (length === 0) return new Uint8Array(0);
    let body: ObjectBody | undefined;
    try {
      const end = offset + length - 1;
      const output = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket, Key: this.fullKey(key), Range: `bytes=${offset}-${end}`,
      }), { abortSignal: syncCancelSignal() });
      body = bodyOf(output);
      const status = output.$metadata?.httpStatusCode ?? (output.ContentRange ? 206 : 200);
      if (status === 206) {
        const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(output.ContentRange ?? '');
        if (!match || Number(match[1]) !== offset || Number(match[2]) !== end
          || (match[3] !== '*' && Number(match[3]) <= end)) {
          throw new CloudStorageError('Network', `S3 Range 响应区间不匹配或越界: ${output.ContentRange}`);
        }
      } else if (status !== 200) throw new CloudStorageError('Network', `S3 Range HTTP 状态异常: ${status}`);
      const budget = status === 206 ? length : 8 * 1024 * 1024;
      ensureDeclaredLenWithinBudget('S3 Range', key, output.ContentLength ?? null, budget);
      const bounded = new BoundedMemoryBody('S3 Range', key, budget);
      for await (const chunk of readChunks(body, MEMORY_GET_STALL_SECS * 1000, 'S3 Range 读取停滞')) bounded.push(chunk);
      const bytes = bounded.intoBytes();
      if (status === 206) {
        if (bytes.byteLength !== length) throw new CloudStorageError('Network', 'S3 Range 返回长度不匹配或请求越界');
        return bytes;
      }
      if (bytes.byteLength < offset + length) throw new CloudStorageError('Network', 'S3 Range 整包响应请求越界');
      return new Uint8Array(bytes.buffer, bytes.byteOffset + offset, length);
    } catch (error) {
      if (isNoSuchKey(error)) throw new CloudStorageError('NotFound', '云端文件不存在');
      if (error instanceof CloudStorageError) throw error;
      throw new CloudStorageError('Network', `S3 Range 读取失败（可能请求越界 / HTTP 416）: ${s3ErrorDetail(error)}`);
    } finally { body?.destroy(); }
  }

  override async getBounded(key: string, maxBytes: number): Promise<Uint8Array | null> {
    let body: ObjectBody;
    let declared: number | null;
    try {
      const output = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
      }), { abortSignal: syncCancelSignal() });
      body = bodyOf(output);
      declared = output.ContentLength ?? null;
    } catch (error) {
      if (isNoSuchKey(error)) return null;
      throw new CloudStorageError('Network', `S3 下载失败: ${s3ErrorDetail(error)}`);
    }

    try { ensureDeclaredLenWithinBudget('S3', key, declared, maxBytes); }
    catch (error) { body.destroy(); throw error; }
    const bounded = new BoundedMemoryBody('S3', key, maxBytes);
    try {
      for await (const chunk of readChunks(body, MEMORY_GET_STALL_SECS * 1000, 'S3 内存对象下载停滞超过 90 秒，连接可能已断开')) {
        bounded.push(chunk);
      }
    } catch (error) {
      body.destroy();
      if (error instanceof CloudStorageError) throw error;
      throw new CloudStorageError('Network', `S3 读取响应体失败: ${s3ErrorDetail(error)}`);
    }
    ensureMemoryGetMatchesDeclaredLen('S3', key, bounded.len(), declared);
    return bounded.intoBytes();
  }

  override async list(prefix: string): Promise<FileInfo[]> {
    const fullPrefix = this.fullKey(prefix);
    const files: FileInfo[] = [];
    let continuationToken: string | null = null;
    for (;;) {
      let output;
      try {
        output = await this.client.send(new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: fullPrefix,
          ...(continuationToken === null ? {} : { ContinuationToken: continuationToken }),
        }), { abortSignal: syncCancelSignal() });
      } catch (error) {
        throw new CloudStorageError('Network', `S3 列出文件失败: ${s3ErrorDetail(error)}`);
      }

      for (const object of output.Contents ?? []) {
        const key = object.Key ?? '';
        if (key.endsWith('/')) continue;
        const size = object.Size ?? 0;
        const lastModified = object.LastModified;
        let epochMs = 0;
        if (lastModified === undefined || Number.isNaN(lastModified.getTime())) {
          this.logTarget().warn(`[CloudStorage::S3] Missing or invalid last_modified timestamp for key '${key}', using epoch fallback`);
        } else {
          epochMs = lastModified.getTime();
        }
        files.push({
          key: this.relativeKey(key),
          size,
          lastModified: chronoAutoSiZ(epochMs),
          ...(object.ETag === undefined ? {} : { etag: object.ETag }),
        });
      }

      if (output.IsTruncated === true) {
        if (output.NextContinuationToken === undefined) {
          throw new CloudStorageError('Network', 'S3 列表被截断但未返回 continuation token，无法安全继续分页');
        }
        continuationToken = output.NextContinuationToken;
      } else break;
    }
    files.sort((a, b) => Date.parse(b.lastModified) - Date.parse(a.lastModified));
    return files;
  }

  override async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
      }), { abortSignal: syncCancelSignal() });
    } catch (error) {
      throw new CloudStorageError('Network', `S3 删除失败: ${s3ErrorDetail(error)}`);
    }
  }

  override async stat(key: string): Promise<FileInfo | null> {
    let output;
    try {
      output = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
      }), { abortSignal: syncCancelSignal() });
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new CloudStorageError('Network', `S3 获取文件信息失败: ${s3ErrorDetail(error)}`);
    }

    const size = output.ContentLength ?? 0;
    const lastModified = output.LastModified;
    let epochMs = 0;
    if (lastModified === undefined || Number.isNaN(lastModified.getTime())) {
      this.logTarget().warn(`[CloudStorage::S3] Missing or invalid last_modified timestamp for key '${this.fullKey(key)}', using epoch fallback`);
    } else {
      epochMs = lastModified.getTime();
    }
    return {
      key,
      size,
      lastModified: chronoAutoSiZ(epochMs),
      ...(output.ETag === undefined ? {} : { etag: output.ETag }),
    };
  }
}
