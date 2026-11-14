import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { rustTrim } from '../../../platform/util/portable.ts';
import type {
  BackupJobStartResponse, ResumableJobResponse,
} from '../../../../contracts/ipc/generated/L21-backup-governance.ts';
import type {
  BackupJobContext, BackupJobResultPayload, BackupJobParams, PersistedJob,
} from '../api.ts';
import { parseJobParams, type Jobs } from './jobs.ts';
import type { Governance } from './governance.ts';
import type { BackupCommands } from './backup-commands.ts';
import { createBackup, deleteBackup, type BackupContext } from './backup-manager.ts';
import { classifyRecoveryKind, loadManifest, type BackupManifest } from './manifest.ts';
import {
  backupDir, sanitizePathForUser, userHomeDir, validateBackupId, validateUserPath,
} from './paths.ts';
import {
  exportBackupToZip, importBackupFromZip, zipContainsEncryptedSecrets,
} from './zip.ts';
import { completeAuditLog, failAuditLog, newAuditLog, withAuditDetails } from '../repository/audit.ts';
import { ioMessage } from './io.ts';
import {
  OPERATION_QUEUED_CANCELLED_MESSAGE, WAITING_FOR_OPERATION_MESSAGE, type Operations,
} from './operations.ts';
import { DATABASE_IDS, type CoordinatedId } from './migrations.ts';

export const STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED_CODE = 'E_STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED';
export const STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED =
  '[E_STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED] 已开启云端端到端加密，但安全存储里没有可用的备份密码。已拒绝继续，以免把无法整槽恢复的便携归档当成加密全保真。请重新配置云端加密密码后再试。';

const CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE = 'E_CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT';
const MIN_CLOUD_ENCRYPTION_PASSWORD_CHARS = 8;

export interface ZipCommandsOptions {
  readonly ctx: Context;
  readonly jobs: Jobs;
  readonly operations: Operations;
  readonly governance: Governance;
  readonly backupCommands: BackupCommands;
}

function nonEmptyPassword(password: string | null | undefined): string | null {
  if (password == null || rustTrim(password) === '') return null;
  return password;
}

function acceptZipEncryptionPassword(password: string): string {
  if (Array.from(password).length < MIN_CLOUD_ENCRYPTION_PASSWORD_CHARS) {
    throw new Error(`[${CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE}] 云端端到端加密密码至少需要 ${MIN_CLOUD_ENCRYPTION_PASSWORD_CHARS} 个字符（不能为空白）`);
  }
  return password;
}

/** `commands_zip::resolve_zip_encryption_password`。 */
export function resolveZipEncryptionPassword(
  explicitPassword: string | null | undefined,
  useStored: boolean | null | undefined,
  storedPassword: string | null | undefined,
): string | null {
  const explicit = nonEmptyPassword(explicitPassword);
  if (explicit !== null) return acceptZipEncryptionPassword(explicit);
  if (useStored === true) {
    const stored = nonEmptyPassword(storedPassword);
    if (stored === null) throw new Error(STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED);
    return acceptZipEncryptionPassword(stored);
  }
  return null;
}

/** `commands_zip::resolve_import_zip_password`。 */
export function resolveImportZipPassword(
  explicitPassword: string | null | undefined,
  useStored: boolean | null | undefined,
  storedPassword: string | null | undefined,
  zipHasSealedSecrets: boolean,
): string | null {
  if (!zipHasSealedSecrets) return nonEmptyPassword(explicitPassword);
  const explicit = nonEmptyPassword(explicitPassword);
  if (explicit !== null) return explicit;
  if (useStored === true) {
    const stored = nonEmptyPassword(storedPassword);
    if (stored === null) throw new Error(STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED);
    return stored;
  }
  return null;
}

async function storedCloudEncryptionPassword(ctx: Context): Promise<string | null> {
  try {
    const credentials = await ctx.secrets.openStore(ctx.app.dataDir).getCloudCredentials();
    return nonEmptyPassword(credentials?.encryptionPassword);
  } catch (error) {
    ctx.logger('backup').warn(`读取云端加密密码失败: ${ioMessage(error)}`);
    return null;
  }
}

function importBackupId(now = new Date()): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  const timestamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}_${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const rand8 = randomUUID().replace(/-/g, '').slice(0, 8);
  return `${timestamp}_${rand8}_${pad(now.getUTCMilliseconds(), 3)}_imported`;
}

