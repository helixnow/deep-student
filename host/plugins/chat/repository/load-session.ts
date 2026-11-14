/**
 * Full-session load. Rust source: `chat_v2/repo.rs:2404-2483`.
 */
import type { LoadSessionResponse, MessageBlock } from '../api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { ChatV2Error } from '../src/error.ts';
import { errorText, type ChatLogger } from '../src/logger.ts';
import { databaseOperation } from './errors.ts';
import { getSession } from './sessions.ts';
import { getSessionMessages, rowToMessage, MESSAGE_COLUMNS } from './messages.ts';
import { getSessionBlocks, rowToBlock, toWireBlock, BLOCK_COLUMNS_QUALIFIED, type BlockRow } from './blocks.ts';
import { loadSessionState } from './session-state.ts';

export function loadSessionFull(db: SqlExecutor, sessionId: string, log?: ChatLogger): LoadSessionResponse {
  return databaseOperation(() => {
    const started = performance.now();
    const elapsed = () => Math.floor(performance.now() - started);
    log?.debug(`[ChatV2::Repo] Loading full session: ${sessionId}`);
    const session = getSession(db, sessionId);
    if (!session) throw new ChatV2Error('SessionNotFound', sessionId);
    const sessionTime = elapsed();
    log?.debug(`[ChatV2::Repo] load_session_full_with_conn session fetched: ${sessionTime} ms`);
    const messages = getSessionMessages(db, sessionId, log);
    const messagesTime = elapsed();
    log?.debug(`[ChatV2::Repo] load_session_full_with_conn messages fetched: ${messagesTime} ms (delta ${messagesTime - sessionTime} ms, count ${messages.length})`);
    const blocks: MessageBlock[] = getSessionBlocks(db, sessionId, log).map(toWireBlock);
    const blocksTime = elapsed();
    log?.debug(`[ChatV2::Repo] load_session_full_with_conn blocks fetched: ${blocksTime} ms (delta ${blocksTime - messagesTime} ms, count ${blocks.length})`);
    const state = loadSessionState(db, sessionId);
    const stateTime = elapsed();
    log?.debug(`[ChatV2::Repo] load_session_full_with_conn state fetched: ${stateTime} ms (delta ${stateTime - blocksTime} ms, has_state=${state !== null})`);
    log?.info(`[ChatV2::Repo] Loaded full session: ${sessionId} with ${messages.length} messages and ${blocks.length} blocks (optimized batch query), total ${elapsed()} ms`);
    const response: LoadSessionResponse = { session, messages, blocks };
    if (state) response.state = state;
    return response;
  });
}

export const LOAD_SESSION_TAIL_BYTE_BUDGET = 2 * 1024 * 1024;
export const LOAD_SESSION_TAIL_MIN_MESSAGES = 2;

/** `tail_window_len_within_budget` (repo.rs:2526-2548). */
function tailWindowLength(db: SqlExecutor, sessionId: string, tailLimit: number, byteBudget: number): number {
  const rows = db.all<{ size: number }>(`SELECT
      COALESCE(LENGTH(m.meta_json), 0) + COALESCE(LENGTH(m.variants_json), 0)
      + COALESCE(LENGTH(m.attachments_json), 0) + COALESCE(LENGTH(m.shared_context_json), 0)
      + COALESCE((SELECT SUM(COALESCE(LENGTH(b.content), 0) + COALESCE(LENGTH(b.tool_input_json), 0)
          + COALESCE(LENGTH(b.tool_output_json), 0) + COALESCE(LENGTH(b.citations_json), 0))
        FROM chat_v2_blocks b WHERE b.message_id = m.id), 0) AS size
    FROM chat_v2_messages m WHERE m.session_id = ?1
    ORDER BY m.timestamp DESC, m.rowid DESC LIMIT ?2`, [sessionId, tailLimit]);
  let taken = 0;
  let used = 0;
  for (const row of rows) {
    const size = Math.max(0, row.size);
    if (taken >= LOAD_SESSION_TAIL_MIN_MESSAGES && used + size > byteBudget) break;
    used += size;
    taken += 1;
  }
  return taken;
}

/** `load_session_tail_with_conn` (repo.rs:2485-2647). */
export function loadSessionTail(db: SqlExecutor, sessionId: string, tailLimit: number, log?: ChatLogger): LoadSessionResponse {
  return loadSessionTailWithBudget(db, sessionId, tailLimit, LOAD_SESSION_TAIL_BYTE_BUDGET, log);
}

/** repo.rs:2550: production tail loader also uses this injectable-budget path. */
export function loadSessionTailWithBudget(
  db: SqlExecutor, sessionId: string, tailLimit: number, byteBudget: number, log?: ChatLogger,
): LoadSessionResponse {
  return databaseOperation(() => {
    const started = performance.now();
    const session = getSession(db, sessionId);
    if (!session) throw new ChatV2Error('SessionNotFound', sessionId);
    const total = db.pluck<number>('SELECT COUNT(*) FROM chat_v2_messages WHERE session_id = ?1', [sessionId])!;
    const window = tailWindowLength(db, sessionId, tailLimit, byteBudget);
    if (total <= window) return loadSessionFull(db, sessionId, log);

    const messageRows = db.all<Parameters<typeof rowToMessage>[0]>(`SELECT ${MESSAGE_COLUMNS}
      FROM chat_v2_messages WHERE session_id = ?1
      ORDER BY timestamp DESC, rowid DESC LIMIT ?2`, [sessionId, window]);
    const messages = messageRows.flatMap(row => {
      try { return [rowToMessage(row)]; } catch (error) {
        log?.warn('[ChatV2Repo] Skipping malformed row: ' + errorText(error));
        return [];
      }
    }).reverse();

    const blockRows = db.all<BlockRow>(`SELECT ${BLOCK_COLUMNS_QUALIFIED} FROM chat_v2_blocks b
      INNER JOIN (SELECT id, timestamp, rowid AS message_rowid FROM chat_v2_messages
        WHERE session_id = ?1 ORDER BY timestamp DESC, rowid DESC LIMIT ?2) m
      ON b.message_id = m.id
      ORDER BY m.timestamp ASC, COALESCE(b.first_chunk_at, b.started_at) ASC, b.block_index ASC`,
    [sessionId, window]);
    const blocks: MessageBlock[] = blockRows.flatMap(row => {
      try { return [toWireBlock(rowToBlock(row))]; } catch (error) {
        log?.warn('[ChatV2Repo] Skipping malformed row: ' + errorText(error));
        return [];
      }
    });
    const state = loadSessionState(db, sessionId);
    const response: LoadSessionResponse = { session, messages, blocks, totalMessageCount: total };
    if (state) response.state = state;
    log?.info(`[ChatV2::Repo] Loaded session tail: ${sessionId} with ${messages.length}/${total} messages and ${blocks.length} blocks, total ${Math.floor(performance.now() - started)} ms`);
    return response;
  });
}
