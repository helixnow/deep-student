/**
 * `chat_v2_compactions` pointer/invalidation helpers.
 * Rust source: `chat_v2/repo.rs:8309-8598`; types in `chat_v2/types.rs:2871-2918`.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { ChatLogger } from '../src/logger.ts';
import { databaseOperation } from './errors.ts';
import { getMessageBlocks, updateBlock } from './blocks.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';

const COMPACTION_COLUMNS = `id, session_id, summary_message_id, tail_start_message_id,
  tail_start_time_created, reason, is_auto, is_overflow, tokens_before, tokens_after,
  model_id, model_config_id, previous_compaction_id, range_start_message_id,
  range_end_message_id, compacted_message_count, created_at`;

export interface CompactionRow {
  id: string;
  session_id: string;
  summary_message_id: string;
  tail_start_message_id: string;
  tail_start_time_created: number;
  reason: string;
  is_auto: number;
  is_overflow: number;
  tokens_before: number | null;
  tokens_after: number | null;
  model_id: string | null;
  model_config_id: string | null;
  previous_compaction_id: string | null;
  range_start_message_id: string | null;
  range_end_message_id: string | null;
  compacted_message_count: number | null;
  created_at: number;
}

export interface CompactionRecord {
  id: string;
  sessionId: string;
  summaryMessageId: string;
  tailStartMessageId: string;
  tailStartTimeCreated: number;
  reason: string;
  isAuto: boolean;
  isOverflow: boolean;
  tokensBefore: number | null;
  tokensAfter: number | null;
  modelId: string | null;
  modelConfigId: string | null;
  previousCompactionId: string | null;
  rangeStartMessageId: string | null;
  rangeEndMessageId: string | null;
  compactedMessageCount: number | null;
  createdAt: number;
}

/** `row_to_compaction` (repo.rs:8577-8597); `u32` casts truncate like `as u32`. */
export function rowToCompaction(row: CompactionRow): CompactionRecord {
  const u32 = (value: number | null): number | null => value === null ? null : Number(BigInt.asUintN(32, BigInt(value)));
  return {
    id: row.id,
    sessionId: row.session_id,
    summaryMessageId: row.summary_message_id,
    tailStartMessageId: row.tail_start_message_id,
    tailStartTimeCreated: row.tail_start_time_created,
    reason: row.reason,
    isAuto: row.is_auto !== 0,
    isOverflow: row.is_overflow !== 0,
    tokensBefore: u32(row.tokens_before),
    tokensAfter: u32(row.tokens_after),
    modelId: row.model_id,
    modelConfigId: row.model_config_id,
    previousCompactionId: row.previous_compaction_id,
    rangeStartMessageId: row.range_start_message_id,
    rangeEndMessageId: row.range_end_message_id,
    compactedMessageCount: u32(row.compacted_message_count),
    createdAt: row.created_at,
  };
}

/** `history_boundary_id` (types.rs:2908-2914). */
export function historyBoundaryId(record: CompactionRecord): string {
  if (record.tailStartMessageId === record.summaryMessageId) {
    return record.rangeEndMessageId ?? '';
  }
  return record.tailStartMessageId;
}

export function getCompactionById(db: SqlExecutor, id: string): CompactionRecord | null {
  return databaseOperation(() => {
    const row = db.get<CompactionRow>(`SELECT ${COMPACTION_COLUMNS} FROM chat_v2_compactions
      WHERE id = ?1 AND deleted_at IS NULL`, [id]);
    return row ? rowToCompaction(row) : null;
  });
}

export function getLatestCompaction(db: SqlExecutor, sessionId: string): CompactionRecord | null {
  return databaseOperation(() => {
    const row = db.get<CompactionRow>(`SELECT ${COMPACTION_COLUMNS} FROM chat_v2_compactions
      WHERE session_id = ?1 AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`, [sessionId]);
    return row ? rowToCompaction(row) : null;
  });
}

/** `get_active_compaction_with_conn` (repo.rs:8468-8507). */
export function getActiveCompaction(db: SqlExecutor, sessionId: string, log?: ChatLogger): CompactionRecord | null {
  return databaseOperation(() => {
    const lastId = db.get<{ last_compaction_id: string | null }>(
      'SELECT last_compaction_id FROM chat_v2_sessions WHERE id = ?1', [sessionId]);
    const id = lastId?.last_compaction_id ?? null;
    if (id === null) return null;
    if (id !== '') {
      const record = getCompactionById(db, id);
      if (record && record.sessionId === sessionId) return record;
      if (record) log?.error(`[chat_v2::repo] session ${sessionId} points to compaction ${id} owned by ${record.sessionId}; using raw history`);
      else log?.warn(`[chat_v2::repo] session ${sessionId} points to missing compaction ${id}; using raw history`);
      return null;
    }
    // Legacy empty-string pointer compatibility.
    return getLatestCompaction(db, sessionId);
  });
}

