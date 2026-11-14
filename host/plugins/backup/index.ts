import { Service, type Context } from '@deepseek-ai/cordis';
import { CommandError, definePlugin, type CallContext } from '../../kernel/api.ts';
import type {} from '../../platform/storage/api.ts';
import type {} from '../../platform/settings/api.ts';
import type {} from '../../platform/secrets/api.ts';
import type {} from '../../../electron/api.ts';
import type {} from '../agent-skills/api.ts';
import type { SyncProviderService, RuntimeCloudStorageConfig } from '../sync-providers/api.ts';
import type {
  BackupOperationGuard, BackupService, BackupSyncCommandPorts, DataGovernanceOperationKind,
  GovernanceService,
} from './api.ts';
import { Jobs } from './src/jobs.ts';
import { assetTypes, scanAssets } from './src/assets.ts';
import { Operations, operationTimeoutMessage } from './src/operations.ts';
import { Governance } from './src/governance.ts';
import { BackupCommands } from './src/backup-commands.ts';
import { ZipCommands } from './src/zip-commands.ts';
import { finalizeRestoreActivation, RestoreCommands } from './src/restore-commands.ts';
import {
  createCloudConfigService, hydrateCloudConfig, testConnectionDraft, type CloudConfigDraftArgs,
} from './src/cloud-config.ts';
import type {} from '../../platform/errors/cloud-config-api.ts';
import { initAuditTable } from './repository/audit.ts';
import { cleanupOldBackups } from './src/backup-manager.ts';
import { backupDir } from './src/paths.ts';
import { createSyncCommandPorts } from './src/sync-ports.ts';
import { OperationGuardError } from './src/operation-errors.ts';
import { DataGovernanceToolExecutor } from './src/governance-tool.ts';
import { announceResumableJobs, runDataGovernanceStartup } from './src/startup-events.ts';
import { bindStartupFinalizer } from './src/startup-finalizers.ts';
import { createAutoBackupScheduler } from './src/auto-backup-scheduler.ts';

/** dstu-platform/startup_gate.rs:24；保持 Rust 120 秒启动等待，不是 IPC 通用超时。 */
const STARTUP_READY_WAIT_MS = 120_000;

class Backup extends Service implements BackupService {
  readonly jobs: Jobs;
  private readonly operations: Operations;
  private readonly syncPorts: BackupSyncCommandPorts;
  private readonly commands: BackupCommands;
  constructor(ctx: Context, operations: Operations, syncPorts: BackupSyncCommandPorts, jobs: Jobs, commands: BackupCommands) {
    super(ctx, 'backup');
    this.operations = operations;
    this.syncPorts = syncPorts;
    this.jobs = jobs;
    this.commands = commands;
  }
  getBackupList() { return this.commands.getBackupList(); }
  runBackup(args: Parameters<BackupCommands['runBackup']>[0]) { return this.commands.runBackup(args); }
  async hydrateCloudConfig(config: RuntimeCloudStorageConfig): Promise<void> {
    await hydrateCloudConfig(config, {
      settings: this.ctx.settings,
      secrets: this.ctx.secrets,
      dataDir: this.ctx.app.dataDir,
      warn: message => this.ctx.logger('backup').warn(message),
    });
  }
  async cleanupOldBackups(keepCount: number): Promise<string[]> {
    return cleanupOldBackups(
      backupDir(this.ctx.app.dataDir),
      keepCount,
      message => this.ctx.logger('backup').warn(message),
    );
  }
  tryAcquireOperation(kind: DataGovernanceOperationKind): BackupOperationGuard {
    return this.operations.tryAcquire(kind);
  }
  async acquireOperation(kind: DataGovernanceOperationKind, timeoutMs: number): Promise<BackupOperationGuard> {
    const outcome = await this.operations.acquireWithTimeout(kind, timeoutMs);
    if (outcome === 'timeout') throw new CommandError(operationTimeoutMessage(timeoutMs));
    return outcome;
  }
  syncCommandPorts(): BackupSyncCommandPorts {
    return this.syncPorts;
  }
}
class GovernanceServiceClass extends Service implements GovernanceService {
  readonly impl: Governance;
  private readonly operations: Operations;
  private readonly syncPorts: BackupSyncCommandPorts;
  getAssetTypes() { return assetTypes(); }
  async scanAssets(types?: string[] | null) {
    try { return await scanAssets(this.ctx.storage.locations.activeDir, types); }
    catch (e) { throw new CommandError(`扫描资产失败: ${e instanceof Error ? e.message : String(e)}`); }
  }
  constructor(
    ctx: Context,
    operations: Operations,
    syncPorts: BackupSyncCommandPorts,
  ) {
    super(ctx, 'governance');
    this.operations = operations;
    this.syncPorts = syncPorts;
    this.impl = new Governance({ ctx, operations });
  }
  acquireOperationGuard(kind: DataGovernanceOperationKind): BackupOperationGuard {
    return this.operations.tryAcquire(kind);
  }
  tryAcquireOperationGuard(kind: DataGovernanceOperationKind): BackupOperationGuard {
    return this.operations.tryAcquire(kind);
  }
  async acquireOperation(kind: DataGovernanceOperationKind, timeoutMs: number): Promise<BackupOperationGuard> {
    const outcome = await this.operations.acquireWithTimeout(kind, timeoutMs);
    if (outcome === 'timeout') throw new CommandError(operationTimeoutMessage(timeoutMs));
    return outcome;
  }
  syncCommandPorts(): BackupSyncCommandPorts {
    return this.syncPorts;
  }
}

