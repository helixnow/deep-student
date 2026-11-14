/**
 * Chat V2 event wire contract. Rust source: `src-tauri/crates/dstu-agent/src/chat_v2/events.rs`.
 *
 * Two channels:
 * - block events: `chat_v2_event_{sessionId}`
 * - session events: `chat_v2_session_{sessionId}`
 *
 * `BackendEvent` is camelCase on the wire; every optional field with
 * `skip_serializing_if = "Option::is_none"` stays `undefined` here so
 * `JSON.stringify` omits it exactly like serde.
 */
import type { GoalRecord, TokenUsage } from '../api.ts';
import { symbols } from '@deepseek-ai/cordis';
import { utf8ByteLength } from '../../../platform/util/index.ts';

export const EVENT_PHASE = {
  START: 'start',
  CHUNK: 'chunk',
  END: 'end',
  ERROR: 'error',
} as const;

export const EVENT_TYPE = {
  THINKING: 'thinking',
  CONTENT: 'content',
  TOOL_CALL: 'tool_call',
  TOOL_CALL_PREPARING: 'tool_call_preparing',
  IMAGE_GEN: 'image_gen',
  RAG: 'rag',
  MEMORY: 'memory',
  WEB_SEARCH: 'web_search',
  MULTIMODAL_RAG: 'multimodal_rag',
  INSIGHT_RECALL: 'insight_recall',
  ANKI_CARDS: 'anki_cards',
  QBANK_QUESTIONS: 'qbank_questions',
  GENERATIVE_UI: 'generative_ui',
  VARIANT_START: 'variant_start',
  VARIANT_END: 'variant_end',
  TOOL_APPROVAL_REQUEST: 'tool_approval_request',
  TOOL_APPROVAL_RESPONSE: 'tool_approval_response',
  PLAN_GATE: 'plan_gate',
  TOOL_LIMIT: 'tool_limit',
  SKILL_INJECTION_AUDIT: 'skill_injection_audit',
  WORKSPACE_INJECTION: 'workspace_injection',
} as const;

export const SESSION_EVENT_TYPE = {
  STREAM_START: 'stream_start',
  STREAM_RECONNECT: 'stream_reconnect',
  STREAM_COMPLETE: 'stream_complete',
  STREAM_ERROR: 'stream_error',
  STREAM_CANCELLED: 'stream_cancelled',
  SAVE_COMPLETE: 'save_complete',
  SAVE_ERROR: 'save_error',
  VARIANT_DELETED: 'variant_deleted',
  SUMMARY_UPDATED: 'summary_updated',
  COMPACTION_STARTED: 'compaction_started',
  COMPACTION_FINISHED: 'compaction_finished',
  COMPACTION_FAILED: 'compaction_failed',
  COMPACTION_COMPLETED: 'compaction_completed',
  CONTEXT_TRIMMED: 'context_trimmed',
  GOAL_UPDATED: 'goal_updated',
} as const;

/** Block-level event payload (`events.rs::BackendEvent`). */
export interface BackendEvent {
  sequenceId: number;
  sessionId?: string;
  type: string;
  phase: string;
  messageId?: string;
  blockId?: string;
  blockType?: string;
  chunk?: string;
  result?: unknown;
  error?: string;
  payload?: unknown;
  skillStateVersion?: number;
  roundId?: string;
  variantId?: string;
  modelId?: string;
  status?: string;
  usage?: TokenUsage;
}

function optional(value: string | null | undefined): string | undefined {
  return value === null ? undefined : value;
}

function optionalUsage(value: TokenUsage | null | undefined): TokenUsage | undefined {
  return value === null ? undefined : value;
}

export function backendEventStart(
  sequenceId: number,
  eventType: string,
  messageId: string,
  blockId: string | null | undefined,
  payload: unknown,
  variantId: string | null | undefined,
): BackendEvent {
  return {
    sequenceId,
    sessionId: undefined,
    type: eventType,
    phase: EVENT_PHASE.START,
    messageId,
    blockId: optional(blockId),
    blockType: undefined,
    chunk: undefined,
    result: undefined,
    error: undefined,
    payload: payload ?? undefined,
    skillStateVersion: undefined,
    roundId: undefined,
    variantId: optional(variantId),
    modelId: undefined,
    status: undefined,
    usage: undefined,
  };
}

export function backendEventChunk(
  sequenceId: number,
  eventType: string,
  blockId: string,
  chunk: string,
  variantId: string | null | undefined,
): BackendEvent {
  return {
    sequenceId,
    sessionId: undefined,
    type: eventType,
    phase: EVENT_PHASE.CHUNK,
    messageId: undefined,
    blockId,
    blockType: undefined,
    chunk,
    result: undefined,
    error: undefined,
    payload: undefined,
    skillStateVersion: undefined,
    roundId: undefined,
    variantId: optional(variantId),
    modelId: undefined,
    status: undefined,
    usage: undefined,
  };
}

