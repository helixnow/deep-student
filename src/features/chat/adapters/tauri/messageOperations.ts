/**
 * Chat V2 - TauriAdapter 拆分模块 —— 消息操作：中断、重试、编辑重发、删除、消息内继续执行
 *
 * 自 TauriAdapter.ts 拆出（行为不变）；函数首参 host 为适配器实例，
 * 由 ChatV2TauriAdapter 同名方法委托调用。
 */

import { invoke } from '@tauri-apps/api/core';
import i18n from 'i18next';
import { formatUserFacingErrorWithThinkingBudgetHint, getErrorMessage } from '@/utils/errorUtils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { reportAdapterError } from '../errors/adapterErrorChannel';
import { resetBridgeState } from '../../core/middleware/eventBridge';
// 🔧 优化：sessionManager 仅用于获取元数据，不再用于获取 Store 状态
// 构造函数现在接收 storeApi 参数，消除了循环依赖的核心问题
import { sessionManager } from '../../core/session/sessionManager';
import type { EditMessageResult, RetryMessageResult } from '../types';
import {
  buildSendContextRefsWithPaths,
  validateAndCleanupContextRefs,
  truncateContextByTokens,
} from '../contextHelper';
import type { ContextRef } from '../../resources/types';
import {
  filterStagedPathMap,
  materializeRetainedBinaryContextRefs,
} from '../attachmentMaterialization';
import { LOG_PREFIX, adapterConsole as console } from './diagnostics';
import { normalizeStreamTerminalError } from './errors';
import { ABORT_TIMEOUT_MS } from './streamLifecycle';
import type { TauriAdapterHost } from './adapterHost';

export async function abortStream(host: TauriAdapterHost): Promise<void> {
  console.log(LOG_PREFIX, 'Aborting stream...');

  try {
    // 直接调用 Store 的 abortStream，它会通过回调通知后端
    await host.store.abortStream();
    console.log(LOG_PREFIX, 'Stream aborted');
  } catch (error) {
    // 强制重置前端状态
    console.warn(LOG_PREFIX, 'Forcing frontend state reset');
    host.store.forceResetToIdle?.();
    reportAdapterError({
      code: 'abort_failed',
      level: 'user',
      sessionId: host.sessionId,
      message: i18n.t('chatV2:error.abortFailedMessage'),
      title: i18n.t('chatV2:error.abortFailed'),
      cause: error,
      retryable: false,
      storeApi: host.getErrorStoreApi(),
    });
    throw error;
  }
}

/**
 * 执行中断操作（内部方法，供 callback 使用）
 * 仅通知后端取消，不更新本地状态（由 Store 的 abortStream 处理）
 * 
 * 包含超时保护机制：如果后端取消请求超过 10 秒未响应，
 * 静默超时让调用方继续执行。
 */
export async function executeAbort(host: TauriAdapterHost): Promise<void> {
  console.log(LOG_PREFIX, 'Execute abort (backend only)...');

  // 🔧 2026-01-15: 超时机制已移除

  // 获取当前流式消息 ID（使用 getCurrentState 获取最新状态）
  const currentMessageId = host.getCurrentState().currentStreamingMessageId;
  if (!currentMessageId) {
    console.warn(LOG_PREFIX, 'No streaming message to abort');
    host.clearStreamExpectation();
    return;
  }

  try {
    // 带超时保护地通知后端取消
    const backendAbort = invoke('chat_v2_cancel_stream', {
      sessionId: host.sessionId,
      messageId: currentMessageId,
    });

    // 创建超时 Promise
    const timeout = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), ABORT_TIMEOUT_MS);
    });

    // 使用 Promise.race 实现超时保护
    const result = await Promise.race([
      backendAbort.then(() => 'success' as const),
      timeout,
    ]);

    if (result === 'timeout') {
      console.warn(
        LOG_PREFIX,
        `Abort backend timeout after ${ABORT_TIMEOUT_MS}ms`
      );
    } else {
      console.log(LOG_PREFIX, 'Backend abort successful');
    }
  } catch (error) {
    console.error(LOG_PREFIX, 'Backend abort failed:', getErrorMessage(error));
    // 不抛出错误，让 Store 继续更新本地状态
  }
}

/**
 * 执行重试操作（内部方法，供 callback 使用）
 * 🆕 P1 状态同步修复: 返回完整的 RetryMessageResult
 * @returns 重试结果，包含消息 ID 和状态变更信息
 */
