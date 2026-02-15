import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
} from '../ui/shad/Dialog';
import { Input } from '../ui/shad/Input';
import { NotionButton } from '../ui/NotionButton';
import { Checkbox } from '../ui/shad/Checkbox';
import { AppSelect } from '../ui/app-menu';
import { Switch } from '../ui/shad/Switch';
import { Label } from '../ui/shad/Label';
import { CustomScrollArea } from '../custom-scroll-area';
import { Badge } from '../ui/shad/Badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/shad/Tabs';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/shad/Card';
import { 
  Eye, 
  EyeOff, 
  Sparkles, 
  Info, 
  Bot, 
  Brain, 
  Image as ImageIcon, 
  Database, 
  Search, 
  Wrench,
  Settings2,
  Zap,
  Cpu,
  Sliders,
  LayoutGrid
} from 'lucide-react';
import type { ApiConfig as BaseApiConfig } from '../../types';
import { inferApiCapabilities } from '../../utils/apiCapabilityEngine';
import { cn } from '../../lib/utils';
import { showGlobalNotification } from '../UnifiedNotification';

// Tauri 2.x API导入（可选）
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

const isTauri = typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__;
const invoke = isTauri ? tauriInvoke : null;

// 子适配器列表（与后端 ADAPTER_REGISTRY 保持一致）
const SUPPORTED_MODEL_ADAPTERS = [
  'general',    // 通用 OpenAI 兼容
  'google',     // Gemini
  'anthropic',  // Claude
  'deepseek',   // DeepSeek
  'qwen',       // 通义千问
  'zhipu',      // 智谱 GLM
  'doubao',     // 字节豆包
  'moonshot',   // Kimi/Moonshot
  'grok',       // xAI Grok
  'minimax',    // MiniMax
] as const;

const ADAPTER_DEFAULT_BASE_URL: Record<string, string> = {
  general: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com',
  anthropic: 'https://api.anthropic.com',
  deepseek: 'https://api.deepseek.com/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  moonshot: 'https://api.moonshot.cn/v1',
  grok: 'https://api.x.ai/v1',
  minimax: 'https://api.minimax.io/v1',
};

export const GENERAL_DEFAULT_MIN_P = 0.05;
export const GENERAL_DEFAULT_TOP_K = 50;

const normalizeBaseUrlForCompare = (url: string) => url.trim().replace(/\/+$/u, '');

const normalizeAdapter = (adapter?: string): (typeof SUPPORTED_MODEL_ADAPTERS)[number] => {
  if (!adapter) return 'general';
  const lower = adapter.toLowerCase();
  // 精确匹配
  if (SUPPORTED_MODEL_ADAPTERS.includes(lower as (typeof SUPPORTED_MODEL_ADAPTERS)[number])) {
    return lower as (typeof SUPPORTED_MODEL_ADAPTERS)[number];
  }
  // 兼容旧版 'openai' 映射到 'general'
  if (lower === 'openai') return 'general';
  return 'general';
};

type EditApiConfig = BaseApiConfig & {
  temperature?: number;
  maxOutputTokens?: number;
  maxTokensLimit?: number;
  reasoningEffort?: string;
  thinkingEnabled?: boolean;
  thinkingBudget?: number;
  includeThoughts?: boolean;
  enableThinking?: boolean;
  minP?: number;
  topK?: number;
  repetitionPenalty?: number;
  reasoningSplit?: boolean;
  effort?: string;
  verbosity?: string;
};

type CapabilityKey = 'isMultimodal' | 'isReasoning' | 'isEmbedding' | 'isReranker' | 'supportsTools';

interface ApiEditModalProps {
  api: EditApiConfig;
  onSave: (api: EditApiConfig) => void;
  onCancel: () => void;
  hideConnectionFields?: boolean;
  lockedVendorInfo?: {
    name?: string;
    baseUrl?: string;
    providerType?: string;
  };
  /** 嵌入模式：不使用 Dialog 包裹，直接渲染内容（用于移动端三屏布局） */
  embeddedMode?: boolean;
}