export function backendEventEnd(
  sequenceId: number,
  eventType: string,
  blockId: string,
  result: unknown,
  variantId: string | null | undefined,
): BackendEvent {
  return {
    sequenceId,
    sessionId: undefined,
    type: eventType,
    phase: EVENT_PHASE.END,
    messageId: undefined,
    blockId,
    blockType: undefined,
    chunk: undefined,
    result: result ?? undefined,
    error: undefined,
    payload: undefined,
    skillStateVersion: undefined,
    roundId: undefined,
    variantId: optional(variantId),
    modelId: undefined,
    status: undefined,
    usage: undefined,
  };
}

export function backendEventError(
  sequenceId: number,
  eventType: string,
  blockId: string,
  error: string,
  variantId: string | null | undefined,
): BackendEvent {
  return {
    sequenceId,
    sessionId: undefined,
    type: eventType,
    phase: EVENT_PHASE.ERROR,
    messageId: undefined,
    blockId,
    blockType: undefined,
    chunk: undefined,
    result: undefined,
    error,
    payload: undefined,
    skillStateVersion: undefined,
    roundId: undefined,
    variantId: optional(variantId),
    modelId: undefined,
    status: undefined,
    usage: undefined,
  };
}

export function backendEventVariantStart(
  sequenceId: number,
  messageId: string,
  variantId: string,
  modelId: string,
): BackendEvent {
  return {
    sequenceId,
    sessionId: undefined,
    type: EVENT_TYPE.VARIANT_START,
    phase: EVENT_PHASE.START,
    messageId,
    blockId: undefined,
    blockType: undefined,
    chunk: undefined,
    result: undefined,
    error: undefined,
    payload: undefined,
    skillStateVersion: undefined,
    roundId: undefined,
    variantId,
    modelId,
    status: undefined,
    usage: undefined,
  };
}

export function backendEventVariantEnd(
  sequenceId: number,
  variantId: string,
  status: string,
  error: string | null | undefined,
  usage: TokenUsage | null | undefined,
): BackendEvent {
  return {
    sequenceId,
    sessionId: undefined,
    type: EVENT_TYPE.VARIANT_END,
    phase: EVENT_PHASE.END,
    messageId: undefined,
    blockId: undefined,
    blockType: undefined,
    chunk: undefined,
    result: undefined,
    error: optional(error),
    payload: undefined,
    skillStateVersion: undefined,
    roundId: undefined,
    variantId,
    modelId: undefined,
    status,
    usage: optionalUsage(usage),
  };
}

export const BackendEvent = {
  start: backendEventStart,
  chunk: backendEventChunk,
  end: backendEventEnd,
  error: backendEventError,
  variantStart: backendEventVariantStart,
  variantEnd: backendEventVariantEnd,
};

/** Session-level event payload (`events.rs::SessionEvent`). */
export interface SessionEvent {
  sequenceId?: number;
  sessionId: string;
  eventType: string;
  messageId?: string;
  streamGeneration?: number;
  skillStateVersion?: number;
  replayMode?: string;
  modelId?: string;
  retryAttempt?: number;
  retryMax?: number;
  error?: string;
  durationMs?: number;
  timestamp: number;
  usage?: TokenUsage;
  title?: string;
  description?: string;
  payload?: unknown;
}

function sessionEventBase(sessionId: string, eventType: string): SessionEvent {
  return {
    sequenceId: undefined,
    sessionId,
    eventType,
    messageId: undefined,
    streamGeneration: undefined,
    skillStateVersion: undefined,
    replayMode: undefined,
    modelId: undefined,
    retryAttempt: undefined,
    retryMax: undefined,
    error: undefined,
    durationMs: undefined,
    timestamp: Date.now(),
    usage: undefined,
    title: undefined,
    description: undefined,
    payload: undefined,
  };
}

export function sessionEventStreamStart(
  sessionId: string,
  messageId: string,
  modelId: string | null | undefined,
): SessionEvent {
  const event = sessionEventBase(sessionId, SESSION_EVENT_TYPE.STREAM_START);
  event.messageId = messageId;
  event.modelId = optional(modelId);
  return event;
}

export function sessionEventStreamReconnect(
  sessionId: string,
  messageId: string,
  retryAttempt: number,
  retryMax: number,
): SessionEvent {
  const event = sessionEventBase(sessionId, SESSION_EVENT_TYPE.STREAM_RECONNECT);
  event.messageId = messageId;
  event.retryAttempt = retryAttempt;
  event.retryMax = retryMax;
  return event;
}

export function sessionEventStreamComplete(sessionId: string, messageId: string, durationMs: number): SessionEvent {
  const event = sessionEventBase(sessionId, SESSION_EVENT_TYPE.STREAM_COMPLETE);
  event.messageId = messageId;
  event.durationMs = durationMs;
  return event;
}

