import registryData from '../../scripts/provider-protocol-registry.json';
import type { ApiProtocol } from '@/types';

export interface ProviderProtocolRecord {
  provider_type: string;
  allowed_protocols: ApiProtocol[];
  default_protocol: ApiProtocol;
  official?: boolean;
  supports_openai_responses?: boolean;
  notes?: string;
}

interface ProviderProtocolRegistryDocument {
  schema_version: string;
  updated_at: string;
  purpose?: string;
  providers: ProviderProtocolRecord[];
}

const OPENAI_COMPATIBLE_PROTOCOLS: ApiProtocol[] = ['openai_chat_completions', 'openai_responses'];
const raw = registryData as ProviderProtocolRegistryDocument;
const providers = raw.providers ?? [];

const normalize = (value?: string | null) => (value ?? '').trim().toLowerCase();

export const normalizeBaseUrlForProtocolRegistry = (url?: string | null) =>
  (url ?? '').trim().replace(/\/+$/, '').toLowerCase();

export const getProviderProtocolRecord = (providerType?: string | null): ProviderProtocolRecord | undefined => {
  const normalized = normalize(providerType);
  if (!normalized) return undefined;
  return providers.find((record) => record.provider_type === normalized);
};

// 使用 URL host 精确匹配，避免 `https://myproxy.com/api.openai.com/v1` 这类中转地址被误判为官方端点。
const resolvesToOfficialOpenAi = (baseUrl?: string | null) => {
  const normalizedBaseUrl = normalizeBaseUrlForProtocolRegistry(baseUrl);
  if (!normalizedBaseUrl) return false;
  const candidate = normalizedBaseUrl.includes('://') ? normalizedBaseUrl : `https://${normalizedBaseUrl}`;
  try {
    return new URL(candidate).hostname === 'api.openai.com';
  } catch {
    return false;
  }
};

export const providerSupportsOpenAiResponses = (args: {
  providerType?: string | null;
  baseUrl?: string | null;
  supportsOpenAIResponses?: boolean | null;
}): boolean => {
  if (args.supportsOpenAIResponses === true) return true;
  if (resolvesToOfficialOpenAi(args.baseUrl)) return true;
  if (normalize(args.providerType) === 'openai') return false;
  return getProviderProtocolRecord(args.providerType)?.supports_openai_responses === true;
};

export const getAllowedProtocolsForProviderType = (providerType?: string | null): ApiProtocol[] => {
  const record = getProviderProtocolRecord(providerType);
  return record?.allowed_protocols?.length ? record.allowed_protocols : OPENAI_COMPATIBLE_PROTOCOLS;
};

export const resolvePreferredProtocol = (args: {
  providerType?: string | null;
  adapter?: string | null;
  baseUrl?: string | null;
  supportsOpenAIResponses?: boolean | null;
}): ApiProtocol => {
  const normalizedAdapter = normalize(args.adapter);
  if (normalizedAdapter === 'anthropic') return 'anthropic_messages';
  if (normalizedAdapter === 'google') return 'google_generate_content';

  const allowed = getAllowedProtocolsForProviderType(args.providerType);

  // 仅「供应商级显式声明」或「官方 OpenAI 端点」才把默认路由切到 Responses。
  // 注册表级 supports_openai_responses=true 只解锁可选项（如 qwen/doubao 的白名单制
  // Responses 端点），默认路由仍由 default_protocol 决定。
  const explicitlyPrefersResponses =
    args.supportsOpenAIResponses === true || resolvesToOfficialOpenAi(args.baseUrl);
  if (explicitlyPrefersResponses && allowed.includes('openai_responses')) {
    return 'openai_responses';
  }

  if (
    normalize(args.providerType) === 'openai'
    && !resolvesToOfficialOpenAi(args.baseUrl)
    && allowed.includes('openai_chat_completions')
  ) {
    return 'openai_chat_completions';
  }

  const record = getProviderProtocolRecord(args.providerType);
  if (record?.default_protocol && allowed.includes(record.default_protocol)) {
    return record.default_protocol;
  }

  return allowed.find((protocol) => protocol === 'openai_chat_completions') ?? allowed[0] ?? 'openai_chat_completions';
};
