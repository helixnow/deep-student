import type { SqlExecutor } from '../../../platform/storage/api.ts';

/** `PRAGMA quick_check(1)`：返回首列字符串。 */
export function quickCheck(db: SqlExecutor): unknown {
  return db.pluck('PRAGMA quick_check(1)');
}

/** `PRAGMA foreign_key_check`：有任何行即存在外键违规。 */
export function foreignKeyViolations(db: SqlExecutor): number {
  return db.all('PRAGMA foreign_key_check').length;
}

/** F3 惰性迭代器：prepare/bind/首行 step 均可能在首次 next() 才抛错，阶段由 StorageError.phase 标记。 */
export function foreignKeyCheckIterator(db: SqlExecutor): IterableIterator<Record<string, unknown>> {
  return db.iterate('PRAGMA foreign_key_check');
}

export interface FailedMigrationRow {
  timestamp: string;
  target: string;
  error_message: string | null;
  details: string | null;
}

/** 诊断报告：最近 5 条失败的迁移审计记录。 */
export function recentFailedMigrations(db: SqlExecutor): FailedMigrationRow[] {
  return db.all<FailedMigrationRow>(
    `SELECT timestamp, target, error_message, details
     FROM __audit_log
     WHERE operation_type = 'migration' AND status = 'failed'
     ORDER BY timestamp DESC LIMIT 5`,
  );
}