export class ZipCommands {
  readonly ctx: Context;
  readonly jobs: Jobs;
  readonly operations: Operations;
  readonly governance: Governance;
  readonly backupCommands: BackupCommands;

  constructor(options: ZipCommandsOptions) {
    this.ctx = options.ctx;
    this.jobs = options.jobs;
    this.operations = options.operations;
    this.governance = options.governance;
    this.backupCommands = options.backupCommands;
  }

  private context(): BackupContext { return this.backupCommands.context(); }

  async listResumableJobs(): Promise<ResumableJobResponse[]> {
    const jobs = this.jobs.listResumableJobs();
    const result: ResumableJobResponse[] = [];
    for (const job of jobs) {
      result.push({ ...job, requires_password: await this.resumableJobRequiresPassword(job) });
    }
    return result;
  }

  private async resumableJobRequiresPassword(job: PersistedJob): Promise<boolean> {
    if (job.kind !== 'import') return false;
    let params: BackupJobParams;
    try {
      params = parseJobParams(job.params);
    } catch (error) {
      this.ctx.logger('backup').warn(`无法解析可恢复导入任务参数，暂不标记密码要求: job_id=${job.job_id}, ${ioMessage(error)}`);
      return false;
    }
    if (typeof params.zip_path !== 'string') return false;
    try {
      return await zipContainsEncryptedSecrets(this.ctx, params.zip_path);
    } catch (error) {
      this.ctx.logger('backup').warn(`无法检查可恢复导入任务是否携带密封载荷: job_id=${job.job_id}, ${ioMessage(error)}`);
      return false;
    }
  }

  async exportZip(args: {
    backupId: string;
    outputPath?: string | null;
    compressionLevel?: number | null;
    includeChecksums?: boolean | null;
    encryptionPassword?: string | null;
    useStoredCloudEncryptionPassword?: boolean | null;
  }): Promise<BackupJobStartResponse> {
    const backupId = validateBackupId(args.backupId);
    if (args.outputPath != null) validateUserPath(args.outputPath);
    const stored = (args.useStoredCloudEncryptionPassword === true
      && nonEmptyPassword(args.encryptionPassword) === null)
      ? await storedCloudEncryptionPassword(this.ctx)
      : null;
    resolveZipEncryptionPassword(args.encryptionPassword, args.useStoredCloudEncryptionPassword, stored);

    const compressionLevel = Math.min(args.compressionLevel ?? 6, 9);
    const includeChecksums = args.includeChecksums ?? true;
    const job = this.jobs.createJob('export');
    this.governance.trySaveAuditLog(withAuditDetails(newAuditLog({
      type: 'Backup', backup_type: 'Full', file_count: 0, total_size: 0,
    }, `zip_export/${backupId}`), {
      job_id: job.job_id, backup_id: backupId, compression_level: compressionLevel,
      include_checksums: includeChecksums, output_path: args.outputPath ?? null, subtype: 'zip_export',
    }));
    void this.executeExport(job, backupId, {
      outputPath: args.outputPath ?? null, compressionLevel, includeChecksums,
      encryptionPassword: args.encryptionPassword ?? null,
      useStoredCloudEncryptionPassword: args.useStoredCloudEncryptionPassword ?? null,
    }).catch(error => this.jobs.markFailure(job.job_id, `ZIP 导出失败: ${ioMessage(error)}`));
    return {
      job_id: job.job_id, kind: 'export', status: 'queued',
      message: 'ZIP 导出任务已启动，请通过 backup-job-progress 事件监听进度',
    };
  }

