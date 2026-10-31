/**
 * Chat V2 - TauriAdapter 拆分模块 —— 变体操作：切换、删除、重试、批量重试、取消
 *
 * 自 TauriAdapter.ts 拆出（行为不变）；函数首参 host 为适配器实例，
 * 由 ChatV2TauriAdapter 同名方法委托调用。
 */

import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from '@/utils/errorUtils';
import { resetBridgeState } from '../../core/middleware/eventBridge';
import { LOG_PREFIX, adapterConsole as console } from './diagnostics';
import type { TauriAdapterHost } from './adapterHost';

/**
 * 执行切换变体操作（内部方法，供 callback 使用）
 */
export async function executeSwitchVariant(
  host: TauriAdapterHost,
  messageId: string,
  variantId: string
): Promise<void> {
  console.log(LOG_PREFIX, 'Executing switch variant:', messageId, '->', variantId);

  try {
    await invoke('chat_v2_switch_variant', {
      sessionId: host.sessionId,
      messageId,
      variantId,
    });

    host.store.setSkillStateJson(null);

    console.log(LOG_PREFIX, 'Variant switched successfully:', variantId);
  } catch (error) {
    const errorMsg = getErrorMessage(error);
    console.error(LOG_PREFIX, 'Switch variant failed:', errorMsg);
    throw error;
  }
}

/**
 * 执行删除变体操作（内部方法，供 callback 使用）
 * @returns 删除结果，包含新的激活变体 ID
 */
export async function executeDeleteVariant(
  host: TauriAdapterHost,
  messageId: string,
  variantId: string
): Promise<{ variantDeleted?: boolean; messageDeleted?: boolean; newActiveId?: string }> {
  console.log(LOG_PREFIX, 'Executing delete variant:', messageId, '->', variantId);

  try {
    const result = await invoke<{
      deletedVariantId: string;
      remainingCount: number;
      newActiveVariantId: string | null;
    }>('chat_v2_delete_variant', {
      sessionId: host.sessionId,
      messageId,
      variantId,
    });

    host.store.setSkillStateJson(null);

    console.log(LOG_PREFIX, 'Variant deleted successfully:', result);

    return {
      variantDeleted: true,
      messageDeleted: false,
      newActiveId: result.newActiveVariantId ?? undefined,
    };
  } catch (error) {
    const errorMsg = getErrorMessage(error);
    console.error(LOG_PREFIX, 'Delete variant failed:', errorMsg);
    throw error;
  }
}

/**
 * 执行重试变体操作（内部方法，供 callback 使用）
 */
export async function executeRetryVariant(
  host: TauriAdapterHost,
  messageId: string,
  variantId: string,
  modelOverride?: string
): Promise<void> {
  console.log(LOG_PREFIX, 'Executing retry variant:', messageId, '->', variantId, 'model:', modelOverride);

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
      variantId,
    );
    await host.applyRuntimeModelSelection(options);
    if (modelOverride) {
      const validIds = await host.getValidChatModelIdSet();
      const trimmedOverride = modelOverride.trim();
      if (trimmedOverride && (validIds.size === 0 || validIds.has(trimmedOverride))) {
        options.modelId = trimmedOverride;
        options.model2OverrideId = trimmedOverride;
        host.applyRuntimeThinkingCapability(options);
      }
    }

    // 🔧 2026-01-15: 超时机制已移除

    await invoke('chat_v2_retry_variant', {
      sessionId: host.sessionId,
      messageId,
      variantId,
      modelOverride: modelOverride ?? null,
      options,
    });

    // 发送成功后清空多变体 ID
    host.store.setPendingParallelModelIds(null);

    console.log(LOG_PREFIX, 'Variant retry initiated:', variantId);
  } catch (error) {
    const errorMsg = getErrorMessage(error);
    console.error(LOG_PREFIX, 'Retry variant failed:', errorMsg);
    throw error;
  }
}

/**
 * 执行批量重试变体操作（内部方法，供 callback 使用）
 */
export async function executeRetryAllVariants(
  host: TauriAdapterHost,
  messageId: string,
  variantIds: string[]
): Promise<void> {
  console.log(
    LOG_PREFIX,
    'Executing retry all variants:',
    messageId,
    'variants:',
    variantIds.length
  );

  try {
    // 🔧 批量重试仅需重置一次事件桥接状态
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

    await invoke('chat_v2_retry_variants', {
      sessionId: host.sessionId,
      messageId,
      variantIds,
      options,
    });

    // 发送成功后清空多变体 ID
    host.store.setPendingParallelModelIds(null);

    console.log(LOG_PREFIX, 'Retry all variants initiated:', variantIds.length);
  } catch (error) {
    const errorMsg = getErrorMessage(error);
    console.error(LOG_PREFIX, 'Retry all variants failed:', errorMsg);
    throw error;
  }
}

/**
 * 执行取消变体操作（内部方法，供 callback 使用）
 */
export async function executeCancelVariant(host: TauriAdapterHost, variantId: string): Promise<void> {
  console.log(LOG_PREFIX, 'Executing cancel variant:', variantId);

  try {
    await invoke('chat_v2_cancel_variant', {
      sessionId: host.sessionId,
      variantId,
    });

    console.log(LOG_PREFIX, 'Variant cancelled successfully:', variantId);
  } catch (error) {
    const errorMsg = getErrorMessage(error);
    console.error(LOG_PREFIX, 'Cancel variant failed:', errorMsg);
    throw error;
  }
}