export function sessionEventStreamCompleteWithUsage(
  sessionId: string,
  messageId: string,
  durationMs: number,
  usage: TokenUsage | null | undefined,
): SessionEvent {
  const event = sessionEventStreamComplete(sessionId, messageId, durationMs);
  event.usage = optionalUsage(usage);
  return event;
}

export function sessionEventStreamError(sessionId: string, messageId: string, error: string): SessionEvent {
  const event = sessionEventBase(sessionId, SESSION_EVENT_TYPE.STREAM_ERROR);
  event.messageId = messageId;
  event.error = error;
  return event;
}

export function sessionEventStreamCancelled(sessionId: string, messageId: string): SessionEvent {
  const event = sessionEventBase(sessionId, SESSION_EVENT_TYPE.STREAM_CANCELLED);
  event.messageId = messageId;
  return event;
}

export function sessionEventSaveComplete(sessionId: string): SessionEvent {
  return sessionEventBase(sessionId, SESSION_EVENT_TYPE.SAVE_COMPLETE);
}

export function sessionEventSaveError(sessionId: string, error: string): SessionEvent {
  const event = sessionEventBase(sessionId, SESSION_EVENT_TYPE.SAVE_ERROR);
  event.error = error;
  return event;
}

export function sessionEventCompactionStarted(sessionId: string, reason: string): SessionEvent {
  const event = sessionEventSaveComplete(sessionId);
  event.eventType = SESSION_EVENT_TYPE.COMPACTION_STARTED;
  event.payload = { reason };
  return event;
}

export function sessionEventCompactionFinished(sessionId: string): SessionEvent {
  const event = sessionEventBase(sessionId, SESSION_EVENT_TYPE.COMPACTION_FINISHED);
  return event;
}

export function sessionEventCompactionFailed(sessionId: string, reason: string): SessionEvent {
  const event = sessionEventBase(sessionId, SESSION_EVENT_TYPE.COMPACTION_FAILED);
  event.payload = { reason };
  return event;
}

export function sessionEventCompactionCompleted(
  sessionId: string,
  tokensBefore: number | null | undefined,
  tokensAfter: number | null | undefined,
): SessionEvent {
  const event = sessionEventBase(sessionId, SESSION_EVENT_TYPE.COMPACTION_COMPLETED);
  event.payload = {
    tokensBefore: tokensBefore ?? null,
    tokensAfter: tokensAfter ?? null,
  };
  return event;
}

export function sessionEventContextTrimmed(
  sessionId: string,
  droppedMessages: number,
  estimatedDroppedTokens: number | null | undefined,
): SessionEvent {
  const event = sessionEventBase(sessionId, SESSION_EVENT_TYPE.CONTEXT_TRIMMED);
  const payload: { droppedMessages: number; estimatedDroppedTokens?: number } = { droppedMessages };
  if (estimatedDroppedTokens !== null && estimatedDroppedTokens !== undefined) {
    payload.estimatedDroppedTokens = estimatedDroppedTokens;
  }
  event.payload = payload;
  return event;
}

export function sessionEventSummaryUpdated(sessionId: string, title: string, description: string): SessionEvent {
  const event = sessionEventBase(sessionId, SESSION_EVENT_TYPE.SUMMARY_UPDATED);
  event.title = title;
  event.description = description;
  return event;
}

export function withStreamGeneration(event: SessionEvent, streamGeneration: number | null | undefined): SessionEvent {
  event.streamGeneration = streamGeneration ?? undefined;
  return event;
}

export const SessionEvent = {
  streamStart: sessionEventStreamStart,
  streamReconnect: sessionEventStreamReconnect,
  streamComplete: sessionEventStreamComplete,
  streamCompleteWithUsage: sessionEventStreamCompleteWithUsage,
  streamError: sessionEventStreamError,
  streamCancelled: sessionEventStreamCancelled,
  saveComplete: sessionEventSaveComplete,
  saveError: sessionEventSaveError,
  compactionStarted: sessionEventCompactionStarted,
  compactionFinished: sessionEventCompactionFinished,
  compactionFailed: sessionEventCompactionFailed,
  compactionCompleted: sessionEventCompactionCompleted,
  contextTrimmed: sessionEventContextTrimmed,
  summaryUpdated: sessionEventSummaryUpdated,
  withStreamGeneration,
};

/** `build_goal_updated_payload` (events.rs:44-55). */
export function buildGoalUpdatedPayload(
  sessionId: string,
  goal: GoalRecord | null,
): { eventType: string; sessionId: string; goal: GoalRecord | null } {
  return { eventType: SESSION_EVENT_TYPE.GOAL_UPDATED, sessionId, goal };
}

// ============================================================
// Sequence counters (events.rs:806-869)
// ============================================================

interface Counter { value: number }

const sessionSequenceCounters = new Map<string, Counter>();
const sessionEventSequenceCounters = new Map<string, Counter>();

function getOrCreateCounter(map: Map<string, Counter>, sessionId: string): Counter {
  let counter = map.get(sessionId);
  if (!counter) {
    counter = { value: 0 };
    map.set(sessionId, counter);
  }
  return counter;
}

