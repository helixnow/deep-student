/**
 * Cloud sync manager (sync_manager.rs): per-device manifests, version upload/download,
 * E2EE marker policy and verified publication.
 *
 * Wire types come from the generated contract; `CloudManifest` is backend-only.
 */

import { sha256Hasher } from './hashing.ts';
import { join } from '../../../platform/util/path.ts';
import type { BackupCrypto, EncryptedRootMemoryStore } from '../../../platform/secrets/api.ts';
import type { BackupVersion, CloudStorage, DownloadResult, FileInfo, SyncStatus, UploadResult } from '../api.ts';
import { convergeBadObject, type BadObjectOutcome } from './bad_object.ts';
import {
  decodeManifest,
  emptyManifest,
  encodeManifest,
  generateNeutralVersionId,
  mergeManifest,
  timestampNanos,
  toWireVersion,
  validateManifest,
  validateVersionId,
  type CloudManifest,
  type ManifestVersion,
} from './manifest.ts';
import { deviceIdShortHash, normalizeDeviceId } from './device_id.ts';
import {
  DEFAULT_E2EE_CLAIM_LEASE_TTL_MS,
  MAX_E2EE_CLAIM_OBJECT_BYTES,
  SYNC_E2EE_CLAIM_CONFLICT_CODE,
  claimEncryptionMarker,
  ensureNoPendingClaims,
  type ClaimExpectation,
} from './e2ee_claim.ts';
import { bytesEqual, utf8Encode } from './bytes.ts';
import { CloudStorageError, ioError } from './errors.ts';
import { fs } from './local-fs.ts';
import { defaultLogSink } from './logging.ts';
import { decodeEncryptionMarker, encodeEncryptionMarker, type EncryptionMarker } from './marker.ts';
import { provePasswordAgainstExistingBackups } from './password_proof.ts';
import {
  SYNC_E2EE_MARKER_CORRUPTED_CODE,
  SYNC_E2EE_MEMORY_PERSIST_FAILED_CODE,
  SYNC_E2EE_PASSWORD_REQUIRED_CODE,
  SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE,
  SYNC_E2EE_WRONG_PASSWORD_CODE,
  syncE2eeError,
} from './mod.ts';
import { BoundedMemoryBody } from './traits.ts';
import { unconditionalSpec, verifiedPublish } from './verified_publish.ts';
import { chronoAutoSiZ } from './time.ts';

export const MANIFEST_FILE = 'manifest.json';
export const MANIFEST_BACKUP_FILE = 'manifest.json.bak';
export const MANIFESTS_DIR = 'manifests';
export const BACKUPS_DIR = 'backups';
export const DEFAULT_MAX_VERSIONS = 10;
export const ENCRYPTION_MARKER_FILE = '.encryption-marker';
export const ENCRYPTION_MARKER_VERSION_WITH_VERIFIER = 2;
export const MANIFEST_OBJECT_MAX_BYTES = 4 * 1024 * 1024;
const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface EncryptionMemoryPersistFailure {
  code: string;
  at: string;
}

let lastMemoryPersistFailure: EncryptionMemoryPersistFailure | null = null;

function recordEncryptionMemoryPersistFailure(): void {
  lastMemoryPersistFailure = { code: SYNC_E2EE_MEMORY_PERSIST_FAILED_CODE, at: chronoAutoSiZ(Date.now()) };
}

function clearEncryptionMemoryPersistFailure(): void {
  lastMemoryPersistFailure = null;
}

export function lastEncryptionMemoryPersistFailure(): EncryptionMemoryPersistFailure | null {
  return lastMemoryPersistFailure;
}

async function boundedGetObject(storage: CloudStorage, key: string, maxBytes: number, kind: string): Promise<Uint8Array | null> {
  const info = await storage.stat(key);
  if (info !== null && info.size > maxBytes) {
    throw new CloudStorageError('Validation',
      `${kind} 对象 ${key} 声明 ${info.size} 字节，超过 ${maxBytes} 字节预算，已拒绝读取（fail-closed）`);
  }
  const data = await storage.get(key);
  if (data === null) return null;
  if (data.byteLength > maxBytes) {
    throw new CloudStorageError('Validation',
      `${kind} 对象 ${key} 实收 ${data.byteLength} 字节，超过 ${maxBytes} 字节预算，已拒绝读取（fail-closed）`);
  }
  return data;
}

