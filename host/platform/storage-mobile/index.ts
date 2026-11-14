/**
 * 移动端存储插件：`dstu.platform.storage` 的移动端实现（SQLite WASM + OPFS）。
 *
 * SQLite WASM 模块与迁移 SQL 由移动端外壳以 `sqliteRuntime` 服务注入（与桌面 better-sqlite3 由
 * Electron 打包进 Host 进程同理：原生 / WASM 绑定属于外壳，Host 源码不依赖具体包）。
 * 启动时迁移四个核心库（与桌面 coordinator 相同顺序与 SQL），然后发布 `ctx.storage`。
 * 迁移失败按桌面处理（startup.ts）：受阻核心库在业务插件装配前进入维护屏障，状态事件由启动 finalizer 发出。
 */
import { definePlugin, CommandError } from '../../kernel/core.ts';
import type { Context } from '@deepseek-ai/cordis';
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
import { MobileBackupService } from './backup.ts';
import { beginMobileStagedUpload, appendMobileStagedUpload, abortMobileStagedUpload } from '../files/mobile-local-runtime.ts';
import type { FilesService } from '../files/api.ts';

/** 桌面由 backup 插件的这个 finalizer 发迁移状态事件；它在场时移动端不重复发。 */
const BACKUP_STATUS_FINALIZER = 'backup.restore-activation';

declare module '@deepseek-ai/cordis' {
  interface Context {
    sqliteRuntime: SqliteRuntime;
  }
}

export { MobileStorageService } from './service.ts';
export type { SqliteRuntime } from './sqlite-wasm.ts';

