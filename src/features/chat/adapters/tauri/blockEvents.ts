/**
 * Chat V2 - TauriAdapter 拆分模块 —— 块级事件（chat_v2_event_{id}）与后端真实 LLM 请求体事件处理
 *
 * 自 TauriAdapter.ts 拆出（行为不变）；函数首参 host 为适配器实例，
 * 由 ChatV2TauriAdapter 同名方法委托调用。
 */

import { getErrorMessage } from '@/utils/errorUtils';
import { reportAdapterError } from '../errors/adapterErrorChannel';
import type { BackendEvent } from '../../core/middleware/eventBridge';
import { handleBackendEventWithSequence } from '../../core/middleware/eventBridge';
import { logMultiVariant } from '@/debug-panel/plugins/MultiVariantDebugPlugin';
import {
  emitTemplateDesignerToolEvent,
  isTemplateDesignerToolName,
} from '../../debug/templateDesignerDebug';
import { LOG_PREFIX, adapterConsole as console } from './diagnostics';
import { matchesLlmRequestBodySession } from './sessionEvents';
import type { TauriAdapterHost, LlmRequestBodyEventPayload } from './adapterHost';

/** rawRequests 中保留完整请求体的最近轮次数（更早轮次 body 置为占位符防止内存无上限增长） */
const MAX_FULL_RAW_REQUEST_ROUNDS = 10;
/** 被截断轮次的 body 占位符 */
const RAW_REQUEST_BODY_TRUNCATED = '[truncated]';

/**
 * 处理块级事件
 */
export function handleBlockEvent(host: TauriAdapterHost, event: BackendEvent): void {
  if (!host.isSessionRuntimeOwner()) return;
  try {
    // ChatAnki 工具调用拦截 — 捕获 tool_call 的 start/end/error 供调试面板显示
    {
      const payloadToolName = (event.payload as any)?.toolName || '';
      const blockToolName = event.blockId
        ? host.getCurrentState().blocks.get(event.blockId)?.toolName || ''
        : '';
      const toolName = payloadToolName || blockToolName;
      const isChatAnkiTool = toolName.includes('chatanki');
      const isAnkiCardsEvent = event.type === 'anki_cards';
      if (isChatAnkiTool || isAnkiCardsEvent) {
        const chunkSize = typeof event.chunk === 'string' ? event.chunk.length : 0;
        const shouldLogChunk = event.phase !== 'chunk' || (() => {
          const key = event.blockId || `${event.type}:${event.messageId || 'unknown'}`;
          const next = (host.chatAnkiChunkLogCounter.get(key) ?? 0) + 1;
          host.chatAnkiChunkLogCounter.set(key, next);
          return next % 10 === 1; // chunk 日志每 10 条记录 1 条，避免刷屏
        })();
        if (shouldLogChunk) {
          try {
            window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
              level: event.phase === 'error' ? 'error' : 'debug',
              phase: 'bridge:event',
              summary: `${event.type}:${event.phase} ${toolName || ''} ${chunkSize ? `chunk=${chunkSize}` : ''}`.trim(),
              blockId: event.blockId,
              detail: {
                messageId: event.messageId,
                sequenceId: event.sequenceId,
                variantId: event.variantId,
                payload: event.payload,
                result: event.result,
                error: event.error,
              },
            }}));
          } catch { /* debug only */ }
        }

        // ★ 性能：chunk 阶段复用上方 1/10 采样（shouldLogChunk），避免流式期间
        // 每个 chunk 都同步 dispatch 一次 window 事件；start/end/error 全量派发
        if (shouldLogChunk) {
          try {
            window.dispatchEvent(new CustomEvent('chatanki-debug-tool-block', { detail: {
              type: event.type,
              phase: event.phase,
              toolName: toolName || event.type,
              blockId: event.blockId,
              toolInput: (event.payload as any)?.toolInput,
              toolOutput: event.result,
              result: event.result,
              error: event.error,
              payload: event.payload,
            }}));
          } catch { /* */ }
        }
      }

      if (isTemplateDesignerToolName(toolName)) {
        try {
          emitTemplateDesignerToolEvent({
            type: event.type,
            phase: event.phase,
            toolName,
            blockId: event.blockId,
            toolInput: (event.payload as any)?.toolInput,
            toolOutput: event.result,
            result: event.result,
            error: event.error,
            payload: event.payload,
          });
        } catch {
          // ignore debug failures
        }
      }
    }

    // 🔧 调试打点：追踪多变体事件接收
    // 🚀 性能：content/thinking 的 chunk 阶段按 1/10 采样（与上方 chatanki 模式一致），
    // 避免多变体流式期间每个 token 级 chunk 都记录一条日志
    const isHotStreamChunk = event.phase === 'chunk'
      && (event.type === 'content' || event.type === 'thinking');
    const shouldLogVariantEvent = !isHotStreamChunk || ++host.variantChunkLogCounter % 10 === 1;
    if (shouldLogVariantEvent && (event.variantId || event.type === 'variant_start' || event.type === 'variant_end')) {
      logMultiVariant('adapter', 'event_received', {
        type: event.type,
        phase: event.phase,
        variantId: event.variantId,
        messageId: event.messageId,
        blockId: event.blockId,
        sequenceId: event.sequenceId,
        willUseVariantHandler: !!event.variantId,
      }, 'info');
    }

    // 🔧 优化：统一使用带序列号检查的处理器
    // 1. 单变体和多变体模式都使用相同的乱序缓冲和去重机制
    // 2. handleBackendEventWithSequence 内部已有向后兼容逻辑：
    //    - 如果 sequenceId 为 undefined，直接处理（不阻塞）
    //    - 如果有 sequenceId，进行乱序检测、缓冲和去重
    // 3. 这样可以提高单变体模式的鲁棒性，防止网络抖动导致的事件乱序
    // 🔧 2026-01-18 修复：使用 getCurrentState() 获取最新状态
    // 之前使用 this.store（构造时的快照），导致 tool_call 事件处理时
    // 无法找到刚创建的 preparing 块（因为 blocks Map 是旧的）
    handleBackendEventWithSequence(host.getCurrentState(), event);
  } catch (error) {
    logMultiVariant('adapter', 'event_error', {
      type: event.type,
      variantId: event.variantId,
      error: getErrorMessage(error),
    }, 'error');
    reportAdapterError({
      code: 'block_event_failed',
      level: 'dev',
      sessionId: host.sessionId,
      message: `Error handling block event (${event.type})`,
      cause: error,
    });
  } finally {
    host.touchPendingStreamCompletion();
  }
}