  private async executeExport(
    job: BackupJobContext,
    backupId: string,
    options: {
      outputPath: string | null; compressionLevel: number; includeChecksums: boolean;
      encryptionPassword: string | null; useStoredCloudEncryptionPassword: boolean | null;
    },
  ): Promise<void> {
    let password: string | null;
    try {
      const stored = (options.useStoredCloudEncryptionPassword === true
        && nonEmptyPassword(options.encryptionPassword) === null)
        ? await storedCloudEncryptionPassword(this.ctx)
        : null;
      password = resolveZipEncryptionPassword(
        options.encryptionPassword, options.useStoredCloudEncryptionPassword, stored,
      );
    } catch (error) {
      job.fail(ioMessage(error));
      return;
    }

    const start = performance.now();
    job.markRunning('queued', 0, WAITING_FOR_OPERATION_MESSAGE, 0, 0);
    let acquired: Awaited<ReturnType<Operations['acquireForJob']>>;
    try { acquired = await this.operations.acquireForJob('zip_export', job.job_id, () => job.isCancelled()); }
    catch (error) { job.fail(`获取全局备份锁失败: ${ioMessage(error)}`); return; }
    if (acquired === 'cancelled') { job.cancelled(OPERATION_QUEUED_CANCELLED_MESSAGE); return; }
    const guard = acquired;
    try {
      const root = backupDir(this.ctx.app.dataDir);
      const source = join(root, backupId);
      if (!existsSync(source)) {
        const message = `备份不存在: ${backupId}`;
        this.governance.trySaveAuditLog(failAuditLog(withAuditDetails(newAuditLog({
          type: 'Backup', backup_type: 'Full', file_count: 0, total_size: 0,
        }, `zip_export/${backupId}`), { job_id: job.job_id, backup_id: backupId, subtype: 'zip_export' }), message));
        job.fail(message);
        return;
      }
      const encrypted = password !== null;
      job.markRunning('scan', 0,
        encrypted ? '正在密封敏感数据并生成加密全保真 ZIP...' : '正在扫描备份目录...', 0, 1);
      if (job.isCancelled()) { job.cancelled('用户取消 ZIP 导出'); return; }

      const zipPath = options.outputPath ?? join(root, `${backupId}.zip`);
      mkdirSync(dirname(zipPath), { recursive: true });
      const sourceManifest = loadManifest(join(source, 'manifest.json'));
      let restorable = false;
      try { restorable = encrypted && classifyRecoveryKind(sourceManifest).restorable; }
      catch { restorable = false; }

      const result = await exportBackupToZip(this.ctx, source, {
        compressionLevel: options.compressionLevel,
        outputPath: zipPath,
        includeChecksums: options.includeChecksums,
        encryptionPassword: password,
      }, progress => {
        const phase = progress.phase === 'scan' ? 'scan'
          : progress.phase === 'seal' || progress.phase === 'compress' ? 'compress' : 'verify';
        job.markRunning(phase, progress.progress, progress.message, progress.processedFiles, progress.totalFiles);
      }, () => job.isCancelled());
      if (job.isCancelled()) { job.cancelled('用户取消 ZIP 导出'); return; }

      job.markRunning('cleanup', 98, '正在完成导出...', result.fileCount, result.fileCount);
      const ratio = result.totalSize === 0 ? 0 : 1 - result.compressedSize / result.totalSize;
      const durationMs = Math.trunc(performance.now() - start);
      const recoveryKind = restorable ? 'disaster_recovery' : 'partial_archive';
      this.governance.trySaveAuditLog(completeAuditLog(withAuditDetails(newAuditLog({
        type: 'Backup', backup_type: 'Full', file_count: result.fileCount, total_size: result.compressedSize,
      }, `zip_export/${backupId}`), {
        job_id: job.job_id, backup_id: backupId, zip_path: result.zipPath,
        file_count: result.fileCount, total_size: result.totalSize,
        compressed_size: result.compressedSize, compression_ratio: ratio,
        zip_checksum: result.zipChecksum, subtype: 'zip_export', encrypted,
        recovery_kind: recoveryKind,
      }), durationMs));

      job.complete(`ZIP 导出完成: ${result.zipPath}`, result.fileCount, result.fileCount, {
        success: true,
        output_path: result.zipPath,
        resolved_path: result.zipPath,
        message: encrypted
          ? (restorable
            ? '加密全保真 ZIP 导出完成：导入时输入备份密码后可整槽恢复'
            : '加密 ZIP 导出完成：源备份不是完整快照，导入后仍为部分归档')
          : `ZIP 导出完成: ${result.fileCount} 个文件, 压缩率 ${(ratio * 100).toFixed(1)}%（便携归档：不含密钥等敏感数据，导入后不能整槽恢复）`,
        error: null,
        duration_ms: durationMs,
        stats: {
          file_count: result.fileCount, total_size: result.totalSize,
          compressed_size: result.compressedSize, compression_ratio: ratio,
          zip_checksum: result.zipChecksum, encrypted,
          recovery_kind: recoveryKind, restorable,
        },
        requires_restart: false,
        checkpoint_path: null,
        resumable_job_id: null,
      });
    } catch (error) {
      if (job.isCancelled()) { job.cancelled('用户取消 ZIP 导出'); return; }
      const message = `ZIP 导出失败: ${ioMessage(error)}`;
      this.governance.trySaveAuditLog(failAuditLog(withAuditDetails(newAuditLog({
        type: 'Backup', backup_type: 'Full', file_count: 0, total_size: 0,
      }, `zip_export/${backupId}`), { job_id: job.job_id, backup_id: backupId, subtype: 'zip_export' }), message));
      job.fail(message);
    } finally {
      guard.release();
    }
  }

