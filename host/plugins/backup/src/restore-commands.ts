import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { getAvailableDiskSpace } from '../../../platform/storage/backup-common.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { BackupJobStartResponse } from '../../../../contracts/ipc/generated/L21-backup-governance.ts';
import type {
  DataSpaceService, DatabaseHandle, DatabaseName, MaintenanceLease, StorageService,
} from '../../../platform/storage/api.ts';
import type { PathsService as PlatformPathsService } from '../../../platform/paths/api.ts';
import { CommandError } from '../../../kernel/api.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import type { BackupJobContext, BackupJobResultPayload } from '../api.ts';
import type { Jobs } from './jobs.ts';
import {
  isMainDatabaseAlreadyInMaintenance, type Operations,
} from './operations.ts';
import { formatBackupProgressMessage, resolveBackupLocale } from './progress-messages.ts';
import type { Governance } from './governance.ts';
import {
  findBackup, finalizeVfsIndexRestore, prepareVfsIndexRestore, restoreNonDatabaseManifestFiles,
  restoreSingleDatabaseToDir, restoreWorkspaceManifestFilesToDir, verifyWithAssets,
  type BackupContext,
} from './backup-manager.ts';
import {
  ATOMIC_RESTORE_UNAVAILABLE_CODE, PARTIAL_ARCHIVE_NOT_SLOTABLE_CODE, checkManifestCompatibility,
  sha256FileAsync, validateForSlotRestore, type BackupManifest,
} from './manifest.ts';
import {
  backupDir, checkedRestoreDiskBudget, ensureExistingPathWithinBackupDir, sanitizePathForUser, userHomeDir,
  validateBackupId,
} from './paths.ts';
import { integrityCheck } from '../repository/backup-verify.ts';
import {
  completeAuditLog, failAuditLog, newAuditLog, withAuditDetails,
} from '../repository/audit.ts';
import { assetRequiresExplicitTrust, restoreAssetsWithProgress } from './assets.ts';
import { restoreCryptoKeysFromManifestTransactional } from './crypto-restore.ts';
import {
  assertNoUnconsumedCompleteDomains, consumeCompleteDomains, type DomainRestoreReport,
} from './restore-plan.ts';
import { databasePath } from './paths.ts';
import { DATABASE_IDS, type CoordinatedId } from './migrations.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import { ioMessage } from './io.ts';
import { Connection } from '../../../platform/storage/connection.ts';
import { PROFILES } from '../../../platform/storage/profiles.ts';
import type { BackupCommands } from './backup-commands.ts';
import { initializeWithReport } from './initialization.ts';

export interface RestoreCommandsOptions {
  readonly ctx: Context;
  readonly jobs: Jobs;
  readonly operations: Operations;
  readonly governance: Governance;
  readonly backupCommands: BackupCommands;
}

const PURGE_MARKER_FILE = '.purge_on_next_start';
const RESTORE_ACTIVATION_MARKER = '.restore_activation_pending.json';

export interface RestoreActivationMarker {
  backup_id: string;
  snapshot_epoch: string;
  created_at: string;
  old_device_id?: string;
  new_device_id?: string;
}

/** serde `RestoreActivationMarker`（commands_restore.rs:56-65）：必填 String，可选字段 null 视作缺省。 */
export function decodeRestoreActivationMarker(value: unknown): RestoreActivationMarker {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid type: expected struct RestoreActivationMarker');
  }
  const record = value as Record<string, unknown>;
  const required = (key: 'backup_id' | 'snapshot_epoch' | 'created_at'): string => {
    if (!(key in record)) throw new Error(`missing field \`${key}\``);
    const field = record[key];
    if (typeof field !== 'string') throw new Error(`invalid type for \`${key}\`: expected a string`);
    return field;
  };
  const optional = (key: 'old_device_id' | 'new_device_id'): string | undefined => {
    const field = record[key];
    if (field === undefined || field === null) return undefined;
    if (typeof field !== 'string') throw new Error(`invalid type for \`${key}\`: expected a string`);
    return field;
  };
  const marker: RestoreActivationMarker = {
    backup_id: required('backup_id'),
    snapshot_epoch: required('snapshot_epoch'),
    created_at: required('created_at'),
  };
  const oldDeviceId = optional('old_device_id');
  const newDeviceId = optional('new_device_id');
  if (oldDeviceId !== undefined) marker.old_device_id = oldDeviceId;
  if (newDeviceId !== undefined) marker.new_device_id = newDeviceId;
  return marker;
}

/** `commands_restore::atomic_restore_unavailable_error`。 */
export function atomicRestoreUnavailableError(): string {
  return `[${ATOMIC_RESTORE_UNAVAILABLE_CODE}] A/B 数据空间管理器不可用，已在写入任何恢复数据前中止；当前数据未改动`;
}

export function restoreActivationMarkerPath(activeDir: string): string {
  return join(activeDir, RESTORE_ACTIVATION_MARKER);
}

