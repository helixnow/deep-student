/**
 * 供应商协议选择与归一化（移植 `dstu-llm/src/llm_manager/mod.rs` 3768–4175、
 * 4094–4175 与 `scripts/provider-protocol-registry.json`）。
 *
 * Rust 侧注册表缺失或解析失败时整体回退为空表（所有查询按"未登记"处理）；
 * 这里的数据模块编译期就固定，行为与解析成功一致。
 */
import { PROVIDER_PROTOCOL_REGISTRY_DOCUMENT } from './data/provider_protocol_registry.ts';
import type { ApiConfig, ModelProfile, VendorConfig } from '../api.ts';

export const AUTH_MODE_NONE = 'none';
export const AUTH_MODE_OPENAI_CODEX_OAUTH = 'openai_codex_oauth';

export interface ProviderProtocolRecord {
  provider_type: string;
  allowed_protocols: readonly string[];
  default_protocol: string;
  official?: boolean;
  supports_openai_responses?: boolean;
}

type Document = {
  providers: ProviderProtocolRecord[];
};

const REGISTRY: readonly ProviderProtocolRecord[] = (
  PROVIDER_PROTOCOL_REGISTRY_DOCUMENT as unknown as Document
).providers;

export function normalizeProviderValue(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export function normalizeBaseUrlForRegistry(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').toLowerCase();
}

export function getProviderProtocolRecord(providerType: string | null | undefined): ProviderProtocolRecord | null {
  const normalized = normalizeProviderValue(providerType);
  if (normalized === '') return null;
  return REGISTRY.find((record) => record.provider_type === normalized) ?? null;
}

export function providerAllowedProtocols(providerType: string | null | undefined): string[] {
  const record = getProviderProtocolRecord(providerType);
  if (record && record.allowed_protocols.length > 0) return [...record.allowed_protocols];
  return ['openai_chat_completions', 'openai_responses'];
}

/** 提取 base_url 的 host（去 scheme/path/query/port）。 */
export function baseUrlHost(baseUrl: string): string {
  const normalized = normalizeBaseUrlForRegistry(baseUrl);
  const schemeIdx = normalized.indexOf('://');
  const withoutScheme = schemeIdx >= 0 ? normalized.slice(schemeIdx + 3) : normalized;
  const hostPort = withoutScheme.split(/[/?#]/)[0] ?? '';
  return hostPort.split(':')[0] ?? '';
}

export function resolvesToOfficialOpenai(providerType: string | null | undefined, baseUrl: string): boolean {
  const normalizedProvider = normalizeProviderValue(providerType);
  const normalizedBaseUrl = normalizeBaseUrlForRegistry(baseUrl);
  if (normalizedProvider === 'openai' && normalizedBaseUrl === '') return true;
  return baseUrlHost(baseUrl) === 'api.openai.com';
}

export function providerSupportsOpenaiResponses(
  providerType: string | null | undefined,
  baseUrl: string,
  supportsOpenaiResponses: boolean | null | undefined,
): boolean {
  if (supportsOpenaiResponses === true) return true;
  if (resolvesToOfficialOpenai(providerType, baseUrl)) return true;
  if (normalizeProviderValue(providerType) === 'openai') return false;
  return getProviderProtocolRecord(providerType)?.supports_openai_responses === true;
}

export function nativeProtocolForModelAdapter(modelAdapter: string): string | null {
  switch (normalizeProviderValue(modelAdapter)) {
    case 'anthropic':
    case 'claude':
      return 'anthropic_messages';
    case 'google':
    case 'gemini':
      return 'google_generate_content';
    default:
      return null;
  }
}

export function resolvePreferredProtocolForProvider(
  providerType: string | null | undefined,
  adapter: string | null | undefined,
  baseUrl: string,
  supportsOpenaiResponses: boolean | null | undefined,
): string {
  const allowed = providerAllowedProtocols(providerType);
  const nativeProtocol = adapter ? nativeProtocolForModelAdapter(adapter) : null;
  if (nativeProtocol !== null && allowed.includes(nativeProtocol)) return nativeProtocol;

  const explicitlyPrefersResponses =
    supportsOpenaiResponses === true || resolvesToOfficialOpenai(providerType, baseUrl);
  if (explicitlyPrefersResponses && allowed.includes('openai_responses')) return 'openai_responses';

  if (
    normalizeProviderValue(providerType) === 'openai' &&
    !resolvesToOfficialOpenai(providerType, baseUrl) &&
    allowed.includes('openai_chat_completions')
  ) {
    return 'openai_chat_completions';
  }

  const record = getProviderProtocolRecord(providerType);
  if (record && allowed.includes(record.default_protocol)) return record.default_protocol;

  return allowed.find((protocol) => protocol === 'openai_chat_completions') ?? allowed[0] ?? 'openai_chat_completions';
}

export function deepseekModelSupportsOpenaiResponses(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  if (normalized === '') return true;
  return (
    normalized.includes('deepseek-v4-flash') ||
    normalized.includes('deepseek-flash') ||
    normalized.includes('deepseek-v4-pro') ||
    normalized === 'deepseek-chat' ||
    normalized === 'deepseek-reasoner'
  );
}

export function configClaimsDeepseekProvider(config: { providerType: string | null; providerScope?: string | null }): boolean {
  return (
    normalizeProviderValue(config.providerType) === 'deepseek' ||
    normalizeProviderValue(config.providerScope) === 'deepseek'
  );
}

export function isOfficialDeepseekConfig(config: { baseUrl: string; providerType: string | null; providerScope?: string | null }): boolean {
  const normalizedBaseUrl = normalizeBaseUrlForRegistry(config.baseUrl);
  if (normalizedBaseUrl === '') return configClaimsDeepseekProvider(config);
  return baseUrlHost(config.baseUrl) === 'api.deepseek.com';
}

export interface ProtocolConfigLike {
  apiProtocol: string | null;
  providerType: string | null;
  providerScope?: string | null;
  supportsOpenaiResponses: boolean | null;
  modelAdapter: string;
  baseUrl: string;
  model: string;
}

export function effectiveApiProtocolForConfig(config: ProtocolConfigLike): string {
  let explicitResponses: string | null = null;
  if (config.apiProtocol != null) {
    const normalized = normalizeProviderValue(config.apiProtocol);
    if (normalized === 'openai_responses') {
      if (providerSupportsOpenaiResponses(config.providerType, config.baseUrl, config.supportsOpenaiResponses)) {
        explicitResponses = normalized;
      }
    } else if (
      normalized === 'openai_chat_completions' ||
      normalized === 'anthropic_messages' ||
      normalized === 'google_generate_content'
    ) {
      return normalized;
    }
  }

  if (explicitResponses !== null) {
    // 空模型名视为可支持（协议归一化路径构造的临时 config）。
    if (isOfficialDeepseekConfig(config) && !deepseekModelSupportsOpenaiResponses(config.model)) {
      return 'openai_chat_completions';
    }
    return explicitResponses;
  }

  const preferred = resolvePreferredProtocolForProvider(
    config.providerType,
    config.modelAdapter,
    config.baseUrl,
    config.supportsOpenaiResponses,
  );
  if (preferred === 'openai_responses') {
    if (isOfficialDeepseekConfig(config)) {
      if (!deepseekModelSupportsOpenaiResponses(config.model)) return 'openai_chat_completions';
    } else if (configClaimsDeepseekProvider(config) && config.supportsOpenaiResponses !== true) {
      return 'openai_chat_completions';
    }
  }
  return preferred;
}

export function shouldUseOpenaiResponsesForConfig(config: ProtocolConfigLike): boolean {
  return effectiveApiProtocolForConfig(config) === 'openai_responses';
}

/** 就地归一化供应商协议；返回是否修改。 */
export function normalizeVendorProtocolConfig(vendor: VendorConfig): boolean {
  let changed = false;
  if (vendor.supportsOpenaiResponses === null || vendor.supportsOpenaiResponses === undefined) {
    vendor.supportsOpenaiResponses = providerSupportsOpenaiResponses(
      vendor.providerType,
      vendor.baseUrl,
      null,
    );
    changed = true;
  }
  if (vendor.apiProtocol != null) {
    const normalized = normalizeProviderValue(vendor.apiProtocol);
    if (
      normalized === 'openai_responses' &&
      !providerSupportsOpenaiResponses(vendor.providerType, vendor.baseUrl, vendor.supportsOpenaiResponses)
    ) {
      vendor.apiProtocol = resolvePreferredProtocolForProvider(
        vendor.providerType,
        'general',
        vendor.baseUrl,
        vendor.supportsOpenaiResponses,
      );
      changed = true;
    }
  }
  return changed;
}

/** 就地归一化模型条目的协议；返回是否修改。 */
export function normalizeModelProfileProtocolConfig(profile: ModelProfile, vendor: VendorConfig | undefined): boolean {
  if (profile.apiProtocol == null) return false;
  const normalized = normalizeProviderValue(profile.apiProtocol);
  if (normalized !== 'openai_responses') return false;

  const config: ProtocolConfigLike = {
    providerType: vendor?.providerType ?? null,
    baseUrl: vendor?.baseUrl ?? '',
    model: profile.model,
    modelAdapter: profile.modelAdapter,
    apiProtocol: 'openai_responses',
    supportsOpenaiResponses: vendor?.supportsOpenaiResponses ?? null,
  };
  if (shouldUseOpenaiResponsesForConfig(config)) return false;

  profile.apiProtocol = resolvePreferredProtocolForProvider(
    vendor?.providerType ?? null,
    profile.modelAdapter,
    vendor?.baseUrl ?? '',
    vendor?.supportsOpenaiResponses ?? null,
  );
  return true;
}

// ------------------------------------------------------------------ 适配器 id（仅用于 `resolvedAdapterId` 下发）

const AGGREGATOR_PLATFORMS = new Set([
  'siliconflow',
  'openrouter',
  'together',
  'fireworks',
  'groq',
  'custom',
  'general',
  'one-api',
  'one_api',
  'sub2api',
  'cpa',
]);

const ADAPTER_ID_BY_KEY: Readonly<Record<string, string>> = {
  openai: 'general',
  general: 'general',
  siliconflow: 'general',
  nvidia: 'general',
  mimo: 'mimo',
  minimax: 'minimax',
  deepseek: 'deepseek',
  qwen: 'qwen',
  zhipu: 'zhipu',
  doubao: 'doubao',
  moonshot: 'moonshot',
  kimi: 'moonshot',
  ernie: 'ernie',
  baidu: 'ernie',
  anthropic: 'anthropic',
  claude: 'anthropic',
  google: 'google',
  gemini: 'google',
  xai: 'grok',
  grok: 'grok',
  mistral: 'mistral',
};

function isAggregatorPlatform(providerType: string): boolean {
  return AGGREGATOR_PLATFORMS.has(providerType.toLowerCase());
}

function adapterIdFor(providerType: string | null, providerScope: string | null, modelAdapter: string): string {
  const siliconflowHost =
    (providerType !== null && providerType.toLowerCase() === 'siliconflow') ||
    (providerScope !== null && providerScope.toLowerCase() === 'siliconflow');
  if (siliconflowHost) {
    const family = modelAdapter.toLowerCase();
    if (family === 'deepseek') return 'deepseek';
    if (family === 'qwen') return 'qwen';
    return 'general';
  }

  const aggregatorHost =
    (providerType !== null && isAggregatorPlatform(providerType)) ||
    (providerScope !== null && isAggregatorPlatform(providerScope));
  if (aggregatorHost) return 'general';

  if (providerScope !== null && !isAggregatorPlatform(providerScope)) {
    const scopeAdapter = ADAPTER_ID_BY_KEY[providerScope.toLowerCase()];
    if (scopeAdapter !== undefined) return scopeAdapter;
  }
  if (providerType !== null && !isAggregatorPlatform(providerType)) {
    const providerAdapter = ADAPTER_ID_BY_KEY[providerType.toLowerCase()];
    if (providerAdapter !== undefined) return providerAdapter;
  }
  return ADAPTER_ID_BY_KEY[modelAdapter.toLowerCase()] ?? 'general';
}

export function requestAdapterIdForConfig(config: ProtocolConfigLike): string {
  const effectiveProtocol = effectiveApiProtocolForConfig(config);
  const usesOpenaiTransport =
    effectiveProtocol === 'openai_chat_completions' || effectiveProtocol === 'openai_responses';
  const nativeAdapterProtocol = nativeProtocolForModelAdapter(config.modelAdapter);
  const usesOpenaiDialect =
    usesOpenaiTransport && (usesGenericOpenaiGateway(config) || nativeAdapterProtocol !== null);
  const usesNativeTransport =
    effectiveProtocol === 'anthropic_messages' || effectiveProtocol === 'google_generate_content';

  if (usesOpenaiDialect) return 'general';
  if (usesNativeTransport) return adapterIdFor(null, null, config.modelAdapter);
  return adapterIdFor(config.providerType, config.providerScope ?? null, config.modelAdapter);
}

export function usesGenericOpenaiGateway(config: ProtocolConfigLike): boolean {
  const hostType = config.providerType ?? config.providerScope ?? null;
  const normalized = normalizeProviderValue(hostType);
  // SiliconFlow 有自有的 OpenAI 兼容 reasoning 方言，由宿主感知适配器处理。
  if (normalized === 'siliconflow') return false;
  const record = getProviderProtocolRecord(hostType);
  return record ? record.official !== true : true;
}

export function providerIsOfficial(providerType: string): boolean {
  return getProviderProtocolRecord(providerType)?.official === true;
}

/** Codex OAuth transport 需要显式 auth_mode（LLMManager::is_openai_codex_oauth）。 */
export function isOpenaiCodexOAuth(config: { authMode?: string | null }): boolean {
  return config.authMode === AUTH_MODE_OPENAI_CODEX_OAUTH;
}
