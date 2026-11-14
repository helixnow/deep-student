/**
 * [R4-e2ee-cas] `.encryption-marker` claim protocol (e2ee_claim.rs).
 *
 * Dumb storage has no conditional PUT, so "read marker → blind PUT" loses updates
 * when two devices claim the same root concurrently. The protocol is:
 *  1. register `.pending/<nonce>.json`, list it back, and require only our own entry;
 *  2. bounded-read the marker and require it to match the expectation;
 *  3. lease gate (`.encryption-marker.lease`, default TTL 60 s);
 *  4. write our lease, read it back byte-for-byte;
 *  5. re-read the marker and require it to equal the step-2 snapshot;
 *  6. PUT the marker and read it back;
 *  7. re-read the lease (must still be ours);
 *  8. best-effort release the lease.
 *
 * A timeout never steals another writer's registration: only the writer deletes its
 * own unique key. Simultaneous failure is allowed; simultaneous success is not.
 */

import type { CloudStorage, FileInfo } from '../api.ts';
import { CloudStorageError } from './errors.ts';
import { millisecondsToNanos } from './time.ts';
import { defaultLogSink } from './logging.ts';
import { nowEpochNanos, parseRfc3339, toRfc3339 } from '../../../platform/time/index.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import { decodeEncryptionMarker, type EncryptionMarker } from './marker.ts';
import { isUuid } from './lease.ts';
import { syncE2eeError } from './mod.ts';
import {
  SerdeJsonError, decodeString, decodeStruct, decodeU32, fromSlice, type Deserializer,
} from './serde_struct.ts';
import { randomUuid } from './random.ts';
import { bytesEqual, utf8Encode } from './bytes.ts';

export const ENCRYPTION_MARKER_LEASE_SUFFIX = '.lease';
export const DEFAULT_E2EE_CLAIM_LEASE_TTL_MS = 60_000;
export const E2EE_CLAIM_LEASE_FORMAT_VERSION = 1;
export const SYNC_E2EE_CLAIM_CONFLICT_CODE = 'E_SYNC_E2EE_CLAIM_CONFLICT';
export const MAX_E2EE_CLAIM_OBJECT_BYTES = 64 * 1024;

function pendingPrefix(markerKey: string): string {
  return `${markerKey}.pending/`;
}

function claimConflict(message: string): CloudStorageError {
  return new CloudStorageError('Conflict', syncE2eeError(SYNC_E2EE_CLAIM_CONFLICT_CODE, message));
}

async function checkPendingClaims(storage: CloudStorage, markerKey: string, ownKey: string | null): Promise<void> {
  const prefix = pendingPrefix(markerKey);
  const listing = await storage.listOutcome(prefix);
  if (listing.truncated) {
    throw claimConflict('加密认领登记列表被截断，无法确认独占写入，已中止');
  }
  if (ownKey !== null && !listing.files.some(file => file.key === ownKey)) {
    throw claimConflict('云端列表未包含本次加密认领登记，无法确认列表新鲜度，已中止');
  }
  if (listing.files.some(file => file.key !== ownKey)) {
    throw claimConflict(
      `云端存在尚未完成的加密认领（${prefix}）。请等待另一台设备完成后重试；`
      + '若设备已崩溃，须先确认它不会继续写入，再人工清理该目录中的残留登记。',
    );
  }
}

export async function ensureNoPendingClaims(storage: CloudStorage, markerKey: string): Promise<void> {
  await checkPendingClaims(storage, markerKey, null);
}

export interface EncryptionClaimLease {
  format_version: number;
  device_id: string;
  nonce: string;
  created_at: string;
  expires_at: string;
}

export function createLease(deviceIdShort: string, ttlMs: number, nowNanos: bigint): EncryptionClaimLease {
  if (!rustTrim(deviceIdShort)) throw new CloudStorageError('Validation', 'E2EE 认领租约缺少设备 ID');
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new CloudStorageError('Validation', 'E2EE 认领租约 TTL 必须大于零');
  return {
    format_version: E2EE_CLAIM_LEASE_FORMAT_VERSION,
    device_id: rustTrim(deviceIdShort),
    nonce: randomUuid(),
    created_at: toRfc3339(nowNanos),
    expires_at: toRfc3339(nowNanos + millisecondsToNanos(ttlMs)),
  };
}