/** `persist_restore_activation_marker`（commands_restore.rs:67-90）：pretty JSON + 临时文件 + fsync + rename + 目录 fsync。 */
export function persistRestoreActivationMarker(
  targetDir: string,
  marker: RestoreActivationMarker,
): void {
  const payload = JSON.stringify(marker, null, 2);
  const target = join(targetDir, RESTORE_ACTIVATION_MARKER);
  const temporary = join(targetDir, `${RESTORE_ACTIVATION_MARKER}.tmp`);
  const step = <T>(prefix: string, run: () => T): T => {
    try { return run(); }
    catch (error) { throw new Error(`${prefix}: ${ioMessage(error)}`); }
  };
  const fd = step('创建恢复激活标记失败', () => openSync(temporary, 'w'));
  try {
    step('写入恢复激活标记失败', () => writeFileSync(fd, payload));
    step('同步恢复激活标记失败', () => fsyncSync(fd));
  } finally {
    closeSync(fd);
  }
  step('发布恢复激活标记失败', () => renameSync(temporary, target));
  if (process.platform === 'win32') return;
  let dir: number;
  // Rust `if let Ok(dir) = File::open(target_dir)`：目录打不开时跳过同步，不算失败。
  try { dir = openSync(targetDir, 'r'); }
  catch { return; }
  try { step('同步恢复目录失败', () => fsyncSync(dir)); }
  finally { closeSync(dir); }
}

/** `write_restore_activation_marker`。 */
export function writeRestoreActivationMarker(
  targetDir: string,
  backupId: string,
  snapshotEpoch: string,
): void {
  persistRestoreActivationMarker(targetDir, {
    backup_id: backupId,
    snapshot_epoch: snapshotEpoch,
    created_at: toRfc3339(),
  });
}

/** `publish_restore_keys_and_commit_cutover`。 */
export async function publishRestoreKeysAndCommitCutover(
  ctx: Context,
  manifest: BackupManifest,
  backupSubdir: string,
  targetSlot: string,
  commitCutover: () => void,
): Promise<number> {
  const keysRequired = manifest.key_policy === 'included_local';
  return restoreCryptoKeysFromManifestTransactional(
    ctx,
    manifest,
    backupSubdir,
    [manifest.backup_id, targetSlot],
    restored => {
      if (keysRequired && restored === 0) {
        throw new Error('备份声明包含加密密钥，但未恢复任何密钥文件');
      }
      try { commitCutover(); }
      catch (error) { throw new Error(`登记恢复切槽失败: ${ioMessage(error)}`); }
    },
  );
}

function dataSpaceOf(ctx: Context): DataSpaceService | null {
  return (ctx.reflect.get('dataSpace') as DataSpaceService | undefined) ?? null;
}

function pathsOf(ctx: Context): PlatformPathsService | null {
  return (ctx.reflect.get('paths') as PlatformPathsService | undefined) ?? null;
}

function storageOf(ctx: Context): StorageService | null {
  return (ctx.reflect.get('storage') as StorageService | undefined) ?? null;
}

/**
 * `finalize_restore_activation`：候选槽成为活动槽且启动迁移成功后，才轮换
 * 设备身份、重置同步游标并解除维护租约。
 */
export async function finalizeRestoreActivation(ctx: Context, activeDir: string): Promise<boolean> {
  const dataSpace = dataSpaceOf(ctx);
  const markerPath = restoreActivationMarkerPath(activeDir);
  if (!existsSync(markerPath)) {
    if (dataSpace !== null) {
      const lease = dataSpace.restoreCutoverPending();
      if (lease !== null) {
        if (lease.activation_committed) return dataSpace.completeRestoreCutover(activeDir);
        throw new Error(
          `恢复维护租约仍在但激活标记缺失: backup=${lease.backup_id}, target=${lease.target_slot}`,
        );
      }
    }
    return false;
  }

  // Rust commands_restore.rs:165-168：读取与 serde 解码分别报错。
  let markerText: string;
  try { markerText = readFileSync(markerPath, 'utf8'); }
  catch (error) { throw new Error(`读取恢复激活标记失败: ${ioMessage(error)}`); }
  let marker: RestoreActivationMarker;
  try { marker = decodeRestoreActivationMarker(JSON.parse(markerText)); }
  catch (error) { throw new Error(`解析恢复激活标记失败: ${ioMessage(error)}`); }
  if (rustTrim(marker.backup_id) === '' || rustTrim(marker.snapshot_epoch) === '') {
    throw new Error('恢复激活标记缺少 backup_id 或 snapshot_epoch');
  }

  const paths = pathsOf(ctx);
  if (paths === null) throw new Error('应用路径服务尚未初始化，无法提交恢复激活');
  const oldDeviceId = marker.old_device_id ?? await paths.deviceId();
  const newDeviceId = marker.new_device_id ?? paths.generateDeviceIdAfterRestore();
  if (marker.old_device_id === undefined || marker.new_device_id === undefined) {
    marker.old_device_id = oldDeviceId;
    marker.new_device_id = newDeviceId;
    persistRestoreActivationMarker(activeDir, marker);
  }

  try {
    // B05：轮换写操作属于 sync_state 所有者（L20 sync-support），不得在本 lane 复制 SQL。
    const syncSupport = ctx.reflect.get('syncSupport') as {
      state?: { recordDeviceRotation?: (oldId: string, newId: string, reason: string) => void };
    } | undefined;
    const syncState = syncSupport?.state;
    const rotate = syncState?.recordDeviceRotation;
    if (typeof rotate !== 'function' || syncState === undefined) {
      throw new Error('待接线：syncSupport.state.recordDeviceRotation（L20 尚未提供）');
    }
    rotate.call(syncState, oldDeviceId, newDeviceId, 'backup_restore_activation');
  } catch (error) {
    throw new Error(`激活恢复槽后重置同步游标失败: ${ioMessage(error)}`);
  }
  try { await paths.persistDeviceIdAfterRestore(newDeviceId); }
  catch (error) { throw new Error(`激活恢复槽后轮换设备 ID 失败: ${ioMessage(error)}`); }

  if (dataSpace === null) throw new Error('恢复槽激活后 DataSpaceManager 不可用');
  dataSpace.markRestoreActivationCommitted(activeDir, marker.backup_id);
  try { unlinkSync(markerPath); }
  catch (error) { throw new Error(`清理恢复激活标记失败: ${ioMessage(error)}`); }
  dataSpace.completeRestoreCutover(activeDir);
  ctx.logger('backup').info(
    `[data_governance] 恢复槽激活提交完成: backup_id=${marker.backup_id}, epoch=${marker.snapshot_epoch}, old_device=${oldDeviceId}, new_device=${newDeviceId}`,
  );
  return true;
}

