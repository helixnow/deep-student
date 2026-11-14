import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import type { ChatSession, ContentSearchResult } from '../api.ts';
import { databaseOperation } from './errors.ts';
import type { ChatLogger } from '../src/logger.ts';
import { SESSION_COLUMNS, VISIBLE_SESSION_FILTER, sessionRows, type SessionRow } from './sessions.ts';

export function searchSessions(db: SqlExecutor, query: string, limit: number, includeArchived: boolean, log?: ChatLogger): ChatSession[] {
  const trimmed = rustTrim(query);
  if (!trimmed) return [];
  const pattern = `%${trimmed.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
  const status = includeArchived ? "persist_status IN ('active', 'archived')" : "persist_status = 'active'";
  return databaseOperation(() => sessionRows(db.all<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM chat_v2_sessions
    WHERE mode != 'agent' AND ${status} AND (
      title LIKE ?1 ESCAPE '\\' OR description LIKE ?1 ESCAPE '\\' OR EXISTS (
        SELECT 1 FROM chat_v2_session_tags t WHERE t.session_id = chat_v2_sessions.id AND t.tag LIKE ?1 ESCAPE '\\'
      )) ${VISIBLE_SESSION_FILTER} ORDER BY updated_at DESC LIMIT ?2`, [pattern, limit]), log));
}

export function searchContent(db: SqlExecutor, query: string, limit: number, dateFrom: string | null = null,
  dateTo: string | null = null, sessionId: string | null = null, includeArchived = false, log?: ChatLogger): ContentSearchResult[] {
  const trimmed = rustTrim(query);
  if (!trimmed) return [];
  const fts = trimmed.split(/\p{White_Space}+/u).map(token => `"${token.replaceAll('"', '""')}"`).join(' ');
  const status = includeArchived ? "s.persist_status IN ('active', 'archived')" : "s.persist_status = 'active'";
  return databaseOperation(() => db.all<ContentSearchResult>(`SELECT s.id AS sessionId, s.title AS sessionTitle,
    m.id AS messageId, b.id AS blockId, m.role AS role,
    snippet(chat_v2_content_fts, 0, X'02', X'03', '...', 40) AS snippet, s.updated_at AS updatedAt
    FROM chat_v2_content_fts fts JOIN chat_v2_blocks b ON fts.rowid = b.rowid
    JOIN chat_v2_messages m ON b.message_id = m.id JOIN chat_v2_sessions s ON m.session_id = s.id
    WHERE chat_v2_content_fts MATCH ?1 AND ${status}
      AND (?2 IS NULL OR julianday(s.updated_at) >= julianday(?2))
      AND (?3 IS NULL OR julianday(s.updated_at) <= julianday(?3))
      AND (?4 IS NULL OR s.id = ?4) ORDER BY bm25(chat_v2_content_fts) LIMIT ?5`,
  [fts, dateFrom, dateTo, sessionId, limit]).flatMap(row => {
    if (typeof row.snippet !== 'string' || typeof row.role !== 'string' || typeof row.updatedAt !== 'string') {
      log?.warn('[ChatV2Repo] Search row error: ' + String(row.blockId));
      return [];
    }
    return [{ ...row, snippet: row.snippet.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\x02', '<mark>').replaceAll('\x03', '</mark>') }];
  }));
}

export function rebuildContentFts(db: SqlExecutor): number {
  return databaseOperation(() => {
    db.run('DELETE FROM chat_v2_content_fts');
    return db.run(`INSERT INTO chat_v2_content_fts(rowid, content) SELECT b.rowid, b.content FROM chat_v2_blocks b
      WHERE b.content IS NOT NULL AND b.content != '' AND b.block_type IN ('content', 'thinking')`).changes;
  });
}

export function addManualTag(db: SqlExecutor, id: string, tag: string): void {
  databaseOperation(() => db.run(`INSERT OR IGNORE INTO chat_v2_session_tags (session_id, tag, tag_type, created_at)
    VALUES (?1, ?2, 'manual', datetime('now'))`, [id, rustTrim(tag)]));
}

export function removeTag(db: SqlExecutor, id: string, tag: string): void {
  databaseOperation(() => db.run('DELETE FROM chat_v2_session_tags WHERE session_id = ?1 AND tag = ?2', [id, tag]));
}

export function getSessionTags(db: SqlExecutor, id: string): string[] {
  return databaseOperation(() => db.all<{ tag: string }>(`SELECT tag FROM chat_v2_session_tags
    WHERE session_id = ?1 ORDER BY tag_type ASC, created_at ASC`, [id]).flatMap(row => typeof row.tag === 'string' ? [row.tag] : []));
}

export function getTagsForSessions(db: SqlExecutor, ids: string[]): Record<string, string[]> {
  return databaseOperation(() => {
    const map = new Map<string, string[]>();
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500);
      const rows = db.all<{ session_id: string; tag: string }>(`SELECT session_id, tag FROM chat_v2_session_tags
        WHERE session_id IN (${chunk.map((_, i) => `?${i + 1}`).join(', ')}) ORDER BY tag_type ASC, created_at ASC`, chunk);
      for (const row of rows) {
        if (typeof row.session_id !== 'string' || typeof row.tag !== 'string') continue;
        const tags = map.get(row.session_id) ?? [];
        tags.push(row.tag);
        map.set(row.session_id, tags);
      }
    }
    return Object.fromEntries(map);
  });
}

export function listAllTags(db: SqlExecutor): [string, number][] {
  return databaseOperation(() => db.all<{ tag: string; cnt: number }>(`SELECT t.tag, COUNT(*) AS cnt
    FROM chat_v2_session_tags t JOIN chat_v2_sessions s ON t.session_id = s.id
    WHERE s.persist_status = 'active' GROUP BY t.tag ORDER BY cnt DESC, t.tag ASC`)
    .flatMap(row => typeof row.tag === 'string' && typeof row.cnt === 'number' ? [[row.tag, row.cnt] as [string, number]] : []));
}