/** `serde_json::from_slice::<EncryptionClaimLease>` (e2ee_claim.rs:137-147, snake_case). */
function decodeLease(bytes: Uint8Array): EncryptionClaimLease {
  return fromSlice(bytes, (root: Deserializer) => decodeStruct(root, 'EncryptionClaimLease', {
    format_version: { decode: decodeU32 },
    device_id: { decode: decodeString },
    nonce: { decode: decodeString },
    created_at: { decode: decodeString },
    expires_at: { decode: decodeString },
  }));
}

/** `expires_at_utc`: `DateTime::parse_from_rfc3339`, exact to the nanosecond. */
function leaseExpiryNanos(lease: EncryptionClaimLease): bigint | null {
  return parseRfc3339(lease.expires_at)?.epochNanos ?? null;
}

/** e2ee_claim.rs:174-180 `structurally_valid`. */
function structurallyValid(lease: EncryptionClaimLease): boolean {
  return lease.format_version === E2EE_CLAIM_LEASE_FORMAT_VERSION
    && rustTrim(lease.device_id) !== ''
    && isUuid(lease.nonce)
    && parseRfc3339(lease.created_at) !== null
    && leaseExpiryNanos(lease) !== null;
}

/** `from_slice(..).ok().filter(structurally_valid)`. */
function readLease(bytes: Uint8Array): EncryptionClaimLease | null {
  let lease: EncryptionClaimLease;
  try { lease = decodeLease(bytes); }
  catch (error) {
    if (error instanceof SerdeJsonError) return null;
    throw error;
  }
  return structurallyValid(lease) ? lease : null;
}

export type ClaimExpectation = 'Absent' | 'LegacyV1';

type MarkerSnapshot = { kind: 'Absent' } | { kind: 'LegacyV1'; raw: Uint8Array; parsed: EncryptionMarker };

function ensureClaimPayloadBounded(what: string, length: number): void {
  if (length > MAX_E2EE_CLAIM_OBJECT_BYTES) {
    throw new CloudStorageError('Unknown',
      `${what}为 ${length} 字节，超过 ${MAX_E2EE_CLAIM_OBJECT_BYTES} 字节上限，已拒绝写入`);
  }
}

async function readBounded(storage: CloudStorage, key: string): Promise<Uint8Array | null> {
  const info = await storage.stat(key);
  if (info !== null && info.size > MAX_E2EE_CLAIM_OBJECT_BYTES) {
    throw claimConflict(
      `认领对象 ${key} 为 ${info.size} 字节，超过 ${MAX_E2EE_CLAIM_OBJECT_BYTES} 字节上限，已拒绝下载（fail-closed）。请人工检查该云端目录。`);
  }
  const bytes = await storage.getBounded(key, MAX_E2EE_CLAIM_OBJECT_BYTES);
  if (bytes === null) return null;
  if (bytes.byteLength > MAX_E2EE_CLAIM_OBJECT_BYTES) {
    throw claimConflict(
      `认领对象 ${key} 实收 ${bytes.byteLength} 字节，超过 ${MAX_E2EE_CLAIM_OBJECT_BYTES} 字节上限，已拒绝（fail-closed）。请人工检查该云端目录。`);
  }
  return bytes;
}

async function deleteIfUnchanged(storage: CloudStorage, key: string, expected: Uint8Array): Promise<boolean> {
  const current = await storage.getBounded(key, MAX_E2EE_CLAIM_OBJECT_BYTES);
  if (current === null || !bytesEqual(current, expected)) return false;
  await storage.delete(key);
  return true;
}

async function readMarkerSnapshot(
  storage: CloudStorage,
  markerKey: string,
  expectation: ClaimExpectation,
): Promise<MarkerSnapshot> {
  const raw = await readBounded(storage, markerKey);
  if (raw === null) {
    if (expectation === 'Absent') return { kind: 'Absent' };
    throw claimConflict('升级旧版加密标记时发现标记已消失（可能被并发删除或改动），已中止本次升级；请重试上传以重新读取云端状态。');
  }
  if (expectation === 'Absent') {
    throw claimConflict('云端加密标记已被其他设备创建，本次首次认领中止；请重试上传，将按已有标记校验加密密码。');
  }
  let parsed: EncryptionMarker;
  try { parsed = decodeEncryptionMarker(raw); }
  catch (error) {
    throw claimConflict(`升级前复核云端加密标记失败：内容无法解析（${error instanceof Error ? error.message : String(error)}），fail-closed。请人工检查该云端目录。`);
  }
  if (parsed.version > 1 || parsed.keyVerifier != null) {
    throw claimConflict('云端加密标记已不再是可升级的 v1 旧标记（可能已被其他设备升级），本次升级中止；请重试上传，将按已有标记校验加密密码。');
  }
  return { kind: 'LegacyV1', raw, parsed };
}

