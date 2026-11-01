/**
 * Chat V2 - TauriAdapter 拆分模块 —— 流式预期（streamExpectation）与 stream_complete 静默窗口结算
 *
 * 自 TauriAdapter.ts 拆出（行为不变）；函数首参 host 为适配器实例，
 * 由 ChatV2TauriAdapter 同名方法委托调用。
 */

import { reportAdapterError } from '../errors/adapterErrorChannel';
import type { ChatStore } from '../../core/types';
import { handleStreamComplete, flushPendingBackendEvents } from '../../core/middleware/eventBridge';
import { chunkBuffer } from '../../core/middleware/chunkBuffer';
import type { SessionEventPayload } from '../types';
import {
  STREAM_COMPLETE_SETTLE_DELAY_MS,
  type PendingStreamCompletion,
  createStreamExpectation,
  withStreamExpectationMessageId,
  syncStreamExpectationState,
  shouldClearStreamExpectation,
  isStaleByExpectationTimestamp as isStaleByExpectationTimestampPure,
  isStaleByStreamGeneration as isStaleByStreamGenerationPure,
  isTargetingCurrentStreamMessage as isTargetingCurrentStreamMessagePure,
  canAdoptRetryReboundStreamStart as canAdoptRetryReboundStreamStartPure,
  clearStreamReconnectMetaPatch,
  forceSettlePendingStreamCompletion as forceSettlePendingStreamCompletionPure,
} from './streamLifecycle';
import type { TauriAdapterHost } from './adapterHost';

export function beginStreamExpectation(host: TauriAdapterHost, messageId: string): void {
  if (!messageId) return;
  host.cancelPendingStreamCompletion();
  host.streamExpectation = createStreamExpectation(messageId);
}

export function setStreamExpectationMessageId(host: TauriAdapterHost, messageId: string): void {
  if (!messageId) return;
  if (!host.streamExpectation) {
    host.beginStreamExpectation(messageId);
    return;
  }
  host.streamExpectation = withStreamExpectationMessageId(host.streamExpectation, messageId);
}

export function syncStreamExpectationFromEvent(
  host: TauriAdapterHost,
  messageId: string,
  timestamp?: number,
  streamGeneration?: number,
): void {
  if (!messageId) return;
  host.streamExpectation = syncStreamExpectationState(
    host.streamExpectation,
    messageId,
    timestamp,
    streamGeneration,
  );
  if (streamGeneration !== undefined) {
    host.lastStreamGenerationByMessageId.set(messageId, streamGeneration);
  }
}

export function clearStreamExpectation(host: TauriAdapterHost, messageId?: string): void {
  if (!shouldClearStreamExpectation(host.streamExpectation, messageId)) return;
  host.streamExpectation = null;
}

export function cancelPendingStreamCompletion(host: TauriAdapterHost): void {
  if (!host.pendingStreamCompletion) return;
  if (host.pendingStreamCompletion.timer !== null) {
    clearTimeout(host.pendingStreamCompletion.timer);
  }
  host.pendingStreamCompletion = null;
}

export function armPendingStreamCompletion(host: TauriAdapterHost, pending: PendingStreamCompletion): void {
  pending.timer = setTimeout(() => {
    if (host.pendingStreamCompletion !== pending) return;
    host.pendingStreamCompletion = null;
    host.settleStreamCompletion(pending.payload);
  }, STREAM_COMPLETE_SETTLE_DELAY_MS);
}

/**
 * stream_complete 收尾执行体：32ms 静默窗口到期后由定时器调用，
 * 或被 goal 续跑的新 stream_start 经 forceSettlePendingStreamCompletion
 * 同步提前调用（见 handleSessionEvent 的 stream_start 分支）。
 */
export function settleStreamCompletion(host: TauriAdapterHost, payload: SessionEventPayload): void {
  if (
    !host.isSessionRuntimeOwner()
    || !payload.messageId
    || !host.isTargetingCurrentStreamMessage(payload.messageId)
    || host.isStaleByStreamGeneration(payload)
    || host.isStaleByExpectationTimestamp(payload)
  ) {
    return;
  }

  // A terminal event can overtake block events from the separate channel.
  // First drain sequence-buffered events, then flush their chunk batches,
  // and only after that tear down the streaming state and bridge context.
  flushPendingBackendEvents(host.getCurrentState());
  chunkBuffer.flushSession(host.sessionId);
  host.clearStreamExpectation(payload.messageId);
  host.store.completeStream('success');
  host.store.updateMessageMeta(
    payload.messageId,
    clearStreamReconnectMetaPatch({ clearTerminalError: true }),
  );
  handleStreamComplete(host.store, {
    messageId: payload.messageId,
    usage: payload.usage,
  }).catch((err) => {
    reportAdapterError({
      code: 'stream_cleanup_failed',
      level: 'dev',
      sessionId: host.sessionId,
      message: 'Error in handleStreamComplete',
      cause: err,
    });
  });
}

/**
 * goal 续跑竞态补丁：新 stream_start 到达时旧轮仍在静默窗口内，
 * 同步结算旧轮（而不是把新轮当冲突丢弃）。
 */
export function forceSettlePendingStreamCompletion(host: TauriAdapterHost): void {
  const pending = host.pendingStreamCompletion;
  if (!pending) return;
  host.pendingStreamCompletion = null;
  forceSettlePendingStreamCompletionPure(pending, (payload) => {
    host.settleStreamCompletion(payload);
  });
}

export function scheduleStreamCompletion(host: TauriAdapterHost, payload: SessionEventPayload): void {
  host.cancelPendingStreamCompletion();
  const pending: PendingStreamCompletion = {
    payload: { ...payload },
    timer: null,
  };
  host.pendingStreamCompletion = pending;
  host.armPendingStreamCompletion(pending);
}

/** Restart the quiet window whenever a block callback arrives. */
export function touchPendingStreamCompletion(host: TauriAdapterHost): void {
  const pending = host.pendingStreamCompletion;
  if (!pending) return;
  if (pending.timer !== null) {
    clearTimeout(pending.timer);
  }
  host.armPendingStreamCompletion(pending);
}

export function isStaleByExpectationTimestamp(host: TauriAdapterHost, payload: SessionEventPayload): boolean {
  return isStaleByExpectationTimestampPure(host.streamExpectation, payload);
}

export function isStaleByStreamGeneration(host: TauriAdapterHost, payload: SessionEventPayload): boolean {
  return isStaleByStreamGenerationPure(
    host.streamExpectation,
    host.lastStreamGenerationByMessageId,
    payload,
  );
}

export function isTargetingCurrentStreamMessage(host: TauriAdapterHost, messageId?: string): boolean {
  return isTargetingCurrentStreamMessagePure(
    messageId,
    host.getCurrentState().currentStreamingMessageId,
    host.streamExpectation?.messageId ?? null,
  );
}

export function canAdoptRetryReboundStreamStart(
  host: TauriAdapterHost,
  state: ChatStore,
  incomingMessageId: string,
  currentStreamingMessageId: string | null,
  expectedMessageId: string | null,
): boolean {
  // 仅当当前流式消息仍是“清空待重试”状态时允许重绑，
  // 避免把普通 stale 事件误接入到现有流。
  const currentMsg = currentStreamingMessageId
    ? state.messageMap.get(currentStreamingMessageId)
    : undefined;
  return canAdoptRetryReboundStreamStartPure(
    incomingMessageId,
    currentStreamingMessageId,
    expectedMessageId,
    state.messageOperationLock,
    currentMsg,
  );
}
