/**
 * 移动端存储插件：`dstu.platform.storage` 的移动端实现（SQLite WASM + OPFS）。
 *
 * SQLite WASM 模块与迁移 SQL 由移动端外壳以 `sqliteRuntime` 服务注入（与桌面 better-sqlite3 由
 * Electron 打包进 Host 进程同理：原生 / WASM 绑定属于外壳，Host 源码不依赖具体包）。
 * 启动时迁移四个核心库（与桌面 coordinator 相同顺序与 SQL），然后发布 `ctx.storage`。
 * 迁移失败按桌面处理（startup.ts）：受阻核心库在业务插件装配前进入维护屏障，状态事件由启动 finalizer 发出。
 */
import { definePlugin, CommandError } from '../../kernel/core.ts';
import type {
  DatabaseName,
  ExactInjectionBudgetService,
  FeatureFlagsService,
  LlmUsageService,
  VirtualFilePolicyService,
} from '../storage/api.ts';
import {
  FeatureFlagManager,
  disableFlag,
  enableFlag,
  newFeatureFlag,
  setGradual,
  setUserSpecific,
  withDependencies,
  withVersionRange,
} from '../storage/feature-flags.ts';
import {
  ExactInjectionBudgetManager,
  InjectionBudgetManager,
  defaultBudgetConfig,
  defaultExactBudgetConfig,
  newInjectionItem,
} from '../storage/injection-budget.ts';
import { isVirtualUri } from '../storage/file-names.ts';
import {
  UsageCollector,
  cacheDebugEnabled,
  deleteOldRecords,
  getDailySummary,
  getRecentUsage,
  getSessionUsage,
  getUsageByCaller,
  getUsageByModel,
  getUsageSummary,
  getUsageTrends,
  recordLlmUsage,
  recordLlmUsageCacheExt,
  recordLlmUsageCacheExtWithIdentity,
  recordLlmUsageExt,
  recordUsageRecord,
  type TimeGranularity,
} from '../storage/llm-usage.ts';
import { MobileStorageService } from './service.ts';
import type { SqliteRuntime } from './sqlite-wasm.ts';
import { MIGRATION_STATUS_EVENT } from './startup.ts';
import { importLegacyNativeData } from './legacy.ts';
import { MobileBackupCancelled, MobileBackupService, type MobileBackupSelection } from './backup.ts';
import { beginMobileStagedUpload, appendMobileStagedUpload, abortMobileStagedUpload } from '../files/mobile-local-runtime.ts';
import { catalog } from '../../plugins/backup/src/asset-catalog.ts';
import { FileError, type FilesService } from '../files/api.ts';
import type { SecretsService } from '../secrets/api.ts';
import { cleanupMobileAuditLogs, queryMobileAuditLogs } from './audit.ts';
import { AppError } from '../errors/api.ts';
import { posix } from '../util/path.ts';
import { decodeUtf8Strict, Utf8DecodeError } from '../util/portable.ts';

/** 桌面由 backup 插件的这个 finalizer 发迁移状态事件；它在场时移动端不重复发。 */
const BACKUP_STATUS_FINALIZER = 'backup.restore-activation';

declare module '@deepseek-ai/cordis' {
  interface Context {
    sqliteRuntime: SqliteRuntime;
  }
}

export { MobileStorageService } from './service.ts';
export type { SqliteRuntime } from './sqlite-wasm.ts';