async function initializeCandidateSlot(governance: Governance, inactiveDir: string): Promise<void> {
  // Rust init.rs 的目录/审计/报告顺序；迁移仍经正式 worker，许可由 executeRestore 的全局 guard 持有。
  await initializeWithReport(inactiveDir, (dir, auditDbPath) => governance.runMigrations(dir, auditDbPath));
}

/** L20 `sync@1.resetSyncBaselineAfterRestore`（D7：跨库表写入归 L20，不硬 inject）。 */
interface RestoreSyncPort {
  resetSyncBaselineAfterRestore(db: DatabaseHandle): [cleaned: number, touched: number];
}

function resetBaselineViaSync(ctx: Context, db: DatabaseHandle): { truncated: number; reset: number } {
  const sync = ctx.get('sync') as RestoreSyncPort | undefined;
  if (sync === undefined) {
    throw new Error('L20 sync 服务尚未安装，无法重建恢复后的同步基线');
  }
  const [truncated, reset] = sync.resetSyncBaselineAfterRestore(db);
  return { truncated, reset };
}

/** 恢复切槽维护屏障：只释放本次取得的组件，绝不解除其他所有者的 fail-close。 */
interface RestoreCutoverBarrier {
  /** Rust `set_restore_cutover_maintenance(false)`：逐组件退出，失败组件保持 fail-close。 */
  release(): void;
}

interface WorkspaceMaintenance {
  enterMaintenanceMode(): Promise<void>;
  exitMaintenanceMode(): void;
}

// Rust commands_restore.rs:281-316 的进入顺序与错误前缀；database/database_manager 在 Host 同为 mistakes。
const CUTOVER_DATABASES: ReadonlyArray<readonly [DatabaseName, string, string]> = [
  ['mistakes', '主数据库进入恢复维护模式失败', '主数据库'],
  ['vfs', 'VFS 进入恢复维护模式失败', 'VFS'],
  ['chat_v2', 'Chat V2 进入恢复维护模式失败', 'Chat V2'],
  ['llm_usage', 'LLM Usage 进入恢复维护模式失败', 'LLM Usage'],
];