export async function executeRetry(
  host: TauriAdapterHost,
  messageId: string,
  modelOverride?: string
): Promise<RetryMessageResult> {
  console.log(LOG_PREFIX, 'Executing retry for message:', messageId, 'model override:', modelOverride);

  try {
    host.beginStreamExpectation(messageId);
    // 🔧 修复：重置事件桥接状态（确保序列号从 0 开始，与 executeSendMessage 保持一致）
    resetBridgeState(host.sessionId);

    const currentParams = host.getCurrentState().chatParams;
    const activeModelId = currentParams.model2OverrideId || currentParams.modelId;
    await host.ensureModelMetadataReady(activeModelId);
    const options = host.applyOriginalReplaySkillState(
      messageId,
      await host.buildSendOptions(),
      host.getCurrentState().chatParams.selectedMcpServers,
    );
    const validIds = await host.getValidChatModelIdSet();
    await host.applyRuntimeModelSelection(options);
    if (modelOverride) {
      const trimmedOverride = modelOverride.trim();
      if (trimmedOverride && (validIds.size === 0 || validIds.has(trimmedOverride))) {
        options.modelId = trimmedOverride;
        options.model2OverrideId = trimmedOverride;
        await host.ensureModelMetadataReady(trimmedOverride);
        host.applyRuntimeThinkingCapability(options);
        host.applyRuntimeContextBudget(options);
      }
    }

    // 🔧 2026-01-15: 超时机制已移除

    // 🆕 P1 状态同步修复: 后端返回增强的结果，包含状态变更信息
    const result = await invoke<{
      message_id?: string;
      new_variant_id?: string;
      deleted_variant_ids?: string[];
    }>('chat_v2_retry_message', {
      sessionId: host.sessionId,
      messageId,
      options,
    });

    const returnedMessageId = result.message_id ?? messageId;
    const newVariantId = result.new_variant_id;
    const deletedVariantIds = result.deleted_variant_ids ?? [];

    console.log(LOG_PREFIX, 'Retry initiated:', {
      messageId: returnedMessageId,
      newVariantId,
      deletedVariantIds: deletedVariantIds.length,
    });
    if (returnedMessageId && returnedMessageId !== messageId) {
      host.setStreamExpectationMessageId(returnedMessageId);
    }

    // 🆕 P1 状态同步修复: 返回完整的状态变更信息
    return {
      success: true,
      messageId: returnedMessageId,
      newVariantId,
      deletedVariantIds: deletedVariantIds.length > 0 ? deletedVariantIds : undefined,
    };
  } catch (error) {
    host.clearStreamExpectation(messageId);
    const errorMsg = getErrorMessage(error);
    console.error(LOG_PREFIX, 'Retry failed:', errorMsg);
    // 显示错误提示（使用 i18n）
    showGlobalNotification('error', formatUserFacingErrorWithThinkingBudgetHint(
      error,
      'chatV2:messageItem.actions.retryFailed',
      'Retry failed',
    ));
    throw error;
  } finally {
    // 无论成功/失败都清理重试阶段暂存的并行模型，避免污染下一次普通发送
    host.store.setPendingParallelModelIds(null);
  }
}

export async function retryMessage(host: TauriAdapterHost, messageId: string, modelOverride?: string): Promise<void> {
  console.log(LOG_PREFIX, 'Retrying message (direct call):', messageId, 'model override:', modelOverride);
  console.warn(
    LOG_PREFIX,
    'retryMessage() called directly. Prefer using store.retryMessage() instead.'
  );

  try {
    // 通过 store 的 retryMessage 方法处理
    // 它会自动调用注入的 _retryCallback（即 executeRetry）
    // 并正确更新本地状态和启动超时监控
    await host.store.retryMessage(messageId, modelOverride);

    console.log(LOG_PREFIX, 'Retry completed:', messageId);
  } catch (error) {
    console.error(LOG_PREFIX, 'Retry message failed:', getErrorMessage(error));
    throw error;
  }
}

export async function editAndResend(host: TauriAdapterHost, messageId: string, newContent: string): Promise<void> {
  console.log(LOG_PREFIX, 'Edit and resend (direct call):', messageId);
  console.warn(
    LOG_PREFIX,
    'editAndResend() called directly. Prefer using store.editAndResend() instead.'
  );

  try {
    // 通过 store 的 editAndResend 方法处理
    // 它会自动调用注入的 _editAndResendCallback（即 executeEditAndResend）
    // 并正确更新本地状态和启动超时监控
    await host.store.editAndResend(messageId, newContent);

    console.log(LOG_PREFIX, 'Edit and resend completed:', messageId);
  } catch (error) {
    console.error(LOG_PREFIX, 'Edit and resend failed:', getErrorMessage(error));
    throw error;
  }
}

/**
 * 执行删除操作（内部方法，供 callback 使用）
 */
