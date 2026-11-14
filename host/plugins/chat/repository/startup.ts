/** Rust repo.rs:3428-3509. Independent statements deliberately have no encompassing transaction. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { now } from '../../../platform/time/index.ts';
import type { ChatLogger } from '../src/logger.ts';
import { databaseOperation } from './errors.ts';

export const INTERRUPTED_BY_RESTART_ERROR = '应用已重启，这一轮回答被中断，可以重新提问';

export function cleanupOrphanUserContentBlocks(db: SqlExecutor, log: Pick<ChatLogger, 'info'>): number {
  const count = databaseOperation(() => db.run(`DELETE FROM chat_v2_blocks
    WHERE id IN (
      SELECT id FROM (
        SELECT b.id, ROW_NUMBER() OVER (PARTITION BY b.message_id ORDER BY b.rowid DESC) AS rn
        FROM chat_v2_blocks b INNER JOIN chat_v2_messages m ON b.message_id = m.id
        WHERE m.role = 'user' AND b.block_type = 'content'
      ) WHERE rn > 1
    )`).changes);
  if (count > 0) log.info(`[ChatV2::Repo] Cleaned up ${count} orphan user content blocks`);
  return count;
}

export function reconcileInterruptedBlocksOnStartup(db: SqlExecutor, log: Pick<ChatLogger, 'info'>): number {
  const millis = now().millis;
  const finished = databaseOperation(() => db.run(`UPDATE chat_v2_blocks
    SET status = 'success', ended_at = COALESCE(ended_at, first_chunk_at, started_at, ?1)
    WHERE status IN ('running', 'pending') AND block_type IN ('thinking', 'content')
      AND content IS NOT NULL AND length(trim(content)) > 0`, [millis]).changes);
  const interrupted = databaseOperation(() => db.run(`UPDATE chat_v2_blocks
    SET status = 'error', error = COALESCE(error, ?2), ended_at = COALESCE(ended_at, ?1)
    WHERE status IN ('running', 'pending')`, [millis, INTERRUPTED_BY_RESTART_ERROR]).changes);
  const total = finished + interrupted;
  if (total > 0) log.info(`[ChatV2::Repo] Reconciled ${total} interrupted blocks on startup (${finished} finished, ${interrupted} marked interrupted)`);
  return total;
}
