/**
 * Chat V2 - 事件桥接中间件
 *
 * 将后端事件分发到对应的事件处理器。
 *
 * 约束：
 * 1. 通过 eventRegistry.get(event.type) 获取 Handler，禁止 switch/case
 * 2. 未注册的事件类型打印 warning，不抛错
 * 3. 支持 start/chunk/end/error 四种 phase
 * 4. 支持序列号检测和乱序缓冲区
 * 5. 支持变体事件处理 (variant_start/variant_end)
 */

import type { ChatStore, VariantStatus, TokenUsage } from '../types';
import { eventRegistry, type EventStartPayload } from '../../registry/eventRegistry';
import { autoSave, streamingBlockSaver } from './autoSave';
import { chunkBuffer } from './chunkBuffer';
import { logMultiVariant } from '@/debug-panel/plugins/MultiVariantDebugPlugin';
import {
  EVENT_BRIDGE_MAX_BUFFER_SIZE,
  EVENT_BRIDGE_MAX_PROCESSED_IDS,
  EVENT_BRIDGE_GAP_TIMEOUT_MS,
  EVENT_BRIDGE_ORPHAN_TERMINAL_TIMEOUT_MS,
} from '../constants';

// ============================================================================
// 后端事件类型定义
// ============================================================================

/**
 * 后端事件的 phase
 */
export type EventPhase = 'start' | 'chunk' | 'end' | 'error';

/**
 * 后端事件结构
 */
export interface BackendEvent {
  /** 会话 ID */
  sessionId?: string;
  /** 事件类型（如 'thinking', 'content', 'web_search', 'variant_start', 'variant_end' 等） */
  type: string;

  /** 事件阶段 */
  phase: EventPhase;

  /** 关联的消息 ID（start 阶段必须提供） */
  messageId?: string;

  /** 关联的块 ID（chunk/end/error 阶段必须提供） */
  blockId?: string;

  /** 块类型（start 阶段可选，默认使用 type） */
  blockType?: string;

  /** 数据块（chunk 阶段） */
  chunk?: string;

  /** 最终结果（end 阶段） */
  result?: unknown;

  /** 错误信息（error 阶段） */
  error?: string;

  /** 附加数据 */
  payload?: Record<string, unknown>;

  /** Skill 状态版本 */
  skillStateVersion?: number;

  /** 工具轮次 ID */
  roundId?: string;

  // ========== 多变体支持 (Prompt 9) ==========

  /** 递增序列号（会话级别，从 0 开始） */
  sequenceId?: number;

  /** 变体 ID（多模型并行时使用） */
  variantId?: string;

  /** 模型 ID（variant_start 时使用） */
  modelId?: string;

  /** 变体状态（variant_end 时使用） */
  status?: VariantStatus;

  /** Token 使用统计（variant_end 时使用） */
  usage?: TokenUsage;
}

function mergeEndResultWithMeta(event: BackendEvent): unknown {
  const { result, status, error } = event;
  const meta: Record<string, unknown> = {};
  if (status !== undefined) meta.status = status;
  if (error !== undefined) meta.error = error;
  if (Object.keys(meta).length === 0) {
    return result;
  }
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), ...meta };
  }
  return { result, ...meta };
}

// ============================================================================
// 事件处理上下文
// ============================================================================

/**
 * 打开中的块记录（块生命周期状态机的最小单元）
 *
 * 生命周期：start（注册）→ chunk*（查询）→ end/error（注销）。
 * 以 blockId（后端提供的 backendBlockId 或前端生成的 ID）为主键。
 */
export interface OpenBlockRecord {
  /** 块 ID（主键） */
  blockId: string;
  /** 事件类型 */
  type: string;
  /** 所属变体 ID（主链为 undefined） */
  variantId?: string;
  /** 注册时间 */
  startedAt: number;
}

/**
 * 孤儿终止事件（end/error 先于对应 start 到达）
 * 缓存短暂窗口等待 start；超时后按「late block」创建兜底块。
 */
export interface OrphanTerminalEvent {
  event: BackendEvent;
  bufferedAt: number;
}

/**
 * 事件处理上下文
 * 用于在多个事件之间共享状态（如 blockId）
 *
 * 🔧 P0 重构：blockIdMap 由「事件类型 → 单个块 ID」改为
 * 「事件类型 → 未完成块 ID 的 FIFO 队列」。同类型并发块（工具环二次 rag、
 * 并行检索等）后到的 start 不再覆盖前者；无 blockId 的 chunk/end 按 FIFO
 * 回退到该类型最早的未完成块。openBlocks 以 blockId 为主键记录所有
 * 打开中的块，作为生命周期 SSOT。
 */
export interface EventContext {
  /** 当前消息 ID */
  messageId: string;

  /** blockId 主键 → 打开中的块记录（生命周期 SSOT） */
  openBlocks: Map<string, OpenBlockRecord>;

  /** 事件类型 → 未完成块 ID FIFO 队列（主链，无 blockId 事件的回退解析） */
  blockIdMap: Map<string, string[]>;

  /** 变体 ID → (事件类型 → 未完成块 ID FIFO 队列)（多变体时使用） */
  variantBlockIdMap: Map<string, Map<string, string[]>>;

  /** 孤儿终止事件缓冲（end/error 早于 start 到达） */
  orphanTerminals: OrphanTerminalEvent[];

  /** 孤儿终止事件超时定时器 */
  orphanTimer: ReturnType<typeof setTimeout> | null;

  /** block_id 到工具轮次的映射 */
  blockRoundMap: Map<string, string>;

  /** 当前主链工具轮次 */
  currentRoundId?: string;

  /** 当前变体工具轮次 */
  variantRoundMap: Map<string, string>;
}

// ============================================================================
// 事件桥接状态 (Prompt 9)
// ============================================================================

export interface EventBridgeState {
  lastSequenceId: number;
  pendingEvents: Map<number, BackendEvent>;
  maxBufferSize: number;
  gapTimer: ReturnType<typeof setTimeout> | null;
  gapDetectedAt: number | null;
  /**
   * 🔧 P1: 首个被接受的 start 事件的 sequenceId（会话流基线）。
   * 首包 start 的 sequenceId > 0 时，比它更早的序号事件属于「基线前事件」
   * （乱序迟到），不再按过期事件误弃，而是去重后直接处理。
   */
  initialBaselineSeqId: number;
}

