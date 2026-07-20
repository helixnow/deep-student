import { describe, expect, it } from 'vitest';
import {
  buildStreamReconnectMeta,
  canAdoptRetryReboundStreamStart,
  clearStreamReconnectMetaPatch,
  createStreamExpectation,
  isStaleByExpectationTimestamp,
  isStaleByStreamGeneration,
  isTargetingCurrentStreamMessage,
  shouldIgnoreStreamLifecycleEvent,
  streamErrorMetaPatch,
  syncStreamExpectationState,
  withStreamExpectationMessageId,
} from '../tauri/streamLifecycle';
import {
  blockEventChannel,
  matchesLlmRequestBodySession,
  sessionEventChannel,
} from '../tauri/sessionEvents';
import { normalizeStreamTerminalError } from '../tauri/errors';
import { isRetryableTerminalAnkiBlock, getCanvasNoteIdFromModeState } from '../tauri/requestHelpers';

describe('tauri/streamLifecycle pure decisions', () => {
  it('builds and clears reconnect meta patches', () => {
    expect(buildStreamReconnectMeta({ retryAttempt: 2 })).toEqual({
      retryAttempt: 2,
      retryMax: 5,
    });
    expect(clearStreamReconnectMetaPatch()).toEqual({ streamReconnect: undefined });
    expect(clearStreamReconnectMetaPatch({ clearTerminalError: true })).toEqual({
      terminalError: undefined,
      streamReconnect: undefined,
    });
    expect(streamErrorMetaPatch('boom')).toEqual({
      terminalError: 'boom',
      streamReconnect: undefined,
    });
  });

  it('targets current or expected streaming message ids', () => {
    expect(isTargetingCurrentStreamMessage('a', 'a', null)).toBe(true);
    expect(isTargetingCurrentStreamMessage('b', 'a', 'b')).toBe(true);
    expect(isTargetingCurrentStreamMessage('c', 'a', 'b')).toBe(false);
    expect(isTargetingCurrentStreamMessage(undefined, 'a', 'a')).toBe(false);
  });

  it('detects stale terminals by expectation timestamp and generation', () => {
    const expectation = createStreamExpectation('msg', 1_000, 2);
    expect(
      isStaleByExpectationTimestamp(expectation, { messageId: 'msg', timestamp: 400 }),
    ).toBe(true);
    expect(
      isStaleByExpectationTimestamp(expectation, { messageId: 'msg', timestamp: 900 }),
    ).toBe(false);

    const gens = new Map([['msg', 2]]);
    expect(
      isStaleByStreamGeneration(expectation, gens, {
        messageId: 'msg',
        eventType: 'stream_complete',
        streamGeneration: 1,
      }),
    ).toBe(true);
    expect(
      isStaleByStreamGeneration(expectation, gens, {
        messageId: 'msg',
        eventType: 'stream_complete',
        streamGeneration: 2,
      }),
    ).toBe(false);

    // Retry window: expectation exists but generation not yet bound → any gen-bearing terminal is stale.
    const unbound = createStreamExpectation('msg', 1_000, null);
    expect(
      isStaleByStreamGeneration(unbound, gens, {
        messageId: 'msg',
        eventType: 'stream_error',
        streamGeneration: 3,
      }),
    ).toBe(true);
  });

  it('syncs expectation message id / generation without leaking across ids', () => {
    const base = createStreamExpectation('old', 10, 1);
    expect(withStreamExpectationMessageId(base, 'new')).toEqual({
      messageId: 'new',
      startedAt: 10,
      streamGeneration: null,
    });
    expect(syncStreamExpectationState(base, 'old', 50, 3)).toEqual({
      messageId: 'old',
      startedAt: 50,
      streamGeneration: 3,
    });
  });

  it('only adopts retry rebound when the current assistant placeholder is empty', () => {
    expect(
      canAdoptRetryReboundStreamStart(
        'msg_new',
        'msg_old',
        'msg_old',
        { operation: 'retry', messageId: 'msg_old' },
        { role: 'assistant', blockIds: [] },
      ),
    ).toBe(true);
    expect(
      canAdoptRetryReboundStreamStart(
        'msg_new',
        'msg_old',
        'msg_old',
        { operation: 'retry', messageId: 'msg_old' },
        { role: 'assistant', blockIds: ['blk'] },
      ),
    ).toBe(false);
  });

  it('shouldIgnoreStreamLifecycleEvent composes targeting + stale guards', () => {
    const expectation = createStreamExpectation('msg', 1_000, 1);
    const gens = new Map([['msg', 1]]);
    expect(
      shouldIgnoreStreamLifecycleEvent(
        { messageId: 'msg', eventType: 'stream_reconnect', streamGeneration: 1, timestamp: 1_100 },
        {
          currentStreamingMessageId: 'msg',
          expectation,
          lastStreamGenerationByMessageId: gens,
        },
      ),
    ).toBe(false);
    expect(
      shouldIgnoreStreamLifecycleEvent(
        { messageId: 'other', eventType: 'stream_reconnect', timestamp: 1_100 },
        {
          currentStreamingMessageId: 'msg',
          expectation,
          lastStreamGenerationByMessageId: gens,
        },
      ),
    ).toBe(true);
  });
});

describe('tauri/sessionEvents + errors + requestHelpers', () => {
  it('matches llm request body channels for the session and variants', () => {
    expect(blockEventChannel('s1')).toBe('chat_v2_event_s1');
    expect(sessionEventChannel('s1')).toBe('chat_v2_session_s1');
    expect(matchesLlmRequestBodySession('chat_v2_event_s1', 's1')).toBe(true);
    expect(matchesLlmRequestBodySession('chat_v2_event_s1_var_0', 's1')).toBe(true);
    expect(matchesLlmRequestBodySession('chat_v2_event_other', 's1')).toBe(false);
  });

  it('normalizes stream terminal errors with a stable fallback', () => {
    const normalized = normalizeStreamTerminalError('upstream blew up');
    expect(typeof normalized).toBe('string');
    expect(normalized.length).toBeGreaterThan(0);
    expect(normalizeStreamTerminalError(undefined)).toMatch(/Load failed|加载失败/i);
  });

  it('classifies retryable Anki terminal blocks and canvas note ids', () => {
    expect(
      isRetryableTerminalAnkiBlock('error', { finalStatus: 'ok' }),
    ).toBe(true);
    expect(
      isRetryableTerminalAnkiBlock('done', { finalStatus: 'completed_with_errors' }),
    ).toBe(true);
    expect(getCanvasNoteIdFromModeState({ canvasNoteId: 'note_1' })).toBe('note_1');
    expect(getCanvasNoteIdFromModeState({ canvasNoteId: '' })).toBeUndefined();
  });
});
