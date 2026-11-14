// Provider strategies, tool config, environment/DB overrides and host filtering.
import type { SettingsStore } from '../../../platform/settings/api.ts';
import {
  objectOf, urlHost, type CnWhitelistConfig, type ProviderKeys, type ProviderStrategies,
  type ProviderStrategy, type SpecialHandling, type ToolConfig,
} from './web-search-core.ts';

export function defaultProviderStrategy(): ProviderStrategy {
  return {
    timeout_ms: 8000, max_retries: 2, initial_retry_delay_ms: 200, max_retry_delay_ms: 5000,
    backoff_multiplier: 2, max_concurrent_requests: 5, rate_limit_per_minute: 60,
    cache_enabled: true, cache_ttl_seconds: 300, cache_max_entries: 128,
    special_handling: { handle_429_retry_after: true, exponential_backoff_on_5xx: true },
  };
}
export function defaultProviderStrategies(): ProviderStrategies {
  const base = defaultProviderStrategy();
  return {
    default: base,
    bing_rss: { ...base, timeout_ms: 10000, max_retries: 2, max_concurrent_requests: 3, rate_limit_per_minute: 20 },
    google_cse: { ...base, timeout_ms: 6000, max_retries: 2, rate_limit_per_minute: 100 },
    serpapi: { ...base, timeout_ms: 15000, max_retries: 2, rate_limit_per_minute: 20 },
    tavily: { ...base, timeout_ms: 8000, max_retries: 3, rate_limit_per_minute: 50 },
    brave: { ...base, timeout_ms: 12000, max_retries: 2, rate_limit_per_minute: 30 },
    searxng: {
      ...base, timeout_ms: 20000, max_retries: 1, rate_limit_per_minute: 30,
      special_handling: { handle_429_retry_after: false, exponential_backoff_on_5xx: false },
    },
    zhipu: { ...base, timeout_ms: 10000, max_retries: 2, rate_limit_per_minute: 60 },
    bocha: { ...base, timeout_ms: 10000, max_retries: 2, rate_limit_per_minute: 60 },
    deepseek: { ...base, timeout_ms: 10000, max_retries: 2, rate_limit_per_minute: 60 },
  };
}
export function getStrategy(strategies: ProviderStrategies, provider: string): ProviderStrategy {
  const map: Record<string, ProviderStrategy | null | undefined> = {
    bing_rss: strategies.bing_rss, google_cse: strategies.google_cse, serpapi: strategies.serpapi,
    tavily: strategies.tavily, brave: strategies.brave, searxng: strategies.searxng,
    zhipu: strategies.zhipu, bocha: strategies.bocha, deepseek: strategies.deepseek,
  };
  return map[provider] ?? strategies.default;
}
export function calculateRetryDelay(strategy: ProviderStrategy, attempt: number): number {
  const initial = strategy.initial_retry_delay_ms ?? 200;
  const max = strategy.max_retry_delay_ms ?? 5000;
  const multiplier = strategy.backoff_multiplier ?? 2;
  return Math.min(Math.trunc(initial * Math.pow(multiplier, attempt)), max);
}
export function shouldRetry(strategy: ProviderStrategy, attempt: number, statusCode: number | null, errorMessage: string): boolean {
  if (attempt >= (strategy.max_retries ?? 2)) return false;
  if (statusCode !== null) {
    if (statusCode >= 500 && statusCode <= 599) return strategy.special_handling?.exponential_backoff_on_5xx ?? true;
    return statusCode === 429 || statusCode === 408;
  }
  const lower = errorMessage.toLowerCase();
  return lower.includes('timeout') || lower.includes('connection') || lower.includes('network');
}


export function defaultProviderKeys(): ProviderKeys {
  return {
    google_cse: null, google_cse_cx: null, serpapi: null, tavily: null, brave: null,
    searxng_endpoint: null, searxng: null, zhipu: null, bocha: null, deepseek: null,
  };
}
export function hasValidKeys(keys: ProviderKeys, engine: string): boolean {
  switch (engine) {
    case 'bing_rss': return true;
    case 'google_cse': return (keys.google_cse ?? '') !== '' && (keys.google_cse_cx ?? '') !== '';
    case 'serpapi': return (keys.serpapi ?? '') !== '';
    case 'tavily': return (keys.tavily ?? '') !== '';
    case 'brave': return (keys.brave ?? '') !== '';
    case 'searxng': return (keys.searxng_endpoint ?? '') !== '';
    case 'zhipu': return (keys.zhipu ?? '') !== '';
    case 'bocha': return (keys.bocha ?? '') !== '';
    case 'deepseek': return (keys.deepseek ?? '') !== '';
    default: return false;
  }
}

function isNonNegativeInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}
function normalizeStrategy(value: unknown): ProviderStrategy | null {
  if (value === null || value === undefined) return null;
  const obj = objectOf(value);
  if (obj === null) return null;
  const readNumber = (field: string, max = Number.MAX_SAFE_INTEGER): number | null | undefined => {
    const current = obj[field];
    if (current === undefined || current === null) return null;
    return isNonNegativeInteger(current, max) ? current : undefined;
  };
  const timeout = readNumber('timeout_ms');
  const maxRetries = readNumber('max_retries', 4294967295);
  const initialDelay = readNumber('initial_retry_delay_ms');
  const maxDelay = readNumber('max_retry_delay_ms');
  const concurrency = readNumber('max_concurrent_requests', 4294967295);
  const rateLimit = readNumber('rate_limit_per_minute', 4294967295);
  const cacheTtl = readNumber('cache_ttl_seconds');
  const cacheMax = readNumber('cache_max_entries');
  const multiplier = obj.backoff_multiplier;
  const cacheEnabled = obj.cache_enabled;
  const special = obj.special_handling;
  if ([timeout, maxRetries, initialDelay, maxDelay, concurrency, rateLimit, cacheTtl, cacheMax].includes(undefined)) return null;
  if (multiplier !== undefined && multiplier !== null && (typeof multiplier !== 'number' || !Number.isFinite(multiplier))) return null;
  if (cacheEnabled !== undefined && cacheEnabled !== null && typeof cacheEnabled !== 'boolean') return null;
  let specialHandling: SpecialHandling | null = null;
  if (special !== undefined && special !== null) {
    const specialObj = objectOf(special);
    if (specialObj === null || typeof specialObj.handle_429_retry_after !== 'boolean'
      || typeof specialObj.exponential_backoff_on_5xx !== 'boolean') return null;
    specialHandling = {
      handle_429_retry_after: specialObj.handle_429_retry_after,
      exponential_backoff_on_5xx: specialObj.exponential_backoff_on_5xx,
    };
  }
  return {
    timeout_ms: timeout as number | null,
    max_retries: maxRetries as number | null,
    initial_retry_delay_ms: initialDelay as number | null,
    max_retry_delay_ms: maxDelay as number | null,
    backoff_multiplier: (multiplier ?? null) as number | null,
    max_concurrent_requests: concurrency as number | null,
    rate_limit_per_minute: rateLimit as number | null,
    cache_enabled: (cacheEnabled ?? null) as boolean | null,
    cache_ttl_seconds: cacheTtl as number | null,
    cache_max_entries: cacheMax as number | null,
    special_handling: specialHandling,
  };
}
export function normalizeProviderStrategies(value: unknown): ProviderStrategies | null {
  const obj = objectOf(value);
  if (obj === null) return null;
  const defaultStrategy = normalizeStrategy(obj.default);
  if (defaultStrategy === null) return null;
  const strategies: ProviderStrategies = { default: defaultStrategy };
  for (const provider of ['bing_rss', 'google_cse', 'serpapi', 'tavily', 'brave', 'searxng', 'zhipu', 'bocha', 'deepseek'] as const) {
    if (!Object.hasOwn(obj, provider)) { strategies[provider] = null; continue; }
    const strategy = normalizeStrategy(obj[provider]);
    if (strategy === null && obj[provider] !== null) return null;
    strategies[provider] = strategy;
  }
  return strategies;
}
export function parseProviderStrategies(raw: string): ProviderStrategies | null {
  try { return normalizeProviderStrategies(JSON.parse(raw)); }
  catch { return null; }
}
export function serializeProviderStrategies(strategies: ProviderStrategies): string {
  return JSON.stringify(strategies);
}

