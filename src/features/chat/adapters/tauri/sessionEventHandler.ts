/**
 * Chat V2 - TauriAdapter 拆分模块 —— 会话级事件（chat_v2_session_{id}）分发：流式生命周期、保存、摘要、压缩、变体删除
 *
 * 自 TauriAdapter.ts 拆出（行为不变）；函数首参 host 为适配器实例，
 * 由 ChatV2TauriAdapter 同名方法委托调用。
 */

import i18n from 'i18next';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { clearAdapterErrorFlag, reportAdapterError } from '../errors/adapterErrorChannel';
import { handleStreamAbort } from '../../core/middleware/eventBridge';
import { logMultiVariant } from '@/debug-panel/plugins/MultiVariantDebugPlugin';
import { chunkBuffer } from '../../core/middleware/chunkBuffer';
// 🔧 优化：sessionManager 仅用于获取元数据，不再用于获取 Store 状态
// 构造函数现在接收 storeApi 参数，消除了循环依赖的核心问题
import { sessionManager } from '../../core/session/sessionManager';
import type { SessionEventPayload } from '../types';
// 🆕 2026-02-16: 工具调用生命周期调试
import {
  resetRound as resetToolCallRound,
} from '@/debug-panel/plugins/ToolCallLifecycleDebugPlugin';
import {
  LOG_PREFIX,
  adapterConsole as console,
  buildStreamStartDiagData,
  emitChatAnkiDebugLifecycle,
} from './diagnostics';
import { normalizeStreamTerminalError } from './errors';
import { isSessionEventForSession } from './sessionEvents';
import {
  compactionReasonI18nKey,
  createContextTrimThrottle,
  parseCompactionCompletedPayload,
  parseCompactionFailedReason,
  parseContextTrimmedPayload,
} from '../../utils/compactionFeedback';
import {
  shouldIgnoreStreamLifecycleEvent,
  buildStreamReconnectMeta,
  clearStreamReconnectMetaPatch,
  streamErrorMetaPatch,
} from './streamLifecycle';
import type { TauriAdapterHost } from './adapterHost';

// ★ context_trimmed 提示节流：模块级（按 sessionId 隔离），
// 适配器重建（会话切换/重连）也不会重置窗口导致刷屏
const contextTrimThrottle = createContextTrimThrottle();

/**
 * 处理会话级事件
 * 
 * 注意：此方法是同步的，但内部的保存操作是异步的。
 * 为了确保 UI 响应性，先重置状态再执行保存。
 */
