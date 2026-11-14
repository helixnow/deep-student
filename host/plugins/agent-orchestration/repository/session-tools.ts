/**
 * chat_v2 会话 / 消息 / 块的只读查询、session_import 的 D1 写入端口声明，以及
 * chat/api.ts 未发布的 `update_session_group_with_conn`（session_move / batch move 使用）。
 *
 * 语义来源：`src-tauri/crates/dstu-agent/src/chat_v2/repo.rs` 的
 * `get_session_with_conn` / `list_sessions_with_conn` / `count_sessions_with_conn` /
 * `load_session_messages_page_with_conn` / `get_session_messages_with_conn` /
 * `get_session_blocks_with_conn`；写入方法 `create_session_with_conn` /
 * `create_message_with_conn` / `create_blocks_batch_with_conn` 由 L04 所有者实现，
 * 本文件只声明调用方需要传入的端口，不执行这些 SQL。
 *
 * 只被 `chat_v2/tools/session_executor.rs` 的移植（`src/session-tools.ts`）使用；
 * 其他 lane 的会话读写仍走 L04 `chatSession`。
 */
import type { SqlExecutor, SqlValue } from '../../../platform/storage/api.ts';
import { chronoRfc3339, parseRfc3339 } from '../../../platform/time/index.ts';

export interface ChatSessionRecord {
  id: string;
  mode: string;
  title: string | null;
  description: string | null;
  summaryHash: string | null;
  persistStatus: string;
  createdAt: string;
  updatedAt: string;
  metadata: unknown;
  groupId: string | null;
  tagsHash: string | null;
  titleLocked: boolean;
}

export interface ChatMessageRecord {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  blockIds: string[];
  timestamp: number;
  persistentStableId: string | null;
  parentId: string | null;
  supersedes: string | null;
  meta: unknown;
  attachments: unknown;
  activeVariantId: string | null;
  variants: unknown;
  sharedContext: unknown;
}

export interface ChatBlockRecord {
  id: string;
  messageId: string;
  blockType: string;
  status: string;
  blockIndex: number;
  content: string | null;
  toolName: string | null;
  toolInput: unknown;
  toolOutput: unknown;
  citations: unknown;
  error: string | null;
  startedAt: number | null;
  endedAt: number | null;
  firstChunkAt: number | null;
}

type Row = Record<string, SqlValue>;

const SESSION_COLUMNS = 'id, mode, title, description, summary_hash, persist_status, created_at, updated_at, metadata_json, group_id, tags_hash, title_locked';
const MESSAGE_COLUMNS = 'id, session_id, role, block_ids_json, timestamp, persistent_stable_id, parent_id, supersedes, meta_json, attachments_json, active_variant_id, variants_json, shared_context_json';
const QUALIFIED_BLOCK_COLUMNS = 'b.id, b.message_id, b.block_type, b.status, b.block_index, b.content, b.tool_name, b.tool_input_json, b.tool_output_json, b.citations_json, b.error, b.started_at, b.ended_at, b.first_chunk_at';

/** Rust `ChatV2Repo::append_visible_session_filter`（repo.rs:220–228）。 */
const VISIBLE_SESSION_FILTER = ` AND COALESCE(json_extract(metadata_json, '$.chatV2Draft.hidden'), 0) != 1
  AND json_extract(metadata_json, '$.superagent') IS NULL
  AND COALESCE(json_extract(metadata_json, '$.super_agent.hidden'), 0) != 1`;

let sessionToolsWarn: (message: string) => void = () => {};

/** 装配层注入 `ctx.logger.warn`（对应 Rust 仓储的 `log::warn!`）。 */
export function setSessionToolsLogger(warn: (message: string) => void): void {
  sessionToolsWarn = warn;
}

function text(value: SqlValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/** Rust `row.get::<_, String>`：缺列 / NULL / 类型不符时整行转换失败，由调用方 warn 后跳过。 */
function requiredText(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new Error(`Invalid column type for '${column}': expected TEXT`);
  }
  return value;
}

function requiredInteger(row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`Invalid column type for '${column}': expected INTEGER`);
  }
  return value;
}

function num(value: SqlValue | undefined): number | null {
  if (typeof value === 'bigint') return Number(value);
  return typeof value === 'number' ? value : null;
}

/** chrono `DateTime::parse_from_rfc3339(..).unwrap_or(UNIX_EPOCH).to_rfc3339()`。 */
function normalizeTimestamp(value: string | null): string {
  if (value === null) return chronoRfc3339(0n);
  const parsed = parseRfc3339(value);
  if (parsed === null) {
    sessionToolsWarn(`[ChatV2Repo] Failed to parse timestamp '${value}', using epoch fallback`);
    return chronoRfc3339(0n);
  }
  return chronoRfc3339(parsed.epochNanos);
}

function parseJson(value: string | null): unknown {
  if (value === null) return undefined;
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

function parseJsonField(value: string | null, field: string, messageId: string): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    sessionToolsWarn(
      `[ChatV2Repo] Failed to parse ${field} for message ${messageId}: ${String(error)}`,
    );
    return undefined;
  }
}