/** 真正的编程异常继续交给 kernel 记为 panic，不能伪装成业务错误。 */
function isProgrammingError(error: unknown): boolean {
  return error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError
    || error instanceof SyntaxError || error instanceof EvalError || error instanceof URIError;
}

function asCommandError(error: unknown): CommandError {
  if (error instanceof CommandError) return error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return new CommandError(message);
  }
  return new CommandError(error instanceof Error ? error.message : String(error));
}

/**
 * 契约 `error: string` 的命令统一出口：Rust `Result<T, String>` 的 Err 走
 * `CommandError`（前端收到字符串错误），只有未预期的编程异常保持 panic 语义。
 */
function stringErrorCommand<A = Record<string, unknown>, R = unknown>(
  handler: (args: A, call: CallContext) => R | Promise<R>,
): (args: A, call: CallContext) => Promise<R> {
  return async (args: A, call: CallContext) => {
    try {
      return await handler(args, call);
    } catch (error) {
      if (isProgrammingError(error)) throw error;
      // 共享许可错误面向 L23 是 AppError 对象；本 lane 的契约仍是 error: string，
      // 因此在命令出口按原契约取出 Rust Display 文本。
      if (error instanceof OperationGuardError) throw new CommandError(error.message);
      throw asCommandError(error);
    }
  };
}

/**
 * 沙箱迁移测试中途不可取消：插件卸载（或调用方放弃）时命令先以停止原因返回，测试在后台跑完并清空槽目录，
 * 卸载最多再等 `GOVERNANCE_DISPOSE_WAIT_MS`。
 */
function returnOnStop<R>(run: () => Promise<R>): (args: unknown, call: CallContext) => Promise<R> {
  return (_args, { signal }) => {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<R>((resolve, reject) => {
      const onStop = (): void => reject(signal.reason);
      signal.addEventListener('abort', onStop, { once: true });
      run().then(resolve, reject).finally(() => signal.removeEventListener('abort', onStop));
    });
  };
}

