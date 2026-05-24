/**
 * 模型配置转换函数
 * 从 Settings.tsx 提取
 */

import { ModelProfile, VendorConfig, ApiConfig, type ApiProtocol, type ModelAdapter } from '@/types';
import {
  getAllowedProtocolsForProviderType,
  resolvePreferredProtocol,
} from '@/utils/providerProtocolRegistry';

const OPENAI_COMPATIBLE_PROTOCOLS: ApiProtocol[] = ['openai_chat_completions', 'openai_responses'];

export const defaultOpenAiCompatibleProtocol = (args: {
  providerType?: string | null;
  adapter?: string | null;
  model?: string | null;
  baseUrl?: string | null;
  supportsOpenAIResponses?: boolean | null;
}): ApiProtocol =>
  resolvePreferredProtocol({
    providerType: args.providerType,
    adapter: args.adapter,
    baseUrl: args.baseUrl,
    supportsOpenAIResponses: args.supportsOpenAIResponses,
  });

export const getAllowedApiProtocolsForProviderType = (providerType?: string | null): ApiProtocol[] =>
  getAllowedProtocolsForProviderType(providerType);

export const defaultApiProtocolForProvider = (
  providerType?: string | null,
  options?: { model?: string | null; baseUrl?: string | null; adapter?: string | null; supportsOpenAIResponses?: boolean | null }
): ApiProtocol => {
  const allowed = getAllowedApiProtocolsForProviderType(providerType);
  const preferred = defaultOpenAiCompatibleProtocol({
    providerType,
    baseUrl: options?.baseUrl,
    model: options?.model,
    adapter: options?.adapter,
    supportsOpenAIResponses: options?.supportsOpenAIResponses,
  });
  if (allowed.includes(preferred)) {
    return preferred;
  }
  return allowed[0] ?? 'openai_chat_completions';
};

export const normalizeApiProtocolForProviderType = (
  explicitProtocol?: ApiProtocol | null,
  providerType?: string | null,
  options?: { model?: string | null; baseUrl?: string | null; adapter?: string | null; supportsOpenAIResponses?: boolean | null }
): ApiProtocol => {
  const allowed = getAllowedApiProtocolsForProviderType(providerType);
  if (explicitProtocol && allowed.includes(explicitProtocol)) {
    return explicitProtocol;
  }
  return defaultApiProtocolForProvider(providerType, options);
};

export const getAllowedApiProtocolsForModelAdapter = (adapter?: string | null): ApiProtocol[] => {
  const normalized = (adapter ?? '').toLowerCase() as ModelAdapter | '';
  if (normalized === 'anthropic') return ['anthropic_messages'];
  if (normalized === 'google') return ['google_generate_content'];
  return OPENAI_COMPATIBLE_PROTOCOLS;
};

export const defaultApiProtocolForModelAdapter = (
  adapter?: string | null,
  options?: { providerType?: string | null; model?: string | null; baseUrl?: string | null; supportsOpenAIResponses?: boolean | null }
): ApiProtocol => {
  const allowed = getAllowedApiProtocolsForModelAdapter(adapter);
  const preferred = defaultOpenAiCompatibleProtocol({
    adapter,
    providerType: options?.providerType,
    model: options?.model,
    baseUrl: options?.baseUrl,
    supportsOpenAIResponses: options?.supportsOpenAIResponses,
  });
  if (allowed.includes(preferred)) {
    return preferred;
  }
  return allowed[0] ?? 'openai_chat_completions';
};

export const normalizeApiProtocolForModelAdapter = (
  explicitProtocol?: ApiProtocol | null,
  adapter?: string | null,
  providerType?: string | null,
  options?: { model?: string | null; baseUrl?: string | null; supportsOpenAIResponses?: boolean | null }
): ApiProtocol => {
  const allowed = getAllowedApiProtocolsForModelAdapter(adapter);
  if (explicitProtocol && allowed.includes(explicitProtocol)) {
    return explicitProtocol;
  }
  const providerDefault = normalizeApiProtocolForProviderType(explicitProtocol, providerType, {
    model: options?.model,
    baseUrl: options?.baseUrl,
    adapter,
    supportsOpenAIResponses: options?.supportsOpenAIResponses,
  });
  if (allowed.includes(providerDefault)) {
    return providerDefault;
  }
  return defaultApiProtocolForModelAdapter(adapter, {
    providerType,
    model: options?.model,
    baseUrl: options?.baseUrl,
    supportsOpenAIResponses: options?.supportsOpenAIResponses,
  });
};