export function defaultToolConfig(): ToolConfig {
  return {
    default_engine: 'bing_rss', timeout_ms: 15000, timeout_ms_overridden: false,
    retry: { max_attempts: 2, initial_delay_ms: 200 },
    site_whitelist: null, site_blacklist: null,
    inject_snippet_max_chars: 180, inject_total_max_chars: 1900,
    reranker: { enabled: false, model_id: null, top_k: null },
    cn_whitelist: { enabled: false, use_default_list: true, custom_sites: null },
    provider_strategies: defaultProviderStrategies(), provider_strategies_overridden: false,
    tavily_search_depth: 'basic', deepseek_need_content: null,
    keys: defaultProviderKeys(),
  };
}
export const CN_TRUSTED_SITES: readonly string[] = [
  'edu.cn', 'tsinghua.edu.cn', 'pku.edu.cn', 'fudan.edu.cn', 'sjtu.edu.cn', 'zju.edu.cn', 'nju.edu.cn',
  'ustc.edu.cn', 'bit.edu.cn', 'buaa.edu.cn', 'gov.cn', 'beijing.gov.cn', 'shanghai.gov.cn',
  'guangzhou.gov.cn', 'shenzhen.gov.cn', 'xinhuanet.com', 'people.com.cn', 'cctv.com', 'chinanews.com.cn',
  'ce.cn', 'runoob.com', 'w3school.com.cn', 'liaoxuefeng.com', 'cnblogs.com', 'csdn.net', 'jianshu.com',
  'segmentfault.com', 'juejin.cn', 'zhihu.com', 'oschina.net', 'github.com', 'gitee.com', 'coding.net',
  'cas.cn', 'cass.cn', 'cnki.net', 'wanfangdata.com.cn', 'baidu.com', 'tencent.com', 'alibaba.com',
  'huawei.com', 'xiaomi.com', 'bytedance.com', 'infoq.cn', '51cto.com', 'iteye.com', 'ibiblio.org',
  'apache.org', 'python.org', 'nodejs.org', 'mysql.com', 'postgresql.org',
];
export function mergedWhitelist(config: CnWhitelistConfig): string[] {
  const list: string[] = config.use_default_list ? [...CN_TRUSTED_SITES] : [];
  if (config.custom_sites !== null) list.push(...config.custom_sites);
  list.sort();
  return list.filter((site, index) => index === 0 || site !== list[index - 1]);
}
export function isHostWhitelisted(config: CnWhitelistConfig, host: string): boolean {
  if (!config.enabled) return true;
  const lower = host.toLowerCase();
  return mergedWhitelist(config).some(domain => lower.endsWith(domain.toLowerCase()));
}
export function isUrlWhitelisted(config: CnWhitelistConfig, url: string): boolean {
  if (!config.enabled) return true;
  const host = urlHost(url);
  return host !== null && isHostWhitelisted(config, host);
}

function parseRustU64(value: string): number | null {
  if (!/^\+?[0-9]+$/.test(value)) return null;
  try {
    const n = BigInt(value);
    return n <= 18446744073709551615n ? Number(n) : null;
  } catch { return null; }
}
function parseRustUsize(value: string): number | null { return parseRustU64(value); }
function parseRustBool(value: string): boolean | null {
  return value === 'true' ? true : value === 'false' ? false : null;
}

export interface DbOverrideSources {
  getSetting(key: string): string | null;
  getSecret(key: string): string | null;
}
export function applyDbOverrides(
  config: ToolConfig, source: DbOverrideSources,
  log: (message: string) => void = () => undefined,
): void {
  const setting = (key: string): string | null => { try { return source.getSetting(key); } catch { return null; } };
  const secret = (key: string): string | null => { try { return source.getSecret(key); } catch { return null; } };

  const engine = setting('web_search.engine');
  if (engine !== null && engine.trim() !== '') config.default_engine = engine;
  const timeout = setting('web_search.timeout_ms');
  if (timeout !== null) {
    const ms = parseRustU64(timeout);
    if (ms !== null) { config.timeout_ms = ms; config.timeout_ms_overridden = true; }
  }

  const keys: [string, keyof ProviderKeys][] = [
    ['web_search.api_key.google_cse', 'google_cse'], ['web_search.google_cse.cx', 'google_cse_cx'],
    ['web_search.api_key.serpapi', 'serpapi'], ['web_search.api_key.tavily', 'tavily'],
    ['web_search.api_key.brave', 'brave'], ['web_search.searxng.endpoint', 'searxng_endpoint'],
    ['web_search.searxng.api_key', 'searxng'], ['web_search.api_key.zhipu', 'zhipu'],
    ['web_search.api_key.bocha', 'bocha'], ['web_search.api_key.deepseek', 'deepseek'],
  ];
  for (const [key, field] of keys) {
    const value = secret(key);
    if (value !== null && value !== '') config.keys[field] = value;
  }
  const needContent = setting('web_search.deepseek.need_content');
  if (needContent !== null) config.deepseek_need_content = needContent.trim().toLowerCase() === 'true';

  for (const [key, field] of [['web_search.site_whitelist', 'site_whitelist'], ['web_search.site_blacklist', 'site_blacklist']] as const) {
    const value = setting(key);
    if (value !== null) {
      const list = value.split(',').map(item => item.trim()).filter(item => item !== '');
      if (list.length) config[field] = list;
    }
  }

  const strategies = setting('web_search.provider_strategies');
  if (strategies !== null && strategies.trim() !== '') {
    const parsed = parseProviderStrategies(strategies);
    if (parsed !== null) {
      config.provider_strategies = parsed;
      config.provider_strategies_overridden = true;
    } else {
      log('解析 web_search.provider_strategies 失败，忽略该覆盖');
    }
  }

  const depth = setting('web_search.tavily.search_depth');
  if (depth !== null && depth.trim() !== '') config.tavily_search_depth = depth;

  for (const [key, field] of [['web_search.inject.snippet_max_chars', 'inject_snippet_max_chars'], ['web_search.inject.total_max_chars', 'inject_total_max_chars']] as const) {
    const value = setting(key);
    if (value !== null) {
      const n = parseRustUsize(value);
      if (n !== null) config[field] = n;
    }
  }

  config.reranker ??= { enabled: false, model_id: null, top_k: null };
  const rerankEnabled = setting('web_search.reranker.enabled');
  if (rerankEnabled !== null) {
    const parsed = parseRustBool(rerankEnabled);
    if (parsed !== null) config.reranker.enabled = parsed;
  }
  const rerankModel = setting('web_search.reranker.model_id');
  if (rerankModel !== null && rerankModel.trim() !== '') config.reranker.model_id = rerankModel;
  const rerankTopK = setting('web_search.reranker.top_k');
  if (rerankTopK !== null) {
    const parsed = parseRustUsize(rerankTopK);
    if (parsed !== null) config.reranker.top_k = parsed;
  }

  config.cn_whitelist ??= { enabled: false, use_default_list: true, custom_sites: null };
  const cnEnabled = setting('web_search.cn_whitelist.enabled');
  if (cnEnabled !== null) {
    const parsed = parseRustBool(cnEnabled);
    if (parsed !== null) config.cn_whitelist.enabled = parsed;
  }
  const cnDefault = setting('web_search.cn_whitelist.use_default');
  if (cnDefault !== null) {
    const parsed = parseRustBool(cnDefault);
    if (parsed !== null) config.cn_whitelist.use_default_list = parsed;
  }
  const cnCustom = setting('web_search.cn_whitelist.custom_sites');
  if (cnCustom !== null && cnCustom.trim() !== '') {
    let list: string[];
    try {
      const parsed: unknown = JSON.parse(cnCustom);
      if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) throw new Error('not a string array');
      list = parsed;
    } catch {
      list = cnCustom.split(',').map(item => item.trim()).filter(item => item !== '');
    }
    if (list.length) config.cn_whitelist.custom_sites = list;
  }
}

