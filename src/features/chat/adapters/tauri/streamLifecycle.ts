/**
 * Stream reconnect / expectation / stale-event decision helpers.
 *
 * Pure functions + constants only — mutable maps and timers stay on the adapter.
 */

import type { SessionEventPayload } from '../types';

/** Quiet window before success cleanup so block-channel tails can flush. */
export const STREAM_COMPLETE_SETTLE_DELAY_MS = 32;

/** Backend abort IPC race timeout (ms). */
export const ABORT_TIMEOUT_MS = 10_000;

/** Default max shown when stream_reconnect omits retryMax. */
export const DEFAULT_STREAM_RECONNECT_MAX = 5;

export interface StreamExpectation {
  messageId: string;
  startedAt: number;
  streamGeneration: number | null;
}

export interface StreamReconnectMeta {
  retryAttempt: number;
  retryMax: number;
}

/** Build inline reconnect progress stored on the assistant message meta. */
export function buildStreamReconnectMeta(payload: {
  retryAttempt?: number;
  retryMax?: number;
}): StreamReconnectMeta {
  return {
    retryAttempt: payload.retryAttempt ?? 1,
    retryMax: payload.retryMax ?? DEFAULT_STREAM_RECONNECT_MAX,
  };
}

/** Meta patch that clears reconnect progress (and optionally terminalError). */
export function clearStreamReconnectMetaPatch(options?: {
  clearTerminalError?: boolean;
}): { streamReconnect: undefined; terminalError?: undefined } {
  if (options?.clearTerminalError) {
    return { terminalError: undefined, streamReconnect: undefined };
  }
  return { streamReconnect: undefined };
}

export function streamErrorMetaPatch(terminalError: string): {
  terminalError: string;
  streamReconnect: undefined;
} {
  return {
    terminalError,
    streamReconnect: undefined,
  };
}

export function createStreamExpectation(
  messageId: string,
  startedAt: number = Date.now(),
  streamGeneration: number | null = null,
): StreamExpectation {
  return { messageId, startedAt, streamGeneration };
}

export function withStreamExpectationMessageId(
  expectation: StreamExpectation | null,
  messageId: string,
): StreamExpectation {
  if (!expectation) {
    return createStreamExpectation(messageId);
  }
  return {
    ...expectation,
    messageId,
    streamGeneration:
      expectation.messageId === messageId ? expectation.streamGeneration : null,
  };
}

export function syncStreamExpectationState(
  expectation: StreamExpectation | null,
  messageId: string,
  timestamp?: number,
  streamGeneration?: number,
): StreamExpectation {
  if (!expectation || expectation.messageId !== messageId) {
    return {
      messageId,
      startedAt: timestamp ?? Date.now(),
      streamGeneration: streamGeneration ?? null,
    };
  }
  return {
    ...expectation,
    ...(typeof timestamp === 'number'
      && Number.isFinite(timestamp)
      && timestamp > expectation.startedAt
      ? { startedAt: timestamp }
      : {}),
    ...(streamGeneration !== undefined ? { streamGeneration } : {}),
  };
}

export function shouldClearStreamExpectation(
  expectation: StreamExpectation | null,
  messageId?: string,
): boolean {
  if (!expectation) return false;
  return !messageId || expectation.messageId === messageId;
}

export function isStaleByExpectationTimestamp(
  expectation: StreamExpectation | null,
  payload: Pick<SessionEventPayload, 'messageId' | 'timestamp'>,
): boolean {
  if (!payload.messageId || !expectation) return false;
  if (expectation.messageId !== payload.messageId) return false;
  if (typeof payload.timestamp !== 'number' || !Number.isFinite(payload.timestamp)) {
    return false;
  }
  return payload.timestamp < expectation.startedAt - 500;
}

export function isStaleByStreamGeneration(
  expectation: StreamExpectation | null,
  lastStreamGenerationByMessageId: ReadonlyMap<string, number>,
  payload: Pick<SessionEventPayload, 'messageId' | 'streamGeneration' | 'eventType'>,
): boolean {
  if (!payload.messageId || payload.streamGeneration === undefined) return false;
  const lastAcceptedGeneration = lastStreamGenerationByMessageId.get(payload.messageId);

  if (payload.eventType === 'stream_start') {
    if (
      expectation?.messageId === payload.messageId
      && expectation.streamGeneration === null
      && lastAcceptedGeneration !== undefined
    ) {
      return payload.streamGeneration <= lastAcceptedGeneration;
    }
    return lastAcceptedGeneration !== undefined
      && payload.streamGeneration < lastAcceptedGeneration;
  }

  if (!expectation || expectation.messageId !== payload.messageId) {
    return lastAcceptedGeneration !== undefined
      && payload.streamGeneration <= lastAcceptedGeneration;
  }

  // A frontend retry expectation is created before the backend start event
  // returns its new generation. Any generation-bearing terminal that arrives
  // in this window belongs to the previous run.
  if (expectation.streamGeneration === null) return true;
  return payload.streamGeneration !== expectation.streamGeneration;
}

export function isTargetingCurrentStreamMessage(
  messageId: string | undefined,
  currentStreamingMessageId: string | null | undefined,
  expectedMessageId: string | null | undefined,
): boolean {
  if (!messageId) return false;
  return messageId === currentStreamingMessageId || messageId === expectedMessageId;
}

export interface RetryReboundMessageLike {
  role?: string;
  blockIds?: string[] | null;
}

export interface RetryReboundLockLike {
  operation?: string;
  messageId?: string;
}

/**
 * Whether a conflicting stream_start may rebind onto a cleared retry placeholder.
 */
export function canAdoptRetryReboundStreamStart(
  incomingMessageId: string,
  currentStreamingMessageId: string | null,
  expectedMessageId: string | null,
  lock: RetryReboundLockLike | null | undefined,
  currentMsg: RetryReboundMessageLike | undefined,
): boolean {
  if (!incomingMessageId) return false;
  if (!currentStreamingMessageId || !expectedMessageId) return false;
  if (currentStreamingMessageId !== expectedMessageId) return false;
  if (incomingMessageId === currentStreamingMessageId) return false;

  if (!lock || lock.operation !== 'retry' || lock.messageId !== currentStreamingMessageId) {
    return false;
  }

  if (!currentMsg || currentMsg.role !== 'assistant') {
    return false;
  }
  return (currentMsg.blockIds?.length ?? 0) === 0;
}

/**
 * Whether a session stream event should be ignored as stale / mistargeted
 * (shared guard for reconnect / complete / error / cancelled).
 */
export function shouldIgnoreStreamLifecycleEvent(
  payload: Pick<
    SessionEventPayload,
    'messageId' | 'timestamp' | 'streamGeneration' | 'eventType'
  >,
  options: {
    currentStreamingMessageId: string | null | undefined;
    expectation: StreamExpectation | null;
    lastStreamGenerationByMessageId: ReadonlyMap<string, number>;
  },
): boolean {
  const expectedMessageId = options.expectation?.messageId ?? null;
  return (
    !payload.messageId
    || !isTargetingCurrentStreamMessage(
      payload.messageId,
      options.currentStreamingMessageId,
      expectedMessageId,
    )
    || isStaleByStreamGeneration(
      options.expectation,
      options.lastStreamGenerationByMessageId,
      payload,
    )
    || isStaleByExpectationTimestamp(options.expectation, payload)
  );
}
