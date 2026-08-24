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
const resolveHostnameFromBaseUrl = (baseUrl?: string | null): string | null => {
  const normalizedBaseUrl = normalizeBaseUrlForProtocolRegistry(baseUrl);
  if (!normalizedBaseUrl) return null;
  const candidate = normalizedBaseUrl.includes('://') ? normalizedBaseUrl : `https://${normalizedBaseUrl}`;
  try {
    return new URL(candidate).hostname;
  } catch {
    return null;
  }
};

const resolvesToOfficialOpenAi = (baseUrl?: string | null) =>
  resolveHostnameFromBaseUrl(baseUrl) === 'api.openai.com';

// 官方原生协议主机：与 resolvesToOfficialOpenAi 同风格的 hostname 精确匹配，
// path 携带官方域名（myproxy.com/api.anthropic.com）或子域伪造
// （api.anthropic.com.evil.example）都不会命中。
const OFFICIAL_NATIVE_PROTOCOL_HOSTS: Readonly<Record<string, ApiProtocol>> = {
  'api.anthropic.com': 'anthropic_messages',
  'generativelanguage.googleapis.com': 'google_generate_content',
};

// 导出给 settings 层（modelConverters）复用：官方 host 的原生协议不受
// providerType allowed 列表约束，判定逻辑必须与 resolvePreferredProtocol 同源。
export const resolveOfficialNativeProtocol = (baseUrl?: string | null): ApiProtocol | undefined => {
  const hostname = resolveHostnameFromBaseUrl(baseUrl);
  return hostname ? OFFICIAL_NATIVE_PROTOCOL_HOSTS[hostname] : undefined;
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
  // 官方 Anthropic / Gemini 端点只说原生协议：用户把 Base URL 填成官方主机、
  // 但 providerType 误配为 custom/openai 时，allowed 列表不含原生协议，若照走
  // openai_chat_completions，2026.8 的官方 Claude/Gemini 会直接 404/协议错。
  // 因此官方 host 在此覆盖错误的 providerType，即使 allowed 不含该原生协议也
  // 返回 native——这是与官方 api.openai.com 相同的 URL 特例，不改动
  // getAllowedProtocolsForProviderType('custom')；代理/中转 host 不受影响，
  // 仍按下方 allowed + adapter 的既有规则走 OpenAI 兼容路由。
  const officialNativeProtocol = resolveOfficialNativeProtocol(args.baseUrl);
  if (officialNativeProtocol) {
    return officialNativeProtocol;
  }

  const normalizedAdapter = normalize(args.adapter);
  const allowed = getAllowedProtocolsForProviderType(args.providerType);
  const nativeProtocol =
    normalizedAdapter === 'anthropic' || normalizedAdapter === 'claude'
      ? 'anthropic_messages'
      : normalizedAdapter === 'google' || normalizedAdapter === 'gemini'
        ? 'google_generate_content'
        : undefined;
  if (nativeProtocol && allowed.includes(nativeProtocol)) {
    return nativeProtocol;
  }

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
