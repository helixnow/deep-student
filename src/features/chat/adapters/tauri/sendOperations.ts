/**
 * Chat V2 - TauriAdapter 拆分模块 —— 发送链路：sendMessage / executeSendMessage / executeWakeSession
 *
 * 自 TauriAdapter.ts 拆出（行为不变）；函数首参 host 为适配器实例，
 * 由 ChatV2TauriAdapter 同名方法委托调用。
 */

import { invoke } from '@tauri-apps/api/core';
import { formatUserFacingErrorWithThinkingBudgetHint, getErrorMessage } from '@/utils/errorUtils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { AttachmentMeta } from '../../core/types';
import { resetBridgeState } from '../../core/middleware/eventBridge';
import { logMultiVariant } from '@/debug-panel/plugins/MultiVariantDebugPlugin';
import type { SendMessageRequest } from '../types';
import {
  buildSendContextRefsWithPaths,
  getPendingContextRefs,
  validateAndCleanupContextRefs,
  logSendContextRefsSummary,
  collectContextTypeHints,
  truncateContextByTokens,
} from '../contextHelper';
import type { ContextSnapshot } from '../../context/types';
import { logAttachment } from '../../debug/chatV2Logger';
import {
  filterStagedPathMap,
  prepareRetainedAttachmentsAndCommit,
} from '../attachmentMaterialization';
import { SKILL_INSTRUCTION_TYPE_ID } from '../../skills/types';
// 🆕 工作区状态（用于传递 workspaceId 到后端）
import { resolveWorkspaceIdForSession } from '../../workspace/workspaceStore';
import { buildAttachmentRequestAudit } from '../../debug/attachmentRequestAudit';
import { LOG_PREFIX, adapterConsole as console } from './diagnostics';
import { isActiveStreamConflict, normalizeStreamTerminalError } from './errors';
import type { TauriAdapterHost } from './adapterHost';

/**
 * 生成消息 ID（格式：msg_{uuid}）
 */
export function generateMessageId(host: TauriAdapterHost): string {
  return `msg_${crypto.randomUUID()}`;
}