/** Block-level channel counter, independent from the session-channel counter. */
export function nextSessionSequenceId(sessionId: string): number {
  return getOrCreateCounter(sessionSequenceCounters, sessionId).value++;
}

/** Drop both counters for a session (hard delete / trash / empty recycle bin). */
export function clearSessionSequenceCounter(sessionId: string): void {
  sessionSequenceCounters.delete(sessionId);
  sessionEventSequenceCounters.delete(sessionId);
}

// ============================================================
// Sinks (events.rs:877-1000)
// ============================================================

/** Event outlet abstraction (`ExecutionEventSink`). */
export interface ExecutionEventSink {
  emitBlockEvent(channel: string, event: BackendEvent): void;
  emitSessionEvent(channel: string, event: SessionEvent): void;
  /** The window analogue: non-null enables chunk batching by default. */
  window(): unknown | null;
}

/** The subset of `ctx.backendEvents` the sink needs. */
export interface BackendEventsLike {
  emit(event: string, payload: unknown): void;
}

export interface EventLogger {
  error(message: string): void;
  debug(message: string): void;
}

let emitFailures = 0;

/** Cross-session cumulative `window.emit` failures (`emit_failure_count`). */
export function emitFailureCount(): number {
  return emitFailures;
}

function recordEmitFailure(): void {
  emitFailures += 1;
}

/** Renderer-backed sink: maps Rust `Window::emit` to `ctx.backendEvents.emit`. */
export class BackendEventsSink implements ExecutionEventSink {
  private readonly events: BackendEventsLike;
  private readonly logger: EventLogger | null;

  constructor(events: BackendEventsLike, logger: EventLogger | null = null) {
    this.events = events;
    this.logger = logger;
  }

  emitBlockEvent(channel: string, event: BackendEvent): void {
    this.deliver(channel, event, `type=${event.type} phase=${event.phase} seq=${event.sequenceId}`);
  }

  emitSessionEvent(channel: string, event: SessionEvent): void {
    this.deliver(channel, event, `type=${event.eventType} seq=${event.sequenceId ?? 'none'}`);
  }

  /** Tauri emit failure policy: retry once, then count as dropped. */
  private deliver(channel: string, event: BackendEvent | SessionEvent, description: string): void {
    try {
      this.events.emit(channel, event);
      this.logger?.debug(`[ChatV2::events] Emitted event: ${channel} ${description}`);
    } catch (first) {
      this.logger?.error(`[ChatV2::events] Failed to emit event (attempt 1/2): ${channel} ${description} - ${String(first)}`);
      try {
        this.events.emit(channel, event);
        this.logger?.debug(`[ChatV2::events] Emitted event after retry: ${channel} ${description}`);
      } catch (second) {
        recordEmitFailure();
        this.logger?.error(
          `[ChatV2::events] Event DROPPED after retry: ${channel} ${description} - ${String(second)} (total_dropped=${emitFailures})`,
        );
      }
    }
  }

  window(): unknown {
    return this.events;
  }
}

/** Headless / test outlet: every event is discarded. */
export class NoopEventSink implements ExecutionEventSink {
  emitBlockEvent(_channel: string, _event: BackendEvent): void {
    // Headless runtime intentionally drops renderer events (Rust logs at trace level).
  }

  emitSessionEvent(_channel: string, _event: SessionEvent): void {
    // Headless runtime intentionally drops renderer events (Rust logs at trace level).
  }

  window(): null {
    return null;
  }
}

// ============================================================
// Chunk batching (events.rs:1023-1887)
// ============================================================

/** Backend chunk batch window; slightly below the frontend's 120ms buffer. */
export const CHUNK_BATCH_WINDOW_MS = 100;
/** Buffer cap in bytes (`String::len` is UTF-8 bytes in Rust). */
export const CHUNK_BATCH_MAX_BYTES = 4096;

interface BlockEventMeta {
  variantId?: string;
  skillStateVersion?: number;
  roundId?: string;
}

interface ChunkBatcherState {
  pending: BackendEvent[];
  windowOpen: boolean;
}

class ChunkBatcher {
  state: ChunkBatcherState = { pending: [], windowOpen: false };

  finishWindow(emit: (event: BackendEvent) => void): void {
    this.state.windowOpen = false;
    const pending = this.state.pending;
    this.state.pending = [];
    for (const event of pending) emit(event);
  }
}

function dispatchBlockEvent(
  sink: ExecutionEventSink,
  channel: string,
  sessionId: string,
  counter: Counter,
  event: BackendEvent,
): void {
  event.sequenceId = counter.value++;
  if (event.sessionId === undefined) event.sessionId = sessionId;
  sink.emitBlockEvent(channel, event);
}

/**
 * `ChatV2EventEmitter` (events.rs:1004-1899).
 *
 * Node is single-threaded, so the Rust mutex becomes a single synchronous
 * state object: batching, sequence assignment and sink delivery never
 * interleave within one emitter call.
 */