const ENV_KEYS: [keyof ProviderKeys, string][] = [
  ['google_cse', 'GOOGLE_API_KEY'], ['google_cse_cx', 'GOOGLE_CSE_CX'], ['serpapi', 'SERPAPI_KEY'],
  ['tavily', 'TAVILY_API_KEY'], ['brave', 'BRAVE_API_KEY'], ['searxng_endpoint', 'SEARXNG_ENDPOINT'],
  ['searxng', 'SEARXNG_API_KEY'], ['zhipu', 'ZHIPU_API_KEY'], ['bocha', 'BOCHA_API_KEY'],
  ['deepseek', 'DEEPSEEK_SEARCH_API_KEY'],
];
export function toolConfigFromEnv(): ToolConfig {
  const config = defaultToolConfig();
  for (const [field, name] of ENV_KEYS) {
    const value = process.env[name];
    if (config.keys[field] === null && value !== undefined) config.keys[field] = value;
  }
  return config;
}
export async function loadToolConfig(
  settings: SettingsStore,
  log: (message: string) => void = () => undefined,
): Promise<ToolConfig> {
  const config = toolConfigFromEnv();
  const secrets = new Map<string, string | null>();
  for (const [key] of ENV_KEYS) {
    const settingKey = key === 'google_cse_cx' ? 'web_search.google_cse.cx'
      : key === 'searxng_endpoint' ? 'web_search.searxng.endpoint'
        : key === 'searxng' ? 'web_search.searxng.api_key' : `web_search.api_key.${key}`;
    try { secrets.set(settingKey, await settings.getSecret(settingKey)); }
    catch { secrets.set(settingKey, null); }
  }
  applyDbOverrides(config, {
    getSetting: key => { try { return settings.get(key); } catch { return null; } },
    getSecret: key => secrets.get(key) ?? null,
  }, log);
  if (!config.keys.deepseek) {
    try { config.keys.deepseek = (await settings.getSecret('builtin-deepseek.api_key'))?.trim() || null; }
    catch { /* boundary-allow empty-catch: The standalone Search key remains independently configurable. */ }
  }
  return config;
}


export function hostAllowed(config: ToolConfig, url: string): boolean {
  const bare = urlHost(url);
  if (bare === null) return true;
  const host = bare.toLowerCase();
  if (config.site_blacklist !== null && config.site_blacklist.some(item => host.endsWith(item.toLowerCase()))) return false;
  if (config.cn_whitelist !== null && config.cn_whitelist.enabled && !isHostWhitelisted(config.cn_whitelist, host)) return false;
  if (config.site_whitelist !== null) return config.site_whitelist.some(item => host.endsWith(item.toLowerCase()));
  return true;
}

