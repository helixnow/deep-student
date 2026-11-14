/**
 * backup-v2 two-pass candidate/grace garbage collection (`delta_gc.rs`).
 *
 * Not wired: no command, UI, `sync_manager` or other production entry point calls
 * this module. Production Cloud backup is still "whole ZIP -> single object
 * put_file"; this is only the orphan-cleanup building block.
 *
 * First principle: **rather leave garbage than delete a still-referenced object.**
 * Any uncertainty (truncated LIST, missing manifest/descriptor, parse failure,
 * decryption failure, encryption-policy mismatch) fails closed into "zero deletes,
 * zero candidate writes this round".
 *
 * Two-pass protocol (two independent successful full scans, never collect+sweep in
 * one call):
 * 1. `collectGcCandidates`: scan every per-device index and every retained version
 *    descriptor, build the live set (object keys + snapshot keys + config), list
 *    objects/snapshots completely, and register unreferenced keys only as
 *    `backup-v2/gc/candidates/<uuid>.json` (candidate != immediately deletable).
 *    Existing candidates for still-unreferenced keys are retained with their
 *    original `firstSeen`. Zero deletes.
 * 2. `sweepGcCandidates`: rebuild the live set with another independent full scan;
 *    delete a candidate's object only when the key is still unreferenced,
 *    `firstSeen + grace <= now`, and `firstSeen` is not after this scan's start.
 *    Keys re-referenced after collect are never deleted (only the stale candidate is
 *    dropped). Object deletion failure leaves garbage; a visible version can never
 *    lose an object.
 */

import { sha256Hex } from './hashing.ts';
import { isEncryptedBackup } from '../../../platform/secrets/dsbk-stream.ts';
import type { FileCipherSession } from '../../../platform/secrets/api.ts';
import type { CloudStorage } from '../api.ts';
import { acquireBackupRepoLease, type BackupRepoLeaseGuard } from './backup_lease.ts';
import { decodeSnapshotDescriptor } from './delta_format.ts';
import {
  BACKUP_V2_CONFIG_KEY,
  BACKUP_V2_MANIFESTS_PREFIX,
  BACKUP_V2_OBJECTS_PREFIX,
  BACKUP_V2_SNAPSHOTS_PREFIX,
  BackupV2DeviceIndex,
  deviceIndexKey,
} from './delta_upload.ts';
import { normalizeDeviceId } from './device_id.ts';
import { CloudStorageError } from './errors.ts';
import { defaultLogSink } from './logging.ts';
import { chronoAutoSiUtc, parseEpochMillis } from './time.ts';
import { randomUuid } from './random.ts';
import { bytesEqual, compareBytes, utf8Decode, utf8Encode } from './bytes.ts';

/** GC candidate directory; the only namespace GC writes. */
export const BACKUP_V2_GC_CANDIDATES_PREFIX = 'backup-v2/gc/candidates/';
/** Fixed candidate format string. */
export const GC_CANDIDATE_FORMAT = 'backup-v2-gc-candidate';
/** Fixed candidate formatVersion (exactly 2; future versions fail closed). */
export const GC_CANDIDATE_FORMAT_VERSION = 2;
/** Default grace: a candidate is not deletable for at least one hour. */
export const DEFAULT_GC_GRACE_MS = 60 * 60 * 1000;

const MAX_CHRONO_DURATION_MS = Number(9_223_372_036_854_775n);

/** GC parameters shared by collect and sweep. */
export interface GcParams {
  holderDeviceId: string;
  /** Injected "now" (firstSeen for collect; grace/scan-start for sweep). */
  nowMs: number;
  graceMs: number;
  cipher?: FileCipherSession | null;
}

/** One successful collect (zero deletes). */
export interface GcCollectResult {
  scannedIndexes: number;
  scannedVersions: number;
  liveKeys: number;
  unreferencedKeys: string[];
  newCandidateKeys: string[];
  retainedCandidates: number;
}

/** One successful sweep. */
export interface GcSweepResult {
  scannedIndexes: number;
  scannedVersions: number;
  liveKeys: number;
  deletedObjectKeys: string[];
  deletedCandidateKeys: string[];
  droppedCandidateKeys: string[];
  pendingCandidates: number;
}