async function hashFileSha256(path: string): Promise<string> {
  const handle = await fs.open(path, 'r').catch(error => {
    throw new CloudStorageError('FileSystem', `打开下载文件做校验失败: ${ioError(error)}`);
  });
  const hasher = sha256Hasher();
  try {
    const buffer = new Uint8Array(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      hasher.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hasher.digestHex();
}

async function lstatSize(path: string): Promise<{ size: number; isFile: boolean; isSymlink: boolean } | null> {
  try {
    const info = await fs.lstat(path);
    return { size: info.size, isFile: info.isFile(), isSymlink: info.isSymbolicLink() };
  } catch { return null; }
}

export interface CloudSyncManagerOptions {
  /** `ctx.secrets.backup` (F4). */
  backup: BackupCrypto;
  /** `<app_data_dir>/.cloud-encrypted-roots.json`; null = memory unavailable. */
  encryptionMemoryPath?: string | null;
  maxVersions?: number;
  e2eeClaimLeaseTtlMs?: number;
}

export class CloudSyncManager {
  readonly storage: CloudStorage;
  readonly deviceId: string;
  private readonly maxVersions: number;
  private readonly backup: BackupCrypto;
  private readonly encryptionMemory: EncryptedRootMemoryStore | null;
  private readonly leaseTtlMs: number;
  private publishMarkerExpectation: Uint8Array | null = null;

  constructor(storage: CloudStorage, deviceId: string, options: CloudSyncManagerOptions) {
    this.storage = storage;
    this.deviceId = normalizeDeviceId(deviceId);
    this.maxVersions = Math.max(options.maxVersions ?? DEFAULT_MAX_VERSIONS, 1);
    this.backup = options.backup;
    this.encryptionMemory = options.encryptionMemoryPath
      ? options.backup.encryptedRootMemory(options.encryptionMemoryPath)
      : null;
    this.leaseTtlMs = options.e2eeClaimLeaseTtlMs ?? DEFAULT_E2EE_CLAIM_LEASE_TTL_MS;
  }

  /** sync_manager.rs:355: memory failures never block; they surface via status. */
  private async rememberEncryptedRoot(): Promise<void> {
    if (this.encryptionMemory === null) return;
    const fingerprint = this.backup.encryptedRootFingerprint(this.storage.instanceBindingHint());
    try {
      await this.encryptionMemory.remember(fingerprint);
      clearEncryptionMemoryPersistFailure();
    } catch (error) {
      defaultLogSink().warn(`登记本机加密目录记忆失败（不阻断本次操作）: ${errorMessage(error)}`);
      recordEncryptionMemoryPersistFailure();
    }
  }

  /** [R6 双门] second gate when the cloud marker has been deleted. */
  async encryptedRootRememberedLocally(): Promise<boolean> {
    if (this.encryptionMemory === null) return false;
    const fingerprint = this.backup.encryptedRootFingerprint(this.storage.instanceBindingHint());
    return this.encryptionMemory.wasEncrypted(fingerprint);
  }

  private deviceManifestKey(): string {
    return `${MANIFESTS_DIR}/${deviceIdShortHash(this.deviceId)}.json`;
  }

  private deviceManifestLegacyKey(): string {
    return `${MANIFESTS_DIR}/${this.deviceId}.json`;
  }

  private async loadOwnDeviceManifests(): Promise<[CloudManifest | null, CloudManifest | null]> {
    const newKey = this.deviceManifestKey();
    const legacyKey = this.deviceManifestLegacyKey();
    const current = await this.readManifestKey(newKey);
    const legacy = newKey === legacyKey ? null : await this.readManifestKey(legacyKey);
    return [current, legacy];
  }

  /** sync_manager.rs:502: bounded read; corrupt objects go through the recovery protocol. */
  private async readManifestKey(key: string): Promise<CloudManifest | null> {
    const data = await boundedGetObject(this.storage, key, MANIFEST_OBJECT_MAX_BYTES, 'manifest');
    if (data === null) return null;
    try {
      return decodeManifest(key, data);
    } catch (corruptError) {
      return this.recoverManifestFromTmp(key, corruptError as CloudStorageError);
    }
  }

  private async recoverManifestFromTmp(key: string, corruptError: CloudStorageError): Promise<CloudManifest> {
    const validate = (bytes: Uint8Array): string | null => {
      try { decodeManifest(key, bytes); return null; }
      catch (error) { return error instanceof Error ? error.message : String(error); }
    };
    let outcome: BadObjectOutcome;
    try {
      outcome = await convergeBadObject(this.storage, this.deviceId, key, validate);
    } catch (convergeError) {
      const residue = await this.recoverFromPublishTmpResidue(key);
      if (residue !== null) return residue;
      throw convergeError;
    }
    switch (outcome.kind) {
      case 'RecoveredFromTmp':
        defaultLogSink().warn(
          `manifest ${key} 正式对象损坏（${corruptError.message}），已用已校验恢复点 ${outcome.tmpKey} 自动收敛`
          + `（坏字节隔离记录: ${outcome.quarantine?.quarantinedKey ?? null}）`,
        );
        return this.rereadConvergedManifest(key, corruptError);
      case 'AlreadyHealthy':
        return this.rereadConvergedManifest(key, corruptError);
      case 'Absent':
        throw corruptError;
    }
  }

  private async rereadConvergedManifest(key: string, corruptError: CloudStorageError): Promise<CloudManifest> {
    const data = await boundedGetObject(this.storage, key, MANIFEST_OBJECT_MAX_BYTES, 'manifest').catch(() => null);
    if (data === null) throw corruptError;
    try { return decodeManifest(key, data); }
    catch { throw corruptError; }
  }

  /** Naming bridge for `.tmp-<op>` residue left by verified_publish. */
  private async recoverFromPublishTmpResidue(key: string): Promise<CloudManifest | null> {
    let candidates: FileInfo[];
    try { candidates = await this.storage.list(`${key}.tmp-`); }
    catch (error) {
      defaultLogSink().warn(`枚举 manifest ${key} 的 .tmp-* 发布残留失败（维持 fail-closed）: ${errorMessage(error)}`);
      return null;
    }
    for (const candidate of candidates) {
      let data: Uint8Array | null;
      try { data = await boundedGetObject(this.storage, candidate.key, MANIFEST_OBJECT_MAX_BYTES, 'manifest'); }
      catch (error) {
        defaultLogSink().warn(`读取 manifest 恢复点 ${candidate.key} 失败，尝试下一个候选: ${errorMessage(error)}`);
        continue;
      }
      if (data === null) continue;
      let recovered: CloudManifest;
      try { recovered = decodeManifest(candidate.key, data); }
      catch (error) {
        defaultLogSink().warn(`manifest 恢复点 ${candidate.key} 未通过校验，跳过并保留（供审计）: ${errorMessage(error)}`);
        continue;
      }
      defaultLogSink().warn(
        `manifest ${key} 正式对象损坏，已改用 verified-publish 残留恢复点 ${candidate.key}（自动收敛中）`,
      );
      try {
        await verifiedPublish(this.storage, unconditionalSpec(key, MANIFEST_OBJECT_MAX_BYTES, 'KeepTmp'), data);
        try { await this.storage.delete(candidate.key); }
        catch (error) {
          defaultLogSink().warn(`自动收敛成功后清理已消费恢复点 ${candidate.key} 失败（无害孤儿）: ${errorMessage(error)}`);
        }
      } catch (error) {
        // Convergence is best-effort: the verified recovery content is still
        // returned for this read, and the next save retries the publication.
        defaultLogSink().warn(`manifest ${key} 自动收敛失败（本次读取仍用已校验恢复内容）: ${errorMessage(error)}`);
        return recovered;
      }
      return recovered;
    }
    return null;
  }

  async getManifest(): Promise<CloudManifest> {
    const merged = emptyManifest();
    let found = false;

    const listing = await this.storage.listOutcome(`${MANIFESTS_DIR}/`);
    if (listing.truncated) {
      throw new CloudStorageError('Unknown', '云端备份 manifest 列表被截断，无法安全合并版本列表');
    }
    for (const file of listing.files) {
      if (!file.key.endsWith('.json')) continue;
      const manifest = await this.readManifestKey(file.key);
      if (manifest === null) continue;
      mergeManifest(merged, manifest);
      found = true;
    }

    let legacy: CloudManifest | null = null;
    let primaryError: CloudStorageError | null = null;
    try { legacy = await this.readManifestKey(MANIFEST_FILE); }
    catch (error) {
      primaryError = error as CloudStorageError;
      defaultLogSink().warn(`主 manifest 解析失败，尝试备份: ${errorMessage(error)}`);
    }
    if (legacy !== null) {
      mergeManifest(merged, legacy);
      found = true;
    } else if (primaryError !== null) {
      const backup = await this.readManifestKey(MANIFEST_BACKUP_FILE);
      if (backup === null) throw primaryError;
      mergeManifest(merged, backup);
      found = true;
    }

    return found ? merged : emptyManifest();
  }

  private async getDeviceManifest(): Promise<CloudManifest> {
    const [current, legacy] = await this.loadOwnDeviceManifests();
    if (current !== null && legacy !== null) { mergeManifest(current, legacy); return current; }
    return current ?? legacy ?? emptyManifest();
  }

  private async saveManifest(manifest: CloudManifest): Promise<void> {
    const newKey = this.deviceManifestKey();
    await this.saveManifestAtKey(newKey, manifest);
    const legacyKey = this.deviceManifestLegacyKey();
    if (legacyKey !== newKey) {
      let info: FileInfo | null;
      try { info = await this.storage.stat(legacyKey); }
      catch (error) {
        defaultLogSink().warn(`迁移设备 manifest 时探测旧对象 ${legacyKey} 失败: ${errorMessage(error)}`);
        return;
      }
      if (info !== null) {
        try { await this.storage.delete(legacyKey); }
        catch (error) {
          defaultLogSink().warn(`迁移设备 manifest 后删除旧对象 ${legacyKey} 失败（新清单已发布）: ${errorMessage(error)}`);
        }
      }
    }
  }

  private async saveManifestAtKey(key: string, manifest: CloudManifest): Promise<void> {
    validateManifest(key, manifest);
    const data = utf8Encode(encodeManifest(manifest));
    await verifiedPublish(this.storage, unconditionalSpec(key, MANIFEST_OBJECT_MAX_BYTES, 'KeepTmp'), data);
  }

  /** [R4-bad-write] Converge a broken own-device manifest. */
  async recoverDeviceManifestBadWrite(): Promise<BadObjectOutcome> {
    const key = this.deviceManifestKey();
    return convergeBadObject(this.storage, this.deviceId, key, bytes => {
      try { decodeManifest(key, bytes); return null; }
      catch (error) { return error instanceof Error ? error.message : String(error); }
    });
  }

  async getStatus(): Promise<SyncStatus> {
    const failure = lastEncryptionMemoryPersistFailure();
    try {
      await this.storage.checkConnection();
    } catch (error) {
      return {
        connected: false, cloudVersionCount: 0,
        ...(failure === null ? {} : { encryptionMemoryPersistFailure: failure }),
        error: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      const manifest = await this.getManifest();
      const deviceLastSync = await this.deviceLastSyncTime();
      const latest = manifest.latest == null
        ? null
        : manifest.versions.find(version => version.id === manifest.latest) ?? null;
      return {
        connected: true,
        cloudVersionCount: manifest.versions.length,
        ...(latest === null ? {} : { latestVersion: toWireVersion(latest) }),
        ...(deviceLastSync === null ? {} : { lastSyncTime: deviceLastSync }),
        ...(failure === null ? {} : { encryptionMemoryPersistFailure: failure }),
      };
    } catch (error) {
      return {
        connected: true, cloudVersionCount: 0,
        ...(failure === null ? {} : { encryptionMemoryPersistFailure: failure }),
        error: `读取 manifest 失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async deviceLastSyncTime(): Promise<string | null> {
    try {
      const [current, legacy] = await this.loadOwnDeviceManifests();
      if (current !== null && legacy !== null) {
        return timestampNanos(current.updatedAt) >= timestampNanos(legacy.updatedAt)
          ? current.updatedAt
          : legacy.updatedAt;
      }
      return current?.updatedAt ?? legacy?.updatedAt ?? null;
    } catch { return null; }
  }

  async listVersions(): Promise<BackupVersion[]> {
    return (await this.getManifest()).versions.map(toWireVersion);
  }

  private async readEncryptionMarkerStateWithRaw(): Promise<{ state: 'Absent' | 'Present' | 'Corrupted'; marker: EncryptionMarker | null; raw: Uint8Array | null }> {
    const info = await this.storage.stat(ENCRYPTION_MARKER_FILE);
    if (info !== null && info.size > MAX_E2EE_CLAIM_OBJECT_BYTES) {
      defaultLogSink().warn(
        `云端加密标记 ${ENCRYPTION_MARKER_FILE} 为 ${info.size} 字节，超过 ${MAX_E2EE_CLAIM_OBJECT_BYTES} 字节上限，拒绝下载并按损坏处理`,
      );
      return { state: 'Corrupted', marker: null, raw: null };
    }
    const data = await this.storage.get(ENCRYPTION_MARKER_FILE);
    if (data === null) return { state: 'Absent', marker: null, raw: null };
    try {
      return { state: 'Present', marker: decodeEncryptionMarker(data), raw: data };
    } catch (error) {
      defaultLogSink().warn(`云端加密标记 ${ENCRYPTION_MARKER_FILE} 内容无法解析，按存在处理: ${errorMessage(error)}`);
      return { state: 'Corrupted', marker: null, raw: data };
    }
  }

  /** Corrupt markers count as present (fail-closed). */
  async readEncryptionMarker(): Promise<EncryptionMarker | null> {
    const { state, marker } = await this.readEncryptionMarkerStateWithRaw();
    if (state === 'Absent') return null;
    if (state === 'Present') return marker;
    return { version: 0, createdByDevice: 'unknown', createdAt: chronoAutoSiZ(Date.now()), keyVerifier: null };
  }

  private recordPublishMarkerExpectation(raw: Uint8Array): void {
    this.publishMarkerExpectation = raw;
  }

  private async ensureMarkerUnchangedBeforePublish(): Promise<void> {
    const expected = this.publishMarkerExpectation;
    if (expected === null) return;
    const { raw } = await this.readEncryptionMarkerStateWithRaw();
    if (raw !== null && bytesEqual(raw, expected)) return;
    throw new CloudStorageError('Conflict', syncE2eeError(SYNC_E2EE_CLAIM_CONFLICT_CODE,
      '发布备份前复验发现云端加密标记已与上传前校验时不一致（认领竞态或标记被并发改动），'
      + '已回滚本次上传、未发布任何版本。请重试上传以重新校验加密密码。'));
  }

  private async claimMarkerWithPassword(password: string, expectation: ClaimExpectation): Promise<EncryptionMarker> {
    const device = deviceIdShortHash(this.deviceId);
    const published = await claimEncryptionMarker(this.storage, {
      markerKey: ENCRYPTION_MARKER_FILE,
      deviceIdShort: device,
      ttlMs: this.leaseTtlMs,
      expectation,
      buildMarker: async snapshot => {
        const verifier = await this.backup.createPasswordVerifier(password);
        const marker: EncryptionMarker = snapshot === null
          ? { version: ENCRYPTION_MARKER_VERSION_WITH_VERIFIER, createdByDevice: device, createdAt: chronoAutoSiZ(Date.now()), keyVerifier: verifier }
          : { version: ENCRYPTION_MARKER_VERSION_WITH_VERIFIER, createdByDevice: snapshot.createdByDevice, createdAt: snapshot.createdAt, keyVerifier: verifier };
        return encodeEncryptionMarker(marker);
      },
    });
    this.recordPublishMarkerExpectation(published);
    return decodeEncryptionMarker(published);
  }

  /** Idempotent v1 marker write, for callers without the password plaintext. */
  async persistEncryptionMarker(): Promise<EncryptionMarker> {
    await ensureNoPendingClaims(this.storage, ENCRYPTION_MARKER_FILE);
    const { state, marker, raw } = await this.readEncryptionMarkerStateWithRaw();
    if (state === 'Present') {
      if (raw !== null) this.recordPublishMarkerExpectation(raw);
      return marker!;
    }
    if (state === 'Corrupted') {
      if (raw !== null) this.recordPublishMarkerExpectation(raw);
      return { version: 0, createdByDevice: 'unknown', createdAt: chronoAutoSiZ(Date.now()), keyVerifier: null };
    }
    const device = deviceIdShortHash(this.deviceId);
    const published = await claimEncryptionMarker(this.storage, {
      markerKey: ENCRYPTION_MARKER_FILE,
      deviceIdShort: device,
      ttlMs: this.leaseTtlMs,
      expectation: 'Absent',
      buildMarker: () => encodeEncryptionMarker({
        version: 1, createdByDevice: device, createdAt: chronoAutoSiZ(Date.now()), keyVerifier: null,
      }),
    });
    this.recordPublishMarkerExpectation(published);
    return decodeEncryptionMarker(published);
  }

  /** [R06-e2ee-verifier] Validate (or register/upgrade) the marker's password verifier. */
  async verifyEncryptionPasswordBeforeUpload(password: string): Promise<EncryptionMarker> {
    await ensureNoPendingClaims(this.storage, ENCRYPTION_MARKER_FILE);
    const { state, marker, raw } = await this.readEncryptionMarkerStateWithRaw();

    if (state === 'Absent') {
      await this.provePasswordAgainstExistingBackups(password, true);
      return this.claimMarkerWithPassword(password, 'Absent');
    }
    if (state === 'Corrupted') {
      throw new CloudStorageError('Configuration', syncE2eeError(SYNC_E2EE_MARKER_CORRUPTED_CODE,
        '云端加密标记（.encryption-marker）内容已损坏，无法确认加密密码与既有备份一致，'
        + '已在上传前中止（fail-closed）。请人工检查该云端目录后重试。'));
    }
    const current: EncryptionMarker = marker!;

    if (current.keyVerifier != null) {
      let matches: boolean;
      try { matches = await this.backup.checkPasswordVerifier(password, current.keyVerifier); }
      catch (error) {
        throw new CloudStorageError('Configuration', syncE2eeError(SYNC_E2EE_MARKER_CORRUPTED_CODE,
          `无法校验云端加密标记的密码校验子（fail-closed，已在上传前中止）：${error instanceof Error ? error.message : String(error)}。`
          + '该标记可能由更新版本的应用写入，请先升级本机应用。'));
      }
      if (!matches) {
        throw new CloudStorageError('Configuration', syncE2eeError(SYNC_E2EE_WRONG_PASSWORD_CODE,
          '加密密码与该云端目录既有加密备份使用的密码不一致，已在上传前中止，未写入任何备份对象。'
          + '请核对加密密码后重试，或改用新的云端目录。'));
      }
      if (raw !== null) this.recordPublishMarkerExpectation(raw);
      return current;
    }

    if ((current.version ?? 0) <= 1) {
      await this.provePasswordAgainstExistingBackups(password, false);
      defaultLogSink().warn(
        `云端加密标记为旧版（无密码校验子），将经认领协议一次性升级到 v${ENCRYPTION_MARKER_VERSION_WITH_VERIFIER}`,
      );
      return this.claimMarkerWithPassword(password, 'LegacyV1');
    }

    throw new CloudStorageError('Configuration', syncE2eeError(SYNC_E2EE_MARKER_CORRUPTED_CODE,
      `云端加密标记版本为 ${current.version} 却缺少密码校验子，疑似损坏或被篡改，已在上传前中止（fail-closed）。`
      + '请人工检查该云端目录后重试。'));
  }

  /** [R12-v1-trust] Prove the password against the newest (then second newest) backup. */
  async provePasswordAgainstExistingBackups(password: string, allowPlaintextZip: boolean): Promise<void> {
    await provePasswordAgainstExistingBackups({
      storage: this.storage,
      backup: this.backup,
      backupObjectKey: versionId => `${BACKUPS_DIR}/${versionId}.zip`,
      getManifest: () => this.getManifest(),
      downloadVersion: (versionId, localDir) => this.downloadWithProgress(versionId, localDir, null),
    }, password, allowPlaintextZip);
  }

  /** Reject plaintext uploads once this root has ever been encrypted. */
  async ensurePlaintextUploadAllowed(): Promise<void> {
    if (await this.readEncryptionMarker() !== null) {
      await this.rememberEncryptedRoot();
      throw new CloudStorageError('Configuration', syncE2eeError(SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE,
        '该云端目录已存在端到端加密备份，为避免明文/密文混布，已拒绝未加密上传。'
        + '请在云存储配置里填写相同的加密密码后重试。'));
    }
    if (await this.encryptedRootRememberedLocally()) {
      throw new CloudStorageError('Configuration', syncE2eeError(SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE,
        '本机记录显示该云端目录曾启用端到端加密，但云端的加密标记现已缺失（可能被删除）。'
        + '为避免向同一目录混入未加密备份，已拒绝本次上传。请在云存储配置里填写原加密密码后重试；'
        + '若确认要改用未加密备份，请换一个新的云端目录。'));
    }
  }

  async enforceEncryptionPolicyBeforeUpload(encryptionEnabled: boolean): Promise<void> {
    if (encryptionEnabled) {
      await this.persistEncryptionMarker();
      await this.rememberEncryptedRoot();
      return;
    }
    await this.ensurePlaintextUploadAllowed();
  }

  async enforceEncryptionPolicyBeforeUploadWithPassword(encryptionPassword: string | null | undefined): Promise<void> {
    if (encryptionPassword != null && encryptionPassword !== '') {
      await this.verifyEncryptionPasswordBeforeUpload(encryptionPassword);
      await this.rememberEncryptedRoot();
      return;
    }
    await this.ensurePlaintextUploadAllowed();
  }

  async upload(zipPath: string, appVersion?: string | null, note?: string | null, recoveryKind?: string | null): Promise<UploadResult> {
    return this.uploadWithProgress(zipPath, appVersion, note, recoveryKind, null);
  }

  async uploadWithProgress(
    zipPath: string,
    appVersion: string | null | undefined,
    note: string | null | undefined,
    recoveryKind: string | null | undefined,
    progress: ((done: number, total: number) => void) | null,
  ): Promise<UploadResult> {
    let fileSize: number;
    try { fileSize = (await fs.stat(zipPath)).size; }
    catch (error) { throw new CloudStorageError('Unknown', `读取文件元信息失败: ${ioError(error)}`); }

    if (fileSize > MAX_FILE_SIZE) {
      throw new CloudStorageError('Validation',
        `备份文件过大（${(fileSize / 1024 / 1024 / 1024).toFixed(2)} GB），最大支持 10 GB`);
    }
    defaultLogSink().info(`开始上传备份文件: ${zipPath} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);

    const now = new Date();
    const versionId = generateNeutralVersionId();
    validateVersionId(versionId);
    const remoteKey = `${BACKUPS_DIR}/${versionId}.zip`;

    const checksum = await this.storage.putFile(remoteKey, zipPath, progress);
    if (checksum.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(checksum)) {
      await this.storage.delete(remoteKey).catch(() => undefined);
      throw new CloudStorageError('Unknown', '云存储 provider 返回了非法 SHA256，已拒绝发布版本');
    }

    const info = await this.storage.stat(remoteKey);
    if (info === null) {
      await this.storage.delete(remoteKey).catch(() => undefined);
      throw new CloudStorageError('Unknown', '云端备份对象上传后不存在，已停止并不得报成功');
    }
    if (info.size !== fileSize) {
      await this.storage.delete(remoteKey).catch(() => undefined);
      throw new CloudStorageError('Unknown',
        `云端备份对象上传后大小不一致：本地 ${fileSize} 字节，远端 ${info.size} 字节，已停止并不得报成功`);
    }
    defaultLogSink().info(`上传完成: version=${versionId}, checksum=${checksum.slice(0, 16)}`);

    const version: ManifestVersion = {
      id: versionId,
      timestamp: chronoAutoSiZ(now.getTime()),
      size: BigInt(fileSize),
      checksum,
      deviceId: this.deviceId,
      ...(appVersion == null ? {} : { appVersion }),
      ...(note == null ? {} : { note }),
      ...(recoveryKind == null ? {} : { recoveryKind }),
    };

    let manifest: CloudManifest;
    try { manifest = await this.getDeviceManifest(); }
    catch (error) {
      try { await this.storage.delete(remoteKey); }
      catch (cleanupError) {
        defaultLogSink().warn(`读取设备 manifest 失败后清理未引用对象 ${remoteKey} 失败: ${errorMessage(cleanupError)}`);
      }
      throw error;
    }
    manifest.versions.unshift(version);
    manifest.latest = versionId;
    manifest.updatedAt = version.timestamp;

    // Publish the manifest that no longer references pruned objects before GC.
    const pruned = this.pruneVersions(manifest);
    try { await this.ensureMarkerUnchangedBeforePublish(); }
    catch (error) {
      try { await this.storage.delete(remoteKey); }
      catch (cleanupError) {
        defaultLogSink().warn(`加密标记复验失败后清理未引用对象 ${remoteKey} 失败: ${errorMessage(cleanupError)}`);
      }
      throw error;
    }
    try { await this.saveManifest(manifest); }
    catch (error) {
      try { await this.storage.delete(remoteKey); }
      catch (cleanupError) {
        defaultLogSink().warn(`manifest 发布失败后清理未引用对象 ${remoteKey} 失败: ${errorMessage(cleanupError)}`);
      }
      throw error;
    }
    for (const old of pruned) {
      try { await this.storage.delete(`${BACKUPS_DIR}/${old.id}.zip`); }
      catch (error) {
        defaultLogSink().warn(`清理已裁剪云端对象 ${old.id} 失败: ${errorMessage(error)}`);
      }
    }

    return { version: toWireVersion(version), prunedVersions: pruned.map(old => old.id) };
  }

  async download(versionId: string | null | undefined, localDir: string): Promise<DownloadResult> {
    return this.downloadWithProgress(versionId, localDir, null);
  }

  async downloadWithProgress(
    versionId: string | null | undefined,
    localDir: string,
    progress: ((done: number, total: number) => void) | null,
  ): Promise<DownloadResult> {
    if (versionId != null) validateVersionId(versionId);
    const manifest = await this.getManifest();

    const version = versionId != null
      ? manifest.versions.find(candidate => candidate.id === versionId)
      : (manifest.latest == null ? undefined : manifest.versions.find(candidate => candidate.id === manifest.latest));
    if (version === undefined) throw new CloudStorageError('NotFound', '未找到指定版本');
    validateVersionId(version.id);
    // u64 stays exact through the resume comparison; only the log display
    // converts it.
    const size = version.size;
    defaultLogSink().info(`开始下载备份文件: version=${version.id}, size=${(Number(size) / 1024 / 1024).toFixed(2)} MB`);

    await fs.mkdir(localDir, { recursive: true }).catch(error => {
      throw new CloudStorageError('Unknown', `创建目录失败: ${ioError(error)}`);
    });

    const localPath = join(localDir, `${version.id}.zip`);
    const remoteKey = `${BACKUPS_DIR}/${version.id}.zip`;

    if (this.storage.supportsResumableDownload()) {
      const partialPath = join(localDir, `.${version.id}.zip.part`);
      const partial = await lstatSize(partialPath);
      let resumeFrom = 0;
      if (partial !== null && !partial.isSymlink && partial.isFile && partial.size > 0 && BigInt(partial.size) <= size) {
        resumeFrom = partial.size;
        defaultLogSink().info(`发现可续传断点: ${partialPath}（${partial.size}/${size.toString()} 字节）`);
      } else if (partial !== null) {
        await fs.rm(partialPath, { force: true }).catch(() => undefined);
      }

      await this.storage.getFileResumable(remoteKey, partialPath, resumeFrom, progress);

      const actualChecksum = await hashFileSha256(partialPath);
      if (actualChecksum !== version.checksum) {
        await fs.rm(partialPath, { force: true }).catch(() => undefined);
        throw new CloudStorageError('Validation',
          `下载完成但 SHA256 校验失败（期望 ${version.checksum.slice(0, 16)}，实际 ${actualChecksum.slice(0, 16)}）。`
          + '断点文件已丢弃，请重试整包下载');
      }
      await fs.rename(partialPath, localPath).catch(error => {
        throw new CloudStorageError('FileSystem', `保存下载文件失败: ${ioError(error)}`);
      });
      defaultLogSink().info(
        `下载完成（断点续传路径, resume_from=${resumeFrom}）: version=${version.id}, checksum=${actualChecksum.slice(0, 16)}`,
      );
    } else {
      const actualChecksum = await this.storage.getFile(remoteKey, localPath, version.checksum, progress);
      defaultLogSink().info(`下载完成: version=${version.id}, checksum=${actualChecksum.slice(0, 16)}`);
    }

    return { version: toWireVersion(version), localPath };
  }

  async deleteVersion(versionId: string): Promise<void> {
    validateVersionId(versionId);
    const manifest = await this.getDeviceManifest();
    const index = manifest.versions.findIndex(version => version.id === versionId);
    if (index < 0) throw new CloudStorageError('NotFound', '版本不存在');

    manifest.versions.splice(index, 1);
    if (manifest.latest === versionId) manifest.latest = manifest.versions[0]?.id ?? null;
    manifest.updatedAt = chronoAutoSiZ(Date.now());
    await this.saveManifest(manifest);

    try { await this.storage.delete(`${BACKUPS_DIR}/${versionId}.zip`); }
    catch (error) {
      defaultLogSink().warn(`版本 ${versionId} 已从 manifest 移除，但对象 GC 失败，将保留为不可见孤儿: ${errorMessage(error)}`);
    }
  }

  private pruneVersions(manifest: CloudManifest): ManifestVersion[] {
    const pruned: ManifestVersion[] = [];
    while (manifest.versions.length > this.maxVersions) {
      const old = manifest.versions.pop();
      if (old !== undefined) pruned.push(old);
    }
    return pruned;
  }
}
