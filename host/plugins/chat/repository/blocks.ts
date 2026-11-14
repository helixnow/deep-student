/**
 * `chat_v2_blocks` persistence. Rust source: `chat_v2/repo.rs:1765-2402`.
 */
import type { MessageBlock } from '../api.ts';

export type StoredBlock = MessageBlock & { blockIndex: number };
export type BlockInput = MessageBlock & { blockIndex?: number };
import { defineQuery, type DatabaseHandle, type SqlExecutor, type SqlParam, type SqlValue,
  type TransactionScope } from '../../../platform/storage/api.ts';
import { JsonReader, JsonSyntaxError } from '../../../platform/util/index.ts';
import { ChatV2Error } from '../src/error.ts';
import { errorText, type ChatLogger } from '../src/logger.ts';
import { databaseOperation } from './errors.ts';
import { isMissingReplayColumn } from './block-replay.ts';
import { now } from '../../../platform/time/index.ts';

export const BLOCK_COLUMNS = 'id, message_id, block_type, status, block_index, content, tool_name, tool_input_json, tool_output_json, citations_json, error, started_at, ended_at, first_chunk_at';
export const BLOCK_COLUMNS_QUALIFIED = 'b.id, b.message_id, b.block_type, b.status, b.block_index, b.content, b.tool_name, b.tool_input_json, b.tool_output_json, b.citations_json, b.error, b.started_at, b.ended_at, b.first_chunk_at';

export interface BlockRow {
  id: string;
  message_id: string;
  block_type: string;
  status: string;
  block_index: number;
  content: string | null;
  tool_name: string | null;
  tool_input_json: string | null;
  tool_output_json: string | null;
  citations_json: string | null;
  error: string | null;
  started_at: number | null;
  ended_at: number | null;
  first_chunk_at: number | null;
}

function parseOptional<T>(value: string | null): T | undefined {
  if (value === null) return undefined;
  try { return JSON.parse(value) as T; } catch { return undefined; }
}

export function rowToBlock(row: BlockRow): StoredBlock {
  // repo.rs:2319-2333 uses typed row.get before constructing MessageBlock.
  const columns = BLOCK_COLUMNS.split(', ');
  for (const [index, column] of columns.entries()) {
    const value = row[column as keyof BlockRow];
    if (index >= 5 && value === null) continue;
    const integer = index === 4 || index >= 11;
    if (integer ? typeof value !== 'number' || !Number.isInteger(value) : typeof value !== 'string') {
      const type = value === null ? 'Null' : typeof value === 'string' ? 'Text'
        : typeof value === 'number' ? Number.isInteger(value) ? 'Integer' : 'Real' : 'Blob';
      throw new Error(`Invalid column type ${type} at index: ${index}, name: ${column}`);
    }
    if (index === 4 && (row.block_index < 0 || row.block_index > 0xffffffff)) {
      throw new Error(`Integral value out of range for column 4: ${value}`);
    }
  }
  const block: StoredBlock = {
    id: row.id,
    messageId: row.message_id,
    type: row.block_type,
    status: row.status,
    blockIndex: row.block_index,
  };
  if (row.content !== null) block.content = row.content;
  if (row.tool_name !== null) block.toolName = row.tool_name;
  const toolInput = parseOptional<unknown>(row.tool_input_json);
  if (toolInput !== undefined) block.toolInput = toolInput;
  const toolOutput = parseOptional<unknown>(row.tool_output_json);
  if (toolOutput !== undefined) block.toolOutput = toolOutput;
  const citations = parseOptional<MessageBlock['citations']>(row.citations_json);
  if (citations !== undefined) block.citations = citations;
  if (row.error !== null) block.error = row.error;
  if (row.started_at !== null) block.startedAt = row.started_at;
  if (row.ended_at !== null) block.endedAt = row.ended_at;
  if (row.first_chunk_at !== null) block.firstChunkAt = row.first_chunk_at;
  return block;
}

const UPSERT_BLOCK = `INSERT INTO chat_v2_blocks (id, message_id, block_type, status, block_index, content, tool_name, tool_input_json, tool_output_json, citations_json, error, started_at, ended_at, first_chunk_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
  ON CONFLICT(id) DO UPDATE SET
    message_id = excluded.message_id, block_type = excluded.block_type, status = excluded.status,
    block_index = excluded.block_index, content = excluded.content, tool_name = excluded.tool_name,
    tool_input_json = excluded.tool_input_json, tool_output_json = excluded.tool_output_json,
    citations_json = excluded.citations_json, error = excluded.error, started_at = excluded.started_at,
    ended_at = excluded.ended_at, first_chunk_at = excluded.first_chunk_at`;