interface ProcessedEventTracker {
  ids: Set<number>;
  /**
   * 🔧 P2: 保守下界——所有 <= floor 的 sequenceId 一律视为已处理。
   * 半量裁剪 ids 后，被裁掉的旧 seq 通过 floor 兜底，防止重放。
   */
  floor: number;
}

const activeContexts = new Map<string, EventContext>();
const bridgeStates = new Map<string, EventBridgeState>();
const processedEventIds = new Map<string, ProcessedEventTracker>();

function getOrCreateContext(sessionId: string, messageId: string): EventContext {
  let context = activeContexts.get(sessionId);
  if (!context || context.messageId !== messageId) {
    // 换消息时旧上下文整体废弃：清掉挂起的孤儿定时器，防止跨消息误创建兜底块
    if (context?.orphanTimer) {
      clearTimeout(context.orphanTimer);
    }
    context = {
      messageId,
      openBlocks: new Map(),
      blockIdMap: new Map(),
      variantBlockIdMap: new Map(),
      orphanTerminals: [],
      orphanTimer: null,
      blockRoundMap: new Map(),
      currentRoundId: undefined,
      variantRoundMap: new Map(),
    };
    activeContexts.set(sessionId, context);
  }
  return context;
}

function isEventProcessed(sessionId: string, sequenceId: number): boolean {
  const tracker = processedEventIds.get(sessionId);
  if (!tracker) return false;
  return sequenceId <= tracker.floor || tracker.ids.has(sequenceId);
}

function markEventProcessed(sessionId: string, sequenceId: number): void {
  let tracker = processedEventIds.get(sessionId);
  if (!tracker) {
    tracker = { ids: new Set(), floor: -1 };
    processedEventIds.set(sessionId, tracker);
  }
  tracker.ids.add(sequenceId);

  if (tracker.ids.size > EVENT_BRIDGE_MAX_PROCESSED_IDS) {
    // 🔧 P2: 按数值升序裁剪（旧实现按插入序裁剪，乱序时可能保留旧 seq 丢新 seq），
    // 并把被裁掉的最大值并入 floor，被裁的旧 seq 不会因裁剪而可重放
    const sorted = Array.from(tracker.ids).sort((a, b) => a - b);
    const keepFrom = Math.floor(sorted.length / 2);
    tracker.floor = Math.max(tracker.floor, sorted[keepFrom - 1] ?? tracker.floor);
    tracker.ids = new Set(sorted.slice(keepFrom));
  }
}

export function clearProcessedEventIds(sessionId: string): void {
  processedEventIds.delete(sessionId);
}

function getOrCreateBridgeState(sessionId: string): EventBridgeState {
  let state = bridgeStates.get(sessionId);

  if (!state) {
    state = {
      lastSequenceId: -1,
      pendingEvents: new Map(),
      maxBufferSize: EVENT_BRIDGE_MAX_BUFFER_SIZE,
      gapTimer: null,
      gapDetectedAt: null,
      initialBaselineSeqId: -1,
    };
    bridgeStates.set(sessionId, state);
  }

  return state;
}

export function clearEventContext(sessionId: string): void {
  const context = activeContexts.get(sessionId);
  if (context?.orphanTimer) {
    clearTimeout(context.orphanTimer);
    context.orphanTimer = null;
  }
  activeContexts.delete(sessionId);
}

/**
 * 🔧 P2: 会话级事件桥状态统一清理钩子。
 *
 * eventBridge 的 activeContexts / bridgeStates / processedEventIds 均为模块级
 * Map，异常路径（组件卸载、会话被销毁、强制重置）下可能残留。
 * 调用方在会话生命周期终点调用一次即可保证无泄漏；重复调用安全（幂等）。
 */
export function disposeSessionEventBridgeState(sessionId: string): void {
  clearEventContext(sessionId);
  clearBridgeState(sessionId);
  clearProcessedEventIds(sessionId);
}

export function clearBridgeState(sessionId: string): void {
  const state = bridgeStates.get(sessionId);
  if (state?.gapTimer) {
    clearTimeout(state.gapTimer);
  }
  bridgeStates.delete(sessionId);
}

/**
 * Drain block events that are still waiting behind a sequence gap.
 *
 * `stream_complete` is delivered on a different Tauri channel from block
 * events, so it can overtake a tail event that is already buffered here. At a
 * successful stream boundary the backend has finished emitting block events;
 * keeping the gap buffer until its normal timeout would let terminal cleanup
 * discard valid final chunks.
 */
export function flushPendingBackendEvents(store: ChatStore): void {
  const state = bridgeStates.get(store.sessionId);
  if (!state || state.pendingEvents.size === 0) return;
  skipGapAndFlush(store, state);
}

/**
 * 重置会话的事件桥接状态（开始新流式时调用）
 */
export function resetBridgeState(sessionId: string): void {
  const state = getOrCreateBridgeState(sessionId);
  const prevSeqId = state.lastSequenceId;
  const prevPendingCount = state.pendingEvents.size;
  
  if (state.gapTimer) {
    clearTimeout(state.gapTimer);
    state.gapTimer = null;
  }
  state.gapDetectedAt = null;
  state.lastSequenceId = -1;
  state.initialBaselineSeqId = -1;
  state.pendingEvents.clear();
  
  // 🔧 清理已处理事件 ID，开始新的去重周期
  clearProcessedEventIds(sessionId);
  clearEventContext(sessionId);
  
  logMultiVariant('adapter', 'resetBridgeState', {
    sessionId,
    prevLastSequenceId: prevSeqId,
    prevPendingEventsCount: prevPendingCount,
  }, 'info');
}

