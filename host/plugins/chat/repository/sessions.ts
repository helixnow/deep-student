import type { SqlExecutor, SqlParam } from '../../../platform/storage/api.ts';
import { parseFlexibleTimestamp, parseRfc3339, toRfc3339Opts } from '../../../platform/time/index.ts';
import { rustTrim, parseJsonDocument, JsonSyntaxError, objectLastWins, jsonNumberToRawJSON,
  type JsonNode } from '../../../platform/util/index.ts';
import type { ChatSession } from '../api.ts';
import { ChatV2Error } from '../src/error.ts';
import { errorText, type ChatLogger } from '../src/logger.ts';
import { databaseNow, databaseTimestamp, utcTimestamp } from '../src/types.ts';
import { databaseOperation } from './errors.ts';

export const SESSION_COLUMNS = 'id, mode, title, description, summary_hash, persist_status, created_at, updated_at, metadata_json, group_id, tags_hash, title_locked';
export const ACTIVE_PERSIST_STATUS_SQL = `COALESCE(persist_status, 'active') NOT IN ('archived', 'deleted')`;
export const VISIBLE_SESSION_FILTER = ` AND (metadata_json IS NULL OR NOT json_valid(metadata_json) OR (
  COALESCE(json_extract(metadata_json, '$.chatV2Draft.hidden'), 0) != 1
  AND json_extract(metadata_json, '$.superagent') IS NULL
  AND COALESCE(json_extract(metadata_json, '$.super_agent.hidden'), 0) != 1
))`;

export interface SessionRow {
  id: string;
  mode: string | null;
  title: string | null;
  description: string | null;
  summary_hash: string | null;
  persist_status: string | null;
  created_at: string | number | bigint | null;
  updated_at: string | number | bigint | null;
  metadata_json: string | null;
  group_id: string | null;
  tags_hash?: string | null;
  title_locked?: number;
}

const EPOCH_ZERO_ISO = toRfc3339Opts(0n, 'AutoSi', true);
const NS_PER_SEC = 1_000_000_000n;

