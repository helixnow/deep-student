/**
 * 外部 AI 工具（Magpie / CC Switch / OpenCode / Claude Code / Codex / 深链 / SQL 备份 / .env）
 * 纯函数解析与归一化层（零 Node 依赖，桌面端与移动端均可安全加载）。
 *
 * 设计约束：
 * - 不支持本地网关桥接模式：自动识别并过滤 Magpie (`127.0.0.1:3425`) 与 CC Switch (`127.0.0.1:15721`)
 *   等本地回环接管地址及占位密钥（`magpie`、`PROXY_MANAGED` 等），仅提取真实上游供应商配置。
 */
import { BUILTIN_VENDORS } from './data/builtin_catalog.ts';
import {
  baseUrlHost,
  providerAllowedProtocols,
  providerSupportsOpenaiResponses,
  resolvePreferredProtocolForProvider,
} from './protocol.ts';

export type ExternalSourceTag =
  | 'magpie'
  | 'cc-switch'
  | 'opencode'
  | 'claude-code'
  | 'codex'
  | 'paste'
  | 'custom-file';

export interface ParsedExternalModel {
  id: string;
  label: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
}

export interface ParsedExternalVendor {
  externalKey: string;
  name: string;
  providerType: string;
  apiProtocol: 'openai_chat_completions' | 'openai_responses' | 'anthropic_messages' | 'google_generate_content';
  supportsOpenaiResponses: boolean;
  baseUrl: string;
  websiteUrl: string | null;
  apiKey: string;
  extraApiKeys: string[];
  headers: Record<string, string>;
  sources: ExternalSourceTag[];
  appTypes: string[];
  models: ParsedExternalModel[];
  matchedBuiltinVendorId: string | null;
}

export interface RawExternalInputSource {
  readonly source: ExternalSourceTag;
  readonly kind: 'json' | 'toml' | 'sql' | 'sqlite-rows' | 'env' | 'auto';
  readonly pathLabel: string;
  readonly text: string | null;
  readonly companionText?: string | null;
  readonly sqliteTables?: {
    readonly providers: readonly Record<string, unknown>[];
    readonly universalProviders: readonly Record<string, unknown>[];
  } | null;
  readonly error?: string | null;
}

export interface ExternalParseSummary {
  candidates: ParsedExternalVendor[];
  sourceStats: Array<{
    source: string;
    pathLabel: string;
    candidateCount: number;
    error: string | null;
  }>;
  skippedProxyCount: number;
  skippedNoKeyCount: number;
}

const KNOWN_PROXY_PORTS = new Set(['3425', '15721']);
const PLACEHOLDER_API_KEYS = new Set([
  '',
  'magpie',
  'proxy_managed',
  'cc-switch',
  'ccswitch',
  'cc_switch',
  'placeholder',
  'your-api-key',
  'your_api_key',
  'sk-xxx',
  'sk-xxxx',
  'none',
  'null',
  'undefined',
]);

const KNOWN_OPENCODE_DEFAULT_ENDPOINTS: Readonly<
  Record<string, { name: string; baseUrl: string; protocol: ParsedExternalVendor['apiProtocol'] }>
