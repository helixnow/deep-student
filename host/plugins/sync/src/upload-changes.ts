/** mod.rs:2456-2705: compress/encrypt once, verify remote bytes before publication. */
import { join } from '../../../platform/util/path.ts';
import type { CloudStorage, UploadProgressCallback } from '../../sync-providers/api.ts';
import { isCloudRateLimited } from '../../sync-providers/api.ts';
import type { SyncStateStore } from '../../sync-support/api.ts';
import type { NativeCompression } from '../../../platform/native/api.ts';
import { nowEpochNanos } from '../../../platform/time/index.ts';
import { ioMessage } from '../../../platform/paths/io-error.ts';
import type { EngineChange } from './change-payload.ts';
import { serializeSyncChange } from './change-payload.ts';
import { validateRemoteFormat, type ValidateRemoteFormatOptions } from './remote-format.ts';
import { ensureRemoteInstanceId } from './manifest-upload.ts';
import { fs } from './local-runtime.ts';
import { maxCloudSeqForDevice, buildChangeKeyV3, buildChangeKeyV4, parseChangeKey } from './change-keys.ts';
import { retryRemote } from './remote-retry.ts';
import { SyncError } from './errors.ts';
import { encodeUtf8 } from '../../../platform/util/portable.ts';
import { timingSafeEqual } from '../../../platform/crypto/encoding.ts';

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
function network(detail: string): never { throw new SyncError(`Network error: ${detail}`); }

async function verifyStreamed(storage: CloudStorage, key: string, bytes: Uint8Array, options: ValidateRemoteFormatOptions): Promise<boolean> {
  let info;
  try { info = await storage.stat(key); }
  catch (error) {
    if (isCloudRateLimited(message(error))) network(message(error));
    options.logger?.warn(`[sync] 上传 size 回验 stat 失败: key=${key}, err=${message(error)}`);
    return false;
  }
  if (info === null) {
    options.logger?.warn(`[sync] 上传后对象不存在（回验失败）: key=${key}`);
    return false;
  }
  if (BigInt(info.size) !== BigInt(bytes.length)) {
    options.logger?.warn(`[sync] 上传 size 回验不符: key=${key}, 期望=${bytes.length}, 实际=${info.size}`);
    return false;
  }
  let readback;
  try { readback = await storage.get(key); }
  catch (error) {
    if (isCloudRateLimited(message(error))) network(message(error));
    options.logger?.warn(`[sync] 上传后回读失败: key=${key}, err=${message(error)}`);
    return false;
  }
  if (readback === null) { options.logger?.warn(`[sync] 上传后回读对象不存在: key=${key}`); return false; }
  if (!timingSafeEqual(readback, bytes)) { options.logger?.warn(`[sync] 上传后回读不一致: key=${key}`); return false; }
  return true;
}

async function putVerified(storage: CloudStorage, key: string, bytes: Uint8Array, options: ValidateRemoteFormatOptions): Promise<void> {
  await retryRemote('上传变更数据', 2, async () => {
    try { await storage.put(key, bytes); }
    catch (error) { network(`上传变更数据失败: ${message(error)}`); }
    let info;
    try { info = await storage.stat(key); }
    catch (error) { network(`上传后回验失败: ${message(error)}`); }
    if (info === null) network(`上传后对象不存在: key=${key}`);
    if (BigInt(info.size) !== BigInt(bytes.length)) network(`上传后 size 校验失败: key=${key}, 期望=${bytes.length}, 实际=${info.size}`);
    let readback;
    try { readback = await storage.get(key); }
    catch (error) { network(`上传后回读失败: ${message(error)}`); }
    if (readback === null) network(`上传后对象不存在: key=${key}`);
    if (!timingSafeEqual(readback, bytes)) network('记录级变更 上传后回读不一致，已停止并不得推进水位');
  }, options.logger);
}

export async function uploadEnrichedChanges(
  storage: CloudStorage, changes: readonly EngineChange[], options: ValidateRemoteFormatOptions,
  openState: () => SyncStateStore, compression: NativeCompression, progress?: UploadProgressCallback | null,
): Promise<void> {
  if (changes.length === 0) { options.logger?.debug('[sync] 没有变更需要上传'); return; }
  const negotiated = await validateRemoteFormat(storage, true, options);
  const instanceId = await ensureRemoteInstanceId(storage, options, openState);
  const state = openState();
  const maxSeq = await maxCloudSeqForDevice(storage, options.deviceId);
  const seq = state.nextUploadSeq(instanceId, options.deviceId, maxSeq);
  const version = nowEpochNanos() / 1_000_000_000n;
  const useV4 = negotiated.min_reader_version >= 4;
  const key = (useV4 ? buildChangeKeyV4 : buildChangeKeyV3)(options.deviceId, seq, version);
  const parsed = parseChangeKey(key);
  const operation = parsed?.kind === 'v4Shard' ? parsed.operationId : null;
  let json: Uint8Array;
  try {
    json = encodeUtf8(`{"changes":[${changes.map(serializeSyncChange).join(',')}],"total_count":${changes.length},"device_id":${JSON.stringify(options.deviceId)},"format_version":${useV4 ? 4 : 3},"source_seq":${seq},"source_device_id":${JSON.stringify(options.deviceId)},"operation_id":${JSON.stringify(operation)}}`);
  } catch (error) { throw new SyncError(`Database error: 序列化变更数据失败: ${message(error)}`); }
  let compressed;
  try { compressed = await compression.zstdEncode(json, 0); }
  catch (error) { throw new SyncError(`Database error: 压缩变更数据失败: ${message(error)}`); }
  const bytes = await options.codec.encode(compressed);
  if (progress != null) {
    let dir: string;
    try { dir = await fs.mkdtemp(join(fs.tmpDir(), 'sync-upload-')); }
    catch (error) { throw new SyncError(`Database error: 创建临时上传文件失败: ${ioMessage(error)}`); }
    try {
      const path = join(dir, 'payload');
      try { await fs.writeFile(path, bytes); }
      catch (error) { throw new SyncError(`Database error: 写入临时上传文件失败: ${ioMessage(error)}`); }
      let uploaded = false;
      try { await storage.putFile(key, path, progress); uploaded = true; }
      catch (error) {
        options.logger?.warn(`[sync] 变更流式上传失败，将回退重试: key=${key}, err=${message(error)}`);
        if (isCloudRateLimited(message(error))) network(message(error));
      }
      if (!uploaded || !await verifyStreamed(storage, key, bytes, options)) await putVerified(storage, key, bytes, options);
    } finally {
      try { await fs.rm(dir, { recursive: true, force: true }); }
      catch { // boundary-allow empty-catch: Rust NamedTempFile Drop ignores temporary-file removal failures.
      }
    }
  } else await putVerified(storage, key, bytes, options);
  state.markPublishedSeq(instanceId, options.deviceId, seq);
  options.logger?.info(`[sync] 带完整数据的变更已上传: device=${options.deviceId}, count=${changes.length}, key=${key}, compressed_size=${compressed.length}, uploaded_size=${bytes.length}, encrypted=${options.codec.encrypted}`);
}