/** Batched emitters with a pending window timer; flushed when the plugin unloads. */
const liveBatchedEmitters = new Set<ChatV2EventEmitter>();

/** Cordis wraps the same event service in a different trace proxy per context. */
function eventOwner(value: unknown): unknown {
  return value !== null && typeof value === 'object' ? Reflect.get(value, symbols.original) ?? value : value;
}

/** Plugin disposer hook: flush every pending chunk window before shutdown. */
export function disposeAllChatEmitters(owner?: BackendEventsLike): void {
  for (const emitter of [...liveBatchedEmitters]) {
    if (owner === undefined || eventOwner(emitter.tryWindow()) === eventOwner(owner)) emitter.dispose();
  }
}

export class ChatV2EventEmitter {
  private readonly sink: ExecutionEventSink;
  private readonly sessionIdValue: string;
  private streamGenerationValue: number | undefined;
  private readonly sequenceCounter: Counter;
  private readonly sessionEventSequenceCounter: Counter;
  private readonly blockEventMeta = new Map<string, BlockEventMeta>();
  private readonly chunkBatcher: ChunkBatcher | null;
  private chunkFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(sink: ExecutionEventSink, sessionId: string, batchingEnabled = sink.window() !== null) {
    this.sink = sink;
    this.sessionIdValue = sessionId;
    this.streamGenerationValue = undefined;
    this.sequenceCounter = getOrCreateCounter(sessionSequenceCounters, sessionId);
    this.sessionEventSequenceCounter = getOrCreateCounter(sessionEventSequenceCounters, sessionId);
    this.chunkBatcher = batchingEnabled ? new ChunkBatcher() : null;
  }

  /** Window-backed sink: batching on by default. */
  static withSink(sink: ExecutionEventSink, sessionId: string): ChatV2EventEmitter {
    return new ChatV2EventEmitter(sink, sessionId);
  }

  static withSinkAndBatching(sink: ExecutionEventSink, sessionId: string, batchingEnabled: boolean): ChatV2EventEmitter {
    return new ChatV2EventEmitter(sink, sessionId, batchingEnabled);
  }

  static newHeadless(sessionId: string): ChatV2EventEmitter {
    return new ChatV2EventEmitter(new NoopEventSink(), sessionId);
  }

  withStreamGeneration(streamGeneration: number | null | undefined): this {
    this.streamGenerationValue = streamGeneration ?? undefined;
    return this;
  }

  sessionId(): string {
    return this.sessionIdValue;
  }

  sinkRef(): ExecutionEventSink {
    return this.sink;
  }

  /** Rust `window()`: panics on a windowless emitter to expose misuse. */
  window(): unknown {
    const window = this.sink.window();
    if (window === null) throw new Error('ChatV2EventEmitter::window() called on a windowless emitter');
    return window;
  }

  tryWindow(): unknown | null {
    return this.sink.window();
  }

  /** Test/diagnostic accessor (`#[cfg(test)] current_sequence_id`). */
  currentSequenceId(): number {
    return this.sequenceCounter.value;
  }

  private blockEventChannel(): string {
    return `chat_v2_event_${this.sessionIdValue}`;
  }

  private sessionEventChannel(): string {
    return `chat_v2_session_${this.sessionIdValue}`;
  }

  registerBlockEventMeta(
    blockId: string,
    variantId: string | null | undefined,
    skillStateVersion: number | null | undefined,
    roundId: string | null | undefined,
  ): void {
    this.blockEventMeta.set(blockId, {
      variantId: optional(variantId),
      skillStateVersion: skillStateVersion ?? undefined,
      roundId: optional(roundId),
    });
  }

  private applyRegisteredMeta(blockId: string | null | undefined, event: BackendEvent): void {
    if (blockId === null || blockId === undefined) return;
    const meta = this.blockEventMeta.get(blockId);
    if (!meta) return;
    if (event.variantId === undefined) event.variantId = meta.variantId;
    if (event.skillStateVersion === undefined) event.skillStateVersion = meta.skillStateVersion;
    if (event.roundId === undefined) event.roundId = meta.roundId;
  }

  private emit(event: BackendEvent): void {
    if (this.chunkBatcher) this.flushPendingChunksLocked(this.chunkBatcher.state);
    this.emitNow(event);
  }

  private emitNow(event: BackendEvent): void {
    dispatchBlockEvent(this.sink, this.blockEventChannel(), this.sessionIdValue, this.sequenceCounter, event);
  }

  private emitSession(event: SessionEvent): void {
    if (this.chunkBatcher) this.flushPendingChunksLocked(this.chunkBatcher.state);
    if (event.streamGeneration === undefined) event.streamGeneration = this.streamGenerationValue;
    if (event.sequenceId === undefined) event.sequenceId = this.sessionEventSequenceCounter.value++;
    this.sink.emitSessionEvent(this.sessionEventChannel(), event);
  }

