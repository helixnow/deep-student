/**
 * Rust `lib.rs` setup 阶段发往前端的两个数据治理事件：
 * - `data-governance-migration-status`（lib.rs:1115-1141 成功/警告；1180-1189、1212-1218、1284-1289 失败）；
 * - `backup-jobs-resumable`（lib.rs:1437-1449）：启动时发现的可恢复备份任务，随后清理已结束任务。
 *
 * Host 中二者都由启动 finalizer 发出：迁移状态先于恢复激活（与 Rust 顺序一致），可恢复任务在
 * 恢复激活之后；恢复模式下组合根跳过 finalizer，等价 Rust 在恢复预检后提前返回。
 *
 * V03-02 方案 A：Rust 在 setup 里同步 emit，页面监听尚不存在，两个事件结构性丢失，用户看到的启动提示
 * 只来自前端拉取兜底（`data_governance_get_migration_status` / `list_resumable_jobs`）。Host 的 finalizer
 * 与主窗口加载并行，推给 webview 就可能送达，产生 Rust 用户从未见过的通知；因此只派发 Host 内部的
 * Cordis 事件（`ctx.on` 订阅），不走 `ctx.backendEvents`。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { StartupCoreRecovery, StartupMigrationFailure } from '../../../platform/storage/api.ts';
import type { Governance, StartupMigrationReport } from './governance.ts';
import type { Jobs } from './jobs.ts';
import type { Operations } from './operations.ts';
import { ioMessage } from './io.ts';

export const MIGRATION_STATUS_EVENT = 'data-governance-migration-status';
export const BACKUP_JOBS_RESUMABLE_EVENT = 'backup-jobs-resumable';

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 启动迁移状态（lib.rs 五处 setup 期载荷），仅 Host 内部。 */
    'data-governance-migration-status'(payload: Record<string, unknown>): void;
    /** 启动时发现的可恢复备份任务（lib.rs:1445 载荷），仅 Host 内部。 */
    'backup-jobs-resumable'(jobs: ReturnType<Jobs['listResumableJobs']>): void;
  }
}

/** lib.rs:1437-1449：非空才发事件；`list_resumable_jobs` / 清理失败均被 Rust 忽略。 */
export function announceResumableJobs(ctx: Context, jobs: Jobs): void {
  const log = ctx.logger('backup');
  try {
    const resumable = jobs.listResumableJobs();
    if (resumable.length > 0) {
      log.info(`🔄 [Backup] 发现 ${resumable.length} 个可恢复的备份任务`);
      ctx.emit(BACKUP_JOBS_RESUMABLE_EVENT, resumable);
    }
  } catch (error) {
    log.debug(`[Backup] 启动时列出可恢复任务失败: ${ioMessage(error)}`);
  }
  try { jobs.cleanupFinishedPersistedJobs(); }
  catch (error) { log.debug(`[Backup] 启动时清理已结束任务失败: ${ioMessage(error)}`); }
}

/**
 * F3 启动迁移报告。`StorageService` 尚未发布该只读快照；与 `componentHealth` 相同，读取服务
 * 实例（或其 `impl`）上的 `startupMigrationReport()`。缺失时返回 null，不伪造迁移结果。
 */
export function startupMigrationReport(storage: unknown): StartupMigrationReport | null {
  for (const candidate of [storage, (storage as { impl?: unknown } | null)?.impl]) {
    if (candidate === null || candidate === undefined || typeof candidate !== 'object') continue;
    const read = (candidate as { startupMigrationReport?: unknown }).startupMigrationReport;
    if (typeof read !== 'function') continue;
    const report = (read as () => unknown).call(candidate);
    if (report === null || report === undefined || typeof report !== 'object') return null;
    return report as StartupMigrationReport;
  }
  return null;
}

/** lib.rs:1104-1141 两种成功载荷。 */
export function migrationStatusPayload(summary: ReturnType<Governance['startupInitializationSummary']>): Record<string, unknown> {
  if (summary.fullySuccessful) {
    return {
      success: true,
      global_version: summary.globalVersion,
      migrations_applied: summary.migrationsApplied,
      duration_ms: summary.durationMs,
      warnings: [],
    };
  }
  return {
    success: true,
    global_version: summary.globalVersion,
    migrations_applied: summary.migrationsApplied,
    duration_ms: summary.durationMs,
    warnings: summary.warnings,
    has_warnings: true,
  };
}

export function announceMigrationStatus(ctx: Context, governance: Governance, auditWarning: string | null): void {
  const report = startupMigrationReport(ctx.storage);
  if (report === null) {
    ctx.logger('backup').debug('[DataGovernance] storage 未提供启动迁移报告，跳过 data-governance-migration-status');
    return;
  }
  const summary = governance.startupInitializationSummary(report, auditWarning);
  if (summary.fullySuccessful) governance.clearPersistedMigrationError();
  ctx.emit(MIGRATION_STATUS_EVENT, migrationStatusPayload(summary));
}