export async function executeDelete(host: TauriAdapterHost, messageId: string): Promise<void> {
  console.log(LOG_PREFIX, 'Executing delete for message:', messageId);

  try {
    await invoke('chat_v2_delete_message', {
      sessionId: host.sessionId,
      messageId,
    });

    console.log(LOG_PREFIX, 'Message deleted from backend:', messageId);
  } catch (error) {
    console.error(LOG_PREFIX, 'Delete message failed:', getErrorMessage(error));
    throw error;
  }
}

export async function deleteMessage(host: TauriAdapterHost, messageId: string): Promise<void> {
  console.log(LOG_PREFIX, 'Deleting message (direct call):', messageId);
  console.warn(
    LOG_PREFIX,
    'deleteMessage() called directly. Prefer using store.deleteMessage() instead.'
  );

  try {
    // 通过 store 的 deleteMessage 方法处理
    // 它会自动调用注入的 _deleteCallback（即 executeDelete）
    // 并正确更新本地状态
    await host.store.deleteMessage(messageId);

    console.log(LOG_PREFIX, 'Message deleted:', messageId);
  } catch (error) {
    console.error(LOG_PREFIX, 'Delete message failed:', getErrorMessage(error));
    throw error;
  }
}

/**
 * 执行编辑并重发操作（内部方法，供 callback 使用）
 * 🆕 P1-2: 支持传递新的上下文引用
 * 🆕 P1 状态同步修复: 返回完整的 EditMessageResult
 * @returns 编辑结果，包含新消息 ID 和状态变更信息
 */
export async function executeEditAndResend(
  host: TauriAdapterHost,
  messageId: string,
  newContent: string,
  newContextRefs?: ContextRef[]
): Promise<EditMessageResult> {
  console.log(LOG_PREFIX, 'Executing editAndResend for message:', messageId, 'newContextRefs:', newContextRefs?.length ?? 0);

  try {
    // 🔧 修复：重置事件桥接状态（确保序列号从 0 开始，与 executeSendMessage 保持一致）
    resetBridgeState(host.sessionId);

    const currentParams = host.getCurrentState().chatParams;
    const activeModelId = currentParams.model2OverrideId || currentParams.modelId;
    await host.ensureModelMetadataReady(activeModelId);
    const options = host.applyOriginalReplaySkillState(
      messageId,
      await host.buildSendOptions(),
      host.getCurrentState().chatParams.selectedMcpServers,
    );
    await host.applyRuntimeModelSelection(options);

    // 🔧 2026-01-15: 超时机制已移除

    // 🆕 P1-2: 如果有新的上下文引用，构建 SendContextRef[]
    // ★ 根据当前模型的多模态能力决定注入图片还是文本
    // 注意：editAndResend 的新消息由后端创建，pathMap 在后端保存时处理
    let newContextRefsForBackend = undefined;
    let newPathMap: Record<string, string> | undefined;
    if (newContextRefs) {
      if (newContextRefs.length === 0) {
        // 显式清空上下文引用（传 [] 给后端，而不是 undefined）
        newContextRefsForBackend = [];
      } else {
        // 🆕 P1 修复：验证并清理已删除的资源引用
        const validContextRefs = await validateAndCleanupContextRefs(
          host.storeApi ?? host.store,
          newContextRefs,
          { notifyUser: true, logDetails: true }
        );
        console.log(LOG_PREFIX, 'Building SendContextRefs for editAndResend:', validContextRefs.length, '(validated from', newContextRefs.length, ')');
        // All resources may have been removed. Keep the replacement explicit:
        // undefined asks the backend to restore the original snapshot instead.
        newContextRefsForBackend = [];
        
        if (validContextRefs.length > 0) {
          const currentModelId = options.modelId;
          const isMultimodal = await host.shouldResolveContextAsMultimodal(options);
          const { sendRefs, pathMap, binaryStageCandidates } = await buildSendContextRefsWithPaths(validContextRefs, { isMultimodal });

          // Token 预估和截断（基于模型预算，防止上下文过长）
          const contextTokenLimit = host.getContextTruncateLimit(options.contextLimit);
          const truncateResult = truncateContextByTokens(sendRefs, contextTokenLimit);

          if (truncateResult.wasTruncated) {
            console.warn(
              LOG_PREFIX,
              'Context truncated for editAndResend:',
              `original=${truncateResult.originalTokens} tokens,`,
              `final=${truncateResult.finalTokens} tokens,`,
              `removed=${truncateResult.removedCount} refs`
            );
            host.notifyContextTruncated(truncateResult.removedCount);
          }

          newContextRefsForBackend = truncateResult.truncatedRefs;
          const stagedPathMap = await materializeRetainedBinaryContextRefs(
            host.sessionId,
            truncateResult.truncatedRefs,
            binaryStageCandidates,
            pathMap,
          );
          const keptIds = new Set(truncateResult.truncatedRefs.map((ref) => ref.resourceId));
          const filteredPathMap = filterStagedPathMap(stagedPathMap, keptIds);
          newPathMap = Object.keys(filteredPathMap).length > 0 ? filteredPathMap : undefined;
          if (newPathMap) {
            console.log(LOG_PREFIX, 'PathMap for editAndResend:', Object.keys(newPathMap).length, 'entries');
          }
        }
      }
    }

    // 🆕 P1 状态同步修复: 后端返回增强的结果，包含状态变更信息
    const result = await invoke<{
      new_message_id?: string;
      deleted_message_ids?: string[];
      new_variant_id?: string;
    }>('chat_v2_edit_and_resend', {
      sessionId: host.sessionId,
      messageId,
      newContent,
      // 🆕 P1-2: 传递新的上下文引用给后端
      newContextRefs: newContextRefsForBackend,
      newPathMap,
      options,
    });

    // 发送成功后清空多变体 ID
    host.store.setPendingParallelModelIds(null);

    const newMessageId = result.new_message_id ?? null;
    const deletedMessageIds = result.deleted_message_ids ?? [];
    const newVariantId = result.new_variant_id;
    if (newMessageId) {
      host.beginStreamExpectation(newMessageId);
    }

    console.log(LOG_PREFIX, 'Edit and resend initiated:', {
      newMessageId,
      deletedMessageIds: deletedMessageIds.length,
      newVariantId,
    });

    // 🆕 P1 状态同步修复: 返回完整的状态变更信息
    return {
      success: true,
      newMessageId: newMessageId ?? undefined,
      deletedMessageIds: deletedMessageIds.length > 0 ? deletedMessageIds : undefined,
      newVariantId,
    };
  } catch (error) {
    const errorMsg = getErrorMessage(error);
    console.error(LOG_PREFIX, 'Edit and resend failed:', errorMsg);
    // 显示错误提示（使用 i18n）
    showGlobalNotification('error', formatUserFacingErrorWithThinkingBudgetHint(
      error,
      'chatV2:messageItem.actions.editFailed',
      'Edit and resend failed',
    ));
    // 🆕 P1 状态同步修复: 返回失败结果而不是抛出异常
    // 让 Store 有机会处理失败情况
    throw error;
  }
}