export default definePlugin({
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
      'get_backup_config',
      'set_backup_config',
    ],
  },
  inject: ['sqliteRuntime'],
  async apply(ctx) {
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
    await importLegacyNativeDatabases(ctx, storage, ctx.sqliteRuntime);
    const report = await storage.migrations.runAll();
    if (!report.success) logger.error(`startup migration failed: ${report.error}`);
    const coreRecovery = await storage.enterCoreRecoveryBarrier();
    if (coreRecovery !== null) {
      ctx.effect(() => () => coreRecovery.release());
      logger.warn(`核心数据域不可安全打开，进入治理恢复启动模式: blocked_components=${JSON.stringify(storage.componentHealth.blockedComponents())}`);
    }
    let usageCollector: UsageCollector | null = null;
    if (!storage.componentHealth.isBlocked('llm_usage')) {
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

    ctx.commands.register('get_startup_recovery_status', () => guard(() => ({
      recovery_required: false,
      active_slot: 'slotA',
      pending_slot: null,
      healthy_candidates: ['slotA'],
      incidents: [],
    })));
    ctx.commands.register('list_startup_recovery_incidents', () => guard(() => []));
    ctx.commands.register('get_data_space_info', () => guard(() => ({
      active_slot: 'slotA',
      inactive_slot: 'slotB',
      pending_slot: null,
      active_dir: storage.locations.activeDir,
      inactive_dir: `${storage.locations.baseDir}/slots/slotB`,
    })));
    ctx.commands.register('get_slot_directory', ({ slotName }) => guard(() => {
      if (slotName !== 'slotA' && slotName !== 'slotB' && slotName !== 'slotC' && slotName !== 'slotD') {
        throw new CommandError(`无效的插槽名称: ${String(slotName)}`);
      }
      return `${storage.locations.baseDir}/slots/${slotName}`;
    }));
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
        is_in_maintenance_mode: blocked.length > 0,
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
    ctx.commands.register('data_governance_get_audit_logs', () => guard(() => ({
      logs: [],
      total: 0,
    })));
    // `data_governance_run_backup` / `_backup_tiered` / `_export_zip` write `<backupRoot>/<id>.zip`
    // in OPFS. The list is the actual directory content, not an in-memory placeholder.
    ctx.commands.register('data_governance_get_backup_list', () => guardAsync(async () => {
      const root = backupService().backupRoot;
      let entries;
      try { entries = await ctx.files.readDir(root); }
      catch { return []; }
      const backups: Array<Record<string, unknown>> = [];
      for (const entry of entries) {
        if (entry.kind !== 'file' || !entry.name.toLowerCase().endsWith('.zip')) continue;
        const stat = await ctx.files.stat(entry.path).catch(() => null);
        if (stat === null) continue;
        backups.push({
          path: entry.name.slice(0, -'.zip'.length),
          created_at: new Date(stat.modifiedMs > 0 ? stat.modifiedMs : Date.now()).toISOString(),
          size: stat.size,
          backup_type: 'full',
          recovery_kind: 'disaster_recovery',
          restorable: true,
          databases: [],
        });
      }
      return backups.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    }));
    ctx.commands.register('data_governance_list_backup_jobs', () => guard(() => backupService().jobs.list()));

    // ---------------------------------------------------------------- 数据迁移（ZIP 备份/恢复）
    //
    // 移动端没有可写的用户目录（也没有桌面 `plugin:dialog`），所以 backup/export 都落在
    // `<dataDir>/recovery/backups`，再由主线程 `mobile:save-backup` 交给系统分享/下载。导入接受
    // OPFS 路径或 `data:` URL；解出的库先暂存在 `imports/<id>/`，`restore_backup` 才覆盖活动槽并重载。
    let backup: MobileBackupService | null = null;
    const backupService = (): MobileBackupService => (backup ??= new MobileBackupService({
      ctx, storage, runtime: ctx.sqliteRuntime, files: ctx.reflect.get('files', false) as FilesService,
    }));

    ctx.commands.register('data_governance_get_backup_job', ({ jobId }) => guard(() => backupService().jobs.get(String(jobId))));

    ctx.commands.register('data_governance_run_backup', () => guard(() => {
      const jobs = backupService().jobs;
      const job = jobs.create('export');
      const id = `backup-${ctx.crypto.randomUUID()}`;
      void (async () => {
        job.update({ status: 'running', phase: 'scan', progress: 2, message: '正在导出 OPFS 数据库与附件' });
        const result = await backupService().exportBackup(id, null, (done, total, file) => {
          job.update({ phase: 'compress', progress: 3 + (done / Math.max(1, total)) * 95, processed_items: done, total_items: total, message: `正在写入 ${file}` });
        });
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
      })().catch((error: unknown) => job.fail(`备份失败: ${error instanceof Error ? error.message : String(error)}`));
      return { job_id: job.id, kind: 'export', status: 'queued', message: '备份任务已启动，请通过 backup-job-progress 事件监听进度' };
    }));

    ctx.commands.register('data_governance_backup_tiered', () => guard(() => {
      const jobs = backupService().jobs;
      const job = jobs.create('export');
      const id = `backup-${ctx.crypto.randomUUID()}`;
      void (async () => {
        job.update({ status: 'running', phase: 'scan', progress: 2, message: '正在导出 OPFS 数据库与附件' });
        const result = await backupService().exportBackup(id);
        job.complete({
          success: true, output_path: result.zipPath, resolved_path: result.zipPath,
          message: `备份完成: ${result.fileCount} 个文件`, error: null, duration_ms: null, requires_restart: false,
          stats: { backup_id: result.backupId, file_count: result.fileCount, total_size: result.totalSize, compressed_size: result.compressedSize },
        });
      })().catch((error: unknown) => job.fail(`分层备份失败: ${error instanceof Error ? error.message : String(error)}`));
      return { job_id: job.id, kind: 'export', status: 'queued', message: '备份任务已启动，请通过 backup-job-progress 事件监听进度' };
    }));

    const startExport = (
      id: string,
      outputPath: string | null,
      deliver: boolean,
    ) => {
      const jobs = backupService().jobs;
      const job = jobs.create('export');
      void (async () => {
        job.update({ status: 'running', phase: 'scan', progress: 2, message: '正在扫描备份数据' });
        const existing = outputPath === null ? await backupService().existingZip(id) : null;
        const result = outputPath !== null
          ? await backupService().exportBackup(id, outputPath, (done, total, file) => {
            job.update({ phase: 'compress', progress: 3 + (done / Math.max(1, total)) * 90, processed_items: done, total_items: total, message: `正在写入 ${file}` });
          })
          : existing !== null
            ? { zipPath: existing, fileCount: 0, totalSize: 0, compressedSize: 0, backupId: id }
            : await backupService().exportBackup(id, null, (done, total, file) => {
              job.update({ phase: 'compress', progress: 3 + (done / Math.max(1, total)) * 90, processed_items: done, total_items: total, message: `正在写入 ${file}` });
            });
        let method: string | null = null;
        if (deliver) {
          job.update({ phase: 'verify', progress: 96, message: '正在交给系统保存' });
          method = await backupService().deliver(result.zipPath, `${result.backupId}.zip`);
        }
        job.complete({
          success: true, output_path: result.zipPath, resolved_path: result.zipPath,
          message: `ZIP 导出完成: ${result.zipPath}`, error: null, duration_ms: null, requires_restart: false,
          stats: {
            backup_id: result.backupId, file_count: result.fileCount, total_size: result.totalSize,
            compressed_size: result.compressedSize, ...(method === null ? {} : { delivery: method }),
          },
        });
      })().catch((error: unknown) => job.fail(`ZIP 导出失败: ${error instanceof Error ? error.message : String(error)}`));
      return { job_id: job.id, kind: 'export', status: 'queued', message: 'ZIP 导出任务已启动，请通过 backup-job-progress 事件监听进度' };
    };

    ctx.commands.register('data_governance_export_zip', (args) => guard(() => {
      const outputPath = typeof args.outputPath === 'string' && args.outputPath.startsWith('/') ? args.outputPath : null;
      return startExport(String(args.backupId), outputPath, outputPath === null);
    }));

    ctx.commands.register('data_governance_backup_and_export_zip', (args) => guard(() => {
      const outputPath = typeof args.outputPath === 'string' && args.outputPath.startsWith('/') ? args.outputPath : null;
      return startExport(`backup-${ctx.crypto.randomUUID()}`, outputPath, outputPath === null);
    }));

    ctx.commands.register('data_governance_import_zip', (args) => guard(() => {
      const jobs = backupService().jobs;
      const job = jobs.create('import');
      void (async () => {
        job.update({ status: 'running', phase: 'scan', progress: 5, message: '正在解压 ZIP 备份' });
        const result = await backupService().importArchive(String(args.zipPath), typeof args.backupId === 'string' ? args.backupId : null);
        job.update({ status: 'running', phase: 'verify', progress: 95, message: '正在验证数据库' });
        job.complete({
          success: true, output_path: result.stageDir, resolved_path: result.stageDir,
          message: `已导入备份 ${result.backupId}`, error: null, duration_ms: null, requires_restart: false,
          stats: { backup_id: result.backupId, database_count: result.databaseCount, blob_count: result.blobCount, stage_dir: result.stageDir },
        });
      })().catch((error: unknown) => job.fail(`ZIP 导入失败: ${error instanceof Error ? error.message : String(error)}`));
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
        if (isSafeBackupId(backupId)) {
          const stageDir = `${backupService().backupRoot}/imports/${backupId}`;
          const zipPath = `${backupService().backupRoot}/${backupId}.zip`;
          const staged = await ctx.files.exists(stageDir).catch(() => false);
          if (!staged && await ctx.files.exists(zipPath).catch(() => false)) {
            job.update({ phase: 'scan', progress: 8, message: '正在解压备份归档' });
            await backupService().importArchive(zipPath, backupId);
          }
        }
        const result = await backupService().restoreArchive(backupId);
        job.update({ status: 'running', phase: 'verify', progress: 95, message: '恢复完成，正在重启应用' });
        job.complete({
          success: true, output_path: result.preRestoreZip, resolved_path: result.preRestoreZip,
          message: '恢复完成，应用即将重新加载', error: null, duration_ms: null, requires_restart: true,
          stats: {
            backup_id: String(args.backupId), database_count: result.databaseCount,
            blob_count: result.blobCount, pre_restore_backup: result.preRestoreZip,
          },
        });
        // 等事件送达到页面后再重载；数据已经落盘，重载只是让新连接读到恢复后的库。
        setTimeout(() => { void backupService().requestRestart(); }, 400);
      })().catch((error: unknown) => job.fail(`恢复失败: ${error instanceof Error ? error.message : String(error)}`));
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
    const configFiles = ctx.reflect.get('files', false) as FilesService | undefined;
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
    ctx.commands.register('get_backup_config', () => guard(() => backupConfig));
    ctx.commands.register('set_backup_config', ({ config }) => guardAsync(async () => {
      if (config && typeof config === 'object') backupConfig = { ...backupConfig, ...(config as Record<string, unknown>) };
      if (!configFiles) throw new Error('Mobile files service is unavailable');
      await configFiles.writeAtomic(backupConfigPath, `${JSON.stringify(backupConfig, null, 2)}\n`, { createParents: true });
      return null;
    }));
  },
});

