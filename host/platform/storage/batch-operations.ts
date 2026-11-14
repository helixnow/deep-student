/**
 * `dstu-storage/src/batch_operations.rs`：主库 `mistakes` 的批处理。
 *
 * Rust 的入口是 `Database::with_batch_operations(|ops| …)`；Host 侧用
 * {@link SqlExecutor} 上的同步事务表达同一边界（默认 deferred，与
 * `Connection::transaction()` 一致），提交由 `transaction()` 完成。
 */
import type { DatabaseHandle } from './api.ts';
import { rfc3339Now } from './time.ts';

const DAY_MS = 86_400_000;

/**
 * `batch_archive_old_mistakes(days_old)`（batch_operations.rs:17-33）：
 * `created_at` 早于 `now - days_old` 且状态不是 `archived` 的错题改为
 * `archived`，同时把 `updated_at` / `last_accessed_at` 写为同一次 `Utc::now()`。
 * 返回影响行数。
 */
export function batchArchiveOldMistakes(db: DatabaseHandle, daysOld: number): number {
  const cutoff = rfc3339Now(new Date(Date.now() - daysOld * DAY_MS));
  return db.transaction((tx) => {
    const updated = tx.run(
      `UPDATE mistakes
       SET status = 'archived', updated_at = ?1, last_accessed_at = ?1
       WHERE created_at < ?2 AND status != 'archived'`,
      [rfc3339Now(), cutoff],
    );
    return updated.changes;
  });
}

/**
 * `batch_cleanup_orphaned_messages()`（batch_operations.rs:35-49）：
 * 删除 `mistake_id` 不在 `mistakes` 表中的 `chat_messages`（历史库可能早于外键约束），
 * 返回删除行数。
 */
export function batchCleanupOrphanedMessages(db: DatabaseHandle): number {
  return db.transaction((tx) => tx.run(
    `DELETE FROM chat_messages
     WHERE mistake_id NOT IN (SELECT id FROM mistakes)`,
    [],
  ).changes);
}