function jsonParam(block: BlockInput, key: 'toolInput' | 'toolOutput' | 'citations'): SqlParam {
  // Rust Option<Value>: `Some(Null)` persists "null", only `None` maps to SQL NULL.
  return key in block && block[key] !== undefined ? JSON.stringify(block[key]) : null;
}

function blockParams(block: BlockInput): SqlParam[] {
  return [
    block.id, block.messageId, block.type, block.status, block.blockIndex ?? 0,
    block.content ?? null, block.toolName ?? null,
    jsonParam(block, 'toolInput'), jsonParam(block, 'toolOutput'), jsonParam(block, 'citations'),
    block.error ?? null, block.startedAt ?? null, block.endedAt ?? null, block.firstChunkAt ?? null,
  ];
}

export function createBlock(db: SqlExecutor, block: BlockInput): void {
  databaseOperation(() => db.run(UPSERT_BLOCK, blockParams(block)));
}

/** tools/executor.rs:558-623 returns raw SQL Display, unlike the repository ChatV2Error wrapper. */
export function saveToolBlockRaw(db: SqlExecutor, sessionId: string, block: BlockInput): void {
  const params = blockParams(block);
  db.run(`INSERT OR IGNORE INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp)
    VALUES (?1, ?2, 'assistant', '[]', ?3)`, [block.messageId, sessionId, now().millis]);
  db.run(UPSERT_BLOCK, params);
  appendBlockIdAtomically(db, block.messageId, block.id);
}

/** Shared by tool crash persistence and the coordinator-sleep block pre-save path. */
export function appendBlockIdAtomically(db: SqlExecutor, messageId: string, blockId: string): void {
  db.run(`UPDATE chat_v2_messages SET block_ids_json = json_insert(block_ids_json, '$[#]', ?1)
    WHERE id = ?2 AND ?1 NOT IN (SELECT value FROM json_each(block_ids_json))`, [blockId, messageId]);
}

const workspaceInjectionBlockIds = defineQuery<[string], { block_ids_json: SqlValue }>(
  'SELECT block_ids_json FROM chat_v2_messages WHERE id = ?1',
  { name: 'chat.message.workspaceInjectionBlockIds', options: { safeIntegers: true } });

/** `serde_json::from_str::<Vec<String>>(s).ok()`. */
function parseStringVec(text: string): string[] | null {
  try {
    const reader = new JsonReader(text);
    const ids: string[] = [];
    reader.beginArray();
    while (reader.nextItem()) ids.push(reader.readString());
    reader.end();
    return ids;
  } catch (error) {
    if (error instanceof JsonSyntaxError) return null;
    throw error;
  }
}

/** rusqlite `row.get::<_, Option<String>>(0)` on the single selected column. */
function optionalTextColumn(value: SqlValue): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  const type = typeof value === 'bigint' ? 'Integer' : typeof value === 'number' ? 'Real' : 'Blob';
  throw new Error(`Invalid column type ${type} at index: 0, name: block_ids_json`);
}

/**
 * `append_block_id_to_message_block_ids` (pipeline/tool_loop.rs:2718-2768): NULL or non-`Vec<String>`
 * JSON restarts from `[]`, existing order/duplicates are rewritten as-is, a missing row becomes an
 * assistant message. Errors are the Rust `String` values; no transaction of its own.
 */
export function appendWorkspaceInjectionBlockId(db: SqlExecutor, sessionId: string, messageId: string, blockId: string): void {
  let existing: string | null | undefined;
  try {
    const row = db.get(workspaceInjectionBlockIds, [messageId]);
    existing = row === undefined ? undefined : optionalTextColumn(row.block_ids_json);
  } catch (error) {
    throw new Error(`Failed to read message: ${errorText(error)}`);
  }
  const nowMs = now().millis;
  if (existing !== undefined) {
    const blockIds = (existing === null ? null : parseStringVec(existing)) ?? [];
    if (!blockIds.includes(blockId)) blockIds.push(blockId);
    try {
      db.run('UPDATE chat_v2_messages SET block_ids_json = ?1 WHERE id = ?2', [JSON.stringify(blockIds), messageId]);
    } catch (error) {
      throw new Error(`Failed to update message block_ids: ${errorText(error)}`);
    }
    return;
  }
  try {
    db.run(`INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp)
                       VALUES (?1, ?2, 'assistant', ?3, ?4)`, [messageId, sessionId, JSON.stringify([blockId]), nowMs]);
  } catch (error) {
    throw new Error(`Failed to create message: ${errorText(error)}`);
  }
}

function insertBatch(db: SqlExecutor, blocks: BlockInput[]): void {
  for (const block of blocks) db.run(UPSERT_BLOCK, blockParams(block));
}

