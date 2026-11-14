/**
 * [R4-bad-write] Bad-object convergence (bad_object.rs).
 *
 * Consumes the residue left by "write tmp → verify → publish final → verify":
 * - final object corrupt + a `.tmp` that passes validation now → quarantine the bad
 *   bytes with a reason record, then converge from the `.tmp`;
 * - final object missing + a verified `.tmp` → converge from it;
 * - only a corrupt final object → quarantine + fail closed;
 * - final object healthy → untouched.
 *
 * Safety boundary: quarantine always copies and verifies first; user backup data
 * objects (`backups/`, `backup-v2/`) are never deleted automatically.
 */

import { sha256Hex } from './hashing.ts';
import type { CloudStorage } from '../api.ts';
import { CloudStorageError } from './errors.ts';
import { defaultLogSink } from './logging.ts';
import { chronoAutoSiZ } from './time.ts';
import { MEMORY_GET_DEFAULT_BUDGET_BYTES } from './traits.ts';
import { randomHex } from './random.ts';
import { bytesEqual, utf8Encode } from './bytes.ts';

export const QUARANTINE_PREFIX = '.quarantine/';
export const BAD_OBJECT_FAIL_CLOSED_CODE = 'E_SYNC_BAD_OBJECT_FAIL_CLOSED';
export const USER_BACKUP_DATA_PREFIXES: readonly string[] = ['backups/', 'backup-v2/'];

const TMP_SUFFIX = '.tmp';
const TMP_OP_MARKER = '.tmp-';

/** [R6-tmp-naming] both generations of staging keys are recognized on the read side. */
export function isTmpObjectKey(key: string): boolean {
  if (key.endsWith(TMP_SUFFIX)) return true;
  const index = key.lastIndexOf(TMP_OP_MARKER);
  if (index < 0) return false;
  const op = key.slice(index + TMP_OP_MARKER.length);
  return op.length > 0 && /^[A-Za-z0-9]+$/.test(op);
}

export type ValidateFn = (bytes: Uint8Array) => string | null;

export interface QuarantineRecord {
  schema: number;
  originalKey: string;
  quarantinedKey: string;
  reason: string;
  badSha256: string;
  badSize: number;
  detectedAt: string;
  deviceId: string;
  originalDeleted: boolean;
  recoveredFromTmp?: string;
}

export type BadObjectOutcome =
  | { kind: 'AlreadyHealthy' }
  | { kind: 'Absent' }
  | { kind: 'RecoveredFromTmp'; key: string; tmpKey: string; quarantine: QuarantineRecord | null };

export function isUserBackupDataObject(key: string): boolean {
  return USER_BACKUP_DATA_PREFIXES.some(prefix => key.startsWith(prefix));
}

function stamp(): string {
  return `${new Date().toISOString().replace(/[-:]/g, '').replace('.', '')}-${randomHex(4)}`;
}

async function publishVerified(storage: CloudStorage, key: string, data: Uint8Array): Promise<void> {
  await storage.put(key, data);
  const readBack = await storage.getBounded(key, data.byteLength);
  if (readBack === null || !bytesEqual(readBack, data)) {
    throw new CloudStorageError('Unknown', `坏写收敛发布 ${key} 后回读校验失败：已保留已校验 .tmp，本次不得报成功`);
  }
}

async function findVerifiedTmp(
  storage: CloudStorage,
  key: string,
  validate: ValidateFn,
): Promise<{ tmpKey: string; bytes: Uint8Array } | null> {
  const files = await storage.list(`${key}.`);
  for (const info of files) {
    if (!isTmpObjectKey(info.key)) continue;
    const bytes = await storage.getBounded(info.key, MEMORY_GET_DEFAULT_BUDGET_BYTES);
    if (bytes === null) continue;
    const reason = validate(bytes);
    if (reason === null) return { tmpKey: info.key, bytes };
    defaultLogSink().warn(`[BadWrite] 临时对象 ${info.key} 未通过重新校验，跳过并保留（供审计）: ${reason}`);
  }
  return null;
}

