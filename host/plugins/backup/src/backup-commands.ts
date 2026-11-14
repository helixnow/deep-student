import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { getAvailableDiskSpace } from '../../../platform/storage/backup-common.ts';
import { dirname, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type {
  AutoVerifyResponse, BackupInfoResponse, BackupJobStartResponse, BackupVerifyResponse,
  BackupVerifyWithAssetsResponse, DatabaseVerifyStatus, DiskSpaceCheckResponse,
} from '../../../../contracts/ipc/generated/L21-backup-governance.ts';
import type { Jobs } from './jobs.ts';
import {
  OPERATION_QUEUED_CANCELLED_MESSAGE, WAITING_FOR_OPERATION_MESSAGE, type Operations,
} from './operations.ts';
import type { Governance } from './governance.ts';
import {
  backupInfo, createBackup, deleteBackup, findBackup, listBackups, verifyWithAssets,
  type BackupContext,
} from './backup-manager.ts';
import {
  INCREMENTAL_BACKUP_REMOVED_MESSAGE, classifyRecoveryKind, validateForSlotRestore,
  type BackupManifest,
} from './manifest.ts';
import {
  BACKUP_DIR_MISSING_CODE, backupDir, backupDirMissingError, checkedRestoreDiskBudget,
  ensureExistingPathWithinBackupDir, sanitizePathForUser, userHomeDir, validateBackupId,
} from './paths.ts';
import { completeAuditLog, failAuditLog, newAuditLog, withAuditDetails } from '../repository/audit.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import { ioMessage } from './io.ts';
import type { BackupJobContext, BackupJobResultPayload, PersistedJob } from '../api.ts';
import { DATABASE_IDS } from './migrations.ts';

export interface BackupCommandsOptions {
  readonly ctx: Context;
  readonly jobs: Jobs;
  readonly operations: Operations;
  readonly governance: Governance;
}

export class BackupCommands {
  readonly ctx: Context;
  readonly jobs: Jobs;
  readonly operations: Operations;
  readonly governance: Governance;

  constructor(options: BackupCommandsOptions) {
    this.ctx = options.ctx;
    this.jobs = options.jobs;
    this.operations = options.operations;
    this.governance = options.governance;
  }

  context(): BackupContext {
    return {
      ctx: this.ctx,
      backupRoot: backupDir(this.ctx.app.dataDir),
      activeDir: this.ctx.storage.locations.activeDir,
      baseDir: this.ctx.app.dataDir,
    };
  }

  getBackupList(): BackupInfoResponse[] {
    const root = backupDir(this.ctx.app.dataDir);
    if (!existsSync(root)) return [];
    try {
      return listBackups(root, message => this.ctx.logger('backup').warn(message)).map(backupInfo);
    } catch (e) {
      this.ctx.logger('backup').error(`[data_governance] 获取备份列表失败: ${ioMessage(e)}`);
      throw new Error(`获取备份列表失败: ${ioMessage(e)}`);
    }
  }

  async deleteBackup(backupId: string): Promise<boolean> {
    const id = validateBackupId(backupId);
    const guard = await this.operations.acquire('backup');
    try {
      const root = backupDir(this.ctx.app.dataDir);
      if (!existsSync(root)) throw new Error(backupDirMissingError());
      const target = join(root, id);
      if (existsSync(target)) ensureExistingPathWithinBackupDir(target, root, userHomeDir(this.ctx));
      try { await deleteBackup(root, id); }
      catch (e) {
        this.ctx.logger('backup').error(`[data_governance] 删除备份失败: ${ioMessage(e)}`);
        throw new Error(`删除备份失败: ${ioMessage(e)}`);
      }
      return true;
    } finally {
      guard.release();
    }
  }

  checkDiskSpace(backupId: string): DiskSpaceCheckResponse {
    const id = validateBackupId(backupId);
    const root = backupDir(this.ctx.app.dataDir);
    if (!existsSync(root)) throw new Error(backupDirMissingError());
    // Rust commands_backup.rs:1339-1348：列表失败记 error 并加前缀，再按 ID 查找。
    let manifests: BackupManifest[];
    try { manifests = listBackups(root, message => this.ctx.logger('backup').warn(message)); }
    catch (e) {
      this.ctx.logger('backup').error(`[data_governance] 获取备份列表失败: ${ioMessage(e)}`);
      throw new Error(`获取备份列表失败: ${ioMessage(e)}`);
    }
    const manifest = manifests.find(candidate => candidate.backup_id === id);
    if (manifest === undefined) throw new Error(`未找到备份: ${id}`);
    const assetSize = manifest.assets?.total_size ?? 0;
    const { backupSize, requiredBytes } = checkedRestoreDiskBudget(manifest.files.map(file => file.size), assetSize);
    const inactiveDir = this.inactiveSlotDir();
    if (!existsSync(inactiveDir) || !statSync(inactiveDir).isDirectory()) {
      throw new Error(`恢复目标槽目录不存在或不是目录，无法确定目标卷: ${sanitizePathForUser(inactiveDir, userHomeDir(this.ctx))}`);
    }
    let targetDir: string;
    try { targetDir = realpathSync(inactiveDir); }
    catch (e) { throw new Error(`解析恢复目标卷失败: ${ioMessage(e)}`); }
    // Rust commands_backup.rs:1373-1376：statvfs → df 回退 → fail-close，失败记 error。
    let available: number;
    try { available = getAvailableDiskSpace(targetDir); }
    catch (e) {
      this.ctx.logger('backup').error(`[data_governance] 获取可用磁盘空间失败: ${ioMessage(e)}`);
      throw new Error(`获取可用磁盘空间失败: ${ioMessage(e)}`);
    }
    const hasEnoughSpace = BigInt(available) >= requiredBytes;
    this.ctx.logger('backup').info(
      `[data_governance] 磁盘空间检查: backup_size=${backupSize}, required=${requiredBytes}, available=${available}, enough=${hasEnoughSpace}`,
    );
    return {
      has_enough_space: hasEnoughSpace,
      available_bytes: available,
      required_bytes: Number(requiredBytes),
      backup_size: Number(backupSize),
    };
  }

  private inactiveSlotDir(): string {
    const active = this.ctx.storage.locations.activeDir;
    const slot = this.ctx.storage.locations.activeSlot;
    const other = slot === 'slotA' ? 'slotB' : 'slotA';
    return join(dirname(active), other);
  }

  async verifyBackup(backupId: string): Promise<BackupVerifyResponse> {
    const id = validateBackupId(backupId);
    const root = backupDir(this.ctx.app.dataDir);
    if (!existsSync(root)) throw new Error(backupDirMissingError());
    const guard = await this.acquireVerifyGuard();
    try {
      const manifest = findBackup(root, id, '备份不存在', message => this.ctx.logger('backup').warn(message));
      ensureExistingPathWithinBackupDir(join(root, manifest.backup_id), root, userHomeDir(this.ctx));
      try {
        return this.buildVerifyResponse(manifest, await verifyWithAssets(this.ctx, root, manifest));
      } catch (e) {
        return this.buildVerifyResponse(manifest, {
          isValid: false, databaseErrors: [ioMessage(e)], assetErrors: [],
        });
      }
    } finally {
      guard.release();
    }
  }

  private buildVerifyResponse(manifest: BackupManifest, result: { isValid: boolean; databaseErrors: string[]; assetErrors: { path: string; message: string }[] }): BackupVerifyResponse {
    const errors = [...result.databaseErrors];
    const checksumMatch = result.databaseErrors.length === 0;
    for (const asset of result.assetErrors) errors.push(`资产校验失败 [${asset.path}]: ${asset.message}`);
    const databasesVerified: DatabaseVerifyStatus[] = manifest.files
      .flatMap(file => file.database_id == null ? [] : [{
        id: file.database_id,
        is_valid: result.isValid,
        error: result.isValid ? null : '校验失败',
      }]);
    return { is_valid: result.isValid, checksum_match: checksumMatch, databases_verified: databasesVerified, errors };
  }

  async verifyBackupWithAssets(backupId: string): Promise<BackupVerifyWithAssetsResponse> {
    const id = validateBackupId(backupId);
    const root = backupDir(this.ctx.app.dataDir);
    if (!existsSync(root)) {
      throw new Error('备份目录不存在。请前往「设置 > 数据治理 > 备份」检查备份目录配置');
    }
    const guard = await this.acquireVerifyGuard();
    try {
      const manifest = findBackup(root, id, '备份不存在', message => this.ctx.logger('backup').warn(message));
      // Rust commands_asset.rs 使用 app_data_dir/backups 作为边界根（而非 recovery/backups）。
      const legacyRoot = join(this.ctx.app.dataDir, 'backups');
      ensureExistingPathWithinBackupDir(join(legacyRoot, manifest.backup_id), legacyRoot, userHomeDir(this.ctx));
      const result = await verifyWithAssets(this.ctx, root, manifest);
      return {
      is_valid: result.isValid,
      database_errors: result.databaseErrors,
      asset_errors: result.assetErrors.map(error => ({
        path: error.path, error_type: error.error_type, message: error.message,
      })),
        has_assets: manifest.assets !== undefined,
        asset_file_count: manifest.assets?.total_files ?? 0,
      };
    } finally {
      guard.release();
    }
  }

  private async acquireVerifyGuard() {
    try { return await this.operations.acquire('verify'); }
    catch (e) { throw new Error(`获取全局备份锁失败: ${ioMessage(e)}`); }
  }

  async autoVerifyLatest(): Promise<AutoVerifyResponse> {
    const root = backupDir(this.ctx.app.dataDir);
    if (!existsSync(root)) {
      throw new Error(`[${BACKUP_DIR_MISSING_CODE}] 备份目录不存在，无法执行自动验证。请前往「设置 > 数据治理 > 备份」检查备份目录配置`);
    }
    // Rust commands_backup.rs:1512-1531：先取全局锁，再列出/选择最新备份，
    // 并一直持有到验证、审计写入和返回，避免选中的备份被并发删除/替换。
    const guard = await this.acquireVerifyGuard();
    try {
      let manifests: BackupManifest[];
      try { manifests = listBackups(root, message => this.ctx.logger('backup').warn(message)); }
      catch (e) { throw new Error(`获取备份列表失败: ${ioMessage(e)}`); }
      if (manifests.length === 0) throw new Error('没有可用的备份，无法执行自动验证。请先创建一个备份');
      const latest = manifests.reduce((best, candidate) => candidate.created_at > best.created_at ? candidate : best);
      const verifiedAt = toRfc3339();
      const start = performance.now();
      let result: { isValid: boolean; databaseErrors: string[]; assetErrors: { path: string; message: string }[] };
      try {
        result = await verifyWithAssets(this.ctx, root, latest);
      } catch (e) {
        result = { isValid: false, databaseErrors: [ioMessage(e)], assetErrors: [] };
      }
      const durationMs = Math.trunc(performance.now() - start);
      const errors = [...result.databaseErrors];
      for (const asset of result.assetErrors) errors.push(`资产校验失败 [${asset.path}]: ${asset.message}`);
      const databasesVerified: DatabaseVerifyStatus[] = latest.files
        .flatMap(file => file.database_id == null ? [] : [{
          id: file.database_id, is_valid: result.isValid, error: result.isValid ? null : '校验失败',
        }]);
      const autoVerifySize = latest.files.reduce((sum, file) => sum + file.size, 0) + (latest.assets?.total_size ?? 0);
      const log = withAuditDetails(newAuditLog({
        type: 'Backup', backup_type: 'Auto', file_count: latest.files.length, total_size: autoVerifySize,
      }, `auto_verify/${latest.backup_id}`), {
        action: 'auto_verify', backup_id: latest.backup_id, is_valid: result.isValid,
        databases_verified: databasesVerified.length, errors, duration_ms: durationMs,
      });
      this.governance.trySaveAuditLog(result.isValid ? completeAuditLog(log, durationMs) : failAuditLog(log, errors.join('; ')));
      return {
        backup_id: latest.backup_id, is_valid: result.isValid, verified_at: verifiedAt,
        duration_ms: durationMs, databases_verified: databasesVerified, errors,
      };
    } finally {
      guard.release();
    }
  }

  runBackup(args: {
    backupType?: string | null; baseVersion?: string | null;
    includeAssets?: boolean | null; assetTypes?: string[] | null;
  }): BackupJobStartResponse {
    const backupType = args.backupType ?? 'full';
    if (backupType === 'incremental') throw new Error(INCREMENTAL_BACKUP_REMOVED_MESSAGE);
    const includeAssets = args.includeAssets ?? true;
    const job = this.jobs.createJob('export');
    this.governance.trySaveAuditLog(withAuditDetails(newAuditLog({
      type: 'Backup', backup_type: 'Full', file_count: 0, total_size: 0,
    }, `governance_backup/${backupType}`), {
      job_id: job.job_id, backup_type: backupType, base_version: args.baseVersion ?? null,
      include_assets: includeAssets, asset_types: args.assetTypes ?? null,
    }));
    void this.executeBackup(job, backupType, args.baseVersion ?? null, includeAssets, args.assetTypes ?? null)
      .catch(e => this.jobs.markFailure(job.job_id, `备份失败: ${ioMessage(e)}`));
    return {
      job_id: job.job_id, kind: 'export', status: 'queued',
      message: '备份任务已启动，请通过 backup-job-progress 事件监听进度',
    };
  }

  private async executeBackup(
    job: BackupJobContext, backupType: string, baseVersion: string | null,
    includeAssets: boolean, assetTypes: string[] | null,
  ): Promise<void> {
    const start = performance.now();
    job.markRunning('queued', 0, WAITING_FOR_OPERATION_MESSAGE, 0, 0);
    let acquired: Awaited<ReturnType<Operations['acquireForJob']>>;
    try { acquired = await this.operations.acquireForJob('backup', job.job_id, () => job.isCancelled()); }
    catch (error) { job.fail(`获取全局备份锁失败: ${ioMessage(error)}`); return; }
    if (acquired === 'cancelled') { job.cancelled(OPERATION_QUEUED_CANCELLED_MESSAGE); return; }
    const guard = acquired;
    try {
      if (backupType === 'incremental') { job.fail(INCREMENTAL_BACKUP_REMOVED_MESSAGE); return; }
      job.setParams({
        backup_type: backupType, base_version: baseVersion ?? undefined, include_assets: includeAssets,
        asset_types: assetTypes ?? undefined, include_checksums: true,
      });
      job.initCheckpoint(4);
      const root = backupDir(this.ctx.app.dataDir);
      try { if (!existsSync(root)) mkdirSync(root, { recursive: true }); }
      catch (e) { job.fail(`创建备份目录失败: ${ioMessage(e)}`); return; }
      job.markRunning('scan', 5, '正在准备备份...', 0, 4);
      if (job.isCancelled()) { job.cancelled('用户取消备份'); return; }
      job.markRunning('checkpoint', 10, '正在执行数据库 checkpoint...', 0, 4);
      if (job.isCancelled()) { job.cancelled('用户取消备份'); return; }

      const allAssetTypes = assetTypes === null || assetTypes.length === 0
        || assetTypes.every(type => !defaultTypes().includes(type));
      // Rust commands_backup.rs:2003-2018：屏障覆盖整个 staging（数据库 + 资产），
      // 释放失败优先于备份结果错误。
      let barrier;
      try { barrier = await this.operations.enterSnapshotBarrier(); }
      catch (e) { job.fail(`无法建立一致备份快照: ${ioMessage(e)}`); return; }
      let manifest: BackupManifest | null = null;
      let backupFailure: unknown = null;
      try {
        manifest = await createBackup(this.context(), {
          includeAssets,
          assetTypes,
          ...(includeAssets && allAssetTypes ? { assetOptions: { max_file_size: Number.MAX_SAFE_INTEGER, max_total_size: Number.MAX_SAFE_INTEGER } } : {}),
          onProgress: (phase, message, processed, total) => job.markRunning(phase, phase === 'verify' ? 80 : 30, message, processed, total),
          checkContinue: () => job.checkContinue(),
        });
      } catch (e) { backupFailure = e; }
      let releaseFailure: unknown = null;
      try { barrier.release(); } catch (e) { releaseFailure = e; }
      if (releaseFailure !== null) { job.fail(ioMessage(releaseFailure)); return; }
      if (backupFailure !== null) throw backupFailure;
      if (manifest === null) throw new Error('备份未生成清单');
      // Rust commands_backup.rs:2040-2046：请求包含资产的备份必须满足可槽恢复契约。
      if (includeAssets) validateForSlotRestore(manifest);
      if (job.isCancelled()) { job.cancelled('用户取消备份'); return; }
      job.markRunning('verify', 80, '正在验证备份...', 3, 4);

      const assetSize = manifest.assets?.total_size ?? 0;
      const { backupSize } = checkedRestoreDiskBudget(manifest.files.map(file => file.size), assetSize);
      const dbSize = backupSize - BigInt(assetSize);
      const classification = classifyRecoveryKind(manifest);
      const databasesBackedUp = manifest.files.flatMap(file => file.database_id == null ? [] : [file.database_id]);
      const durationMs = Math.trunc(performance.now() - start);
      const assetFiles = manifest.assets?.total_files ?? 0;
      this.governance.trySaveAuditLog(withAuditDetails(completeAuditLog(newAuditLog({
        type: 'Backup', backup_type: 'Full', file_count: manifest.files.length + assetFiles, total_size: Number(backupSize),
      }, manifest.backup_id), durationMs), {
        job_id: job.job_id, backup_type: backupType, include_assets: includeAssets,
        db_files: manifest.files.length, asset_files: assetFiles,
        db_size: Number(dbSize), asset_size: assetSize,
      }));

      const verification = await verifyWithAssets(this.ctx, root, manifest);
      const verifyErrors = [...verification.databaseErrors];
      for (const asset of verification.assetErrors) verifyErrors.push(`资产校验失败 [${asset.path}]: ${asset.message}`);
      this.governance.trySaveAuditLog(completeAuditLog(withAuditDetails(newAuditLog({
        type: 'Backup', backup_type: 'Auto', file_count: manifest.files.length, total_size: Number(backupSize),
      }, `post_backup_verify/${manifest.backup_id}`), {
        action: 'post_backup_auto_verify', backup_id: manifest.backup_id,
        is_valid: verification.isValid, errors: verifyErrors,
      }), Math.trunc(performance.now() - start)));

      const result: BackupJobResultPayload = {
        success: verification.isValid,
        output_path: manifest.backup_id,
        resolved_path: null,
        message: `备份完成: ${databasesBackedUp.length} 个数据库, ${backupSize} 字节`,
        error: verification.isValid ? null : '备份完成但校验失败，请在审计页查看详情并重新执行备份。',
        duration_ms: durationMs,
        stats: {
          databases_backed_up: databasesBackedUp,
          backup_size: Number(backupSize),
          db_files: manifest.files.length,
          asset_files: assetFiles,
          recovery_kind: classification.kind,
          restorable: classification.restorable,
          auto_verify: { is_valid: verification.isValid, errors: verifyErrors },
        },
        requires_restart: false,
        checkpoint_path: null,
        resumable_job_id: null,
      };
      job.complete(`备份完成: ${manifest.backup_id}`, databasesBackedUp.length, databasesBackedUp.length, result);
    } catch (e) {
      if (job.isCancelled()) { job.cancelled('用户取消备份'); return; }
      const message = ioMessage(e);
      this.governance.trySaveAuditLog(failAuditLog(withAuditDetails(newAuditLog({
        type: 'Backup', backup_type: 'Full', file_count: 0, total_size: 0,
      }, `governance_backup/${backupType}`), {
        job_id: job.job_id, backup_type: backupType, include_assets: includeAssets,
      }), message));
      job.fail(`备份失败: ${message}`);
    } finally {
      guard.release();
    }
  }

  /** `data_governance_resume_backup_job` 的 Export 分支。 */
  resumeExportJob(job: PersistedJob): BackupJobStartResponse {
    const restored = this.jobs.restoreJobFromPersisted(job);
    let params: Record<string, unknown> = {};
    if (job.params && typeof job.params === 'object' && !Array.isArray(job.params)) {
      params = job.params as Record<string, unknown>;
    }
    const backupType = typeof params.backup_type === 'string' ? params.backup_type : 'full';
    const baseVersion = typeof params.base_version === 'string' ? params.base_version : null;
    const includeAssets = params.include_assets === true;
    const assetTypes = Array.isArray(params.asset_types) ? params.asset_types.map(String) : null;
    void this.executeBackup(restored, backupType, baseVersion, includeAssets, assetTypes)
      .catch(e => this.jobs.markFailure(restored.job_id, `备份失败: ${ioMessage(e)}`));
    return {
      job_id: restored.job_id, kind: 'export', status: 'queued',
      message: '备份任务已恢复，将使用相同参数重新执行',
    };
  }

  backupTiered(args: {
    tiers?: string[] | null; includeDatabases?: string[] | null; excludeDatabases?: string[] | null;
    includeAssets?: boolean | null; maxAssetSize?: number | null; assetTypes?: string[] | null;
  }): BackupJobStartResponse {
    const job = this.jobs.createJob('export');
    this.governance.trySaveAuditLog(withAuditDetails(newAuditLog({
      type: 'Backup', backup_type: 'Full', file_count: 0, total_size: 0,
    }, 'governance_backup/tiered'), {
      job_id: job.job_id, tiers: args.tiers ?? null,
      include_databases: args.includeDatabases ?? null, exclude_databases: args.excludeDatabases ?? null,
      include_assets: args.includeAssets ?? false, max_asset_size: args.maxAssetSize ?? null,
    }));
    void this.executeTiered(job, args).catch(e => this.jobs.markFailure(job.job_id, `分层备份失败: ${ioMessage(e)}`));
    return {
      job_id: job.job_id, kind: 'export', status: 'queued',
      message: '分层备份任务已启动，请通过 backup-job-progress 事件监听进度',
    };
  }

  private async executeTiered(job: BackupJobContext, args: {
    tiers?: string[] | null; includeDatabases?: string[] | null; excludeDatabases?: string[] | null;
    includeAssets?: boolean | null; maxAssetSize?: number | null; assetTypes?: string[] | null;
  }): Promise<void> {
    const start = performance.now();
    job.markRunning('queued', 0, WAITING_FOR_OPERATION_MESSAGE, 0, 0);
    let acquired: Awaited<ReturnType<Operations['acquireForJob']>>;
    try { acquired = await this.operations.acquireForJob('backup', job.job_id, () => job.isCancelled()); }
    catch (error) { job.fail(`获取全局备份锁失败: ${ioMessage(error)}`); return; }
    if (acquired === 'cancelled') { job.cancelled(OPERATION_QUEUED_CANCELLED_MESSAGE); return; }
    const guard = acquired;
    try {
      const parsedTiers = (args.tiers ?? ['core']).map(tier => tier.toLowerCase()).filter(tier =>
        ['core', 'important', 'rebuildable', 'large_assets', 'largeassets'].includes(tier));
      const includeDatabases = args.includeDatabases ?? [];
      const excludeDatabases = args.excludeDatabases ?? [];
      const selected = DATABASE_IDS.filter(id => {
        if (excludeDatabases.includes(id)) return false;
        if (includeDatabases.includes(id)) return true;
        if (parsedTiers.length === 0) return id === 'chat_v2' || id === 'vfs' || id === 'mistakes';
        return parsedTiers.some(tier => (tier === 'core' && (id === 'chat_v2' || id === 'vfs' || id === 'mistakes'))
          || (tier === 'important' && id === 'llm_usage'));
      });
      const includeAssets = args.includeAssets ?? false;
      const totalDatabases = selected.length;
      job.markRunning('scan', 5, '正在扫描数据库和资产...', 0, 0);
      if (job.isCancelled()) { job.cancelled('用户取消备份'); return; }
      job.markRunning('checkpoint', 15, '正在执行数据库 checkpoint...', 0, totalDatabases);
      if (job.isCancelled()) { job.cancelled('用户取消备份'); return; }
      job.markRunning('compress', 20, '一致性屏障内：正在 staging 分层数据并计算哈希...', 0, totalDatabases);

      // Rust commands_backup.rs:2807-2818：分层 staging 同样在屏障内完成。
      let barrier;
      try { barrier = await this.operations.enterSnapshotBarrier(); }
      catch (e) { job.fail(`无法建立一致备份快照: ${ioMessage(e)}`); return; }
      let manifest: BackupManifest | null = null;
      let backupFailure: unknown = null;
      try {
        manifest = await createBackup(this.context(), {
          includeAssets,
          assetTypes: args.assetTypes ?? null,
          selectedDatabases: selected,
          backupIdSuffix: 'tiered',
          missingDatabaseStyle: 'tiered',
          ...(includeAssets && args.maxAssetSize != null ? { assetOptions: { max_file_size: args.maxAssetSize } } : {}),
          onProgress: (phase, message, processed, total) => job.markRunning(phase, phase === 'verify' ? 95 : 30, message, processed, total),
          checkContinue: () => job.checkContinue(),
        });
      } catch (e) { backupFailure = e; }
      let releaseFailure: unknown = null;
      try { barrier.release(); } catch (e) { releaseFailure = e; }
      if (releaseFailure !== null) { job.fail(ioMessage(releaseFailure)); return; }
      if (backupFailure !== null) throw backupFailure;
      if (manifest === null) throw new Error('分层备份未生成清单');
      if (job.isCancelled()) { job.cancelled('用户取消备份'); return; }
      if (includeAssets) job.markRunning('compress', 90, '正在备份资产文件...', totalDatabases, totalDatabases);
      job.markRunning('verify', 95, '正在验证备份...', totalDatabases, totalDatabases);
      if (job.isCancelled()) { job.cancelled('用户取消备份'); return; }

      const assetSize = manifest.assets?.total_size ?? 0;
      const { backupSize } = checkedRestoreDiskBudget(manifest.files.map(file => file.size), assetSize);
      const classification = classifyRecoveryKind(manifest);
      const verification = await verifyWithAssets(this.ctx, backupDir(this.ctx.app.dataDir), manifest);
      const verifyErrors = [...verification.databaseErrors];
      for (const asset of verification.assetErrors) verifyErrors.push(`资产校验失败 [${asset.path}]: ${asset.message}`);
      const durationMs = Math.trunc(performance.now() - start);
      const stats = {
        backup_id: manifest.backup_id,
        backed_up_tiers: parsedTiers,
        tier_file_counts: { [parsedTiers[0] ?? 'Core']: manifest.files.length },
        tier_sizes: { [parsedTiers[0] ?? 'Core']: Number(backupSize) },
        total_files: manifest.files.length,
        total_size: Number(backupSize),
        skipped_files_count: manifest.assets?.skipped_files ?? 0,
        recovery_kind: classification.kind,
        restorable: classification.restorable,
        auto_verify: { is_valid: verification.isValid, errors: verifyErrors },
      };
      const payload: BackupJobResultPayload = {
        success: verification.isValid,
        output_path: join(backupDir(this.ctx.app.dataDir), manifest.backup_id),
        resolved_path: null,
        message: `分层备份完成，共 ${manifest.files.length} 个文件，大小 ${backupSize} 字节`,
        error: verification.isValid ? null : '分层备份完成但校验失败，请在审计页查看详情并重新执行备份。',
        duration_ms: durationMs,
        stats,
        requires_restart: false,
        checkpoint_path: null,
        resumable_job_id: null,
      };
      this.governance.trySaveAuditLog(completeAuditLog(newAuditLog({
        type: 'Backup', backup_type: 'Full', file_count: manifest.files.length, total_size: Number(backupSize),
      }, manifest.backup_id), durationMs));
      job.complete(`分层备份完成: ${manifest.backup_id}，共 ${manifest.files.length} 个文件`, manifest.files.length, manifest.files.length, payload);
    } catch (e) {
      if (job.isCancelled()) { job.cancelled('用户取消备份'); return; }
      const message = ioMessage(e);
      this.governance.trySaveAuditLog(failAuditLog(newAuditLog({
        type: 'Backup', backup_type: 'Full', file_count: 0, total_size: 0,
      }, 'governance_backup/tiered'), message));
      job.fail(`分层备份失败: ${message}`);
    } finally {
      guard.release();
    }
  }
}

function defaultTypes(): string[] {
  return ['images', 'notes_assets', 'documents', 'vfs_blobs', 'subjects', 'workspaces', 'audio', 'videos', 'textbooks', 'pdf_ocr_sessions'];
}