export default definePlugin({
  meta: {
    id: 'dstu.backup', lane: 'L21-backup-governance', provides: ['backup', 'governance', 'cloudConfig'],
    platforms: ['desktop'],
    commands: [
      'cloud_config_test_connection_draft',
      'data_governance_auto_verify_latest_backup', 'data_governance_backup_and_export_zip',
      'data_governance_backup_tiered', 'data_governance_cancel_backup',
      'data_governance_check_disk_space_for_restore', 'data_governance_cleanup_audit_logs',
      'data_governance_cleanup_persisted_jobs', 'data_governance_delete_backup',
      'data_governance_export_zip', 'data_governance_get_asset_types',
      'data_governance_get_audit_logs', 'data_governance_get_backup_job',
      'data_governance_get_backup_list', 'data_governance_get_database_status',
      'data_governance_get_maintenance_status', 'data_governance_get_migration_diagnostic_report',
      'data_governance_get_migration_status', 'data_governance_get_schema_registry',
      'data_governance_import_zip', 'data_governance_list_backup_jobs',
      'data_governance_list_resumable_jobs', 'data_governance_purge_all_data',
      'data_governance_restore_backup', 'data_governance_restore_with_assets',
      'data_governance_resume_backup_job', 'data_governance_run_backup',
      'data_governance_run_health_check', 'data_governance_run_slot_c_empty_db_test',
      'data_governance_run_slot_d_clone_db_test', 'data_governance_scan_assets',
      'data_governance_verify_backup', 'data_governance_verify_backup_with_assets',
    ],
  },
  inject: ['storage', 'settings', 'secrets'],
  apply(ctx) {
    const operations = new Operations({ ctx });
    const syncPorts = createSyncCommandPorts(ctx, operations);
    const wrap = stringErrorCommand;
    ctx.provide('cloudConfig', createCloudConfigService({
      settings: ctx.settings,
      secrets: ctx.secrets,
      dataDir: ctx.app.dataDir,
      warn: message => ctx.logger('backup').warn(message),
    }));
    const jobs = new Jobs(ctx);
    const governance = new GovernanceServiceClass(ctx, operations, syncPorts);
    const backupCommands = new BackupCommands({
      ctx, jobs, operations, governance: governance.impl,
    });
    const backup = new Backup(ctx, operations, syncPorts, jobs, backupCommands);
    const zipCommands = new ZipCommands({
      ctx, jobs: backup.jobs, operations, governance: governance.impl, backupCommands,
    });
    const restoreCommands = new RestoreCommands({
      ctx, jobs: backup.jobs, operations, governance: governance.impl, backupCommands,
    });
    // L07按每次注册返回独立disposer；仅由依赖作用域登记，避免root/child的trace proxy导致重复。
    // provider替换或本插件卸载时只撤销本次贡献，不按名称移除其它调用者的登记。
    const governanceExecutor = new DataGovernanceToolExecutor();
    ctx.inject(['agentTools'], child => {
      const registration = child.agentTools.registerToolExecutors([governanceExecutor]);
      child.effect(() => () => registration.dispose());
    });
    let auditWarning: string | null = null;
    try { initAuditTable(ctx.storage.database('audit')); }
    catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.logger('backup').warn(`初始化审计表失败: ${message}`);
      auditWarning = `审计日志初始化失败: ${message}`;
    }
    ctx.commands.register<CloudConfigDraftArgs>('cloud_config_test_connection_draft', args =>
      testConnectionDraft(ctx, args, {
        secrets: ctx.secrets,
        provider: (ctx.reflect.get('syncProvider') as SyncProviderService | undefined) ?? null,
      }));
    ctx.commands.register('data_governance_get_asset_types', wrap(() => governance.getAssetTypes()));
    ctx.commands.register<{ assetTypes: string[] | null }>('data_governance_scan_assets', wrap<{ assetTypes: string[] | null }>(args => governance.scanAssets(args.assetTypes)));
    ctx.commands.register('data_governance_restore_with_assets', wrap(() => {
      throw new CommandError('该旧恢复入口已停用，因为它无法保证完整快照校验和原子槽切换。请调用 data_governance_restore_backup。');
    }));
    ctx.commands.register<{ jobId: string }>('data_governance_cancel_backup', wrap<{ jobId: string }>(args => {
      ctx.logger('backup').info(`[data_governance] 请求取消备份任务: ${args.jobId}`);
      const cancelled = backup.jobs.requestCancel(args.jobId);
      if (cancelled) ctx.logger('backup').info(`[data_governance] 备份任务取消请求已发送: ${args.jobId}`);
      else ctx.logger('backup').warn(`[data_governance] 备份任务取消请求失败（任务可能已完成或不存在）: ${args.jobId}`);
      return cancelled;
    }));
    ctx.commands.register<{ jobId: string }>('data_governance_get_backup_job', wrap<{ jobId: string }>(args => backup.jobs.getJob(args.jobId)));
    ctx.commands.register('data_governance_list_backup_jobs', wrap(() => backup.jobs.listJobs()));
    ctx.commands.register('data_governance_cleanup_persisted_jobs', wrap(() => backup.jobs.cleanupFinishedPersistedJobs()));

    ctx.commands.register('data_governance_get_schema_registry', wrap(() => governance.impl.getSchemaRegistry()));
    ctx.commands.register<{ operationType?: string | null; status?: string | null; limit?: number | null; offset?: number | null }>(
      'data_governance_get_audit_logs',
      wrap<{ operationType?: string | null; status?: string | null; limit?: number | null; offset?: number | null }>(
        args => governance.impl.getAuditLogs(args),
      ),
    );
    ctx.commands.register<{ keepRecent?: number | null; beforeDays?: number | null; confirmationToken: string }>(
      'data_governance_cleanup_audit_logs',
      wrap<{ keepRecent?: number | null; beforeDays?: number | null; confirmationToken: string }>(
        args => governance.impl.cleanupAuditLogs(args),
      ),
    );
    ctx.commands.register('data_governance_get_migration_status', wrap(() => governance.impl.getMigrationStatus()));
    ctx.commands.register('data_governance_run_health_check', wrap(() => governance.impl.runHealthCheck()));
    ctx.commands.register<{ databaseId: string }>('data_governance_get_database_status', wrap<{ databaseId: string }>(args => governance.impl.getDatabaseStatus(args.databaseId)));
    ctx.commands.register('data_governance_get_migration_diagnostic_report', wrap(returnOnStop(() => governance.impl.getMigrationDiagnosticReport())));
    ctx.commands.register('data_governance_get_maintenance_status', wrap(async () => {
      const gate = ctx.get('startupGate');
      if (gate === undefined) throw new CommandError('startupGate 服务尚未安装，无法查询维护状态');
      // Rust commands.rs:434-439：setup 完成后才评估维护状态，避免提前返回伪健康。
      if (!await gate.waitStartupReady(STARTUP_READY_WAIT_MS)) {
        throw new CommandError(`应用启动初始化超时（${STARTUP_READY_WAIT_MS / 1000} 秒），请重启应用`);
      }
      return governance.impl.getMaintenanceStatus();
    }));
    ctx.commands.register('data_governance_run_slot_c_empty_db_test', wrap(returnOnStop(() => governance.impl.runSlotCTest())));
    ctx.commands.register('data_governance_run_slot_d_clone_db_test', wrap(returnOnStop(() => governance.impl.runSlotDTest())));

    ctx.commands.register('data_governance_get_backup_list', wrap(() => backupCommands.getBackupList()));
    ctx.commands.register<{ backupId: string }>('data_governance_delete_backup', wrap<{ backupId: string }>(args => backupCommands.deleteBackup(args.backupId)));
    ctx.commands.register<{ backupId: string }>('data_governance_check_disk_space_for_restore', wrap<{ backupId: string }>(args => backupCommands.checkDiskSpace(args.backupId)));
    ctx.commands.register<{ backupId: string }>('data_governance_verify_backup', wrap<{ backupId: string }>(args => backupCommands.verifyBackup(args.backupId)));
    ctx.commands.register<{ backupId: string }>('data_governance_verify_backup_with_assets', wrap<{ backupId: string }>(args => backupCommands.verifyBackupWithAssets(args.backupId)));
    ctx.commands.register('data_governance_auto_verify_latest_backup', wrap(() => backupCommands.autoVerifyLatest()));
    ctx.commands.register('data_governance_list_resumable_jobs', wrap(() => zipCommands.listResumableJobs()));
    ctx.commands.register<{
      backupType?: string | null; baseVersion?: string | null;
      includeAssets?: boolean | null; assetTypes?: string[] | null;
    }>('data_governance_run_backup', wrap<{
      backupType?: string | null; baseVersion?: string | null;
      includeAssets?: boolean | null; assetTypes?: string[] | null;
    }>(args => backupCommands.runBackup(args)));
    ctx.commands.register<{
      tiers?: string[] | null; includeDatabases?: string[] | null; excludeDatabases?: string[] | null;
      includeAssets?: boolean | null; maxAssetSize?: number | null; assetTypes?: string[] | null;
    }>('data_governance_backup_tiered', wrap<{
      tiers?: string[] | null; includeDatabases?: string[] | null; excludeDatabases?: string[] | null;
      includeAssets?: boolean | null; maxAssetSize?: number | null; assetTypes?: string[] | null;
    }>(args => backupCommands.backupTiered(args)));
    ctx.commands.register<{ jobId: string; password?: string | null }>(
      'data_governance_resume_backup_job',
      wrap<{ jobId: string; password?: string | null }>(args => zipCommands.resumeBackupJob(args)),
    );
    ctx.commands.register<{
      backupId: string; outputPath?: string | null; compressionLevel?: number | null;
      includeChecksums?: boolean | null; encryptionPassword?: string | null;
      useStoredCloudEncryptionPassword?: boolean | null;
    }>('data_governance_export_zip', wrap<{
      backupId: string; outputPath?: string | null; compressionLevel?: number | null;
      includeChecksums?: boolean | null; encryptionPassword?: string | null;
      useStoredCloudEncryptionPassword?: boolean | null;
    }>(args => zipCommands.exportZip(args)));
    ctx.commands.register<{
      zipPath: string; backupId?: string | null; password?: string | null;
      useStoredCloudEncryptionPassword?: boolean | null;
    }>('data_governance_import_zip', wrap<{
      zipPath: string; backupId?: string | null; password?: string | null;
      useStoredCloudEncryptionPassword?: boolean | null;
    }>(args => zipCommands.importZip(args)));
    ctx.commands.register<{
      outputPath: string; compressionLevel?: number | null; addToBackupList?: boolean | null;
      useTiered?: boolean | null; tiers?: string[] | null; includeAssets?: boolean | null;
      assetTypes?: string[] | null; encryptionPassword?: string | null;
    }>('data_governance_backup_and_export_zip', wrap<{
      outputPath: string; compressionLevel?: number | null; addToBackupList?: boolean | null;
      useTiered?: boolean | null; tiers?: string[] | null; includeAssets?: boolean | null;
      assetTypes?: string[] | null; encryptionPassword?: string | null;
    }>(args => zipCommands.backupAndExportZip(args)));
    ctx.commands.register<{ backupId: string; restoreAssets?: boolean | null }>(
      'data_governance_restore_backup',
      wrap<{ backupId: string; restoreAssets?: boolean | null }>(args => restoreCommands.restoreBackup(args)),
    );
    ctx.commands.register('data_governance_purge_all_data', wrap(() => restoreCommands.purgeAllData()));
    // D2 / lib.rs:1169：迁移完成、全部业务插件可用后，由 F1/F3 组合根执行，随后才标记 ready。
    // 注册放在 apply 最后；不硬注入 sync/paths，也不在注册期间提前执行恢复收尾。
    // lib.rs:1098-1419：迁移状态事件、恢复激活与失败后的维护屏障；失败载荷代替启动失败。
    // 卸载即解绑、重装不重复登记、晚装跳过（V09-P1-3，见 src/startup-finalizers.ts）。
    bindStartupFinalizer(ctx, 'backup.restore-activation', () => runDataGovernanceStartup(
      ctx, governance.impl, operations, auditWarning,
      () => finalizeRestoreActivation(ctx, ctx.storage.locations.activeDir),
    ));
    bindStartupFinalizer(ctx, 'backup.resumable-jobs', () => announceResumableJobs(ctx, backup.jobs), {
      after: ['backup.restore-activation'],
    });
    // lib.rs:1680-1693：setup 末尾 spawn 自动备份调度器；恢复模式跳过 finalizer，对应 Rust 提前返回。
    const autoBackup = createAutoBackupScheduler({ ctx, jobs: backup.jobs, operations });
    ctx.effect(() => () => autoBackup.stop());
    bindStartupFinalizer(ctx, 'backup.auto-backup-scheduler', () => autoBackup.start(), {
      after: ['backup.resumable-jobs'], late: 'run',
    });
  },
});