/** `commands_restore.rs:266-399 set_restore_cutover_maintenance(app, true)`。 */
async function setRestoreCutoverMaintenance(ctx: Context): Promise<RestoreCutoverBarrier> {
  const storage = storageOf(ctx);
  if (storage === null || typeof storage.enterMaintenance !== 'function') {
    throw new Error('应用数据库状态尚未初始化');
  }
  const leases: Array<readonly [MaintenanceLease, string]> = [];
  let workspace: WorkspaceMaintenance | null = null;
  try {
    for (const [name, failurePrefix, label] of CUTOVER_DATABASES) {
      try { leases.push([await storage.enterMaintenance([name]), label]); }
      catch (error) {
        // Rust 271-273：主库已处于维护模式（启动 fail-close 等其他所有者）时直接拒绝。
        if (name === 'mistakes' && isMainDatabaseAlreadyInMaintenance(error)) {
          throw new Error('应用已处于维护模式，拒绝启动恢复切槽以免解除现有安全屏障');
        }
        throw new Error(`${failurePrefix}: ${ioMessage(error)}`);
      }
    }
    const candidate = ctx.reflect.get('agentWorkspace') as WorkspaceMaintenance | undefined;
    if (candidate !== undefined && typeof candidate.enterMaintenanceMode === 'function') {
      try { await candidate.enterMaintenanceMode(); }
      catch (error) { throw new Error(`工作区进入恢复维护模式失败: ${ioMessage(error)}`); }
      workspace = candidate;
    }
  } catch (error) {
    // Rust 319-354：逆序释放本次已取得的组件，结果按 `let _ =` 忽略。
    for (const [lease] of leases.reverse()) {
      try { lease.release(); }
      catch { // boundary-allow empty-catch: Rust `let _ = exit_maintenance_mode()`，保留进入失败的原始错误。
      }
    }
    throw error;
  }

  return {
    release: () => {
      const exitErrors: string[] = [];
      for (const [lease, label] of leases) {
        try { lease.release(); }
        catch (error) { exitErrors.push(`${label}: ${ioMessage(error)}`); }
      }
      if (workspace !== null) {
        try { workspace.exitMaintenanceMode(); }
        catch (error) { exitErrors.push(`工作区: ${ioMessage(error)}`); }
      }
      if (exitErrors.length > 0) {
        const message = `退出恢复维护屏障失败（失败组件保持 fail-close，需重启恢复）: ${exitErrors.join('; ')}`;
        ctx.logger('backup').error(`[data_governance] ${message}`);
        throw new Error(message);
      }
    },
  };
}

function failRestoreAfterCommittedCutover(
  ctx: Context,
  governance: Governance,
  job: BackupJobContext,
  backupId: string,
  targetSlot: string,
  error: string,
  domainOutcomes: DomainRestoreReport[] | null,
  durationMs: number | null = null,
): void {
  const honestError = `${error}（切槽与加密密钥已原子提交、不可撤销：重启后将激活候选槽 ${targetSlot}；本任务按失败终止，失败/未消费的域不会自动恢复，请依据审计日志中的 domains 终态处置）`;
  ctx.logger('backup').error(`[data_governance] ${honestError}`);
  governance.trySaveAuditLog(withAuditDetails(failAuditLog(newAuditLog({
    type: 'Restore', backup_path: backupId,
  }, backupId), honestError, durationMs), {
    job_id: job.job_id,
    cutover_committed: true,
    activates_slot_on_restart: targetSlot,
    domains: domainOutcomes,
  }));
  job.fail(honestError);
}

function asDatabaseId(value: string): CoordinatedId | null {
  return (DATABASE_IDS as readonly string[]).includes(value) ? value as CoordinatedId : null;
}

export class RestoreCommands {
  readonly ctx: Context;
  readonly jobs: Jobs;
  readonly operations: Operations;
  readonly governance: Governance;
  readonly backupCommands: BackupCommands;

  constructor(options: RestoreCommandsOptions) {
    this.ctx = options.ctx;
    this.jobs = options.jobs;
    this.operations = options.operations;
    this.governance = options.governance;
    this.backupCommands = options.backupCommands;
  }

  private context(): BackupContext { return this.backupCommands.context(); }

  restoreBackup(args: { backupId: string; restoreAssets?: boolean | null }): BackupJobStartResponse {
    const backupId = validateBackupId(args.backupId);
    const job = this.jobs.createJob('import');
    this.governance.trySaveAuditLog(withAuditDetails(newAuditLog({
      type: 'Restore', backup_path: backupId,
    }, backupId), {
      job_id: job.job_id, restore_assets: args.restoreAssets ?? null,
    }));
    void this.executeRestore(job, backupId, args.restoreAssets ?? null)
      .catch(error => this.jobs.markFailure(job.job_id, `恢复失败: ${ioMessage(error)}`));
    const locale = resolveBackupLocale(this.ctx);
    return {
      job_id: job.job_id, kind: 'import', status: 'queued',
      message: formatBackupProgressMessage(locale, 'restore.started'),
    };
  }