export default definePlugin<{ recoveryOnly?: boolean }>({
  meta: {
    id: 'dstu.platform.storage',
    lane: 'W14-portable',
    provides: ['storage', 'injectionBudget', 'featureFlags', 'virtualFilePolicy', 'llmUsage'],
    platforms: ['mobile'],
    commands: [
      'staged_upload_begin',
      'staged_upload_append',
      'staged_upload_abort',
      'get_startup_recovery_status',
      'list_startup_recovery_incidents',
      'get_data_space_info',
      'get_slot_directory',
      'get_database_info',
      'llm_usage_get_trends',
      'llm_usage_by_model',
      'llm_usage_by_caller',
      'llm_usage_summary',
      'llm_usage_session_summary',
      'llm_usage_recent',
      'llm_usage_daily',
      'llm_usage_cleanup',
      'data_governance_get_maintenance_status',
      'data_governance_get_migration_status',
      'data_governance_get_database_status',
      'data_governance_get_schema_registry',
      'data_governance_run_health_check',
      'data_governance_get_audit_logs',
      'data_governance_cleanup_audit_logs',
      'data_governance_cancel_backup',
      'data_governance_delete_backup',
      'data_governance_list_resumable_jobs',
      'data_governance_auto_verify_latest_backup',
      'data_governance_verify_backup',
      'data_governance_verify_backup_with_assets',
      'data_governance_get_asset_types',
      'data_governance_scan_assets',
      'data_governance_get_backup_list',
      'data_governance_list_backup_jobs',
      'data_governance_get_backup_job',
      'data_governance_run_backup',
      'data_governance_backup_tiered',
      'data_governance_backup_and_export_zip',
      'data_governance_export_zip',
      'data_governance_import_zip',
      'data_governance_restore_backup',
      'data_governance_check_disk_space_for_restore',
      'save_webview_settings',
      'load_webview_settings',
      'get_backup_config',
      'set_backup_config',
      'export_unified_backup_data',
      'get_app_data_dir',
      'get_app_version',
      'get_file_size',
      'hash_file',
      'read_file_text',
      'read_file_bytes',
      'save_text_to_file',
      'copy_file',
    ],
  },
  inject: ['sqliteRuntime', 'files', 'crypto'],
  async apply(ctx, config) {
    const logger = ctx.logger('storage');
    const storage = new MobileStorageService({
      runtime: ctx.sqliteRuntime,
      baseDir: ctx.app.dataDir,
      log: (level, message) => logger[level](message),
    });
    ctx.effect(() => () => storage.unload());
    const featureFlags: FeatureFlagsService = {
      load: (store, appVersion, options = {}) => {
        const manager = new FeatureFlagManager(appVersion, options.debug ?? false);
        if (options.userId != null) manager.withUserId(options.userId);
        return manager.loadFromDatabase(store);
      },
      save: (manager, store) => manager.saveToDatabase(store),
      newFlag: newFeatureFlag,
      enable: enableFlag,
      disable: disableFlag,
      setGradual,
      setUserSpecific,
      withDependencies,
      withVersionRange,
    };
    ctx.provide('featureFlags', featureFlags);
    const injectionBudget: ExactInjectionBudgetService = {
      defaultConfig: defaultBudgetConfig,
      createManager: (config) => new InjectionBudgetManager(config),
      newItem: newInjectionItem,
      defaultExactConfig: defaultExactBudgetConfig,
      createExactManager: (config) => new ExactInjectionBudgetManager(config),
    };
    ctx.provide('injectionBudget', injectionBudget);
    const virtualFilePolicy: VirtualFilePolicyService = { isVirtualUri };
    ctx.provide('virtualFilePolicy', virtualFilePolicy);
    // 0.15.x 原生 Android 把库放在应用私有 files/slots/<slot>/ 下；升级成 Capacitor/OPFS 后首次启动
    // 必须在迁移建库之前把旧库搬进 pool，否则迁移会在空库上建表，旧数据再也进不来。
    let backup: MobileBackupService | null = null;
    const backupService = (): MobileBackupService => (backup ??= new MobileBackupService({
      ctx, storage, runtime: ctx.sqliteRuntime, files: ctx.files,
    }));

    const startupRecovery = config?.recoveryOnly ? await backupService().recoverPendingRestore() : null;
    if (startupRecovery === null) await importLegacyNativeData(ctx, storage, ctx.sqliteRuntime);
    const report = startupRecovery === null ? await storage.migrations.runAll() : {
      databases: [], success: false, totalDurationMs: 0,
      error: startupRecovery.reason ?? '数据恢复已完成，需要重启应用',
    };
    if (startupRecovery !== null && report.error !== null) {
      for (const { component } of storage.componentHealth.components) storage.componentHealth.markBlocked(component, report.error);
    }
    if (startupRecovery === null && !report.success) logger.error(`startup migration failed: ${report.error}`);
    const coreRecovery = startupRecovery === null ? await storage.enterCoreRecoveryBarrier() : null;
    if (coreRecovery !== null) {
      ctx.effect(() => () => coreRecovery.release());
      logger.warn(`核心数据域不可安全打开，进入治理恢复启动模式: blocked_components=${JSON.stringify(storage.componentHealth.blockedComponents())}`);
    }
    let usageCollector: UsageCollector | null = null;
    if (startupRecovery === null && !storage.componentHealth.isBlocked('llm_usage')) {
      const collector = new UsageCollector({ getConnSafe: () => storage.database('llm_usage') });
      usageCollector = collector;
      storage.beforeShutdown(() => {
        usageCollector = null;
        return collector.shutdown();
      });
    }
    const collectorSource = () => usageCollector;
    const llmUsageService: LlmUsageService = {
      cacheDebugEnabled,
      recordLlmUsageCacheExtWithIdentity: (call) => recordLlmUsageCacheExtWithIdentity(collectorSource, call),
      recordLlmUsageCacheExt: (call) => recordLlmUsageCacheExt(collectorSource, call),
      recordLlmUsageExt: (call) => recordLlmUsageExt(collectorSource, call),
      recordLlmUsage: (call) => recordLlmUsage(collectorSource, call),
      recordUsageRecord: (record) => recordUsageRecord(collectorSource, record),
    };
    ctx.provide('llmUsage', llmUsageService);
    storage.registerFinalizer('storage.migration-status', () => {
      if (storage.finalizerNames().includes(BACKUP_STATUS_FINALIZER)) return;
      const payload = storage.migrationStatusPayload();
      if (payload === null) return;
      try { ctx.backendEvents.emit(MIGRATION_STATUS_EVENT, payload); }
      catch (error) { logger.warn(`发送迁移状态事件失败: ${error instanceof Error ? error.message : String(error)}`); }
    });
    ctx.provide('storage', storage);

    const llmFail = (error: unknown): CommandError =>
      error instanceof CommandError ? error : new CommandError(error instanceof Error ? error.message : String(error));
    const guard = <T>(fn: () => T): T => {
      try { return fn(); }
      catch (error) { throw llmFail(error); }
    };
    const guardAsync = async <T>(fn: () => Promise<T>): Promise<T> => {
      try { return await fn(); }
      catch (error) { throw llmFail(error); }
    };

    const guardFileCommand = async <T>(fn: () => Promise<T>): Promise<T> => {
      try { return await fn(); }
      catch (error) {
        if (error instanceof CommandError) throw error;
        throw new CommandError(AppError.file_system(error instanceof Error ? error.message : String(error)));
      }
    };

    ctx.commands.register('staged_upload_begin', ({ name, totalSize }) => guard(() =>
      beginMobileStagedUpload(name as string, totalSize as number)));
    ctx.commands.register('staged_upload_append', (args, call) => guard(() => {
      if (call.payload instanceof Uint8Array || Array.isArray(call.payload)) {
        return appendMobileStagedUpload(call.headers?.['x-upload-id'] ?? '',
          Number(call.headers?.['x-upload-offset']), new Uint8Array(call.payload));
      }
      return appendMobileStagedUpload(args.uploadId as string, args.offset as number, args.data as string);
    }));
    ctx.commands.register('staged_upload_abort', ({ uploadId }) => guard(() => abortMobileStagedUpload(uploadId as string)));

    const incident = startupRecovery && {
      incident_id: startupRecovery.id,
      created_at: new Date().toISOString(),
      failed_operation: 'mobile_pending_restore',
      recovery_error: startupRecovery.reason,
      resolved: startupRecovery.reason === null,
      retry_requires_restart: startupRecovery.reason === null,
      legacy_entries: [],
      candidates: startupRecovery.previousBackupId ? [{
        id: startupRecovery.previousBackupId, exists: true, has_data: true, has_database: false,
        size_bytes: startupRecovery.previousBackupBytes, latest_modified: null,
        database_filenames: [], core_database_filenames: [], valid_core_database_filenames: [],
        selectable: true, recommended: true, recommendation_reason: '恢复开始前保存的 ZIP 快照，激活前必须校验',
      }] : [],
    };
    ctx.commands.register('get_startup_recovery_status', () => ({ recovery_required: incident !== null, incident }));
    ctx.commands.register('list_startup_recovery_incidents', () => incident === null ? [] : [incident]);
    ctx.commands.register('get_data_space_info', () => guard(() => ({
      active_slot: 'slotA',
      inactive_slot: 'slotB',
      pending_slot: null,
      active_dir: storage.locations.activeDir,
      inactive_dir: `${storage.locations.baseDir}/slots/slotB`,
    })));
    ctx.commands.register('get_slot_directory', ({ slotName }) => {
      if (slotName !== 'slotA' && slotName !== 'slotB' && slotName !== 'slotC' && slotName !== 'slotD') {
        throw new CommandError(AppError.validation(`无效的插槽名称: ${String(slotName)}`));
      }
      return `${storage.locations.baseDir}/slots/${slotName}`;
    });
    ctx.commands.register('get_database_info', () => guard(() => ({
      production_db_path: storage.pathOf('mistakes'),
      test_db_path: `${storage.locations.activeDir}/test_mistakes.db`,
      test_db_exists: false,
      production_db_exists: true,
      active_database: 'production',
    })));
    const llmUsageDb = () => storage.database('llm_usage');
    ctx.commands.register('llm_usage_get_trends', ({ days, granularity }) => guard(() => {
      const parsed: TimeGranularity =
        granularity === 'hour' || granularity === 'day' || granularity === 'week' || granularity === 'month'
          ? granularity
          : 'day';
      return getUsageTrends(llmUsageDb(), days as number, parsed);
    }));
    ctx.commands.register('llm_usage_by_model', ({ startDate, endDate }) => guard(() =>
      getUsageByModel(llmUsageDb(), startDate as string, endDate as string)));
    ctx.commands.register('llm_usage_by_caller', ({ startDate, endDate }) => guard(() =>
      getUsageByCaller(llmUsageDb(), startDate as string, endDate as string)));
    ctx.commands.register('llm_usage_summary', ({ startDate, endDate }) => guard(() =>
      getUsageSummary(llmUsageDb(), startDate as string | null | undefined, endDate as string | null | undefined)));
    ctx.commands.register('llm_usage_session_summary', ({ sessionId }) => guard(() =>
      getSessionUsage(llmUsageDb(), sessionId as string)));
    ctx.commands.register('llm_usage_recent', ({ limit }) => guard(() =>
      getRecentUsage(llmUsageDb(), (limit as number | null | undefined) ?? 50)));
    ctx.commands.register('llm_usage_daily', ({ startDate, endDate }) => guard(() =>
      getDailySummary(llmUsageDb(), startDate as string, endDate as string)));
    ctx.commands.register('llm_usage_cleanup', ({ beforeDate }) => guard(() =>
      deleteOldRecords(llmUsageDb(), beforeDate as string)));
    ctx.commands.register('data_governance_get_maintenance_status', () => guard(() => {
      const blocked = storage.componentHealth.blockedComponents();
      return {
        is_in_maintenance_mode: startupRecovery !== null || blocked.length > 0,
        blocked_components: blocked,
        current_operation: null,
        component_health: storage.componentHealth.toJSON(),
        component_issues: storage.componentHealth.issues(),
      };
    }));
    ctx.commands.register('data_governance_get_migration_status', () => guard(() => {
      const migrationReport = storage.startupMigrationReport() ?? report;
      const nowIso = new Date().toISOString();
      const databases = migrationReport.databases.map((db) => ({
        id: db.id,
        current_version: db.toVersion,
        target_version: db.toVersion,
        is_initialized: db.toVersion > 0,
        last_migration_at: db.toVersion > 0 ? nowIso : null,
        pending_count: 0,
        has_pending: false,
      }));
      const globalVersion = Math.max(0, ...databases.map((d) => d.current_version));
      return {
        global_version: globalVersion,
        all_healthy: migrationReport.success,
        databases,
        pending_migrations_total: 0,
        has_pending_migrations: false,
        last_error: migrationReport.error,
      };
    }));
    ctx.commands.register('data_governance_get_database_status', ({ databaseId }) => guard(() => {
      const migrationReport = storage.startupMigrationReport() ?? report;
      const found = migrationReport.databases.find((d) => d.id === databaseId);
      if (!found) return null;
      const nowIso = new Date().toISOString();
      return {
        id: found.id,
        schema_version: found.toVersion,
        min_compatible_version: 1,
        max_compatible_version: found.toVersion,
        data_contract_version: '1.0',
        checksum: '',
        updated_at: nowIso,
        migration_history: [],
        dependencies: found.id === 'chat_v2' || found.id === 'mistakes' ? ['vfs'] : [],
      };
    }));
    ctx.commands.register('data_governance_get_schema_registry', () => guard(() => {
      const migrationReport = storage.startupMigrationReport() ?? report;
      const nowIso = new Date().toISOString();
      const databases = migrationReport.databases.map((db) => ({
        id: db.id,
        schema_version: db.toVersion,
        min_compatible_version: 1,
        max_compatible_version: db.toVersion,
        data_contract_version: '1.0',
        migration_count: db.appliedCount,
        checksum: '',
        updated_at: nowIso,
      }));
      return {
        global_version: Math.max(0, ...databases.map((d) => d.schema_version)),
        aggregated_at: nowIso,
        databases,
      };
    }));
    ctx.commands.register('data_governance_run_health_check', () => guard(() => {
      const migrationReport = storage.startupMigrationReport() ?? report;
      const nowIso = new Date().toISOString();
      const databases = migrationReport.databases.map((db) => ({
        id: db.id,
        is_healthy: db.success,
        dependencies_met: true,
        schema_version: db.toVersion,
        target_version: db.toVersion,
        pending_count: 0,
        issues: db.error ? [db.error] : [],
      }));
      return {
        overall_healthy: migrationReport.success,
        total_databases: databases.length,
        initialized_count: databases.filter((d) => d.schema_version > 0).length,
        uninitialized_count: databases.filter((d) => d.schema_version === 0).length,
        dependency_check_passed: true,
        dependency_error: null,
        databases,
        checked_at: nowIso,
        pending_migrations_count: 0,
        has_pending_migrations: false,
        audit_log_healthy: true,
        audit_log_error: null,
        audit_log_error_at: null,
      };
    }));
    ctx.commands.register<{
      operationType?: string | null;
      status?: string | null;
      limit?: number | null;
      offset?: number | null;
    }>('data_governance_get_audit_logs', (args) => guard(() =>
      queryMobileAuditLogs(storage.database('audit'), args)));
    ctx.commands.register<{
      keepRecent?: number | null;
      beforeDays?: number | null;
      confirmationToken: string;
    }>('data_governance_cleanup_audit_logs', (args) => guard(() =>
      cleanupMobileAuditLogs(storage.database('audit'), {
        keepRecent: args.keepRecent,
        beforeDays: args.beforeDays,
        confirmationToken: args.confirmationToken,
        generateId: () => ctx.crypto.randomUUID(),
      })));
    // `data_governance_run_backup` / `_backup_tiered` / `_export_zip` write `<backupRoot>/<id>.zip`
    // in OPFS. The list is the actual directory content, not an in-memory placeholder.
    const listBackups = async () => {
      const root = backupService().backupRoot;
      let entries;
      try { entries = await ctx.files.readDir(root); }
      catch (error) { if (error instanceof FileError && error.kind === 'NotFound') return []; throw error; }
      const backups: Array<Record<string, unknown>> = [];
      for (const entry of entries) {
        if (entry.kind !== 'file' || !entry.name.toLowerCase().endsWith('.zip')) continue;
        const stat = await ctx.files.stat(entry.path).catch(() => null);
        if (stat === null) continue;
        backups.push({
          path: entry.name.slice(0, -'.zip'.length),
          created_at: new Date(stat.modifiedMs > 0 ? stat.modifiedMs : Date.now()).toISOString(),
          size: stat.size,
          ...await backupService().describeBackup(entry.path).catch(() => ({
            backup_type: 'unknown', recovery_kind: 'partial_archive', restorable: false, databases: [],
          })),
        });
      }
      return backups.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    };
    ctx.commands.register('data_governance_get_backup_list', () => guardAsync(listBackups));
    ctx.commands.register('data_governance_auto_verify_latest_backup', () => guardAsync(async () => {
      const latest = (await listBackups())[0];
      if (!latest) throw new CommandError('没有可校验的备份');
      const started = performance.now();
      const id = String(latest.path);
      const result = (await backupService().verifyBackup(id)).base;
      return { ...result, backup_id: id, verified_at: new Date().toISOString(), duration_ms: Math.trunc(performance.now() - started) };
    }));
    ctx.commands.register('data_governance_cancel_backup', ({ jobId }) => guard(() => backupService().jobs.cancel(String(jobId))));
    ctx.commands.register('data_governance_delete_backup', ({ backupId }) => guardAsync(() => backupService().removeBackup(String(backupId))));
    // Mobile only exposes pending restore replay at startup; there are no user-resumable jobs.
    ctx.commands.register('data_governance_list_resumable_jobs', () => []);
    ctx.commands.register('data_governance_verify_backup', ({ backupId }) => guardAsync(async () => (await backupService().verifyBackup(String(backupId))).base));
    ctx.commands.register('data_governance_verify_backup_with_assets', ({ backupId }) => guardAsync(async () => (await backupService().verifyBackup(String(backupId))).assets));
    ctx.commands.register('data_governance_get_asset_types', () => catalog.map(([id, name, priority]) => ({ id, name, priority, relative_path: id })));
    ctx.commands.register('data_governance_scan_assets', ({ assetTypes }) => guardAsync(() => backupService().scanAssets(
      Array.isArray(assetTypes) ? assetTypes.filter((value): value is string => typeof value === 'string') : undefined,
    )));
    ctx.commands.register('data_governance_list_backup_jobs', () => guard(() => backupService().jobs.list()));

    // ---------------------------------------------------------------- 数据迁移（ZIP 备份/恢复）
    //
    // 移动端没有可写的用户目录（也没有桌面 `plugin:dialog`），所以 backup/export 都落在
    // `<dataDir>/recovery/backups`，再由主线程 `mobile:save-backup` 交给系统分享/下载。导入接受
    // OPFS 路径或 `data:` URL；解出的库先暂存在 `imports/<id>/`，`restore_backup` 才覆盖活动槽并重载。
    ctx.commands.register('data_governance_get_backup_job', ({ jobId }) => guard(() => backupService().jobs.get(String(jobId))));

    const selectedBackup = (args: Record<string, unknown>, tiered: boolean): MobileBackupSelection | undefined => {
      if (!tiered && args.includeAssets !== false && !Array.isArray(args.assetTypes)) return undefined;
      const tiers = Array.isArray(args.tiers) ? args.tiers : ['core'];
      const includes = Array.isArray(args.includeDatabases) ? args.includeDatabases : [];
      const excludes = Array.isArray(args.excludeDatabases) ? args.excludeDatabases : [];
      const databases = (['vfs', 'chat_v2', 'mistakes', 'llm_usage'] as const).filter(db => !excludes.includes(db)
        && (!tiered || includes.includes(db) || (db === 'llm_usage' ? tiers.includes('important') : tiers.includes('core'))));
      const wantsAssets = tiered ? args.includeAssets === true : args.includeAssets !== false;
      const assetRoots = catalog.filter(([root, , priority]) => wantsAssets
        && (!Array.isArray(args.assetTypes) || args.assetTypes.length === 0 || args.assetTypes.includes(root))
        && (!tiered || (priority === 0 ? tiers.includes('important') : tiers.includes('large_assets') || tiers.includes('largeassets'))))
        .map(([root]) => root);
      if (databases.length === 0 && assetRoots.length === 0) throw new CommandError('请选择要备份的数据库或资产');
      return { databases, assetRoots, maxAssetSize: typeof args.maxAssetSize === 'number' ? args.maxAssetSize : undefined };
    };
    ctx.commands.register('data_governance_run_backup', (args) => guard(() => {
      if (args.backupType === 'incremental') throw new CommandError('移动端不支持增量备份');
      const selection = selectedBackup(args, false);
      const jobs = backupService().jobs;
      const job = jobs.create('export');
      const id = `backup-${ctx.crypto.randomUUID()}`;
      void (async () => {
        job.update({ status: 'running', phase: 'scan', progress: 2, message: '正在导出 OPFS 数据库与附件' });
        const result = await backupService().exportBackup(id, null, (done, total, file) => {
          job.update({ phase: 'compress', progress: 3 + (done / Math.max(1, total)) * 95, processed_items: done, total_items: total, message: `正在写入 ${file}` });
        }, selection, job.check, () => job.update({ cancellable: false }));
        job.complete({
          success: true,
          output_path: result.zipPath,
          resolved_path: result.zipPath,
          message: `备份完成: ${result.fileCount} 个文件`,
          error: null,
          duration_ms: null,
          requires_restart: false,
          stats: {
            backup_id: result.backupId, file_count: result.fileCount, total_size: result.totalSize, compressed_size: result.compressedSize,
          },
        });
      })().catch((error: unknown) => job.fail(`备份失败: ${error instanceof Error ? error.message : String(error)}`, error));
      return { job_id: job.id, kind: 'export', status: 'queued', message: '备份任务已启动，请通过 backup-job-progress 事件监听进度' };
    }));

    ctx.commands.register('data_governance_backup_tiered', (args) => guard(() => {
      const selection = selectedBackup(args, true);
      const jobs = backupService().jobs;
      const job = jobs.create('export');
      const id = `backup-${ctx.crypto.randomUUID()}`;
      void (async () => {
        job.update({ status: 'running', phase: 'scan', progress: 2, message: '正在导出 OPFS 数据库与附件' });
        const result = await backupService().exportBackup(id, undefined, undefined, selection, job.check, () => job.update({ cancellable: false }));
        job.complete({
          success: true, output_path: result.zipPath, resolved_path: result.zipPath,
          message: `备份完成: ${result.fileCount} 个文件`, error: null, duration_ms: null, requires_restart: false,
          stats: { backup_id: result.backupId, file_count: result.fileCount, total_size: result.totalSize, compressed_size: result.compressedSize },
        });
      })().catch((error: unknown) => job.fail(`分层备份失败: ${error instanceof Error ? error.message : String(error)}`, error));
      return { job_id: job.id, kind: 'export', status: 'queued', message: '备份任务已启动，请通过 backup-job-progress 事件监听进度' };
    }));

    const startExport = (
      id: string,
      outputPath: string | null,
      createLocal: boolean,
      keepLocal: boolean,
      password: string | undefined,
      selection?: MobileBackupSelection,
      compressionLevel = 0,
    ) => {
      if (!isSafeBackupId(id)) throw new CommandError('备份 ID 无效');
      if (password && [...password.trim()].length < 8) throw new CommandError('备份密码至少需要 8 个字符');
      if (!Number.isInteger(compressionLevel) || compressionLevel < 0 || compressionLevel > 9) throw new CommandError('压缩等级应介于 0 和 9 之间');
      const service = backupService();
      const job = service.jobs.create('export');
      const exportedPath = outputPath ?? `${storage.locations.baseDir}/tmp/backups/${job.id}.zip`;
      let createdPath: string | null = null;
      void (async () => {
        try {
          job.update({ status: 'running', phase: 'scan', progress: 2, message: '正在扫描备份数据' });
          let local = await service.existingZip(id);
          if (!local) {
            if (!createLocal) throw new CommandError(`备份不存在：${id}`);
            const result = await service.exportBackup(id, null, (done, total, file) => {
              job.update({ phase: 'compress', progress: 3 + (done / Math.max(1, total)) * 70, processed_items: done, total_items: total, message: `正在写入 ${file}` });
            }, selection, job.check);
            local = createdPath = result.zipPath;
          }
          if (local === exportedPath) throw new CommandError('不能用便携 ZIP 覆盖应用内备份');
          job.check();
          job.update({ phase: 'compress', progress: 80, message: '正在生成便携 ZIP' });
          const compressedSize = await service.exportPortable(local, exportedPath, password, compressionLevel, job.check);
          job.check();
          job.update({ cancellable: false });
          let delivery: string | undefined;
          if (outputPath === null) {
            job.update({ phase: 'verify', progress: 96, message: '正在交给系统保存' });
            try { delivery = await service.deliver(exportedPath, `${id}.zip`); }
            catch (error) {
              if (error instanceof Error && error.message.includes('已取消选择保存位置')) throw new MobileBackupCancelled('已取消选择保存位置');
              throw error;
            }
          }
          job.complete({
            success: true, output_path: outputPath ?? `${id}.zip`, resolved_path: outputPath ?? `${id}.zip`,
            message: `ZIP 导出完成: ${id}.zip`, error: null, duration_ms: null, requires_restart: false,
            stats: { backup_id: id, compressed_size: compressedSize, delivery },
          });
        } finally {
          if (outputPath === null) await ctx.files.rm(exportedPath, { force: true }).catch(() => undefined);
          if (!keepLocal && createdPath !== null) await ctx.files.rm(createdPath, { force: true }).catch(() => undefined);
        }
      })().catch((error: unknown) => job.fail(`ZIP 导出失败: ${error instanceof Error ? error.message : String(error)}`, error));
      return { job_id: job.id, kind: 'export', status: 'queued', message: 'ZIP 导出任务已启动，请通过 backup-job-progress 事件监听进度' };
    };

    const resolveCloudBackupPassword = async (explicit: unknown, useStored: unknown): Promise<string | undefined> => {
      const trimmedExplicit = typeof explicit === 'string' && explicit.trim().length > 0 ? explicit : undefined;
      if (trimmedExplicit) return trimmedExplicit;
      if (useStored !== true) return undefined;
      const secrets = ctx.get('secrets') as SecretsService | undefined;
      if (!secrets) throw new CommandError('未找到已保存的云端加密密码，请先在云存储设置中保存密码或手动输入');
      const stored = await secrets.openFallbackStore().getCloudCredentials();
      const storedPassword = typeof stored?.encryptionPassword === 'string' && stored.encryptionPassword.trim().length > 0
        ? stored.encryptionPassword
        : undefined;
      if (!storedPassword) throw new CommandError('未找到已保存的云端加密密码，请先在云存储设置中保存密码或手动输入');
      return storedPassword;
    };

    ctx.commands.register('data_governance_export_zip', (args) => guard(async () => {
      const password = await resolveCloudBackupPassword(args.encryptionPassword, args.useStoredCloudEncryptionPassword);
      const outputPath = typeof args.outputPath === 'string' && args.outputPath.startsWith('/') ? args.outputPath : null;
      return startExport(String(args.backupId), outputPath, false, true, password,
        undefined, typeof args.compressionLevel === 'number' ? args.compressionLevel : undefined);
    }));

    ctx.commands.register('data_governance_backup_and_export_zip', (args) => guard(async () => {
      const password = await resolveCloudBackupPassword(args.encryptionPassword, args.useStoredCloudEncryptionPassword);
      const outputPath = typeof args.outputPath === 'string' && args.outputPath.startsWith('/') ? args.outputPath : null;
      return startExport(`backup-${ctx.crypto.randomUUID()}`, outputPath, true, args.addToBackupList === true, password,
        selectedBackup(args, args.useTiered === true), typeof args.compressionLevel === 'number' ? args.compressionLevel : undefined);
    }));

    ctx.commands.register('data_governance_import_zip', (args) => guard(async () => {
      const password = await resolveCloudBackupPassword(args.password, args.useStoredCloudEncryptionPassword);
      const jobs = backupService().jobs;
      const job = jobs.create('import');
      void (async () => {
        const picker = args.zipPath === 'mobile-picker:';
        job.update({ status: 'running', phase: 'scan', progress: 5, message: '正在解压 ZIP 备份', cancellable: !picker });
        let passedPicker = !picker;
        const result = await backupService().importArchive(String(args.zipPath), typeof args.backupId === 'string' ? args.backupId : null,
          password, false, () => {
            job.check();
            if (!passedPicker) {
              passedPicker = true;
              job.update({ cancellable: true });
            }
          }, () => job.update({ cancellable: false }));
        job.update({ status: 'running', phase: 'verify', progress: 95, message: '正在验证数据库' });
        job.complete({
          success: true, output_path: result.stageDir, resolved_path: result.stageDir,
          message: `已导入备份 ${result.backupId}`, error: null, duration_ms: null, requires_restart: false,
          stats: { backup_id: result.backupId, database_count: result.databaseCount, blob_count: result.blobCount, stage_dir: result.stageDir, restorable: result.restorable, recovery_kind: result.restorable ? 'disaster_recovery' : 'partial_archive' },
        });
      })().catch((error: unknown) => job.fail(`ZIP 导入失败: ${error instanceof Error ? error.message : String(error)}`, error));
      return { job_id: job.id, kind: 'import', status: 'queued', message: 'ZIP 导入任务已启动，请通过 backup-job-progress 事件监听进度' };
    }));

    ctx.commands.register('data_governance_restore_backup', (args) => guard(() => {
      const jobs = backupService().jobs;
      const job = jobs.create('import');
      void (async () => {
        job.update({ status: 'running', phase: 'scan', progress: 3, message: '正在准备恢复活动数据槽' });
        const backupId = String(args.backupId);
        // A backup listed from `<backupRoot>/<id>.zip` has not been staged yet; unpacking it first
        // makes the list action self-contained (imports are idempotent — the stage dir is replaced).
        if (startupRecovery === null && isSafeBackupId(backupId)) {
          const stageDir = `${backupService().backupRoot}/imports/${backupId}`;
          const zipPath = `${backupService().backupRoot}/${backupId}.zip`;
          const staged = await ctx.files.exists(`${stageDir}/manifest.json`);
          if (!staged && await ctx.files.exists(zipPath).catch(() => false)) {
            job.update({ phase: 'scan', progress: 8, message: '正在解压备份归档' });
            await backupService().importArchive(zipPath, backupId, undefined, true, job.check);
          }
        }
        job.check();
        job.update({ cancellable: false });
        if (startupRecovery !== null) {
          if (startupRecovery.reason === null) throw new CommandError('数据恢复已经完成，请重启应用');
          await backupService().replacePendingRestore(backupId, startupRecovery.previousBackupId, job.check);
        }
        const result = startupRecovery === null ? await backupService().restoreArchive(backupId) : null;
        job.update({ status: 'running', phase: 'verify', progress: 95, message: '恢复完成，正在重启应用' });
        job.complete({
          success: true, output_path: result?.preRestoreZip ?? null, resolved_path: result?.preRestoreZip ?? null,
          message: '恢复完成，应用即将重新加载', error: null, duration_ms: null, requires_restart: true,
          stats: { backup_id: backupId, ...(result ? {
            database_count: result.databaseCount, blob_count: result.blobCount, pre_restore_backup: result.preRestoreZip,
          } : {}) },
        });
        // 等事件送达到页面后再重载；数据已经落盘，重载只是让新连接读到恢复后的库。
        setTimeout(() => { void backupService().requestRestart(); }, 400);
      })().catch((error: unknown) => job.fail(`恢复失败: ${error instanceof Error ? error.message : String(error)}`, error));
      return { job_id: job.id, kind: 'import', status: 'queued', message: '恢复任务已启动，请通过 backup-job-progress 事件监听进度' };
    }));

    ctx.commands.register('data_governance_check_disk_space_for_restore', ({ backupId }) => guardAsync(async () => {
      const backupSize = await backupService().stagedSize(String(backupId));
      const required = backupSize * 2;
      // 旧 WebView 可能没有 storage.estimate；此时不能把“未知”当成“空间不足”而阻断恢复。
      let available: number | null = null;
      try {
        const estimate = await navigator.storage.estimate();
        const quota = typeof estimate.quota === 'number' ? estimate.quota : 0;
        if (quota > 0) available = Math.max(0, quota - (estimate.usage ?? 0));
      } catch { // boundary-allow empty-catch: estimate 不可用，按未知处理。
      }
      return {
        has_enough_space: available === null || available >= required,
        available_bytes: available ?? 0,
        required_bytes: required,
        backup_size: backupSize,
      };
    }));
    // Backup settings must survive a reload: the previous in-memory object reset on every restart.
    // OPFS is the durable store (Host runs in a Worker, where `localStorage` is unavailable).
    const backupConfigPath = `${ctx.app.dataDir}/recovery/backup-config.json`;
    const configFiles = ctx.files;
    let backupConfig: Record<string, unknown> = {
      backupDirectory: null,
      autoBackupEnabled: false,
      autoBackupIntervalHours: 24,
      maxBackupCount: 10,
      slimBackup: false,
    };
    try {
      if (configFiles && await configFiles.exists(backupConfigPath)) {
        const parsed: unknown = JSON.parse(await configFiles.readText(backupConfigPath));
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          backupConfig = { ...backupConfig, ...(parsed as Record<string, unknown>) };
        }
      }
    } catch (error) {
      logger.warn(`读取备份配置失败，使用默认值: ${error instanceof Error ? error.message : String(error)}`);
    }
    const webviewSettingsPath = `${storage.locations.activeDir}/webview_settings.json`;
    ctx.commands.register('save_webview_settings', ({ settings }) => guardFileCommand(async () => {
      if (settings === null || typeof settings !== 'object' || Array.isArray(settings)
        || Object.values(settings).some(value => typeof value !== 'string')) throw new CommandError(AppError.validation('WebView 设置必须是字符串映射'));
      const json = JSON.stringify(settings);
      const size = new TextEncoder().encode(json).byteLength;
      await ctx.files.writeAtomic(webviewSettingsPath, json, { createParents: true });
      return { success: true, path: webviewSettingsPath, size };
    }));
    ctx.commands.register('load_webview_settings', () => guardFileCommand(async () => {
      if (!await ctx.files.exists(webviewSettingsPath)) return { exists: false, settings: null };
      return { exists: true, settings: JSON.parse(await ctx.files.readText(webviewSettingsPath)) };
    }));
    ctx.commands.register('get_backup_config', () => guard(() => backupConfig));
    ctx.commands.register('set_backup_config', ({ config }) => guardFileCommand(async () => {
      if (config && typeof config === 'object') {
        const next = { ...backupConfig, ...(config as Record<string, unknown>) };
        if (next.autoBackupEnabled) throw new CommandError(AppError.validation('Android 不支持在后台自动备份，请手动创建备份'));
        await configFiles.writeAtomic(backupConfigPath, `${JSON.stringify(next, null, 2)}\n`, { createParents: true });
        backupConfig = next;
      }
      return null;
    }));

    // ---------------------------------------------------------------- OPFS 文件命令（前端通用文件 API）
    const MAX_READ_FILE_BYTES = 200 * 1024 * 1024;
    const requireFiles = (): FilesService => ctx.files;
    const normalizeOpfsPath = (raw: string): string => {
      const trimmed = String(raw ?? '').replace(/^\0+|\0+$/g, '').trim();
      if (trimmed === '') throw new CommandError(AppError.validation('路径不能为空'));
      if (trimmed.includes('://') || /^(primary|secondary|raw):/i.test(trimmed)) {
        throw new CommandError(AppError.file_system(`读取文件失败: ${trimmed} (URL is not a valid path)`));
      }
      if (!trimmed.startsWith('/')) throw new CommandError(AppError.validation(`路径必须是绝对路径: ${trimmed}`));
      const segments = trimmed.split('/');
      if (segments.includes('..')) throw new CommandError(AppError.validation(`非法路径: ${trimmed}`));
      const normalized = posix.normalize(trimmed);
      const base = posix.normalize(ctx.app.dataDir);
      if (normalized !== base && !normalized.startsWith(`${base}/`)) {
        throw new CommandError(AppError.validation(`路径超出应用目录范围: ${trimmed}`));
      }
      return normalized;
    };
    const wrapFileOpError = (prefix: string, path: string, error: unknown): never => {
      if (error instanceof CommandError) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      const kind = (error as { kind?: string } | null)?.kind;
      if (kind === 'OutsideRoots' || kind === 'InvalidPath') throw new CommandError(AppError.validation(`${prefix}: ${path} (${msg})`));
      throw new CommandError(AppError.file_system(`${prefix}: ${path} (${msg})`));
    };

    ctx.commands.register('get_app_data_dir', () => ctx.app.dataDir);
    ctx.commands.register('get_app_version', () => ctx.app.version);

    ctx.commands.register<{ path: string }>('get_file_size', async ({ path }) => {
      const normalized = normalizeOpfsPath(path);
      const files = requireFiles();
      try {
        const stat = await files.stat(normalized);
        if (stat.kind !== 'file') throw new CommandError(AppError.file_system(`获取文件信息失败: ${normalized} (不是文件)`));
        return stat.size;
      } catch (error) {
        wrapFileOpError('获取文件信息失败', normalized, error);
      }
    });

    ctx.commands.register<{ path: string }>('hash_file', async ({ path }) => {
      const normalized = normalizeOpfsPath(path);
      const files = requireFiles();
      try {
        const stat = await files.stat(normalized);
        if (stat.kind !== 'file') throw new CommandError(AppError.file_system(`读取文件失败: ${normalized} (不是文件)`));
        const cryptoSvc = ctx.reflect.get('crypto', false) as {
          createHasher?(algo: 'SHA-256'): { update(chunk: Uint8Array): void; digestHex(): string };
        } | undefined;
        if (cryptoSvc && typeof cryptoSvc.createHasher === 'function') {
          const hasher = cryptoSvc.createHasher('SHA-256');
          const stream = await files.openRead(normalized);
          const reader = stream.getReader();
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              hasher.update(next.value);
            }
          } finally {
            reader.releaseLock();
          }
          return hasher.digestHex();
        }
        const bytes = await files.readBytes(normalized);
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
        return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
      } catch (error) {
        wrapFileOpError('读取文件失败', normalized, error);
      }
    });

    ctx.commands.register<{ path: string }>('read_file_text', async ({ path }) => {
      const normalized = normalizeOpfsPath(path);
      const files = requireFiles();
      let bytes!: Uint8Array;
      try {
        const stat = await files.stat(normalized);
        if (stat.kind !== 'file') throw new CommandError(AppError.file_system(`读取文件失败: ${normalized} (不是文件)`));
        if (stat.size > MAX_READ_FILE_BYTES) {
          throw new CommandError(AppError.validation(`文件过大: ${stat.size} 字节，超过读取上限 ${MAX_READ_FILE_BYTES} 字节: ${normalized}`));
        }
        bytes = await files.readBytes(normalized);
      } catch (error) {
        wrapFileOpError('读取文件失败', normalized, error);
      }
      try {
        return decodeUtf8Strict(bytes);
      } catch (error) {
        if (error instanceof Utf8DecodeError) throw new CommandError(AppError.file_system('文件编码不是有效的 UTF-8'));
        throw new CommandError(AppError.file_system(`读取文件失败: ${error instanceof Error ? error.message : String(error)}`));
      }
    });

    ctx.commands.register<{ path: string; maxBytes?: number | null }>('read_file_bytes', async ({ path, maxBytes }) => {
      const normalized = normalizeOpfsPath(path);
      const files = requireFiles();
      const limit = Math.min(maxBytes ?? MAX_READ_FILE_BYTES, MAX_READ_FILE_BYTES);
      try {
        const stat = await files.stat(normalized);
        if (stat.kind !== 'file') throw new CommandError(AppError.file_system(`读取文件失败: ${normalized} (不是文件)`));
        if (stat.size > limit) {
          throw new CommandError(AppError.validation(`文件过大: ${stat.size} 字节，超过读取上限 ${limit} 字节: ${normalized}`));
        }
        return await files.readBytes(normalized);
      } catch (error) {
        wrapFileOpError('读取文件失败', normalized, error);
      }
    });

    ctx.commands.register<{ path: string; content: string }>('save_text_to_file', async ({ path, content }) => {
      const normalized = normalizeOpfsPath(path);
      const files = requireFiles();
      try {
        await files.writeText(normalized, String(content ?? ''), { createParents: true });
        return null;
      } catch (error) {
        wrapFileOpError('写入文件失败', normalized, error);
      }
    });

    ctx.commands.register<{ sourcePath: string; destPath: string }>('copy_file', async ({ sourcePath, destPath }) => {
      const src = normalizeOpfsPath(sourcePath);
      const dst = normalizeOpfsPath(destPath);
      if (src === dst) throw new CommandError(AppError.validation('源路径与目标路径不能相同'));
      const files = requireFiles();
      try {
        const stat = await files.stat(src);
        if (stat.kind !== 'file') throw new CommandError(AppError.file_system(`复制文件失败: ${src} (不是文件)`));
        const stream = await files.openRead(src);
        const reader = stream.getReader();
        const sink = await files.openFile(dst, { mode: 'truncate', createParents: true });
        let pos = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            await sink.write(next.value, pos);
            pos += next.value.byteLength;
          }
          await sink.sync();
        } finally {
          reader.releaseLock();
          await sink.close().catch(() => undefined);
        }
        return null;
      } catch (error) {
        wrapFileOpError('复制文件失败', src, error);
      }
    });

    ctx.commands.register<{ options: unknown }>('export_unified_backup_data', async ({ options }) => {
      const includeSettings = options !== null && typeof options === 'object'
        && (options as Record<string, unknown>).include_settings === true;
      const systemSettings: Record<string, string> = {};
      let apiConfigurations: unknown[] = [];
      let modelAssignments: unknown | null = null;
      if (includeSettings) {
        try {
          const settingsSvc = ctx.reflect.get('settings', false) as { listByPrefix?(prefix: string): readonly { key: string; value: string }[] } | undefined;
          const rows = typeof settingsSvc?.listByPrefix === 'function'
            ? settingsSvc.listByPrefix('')
            : storage.database('mistakes').all<{ key: string; value: string }>('SELECT key, value FROM settings ORDER BY key');
          for (const row of rows) systemSettings[row.key] = row.value;
        } catch (error) {
          throw new CommandError(AppError.database(`读取设置失败: ${error instanceof Error ? error.message : String(error)}`));
        }
        const llm = ctx.reflect.get('llm', false) as {
          getApiConfigs?(): Promise<unknown[]>;
          getModelAssignments?(): Promise<unknown>;
        } | undefined;
        if (!llm || typeof llm.getApiConfigs !== 'function' || typeof llm.getModelAssignments !== 'function') {
          throw new CommandError(AppError.database('导出API配置失败: LLM manager service is not available'));
        }
        try {
          apiConfigurations = await llm.getApiConfigs();
        } catch (error) {
          throw new CommandError(AppError.database(`导出API配置失败: ${error instanceof Error ? error.message : String(error)}`));
        }
        try {
          modelAssignments = await llm.getModelAssignments();
        } catch (error) {
          throw new CommandError(AppError.database(`导出模型分配失败: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
      return {
        version: '3.0' as const,
        timestamp: new Date().toISOString(),
        backup_type: 'unified' as const,
        traditional_data: {
          reviews: [],
          settings: {
            system_settings: systemSettings,
            api_configurations: apiConfigurations,
            model_assignments: modelAssignments,
          },
        },
        metadata: { export_options: options },
      };
    });
  },
});

/** `backup.ts` 的 `sanitizeBackupId` 同等约束：备份列表里的 id 才能直接拼进路径。 */
function isSafeBackupId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !value.startsWith('.')
    && !value.includes('..') && /^[A-Za-z0-9._-]+$/.test(value);
}