function optionalText(row: Row, column: string): string | null {
  const value = row[column];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`Invalid column type for '${column}': expected TEXT`);
  }
  return value;
}

function stringArray(value: string | null, messageId: string): string[] {
  const parsed = parseJsonField(value, 'block_ids_json', messageId);
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
}

export function rowToSession(row: Row): ChatSessionRecord {
  const persist = requiredText(row, 'persist_status');
  return {
    id: requiredText(row, 'id'),
    mode: requiredText(row, 'mode'),
    title: optionalText(row, 'title'),
    description: optionalText(row, 'description'),
    summaryHash: optionalText(row, 'summary_hash'),
    persistStatus: persist === 'archived' || persist === 'deleted' ? persist : 'active',
    createdAt: normalizeTimestamp(requiredText(row, 'created_at')),
    updatedAt: normalizeTimestamp(requiredText(row, 'updated_at')),
    metadata: parseJson(optionalText(row, 'metadata_json')),
    groupId: optionalText(row, 'group_id'),
    tagsHash: optionalText(row, 'tags_hash'),
    titleLocked: (num(row.title_locked) ?? 0) !== 0,
  };
}

export function rowToMessage(row: Row): ChatMessageRecord {
  const id = requiredText(row, 'id');
  return {
    id,
    sessionId: requiredText(row, 'session_id'),
    role: requiredText(row, 'role') === 'assistant' ? 'assistant' : 'user',
    blockIds: stringArray(requiredText(row, 'block_ids_json'), id),
    timestamp: requiredInteger(row, 'timestamp'),
    persistentStableId: optionalText(row, 'persistent_stable_id'),
    parentId: optionalText(row, 'parent_id'),
    supersedes: optionalText(row, 'supersedes'),
    meta: parseJsonField(optionalText(row, 'meta_json'), 'meta_json', id),
    attachments: parseJsonField(optionalText(row, 'attachments_json'), 'attachments_json', id),
    activeVariantId: optionalText(row, 'active_variant_id'),
    variants: parseJsonField(optionalText(row, 'variants_json'), 'variants_json', id),
    sharedContext: parseJsonField(optionalText(row, 'shared_context_json'), 'shared_context_json', id),
  };
}

export function rowToBlock(row: Row): ChatBlockRecord {
  return {
    id: requiredText(row, 'id'),
    messageId: requiredText(row, 'message_id'),
    blockType: requiredText(row, 'block_type'),
    status: requiredText(row, 'status'),
    blockIndex: requiredInteger(row, 'block_index'),
    content: optionalText(row, 'content'),
    toolName: optionalText(row, 'tool_name'),
    toolInput: parseJson(optionalText(row, 'tool_input_json')),
    toolOutput: parseJson(optionalText(row, 'tool_output_json')),
    citations: parseJson(optionalText(row, 'citations_json')),
    error: optionalText(row, 'error'),
    startedAt: num(row.started_at),
    endedAt: num(row.ended_at),
    firstChunkAt: num(row.first_chunk_at),
  };
}

function filters(status: string | null, groupId: string | null): { sql: string; params: SqlValue[] } {
  let sql = VISIBLE_SESSION_FILTER;
  const params: SqlValue[] = [];
  if (status !== null) { sql += ' AND persist_status = ?'; params.push(status); }
  if (groupId !== null) {
    if (groupId === '') sql += ' AND group_id IS NULL';
    else if (groupId === '*') sql += ' AND group_id IS NOT NULL';
    else { sql += ' AND group_id = ?'; params.push(groupId); }
  }
  return { sql, params };
}

