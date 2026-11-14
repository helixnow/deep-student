import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { definePlugin, CommandError } from '../../kernel/api.ts';
import { AppError } from '../errors/api.ts';
import type { ExactInjectionBudgetService, FeatureFlagsService, FileManagerPathsService, ImageQualityService, LlmUsageService, NoteAssetsService, VirtualFilePolicyService } from './api.ts';
import type {} from '../log/api.ts';
import type {} from '../secrets/api.ts';
import type {} from '../../../electron/api.ts';
import { DataSpaceStartup } from './startup.ts';
import { StorageCordisService, type StorageServiceOptions } from './service.ts';
import { slotFromName, databasePath } from './locations.ts';
import { openTestDatabase, parseSeedConfig, seedTestDatabase, TEST_DATABASE_FILE, testDatabasePath, type SeedResult } from './test-database.ts';
import { SqliteDatabase } from './database.ts';
import { writePurgeMarker } from './startup-cleanup.ts';
import { errorText } from './data-space-files.ts';
import { setStorageLogger, storageLog } from './logging.ts';
import { abort, append, beginIn, maxBytesForName, parseAppendRequest, stageFromReader, stagingDir } from './staged-upload.ts';
import { copyFileVerified, denyHiddenLocalPath, openReadStream } from './unified-file-manager.ts';
import { extractFileName, isVirtualUri, rejectDoubleEncodedVirtualUri } from './file-names.ts';
import { buildStartupRecoveryReport, exportIncidentZip, removeStagedRecoveryExport, startupRecoveryExportStagingPath } from './recovery-export.ts';
import {
  FeatureFlagManager,
  disableFlag,
  enableFlag,
  newFeatureFlag,
  setGradual,
  setUserSpecific,
  withDependencies,
  withVersionRange,
} from './feature-flags.ts';
import { ExactInjectionBudgetManager, InjectionBudgetManager, defaultBudgetConfig, defaultExactBudgetConfig, newInjectionItem } from './injection-budget.ts';
import {
  adjustImageQualityBase64,
  adjustImageQualityBytes,
  getPersistentAppDataDir,
  getTempAppDataDir,
  getWritableAppDataDir,
  portableRelativePath,
  resolveImagePath,
  resolveNoteAssetsDir,
  validateNoteAssetPathSegment,
} from './file-manager.ts';
import {
  deleteOldRecords,
  getDailySummary,
  getRecentUsage,
  getSessionUsage,
  getUsageByCaller,
  getUsageByModel,
  getUsageSummary,
  getUsageTrends,
  UsageCollector,
  cacheDebugEnabled,
  recordLlmUsage,
  recordLlmUsageCacheExt,
  recordLlmUsageCacheExtWithIdentity,
  recordLlmUsageExt,
  recordUsageRecord,
  setCacheDebugSource,
  type TimeGranularity,
} from './llm-usage.ts';

setCacheDebugSource(() => process.env.CHAT_V2_CACHE_DEBUG === '1');

function llmUsageFailure(error: unknown): CommandError {
  return new CommandError(errorText(error));
}

function stagedMessage(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return errorText(error);
}