function getCurrentSkillStateVersion(store: ChatStore): number | undefined {
  const raw = (store as ChatStore & { skillStateJson?: string | null }).skillStateJson;
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed?.version === 'number' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

function isToolEvent(event: BackendEvent): boolean {
  return event.type === 'tool_call' || event.type === 'tool_call_preparing';
}

function shouldDropEventBySkillVersion(store: ChatStore, event: BackendEvent): boolean {
  const currentVersion = getCurrentSkillStateVersion(store);
  if (event.skillStateVersion === undefined || currentVersion === undefined) {
    return false;
  }
  return event.skillStateVersion < currentVersion;
}

function resolveExpectedRound(context: EventContext, event: BackendEvent): string | undefined {
  if (event.blockId && context.blockRoundMap.has(event.blockId)) {
    return context.blockRoundMap.get(event.blockId);
  }
  if (event.variantId) {
    return context.variantRoundMap.get(event.variantId);
  }
  return context.currentRoundId;
}

function updateRoundContext(context: EventContext, event: BackendEvent): void {
  if (!isToolEvent(event) || !event.roundId) {
    return;
  }

  if (event.variantId) {
    context.variantRoundMap.set(event.variantId, event.roundId);
  } else {
    context.currentRoundId = event.roundId;
  }

  if (event.blockId) {
    context.blockRoundMap.set(event.blockId, event.roundId);
  }
}

function shouldDropEventByRound(context: EventContext, event: BackendEvent): boolean {
  if (!isToolEvent(event) || !event.roundId || event.phase === 'start') {
    return false;
  }

  const expectedRound = resolveExpectedRound(context, event);
  return !!expectedRound && expectedRound !== event.roundId;
}

// ============================================================================
// 变体事件类型常量 (Prompt 9)
// ============================================================================

/** 变体开始事件类型 */
export const EVENT_TYPE_VARIANT_START = 'variant_start';

/** 变体结束事件类型 */
export const EVENT_TYPE_VARIANT_END = 'variant_end';

// 🚀 性能：content/thinking 的 chunk 阶段是 token 级热路径，多变体流式时
// 逐条调试日志会绕开 chunk 缓冲（每秒数百次分配 + 同步 DOM 事件派发）。
// 此处按 1/10 采样（与 TauriAdapter 的 chatanki chunk 日志同一模式），
// start/end/error/variant_* 等低频事件仍全量记录，不影响调试面板可观测性。
let variantChunkLogCounter = 0;

/** 判断当前事件的多变体调试日志是否应记录（高频 chunk 采样，其余全量） */
function shouldLogVariantEvent(type: string, phase: EventPhase): boolean {
  if (phase !== 'chunk' || (type !== 'content' && type !== 'thinking')) {
    return true;
  }
  return ++variantChunkLogCounter % 10 === 1;
}

// ============================================================================
// 序列号检测与乱序缓冲 (Prompt 9)
// ============================================================================

/**
 * 带序列号检测的事件处理入口
 * 
 * 处理逻辑：
 * 1. 检查 sequenceId 是否连续
 * 2. 乱序事件暂存缓冲区
 * 3. 按序处理缓冲区
 * 4. 过期事件直接忽略
 *
 * @param store ChatStore 实例
 * @param event 后端事件
 */
export function handleBackendEventWithSequence(
  store: ChatStore,
  event: BackendEvent
): void {
  const { sequenceId, type, variantId, phase } = event;

  // 🚀 性能：本事件的调试日志采样决策（content/thinking chunk 按 1/10 采样）
  const shouldLogThisEvent = shouldLogVariantEvent(type, phase);

  // 🔧 去重检查：如果事件已处理过，直接忽略
  if (sequenceId !== undefined && isEventProcessed(store.sessionId, sequenceId)) {
    // 🔧 调试打点：重复事件
    if (shouldLogThisEvent && (variantId || type === 'variant_start' || type === 'variant_end')) {
      logMultiVariant('adapter', 'sequenceHandler_duplicate', {
        type,
        variantId,
        sequenceId,
      }, 'warning');
    }
    return;
  }

  // 🔧 调试打点：序列号处理入口
  if (shouldLogThisEvent && (variantId || type === 'variant_start' || type === 'variant_end')) {
    logMultiVariant('adapter', 'sequenceHandler_entry', {
      type,
      phase,
      variantId,
      sequenceId,
      hasSequenceId: sequenceId !== undefined,
    }, 'info');
  }

  // 如果没有 sequenceId，直接处理（向后兼容）
  if (sequenceId === undefined) {
    if (shouldLogThisEvent && (variantId || type === 'variant_start')) {
      logMultiVariant('adapter', 'sequenceHandler_no_seq_direct', {
        type,
        variantId,
      }, 'warning');
    }
    processEventInternal(store, event);
    return;
  }

  const bridgeState = getOrCreateBridgeState(store.sessionId);
  const expectedSeqId = bridgeState.lastSequenceId + 1;

  // 🔧 修复：如果是第一个事件（lastSequenceId === -1），需要确保 start 优先
  // 乱序情况下 chunk 先到会导致 start 被丢弃，从而无法创建 block
  if (bridgeState.lastSequenceId === -1) {
    if (phase !== 'start') {
      logMultiVariant('adapter', 'sequenceHandler_first_non_start_buffered', {
        type,
        phase,
        variantId,
        sequenceId,
      }, 'warning');

      bridgeState.pendingEvents.set(sequenceId, event);
      // 首包非 start 也要启动恢复机制，避免在 start 丢失时永久卡住
      ensureGapRecoveryTimer(store, bridgeState);
      return;
    }

    logMultiVariant('adapter', 'sequenceHandler_first_event', {
      type,
      variantId,
      sequenceId,
      message: 'Accepting first start event regardless of sequence ID',
    }, 'info');

    // 🔧 P1: 记录基线序号。首包 start 的 sequenceId > 0 时，比它更早的
    // 序号事件（乱序迟到）后续不再被过期分支误弃
    bridgeState.initialBaselineSeqId = sequenceId;
    markEventProcessed(store.sessionId, sequenceId);
    processEventInternal(store, event);
    bridgeState.lastSequenceId = sequenceId;
    processBufferedEvents(store, bridgeState);
    return;
  }

  // 1. 如果是过期事件，直接忽略
  if (sequenceId <= bridgeState.lastSequenceId) {
    // 🔧 P1: 基线前事件（早于首个被接受的 start 的序号）是迟到而非重复：
    // 首包 start 直接跳 lastSequenceId 后，这些事件曾被无条件丢弃，
    // 导致更早发射的检索块等凭空消失。这里去重后直接处理（不推进游标）。
    if (sequenceId < bridgeState.initialBaselineSeqId) {
      logMultiVariant('adapter', 'sequenceHandler_pre_baseline_late', {
        type,
        variantId,
        sequenceId,
        baseline: bridgeState.initialBaselineSeqId,
      }, 'warning');
      markEventProcessed(store.sessionId, sequenceId);
      processEventInternal(store, event);
      return;
    }
    if (shouldLogThisEvent && (variantId || type === 'variant_start')) {
      logMultiVariant('adapter', 'sequenceHandler_expired', {
        type,
        variantId,
        sequenceId,
        lastProcessed: bridgeState.lastSequenceId,
      }, 'error');
    }
    return;
  }

  // 2. 如果是期望的下一个事件，直接处理
  if (sequenceId === expectedSeqId) {
    if (shouldLogThisEvent && (variantId || type === 'variant_start')) {
      logMultiVariant('adapter', 'sequenceHandler_process', {
        type,
        variantId,
        sequenceId,
        expectedSeqId,
      }, 'success');
    }
    markEventProcessed(store.sessionId, sequenceId);
    processEventInternal(store, event);
    bridgeState.lastSequenceId = sequenceId;

    // 检查缓冲区中是否有连续的后续事件
    processBufferedEvents(store, bridgeState);
    return;
  }

  // 3. 如果是未来事件（乱序），加入缓冲区
  if (shouldLogThisEvent && (variantId || type === 'variant_start')) {
    logMultiVariant('adapter', 'sequenceHandler_buffered', {
      type,
      variantId,
      sequenceId,
      expectedSeqId,
      bufferSize: bridgeState.pendingEvents.size,
    }, 'warning');
  }

  if (bridgeState.pendingEvents.size >= bridgeState.maxBufferSize) {
    console.warn(
      `[EventBridge] Buffer full, skipping gap and flushing. ` +
        `Current size=${bridgeState.pendingEvents.size}, max=${bridgeState.maxBufferSize}`
    );
    bridgeState.pendingEvents.set(sequenceId, event);
    skipGapAndFlush(store, bridgeState);
    return;
  }

  bridgeState.pendingEvents.set(sequenceId, event);

  // 启动 gap 超时定时器
  ensureGapRecoveryTimer(store, bridgeState);
}

/**
 * 处理缓冲区中的连续事件
 */
function processBufferedEvents(
  store: ChatStore,
  bridgeState: EventBridgeState
): void {
  let nextSeqId = bridgeState.lastSequenceId + 1;

  while (bridgeState.pendingEvents.has(nextSeqId)) {
    const bufferedEvent = bridgeState.pendingEvents.get(nextSeqId)!;
    bridgeState.pendingEvents.delete(nextSeqId);

    markEventProcessed(store.sessionId, nextSeqId);
    try {
      processEventInternal(store, bufferedEvent);
    } catch (error) {
      console.error(
        `[EventBridge] Error processing buffered event seqId=${nextSeqId}, type=${bufferedEvent.type}:`,
        error
      );
    }
    bridgeState.lastSequenceId = nextSeqId;
    nextSeqId++;
  }

  // 缓冲区清空后取消 gap timer
  if (bridgeState.pendingEvents.size === 0 && bridgeState.gapTimer) {
    clearTimeout(bridgeState.gapTimer);
    bridgeState.gapTimer = null;
    bridgeState.gapDetectedAt = null;
  }
}

function ensureGapRecoveryTimer(store: ChatStore, bridgeState: EventBridgeState): void {
  if (bridgeState.gapTimer) {
    return;
  }

  bridgeState.gapDetectedAt = Date.now();
  bridgeState.gapTimer = setTimeout(() => {
    bridgeState.gapTimer = null;
    if (bridgeState.pendingEvents.size > 0) {
      console.warn(
        `[EventBridge] Gap timeout (${EVENT_BRIDGE_GAP_TIMEOUT_MS}ms) - skipping missing seqId(s). ` +
          `Last processed: ${bridgeState.lastSequenceId}, buffered: ${bridgeState.pendingEvents.size}`
      );
      skipGapAndFlush(store, bridgeState);
    }
  }, EVENT_BRIDGE_GAP_TIMEOUT_MS);
}

/**
 * 跳过序列号间隙，按序处理缓冲区中所有事件
 */
function skipGapAndFlush(
  store: ChatStore,
  bridgeState: EventBridgeState
): void {
  if (bridgeState.pendingEvents.size === 0) return;

  const sortedSeqIds = Array.from(bridgeState.pendingEvents.keys()).sort((a, b) => a - b);
  const skippedFrom = bridgeState.lastSequenceId + 1;
  const skippedTo = sortedSeqIds[0] - 1;

  console.warn(
    `[EventBridge] Skipping gap: seqId ${skippedFrom}-${skippedTo} (${skippedTo - skippedFrom + 1} events lost). ` +
      `Flushing ${sortedSeqIds.length} buffered events.`
  );

  if (bridgeState.gapTimer) {
    clearTimeout(bridgeState.gapTimer);
    bridgeState.gapTimer = null;
  }
  bridgeState.gapDetectedAt = null;

  // 强制按序消费当前缓冲中的全部事件（允许中间仍有 gap）
  for (const seqId of sortedSeqIds) {
    const event = bridgeState.pendingEvents.get(seqId);
    if (!event) continue;

    bridgeState.pendingEvents.delete(seqId);
    markEventProcessed(store.sessionId, seqId);
    try {
      processEventInternal(store, event);
    } catch (error) {
      console.error(
        `[EventBridge] Error processing flushed event seqId=${seqId}, type=${event.type}:`,
        error
      );
    }
    bridgeState.lastSequenceId = seqId;
  }
}

// ============================================================================
// 事件分发实现 (Prompt 9 扩展)
// ============================================================================

/**
 * 内部事件处理入口
 * 支持变体事件和普通事件
 */
function processEventInternal(store: ChatStore, event: BackendEvent): void {
  const { type, variantId, messageId, modelId, status, error, phase, blockId, sequenceId } = event;

  if (shouldDropEventBySkillVersion(store, event)) {
    logMultiVariant('adapter', 'drop_stale_skill_state_event', {
      type,
      phase,
      variantId,
      blockId,
      sequenceId,
      eventSkillStateVersion: event.skillStateVersion,
      currentSkillStateVersion: getCurrentSkillStateVersion(store),
    }, 'warning');
    return;
  }

  const effectiveMessageId = messageId ?? store.currentStreamingMessageId ?? '';
  const context = getOrCreateContext(store.sessionId, effectiveMessageId);

  if (shouldDropEventByRound(context, event)) {
    logMultiVariant('adapter', 'drop_stale_round_event', {
      type,
      phase,
      variantId,
      blockId,
      sequenceId,
      eventRoundId: event.roundId,
      expectedRoundId: resolveExpectedRound(context, event),
    }, 'warning');
    return;
  }

  updateRoundContext(context, event);

  // 🔧 调试打点：追踪多变体相关事件（content/thinking chunk 按 1/10 采样）
  if (
    shouldLogVariantEvent(type, phase)
    && (variantId || type === EVENT_TYPE_VARIANT_START || type === EVENT_TYPE_VARIANT_END)
  ) {
    logMultiVariant('adapter', 'processEventInternal', {
      type,
      phase,
      variantId,
      messageId,
      blockId,
      sequenceId,
      isVariantLifecycle: type === EVENT_TYPE_VARIANT_START || type === EVENT_TYPE_VARIANT_END,
    }, 'info');
  }

  // 1. 处理变体生命周期事件
  if (type === EVENT_TYPE_VARIANT_START) {
    handleVariantStart(store, event);
    return;
  }

  if (type === EVENT_TYPE_VARIANT_END) {
    handleVariantEnd(store, event);
    return;
  }

  // 2. 处理普通 block 事件（dispatchBlockEvent 内部按 event.variantId 决定块归属）
  dispatchBlockEvent(store, event);
}

/**
 * 处理 variant_start 事件
 * 发射此事件时必须在变体的任何 block 事件之前
 */
function handleVariantStart(store: ChatStore, event: BackendEvent): void {
  const { messageId, variantId, modelId } = event;

  logMultiVariant('adapter', 'handleVariantStart_called', {
    messageId,
    variantId,
    modelId,
    hasStoreMethod: typeof store.handleVariantStart === 'function',
  }, 'info');

  if (!messageId || !variantId || !modelId) {
    logMultiVariant('adapter', 'handleVariantStart_missing_fields', {
      messageId,
      variantId,
      modelId,
    }, 'error');
    return;
  }

  // 调用 Store 的 handleVariantStart 方法
  if (typeof store.handleVariantStart === 'function') {
    // 🔧 Prompt 7: 传递 BackendVariantEvent 兼容的事件对象
    store.handleVariantStart({
      type: event.type,
      messageId,
      variantId,
      modelId,
      status: event.status,
      error: event.error,
      sequenceId: event.sequenceId,
    });
  } else {
    // 如果 Store 还没有实现，打印警告并创建上下文
    console.warn(
      '[EventBridge] Store.handleVariantStart not implemented, creating context only'
    );
    const context = getOrCreateContext(store.sessionId, messageId);
    // 为该变体初始化 blockIdMap
    if (!context.variantBlockIdMap.has(variantId)) {
      context.variantBlockIdMap.set(variantId, new Map());
    }
  }

  // 触发自动保存
  autoSave.scheduleAutoSave(store);
}

/**
 * 处理 variant_end 事件
 * 发射此事件时必须在变体的所有 block 事件之后
 */
function handleVariantEnd(store: ChatStore, event: BackendEvent): void {
  const { variantId, status, error, usage } = event;

  logMultiVariant('adapter', 'handleVariantEnd_called', {
    variantId,
    status,
    error,
    // 🆕 P0修复：日志中包含 usage 信息
    usage: usage ? { total: usage.totalTokens, source: usage.source } : undefined,
    hasStoreMethod: typeof store.handleVariantEnd === 'function',
  }, status === 'success' ? 'success' : 'info');

  if (!variantId) {
    logMultiVariant('adapter', 'handleVariantEnd_missing_variantId', {}, 'error');
    return;
  }

  // 调用 Store 的 handleVariantEnd 方法
  if (typeof store.handleVariantEnd === 'function') {
    // 🔧 Prompt 7: 传递 BackendVariantEvent 兼容的事件对象
    // 🆕 P0修复：传递 usage 到 Store
    store.handleVariantEnd({
      type: event.type,
      variantId,
      status: event.status,
      error,
      sequenceId: event.sequenceId,
      usage,
    });
  } else {
    logMultiVariant('adapter', 'handleVariantEnd_not_implemented', { variantId }, 'warning');
  }

  // 触发自动保存
  autoSave.scheduleAutoSave(store);
}

// ============================================================================
// 块生命周期追踪（P0 重构：blockId 主键 + type FIFO 回退队列 + 孤儿终止事件）
// ============================================================================

/**
 * 获取（主链或指定变体的）type → FIFO 队列映射
 */
function getFallbackQueues(
  context: EventContext,
  variantId?: string
): Map<string, string[]> {
  if (variantId === undefined) {
    return context.blockIdMap;
  }
  let queues = context.variantBlockIdMap.get(variantId);
  if (!queues) {
    queues = new Map();
    context.variantBlockIdMap.set(variantId, queues);
  }
  return queues;
}

/**
 * start：以 blockId 为主键注册打开中的块，并加入该 type 的 FIFO 回退队列
 */
function trackBlockStart(
  context: EventContext,
  type: string,
  blockId: string,
  variantId?: string
): void {
  context.openBlocks.set(blockId, { blockId, type, variantId, startedAt: Date.now() });
  const queues = getFallbackQueues(context, variantId);
  const queue = queues.get(type);
  if (queue) {
    if (!queue.includes(blockId)) queue.push(blockId);
  } else {
    queues.set(type, [blockId]);
  }
}

/**
 * chunk：显式 blockId 优先；否则回退到该 type 最早的未完成块（FIFO 头）
 */
function resolveOpenBlockId(
  context: EventContext,
  type: string,
  blockId?: string,
  variantId?: string
): string | undefined {
  if (blockId) return blockId;
  return getFallbackQueues(context, variantId).get(type)?.[0];
}

/**
 * end/error：注销块。显式 blockId 按值移除（并以 openBlocks 记录中的
 * variantId 为准定位队列）；无 blockId 时按 FIFO 头出队。
 */
function untrackBlock(
  context: EventContext,
  type: string,
  blockId?: string,
  variantId?: string
): string | undefined {
  let resolved = blockId;
  let effectiveVariantId = variantId;
  if (resolved !== undefined) {
    const record = context.openBlocks.get(resolved);
    if (record) {
      effectiveVariantId = record.variantId;
    }
  } else {
    resolved = getFallbackQueues(context, effectiveVariantId).get(type)?.[0];
  }
  if (resolved === undefined) return undefined;

  const queues = getFallbackQueues(context, effectiveVariantId);
  const queue = queues.get(type);
  if (queue) {
    const index = queue.indexOf(resolved);
    if (index !== -1) queue.splice(index, 1);
    if (queue.length === 0) queues.delete(type);
  }
  context.openBlocks.delete(resolved);
  return resolved;
}

/**
 * 块是否为「已知块」：正在追踪中，或已存在于 Store（restore 后继续流式等场景）
 */
function isBlockKnown(store: ChatStore, context: EventContext, blockId: string): boolean {
  if (context.openBlocks.has(blockId)) return true;
  const blocks = (store as { blocks?: Map<string, unknown> }).blocks;
  return blocks instanceof Map && blocks.has(blockId);
}

/**
 * 应用终止事件（end/error）到指定块并注销追踪
 */
function applyTerminalEvent(
  store: ChatStore,
  handler: NonNullable<ReturnType<typeof eventRegistry.get>>,
  context: EventContext,
  event: BackendEvent,
  blockId: string
): void {
  if (event.phase === 'error') {
    handler.onError?.(store, blockId, event.error ?? 'Unknown error');
  } else {
    handler.onEnd?.(store, blockId, mergeEndResultWithMeta(event));
  }
  untrackBlock(context, event.type, blockId, event.variantId);
}

/**
 * 缓存孤儿终止事件（end/error 无法解析到任何已知块）。
 *
 * 场景：gap 强制 flush 把 start 丢掉后，end 先于（或永远等不到）start 到达。
 * 旧实现直接丢弃，检索结果凭空消失。现在缓存一个短暂窗口：
 * - 若窗口内对应 start 到达 → 立即回放（见 tryApplyOrphanTerminal）
 * - 超时 → 按「late block」创建兜底块再应用终止事件（见 flushOrphanTerminals）
 */
function bufferOrphanTerminal(
  store: ChatStore,
  context: EventContext,
  event: BackendEvent
): void {
  console.warn(
    `[EventBridge] Orphan '${event.phase}' event buffered (no matching start yet). ` +
      `type=${event.type}, blockId=${event.blockId ?? '(none)'}, ` +
      `waiting ${EVENT_BRIDGE_ORPHAN_TERMINAL_TIMEOUT_MS}ms for start or late-block fallback.`
  );
  context.orphanTerminals.push({ event, bufferedAt: Date.now() });
  if (!context.orphanTimer) {
    context.orphanTimer = setTimeout(() => {
      context.orphanTimer = null;
      flushOrphanTerminals(store);
    }, EVENT_BRIDGE_ORPHAN_TERMINAL_TIMEOUT_MS);
  }
}

/**
 * start 到达后回放匹配的孤儿终止事件（最多一个——一个 start 只打开一个块）
 */
function tryApplyOrphanTerminal(
  store: ChatStore,
  context: EventContext,
  type: string,
  blockId: string,
  variantId?: string
): void {
  if (context.orphanTerminals.length === 0) return;
  const index = context.orphanTerminals.findIndex(
    (orphan) =>
      orphan.event.type === type
      && orphan.event.variantId === variantId
      && (orphan.event.blockId === undefined || orphan.event.blockId === blockId)
  );
  if (index === -1) return;

  const [orphan] = context.orphanTerminals.splice(index, 1);
  const handler = eventRegistry.get(type);
  if (!handler) return;

  console.warn(
    `[EventBridge] Replaying buffered orphan '${orphan.event.phase}' onto late-arriving start. ` +
      `type=${type}, blockId=${blockId}`
  );
  applyTerminalEvent(store, handler, context, orphan.event, blockId);
  autoSave.scheduleAutoSave(store);
}

/**
 * 冲刷孤儿终止事件：优先解析到现存块；无法解析时创建「late block」兜底块。
 *
 * 在孤儿窗口超时或流式终点（stream_complete）调用，保证检索结果等
 * end 数据不会因 start 丢失而静默消失。
 */
export function flushOrphanTerminals(store: ChatStore): void {
  const context = activeContexts.get(store.sessionId);
  if (!context) return;
  if (context.orphanTimer) {
    clearTimeout(context.orphanTimer);
    context.orphanTimer = null;
  }
  if (context.orphanTerminals.length === 0) return;

  const orphans = context.orphanTerminals.splice(0, context.orphanTerminals.length);
  for (const { event } of orphans) {
    const handler = eventRegistry.get(event.type);
    if (!handler) continue;

    // 再次尝试解析：等待窗口内可能已有同类型块 start
    let blockId: string | undefined;
    if (event.blockId && isBlockKnown(store, context, event.blockId)) {
      blockId = event.blockId;
    } else {
      blockId = resolveOpenBlockId(context, event.type, undefined, event.variantId);
    }

    if (!blockId) {
      // late block 兜底：为孤儿终止事件补建块
      if (!handler.onStart) continue;
      const effectiveMessageId =
        event.messageId ?? context.messageId ?? store.currentStreamingMessageId ?? '';
      if (!effectiveMessageId) continue;
      const startPayload: EventStartPayload = event.payload ?? {};
      blockId = event.blockId
        ? handler.onStart(store, effectiveMessageId, startPayload, event.blockId)
        : handler.onStart(store, effectiveMessageId, startPayload);
      if (!blockId) continue;
      console.warn(
        `[EventBridge] Created late block ${blockId} for orphan '${event.phase}' (type=${event.type})`
      );
    }

    applyTerminalEvent(store, handler, context, event, blockId);
  }
  autoSave.scheduleAutoSave(store);
}

// ============================================================================
// 统一块事件分发（主链与变体共用）
// ============================================================================

/**
 * 处理普通 block 事件（start/chunk/end/error）。
 *
 * 主链与变体块事件共用此实现：
 * - event.variantId 存在时，块归属到指定变体（addBlockToVariant）
 * - 块生命周期由 openBlocks（blockId 主键）+ type FIFO 队列追踪，
 *   同类型并发块不再互相覆盖
 * - 无法解析的 end/error 进入孤儿缓冲，等待 start 或超时兜底
 *
 * 注意：eventRegistry 插件接口保持不变（onStart/onChunk/onEnd/onError 签名不动）。
 */
function dispatchBlockEvent(store: ChatStore, event: BackendEvent): void {
  const { type, phase, messageId, blockId, variantId, chunk, payload } = event;

  // 🔧 调试打点：追踪变体块事件
  if (variantId && phase === 'start') {
    logMultiVariant('adapter', 'handleBlockEventWithVariant_start', {
      type,
      phase,
      variantId,
      messageId,
      blockId,
      hasHandler: eventRegistry.has(type),
    }, 'info');
  }

  // 1. 从注册表获取 Handler（不使用 switch/case 分发事件类型）
  const handler = eventRegistry.get(type);
  if (!handler) {
    if (variantId) {
      logMultiVariant('adapter', 'handleBlockEventWithVariant_no_handler', {
        type,
        variantId,
      }, 'warning');
    } else {
      console.warn(
        `[EventBridge] No handler registered for event type: "${type}". ` +
          `Event will be ignored. To handle this event, register a handler with: ` +
          `eventRegistry.register('${type}', { onStart, onChunk, onEnd, onError })`
      );
    }
    return;
  }

  // 2. 获取事件上下文
  const effectiveMessageId = messageId ?? store.currentStreamingMessageId ?? '';

  if (!effectiveMessageId && phase === 'start') {
    if (variantId) {
      logMultiVariant('adapter', 'handleBlockEventWithVariant_no_messageId', {
        type,
        variantId,
        phase,
      }, 'error');
    } else {
      console.error(
        `[EventBridge] Cannot process 'start' event without messageId. Event:`,
        event
      );
    }
    return;
  }

  const context = getOrCreateContext(store.sessionId, effectiveMessageId);

  // 3. 根据 phase 调用对应的 Handler 方法
  switch (phase) {
    case 'start': {
      if (handler.onStart) {
        const startPayload: EventStartPayload = payload ?? {};

        // 如果后端传了 blockId，直接使用（多工具并发场景）；否则由前端创建
        const effectiveBlockId = blockId
          ? handler.onStart(store, effectiveMessageId, startPayload, blockId)
          : handler.onStart(store, effectiveMessageId, startPayload);

        if (variantId) {
          logMultiVariant('adapter', 'handleBlockEventWithVariant_block_created', {
            type,
            variantId,
            messageId: effectiveMessageId,
            blockId: effectiveBlockId,
            hasAddBlockToVariant: typeof (store as any).addBlockToVariant === 'function',
          }, effectiveBlockId ? 'success' : 'warning');
        }

        if (effectiveBlockId) {
          // 以 blockId 为主键注册生命周期；同类型并发块进入 FIFO 队列
          trackBlockStart(context, type, effectiveBlockId, variantId);
          if (event.roundId) {
            context.blockRoundMap.set(effectiveBlockId, event.roundId);
          }

          if (variantId) {
            // 将 block 添加到变体
            // 注意：handler.onStart 调用 store.createBlock 会将 block 添加到 message.blockIds
            // addBlockToVariant (Prompt 7) 需要负责：
            // 1. 从 message.blockIds 移除该 block（避免重复）
            // 2. 将 block 添加到 variant.blockIds
            if (typeof (store as any).addBlockToVariant === 'function') {
              (store as any).addBlockToVariant(
                effectiveMessageId,
                variantId,
                effectiveBlockId
              );
              logMultiVariant('adapter', 'addBlockToVariant_called', {
                messageId: effectiveMessageId,
                variantId,
                blockId: effectiveBlockId,
              }, 'success');
            } else {
              // Prompt 7 未实现时，block 仍然保留在 message.blockIds（降级兼容）
              logMultiVariant('adapter', 'addBlockToVariant_not_implemented', {
                messageId: effectiveMessageId,
                variantId,
                blockId: effectiveBlockId,
              }, 'warning');
            }
          }

          // 孤儿终止事件回放：end/error 先到、start 后到的场景
          tryApplyOrphanTerminal(store, context, type, effectiveBlockId, variantId);

          // 注：块创建通过同步 set() 立即写入 store，无需强制同步渲染
        }
      }
      break;
    }

    case 'chunk': {
      if (handler.onChunk) {
        // 优先使用事件中的 blockId，否则回退到该 type 最早的未完成块
        const effectiveBlockId = resolveOpenBlockId(context, type, blockId, variantId);

        if (!effectiveBlockId) {
          console.warn(
            `[EventBridge] Cannot process 'chunk' event without blockId. ` +
              `Event type: "${type}". Make sure 'start' event was processed first.`
          );
          return;
        }

        // 🔧 性能优化：使用 chunkBuffer 批量更新
        // 对于流式内容块（content, thinking），使用缓冲器减少 Store 更新频率
        // ⚠️ 热路径：此分支每个 token 级 chunk 都会执行，禁止无条件日志。
        if ((type === 'content' || type === 'thinking') && chunk) {
          chunkBuffer.setStore(store);
          chunkBuffer.push(effectiveBlockId, chunk, store.sessionId);

          // 🔧 防闪退：定期保存流式块内容到后端
          // 🔧 P2修复：传递 sessionId 支持多会话并发清理
          if (effectiveMessageId) {
            streamingBlockSaver.scheduleBlockSave(
              effectiveBlockId,
              effectiveMessageId,
              type,
              chunk,
              store.sessionId
            );
          }
          // 🚀 P1：流式内容 chunk 不再调度全量会话 autoSave。
          // 流式期间的持久化由 streamingBlockSaver（5s 节流的块级保存）负责，
          // 终态完整保存由 end/error 与 stream_complete 的 forceImmediateSave 保证。
        } else {
          handler.onChunk(store, effectiveBlockId, chunk ?? '');
          // 🚀 性能：空 chunk（如空 content chunk 落进此分支）没有产生新内容，
          // 不调度全量会话保存
          if (chunk) {
            autoSave.scheduleAutoSave(store);
          }
        }
      }
      break;
    }

    case 'end':
    case 'error': {
      const hasTerminalHandler = phase === 'end' ? !!handler.onEnd : !!handler.onError;
      if (!hasTerminalHandler) break;

      // 解析目标块：
      // - 显式 blockId 且为已知块（追踪中 / 已在 Store）→ 直接使用
      // - 无 blockId → 该 type 最早未完成块（FIFO，与 start 顺序对齐）
      let effectiveBlockId: string | undefined;
      if (blockId) {
        if (isBlockKnown(store, context, blockId)) {
          effectiveBlockId = blockId;
        }
      } else {
        effectiveBlockId = resolveOpenBlockId(context, type, undefined, variantId);
      }

      if (!effectiveBlockId) {
        // 孤儿终止事件：start 可能因 gap 丢失或尚未到达，缓存等待/兜底
        bufferOrphanTerminal(store, context, event);
        return;
      }

      applyTerminalEvent(store, handler, context, event, effectiveBlockId);
      autoSave.scheduleAutoSave(store);
      break;
    }

    default:
      console.warn(`[EventBridge] Unknown event phase: "${phase}"`);
  }
}

// ============================================================================
// 原有事件处理（向后兼容）
// ============================================================================

/**
 * 处理后端事件（向后兼容入口，无序列号检查）
 *
 * 核心事件分发逻辑委托给 dispatchBlockEvent：
 * 禁止使用 switch/case 处理事件类型，通过 eventRegistry 动态查找 Handler。
 *
 * @param store ChatStore 实例
 * @param event 后端事件
 */
export function handleBackendEvent(store: ChatStore, event: BackendEvent): void {
  dispatchBlockEvent(store, event);
}

// ============================================================================
// 流式完成处理
// ============================================================================

/**
 * 流式完成事件选项
 * 用于传递 stream_complete 事件携带的数据
 */
export interface StreamCompleteOptions {
  /** 关联的消息 ID */
  messageId?: string;
  /** Token 使用统计 */
  usage?: TokenUsage;
}

/**
 * 处理流式完成事件
 * 在所有流式结束后调用，执行清理和强制保存
 *
 * @param store ChatStore 实例
 * @param options 可选的流式完成事件数据（messageId, usage）
 */
export async function handleStreamComplete(
  store: ChatStore,
  options?: StreamCompleteOptions
): Promise<void> {
  logMultiVariant('adapter', 'handleStreamComplete_called', {
    sessionId: store.sessionId,
    messageId: options?.messageId,
    hasUsage: !!options?.usage,
    usage: options?.usage,
  }, 'success');

  // 🆕 Prompt 8: 处理 stream_complete 事件的 token 统计
  // 更新消息的 _meta.usage
  if (options?.messageId && options?.usage) {
    console.log(
      '[EventBridge] Token usage received:',
      'messageId=', options.messageId,
      'prompt=', options.usage.promptTokens,
      'completion=', options.usage.completionTokens,
      'total=', options.usage.totalTokens,
      'source=', options.usage.source
    );
    store.updateMessageMeta(options.messageId, { usage: options.usage });
  }

  // 🔧 P1: 流式终点先冲刷孤儿终止事件（等待中的 end/error 立即走 late-block 兜底），
  // 避免随后的上下文清理把已到达的检索结果静默丢弃
  flushOrphanTerminals(store);

  // 🔧 P1修复：只刷新当前会话的 chunkBuffer（不清理，保留 session 缓冲区供后续复用）
  chunkBuffer.flushSession(store.sessionId);

  // 🔧 清理流式块保存器的累积内容（防止内存泄漏）
  streamingBlockSaver.cleanup(store.sessionId);

  // 清理事件上下文
  clearEventContext(store.sessionId);

  // 清理事件桥接状态
  clearBridgeState(store.sessionId);
  // 清理去重集合，避免新流复用 sequenceId 时被误判重复
  clearProcessedEventIds(store.sessionId);

  // 强制立即保存
  await autoSave.forceImmediateSave(store);

  logMultiVariant('adapter', 'handleStreamComplete_done', {
    sessionId: store.sessionId,
  }, 'success');
}

/**
 * 处理流式中断事件
 * 在用户中断流式时调用
 *
 * @param store ChatStore 实例
 */
export async function handleStreamAbort(store: ChatStore): Promise<void> {
  logMultiVariant('adapter', 'handleStreamAbort_called', {
    sessionId: store.sessionId,
  }, 'warning');

  // 🔧 P1修复：只刷新当前会话的 chunkBuffer（不清理，保留 session 缓冲区供后续复用）
  chunkBuffer.flushSession(store.sessionId);

  // 🔧 清理流式块保存器的累积内容（防止内存泄漏）
  streamingBlockSaver.cleanup(store.sessionId);

  // 清理事件上下文
  clearEventContext(store.sessionId);

  // 清理事件桥接状态
  clearBridgeState(store.sessionId);
  // 清理去重集合，避免新流复用 sequenceId 时被误判重复
  clearProcessedEventIds(store.sessionId);

  // 强制立即保存
  await autoSave.forceImmediateSave(store);

  logMultiVariant('adapter', 'handleStreamAbort_done', {
    sessionId: store.sessionId,
  }, 'warning');
}

// ============================================================================
// 批量事件处理
// ============================================================================

/**
 * 批量处理后端事件（带序列号检测）
 * 用于处理一次性返回的多个事件
 *
 * 🔧 优化：统一使用带序列号检查的处理器
 * 即使事件没有 sequenceId，也能正确处理（向后兼容）
 *
 * @param store ChatStore 实例
 * @param events 后端事件数组
 */
export function handleBackendEvents(
  store: ChatStore,
  events: BackendEvent[]
): void {
  for (const event of events) {
    try {
      handleBackendEventWithSequence(store, event);
    } catch (error) {
      console.error(
        `[EventBridge] Error in batch event processing, type=${event.type}, phase=${event.phase}:`,
        error
      );
    }
  }
}

/**
 * 批量处理后端事件（带序列号检测）
 * 用于处理多变体事件流
 *
 * 🔧 注意：现在 handleBackendEvents 和此函数等价
 * 两者都使用带序列号检查的处理器，保留此函数是为了向后兼容
 *
 * @param store ChatStore 实例
 * @param events 后端事件数组
 */
export function handleBackendEventsWithSequence(
  store: ChatStore,
  events: BackendEvent[]
): void {
  // 直接委托给 handleBackendEvents，两者现在等价
  handleBackendEvents(store, events);
}

// ============================================================================
// 事件构造辅助函数
// ============================================================================

/**
 * 创建 start 事件
 */
export function createStartEvent(
  type: string,
  messageId: string,
  payload?: Record<string, unknown>
): BackendEvent {
  return { type, phase: 'start', messageId, payload };
}

/**
 * 创建 chunk 事件
 */
export function createChunkEvent(
  type: string,
  blockId: string,
  chunk: string
): BackendEvent {
  return { type, phase: 'chunk', blockId, chunk };
}

/**
 * 创建 end 事件
 */
export function createEndEvent(
  type: string,
  blockId: string,
  result?: unknown
): BackendEvent {
  return { type, phase: 'end', blockId, result };
}

/**
 * 创建 error 事件
 */
export function createErrorEvent(
  type: string,
  blockId: string,
  error: string
): BackendEvent {
  return { type, phase: 'error', blockId, error };
}