export async function continueMessage(host: TauriAdapterHost, messageId: string, variantId?: string): Promise<void> {
  console.log(LOG_PREFIX, 'Continue message:', messageId, 'variant:', variantId);

  try {
    host.beginStreamExpectation(messageId);
    // 重置事件桥接状态
    resetBridgeState(host.sessionId);

    const currentParams = host.getCurrentState().chatParams;
    const activeModelId = currentParams.model2OverrideId || currentParams.modelId;
    await host.ensureModelMetadataReady(activeModelId);
    const options = host.applyOriginalReplaySkillState(
      messageId,
      await host.buildSendOptions(),
      host.getCurrentState().chatParams.selectedMcpServers,
    );
    await host.applyRuntimeModelSelection(options);

    // 🔧 竞态修复：invoke 前立即设置 streaming 状态，防止窗口期内重复点击
    // 与 sendMessageWithIds / retryVariant 保持一致
    host.store.setCurrentStreamingMessage(messageId);
    const storeApi = host.storeApi ?? sessionManager.get(host.sessionId);
    if (storeApi) {
      storeApi.setState({ sessionStatus: 'streaming' as const });
    }

    const resultMessageId = await invoke<string>('chat_v2_continue_message', {
      sessionId: host.sessionId,
      messageId,
      variantId,
      options,
    });

    console.log(LOG_PREFIX, 'Continue message initiated:', resultMessageId);
    
    // 更新流式消息 ID
    if (resultMessageId && resultMessageId !== messageId) {
      host.setStreamExpectationMessageId(resultMessageId);
      host.store.setCurrentStreamingMessage(resultMessageId);
    }
  } catch (error) {
    host.clearStreamExpectation(messageId);
    const errorMsg = getErrorMessage(error);
    console.error(LOG_PREFIX, 'Continue message failed:', errorMsg);
    // 清除流式状态
    // 🔧 修复：同时清除 stale currentStreamingMessageId（completeStream 在 idle 时不清除它）
    host.store.completeStream('error', normalizeStreamTerminalError(error));
    host.store.setCurrentStreamingMessage(null);
    // 🔧 修复：不在此处显示通知，让 store.continueMessage 的 fallback（sendMessage）处理
    // 原代码在此显示 "继续执行失败" 通知，但 store 会 fallback 到 sendMessage('继续')，
    // 导致用户看到一个无意义的错误通知
    throw error;
  }
}