export default definePlugin<Pick<StorageServiceOptions, 'migrationsDir' | 'dataLocalDir'>>({
  meta: {
    id: 'dstu.platform.storage', lane: 'F3-storage', provides: ['storage', 'dataSpace', 'featureFlags', 'injectionBudget', 'noteAssets', 'imageQuality', 'llmUsage', 'fileManagerPaths', 'virtualFilePolicy'],
    commands: ['get_data_space_info', 'get_slot_directory', 'get_test_slot_info', 'clear_test_slots',
      'mark_data_space_pending_switch_to_inactive', 'purge_all_database_files', 'purge_active_data_dir_now',
      'get_startup_recovery_status', 'retry_startup_recovery_preflight', 'list_startup_recovery_incidents',
      'resolve_startup_recovery', 'open_startup_recovery_incident_folder', 'restart_app',
      'export_startup_recovery_incident', 'export_startup_recovery_report',
      'get_database_info', 'set_test_run_id',
      'switch_to_test_database', 'reset_test_database', 'switch_to_production_database', 'seed_test_database',
      'staged_upload_begin', 'staged_upload_append', 'staged_upload_from_path', 'staged_upload_abort',
      'llm_usage_get_trends', 'llm_usage_by_model', 'llm_usage_by_caller', 'llm_usage_summary',
      'llm_usage_session_summary', 'llm_usage_recent', 'llm_usage_daily', 'llm_usage_cleanup'],
  },
  inject: ['secrets', 'paths', 'log'],
  async apply(ctx, config = {}) {
    setStorageLogger((target) => ctx.log.logger(target));
    ctx.effect(() => () => setStorageLogger(null));
    const startup = new DataSpaceStartup(ctx.app.dataDir, ctx.secrets.publication, async () => {
      const sync = ctx.get('storageStartupSync');
      if (!sync) throw new Error('L20 storageStartupSync 服务尚未就绪');
      await sync.resetDefaultAfterLocalPurge();
    });
    ctx.reflect.provide('dataSpace', startup);
    // Public utility services (feature_flags.rs / injection_budget.rs / file_manager.rs paths).
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
    ctx.reflect.provide('featureFlags', featureFlags);
    const injectionBudget: ExactInjectionBudgetService = {
      defaultConfig: defaultBudgetConfig,
      createManager: (config) => new InjectionBudgetManager(config),
      newItem: newInjectionItem,
      defaultExactConfig: defaultExactBudgetConfig,
      createExactManager: (config) => new ExactInjectionBudgetManager(config),
    };
    ctx.reflect.provide('injectionBudget', injectionBudget);
    const noteAssets: NoteAssetsService = {
      validateSegment: validateNoteAssetPathSegment,
      portableRelativePath,
      resolveDir: resolveNoteAssetsDir,
    };
    ctx.reflect.provide('noteAssets', noteAssets);
    const imageQuality: ImageQualityService = {
      adjustImageQualityBytes,
      adjustImageQualityBase64,
    };
    ctx.reflect.provide('imageQuality', imageQuality);
    const virtualFilePolicy: VirtualFilePolicyService = { isVirtualUri };
    ctx.reflect.provide('virtualFilePolicy', virtualFilePolicy);
    await startup.start();
    // F2 在 Electron main 解析资源目录（打包 `Resources/migrations` / 开发态仓库目录）
    // 并通过 `DS_MIGRATIONS_DIR` 交给 Host 进程；profile 未显式配置时以它为准。
    const migrationsDir = config.migrationsDir ?? (process.env.DS_MIGRATIONS_DIR || undefined);
    const storage = new StorageCordisService(ctx, {
      ...config,
      dataLocalDir: config.dataLocalDir ?? ctx.paths.os.dataLocal,
      ...(migrationsDir === undefined ? {} : { migrationsDir }),
      beforeMigrations: () => startup.start(),
      assertReady: () => startup.assertReady(),
    });
    if (!startup.status().recovery_required) {
      // lib.rs:1194-1306：全局迁移失败不终止启动。runAll 已记录失败并重建组件健康；
      // 失败载荷、`.last_migration_error` 与维护屏障由数据治理（backup）的启动 finalizer 负责。
      try { await storage.impl.migrations.runAll(); }
      catch (error) {
        // 迁移前的数据空间准备失败不属于 initialize_with_report，保持原有启动失败。
        if (storage.impl.startupMigrationFailure() === null) throw error;
        storageLog('dstu_storage::data_governance', 'warn', `⚠️ [DataGovernance] 初始化失败（将以降级模式继续运行）: ${errorText(error)}`);
      }
      // lib.rs:1312-1318 核心恢复启动模式：必须在业务插件装配（apply 内开库）之前进入屏障。
      const coreRecovery = await storage.impl.enterCoreRecoveryBarrier();
      if (coreRecovery !== null) {
        ctx.effect(() => () => coreRecovery.release());
        storageLog('dstu_storage::data_governance', 'warn',
          `[DataGovernance] 核心数据域不可安全打开，进入治理恢复启动模式: blocked_components=${JSON.stringify(storage.impl.componentHealth.blockedComponents())}`);
      }
    }

    // lib.rs:1585-1607: the UsageCollector exists only when llm_usage was initialised
    // (no recovery, component not blocked). Until then records wait in the bounded
    // pending queue (mod.rs:78) and are flushed by the next record after it exists.
    let usageCollector: UsageCollector | null = null;
    if (!startup.status().recovery_required && !storage.impl.componentHealth.isBlocked('llm_usage')) {
      const collector = new UsageCollector({ getConnSafe: () => storage.impl.database('llm_usage') });
      usageCollector = collector;
      storageLog('dstu_storage::llm_usage', 'info', '✅ LLM Usage Collector 初始化成功');
      // Host dispose closes the llm_usage connection (Rust keeps it until process exit),
      // so buffered records must be flushed before storage shuts down.
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
    ctx.reflect.provide('llmUsage', llmUsageService);

    // lib.rs:3482 build_app_state: FileManager::new(active_app_data_dir), images_dir = <dir>/images.
    // RUST-FIX(RF-W07-persistent-app-data-no-silent-relocation): persistent callers get a throwing variant.
    const fileManagerPaths: FileManagerPathsService = {
      getWritableAppDataDir: () => getWritableAppDataDir(storage.impl.locations.activeDir, ctx.paths.os.data, ctx.paths.os.temp),
      getPersistentAppDataDir: () => getPersistentAppDataDir(storage.impl.locations.activeDir),
      getTempAppDataDir: () => getTempAppDataDir(storage.impl.locations.activeDir, ctx.paths.os.data, ctx.paths.os.temp),
      resolveImagePath: (relativePath: string) => resolveImagePath(path.join(storage.impl.locations.activeDir, 'images'), relativePath),
    };
    ctx.reflect.provide('fileManagerPaths', fileManagerPaths);
    const manager = () => {
      if (!startup.initialized) throw new CommandError(AppError.internal('数据空间管理器未初始化'));
      return startup.manager;
    };
    ctx.commands.register('get_startup_recovery_status', async () => {
      // data_space.rs:2176-2187: setup readiness precedes reading recovery state.
      // F2 owns the gate; F1 marks it after finalizers (including recovery boot).
      const gate = ctx.get('startupGate');
      if (!gate) throw new CommandError(AppError.internal('启动完成闸门服务未注册'));
      if (!(await gate.waitStartupReady(120_000))) {
        throw new CommandError(AppError.internal('应用启动初始化超时（120 秒），请重启应用'));
      }
      try { return startup.status(); }
      catch (error) { throw new CommandError(AppError.internal(`读取启动恢复状态失败: ${errorText(error)}`)); }
    });
    ctx.commands.register('retry_startup_recovery_preflight', () => startup.retryPreflight());
    ctx.commands.register('list_startup_recovery_incidents', () => {
      try { return startup.incidents(); } catch (error) { throw new CommandError(AppError.file_system(`读取启动恢复记录失败: ${errorText(error)}`)); }
    });
    ctx.commands.register('resolve_startup_recovery', ({ candidateId }) => {
      if (!['legacy', 'slotA', 'slotB'].includes(candidateId as string)) throw new CommandError(AppError.validation('候选 id 必须是 legacy、slotA 或 slotB'));
      try { return startup.resolve(candidateId as string); } catch (error) { throw new CommandError(AppError.file_system(`解决启动恢复事件失败: ${errorText(error)}`)); }
    });
    ctx.commands.register('open_startup_recovery_incident_folder', async ({ incidentId }) => {
      let directory: string;
      try { directory = startup.recovery.incidentDirectory(incidentId as string); } catch (error) { throw new CommandError(AppError.file_system(`定位恢复事件目录失败: ${errorText(error)}`)); }
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open', [directory]);
          const timer = setTimeout(() => reject(new Error('等待文件管理器启动超时')), 10_000);
          timer.unref?.();
          const finish = (error?: Error) => {
            clearTimeout(timer);
            if (error) reject(error); else resolve();
          };
          child.once('error', (error) => finish(error));
          child.once('spawn', () => finish());
        });
      } catch (error) { throw new CommandError(AppError.file_system(`打开恢复事件目录失败: ${errorText(error)}`)); }
      return null;
    });
    ctx.commands.register('get_data_space_info', () => {
      const m = manager(); let state;
      try { state = m.readState(); } catch (error) { throw new CommandError(AppError.internal(`读取数据空间状态失败: ${errorText(error)}`)); }
      const active = state.active === 'slotB' ? 'slotB' : 'slotA';
      return { active_slot: active, inactive_slot: active === 'slotA' ? 'slotB' : 'slotA', pending_slot: state.pending, active_dir: m.activeDir(), inactive_dir: m.inactiveDir() };
    });
    ctx.commands.register('mark_data_space_pending_switch_to_inactive', () => {
      const m = manager(), target = m.inactiveSlot();
      try { m.markPendingSwitch(target); } catch (error) { throw new CommandError(AppError.file_system(`标记切换失败: ${errorText(error)}`)); }
      return `已标记下次重启切换到 ${target}`;
    });
    ctx.commands.register('purge_all_database_files', () => {
      writePurgeMarker(manager().baseDir);
      return '已标记：下次启动将清空所有数据（备份保留），即将重启应用以完成清空。';
    });
    ctx.commands.register('purge_active_data_dir_now', () => {
      throw new CommandError(AppError.validation('为保证数据库连接安全，移动端清空数据需要完整退出并重新打开应用，不能仅刷新页面'));
    });
    ctx.commands.register('get_test_slot_info', () => {
      const m = manager(), c = m.slotDir('slotC'), d = m.slotDir('slotD');
      const count = (dir: string) => { try { return fs.readdirSync(dir).length; } catch { return 0; } };
      return { slot_c_dir: c, slot_d_dir: d, slot_c_exists: fs.existsSync(c), slot_d_exists: fs.existsSync(d), slot_c_file_count: count(c), slot_d_file_count: count(d) };
    });
    ctx.commands.register('clear_test_slots', () => {
      const m = manager(); try { m.clearTestSlots(); } catch (error) { throw new CommandError(AppError.file_system(`清空测试插槽失败: ${errorText(error)}`)); }
      return '测试插槽 C 和 D 已清空';
    });
    ctx.commands.register('get_slot_directory', ({ slotName }) => {
      const m = manager(), slot = slotFromName(slotName as string);
      if (!slot) throw new CommandError(AppError.validation(`无效的插槽名称: ${slotName}`));
      return m.slotDir(slot);
    });
    ctx.commands.register('restart_app', async (_, call) => { await ctx.shell.request('plugin:process|restart', { __window: call.source.window }); return null; });

    ctx.commands.register('get_database_info', () => {
      if (!startup.initialized) throw new CommandError(AppError.internal('数据空间管理器未初始化'));
      const locations = storage.impl.locations;
      const production = databasePath(locations, 'mistakes');
      const test = testDatabasePath(locations);
      const appState = ctx.get('appCommandState') as { activeDatabase?: string } | undefined;
      return {
        production_db_path: production,
        test_db_path: test,
        test_db_exists: fs.existsSync(test),
        production_db_exists: fs.existsSync(production),
        active_database: appState?.activeDatabase ?? 'production',
      };
    });

    /**
     * `commands.rs:7174/7220/7340`：测试库在 FileManager 可写目录（活动槽）下。
     * RUST-FIX(RF-W07-persistent-app-data-no-silent-relocation): 测试库是持久数据，活动槽不可用时报错，
     * 不随 Rust 回退链挪到 `data_dir()/DeepStudent` 或 temp。`get_database_info` 只读，仍报活动槽路径。
     */
    const testDatabase = () => path.join(getPersistentAppDataDir(storage.impl.locations.activeDir), TEST_DATABASE_FILE);

    /** commands.rs:7199-7207 / 7253-7261 / 7291-7299：两步切换（Database + DatabaseManager）。 */
    const switchMistakesDatabase = (target: string) => {
      try { storage.impl.switchToPath('mistakes', target); }
      catch (error) { throw new CommandError(AppError.internal(`切换数据库连接失败: ${errorText(error)}`)); }
      try { storage.impl.refreshPool('mistakes'); }
      catch (error) { throw new CommandError(AppError.internal(`刷新数据库连接池失败: ${errorText(error)}`)); }
    };

    /** `state.active_database` 归 L22（AppCommandState）；缺失时 fail-close，不静默只切连接。 */
    const appCommandState = () => {
      const state = ctx.get('appCommandState') as { activeDatabase: 'production' | 'test' } | undefined;
      if (state === undefined) throw new CommandError(AppError.internal('应用命令状态服务尚未就绪'));
      return state;
    };

    ctx.commands.register('switch_to_test_database', () => {
      const appState = appCommandState();
      const testPath = testDatabase();
      try { fs.mkdirSync(path.dirname(testPath), { recursive: true }); }
      catch (error) { throw new CommandError(AppError.file_system(`创建测试数据库目录失败: ${errorText(error)}`)); }
      if (!fs.existsSync(testPath)) {
        try { openTestDatabase(testPath).close(); }
        catch (error) { throw new CommandError(AppError.file_system(`初始化测试数据库失败: ${errorText(error)}`)); }
        storageLog('dstu_storage::test_mode', 'info', `[测试模式] 已创建测试数据库: ${JSON.stringify(testPath)}`);
      } else {
        storageLog('dstu_storage::test_mode', 'info', `[测试模式] 使用现有测试数据库: ${JSON.stringify(testPath)}`);
      }
      switchMistakesDatabase(testPath);
      appState.activeDatabase = 'test';
      return { success: true, test_db_path: testPath, message: '已切换到测试数据库', active_database: 'test' };
    });

    ctx.commands.register('reset_test_database', () => {
      const appState = appCommandState();
      const testPath = testDatabase();
      const deletedFiles: string[] = [];
      if (fs.existsSync(testPath)) {
        try { fs.unlinkSync(testPath); }
        catch (error) { throw new CommandError(AppError.file_system(`删除测试数据库文件失败: ${errorText(error)}`)); }
        deletedFiles.push(testPath);
      }
      for (const suffix of ['-wal', '-shm']) {
        const extra = `${testPath}${suffix}`;
        if (!fs.existsSync(extra)) continue;
        try { fs.unlinkSync(extra); }
        catch (error) { storageLog('dstu_storage::test_mode', 'warn', `[测试模式] 删除测试数据库附属文件失败: ${extra}: ${errorText(error)}`); }
        deletedFiles.push(extra);
      }
      try { openTestDatabase(testPath).close(); }
      catch (error) { throw new CommandError(AppError.file_system(`重新创建测试数据库失败: ${errorText(error)}`)); }
      storageLog('dstu_storage::test_mode', 'info', `[测试模式] 已重置测试数据库: ${JSON.stringify(testPath)}`);
      if (appState.activeDatabase === 'test') switchMistakesDatabase(testPath);
      return { success: true, test_db_path: testPath, deleted_files: deletedFiles, message: '测试数据库已重置', active_database: appState.activeDatabase };
    });

    ctx.commands.register('switch_to_production_database', () => {
      const appState = appCommandState();
      const productionPath = databasePath(storage.impl.locations, 'mistakes');
      storageLog('dstu_storage::test_mode', 'info', `[测试模式] 切换回生产数据库: ${JSON.stringify(productionPath)}`);
      switchMistakesDatabase(productionPath);
      appState.activeDatabase = 'production';
      return { success: true, production_db_path: productionPath, message: '已切换回生产数据库', active_database: 'production' };
    });

    ctx.commands.register<{ config?: unknown }>('seed_test_database', ({ config }) => {
      const testPath = testDatabase();
      if (!fs.existsSync(testPath)) {
        try { openTestDatabase(testPath).close(); }
        catch (error) { throw new CommandError(AppError.file_system(`初始化测试数据库失败: ${errorText(error)}`)); }
      }
      let db;
      try { db = openTestDatabase(testPath); }
      catch (error) { throw new CommandError(AppError.file_system(`打开测试数据库失败: ${errorText(error)}`)); }
      let result;
      try { result = seedTestDatabase(db, parseSeedConfig(config)); }
      finally { db.close(); }
      storageLog('dstu_storage::test_mode', 'info',
        `[测试模式] 测试数据库播种完成: 错题${result.mistakes_created}条, 消息${result.messages_created}条, 数据库: ${JSON.stringify(testPath)}`);
      for (const message of result.errors) storageLog('dstu_storage::test_mode', 'error', `[测试模式] 播种错误: ${message}`);
      return {
        success: true,
        mistakes_created: result.mistakes_created,
        messages_created: result.messages_created,
        errors: result.errors,
        test_db_path: testPath,
      };
    });

    ctx.commands.register('set_test_run_id', ({ testRunId }) => {
      storageLog('dstu_storage::test_mode', 'info', `[测试模式] TestRunId设置: ${testRunId as string}`);
      return { success: true, test_run_id: testRunId as string };
    });

    ctx.commands.register('export_startup_recovery_incident', async ({ incidentId, destination }) => {
      const target = destination as string;
      let source: string;
      try { source = startup.recovery.incidentDirectory(incidentId as string); }
      catch (error) { throw new CommandError(AppError.file_system(`定位恢复事件目录失败: ${errorText(error)}`)); }

      if (isVirtualUri(target)) {
        let staged: string;
        try { staged = startupRecoveryExportStagingPath(ctx.app.dataDir, 'zip'); }
        catch (error) { throw new CommandError(AppError.file_system(`创建恢复导出临时文件失败: ${errorText(error)}`)); }
        try {
          try { await exportIncidentZip(source, staged); }
          catch (error) { throw new CommandError(AppError.file_system(`导出恢复事件失败: ${errorText(error)}`)); }
          try { await copyFileVerified(staged, target); }
          catch (error) { throw new CommandError(AppError.file_system(`写入目标位置失败: ${stagedMessage(error)}`)); }
        } finally { removeStagedRecoveryExport(staged); }
        return target;
      }

      try { rejectDoubleEncodedVirtualUri(target); } catch (error) { throw new CommandError(error); }
      try { await exportIncidentZip(source, target); }
      catch (error) { throw new CommandError(AppError.file_system(`导出恢复事件失败: ${errorText(error)}`)); }
      return target;
    });

    ctx.commands.register('export_startup_recovery_report', async ({ destination }) => {
      const target = destination as string;
      const status = startup.status();
      let incidents: ReturnType<typeof startup.incidents>;
      try { incidents = startup.incidents(); }
      catch (error) { storageLog('dstu_storage::data_space', 'warn', `读取启动恢复记录失败，诊断报告按空列表生成: ${errorText(error)}`); incidents = []; }
      const payload = buildStartupRecoveryReport(
        status,
        incidents,
        status.recovery_required ? null : storage.impl.componentHealth,
      );
      let bytes: Buffer;
      try { bytes = Buffer.from(JSON.stringify(payload, null, 2), 'utf8'); }
      catch (error) { throw new CommandError(AppError.internal(`生成诊断报告失败: ${errorText(error)}`)); }

      if (isVirtualUri(target)) {
        let staged: string;
        try { staged = startupRecoveryExportStagingPath(ctx.app.dataDir, 'json'); }
        catch (error) { throw new CommandError(AppError.file_system(`创建诊断报告临时文件失败: ${errorText(error)}`)); }
        try {
          try { fs.writeFileSync(staged, bytes); }
          catch (error) { throw new CommandError(AppError.file_system(`写入诊断报告失败: ${errorText(error)}`)); }
          try { await copyFileVerified(staged, target); }
          catch (error) { throw new CommandError(AppError.file_system(`写入目标位置失败: ${stagedMessage(error)}`)); }
        } finally { removeStagedRecoveryExport(staged); }
        return target;
      }

      try { rejectDoubleEncodedVirtualUri(target); } catch (error) { throw new CommandError(error); }
      try { fs.mkdirSync(path.dirname(target), { recursive: true }); }
      catch (error) { throw new CommandError(AppError.file_system(`创建诊断报告目录失败: ${errorText(error)}`)); }
      try { fs.writeFileSync(target, bytes); }
      catch (error) { throw new CommandError(AppError.file_system(`写入诊断报告失败: ${errorText(error)}`)); }
      return target;
    });

    const staging = () => stagingDir(ctx.paths.appCacheDir);
    ctx.commands.register('staged_upload_begin', ({ name, totalSize }) => {
      try { return beginIn(staging(), name as string, totalSize as number, maxBytesForName(name as string)); }
      catch (error) { throw new CommandError(stagedMessage(error)); }
    });
    ctx.commands.register('staged_upload_append', (_, call) => {
      const headers = call.headers ?? {};
      try {
        const request = parseAppendRequest(call.payload, headers['x-upload-id'], headers['x-upload-offset']);
        return append(request.uploadId, request.offset, request.bytes);
      } catch (error) { throw new CommandError(stagedMessage(error)); }
    });
    ctx.commands.register('staged_upload_from_path', async ({ path }) => {
      const appDirs = [ctx.app.dataDir, ctx.paths.appLocalDataDir, ctx.paths.appCacheDir];
      let name: string;
      let reader: ReturnType<typeof openReadStream>;
      try {
        denyHiddenLocalPath(appDirs, path as string);
        name = extractFileName(path as string);
        reader = openReadStream(path as string);
      } catch (error) { throw new CommandError(stagedMessage(error)); }
      try {
        const staged = await stageFromReader(staging(), name, reader, maxBytesForName(name));
        return { uploadId: staged.uploadId, size: staged.size };
      } catch (error) { throw new CommandError(stagedMessage(error)); }
    });
    ctx.commands.register('staged_upload_abort', ({ uploadId }) => { abort(uploadId as string); return null; });

    const llmUsage = () => storage.impl.database('llm_usage');
    ctx.commands.register('llm_usage_get_trends', ({ days, granularity }) => {
      const parsed: TimeGranularity = granularity === 'hour' || granularity === 'day' || granularity === 'week' || granularity === 'month'
        ? granularity
        : 'day';
      try { return getUsageTrends(llmUsage(), days as number, parsed); }
      catch (error) { throw llmUsageFailure(error); }
    });
    ctx.commands.register('llm_usage_by_model', ({ startDate, endDate }) => {
      try { return getUsageByModel(llmUsage(), startDate as string, endDate as string); }
      catch (error) { throw llmUsageFailure(error); }
    });
    ctx.commands.register('llm_usage_by_caller', ({ startDate, endDate }) => {
      try { return getUsageByCaller(llmUsage(), startDate as string, endDate as string); }
      catch (error) { throw llmUsageFailure(error); }
    });
    ctx.commands.register('llm_usage_summary', ({ startDate, endDate }) => {
      try { return getUsageSummary(llmUsage(), startDate as string | null | undefined, endDate as string | null | undefined); }
      catch (error) { throw llmUsageFailure(error); }
    });
    ctx.commands.register('llm_usage_session_summary', ({ sessionId }) => {
      try { return getSessionUsage(llmUsage(), sessionId as string); }
      catch (error) { throw llmUsageFailure(error); }
    });
    ctx.commands.register('llm_usage_recent', ({ limit }) => {
      try { return getRecentUsage(llmUsage(), (limit as number | null | undefined) ?? 50); }
      catch (error) { throw llmUsageFailure(error); }
    });
    ctx.commands.register('llm_usage_daily', ({ startDate, endDate }) => {
      try { return getDailySummary(llmUsage(), startDate as string, endDate as string); }
      catch (error) { throw llmUsageFailure(error); }
    });
    ctx.commands.register('llm_usage_cleanup', ({ beforeDate }) => {
      try { return deleteOldRecords(llmUsage(), beforeDate as string); }
      catch (error) { throw llmUsageFailure(error); }
    });
  },
});
