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
import { logMultiVariant } from '../../../debug-panel/plugins/MultiVariantDebugPlugin';
import { EVENT_BRIDGE_MAX_BUFFER_SIZE, EVENT_BRIDGE_MAX_PROCESSED_IDS, EVENT_BRIDGE_GAP_TIMEOUT_MS } from '../constants';

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
 * 事件处理上下文
 * 用于在多个事件之间共享状态（如 blockId）
 */
export interface EventContext {
  /** 当前消息 ID */
  messageId: string;

  /** 事件类型到块 ID 的映射 */
  blockIdMap: Map<string, string>;

  /** 变体 ID 到事件类型到块 ID 的映射（多变体时使用） */
  variantBlockIdMap: Map<string, Map<string, string>>;
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
}

const activeContexts = new Map<string, EventContext>();
const bridgeStates = new Map<string, EventBridgeState>();
const processedEventIds = new Map<string, Set<number>>();

function getOrCreateContext(sessionId: string, messageId: string): EventContext {
  let context = activeContexts.get(sessionId);
  if (!context || context.messageId !== messageId) {
    context = {
      messageId,
      blockIdMap: new Map(),
      variantBlockIdMap: new Map(),
    };
    activeContexts.set(sessionId, context);
  }
  return context;
}

function isEventProcessed(sessionId: string, sequenceId: number): boolean {
  const ids = processedEventIds.get(sessionId);
  return ids?.has(sequenceId) ?? false;
}

function markEventProcessed(sessionId: string, sequenceId: number): void {
  let ids = processedEventIds.get(sessionId);
  if (!ids) {
    ids = new Set();
    processedEventIds.set(sessionId, ids);
  }
  ids.add(sequenceId);
  
  if (ids.size > EVENT_BRIDGE_MAX_PROCESSED_IDS) {
    const idsArray = Array.from(ids);
    ids.clear();
    for (let i = Math.floor(idsArray.length / 2); i < idsArray.length; i++) {
      ids.add(idsArray[i]);
    }
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
    };
    bridgeStates.set(sessionId, state);
  }

  return state;
}

export function clearEventContext(sessionId: string): void {
  activeContexts.delete(sessionId);
}

export function clearBridgeState(sessionId: string): void {
  const state = bridgeStates.get(sessionId);
  if (state?.gapTimer) {
    clearTimeout(state.gapTimer);
  }
  bridgeStates.delete(sessionId);
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
  state.pendingEvents.clear();
  
  // 🔧 清理已处理事件 ID，开始新的去重周期
  clearProcessedEventIds(sessionId);
  
  logMultiVariant('adapter', 'resetBridgeState', {
    sessionId,
    prevLastSequenceId: prevSeqId,
    prevPendingEventsCount: prevPendingCount,
  }, 'info');
}

// ============================================================================
// 变体事件类型常量 (Prompt 9)
// ============================================================================

/** 变体开始事件类型 */
export const EVENT_TYPE_VARIANT_START = 'variant_start';