function validation(message: string): CloudStorageError {
  return new CloudStorageError('Validation', message);
}

function compareUtf8(left: string, right: string): number {
  return compareBytes(utf8Encode(left), utf8Encode(right));
}

function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw validation(`${label} 解析失败: 顶层必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function expectFields(
  object: Record<string, unknown>,
  label: string,
  required: readonly string[],
): void {
  for (const key of Object.keys(object)) {
    if (!required.includes(key)) {
      throw validation(
        `${label} 解析失败: unknown field \`${key}\`, expected one of `
          + required.map(field => `\`${field}\``).join(', '),
      );
    }
  }
  for (const key of required) {
    if (!(key in object)) throw validation(`${label} 解析失败: missing field \`${key}\``);
  }
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw validation(`${field} 必须是字符串`);
  return value;
}

function expectU32(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw validation(`${field} 必须是 u32 整数`);
  }
  return value;
}

function expectU64(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw validation(`${field} 必须是 u64 整数`);
  }
  return value;
}

/** `backup-v2/gc/candidates/<uuid>.json` schema. */
export class GcCandidateV2 {
  format: string;
  formatVersion: number;
  objectKey: string;
  firstSeen: string;
  sweepGeneration: number;

  constructor(fields: {
    format: string;
    formatVersion: number;
    objectKey: string;
    firstSeen: string;
    sweepGeneration: number;
  }) {
    this.format = fields.format;
    this.formatVersion = fields.formatVersion;
    this.objectKey = fields.objectKey;
    this.firstSeen = fields.firstSeen;
    this.sweepGeneration = fields.sweepGeneration;
  }

  validate(): void {
    if (this.format !== GC_CANDIDATE_FORMAT) {
      throw validation(`GC candidate format 必须是 ${GC_CANDIDATE_FORMAT}，实际为 ${this.format}`);
    }
    if (this.formatVersion !== GC_CANDIDATE_FORMAT_VERSION) {
      throw validation(
        `GC candidate formatVersion 必须恰好为 ${GC_CANDIDATE_FORMAT_VERSION}，`
          + `实际为 ${this.formatVersion}；未来版本 fail-closed，不猜测解读`,
      );
    }
    if (!this.objectKey.startsWith(BACKUP_V2_OBJECTS_PREFIX)
      && !this.objectKey.startsWith(BACKUP_V2_SNAPSHOTS_PREFIX)) {
      throw validation(
        `GC candidate objectKey 必须位于 ${BACKUP_V2_OBJECTS_PREFIX} 或 `
          + `${BACKUP_V2_SNAPSHOTS_PREFIX} 下（fail-closed）：${this.objectKey}`,
      );
    }
    if (this.objectKey.includes('\\') || utf8Encode(this.objectKey).includes(0)
      || this.objectKey.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
      throw validation('GC candidate objectKey 含非法路径段（穿越 / 空段 / 反斜杠 / NUL）');
    }
    if (parseEpochMillis(this.firstSeen) === null) {
      throw validation('GC candidate firstSeen 必须是合法 RFC 3339 时间戳');
    }
    if (this.sweepGeneration === 0) {
      throw validation('GC candidate sweepGeneration 必须 ≥ 1（0 视为未初始化，fail-closed）');
    }
  }

