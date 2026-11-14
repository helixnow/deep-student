/**
 * `src-tauri/src/data_governance/init.rs` 的 Electron 侧初始化面：
 * 目录准备、审计库初始化、迁移报告与降级警告。
 *
 * 组合根仍由 F3 启动编排持有；本模块只服务 L21 恢复候选槽的真实初始化
 * （`RestoreCommands::initializeCandidateSlot`），不复制 F3 的启动/迁移算法。
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Connection } from '../../../platform/storage/connection.ts';
import { PROFILES } from '../../../platform/storage/profiles.ts';
import { initAuditTable } from '../../../platform/storage/migration/audit-log.ts';

/** `init.rs::InitializationReport`。 */
export class InitializationReport {
  auditInitialized = false;
  migrationsSuccess = false;
  migrationsApplied = 0;
  totalDurationMs = 0;
  warnings: string[] = [];

  addWarning(warning: string): void {
    this.warnings.push(warning);
  }

  /** `init.rs::InitializationReport::is_fully_successful`。 */
  isFullySuccessful(): boolean {
    return this.auditInitialized && this.migrationsSuccess && this.warnings.length === 0;
  }
}

/** `init.rs::ensure_directories`：databases / backups / slots/slotA。 */
export function ensureDirectories(appDataDir: string): void {
  mkdirSync(join(appDataDir, 'databases'), { recursive: true });
  mkdirSync(join(appDataDir, 'backups'), { recursive: true });
  mkdirSync(join(appDataDir, 'slots', 'slotA'), { recursive: true });
}

/** `init.rs::initialize_audit_log`：创建/打开 databases/audit.db 并初始化审计表。 */
export function initializeAuditLog(appDataDir: string): void {
  const auditDbPath = join(appDataDir, 'databases', 'audit.db');
  mkdirSync(dirname(auditDbPath), { recursive: true });
  const conn = new Connection(auditDbPath, { label: 'audit', profile: PROFILES.plain });
  try {
    initAuditTable(conn);
  } finally {
    conn.close();
  }
}

/** 初始化所消费的迁移报告（`MigrationWorkerReport` 的本模块所需子集）。 */
export interface InitializationMigrationReport {
  readonly success: boolean;
  readonly error: string | null;
  readonly databases: ReadonlyArray<{ readonly appliedCount: number }>;
}

export type InitializeMigrationRunner = (
  appDataDir: string,
  auditDbPath?: string | null,
) => Promise<InitializationMigrationReport>;

/**
 * `init.rs::initialize_with_report` 的候选槽初始化子集：
 * 目录 → 审计（失败仅降级告警）→ 实际迁移；迁移失败与 Rust 一样向上抛错。
 */
export async function initializeWithReport(
  appDataDir: string,
  runMigrations: InitializeMigrationRunner,
): Promise<InitializationReport> {
  const started = Date.now();
  const report = new InitializationReport();
  ensureDirectories(appDataDir);

  let auditInitialized = false;
  try {
    initializeAuditLog(appDataDir);
    report.auditInitialized = true;
    auditInitialized = true;
  } catch (error) {
    report.addWarning(`审计日志初始化失败: ${error instanceof Error ? error.message : String(error)}`);
  }

  const migration = await runMigrations(appDataDir, auditInitialized ? undefined : null);
  report.migrationsSuccess = migration.success;
  report.migrationsApplied = migration.databases.reduce((sum, db) => sum + db.appliedCount, 0);
  report.totalDurationMs = Date.now() - started;
  if (!migration.success) throw new Error(migration.error ?? '迁移报告未通过');
  return report;
}