  async importZip(args: {
    zipPath: string;
    backupId?: string | null;
    password?: string | null;
    useStoredCloudEncryptionPassword?: boolean | null;
  }): Promise<BackupJobStartResponse> {
    const requestedBackupId = args.backupId == null ? null : validateBackupId(args.backupId);
    validateUserPath(args.zipPath);
    if (!existsSync(args.zipPath)) {
      throw new Error(`ZIP 文件不存在: ${sanitizePathForUser(args.zipPath, userHomeDir(this.ctx))}。请确认文件路径正确，或重新选择文件`);
    }
    const job = this.jobs.createJob('import');
    this.governance.trySaveAuditLog(withAuditDetails(newAuditLog({
      type: 'Backup', backup_type: 'Full', file_count: 0, total_size: 0,
    }, `zip_import/${requestedBackupId ?? 'auto'}`), {
      job_id: job.job_id, zip_path: args.zipPath, backup_id: requestedBackupId, subtype: 'zip_import',
    }));
    void this.executeImport(job, args.zipPath, requestedBackupId, args.password ?? null,
      args.useStoredCloudEncryptionPassword ?? null, false)
      .catch(error => this.jobs.markFailure(job.job_id, `ZIP 导入失败: ${ioMessage(error)}`));
    return {
      job_id: job.job_id, kind: 'import', status: 'queued',
      message: 'ZIP 导入任务已启动，请通过 backup-job-progress 事件监听进度',
    };
  }