export async function sendMessage(host: TauriAdapterHost, content: string, attachments?: AttachmentMeta[]): Promise<void> {
  console.warn(
    LOG_PREFIX,
    'sendMessage() called directly. Prefer using store.sendMessage() instead.'
  );
  console.log(LOG_PREFIX, 'Sending message:', { content: content.substring(0, 50), attachments });

  try {
    const backendStreamActive = await invoke<boolean>('chat_v2_has_active_stream', {
      sessionId: host.sessionId,
    });
    if (backendStreamActive) {
      throw new Error('Session has an active stream. Please wait for completion or cancel first.');
    }
    // 🔧 修复：重置事件桥接状态（确保序列号从 0 开始，与 executeSendMessage 保持一致）
    resetBridgeState(host.sessionId);

    // 1. 前端生成消息 ID（消息 ID 统一方案 B）
    const userMessageId = host.generateMessageId();
    const assistantMessageId = host.generateMessageId();
    host.beginStreamExpectation(assistantMessageId);
    const sendStateSnapshot = host.getCurrentState();

    // ⚠️ 统一上下文注入：先获取 pendingContextRefs（sendMessageWithIds 会清空）
    // ★ 使用 storeApi 获取最新状态
    let pendingContextRefs = getPendingContextRefs(host.storeApi ?? host.store);

    // 🆕 P1 修复：验证并清理已删除的资源引用
    // 在发送前检查资源是否仍然存在，移除无效引用
    if (pendingContextRefs.length > 0) {
      pendingContextRefs = await validateAndCleanupContextRefs(
        host.storeApi ?? host.store,
        pendingContextRefs,
        { notifyUser: true, logDetails: true }
      );
      console.log(LOG_PREFIX, 'After validation:', pendingContextRefs.length, 'valid refs');
    }

    // 2. 构建发送选项（包含 parallelModelIds），并先同步当前会话模型
    // 这样 sendMessageWithIds 创建的助手占位消息会立即显示本轮实际模型。
    const activeModelId = sendStateSnapshot.chatParams.model2OverrideId || sendStateSnapshot.chatParams.modelId;
    await host.ensureModelMetadataReady(activeModelId);
    const options = await host.buildSendOptions({
      state: sendStateSnapshot,
      pendingContextRefs,
    });
    await host.applyRuntimeModelSelection(options);
    let localTurnCommitted = false;
    const commitLocalTurn = async () => {
      if (localTurnCommitted) return;
      await host.store.sendMessageWithIds(
        content,
        attachments,
        userMessageId,
        assistantMessageId,
      );
      localTurnCommitted = true;
    };

    // 🆕 统一上下文注入：构建 SendContextRef[]（附件已通过 pendingContextRefs 处理）
    // ★ 根据当前模型的多模态能力决定注入图片还是文本
    // ★ 文档28 Prompt10：使用 buildSendContextRefsWithPaths 获取 pathMap
    let userContextRefs = undefined;
    let contextPathMap: Record<string, string> | undefined;
    let isMultimodalModel = false;
    // 🔧 2026-02-22: 过滤掉 skill_instruction 类型 refs
    // 技能内容改由后端 auto-load_skills 工具结果投递（role: tool），不再注入 user message
    const refsForUserMessage = pendingContextRefs.filter(
      (ref) => ref.typeId !== SKILL_INSTRUCTION_TYPE_ID
    );
    if (refsForUserMessage.length > 0) {
      const currentModelId = options.modelId;
      const isMultimodal = await host.shouldResolveContextAsMultimodal(options);
      isMultimodalModel = isMultimodal;
      const { sendRefs, pathMap, binaryStageCandidates } = await buildSendContextRefsWithPaths(refsForUserMessage, { isMultimodal });

      // Token 预估和截断（防止上下文过长）
      // ✅ 按模型上下文预算截断（优先使用用户覆盖，其次模型推断）
      const truncateResult = truncateContextByTokens(sendRefs, host.getContextTruncateLimit(options.contextLimit));

      if (truncateResult.wasTruncated) {
        console.warn(
          LOG_PREFIX,
          'Context truncated:',
          `original=${truncateResult.originalTokens} tokens,`,
          `final=${truncateResult.finalTokens} tokens,`,
          `removed=${truncateResult.removedCount} refs`
        );
        host.notifyContextTruncated(truncateResult.removedCount);
      }

      userContextRefs = truncateResult.truncatedRefs;
      const stagedPathMap = await prepareRetainedAttachmentsAndCommit(
        host.sessionId,
        userContextRefs,
        binaryStageCandidates,
        pathMap,
        commitLocalTurn,
      );

      // ★ 文档28 Prompt10：保存 pathMap 用于传递给后端和更新 store
      const keptPathMap = filterStagedPathMap(
        stagedPathMap,
        new Set(userContextRefs.map((ref) => ref.resourceId)),
      );
      if (Object.keys(keptPathMap).length > 0) {
        contextPathMap = keptPathMap;
      }
    }

    // Commit the optimistic local turn only after attachment preparation succeeds.
    await commitLocalTurn();
    if (contextPathMap) {
      host.store.updateMessagePathMap(userMessageId, contextPathMap);
    }

    // 🔧 2026-01-15: 超时机制已移除

    // 🔧 P1 修复：仅当本会话确实属于当前工作区时才附加 workspaceId，避免跨会话串台
    const attachedWorkspaceId = resolveWorkspaceIdForSession(host.sessionId);

    // 5. 调用后端（传递前端生成的消息 ID）
    const request: SendMessageRequest = {
      sessionId: host.sessionId,
      content,
      // 🆕 附件已通过 userContextRefs 传递，不再使用 attachments 字段
      options,
      // 传递前端生成的消息 ID，后端必须使用这些 ID
      userMessageId,
      assistantMessageId,
      userContextRefs, // 🆕 统一上下文注入（包含附件）
      pathMap: contextPathMap, // ★ 文档28 Prompt10：传递路径映射给后端保存
      workspaceId: attachedWorkspaceId, // 🆕 工作区 ID（多 Agent 协作，仅限工作区成员会话）
    };

    const requestAudit = buildAttachmentRequestAudit(request, {
      source: 'frontend',
      modelId: options.modelId,
      isMultimodalModel,
    });
    logAttachment('adapter', 'send_request_audit_frontend', requestAudit as unknown as Record<string, unknown>, requestAudit.expectation.expectationMet ? 'success' : 'warning');

    const returnedAssistantMessageId = await invoke<string>('chat_v2_send_message', {
      request,
    });

    // 发送成功后才清空多变体 ID，确保失败时用户可以重试
    host.store.setPendingParallelModelIds(null);

    console.log(
      LOG_PREFIX,
      'Message sent, assistant message ID:',
      returnedAssistantMessageId,
      '(expected:',
      assistantMessageId,
      ')'
    );

    // 5. 验证 ID 一致性（后端应返回相同的 ID）
    if (returnedAssistantMessageId && returnedAssistantMessageId !== assistantMessageId) {
      console.warn(
        LOG_PREFIX,
        'Backend returned different assistant message ID:',
        returnedAssistantMessageId,
        'expected:',
        assistantMessageId
      );
      // 更新为后端返回的 ID（兼容旧版本后端）
      host.setStreamExpectationMessageId(returnedAssistantMessageId);
      host.store.setCurrentStreamingMessage(returnedAssistantMessageId);
    }
  } catch (error) {
    host.clearStreamExpectation();
    const errorMsg = getErrorMessage(error);
    if (isActiveStreamConflict(errorMsg)) {
      console.warn(LOG_PREFIX, 'Send rejected because the backend stream is still active');
      showGlobalNotification('error', formatUserFacingErrorWithThinkingBudgetHint(
        error,
        'chatV2:error.sendFailed',
        'Send failed',
      ));
      throw error;
    }
    console.error(LOG_PREFIX, 'Send message failed:', errorMsg);
    // 尝试恢复状态
    try {
      await host.store.abortStream();
    } catch {
      // 忽略恢复失败
    }
    // 显示错误提示（使用 i18n）
    showGlobalNotification('error', formatUserFacingErrorWithThinkingBudgetHint(
      error,
      'chatV2:error.sendFailed',
      'Send failed',
    ));
    throw error;
  }
}