/** `create_blocks_batch_with_conn`: one savepoint/transaction for the whole batch. */
export function createBlocksBatch(db: DatabaseHandle | TransactionScope, blocks: BlockInput[]): void {
  if (blocks.length === 0) return;
  databaseOperation(() => {
    if ('savepoint' in db) db.savepoint(scope => insertBatch(scope, blocks));
    else db.transaction(tx => insertBatch(tx, blocks), { behavior: 'immediate' });
  });
}

export function getBlock(db: SqlExecutor, blockId: string): StoredBlock | null {
  return databaseOperation(() => {
    const row = db.get<BlockRow>(`SELECT ${BLOCK_COLUMNS} FROM chat_v2_blocks WHERE id = ?1`, [blockId]);
    return row ? rowToBlock(row) : null;
  });
}

export function getMessageBlocks(db: SqlExecutor, messageId: string, log?: ChatLogger): StoredBlock[] {
  return databaseOperation(() => db.all<BlockRow>(`SELECT ${BLOCK_COLUMNS} FROM chat_v2_blocks
    WHERE message_id = ?1 ORDER BY block_index ASC`, [messageId]).flatMap(row => {
    try { return [rowToBlock(row)]; } catch (error) {
      log?.warn('[ChatV2Repo] Skipping malformed row: ' + errorText(error));
      return [];
    }
  }));
}

/** pipeline/persistence.rs:743-753; caller keeps externally-created Anki payloads untouched. */
export function listBlockPositions(db: SqlExecutor, messageId: string, type: string): [number, string][] {
  return databaseOperation(() => db.all<{ block_index: number; id: string }>(
    'SELECT block_index, id FROM chat_v2_blocks WHERE message_id = ?1 AND block_type = ?2', [messageId, type])
    .map(row => {
      if (typeof row.id !== 'string') throw new Error('Invalid column type for id');
      if (!Number.isInteger(row.block_index) || row.block_index < 0 || row.block_index > 0xffffffff) {
        throw new Error(`Integral value out of range for column 0: ${row.block_index}`);
      }
      return [row.block_index, row.id];
    }));
}

/** `get_session_blocks_with_conn` ordering (repo.rs:2374-2402). */
export function getSessionBlocks(db: SqlExecutor, sessionId: string, log?: ChatLogger): StoredBlock[] {
  return databaseOperation(() => db.all<BlockRow>(`SELECT ${BLOCK_COLUMNS_QUALIFIED} FROM chat_v2_blocks b
    INNER JOIN chat_v2_messages m ON b.message_id = m.id
    WHERE m.session_id = ?1
    ORDER BY m.timestamp ASC, COALESCE(b.first_chunk_at, b.started_at) ASC, b.block_index ASC`,
  [sessionId]).flatMap(row => {
    try { return [rowToBlock(row)]; } catch (error) {
      log?.warn('[ChatV2Repo] Skipping malformed row: ' + errorText(error));
      return [];
    }
  }));
}

/**
 * `update_block_with_conn` (repo.rs:2227-2295): changing `content` invalidates
 * the replay-sidecar `llm_content` in the same UPDATE.
 */
export function updateBlock(db: SqlExecutor, block: BlockInput, log?: ChatLogger): void {
  log?.debug(`[ChatV2::Repo] Updating block: id=${block.id}, status=${block.status}`);
  databaseOperation(() => {
    const params: SqlParam[] = [
      block.id, block.status, block.content ?? null,
      jsonParam(block, 'toolInput'), jsonParam(block, 'toolOutput'), jsonParam(block, 'citations'),
      block.error ?? null, block.startedAt ?? null, block.endedAt ?? null, block.firstChunkAt ?? null,
    ];
    const fields = `status = ?2, content = ?3, tool_input_json = ?4, tool_output_json = ?5,
      citations_json = ?6, error = ?7, started_at = ?8, ended_at = ?9, first_chunk_at = ?10 WHERE id = ?1`;
    let result;
    try {
      result = db.run(`UPDATE chat_v2_blocks SET llm_content = CASE WHEN content IS ?3 THEN llm_content ELSE NULL END, ${fields}`, params);
    } catch (error) {
      if (!isMissingReplayColumn(error)) throw error;
      result = db.run(`UPDATE chat_v2_blocks SET ${fields}`, params);
    }
    if (!result.changes) throw new ChatV2Error('BlockNotFound', block.id);
  });
  log?.debug(`[ChatV2::Repo] Block updated: ${block.id}`);
}

/** `clear_block_llm_content_with_conn` (repo.rs:2199-2212): old databases without the column are a no-op. */
export function clearBlockLlmContent(db: SqlExecutor, blockId: string): void {
  databaseOperation(() => {
    try { db.run('UPDATE chat_v2_blocks SET llm_content = NULL WHERE id = ?1', [blockId]); }
    catch (error) { if (!isMissingReplayColumn(error)) throw error; }
  });
}

