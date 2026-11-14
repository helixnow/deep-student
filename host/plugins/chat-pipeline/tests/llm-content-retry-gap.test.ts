/**
 * chat_v2/pipeline/llm_content_retry_gap_tests.rs — retry-path llm_content
 * sidecar gaps. Like the Rust module, this is a test-only simulation of the DB
 * row and the retry pipeline context; no real repo/DB is involved.
 */
import { describe, expect, it } from 'vitest';

interface BlockRow {
  content: string;
  llmContent: string | null;
}

interface SessionState {
  precedingUserId: string;
  precedingRow: BlockRow;
}

interface RetryTurn {
  ctxUserId: string;
  ctxAssistantId: string;
  liveUserLlmContent: string;
}

/**
 * Common lookup semantics: sidecar writes locate the existing content block by
 * `ctx.user_message_id`; a missing row silently skips the write.
 */
function persistSidecarByCtxUserId(session: SessionState, ctxUserId: string,
  liveWrapped: string): boolean {
  if (session.precedingUserId === ctxUserId) {
    session.precedingRow.llmContent = liveWrapped;
    return true;
  }
  return false;
}

/** context.rs `live_user_llm_content()`: empty compiled content is not writable. */
function liveUserLlmContent(compiledContent: string): string | null {
  return compiledContent === '' ? null : compiledContent;
}

/** history.rs replay override: non-empty sidecar wins, else bare content. */
function replayUserContent(row: BlockRow): string {
  return row.llmContent !== null && row.llmContent !== '' ? row.llmContent : row.content;
}

/**
 * Retry live request assembly: history minus `{ctx.user_message_id,
 * ctx.assistant_message_id}`, then the freshly compiled user message.
 */
function assembleLiveRequest(session: SessionState, turn: RetryTurn): string[] {
  const userMessages: string[] = [];
  const excluded = session.precedingUserId === turn.ctxUserId
    || session.precedingUserId === turn.ctxAssistantId;
  if (!excluded) userMessages.push(replayUserContent(session.precedingRow));
  userMessages.push(turn.liveUserLlmContent);
  return userMessages;
}

const BARE = '帮我总结这份周报';
const ORIGINAL_WRAPPED = '<user_query>\n帮我总结这份周报\n</user_query>\n\n'
  + '<injected_context>\n<runtime_facts>\n当前日期: 2026-08-20\n</runtime_facts>\n'
  + '</injected_context>';
const RETRY_WRAPPED = '<user_query>\n帮我总结这份周报\n</user_query>\n\n'
  + '<injected_context>\n<runtime_facts>\n当前日期: 2026-08-26\n</runtime_facts>\n'
  + '</injected_context>';

const PRECEDING_USER_ID = 'msg_user_orig';
const RETRIED_ASSISTANT_ID = 'msg_assistant_retried';
const FRESH_CTX_USER_ID = 'msg_fresh_uuid_from_pipeline_context_new';

function sessionAfterNormalOriginalTurn(): SessionState {
  return {
    precedingUserId: PRECEDING_USER_ID,
    precedingRow: { content: BARE, llmContent: ORIGINAL_WRAPPED },
  };
}

function currentBehaviorRetryTurn(): RetryTurn {
  return {
    ctxUserId: FRESH_CTX_USER_ID,
    ctxAssistantId: RETRIED_ASSISTANT_ID,
    liveUserLlmContent: RETRY_WRAPPED,
  };
}

describe('chat_v2/pipeline/llm_content_retry_gap_tests.rs', () => {
  it('retry_fresh_user_message_id_skips_early_and_save_point_sidecar_writes', () => {
    const session = sessionAfterNormalOriginalTurn();
    const turn = currentBehaviorRetryTurn();

    expect(persistSidecarByCtxUserId(session, turn.ctxUserId, turn.liveUserLlmContent)).toBe(false);
    expect(persistSidecarByCtxUserId(session, turn.ctxUserId, turn.liveUserLlmContent)).toBe(false);
    expect(session.precedingRow.llmContent).toBe(ORIGINAL_WRAPPED);
  });

  it('retry_leaves_stale_sidecar_next_turn_drifts_from_retry_live_bytes', () => {
    const session = sessionAfterNormalOriginalTurn();
    const turn = currentBehaviorRetryTurn();
    persistSidecarByCtxUserId(session, turn.ctxUserId, turn.liveUserLlmContent);

    const replayed = replayUserContent(session.precedingRow);
    expect(replayed).toBe(ORIGINAL_WRAPPED);
    expect(replayed).not.toBe(turn.liveUserLlmContent);
    expect(replayed).toContain('2026-08-20');
    expect(replayed).not.toContain('2026-08-26');
  });

  it('retry_after_crash_window_null_sidecar_misses_backfill', () => {
    const session: SessionState = {
      precedingUserId: PRECEDING_USER_ID,
      precedingRow: { content: BARE, llmContent: null },
    };
    const turn = currentBehaviorRetryTurn();

    expect(persistSidecarByCtxUserId(session, turn.ctxUserId, turn.liveUserLlmContent)).toBe(false);
    expect(session.precedingRow.llmContent).toBeNull();

    const replayed = replayUserContent(session.precedingRow);
    expect(replayed).toBe(BARE);
    expect(replayed).not.toBe(turn.liveUserLlmContent);
  });

  it('retry_live_request_double_includes_preceding_user_message', () => {
    const session = sessionAfterNormalOriginalTurn();
    const turn = currentBehaviorRetryTurn();

    const userMessages = assembleLiveRequest(session, turn);
    expect(userMessages).toHaveLength(2);
    const bareOccurrences = userMessages.filter(message => message.includes(BARE)).length;
    expect(bareOccurrences).toBe(2);
    expect(userMessages[0]).toBe(ORIGINAL_WRAPPED);
    expect(userMessages[1]).toBe(RETRY_WRAPPED);
    expect(userMessages[0]).not.toBe(userMessages[1]);
  });

  it('retry_reusing_preceding_user_id_closes_sidecar_gaps', () => {
    const session = sessionAfterNormalOriginalTurn();
    const turn: RetryTurn = {
      ctxUserId: PRECEDING_USER_ID,
      ctxAssistantId: RETRIED_ASSISTANT_ID,
      liveUserLlmContent: RETRY_WRAPPED,
    };

    expect(assembleLiveRequest(session, turn)).toEqual([RETRY_WRAPPED]);

    expect(persistSidecarByCtxUserId(session, turn.ctxUserId, turn.liveUserLlmContent)).toBe(true);
    expect(session.precedingRow.llmContent).toBe(RETRY_WRAPPED);
    expect(replayUserContent(session.precedingRow)).toBe(turn.liveUserLlmContent);
  });

  it('retry_reusing_preceding_user_id_backfills_null_sidecar', () => {
    const session: SessionState = {
      precedingUserId: PRECEDING_USER_ID,
      precedingRow: { content: BARE, llmContent: null },
    };

    expect(persistSidecarByCtxUserId(session, PRECEDING_USER_ID, RETRY_WRAPPED)).toBe(true);
    expect(replayUserContent(session.precedingRow)).toBe(RETRY_WRAPPED);
  });

  it('empty_live_content_never_persists_and_empty_sidecar_falls_back_bare', () => {
    expect(liveUserLlmContent('')).toBeNull();
    expect(liveUserLlmContent(RETRY_WRAPPED)).toBe(RETRY_WRAPPED);
    expect(replayUserContent({ content: BARE, llmContent: '' })).toBe(BARE);
  });
});