/** `backup.ts` 的 `sanitizeBackupId` 同等约束：备份列表里的 id 才能直接拼进路径。 */
function isSafeBackupId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !value.startsWith('.')
    && !value.includes('..') && /^[A-Za-z0-9._-]+$/.test(value);
}

/** 0.15.x 原生 Android 的库文件布局（`<files>/slots/<slot>/…`），按归档名映射到移动端注册库。 */
const LEGACY_DATABASE_NAMES: Readonly<Record<string, DatabaseName>> = {
  'vfs.db': 'vfs',
  'chat_v2.db': 'chat_v2',
  'mistakes.db': 'mistakes',
  'llm_usage.db': 'llm_usage',
  'audit.db': 'audit',
};

interface LegacyDatabaseAnswer {
  readonly slot?: unknown;
  readonly files?: unknown;
}

function legacyBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

/**
 * 首次启动（OPFS 里四个核心库都还不存在）时，向主线程要旧版原生 Android 应用留下的 `.db` 字节。
 * 主线程读 `/data/user/0/com.deepstudent.app/files/slots/<slot>/`（含 slotB），这里在迁移建库之前
 * 写入 `opfs-sahpool`。读写失败只记 warn：没有旧数据的全新安装同样走这个分支。
 */
async function importLegacyNativeDatabases(ctx: Context, storage: MobileStorageService, runtime: SqliteRuntime): Promise<void> {
  const core: readonly DatabaseName[] = ['vfs', 'chat_v2', 'mistakes', 'llm_usage'];
  if (core.some((name) => runtime.exists(storage.pathOf(name)))) return;
  let answer: LegacyDatabaseAnswer | null;
  try {
    answer = await ctx.shell.request<LegacyDatabaseAnswer | null>('mobile:legacy-databases');
  } catch (error) {
    ctx.logger('storage').debug(`legacy native database check skipped: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (answer === null || typeof answer !== 'object' || !Array.isArray(answer.files)) return;
  const importDb = runtime.importDb;
  if (typeof importDb !== 'function') return;
  let imported = 0;
  for (const candidate of answer.files) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const name = (candidate as { name?: unknown }).name;
    const bytes = legacyBytes((candidate as { bytes?: unknown }).bytes);
    if (typeof name !== 'string' || bytes === null) continue;
    const database = LEGACY_DATABASE_NAMES[name.split('/').pop() ?? name];
    if (database === undefined) continue;
    if (bytes.byteLength < 512 || new TextDecoder('ascii').decode(bytes.subarray(0, 16)) !== 'SQLite format 3\0') {
      ctx.logger('storage').warn(`legacy native database ${name} is not an SQLite file; skipped`);
      continue;
    }
    try {
      await importDb.call(runtime, storage.pathOf(database), bytes);
      imported += 1;
    } catch (error) {
      // 旧数据导入失败不能挡住启动：迁移会在空库上继续，用户仍可正常使用新版本。
      ctx.logger('storage').warn(`importing legacy native database ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (imported > 0) {
    ctx.logger('storage').info(`imported ${imported} legacy native database file(s) from slot ${String(answer.slot ?? 'unknown')} before migrations`);
  }
}