const resolveApiProtocol = (
  explicitProtocol?: ApiProtocol | null,
  providerType?: string | null,
  adapter?: string | null,
  options?: { model?: string | null; baseUrl?: string | null; supportsOpenAIResponses?: boolean | null }
): ApiProtocol => normalizeApiProtocolForModelAdapter(explicitProtocol, adapter, providerType, options);

const isLegacyOpenAiAdapter = (adapter?: string | null) => {
  const normalized = (adapter ?? '').toLowerCase();
  return normalized === '' || normalized === 'openai' || normalized === 'general';
};

const isDeepSeekFamilyModel = (
  model: string,
  providerScope?: string | null,
  providerType?: string | null
) => {
  const lowerModel = model.toLowerCase();
  const lowerScope = (providerScope ?? '').toLowerCase();
  const lowerProvider = (providerType ?? '').toLowerCase();
  if (lowerScope === 'nvidia' || lowerProvider === 'nvidia') {
    return false;
  }
  return lowerModel.includes('deepseek') || lowerScope === 'deepseek' || lowerProvider === 'deepseek';
};

const normalizeDeepSeekModelAdapter = (
  adapter: string | undefined,
  model: string,
  providerScope?: string | null,
  providerType?: string | null
) => {
  if (isLegacyOpenAiAdapter(adapter) && isDeepSeekFamilyModel(model, providerScope, providerType)) {
    return 'deepseek';
  }
  return adapter ?? 'openai';
};

export const convertProfileToApiConfig = (profile: ModelProfile, vendor: VendorConfig): ApiConfig => {
  const providerScope = profile.providerScope ?? vendor.providerType;
  const modelAdapter = normalizeDeepSeekModelAdapter(
    profile.modelAdapter,
    profile.model,
    providerScope,
    vendor.providerType
  );

  return {
    id: profile.id,
    name: profile.label,
    vendorId: vendor.id,
    vendorName: vendor.name,
    providerType: vendor.providerType,
    providerScope,
    apiProtocol: resolveApiProtocol(profile.apiProtocol ?? vendor.apiProtocol, vendor.providerType, modelAdapter, {
      model: profile.model,
      baseUrl: vendor.baseUrl,
      supportsOpenAIResponses: vendor.supportsOpenAIResponses,
    }),
    supportsOpenAIResponses: vendor.supportsOpenAIResponses,
    apiKey: vendor.apiKey ?? '',
    baseUrl: vendor.baseUrl,
    model: profile.model,
    isMultimodal: profile.isMultimodal,
    isReasoning: profile.isReasoning,
    isEmbedding: profile.isEmbedding,
    isReranker: profile.isReranker,
    isImageGeneration: profile.isImageGeneration,
    enabled: profile.enabled !== false && profile.status !== 'disabled',
    modelAdapter,
    maxOutputTokens: profile.maxOutputTokens ?? 0,
    temperature: profile.temperature ?? 0.7,
    supportsTools: profile.supportsTools ?? false,
    geminiApiVersion: profile.geminiApiVersion ?? 'v1',
    isBuiltin: profile.isBuiltin ?? false,
    isReadOnly: vendor.isReadOnly ?? false,
    reasoningEffort: profile.reasoningEffort,
    thinkingEnabled: profile.thinkingEnabled ?? false,
    thinkingBudget: profile.thinkingBudget,
    includeThoughts: profile.includeThoughts ?? false,
    enableThinking: profile.enableThinking,
    minP: profile.minP,
    topK: profile.topK,
    supportsReasoning: profile.supportsReasoning ?? profile.isReasoning,
    headers: vendor.headers,
    contextWindow: profile.contextWindow,
    repetitionPenalty: profile.repetitionPenalty,
    reasoningSplit: profile.reasoningSplit,
    effort: profile.effort,
    verbosity: profile.verbosity,
  };
};

