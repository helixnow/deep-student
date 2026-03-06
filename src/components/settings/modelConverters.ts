/**
 * 模型配置转换函数
 * 从 Settings.tsx 提取
 */

import { ModelProfile, VendorConfig, ApiConfig } from '../../types';

export const convertProfileToApiConfig = (profile: ModelProfile, vendor: VendorConfig): ApiConfig => ({
  id: profile.id,
  name: profile.label,
  vendorId: vendor.id,
  vendorName: vendor.name,
  providerType: vendor.providerType,
  providerScope: profile.providerScope ?? vendor.providerType,
  apiKey: vendor.apiKey ?? '',
  baseUrl: vendor.baseUrl,
  model: profile.model,
  isMultimodal: profile.isMultimodal,
  isReasoning: profile.isReasoning,
  isEmbedding: profile.isEmbedding,
  isReranker: profile.isReranker,
  enabled: profile.enabled !== false && profile.status !== 'disabled',
  modelAdapter: profile.modelAdapter,
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
  repetitionPenalty: profile.repetitionPenalty,
  reasoningSplit: profile.reasoningSplit,
  effort: profile.effort,
  verbosity: profile.verbosity,
});

export const convertApiConfigToProfile = (api: ApiConfig, vendorId: string): ModelProfile => ({
  id: api.id,
  vendorId,
  label: api.name,
  model: api.model,
  providerScope: api.providerScope ?? api.providerType,
  modelAdapter: api.modelAdapter,
  isMultimodal: api.isMultimodal,
  isReasoning: api.isReasoning,
  isEmbedding: api.isEmbedding,
  isReranker: api.isReranker,
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
  repetitionPenalty: api.repetitionPenalty,
  reasoningSplit: api.reasoningSplit,
  effort: api.effort,
  verbosity: api.verbosity,
});

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
  return 'openai';
};