/** repo.rs:583–637。 */
export function listSessions(
  db: SqlExecutor, status: string | null, groupId: string | null, limit: number, offset: number,
): ChatSessionRecord[] {
  const { sql, params } = filters(status, groupId);
  const rows = db.all<Row>(`SELECT ${SESSION_COLUMNS} FROM chat_v2_sessions
    WHERE mode != 'agent' ${sql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return rows.flatMap((row) => {
    try { return [rowToSession(row)]; } catch (error) {
      sessionToolsWarn(`[ChatV2Repo] Skipping malformed row: ${String(error)}`);
      return [];
    }
  });
}

/** repo.rs:646–675。 */
export function countSessions(db: SqlExecutor, status: string | null, groupId: string | null): number {
  const { sql, params } = filters(status, groupId);
  return Number(db.pluck<number>(`SELECT COUNT(*) FROM chat_v2_sessions WHERE mode != 'agent' ${sql}`, params) ?? 0);
}

/** repo.rs:397–414。 */
export function getSessionById(db: SqlExecutor, sessionId: string): ChatSessionRecord | null {
  const row = db.get<Row>(`SELECT ${SESSION_COLUMNS} FROM chat_v2_sessions WHERE id = ?1`, [sessionId]);
  return row === undefined ? null : rowToSession(row);
}

function messagesFromRows(rows: Row[]): ChatMessageRecord[] {
  return rows.flatMap((row) => {
    try { return [rowToMessage(row)]; } catch (error) {
      sessionToolsWarn(`[ChatV2Repo] Skipping malformed row: ${String(error)}`);
      return [];
    }
  });
}

function blocksFromRows(rows: Row[]): ChatBlockRecord[] {
  return rows.flatMap((row) => {
    try { return [rowToBlock(row)]; } catch (error) {
      sessionToolsWarn(`[ChatV2Repo] Skipping malformed block row: ${String(error)}`);
      return [];
    }
  });
}

/** repo.rs:1387–1411。 */
export function getMessages(db: SqlExecutor, sessionId: string): ChatMessageRecord[] {
  return messagesFromRows(db.all<Row>(`SELECT ${MESSAGE_COLUMNS} FROM chat_v2_messages
    WHERE session_id = ?1 ORDER BY timestamp ASC, rowid ASC`, [sessionId]));
}

/** repo.rs:2374–2401。 */
export function getBlocks(db: SqlExecutor, sessionId: string): ChatBlockRecord[] {
  return blocksFromRows(db.all<Row>(`SELECT ${QUALIFIED_BLOCK_COLUMNS}
    FROM chat_v2_blocks b
    INNER JOIN chat_v2_messages m ON b.message_id = m.id
    WHERE m.session_id = ?1
    ORDER BY m.timestamp ASC, COALESCE(b.first_chunk_at, b.started_at) ASC, b.block_index ASC`, [sessionId]));
}

/** repo.rs:1477–1577：分页消息 + 该页消息的块（窗口 SQL 与 Rust 完全一致）。 */
export function loadMessagesPage(
  db: SqlExecutor, sessionId: string, page: number, pageSize: number, roleFilter: string | null,
): { messages: ChatMessageRecord[]; blocks: ChatBlockRecord[]; total: number } {
  const offset = (Math.max(1, page) - 1) * pageSize;
  const total = Number(db.pluck<number>(`SELECT COUNT(*) FROM chat_v2_messages
    WHERE session_id = ?1 AND (?2 IS NULL OR role = ?2)`, [sessionId, roleFilter]) ?? 0);
  const messages = messagesFromRows(db.all<Row>(`SELECT ${MESSAGE_COLUMNS} FROM chat_v2_messages
    WHERE session_id = ?1 AND (?2 IS NULL OR role = ?2)
    ORDER BY timestamp ASC, rowid ASC LIMIT ?3 OFFSET ?4`,
  [sessionId, roleFilter, pageSize, offset]));
  const blocks = blocksFromRows(db.all<Row>(`SELECT ${QUALIFIED_BLOCK_COLUMNS}
    FROM chat_v2_blocks b
    INNER JOIN (
      SELECT id, timestamp, rowid AS message_rowid
      FROM chat_v2_messages
      WHERE session_id = ?1 AND (?2 IS NULL OR role = ?2)
      ORDER BY timestamp ASC, rowid ASC
      LIMIT ?3 OFFSET ?4
    ) page_messages ON b.message_id = page_messages.id
    ORDER BY page_messages.timestamp ASC, page_messages.message_rowid ASC, b.block_index ASC`,
  [sessionId, roleFilter, pageSize, offset]));
  return { messages, blocks, total };
}

/** repo.rs:4667–4676 / 4681–4715。 */
export function getTagsForSessions(db: SqlExecutor, sessionIds: readonly string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (let index = 0; index < sessionIds.length; index += 500) {
    const chunk = sessionIds.slice(index, index + 500);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map((_, position) => `?${position + 1}`).join(',');
    const rows = db.all<Row>(`SELECT session_id, tag FROM chat_v2_session_tags
      WHERE session_id IN (${placeholders}) ORDER BY tag_type ASC, created_at ASC`, [...chunk]);
    for (const row of rows) {
      const sessionId = text(row.session_id);
      const tag = text(row.tag);
      if (sessionId === null || tag === null) continue;
      const list = map.get(sessionId) ?? [];
      list.push(tag);
      map.set(sessionId, list);
    }
  }
  return map;
}

/** repo.rs:1117–1127 `update_session_group_with_conn`（不存在的会话静默成功）。 */
export function updateSessionGroup(db: SqlExecutor, sessionId: string, groupId: string | null): void {
  db.run('UPDATE chat_v2_sessions SET group_id = ?2, updated_at = ?3 WHERE id = ?1',
    [sessionId, groupId, chronoRfc3339()]);
}

/**
 * 会话导入的 D1 写入端口：chat_v2 表所有者（L04）按 Rust
 * `create_session_with_conn` / `create_message_with_conn` /
 * `create_blocks_batch_with_conn` 一一对应发布；调用方开启并持有事务，
 * 只把同一个 `SqlExecutor` 依次传入，本 lane 不直接写 chat_v2_* 表。
 */
export interface SessionImportRepository {
  createSessionWithConn(conn: SqlExecutor, session: import('../../chat/api.ts').ChatSession): void;
  createMessageWithConn(conn: SqlExecutor, message: import('../../chat/api.ts').ChatMessage): void;
  createBlocksBatchWithConn(
    conn: SqlExecutor,
    blocks: ReadonlyArray<import('../../chat/api.ts').MessageBlock & { blockIndex?: number }>,
  ): void;
}