  private flushPendingChunksLocked(state: ChunkBatcherState): void {
    if (state.pending.length === 0) return;
    const pending = state.pending;
    state.pending = [];
    for (const event of pending) this.emitNow(event);
  }

  private flushPendingChunk(): void {
    if (this.chunkBatcher) this.flushPendingChunksLocked(this.chunkBatcher.state);
  }

  private scheduleChunkFlush(batcher: ChunkBatcher): void {
    // The timer is owned by the emitter (not a WeakRef): it is cleared in
    // `dispose()`, and the plugin disposer calls `disposeAllChatEmitters()` so
    // unloading flushes every pending chunk window.
    liveBatchedEmitters.add(this);
    this.chunkFlushTimer = setTimeout(() => {
      this.chunkFlushTimer = null;
      liveBatchedEmitters.delete(this);
      batcher.finishWindow(event => {
        dispatchBlockEvent(this.sink, this.blockEventChannel(), this.sessionIdValue, this.sequenceCounter, event);
      });
    }, CHUNK_BATCH_WINDOW_MS);
  }

  // ========== Block-level event helpers ==========

  emitStart(
    eventType: string,
    messageId: string,
    blockId: string | null | undefined,
    payload: unknown,
    variantId: string | null | undefined,
  ): string | null {
    const event = backendEventStart(0, eventType, messageId, blockId, payload, variantId);
    this.applyRegisteredMeta(blockId, event);
    this.emit(event);
    return optional(blockId) ?? null;
  }

  emitStartWithMeta(
    eventType: string,
    messageId: string,
    blockId: string | null | undefined,
    payload: unknown,
    variantId: string | null | undefined,
    skillStateVersion: number | null | undefined,
    roundId: string | null | undefined,
  ): string | null {
    const event = backendEventStart(0, eventType, messageId, blockId, payload, variantId);
    event.skillStateVersion = skillStateVersion ?? undefined;
    event.roundId = optional(roundId);
    this.applyRegisteredMeta(blockId, event);
    this.emit(event);
    return optional(blockId) ?? null;
  }

  emitChunk(
    eventType: string,
    blockId: string,
    chunk: string,
    variantId: string | null | undefined,
  ): void {
    const batchable = (eventType === EVENT_TYPE.CONTENT || eventType === EVENT_TYPE.THINKING) && chunk.length > 0;
    const batcher = this.chunkBatcher;
    if (!batcher || !batchable) {
      const event = backendEventChunk(0, eventType, blockId, chunk, variantId);
      this.applyRegisteredMeta(blockId, event);
      this.emit(event);
      return;
    }

    const state = batcher.state;
    const registeredMeta = this.blockEventMeta.get(blockId);
    const effectiveVariantId = variantId ?? registeredMeta?.variantId;
    const pendingIndex = state.pending.findIndex(event => event.variantId === effectiveVariantId);
    const sameBlock = pendingIndex >= 0
      && state.pending[pendingIndex]!.type === eventType
      && state.pending[pendingIndex]!.blockId === blockId;
    if (sameBlock) {
      const event = state.pending[pendingIndex]!;
      event.chunk = `${event.chunk ?? ''}${chunk}`;
    } else {
      // Same variant switching blocks keeps block order; variants coalesce independently.
      if (pendingIndex >= 0) this.flushPendingChunksLocked(state);
      const event = backendEventChunk(0, eventType, blockId, chunk, variantId);
      if (registeredMeta) {
        event.variantId = effectiveVariantId;
        event.skillStateVersion = registeredMeta.skillStateVersion;
        event.roundId = registeredMeta.roundId;
      }
      state.pending.push(event);
    }
    const pendingBytes = state.pending.reduce(
      (total, event) => total + (event.chunk === undefined ? 0 : utf8ByteLength(event.chunk)),
      0,
    );
    if (pendingBytes >= CHUNK_BATCH_MAX_BYTES) this.flushPendingChunksLocked(state);
    if (state.pending.length > 0 && !state.windowOpen) {
      state.windowOpen = true;
      this.scheduleChunkFlush(batcher);
    }
  }

  emitChunkWithMeta(
    eventType: string,
    blockId: string,
    chunk: string,
    variantId: string | null | undefined,
    skillStateVersion: number | null | undefined,
    roundId: string | null | undefined,
  ): void {
    const event = backendEventChunk(0, eventType, blockId, chunk, variantId);
    event.skillStateVersion = skillStateVersion ?? undefined;
    event.roundId = optional(roundId);
    this.applyRegisteredMeta(blockId, event);
    this.emit(event);
  }

  emitEnd(
    eventType: string,
    blockId: string,
    result: unknown,
    variantId: string | null | undefined,
  ): void {
    const event = backendEventEnd(0, eventType, blockId, result, variantId);
    this.applyRegisteredMeta(blockId, event);
    this.emit(event);
  }

