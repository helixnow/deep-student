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

export const providerTypeFromConfig = (providerType?: string | null, adapter?: string | null) => {
  if (providerType) return providerType;
  if (!adapter) return 'openai';
  if (adapter === 'google') return 'google';
  if (adapter === 'anthropic') return 'anthropic';
  return 'openai';
};