function coerceTimestampColumn(value: unknown, key: 'created_at' | 'updated_at'): string {
  if (value === null || value === undefined) return EPOCH_ZERO_ISO;
  if (typeof value === 'string') {
    const rfc = parseRfc3339(value);
    if (rfc !== null) return toRfc3339Opts(rfc.epochNanos, 'AutoSi', true);
    const trimmed = value.trim();
    if (!trimmed) return EPOCH_ZERO_ISO;
    const flexible = parseFlexibleTimestamp(trimmed);
    if (flexible !== null) return toRfc3339Opts(flexible.epochNanos, 'AutoSi', true);
    return utcTimestamp(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const truncated = Math.trunc(value);
    const flexible = parseFlexibleTimestamp(String(truncated));
    if (flexible !== null) return toRfc3339Opts(flexible.epochNanos, 'AutoSi', true);
    return toRfc3339Opts(BigInt(truncated) * NS_PER_SEC, 'AutoSi', true);
  }
  if (typeof value === 'bigint') {
    const flexible = parseFlexibleTimestamp(value.toString());
    if (flexible !== null) return toRfc3339Opts(flexible.epochNanos, 'AutoSi', true);
    return toRfc3339Opts(value * NS_PER_SEC, 'AutoSi', true);
  }
  throw new ChatV2Error('Database', `Invalid column type for ${key}`);
}

/** Session metadata is serde_json::Value: retain arbitrary numeric tokens on read/modify/write. */
function metadataValue(node: JsonNode): unknown {
  switch (node.kind) {
    case 'null': return null;
    case 'bool': case 'string': return node.value;
    case 'number': {
      const number = node.value;
      if ((number.kind === 'u64' || number.kind === 'i64')
        && number.value >= -9007199254740991n && number.value <= 9007199254740991n) return Number(number.value);
      return jsonNumberToRawJSON(number);
    }
    case 'array': return node.items.map(metadataValue);
    case 'object': return Object.fromEntries([...objectLastWins(node)].map(([key, value]) => [key, metadataValue(value)]));
  }
}

export function rowToSession(row: SessionRow): ChatSession {
  if (typeof row.id !== 'string') throw new ChatV2Error('Database', 'Invalid column type for id');
  let mode: string;
  if (row.mode === null || row.mode === undefined) {
    mode = 'chat';
  } else if (typeof row.mode === 'string') {
    mode = row.mode.trim() || 'chat';
  } else {
    throw new ChatV2Error('Database', 'Invalid column type for mode');
  }
  let rawPersistStatus: string;
  if (row.persist_status === null || row.persist_status === undefined) {
    rawPersistStatus = 'active';
  } else if (typeof row.persist_status === 'string') {
    rawPersistStatus = row.persist_status;
  } else {
    throw new ChatV2Error('Database', 'Invalid column type for persist_status');
  }
  const createdAt = coerceTimestampColumn(row.created_at, 'created_at');
  const updatedAt = coerceTimestampColumn(row.updated_at, 'updated_at');
  const session: ChatSession = {
    id: row.id,
    mode,
    titleLocked: typeof row.title_locked === 'number' && row.title_locked !== 0,
    persistStatus: rawPersistStatus === 'archived' || rawPersistStatus === 'deleted' ? rawPersistStatus : 'active',
    createdAt,
    updatedAt,
  };
  if (row.title !== null) session.title = row.title;
  if (row.description !== null) session.description = row.description;
  if (row.summary_hash !== null) session.summaryHash = row.summary_hash;
  if (typeof row.group_id === 'string' && row.group_id.trim() !== '') session.groupId = row.group_id;
  if (row.tags_hash != null) session.tagsHash = row.tags_hash;
  if (row.metadata_json !== null) {
    try { session.metadata = metadataValue(parseJsonDocument(row.metadata_json)); }
    catch (error) {
      if (!(error instanceof JsonSyntaxError)) throw error;
      session.metadata = undefined;
    }
  }
  return session;
}

export function sessionRows(rows: SessionRow[], log?: ChatLogger): ChatSession[] {
  return rows.flatMap(row => {
    try { return [rowToSession(row)]; }
    catch (error) { log?.warn('[ChatV2Repo] Skipping malformed row: ' + errorText(error)); return []; }
  });
}

export function createSession(db: SqlExecutor, s: ChatSession): void {
  databaseOperation(() => db.run(`INSERT INTO chat_v2_sessions
    (id, mode, title, description, summary_hash, title_locked, persist_status, created_at, updated_at, metadata_json, group_id)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  [s.id, s.mode, s.title ?? null, s.description ?? null, s.summaryHash ?? null, s.titleLocked, s.persistStatus,
    databaseTimestamp(s.createdAt), databaseTimestamp(s.updatedAt), s.metadata === undefined ? null : JSON.stringify(s.metadata), s.groupId ?? null]));
}

export function getSession(db: SqlExecutor, id: string): ChatSession | null {
  return databaseOperation(() => {
    const row = db.get<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM chat_v2_sessions WHERE id = ?1`, [id]);
    return row ? rowToSession(row) : null;
  });
}

export function updateSession(db: SqlExecutor, s: ChatSession, log?: ChatLogger): void {
  log?.debug(`[ChatV2::Repo] Updating session: ${s.id}`);
  databaseOperation(() => {
    const result = db.run(`UPDATE chat_v2_sessions SET mode = ?2, title = ?3, description = ?4,
      summary_hash = ?5, persist_status = ?6, updated_at = ?7, metadata_json = ?8,
      group_id = ?9, tags_hash = ?10, title_locked = ?11 WHERE id = ?1`,
    [s.id, s.mode, s.title ?? null, s.description ?? null, s.summaryHash ?? null, s.persistStatus,
      databaseTimestamp(s.updatedAt), s.metadata === undefined ? null : JSON.stringify(s.metadata), s.groupId ?? null, s.tagsHash ?? null, s.titleLocked]);
    if (!result.changes) throw new ChatV2Error('SessionNotFound', s.id);
  });
  log?.info(`[ChatV2::Repo] Session updated: ${s.id}`);
}

