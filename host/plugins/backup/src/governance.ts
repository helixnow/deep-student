import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { getAvailableDiskSpace } from '../../../platform/storage/backup-common.ts';
import { dirname, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type {
  AuditLogPagedResponse, DatabaseDetailResponse, DatabaseHealthStatus, DatabaseStatusResponse,
  HealthCheckResponse, MaintenanceStatusResponse, MigrationDatabaseStatus, MigrationStatusResponse,
  SchemaRegistryResponse, SlotMigrationTestResponse, StartupComponentHealth, StartupComponentIssue,
} from '../../../../contracts/ipc/generated/L21-backup-governance.ts';
import { DEFAULT_MIGRATIONS_DIR } from '../../../platform/storage/migration/definitions/index.ts';
import { StorageError, type DatabaseHandle, type SqlExecutor } from '../../../platform/storage/api.ts';
import { createMigrationWorker, type MigrationWorker, type MigrationWorkerReport } from '../../../platform/storage/node.ts';
import { DATABASE_IDS, type CoordinatedId } from './migrations.ts';
import { databasePath, resolveTargetAndPending, TOTAL_DATABASES } from './paths.ts';
import {
  aggregateSchemaRegistry, calculateGlobalVersion, checkDependencies, type DatabaseOpener, type SchemaRegistry,
} from '../repository/schema-registry.ts';

/** F3 启动 `migrations.runAll()` 的报告（`MigrationReport` 中本模块需要的字段）。 */
export interface StartupMigrationReport {
  readonly success: boolean;
  readonly totalDurationMs: number;
  readonly databases: ReadonlyArray<{ readonly appliedCount: number }>;
}

export interface StartupInitializationSummary {
  readonly globalVersion: number;
  readonly migrationsApplied: number;
  readonly durationMs: number;
  readonly warnings: string[];
  readonly fullySuccessful: boolean;
}
import {
  cleanupKeepRecent, cleanupOldEntries, completeAuditLog, failAuditLog, initAuditTable,
  newAuditLog, queryAuditLogsPaged, saveAuditLog, toAuditLogResponse, withAuditDetails,
  type AuditQueryResult,
} from '../repository/audit.ts';
import { foreignKeyCheckIterator, quickCheck, recentFailedMigrations } from '../repository/diagnostics.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import { ioMessage } from './io.ts';
import type { Operations } from './operations.ts';

const MIGRATION_ERROR_FILE = '.last_migration_error';
/** 卸载等测试槽与迁移线程收尾的上限；超时后不再拖住卸载链，退出时它们随进程结束（同 Rust 退出不等待）。 */
export const GOVERNANCE_DISPOSE_WAIT_MS = 10_000;

const I64_MIN = -9223372036854775808n;
const I64_MAX = 9223372036854775807n;

/** Rust `i64::from_str`：可选单个 `+`/`-`，其后至少一位 ASCII 十进制数字，结果须在 i64 范围内。 */
function parseI64(text: string): bigint | null {
  if (!/^[+-]?[0-9]+$/.test(text)) return null;
  const value = BigInt(text);
  return value < I64_MIN || value > I64_MAX ? null : value;
}

export interface GovernanceOptions {
  readonly ctx: Context;
  readonly operations: Operations;
}

interface AuditHealth {
  message: string;
  occurredAt: string;
}

type SandboxSlot = 'slotC' | 'slotD';

export class Governance {
  readonly ctx: Context;
  readonly operations: Operations;
  private auditHealth: AuditHealth | null = null;
  private readonly migrations: MigrationWorker;
  // RUST-FIX(RF-W08-diagnostic-slots-concurrent): Rust 在同一线程依次跑 C、D；两槽目录互不相干，D 用自己的线程与 C 并发。
  private readonly slotDMigrations: MigrationWorker;
  private readonly sandboxJobs: Record<SandboxSlot, Promise<void>> = { slotC: Promise.resolve(), slotD: Promise.resolve() };

  constructor(options: GovernanceOptions) {
    this.ctx = options.ctx;
    this.operations = options.operations;
    this.migrations = createMigrationWorker({ baseDir: this.ctx.app.dataDir });
    this.slotDMigrations = createMigrationWorker({ baseDir: this.ctx.app.dataDir });
    this.ctx.effect(() => async () => {
      // 排队的测试槽任务也须先完成其迁移/清理，再由 F3 drain 已接收的迁移并关闭线程。
      const drained = Promise.all([this.sandboxJobs.slotC, this.sandboxJobs.slotD])
        .then(() => Promise.all([this.migrations.close(), this.slotDMigrations.close()]))
        .then(() => false);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        drained,
        new Promise<true>(resolve => { timer = setTimeout(resolve, GOVERNANCE_DISPOSE_WAIT_MS, true); }),
      ]).finally(() => clearTimeout(timer));
      if (timedOut) {
        drained.catch(error => this.ctx.logger('backup').warn(`[DataGovernance] 卸载后关闭迁移线程失败: ${ioMessage(error)}`));
        this.ctx.logger('backup').warn(
          `[DataGovernance] 测试槽或迁移线程 ${GOVERNANCE_DISPOSE_WAIT_MS}ms 内未收尾，卸载不再等待；它们结束后线程随即关闭`,
        );
      }
    });
  }

  /** 只切换执行线程；迁移算法、备份 guard、错误与日志均由 F3 正式入口保持。 */
  runMigrations(appDataDir: string, auditDbPath?: string | null): Promise<MigrationWorkerReport> {
    const worker = appDataDir === this.slotDir('slotD') ? this.slotDMigrations : this.migrations;
    const diagnosticSandbox = appDataDir === this.slotDir('slotC') || appDataDir === this.slotDir('slotD');
    return worker.runAll({
      appDataDir, migrationsDir: process.env.DS_MIGRATIONS_DIR || DEFAULT_MIGRATIONS_DIR,
      ...(auditDbPath === undefined ? {} : { auditDbPath }),
      ...(diagnosticSandbox ? { diagnosticSandbox: true } : {}),
    });
  }

  /** 同一槽的 reset/copy/migrate/cleanup 整体排队；不同槽的目录互不相干。 */
  private runSandboxTest(slot: SandboxSlot, run: () => Promise<SlotMigrationTestResponse>): Promise<SlotMigrationTestResponse> {
    const job = this.sandboxJobs[slot].then(run);
    // 此 promise 只维持队列顺序；调用方仍得到原 job 的成功/失败，不吞业务错误。
    this.sandboxJobs[slot] = job.then(() => undefined, () => undefined);
    return job;
  }

  private get activeDir(): string { return this.ctx.storage.locations.activeDir; }

  /** `try_save_audit_log`：best-effort，失败只影响健康快照。 */
  trySaveAuditLog(log: Parameters<typeof saveAuditLog>[1]): void {
    try {
      const db = this.ctx.storage.database('audit');
      initAuditTable(db);
      saveAuditLog(db, log);
      this.auditHealth = null;
    } catch (e) {
      this.auditHealth = { message: `写入审计日志失败: ${ioMessage(e)}`, occurredAt: toRfc3339() };
      this.ctx.logger('backup').warn(`[data_governance] 写入审计日志失败: ${ioMessage(e)}`);
    }
  }

  private opener(): DatabaseOpener {
    const storage = this.ctx.storage;
    return {
      open: (path, options) => storage.openFile(path, options),
      close: handle => storage.close(handle as DatabaseHandle),
    };
  }

  /** `refresh_schema_registry_from_live_state`。 */
  private refreshSchemaRegistry(isBlocked?: (id: CoordinatedId) => boolean): SchemaRegistry {
    try {
      return aggregateSchemaRegistry(this.activeDir, this.opener(), toRfc3339, isBlocked);
    } catch (e) {
      throw new Error(`刷新 SchemaRegistry 失败 (${this.activeDir}): ${ioMessage(e)}`);
    }
  }

  private readPersistedMigrationError(): { error: string; timestamp: string } | null {
    const path = join(this.activeDir, MIGRATION_ERROR_FILE);
    let content: string;
    try { content = readFileSync(path, 'utf8'); }
    catch { return null; }
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (typeof parsed.error !== 'string' || typeof parsed.timestamp !== 'string') return null;
      return { error: parsed.error, timestamp: parsed.timestamp };
    } catch { return null; }
  }

  getSchemaRegistry(): SchemaRegistryResponse {
    const registry = this.refreshSchemaRegistry();
    return {
      global_version: registry.global_version,
      aggregated_at: registry.aggregated_at,
      databases: DATABASE_IDS.flatMap(id => {
        const status = registry.databases.get(id);
        if (!status) return [];
        const response: DatabaseStatusResponse = {
          id,
          schema_version: status.schema_version,
          min_compatible_version: status.min_compatible_version,
          max_compatible_version: status.max_compatible_version,
          data_contract_version: status.data_contract_version,
          migration_count: status.migration_history.length,
          checksum: status.checksum,
          updated_at: status.updated_at,
        };
        return [response];
      }),
    };
  }

  getAuditLogs(args: {
    operationType?: string | null;
    status?: string | null;
    limit?: number | null;
    offset?: number | null;
  }): AuditLogPagedResponse {
    // Rust 先取审计库连接，再做 status 校验（commands.rs:537-554）。
    let db: SqlExecutor;
    try { db = this.ctx.storage.database('audit'); }
    catch (e) { throw new Error(`获取审计数据库连接失败: ${ioMessage(e)}`); }
    let status: 'Started' | 'Completed' | 'Failed' | 'Partial' | undefined;
    if (args.status != null) {
      switch (args.status) {
        case 'Started': status = 'Started'; break;
        case 'Completed': status = 'Completed'; break;
        case 'Failed': status = 'Failed'; break;
        case 'Partial': status = 'Partial'; break;
        default:
          throw new Error(`无效的状态过滤值: ${args.status}。可选值: Completed, Failed, Partial`);
      }
    }
    let result: AuditQueryResult;
    try {
      result = queryAuditLogsPaged(db, {
        operation_type: args.operationType ?? undefined,
        status,
        limit: args.limit ?? 100,
        offset: args.offset ?? undefined,
      });
    } catch (e) {
      throw new Error(`查询审计日志失败: ${ioMessage(e)}`);
    }
    return { logs: result.logs.map(toAuditLogResponse), total: result.total };
  }

  cleanupAuditLogs(args: {
    keepRecent?: number | null;
    beforeDays?: number | null;
    confirmationToken: string;
  }): number {
    const TOKEN_PREFIX = 'AUDIT_CLEANUP_';
    const TOKEN_VALIDITY_SECS = 60;
    if (!args.confirmationToken.startsWith(TOKEN_PREFIX)) {
      throw new Error('审计清理令牌格式无效，需要 AUDIT_CLEANUP_{unix_timestamp}');
    }
    const tokenTsExact = parseI64(args.confirmationToken.slice(TOKEN_PREFIX.length));
    if (tokenTsExact === null) throw new Error('审计清理令牌中的时间戳无效');
    const delta = BigInt(Math.floor(Date.now() / 1000)) - tokenTsExact;
    const diff = delta < 0n ? -delta : delta;
    if (diff > BigInt(TOKEN_VALIDITY_SECS)) {
      throw new Error(`审计清理令牌已过期（差值 ${diff}s，允许 ${TOKEN_VALIDITY_SECS}s 内）`);
    }
    const tokenTs = Number(tokenTsExact);

    const MIN_KEEP_RECENT = 100;
    const MIN_BEFORE_DAYS = 7;
    if (args.keepRecent != null && args.keepRecent < MIN_KEEP_RECENT) {
      throw new Error(`keep_recent 不得低于 ${MIN_KEEP_RECENT}，当前值: ${args.keepRecent}`);
    }
    if (args.beforeDays != null && args.beforeDays < MIN_BEFORE_DAYS) {
      throw new Error(`before_days 不得低于 ${MIN_BEFORE_DAYS} 天，当前值: ${args.beforeDays}`);
    }

    let db: SqlExecutor;
    try { db = this.ctx.storage.database('audit'); }
    catch (e) { throw new Error(`获取审计数据库连接失败: ${ioMessage(e)}`); }

    this.trySaveAuditLog(completeAuditLog(
      withAuditDetails(newAuditLog({ type: 'Maintenance', action: 'cleanup_audit_logs' }, 'cleanup_audit_logs_initiated'), {
        keep_recent: args.keepRecent ?? null,
        before_days: args.beforeDays ?? null,
        confirmation_token_ts: tokenTs,
      }),
      0,
    ));

    const DEFAULT_MAX_AGE_DAYS = 90;
    let deleted: number;
    try {
      deleted = args.keepRecent != null
        ? cleanupKeepRecent(db, args.keepRecent)
        : cleanupOldEntries(db, args.beforeDays ?? DEFAULT_MAX_AGE_DAYS);
    } catch (e) {
      this.trySaveAuditLog(failAuditLog(
        newAuditLog({ type: 'Maintenance', action: 'cleanup_audit_logs' }, 'cleanup_audit_logs'),
        ioMessage(e),
      ));
      throw new Error(`清理审计日志失败: ${ioMessage(e)}`);
    }

    this.trySaveAuditLog(completeAuditLog(
      withAuditDetails(newAuditLog({ type: 'Maintenance', action: 'cleanup_audit_logs' }, 'cleanup_audit_logs'), {
        deleted_count: deleted,
        keep_recent: args.keepRecent ?? null,
        before_days: args.beforeDays ?? null,
      }),
      0,
    ));
    return deleted;
  }

  getMigrationStatus(): MigrationStatusResponse {
    const registry = this.refreshSchemaRegistry();
    let pendingTotal = 0;
    let lastError: string | null = null;
    const databases: MigrationDatabaseStatus[] = DATABASE_IDS.map(id => {
      const status = registry.databases.get(id);
      const currentVersion = status?.schema_version ?? 0;
      const target = resolveTargetAndPending(id, currentVersion, status);
      pendingTotal += target.pendingCount;
      if (target.pendingCount > 0 && currentVersion > 0) {
        const message = `${id} 有 ${target.pendingCount} 个迁移未执行 (当前: v${currentVersion}, 目标: v${target.targetVersion})`;
        this.ctx.logger('backup').warn(`⚠️ [MigrationStatus] ${message}`);
        if (lastError === null) lastError = message;
      }
      return {
        id,
        current_version: currentVersion,
        target_version: target.targetVersion,
        is_initialized: currentVersion > 0,
        last_migration_at: status && status.updated_at !== '' ? status.updated_at : null,
        pending_count: target.pendingCount,
        has_pending: target.pendingCount > 0,
      };
    });
    const allHealthy = databases.every(d => d.is_initialized && !d.has_pending);
    if (pendingTotal > 0) {
      const persisted = this.readPersistedMigrationError();
      if (persisted) lastError = persisted.error;
    }
    return {
      global_version: registry.global_version,
      all_healthy: allHealthy,
      databases,
      pending_migrations_total: pendingTotal,
      has_pending_migrations: pendingTotal > 0,
      last_error: lastError,
    };
  }

  /**
   * `init.rs::initialize_with_report` 的 Ok 分支汇总（init.rs:181-239）：迁移报告由 F3 启动迁移给出，
   * 这里补齐依赖校验降级、组件健康告警、全局版本与 `is_fully_successful`。
   */
  startupInitializationSummary(report: StartupMigrationReport, auditWarning: string | null): StartupInitializationSummary {
    // init.rs:199-202 `aggregate_schema_registry_with_health`：启动健康中已阻断的库不参与聚合。
    const blocked = new Set((startupComponentHealth(this.ctx.storage)?.issues ?? [])
      .filter(issue => issue.status === 'blocked').map(issue => issue.component));
    const registry = this.refreshSchemaRegistry(id => blocked.has(id));
    const warnings: string[] = auditWarning === null ? [] : [auditWarning];
    try { checkDependencies(registry); }
    catch (e) {
      const blocked = DATABASE_IDS.find(id => registry.databases.has(id) && dependenciesOf(id).some(dep => {
        const status = registry.databases.get(dep);
        return status === undefined || (status.schema_version === 0 && registry.databases.get(id)!.schema_version > 0);
      }));
      if (blocked !== undefined) registry.databases.delete(blocked);
      registry.global_version = calculateGlobalVersion(registry.databases.values());
      warnings.push(`Schema dependency validation degraded: ${ioMessage(e)}`);
    }
    for (const issue of startupComponentHealth(this.ctx.storage)?.issues ?? []) {
      if (issue.component === 'audit') continue;
      const warning = issue.reason ?? `${issue.component} startup degraded`;
      if (!warnings.includes(warning)) warnings.push(warning);
    }
    return {
      globalVersion: registry.global_version,
      migrationsApplied: report.databases.reduce((sum, db) => sum + db.appliedCount, 0),
      durationMs: report.totalDurationMs,
      warnings,
      fullySuccessful: auditWarning === null && report.success && warnings.length === 0,
    };
  }

  /** `commands::clear_migration_error`：迁移完全成功后删除持久化的上次错误。 */
  /** `commands.rs:61-74 persist_migration_error`：写失败只记日志。 */
  persistMigrationError(error: string): void {
    const path = join(this.activeDir, MIGRATION_ERROR_FILE);
    try { writeFileSync(path, JSON.stringify({ error, timestamp: toRfc3339() })); }
    catch (e) { this.ctx.logger('backup').warn(`Failed to persist migration error to file ${path}: ${ioMessage(e)}`); }
  }

  clearPersistedMigrationError(): void {
    try { rmSync(join(this.activeDir, MIGRATION_ERROR_FILE), { force: true }); }
    catch (e) { this.ctx.logger('backup').warn(`清除迁移错误记录失败: ${ioMessage(e)}`); }
  }

  runHealthCheck(): HealthCheckResponse {
    this.ctx.logger('backup').info('🔍 [HealthCheck] 开始运行健康检查...');
    const registry = this.refreshSchemaRegistry();
    let dependencyOk = true;
    let dependencyError: string | null = null;
    try { checkDependencies(registry); }
    catch (e) {
      dependencyOk = false;
      dependencyError = ioMessage(e);
      this.ctx.logger('backup').warn(`⚠️ [HealthCheck] 依赖关系检查失败: ${dependencyError}`);
    }

    const initializedCount = [...registry.databases.values()].filter(s => s.schema_version > 0).length;
    const uninitializedCount = TOTAL_DATABASES - initializedCount;
    let pendingTotal = 0;

    const health: DatabaseHealthStatus[] = DATABASE_IDS.map(id => {
      const status = registry.databases.get(id);
      const schemaVersion = status?.schema_version ?? 0;
      const target = resolveTargetAndPending(id, schemaVersion, status);
      const isInitialized = schemaVersion > 0;
      pendingTotal += target.pendingCount;
      const dependenciesMet = dependenciesOf(id).every(dep => {
        const depStatus = registry.databases.get(dep);
        return depStatus !== undefined && depStatus.schema_version > 0;
      });
      const issues: string[] = [];
      if (!isInitialized) issues.push('数据库未初始化');
      if (!dependenciesMet) issues.push('依赖数据库未就绪');
      if (target.pendingCount > 0) {
        issues.push(`有 ${target.pendingCount} 个迁移待执行 (当前: v${schemaVersion}, 目标: v${target.targetVersion})`);
      }
      if (isInitialized) {
        try { this.integrityCheck(databasePath(this.activeDir, id)); }
        catch (e) { issues.push(`数据库完整性检查失败: ${ioMessage(e)}`); }
      }
      if (issues.length > 0) {
        this.ctx.logger('backup').warn(
          `  ⚠️ [HealthCheck] ${id}: v${schemaVersion} -> v${target.targetVersion}, 问题: ${JSON.stringify(issues)}`,
        );
      }
      return {
        id,
        is_healthy: isInitialized && target.pendingCount === 0 && dependenciesMet && issues.length === 0,
        dependencies_met: dependenciesMet,
        schema_version: schemaVersion,
        target_version: target.targetVersion,
        pending_count: target.pendingCount,
        issues,
      };
    });

    const overallHealthy = dependencyOk && uninitializedCount === 0 && pendingTotal === 0
      && health.every(database => database.is_healthy);
    if (overallHealthy) {
      this.ctx.logger('backup').info('✅ [HealthCheck] 健康检查完成: 所有数据库状态正常');
    } else {
      this.ctx.logger('backup').warn(
        `⚠️ [HealthCheck] 健康检查完成: 发现问题 (未初始化: ${uninitializedCount}, 依赖检查: ${dependencyOk ? '通过' : '失败'}, 待执行迁移: ${pendingTotal})`,
      );
    }

    return {
      overall_healthy: overallHealthy,
      total_databases: TOTAL_DATABASES,
      initialized_count: initializedCount,
      uninitialized_count: uninitializedCount,
      dependency_check_passed: dependencyOk,
      dependency_error: dependencyError,
      databases: health,
      checked_at: toRfc3339(),
      pending_migrations_count: pendingTotal,
      has_pending_migrations: pendingTotal > 0,
      audit_log_healthy: this.auditHealth === null,
      audit_log_error: this.auditHealth?.message ?? null,
      audit_log_error_at: this.auditHealth?.occurredAt ?? null,
    };
  }

  private integrityCheck(path: string): void {
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error('数据库文件不存在');
    // Rust `commands.rs:894-924`：READ_ONLY | NO_MUTEX + busy_timeout=5s。
    let handle: DatabaseHandle;
    try {
      handle = this.ctx.storage.openFile(path, {
        label: 'health-check',
        mustExist: true,
        profile: { readonly: true, busyTimeoutMs: 5_000 },
      });
    } catch (e) {
      throw new Error(`只读打开失败: ${ioMessage(e)}`);
    }
    let rows: IterableIterator<Record<string, unknown>> | null = null;
    const cleanup = (failed: boolean): void => {
      // better-sqlite3 的 iterate() 未结束时会占住连接；先复位语句，否则 close
      // 会抛 "connection is busy executing a query" 并覆盖原始外键违规诊断。
      try { rows?.return?.(); }
      catch { // boundary-allow empty-catch: 关闭迭代器失败不得覆盖原始 FK 违规诊断。
      }
      try { this.ctx.storage.close(handle); }
      catch (closeError) {
        if (!failed) throw closeError;
      }
    };
    try {
      let checkResult: unknown;
      try { checkResult = quickCheck(handle); }
      catch (e) { throw new Error(`quick_check 执行失败: ${ioMessage(e)}`); }
      if (typeof checkResult !== 'string' || checkResult.toLowerCase() !== 'ok') {
        throw new Error(`quick_check: ${String(checkResult)}`);
      }
      try { rows = foreignKeyCheckIterator(handle); }
      catch (e) { throw new Error(`foreign_key_check 准备失败: ${ioMessage(e)}`); }
      let first: IteratorResult<Record<string, unknown>>;
      try { first = rows.next(); }
      catch (e) {
        // F3 的 iterate 是惰性 generator：prepare/bind 也可能首次 next() 才执行。
        // Rust commands.rs:912-920 分别映射 prepare / query([]) / Rows.next；不可按文案猜阶段。
        const stage = e instanceof StorageError && e.phase === 'prepare' ? '准备'
          : e instanceof StorageError && e.phase === 'bind' ? '执行' : '读取';
        throw new Error(`foreign_key_check ${stage}失败: ${ioMessage(e)}`);
      }
      if (!first.done) throw new Error('检测到外键约束违规');
    } catch (error) {
      cleanup(true);
      throw error;
    }
    cleanup(false);
  }

  getDatabaseStatus(databaseId: string): DatabaseDetailResponse | null {
    const registry = this.refreshSchemaRegistry();
    let id: CoordinatedId;
    switch (databaseId) {
      case 'vfs': id = 'vfs'; break;
      case 'chat_v2': id = 'chat_v2'; break;
      case 'mistakes': id = 'mistakes'; break;
      case 'llm_usage': id = 'llm_usage'; break;
      default:
        throw new Error(`未知的数据库 ID: ${databaseId}。可选值: vfs, chat_v2, mistakes, llm_usage`);
    }
    const status = registry.databases.get(id);
    if (!status) return null;
    return {
      id,
      schema_version: status.schema_version,
      min_compatible_version: status.min_compatible_version,
      max_compatible_version: status.max_compatible_version,
      data_contract_version: status.data_contract_version,
      checksum: status.checksum,
      updated_at: status.updated_at,
      migration_history: status.migration_history.map(record => ({ ...record })),
      dependencies: [...dependenciesOf(id)],
    };
  }

  getMaintenanceStatus(): MaintenanceStatusResponse {
    const blocked = this.operations.blockedComponents();
    const health = startupComponentHealth(this.ctx.storage);
    return {
      is_in_maintenance_mode: blocked.length > 0,
      blocked_components: blocked,
      current_operation: this.operations.current(),
      component_health: health?.snapshot ?? null,
      component_issues: health?.issues ?? [],
    };
  }

  private slotDir(name: SandboxSlot): string {
    return join(dirname(this.activeDir), name);
  }

  /** commands.rs:232-235、264-266：`let _ =` 删除并重建；失败不打断测试，由随后的迁移或复制报出根因。 */
  private async resetDir(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(path, { recursive: true }).catch(() => undefined);
  }

  runSlotCTest(): Promise<SlotMigrationTestResponse> {
    return this.runSandboxTest('slotC', () => this.executeSlotCTest());
  }

  private async executeSlotCTest(): Promise<SlotMigrationTestResponse> {
    const dir = this.slotDir('slotC');
    await this.resetDir(dir);
    const lines: string[] = [];
    try {
      const report = await this.runMigrations(dir, null);
      lines.push(`结果: 成功 (${report.totalDurationMs}ms)`);
      for (const db of report.databases) {
        lines.push(`  [${db.id}] v${db.fromVersion} -> v${db.toVersion}, 应用 ${db.appliedCount} 个迁移, ${db.durationMs}ms`);
      }
      await this.resetDir(dir);
      return { success: true, report: `${lines.join('\n')}\n` };
    } catch (error) {
      lines.push('结果: 失败!');
      lines.push(`  ROOT CAUSE: ${ioMessage(error)}`);
      await this.resetDir(dir);
      return { success: false, report: `${lines.join('\n')}\n` };
    }
  }

  /** 与 Rust 一致：逐个库用 SQLite Online Backup 生成自洽快照。 */
  runSlotDTest(): Promise<SlotMigrationTestResponse> {
    return this.runSandboxTest('slotD', () => this.executeSlotDTest());
  }

  private async executeSlotDTest(): Promise<SlotMigrationTestResponse> {
    const dir = this.slotDir('slotD');
    await this.resetDir(dir);
    const lines: string[] = [];
    const copyErrors: string[] = [];
    const dbFiles: ReadonlyArray<readonly [string, string]> = [
      ['', 'chat_v2.db'], ['', 'mistakes.db'], ['', 'llm_usage.db'], ['databases', 'vfs.db'],
    ];
    for (const [subdir, fileName] of dbFiles) {
      const src = subdir === '' ? join(this.activeDir, fileName) : join(this.activeDir, subdir, fileName);
      if (!existsSync(src)) { copyErrors.push(`${subdir}/${fileName}: 源数据库不存在`); continue; }
      const dstDir = subdir === '' ? dir : join(dir, subdir);
      try { mkdirSync(dstDir, { recursive: true }); }
      catch (e) { copyErrors.push(`${subdir}/${fileName}: ${ioMessage(e)}`); continue; }
      const dst = join(dstDir, fileName);
      let source: DatabaseHandle;
      try { source = this.ctx.storage.openFile(src, { label: `slot-d:${fileName}`, mustExist: true }); }
      catch (e) { copyErrors.push(`${subdir}/${fileName}: 打开源库失败: ${ioMessage(e)}`); continue; }
      try { await source.backupTo(dst); }
      catch (e) { copyErrors.push(`${subdir}/${fileName}: 执行 SQLite backup 失败: ${ioMessage(e)}`); }
      finally { this.ctx.storage.close(source); }
    }

    if (copyErrors.length > 0) {
      lines.push(`复制文件时出错: ${copyErrors.join('; ')}`);
      await this.resetDir(dir);
      return { success: false, report: `${lines.join('\n')}\n` };
    }

    try {
      const report = await this.runMigrations(dir, null);
      lines.push(`结果: 成功 (${report.totalDurationMs}ms)`);
      for (const db of report.databases) {
        if (db.appliedCount > 0) {
          lines.push(`  [${db.id}] v${db.fromVersion} -> v${db.toVersion}, 应用 ${db.appliedCount} 个迁移, ${db.durationMs}ms`);
        } else {
          lines.push(`  [${db.id}] v${db.toVersion} (已是最新)`);
        }
      }
      await this.resetDir(dir);
      return { success: true, report: `${lines.join('\n')}\n` };
    } catch (error) {
      lines.push('结果: 失败!');
      lines.push(`  ROOT CAUSE: ${ioMessage(error)}`);
      await this.resetDir(dir);
      return { success: false, report: `${lines.join('\n')}\n` };
    }
  }

  async getMigrationDiagnosticReport(): Promise<string> {
    const registry = this.refreshSchemaRegistry();
    const lines: string[] = [];
    const write = (line = ''): void => { lines.push(line); };

    write('=== Deep Student 迁移诊断报告 ===');
    write(`时间: ${toRfc3339()}`);
    write(`平台: ${rustOs()} ${rustArch()}`);
    write(`应用版本: ${this.ctx.app.version}`);
    write();

    write('--- 数据库状态 ---');
    const errorMessages: string[] = [];
    for (const id of DATABASE_IDS) {
      const status = registry.databases.get(id);
      const currentVersion = status?.schema_version ?? 0;
      const target = resolveTargetAndPending(id, currentVersion, status);
      let flag = '';
      if (target.pendingCount > 0 && currentVersion > 0) {
        errorMessages.push(`${id}: 有 ${target.pendingCount} 个迁移未执行 (当前: v${currentVersion}, 目标: v${target.targetVersion})`);
        flag = ' ⚠️';
      }
      write(`[${id}] 当前: v${currentVersion}, 目标: v${target.targetVersion}, 待执行: ${target.pendingCount}${flag}`);
    }
    write();

    write('--- 错误信息 ---');
    const persisted = this.readPersistedMigrationError();
    if (persisted) write(`[${persisted.timestamp}] 真实迁移错误: ${persisted.error}`);
    if (errorMessages.length === 0 && persisted === null) write('(无)');
    else for (const message of errorMessages) write(message);
    write();

    write('--- 最近迁移失败记录（审计日志） ---');
    const auditDbPath = join(this.activeDir, 'databases', 'audit.db');
    if (!existsSync(auditDbPath)) {
      write('(审计数据库不存在)');
    } else {
      let handle: DatabaseHandle | undefined;
      try { handle = this.ctx.storage.openFile(auditDbPath, { label: 'diagnostic-audit', mustExist: true }); }
      catch (e) { write(`(无法打开审计数据库: ${ioMessage(e)})`); handle = undefined; }
      if (handle) {
        try {
          const rows = recentFailedMigrations(handle);
          if (rows.length === 0) write('(审计日志中无迁移失败记录)');
          for (const row of rows) {
            write(`[${row.timestamp ?? ''}] db=${row.target ?? ''}`);
            if (row.error_message != null) write(`  error: ${row.error_message}`);
            if (row.details != null) {
              const chars = Array.from(row.details);
              const truncated = chars.length > 500 ? `${chars.slice(0, 500).join('')}...(truncated)` : row.details;
              write(`  details: ${truncated}`);
            }
          }
        } catch (e) {
          write(`(查询审计日志失败: ${ioMessage(e)})`);
        } finally {
          this.ctx.storage.close(handle);
        }
      }
    }
    write();

    // RUST-FIX(RF-W08-diagnostic-slots-concurrent): Rust 等 C 跑完才开始 D；这里同时开跑，仍按 C、D 顺序写入，C 的异常优先。
    const [slotC, slotD] = await Promise.allSettled([this.runSlotCTest(), this.runSlotDTest()]);
    if (slotC.status === 'rejected') throw slotC.reason;
    write('--- 空库迁移测试 (Slot C) ---');
    write(slotC.value.report);
    write();
    if (slotD.status === 'rejected') throw slotD.reason;
    write('--- 当前库重试迁移测试 (Slot D) ---');
    write('(复制当前活跃插槽的数据库，重新执行迁移流程；若成功说明重启可恢复)');
    write(slotD.value.report);
    write();

    write('--- 迁移历史 ---');
    for (const id of DATABASE_IDS) {
      const status = registry.databases.get(id);
      if (!status) { write(`[${id}] (数据库未初始化)`); continue; }
      const history = status.migration_history.map(record => `v${record.version}(${record.name})`).join(' ');
      write(`[${id}] ${history === '' ? '(无记录)' : history}`);
    }
    write();

    write('--- 磁盘空间 ---');
    const available = availableDiskSpace(this.activeDir);
    let totalDbSize = 0;
    for (const id of DATABASE_IDS) {
      const path = databasePath(this.activeDir, id);
      if (existsSync(path)) totalDbSize += statSync(path).size;
    }
    write(`可用: ${Math.floor(available / (1024 * 1024))}MB, 数据库总大小: ${Math.floor(totalDbSize / (1024 * 1024))}MB`);
    write();

    write('--- 数据目录 ---');
    write(this.activeDir);
    return lines.join('\n');
  }
}