> = {
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', protocol: 'openai_responses' },
  siliconflow: { name: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', protocol: 'openai_chat_completions' },
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', protocol: 'openai_responses' },
  anthropic: { name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', protocol: 'anthropic_messages' },
  google: { name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com', protocol: 'google_generate_content' },
  gemini: { name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com', protocol: 'google_generate_content' },
  openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai_chat_completions' },
  moonshot: { name: 'Moonshot AI', baseUrl: 'https://api.moonshot.cn/v1', protocol: 'openai_chat_completions' },
  kimi: { name: 'Moonshot AI', baseUrl: 'https://api.moonshot.cn/v1', protocol: 'openai_chat_completions' },
  zhipu: { name: 'Zhipu AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'openai_chat_completions' },
  zai: { name: 'Zhipu AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'openai_chat_completions' },
  qwen: { name: 'Alibaba Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'openai_chat_completions' },
  dashscope: { name: 'Alibaba Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'openai_chat_completions' },
  xai: { name: 'xAI', baseUrl: 'https://api.x.ai/v1', protocol: 'openai_responses' },
  grok: { name: 'xAI', baseUrl: 'https://api.x.ai/v1', protocol: 'openai_responses' },
  mistral: { name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', protocol: 'openai_responses' },
  minimax: { name: 'MiniMax', baseUrl: 'https://api.minimax.io/v1', protocol: 'openai_chat_completions' },
  doubao: { name: 'ByteDance Doubao', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', protocol: 'openai_chat_completions' },
  nvidia: { name: 'NVIDIA', baseUrl: 'https://integrate.api.nvidia.com/v1', protocol: 'openai_chat_completions' },
  groq: { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', protocol: 'openai_chat_completions' },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveU32(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 0xffff_ffff) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const num = Number(trimmed);
      if (Number.isSafeInteger(num) && num > 0 && num <= 0xffff_ffff) return num;
    }
  }
  return null;
}

export function maskExternalApiKey(rawKey: string): string {
  const trimmed = rawKey.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}••••`;
  const prefixLen = trimmed.startsWith('sk-ant-') ? 7 : trimmed.startsWith('sk-') ? 5 : 4;
  return `${trimmed.slice(0, prefixLen)}••••${trimmed.slice(-4)}`;
}

function sanitizeKeyValue(raw: string): string {
  return raw
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .trim()
    .replace(/^Bearer\s+/i, '')
    .trim();
}

function isPlaceholderKey(key: string): boolean {
  const cleaned = sanitizeKeyValue(key);
  if (!cleaned) return true;
  if ([...cleaned].every((ch) => ch === '*' || ch === '•')) return true;
  if (cleaned.startsWith('${') || cleaned.startsWith('$ENV') || cleaned.startsWith('{env:')) return true;
  return PLACEHOLDER_API_KEYS.has(cleaned.toLowerCase());
}

function isLoopbackGatewayProxyUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
    const host = parsed.hostname.toLowerCase();
    const isLoopback =
      host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]' || host === '0.0.0.0';
    if (!isLoopback) return false;
    if (KNOWN_PROXY_PORTS.has(parsed.port)) return true;
    const lowerPath = parsed.pathname.toLowerCase();
    return lowerPath.includes('/magpie') || lowerPath.includes('/cc-switch');
  } catch {
    return false;
  }
}

export function stripJsonComments(input: string): string {
  let out = '';
  let inString = false;
  let stringQuote = '"';
  let escaped = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    const next = input[i + 1];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === stringQuote) {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      stringQuote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  // 移除对象/数组末尾多余逗号
  return out.replace(/,\s*([}\]])/g, '$1');
}

function parseJsonLenient(text: string): unknown {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return JSON.parse(stripJsonComments(trimmed));
  }
}

function normalizeEndpointUrl(
  rawUrl: string,
  protocol: ParsedExternalVendor['apiProtocol'],
): string {
  const firstSegment = rawUrl.split(',')[0]?.trim() ?? '';
  if (!firstSegment) {
    if (protocol === 'anthropic_messages') return 'https://api.anthropic.com/v1';
    if (protocol === 'google_generate_content') return 'https://generativelanguage.googleapis.com';
    return '';
  }
  const withScheme = firstSegment.includes('://') ? firstSegment : `https://${firstSegment}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  let pathname = parsed.pathname.replace(/\/+$/, '');
  if (protocol === 'anthropic_messages') {
    pathname = pathname.replace(/\/v1\/messages$/i, '/v1').replace(/\/messages$/i, '');
  } else if (protocol === 'google_generate_content') {
    pathname = pathname.replace(/\/v1beta\/models$/i, '').replace(/\/models$/i, '');
  } else {
    pathname = pathname
      .replace(/\/chat\/completions$/i, '')
      .replace(/\/responses$/i, '')
      .replace(/\/embeddings$/i, '')
      .replace(/\/models$/i, '');
  }
  parsed.pathname = pathname;
  parsed.search = '';
  parsed.hash = '';
  return parsed.href.replace(/\/+$/, '');
}

function inferProviderAndBuiltin(
  baseUrl: string,
  protocol: ParsedExternalVendor['apiProtocol'],
): { providerType: string; matchedBuiltinVendorId: string | null; displayNameFallback: string } {
  const host = baseUrlHost(baseUrl);
  const lowerUrl = baseUrl.toLowerCase();

  for (const builtin of BUILTIN_VENDORS) {
    if (builtin.authMode === 'openai_codex_oauth' || builtin.providerType === 'opencode_go') {
      continue;
    }
    const builtinHost = baseUrlHost(builtin.baseUrl);
    if (!builtinHost || builtinHost !== host) continue;
    const allowed = providerAllowedProtocols(builtin.providerType);
    if (!allowed.includes(protocol)) continue;
    // 防止把 `https://open.bigmodel.cn/api/anthropic` 误配到仅支持 `/api/paas/v4` 的内置项
    if (protocol !== 'anthropic_messages' && lowerUrl.includes('/anthropic')) continue;
    return {
      providerType: builtin.providerType,
      matchedBuiltinVendorId: builtin.id,
      displayNameFallback: builtin.name,
    };
  }

  if (protocol === 'anthropic_messages') {
    const anthropicBrandByHost: Readonly<Record<string, string>> = {
      'api.anthropic.com': 'Anthropic',
      'api.deepseek.com': 'DeepSeek (Anthropic)',
      'open.bigmodel.cn': 'Zhipu AI (Anthropic)',
      'api.z.ai': 'Zhipu AI (Anthropic)',
      'api.moonshot.cn': 'Moonshot AI (Anthropic)',
      'api.moonshot.ai': 'Moonshot AI (Anthropic)',
      'api.minimax.io': 'MiniMax (Anthropic)',
      'api.minimaxi.com': 'MiniMax (Anthropic)',
      'dashscope.aliyuncs.com': 'Alibaba Qwen (Anthropic)',
    };
    return {
      providerType: 'anthropic',
      matchedBuiltinVendorId: host === 'api.anthropic.com' ? 'builtin-anthropic' : null,
      displayNameFallback: anthropicBrandByHost[host] ?? (host || 'Anthropic Relay'),
    };
  }
  if (protocol === 'google_generate_content') {
    return {
      providerType: 'google',
      matchedBuiltinVendorId: null,
      displayNameFallback: host === 'generativelanguage.googleapis.com' ? 'Google Gemini' : host || 'Gemini Relay',
    };
  }
  if (host === 'openrouter.ai') {
    return { providerType: 'openrouter', matchedBuiltinVendorId: null, displayNameFallback: 'OpenRouter' };
  }
  if (host === 'api.x.ai') {
    return { providerType: 'grok', matchedBuiltinVendorId: null, displayNameFallback: 'xAI' };
  }
  if (host === 'qianfan.baidubce.com') {
    return { providerType: 'ernie', matchedBuiltinVendorId: null, displayNameFallback: 'Baidu ERNIE' };
  }
  if (host === '127.0.0.1' || host === 'localhost') {
    try {
      if (new URL(baseUrl).port === '11434') {
        return { providerType: 'ollama', matchedBuiltinVendorId: null, displayNameFallback: 'Ollama' };
      }
    } catch (err) {
      void err;
    }
  }
  return {
    providerType: 'custom',
    matchedBuiltinVendorId: null,
    displayNameFallback: host || 'Custom Provider',
  };
}

interface RawCandidateDraft {
  source: ExternalSourceTag;
  appType: string;
  externalId: string;
  name: string;
  protocol: ParsedExternalVendor['apiProtocol'];
  rawUrl: string;
  websiteUrl: string | null;
  keys: string[];
  headers: Record<string, string>;
  models: ParsedExternalModel[];
}

function modelFromUnknown(entry: unknown): ParsedExternalModel | null {
  if (typeof entry === 'string') {
    const id = entry.trim();
    return id ? { id, label: id, contextWindow: null, maxOutputTokens: null } : null;
  }
  if (!isRecord(entry)) return null;
  const id = asTrimmedString(entry.id ?? entry.model ?? entry.name);
  if (!id) return null;
  const label = asTrimmedString(entry.label ?? entry.displayName ?? entry.display_name ?? entry.name) || id;
  const limit = isRecord(entry.limit) ? entry.limit : null;
  const contextWindow =
    positiveU32(entry.contextWindow ?? entry.context_window ?? entry.context_length ?? limit?.context) ?? null;
  const maxOutputTokens =
    positiveU32(entry.maxOutputTokens ?? entry.max_output_tokens ?? entry.max_tokens ?? limit?.output) ?? null;
  return { id, label, contextWindow, maxOutputTokens };
}

function collectDistinctModels(items: readonly (ParsedExternalModel | string | null | undefined)[]): ParsedExternalModel[] {
  const byId = new Map<string, ParsedExternalModel>();
  for (const raw of items) {
    if (!raw) continue;
    const item = typeof raw === 'string' ? modelFromUnknown(raw) : raw;
    if (!item) continue;
    const key = item.id.trim().toLowerCase();
    if (!key) continue;
    const prev = byId.get(key);
    if (!prev) {
      byId.set(key, { ...item, id: item.id.trim(), label: item.label.trim() || item.id.trim() });
    } else {
      byId.set(key, {
        id: prev.id,
        label: prev.label === prev.id && item.label !== item.id ? item.label : prev.label,
        contextWindow: prev.contextWindow ?? item.contextWindow,
        maxOutputTokens: prev.maxOutputTokens ?? item.maxOutputTokens,
      });
    }
  }
  return [...byId.values()];
}

function extractHeadersRecord(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const name = k.trim();
    if (!name || typeof v !== 'string') continue;
    const val = v.trim();
    if (val) result[name] = val;
  }
  return result;
}

// ------------------------------------------------------------------ 轻量 Codex TOML 解析

interface ParsedCodexToml {
  model: string;
  modelProvider: string;
  baseUrl: string;
  wireApi: string;
  providers: Record<
    string,
    {
      name: string;
      baseUrl: string;
      wireApi: string;
      headers: Record<string, string>;
    }
  >;
}

function stripTomlInlineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inDouble) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === '#') return line.slice(0, i).trim();
  }
  return line.trim();
}

function unquoteTomlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    const inner = trimmed.slice(1, -1);
    return trimmed.startsWith('"')
      ? inner.replace(/\\(["\\ntr])/g, (_, esc: string) => {
          if (esc === 'n') return '\n';
          if (esc === 't') return '\t';
          if (esc === 'r') return '\r';
          return esc;
        })
      : inner;
  }
  return trimmed;
}

function parseTomlInlineTable(raw: string): Record<string, string> {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return {};
  const body = trimmed.slice(1, -1).trim();
  if (!body) return {};
  const result: Record<string, string> = {};
  for (const part of body.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = unquoteTomlScalar(part.slice(0, eq));
    const val = unquoteTomlScalar(part.slice(eq + 1));
    if (key && val) result[key] = val;
  }
  return result;
}

export function parseCodexToml(tomlText: string): ParsedCodexToml {
  const out: ParsedCodexToml = {
    model: '',
    modelProvider: '',
    baseUrl: '',
    wireApi: '',
    providers: {},
  };
  let currentSection = '';
  for (const rawLine of tomlText.split(/\r?\n/)) {
    const line = stripTomlInlineComment(rawLine);
    if (!line) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      currentSection = line.slice(1, -1).trim();
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const rawKey = unquoteTomlScalar(line.slice(0, eqIdx));
    const rawVal = line.slice(eqIdx + 1).trim();
    const scalar = unquoteTomlScalar(rawVal);

    if (currentSection === '') {
      if (rawKey === 'model') out.model = scalar;
      else if (rawKey === 'model_provider') out.modelProvider = scalar;
      else if (rawKey === 'openai_base_url' || rawKey === 'base_url') out.baseUrl = scalar;
      else if (rawKey === 'wire_api') out.wireApi = scalar;
      continue;
    }

    const providerMatch = /^model_providers\.([^.]+)(?:\.(.+))?$/.exec(currentSection);
    if (providerMatch) {
      const providerKey = unquoteTomlScalar(providerMatch[1]!);
      const subSection = providerMatch[2]?.trim() ?? '';
      const entry =
        out.providers[providerKey] ??
        (out.providers[providerKey] = { name: providerKey, baseUrl: '', wireApi: '', headers: {} });
      if (subSection === 'http_headers') {
        if (rawKey && scalar) entry.headers[rawKey] = scalar;
      } else if (!subSection) {
        if (rawKey === 'name') entry.name = scalar;
        else if (rawKey === 'base_url') entry.baseUrl = scalar;
        else if (rawKey === 'wire_api') entry.wireApi = scalar;
        else if (rawKey === 'http_headers') {
          Object.assign(entry.headers, parseTomlInlineTable(rawVal));
        }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ Magpie 解析

function parseMagpieDrafts(text: string, companionText?: string | null): RawCandidateDraft[] {
  const drafts: RawCandidateDraft[] = [];
  const companionModelsByProvider = new Map<string, ParsedExternalModel[]>();

  if (companionText && companionText.trim()) {
    try {
      const companion = parseJsonLenient(companionText);
      if (isRecord(companion)) {
        for (const [key, value] of Object.entries(companion)) {
          const list = Array.isArray(value)
            ? value
            : isRecord(value) && Array.isArray(value.models)
              ? value.models
              : [];
          const parsedModels = collectDistinctModels(list.map(modelFromUnknown));
          if (parsedModels.length > 0) {
            companionModelsByProvider.set(key.trim().toLowerCase(), parsedModels);
          }
        }
      }
    } catch (err) {
      void err;
    }
  }

  const root = parseJsonLenient(text);
  const rawItems: Array<{ idHint: string; record: Record<string, unknown> }> = [];
  if (Array.isArray(root)) {
    for (const item of root) {
      if (isRecord(item)) rawItems.push({ idHint: asTrimmedString(item.id), record: item });
    }
  } else if (isRecord(root)) {
    if (Array.isArray(root.providers)) {
      for (const item of root.providers) {
        if (isRecord(item)) rawItems.push({ idHint: asTrimmedString(item.id), record: item });
      }
    } else if (isRecord(root.providers)) {
      for (const [id, item] of Object.entries(root.providers)) {
        if (isRecord(item)) rawItems.push({ idHint: id, record: item });
      }
    } else if (
      typeof root.key === 'string' ||
      typeof root.apiKey === 'string' ||
      typeof root.api_key === 'string' ||
      typeof root.chat === 'string' ||
      typeof root.baseUrl === 'string' ||
      typeof root.base_url === 'string' ||
      typeof root.anthropic === 'string'
    ) {
      rawItems.push({ idHint: asTrimmedString(root.id), record: root });
    } else {
      for (const [id, item] of Object.entries(root)) {
        if (isRecord(item)) rawItems.push({ idHint: id, record: item });
      }
    }
  }

  for (const { idHint, record } of rawItems) {
    const id = asTrimmedString(record.id) || idHint || 'magpie-provider';
    const name = asTrimmedString(record.name ?? record.label ?? record.title) || id;
    const keys: string[] = [];
    for (const kField of [record.key, record.apiKey, record.api_key, record.token]) {
      const k = asTrimmedString(kField);
      if (k) keys.push(k);
    }
    if (Array.isArray(record.keys)) {
      for (const item of record.keys) {
        const k = asTrimmedString(item);
        if (k) keys.push(k);
      }
    }
    if (Array.isArray(record.accounts)) {
      for (const acc of record.accounts) {
        if (!isRecord(acc)) continue;
        for (const kField of [acc.key, acc.apiKey, acc.api_key, acc.token]) {
          const k = asTrimmedString(kField);
          if (k) keys.push(k);
        }
      }
    }

    const rawModels = Array.isArray(record.models)
      ? record.models.map(modelFromUnknown)
      : isRecord(record.models)
        ? Object.entries(record.models).map(([mId, mVal]) =>
            isRecord(mVal) ? modelFromUnknown({ id: mId, ...mVal }) : modelFromUnknown(mId),
          )
        : [];
    const companionModels = companionModelsByProvider.get(id.toLowerCase()) ?? [];
    const models = collectDistinctModels([...rawModels, ...companionModels]);
    const headers = extractHeadersRecord(record.headers);
    const websiteUrl = asTrimmedString(record.websiteUrl ?? record.website_url ?? record.homepage) || null;

    const baseApi = asTrimmedString(record.baseAPI ?? record.api ?? record.protocol ?? record.type).toLowerCase();
    const chatUrl = asTrimmedString(
      record.chat ?? record.base ?? record.baseURL ?? record.baseUrl ?? record.base_url ?? record.api_base ?? record.endpoint ?? record.url,
    );
    const anthropicUrl = asTrimmedString(record.anthropic ?? record.anthropicURL ?? record.anthropicUrl);
    const geminiUrl = asTrimmedString(record.gemini ?? record.geminiUrl);

    const knownDefault = KNOWN_OPENCODE_DEFAULT_ENDPOINTS[id.toLowerCase()];

    if (baseApi.includes('gemini') || baseApi.includes('google') || (geminiUrl && !chatUrl && !anthropicUrl)) {
      drafts.push({
        source: 'magpie',
        appType: 'gemini',
        externalId: id,
        name: name === id && knownDefault ? knownDefault.name : name,
        protocol: 'google_generate_content',
        rawUrl: geminiUrl || chatUrl || knownDefault?.baseUrl || 'https://generativelanguage.googleapis.com',
        websiteUrl,
        keys,
        headers,
        models,
      });
      continue;
    }

    if (baseApi.includes('anthropic') || (anthropicUrl && !chatUrl)) {
      drafts.push({
        source: 'magpie',
        appType: 'claude',
        externalId: id,
        name: name === id && knownDefault ? knownDefault.name : name,
        protocol: 'anthropic_messages',
        rawUrl: anthropicUrl || chatUrl || 'https://api.anthropic.com/v1',
        websiteUrl,
        keys,
        headers,
        models,
      });
      continue;
    }

    const effectiveOpenAiUrl = chatUrl || knownDefault?.baseUrl || '';
    const openAiProtocol: ParsedExternalVendor['apiProtocol'] =
      baseApi.includes('response') || knownDefault?.protocol === 'openai_responses'
        ? 'openai_responses'
        : 'openai_chat_completions';

    if (effectiveOpenAiUrl || keys.length > 0) {
      drafts.push({
        source: 'magpie',
        appType: 'openai',
        externalId: id,
        name: name === id && knownDefault ? knownDefault.name : name,
        protocol: knownDefault && !chatUrl ? knownDefault.protocol : openAiProtocol,
        rawUrl: effectiveOpenAiUrl,
        websiteUrl,
        keys,
        headers,
        models,
      });
    }
  }

  return drafts;
}

// ------------------------------------------------------------------ CC Switch 解析

function extractModelsFromMeta(meta: unknown): ParsedExternalModel[] {
  if (!isRecord(meta)) return [];
  const items: Array<ParsedExternalModel | null> = [];
  for (const key of ['models', 'custom_models', 'customModels', 'modelList']) {
    const val = meta[key];
    if (Array.isArray(val)) {
      for (const m of val) items.push(modelFromUnknown(m));
    } else if (isRecord(val)) {
      for (const [mId, mObj] of Object.entries(val)) {
        items.push(isRecord(mObj) ? modelFromUnknown({ id: mId, ...mObj }) : modelFromUnknown(mId));
      }
    }
  }
  return collectDistinctModels(items);
}

function parseCcSwitchProviderRecord(
  row: Record<string, unknown>,
  sourceTag: ExternalSourceTag = 'cc-switch',
): RawCandidateDraft[] {
  const id = asTrimmedString(row.id) || 'cc-provider';
  const appType = asTrimmedString(row.app_type ?? row.appType ?? row.app).toLowerCase() || 'claude';
  const name = asTrimmedString(row.name) || id;
  const websiteUrl = asTrimmedString(row.website_url ?? row.websiteUrl ?? row.homepage) || null;

  let settings: unknown = row.settings_config ?? row.settingsConfig ?? row.config;
  if (typeof settings === 'string' && settings.trim()) {
    try {
      settings = parseJsonLenient(settings);
    } catch {
      // 若本身是 TOML 文本，包装成 codex 结构处理
      settings = { config: settings };
    }
  }
  let meta: unknown = row.meta;
  if (typeof meta === 'string' && meta.trim()) {
    try {
      meta = parseJsonLenient(meta);
    } catch {
      meta = null;
    }
  }
  const metaModels = extractModelsFromMeta(meta);
  if (!isRecord(settings)) return [];

  if (appType === 'claude') {
    const env = isRecord(settings.env) ? settings.env : settings;
    const rawKey =
      asTrimmedString(env.ANTHROPIC_AUTH_TOKEN) ||
      asTrimmedString(env.ANTHROPIC_API_KEY) ||
      asTrimmedString(settings.apiKey ?? settings.api_key);
    const rawUrl =
      asTrimmedString(env.ANTHROPIC_BASE_URL) ||
      asTrimmedString(settings.baseUrl ?? settings.base_url) ||
      (rawKey.startsWith('sk-ant-') ? 'https://api.anthropic.com/v1' : '');
    const explicitModels = collectDistinctModels([
      asTrimmedString(env.ANTHROPIC_MODEL),
      asTrimmedString(env.ANTHROPIC_DEFAULT_SONNET_MODEL),
      asTrimmedString(env.ANTHROPIC_DEFAULT_OPUS_MODEL),
      asTrimmedString(env.ANTHROPIC_DEFAULT_HAIKU_MODEL),
      asTrimmedString(env.ANTHROPIC_SMALL_FAST_MODEL),
      ...metaModels,
    ]);
    return [
      {
        source: sourceTag,
        appType: 'claude',
        externalId: `${id}:claude`,
        name,
        protocol: 'anthropic_messages',
        rawUrl,
        websiteUrl,
        keys: rawKey ? rawKey.split(',').map((s) => s.trim()).filter(Boolean) : [],
        headers: extractHeadersRecord(settings.headers),
        models: explicitModels,
      },
    ];
  }

  if (appType === 'codex') {
    const authObj = isRecord(settings.auth) ? settings.auth : {};
    const envObj = isRecord(settings.env) ? settings.env : {};
    const rawKey =
      asTrimmedString(authObj.OPENAI_API_KEY) ||
      asTrimmedString(envObj.OPENAI_API_KEY) ||
      asTrimmedString(settings.apiKey ?? settings.api_key);
    const configToml = typeof settings.config === 'string' ? parseCodexToml(settings.config) : null;
    const selectedProvider =
      configToml && configToml.modelProvider
        ? configToml.providers[configToml.modelProvider]
        : configToml
          ? Object.values(configToml.providers)[0]
          : undefined;
    const rawUrl =
      selectedProvider?.baseUrl ||
      configToml?.baseUrl ||
      asTrimmedString(settings.baseUrl ?? settings.base_url ?? envObj.OPENAI_BASE_URL) ||
      (rawKey ? 'https://api.openai.com/v1' : '');
    const wireApi = (selectedProvider?.wireApi || configToml?.wireApi || '').toLowerCase();
    const protocol: ParsedExternalVendor['apiProtocol'] =
      wireApi === 'chat' || wireApi === 'chat_completions' ? 'openai_chat_completions' : 'openai_responses';
    const models = collectDistinctModels([configToml?.model, ...metaModels]);
    return [
      {
        source: sourceTag,
        appType: 'codex',
        externalId: `${id}:codex`,
        name: name || selectedProvider?.name || id,
        protocol,
        rawUrl,
        websiteUrl,
        keys: rawKey ? rawKey.split(',').map((s) => s.trim()).filter(Boolean) : [],
        headers: { ...extractHeadersRecord(settings.headers), ...(selectedProvider?.headers ?? {}) },
        models,
      },
    ];
  }

  if (appType === 'gemini') {
    const env = isRecord(settings.env) ? settings.env : settings;
    const rawKey =
      asTrimmedString(env.GEMINI_API_KEY) ||
      asTrimmedString(env.GOOGLE_API_KEY) ||
      asTrimmedString(settings.apiKey ?? settings.api_key);
    const rawUrl =
      asTrimmedString(env.GOOGLE_GEMINI_BASE_URL) ||
      asTrimmedString(env.GEMINI_BASE_URL) ||
      asTrimmedString(settings.baseUrl ?? settings.base_url) ||
      'https://generativelanguage.googleapis.com';
    const models = collectDistinctModels([asTrimmedString(env.GEMINI_MODEL), ...metaModels]);
    return [
      {
        source: sourceTag,
        appType: 'gemini',
        externalId: `${id}:gemini`,
        name,
        protocol: 'google_generate_content',
        rawUrl,
        websiteUrl,
        keys: rawKey ? rawKey.split(',').map((s) => s.trim()).filter(Boolean) : [],
        headers: extractHeadersRecord(settings.headers),
        models,
      },
    ];
  }

  // `opencode` / `openclaw` / 通用对象格式
  const options = isRecord(settings.options) ? settings.options : settings;
  const npmPkg = asTrimmedString(settings.npm).toLowerCase();
  const protocol: ParsedExternalVendor['apiProtocol'] = npmPkg.includes('anthropic')
    ? 'anthropic_messages'
    : npmPkg.includes('google')
      ? 'google_generate_content'
      : 'openai_chat_completions';
  const rawUrl = asTrimmedString(options.baseURL ?? options.baseUrl ?? settings.baseURL ?? settings.baseUrl);
  const rawKey = asTrimmedString(options.apiKey ?? options.api_key ?? settings.apiKey ?? settings.api_key);
  const modelsField = settings.models;
  const modelsList = Array.isArray(modelsField)
    ? modelsField.map(modelFromUnknown)
    : isRecord(modelsField)
      ? Object.entries(modelsField).map(([mId, mObj]) =>
          isRecord(mObj) ? modelFromUnknown({ id: mId, ...mObj }) : modelFromUnknown(mId),
        )
      : [];
  return [
    {
      source: sourceTag,
      appType,
      externalId: `${id}:${appType}`,
      name,
      protocol,
      rawUrl,
      websiteUrl,
      keys: rawKey ? rawKey.split(',').map((s) => s.trim()).filter(Boolean) : [],
      headers: extractHeadersRecord(options.headers ?? settings.headers),
      models: collectDistinctModels([...modelsList, ...metaModels]),
    },
  ];
}

function parseCcSwitchUniversalRow(
  row: Record<string, unknown>,
  sourceTag: ExternalSourceTag = 'cc-switch',
): RawCandidateDraft[] {
  const id = asTrimmedString(row.id) || 'cc-universal';
  const name = asTrimmedString(row.name) || id;
  const websiteUrl = asTrimmedString(row.website_url ?? row.websiteUrl) || null;
  let configObj: Record<string, unknown> = row;
  if (typeof row.settings_config === 'string' && row.settings_config.trim()) {
    try {
      const parsed = parseJsonLenient(row.settings_config);
      if (isRecord(parsed)) configObj = { ...row, ...parsed };
    } catch (err) {
      void err;
    }
  }
  const rawUrl = asTrimmedString(configObj.base_url ?? configObj.baseUrl ?? configObj.endpoint);
  const rawKey = asTrimmedString(configObj.api_key ?? configObj.apiKey ?? configObj.key);
  let modelsRaw: unknown = configObj.models;
  if (typeof modelsRaw === 'string' && modelsRaw.trim()) {
    const rawModelsText = modelsRaw;
    try {
      modelsRaw = parseJsonLenient(rawModelsText);
    } catch {
      modelsRaw = rawModelsText.split(',').map((s: string) => s.trim());
    }
  }
  const modelCandidates: Array<ParsedExternalModel | null> = [];
  if (Array.isArray(modelsRaw)) {
    for (const m of modelsRaw) modelCandidates.push(modelFromUnknown(m));
  } else if (isRecord(modelsRaw)) {
    // Universal provider 的 `models` 可能是 `{ claude: { model: "..." }, codex: { model: "..." } }` 或模型字典
    for (const [k, v] of Object.entries(modelsRaw)) {
      if (typeof v === 'string') {
        modelCandidates.push(modelFromUnknown(v));
      } else if (isRecord(v)) {
        if (typeof v.model === 'string') modelCandidates.push(modelFromUnknown(v.model));
        else modelCandidates.push(modelFromUnknown({ id: k, ...v }));
      }
    }
  }
  const providerTypeHint = asTrimmedString(configObj.provider_type ?? configObj.providerType).toLowerCase();
  const protocol: ParsedExternalVendor['apiProtocol'] = providerTypeHint.includes('anthropic')
    ? 'anthropic_messages'
    : providerTypeHint.includes('gemini') || providerTypeHint.includes('google')
      ? 'google_generate_content'
      : 'openai_chat_completions';

  return [
    {
      source: sourceTag,
      appType: 'universal',
      externalId: `${id}:universal`,
      name,
      protocol,
      rawUrl,
      websiteUrl,
      keys: rawKey ? rawKey.split(',').map((s) => s.trim()).filter(Boolean) : [],
      headers: extractHeadersRecord(configObj.headers),
      models: collectDistinctModels(modelCandidates),
    },
  ];
}

// ------------------------------------------------------------------ CC Switch SQL 备份解析

function splitSqlTupleList(valuesChunk: string): string[][] {
  const rows: string[][] = [];
  let i = 0;
  const len = valuesChunk.length;
  while (i < len) {
    while (i < len && valuesChunk[i] !== '(' && valuesChunk[i] !== ';') i += 1;
    if (i >= len || valuesChunk[i] === ';') break;
    i += 1; // skip '('
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;
    while (i < len) {
      const ch = valuesChunk[i]!;
      if (inQuotes) {
        if (ch === "'" && valuesChunk[i + 1] === "'") {
          current += "'";
          i += 2;
          continue;
        }
        if (ch === "'") {
          inQuotes = false;
          i += 1;
          continue;
        }
        current += ch;
        i += 1;
        continue;
      }
      if (ch === "'") {
        inQuotes = true;
        i += 1;
        continue;
      }
      if (ch === ',') {
        fields.push(current.trim());
        current = '';
        i += 1;
        continue;
      }
      if (ch === ')') {
        fields.push(current.trim());
        rows.push(fields);
        i += 1;
        break;
      }
      current += ch;
      i += 1;
    }
  }
  return rows;
}

function decodeSqlValue(token: string, wasRawString: boolean): unknown {
  if (!wasRawString && /^null$/i.test(token)) return null;
  if (!wasRawString && /^-?\d+$/.test(token)) return Number(token);
  return token;
}

export function parseCcSwitchSqlDump(sqlText: string, sourceTag: ExternalSourceTag = 'cc-switch'): RawCandidateDraft[] {
  const drafts: RawCandidateDraft[] = [];
  const defaultProviderCols = [
    'id',
    'app_type',
    'name',
    'settings_config',
    'website_url',
    'category',
    'created_at',
    'sort_index',
    'notes',
    'icon',
    'icon_color',
    'meta',
    'is_current',
    'in_failover_queue',
  ];
  const insertRegex =
    /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(?:["`[]?\w+["`\]]?\.)?["`[]?(providers|universal_providers)["`\]]?\s*(?:\(([^)]+)\))?\s*VALUES\s*([\s\S]*?);/gi;

  for (const match of sqlText.matchAll(insertRegex)) {
    const tableName = (match[1] ?? '').toLowerCase();
    const rawCols = match[2];
    const valuesPart = `${match[3] ?? ''};`;
    const columns = rawCols
      ? rawCols.split(',').map((col) => col.trim().replace(/^["`[]|["`\]]$/g, ''))
      : tableName === 'providers'
        ? defaultProviderCols
        : [];
    if (columns.length === 0) continue;

    // 保留原始引号状态以区分 `'NULL'` 与 SQL `NULL`
    const rawTuples = splitSqlTupleList(valuesPart);
    for (const tuple of rawTuples) {
      const record: Record<string, unknown> = {};
      for (let idx = 0; idx < columns.length && idx < tuple.length; idx++) {
        const colName = columns[idx]!;
        const val = tuple[idx]!;
        record[colName] = decodeSqlValue(val, colName === 'settings_config' || colName === 'meta' || colName === 'name');
      }
      if (tableName === 'universal_providers') {
        drafts.push(...parseCcSwitchUniversalRow(record, sourceTag));
      } else {
        drafts.push(...parseCcSwitchProviderRecord(record, sourceTag));
      }
    }
  }
  return drafts;
}

// ------------------------------------------------------------------ ccswitch:// 深链解析

function decodeBase64Utf8(encoded: string): string | null {
  const normalized = encoded.trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!normalized) return null;
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = globalThis.atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

export function parseCcSwitchDeepLink(uriText: string, sourceTag: ExternalSourceTag = 'paste'): RawCandidateDraft[] {
  let url: URL;
  try {
    url = new URL(uriText.trim());
  } catch {
    return [];
  }
  if (url.protocol.toLowerCase() !== 'ccswitch:') return [];
  const params = url.searchParams;
  const resource = (params.get('resource') ?? 'provider').toLowerCase();
  if (resource !== 'provider' && resource !== 'providers' && resource !== '') return [];

  const app = (params.get('app') ?? params.get('app_type') ?? 'claude').toLowerCase();
  const name = (params.get('name') ?? params.get('title') ?? '').trim();
  const homepage = (params.get('homepage') ?? params.get('websiteUrl') ?? params.get('website_url') ?? '').trim() || null;
  const endpoint = (params.get('endpoint') ?? params.get('baseUrl') ?? params.get('base_url') ?? '').trim();
  const apiKey = (params.get('apiKey') ?? params.get('api_key') ?? params.get('key') ?? params.get('token') ?? '').trim();
  const rawConfigParam = params.get('config') ?? params.get('settingsConfig') ?? params.get('settings_config');
  const configFormat = (params.get('configFormat') ?? params.get('format') ?? '').toLowerCase();

  if (rawConfigParam && rawConfigParam.trim()) {
    const decoded =
      rawConfigParam.trim().startsWith('{') || rawConfigParam.trim().startsWith('[')
        ? rawConfigParam.trim()
        : (decodeBase64Utf8(rawConfigParam) ?? rawConfigParam.trim());
    if (configFormat === 'toml' || (!decoded.startsWith('{') && decoded.includes('='))) {
      return parseCcSwitchProviderRecord(
        {
          id: name || 'ccswitch-link',
          app_type: app === 'claude' && decoded.includes('model_providers') ? 'codex' : app,
          name: name || 'CC Switch Import',
          website_url: homepage,
          settings_config: {
            auth: apiKey ? { OPENAI_API_KEY: apiKey } : {},
            config: decoded,
          },
        },
        sourceTag,
      );
    }
    try {
      const parsedConfig = parseJsonLenient(decoded);
      if (isRecord(parsedConfig)) {
        // 补充 URL 参数中额外提供的 endpoint / apiKey
        if (endpoint || apiKey) {
          const env = isRecord(parsedConfig.env) ? { ...parsedConfig.env } : {};
          if (app === 'claude') {
            if (endpoint && !env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = endpoint;
            if (apiKey && !env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY) env.ANTHROPIC_AUTH_TOKEN = apiKey;
            parsedConfig.env = env;
          } else if (app === 'gemini') {
            if (endpoint && !env.GOOGLE_GEMINI_BASE_URL) env.GOOGLE_GEMINI_BASE_URL = endpoint;
            if (apiKey && !env.GEMINI_API_KEY) env.GEMINI_API_KEY = apiKey;
            parsedConfig.env = env;
          }
        }
        return parseCcSwitchProviderRecord(
          {
            id: name || 'ccswitch-link',
            app_type: app,
            name: name || 'CC Switch Import',
            website_url: homepage,
            settings_config: parsedConfig,
          },
          sourceTag,
        );
      }
    } catch (err) {
      void err;
    }
  }

  const modelsFromQuery = collectDistinctModels([
    params.get('model'),
    ...(params.get('models')?.split(',') ?? []),
    params.get('sonnetModel') ?? params.get('sonnet_model'),
    params.get('opusModel') ?? params.get('opus_model'),
    params.get('haikuModel') ?? params.get('haiku_model'),
  ]);

  const protocol: ParsedExternalVendor['apiProtocol'] =
    app === 'claude'
      ? 'anthropic_messages'
      : app === 'gemini'
        ? 'google_generate_content'
        : app === 'codex'
          ? 'openai_responses'
          : 'openai_chat_completions';

  return [
    {
      source: sourceTag,
      appType: app,
      externalId: `ccswitch-link:${name || endpoint}`,
      name: name || 'CC Switch Provider',
      protocol,
      rawUrl: endpoint,
      websiteUrl: homepage,
      keys: apiKey ? apiKey.split(',').map((s) => s.trim()).filter(Boolean) : [],
      headers: {},
      models: modelsFromQuery,
    },
  ];
}

// ------------------------------------------------------------------ OpenCode / Claude Code / Codex / .env 解析

function parseOpenCodeDrafts(configText: string, authText?: string | null): RawCandidateDraft[] {
  const drafts: RawCandidateDraft[] = [];
  const authKeysByProvider = new Map<string, string>();

  if (authText && authText.trim()) {
    try {
      const authRoot = parseJsonLenient(authText);
      if (isRecord(authRoot)) {
        for (const [providerId, entry] of Object.entries(authRoot)) {
          if (typeof entry === 'string' && entry.trim()) {
            authKeysByProvider.set(providerId.trim().toLowerCase(), entry.trim());
          } else if (isRecord(entry)) {
            const key = asTrimmedString(entry.key ?? entry.apiKey ?? entry.token);
            if (key) authKeysByProvider.set(providerId.trim().toLowerCase(), key);
          }
        }
      }
    } catch (err) {
      void err;
    }
  }

  const root = parseJsonLenient(configText);
  const consumedAuthIds = new Set<string>();
  const providersMap = isRecord(root)
    ? isRecord(root.provider)
      ? root.provider
      : isRecord(root.providers)
        ? root.providers
        : null
    : null;

  if (providersMap) {
    for (const [providerId, rawProvider] of Object.entries(providersMap)) {
      if (!isRecord(rawProvider)) continue;
      const lowerId = providerId.trim().toLowerCase();
      consumedAuthIds.add(lowerId);
      const options = isRecord(rawProvider.options) ? rawProvider.options : {};
      const npmPkg = asTrimmedString(rawProvider.npm).toLowerCase();
      const known = KNOWN_OPENCODE_DEFAULT_ENDPOINTS[lowerId];
      const protocol: ParsedExternalVendor['apiProtocol'] = npmPkg.includes('anthropic')
        ? 'anthropic_messages'
        : npmPkg.includes('google')
          ? 'google_generate_content'
          : (known?.protocol ?? 'openai_chat_completions');
      const rawUrl =
        asTrimmedString(options.baseURL ?? options.baseUrl ?? rawProvider.baseURL ?? rawProvider.baseUrl) ||
        (known?.baseUrl ?? '');
      const inlineKey = asTrimmedString(options.apiKey ?? options.api_key ?? rawProvider.apiKey);
      const fallbackAuthKey = authKeysByProvider.get(lowerId) ?? '';
      const keys = [inlineKey, fallbackAuthKey].filter(Boolean);
      const modelsObj = rawProvider.models;
      const models = isRecord(modelsObj)
        ? collectDistinctModels(
            Object.entries(modelsObj).map(([mId, mVal]) =>
              isRecord(mVal) ? modelFromUnknown({ id: mId, ...mVal }) : modelFromUnknown(mId),
            ),
          )
        : Array.isArray(modelsObj)
          ? collectDistinctModels(modelsObj.map(modelFromUnknown))
          : [];

      drafts.push({
        source: 'opencode',
        appType: 'opencode',
        externalId: `opencode:${providerId}`,
        name: asTrimmedString(rawProvider.name) || known?.name || providerId,
        protocol,
        rawUrl,
        websiteUrl: null,
        keys,
        headers: extractHeadersRecord(options.headers ?? rawProvider.headers),
        models,
      });
    }
  }

  for (const [providerId, key] of authKeysByProvider.entries()) {
    if (consumedAuthIds.has(providerId)) continue;
    const known = KNOWN_OPENCODE_DEFAULT_ENDPOINTS[providerId];
    if (!known) continue;
    drafts.push({
      source: 'opencode',
      appType: 'opencode',
      externalId: `opencode-auth:${providerId}`,
      name: known.name,
      protocol: known.protocol,
      rawUrl: known.baseUrl,
      websiteUrl: null,
      keys: [key],
      headers: {},
      models: [],
    });
  }

  return drafts;
}

function parseClaudeSettingsJson(text: string, sourceTag: ExternalSourceTag = 'claude-code'): RawCandidateDraft[] {
  const parsed = parseJsonLenient(text);
  if (!isRecord(parsed)) return [];
  return parseCcSwitchProviderRecord(
    {
      id: 'claude-settings',
      app_type: 'claude',
      name: 'Claude Code Provider',
      settings_config: parsed,
    },
    sourceTag,
  );
}

function parseCodexConfigAndAuth(
  tomlText: string,
  authJsonText?: string | null,
  sourceTag: ExternalSourceTag = 'codex',
): RawCandidateDraft[] {
  let authKey = '';
  if (authJsonText && authJsonText.trim()) {
    try {
      const parsed = parseJsonLenient(authJsonText);
      if (isRecord(parsed)) {
        authKey = asTrimmedString(parsed.OPENAI_API_KEY ?? parsed.apiKey ?? parsed.api_key);
      }
    } catch (err) {
      void err;
    }
  }
  const toml = parseCodexToml(tomlText);
  const selectedProvider = toml.modelProvider
    ? toml.providers[toml.modelProvider]
    : Object.values(toml.providers)[0];
  const rawUrl = selectedProvider?.baseUrl || toml.baseUrl || (authKey ? 'https://api.openai.com/v1' : '');
  const wireApi = (selectedProvider?.wireApi || toml.wireApi || '').toLowerCase();
  const protocol: ParsedExternalVendor['apiProtocol'] =
    wireApi === 'chat' || wireApi === 'chat_completions' ? 'openai_chat_completions' : 'openai_responses';
  const name = selectedProvider?.name || toml.modelProvider || 'Codex Provider';

  if (!rawUrl && !authKey) return [];
  return [
    {
      source: sourceTag,
      appType: 'codex',
      externalId: `codex:${name}`,
      name,
      protocol,
      rawUrl,
      websiteUrl: null,
      keys: authKey ? [authKey] : [],
      headers: selectedProvider?.headers ?? {},
      models: collectDistinctModels([toml.model]),
    },
  ];
}

export function parseEnvSnippet(text: string, sourceTag: ExternalSourceTag = 'paste'): RawCandidateDraft[] {
  const vars: Record<string, string> = {};
  const assignPair = (rawKey: string, rawVal: string) => {
    const cleanKey = rawKey.replace(/^(?:export\s+|set\s+|\$env:)/i, '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cleanKey)) return;
    let val = rawVal.trim().replace(/;+$/, '').trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    } else {
      val = val.replace(/\s+#.*$/, '').trim();
    }
    if (cleanKey && val) vars[cleanKey] = val;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // 支持单行内多个环境变量前缀，如：`ANTHROPIC_BASE_URL=https://... ANTHROPIC_AUTH_TOKEN=sk-... claude`
    const inlineMatches = [
      ...trimmed.matchAll(
        /(?:(?:export|set)\s+|\$env:)?([A-Z][A-Z0-9_]{2,})\s*=\s*("[^"]*"|'[^']*'|[^\s;]+)/g,
      ),
    ];
    if (inlineMatches.length >= 2) {
      for (const m of inlineMatches) {
        assignPair(m[1]!, m[2]!);
      }
      continue;
    }
    const withoutPrefix = trimmed.replace(/^(?:export\s+|set\s+|\$env:)/i, '');
    const eq = withoutPrefix.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutPrefix.slice(0, eq).trim();
    const val = withoutPrefix.slice(eq + 1).trim();
    // 剔除行末附带的 CLI 启动命令（如 `ANTHROPIC_AUTH_TOKEN=sk-xxx claude`）
    const unquotedVal =
      val.startsWith('"') || val.startsWith("'")
        ? val
        : (val.split(/\s+(?:claude|codex|gemini|opencode)\b/i)[0] ?? val);
    assignPair(key, unquotedVal);
  }

  const drafts: RawCandidateDraft[] = [];
  const anthropicKey = vars.ANTHROPIC_AUTH_TOKEN || vars.ANTHROPIC_API_KEY || '';
  const anthropicUrl = vars.ANTHROPIC_BASE_URL || (anthropicKey.startsWith('sk-ant-') ? 'https://api.anthropic.com/v1' : '');
  if (anthropicKey || vars.ANTHROPIC_BASE_URL) {
    drafts.push({
      source: sourceTag,
      appType: 'claude',
      externalId: 'env:anthropic',
      name: 'Anthropic Provider',
      protocol: 'anthropic_messages',
      rawUrl: anthropicUrl,
      websiteUrl: null,
      keys: anthropicKey ? [anthropicKey] : [],
      headers: {},
      models: collectDistinctModels([
        vars.ANTHROPIC_MODEL,
        vars.ANTHROPIC_DEFAULT_SONNET_MODEL,
        vars.ANTHROPIC_DEFAULT_OPUS_MODEL,
        vars.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      ]),
    });
  }

  const openaiKey = vars.OPENAI_API_KEY || '';
  const openaiUrl = vars.OPENAI_BASE_URL || vars.OPENAI_API_BASE || (openaiKey ? 'https://api.openai.com/v1' : '');
  if (openaiKey || vars.OPENAI_BASE_URL || vars.OPENAI_API_BASE) {
    drafts.push({
      source: sourceTag,
      appType: 'openai',
      externalId: 'env:openai',
      name: 'OpenAI Compatible',
      protocol: 'openai_chat_completions',
      rawUrl: openaiUrl,
      websiteUrl: null,
      keys: openaiKey ? [openaiKey] : [],
      headers: {},
      models: collectDistinctModels([vars.OPENAI_MODEL]),
    });
  }

  const geminiKey = vars.GEMINI_API_KEY || vars.GOOGLE_API_KEY || '';
  const geminiUrl = vars.GOOGLE_GEMINI_BASE_URL || vars.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
  if (geminiKey) {
    drafts.push({
      source: sourceTag,
      appType: 'gemini',
      externalId: 'env:gemini',
      name: 'Gemini Provider',
      protocol: 'google_generate_content',
      rawUrl: geminiUrl,
      websiteUrl: null,
      keys: [geminiKey],
      headers: {},
      models: collectDistinctModels([vars.GEMINI_MODEL]),
    });
  }

  return drafts;
}

function parseCcSwitchJsonLegacyOrExport(text: string, sourceTag: ExternalSourceTag): RawCandidateDraft[] {
  const root = parseJsonLenient(text);
  const drafts: RawCandidateDraft[] = [];

  if (Array.isArray(root)) {
    for (const item of root) {
      if (isRecord(item) && ('settings_config' in item || 'settingsConfig' in item || 'app_type' in item)) {
        drafts.push(...parseCcSwitchProviderRecord(item, sourceTag));
      }
    }
    if (drafts.length > 0) return drafts;
  }

  if (isRecord(root)) {
    // Legacy CC Switch v1/v2 `config.json`: `{ apps: { claude: { providers: { id: { ... } } }, codex: ... } }`
    if (isRecord(root.apps)) {
      for (const [appType, appVal] of Object.entries(root.apps)) {
        if (!isRecord(appVal)) continue;
        const providers = appVal.providers;
        if (isRecord(providers)) {
          for (const [id, pVal] of Object.entries(providers)) {
            if (isRecord(pVal)) {
              drafts.push(
                ...parseCcSwitchProviderRecord({ id, app_type: appType, ...pVal }, sourceTag),
              );
            }
          }
        } else if (Array.isArray(providers)) {
          for (const pVal of providers) {
            if (isRecord(pVal)) {
              drafts.push(...parseCcSwitchProviderRecord({ app_type: appType, ...pVal }, sourceTag));
            }
          }
        }
      }
      if (drafts.length > 0) return drafts;
    }

    if (Array.isArray(root.providers) && root.providers.some((p) => isRecord(p) && ('settings_config' in p || 'app_type' in p))) {
      for (const pVal of root.providers) {
        if (isRecord(pVal)) drafts.push(...parseCcSwitchProviderRecord(pVal, sourceTag));
      }
      if (drafts.length > 0) return drafts;
    }
  }

  return drafts;
}

export function parseArbitraryExternalText(rawText: string, sourceTag: ExternalSourceTag = 'paste'): RawCandidateDraft[] {
  const trimmed = rawText.trim();
  if (!trimmed) return [];

  // 1. 支持一行或多行 `ccswitch://` 深链
  const deepLinkMatches = [...trimmed.matchAll(/ccswitch:\/\/[^\s"'<>]+/gi)].map((m) => m[0]);
  if (deepLinkMatches.length > 0) {
    const out: RawCandidateDraft[] = [];
    for (const link of deepLinkMatches) {
      out.push(...parseCcSwitchDeepLink(link, sourceTag));
    }
    if (out.length > 0) return out;
  }

  // 2. SQL 转储 (`INSERT INTO providers ...`)
  if (/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+["`[]?(?:providers|universal_providers)/i.test(trimmed)) {
    return parseCcSwitchSqlDump(trimmed, sourceTag);
  }

  // 3. JSON / JSONC（自动识别 CC Switch / OpenCode / Claude Code / Magpie）
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const ccJson = parseCcSwitchJsonLegacyOrExport(trimmed, sourceTag);
    if (ccJson.length > 0) return ccJson;

    const parsed = parseJsonLenient(trimmed);
    if (isRecord(parsed)) {
      if (isRecord(parsed.env) && ('ANTHROPIC_AUTH_TOKEN' in parsed.env || 'ANTHROPIC_API_KEY' in parsed.env || 'ANTHROPIC_BASE_URL' in parsed.env || 'GEMINI_API_KEY' in parsed.env)) {
        if ('GEMINI_API_KEY' in parsed.env || 'GOOGLE_API_KEY' in parsed.env) {
          return parseCcSwitchProviderRecord({ id: 'pasted-gemini', app_type: 'gemini', name: 'Gemini Provider', settings_config: parsed }, sourceTag);
        }
        return parseClaudeSettingsJson(trimmed, sourceTag);
      }
      if (isRecord(parsed.provider) || (isRecord(parsed.providers) && Object.values(parsed.providers).some((v) => isRecord(v) && ('npm' in v || 'options' in v)))) {
        return parseOpenCodeDrafts(trimmed, null).map((d) => ({ ...d, source: sourceTag }));
      }
    }
    return parseMagpieDrafts(trimmed, null).map((d) => ({ ...d, source: sourceTag }));
  }

  // 4. Codex TOML (`[model_providers...]` + 可选 `OPENAI_API_KEY`)
  if (/\[model_providers\.[^\]]+\]/i.test(trimmed)) {
    const envDrafts = parseEnvSnippet(trimmed, sourceTag);
    const keyHint = envDrafts.flatMap((d) => d.keys)[0] ?? '';
    return parseCodexConfigAndAuth(
      trimmed,
      keyHint ? JSON.stringify({ OPENAI_API_KEY: keyHint }) : null,
      sourceTag,
    );
  }

  // 5. `.env` / Shell `export` 变量块
  return parseEnvSnippet(trimmed, sourceTag);
}

/** 前端输入框快速判断粘贴文本是否为结构化外部工具配置（而非裸 API Key）。 */
export function looksLikeStructuredExternalConfig(rawText: string): boolean {
  const trimmed = rawText.trim();
  if (!trimmed) return false;
  if (/^ccswitch:\/\//i.test(trimmed)) return true;
  if (/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+["`[]?(?:providers|universal_providers)/i.test(trimmed)) return true;
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return true;
  }
  if (/\[model_providers\.[^\]]+\]/i.test(trimmed)) return true;
  if (/(?:^|\n|\s)(?:export\s+|set\s+|\$env:)?(?:ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|OPENAI_API_KEY|OPENAI_BASE_URL|GEMINI_API_KEY|GOOGLE_GEMINI_BASE_URL)\s*=/i.test(trimmed)) {
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ 统一解析与跨源去重合并

function parseSingleSourceDrafts(input: RawExternalInputSource): RawCandidateDraft[] {
  if (input.kind === 'sqlite-rows' && input.sqliteTables) {
    const out: RawCandidateDraft[] = [];
    for (const row of input.sqliteTables.universalProviders) {
      out.push(...parseCcSwitchUniversalRow(row, input.source));
    }
    for (const row of input.sqliteTables.providers) {
      out.push(...parseCcSwitchProviderRecord(row, input.source));
    }
    return out;
  }

  const text = input.text ?? '';
  if (!text.trim() && !(input.companionText ?? '').trim()) return [];

  if (input.source === 'magpie' && input.kind === 'json') {
    return parseMagpieDrafts(text, input.companionText);
  }
  if (input.source === 'cc-switch') {
    if (input.kind === 'sql') return parseCcSwitchSqlDump(text, 'cc-switch');
    return parseCcSwitchJsonLegacyOrExport(text, 'cc-switch');
  }
  if (input.source === 'opencode') {
    return parseOpenCodeDrafts(text, input.companionText);
  }
  if (input.source === 'claude-code') {
    return parseClaudeSettingsJson(text, 'claude-code');
  }
  if (input.source === 'codex') {
    return parseCodexConfigAndAuth(text, input.companionText, 'codex');
  }
  if (input.kind === 'sql') {
    return parseCcSwitchSqlDump(text, input.source);
  }
  return parseArbitraryExternalText(text, input.source);
}

export function parseAndNormalizeExternalSources(
  inputs: readonly RawExternalInputSource[],
): ExternalParseSummary {
  let skippedProxyCount = 0;
  let skippedNoKeyCount = 0;
  const sourceStats: ExternalParseSummary['sourceStats'] = [];
  const mergedByBucket = new Map<string, ParsedExternalVendor>();

  for (const input of inputs) {
    if (input.error) {
      sourceStats.push({
        source: input.source,
        pathLabel: input.pathLabel,
        candidateCount: 0,
        error: input.error,
      });
      continue;
    }

    let rawDrafts: RawCandidateDraft[] = [];
    let parseError: string | null = null;
    try {
      rawDrafts = parseSingleSourceDrafts(input);
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }

    if (parseError !== null) {
      sourceStats.push({
        source: input.source,
        pathLabel: input.pathLabel,
        candidateCount: 0,
        error: parseError,
      });
      continue;
    }

    let validCountForSource = 0;
    for (const draft of rawDrafts) {
      if (isLoopbackGatewayProxyUrl(draft.rawUrl)) {
        skippedProxyCount += 1;
        continue;
      }

      const validKeys: string[] = [];
      let sawProxyPlaceholderKey = false;
      for (const rawKey of draft.keys) {
        const cleaned = sanitizeKeyValue(rawKey);
        if (!cleaned) continue;
        const lower = cleaned.toLowerCase();
        if (lower === 'magpie' || lower === 'proxy_managed' || lower === 'cc-switch' || lower === 'ccswitch') {
          sawProxyPlaceholderKey = true;
          continue;
        }
        if (isPlaceholderKey(cleaned)) continue;
        if (!validKeys.includes(cleaned)) validKeys.push(cleaned);
      }

      const normalizedUrl = normalizeEndpointUrl(draft.rawUrl, draft.protocol);
      if (!normalizedUrl) {
        skippedNoKeyCount += 1;
        continue;
      }

      const { providerType, matchedBuiltinVendorId, displayNameFallback } = inferProviderAndBuiltin(
        normalizedUrl,
        draft.protocol,
      );

      if (validKeys.length === 0 && providerType !== 'ollama') {
        if (sawProxyPlaceholderKey) skippedProxyCount += 1;
        else skippedNoKeyCount += 1;
        continue;
      }

      validCountForSource += 1;
      const effectiveProtocol =
        matchedBuiltinVendorId !== null && draft.protocol === 'openai_chat_completions'
          ? (resolvePreferredProtocolForProvider(providerType, 'general', normalizedUrl, null) as ParsedExternalVendor['apiProtocol'])
          : draft.protocol;
      const supportsResponses =
        effectiveProtocol === 'openai_responses' ||
        providerSupportsOpenaiResponses(providerType, normalizedUrl, null);

      const bucketKey =
        matchedBuiltinVendorId !== null
          ? `builtin:${matchedBuiltinVendorId}`
          : `endpoint:${normalizedUrl.toLowerCase()}|protocol:${effectiveProtocol}`;

      const resolvedName =
        draft.name &&
        draft.name !== 'Claude Code Provider' &&
        draft.name !== 'Codex Provider' &&
        draft.name !== 'CC Switch Provider' &&
        draft.name !== 'Anthropic Provider' &&
        draft.name !== 'OpenAI Compatible'
          ? draft.name
          : displayNameFallback;

      const existing = mergedByBucket.get(bucketKey);
      if (!existing) {
        const [primaryKey = '', ...restKeys] = validKeys;
        mergedByBucket.set(bucketKey, {
          externalKey: bucketKey,
          name: resolvedName,
          providerType,
          apiProtocol: effectiveProtocol,
          supportsOpenaiResponses: supportsResponses,
          baseUrl:
            matchedBuiltinVendorId !== null
              ? (BUILTIN_VENDORS.find((v) => v.id === matchedBuiltinVendorId)?.baseUrl ?? normalizedUrl)
              : normalizedUrl,
          websiteUrl: draft.websiteUrl,
          apiKey: primaryKey,
          extraApiKeys: restKeys,
          headers: { ...draft.headers },
          sources: [draft.source],
          appTypes: [draft.appType],
          models: collectDistinctModels(draft.models),
          matchedBuiltinVendorId,
        });
      } else {
        const allKeys = [existing.apiKey, ...existing.extraApiKeys].filter(Boolean);
        for (const k of validKeys) {
          if (!allKeys.includes(k)) allKeys.push(k);
        }
        const [primaryKey = '', ...restKeys] = allKeys;
        existing.apiKey = primaryKey;
        existing.extraApiKeys = restKeys;
        if (!existing.sources.includes(draft.source)) existing.sources.push(draft.source);
        if (!existing.appTypes.includes(draft.appType)) existing.appTypes.push(draft.appType);
        if (!existing.websiteUrl && draft.websiteUrl) existing.websiteUrl = draft.websiteUrl;
        Object.assign(existing.headers, draft.headers);
        existing.models = collectDistinctModels([...existing.models, ...draft.models]);
      }
    }

    sourceStats.push({
      source: input.source,
      pathLabel: input.pathLabel,
      candidateCount: validCountForSource,
      error: null,
    });
  }

  return {
    candidates: [...mergedByBucket.values()],
    sourceStats,
    skippedProxyCount,
    skippedNoKeyCount,
  };
}
