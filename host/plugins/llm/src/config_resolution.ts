/** Credential/header validation and vendor/profile runtime resolution. */
import type { ApiConfig, ModelProfile, VendorConfig } from '../api.ts';
import { AUTH_MODE_NONE, AUTH_MODE_OPENAI_CODEX_OAUTH, effectiveApiProtocolForConfig,
  resolvePreferredProtocolForProvider } from './protocol.ts';
import { looksLikeImageGenerationModelId, looksLikeMultimodalEmbedding, resolveCapabilityOverrides } from './capabilities.ts';
import { isOpencodeGoConfig, baseUrlForProtocol } from './opencode_go.ts';

export function isMaskedSecret(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== '' && [...trimmed].every(character => character === '*');
}
export function isSensitiveVendorHeader(name: string): boolean { return name.trim() !== ''; }
export function apiOriginsMatch(left: string, right: string): boolean {
  const parse = (raw: string): { scheme: string; host: string; port: number } | null => {
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)/.exec(raw.trim());
    if (!match) return null;
    const scheme = match[1]!.toLowerCase(), authority = match[2]!;
    const at = authority.lastIndexOf('@');
    const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
    let host: string, portText: string;
    if (hostPort.startsWith('[')) {
      const end = hostPort.indexOf(']');
      if (end < 0) return null;
      host = hostPort.slice(0, end + 1); portText = hostPort.slice(end + 1).replace(/^:/, '');
    } else {
      const parts = hostPort.split(':'); host = parts[0] ?? ''; portText = parts[1] ?? '';
    }
    if (host === '') return null;
    let port = 0;
    if (portText !== '') { if (!/^\d+$/.test(portText)) return null; port = Number(portText); }
    else if (scheme === 'http' || scheme === 'ws') port = 80;
    else if (scheme === 'https' || scheme === 'wss') port = 443;
    else if (scheme === 'ftp') port = 21;
    return { scheme, host: host.toLowerCase(), port };
  };
  const a = parse(left), b = parse(right);
  return a !== null && b !== null && a.scheme === b.scheme && a.host === b.host && a.port === b.port;
}
export function isValidHeaderName(name: string): boolean { return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name); }
export function isValidHeaderValue(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code !== 0x09 && (code < 0x20 || code > 0x7e)) return false;
  }
  return true;
}
export interface ResolvedModelConfig { vendor: VendorConfig; profile: ModelProfile; runtime: ApiConfig }
export function mergeVendorProfile(vendor: VendorConfig, profile: ModelProfile, codexAuthenticated: boolean,
  decrypt: (value: string) => string): ResolvedModelConfig {
  const hasNoAuth = vendor.authMode?.toLowerCase() === AUTH_MODE_NONE;
  const apiKey = hasNoAuth ? '' : vendor.isBuiltin ? vendor.apiKey.trim() : decrypt(vendor.apiKey).trim();
  const hasApiKey = (apiKey !== '' && apiKey !== '***' && ![...apiKey].every(character => character === '*'))
    || vendor.apiKeys.some(key => key.trim() !== '');
  const hasOauthSession = vendor.providerType.toLowerCase() === 'openai_codex'
    && vendor.authMode === AUTH_MODE_OPENAI_CODEX_OAUTH && codexAuthenticated;
  const providerScope = profile.providerScope ?? vendor.providerType;
  const capabilityOverrides = resolveCapabilityOverrides(profile.model, providerScope);
  const maxTokensLimit = profile.maxTokensLimit !== null && vendor.maxTokensLimit !== null
    ? Math.min(profile.maxTokensLimit, vendor.maxTokensLimit) : profile.maxTokensLimit ?? vendor.maxTokensLimit;
  const runtime: ApiConfig = {
    resolvedAdapterId: null, id: profile.id, name: profile.label, vendorId: vendor.id, vendorName: vendor.name,
    providerType: vendor.providerType, providerScope, authMode: vendor.authMode,
    apiProtocol: profile.apiProtocol ?? vendor.apiProtocol ?? resolvePreferredProtocolForProvider(
      vendor.providerType, profile.modelAdapter, vendor.baseUrl, vendor.supportsOpenaiResponses),
    supportsOpenaiResponses: vendor.supportsOpenaiResponses, apiKey, baseUrl: vendor.baseUrl, model: profile.model,
    isMultimodal: profile.isMultimodal || capabilityOverrides.isMultimodal
      || (profile.isEmbedding && !profile.isReranker && looksLikeMultimodalEmbedding(profile.model)),
    isReasoning: profile.isReasoning, isEmbedding: profile.isEmbedding, isReranker: profile.isReranker,
    isImageGeneration: profile.isImageGeneration || looksLikeImageGenerationModelId(profile.model),
    enabled: profile.enabled && profile.status.toLowerCase() !== 'disabled' && (hasApiKey || hasNoAuth || hasOauthSession),
    modelAdapter: profile.modelAdapter, maxOutputTokens: profile.maxOutputTokens, temperature: profile.temperature,
    supportsTools: profile.supportsTools || capabilityOverrides.supportsTools,
    geminiApiVersion: profile.geminiApiVersion ?? 'v1', isBuiltin: profile.isBuiltin || vendor.isBuiltin,
    isReadOnly: vendor.isReadOnly, reasoningEffort: profile.reasoningEffort, reasoningMode: profile.reasoningMode,
    thinkingEnabled: profile.thinkingEnabled, thinkingBudget: profile.thinkingBudget, includeThoughts: profile.includeThoughts,
    minP: profile.minP, topK: profile.topK, enableThinking: profile.enableThinking,
    supportsReasoning: profile.supportsReasoning || profile.isReasoning || capabilityOverrides.supportsReasoning,
    headers: { ...vendor.headers }, topPOverride: null, frequencyPenaltyOverride: null, presencePenaltyOverride: null,
    repetitionPenalty: profile.repetitionPenalty, reasoningSplit: profile.reasoningSplit, effort: profile.effort,
    verbosity: profile.verbosity, isFavorite: profile.isFavorite, maxTokensLimit,
    contextWindow: profile.contextWindow ?? capabilityOverrides.contextWindow, extraBody: profile.extraBody,
  };
  if (isOpencodeGoConfig(runtime)) runtime.baseUrl = baseUrlForProtocol(runtime.baseUrl, effectiveApiProtocolForConfig(runtime));
  return { vendor: { ...vendor }, profile: { ...profile }, runtime };
}
/** Preserve user changes while refreshing fields unchanged since the previous built-in snapshot. */
export function mergeBuiltinProfileUserAware(profiles: ModelProfile[], builtinProfile: ModelProfile,
  previousBuiltinProfile: ModelProfile | undefined): void {
  const existing = profiles.find(profile => profile.id === builtinProfile.id);
  if (existing === undefined) { profiles.push(builtinProfile); return; }
  existing.isBuiltin = true;
  if (previousBuiltinProfile === undefined) {
    existing.isMultimodal = builtinProfile.isMultimodal; existing.isReasoning = builtinProfile.isReasoning;
    existing.isEmbedding = builtinProfile.isEmbedding; existing.isReranker = builtinProfile.isReranker;
    existing.supportsTools = builtinProfile.supportsTools; existing.supportsReasoning = builtinProfile.supportsReasoning;
    return;
  }
  const updatable = [
    'vendorId', 'label', 'model', 'modelAdapter', 'isMultimodal', 'isReasoning',
    'isEmbedding', 'isReranker', 'supportsTools', 'supportsReasoning', 'status', 'enabled',
    'maxOutputTokens', 'temperature', 'reasoningEffort', 'thinkingEnabled', 'thinkingBudget',
    'includeThoughts', 'enableThinking', 'minP', 'topK', 'geminiApiVersion',
    'repetitionPenalty', 'reasoningSplit', 'effort', 'verbosity', 'isFavorite', 'maxTokensLimit', 'contextWindow',
  ] as const;
  for (const field of updatable) {
    if (existing[field] === previousBuiltinProfile[field]) (existing as unknown as Record<string, unknown>)[field] = builtinProfile[field];
  }
}