function fallbackExpiryNanos(info: FileInfo | null, ttlMs: number, nowNanos: bigint): bigint {
  return (info === null ? nowNanos : parseRfc3339(info.lastModified)?.epochNanos ?? nowNanos)
    + millisecondsToNanos(ttlMs);
}

async function ensureNoLiveLease(
  storage: CloudStorage,
  leaseKey: string,
  ttlMs: number,
  nowNanos: bigint,
): Promise<void> {
  const info = await storage.stat(leaseKey);
  if (info !== null && info.size > MAX_E2EE_CLAIM_OBJECT_BYTES) {
    const fallback = fallbackExpiryNanos(info, ttlMs, nowNanos);
    if (fallback > nowNanos) {
      throw claimConflict(
        `云端存在无法解读的加密标记认领租约（${info.size} 字节，超过上限），按活跃处理至 ${toRfc3339(fallback)}；请稍后重试。`);
    }
    await storage.delete(leaseKey);
    return;
  }
  const bytes = await storage.getBounded(leaseKey, MAX_E2EE_CLAIM_OBJECT_BYTES);
  if (bytes === null) return;
  const parsed = readLease(bytes);
  const leaseNanos = parsed === null ? null : leaseExpiryNanos(parsed);
  const expiresAt = leaseNanos ?? fallbackExpiryNanos(info, ttlMs, nowNanos);
  if (expiresAt > nowNanos) {
    const holder = parsed?.device_id ?? '未知设备（租约内容损坏）';
    throw claimConflict(
      `云端加密标记正被其他设备认领：${holder}（租约预计 ${toRfc3339(expiresAt)} 到期）。`
      + '请等待其完成或租约过期后重试；不要手工删除云端认领文件。');
  }
  await deleteIfUnchanged(storage, leaseKey, bytes);
}

async function publishMarkerVerified(storage: CloudStorage, markerKey: string, data: Uint8Array): Promise<void> {
  await storage.put(markerKey, data);
  const readBack = await storage.getBounded(markerKey, MAX_E2EE_CLAIM_OBJECT_BYTES);
  if (readBack === null) {
    throw new CloudStorageError('Unknown', '加密标记上传后对象不存在，已停止并不得报成功');
  }
  if (!bytesEqual(readBack, data)) {
    throw new CloudStorageError('Unknown', '加密标记上传后回读不一致，已停止并不得报成功');
  }
}

export interface ClaimOptions {
  markerKey: string;
  deviceIdShort: string;
  ttlMs: number;
  expectation: ClaimExpectation;
  buildMarker: (snapshot: EncryptionMarker | null) => Promise<Uint8Array> | Uint8Array;
}

