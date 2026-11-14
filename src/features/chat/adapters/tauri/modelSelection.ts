/**
 * Chat V2 - TauriAdapter 拆分模块 —— 运行时模型选择：模型元数据、默认模型回填、思维链能力与多模态判定
 *
 * 自 TauriAdapter.ts 拆出（行为不变）；函数首参 host 为适配器实例，
 * 由 ChatV2TauriAdapter 同名方法委托调用。
 */

import { invoke } from '@tauri-apps/api/core';
import i18n from 'i18next';
import { getErrorMessage } from '@/utils/errorUtils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { ApiConfig, ModelAssignments } from '@/types';
import type { SendOptions } from '../types';
import {
  ensureModelsCacheLoaded,
  getCachedModels,
  getModelInfoByConfigId,
  isModelMultimodalAsync,
} from '../../hooks/useAvailableModels';
import { inferCapabilities } from '@/utils/modelCapabilities';
import { isAvailableChatModel } from '@/utils/chatModelEligibility';
import { LOG_PREFIX, adapterConsole as console } from './diagnostics';
import type { NormalizedChatModelSelection } from './requestHelpers';
import type { TauriAdapterHost } from './adapterHost';

export async function ensureModelMetadataReady(host: TauriAdapterHost, modelId: string | undefined): Promise<void> {
  if (!modelId) {
    return;
  }

  try {
    await ensureModelsCacheLoaded();
    if (!getModelInfoByConfigId(modelId)) {
      await ensureModelsCacheLoaded(true);
    }
  } catch (error) {
    console.warn(LOG_PREFIX, 'Failed to load model metadata cache:', getErrorMessage(error));
  }
}

export async function hydrateDefaultChatModelIfMissing(host: TauriAdapterHost): Promise<void> {
  const generation = host.setupGeneration;
  const currentParams = host.getCurrentState().chatParams;
  if (currentParams.modelId?.trim()) {
    return;
  }

  try {
    // 元数据与默认分配/有效 id 读取互不依赖，冷缓存也不必多等一个 RPC 往返。
    const [, normalizedSelection] = await Promise.all([
      ensureModelsCacheLoaded(),
      host.normalizeChatModelSelection(
        currentParams.modelId || undefined,
        currentParams.model2OverrideId || undefined
      ),
    ]);
    if (generation !== host.setupGeneration || !host.isSessionRuntimeOwner()) return;
    const latestParams = host.getCurrentState().chatParams;
    // UI 已在 onDataRestored 后放行：用户可能在 WAN 回填期间选了另一个模型。
    if (latestParams.modelId?.trim()
      || latestParams.model2OverrideId !== currentParams.model2OverrideId) {
      return;
    }

    // 只回写 model2OverrideId 与显示名，不写 modelId——避免把全局默认烘焙成
    // 会话固定值。modelId 留空，发送时由 resolveEffectiveChatModelId 现取全局默认。
    host.store.setChatParams({
      model2OverrideId: normalizedSelection.model2OverrideId ?? null,
      modelDisplayName: normalizedSelection.modelDisplayName || latestParams.modelDisplayName || '',
    });
  } catch (error) {
    console.warn(LOG_PREFIX, 'Failed to hydrate default chat model:', getErrorMessage(error));
  }
}

export function getEffectiveRuntimeModelId(host: TauriAdapterHost, options: {
  modelId?: string;
  model2OverrideId?: string;
}): string | undefined {
  const overrideId = options.model2OverrideId?.trim();
  if (overrideId) {
    return overrideId;
  }
  const modelId = options.modelId?.trim();
  return modelId || undefined;
}

export function resolveModelSupportsRuntimeThinking(host: TauriAdapterHost, modelId: string | undefined): boolean | undefined {
  const modelInfo = getModelInfoByConfigId(modelId);
  if (!modelInfo) {
    return undefined;
  }

  const explicitReasoning = modelInfo.isReasoning;
  const explicitSupportsReasoning = (modelInfo as Record<string, unknown>).supportsReasoning;
  if (explicitReasoning === true || explicitSupportsReasoning === true) {
    return true;
  }
  if (explicitReasoning === false && explicitSupportsReasoning === false) {
    return false;
  }

  const providerScope =
    typeof modelInfo.providerScope === 'string' ? modelInfo.providerScope : undefined;
  return inferCapabilities({
    id: modelInfo.model || modelInfo.id || modelId || '',
    name: modelInfo.name,
    providerScope,
  }).supportsReasoning;
}