  emitEndWithMeta(
    eventType: string,
    blockId: string,
    result: unknown,
    variantId: string | null | undefined,
    skillStateVersion: number | null | undefined,
    roundId: string | null | undefined,
  ): void {
    const event = backendEventEnd(0, eventType, blockId, result, variantId);
    event.skillStateVersion = skillStateVersion ?? undefined;
    event.roundId = optional(roundId);
    this.applyRegisteredMeta(blockId, event);
    this.emit(event);
  }

  emitSkillInjectionAudit(
    messageId: string,
    payload: unknown,
    variantId: string | null | undefined,
    skillStateVersion: number | null | undefined,
    roundId: string | null | undefined,
  ): void {
    const event: BackendEvent = {
      sequenceId: 0,
      sessionId: this.sessionIdValue,
      type: EVENT_TYPE.SKILL_INJECTION_AUDIT,
      phase: EVENT_PHASE.END,
      messageId,
      blockId: undefined,
      blockType: undefined,
      chunk: undefined,
      result: payload,
      error: undefined,
      payload: undefined,
      skillStateVersion: skillStateVersion ?? undefined,
      roundId: optional(roundId),
      variantId: optional(variantId),
      modelId: undefined,
      status: undefined,
      usage: undefined,
    };
    this.emit(event);
  }

  emitError(
    eventType: string,
    blockId: string,
    error: string,
    variantId: string | null | undefined,
  ): void {
    const event = backendEventError(0, eventType, blockId, error, variantId);
    this.applyRegisteredMeta(blockId, event);
    this.emit(event);
  }

  emitErrorWithMeta(
    eventType: string,
    blockId: string,
    error: string,
    variantId: string | null | undefined,
    skillStateVersion: number | null | undefined,
    roundId: string | null | undefined,
  ): void {
    const event = backendEventError(0, eventType, blockId, error, variantId);
    event.skillStateVersion = skillStateVersion ?? undefined;
    event.roundId = optional(roundId);
    this.applyRegisteredMeta(blockId, event);
    this.emit(event);
  }

  // ========== Type-specific helpers ==========

  emitContentChunk(blockId: string, content: string, variantId: string | null | undefined): void {
    this.emitChunk(EVENT_TYPE.CONTENT, blockId, content, variantId);
  }

  emitThinkingChunk(blockId: string, content: string, variantId: string | null | undefined): void {
    this.emitChunk(EVENT_TYPE.THINKING, blockId, content, variantId);
  }

  emitToolCallStart(
    messageId: string,
    blockId: string,
    toolName: string,
    toolInput: unknown,
    toolCallId: string | null | undefined,
    variantId: string | null | undefined,
  ): void {
    const payload = {
      toolName,
      toolInput,
      toolCallId: toolCallId ?? null,
    };
    this.emitStart(EVENT_TYPE.TOOL_CALL, messageId, blockId, payload, variantId);
  }

  emitToolCallPreparing(
    messageId: string,
    toolCallId: string,
    toolName: string,
    blockId: string | null | undefined,
  ): void {
    const payload = { toolCallId, toolName, status: 'preparing' };
    const event: BackendEvent = {
      sequenceId: 0,
      sessionId: undefined,
      type: EVENT_TYPE.TOOL_CALL_PREPARING,
      phase: EVENT_PHASE.START,
      messageId,
      blockId: optional(blockId),
      blockType: undefined,
      chunk: undefined,
      result: undefined,
      error: undefined,
      payload,
      skillStateVersion: undefined,
      roundId: undefined,
      variantId: undefined,
      modelId: undefined,
      status: undefined,
      usage: undefined,
    };
    this.applyRegisteredMeta(blockId, event);
    this.emit(event);
  }

  emitToolCallPreparingWithMeta(
    messageId: string,
    toolCallId: string,
    toolName: string,
    blockId: string | null | undefined,
    variantId: string | null | undefined,
    skillStateVersion: number | null | undefined,
    roundId: string | null | undefined,
  ): void {
    const payload = { toolCallId, toolName, status: 'preparing' };
    const event: BackendEvent = {
      sequenceId: 0,
      sessionId: undefined,
      type: EVENT_TYPE.TOOL_CALL_PREPARING,
      phase: EVENT_PHASE.START,
      messageId,
      blockId: optional(blockId),
      blockType: undefined,
      chunk: undefined,
      result: undefined,
      error: undefined,
      payload,
      skillStateVersion: skillStateVersion ?? undefined,
      roundId: optional(roundId),
      variantId: optional(variantId),
      modelId: undefined,
      status: undefined,
      usage: undefined,
    };
    this.applyRegisteredMeta(blockId, event);
    this.emit(event);
  }