export function deleteSession(db: SqlExecutor, id: string): void {
  databaseOperation(() => {
    if (!db.run('DELETE FROM chat_v2_sessions WHERE id = ?1', [id]).changes) throw new ChatV2Error('SessionNotFound', id);
  });
}

function filters(status: string | null, groupId: string | null): { sql: string; params: SqlParam[] } {
  let sql = VISIBLE_SESSION_FILTER;
  const params: SqlParam[] = [];
  if (status === 'active') {
    sql += ` AND ${ACTIVE_PERSIST_STATUS_SQL}`;
  } else if (status !== null) {
    sql += ' AND persist_status = ?';
    params.push(status);
  }
  if (groupId !== null) {
    if (groupId === '') sql += " AND (group_id IS NULL OR group_id = '')";
    else if (groupId === '*') sql += " AND group_id IS NOT NULL AND group_id != ''";
    else { sql += ' AND group_id = ?'; params.push(groupId); }
  }
  return { sql, params };
}

export function listSessions(db: SqlExecutor, status: string | null, groupId: string | null, limit: number, offset: number, log?: ChatLogger): ChatSession[] {
  const { sql, params } = filters(status, groupId);
  return databaseOperation(() => sessionRows(db.all<SessionRow>(`SELECT ${SESSION_COLUMNS}
    FROM chat_v2_sessions WHERE COALESCE(mode, 'chat') != 'agent' ${sql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]), log));
}

export function countSessions(db: SqlExecutor, status: string | null, groupId: string | null): number {
  const { sql, params } = filters(status, groupId);
  return databaseOperation(() => db.pluck<number>(`SELECT COUNT(*) FROM chat_v2_sessions WHERE COALESCE(mode, 'chat') != 'agent' ${sql}`, params)!);
}

export function setTitleLocked(db: SqlExecutor, id: string, locked: boolean): void {
  databaseOperation(() => db.run('UPDATE chat_v2_sessions SET title_locked = ?2 WHERE id = ?1', [id, locked]));
}

/** `list_agent_sessions_with_conn` (repo.rs:1206-1252): active agent sessions only. */
export function listAgentSessions(db: SqlExecutor, workspaceId: string | null, limit: number, log?: ChatLogger): ChatSession[] {
  return databaseOperation(() => {
    const rows = workspaceId === null
      ? db.all<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM chat_v2_sessions
          WHERE mode = 'agent' AND ${ACTIVE_PERSIST_STATUS_SQL}
          ORDER BY updated_at DESC LIMIT ?1`, [limit])
      : db.all<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM chat_v2_sessions
          WHERE mode = 'agent' AND ${ACTIVE_PERSIST_STATUS_SQL}
            AND metadata_json IS NOT NULL AND json_valid(metadata_json)
            AND json_extract(metadata_json, '$.workspace_id') = ?1
          ORDER BY updated_at DESC LIMIT ?2`, [workspaceId, limit]);
    return sessionRows(rows, log);
  });
}

/** Active Super-agent sessions excluding one id (`other_active_super_session_exists`). */
export function otherActiveSuperSessionExists(db: SqlExecutor, sessionId: string): boolean {
  return databaseOperation(() => Number(db.pluck<number>(`SELECT EXISTS(
    SELECT 1 FROM chat_v2_sessions
    WHERE id != ?1 AND ${ACTIVE_PERSIST_STATUS_SQL}
      AND metadata_json IS NOT NULL AND json_valid(metadata_json)
      AND COALESCE(json_extract(metadata_json, '$.super_agent.active'), 0) = 1
  )`, [sessionId])) === 1);
}

/** `update_session_group_with_conn` (repo.rs:1117-1127). */
export function updateSessionGroup(db: SqlExecutor, sessionId: string, groupId: string | null): void {
  databaseOperation(() => db.run(
    'UPDATE chat_v2_sessions SET group_id = ?2, updated_at = ?3 WHERE id = ?1',
    [sessionId, groupId, databaseNow()]));
}

/** `session_has_running_anki_blocks` (manage_session.rs:274-307). */
export function sessionHasRunningAnkiBlocks(db: SqlExecutor, sessionId: string): boolean {
  return databaseOperation(() => Number(db.pluck<number>(`SELECT COUNT(*)
    FROM chat_v2_blocks b
    INNER JOIN chat_v2_messages m ON m.id = b.message_id
    WHERE m.session_id = ?1
      AND b.block_type = 'anki_cards'
      AND b.status IN ('pending', 'running')`, [sessionId])) > 0);
}

/** `session_has_super_marker`: metadata contains a `super_agent` key (any shape). */
export function sessionHasSuperMarker(db: SqlExecutor, sessionId: string): boolean {
  return databaseOperation(() => Number(db.pluck<number>(
    `SELECT CASE
        WHEN metadata_json IS NOT NULL AND json_valid(metadata_json)
        THEN COALESCE(json_type(metadata_json, '$.super_agent') IS NOT NULL, 0)
        ELSE 0
      END
      FROM chat_v2_sessions WHERE id = ?1`, [sessionId])) === 1);
}

export interface SessionReferencingResource {
  sessionId: string; title: string | null; messageId: string; lastReferencedAt: number;
}

/** `list_sessions_referencing` (manage_session.rs:2889-2937). */
export function listSessionsReferencing(
  db: SqlExecutor,
  sourceIds: string[],
  limit: number,
): SessionReferencingResource[] {
  return databaseOperation(() => {
    const bySession = new Map<string, SessionReferencingResource>();
    for (const rawId of sourceIds.map(rustTrim).filter(id => id !== '')) {
      const quoted = likeContains(`"${rawId}"`);
      const pdfMarker = likeContains(`[PDF@${rawId}:`);
      const hits = db.all<{ sid: string; title: string | null; mid: string; ts: number }>(`
        SELECT h.sid, s.title, h.mid, h.ts FROM (
          SELECT m.session_id AS sid, m.id AS mid, m.timestamp AS ts
            FROM chat_v2_messages m
           WHERE m.meta_json LIKE ?1 ESCAPE '\\' OR m.attachments_json LIKE ?1 ESCAPE '\\'
          UNION ALL
          SELECT m.session_id, m.id, m.timestamp
            FROM chat_v2_blocks b JOIN chat_v2_messages m ON m.id = b.message_id
           WHERE b.citations_json LIKE ?1 ESCAPE '\\' OR b.content LIKE ?2 ESCAPE '\\'
        ) h
        JOIN chat_v2_sessions s ON s.id = h.sid
        WHERE COALESCE(s.persist_status, 'active') NOT IN ('archived', 'deleted')`, [quoted, pdfMarker]);
      for (const hit of hits) {
        const existing = bySession.get(hit.sid);
        if (existing && existing.lastReferencedAt >= hit.ts) continue;
        bySession.set(hit.sid, { sessionId: hit.sid, title: hit.title, messageId: hit.mid, lastReferencedAt: hit.ts });
      }
    }
    return [...bySession.values()]
      .sort((left, right) => right.lastReferencedAt - left.lastReferencedAt)
      .slice(0, limit);
  });
}

function likeContains(needle: string): string {
  return `%${needle.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
}

/** `delete_session_with_tx` (repo.rs:546-564): cascade messages/blocks via FK. */
export function deleteSessionHard(db: SqlExecutor, sessionId: string, log?: ChatLogger): void {
  log?.debug(`[ChatV2::Repo] Deleting session: ${sessionId}`);
  databaseOperation(() => {
    if (!db.run('DELETE FROM chat_v2_sessions WHERE id = ?1', [sessionId]).changes) {
      throw new ChatV2Error('SessionNotFound', sessionId);
    }
  });
  log?.info(`[ChatV2::Repo] Session deleted with cascade: ${sessionId}`);
}

/** `list_deleted_session_ids` (repo.rs:3406-3415). */
export function listDeletedSessionIds(db: SqlExecutor): string[] {
  return databaseOperation(() => db.all<{ id: string }>(
    `SELECT id FROM chat_v2_sessions WHERE persist_status = 'deleted'`).map(row => row.id));
}