/** `set_compaction_summary_active_metadata_with_conn` (repo.rs:8309-8332). */
function setCompactionSummaryActiveMetadata(db: SqlExecutor, compactionId: string, isActive: boolean, log?: ChatLogger): void {
  const record = getCompactionById(db, compactionId);
  if (!record) return;
  for (const block of getMessageBlocks(db, record.summaryMessageId, log)) {
    if (block.type !== 'compaction_summary') continue;
    const metadata = block.toolOutput !== null && block.toolOutput !== undefined
      ? block.toolOutput : {};
    if (metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)) {
      (metadata as Record<string, unknown>).isActive = isActive;
    }
    updateBlock(db, { ...block, toolOutput: metadata }, log);
  }
}

/** `clear_session_last_compaction_with_conn` (repo.rs:8406-8426). */
export function clearSessionLastCompaction(db: SqlExecutor, sessionId: string, log?: ChatLogger): void {
  databaseOperation(() => {
    const current = db.get<{ last_compaction_id: string | null }>(
      'SELECT last_compaction_id FROM chat_v2_sessions WHERE id = ?1', [sessionId]);
    const id = current?.last_compaction_id ?? null;
    if (id !== null) setCompactionSummaryActiveMetadata(db, id, false, log);
    db.run('UPDATE chat_v2_sessions SET last_compaction_id = NULL, updated_at = ?1 WHERE id = ?2',
      [toRfc3339(), sessionId]);
  });
}

/** `invalidate_compaction_for_message_with_conn` (repo.rs:8428-8460). */
export function invalidateCompactionForMessage(db: SqlExecutor, sessionId: string, messageId: string, log?: ChatLogger): boolean {
  return databaseOperation(() => {
    const record = getActiveCompaction(db, sessionId, log);
    if (!record) return false;
    if (messageId === record.summaryMessageId) {
      clearSessionLastCompaction(db, sessionId, log);
      return true;
    }
    const messages = db.all<{ id: string }>(
      'SELECT id FROM chat_v2_messages WHERE session_id = ?1 ORDER BY timestamp ASC, rowid ASC',
      [sessionId]).map(row => row.id);
    const target = messages.indexOf(messageId);
    const tailId = historyBoundaryId(record);
    const tail = messages.indexOf(tailId);
    const affected = target >= 0 && tail >= 0 ? target <= tail : tail < 0;
    if (affected) {
      clearSessionLastCompaction(db, sessionId, log);
      log?.info(`[chat_v2::repo] invalidated compaction ${record.id} after message ${messageId} changed in session ${sessionId}`);
    }
    return affected;
  });
}

/** `create_compaction_with_conn` (repo.rs:8334-8376): insert only, never updates the tail cutoff. */
export function createCompaction(db: SqlExecutor, record: CompactionRecord): void {
  databaseOperation(() => db.run(`INSERT INTO chat_v2_compactions (
      id, session_id, summary_message_id, tail_start_message_id,
      tail_start_time_created, reason, is_auto, is_overflow,
      tokens_before, tokens_after, model_id, model_config_id,
      previous_compaction_id, range_start_message_id, range_end_message_id,
      compacted_message_count, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
  [
    record.id, record.sessionId, record.summaryMessageId, record.tailStartMessageId,
    record.tailStartTimeCreated, record.reason, record.isAuto ? 1 : 0, record.isOverflow ? 1 : 0,
    record.tokensBefore, record.tokensAfter, record.modelId, record.modelConfigId,
    record.previousCompactionId, record.rangeStartMessageId, record.rangeEndMessageId,
    record.compactedMessageCount, record.createdAt,
    toRfc3339(),
  ]));
}

/** `set_session_last_compaction_with_conn` (repo.rs:8378-8405). */
export function setSessionLastCompaction(db: SqlExecutor, sessionId: string, compactionId: string, log?: ChatLogger): void {
  databaseOperation(() => {
    const row = db.get<{ last_compaction_id: string | null }>(
      'SELECT last_compaction_id FROM chat_v2_sessions WHERE id = ?1', [sessionId]);
    const current = row?.last_compaction_id ?? null;
    if (current !== null && current !== compactionId) {
      setCompactionSummaryActiveMetadata(db, current, false, log);
    }
    setCompactionSummaryActiveMetadata(db, compactionId, true, log);
    db.run('UPDATE chat_v2_sessions SET last_compaction_id = ?1, updated_at = ?2 WHERE id = ?3',
      [compactionId, toRfc3339(), sessionId]);
  });
}

/** `list_compactions_with_conn` (repo.rs:8553-8575): created_at ASC, excludes deleted rows. */
export function listCompactions(db: SqlExecutor, sessionId: string): CompactionRecord[] {
  return databaseOperation(() => db.all<CompactionRow>(`SELECT ${COMPACTION_COLUMNS}
    FROM chat_v2_compactions
    WHERE session_id = ?1 AND deleted_at IS NULL
    ORDER BY created_at ASC`, [sessionId]).map(rowToCompaction));
}
