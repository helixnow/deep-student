/**
 * summary.rs:259 persist_session_metadata + repo.rs:4610 upsert_auto_tags.
 * The chat owner publishes no session-metadata writer yet; this module keeps the
 * SQL in a repository until that writer exists.
 */
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';

/** repo.rs:4610 — replace the session's auto tags, skipping blank ones. */
function upsertAutoTags(tx: SqlExecutor, sessionId: string, tags: readonly string[]): void {
  tx.run("DELETE FROM chat_v2_session_tags WHERE session_id = ?1 AND tag_type = 'auto'", [sessionId]);
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (trimmed === '') continue;
    tx.run("INSERT OR IGNORE INTO chat_v2_session_tags (session_id, tag, tag_type, created_at) VALUES (?1, ?2, 'auto', datetime('now'))",
      [sessionId, trimmed]);
  }
}

/**
 * Writes title + summary/tags hash and auto tags in one immediate transaction.
 * Returns false when the session is missing or its title was locked concurrently.
 */
export async function persistSessionMetadata(db: DatabaseHandle, sessionId: string,
  metadata: { title: string; tags: readonly string[] }, contentHash: string): Promise<boolean> {
  return db.write(tx => {
    const now = toRfc3339();
    const { changes } = tx.run(`UPDATE chat_v2_sessions
      SET title = ?2, summary_hash = ?3, tags_hash = ?4, updated_at = ?5
      WHERE id = ?1 AND title_locked = 0`, [sessionId, metadata.title, contentHash, contentHash, now]);
    if (changes === 0) return false;
    if (metadata.tags.length > 0) upsertAutoTags(tx, sessionId, metadata.tags);
    return true;
  });
}