  emitToolCallPreparingWithVariant(
    messageId: string,
    toolCallId: string,
    toolName: string,
    blockId: string | null | undefined,
    variantId: string,
  ): void {
    const payload = { toolCallId, toolName, status: 'preparing' };
    const event: BackendEvent = {
      sequenceId: 0,
      sessionId: undefined,
      type: EVENT_TYPE.TOOL_CALL_PREPARING,
      phase: EVENT_PHASE.START,
      messageId,
      blockId: optional(blockId),
      blockType: undefined,
      chunk: undefined,
      result: undefined,
      error: undefined,
      payload,
      skillStateVersion: undefined,
      roundId: undefined,
      variantId,
      modelId: undefined,
      status: undefined,
      usage: undefined,
    };
    this.applyRegisteredMeta(blockId, event);
    this.emit(event);
  }

  // ========== Session-level helpers ==========

  emitStreamStart(messageId: string, modelId: string | null | undefined): void {
    this.emitSession(sessionEventStreamStart(this.sessionIdValue, messageId, modelId));
  }

  emitStreamReconnect(messageId: string, retryAttempt: number, retryMax: number): void {
    this.emitSession(sessionEventStreamReconnect(this.sessionIdValue, messageId, retryAttempt, retryMax));
  }

  emitStreamComplete(messageId: string, durationMs: number): void {
    this.emitSession(sessionEventStreamComplete(this.sessionIdValue, messageId, durationMs));
  }

  emitStreamCompleteWithUsage(
    messageId: string,
    durationMs: number,
    usage: TokenUsage | null | undefined,
  ): void {
    this.emitSession(sessionEventStreamCompleteWithUsage(this.sessionIdValue, messageId, durationMs, usage));
  }

  emitStreamError(messageId: string, error: string): void {
    this.emitSession(sessionEventStreamError(this.sessionIdValue, messageId, error));
  }

  emitStreamErrorWithDetails(messageId: string, error: string, code: string, details: unknown): void {
    const event = sessionEventStreamError(this.sessionIdValue, messageId, error);
    event.payload = { code, details };
    this.emitSession(event);
  }

  emitStreamCancelled(messageId: string): void {
    this.emitSession(sessionEventStreamCancelled(this.sessionIdValue, messageId));
  }

  emitSaveComplete(): void {
    this.emitSession(sessionEventSaveComplete(this.sessionIdValue));
  }

  emitSaveError(error: string): void {
    this.emitSession(sessionEventSaveError(this.sessionIdValue, error));
  }

  emitSummaryUpdated(title: string, description: string): void {
    this.emitSession(sessionEventSummaryUpdated(this.sessionIdValue, title, description));
  }

  emitCompactionStarted(reason: string): void {
    this.emitSession(sessionEventCompactionStarted(this.sessionIdValue, reason));
  }

  emitCompactionFinished(): void {
    this.emitSession(sessionEventCompactionFinished(this.sessionIdValue));
  }

  emitCompactionFailed(reason: string): void {
    this.emitSession(sessionEventCompactionFailed(this.sessionIdValue, reason));
  }

  emitCompactionCompleted(tokensBefore: number | null | undefined, tokensAfter: number | null | undefined): void {
    this.emitSession(sessionEventCompactionCompleted(this.sessionIdValue, tokensBefore, tokensAfter));
  }

  emitContextTrimmed(droppedMessages: number, estimatedDroppedTokens: number | null | undefined): void {
    this.emitSession(sessionEventContextTrimmed(this.sessionIdValue, droppedMessages, estimatedDroppedTokens));
  }

  // ========== Variant lifecycle ==========

  emitVariantStart(messageId: string, variantId: string, modelId: string): void {
    this.emit(backendEventVariantStart(0, messageId, variantId, modelId));
  }

  emitVariantEnd(
    variantId: string,
    status: string,
    error: string | null | undefined,
    usage: TokenUsage | null | undefined,
  ): void {
    this.emit(backendEventVariantEnd(0, variantId, status, error, usage));
  }

  // ========== Lifecycle / diagnostics ==========

  /** Flush the tail buffer (Rust `Drop`); also clears the pending timer. */
  dispose(): void {
    this.flushPendingChunk();
    if (this.chunkBatcher) this.chunkBatcher.state.windowOpen = false;
    if (this.chunkFlushTimer !== null) {
      clearTimeout(this.chunkFlushTimer);
      this.chunkFlushTimer = null;
    }
    liveBatchedEmitters.delete(this);
  }

  /** @internal Test control replacing direct access to the Rust batcher state. */
  setChunkWindowOpen(open: boolean): void {
    if (this.chunkBatcher) this.chunkBatcher.state.windowOpen = open;
  }

  /** @internal Test control: simulate the window timer expiring. */
  finishChunkWindow(): void {
    if (!this.chunkBatcher) return;
    this.chunkBatcher.finishWindow(event => {
      dispatchBlockEvent(this.sink, this.blockEventChannel(), this.sessionIdValue, this.sequenceCounter, event);
    });
  }

  /** @internal Test/diagnostic observation. */
  chunkWindowOpen(): boolean {
    return this.chunkBatcher?.state.windowOpen ?? false;
  }

  /** @internal Test/diagnostic observation. */
  pendingChunkCount(): number {
    return this.chunkBatcher?.state.pending.length ?? 0;
  }
}