async function quarantineBadObject(
  storage: CloudStorage,
  deviceId: string,
  key: string,
  badBytes: Uint8Array,
  reason: string,
  recoveredFromTmp: string | null,
): Promise<QuarantineRecord> {
  const detectedAt = new Date();
  const mark = stamp();
  const quarantinedKey = `${QUARANTINE_PREFIX}${key}.${mark}.bad`;
  const reasonKey = `${QUARANTINE_PREFIX}${key}.${mark}.reason.json`;

  await storage.put(quarantinedKey, badBytes);
  const readBack = await storage.getBounded(quarantinedKey, badBytes.byteLength);
  if (readBack === null || !bytesEqual(readBack, badBytes)) {
    throw new CloudStorageError('Unknown',
      `隔离副本 ${quarantinedKey} 回读校验失败：审计痕迹不可信，已停止（原对象未动）`);
  }

  let originalDeleted = false;
  if (!isUserBackupDataObject(key)) {
    try { await storage.delete(key); originalDeleted = true; }
    catch (error) {
      defaultLogSink().warn(
        `[BadWrite] 删除坏正式对象 ${key} 失败（副本已在隔离区，记录将如实标注未删除）: ${error instanceof Error ? error.message : String(error)}`,
      );
      originalDeleted = false;
    }
  }

  const record: QuarantineRecord = {
    schema: 1,
    originalKey: key,
    quarantinedKey,
    reason,
    badSha256: sha256Hex(badBytes),
    badSize: badBytes.byteLength,
    detectedAt: chronoAutoSiZ(detectedAt.getTime()),
    deviceId,
    originalDeleted,
    ...(recoveredFromTmp === null ? {} : { recoveredFromTmp }),
  };
  const recordBytes = utf8Encode(JSON.stringify(record, null, 2));
  await storage.put(reasonKey, recordBytes);
  const recordReadBack = await storage.getBounded(reasonKey, recordBytes.byteLength);
  if (recordReadBack === null || !bytesEqual(recordReadBack, recordBytes)) {
    throw new CloudStorageError('Unknown', `隔离原因记录 ${reasonKey} 回读校验失败：审计痕迹不完整，已停止`);
  }
  return record;
}

async function deleteTmpBestEffort(storage: CloudStorage, tmpKey: string): Promise<void> {
  try { await storage.delete(tmpKey); }
  catch (error) {
    defaultLogSink().warn(
      `[BadWrite] 收敛成功后删除已消费临时对象 ${tmpKey} 失败（不影响结果）: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Bad-object convergence entry point. `validate` runs now on every candidate. */
export async function convergeBadObject(
  storage: CloudStorage,
  deviceId: string,
  key: string,
  validate: ValidateFn,
): Promise<BadObjectOutcome> {
  if (!key || key.startsWith(QUARANTINE_PREFIX) || isTmpObjectKey(key)) {
    throw new CloudStorageError('Validation',
      `坏写收敛只接受业务正式对象 key（非空、不在隔离前缀下、非 .tmp / .tmp-<op> 暂存键）: ${JSON.stringify(key)}`);
  }

  const bytes = await storage.getBounded(key, MEMORY_GET_DEFAULT_BUDGET_BYTES);
  if (bytes !== null) {
    const reason = validate(bytes);
    if (reason === null) return { kind: 'AlreadyHealthy' };

    const verifiedTmp = await findVerifiedTmp(storage, key, validate);
    const record = await quarantineBadObject(storage, deviceId, key, bytes, reason, verifiedTmp?.tmpKey ?? null);
    if (verifiedTmp === null) {
      throw new CloudStorageError('Validation',
        `[${BAD_OBJECT_FAIL_CLOSED_CODE}] 正式对象 ${key} 校验失败（${reason}），且无可用已校验 .tmp 收敛：`
        + `坏字节已隔离到 ${record.quarantinedKey}（原因记录见同名 .reason.json），本次 fail-closed，不冒充成功`);
    }
    await publishVerified(storage, key, verifiedTmp.bytes);
    await deleteTmpBestEffort(storage, verifiedTmp.tmpKey);
    return { kind: 'RecoveredFromTmp', key, tmpKey: verifiedTmp.tmpKey, quarantine: record };
  }

  const verifiedTmp = await findVerifiedTmp(storage, key, validate);
  if (verifiedTmp === null) return { kind: 'Absent' };
  await publishVerified(storage, key, verifiedTmp.bytes);
  await deleteTmpBestEffort(storage, verifiedTmp.tmpKey);
  return { kind: 'RecoveredFromTmp', key, tmpKey: verifiedTmp.tmpKey, quarantine: null };
}