export function handleSessionEvent(host: TauriAdapterHost, payload: SessionEventPayload): void {
  if (!host.isSessionRuntimeOwner()) return;
  if (!isSessionEventForSession(payload.sessionId, host.sessionId)) {
    return;
  }
  console.log(LOG_PREFIX, 'Session event:', payload.eventType, payload);
  emitChatAnkiDebugLifecycle({
    level: payload.eventType === 'stream_error' ? 'error' : 'debug',
    phase: 'backend:event',
    summary: `session_event ${payload.eventType} msg=${payload.messageId ?? 'null'}`,
    detail: payload,
  });

  try {
    switch (payload.eventType) {
      case 'stream_start': {
        if (!payload.messageId) {
          console.warn(LOG_PREFIX, 'Ignore stream_start without messageId');
          break;
        }
        if (
          host.isStaleByStreamGeneration(payload)
          || host.isStaleByExpectationTimestamp(payload)
        ) {
          console.warn(LOG_PREFIX, 'Ignore stale stream_start:', {
            messageId: payload.messageId,
            streamGeneration: payload.streamGeneration,
            eventTimestamp: payload.timestamp,
            expectation: host.streamExpectation,
          });
          break;
        }

        // goal 续跑竞态补丁（2026-09）：后端 goal 续跑在上一轮
        // stream_complete 后约 150ms 发起新一轮 stream_start（新 messageId），
        // 可能落在 STREAM_COMPLETE_SETTLE_DELAY_MS 静默窗口内——旧轮
        // completion 已 arm 未执行，currentStreamingMessageId /
        // streamExpectation 仍指向旧消息，下方冲突守卫会把新轮误丢弃。
        // 这里先把旧轮同步结算（completeStream('success') + 清 expectation），
        // 再让新轮走正常（自主流）路径。
        if (
          host.pendingStreamCompletion
          && host.pendingStreamCompletion.payload.messageId !== payload.messageId
        ) {
          host.forceSettlePendingStreamCompletion();
        }

        const currentState = host.getCurrentState();
        const currentStreamingMessageId = currentState.currentStreamingMessageId;
        const expectedMessageId = host.streamExpectation?.messageId ?? null;
        const hasConflictingCurrent =
          !!currentStreamingMessageId && currentStreamingMessageId !== payload.messageId;
        const hasConflictingExpectation =
          !!expectedMessageId && expectedMessageId !== payload.messageId;
        if (hasConflictingCurrent || hasConflictingExpectation) {
          const canAdoptRetryRebound = host.canAdoptRetryReboundStreamStart(
            currentState,
            payload.messageId,
            currentStreamingMessageId,
            expectedMessageId,
          );
          if (canAdoptRetryRebound) {
            console.warn(LOG_PREFIX, 'Adopt retry rebound stream_start messageId:', {
              incomingMessageId: payload.messageId,
              previousMessageId: currentStreamingMessageId,
              expectedMessageId,
            });
            host.setStreamExpectationMessageId(payload.messageId);
            host.store.setCurrentStreamingMessage(payload.messageId);
          } else {
            console.warn(LOG_PREFIX, 'Ignore stale stream_start with mismatched messageId:', {
              incomingMessageId: payload.messageId,
              currentStreamingMessageId,
              expectedMessageId,
            });
            break;
          }
        }

        // 🔧 P1 修复（2026-07-08 审阅 20 P1-1）：
        // 原先此处对 isTargetingCurrentStreamMessage 的硬性守卫会把后端自主发起的流
        // （P29 子代理场景：前端从未调用 send，currentStreamingMessageId 与
        // streamExpectation 均为 null）静默丢弃，使下方占位消息创建路径成为死代码。
        // messageId 冲突场景已由上方 hasConflictingCurrent/hasConflictingExpectation
        // 守卫处理（含 retry 重绑白名单），走到这里只剩两种合法情况：
        //   a) 事件指向当前流/预期流（isTargeting = true）
        //   b) 当前无任何进行中流与预期 → 后端自主发起的新流，放行到占位路径
        const isTargetingKnownStream = host.isTargetingCurrentStreamMessage(payload.messageId);
        const isAutonomousStreamStart =
          !isTargetingKnownStream &&
          !host.getCurrentState().currentStreamingMessageId &&
          !host.streamExpectation;
        if (!isTargetingKnownStream && !isAutonomousStreamStart) {
          console.warn(LOG_PREFIX, 'Ignore stale stream_start with mismatched messageId:', {
            incomingMessageId: payload.messageId,
            currentStreamingMessageId: host.getCurrentState().currentStreamingMessageId,
            expectedMessageId: host.streamExpectation?.messageId ?? null,
          });
          break;
        }

        // 拦截空闲态下针对已完成历史消息的自主 start 事件（stale 重放）。
        // 🔧 必须在 syncStreamExpectationFromEvent 之前判断，否则 expectation 被
        // 提前同步为该 messageId 后此守卫恒不命中（原实现的死代码问题）。
        const autonomousTargetMessage = isAutonomousStreamStart
          ? currentState.messageMap.get(payload.messageId)
          : undefined;
        if (
          isAutonomousStreamStart &&
          autonomousTargetMessage &&
          autonomousTargetMessage.role !== 'assistant'
        ) {
          console.warn(LOG_PREFIX, 'Ignore autonomous stream_start targeting a non-assistant message:', {
            messageId: payload.messageId,
            role: autonomousTargetMessage.role,
          });
          break;
        }
        if (
          isAutonomousStreamStart
          && autonomousTargetMessage
          && currentState.sessionStatus === 'idle'
          && (autonomousTargetMessage.blockIds?.length ?? 0) > 0
        ) {
          console.warn(LOG_PREFIX, 'Ignore stream_start for completed historical message:', {
            messageId: payload.messageId,
            blockCount: autonomousTargetMessage.blockIds?.length ?? 0,
            currentStreamingMessageId,
            expectedMessageId,
          });
          break;
        }

        host.syncStreamExpectationFromEvent(
          payload.messageId,
          payload.timestamp,
          payload.streamGeneration,
        );

        // 流式开始
        // 🆕 2026-02-16: 重置工具调用生命周期追踪器的轮次计数器
        try {
          resetToolCallRound();
        } catch { /* debug only */ }

        // 🔧 调试打点：记录 stream_start 事件中的模型名称
        logMultiVariant('adapter', 'stream_start_received', {
          messageId: payload.messageId,
          modelId: payload.modelId,
          hasModelId: !!payload.modelId,
          sessionId: payload.sessionId,
        }, payload.modelId ? 'success' : 'warning');

        const fallbackModelId =
          host.getCurrentState().chatParams.modelDisplayName ||
          host.getCurrentState().chatParams.modelId ||
          undefined;
        
        // 🔧 P29 修复：子代理场景下消息可能不存在（后端创建，前端未同步）
        // 检查消息是否存在，不存在则创建占位消息（与普通会话 sendMessageWithIds 等价）
        // （历史消息 stale 拦截已前移到 syncStreamExpectationFromEvent 之前，见上方守卫）
        const messageExists = currentState.messageMap.has(payload.messageId);
        const streamStoreApi = host.storeApi ?? sessionManager.get(host.sessionId);

        // 🔧 P31 全链路诊断
        const diagData = buildStreamStartDiagData({
          messageId: payload.messageId,
          messageExists,
          hasStoreApi: !!host.storeApi,
          storeApiType: host.storeApi ? typeof host.storeApi : 'null',
          hasStoreApiGetState: typeof host.storeApi?.getState === 'function',
          messageMapSize: currentState.messageMap.size,
          messageOrder: currentState.messageOrder,
          sessionStatus: currentState.sessionStatus,
          sessionId: payload.sessionId,
          thisSessionId: host.sessionId,
        });
        console.log(LOG_PREFIX, '[P31] stream_start check:', diagData);
        
        // 调用全局调试日志
        if ((window as any).__subagentFlowLog) {
          (window as any).__subagentFlowLog('stream_start', 'check_state', diagData, 
            !messageExists && host.storeApi ? 'info' : (!host.storeApi ? 'error' : 'warning'));
        }
        
        if (!messageExists && payload.messageId) {
          console.log(LOG_PREFIX, '[P29] Creating placeholder assistant message for subagent:', payload.messageId);
          logMultiVariant('adapter', 'stream_start_create_placeholder', {
            messageId: payload.messageId,
            modelId: payload.modelId,
            sessionId: payload.sessionId,
            hasStoreApi: !!host.storeApi,
          }, 'warning');
          
          // 与 sendMessageWithIds 等价：创建占位助手消息并设置流式状态
          const placeholderMessage = {
            id: payload.messageId,
            role: 'assistant' as const,
            blockIds: [] as string[],
            timestamp: Date.now(),
            _meta: {
              modelId: payload.modelId || fallbackModelId,
            },
          };
          
          // 🔧 P32 修复：不依赖 this.storeApi，从 sessionManager 获取 store 作为后备
          if (streamStoreApi) {
            streamStoreApi.setState((s) => ({
              sessionStatus: 'streaming' as const,
              messageMap: new Map(s.messageMap).set(payload.messageId, placeholderMessage),
              messageOrder: s.messageOrder.includes(payload.messageId)
                ? s.messageOrder
                : [...s.messageOrder, payload.messageId],
              currentStreamingMessageId: payload.messageId,
            }));
            console.log(LOG_PREFIX, '[P32] Placeholder created via', host.storeApi ? 'storeApi' : 'sessionManager fallback');
          } else {
            console.error(LOG_PREFIX, '[P32] Cannot create placeholder: no storeApi available');
          }
        } else {
          // An autonomous backend stream can race with session loading: the
          // empty assistant placeholder may already exist even though the
          // frontend never entered streaming state. Adopt every accepted
          // stream_start into the same invariant used by the send path so
          // terminal events are not discarded by completeStream().
          if (streamStoreApi) {
            streamStoreApi.setState({
              sessionStatus: 'streaming' as const,
              currentStreamingMessageId: payload.messageId,
            });
          }
        }

        if (messageExists && payload.messageId && payload.modelId) {
          // 普通会话：消息已存在，仅更新 modelId
          logMultiVariant('adapter', 'stream_start_update_meta', {
            messageId: payload.messageId,
            modelId: payload.modelId,
          }, 'success');
          host.store.updateMessageMeta(payload.messageId, { modelId: payload.modelId });
        } else if (messageExists && payload.messageId && fallbackModelId) {
          // 🔧 回退：stream_start 未携带 modelId 时使用当前模型
          logMultiVariant('adapter', 'stream_start_fallback_model', {
            messageId: payload.messageId,
            modelId: fallbackModelId,
          }, 'warning');
          host.store.updateMessageMeta(payload.messageId, { modelId: fallbackModelId });
        } else if (messageExists) {
          logMultiVariant('adapter', 'stream_start_no_modelId', {
            messageId: payload.messageId,
            hasMessageId: !!payload.messageId,
            hasModelId: !!payload.modelId,
          }, 'warning');
        }
        break;
      }

      case 'stream_reconnect':
        if (
          shouldIgnoreStreamLifecycleEvent(payload, {
            currentStreamingMessageId: host.getCurrentState().currentStreamingMessageId,
            expectation: host.streamExpectation,
            lastStreamGenerationByMessageId: host.lastStreamGenerationByMessageId,
          })
        ) {
          console.warn(LOG_PREFIX, 'Ignore stale stream_reconnect:', {
            messageId: payload.messageId,
            currentStreamingMessageId: host.getCurrentState().currentStreamingMessageId,
            expectation: host.streamExpectation,
            eventTimestamp: payload.timestamp,
          });
          break;
        }
        host.store.updateMessageMeta(payload.messageId!, {
          streamReconnect: buildStreamReconnectMeta(payload),
        });
        break;

      case 'stream_complete':
        if (
          shouldIgnoreStreamLifecycleEvent(payload, {
            currentStreamingMessageId: host.getCurrentState().currentStreamingMessageId,
            expectation: host.streamExpectation,
            lastStreamGenerationByMessageId: host.lastStreamGenerationByMessageId,
          })
        ) {
          console.warn(LOG_PREFIX, 'Ignore stale stream_complete:', {
            messageId: payload.messageId,
            currentStreamingMessageId: host.getCurrentState().currentStreamingMessageId,
            expectation: host.streamExpectation,
            eventTimestamp: payload.timestamp,
          });
          break;
        }
        // 流式完成 - 重置状态为 idle
        console.log(
          LOG_PREFIX,
          'Stream complete for message:',
          payload.messageId,
          'duration:',
          payload.durationMs,
          'ms'
        );
        host.scheduleStreamCompletion(payload);
        break;

      case 'stream_error': {
        if (
          shouldIgnoreStreamLifecycleEvent(payload, {
            currentStreamingMessageId: host.getCurrentState().currentStreamingMessageId,
            expectation: host.streamExpectation,
            lastStreamGenerationByMessageId: host.lastStreamGenerationByMessageId,
          })
        ) {
          console.warn(LOG_PREFIX, 'Ignore stale stream_error:', {
            messageId: payload.messageId,
            currentStreamingMessageId: host.getCurrentState().currentStreamingMessageId,
            expectation: host.streamExpectation,
            eventTimestamp: payload.timestamp,
          });
          break;
        }
        host.cancelPendingStreamCompletion();
        host.clearStreamExpectation(payload.messageId);
        // 流式错误 - 重置状态为 idle
        chunkBuffer.flushSession(host.sessionId);
        // 🔧 P2修复：先重置状态确保 UI 响应，再异步保存
        // 先归一化再收尾，孤儿 preparing 块才能显示后端真实原因而不是通用兜底文案
        const contextOverflow = payload.payload?.code === 'CONTEXT_WINDOW_EXCEEDED';
        const streamError = normalizeStreamTerminalError(payload.error, payload.payload?.code);
        host.store.completeStream('error', streamError);
        host.store.updateMessageMeta(
          payload.messageId!,
          streamErrorMetaPatch(streamError),
        );
        handleStreamAbort(host.store).catch((err) => {
          reportAdapterError({
            code: 'stream_cleanup_failed',
            level: 'dev',
            sessionId: host.sessionId,
            message: 'Error in handleStreamAbort after stream_error',
            cause: err,
          });
        });
        // 显示错误提示（经 errorChannel，避免黑盒 console.error）
        if (payload.error) {
          reportAdapterError({
            code: 'stream_error',
            level: 'user',
            sessionId: host.sessionId,
            message: streamError,
            title: i18n.t('chatV2:error.streamInterrupted'),
            cause: payload.error,
            retryable: false,
            action: contextOverflow && payload.messageId ? {
              label: i18n.t('chatV2:error.chooseLargerModel'),
              onClick: () => {
                host.getCurrentState().setModelRetryTarget(payload.messageId!);
                host.getCurrentState().setPanelState('model', true);
              },
            } : undefined,
            storeApi: host.getErrorStoreApi(),
          });
        }
        break;
      }

      case 'stream_cancelled':
        if (
          shouldIgnoreStreamLifecycleEvent(payload, {
            currentStreamingMessageId: host.getCurrentState().currentStreamingMessageId,
            expectation: host.streamExpectation,
            lastStreamGenerationByMessageId: host.lastStreamGenerationByMessageId,
          })
        ) {
          console.warn(LOG_PREFIX, 'Ignore stale stream_cancelled:', {
            messageId: payload.messageId,
            currentStreamingMessageId: host.getCurrentState().currentStreamingMessageId,
            expectation: host.streamExpectation,
            eventTimestamp: payload.timestamp,
          });
          break;
        }
        host.cancelPendingStreamCompletion();
        host.clearStreamExpectation(payload.messageId);
        // 流式被取消 - 由 abortStream 处理状态重置
        console.log(LOG_PREFIX, 'Stream cancelled for message:', payload.messageId);
        chunkBuffer.flushSession(host.sessionId);
        // 🔧 P2修复：先重置状态确保 UI 响应，再异步保存
        // 用户主动取消时，abortStream 可能已经重置了状态
        // completeStream 内部会检查状态，如果已经是 idle 则不会重复处理
        host.store.completeStream('cancelled');
        host.store.updateMessageMeta(
          payload.messageId!,
          clearStreamReconnectMetaPatch(),
        );
        // 用户取消时也清空多变体 ID
        host.store.setPendingParallelModelIds(null);
        handleStreamAbort(host.store).catch((err) => {
          reportAdapterError({
            code: 'stream_cleanup_failed',
            level: 'dev',
            sessionId: host.sessionId,
            message: 'Error in handleStreamAbort after stream_cancelled',
            cause: err,
          });
        });
        break;

      case 'save_complete':
        console.log(LOG_PREFIX, 'Session saved successfully');
        clearAdapterErrorFlag(host.sessionId, host.getErrorStoreApi(), ['session_save_failed']);
        break;

      case 'save_error':
        reportAdapterError({
          code: 'session_save_failed',
          level: 'user',
          sessionId: host.sessionId,
          message: i18n.t('chatV2:error.saveFailedDesc'),
          title: i18n.t('chatV2:error.saveFailed'),
          cause: payload.error,
          retryable: true,
          retry: () => host.saveSession(),
          storeApi: host.getErrorStoreApi(),
        });
        break;

      case 'summary_updated':
        // 摘要自动生成完成 - 同时更新标题和简介
        console.log(LOG_PREFIX, 'Session summary updated:', {
          title: payload.title,
          description: payload.description,
        });
        if (payload.title) {
          host.store.setSummary(payload.title, payload.description ?? '');
          // 通知侧边栏等组件刷新会话列表
          window.dispatchEvent(new CustomEvent('chat-v2:sessions-updated'));
        }
        break;

      case 'goal_updated':
        // goal 模式 P0：后端目标状态变更（创建/暂停/恢复/编辑/续跑计数），
        // payload.goal 为 null 表示目标已清除。setGoal 驱动顶栏
        // GoalStatusChip 自动更新。
        host.store.setGoal(payload.goal ?? null);
        break;

      case 'variant_deleted':
        // 变体删除事件 - 后端已完成删除，前端同步状态
        host.handleVariantDeleted(payload);
        break;

      case 'compaction_started': {
        if (host.getCurrentState().compactionInProgress) break;
        host.store.setCompactionInProgress(true);
        showGlobalNotification(
          'info',
          i18n.t('chatV2:compaction.started'),
          i18n.t('chatV2:compaction.startedTitle'),
        );
        break;
      }

      case 'compaction_finished':
        host.store.setCompactionInProgress(false);
        break;

      case 'compaction_completed': {
        // 🆕 压缩已落盘：立即写入水位覆盖值，上下文水位环不等下一轮 usage 即刷新。
        // 覆盖值在下一轮真实 usage 到达时由 eventBridge 清除。
        const completed = parseCompactionCompletedPayload(payload.payload);
        host.store.setCompactionInProgress(false);
        if (completed?.tokensAfter && completed.tokensAfter > 0) {
          host.store.setContextUsageOverride({
            sessionId: host.sessionId,
            tokensAfter: completed.tokensAfter,
          });
        }
        showGlobalNotification(
          'success',
          completed?.tokensBefore && completed.tokensAfter
            ? i18n.t('chatV2:compaction.completedWithUsage', {
                before: completed.tokensBefore.toLocaleString(),
                after: completed.tokensAfter.toLocaleString(),
              })
            : i18n.t('chatV2:compaction.completed'),
          i18n.t('chatV2:compaction.completedTitle'),
        );
        break;
      }

      case 'compaction_failed': {
        // Keep the complete history on failure; never imply successful compaction.
        host.store.setCompactionInProgress(false);
        const reason = parseCompactionFailedReason(payload.payload);
        const reasonText = i18n.t(`chatV2:${compactionReasonI18nKey(reason)}`);
        showGlobalNotification(
          'warning',
          i18n.t('chatV2:compaction.autoFailed', {
            reason: reasonText,
          }),
          i18n.t('chatV2:compaction.autoFailedTitle'),
        );
        break;
      }

      case 'context_trimmed': {
        // FIFO 截断实际丢弃消息：温和提示 + 同会话 30s 合并节流
        const trimmed = parseContextTrimmedPayload(payload.payload);
        if (!trimmed) break;
        const decision = contextTrimThrottle.record(host.sessionId, trimmed);
        if (!decision.notify) break;
        showGlobalNotification(
          'info',
          i18n.t('chatV2:compaction.contextTrimmed', {
            count: decision.droppedMessages,
          }),
          i18n.t('chatV2:compaction.contextTrimmedTitle'),
          { borderTone: 'neutral' },
        );
        break;
      }

      default:
        console.warn(LOG_PREFIX, 'Unknown session event type:', payload.eventType);
    }
  } catch (error) {
    reportAdapterError({
      code: 'session_event_failed',
      level: 'dev',
      sessionId: host.sessionId,
      message: 'Error handling session event',
      cause: error,
    });
  }
}