  encode(): Uint8Array {
    this.validate();
    try {
      return utf8Encode(JSON.stringify(this, null, 2));
    } catch (error) {
      throw new CloudStorageError('Unknown',
        `GC candidate 序列化失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  static decode(bytes: Uint8Array): GcCandidateV2 {
    let parsed: unknown;
    try {
      parsed = JSON.parse(utf8Decode(bytes));
    } catch (error) {
      throw validation(`GC candidate 解析失败（fail-closed）: ${error instanceof Error ? error.message : String(error)}`);
    }
    const object = expectObject(parsed, 'GC candidate');
    expectFields(object, 'GC candidate', [
      'format', 'formatVersion', 'objectKey', 'firstSeen', 'sweepGeneration',
    ]);
    const candidate = new GcCandidateV2({
      format: expectString(object.format, 'format'),
      formatVersion: expectU32(object.formatVersion, 'formatVersion'),
      objectKey: expectString(object.objectKey, 'objectKey'),
      firstSeen: expectString(object.firstSeen, 'firstSeen'),
      sweepGeneration: expectU64(object.sweepGeneration, 'sweepGeneration'),
    });
    candidate.validate();
    return candidate;
  }

  firstSeenAt(): number {
    const parsed = parseEpochMillis(this.firstSeen);
    if (parsed === null) throw validation('GC candidate firstSeen 非法');
    return parsed;
  }
}

interface LiveScan {
  live: Set<string>;
  indexCount: number;
  versionCount: number;
}

async function decodeStoredDescriptor(
  bytes: Uint8Array,
  cipher: FileCipherSession | null | undefined,
  snapshotKey: string,
): Promise<Uint8Array> {
  if (cipher !== null && cipher !== undefined) {
    if (!isEncryptedBackup(bytes)) {
      throw validation(
        `已配置加密会话，但 snapshot descriptor（${snapshotKey}）不是 DSBK 密文；`
          + '加密策略不一致，本轮 GC 零删除（fail-closed）',
      );
    }
    return cipher.decryptBytes(bytes).catch(error => {
      throw validation(
        `解密 snapshot descriptor（${snapshotKey}）失败（密码错或数据损坏），`
          + `本轮 GC 零删除（fail-closed）：${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
  if (isEncryptedBackup(bytes)) {
    throw validation(
      `snapshot descriptor（${snapshotKey}）是 DSBK 密文，但本次未提供加密会话；`
        + '不得静默改变加密策略，本轮 GC 零删除（fail-closed）',
    );
  }
  return bytes;
}

async function scanLiveSet(
  storage: CloudStorage,
  cipher: FileCipherSession | null | undefined,
): Promise<LiveScan> {
  const listing = await storage.listOutcome(BACKUP_V2_MANIFESTS_PREFIX);
  if (listing.truncated) {
    throw new CloudStorageError('Network',
      'backup-v2 版本索引列表不完整（truncated），无法证明 live set 完备，'
        + '本轮 GC 零删除、零写 candidate（fail-closed）');
  }

  const live = new Set<string>([BACKUP_V2_CONFIG_KEY]);
  let indexCount = 0;
  let versionCount = 0;

  for (const file of listing.files) {
    if (!file.key.startsWith(BACKUP_V2_MANIFESTS_PREFIX)) continue;
    const bytes = await storage.get(file.key);
    if (bytes === null) {
      throw validation(
        `版本索引 ${file.key} 在列举后消失，live set 不可信，本轮 GC 零删除（fail-closed）`,
      );
    }
    const index = BackupV2DeviceIndex.decode(bytes);
    if (deviceIndexKey(index.deviceId) !== file.key) {
      throw validation(
        `版本索引 ${file.key} 的 deviceId（${index.deviceId}）与其 key 不符，本轮 GC 零删除（fail-closed）`,
      );
    }
    indexCount += 1;

    for (const entry of index.versions) {
      live.add(entry.snapshotKey);
      const stored = await storage.get(entry.snapshotKey);
      if (stored === null) {
        throw validation(
          `保留版本 ${entry.id} 的 snapshot descriptor 缺失（${entry.snapshotKey}），`
            + 'live set 不完备，本轮 GC 零删除（fail-closed）',
        );
      }
      if (stored.byteLength !== entry.snapshotSize
        || sha256Hex(stored).toLowerCase() !== entry.snapshotCipherSha256.toLowerCase()) {
        throw validation(
          `保留版本 ${entry.id} 的 snapshot descriptor（${entry.snapshotKey}）与索引登记的大小/哈希不符，`
            + '本轮 GC 零删除（fail-closed）',
        );
      }
      const plaintext = await decodeStoredDescriptor(stored, cipher, entry.snapshotKey);
      const descriptor = decodeSnapshotDescriptor(plaintext);
      if (descriptor.deviceId !== index.deviceId) {
        throw validation(`保留版本 ${entry.id} 的 descriptor deviceId 与索引不符，本轮 GC 零删除（fail-closed）`);
      }
      if (descriptor.versionId !== entry.id) {
        throw validation(`保留版本 ${entry.id} 的 descriptor versionId 不符，本轮 GC 零删除（fail-closed）`);
      }
      versionCount += 1;
      for (const fileRef of descriptor.files) live.add(fileRef.objectKey);
    }
  }

  return { live, indexCount, versionCount };
}

async function listCompleteKeys(storage: CloudStorage, prefix: string): Promise<string[]> {
  const listing = await storage.listOutcome(prefix);
  if (listing.truncated) {
    throw new CloudStorageError('Network',
      `${prefix} 列表不完整（truncated），无法区分「未引用」与「未列出」，`
        + '本轮 GC 零删除、零写 candidate（fail-closed）');
  }
  return listing.files.map(file => file.key).filter(key => key.startsWith(prefix));
}

async function loadAllCandidates(storage: CloudStorage): Promise<Map<string, GcCandidateV2>> {
  const listing = await storage.listOutcome(BACKUP_V2_GC_CANDIDATES_PREFIX);
  if (listing.truncated) {
    throw new CloudStorageError('Network',
      'GC candidate 列表不完整（truncated），本轮 GC 零删除、零写 candidate（fail-closed）');
  }
  const candidates = new Map<string, GcCandidateV2>();
  for (const file of listing.files) {
    if (!file.key.startsWith(BACKUP_V2_GC_CANDIDATES_PREFIX)) continue;
    const bytes = await storage.get(file.key);
    if (bytes === null) {
      throw validation(
        `GC candidate ${file.key} 在列举后消失，登记面不可信，本轮 GC 中止（fail-closed）`,
      );
    }
    candidates.set(file.key, GcCandidateV2.decode(bytes));
  }
  return candidates;
}

function normalizedHolder(holderDeviceId: string): string {
  if (holderDeviceId.trim() === '') {
    throw validation('设备 ID 为空，拒绝执行 backup-v2 GC（fail-closed）');
  }
  const deviceId = normalizeDeviceId(holderDeviceId);
  if (deviceId === '') {
    throw validation('设备 ID 规范化后为空，拒绝执行 backup-v2 GC（fail-closed）');
  }
  return deviceId;
}

async function releaseBestEffort(guard: BackupRepoLeaseGuard): Promise<void> {
  const [result] = await Promise.allSettled([guard.release()]);
  if (result.status === 'rejected') {
    defaultLogSink().warn(
      `[delta-gc] 释放备份仓库租约失败（将由 TTL 兜底）: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
    );
  }
}

/**
 * First pass: register unreferenced keys as candidates. Never deletes anything.
 */
export async function collectGcCandidates(
  storage: CloudStorage,
  params: GcParams,
): Promise<GcCollectResult> {
  const deviceId = normalizedHolder(params.holderDeviceId);
  const guard = await acquireBackupRepoLease(storage, deviceId);
  try {
    return await collectLocked(storage, params);
  } finally {
    await releaseBestEffort(guard);
  }
}

async function collectLocked(storage: CloudStorage, params: GcParams): Promise<GcCollectResult> {
  const scan = await scanLiveSet(storage, params.cipher);
  const dataKeys = [
    ...await listCompleteKeys(storage, BACKUP_V2_OBJECTS_PREFIX),
    ...await listCompleteKeys(storage, BACKUP_V2_SNAPSHOTS_PREFIX),
  ];
  const existing = await loadAllCandidates(storage);
  const alreadyRecorded = new Set([...existing.values()].map(candidate => candidate.objectKey));
  const maxGeneration = [...existing.values()].reduce(
    (max, candidate) => Math.max(max, candidate.sweepGeneration), 0,
  );
  if (maxGeneration >= Number.MAX_SAFE_INTEGER) {
    throw validation('GC sweepGeneration 溢出 u64，拒绝执行');
  }
  const generation = maxGeneration + 1;

  const unreferencedKeys = [...new Set(dataKeys.filter(key => !scan.live.has(key)))];
  unreferencedKeys.sort(compareUtf8);

  const newCandidateKeys: string[] = [];
  let retainedCandidates = 0;
  for (const key of unreferencedKeys) {
    if (alreadyRecorded.has(key)) {
      retainedCandidates += 1;
      continue;
    }
    const candidate = new GcCandidateV2({
      format: GC_CANDIDATE_FORMAT,
      formatVersion: GC_CANDIDATE_FORMAT_VERSION,
      objectKey: key,
      firstSeen: chronoAutoSiUtc(params.nowMs),
      sweepGeneration: generation,
    });
    const encoded = candidate.encode();
    const candidateKey = `${BACKUP_V2_GC_CANDIDATES_PREFIX}${randomUuid()}.json`;
    if (await storage.exists(candidateKey)) {
      throw new CloudStorageError('Unknown',
        '随机 GC candidate key 已存在，存储行为异常，fail-closed');
    }
    await storage.put(candidateKey, encoded);
    const readback = await storage.get(candidateKey);
    if (readback === null) {
      throw new CloudStorageError('Network',
        `GC candidate ${candidateKey} 写入后回读缺失（fail-closed）`);
    }
    if (!bytesEqual(readback, encoded)) {
      throw new CloudStorageError('Network',
        `GC candidate ${candidateKey} 回读字节与本地不符（fail-closed）`);
    }
    newCandidateKeys.push(candidateKey);
  }

  return {
    scannedIndexes: scan.indexCount,
    scannedVersions: scan.versionCount,
    liveKeys: scan.live.size,
    unreferencedKeys,
    newCandidateKeys,
    retainedCandidates,
  };
}

/**
 * Second pass: independent full scan, then delete grace-expired candidates whose
 * keys are still unreferenced. Must be a separate call from collect.
 */
export async function sweepGcCandidates(
  storage: CloudStorage,
  params: GcParams,
): Promise<GcSweepResult> {
  const deviceId = normalizedHolder(params.holderDeviceId);
  const guard = await acquireBackupRepoLease(storage, deviceId);
  try {
    return await sweepLocked(storage, params);
  } finally {
    await releaseBestEffort(guard);
  }
}

async function sweepLocked(storage: CloudStorage, params: GcParams): Promise<GcSweepResult> {
  if (!Number.isFinite(params.graceMs) || params.graceMs < 0 || params.graceMs > MAX_CHRONO_DURATION_MS) {
    throw validation('GC grace 超出可表示范围，拒绝执行');
  }
  const scanStartedAt = params.nowMs;

  const scan = await scanLiveSet(storage, params.cipher);
  const candidates = await loadAllCandidates(storage);

  const deletedObjectKeys: string[] = [];
  const deletedCandidateKeys: string[] = [];
  const droppedCandidateKeys: string[] = [];
  let pendingCandidates = 0;

  const orderedKeys = [...candidates.keys()].sort(compareUtf8);
  for (const candidateKey of orderedKeys) {
    const candidate = candidates.get(candidateKey)!;
    if (scan.live.has(candidate.objectKey)) {
      await storage.delete(candidateKey);
      droppedCandidateKeys.push(candidateKey);
      continue;
    }
    const firstSeen = candidate.firstSeenAt();
    const graceElapsed = firstSeen + params.graceMs <= params.nowMs;
    if (!graceElapsed || firstSeen > scanStartedAt) {
      pendingCandidates += 1;
      continue;
    }
    // Delete the object first, then the candidate: a crash in between leaves a
    // candidate pointing at a deleted object (idempotent next round), never a
    // visible version missing an object.
    if (await storage.exists(candidate.objectKey)) {
      await storage.delete(candidate.objectKey);
    }
    deletedObjectKeys.push(candidate.objectKey);
    await storage.delete(candidateKey);
    deletedCandidateKeys.push(candidateKey);
  }

  return {
    scannedIndexes: scan.indexCount,
    scannedVersions: scan.versionCount,
    liveKeys: scan.live.size,
    deletedObjectKeys,
    deletedCandidateKeys,
    droppedCandidateKeys,
    pendingCandidates,
  };
}