  private async executeImport(
    job: BackupJobContext,
    zipPath: string,
    backupId: string | null,
    explicitPassword: string | null,
    useStored: boolean | null,
    resumable: boolean,
  ): Promise<void> {
    let sealed: boolean;
    try { sealed = await zipContainsEncryptedSecrets(this.ctx, zipPath); }
    catch (error) {
      job.fail(`无法读取 ZIP 文件: ${ioMessage(error)}`);
      return;
    }
    let password: string | null;
    try {
      const stored = (sealed && useStored === true && nonEmptyPassword(explicitPassword) === null)
        ? await storedCloudEncryptionPassword(this.ctx)
        : null;
      password = resolveImportZipPassword(explicitPassword, useStored, stored, sealed);
    } catch (error) {
      job.fail(ioMessage(error));
      return;
    }

    const start = performance.now();
    job.markRunning('queued', 0, WAITING_FOR_OPERATION_MESSAGE, 0, 0);
    let acquired: Awaited<ReturnType<Operations['acquireForJob']>>;
    try { acquired = await this.operations.acquireForJob('zip_import', job.job_id, () => job.isCancelled()); }
    catch (error) { job.fail(`获取全局备份锁失败: ${ioMessage(error)}`); return; }
    if (acquired === 'cancelled') { job.cancelled(OPERATION_QUEUED_CANCELLED_MESSAGE); return; }
    const guard = acquired;
    const root = backupDir(this.ctx.app.dataDir);
    let targetId = backupId ?? importBackupId();
    let targetDir = join(root, targetId);
    let isResuming = false;
    try {
      try { targetId = validateBackupId(targetId); }
      catch (error) { job.fail(`backup_id 非法: ${ioMessage(error)}`); return; }
      targetDir = join(root, targetId);
      const checkpoint = job.getCheckpoint();
      const processedCount = checkpoint
        ? Math.max(checkpoint.current_index, checkpoint.processed_items.length)
        : 0;
      isResuming = checkpoint !== null && (checkpoint.partial_output != null || processedCount > 0);

      if (existsSync(targetDir) && !(resumable && isResuming)) {
        job.fail(`备份已存在: ${targetId}`);
        return;
      }
      mkdirSync(root, { recursive: true });

      job.setParams({
        zip_path: zipPath, backup_id: targetId, include_assets: false, include_checksums: false,
      });
      if (checkpoint === null) job.initCheckpoint(0);
      job.setPartialOutput(targetDir);
      job.updateZipCheckpoint(processedCount, checkpoint?.total_items ?? 0);
      job.markRunning('scan', 0, isResuming ? '从检查点恢复，正在验证 ZIP 文件...' : '正在验证 ZIP 文件...', 0, 0);
      if (job.isCancelled()) { job.cancelled('用户取消导入'); return; }

      const fileCount = await importBackupFromZip(this.ctx, zipPath, targetDir, {
        password,
        skipExisting: resumable,
        onProgress: progress => job.markRunning(
          progress.phase, progress.progress, progress.message, progress.processedFiles, progress.totalFiles,
        ),
        isCancelled: () => job.isCancelled(),
      });
      const durationMs = Math.trunc(performance.now() - start);
      job.markRunning('cleanup', 95, '正在清理临时文件...', fileCount, fileCount);

      let restorable = false;
      try { restorable = classifyRecoveryKind(loadManifest(join(targetDir, 'manifest.json'))).restorable; }
      catch { restorable = false; }
      const recoveryKind = restorable ? 'disaster_recovery' : 'partial_archive';
      this.governance.trySaveAuditLog(completeAuditLog(withAuditDetails(newAuditLog({
        type: 'Backup', backup_type: 'Full', file_count: fileCount, total_size: 0,
      }, `zip_import/${targetId}`), {
        job_id: job.job_id, zip_path: zipPath, backup_id: targetId,
        backup_path: targetDir, file_count: fileCount, subtype: 'zip_import',
      }), durationMs));

      const payload: BackupJobResultPayload = {
        success: true,
        output_path: targetDir,
        resolved_path: null,
        message: `ZIP 导入成功: ${fileCount} 个文件, 备份 ID: ${targetId}${restorable ? '（完整快照，可整槽恢复）' : '（部分归档，不能整槽恢复）'}`,
        error: null,
        duration_ms: durationMs,
        stats: {
          file_count: fileCount, backup_id: targetId, backup_path: targetDir,
          recovery_kind: recoveryKind, restorable,
        },
        requires_restart: false,
        checkpoint_path: null,
        resumable_job_id: null,
      };
      job.complete(`ZIP 导入成功: ${fileCount} 个文件`, fileCount, fileCount, payload);
    } catch (error) {
      if (job.isCancelled()) { job.cancelled('用户取消导入'); return; }
      const message = ioMessage(error);
      this.ctx.logger('backup').error(
        resumable ? `[data_governance] ZIP 导入失败: ${message}` : `[data_governance] ZIP 导入任务失败: ${message}`,
      );
      this.governance.trySaveAuditLog(failAuditLog(withAuditDetails(newAuditLog({
        type: 'Backup', backup_type: 'Full', file_count: 0, total_size: 0,
      }, `zip_import/${targetId}`), {
        job_id: job.job_id, zip_path: zipPath, backup_id: targetId,
        backup_path: targetDir, subtype: 'zip_import',
      }), message));
      // RUST-FIX(RF-W08-zip-import-cleanup-before-failed): Rust 先 fail 再 remove_dir_all，前端看到 failed 时半成品目录可能还在。
      if (!resumable && existsSync(targetDir)) {
        try { await rm(targetDir, { recursive: true, force: true }); }
        catch (cleanupError) { this.ctx.logger('backup').warn(`清理失败的导入目录时出错: ${ioMessage(cleanupError)}`); }
      }
      job.fail(`ZIP 导入失败: ${message}`);
    } finally {
      guard.release();
    }
  }

  async backupAndExportZip(args: {
    outputPath: string;
    compressionLevel?: number | null;
    addToBackupList?: boolean | null;
    useTiered?: boolean | null;
    tiers?: string[] | null;
    includeAssets?: boolean | null;
    assetTypes?: string[] | null;
    encryptionPassword?: string | null;
  }): Promise<BackupJobStartResponse> {
    validateUserPath(args.outputPath);
    const compressionLevel = Math.min(args.compressionLevel ?? 6, 9);
    const addToBackupList = args.addToBackupList ?? true;
    const useTiered = args.useTiered ?? false;
    const job = this.jobs.createJob('export');
    void this.executeBackupAndExport(job, {
      outputPath: args.outputPath, compressionLevel, addToBackupList, useTiered,
      tiers: args.tiers ?? null, includeAssets: args.includeAssets ?? null,
      assetTypes: args.assetTypes ?? null, encryptionPassword: args.encryptionPassword ?? null,
    }).catch(error => this.jobs.markFailure(job.job_id, `备份导出失败: ${ioMessage(error)}`));
    return {
      job_id: job.job_id, kind: 'export', status: 'queued',
      message: '备份导出任务已启动，请通过 backup-job-progress 事件监听进度',
    };
  }