/**
 * 处理 variant_deleted 事件
 * 
 * 后端删除变体后发射此事件，前端需要同步更新本地状态。
 * 
 * Payload 结构：
 * - messageId: 消息 ID
 * - variantId: 被删除的变体 ID
 * - remainingCount: 剩余变体数量
 * - newActiveVariantId: 新的激活变体 ID（可选）
 */
export function handleVariantDeleted(host: TauriAdapterHost, payload: SessionEventPayload): void {
  const { messageId, variantId, newActiveVariantId, remainingCount } = payload;

  if (!messageId || !variantId) {
    console.warn(LOG_PREFIX, 'variant_deleted event missing messageId or variantId:', payload);
    return;
  }

  console.log(LOG_PREFIX, 'Variant deleted event received:', {
    messageId,
    variantId,
    remainingCount,
    newActiveVariantId,
  });

  // 获取当前状态
  const currentState = host.getCurrentState();
  const message = currentState.messageMap.get(messageId);

  if (!message) {
    console.warn(LOG_PREFIX, 'variant_deleted: Message not found:', messageId);
    return;
  }

  const variants = message.variants ?? [];
  const variantIndex = variants.findIndex((v) => v.id === variantId);

  if (variantIndex === -1) {
    // 变体可能已经被前端删除（例如用户主动调用 deleteVariant）
    // 这种情况下忽略事件，避免重复处理
    console.log(LOG_PREFIX, 'variant_deleted: Variant already removed from frontend:', variantId);
    return;
  }

  // 获取要删除的变体的 blockIds（用于清理 blocks Map）
  const variantToDelete = variants[variantIndex];
  const blockIdsToDelete = variantToDelete.blockIds ?? [];

  // 使用 storeApi 更新状态（如果可用），否则回退到 store
  const storeApi = host.storeApi ?? sessionManager.get(host.sessionId);
  
  if (storeApi) {
    storeApi.setState((s) => {
      const newMessageMap = new Map(s.messageMap);
      const newBlocks = new Map(s.blocks);
      const newStreamingVariantIds = new Set(s.streamingVariantIds);

      const msg = newMessageMap.get(messageId);
      if (msg) {
        // 移除被删除的变体
        const newVariants = (msg.variants ?? []).filter((v) => v.id !== variantId);
        
        // 使用后端返回的 newActiveVariantId，如果没有则保持当前激活状态
        // 如果当前激活的变体被删除，则选择第一个变体
        let newActiveId = msg.activeVariantId;
        if (newActiveVariantId) {
          newActiveId = newActiveVariantId;
        } else if (msg.activeVariantId === variantId && newVariants.length > 0) {
          newActiveId = newVariants[0].id;
        }

        const newActiveVariant = newVariants.find((v) => v.id === newActiveId);

        newMessageMap.set(messageId, {
          ...msg,
          variants: newVariants,
          activeVariantId: newActiveId,
          _meta: newActiveVariant?.modelId
            ? { ...(msg._meta ?? {}), modelId: newActiveVariant.modelId }
            : msg._meta,
        });
      }

      // 清理被删除变体关联的 blocks
      for (const blockId of blockIdsToDelete) {
        newBlocks.delete(blockId);
      }

      // 从 streamingVariantIds 中移除（如果变体正在流式中）
      newStreamingVariantIds.delete(variantId);

      return {
        messageMap: newMessageMap,
        blocks: newBlocks,
        streamingVariantIds: newStreamingVariantIds,
      };
    });

    console.log(LOG_PREFIX, 'variant_deleted: Frontend state synced:', {
      variantId,
      blocksRemoved: blockIdsToDelete.length,
    });
  } else {
    console.error(LOG_PREFIX, 'variant_deleted: Cannot update state - no storeApi available');
  }
}
