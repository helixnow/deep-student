/**
 * Chat V2 - 可用模型列表 Hook
 *
 * 获取系统配置的模型列表，用于 @模型 解析和多变体支持。
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ModelInfo } from '../utils/parseModelMentions';
import { useEventRegistry } from '@/hooks/useEventRegistry';

// ============================================================================
// 类型
// ============================================================================

/**
 * 模型配置接口（与后端 ApiConfig 对应）
 * 🔧 扩展：添加模型能力字段，便于前端根据模型能力显示不同 UI
 */
interface ModelConfig {
  id: string;
  name: string;
  model: string;
  isMultimodal?: boolean;
  /** 是否为推理模型（支持 thinking/reasoning） */
  isReasoning?: boolean;
  /** 是否支持工具调用 */
  supportsTools?: boolean;
  /** 是否启用 */
  enabled?: boolean;
  /** 是否为嵌入模型 */
  isEmbedding?: boolean;
  is_embedding?: boolean;
  /** 是否为重排序模型 */
  isReranker?: boolean;
  is_reranker?: boolean;
  /** 模型最大输出 tokens */
  maxOutputTokens?: number;
  max_output_tokens?: number;
  /** 供应商级别 max_tokens 上限 */
  maxTokensLimit?: number;
  max_tokens_limit?: number;
}

interface UseAvailableModelsReturn {
  /** 可用模型列表（已转换为 ModelInfo 格式） */
  models: ModelInfo[];
  /** 是否正在加载 */
  loading: boolean;
  /** 加载错误 */
  error: Error | null;
  /** 重新加载 */
  reload: () => Promise<void>;
}

// ============================================================================
// 缓存
// ============================================================================