  private async executeBackupAndExport(
    job: BackupJobContext,
    args: {
      outputPath: string; compressionLevel: number; addToBackupList: boolean; useTiered: boolean;
      tiers: string[] | null; includeAssets: boolean | null; assetTypes: string[] | null;
      encryptionPassword: string | null;
    },
  ): Promise<void> {
    const start = performance.now();
    job.markRunning('queued', 0, WAITING_FOR_OPERATION_MESSAGE, 0, 0);
    let acquired: Awaited<ReturnType<Operations['acquireForJob']>>;
    try { acquired = await this.operations.acquireForJob('backup', job.job_id, () => job.isCancelled()); }
    catch (error) { job.fail(`获取全局备份锁失败: ${ioMessage(error)}`); return; }
    if (acquired === 'cancelled') { job.cancelled(OPERATION_QUEUED_CANCELLED_MESSAGE); return; }
    const guard = acquired;
    try {
      const includeAssets = args.includeAssets ?? !args.useTiered;
      job.setParams({
        backup_type: args.useTiered ? 'tiered' : includeAssets ? 'full' : 'database_only',
        include_assets: includeAssets,
        asset_types: args.assetTypes ?? undefined,
        output_path: args.outputPath,
        compression_level: args.compressionLevel,
        include_checksums: true,
      });
      const root = backupDir(this.ctx.app.dataDir);
      if (!existsSync(root)) mkdirSync(root, { recursive: true });
      job.markRunning('scan', 2, '正在准备备份...', 0, 1);
      if (job.isCancelled()) { job.cancelled('用户取消备份导出'); return; }

      let selected: readonly CoordinatedId[] = DATABASE_IDS;
      let backupIdSuffix: string | undefined;
      let missingStyle: 'full' | 'tiered' = 'full';
      if (args.useTiered) {
        const parsedTiers = (args.tiers ?? ['core']).map(tier => tier.toLowerCase()).filter(tier => {
          if (['core', 'important', 'rebuildable', 'large_assets', 'largeassets'].includes(tier)) return true;
          this.ctx.logger('backup').warn(`[data_governance] 未知分层备份层级: ${tier}`);
          return false;
        });
        if (parsedTiers.length === 0) { job.fail('分层备份至少需要一个有效层级'); return; }
        selected = DATABASE_IDS.filter(id =>
          parsedTiers.some(tier => (tier === 'core' && (id === 'chat_v2' || id === 'vfs' || id === 'mistakes'))
            || (tier === 'important' && id === 'llm_usage')));
        backupIdSuffix = 'tiered';
        missingStyle = 'tiered';
      }

      job.markRunning('checkpoint', 15, '正在执行数据库 checkpoint...', 0, selected.length);
      // Rust commands_zip.rs:427-516：屏障覆盖数据库/资产 staging，释放失败优先于备份结果。
      let barrier;
      try { barrier = await this.operations.enterSnapshotBarrier(); }
      catch (error) { job.fail(`无法建立一致备份快照: ${ioMessage(error)}`); return; }
      let manifest: BackupManifest | null = null;
      let backupFailure: unknown = null;
      try {
        manifest = await createBackup(this.context(), {
          includeAssets,
          assetTypes: args.assetTypes,
          selectedDatabases: selected,
          backupIdSuffix,
          missingDatabaseStyle: missingStyle,
          ...(includeAssets && args.assetTypes === null
            ? { assetOptions: { max_file_size: Number.MAX_SAFE_INTEGER, max_total_size: Number.MAX_SAFE_INTEGER } }
            : {}),
          onProgress: (phase, message, processed, total) =>
            job.markRunning(phase === 'verify' ? 'verify' : 'checkpoint', phase === 'verify' ? 80 : 30, message, processed, total),
          checkContinue: () => job.checkContinue(),
        });
      } catch (error) { backupFailure = error; }
      let releaseFailure: unknown = null;
      try { barrier.release(); } catch (error) { releaseFailure = error; }
      if (releaseFailure !== null) { job.fail(ioMessage(releaseFailure)); return; }
      if (backupFailure !== null) throw backupFailure;
      if (manifest === null) throw new Error('备份并导出未生成清单');
      if (job.isCancelled()) { job.cancelled('用户取消备份导出'); return; }

      job.markRunning('compress', 62, '正在压缩 ZIP 文件...', 0, 1);
      const zipPath = args.outputPath;
      mkdirSync(dirname(zipPath), { recursive: true });
      const result = await exportBackupToZip(this.ctx, join(root, manifest.backup_id), {
        compressionLevel: args.compressionLevel,
        outputPath: zipPath,
        includeChecksums: true,
        encryptionPassword: args.encryptionPassword,
      }, progress => {
        job.markRunning('compress', 62 + (progress.progress / 100) * 33,
          progress.message, progress.processedFiles, progress.totalFiles);
      }, () => job.isCancelled());

      let restorable = false;
      if (args.encryptionPassword !== null) {
        try { restorable = classifyRecoveryKind(manifest).restorable; }
        catch { restorable = false; }
      }
      const recoveryKind = restorable ? 'disaster_recovery' : 'partial_archive';
      job.markRunning('cleanup', 98, '正在完成导出...', 1, 1);

      if (!args.addToBackupList) {
        try { await deleteBackup(root, manifest.backup_id); }
        catch (error) { this.ctx.logger('backup').warn(`备份已导出但清理中间目录失败: ${manifest.backup_id} - ${ioMessage(error)}`); }
      }

      const durationMs = Math.trunc(performance.now() - start);
      const ratio = result.totalSize === 0 ? 0 : 1 - result.compressedSize / result.totalSize;
      const payload: BackupJobResultPayload = {
        success: true,
        output_path: result.zipPath,
        resolved_path: null,
        message: `备份并导出完成: ${result.fileCount} 个文件，${result.compressedSize} 字节${restorable ? '（加密全保真 ZIP：导入时输入备份密码后可整槽恢复）' : '（便携归档：不含密钥等敏感数据，导入后不能整槽恢复）'}`,
        error: null,
        duration_ms: durationMs,
        stats: {
          backup_id: manifest.backup_id,
          zip_path: result.zipPath,
          compression_level: args.compressionLevel,
          compression_ratio: ratio,
          add_to_backup_list: args.addToBackupList,
          use_tiered: args.useTiered,
          include_assets: includeAssets,
          encrypted: args.encryptionPassword !== null,
          recovery_kind: recoveryKind,
          restorable,
        },
        requires_restart: false,
        checkpoint_path: null,
        resumable_job_id: null,
      };
      job.complete('备份并导出 ZIP 完成', 1, 1, payload);
    } catch (error) {
      if (job.isCancelled()) { job.cancelled('用户取消备份导出'); return; }
      job.fail(`备份导出失败: ${ioMessage(error)}`);
    } finally {
      guard.release();
    }
  }

