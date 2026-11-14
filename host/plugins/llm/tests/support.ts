import type { ApiConfig } from '../api.ts';

export function makeConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    id: '', name: '', vendorId: null, vendorName: null, providerType: null,
    providerScope: null, authMode: null, apiProtocol: null, supportsOpenaiResponses: null,
    apiKey: '', baseUrl: '', model: '', isMultimodal: false, isReasoning: false,
    isEmbedding: false, isReranker: false, isImageGeneration: false, enabled: false,
    modelAdapter: 'general', maxOutputTokens: 8192, temperature: 0.7, supportsTools: false,
    geminiApiVersion: 'v1', isBuiltin: false, isReadOnly: false, reasoningEffort: null,
    reasoningMode: null, thinkingEnabled: false, thinkingBudget: null, includeThoughts: false,
    minP: null, topK: null, enableThinking: null, supportsReasoning: false, headers: null,
    topPOverride: null, frequencyPenaltyOverride: null, presencePenaltyOverride: null,
    repetitionPenalty: null, reasoningSplit: null, effort: null, verbosity: null,
    isFavorite: false, maxTokensLimit: null, contextWindow: null, extraBody: null,
    resolvedAdapterId: null, ...overrides,
  };
}

export type Body = { [key: string]: unknown };