let cachedModels: ModelInfo[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟缓存

// ============================================================================
// 共享加载逻辑
// ============================================================================

/**
 * 从后端拉取并转换聊天模型配置
 */
async function fetchAvailableModelInfos(): Promise<ModelInfo[]> {
  const configs = await invoke<ModelConfig[]>('get_api_configurations');

  // 过滤掉嵌入模型、重排序模型和未启用的模型（供应商没有 API Key 的模型 enabled=false）
  const chatModels = (configs || []).filter((c) => {
    const isEmbedding = c.isEmbedding === true || c.is_embedding === true;
    const isReranker = c.isReranker === true || c.is_reranker === true;
    const isEnabled = c.enabled !== false;
    return !isEmbedding && !isReranker && isEnabled;
  });

  // 转换为 ModelInfo 格式
  // 🔧 修复：使用 model 字段作为显示 ID，而非数据库 ID
  // 🔧 扩展：传递模型能力字段（isReasoning、supportsTools、enabled）
  return chatModels.map((config) => ({
    id: config.id, // 数据库 ID（用于后端调用）
    name: config.name || config.model, // 用户定义的名称（用于显示和 @mention 插入）
    // 模型标识符（如 "gpt-4", "deepseek-chat"）- 用于 Popover 副标题显示
    model: config.model,
    // 生成别名：包含名称、模型标识符
    aliases: [
      config.name?.toLowerCase(),
      config.model?.toLowerCase(),
    ].filter((s): s is string => !!s && s.length > 0),
    // 🔧 新增：模型能力字段，便于 UI 根据能力显示不同状态
    isMultimodal: config.isMultimodal,
    isReasoning: config.isReasoning,
    supportsTools: config.supportsTools,
    enabled: config.enabled,
    // 上下文预算推断所需元信息
    maxOutputTokens: config.maxOutputTokens ?? config.max_output_tokens,
    maxTokensLimit: config.maxTokensLimit ?? config.max_tokens_limit,
  }));
}

/**
 * 确保缓存已加载
 */
export async function ensureModelsCacheLoaded(forceRefresh = false): Promise<ModelInfo[]> {
  const now = Date.now();
  if (!forceRefresh && cachedModels && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedModels;
  }

  const modelInfos = await fetchAvailableModelInfos();
  cachedModels = modelInfos;
  cacheTimestamp = now;
  return modelInfos;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * useAvailableModels - 获取可用模型列表
 *
 * 特性：
 * - 5 分钟内存缓存
 * - 自动转换为 ModelInfo 格式
 * - 支持手动刷新
 *
 * @example
 * ```tsx
 * const { models, loading } = useAvailableModels();
 * // 传递给 useInputBarV2
 * useInputBarV2(store, { availableModels: models });
 * ```
 */
export function useAvailableModels(): UseAvailableModelsReturn {
  const [models, setModels] = useState<ModelInfo[]>(cachedModels || []);
  const [loading, setLoading] = useState(!cachedModels);
  const [error, setError] = useState<Error | null>(null);

  const loadModels = useCallback(async () => {
    // 检查缓存
    const now = Date.now();
    if (cachedModels && now - cacheTimestamp < CACHE_TTL_MS) {
      setModels(cachedModels);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const modelInfos = await ensureModelsCacheLoaded(true);
      setModels(modelInfos);
    } catch (err: unknown) {
      console.error('[useAvailableModels] Failed to load models:', err);
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  // 配置变更时清理缓存并刷新（避免 5 分钟 TTL 造成“改了配置却不生效”的错觉）
  const handleConfigChanged = useCallback(() => {
    clearModelsCache();
    void loadModels();
  }, [loadModels]);
  useEventRegistry(
    [
      {
        target: 'window',
        type: 'api_configurations_changed',
        listener: handleConfigChanged as EventListener,
      },
    ],
    [handleConfigChanged]
  );

  return useMemo(
    () => ({
      models,
      loading,
      error,
      reload: loadModels,
    }),
    [models, loading, error]
  );
}

/**
 * 清除模型缓存
 *
 * 在模型配置变更后调用
 */
export function clearModelsCache(): void {
  cachedModels = null;
  cacheTimestamp = 0;
}

/**
 * 获取缓存的模型列表（非 React 环境使用）
 *
 * ★ 用于 TauriAdapter 等非 React 组件获取模型配置
 */
export function getCachedModels(): ModelInfo[] | null {
  return cachedModels;
}

/**
 * 根据模型 ID 查找缓存中的模型信息
 */
export function getModelInfoByConfigId(modelId: string | undefined): ModelInfo | undefined {
  if (!modelId || !cachedModels) {
    return undefined;
  }
  return cachedModels.find((m) => m.id === modelId);
}

/**
 * 根据模型 ID 查找模型是否支持多模态
 *
 * ★ 用于上下文注入模块判断是否注入图片
 *
 * @param modelId 模型配置 ID
 * @returns 是否支持多模态（未找到时返回 false）
 */
export function isModelMultimodal(modelId: string | undefined): boolean {
  if (!modelId || !cachedModels) {
    return false;
  }
  const model = cachedModels.find((m) => m.id === modelId);
  return model?.isMultimodal === true;
}

/**
 * 异步版本：根据模型 ID 查找模型是否支持多模态
 *
 * ★ 2026-02 修复：如果缓存未加载，先加载缓存再判断
 * ★ 用于发送消息时确保正确判断模型多模态能力
 *
 * @param modelId 模型配置 ID
 * @returns 是否支持多模态（未找到时返回 false）
 */
export async function isModelMultimodalAsync(modelId: string | undefined): Promise<boolean> {
  let effectiveModelId = modelId;
  console.log('[PDF_DEBUG_FE] isModelMultimodalAsync called with modelId:', modelId);

  if (!effectiveModelId) {
    try {
      const assignments = await invoke<{ model2_config_id?: string | null }>('get_model_assignments');
      const defaultModelId = assignments?.model2_config_id ?? undefined;
      if (defaultModelId && defaultModelId.trim().length > 0) {
        effectiveModelId = defaultModelId;
        console.log('[PDF_DEBUG_FE] isModelMultimodalAsync: resolved default model2_config_id:', effectiveModelId);
      }
    } catch (error: unknown) {
      console.warn('[PDF_DEBUG_FE] isModelMultimodalAsync: get_model_assignments failed:', error);
    }
  }

  if (!effectiveModelId) {
    console.log('[PDF_DEBUG_FE] isModelMultimodalAsync: modelId unresolved, returning false');
    return false;
  }

  // 如果缓存未加载，先加载缓存
  if (!cachedModels || cachedModels.length === 0) {
    console.log('[PDF_DEBUG_FE] isModelMultimodalAsync: cachedModels is null, loading from backend...');
    try {
      const models = await ensureModelsCacheLoaded();

      // ★ 调试：打印所有模型的多模态状态
      console.log('[PDF_DEBUG_FE] isModelMultimodalAsync: cached models:', models.map(m => ({
        id: m.id,
        name: m.name,
        isMultimodal: m.isMultimodal,
      })));
    } catch (error: unknown) {
      console.error('[isModelMultimodalAsync] Failed to load models:', error);
      return false;
    }
  }

  const model = cachedModels?.find((m) => m.id === effectiveModelId);
  const result = model?.isMultimodal === true;

  console.log('[PDF_DEBUG_FE] isModelMultimodalAsync result:', {
    modelId: effectiveModelId,
    foundModel: model ? { id: model.id, name: model.name, isMultimodal: model.isMultimodal } : null,
    result,
  });

  return result;
}

export default useAvailableModels;