/** 变体结束事件类型 */
export const EVENT_TYPE_VARIANT_END = 'variant_end';

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

  // 🔧 去重检查：如果事件已处理过，直接忽略
  if (sequenceId !== undefined && isEventProcessed(store.sessionId, sequenceId)) {
    // 🔧 调试打点：重复事件
    if (variantId || type === 'variant_start' || type === 'variant_end') {
      logMultiVariant('adapter', 'sequenceHandler_duplicate', {
        type,
        variantId,
        sequenceId,
      }, 'warning');
    }
    return;
  }

  // 🔧 调试打点：序列号处理入口
  if (variantId || type === 'variant_start' || type === 'variant_end') {
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
    if (variantId || type === 'variant_start') {
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

    markEventProcessed(store.sessionId, sequenceId);
    processEventInternal(store, event);
    bridgeState.lastSequenceId = sequenceId;
    processBufferedEvents(store, bridgeState);
    return;
  }

  // 1. 如果是过期事件，直接忽略
  if (sequenceId <= bridgeState.lastSequenceId) {
    if (variantId || type === 'variant_start') {
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
    if (variantId || type === 'variant_start') {
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
  if (variantId || type === 'variant_start') {
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

  // 🔧 调试打点：追踪多变体相关事件
  if (variantId || type === EVENT_TYPE_VARIANT_START || type === EVENT_TYPE_VARIANT_END) {
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

  // 2. 处理普通 block 事件
  // 根据 variantId 决定块归属
  if (variantId) {
    handleBlockEventWithVariant(store, event);
  } else {
    handleBlockEventWithoutVariant(store, event);
  }
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

/**
 * 处理带 variantId 的 block 事件
 * block 归属到指定变体
 */
function handleBlockEventWithVariant(
  store: ChatStore,
  event: BackendEvent
): void {
  const {
    type,
    phase,
    messageId,
    blockId,
    variantId,
    chunk,
    result,
    error,
    payload,
  } = event;

  // 🔧 调试打点：追踪变体块事件
  if (phase === 'start') {
    logMultiVariant('adapter', 'handleBlockEventWithVariant_start', {
      type,
      phase,
      variantId,
      messageId,
      blockId,
      hasHandler: eventRegistry.has(type),
    }, 'info');
  }

  // 1. 从注册表获取 Handler
  const handler = eventRegistry.get(type);
  if (!handler) {
    logMultiVariant('adapter', 'handleBlockEventWithVariant_no_handler', {
      type,
      variantId,
    }, 'warning');
    return;
  }

  // 2. 获取事件上下文
  const effectiveMessageId =
    messageId ?? store.currentStreamingMessageId ?? '';

  if (!effectiveMessageId && phase === 'start') {
    logMultiVariant('adapter', 'handleBlockEventWithVariant_no_messageId', {
      type,
      variantId,
      phase,
    }, 'error');
    return;
  }

  const context = getOrCreateContext(store.sessionId, effectiveMessageId);

  // 确保变体 blockIdMap 存在
  if (!context.variantBlockIdMap.has(variantId!)) {
    context.variantBlockIdMap.set(variantId!, new Map());
  }
  const variantBlockIdMap = context.variantBlockIdMap.get(variantId!)!;

  // 3. 根据 phase 处理
  switch (phase) {
    case 'start': {
      if (handler.onStart) {
        const startPayload: EventStartPayload = payload ?? {};
        const effectiveBlockId = blockId
          ? handler.onStart(store, effectiveMessageId, startPayload, blockId)
          : handler.onStart(store, effectiveMessageId, startPayload);

        logMultiVariant('adapter', 'handleBlockEventWithVariant_block_created', {
          type,
          variantId,
          messageId: effectiveMessageId,
          blockId: effectiveBlockId,
          hasAddBlockToVariant: typeof (store as any).addBlockToVariant === 'function',
        }, effectiveBlockId ? 'success' : 'warning');

        if (effectiveBlockId) {
          variantBlockIdMap.set(type, effectiveBlockId);

          // 将 block 添加到变体
          // 注意：handler.onStart 调用 store.createBlock 会将 block 添加到 message.blockIds
          // addBlockToVariant (Prompt 7) 需要负责：
          // 1. 从 message.blockIds 移除该 block（避免重复）
          // 2. 将 block 添加到 variant.blockIds
          if (typeof (store as any).addBlockToVariant === 'function') {
            (store as any).addBlockToVariant(
              effectiveMessageId,
              variantId!,
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

          // 🔧 FIX: flushSync 已移至 Store 层面，addBlockToVariant 也会触发强制同步
          // addBlockToVariant 内部调用 set() 后会自动 flushSync
        }
      }
      break;
    }

    case 'chunk': {
      if (handler.onChunk) {
        const effectiveBlockId = blockId ?? variantBlockIdMap.get(type);
        if (!effectiveBlockId) {
          console.warn(
            `[EventBridge] Cannot process chunk without blockId. type=${type}`
          );
          return;
        }

        // 🔧 DEBUG: 记录收到的 chunk 事件
        console.log(`[EventBridge] 📨 chunk event: type=${type}, blockId=${effectiveBlockId}, chunkLen=${chunk?.length ?? 0}`);

        if ((type === 'content' || type === 'thinking') && chunk) {
          console.log(`[EventBridge] 📦 using chunkBuffer path: type=${type}`);
          chunkBuffer.setStore(store);
          chunkBuffer.push(effectiveBlockId, chunk, store.sessionId);

          // 🔧 防闪退：多变体流式块也进行定期保存
          if (effectiveMessageId) {
            streamingBlockSaver.scheduleBlockSave(
              effectiveBlockId,
              effectiveMessageId,
              type,
              chunk,
              store.sessionId
            );
          }
        } else {
          console.log(`[EventBridge] 📤 direct update: type=${type}`);
          handler.onChunk(store, effectiveBlockId, chunk ?? '');
        }

        autoSave.scheduleAutoSave(store);
      }
      break;
    }

    case 'end': {
      if (handler.onEnd) {
        const effectiveBlockId = blockId ?? variantBlockIdMap.get(type);
        if (!effectiveBlockId) {
          console.warn(
            `[EventBridge] Cannot process end without blockId. type=${type}`
          );
          return;
        }

        handler.onEnd(store, effectiveBlockId, mergeEndResultWithMeta(event));
        variantBlockIdMap.delete(type);
        autoSave.scheduleAutoSave(store);
      }
      break;
    }

    case 'error': {
      if (handler.onError) {
        const effectiveBlockId = blockId ?? variantBlockIdMap.get(type);
        if (!effectiveBlockId) {
          console.warn(
            `[EventBridge] Cannot process error without blockId. type=${type}`
          );
          return;
        }

        handler.onError(store, effectiveBlockId, error ?? 'Unknown error');
        variantBlockIdMap.delete(type);
        autoSave.scheduleAutoSave(store);
      }
      break;
    }

    default:
      console.warn(`[EventBridge] Unknown event phase: "${phase}"`);
  }
}

/**
 * 处理无 variantId 的 block 事件
 * block 归属到 message.blockIds（单变体兼容）
 * 
 * 注意：store.createBlock 内部已经将 blockId 添加到 message.blockIds，
 * 所以这里不需要再调用 addBlockToMessage。
 */
function handleBlockEventWithoutVariant(
  store: ChatStore,
  event: BackendEvent
): void {
  // 直接调用原有的 handleBackendEvent 逻辑
  // createBlock 内部已处理 message.blockIds 更新
  handleBackendEvent(store, event);
}

// ============================================================================
// 原有事件处理（向后兼容）
// ============================================================================

/**
 * 处理后端事件
 *
 * 核心事件分发逻辑，禁止使用 switch/case 处理事件类型。
 * 通过 eventRegistry 动态查找 Handler。
 *
 * @param store ChatStore 实例
 * @param event 后端事件
 */
export function handleBackendEvent(store: ChatStore, event: BackendEvent): void {
  const { type, phase, messageId, blockId, chunk, result, error, payload } = event;

  // 1. 从注册表获取 Handler（不使用 switch/case）
  const handler = eventRegistry.get(type);

  if (!handler) {
    console.warn(
      `[EventBridge] No handler registered for event type: "${type}". ` +
        `Event will be ignored. To handle this event, register a handler with: ` +
        `eventRegistry.register('${type}', { onStart, onChunk, onEnd, onError })`
    );
    return;
  }

  // 2. 获取事件上下文
  const effectiveMessageId =
    messageId ?? store.currentStreamingMessageId ?? '';

  if (!effectiveMessageId && phase === 'start') {
    console.error(
      `[EventBridge] Cannot process 'start' event without messageId. Event:`,
      event
    );
    return;
  }

  const context = getOrCreateContext(store.sessionId, effectiveMessageId);

  // 3. 根据 phase 调用对应的 Handler 方法
  switch (phase) {
    case 'start': {
      if (handler.onStart) {
        // 转换 payload 类型
        const startPayload: EventStartPayload = payload ?? {};
        
        // 如果后端传了 blockId，直接使用；否则由前端创建
        let effectiveBlockId: string;
        if (blockId) {
          // 后端传了 blockId（多工具并发场景）
          // 仍然需要调用 onStart 创建块，但使用后端的 blockId
          effectiveBlockId = handler.onStart(
            store,
            effectiveMessageId,
            startPayload,
            blockId
          );
        } else {
          // 后端未传 blockId，由前端创建
          effectiveBlockId = handler.onStart(store, effectiveMessageId, startPayload);
        }

        // 保存 blockId 到上下文
        if (effectiveBlockId) {
          context.blockIdMap.set(type, effectiveBlockId);
        }

        // 🔧 FIX: flushSync 已移至 Store 层面的 createBlock 方法中
        // Store.createBlock 在 set() 后立即调用 flushSync，确保组件立即挂载
      }
      break;
    }

    case 'chunk': {
      if (handler.onChunk) {
        // 优先使用事件中的 blockId，否则从上下文获取
        const effectiveBlockId = blockId ?? context.blockIdMap.get(type);

        if (!effectiveBlockId) {
          console.warn(
            `[EventBridge] Cannot process 'chunk' event without blockId. ` +
              `Event type: "${type}". Make sure 'start' event was processed first.`
          );
          return;
        }

        // 🔧 性能优化：使用 chunkBuffer 批量更新
        // 对于流式内容块（content, thinking），使用缓冲器减少 Store 更新频率
        if ((type === 'content' || type === 'thinking') && chunk) {
          // 确保 chunkBuffer 有 Store 引用
          chunkBuffer.setStore(store);
          chunkBuffer.push(effectiveBlockId, chunk, store.sessionId);

          // 🔧 防闪退：定期保存流式块内容到后端
          // 注意：传入 chunk 而不是 block.content，因为 chunkBuffer 有 16ms 延迟
          // streamingBlockSaver 会自己累积 chunk
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
        } else {
          // 其他类型直接更新
          console.log(`[EventBridge:Main] 📤 direct update`);
          handler.onChunk(store, effectiveBlockId, chunk ?? '');
        }

        // 触发自动保存
        autoSave.scheduleAutoSave(store);
      }
      break;
    }

    case 'end': {
      if (handler.onEnd) {
        // 优先使用事件中的 blockId，否则从上下文获取
        const effectiveBlockId = blockId ?? context.blockIdMap.get(type);

        if (!effectiveBlockId) {
          console.warn(
            `[EventBridge] Cannot process 'end' event without blockId. ` +
              `Event type: "${type}". Make sure 'start' event was processed first.`
          );
          return;
        }

        handler.onEnd(store, effectiveBlockId, mergeEndResultWithMeta(event));

        // 从上下文移除已完成的块
        context.blockIdMap.delete(type);

        // 触发自动保存
        autoSave.scheduleAutoSave(store);
      }
      break;
    }

    case 'error': {
      if (handler.onError) {
        // 优先使用事件中的 blockId，否则从上下文获取
        const effectiveBlockId = blockId ?? context.blockIdMap.get(type);

        if (!effectiveBlockId) {
          console.warn(
            `[EventBridge] Cannot process 'error' event without blockId. ` +
              `Event type: "${type}". Error: ${error}`
          );
          return;
        }

        handler.onError(store, effectiveBlockId, error ?? 'Unknown error');

        // 从上下文移除出错的块
        context.blockIdMap.delete(type);

        // 触发自动保存
        autoSave.scheduleAutoSave(store);
      }
      break;
    }

    default:
      console.warn(`[EventBridge] Unknown event phase: "${phase}"`);
  }
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
