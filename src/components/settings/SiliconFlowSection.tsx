/**
 * SiliconFlow Quick Configuration Section
 * 硅基流动快速配置组件
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Plus, Minus, Key, Server, Cpu, Brain, Image, Trash2, CheckCircle, Settings, Zap, Eye, EyeOff, Clock } from 'lucide-react';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'; // 使用Tauri v2 http插件
import { invoke } from '@tauri-apps/api/core';
import { showGlobalNotification } from '../UnifiedNotification';
import { SiliconFlowLogo } from '../ui/SiliconFlowLogo';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '../ui/shad/Card';
import { Input } from '../ui/shad/Input';
import { NotionButton } from '../ui/NotionButton';
import { Label } from '../ui/shad/Label';
import { Badge } from '../ui/shad/Badge';
import { CollapsibleModelSelector, type CollapsibleModelOption } from '../ui/shad/CollapsibleModelSelector';
import { TauriAPI } from '../../utils/tauriApi';
import { inferCapabilities, getModelDefaultParameters, applyProviderSpecificAdjustments } from '../../utils/modelCapabilities';
import { inferApiCapabilities } from '../../utils/apiCapabilityEngine';
import { getProviderIcon } from '../../utils/providerIconEngine';
import { cn } from '@/lib/utils';
import { vfsUnifiedIndexApi } from '../../api/vfsUnifiedIndexApi';

interface SiliconFlowModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  permission: any[];
  status: string; // Added for filtering
  name: string; // Added for model name
  supported_features: string[]; // Added for model capabilities
}

interface ApiConfig {
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  providerType?: string;
  isMultimodal: boolean;
  isReasoning: boolean;
  isEmbedding: boolean;
  isReranker: boolean;
  enabled: boolean;
  modelAdapter: string;
  maxOutputTokens?: number;
  temperature?: number;
  geminiApiVersion?: string;
  isBuiltin?: boolean;
  isReadOnly?: boolean;
  reasoningEffort?: string;
  thinkingEnabled?: boolean;
  thinkingBudget?: number;
  includeThoughts?: boolean;
  enableThinking?: boolean;
  minP?: number;
  topK?: number;
  supportsReasoning?: boolean;
  supportsTools?: boolean;
  repetitionPenalty?: number;
  reasoningSplit?: boolean;
  effort?: string;
  verbosity?: string;
}

type SiliconFlowSectionVariant = 'full' | 'quick' | 'models' | 'inline';

interface SiliconFlowSectionProps {
  onCreateConfig: (config: Omit<ApiConfig, 'id'>) => Promise<string | null | undefined> | void;
  showMessage?: (type: 'success' | 'error', text: string) => void;
  onBatchConfigsCreated?: (configIds: { [key: string]: string }) => void;
  onBatchCreateConfigs?: (configs: Array<Omit<ApiConfig, 'id'> & { tempId: string }>) => Promise<{ success: boolean; idMap: { [tempId: string]: string } }> | void | undefined;
  variant?: SiliconFlowSectionVariant;
}

export const SiliconFlowSection: React.FC<SiliconFlowSectionProps> = ({ onCreateConfig, showMessage, onBatchConfigsCreated, onBatchCreateConfigs, variant = 'full' }) => {
  const { t } = useTranslation(['common', 'settings']);
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<SiliconFlowModel[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [loading, setLoading] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);
  const [availableModels, setAvailableModels] = useState<SiliconFlowModel[]>([]); // New state for available models
  const [error, setError] = useState<string | null>(null); // New state for error message
  const [showApiKey, setShowApiKey] = useState(false);
  const [lastFetchTime, setLastFetchTime] = useState<number | null>(null); // 上次获取时间
  const [isFromCache, setIsFromCache] = useState(false); // 是否来自缓存

  const getModelCapabilities = useCallback((modelLike: SiliconFlowModel | string | null | undefined) => {
    const model = typeof modelLike === 'string' ? models.find(m => m.id === modelLike) : modelLike ?? undefined;
    const desc = model ? { id: model.id, supported_features: model.supported_features } : (typeof modelLike === 'string' ? modelLike : '');
    return inferCapabilities({ ...(desc as any), providerScope: 'siliconflow' });
  }, [models]);

  const selectedModelData = useMemo(() => models.find(m => m.id === selectedModel) ?? null, [models, selectedModel]);

  // 格式化时间显示
  const formatLastFetchTime = useCallback((timestamp: number | null) => {
    if (!timestamp) return t('common:siliconflow.never_fetched');

    const now = Date.now();
    const diff = now - timestamp;

    // 小于1分钟
    if (diff < 60000) {
      return t('common:siliconflow.just_now');
    }

    // 小于1小时
    if (diff < 3600000) {
      const minutes = Math.floor(diff / 60000);
      return t('common:siliconflow.minutes_ago', { minutes });
    }

    // 小于1天
    if (diff < 86400000) {
      const hours = Math.floor(diff / 3600000);
      return t('common:siliconflow.hours_ago', { hours });
    }

    // 大于1天，显示具体日期
    const date = new Date(timestamp);
    return date.toLocaleString();
  }, [t]);

  // 从缓存加载模型列表
  const loadCachedModels = useCallback(async () => {
    try {
      const cached = await TauriAPI.getSetting('siliconflow.cached_models');
      const cachedTime = await TauriAPI.getSetting('siliconflow.cached_models_time');

      if (cached && cachedTime) {
        const modelsData = JSON.parse(cached);
        const timestamp = parseInt(cachedTime);

        if (Array.isArray(modelsData)) {
          // 检查缓存的模型列表是否为空，如果为空则返回false触发自动获取
          if (modelsData.length === 0) {
            console.log('缓存的模型列表为空，将自动获取最新数据');
            return false;
          }

          setModels(modelsData);
          setLastFetchTime(timestamp);
          setIsFromCache(true);

          // 提取可用模型
          const availableModels = modelsData.filter((model: SiliconFlowModel) =>
            model.status === 'available' &&
            !model.name.includes('dev') &&
            !model.name.includes('test')
          );
          setAvailableModels(availableModels);

          return true;
        }
      }
    } catch (error: unknown) {
      console.warn('加载缓存模型列表失败:', error);
    }
    return false;
  }, []);

  // 保存模型列表到缓存
  const saveCachedModels = useCallback(async (modelsData: SiliconFlowModel[]) => {
    try {
      await TauriAPI.saveSetting('siliconflow.cached_models', JSON.stringify(modelsData));
      await TauriAPI.saveSetting('siliconflow.cached_models_time', Date.now().toString());
      setLastFetchTime(Date.now());
    } catch (error: unknown) {
      console.warn('保存缓存模型列表失败:', error);
    }
  }, []);

  // 清除缓存
  const clearCachedModels = useCallback(async () => {
    try {
      await TauriAPI.deleteSetting('siliconflow.cached_models');
      await TauriAPI.deleteSetting('siliconflow.cached_models_time');
      setLastFetchTime(null);
      setIsFromCache(false);
    } catch (error: unknown) {
      console.warn('清除缓存模型列表失败:', error);
    }
  }, []);

  // 合并基础能力和扩展能力，用于模型预览显示
  const selectedModelCapabilities = useMemo(() => {
    const baseCaps = getModelCapabilities(selectedModelData ?? selectedModel);
    const modelId = selectedModelData?.id ?? selectedModel;
    if (!modelId) return baseCaps;

    const extCaps = inferApiCapabilities({ id: modelId, name: selectedModelData?.name, providerScope: 'siliconflow' });
    // 合并：如果扩展能力检测到推理支持，覆盖基础能力
    return {
      ...baseCaps,
      isReasoning: baseCaps.isReasoning || extCaps.reasoning || extCaps.supportsThinkingTokens || extCaps.supportsHybridReasoning,
      supportsReasoning: baseCaps.supportsReasoning || extCaps.supportsReasoningEffort || extCaps.supportsThinkingTokens || extCaps.supportsHybridReasoning,
    };
  }, [getModelCapabilities, selectedModelData, selectedModel]);

  const persistApiKey = useCallback(async (value: string) => {
    try {
      const trimmed = value.trim();
      if (trimmed) {
        await TauriAPI.saveSetting('siliconflow.api_key', trimmed);
      } else {
        await TauriAPI.deleteSetting('siliconflow.api_key');
      }
      // 触发自定义事件，通知其他实例更新API Key
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('siliconflow-apikey-changed', { detail: { apiKey: trimmed } }));
      }
    } catch (error: unknown) {
      console.error('保存SiliconFlow API Key失败:', error);
      showGlobalNotification('error', t('common:siliconflow.save_api_key_failed'));
    }
  }, [t]);

  // 组件加载时从持久化存储恢复API密钥
  React.useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        let savedApiKey = await TauriAPI.getSetting('siliconflow.api_key');
        if (!savedApiKey && typeof window !== 'undefined' && window.localStorage) {
          const legacy = window.localStorage.getItem('siliconflow_api_key');
          if (legacy) {
            savedApiKey = legacy;
            await persistApiKey(legacy);
            try { window.localStorage.removeItem('siliconflow_api_key'); } catch (error: unknown) { console.error('移除旧版 SiliconFlow Key 失败:', error); }
          }
        }
        if (mounted && savedApiKey) {
          setApiKey(savedApiKey);
        }
      } catch (error: unknown) {
        console.error('加载SiliconFlow API Key失败:', error);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [persistApiKey]);

  // 监听其他实例的API Key变化（修复多实例状态不同步问题）
  React.useEffect(() => {
    const handleApiKeyChanged = (event: Event) => {
      const customEvent = event as CustomEvent<{ apiKey: string }>;
      if (customEvent.detail?.apiKey !== undefined) {
        setApiKey(customEvent.detail.apiKey);
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('siliconflow-apikey-changed', handleApiKeyChanged);
      return () => {
        window.removeEventListener('siliconflow-apikey-changed', handleApiKeyChanged);
      };
    }
  }, []);

  // API密钥加载后自动加载缓存的模型列表
  React.useEffect(() => {
    if (apiKey.trim()) {
      // 自动加载缓存的模型列表，如果缓存为空或不存在则自动获取
      (async () => {
        const loadedFromCache = await loadCachedModels();
        if (!loadedFromCache) {
          console.log('没有有效的缓存，将自动获取模型列表');
          // 延迟调用 fetchSiliconFlowModels，避免循环依赖
          setTimeout(() => {
            void fetchSiliconFlowModels(true);
          }, 0);
        }
      })();
    } else {
      // 如果没有API key，清空模型列表和缓存状态
      setModels([]);
      setAvailableModels([]);
      setLastFetchTime(null);
      setIsFromCache(false);
    }
  }, [apiKey, loadCachedModels]);

  // API密钥变化时自动保存
  const handleApiKeyChange = (value: string) => {
    // 立即更新状态（修复移动端输入后按钮仍禁用的问题）
    setApiKey(value);
    // 异步保存到后端
    void persistApiKey(value);
  };

  // 清除保存的API密钥
  const clearSavedApiKey = async () => {
    setApiKey('');
    setModels([]);
    setAvailableModels([]);
    setSelectedModel('');
    setLastFetchTime(null);
    setIsFromCache(false);
    await persistApiKey('');
    await clearCachedModels();
    showGlobalNotification('success', t('common:siliconflow.api_key_cleared'));
  };

  const isStreamChannelError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('fetch_read_body') && message.includes('streamChannel');
  };

  const fetchSiliconFlowModels = useCallback(async (forceRefresh = false) => {
    if (!apiKey.trim()) {
      showGlobalNotification('warning', t('common:siliconflow.enter_api_key_first'));
      return;
    }

    // 如果不是强制刷新，先尝试加载缓存
    if (!forceRefresh) {
      const loadedFromCache = await loadCachedModels();
      if (loadedFromCache) {
        setIsFromCache(true);
        setLoading(false);
        return;
      }
    }

    setLoading(true);
    setModels([]);
    setAvailableModels([]);
    setError(null);
    setIsFromCache(false);

    try {
      const fetchModels = async (doFetch: typeof fetch) => {
        const response = await doFetch('https://api.siliconflow.cn/v1/models', {
          method: 'GET',
          headers: {
            // 修复：去除首尾空格，避免因空白字符导致401
            'Authorization': `Bearer ${apiKey.trim()}`,
          },
        });

        if (!response.ok) {
          // 尝试解析错误信息
          let errorDetails: string;
          try {
            const errJson = await response.json();
            errorDetails = JSON.stringify(errJson);
          } catch {
            errorDetails = response.statusText || `HTTP ${response.status}`;
          }
          throw new Error(t('common:siliconflow.api_request_failed', {
            status: response.status,
            statusText: errorDetails,
          }));
        }

        try {
          return await response.json() as { data?: SiliconFlowModel[] };
        } catch (error: unknown) {
          if (isStreamChannelError(error)) {
            const wrapped = new Error('TAURI_HTTP_READ_BODY_FAILED');
            (wrapped as any).cause = error;
            throw wrapped;
          }
          throw error;
        }
      };

      let data: { data?: SiliconFlowModel[] };
      try {
        // 使用 Tauri v2 http 插件进行网络请求（遵循标准 Fetch API）
        data = await fetchModels(tauriFetch as typeof fetch);
      } catch (error: unknown) {
        if (isStreamChannelError(error) || (error instanceof Error && error.message === 'TAURI_HTTP_READ_BODY_FAILED')) {
          // Tauri HTTP 读体失败时回退到浏览器 fetch（部分版本的插件存在 streamChannel 兼容问题）
          data = await fetchModels(fetch);
        } else {
          throw error;
        }
      }
      
      if (data?.data && Array.isArray(data.data)) {
        // 修改：获取所有可用模型，不再过滤嵌入和重排序模型
        const allModels = data.data.filter((model: SiliconFlowModel) =>
          // 排除音频/视频模型
          !model.id.includes('tts') &&
          !model.id.includes('whisper') &&
          !model.id.includes('video') &&
          !model.id.includes('image') &&
          !model.id.includes('kolors') &&
          !model.id.includes('flux')
        );
        setModels(allModels);

        // 提取可用模型到单独的数组
        const availableModels = allModels.filter(model =>
          model.status === 'available' &&
          !model.name.includes('dev') &&
          !model.name.includes('test')
        );

        // 保存到缓存
        await saveCachedModels(allModels);
        setAvailableModels(availableModels);

        if (availableModels.length === 0) {
          // 如果没有可用模型，显示获取成功但无可用模型的消息
          showGlobalNotification('success', t('common:siliconflow.models_fetched_success', { count: allModels.length }));
        } else {
          // 如果有可用模型，显示获取成功和可用模型数量
          showGlobalNotification('success', t('common:siliconflow.models_fetched_success', { count: allModels.length }));
        }
      } else {
        throw new Error(t('common:siliconflow.invalid_response_format'));
      }
    } catch (error: unknown) {
      console.error(t('common:siliconflow.fetch_models_error'), error);
      showGlobalNotification('error', t('common:siliconflow.fetch_models_failed_message', { error: error instanceof Error ? error.message : 'Unknown error' }));
      setModels([]);
      setAvailableModels([]);
    } finally {
      setLoading(false);
    }
  }, [apiKey, showGlobalNotification, t, loadCachedModels, saveCachedModels]);

  /**
   * 获取特定模型的默认参数
   * 这里维护了不同模型的特定配置，便于统一管理
   * 
   * 维护指南：
   * 1. 精确匹配优先：在 modelSpecificConfigs 对象中添加模型的完整ID
   * 2. 模式匹配兜底：在下方的条件判断中添加通用规则
   * 3. 参数说明：
   *    - maxOutputTokens: 模型最大输出令牌数限制
   *    - temperature: 温度参数，控制输出随机性（0-2）
   * 
   * 添加新模型示例：
   * 'Pro/YourModel/Name-Version': { maxOutputTokens: 4096, temperature: 0.7 }
   */
  interface ModelDefaultParams {
    maxOutputTokens?: number;
    temperature?: number;
    enableThinking?: boolean;
    thinkingBudget?: number;
    includeThoughts?: boolean;
    minP?: number;
    topK?: number;
  }

  // 统一复用能力模块的默认参数
  const getDefaultParams = useCallback((modelId: string) => getModelDefaultParameters(modelId), []);

  const collapsibleOptions: CollapsibleModelOption[] = useMemo(() => {
    const list = availableModels.length > 0 ? availableModels : models;
    return [...list]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(m => ({ value: m.id, label: m.id, icon: getProviderIcon(m.id) }));
  }, [models, availableModels]);

  // 创建API配置
  const handleCreateConfig = async () => {
    if (!apiKey.trim()) {
      showGlobalNotification('warning', t('common:siliconflow.api_key_required_create'));
      return;
    }

    if (!selectedModel) {
      showGlobalNotification('warning', t('common:siliconflow.please_select_model'));
      return;
    }

    const modelInfo = selectedModelData ?? models.find(m => m.id === selectedModel);
    if (!modelInfo) {
      showGlobalNotification('error', t('common:siliconflow.selected_model_not_exist'));
      return;
    }

    const { isMultimodal, isReasoning, isEmbedding, isReranker, modelAdapter, supportsReasoning, supportsTools } = getModelCapabilities(modelInfo);
    const capsExt = inferApiCapabilities({ id: modelInfo.id, name: modelInfo.name, providerScope: 'siliconflow' });
    // 修复：只有当模型明确支持工具调用时才启用，避免给不支持工具调用的模型传递工具配置
    const effectiveSupportsTools = supportsTools;
    const effectiveSupportsReasoning =
      supportsReasoning ||
      capsExt.reasoning ||
      capsExt.supportsReasoningEffort ||
      capsExt.supportsThinkingTokens ||
      capsExt.supportsHybridReasoning;
    
    // 获取模型的默认参数
    const modelDefaults = getDefaultParams(selectedModel);

    const enableThinkingDefault = effectiveSupportsReasoning
      ? modelDefaults.enableThinking ?? (capsExt.supportsThinkingTokens || capsExt.supportsHybridReasoning || isReasoning)
      : false;
    const thinkingBudgetDefault = effectiveSupportsReasoning ? modelDefaults.thinkingBudget : undefined;
    const includeThoughtsDefault = effectiveSupportsReasoning
      ? modelDefaults.includeThoughts ?? capsExt.supportsThinkingTokens
      : false;

    const configData: Omit<ApiConfig, 'id'> = {
      name: t('common:siliconflow.config_name_template', { model: selectedModel }),
      // 修复：存储时也去除首尾空格，避免后续请求失败
      apiKey: apiKey.trim(),
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: selectedModel,
      providerType: 'siliconflow',
      isMultimodal,
      isReasoning: effectiveSupportsReasoning,
      isEmbedding,
      isReranker,
      enabled: true,
      modelAdapter,
      supportsReasoning: effectiveSupportsReasoning,
      supportsTools: effectiveSupportsTools,
      // 应用模型特定的默认参数，如果没有则使用全局默认值
      maxOutputTokens: modelDefaults.maxOutputTokens ?? 8192,
      temperature: modelDefaults.temperature ?? 0.7,
      thinkingEnabled: enableThinkingDefault,
      enableThinking: enableThinkingDefault,
      thinkingBudget: thinkingBudgetDefault,
      includeThoughts: includeThoughtsDefault,
      minP: modelDefaults.minP ?? undefined,
      topK: modelDefaults.topK ?? undefined,
    };

    // 提供商特定调整：如 DeepSeek-V3 系列工具调用与思维模式互斥
    Object.assign(configData, applyProviderSpecificAdjustments({
      modelId: selectedModel,
      supportsTools: effectiveSupportsTools,
      supportsReasoning,
    }));

    try {
      await onCreateConfig(configData);
      showGlobalNotification('success', t('common:siliconflow.config_created_success', { model: selectedModel }));
      
      // 只重置选中的模型，保留API密钥和模型列表以便继续添加其他模型
      setSelectedModel('');
      // 不重置API密钥和模型列表，方便用户继续添加其他模型
      // setApiKey('');
      // setModels([]);
      // setIsExpanded(false);
    } catch (error: unknown) {
      showGlobalNotification('error', t('common:siliconflow.config_create_failed', { error: error instanceof Error ? error.message : 'Unknown error' }));
    }
  };

  // 一键分配功能 - 预设模型配置
  // 注意：嵌入模型不再通过全局分配，而是通过维度管理
  const PRESET_MODELS = [
    { model: 'deepseek-ai/DeepSeek-V3.2', name: 'SiliconFlow - deepseek-ai/DeepSeek-V3.2', assignmentKey: t('settings:mapping_keys.model2_configured') },
    { model: 'deepseek-ai/DeepSeek-V3.2', name: 'SiliconFlow - deepseek-ai/DeepSeek-V3.2', assignmentKey: t('settings:mapping_keys.qbank_ai_grading_configured') },
    { model: 'Qwen/Qwen3-30B-A3B-Instruct-2507', name: 'SiliconFlow - Qwen/Qwen3-30B-A3B-Instruct-2507', assignmentKey: t('settings:mapping_keys.anki_configured') },
    // 嵌入模型将通过维度管理创建，但仍需创建 API 配置
    { model: 'BAAI/bge-m3', name: 'SiliconFlow - BAAI/bge-m3', assignmentKey: '__embedding_text__', isDimensionModel: true, dimension: 1024, modality: 'text' as const },
    { model: 'BAAI/bge-reranker-v2-m3', name: 'SiliconFlow - BAAI/bge-reranker-v2-m3', assignmentKey: t('settings:mapping_keys.reranker_configured') },
    { model: 'inclusionAI/Ling-mini-2.0', name: 'SiliconFlow - inclusionAI/Ling-mini-2.0', assignmentKey: t('settings:mapping_keys.chat_title_configured') },
    { model: 'tencent/Hunyuan-MT-7B', name: 'SiliconFlow - tencent/Hunyuan-MT-7B', assignmentKey: t('settings:mapping_keys.translation_configured') },
    { model: 'deepseek-ai/DeepSeek-V3.2', name: 'SiliconFlow - deepseek-ai/DeepSeek-V3.2', assignmentKey: t('settings:mapping_keys.question_parsing_configured') },
    { model: 'inclusionAI/Ling-mini-2.0', name: 'SiliconFlow - inclusionAI/Ling-mini-2.0', assignmentKey: t('settings:mapping_keys.memory_decision_configured') },
  ];

  // OCR 专用模型预设（支持多引擎，按优先级排列，全部默认启用）
  // 注意：这些模型会自动根据名称推断适配器类型
  // OCR-VLM（专业 OCR，快速/便宜）排在前面，通用 VLM（能力强/较贵）排在后面
  // 普通 OCR 任务自动使用前面的快速模型；题目集导入通过 VlmGroundingService 独立选择 GLM-4.6V
  const PRESET_OCR_MODELS = [
    { 
      model: 'PaddlePaddle/PaddleOCR-VL-1.5', 
      name: 'SiliconFlow - PaddleOCR-VL-1.5',
      engineType: 'paddle_ocr_vl',
      description: '免费开源 OCR 1.5 版，支持 109 种语言，精度达 94.5%',
      isFree: true,
    },
    { 
      model: 'PaddlePaddle/PaddleOCR-VL', 
      name: 'SiliconFlow - PaddleOCR-VL',
      engineType: 'paddle_ocr_vl_v1',
      description: '免费开源 OCR 旧版，支持坐标输出，作为 1.5 版的备用',
      isFree: true,
    },
    { 
      model: 'deepseek-ai/DeepSeek-OCR', 
      name: 'SiliconFlow - DeepSeek-OCR',
      engineType: 'deepseek_ocr',
      description: '专业 OCR 模型，支持坐标定位',
      isFree: false,
    },
    {
      model: 'zai-org/GLM-4.6V',
      name: 'SiliconFlow - GLM-4.6V',
      engineType: 'glm4v_ocr',
      description: '智谱 106B MoE 多模态模型，支持坐标定位，题目集导入自动优先使用',
      isFree: false,
    },
    {
      model: 'Qwen/Qwen3-VL-8B-Instruct',
      name: 'SiliconFlow - Qwen3-VL-8B',
      engineType: 'generic_vlm',
      description: '通用多模态模型，适合简单文档识别（备用）',
      isFree: false,
    },
  ];
 
  // 一键分配处理函数
  const handleOneClickAssign = async () => {
    if (!apiKey.trim()) {
      showGlobalNotification('warning', t('common:siliconflow.enter_api_key_first'));
      return;
    }

    setLoading(true);

    try {
      // 准备批量创建的配置
      const batchConfigs: Array<Omit<ApiConfig, 'id'> & { tempId: string }> = [];
      const configMapping: { [key: string]: string } = {};

      // 去重：相同 baseUrl+model+apiKey 只创建一次配置
      const createdMap: { [key: string]: string } = {};
      const baseUrl = 'https://api.siliconflow.cn/v1';

      // 创建通用模型配置的辅助函数
      const createModelConfig = (modelId: string, modelName: string, index: number) => {
        const compositeKey = `${baseUrl}|${modelId}|${apiKey.trim()}`;
        let tempId = createdMap[compositeKey];
        if (tempId) return tempId; // 已存在，直接返回 tempId

        tempId = `${Date.now()}_${index}_${Math.random().toString(36).substr(2, 9)}`;
        createdMap[compositeKey] = tempId;

        const presetModelData = models.find(m => m.id === modelId);
        const {
          isMultimodal,
          isReasoning,
          isEmbedding,
          isReranker,
          modelAdapter,
          supportsReasoning,
          supportsTools,
        } = getModelCapabilities(presetModelData ?? modelId);
        const capsExt = inferApiCapabilities({ id: modelId, name: presetModelData?.name, providerScope: 'siliconflow' });
        const effectiveSupportsTools = supportsTools;
        const modelDefaults = getModelDefaultParameters(modelId);
        const effectiveSupportsReasoning =
          supportsReasoning ||
          capsExt.reasoning ||
          capsExt.supportsReasoningEffort ||
          capsExt.supportsThinkingTokens ||
          capsExt.supportsHybridReasoning;
        const enableThinkingDefault = effectiveSupportsReasoning
          ? modelDefaults.enableThinking ?? (capsExt.supportsThinkingTokens || capsExt.supportsHybridReasoning || isReasoning)
          : false;
        const thinkingBudgetDefault = effectiveSupportsReasoning ? modelDefaults.thinkingBudget : undefined;
        const includeThoughtsDefault = effectiveSupportsReasoning
          ? modelDefaults.includeThoughts ?? capsExt.supportsThinkingTokens
          : false;

        const configData = {
          tempId,
          name: modelName,
          apiKey: apiKey.trim(),
          baseUrl,
          model: modelId,
          providerType: 'siliconflow',
          isMultimodal,
          isReasoning: effectiveSupportsReasoning,
          isEmbedding,
          isReranker,
          enabled: true,
          modelAdapter,
          supportsReasoning: effectiveSupportsReasoning,
          supportsTools: effectiveSupportsTools,
          maxOutputTokens: modelDefaults.maxOutputTokens ?? 8192,
          temperature: modelDefaults.temperature ?? 0.7,
          isBuiltin: false,
          isReadOnly: false,
          thinkingEnabled: enableThinkingDefault,
          enableThinking: enableThinkingDefault,
          thinkingBudget: thinkingBudgetDefault,
          includeThoughts: includeThoughtsDefault,
          minP: modelDefaults.minP ?? undefined,
          topK: modelDefaults.topK ?? undefined,
          contextWindow: capsExt.contextWindow,
        };
        Object.assign(
          configData,
          applyProviderSpecificAdjustments({
            modelId,
            supportsTools: effectiveSupportsTools,
            supportsReasoning,
          })
        );
        batchConfigs.push(configData);
        return tempId;
      };

      // 创建通用模型配置
      for (let i = 0; i < PRESET_MODELS.length; i++) {
        const presetModel = PRESET_MODELS[i];
        const tempId = createModelConfig(presetModel.model, presetModel.name, i);
        configMapping[presetModel.assignmentKey] = tempId;
      }

      // 创建 OCR 专用模型配置（支持多个 OCR 引擎）
      const ocrConfigIds: string[] = [];
      for (let i = 0; i < PRESET_OCR_MODELS.length; i++) {
        const ocrModel = PRESET_OCR_MODELS[i];
        const tempId = createModelConfig(ocrModel.model, ocrModel.name, PRESET_MODELS.length + i);
        ocrConfigIds.push(tempId);
        // 第一个 OCR 模型作为默认分配
        if (i === 0) {
          configMapping[t('settings:mapping_keys.exam_sheet_ocr_configured')] = tempId;
        }
      }

      console.log('🎯 准备批量创建配置:');
      console.log('  - 配置数量:', batchConfigs.length);
      console.log('  - 配置ID列表:', batchConfigs.map(c => c.tempId));
      console.log('  - 配置名称列表:', batchConfigs.map(c => c.name));
      
      // 批量创建所有配置
      let success = false;
      let idMap: { [tempId: string]: string } = {};
      if (onBatchCreateConfigs) {
        console.log('📤 调用 onBatchCreateConfigs...');
        const result = await onBatchCreateConfigs(batchConfigs);
        if (result && typeof result === 'object') {
          success = !!result.success;
          idMap = result.idMap || {};
        }
        console.log('📥 onBatchCreateConfigs 返回:', result);
      } else {
        // 回退到单个创建
        for (const config of batchConfigs) {
          const { tempId, ...configData } = config;
          const newId = await onCreateConfig(configData);
          if (newId) {
            idMap[tempId] = newId;
          } else {
            // 若未返回新ID，则保留原临时ID（理论上不会发生）
            idMap[tempId] = tempId;
          }
        }
        success = true;
      }

      if (success) {
        // 调用回调函数自动应用模型分配（过滤掉维度模型的 assignmentKey）
        if (onBatchConfigsCreated) {
          const finalMapping: { [key: string]: string } = {};
          Object.entries(configMapping).forEach(([assignmentKey, tempId]) => {
            // 跳过维度模型的 assignmentKey，它们不参与全局模型分配
            if (!assignmentKey.startsWith('__')) {
              finalMapping[assignmentKey] = idMap[tempId] || tempId;
            }
          });
          onBatchConfigsCreated(finalMapping);
        }

        // 创建嵌入维度并设置为默认
        try {
          for (const presetModel of PRESET_MODELS) {
            if ((presetModel as any).isDimensionModel) {
              const tempId = configMapping[presetModel.assignmentKey];
              const realConfigId = idMap[tempId] || tempId;
              const { dimension, modality } = presetModel as any;
              
              console.log(`📊 创建嵌入维度: ${dimension} (${modality}), 模型: ${realConfigId}`);
              
              // 创建维度并绑定模型
              await vfsUnifiedIndexApi.createDimension(dimension, modality, realConfigId, presetModel.name);
              
              // 设置为默认维度
              await vfsUnifiedIndexApi.setDefaultEmbeddingDimension(dimension, modality);
              
              console.log(`✅ 已设置默认 ${modality} 嵌入维度: ${dimension}`);
            }
          }
        } catch (e: unknown) {
          console.warn('创建嵌入维度失败:', e);
          // 不阻止整体流程
        }

        // M6 fix: 合并模式 — 保留用户已有的自定义 OCR 引擎，仅补充预设引擎
        try {
          // 先读取现有引擎列表
          let existingEngines: Array<{ configId: string; model: string; engineType: string; name: string; isFree: boolean; enabled: boolean; priority: number }> = [];
          try {
            existingEngines = await invoke<typeof existingEngines>('get_available_ocr_models');
          } catch { /* 首次使用，列表为空 */ }

          // 合并逻辑：预设引擎排在前面，已有自定义引擎追加在后
          // 匹配规则：model 或 engineType 相同视为同一引擎（处理模型 ID 升级场景，如 4.1V → 4.6V）
          const merged = [
            ...PRESET_OCR_MODELS.map((ocrModel, idx) => {
              const existing = existingEngines.find(
                e => e.model === ocrModel.model || e.engineType === ocrModel.engineType
              );
              const newConfigId = idMap[ocrConfigIds[idx]] || ocrConfigIds[idx];
              if (existing) {
                return {
                  ...existing,
                  configId: newConfigId,
                  model: ocrModel.model,
                  name: ocrModel.name,
                };
              }
              return {
                configId: newConfigId,
                model: ocrModel.model,
                engineType: ocrModel.engineType,
                name: ocrModel.name,
                isFree: ocrModel.isFree,
                enabled: true,
                priority: idx,
              };
            }),
            // 保留用户自定义引擎（非预设的 model 且非预设的 engineType）
            ...existingEngines.filter(e =>
              !PRESET_OCR_MODELS.some(p => p.model === e.model || p.engineType === e.engineType)
            ),
          ].map((e, i) => ({ ...e, priority: i }));

          await invoke('save_available_ocr_models', { models: merged });
          console.log('📝 已合并保存 OCR 模型配置（保留自定义引擎）:', merged);
        } catch (e: unknown) {
          console.warn('保存 OCR 模型配置失败:', e);
        }

        // 弹出一键分配成功提示
        showGlobalNotification('success', t('common:siliconflow.one_click_success'));
      } else {
        showGlobalNotification('error', t('common:siliconflow.one_click_failed'));
      }
    } catch (error: unknown) {
      showGlobalNotification('error', t('common:siliconflow.one_click_error', { error: error instanceof Error ? error.message : 'Unknown error' }));
    } finally {
      setLoading(false);
    }
  };

  const showQuickCard = variant === 'full' || variant === 'quick';
  const showModelControls = variant === 'full' || variant === 'models';
  const isInline = variant === 'inline';

  const quickBody = (
    <div className="space-y-3">
      <div className="relative">
        <Input
          type={showApiKey ? 'text' : 'password'}
          value={apiKey}
          onChange={e => handleApiKeyChange(e.target.value)}
          placeholder={t('common:siliconflow.api_key_placeholder_local')}
          className="pr-10"
        />
        <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setShowApiKey(v => !v)} className="absolute inset-y-0 right-0 !rounded-none" title={showApiKey ? t('common:siliconflow.hide') : t('common:siliconflow.show')} aria-label={showApiKey ? t('common:siliconflow.hide_api_key') : t('common:siliconflow.show_api_key')}>
          {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </NotionButton>
      </div>
      <div className="flex items-center justify-between pt-2">
        {/* Notion 风格按钮 - 一键分配 */}
        <NotionButton variant="ghost" size="sm" onClick={handleOneClickAssign} disabled={loading || !apiKey.trim()} className="text-blue-600 dark:text-blue-400 bg-blue-500/10 hover:bg-blue-500/20">
          <Zap className="h-3.5 w-3.5" />
          {t('common:siliconflow.one_click_assign')}
        </NotionButton>
        {/* Notion 风格按钮 - 清除 (右对齐) */}
        <NotionButton variant="ghost" size="sm" onClick={clearSavedApiKey} disabled={loading || !apiKey} title={t('common:siliconflow.clear_api_key_title')} className="text-red-600 dark:text-red-400 bg-red-500/10 hover:bg-red-500/20">
          <Trash2 className="h-3.5 w-3.5" />
          {t('common:siliconflow.clear_button')}
        </NotionButton>
      </div>
    </div>
  );

  if (isInline) {
    return quickBody;
  }

  const quickContainerClass =
    variant === 'full'
      ? 'rounded-xl border border-transparent ring-1 ring-border/40 bg-card text-card-foreground shadow-sm'
      : 'mt-4 rounded-xl border border-transparent ring-1 ring-border/40 bg-card text-card-foreground shadow-sm';
  const quickHeaderPadding = variant === 'full' ? 'px-5 py-4' : 'px-4 py-3';
  const quickBodyClass =
    variant === 'full'
      ? 'border-t border-[hsl(var(--border))]/60 px-5 py-4 space-y-3'
      : 'border-t border-[hsl(var(--border))]/60 px-4 py-3 space-y-3';

  const quickCard = (
    <div className={quickContainerClass}>
      <div
        className={`flex cursor-pointer select-none items-center justify-between ${quickHeaderPadding}`}
        onClick={() => setIsExpanded(v => !v)}
        role="button"
        tabIndex={0}
      >
        <div className="flex items-center gap-3">
          <SiliconFlowLogo className="h-6" />
          <div>
            <p className="text-sm font-medium">{t('common:siliconflow.section_title')}</p>
            <p className="text-xs text-muted-foreground">{t('common:siliconflow.section_description')}</p>
          </div>
        </div>
        {isExpanded ? <Minus className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
      </div>
      {isExpanded && <div className={quickBodyClass}>{quickBody}</div>}
    </div>
  );

  const modelSelectionPreview = selectedModel && (
    <div className="rounded-md border border-border p-3 text-sm grid gap-2">
      <div className="flex items-center gap-2">
        <SiliconFlowLogo className="h-4 opacity-80" />
        <span className="font-medium">{t('common:siliconflow.model_preview_title')}</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex items-center gap-2 text-muted-foreground"><Cpu className="h-4 w-4" /> {t('common:siliconflow.model_label')}: {selectedModel}</div>
        <div className="flex items-center gap-2 text-muted-foreground"><Server className="h-4 w-4" /> {t('common:siliconflow.api_address_label')}: https://api.siliconflow.cn/v1</div>
        <div className="flex items-center gap-2 text-muted-foreground"><Image className="h-4 w-4" /> {t('common:siliconflow.multimodal_label')}: {selectedModelCapabilities.isMultimodal ? t('common:siliconflow.yes') : t('common:siliconflow.no')}</div>
        <div className="flex items-center gap-2 text-muted-foreground"><Brain className="h-4 w-4" /> {t('common:siliconflow.reasoning_model_label')}: {selectedModelCapabilities.isReasoning ? t('common:siliconflow.yes') : t('common:siliconflow.no')}</div>
        <div className="flex items-center gap-2 text-muted-foreground"><Settings className="h-4 w-4" /> {t('common:siliconflow.embedding_model_label')}: {selectedModelCapabilities.isEmbedding ? t('common:siliconflow.yes') : t('common:siliconflow.no')}</div>
        <div className="flex items-center gap-2 text-muted-foreground"><Settings className="h-4 w-4" /> {t('common:siliconflow.reranker_model_label')}: {selectedModelCapabilities.isReranker ? t('common:siliconflow.yes') : t('common:siliconflow.no')}</div>
        <div className="flex items-center gap-2 text-muted-foreground"><Settings className="h-4 w-4" /> {t('common:siliconflow.thinking_params_label')}: {selectedModelCapabilities.supportsReasoning ? t('common:siliconflow.supports') : t('common:siliconflow.not_supports')}</div>
        <div className="flex items-center gap-2 text-muted-foreground"><Settings className="h-4 w-4" /> {t('common:siliconflow.adapter_label')}: {selectedModelCapabilities.modelAdapter}</div>
        {(() => {
          const defaults = getModelDefaultParameters(selectedModel);
          return (
            <>
              {defaults.maxOutputTokens && (
                <div className="flex items-center gap-2 text-muted-foreground"><Settings className="h-4 w-4" /> {t('common:siliconflow.default_max_tokens_label')}: {defaults.maxOutputTokens}</div>
              )}
              {defaults.temperature !== undefined && (
                <div className="flex items-center gap-2 text-muted-foreground"><Settings className="h-4 w-4" /> {t('common:siliconflow.default_temperature_label')}: {defaults.temperature}</div>
              )}
            </>
          );
        })()}
      </div>
    </div>
  );

  const modelControls = (
    <div className={variant === 'models' ? 'rounded-lg border border-dashed border-border/50 bg-muted/20 p-4 space-y-3' : 'space-y-3'}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <SiliconFlowLogo className="h-4" />
          <NotionButton
            variant="default"
            onClick={() => fetchSiliconFlowModels(true)}
            disabled={loading || !apiKey.trim()}
          >
            <Download className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            {loading ? t('common:siliconflow.fetching_models') : t('common:siliconflow.get_model_list')}
          </NotionButton>
        </div>
        <p className="text-sm text-muted-foreground">{t('common:siliconflow.models_count', { count: models.length })}</p>
      </div>
      <CollapsibleModelSelector
        value={selectedModel}
        onChange={setSelectedModel}
        options={collapsibleOptions}
        placeholder={t('common:siliconflow.select_model_placeholder')}
        searchPlaceholder={t('common:siliconflow.search_placeholder')}
        emptyText={t('common:siliconflow.no_match')}
        title={t('common:siliconflow.select_model')}
        totalCount={models.length}
        isFromCache={isFromCache}
        cacheTimeText={lastFetchTime ? formatLastFetchTime(lastFetchTime) : undefined}
      />
      {modelSelectionPreview}
      <div className="flex items-center justify-between">
        {/* 缓存状态 - 左下角 */}
        {lastFetchTime ? (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            <span>
              {isFromCache ? t('common:siliconflow.cached_from') : t('common:siliconflow.updated_at')}: {formatLastFetchTime(lastFetchTime)}
            </span>
            {isFromCache && (
              <Badge variant="outline" className="ml-1 text-xs">
                {t('common:siliconflow.cached')}
              </Badge>
            )}
          </div>
        ) : (
          <div />
        )}
        <NotionButton variant="primary" onClick={handleCreateConfig} disabled={!selectedModel} className="shrink-0 whitespace-nowrap">
          <Plus className="h-3.5 w-3.5" />
          {t('common:siliconflow.create_api_config')}
        </NotionButton>
      </div>
    </div>
  );

  const modelCardDefault = (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-base">{t('common:siliconflow.select_model')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">{modelControls}</CardContent>
    </Card>
  );

  return (
    <div className="w-full space-y-4">
      {showQuickCard && quickCard}
      {showModelControls && variant !== 'models' && modelCardDefault}
      {showModelControls && variant === 'models' && modelControls}
    </div>
  );
};