/** Publish (create or v1→v2 upgrade) the marker through the claim protocol. */
export async function claimEncryptionMarker(storage: CloudStorage, options: ClaimOptions): Promise<Uint8Array> {
  const pending = createLease(options.deviceIdShort, options.ttlMs, nowEpochNanos());
  const ownKey = `${pendingPrefix(options.markerKey)}${pending.nonce}.json`;
  const pendingBytes = utf8Encode(JSON.stringify(pending, null, 2));
  ensureClaimPayloadBounded('认领登记', pendingBytes.byteLength);
  await storage.put(ownKey, pendingBytes);

  let result: Uint8Array;
  try {
    result = await claimRegisteredMarker(storage, options, ownKey);
  } catch (error) {
    await storage.delete(ownKey).catch(cleanupError => {
      defaultLogSink().warn(
        `[e2ee-claim] 清理认领登记失败: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    });
    throw error;
  }
  await storage.delete(ownKey);
  return result;
}

async function claimRegisteredMarker(storage: CloudStorage, options: ClaimOptions, ownKey: string): Promise<Uint8Array> {
  const { markerKey, deviceIdShort, ttlMs, expectation, buildMarker } = options;
  const leaseKey = `${markerKey}${ENCRYPTION_MARKER_LEASE_SUFFIX}`;
  const now = nowEpochNanos();

  const snapshot = await readMarkerSnapshot(storage, markerKey, expectation);

  if (expectation === 'Absent' && storage.supportsConditionalPut()) {
    const data = await buildMarker(null);
    ensureClaimPayloadBounded('待发布的加密标记', data.byteLength);
    await checkPendingClaims(storage, markerKey, ownKey);
    if (!await storage.putIfAbsent(markerKey, data)) {
      throw claimConflict('云端加密标记已被其他设备并发创建（条件写冲突），本次认领中止；请重试上传，将按已有标记校验加密密码。');
    }
    await publishMarkerVerified(storage, markerKey, data);
    return data;
  }

  await ensureNoLiveLease(storage, leaseKey, ttlMs, now);

  const lease = createLease(deviceIdShort, ttlMs, now);
  const leaseBytes = utf8Encode(JSON.stringify(lease, null, 2));
  ensureClaimPayloadBounded('认领租约', leaseBytes.byteLength);
  await storage.put(leaseKey, leaseBytes);

  const leaseReadBack = await storage.getBounded(leaseKey, MAX_E2EE_CLAIM_OBJECT_BYTES);
  if (leaseReadBack === null || !bytesEqual(leaseReadBack, leaseBytes)) {
    throw claimConflict('加密标记认领租约被其他设备并发抢占，本次认领中止；请稍后重试。');
  }

  let markerRecheck: Uint8Array | null;
  try { markerRecheck = await readBounded(storage, markerKey); }
  catch (error) {
    await deleteIfUnchanged(storage, leaseKey, leaseBytes).catch(() => undefined);
    throw error;
  }
  const unchanged = snapshot.kind === 'Absent'
    ? markerRecheck === null
    : markerRecheck !== null && bytesEqual(markerRecheck, snapshot.raw);
  if (!unchanged) {
    await deleteIfUnchanged(storage, leaseKey, leaseBytes).catch(() => undefined);
    throw claimConflict('持有认领租约后复核发现云端加密标记已被并发改动，本次认领中止；请重试上传以重新读取云端状态。');
  }

  let data: Uint8Array;
  try {
    data = await buildMarker(snapshot.kind === 'Absent' ? null : snapshot.parsed);
    ensureClaimPayloadBounded('待发布的加密标记', data.byteLength);
  } catch (error) {
    await deleteIfUnchanged(storage, leaseKey, leaseBytes).catch(() => undefined);
    throw error;
  }

  // KDF generation can be slow: revalidate both registers right before the write.
  try {
    await checkPendingClaims(storage, markerKey, ownKey);
    const leaseNow = await readBounded(storage, leaseKey);
    if (leaseNow === null || !bytesEqual(leaseNow, leaseBytes)) {
      throw claimConflict('生成密码校验子期间认领租约已变化，未写入加密标记');
    }
    const markerNow = await readBounded(storage, markerKey);
    const sameMarker = markerRecheck === null ? markerNow === null : markerNow !== null && bytesEqual(markerNow, markerRecheck);
    if (!sameMarker) throw claimConflict('写入前加密标记已被其他设备改变，未覆盖已发布标记');
  } catch (error) {
    await deleteIfUnchanged(storage, leaseKey, leaseBytes).catch(() => undefined);
    throw error;
  }

  try { await publishMarkerVerified(storage, markerKey, data); }
  catch (error) {
    await deleteIfUnchanged(storage, leaseKey, leaseBytes).catch(() => undefined);
    throw error;
  }

  const leaseAfter = await storage.getBounded(leaseKey, MAX_E2EE_CLAIM_OBJECT_BYTES);
  if (leaseAfter === null || !bytesEqual(leaseAfter, leaseBytes)) {
    throw claimConflict(
      '认领期间租约被其他设备并发抢占，无法确认互斥，本次认领按失败处理；'
      + '请重试上传，将按云端当前标记校验加密密码。');
  }

  await deleteIfUnchanged(storage, leaseKey, leaseBytes).catch(error => {
    defaultLogSink().warn(
      `[e2ee-claim] 释放加密标记认领租约失败（将由 TTL 在 ${Math.floor(options.ttlMs / 1000)}s 内回收）: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  });
  return data;
}