export const convertApiConfigToProfile = (api: ApiConfig, vendorId: string): ModelProfile => {
  const providerScope = api.providerScope ?? api.providerType;
  const modelAdapter = normalizeDeepSeekModelAdapter(
    api.modelAdapter,
    api.model,
    providerScope,
    api.providerType
  );

  return {
    id: api.id,
    vendorId,
    label: api.name,
    model: api.model,
    providerScope,
    apiProtocol: resolveApiProtocol(api.apiProtocol, api.providerType, modelAdapter, {
      model: api.model,
      baseUrl: api.baseUrl,
      supportsOpenAIResponses: api.supportsOpenAIResponses,
    }),
    modelAdapter,
    isMultimodal: api.isMultimodal,
    isReasoning: api.isReasoning,
    isEmbedding: api.isEmbedding,
    isReranker: api.isReranker,
    isImageGeneration: api.isImageGeneration,
    supportsTools: api.supportsTools,
    supportsReasoning: api.supportsReasoning ?? api.isReasoning,
    status: api.enabled ? 'enabled' : 'disabled',
    enabled: api.enabled,
    maxOutputTokens: api.maxOutputTokens,
    temperature: api.temperature,
    reasoningEffort: api.reasoningEffort,
    thinkingEnabled: api.thinkingEnabled,
    thinkingBudget: api.thinkingBudget,
    includeThoughts: api.includeThoughts,
    enableThinking: api.enableThinking,
    minP: api.minP,
    topK: api.topK,
    geminiApiVersion: api.geminiApiVersion,
    isBuiltin: api.isBuiltin,
    isReadOnly: api.isReadOnly,
    contextWindow: api.contextWindow,
    repetitionPenalty: api.repetitionPenalty,
    reasoningSplit: api.reasoningSplit,
    effort: api.effort,
    verbosity: api.verbosity,
  };
};

export const normalizeBaseUrl = (url: string) => url.trim().replace(/\/+$/, '');

export const inferProviderTypeFromBaseUrl = (baseUrl?: string | null): string | undefined => {
  const lowerBaseUrl = normalizeBaseUrl(baseUrl ?? '').toLowerCase();
  if (!lowerBaseUrl) return undefined;

  if (lowerBaseUrl.includes('siliconflow.cn') || lowerBaseUrl.includes('siliconflow.com')) {
    return 'siliconflow';
  }
  if (
    lowerBaseUrl.includes('dashscope.aliyuncs.com') ||
    lowerBaseUrl.includes('dashscope-intl.aliyuncs.com')
  ) {
    return 'qwen';
  }
  if (lowerBaseUrl.includes('openrouter.ai')) {
    return 'openrouter';
  }
  if (lowerBaseUrl.includes('://localhost:11434') || lowerBaseUrl.includes('://127.0.0.1:11434') || lowerBaseUrl.includes('ollama')) {
    return 'ollama';
  }
  if (lowerBaseUrl.includes('api.deepseek.com')) {
    return 'deepseek';
  }
  if (lowerBaseUrl.includes('open.bigmodel.cn')) {
    return 'zhipu';
  }
  if (lowerBaseUrl.includes('volces.com') || lowerBaseUrl.includes('volcengine.com')) {
    return 'doubao';
  }
  if (lowerBaseUrl.includes('api.moonshot.cn')) {
    return 'moonshot';
  }
  if (lowerBaseUrl.includes('api.openai.com')) {
    return 'openai';
  }
  if (lowerBaseUrl.includes('generativelanguage.googleapis.com')) {
    return 'gemini';
  }
  if (lowerBaseUrl.includes('api.x.ai')) {
    return 'grok';
  }
  if (lowerBaseUrl.includes('api.anthropic.com')) {
    return 'anthropic';
  }
  if (lowerBaseUrl.includes('api.minimax.io') || lowerBaseUrl.includes('api.minimax.chat')) {
    return 'minimax';
  }
  if (lowerBaseUrl.includes('integrate.api.nvidia.com')) {
    return 'nvidia';
  }
  if (lowerBaseUrl.includes('xiaomimimo.com')) {
    return 'mimo';
  }

  return undefined;
};

export const providerTypeFromConfig = (providerType?: string | null, adapter?: string | null) => {
  if (providerType) return providerType;
  if (!adapter) return 'openai';
  if (adapter === 'qwen') return 'qwen';
  if (adapter === 'deepseek') return 'deepseek';
  if (adapter === 'zhipu') return 'zhipu';
  if (adapter === 'doubao') return 'doubao';
  if (adapter === 'moonshot') return 'moonshot';
  if (adapter === 'grok') return 'grok';
  if (adapter === 'google') return 'google';
  if (adapter === 'anthropic') return 'anthropic';
  if (adapter === 'minimax') return 'minimax';
  if (adapter === 'ernie') return 'ernie';
  if (adapter === 'mistral') return 'mistral';
  if (adapter === 'nvidia') return 'nvidia';
  if (adapter === 'mimo') return 'mimo';
  return 'openai';
};