/**
 * ★ 2026-02-14: 处理后端真实 LLM 请求体事件
 *
 * 后端在构建并脱敏 LLM 请求体后通过 `chat_v2_llm_request_body` 全局事件推送。
 * 此方法按 streamEvent 中的 session_id 过滤，仅处理当前会话的事件，
 * 然后将 rawRequest 更新为后端的真实请求体（替换之前保存的前端请求）。
 */
export function handleLlmRequestBody(host: TauriAdapterHost, payload: LlmRequestBodyEventPayload): void {
  if (!host.isSessionRuntimeOwner()) return;
  if (!matchesLlmRequestBodySession(payload.streamEvent, host.sessionId)) {
    return;
  }

  const state = host.getCurrentState();
  const expectedMessageId = host.streamExpectation?.messageId ?? null;
  const targetMsgId = payload.messageId || state.currentStreamingMessageId || expectedMessageId;

  if (!targetMsgId) return;
  if (
    payload.messageId
    && expectedMessageId
    && payload.messageId !== expectedMessageId
    && state.currentStreamingMessageId !== payload.messageId
  ) {
    console.warn(LOG_PREFIX, 'Ignore stale llm_request_body event:', {
      messageId: payload.messageId,
      expectedMessageId,
      currentStreamingMessageId: state.currentStreamingMessageId,
    });
    return;
  }
  const targetMsg = state.messageMap.get(targetMsgId);
  if (!targetMsg || targetMsg.role !== 'assistant') return;

  const existing = targetMsg._meta?.rawRequests ?? [];
  const entry = {
    _source: 'backend_llm' as const,
    model: payload.model,
    url: payload.url,
    body: payload.requestBody,
    logFilePath: payload.logFilePath ?? undefined,
    round: existing.length + 1,
  };

  // 🚀 内存上限：请求体含全量上下文且跨轮次超线性增长，长 agentic 会话
  // 无上限累积可达数十 MB。仅保留最近 N 轮完整 body，更早轮次置为占位符
  // （保留 model/url/round/logFilePath 元信息，完整内容仍可经 logFilePath 读取）
  const rawRequests = [...existing, entry];
  const truncateBefore = rawRequests.length - MAX_FULL_RAW_REQUEST_ROUNDS;
  for (let i = 0; i < truncateBefore; i++) {
    if (rawRequests[i].body !== RAW_REQUEST_BODY_TRUNCATED) {
      rawRequests[i] = { ...rawRequests[i], body: RAW_REQUEST_BODY_TRUNCATED };
    }
  }

  // rawRequest 保持最新一轮（兼容旧逻辑）
  const rawRequest = {
    _source: 'backend_llm' as const,
    model: payload.model,
    url: payload.url,
    body: payload.requestBody,
    logFilePath: payload.logFilePath ?? undefined,
  };

  state.updateMessageMeta(targetMsgId, { rawRequest, rawRequests });
}