/**
 * 执行系统唤醒（内部方法，供 callback 使用）。
 *
 * 唤醒内容仍进入 Pipeline 的 user content，但后端强制跳过用户消息持久化；
 * 本地 store 已仅创建 assistant 占位，以避免出现伪用户气泡。
 */
export async function executeWakeSession(
  host: TauriAdapterHost,
  content: string,
  assistantMessageId: string,
): Promise<void> {
  console.log(LOG_PREFIX, 'Executing wake session:', {
    content: content.substring(0, 50),
    assistantMessageId,
  });

  try {
    host.beginStreamExpectation(assistantMessageId);
    resetBridgeState(host.sessionId);

    const state = host.getCurrentState();
    const activeModelId = state.chatParams.model2OverrideId || state.chatParams.modelId;
    await host.ensureModelMetadataReady(activeModelId);
    const options = await host.buildSendOptions({ state, pendingContextRefs: [] });
    await host.applyRuntimeModelSelection(options);

    const returnedAssistantMessageId = await invoke<string>('chat_v2_wake_session', {
      sessionId: host.sessionId,
      content,
      assistantMessageId,
      options,
    });
    if (returnedAssistantMessageId && returnedAssistantMessageId !== assistantMessageId) {
      host.setStreamExpectationMessageId(returnedAssistantMessageId);
      host.store.setCurrentStreamingMessage(returnedAssistantMessageId);
    }
  } catch (error) {
    host.clearStreamExpectation(assistantMessageId);
    const errorMsg = getErrorMessage(error);
    if (isActiveStreamConflict(errorMsg)) {
      console.warn(LOG_PREFIX, 'Wake deferred because the backend stream is still active');
      throw error;
    }
    console.error(LOG_PREFIX, 'Execute wake session failed:', errorMsg);
    host.store.updateMessageMeta(assistantMessageId, { terminalError: errorMsg });
    host.store.completeStream('error', normalizeStreamTerminalError(error));
    showGlobalNotification('error', formatUserFacingErrorWithThinkingBudgetHint(
      error,
      'chatV2:error.sendFailed',
      'Wake failed',
    ));
    throw error;
  }
}