  async resumeBackupJob(args: { jobId: string; password?: string | null }): Promise<BackupJobStartResponse> {
    const persisted = this.jobs.loadPersistedJobs().find(job => job.job_id === args.jobId);
    if (!persisted) throw new Error(`未找到可恢复的任务: ${args.jobId}`);
    if (persisted.status !== 'failed') {
      throw new Error(`任务状态为 ${persisted.status}，仅失败状态的任务可恢复。请等待任务完成或创建新任务`);
    }
    if (!persisted.checkpoint) throw new Error('任务没有检查点信息，无法恢复。请创建新的备份任务重试');

    if (persisted.kind === 'export') return this.backupCommands.resumeExportJob(persisted);

    let params: BackupJobParams;
    try {
      params = parseJobParams(persisted.params);
    } catch {
      params = { include_assets: false, include_checksums: false };
    }
    if (typeof params.zip_path !== 'string') throw new Error('导入任务缺少 ZIP 路径参数');
    const zipPath = params.zip_path;
    if (!existsSync(zipPath)) {
      throw new Error(`ZIP 文件不存在: ${sanitizePathForUser(zipPath, userHomeDir(this.ctx))}。请确认文件路径正确，或重新选择文件`);
    }
    const restored = this.jobs.restoreJobFromPersisted(persisted);
    void this.executeImport(restored, zipPath, params.backup_id ?? null,
      args.password ?? null, null, true)
      .catch(error => this.jobs.markFailure(restored.job_id, `ZIP 导入失败: ${ioMessage(error)}`));
    return {
      job_id: restored.job_id, kind: 'import', status: 'queued',
      message: '导入任务已恢复，将从断点继续解压',
    };
  }
}