interface StartupHealthLike {
  toJSON(): StartupComponentHealth;
  issues(): StartupComponentIssue[];
}

/**
 * Rust `StartupComponentHealthState` 由父进程注册为 Tauri state；Host 中由 F3 storage
 * 持有。`StorageService` 接口暂未发布该只读快照，这里读取服务实例上的公开字段
 * （`componentHealth`，或 storage 服务自身的 `impl.componentHealth`）。
 */
function startupComponentHealth(storage: unknown): {
  snapshot: StartupComponentHealth;
  issues: StartupComponentIssue[];
} | null {
  const candidates = [storage, (storage as { impl?: unknown } | null)?.impl];
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || typeof candidate !== 'object') continue;
    const health = (candidate as { componentHealth?: unknown }).componentHealth;
    if (health === null || health === undefined || typeof health !== 'object') continue;
    const like = health as Partial<StartupHealthLike>;
    if (typeof like.toJSON !== 'function') continue;
    return {
      snapshot: like.toJSON(),
      issues: typeof like.issues === 'function' ? like.issues() : [],
    };
  }
  return null;
}

function dependenciesOf(id: CoordinatedId): readonly CoordinatedId[] {
  return id === 'chat_v2' || id === 'mistakes' ? ['vfs'] : [];
}

function rustOs(): string {
  const platform = process.platform;
  return platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux';
}

function rustArch(): string {
  const arch = process.arch;
  return arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch;
}

/** Rust commands.rs:1248 `get_available_disk_space(..).unwrap_or(0)`；回退与日志由平台实现。 */
function availableDiskSpace(path: string): number {
  try { return getAvailableDiskSpace(path); }
  catch { return 0; } // boundary-allow empty-catch: Rust unwrap_or(0)，失败日志已由 getAvailableDiskSpace 记录。
}