export function applyRuntimeThinkingCapability(host: TauriAdapterHost, options: SendOptions): void {
  const supportsThinking = host.resolveModelSupportsRuntimeThinking(
    host.getEffectiveRuntimeModelId(options)
  );
  if (supportsThinking !== false) {
    return;
  }

  options.enableThinking = false;
  options.reasoningEffort = undefined;
  options.thinkingBudget = undefined;
}

// RUST-FIX(RF-W09-stale-model-cache-context-budget): Rust 版的预算在解析出实际模型之前就算好，跟随全局默认模型的会话总按 100k 兜底窗口发送
export function applyRuntimeContextBudget(host: TauriAdapterHost, options: SendOptions): void {
  options.contextLimit = host.resolveInputContextLimit(
    options.modelId,
    options.model2OverrideId,
    options.maxTokens ?? 0,
    host.getCurrentState().chatParams.contextLimit,
  );
}

export async function shouldResolveContextAsMultimodal(host: TauriAdapterHost, options: {
  modelId?: string;
  model2OverrideId?: string;
  parallelModelIds?: string[];
}): Promise<boolean> {
  const effectiveModelId = host.getEffectiveRuntimeModelId(options);
  const candidateIds = [
    ...(options.parallelModelIds ?? []),
    ...(effectiveModelId ? [effectiveModelId] : []),
  ].filter((id, index, list) => !!id && list.indexOf(id) === index);

  if (candidateIds.length === 0) {
    return false;
  }

  const capabilities = await Promise.all(candidateIds.map((id) => isModelMultimodalAsync(id)));
  return capabilities.some(Boolean);
}

export async function getValidChatModelIdSet(host: TauriAdapterHost): Promise<Set<string>> {
  try {
    const configs = await invoke<ApiConfig[]>('get_api_configurations');
    return new Set(
      (configs || [])
        .filter(isAvailableChatModel)
        .map((config) => (typeof config?.id === 'string' ? config.id.trim() : ''))
        .filter((id) => id.length > 0)
    );
  } catch (error) {
    console.warn(LOG_PREFIX, 'Failed to load current API configuration ids:', getErrorMessage(error));
    return new Set();
  }
}

export class MissingChatModelError extends Error {}

export async function resolveEffectiveChatModelId(
  host: TauriAdapterHost,
  modelId: string | undefined,
  validIds?: Set<string>,
  prefetchedAssignments?: Promise<ModelAssignments | undefined>,
): Promise<string> {
  if (modelId && modelId.trim().length > 0) {
    const trimmed = modelId.trim();
    if (!validIds || validIds.size === 0 || validIds.has(trimmed)) {
      return trimmed;
    }
  }

  try {
    // 调用方可以先把分配读取和有效 id 读取并行发出去（省一个 RTT）；
    // 没预取时这里自己发。
    const assignments = prefetchedAssignments
      ? await prefetchedAssignments
      : await invoke<ModelAssignments>('get_model_assignments');
    const defaultModelId = assignments?.model2_config_id ?? undefined;
    if (defaultModelId && defaultModelId.trim().length > 0) {
      const trimmed = defaultModelId.trim();
      if (!validIds || validIds.size === 0 || validIds.has(trimmed)) {
        return trimmed;
      }
    }
  } catch (error) {
    console.warn(LOG_PREFIX, 'Failed to resolve default model assignment:', getErrorMessage(error));
  }

  // 兜底：运行时从已缓存模型中取第一个可用的
  try {
    await ensureModelsCacheLoaded();
    const cachedModels = getCachedModels();
    if (cachedModels && cachedModels.length > 0) {
      const fallbackId = cachedModels[0].id;
      console.warn(LOG_PREFIX, 'Runtime fallback to first available model:', fallbackId);
      if (!validIds || validIds.size === 0 || validIds.has(fallbackId)) {
        return fallbackId;
      }
    }
  } catch {
    // fall through to throw
  }

  throw new MissingChatModelError('No chat model configured: missing chatParams.modelId and model_assignments.model2_config_id');
}