/** 与 {@link startupMigrationReport} 相同的结构化探测：F3 记录的启动迁移全局失败。 */
export function startupMigrationFailure(storage: unknown): StartupMigrationFailure | null {
  for (const candidate of [storage, (storage as { impl?: unknown } | null)?.impl]) {
    if (candidate === null || candidate === undefined || typeof candidate !== 'object') continue;
    const read = (candidate as { startupMigrationFailure?: unknown }).startupMigrationFailure;
    if (typeof read !== 'function') continue;
    const failure = (read as () => unknown).call(candidate);
    if (failure === null || failure === undefined || typeof failure !== 'object') return null;
    return failure as StartupMigrationFailure;
  }
  return null;
}

/** 与 {@link startupMigrationReport} 相同的结构化探测：F3 已进入的核心恢复屏障。 */
export function startupCoreRecovery(storage: unknown): StartupCoreRecovery | null {
  for (const candidate of [storage, (storage as { impl?: unknown } | null)?.impl]) {
    if (candidate === null || candidate === undefined || typeof candidate !== 'object') continue;
    const read = (candidate as { startupCoreRecovery?: unknown }).startupCoreRecovery;
    if (typeof read !== 'function') continue;
    const recovery = (read as () => unknown).call(candidate);
    if (recovery === null || recovery === undefined || typeof recovery !== 'object') return null;
    return recovery as StartupCoreRecovery;
  }
  return null;
}

export const RECOVERED_MIGRATION_MESSAGE = '数据库升级失败，已恢复到升级前状态并进入只读维护模式。请先导出备份或更新应用后重试。';

/** lib.rs:1212-1218（已从备份恢复）与 lib.rs:1284-1289（其余全局失败）。 */
export function migrationFailurePayload(failure: StartupMigrationFailure): Record<string, unknown> {
  if (failure.recovered) {
    return {
      success: false,
      recovered: true,
      error: failure.error,
      maintenance_mode_forced: true,
      message: RECOVERED_MIGRATION_MESSAGE,
    };
  }
  return { success: false, error: failure.error, degraded_mode: true, maintenance_mode_forced: failure.maintenanceForced };
}

/** lib.rs:1180-1189。 */
export function restoreActivationFailurePayload(error: string): Record<string, unknown> {
  return { success: false, error, degraded_mode: true, maintenance_mode_forced: true, restore_activation_failed: true };
}

/**
 * D2：lib.rs:1098-1419 数据治理启动段。失败不再让 Host 启动失败，而是：
 * - 全局迁移失败：持久化错误 → 发失败载荷 → 跳过恢复激活（Rust 只在 Ok 分支提交）；
 * - 迁移成功：发成功/警告载荷 → 提交恢复激活；激活失败时持久化错误并发 `restore_activation_failed`；
 * - 需要强制维护时进入全组件维护屏障，持续到 Host 卸载。屏障本身建立失败仍抛出（Rust setup 返回 Err）。
 *
 * 有意偏离 Rust：Rust 在核心组件被阻断时提前结束 setup（不构建 AppState），Host 无法“不装配”已安装插件，
 * 改为对相同数据库建立维护屏障，使依赖它们的命令得到明确的 MAINTENANCE 错误。
 */
export async function runDataGovernanceStartup(
  ctx: Context,
  governance: Governance,
  operations: Operations,
  auditWarning: string | null,
  activate: () => Promise<unknown>,
): Promise<void> {
  const log = ctx.logger('backup');
  const emit = (payload: Record<string, unknown>) => {
    try { ctx.emit(MIGRATION_STATUS_EVENT, payload); }
    catch (e) { log.warn(`发送迁移状态事件失败: ${ioMessage(e)}`); }
  };
  let failClose = false;
  // lib.rs:1312-1318 核心恢复模式：屏障由 storage 在业务插件装配前建立，这里只接管其维护态报告。
  const coreRecovery = startupCoreRecovery(ctx.storage);
  if (coreRecovery !== null) operations.adoptStartupBarrier(coreRecovery.databases);
  const failure = startupMigrationFailure(ctx.storage);
  if (failure !== null) {
    governance.persistMigrationError(failure.error);
    emit(migrationFailurePayload(failure));
    failClose = failure.maintenanceForced;
  } else {
    try { announceMigrationStatus(ctx, governance, auditWarning); }
    catch (e) { log.warn(`发送迁移状态事件失败: ${ioMessage(e)}`); }
    try {
      await activate();
    } catch (error) {
      const message = ioMessage(error);
      governance.persistMigrationError(message);
      emit(restoreActivationFailurePayload(message));
      log.warn('恢复槽激活事务提交失败，强制进入维护模式');
      failClose = true;
    }
  }
  if (!failClose) return;
  await operations.enterStartupFailClose();
  log.warn('⚠️ [DataGovernance] 初始化失败后已进入全组件维护模式');
}