export const ShadApiEditModal: React.FC<ApiEditModalProps> = ({
  api,
  onSave,
  onCancel,
  hideConnectionFields = false,
  lockedVendorInfo,
  embeddedMode = false,
}) => {
  const { t } = useTranslation(['common', 'settings']);
  const normalizedAdapter = normalizeAdapter(api.modelAdapter);
  const initialMinP = normalizedAdapter === 'general' ? (api as any).minP ?? GENERAL_DEFAULT_MIN_P : (api as any).minP ?? undefined;
  const initialTopK = normalizedAdapter === 'general' ? (api as any).topK ?? GENERAL_DEFAULT_TOP_K : (api as any).topK ?? undefined;
  const fieldIds = useMemo(
    () => ({
      name: `api-name-${api.id}`,
      baseUrl: `api-base-url-${api.id}`,
      model: `api-model-${api.id}`,
      apiKey: `api-key-${api.id}`,
      adapter: `api-adapter-${api.id}`,
      temperature: `api-temperature-${api.id}`,
      maxTokens: `api-maxTokens-${api.id}`,
    }),
    [api.id]
  );
  const [showApiKey, setShowApiKey] = useState(false);
  // 数字输入的本地字符串状态，避免直接写入 NaN 造成受控组件异常
  const [tempInput, setTempInput] = useState<string>(() => String(api.temperature ?? 0.7));
  const [maxTokensInput, setMaxTokensInput] = useState<string>(() => String(api.maxOutputTokens ?? 8192));
  const [maxTokensLimitInput, setMaxTokensLimitInput] = useState<string>(() =>
    api.maxTokensLimit != null ? String(api.maxTokensLimit) : ''
  );
  const [contextWindowInput, setContextWindowInput] = useState<string>(() =>
    api.contextWindow != null ? String(api.contextWindow) : ''
  );

  const [formData, setFormData] = useState<EditApiConfig>({
    ...api,
    isReasoning: api.isReasoning ?? false,
    isEmbedding: api.isEmbedding ?? false,
    isReranker: api.isReranker ?? false,
    modelAdapter: normalizedAdapter,
    temperature: api.temperature ?? 0.7,
    maxOutputTokens: api.maxOutputTokens ?? 8192,
    maxTokensLimit: api.maxTokensLimit,
    supportsTools: api.supportsTools ?? (!api.isEmbedding && !api.isReranker),
    reasoningEffort: api.reasoningEffort ?? undefined,
    thinkingEnabled: api.thinkingEnabled ?? false,
    thinkingBudget: api.thinkingBudget ?? undefined,
    includeThoughts: api.includeThoughts ?? false,
    enableThinking: (api as any).enableThinking ?? api.thinkingEnabled ?? false,
    minP: initialMinP,
    topK: initialTopK,
    supportsReasoning: api.supportsReasoning ?? false,
    repetitionPenalty: (api as any).repetitionPenalty ?? undefined,
    reasoningSplit: (api as any).reasoningSplit ?? undefined,
    effort: (api as any).effort ?? undefined,
    verbosity: (api as any).verbosity ?? undefined,
  });

  const inferredCaps = useMemo(
    () => inferApiCapabilities({ id: formData.model, name: formData.name }),
    [formData.model, formData.name]
  );

  const inferenceTimeoutRef = useRef<number | null>(null);
  const lastInferredModelRef = useRef<string | null>(api.model ?? null);
  const initialThinkingSetupDone = useRef(false);

  // 🔧 2026-01-11 修复：组件初始化时检测 Gemini 推理模型，自动设置 include_thoughts
  // 解决编辑现有配置时 include_thoughts 不自动开启的问题
  useEffect(() => {
    // 只在首次挂载时执行
    if (initialThinkingSetupDone.current) return;
    initialThinkingSetupDone.current = true;

    const model = (formData.model || '').trim().toLowerCase();
    if (!model) return;

    // 检查是否是 Gemini 推理模型且需要自动启用思维链
    const isGemini = formData.modelAdapter === 'google' && model.includes('gemini');
    if (!isGemini) return;

    const caps = inferApiCapabilities({ id: formData.model, name: formData.name });
    const shouldReason = caps.reasoning || caps.supportsReasoningEffort || caps.supportsThinkingTokens || caps.supportsHybridReasoning;
    if (!shouldReason || !caps.supportsThinkingTokens) return;

    // 检查是否已经设置过思维链选项
    const hasThinkingFlags =
      !!formData.includeThoughts ||
      !!formData.thinkingEnabled ||
      !!(formData as any).enableThinking ||
      formData.thinkingBudget != null;

    if (!hasThinkingFlags) {
      console.log('[ShadApiEditModal] Auto-enabling Gemini thinking options for:', model);
      setFormData(prev => ({
        ...prev,
        includeThoughts: true,
        thinkingEnabled: true,
        enableThinking: true,
        thinkingBudget: -1,
        isReasoning: true,
        supportsReasoning: true,
      }));
    }
  }, []); // 仅在组件挂载时执行一次

  useEffect(() => {
    const model = (formData.model || '').trim();
    if (inferenceTimeoutRef.current != null && typeof window !== 'undefined') {
      window.clearTimeout(inferenceTimeoutRef.current);
      inferenceTimeoutRef.current = null;
    }
    if (!model) {
      return;
    }
    if (typeof window === 'undefined') {
      return;
    }
    inferenceTimeoutRef.current = window.setTimeout(() => {
      if (!model) return;
      if (lastInferredModelRef.current === model) return;
      setFormData(prev => {
        const currentModel = (prev.model || '').trim();
        if (!currentModel || currentModel !== model) {
          return prev;
        }
        const caps = inferApiCapabilities({ id: currentModel, name: prev.name });
        const shouldReason =
          caps.reasoning || caps.supportsReasoningEffort || caps.supportsThinkingTokens || caps.supportsHybridReasoning;
        let next: EditApiConfig = {
          ...prev,
          isEmbedding: caps.embedding,
          isReranker: caps.rerank,
          isMultimodal: caps.vision,
          isReasoning: shouldReason,
          supportsReasoning: shouldReason,
          supportsTools: caps.functionCalling && !caps.embedding && !caps.rerank && !caps.imageModel,
          contextWindow: caps.contextWindow,
        };
        const lowerModel = currentModel.toLowerCase();
        const isGemini = next.modelAdapter === 'google' && lowerModel.includes('gemini');
        const hasThinkingFlags =
          !!next.includeThoughts ||
          !!next.thinkingEnabled ||
          !!(next as any).enableThinking ||
          next.thinkingBudget != null;
        if (isGemini && shouldReason && caps.supportsThinkingTokens && !hasThinkingFlags) {
          next = {
            ...next,
            includeThoughts: true,
            thinkingEnabled: true,
            enableThinking: true,
            thinkingBudget: -1,
          };
        }
        return next;
      });
      lastInferredModelRef.current = model;
    }, 600);
    return () => {
      if (inferenceTimeoutRef.current != null && typeof window !== 'undefined') {
        window.clearTimeout(inferenceTimeoutRef.current);
        inferenceTimeoutRef.current = null;
      }
    };
  }, [formData.model, formData.name, formData.modelAdapter]);

  useEffect(() => {
    if (formData.modelAdapter !== 'general') return;
    setFormData(prev => {
      if (prev.modelAdapter !== 'general') return prev;
      const nextMinP = prev.minP ?? GENERAL_DEFAULT_MIN_P;
      const nextTopK = prev.topK ?? GENERAL_DEFAULT_TOP_K;
      if (nextMinP === prev.minP && nextTopK === prev.topK) return prev;
      return { ...prev, minP: nextMinP, topK: nextTopK };
    });
  }, [formData.modelAdapter]);

  const isGeminiReasoningWithThoughts = useMemo(() => {
    if (formData.modelAdapter !== 'google') return false;
    const lower = (formData.model || '').toLowerCase();
    if (!lower.includes('gemini')) return false;
    if (!inferredCaps.supportsThinkingTokens && !inferredCaps.supportsReasoningEffort && !inferredCaps.reasoning) {
      return false;
    }
    if (!formData.supportsReasoning && !inferredCaps.reasoning) {
      return false;
    }
    if (!formData.includeThoughts && !formData.thinkingEnabled && !(formData as any).enableThinking) {
      return false;
    }
    return true;
  }, [
    formData.modelAdapter,
    formData.model,
    formData.supportsReasoning,
    formData.includeThoughts,
    formData.thinkingEnabled,
    (formData as any).enableThinking,
    inferredCaps.supportsThinkingTokens,
    inferredCaps.supportsReasoningEffort,
    inferredCaps.reasoning,
  ]);

  // 互斥：DeepSeek-V3.1 工具与思维模式互斥
  const isDeepseekV31 = useMemo(() => {
    const lower = (formData.model || '').toLowerCase();
    return lower === 'deepseek-ai/deepseek-v3.1' || lower === 'pro/deepseek-ai/deepseek-v3.1';
  }, [formData.model]);

  const fallbackAdapterOptions = useMemo(
    () => [
      {
        value: 'general',
        label: t('common:api_config_modal.adapter_general'),
        description: t('common:api_config_modal.adapter_general_desc'),
      },
      {
        value: 'google',
        label: t('common:api_config_modal.adapter_google'),
        description: t('common:api_config_modal.adapter_google_desc'),
      },
      {
        value: 'anthropic',
        label: t('common:api_config_modal.adapter_anthropic'),
        description: t('common:api_config_modal.adapter_anthropic_desc'),
      },
      {
        value: 'deepseek',
        label: t('common:api_config_modal.adapter_deepseek'),
        description: t('common:api_config_modal.adapter_deepseek_desc'),
      },
      {
        value: 'qwen',
        label: t('common:api_config_modal.adapter_qwen'),
        description: t('common:api_config_modal.adapter_qwen_desc'),
      },
      {
        value: 'zhipu',
        label: t('common:api_config_modal.adapter_zhipu'),
        description: t('common:api_config_modal.adapter_zhipu_desc'),
      },
      {
        value: 'doubao',
        label: t('common:api_config_modal.adapter_doubao'),
        description: t('common:api_config_modal.adapter_doubao_desc'),
      },
      {
        value: 'moonshot',
        label: t('common:api_config_modal.adapter_moonshot'),
        description: t('common:api_config_modal.adapter_moonshot_desc'),
      },
      {
        value: 'grok',
        label: t('common:api_config_modal.adapter_grok'),
        description: t('common:api_config_modal.adapter_grok_desc'),
      },
      {
        value: 'minimax',
        label: t('common:api_config_modal.adapter_minimax'),
        description: t('common:api_config_modal.adapter_minimax_desc'),
      },
    ],
    [t]
  );

  const [modelAdapterOptions, setModelAdapterOptions] = useState<
    Array<{ value: string; label: string; description?: string }>
  >(fallbackAdapterOptions);

  useEffect(() => {
    setModelAdapterOptions(fallbackAdapterOptions);
  }, [fallbackAdapterOptions]);

  useEffect(() => {
    (async () => {
      try {
        if (!invoke) return;
        const result: any = await invoke('get_model_adapter_options');
        if (Array.isArray(result)) {
          const allowed = new Set(SUPPORTED_MODEL_ADAPTERS);
          const mapped = result
            .map((item: any) => ({ value: item?.value, label: item?.label, description: item?.description }))
            .filter((x: any) => x && x.value && x.label)
            .filter((x: any) => allowed.has(x.value));
          if (mapped.length > 0) setModelAdapterOptions(mapped);
        }
      } catch (e: unknown) {
        // 静默失败，使用回退列表
        console.warn('加载模型适配器选项失败，使用回退列表:', e);
      }
    })();
  }, [t]);

  useEffect(() => {
    const recommended: Record<string, { temperature: number; maxOutputTokens: number }> = {
      general: { temperature: 0.7, maxOutputTokens: 8192 },
      google: { temperature: 0.7, maxOutputTokens: 8192 },
      anthropic: { temperature: 0.7, maxOutputTokens: 4096 },
    };
    if (formData.modelAdapter && recommended[formData.modelAdapter]) {
      setFormData(prev => ({
        ...prev,
        temperature: prev.temperature === 0.7 ? recommended[formData.modelAdapter].temperature : prev.temperature,
        maxOutputTokens:
          prev.maxOutputTokens === 8192 ? recommended[formData.modelAdapter].maxOutputTokens : prev.maxOutputTokens,
      }));
      // 同步字符串输入的初值（仅在仍为默认值时）
      setTempInput(prev => (prev === '0.7' ? String(recommended[formData.modelAdapter].temperature) : prev));
      setMaxTokensInput(prev => (prev === '8192' ? String(recommended[formData.modelAdapter].maxOutputTokens) : prev));
    }
  }, [formData.modelAdapter]);

  const capabilityOptions = useMemo<
    Array<{ key: CapabilityKey; title: string; description: string; icon: React.ReactNode; highlight?: boolean }>
  >(
    () => [
      {
        key: 'isMultimodal',
        title: t('settings:api.modal.capabilities.multimodal.title'),
        description: t('settings:api.modal.capabilities.multimodal.description'),
        icon: <ImageIcon className="h-5 w-5" />,
      },
      {
        key: 'isReasoning',
        title: t('settings:api.modal.capabilities.reasoning.title'),
        description: t('settings:api.modal.capabilities.reasoning.description'),
        icon: <Brain className="h-5 w-5" />,
      },
      {
        key: 'isEmbedding',
        title: t('settings:api.modal.capabilities.embedding.title'),
        description: t('settings:api.modal.capabilities.embedding.description'),
        icon: <Database className="h-5 w-5" />,
      },
      {
        key: 'isReranker',
        title: t('settings:api.modal.capabilities.reranker.title'),
        description: t('settings:api.modal.capabilities.reranker.description'),
        icon: <Search className="h-5 w-5" />,
      },
      {
        key: 'supportsTools',
        title: t('settings:api.modal.capabilities.tools.title'),
        description: t('settings:api.modal.capabilities.tools.description'),
        icon: <Wrench className="h-5 w-5" />,
        highlight: true,
      },
    ],
    [t]
  );

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!formData.name.trim()) {
      showGlobalNotification('warning', t('placeholders.enter_name'));
      return;
    }
    if (!hideConnectionFields && !formData.baseUrl.trim()) {
      showGlobalNotification('warning', t('placeholders.enter_url'));
      return;
    }
    if (!formData.model.trim()) {
      showGlobalNotification('warning', t('labels.model_name'));
      return;
    }
    const sanitized: EditApiConfig = {
      ...formData,
      temperature:
        typeof formData.temperature === 'number' && Number.isFinite(formData.temperature)
          ? formData.temperature
          : undefined,
      maxOutputTokens:
        typeof formData.maxOutputTokens === 'number' && Number.isFinite(formData.maxOutputTokens)
          ? Math.round(formData.maxOutputTokens)
          : undefined,
      maxTokensLimit:
        typeof formData.maxTokensLimit === 'number' && Number.isFinite(formData.maxTokensLimit)
          ? Math.round(formData.maxTokensLimit)
          : undefined,
      thinkingBudget:
        typeof formData.thinkingBudget === 'number' && Number.isFinite(formData.thinkingBudget)
          ? (() => {
              const rounded = Math.round(formData.thinkingBudget);
              if (formData.modelAdapter === 'google') {
                return Math.max(-1, Math.min(rounded, 2_147_483_647));
              }
              return Math.max(0, Math.min(rounded, 2_147_483_647));
            })()
          : undefined,
      enableThinking: formData.enableThinking ?? false,
      minP:
        typeof formData.minP === 'number' && Number.isFinite(formData.minP)
          ? Math.max(0, Math.min(formData.minP, 1))
          : undefined,
      topK:
        typeof formData.topK === 'number' && Number.isFinite(formData.topK)
          ? Math.max(0, Math.min(Math.round(formData.topK), 10000))
          : undefined,
      supportsReasoning: formData.supportsReasoning ?? false,
      repetitionPenalty:
        typeof formData.repetitionPenalty === 'number' && Number.isFinite(formData.repetitionPenalty)
          ? Math.max(0, formData.repetitionPenalty)
          : undefined,
      reasoningSplit: formData.reasoningSplit,
      effort: formData.effort,
      verbosity: formData.verbosity,
    };
    // 若用户显式开启了思维链相关任一项，则强制标记 supportsReasoning=true，避免被保存阶段清除
    if (sanitized.includeThoughts || sanitized.enableThinking || sanitized.thinkingBudget !== undefined) {
      sanitized.supportsReasoning = true;
    }
    if (!sanitized.supportsReasoning) {
      sanitized.enableThinking = false;
      sanitized.includeThoughts = false;
      sanitized.thinkingBudget = undefined;
    }
    if (sanitized.supportsReasoning && sanitized.modelAdapter === 'anthropic') {
      if (sanitized.thinkingBudget && sanitized.thinkingBudget > 0 && sanitized.thinkingBudget < 1024) {
        sanitized.thinkingBudget = 1024;
      }
    }
    // 对于 Google 适配器，允许 includeThoughts 独立存在（仅当用户明确关闭 supportsReasoning 时才清理）
    if (sanitized.modelAdapter !== 'google') {
      if (!sanitized.enableThinking) {
        sanitized.includeThoughts = false;
      }
    }
    onSave(sanitized);
  };

  // 在用户交互过程中保证互斥：
  useEffect(() => {
    if (isDeepseekV31) {
      // 若工具开启，则关闭思维链
      if (formData.supportsTools && (formData.enableThinking || formData.includeThoughts || formData.thinkingBudget != null)) {
        setFormData(prev => ({ ...prev, enableThinking: false, includeThoughts: false, thinkingBudget: undefined }));
      }
    }
  }, [isDeepseekV31, formData.supportsTools]);

  // 嵌入模式的内容渲染
  const formContent = (
    <form onSubmit={handleSubmit} className={cn(
      "flex flex-col flex-1 min-h-0 overflow-hidden",
      embeddedMode && "h-full"
    )}>

          {/* Tabs & Content - Flex Body */}
          <Tabs defaultValue="general" className="flex-1 flex flex-col min-h-0">
            <div className="flex-none px-2 sm:px-4 border-b border-border/40">
              <TabsList className="w-full justify-between sm:justify-start h-auto p-0 bg-transparent gap-0 sm:gap-4">
                <TabsTrigger 
                  value="general" 
                  variant="bare"
                  className="flex-1 sm:flex-none data-[state=active]:border-b-primary data-[state=active]:text-primary border-b-2 border-b-transparent rounded-none px-1 sm:px-0.5 py-2 transition-all font-medium text-muted-foreground text-[11px] sm:text-sm hover:text-foreground/80"
                >
                  {t('settings:api.modal.basic_info')}
                </TabsTrigger>
                <TabsTrigger 
                  value="capabilities" 
                  variant="bare"
                  className="flex-1 sm:flex-none data-[state=active]:border-b-primary data-[state=active]:text-primary border-b-2 border-b-transparent rounded-none px-1 sm:px-0.5 py-2 transition-all font-medium text-muted-foreground text-[11px] sm:text-sm hover:text-foreground/80"
                >
                  {t('settings:api.modal.capabilities.title')}
                </TabsTrigger>
                <TabsTrigger 
                  value="params" 
                  variant="bare"
                  className="flex-1 sm:flex-none data-[state=active]:border-b-primary data-[state=active]:text-primary border-b-2 border-b-transparent rounded-none px-1 sm:px-0.5 py-2 transition-all font-medium text-muted-foreground text-[11px] sm:text-sm hover:text-foreground/80"
                >
                  {t('settings:api.modal.advanced_settings')}
                </TabsTrigger>
                <TabsTrigger 
                  value="reasoning" 
                  variant="bare"
                  className="flex-1 sm:flex-none data-[state=active]:border-b-primary data-[state=active]:text-primary border-b-2 border-b-transparent rounded-none px-1 sm:px-0.5 py-2 transition-all font-medium text-muted-foreground text-[11px] sm:text-sm hover:text-foreground/80"
                >
                  {t('settings:api.modal.reasoning.title')}
                </TabsTrigger>
              </TabsList>
            </div>

            <CustomScrollArea className="flex-1 min-h-0" viewportClassName="pr-1">
              <div className="p-2 sm:p-4">
                {/* General Tab */}
                <TabsContent value="general" className="mt-0 space-y-3 focus-visible:outline-none">
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor={fieldIds.name} className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider ml-1">
                        {t('common:api_config_modal.config_name')}
                      </Label>
                      <Input
                        id={fieldIds.name}
                        value={formData.name}
                        onChange={e => setFormData(prev => ({ ...prev, name: (e.target as HTMLInputElement).value }))}
                        placeholder={t('common:api_config_modal.config_name_placeholder')}
                        className="bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-muted/20 focus-visible:ring-0 focus-visible:ring-offset-0 transition-all h-10"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={fieldIds.model} className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider ml-1">
                        {t('common:api_config_modal.model_name')}
                      </Label>
                      <div className="relative">
                        <Input
                          id={fieldIds.model}
                          value={formData.model}
                          onChange={e => setFormData(prev => ({ ...prev, model: (e.target as HTMLInputElement).value }))}
                          placeholder={t('common:api_config_modal.model_name_placeholder')}
                          className="bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-muted/20 focus-visible:ring-0 focus-visible:ring-offset-0 transition-all h-10 pr-8"
                        />
                        <Sparkles className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-amber-400/60 pointer-events-none" />
                      </div>
                      <p className="text-[10px] text-muted-foreground/60 flex items-center gap-1 ml-1">
                        {t('settings:api.modal.model_name_hint')}
                      </p>
                    </div>
                    
                    <div className="space-y-2 md:col-span-2">
                      <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider ml-1">
                        {t('settings:api.modal.adapter.field_label')}
                      </Label>
                      {/* 模型适配器 - 展开式列表 */}
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
                        {modelAdapterOptions.map(option => {
                          const isSelected = formData.modelAdapter === option.value;
                          return (
                            <button
                              key={option.value}
                              type="button"
                              onClick={() => {
                                setFormData(prev => {
                                  const nextDefault = ADAPTER_DEFAULT_BASE_URL[option.value] ?? prev.baseUrl;
                                  const prevDefault = ADAPTER_DEFAULT_BASE_URL[prev.modelAdapter];
                                  const prevNormalized = normalizeBaseUrlForCompare(prev.baseUrl);
                                  const prevDefaultNormalized = prevDefault ? normalizeBaseUrlForCompare(prevDefault) : '';
                                  const shouldReplaceBase = prevNormalized.length === 0 || (prevDefaultNormalized !== '' && prevNormalized === prevDefaultNormalized);
                                  const next: EditApiConfig = { ...prev, modelAdapter: option.value };
                                  if (shouldReplaceBase) {
                                    next.baseUrl = nextDefault ?? prev.baseUrl;
                                  }
                                  return next;
                                });
                              }}
                              className={cn(
                                'flex flex-col items-center justify-center gap-1 p-3 rounded-lg border text-center transition-all duration-150',
                                isSelected
                                  ? 'border-primary bg-primary/10 text-foreground'
                                  : 'border-border/40 bg-muted/20 text-muted-foreground hover:border-border hover:bg-muted/40 hover:text-foreground'
                              )}
                            >
                              <span className={cn('text-sm', isSelected && 'font-medium')}>{option.label}</span>
                            </button>
                          );
                        })}
                      </div>
                      {/* 当前选中适配器的描述 */}
                      {modelAdapterOptions.find(o => o.value === formData.modelAdapter)?.description && (
                        <p className="text-xs text-muted-foreground/70 text-center mt-1">
                          {modelAdapterOptions.find(o => o.value === formData.modelAdapter)?.description}
                        </p>
                      )}
                    </div>
                  </div>

                  {!hideConnectionFields && (
                    <div className="pt-1">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="h-px flex-1 bg-border/40"></div>
                        <span className="text-xs font-medium text-muted-foreground/50 uppercase tracking-wider">{t('settings:api.modal.connection_info')}</span>
                        <div className="h-px flex-1 bg-border/40"></div>
                      </div>
                      
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="space-y-2 md:col-span-2">
                          <Label htmlFor={fieldIds.baseUrl} className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider ml-1">
                            {t('common:api_config_modal.base_url')}
                          </Label>
                          <Input
                            id={fieldIds.baseUrl}
                            type="url"
                            value={formData.baseUrl}
                            onChange={e => setFormData(prev => ({ ...prev, baseUrl: (e.target as HTMLInputElement).value }))}
                            placeholder={ADAPTER_DEFAULT_BASE_URL[formData.modelAdapter] ?? t('common:api_config_modal.base_url_placeholder')}
                            className="font-mono text-sm bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-muted/20 focus-visible:ring-0 focus-visible:ring-offset-0 transition-all h-10"
                          />
                        </div>
                        <div className="space-y-2 md:col-span-2">
                          <Label htmlFor={fieldIds.apiKey} className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider ml-1">
                            {t('common:api_config_modal.api_key')}
                          </Label>
                          <div className="relative">
                            <Input
                              id={fieldIds.apiKey}
                              type={showApiKey ? 'text' : 'password'}
                              value={formData.apiKey}
                              onChange={e => setFormData(prev => ({ ...prev, apiKey: (e.target as HTMLInputElement).value }))}
                              placeholder={t('common:api_config_modal.api_key_placeholder')}
                              className="pr-10 font-mono text-sm bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-muted/20 focus-visible:ring-0 focus-visible:ring-offset-0 transition-all h-[50px]"
                            />
                            <NotionButton
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => setShowApiKey(!showApiKey)}
                              className="absolute right-1 top-1 h-8 w-8 text-muted-foreground/50 hover:text-foreground transition-colors"
                            >
                              {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                            </NotionButton>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </TabsContent>

                {/* Capabilities Tab */}
                <TabsContent value="capabilities" className="mt-0 focus-visible:outline-none animate-in fade-in-50 slide-in-from-bottom-2 duration-300">
                  <div className="grid gap-3 sm:grid-cols-2">
                    {capabilityOptions.map(option => {
                      const checked = !!(formData as any)[option.key];
                      return (
                        <div
                          key={option.key}
                          onClick={() => {
                            const nextChecked = !checked;
                            setFormData(prev => {
                              const updated: EditApiConfig = { ...prev, [option.key]: nextChecked } as EditApiConfig;
                              if (option.key === 'isReasoning') {
                                if (nextChecked) {
                                  updated.supportsReasoning = true;
                                } else {
                                  updated.supportsReasoning = false;
                                  updated.enableThinking = false;
                                  updated.includeThoughts = false;
                                  updated.thinkingBudget = undefined;
                                }
                              }
                              return updated;
                            });
                          }}
                          className={cn(
                            'relative flex cursor-pointer items-start gap-4 rounded-xl border p-4 transition-all duration-200 select-none group',
                            checked
                              ? 'border-primary/50 bg-primary/5 shadow-sm'
                              : 'border-border/40 bg-card hover:border-primary/20 hover:bg-accent/30',
                            option.key === 'supportsTools' && 'sm:col-span-2'
                          )}
                        >
                          <div className={cn("p-2.5 rounded-lg shrink-0 transition-all duration-200", checked ? "bg-primary text-primary-foreground shadow-sm scale-110" : "bg-muted/50 text-muted-foreground group-hover:text-foreground")}>
                            {option.icon}
                          </div>
                          <div className="flex-1 space-y-1.5 pt-0.5">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-medium text-sm flex items-center gap-2">
                                {option.title}
                                {option.highlight && (
                                  <Badge variant="secondary" className="text-[10px] h-4 px-1.5 font-normal bg-primary/10 text-primary border-none">
                                    {t('settings:api.modal.capabilities.recommended')}
                                  </Badge>
                                )}
                              </span>
                              <div className={cn("w-4 h-4 rounded-full border transition-all flex items-center justify-center", checked ? "bg-primary border-primary" : "border-muted-foreground/30")}>
                                {checked && <div className="w-1.5 h-1.5 bg-background rounded-full" />}
                              </div>
                            </div>
                            <p className="text-xs text-muted-foreground leading-relaxed pr-4">
                              {option.description}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </TabsContent>

                {/* Params Tab */}
                <TabsContent value="params" className="mt-0 focus-visible:outline-none animate-in fade-in-50 slide-in-from-bottom-2 duration-300">
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor={fieldIds.temperature} className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider ml-1">
                        {t('settings:api.modal.fields.temperature')}
                      </Label>
                      <Input
                        id={fieldIds.temperature}
                        type="number"
                        value={tempInput}
                        onChange={e => setTempInput((e.target as HTMLInputElement).value)}
                        onBlur={() => {
                          const raw = tempInput.trim();
                          let next = Number(raw);
                          if (!raw) next = formData.temperature ?? 0.7;
                          if (Number.isNaN(next)) next = formData.temperature ?? 0.7;
                          next = Math.max(0, Math.min(2, next));
                          setFormData(prev => ({ ...prev, temperature: next }));
                          setTempInput(String(next));
                        }}
                        min={0}
                        max={2}
                        step={0.1}
                        className="bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-muted/20 focus-visible:ring-0 focus-visible:ring-offset-0 transition-all h-10"
                      />
                      <p className="text-[10px] text-muted-foreground/60 ml-1">
                        {t('settings:api.modal.fields.temperature_hint')}
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={fieldIds.maxTokens} className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider ml-1">
                        {t('settings:api.modal.fields.max_tokens')}
                      </Label>
                      <Input
                        id={fieldIds.maxTokens}
                        type="number"
                        value={maxTokensInput}
                        onChange={e => setMaxTokensInput((e.target as HTMLInputElement).value)}
                        onBlur={() => {
                          const raw = maxTokensInput.trim();
                          let next = Number(raw);
                          if (!raw) next = formData.maxOutputTokens ?? 8192;
                          if (!Number.isFinite(next)) next = formData.maxOutputTokens ?? 8192;
                          next = Math.max(1, Math.min(128000, Math.round(next)));
                          setFormData(prev => ({ ...prev, maxOutputTokens: next }));
                          setMaxTokensInput(String(next));
                        }}
                        min={1}
                        max={128000}
                        step={1}
                        className="bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-muted/20 focus-visible:ring-0 focus-visible:ring-offset-0 transition-all h-10"
                      />
                      <p className="text-[10px] text-muted-foreground/60 ml-1">
                        {t('settings:api.modal.fields.max_tokens_hint')}
                      </p>
                      {formData.modelAdapter === 'general' && formData.model?.toLowerCase().includes('qwen') && (
                        <p className="text-[10px] text-amber-500 ml-1">{t('settings:api.modal.fields.qwen_hint')}</p>
                      )}
                    </div>
                  </div>

                  {/* API max_tokens 限制（可选） */}
                  <div className="space-y-2 pt-4 border-t border-border/40">
                    <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider ml-1">
                      {t('settings:api.modal.fields.max_tokens_limit')}
                    </Label>
                    <Input
                      type="number"
                      value={maxTokensLimitInput}
                      onChange={e => setMaxTokensLimitInput((e.target as HTMLInputElement).value)}
                      onBlur={() => {
                        const raw = maxTokensLimitInput.trim();
                        if (!raw) {
                          setFormData(prev => ({ ...prev, maxTokensLimit: undefined }));
                          return;
                        }
                        let next = Number(raw);
                        if (!Number.isFinite(next) || next <= 0) {
                          setFormData(prev => ({ ...prev, maxTokensLimit: undefined }));
                          setMaxTokensLimitInput('');
                          return;
                        }
                        next = Math.max(1, Math.min(1000000, Math.round(next)));
                        setFormData(prev => ({ ...prev, maxTokensLimit: next }));
                        setMaxTokensLimitInput(String(next));
                      }}
                      min={1}
                      max={1000000}
                      step={1}
                      placeholder={t('settings:api.modal.fields.max_tokens_limit_placeholder')}
                      className="bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-muted/20 focus-visible:ring-0 focus-visible:ring-offset-0 transition-all h-10"
                    />
                    <p className="text-[10px] text-muted-foreground/60 ml-1">
                      {t('settings:api.modal.fields.max_tokens_limit_hint')}
                    </p>
                  </div>

                  {/* 上下文窗口大小（可选） */}
                  <div className="space-y-2 pt-4 border-t border-border/40">
                    <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider ml-1">
                      {t('settings:api.modal.fields.context_window')}
                    </Label>
                    <Input
                      type="number"
                      value={contextWindowInput}
                      onChange={e => setContextWindowInput((e.target as HTMLInputElement).value)}
                      onBlur={() => {
                        const raw = contextWindowInput.trim();
                        if (!raw) {
                          setFormData(prev => ({ ...prev, contextWindow: undefined }));
                          return;
                        }
                        let next = Number(raw);
                        if (!Number.isFinite(next) || next <= 0) {
                          setFormData(prev => ({ ...prev, contextWindow: undefined }));
                          setContextWindowInput('');
                          return;
                        }
                        next = Math.max(1024, Math.min(2000000, Math.round(next)));
                        setFormData(prev => ({ ...prev, contextWindow: next }));
                        setContextWindowInput(String(next));
                      }}
                      min={1024}
                      max={2000000}
                      step={1024}
                      placeholder={t('settings:api.modal.fields.context_window_placeholder', { defaultValue: `${t('settings:api.modal.fields.context_window_auto_inferred')}: ${inferredCaps.contextWindow.toLocaleString()}` })}
                      className="bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-muted/20 focus-visible:ring-0 focus-visible:ring-offset-0 transition-all h-10"
                    />
                    <p className="text-[10px] text-muted-foreground/60 ml-1">
                      {t('settings:api.modal.fields.context_window_hint')}
                      {' '}{inferredCaps.contextWindow.toLocaleString()} tokens
                    </p>
                  </div>

                  {formData.modelAdapter === 'general' && (
                    <div className="grid gap-6 md:grid-cols-2 pt-6 mt-2 border-t border-border/40">
                      <div className="space-y-2">
                        <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider ml-1">{t('settings:api.modal.fields.min_p')}</Label>
                        <Input
                          type="number"
                          step={0.01}
                          value={formData.minP ?? ''}
                          onChange={e => {
                            const raw = (e.target as HTMLInputElement).value;
                            setFormData(prev => {
                              if (!raw) return { ...prev, minP: undefined };
                              const num = Number(raw);
                              if (!Number.isFinite(num)) return prev;
                              return { ...prev, minP: Math.max(0, Math.min(num, 1)) };
                            });
                          }}
                          className="bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-muted/20 focus-visible:ring-0 focus-visible:ring-offset-0 transition-all h-10"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider ml-1">{t('settings:api.modal.fields.top_k')}</Label>
                        <Input
                          type="number"
                          min={0}
                          value={formData.topK ?? ''}
                          onChange={e => {
                            const raw = (e.target as HTMLInputElement).value;
                            setFormData(prev => {
                              if (!raw) return { ...prev, topK: undefined };
                              const num = Number(raw);
                              if (!Number.isFinite(num)) return prev;
                              return { ...prev, topK: Math.max(0, Math.min(Math.round(num), 10000)) };
                            });
                          }}
                          className="bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-muted/20 focus-visible:ring-0 focus-visible:ring-offset-0 transition-all h-10"
                        />
                      </div>
                    </div>
                  )}
                </TabsContent>

                {/* Reasoning Tab */}
                <TabsContent value="reasoning" className="mt-0 focus-visible:outline-none animate-in fade-in-50 slide-in-from-bottom-2 duration-300">
                  {formData.modelAdapter === 'general' && (
                    <div className="space-y-6">
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider ml-1">
                            {t('settings:api.modal.reasoning.openai_label')}
                          </Label>
                          <AppSelect
                            value={formData.reasoningEffort ?? 'unset'}
                            onValueChange={v => setFormData(prev => ({ ...prev, reasoningEffort: v === 'unset' ? undefined : v }))}
                            placeholder={t('settings:api.modal.reasoning.default_option')}
                            options={[
                              { value: 'unset', label: t('settings:api.modal.reasoning.unset_option') },
                              { value: 'none', label: t('settings:api.modal.reasoning.effort.none', 'None') },
                              { value: 'minimal', label: t('settings:api.modal.reasoning.effort.minimal') },
                              { value: 'low', label: t('settings:api.modal.reasoning.effort.low') },
                              { value: 'medium', label: t('settings:api.modal.reasoning.effort.medium') },
                              { value: 'high', label: t('settings:api.modal.reasoning.effort.high') },
                              { value: 'xhigh', label: t('settings:api.modal.reasoning.effort.xhigh', 'Extra High') },
                            ]}
                            variant="ghost"
                            className="bg-muted/30 border-transparent hover:border-border/50 transition-all h-10"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider ml-1">{t('settings:api.modal.fields.thinking_budget')}</Label>
                          <Input
                            type="number"
                            min={0}
                            value={formData.thinkingBudget ?? ''}
                            disabled={!formData.supportsReasoning}
                            onChange={e => {
                              const raw = (e.target as HTMLInputElement).value;
                              setFormData(prev => {
                                if (!raw) return { ...prev, thinkingBudget: undefined };
                                const num = Number(raw);
                                if (!Number.isFinite(num)) return prev;
                                return { ...prev, thinkingBudget: Math.max(0, Math.min(Math.round(num), 2_147_483_647)) };
                              });
                            }}
                            className="bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-muted/20 focus-visible:ring-0 focus-visible:ring-offset-0 transition-all h-10"
                          />
                        </div>
                      </div>
                      
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className={cn("flex items-center justify-between p-4 rounded-xl border transition-all duration-200", formData.enableThinking ? "bg-primary/5 border-primary/30" : "bg-card border-border/40 hover:border-border/60")}>
                          <div className="space-y-1">
                            <Label className="text-sm font-medium cursor-pointer" onClick={() => formData.supportsReasoning && setFormData(prev => ({ ...prev, enableThinking: !prev.enableThinking }))}>{t('settings:api.modal.reasoning.enable_thinking')}</Label>
                            <p className="text-xs text-muted-foreground/70">{t('settings:api.modal.reasoning.enable_thinking_hint')}</p>
                          </div>
                          <Switch
                            checked={!!formData.enableThinking}
                            disabled={!formData.supportsReasoning}
                            onCheckedChange={v => setFormData(prev => ({ ...prev, enableThinking: !!v }))}
                          />
                        </div>
                        <div className={cn("flex items-center justify-between p-4 rounded-xl border transition-all duration-200", formData.includeThoughts ? "bg-primary/5 border-primary/30" : "bg-card border-border/40 hover:border-border/60")}>
                          <div className="space-y-1">
                            <Label className="text-sm font-medium cursor-pointer" onClick={() => formData.supportsReasoning && setFormData(prev => ({ ...prev, includeThoughts: !prev.includeThoughts }))}>{t('settings:api.modal.reasoning.include_thoughts')}</Label>
                            <p className="text-xs text-muted-foreground/70">{t('settings:api.modal.reasoning.include_thoughts_hint')}</p>
                          </div>
                          <Switch
                            checked={!!formData.includeThoughts}
                            disabled={!formData.supportsReasoning}
                            onCheckedChange={v => setFormData(prev => ({ ...prev, includeThoughts: !!v }))}
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Repetition Penalty - for Qwen/Doubao models */}
                  {formData.modelAdapter === 'general' && (
                    <div className="space-y-2 pt-4 border-t border-border/40">
                      <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider ml-1">
                        {t('settings:api.modal.fields.repetition_penalty', 'Repetition Penalty')}
                      </Label>
                      <Input
                        type="number"
                        step={0.1}
                        min={0}
                        value={formData.repetitionPenalty ?? ''}
                        onChange={e => {
                          const raw = (e.target as HTMLInputElement).value;
                          setFormData(prev => {
                            if (!raw) return { ...prev, repetitionPenalty: undefined };
                            const num = Number(raw);
                            if (!Number.isFinite(num)) return prev;
                            return { ...prev, repetitionPenalty: Math.max(0, num) };
                          });
                        }}
                        placeholder={t('settings:api.modal.fields.repetition_penalty_placeholder', 'Qwen: >1.0, Doubao: >0')}
                        className="bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-muted/20 focus-visible:ring-0 focus-visible:ring-offset-0 transition-all h-10"
                      />
                      <p className="text-[10px] text-muted-foreground/60 ml-1">
                        {t('settings:api.modal.fields.repetition_penalty_hint', 'Qwen/Doubao models: penalize repeated tokens')}
                      </p>
                    </div>
                  )}

                  {/* Reasoning Split - for MiniMax models */}
                  {formData.modelAdapter === 'general' && (
                    <div className="pt-4 border-t border-border/40">
                      <div className={cn("flex items-center justify-between p-4 rounded-xl border transition-all duration-200", formData.reasoningSplit ? "bg-primary/5 border-primary/30" : "bg-card border-border/40 hover:border-border/60")}>
                        <div className="space-y-1">
                          <Label className="text-sm font-medium cursor-pointer" onClick={() => setFormData(prev => ({ ...prev, reasoningSplit: !prev.reasoningSplit }))}>
                            {t('settings:api.modal.fields.reasoning_split', 'MiniMax Reasoning Split')}
                          </Label>
                          <p className="text-xs text-muted-foreground/70">
                            {t('settings:api.modal.fields.reasoning_split_hint', 'Separate thinking content to reasoning_details field')}
                          </p>
                        </div>
                        <Switch
                          checked={!!formData.reasoningSplit}
                          onCheckedChange={v => setFormData(prev => ({ ...prev, reasoningSplit: !!v }))}
                        />
                      </div>
                    </div>
                  )}

                  {formData.modelAdapter === 'anthropic' && (
                    <div className="space-y-6">
                      <div className={cn("flex items-center justify-between p-4 rounded-xl border transition-all duration-200", formData.thinkingEnabled ? "bg-primary/5 border-primary/30" : "bg-card border-border/40 hover:border-border/60")}>
                        <div className="space-y-1">
                          <Label className="text-sm font-medium cursor-pointer" onClick={() => setFormData(prev => ({ ...prev, thinkingEnabled: !prev.thinkingEnabled }))}>{t('settings:api.modal.anthropic.title')}</Label>
                          <p className="text-xs text-muted-foreground/70">{t('settings:api.modal.anthropic.description')}</p>
                        </div>
                        <Switch
                          checked={!!formData.thinkingEnabled}
                          onCheckedChange={v => setFormData(prev => ({ ...prev, thinkingEnabled: !!v }))}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider ml-1">{t('settings:api.modal.anthropic.budget_label')}</Label>
                        <Input
                          type="number"
                          min={0}
                          value={formData.thinkingBudget ?? ''}
                          onChange={e => {
                            const raw = (e.target as HTMLInputElement).value;
                            setFormData(prev => {
                              if (!raw) return { ...prev, thinkingBudget: undefined };
                              const num = Number(raw);
                              if (!Number.isFinite(num)) return prev;
                              return { ...prev, thinkingBudget: Math.max(0, Math.min(Math.round(num), 2_147_483_647)) };
                            });
                          }}
                          className="bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-muted/20 focus-visible:ring-0 focus-visible:ring-offset-0 transition-all h-10"
                        />
                        <p className="text-[10px] text-muted-foreground/60 ml-1">{t('settings:api.modal.anthropic.budget_hint')}</p>
                      </div>
                    </div>
                  )}

                  {formData.modelAdapter === 'google' && (
                    <div className="space-y-6">
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider ml-1">{t('settings:api.modal.google.effort_label')}</Label>
                          <AppSelect
                            value={formData.reasoningEffort ?? 'none'}
                            onValueChange={v => setFormData(prev => ({ ...prev, reasoningEffort: v }))}
                            placeholder={t('settings:api.modal.reasoning.default_option')}
                            options={[
                              { value: 'none', label: t('settings:api.modal.reasoning.effort.none') },
                              { value: 'low', label: t('settings:api.modal.reasoning.effort.low') },
                              { value: 'medium', label: t('settings:api.modal.reasoning.effort.medium') },
                              { value: 'high', label: t('settings:api.modal.reasoning.effort.high') },
                            ]}
                            variant="ghost"
                            className="bg-muted/30 border-transparent hover:border-border/50 transition-all h-10"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider ml-1">{t('settings:api.modal.google.thinking_budget_label')}</Label>
                          <Input
                            type="number"
                            value={formData.thinkingBudget ?? ''}
                            onChange={e => {
                              const raw = (e.target as HTMLInputElement).value;
                              setFormData(prev => {
                                if (!raw) return { ...prev, thinkingBudget: undefined };
                                const num = Number(raw);
                                if (!Number.isFinite(num)) return prev;
                                return { ...prev, thinkingBudget: Math.max(-1, Math.min(Math.round(num), 2_147_483_647)) };
                              });
                            }}
                            className="bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-muted/20 focus-visible:ring-0 focus-visible:ring-offset-0 transition-all h-10"
                          />
                        </div>
                      </div>
                      <div className={cn("flex items-center justify-between p-4 rounded-xl border transition-all duration-200", formData.includeThoughts ? "bg-primary/5 border-primary/30" : "bg-card border-border/40 hover:border-border/60")}>
                        <div className="space-y-1">
                          <Label className="text-sm font-medium cursor-pointer" onClick={() => setFormData(prev => ({ ...prev, includeThoughts: !prev.includeThoughts }))}>{t('settings:api.modal.google.include_thoughts_label')}</Label>
                          {isGeminiReasoningWithThoughts && (
                            <p className="text-xs text-muted-foreground">{t('settings:api.modal.google.auto_thinking_hint')}</p>
                          )}
                        </div>
                        <Switch
                          checked={!!formData.includeThoughts}
                          onCheckedChange={v =>
                            setFormData(prev => {
                              const next = !!v;
                              const updated: EditApiConfig = { ...prev, includeThoughts: next };
                              if (next) {
                                if (updated.thinkingBudget == null) updated.thinkingBudget = -1;
                                if (!updated.thinkingEnabled) updated.thinkingEnabled = true;
                                if (updated.modelAdapter === 'google') (updated as any).geminiApiVersion = 'v1beta';
                              }
                              return updated;
                            })
                          }
                        />
                      </div>
                    </div>
                  )}

                  {/* DeepSeek 专用面板 */}
                  {formData.modelAdapter === 'deepseek' && (
                    <div className="space-y-6">
                      <Card className="border-border/40">
                        <CardHeader className="pb-3">
                          <CardTitle className="text-sm flex items-center gap-2">
                            <Brain className="h-4 w-4 text-primary" />
                            {t('settings:api.modal.deepseek.title')}
                          </CardTitle>
                          <CardDescription className="text-xs">
                            {t('settings:api.modal.deepseek.description')}
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className={cn("flex items-center justify-between p-4 rounded-xl border transition-all duration-200", formData.enableThinking ? "bg-primary/5 border-primary/30" : "bg-card border-border/40 hover:border-border/60")}>
                            <div className="space-y-1">
                              <Label className="text-sm font-medium cursor-pointer" onClick={() => setFormData(prev => ({ ...prev, enableThinking: !prev.enableThinking }))}>
                                {t('settings:api.modal.deepseek.enable_thinking')}
                              </Label>
                              <p className="text-xs text-muted-foreground/70">
                                {t('settings:api.modal.deepseek.enable_thinking_hint')}
                              </p>
                            </div>
                            <Switch
                              checked={!!formData.enableThinking}
                              onCheckedChange={v => setFormData(prev => ({ ...prev, enableThinking: !!v, supportsReasoning: !!v }))}
                            />
                          </div>
                          {isDeepseekV31 && formData.supportsTools && (
                            <p className="text-xs text-amber-500 flex items-center gap-1">
                              <Info className="h-3 w-3" />
                              {t('settings:api.modal.deepseek.v31_warning')}
                            </p>
                          )}
                        </CardContent>
                      </Card>
                    </div>
                  )}

                  {/* Qwen 专用面板 */}
                  {formData.modelAdapter === 'qwen' && (
                    <div className="space-y-6">
                      <Card className="border-border/40">
                        <CardHeader className="pb-3">
                          <CardTitle className="text-sm flex items-center gap-2">
                            <Brain className="h-4 w-4 text-primary" />
                            {t('settings:api.modal.qwen.title')}
                          </CardTitle>
                          <CardDescription className="text-xs">
                            {t('settings:api.modal.qwen.description')}
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className={cn("flex items-center justify-between p-4 rounded-xl border transition-all duration-200", formData.enableThinking ? "bg-primary/5 border-primary/30" : "bg-card border-border/40 hover:border-border/60")}>
                            <div className="space-y-1">
                              <Label className="text-sm font-medium cursor-pointer" onClick={() => setFormData(prev => ({ ...prev, enableThinking: !prev.enableThinking }))}>
                                {t('settings:api.modal.qwen.enable_thinking')}
                              </Label>
                              <p className="text-xs text-muted-foreground/70">
                                {t('settings:api.modal.qwen.enable_thinking_hint')}
                              </p>
                            </div>
                            <Switch
                              checked={!!formData.enableThinking}
                              onCheckedChange={v => setFormData(prev => ({ ...prev, enableThinking: !!v, supportsReasoning: !!v }))}
                            />
                          </div>
                          <div className="grid gap-3 md:grid-cols-2">
                            <div className="space-y-2">
                              <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider ml-1">
                                {t('settings:api.modal.qwen.thinking_budget', 'Thinking Budget')}
                              </Label>
                              <Input
                                type="number"
                                min={0}
                                value={formData.thinkingBudget ?? ''}
                                disabled={!formData.enableThinking}
                                onChange={e => {
                                  const raw = (e.target as HTMLInputElement).value;
                                  setFormData(prev => {
                                    if (!raw) return { ...prev, thinkingBudget: undefined };
                                    const num = Number(raw);
                                    if (!Number.isFinite(num)) return prev;
                                    return { ...prev, thinkingBudget: Math.max(0, Math.round(num)) };
                                  });
                                }}
                                placeholder={t('settings:api.modal.qwen.thinking_budget_placeholder')}
                                className="bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-muted/20 focus-visible:ring-0 focus-visible:ring-offset-0 transition-all h-10"
                              />
                            </div>
                            <div className="space-y-2">
                              <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider ml-1">
                                {t('settings:api.modal.qwen.reasoning_effort', 'Reasoning Effort')}
                              </Label>
                              <AppSelect
                                value={formData.reasoningEffort ?? 'unset'}
                                onValueChange={v => setFormData(prev => ({ ...prev, reasoningEffort: v === 'unset' ? undefined : v }))}
                                placeholder={t('settings:api.modal.reasoning.default_option')}
                                options={[
                                  { value: 'unset', label: t('settings:api.modal.reasoning.unset_option') },
                                  { value: 'low', label: t('settings:api.modal.reasoning.effort.low') },
                                  { value: 'medium', label: t('settings:api.modal.reasoning.effort.medium') },
                                  { value: 'high', label: t('settings:api.modal.reasoning.effort.high') },
                                ]}
                                variant="ghost"
                                className="bg-muted/30 border-transparent hover:border-border/50 transition-all h-10"
                              />
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    </div>
                  )}

                  {/* Grok 专用面板 */}
                  {formData.modelAdapter === 'grok' && (
                    <div className="space-y-6">
                      <Card className="border-border/40">
                        <CardHeader className="pb-3">
                          <CardTitle className="text-sm flex items-center gap-2">
                            <Zap className="h-4 w-4 text-primary" />
                            {t('settings:api.modal.grok.title')}
                          </CardTitle>
                          <CardDescription className="text-xs">
                            {t('settings:api.modal.grok.description')}
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className="space-y-2">
                            <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider ml-1">
                              {t('settings:api.modal.grok.reasoning_effort')}
                            </Label>
                            <AppSelect
                              value={formData.reasoningEffort ?? 'unset'}
                              onValueChange={v => setFormData(prev => ({ ...prev, reasoningEffort: v === 'unset' ? undefined : v }))}
                              placeholder={t('settings:api.modal.reasoning.default_option')}
                              options={[
                                { value: 'unset', label: t('settings:api.modal.reasoning.unset_option') },
                                { value: 'low', label: t('settings:api.modal.reasoning.effort.low') },
                                { value: 'high', label: t('settings:api.modal.reasoning.effort.high') },
                              ]}
                              variant="ghost"
                              className="bg-muted/30 border-transparent hover:border-border/50 transition-all h-10"
                            />
                            <p className="text-[10px] text-muted-foreground/60 ml-1">
                              {t('settings:api.modal.grok.reasoning_effort_hint')}
                            </p>
                          </div>
                          {formData.model?.toLowerCase().includes('grok-4') && (
                            <p className="text-xs text-amber-500 flex items-center gap-1">
                              <Info className="h-3 w-3" />
                              {t('settings:api.modal.grok.grok4_warning')}
                            </p>
                          )}
                        </CardContent>
                      </Card>
                    </div>
                  )}

                  {/* Doubao 专用面板 */}
                  {formData.modelAdapter === 'doubao' && (
                    <div className="space-y-6">
                      <Card className="border-border/40">
                        <CardHeader className="pb-3">
                          <CardTitle className="text-sm flex items-center gap-2">
                            <Brain className="h-4 w-4 text-primary" />
                            {t('settings:api.modal.doubao.title')}
                          </CardTitle>
                          <CardDescription className="text-xs">
                            {t('settings:api.modal.doubao.description')}
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className="space-y-2">
                            <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider ml-1">
                              {t('settings:api.modal.doubao.thinking_mode')}
                            </Label>
                            <AppSelect
                              value={formData.reasoningEffort ?? 'enabled'}
                              onValueChange={v => setFormData(prev => ({ 
                                ...prev, 
                                reasoningEffort: v,
                                enableThinking: v !== 'disabled',
                                supportsReasoning: v !== 'disabled'
                              }))}
                              options={[
                                { value: 'enabled', label: t('settings:api.modal.doubao.mode_enabled') },
                                { value: 'disabled', label: t('settings:api.modal.doubao.mode_disabled') },
                                { value: 'auto', label: t('settings:api.modal.doubao.mode_auto') },
                              ]}
                              variant="ghost"
                              className="bg-muted/30 border-transparent hover:border-border/50 transition-all h-10"
                            />
                            <p className="text-[10px] text-muted-foreground/60 ml-1">
                              {t('settings:api.modal.doubao.thinking_mode_hint')}
                            </p>
                          </div>
                        </CardContent>
                      </Card>
                    </div>
                  )}

                  {/* Zhipu 专用面板 */}
                  {formData.modelAdapter === 'zhipu' && (
                    <div className="space-y-6">
                      <Card className="border-border/40">
                        <CardHeader className="pb-3">
                          <CardTitle className="text-sm flex items-center gap-2">
                            <Brain className="h-4 w-4 text-primary" />
                            {t('settings:api.modal.zhipu.title')}
                          </CardTitle>
                          <CardDescription className="text-xs">
                            {t('settings:api.modal.zhipu.description')}
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className={cn("flex items-center justify-between p-4 rounded-xl border transition-all duration-200", formData.enableThinking ? "bg-primary/5 border-primary/30" : "bg-card border-border/40 hover:border-border/60")}>
                            <div className="space-y-1">
                              <Label className="text-sm font-medium cursor-pointer" onClick={() => setFormData(prev => ({ ...prev, enableThinking: !prev.enableThinking }))}>
                                {t('settings:api.modal.zhipu.enable_thinking')}
                              </Label>
                              <p className="text-xs text-muted-foreground/70">
                                {t('settings:api.modal.zhipu.enable_thinking_hint')}
                              </p>
                            </div>
                            <Switch
                              checked={!!formData.enableThinking}
                              onCheckedChange={v => setFormData(prev => ({ ...prev, enableThinking: !!v, supportsReasoning: !!v }))}
                            />
                          </div>
                          <div className={cn("flex items-center justify-between p-4 rounded-xl border transition-all duration-200", formData.includeThoughts ? "bg-primary/5 border-primary/30" : "bg-card border-border/40 hover:border-border/60")}>
                            <div className="space-y-1">
                              <Label className="text-sm font-medium cursor-pointer" onClick={() => setFormData(prev => ({ ...prev, includeThoughts: !prev.includeThoughts }))}>
                                {t('settings:api.modal.zhipu.preserve_thinking')}
                              </Label>
                              <p className="text-xs text-muted-foreground/70">
                                {t('settings:api.modal.zhipu.preserve_thinking_hint')}
                              </p>
                            </div>
                            <Switch
                              checked={!!formData.includeThoughts}
                              onCheckedChange={v => setFormData(prev => ({ ...prev, includeThoughts: !!v }))}
                            />
                          </div>
                        </CardContent>
                      </Card>
                    </div>
                  )}

                  {/* Moonshot/Kimi 专用面板 */}
                  {formData.modelAdapter === 'moonshot' && (
                    <div className="space-y-6">
                      <Card className="border-border/40">
                        <CardHeader className="pb-3">
                          <CardTitle className="text-sm flex items-center gap-2">
                            <Brain className="h-4 w-4 text-primary" />
                            {t('settings:api.modal.moonshot.title')}
                          </CardTitle>
                          <CardDescription className="text-xs">
                            {t('settings:api.modal.moonshot.description')}
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            <Info className="h-3 w-3" />
                            {t('settings:api.modal.moonshot.auto_config')}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {t('settings:api.modal.moonshot.reasoning_content')}
                          </p>
                        </CardContent>
                      </Card>
                    </div>
                  )}

                  {/* MiniMax 专用面板 */}
                  {formData.modelAdapter === 'minimax' && (
                    <div className="space-y-6">
                      <Card className="border-border/40">
                        <CardHeader className="pb-3">
                          <CardTitle className="text-sm flex items-center gap-2">
                            <Brain className="h-4 w-4 text-primary" />
                            {t('settings:api.modal.minimax.title')}
                          </CardTitle>
                          <CardDescription className="text-xs">
                            {t('settings:api.modal.minimax.description')}
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className={cn("flex items-center justify-between p-4 rounded-xl border transition-all duration-200", formData.reasoningSplit ? "bg-primary/5 border-primary/30" : "bg-card border-border/40 hover:border-border/60")}>
                            <div className="space-y-1">
                              <Label className="text-sm font-medium cursor-pointer" onClick={() => setFormData(prev => ({ ...prev, reasoningSplit: !prev.reasoningSplit }))}>
                                {t('settings:api.modal.minimax.reasoning_split', 'Reasoning Split')}
                              </Label>
                              <p className="text-xs text-muted-foreground/70">
                                {t('settings:api.modal.minimax.reasoning_split_hint')}
                              </p>
                            </div>
                            <Switch
                              checked={!!formData.reasoningSplit}
                              onCheckedChange={v => setFormData(prev => ({ ...prev, reasoningSplit: !!v }))}
                            />
                          </div>
                          <p className="text-xs text-amber-500 flex items-center gap-1">
                            <Info className="h-3 w-3" />
                            {t('settings:api.modal.minimax.no_enable_thinking')}
                          </p>
                        </CardContent>
                      </Card>
                    </div>
                  )}
                </TabsContent>
              </div>
            </CustomScrollArea>
          </Tabs>

          {/* Footer - Fixed & Minimal */}
          <div className="flex-none px-3 pt-2 pb-8 sm:pb-2 border-t border-border/40 flex items-center justify-end gap-2">
            <NotionButton type="button" variant="ghost" onClick={onCancel} className="hover:bg-muted/50 text-muted-foreground hover:text-foreground">
              {t('common:actions.cancel')}
            </NotionButton>
            <NotionButton type="submit" variant="primary" className="min-w-[100px]">
              {t('common:actions.save')}
            </NotionButton>
          </div>
        </form>
  );

  // 嵌入模式：直接返回表单内容，不使用 Dialog 包裹
  if (embeddedMode) {
    return (
      <div className="h-full flex flex-col">
        {formContent}
      </div>
    );
  }

  // 模态框模式：使用 Dialog 包裹
  // containerSelector 限制遮罩和居中区域在主内容区域（不包含左侧边栏）
  return (
    <Dialog open={true} onOpenChange={() => {}}>
      <DialogContent
        closeOnOverlayClick={false}
        containerSelector="#settings-main-content"
        className="w-[min(95vw,672px)] max-h-[min(85vh,700px)] p-0 overflow-hidden bg-background flex flex-col border shadow-2xl rounded-xl sm:rounded-2xl"
      >
        {formContent}
      </DialogContent>
    </Dialog>
  );
};

export default ShadApiEditModal;
