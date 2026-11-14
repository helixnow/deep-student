/**
 * 启动迁移失败的语义，与桌面逐项对齐（桌面实现依赖 `node:fs`，Worker 中不能导入，这里是可移植副本）：
 * - {@link MobileComponentHealth} = `StartupComponentHealth`（host/platform/storage/migration/backup.ts）；
 * - 单库失败 / 依赖跳过的原因 = coordinator.ts `runAll`（lib.rs 中 `initialize_with_report` 仍返回 Ok）；
 * - 核心恢复屏障的库与原因 = service.ts `enterCoreRecoveryBarrier`（lib.rs:1312-1318）；
 * - `data-governance-migration-status` 载荷 = backup 插件 startup-events.ts / governance.ts
 *   `startupInitializationSummary`（lib.rs:1104-1141）。backup 插件只有桌面版，移动端由存储插件发出。
 *
 * 移动端没有迁移前快照、恢复 journal 与磁盘预检，桌面 `runAll` 的全局失败来源都不存在，
 * 因此 `startupMigrationFailure()` 恒为 null；单库失败对应桌面“没有快照、文件原样保留”的分支。
 */
import type { CoordinatedDatabaseName, MigrationReport } from '../storage/api.ts';

export type StartupComponentStatus = 'healthy' | 'degraded' | 'blocked';

export interface StartupComponentIssue {
  component: string;
  status: StartupComponentStatus;
  reason: string | null;
  dependency: string | null;
}

/** `DatabaseId::dependencies()`。 */
export const DATABASE_DEPENDENCIES: Readonly<Record<CoordinatedDatabaseName, readonly CoordinatedDatabaseName[]>> = {
  vfs: [],
  chat_v2: ['vfs'],
  mistakes: ['vfs'],
  llm_usage: [],
};

/** 桌面 service.ts `CORE_RECOVERY_DATABASES`：屏障按此顺序进入。 */
export const CORE_RECOVERY_DATABASES: readonly CoordinatedDatabaseName[] = ['mistakes', 'vfs', 'chat_v2', 'llm_usage'];

export const MIGRATION_STATUS_EVENT = 'data-governance-migration-status';

export class MobileComponentHealth {
  components: StartupComponentIssue[] = ['vfs', 'mistakes', 'chat_v2', 'llm_usage', 'audit'].map(component => ({
    component,
    status: 'healthy',
    reason: null,
    dependency: null,
  }));

  isBlocked(component: string): boolean {
    return this.components.some(e => e.component === component && e.status === 'blocked');
  }

  blockedComponents(): string[] {
    return this.components.filter(e => e.status === 'blocked').map(e => e.component);
  }

  requiresCoreRecovery(): boolean {
    return this.isBlocked('vfs') || this.isBlocked('mistakes');
  }

  issues(): StartupComponentIssue[] {
    return this.components.filter(e => e.status !== 'healthy').map(e => ({ ...e }));
  }

  markDegraded(component: string, reason: string): void {
    this.set(component, 'degraded', reason, null);
  }

  markBlocked(component: string, reason: string): void {
    this.set(component, 'blocked', reason, null);
  }

  markDependencyBlocked(component: string, dependency: string, reason: string): void {
    this.set(component, 'blocked', reason, dependency);
  }

  private set(component: string, status: StartupComponentStatus, reason: string, dependency: string | null): void {
    const entry = this.components.find(e => e.component === component);
    if (entry === undefined) return;
    entry.status = status;
    entry.reason = reason;
    entry.dependency = dependency;
  }

  toJSON(): { components: StartupComponentIssue[] } {
    return { components: this.components.map(e => ({ ...e })) };
  }
}

export function dependencySkipReason(dependency: string): string {
  return `Skipped because dependency '${dependency}' is blocked`;
}

/** coordinator.ts `runAll` 单库失败 + `describeSingleRestore` 的 `untouched` 分支（没有任何快照）。 */
export function migrationFailureReason(id: CoordinatedDatabaseName, error: string, path: string): string {
  return `Database '${id}' migration failed: ${error}. `
    + `No snapshot was taken before this migration run, so nothing was restored; the database file was kept in place at ${path} (not deleted or overwritten). `
    + 'No earlier snapshot contains this database.';
}

/** 桌面 `enterCoreRecoveryBarrier`：被阻断的核心库，原因取直接失败（非依赖跳过）的去重原因。 */
export function coreRecoveryPlan(health: MobileComponentHealth): { reason: string; databases: CoordinatedDatabaseName[] } | null {
  if (!health.requiresCoreRecovery()) return null;
  const databases = CORE_RECOVERY_DATABASES.filter(name => health.isBlocked(name));
  const reason = [...new Set(health.issues()
    .filter(issue => issue.status === 'blocked' && issue.dependency == null
      && (CORE_RECOVERY_DATABASES as readonly string[]).includes(issue.component))
    .map(issue => issue.reason ?? `${issue.component} blocked`))].join('; ');
  return { reason, databases };
}

/**
 * lib.rs:1104-1141 两种 Ok 载荷。`global_version` 只聚合未阻断的库（`aggregate_schema_registry_with_health`）；
 * 移动端没有审计库，没有审计警告。
 */
export function migrationStatusPayload(report: MigrationReport, health: MobileComponentHealth): Record<string, unknown> {
  const warnings: string[] = [];
  for (const issue of health.issues()) {
    if (issue.component === 'audit') continue;
    const warning = issue.reason ?? `${issue.component} startup degraded`;
    if (!warnings.includes(warning)) warnings.push(warning);
  }
  const base = {
    success: true,
    global_version: Math.max(0, ...report.databases.filter(db => !health.isBlocked(db.id)).map(db => db.toVersion)),
    migrations_applied: report.databases.reduce((sum, db) => sum + db.appliedCount, 0),
    duration_ms: report.totalDurationMs,
  };
  return report.success && warnings.length === 0
    ? { ...base, warnings: [] }
    : { ...base, warnings, has_warnings: true };
}