export async function normalizeChatModelSelection(
  host: TauriAdapterHost,
  modelId: string | undefined,
  model2OverrideId: string | undefined,
  pinnedByUser?: boolean
): Promise<NormalizedChatModelSelection> {
  // 有效 id 列表与全局分配互不依赖：一起发出，省掉一次串行往返
  // （公网 RTT 150–250ms）。用户显式固定的模型本来就有效时不会用到分配，
  // 那种情况不发这次请求。
  const needsAssignments = !(pinnedByUser && modelId?.trim());
  const assignmentsPromise = needsAssignments
    ? invoke<ModelAssignments>('get_model_assignments').catch(() => undefined)
    : undefined;
  const validIds = await host.getValidChatModelIdSet();
  let normalizedOverrideId = model2OverrideId?.trim() || undefined;
  if (normalizedOverrideId && validIds.size > 0 && !validIds.has(normalizedOverrideId)) {
    normalizedOverrideId = undefined;
  }

  // 仅"用户显式固定"的会话才尊重其持久化 modelId；未固定会话一律忽略
  // （可能是旧版本烘焙的 fallback 残留），直接取当前全局默认，保证
  // "模型分配"切换后会话跟随新默认。
  const candidateModelId = pinnedByUser ? modelId : undefined;
  const normalizedModelId = await resolveEffectiveChatModelId(
    host,
    candidateModelId,
    validIds,
    assignmentsPromise,
  );
  const effectiveModelId = normalizedOverrideId || normalizedModelId;
  await host.ensureModelMetadataReady(effectiveModelId);
  const modelInfo = getModelInfoByConfigId(effectiveModelId);
  const modelDisplayName = modelInfo?.model || modelInfo?.name || effectiveModelId;
  // 用户固定的模型已被删除 / 停用（不在当前可用列表）而被回退替换
  const trimmedPinned = candidateModelId?.trim();
  const pinnedModelUnavailable = Boolean(
    trimmedPinned && validIds.size > 0 && !validIds.has(trimmedPinned) && effectiveModelId !== trimmedPinned,
  );

  return {
    modelId: normalizedModelId,
    model2OverrideId: normalizedOverrideId,
    effectiveModelId,
    modelDisplayName,
    pinnedModelUnavailable,
  };
}

export async function applyRuntimeModelSelection(host: TauriAdapterHost, options: SendOptions): Promise<NormalizedChatModelSelection> {
  const pinnedByUser = host.store.chatParams?.modelIdPinnedByUser === true;
  const normalizedSelection = await host.normalizeChatModelSelection(
    options.modelId,
    options.model2OverrideId,
    pinnedByUser
  );

  // issue #44：会话固定的模型被删除 / 停用后，此前悄悄换成默认或第一个可用模型继续对话，
  // 用户以为还在用原模型。改为每个会话 + 模型提示一次实际改用的模型。
  if (normalizedSelection.pinnedModelUnavailable) {
    const missingId = options.modelId?.trim() ?? '';
    const noticeKey = `${host.sessionId}::${missingId}`;
    if (!host.notifiedUnavailablePinnedModels.has(noticeKey)) {
      host.notifiedUnavailablePinnedModels.add(noticeKey);
      const previousName = host.store.chatParams?.modelDisplayName?.trim() || missingId;
      showGlobalNotification(
        'warning',
        i18n.t('chatV2:modelPicker.pinnedUnavailable', {
          from: previousName,
          to: normalizedSelection.modelDisplayName || normalizedSelection.effectiveModelId,
        }),
      );
    }
  }

  options.modelId = normalizedSelection.effectiveModelId;
  options.model2OverrideId = normalizedSelection.model2OverrideId;
  host.applyRuntimeThinkingCapability(options);
  host.applyRuntimeContextBudget(options);

  // 已固定与未固定都不再回写 modelId（未固定避免烘焙全局默认；已固定的
  // modelId 由用户选择路径负责写入）。这里只刷新实际生效模型的显示名。
  host.store.setChatParams({
    modelDisplayName: normalizedSelection.modelDisplayName || '',
  });

  return normalizedSelection;
}