  private async executeRestore(
    job: BackupJobContext,
    backupId: string,
    restoreAssets: boolean | null,
  ): Promise<void> {
    const start = performance.now();
    const locale = resolveBackupLocale(this.ctx);
    const recordAuditFailure = (message: string, extraDetails: Record<string, unknown> = {}): void => {
      this.governance.trySaveAuditLog(withAuditDetails(failAuditLog(newAuditLog({
        type: 'Restore', backup_path: backupId,
      }, backupId), message, Math.trunc(performance.now() - start)), {
        job_id: job.job_id, restore_assets: restoreAssets, ...extraDetails,
      }));
    };
    const failJob = (message: string, extraDetails?: Record<string, unknown>): void => {
      recordAuditFailure(message, extraDetails);
      job.fail(message);
    };
    const cancelJob = (message: string): void => {
      recordAuditFailure(message, { cancelled: true });
      job.cancelled(message);
    };
    job.markRunning('queued', 0, formatBackupProgressMessage(locale, 'backup.waiting_for_operation'), 0, 0);
    let acquired: Awaited<ReturnType<Operations['acquireForJob']>>;
    try { acquired = await this.operations.acquireForJob('restore', job.job_id, () => job.isCancelled()); }
    catch (error) { failJob(`获取全局备份锁失败: ${ioMessage(error)}`); return; }
    if (acquired === 'cancelled') { cancelJob(formatBackupProgressMessage(locale, 'backup.cancelled_in_queue')); return; }
    const guard = acquired;
    const root = backupDir(this.ctx.app.dataDir);
    try {
      if (!existsSync(root)) { failJob('备份目录不存在'); return; }
      job.markRunning('scan', 2, formatBackupProgressMessage(locale, 'restore.verifying_manifest'), 0, 0);
      if (job.isCancelled()) { cancelJob(formatBackupProgressMessage(locale, 'restore.cancelled')); return; }

      let manifest: BackupManifest;
      try { manifest = findBackup(root, backupId, '备份不存在', message => this.ctx.logger('backup').warn(message)); }
      catch (error) { failJob(ioMessage(error)); return; }
      const manifestDir = join(root, manifest.backup_id);
      try { ensureExistingPathWithinBackupDir(manifestDir, root, userHomeDir(this.ctx)); }
      catch (error) { failJob(`备份路径校验失败: ${ioMessage(error)}`); return; }

      try { checkManifestCompatibility(manifest); }
      catch (error) { failJob(`备份版本不兼容: ${ioMessage(error)}`); return; }
      try { validateForSlotRestore(manifest); }
      catch (error) {
        failJob(`[${PARTIAL_ARCHIVE_NOT_SLOTABLE_CODE}] 备份不能用于完整恢复: ${ioMessage(error)}`);
        return;
      }
      if (restoreAssets === false) {
        failJob(`[${PARTIAL_ARCHIVE_NOT_SLOTABLE_CODE}] 完整快照恢复不能跳过资产；partial archive 不能替换数据槽`);
        return;
      }
      const verification = await verifyWithAssets(this.ctx, root, manifest);
      if (!verification.isValid) {
        const errors = [...verification.databaseErrors,
          ...verification.assetErrors.map(error => `${error.path}: ${error.message}`)];
        failJob(`备份完整性验证失败: ${errors.join('; ')}`);
        return;
      }

      const databaseFiles = manifest.files.filter(file => file.path.endsWith('.db') && file.database_id != null);
      const totalDatabases = databaseFiles.length;
      const untrustedAssetCount = (manifest.assets?.files ?? [])
        .filter(asset => !asset.is_directory && assetRequiresExplicitTrust(asset)).length;
      const assetFileCount = Math.max(0, (manifest.assets?.total_files ?? 0) - untrustedAssetCount);
      const workspaceFileCount = manifest.files
        .filter(file => file.path.startsWith('workspaces/') && file.path.endsWith('.db')).length;
      const manifestAssetCount = manifest.files
        .filter(file => file.database_id == null && !file.path.endsWith('.db')).length;
      const totalItems = totalDatabases + workspaceFileCount + manifestAssetCount + assetFileCount;
      job.markRunning('scan', 5,
        formatBackupProgressMessage(locale, 'restore.manifest_verified', { totalDatabases, assetFileCount }),
        0, totalItems);

      const backupSubdir = join(root, manifest.backup_id);
      if (!existsSync(backupSubdir)) { failJob(`备份目录不存在: ${backupSubdir}`); return; }
      if (job.isCancelled()) { cancelJob(formatBackupProgressMessage(locale, 'restore.cancelled')); return; }

      const verifyTotal = manifest.files.length;
      for (let index = 0; index < verifyTotal; index++) {
        const file = manifest.files[index]!;
        if (job.isCancelled()) { cancelJob(formatBackupProgressMessage(locale, 'restore.cancelled_verify')); return; }
        const progress = 5 + (index / Math.max(1, verifyTotal)) * 10;
        job.markRunning(
          'verify',
          progress,
          formatBackupProgressMessage(locale, 'restore.verifying_file', {
            path: file.path, index: index + 1, total: verifyTotal,
          }),
          0,
          totalItems,
        );
        const filePath = join(backupSubdir, file.path);
        if (!existsSync(filePath)) { failJob(`备份文件不存在: ${file.path}`); return; }
        let actual: string;
        try { actual = await sha256FileAsync(filePath, file.size); }
        catch (error) { failJob(`计算校验和失败 ${file.path}: ${ioMessage(error)}`); return; }
        if (actual !== file.sha256) {
          failJob(`备份文件校验和不匹配: ${file.path} (expected=${file.sha256}, actual=${actual})`);
          return;
        }
        if (file.path.endsWith('.db')) {
          let handle;
          try { handle = this.ctx.storage.openFile(filePath, { label: `restore-verify:${file.path}`, mustExist: true }); }
          catch (error) { failJob(`无法打开备份数据库文件: ${file.path} (${ioMessage(error)})`); return; }
          try {
            let result: string;
            try { result = integrityCheck(handle); }
            catch (error) { failJob(`备份数据库完整性检查执行失败: ${file.path} (${ioMessage(error)})`); return; }
            if (result !== 'ok') { failJob(`备份数据库完整性检查失败: ${file.path} (${result})`); return; }
          } finally { this.ctx.storage.close(handle); }
        }
      }

      const dataSpace = dataSpaceOf(this.ctx);
      if (dataSpace === null) { failJob(atomicRestoreUnavailableError()); return; }
      const inactiveSlot = dataSpace.activeDir() === dataSpace.slotDir('slotA') ? 'slotB' : 'slotA';
      const inactiveDir = dataSpace.inactiveDir();

      const assetSize = manifest.assets?.total_size ?? 0;
      let required: bigint;
      try { required = checkedRestoreDiskBudget(manifest.files.map(file => file.size), assetSize).requiredBytes; }
      catch (error) { failJob(ioMessage(error)); return; }
      if (!existsSync(inactiveDir)) {
        failJob(`恢复目标槽目录不存在或不是目录，无法确定目标卷: ${sanitizePathForUser(inactiveDir, userHomeDir(this.ctx))}`);
        return;
      }
      let available: number;
      try {
        const targetVolume = realpathSync(inactiveDir);
        available = getAvailableDiskSpace(targetVolume);
      } catch (error) { failJob(`获取恢复目标卷可用空间失败: ${ioMessage(error)}`); return; }
      if (BigInt(available) < required) {
        failJob(`磁盘空间不足：需要 ${(Number(required) / 1024 / 1024).toFixed(1)} MB，仅剩 ${(available / 1024 / 1024).toFixed(1)} MB。请清理存储空间后重试`);
        return;
      }

      try { dataSpace.clearSlotForRestore(inactiveSlot); }
      catch (error) {
        failJob(`清空恢复目标插槽 ${inactiveSlot} 失败，已中止恢复（避免脏插槽混入）: ${ioMessage(error)}`);
        return;
      }
      try { mkdirSync(inactiveDir, { recursive: true }); }
      catch (error) { failJob(`创建恢复目标目录失败: ${ioMessage(error)}`); return; }

      const databasesRestored: string[] = [];
      const restoreErrors: string[] = [];
      for (let index = 0; index < databaseFiles.length; index++) {
        const file = databaseFiles[index]!;
        const dbIdText = file.database_id!;
        const dbId = asDatabaseId(dbIdText);
        if (dbId === null) {
          restoreErrors.push(`备份中包含未知的数据库 ID: ${dbIdText}`);
          continue;
        }
        const progress = 15 + (index / Math.max(1, totalDatabases)) * 65;
        job.markRunning('replace', progress,
          formatBackupProgressMessage(locale, 'restore.restoring_database', {
            dbId: dbIdText, index: index + 1, total: totalDatabases,
          }), index, totalItems);
        try {
          await restoreSingleDatabaseToDir(this.ctx, dbId, backupSubdir, inactiveDir);
          databasesRestored.push(dbIdText);
        } catch (error) {
          restoreErrors.push(`${dbIdText}: ${ioMessage(error)}`);
        }
      }

      const restoreAssetsEnabled = true;
      if (restoreErrors.length === 0 && databasesRestored.includes('vfs')) {
        try { await prepareVfsIndexRestore(this.ctx, manifest, inactiveDir, restoreAssetsEnabled); }
        catch (error) { failJob(`准备恢复 VFS 派生索引失败: ${ioMessage(error)}`); return; }
      }

      let restoredWorkspaces: number;
      try { restoredWorkspaces = await restoreWorkspaceManifestFilesToDir(this.ctx, manifest, backupSubdir, inactiveDir); }
      catch (error) { failJob(`恢复工作区数据库失败: ${ioMessage(error)}`); return; }
      let restoredManifestAssets: number;
      try { restoredManifestAssets = await restoreNonDatabaseManifestFiles(manifest, backupSubdir, inactiveDir); }
      catch (error) { failJob(`恢复分层资产失败: ${ioMessage(error)}`); return; }

      job.markRunning('replace', 80,
        formatBackupProgressMessage(locale, 'restore.databases_restored', {
          restored: databasesRestored.length, total: totalDatabases, workspaces: restoredWorkspaces,
        }),
        totalDatabases, totalItems);

      if (restoreErrors.length > 0) {
        const message = `部分数据库恢复失败: ${restoreErrors.join('; ')}`;
        failJob(message, { errors: restoreErrors });
        return;
      }

      const shouldRestoreAssets = true;
      let restoredAssets = restoredManifestAssets;
      if (manifest.assets) {
        const trusted = manifest.assets.files.filter(asset => !assetRequiresExplicitTrust(asset));
        if (untrustedAssetCount > 0) {
          this.ctx.logger('backup').info(
            `[data_governance] 已从自动资产恢复中排除 ${untrustedAssetCount} 个待信任可执行文件（UntrustedExecutable 域），交由 DomainRestorePlan 隔离`,
          );
        }
        try {
          const count = await restoreAssetsWithProgress(
            backupSubdir,
            inactiveDir,
            trusted,
            (restored, totalAsset) => {
              if (job.isCancelled()) return false;
              const ratio = totalAsset > 0 ? restored / totalAsset : 1;
              job.markRunning('replace', 80 + ratio * 12,
                formatBackupProgressMessage(locale, 'restore.restoring_assets', {
                  restored, total: totalAsset,
                }),
                totalDatabases + restored, totalItems);
              return true;
            },
          );
          restoredAssets += count;
        } catch (error) {
          if (error instanceof Error && 'cancelled' in error && (error as { cancelled?: boolean }).cancelled === true) {
            cancelJob(formatBackupProgressMessage(locale, 'restore.cancelled_assets'));
            return;
          }
          restoreErrors.push(`资产恢复: ${ioMessage(error)}`);
        }
      }

      const hasAssetErrors = restoreErrors.length > 0;
      if (hasAssetErrors) {
        failJob(`资产恢复失败: ${restoreErrors.join('; ')}`);
        return;
      }

      if (databasesRestored.includes('vfs')) {
        try { finalizeVfsIndexRestore(this.ctx, manifest, inactiveDir, shouldRestoreAssets); }
        catch (error) { failJob(`校验恢复后的 VFS 派生索引失败: ${ioMessage(error)}`); return; }
      }

      job.markRunning('cleanup', 93, formatBackupProgressMessage(locale, 'restore.marking_slot_switch'), totalItems, totalItems);
      const durationMs = Math.round(performance.now() - start);
      const restoreTargetPath = inactiveDir;

      try { await initializeCandidateSlot(this.governance, inactiveDir); }
      catch (error) { failJob(`恢复候选槽迁移/验证失败: ${ioMessage(error)}`); return; }

      for (const dbIdText of databasesRestored) {
        const dbId = asDatabaseId(dbIdText);
        if (dbId === null) continue;
        const dbPath = databasePath(inactiveDir, dbId);
        if (!existsSync(dbPath)) {
          failJob(`恢复候选槽缺少数据库: ${dbPath}`);
          return;
        }
        const conn = new Connection(dbPath, { label: `restore-baseline:${dbId}`, profile: PROFILES.plain });
        try {
          conn.exec('BEGIN IMMEDIATE');
          try {
            const stats = resetBaselineViaSync(
              this.ctx,
              conn as unknown as DatabaseHandle,
            );
            conn.exec('COMMIT');
            this.ctx.logger('backup').info(
              `[data_governance] ${dbIdText} 同步基线已重建: 清理 change_log=${stats.truncated}, 重置 sync_version=${stats.reset}`,
            );
          } catch (error) {
            try { conn.exec('ROLLBACK'); }
            catch (rollbackError) {
              this.ctx.logger('backup').warn(`回滚同步基线事务失败: ${ioMessage(rollbackError)}`);
            }
            failJob(`${dbIdText} 同步基线重建失败，拒绝激活候选槽: ${ioMessage(error)}`);
            return;
          }
        } finally {
          conn.close();
        }
      }

      try { writeRestoreActivationMarker(inactiveDir, backupId, manifest.snapshot_epoch); }
      catch (error) { failJob(ioMessage(error)); return; }

      let maintenance: RestoreCutoverBarrier;
      try { maintenance = await setRestoreCutoverMaintenance(this.ctx); }
      catch (error) {
        try { unlinkSync(restoreActivationMarkerPath(inactiveDir)); }
        catch (cleanupError) {
          this.ctx.logger('backup').warn(`清理恢复激活标记失败: ${ioMessage(cleanupError)}`);
        }
        failJob(ioMessage(error));
        return;
      }

      let restoredCryptoKeys: number;
      try {
        restoredCryptoKeys = await publishRestoreKeysAndCommitCutover(
          this.ctx,
          manifest,
          backupSubdir,
          inactiveSlot,
          () => dataSpace.markRestoreCutoverPending(inactiveSlot, backupId),
        );
      } catch (error) {
        // Rust 1223：`let _ = set_restore_cutover_maintenance(&app, false)`，错误已在 release 内记 error。
        try { maintenance.release(); }
        catch { // boundary-allow empty-catch: Rust 忽略退出结果，任务仍以提交失败原因终止。
        }
        try { unlinkSync(restoreActivationMarkerPath(inactiveDir)); }
        catch (cleanupError) {
          this.ctx.logger('backup').warn(`清理恢复激活标记失败: ${ioMessage(cleanupError)}`);
        }
        failJob(`提交恢复密钥与切槽失败: ${ioMessage(error)}`);
        return;
      }
      if (restoredCryptoKeys > 0) {
        this.ctx.logger('backup').info(
          `[data_governance] 加密密钥与恢复切槽原子提交完成: ${restoredCryptoKeys} 个文件`,
        );
      }
      this.ctx.logger('backup').info(`[data_governance] 已原子登记下次启动切换到 ${inactiveSlot}`);

      job.markRunning('cleanup', 95, formatBackupProgressMessage(locale, 'restore.restoring_auxiliary_domains'), totalItems, totalItems);
      let domainOutcomes: DomainRestoreReport[];
      try {
        domainOutcomes = await consumeCompleteDomains(
          this.ctx, manifest, backupSubdir, inactiveDir, this.ctx.app.dataDir,
        );
      } catch (error) {
        failRestoreAfterCommittedCutover(
          this.ctx, this.governance, job, backupId, inactiveSlot,
          `消费域恢复计划失败: ${ioMessage(error)}`, null, Math.round(performance.now() - start),
        );
        return;
      }
      const failedDomains = domainOutcomes
        .filter(outcome => outcome.state === 'failed')
        .map(outcome => `${outcome.domain_id}: ${outcome.detail ?? ''}`);
      if (failedDomains.length > 0) {
        failRestoreAfterCommittedCutover(
          this.ctx, this.governance, job, backupId, inactiveSlot,
          `域恢复计划执行失败: ${failedDomains.join('; ')}`, domainOutcomes, Math.round(performance.now() - start),
        );
        return;
      }
      const isolatedSummary = domainOutcomes
        .filter(outcome => outcome.state === 'isolated_pending_trust')
        .map(outcome => outcome.code ? `${outcome.domain_id}[${outcome.code}]` : outcome.domain_id);

      const consumedDomainIds = [
        ...databasesRestored.map(id => `database:${id}`),
        'workspaces-root',
        ...DATABASE_IDS.map(id => `asset-root:${id}`),
        'crypto',
        ...domainOutcomes.map(outcome => outcome.domain_id),
      ];
      try { assertNoUnconsumedCompleteDomains(manifest, consumedDomainIds); }
      catch (error) {
        failRestoreAfterCommittedCutover(
          this.ctx, this.governance, job, backupId, inactiveSlot,
          `[E_RESTORE_DOMAIN_UNCONSUMED] 存在未被恢复编排消费的 Complete 域: ${ioMessage(error)}`,
          domainOutcomes, Math.round(performance.now() - start),
        );
        return;
      }

      job.markRunning('cleanup', 97, formatBackupProgressMessage(locale, 'restore.recording_audit_log'), totalItems, totalItems);
      this.governance.trySaveAuditLog(withAuditDetails(
        completeAuditLog(newAuditLog({ type: 'Restore', backup_path: backupId }, backupId), durationMs),
        {
          job_id: job.job_id,
          restore_assets: shouldRestoreAssets,
          restored_assets: restoredAssets,
          databases_restored: databasesRestored,
          asset_errors: restoreErrors,
          domains: domainOutcomes,
          isolated_domains: isolatedSummary,
          quarantined_executable_assets: untrustedAssetCount,
        },
      ));

      const isolatedDomains = isolatedSummary.join(', ');
      const payload: BackupJobResultPayload = {
        success: true,
        output_path: restoreTargetPath,
        resolved_path: restoreTargetPath,
        message: formatBackupProgressMessage(locale, 'restore.completed_detail', {
          databases: databasesRestored.join(', '), restoredAssets, isolatedDomains,
        }),
        error: null,
        duration_ms: durationMs,
        stats: {
          backup_id: backupId,
          databases_restored: databasesRestored,
          database_count: databasesRestored.length,
          restore_assets: shouldRestoreAssets,
          restored_assets: restoredAssets,
          restore_target: restoreTargetPath,
          asset_errors: restoreErrors,
          domains: domainOutcomes,
          isolated_domains: isolatedSummary,
          quarantined_executable_assets: untrustedAssetCount,
        },
        requires_restart: true,
        checkpoint_path: null,
        resumable_job_id: null,
      };
      job.complete(
        formatBackupProgressMessage(locale, 'restore.completed', {
          databaseCount: databasesRestored.length, restoredAssets, isolatedDomains,
        }),
        totalItems,
        totalItems,
        payload,
      );
    } catch (error) {
      if (job.isCancelled()) { cancelJob(formatBackupProgressMessage(locale, 'restore.cancelled')); return; }
      const message = ioMessage(error);
      recordAuditFailure(message);
      job.fail(message);
    } finally {
      guard.release();
    }
  }

  /** `data_governance_purge_all_data`：写清理标记后请求完整重启（不返回）。 */
  async purgeAllData(): Promise<string> {
    const marker = join(this.ctx.app.dataDir, PURGE_MARKER_FILE);
    try {
      mkdirSync(this.ctx.app.dataDir, { recursive: true });
      writeFileSync(marker, '1');
    } catch (error) {
      throw new Error(`写入清理标记失败: ${ioMessage(error)}`);
    }
    this.ctx.logger('backup').info('[data_governance] 已设置清空数据标记，将重启应用执行清理');
    await this.ctx.shell.request('process:restart');
    throw new CommandError('应用重启未生效：进程仍在运行');
  }
}