export function deleteBlock(db: SqlExecutor, blockId: string): void {
  databaseOperation(() => {
    if (!db.run('DELETE FROM chat_v2_blocks WHERE id = ?1', [blockId]).changes) {
      throw new ChatV2Error('BlockNotFound', blockId);
    }
  });
}

/**
 * `copy_block_replay_with_conn` (repo.rs:2172-2192): replay sidecar columns are
 * not part of `MessageBlock`, so branching copies them at SQL level. Missing
 * V20260806 columns degrade to a no-op (old databases).
 */
export function copyBlockReplay(db: SqlExecutor, sourceBlockId: string, targetBlockId: string): void {
  databaseOperation(() => {
    try {
      db.run(`UPDATE chat_v2_blocks
        SET llm_content = (SELECT s.llm_content FROM chat_v2_blocks s WHERE s.id = ?1),
            tool_call_id = (SELECT s.tool_call_id FROM chat_v2_blocks s WHERE s.id = ?1),
            round_text = (SELECT s.round_text FROM chat_v2_blocks s WHERE s.id = ?1)
        WHERE id = ?2`, [sourceBlockId, targetBlockId]);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('no such column')) throw error;
    }
  });
}

/** pipeline/compaction.rs:1503-1514; leave raw query errors for the L03 warning boundary. */
export function getCompactionSummaryMessageIds(db: SqlExecutor, sessionId: string): string[] {
  return db.all<{ message_id: unknown }>(`SELECT DISTINCT b.message_id
    FROM chat_v2_blocks b
    INNER JOIN chat_v2_messages m ON m.id = b.message_id
    WHERE b.block_type = ?1 AND m.session_id = ?2`, ['compaction_summary', sessionId]).map(row => {
    if (typeof row.message_id !== 'string') {
      const type = row.message_id === null ? 'Null' : typeof row.message_id === 'number'
        ? Number.isInteger(row.message_id) ? 'Integer' : 'Real' : 'Blob';
      throw new Error(`Invalid column type ${type} at index: 0, name: message_id`);
    }
    return row.message_id;
  });
}

/** Strip the backend-only `block_index` before IPC (`skip_serializing`). */
export function toWireBlock(block: StoredBlock): MessageBlock {
  const { blockIndex: _blockIndex, ...wire } = block;
  return wire;
}

/** Append a streaming block id to `block_ids_json` when the message exists. */
export function appendBlockIdToMessage(db: SqlExecutor, messageId: string, blockId: string): void {
  databaseOperation(() => {
    const row = db.get<{ block_ids_json: string }>(
      'SELECT block_ids_json FROM chat_v2_messages WHERE id = ?1', [messageId]);
    if (!row) return;
    let blockIds: string[] = [];
    try { blockIds = JSON.parse(row.block_ids_json) as string[]; } catch { blockIds = []; }
    if (blockIds.includes(blockId)) return;
    blockIds.push(blockId);
    db.run('UPDATE chat_v2_messages SET block_ids_json = ?1 WHERE id = ?2', [JSON.stringify(blockIds), messageId]);
  });
}

const UPSERT_STREAMING_BLOCK = `INSERT INTO chat_v2_blocks
  (id, message_id, block_type, status, block_index, content, tool_name, tool_input_json, tool_output_json, citations_json, error, started_at, ended_at, first_chunk_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
  ON CONFLICT(id) DO UPDATE SET
    message_id = excluded.message_id,
    block_type = excluded.block_type,
    status = excluded.status,
    block_index = excluded.block_index,
    content = excluded.content,
    tool_name = excluded.tool_name,
    tool_input_json = excluded.tool_input_json,
    tool_output_json = excluded.tool_output_json,
    citations_json = excluded.citations_json,
    error = excluded.error,
    started_at = COALESCE(chat_v2_blocks.started_at, excluded.started_at),
    ended_at = excluded.ended_at,
    first_chunk_at = COALESCE(chat_v2_blocks.first_chunk_at, excluded.first_chunk_at)`;

/** `upsert_block_in_db` (block_actions.rs:958-1015): crash-save upsert keeps the first started_at. */
export function upsertStreamingBlock(db: SqlExecutor, block: BlockInput): void {
  databaseOperation(() => db.run(UPSERT_STREAMING_BLOCK, blockParams(block)));
}

/** Candidate `anki_cards` tool outputs matching a LIKE pattern, newest rowid first. */
export function ankiToolOutputsMatching(db: SqlExecutor, likePattern: string): string[] {
  return databaseOperation(() => db.all<{ tool_output_json: string }>(`
    SELECT tool_output_json
    FROM chat_v2_blocks
    WHERE block_type = 'anki_cards'
      AND tool_output_json IS NOT NULL
      AND tool_output_json LIKE ?1 ESCAPE '\\'
    ORDER BY rowid DESC`, [likePattern]).map(row => row.tool_output_json));
}