/**
 * 执行发送消息（内部方法，供 callback 使用）
 * 
 * 与 sendMessage 的区别：使用调用方传入的消息 ID，而不是自己生成。
 * 这确保了 Store.sendMessage() 生成的 ID 与后端使用的 ID 一致。
 */
export async function executeSendMessage(
  host: TauriAdapterHost,
  content: string,
  attachments: AttachmentMeta[] | undefined,
  userMessageId: string,
  assistantMessageId: string
): Promise<void> {
  console.log(LOG_PREFIX, 'Executing sendMessage:', { content: content.substring(0, 50), userMessageId, assistantMessageId });

  try {
    const backendStreamActive = await invoke<boolean>('chat_v2_has_active_stream', {
      sessionId: host.sessionId,
    });
    if (backendStreamActive) {
      throw new Error('Session has an active stream. Please wait for completion or cancel first.');
    }
    host.beginStreamExpectation(assistantMessageId);
    const sendStateSnapshot = host.getCurrentState();

    // 🔧 重置事件桥接状态（确保序列号从 0 开始）
    resetBridgeState(host.sessionId);

    // ========== 🆕 统一上下文注入（必须在 sendMessageWithIds 之前获取） ==========
    // 0. 先获取 pendingContextRefs（sendMessageWithIds 会清空它们）
    // ★ 使用 storeApi 获取最新状态，this.store 是构造时的快照，不是响应式的
    let pendingContextRefs = getPendingContextRefs(host.storeApi ?? host.store);
    logAttachment('adapter', 'get_pending_context_refs', {
      count: pendingContextRefs.length,
      refs: pendingContextRefs.map(r => ({ resourceId: r.resourceId, typeId: r.typeId, hash: r.hash })),
    });

    // 🆕 P1 修复：验证并清理已删除的资源引用
    // 在发送前检查资源是否仍然存在，移除无效引用
    if (pendingContextRefs.length > 0) {
      pendingContextRefs = await validateAndCleanupContextRefs(
        host.storeApi ?? host.store,
        pendingContextRefs,
        { notifyUser: true, logDetails: true }
      );
      console.log(LOG_PREFIX, 'After validation:', pendingContextRefs.length, 'valid refs');
    }

    // 1. 构建发送选项（包含 parallelModelIds），并先同步当前会话模型
    // 这样 sendMessageWithIds 创建的助手占位消息会立即显示本轮实际模型。
    const activeModelId = sendStateSnapshot.chatParams.model2OverrideId || sendStateSnapshot.chatParams.modelId;
    await host.ensureModelMetadataReady(activeModelId);
    const options = await host.buildSendOptions({
      state: sendStateSnapshot,
      pendingContextRefs,
    });
    await host.applyRuntimeModelSelection(options);
    let localTurnCommitted = false;
    const commitLocalTurn = async () => {
      if (localTurnCommitted) return;
      await host.store.sendMessageWithIds(
        content,
        attachments,
        userMessageId,
        assistantMessageId,
      );
      localTurnCommitted = true;
    };

    // 🔧 调试打点：发送消息时的状态
    if (options.parallelModelIds && options.parallelModelIds.length >= 2) {
      logMultiVariant('adapter', 'executeSendMessage', {
        userMessageId,
        assistantMessageId,
        parallelModelIds: options.parallelModelIds,
        isMultiVariant: true,
      }, 'success');
    }

    // 注意：不在这里清空 pendingParallelModelIds，等待发送成功后再清空
    // 这样如果发送失败，用户可以重试而不会丢失多变体配置

    // ========== 🆕 统一上下文注入 ==========
    // 附件已通过 pendingContextRefs 处理，不再使用旧的 attachments 字段

    // 3. 构建 SendContextRef[]（按优先级排序，获取资源内容，调用 formatToBlocks）
    // ★ 根据当前模型的多模态能力决定注入图片还是文本
    // ★ 文档28 Prompt10：使用 buildSendContextRefsWithPaths 获取 pathMap
    let userContextRefs = undefined;
    let contextPathMap: Record<string, string> | undefined;
    let retainedContextSnapshot: ContextSnapshot | undefined;
    let isMultimodalModel = false;
    // 🔧 2026-02-22: 过滤掉 skill_instruction 类型 refs
    // 技能内容改由后端 auto-load_skills 工具结果投递（role: tool），不再注入 user message
    const refsForUserMessage2 = pendingContextRefs.filter(
      (ref) => ref.typeId !== SKILL_INSTRUCTION_TYPE_ID
    );
    if (refsForUserMessage2.length > 0) {
      console.log(LOG_PREFIX, 'Building SendContextRefs for', refsForUserMessage2.length, 'refs (filtered', pendingContextRefs.length - refsForUserMessage2.length, 'skill_instruction refs)');
      const currentModelId = options.modelId;
      const isMultimodal = await host.shouldResolveContextAsMultimodal(options);
      isMultimodalModel = isMultimodal;
      console.debug('[TauriAdapter] send: model =', currentModelId, 'isMultimodal =', isMultimodal);
      const { sendRefs, pathMap, binaryStageCandidates } = await buildSendContextRefsWithPaths(refsForUserMessage2, { isMultimodal });

      // 3.1 Token 预估和截断（基于模型预算，防止上下文过长）
      const contextTokenLimit = host.getContextTruncateLimit(options.contextLimit);
      const truncateResult = truncateContextByTokens(sendRefs, contextTokenLimit);

      if (truncateResult.wasTruncated) {
        // 发生截断，记录警告日志
        console.warn(
          LOG_PREFIX,
          'Context truncated:',
          `original=${truncateResult.originalTokens} tokens,`,
          `final=${truncateResult.finalTokens} tokens,`,
          `removed=${truncateResult.removedCount} refs,`,
          `kept=${truncateResult.truncatedRefs.length} refs`
        );

        host.notifyContextTruncated(truncateResult.removedCount);
      } else {
        // 未截断，记录 debug 日志
        console.log(
          LOG_PREFIX,
          'Context within token limit:',
          `${truncateResult.finalTokens} / ${contextTokenLimit} tokens,`,
          `${sendRefs.length} refs`
        );
      }

      // 使用截断后的 sendRefs
      userContextRefs = truncateResult.truncatedRefs;
      const stagedPathMap = await prepareRetainedAttachmentsAndCommit(
        host.sessionId,
        userContextRefs,
        binaryStageCandidates,
        pathMap,
        commitLocalTurn,
      );
      logSendContextRefsSummary(userContextRefs);

      // 🔧 修复：同步更新 contextSnapshot，确保与截断后的请求一致
      const keptContextRefs = userContextRefs.map((ref) => ({
        resourceId: ref.resourceId,
        hash: ref.hash,
        typeId: ref.typeId,
        displayName: ref.displayName,
        injectModes: ref.injectModes,
      }));
      const keptResourceIds = new Set<string>(keptContextRefs.map((ref) => String(ref.resourceId)));
      const filteredPathMap = filterStagedPathMap(stagedPathMap, keptResourceIds);
      const contextSnapshot = keptContextRefs.length > 0
        ? {
            userRefs: keptContextRefs,
            retrievalRefs: [],
            ...(Object.keys(filteredPathMap).length > 0 ? { pathMap: filteredPathMap } : {}),
          }
        : undefined;
      retainedContextSnapshot = contextSnapshot;

      // ★ 文档28 Prompt10：保存 pathMap 用于传递给后端和更新 store
      if (Object.keys(filteredPathMap).length > 0) {
        contextPathMap = filteredPathMap;
      }

      // 3.2 收集上下文类型 Hints（用于 System Prompt 中声明 XML 标签含义）
      // Schema 工具 ID 已在 buildSendOptions 中通过 collectSchemaToolIds 统一收集
      const contextTypeHints = collectContextTypeHints(keptContextRefs);
      if (contextTypeHints.length > 0) {
        options.contextTypeHints = contextTypeHints;
        console.log(LOG_PREFIX, 'Context type hints:', contextTypeHints.length, 'hints');
      }
    }

    // ========== 🆕 统一上下文注入结束 ==========

    // Staging can fail. Keep the composer and ContextRefs intact until it succeeds.
    await commitLocalTurn();
    if (retainedContextSnapshot) {
      host.store.updateMessageMeta(userMessageId, { contextSnapshot: retainedContextSnapshot });
    }
    if (contextPathMap) {
      host.store.updateMessagePathMap(userMessageId, contextPathMap);
    }

    // 🔧 2026-01-15: 超时机制已移除

    // 🔧 P1 修复：仅当本会话确实属于当前工作区时才附加 workspaceId，避免跨会话串台
    const attachedWorkspaceId = resolveWorkspaceIdForSession(host.sessionId);

    // 5. 调用后端
    const request: SendMessageRequest = {
      sessionId: host.sessionId,
      content,
      // 🆕 附件已通过 userContextRefs 传递，不再使用 attachments 字段
      options,
      userMessageId,
      assistantMessageId,
      userContextRefs, // 🆕 统一上下文注入（包含附件）
      pathMap: contextPathMap, // ★ 文档28 Prompt10：传递路径映射给后端保存
      workspaceId: attachedWorkspaceId, // 🆕 工作区 ID（多 Agent 协作，仅限工作区成员会话）
    };

    const requestAudit = buildAttachmentRequestAudit(request, {
      source: 'frontend',
      modelId: options.modelId,
      isMultimodalModel,
    });
    logAttachment('adapter', 'send_request_audit_frontend', requestAudit as unknown as Record<string, unknown>, requestAudit.expectation.expectationMet ? 'success' : 'warning');

    const returnedAssistantMessageId = await invoke<string>('chat_v2_send_message', {
      request,
    });

    // 发送成功后才清空多变体 ID，确保失败时用户可以重试
    host.store.setPendingParallelModelIds(null);

    // 🆕 开发者调试：保存完整请求体到助手消息的元数据
    // ★ 2026-02-14: 如果后端已推送真实 LLM 请求体（_source='backend_llm'），则不覆盖
    const existingMeta = host.getCurrentState().messageMap.get(assistantMessageId)?._meta;
    const existingRaw = existingMeta?.rawRequest as { _source?: string } | undefined;
    if (!existingRaw || existingRaw._source !== 'backend_llm') {
      host.store.updateMessageMeta(assistantMessageId, { rawRequest: request });
    }

    console.log(LOG_PREFIX, 'Message sent, assistant ID:', returnedAssistantMessageId);

    // 6. 验证 ID 一致性
    if (returnedAssistantMessageId && returnedAssistantMessageId !== assistantMessageId) {
      console.warn(LOG_PREFIX, 'Backend returned different ID:', returnedAssistantMessageId);
      host.setStreamExpectationMessageId(returnedAssistantMessageId);
      host.store.setCurrentStreamingMessage(returnedAssistantMessageId);
    }
  } catch (error) {
    host.clearStreamExpectation();
    const errorMsg = getErrorMessage(error);
    if (isActiveStreamConflict(errorMsg)) {
      console.warn(LOG_PREFIX, 'Send rejected because the backend stream is still active');
      showGlobalNotification('error', formatUserFacingErrorWithThinkingBudgetHint(
        error,
        'chatV2:error.sendFailed',
        'Send failed',
      ));
      throw error;
    }
    console.error(LOG_PREFIX, 'Execute sendMessage failed:', errorMsg);
    host.store.updateMessageMeta(assistantMessageId, { terminalError: errorMsg });
    try {
      await host.store.abortStream();
    } catch {
      // 忽略恢复失败
    }
    showGlobalNotification('error', formatUserFacingErrorWithThinkingBudgetHint(
      error,
      'chatV2:error.sendFailed',
      'Send failed',
    ));
    throw error;
  }
}
