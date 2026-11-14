/**
 * 供应商模型目录抓取（移植 `src/commands.rs:2918–3320`）。
 *
 * 端点推导、探测字段、请求头、分页与 OpenCode Go 内置目录均逐条对应 Rust。
 * HTTP 由调用方注入，便于按 Rust 行为（禁止重定向、超时、错误截断）测试。
 */
import { AppError } from '../../../platform/errors/api.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import type { VendorConfig } from '../api.ts';
import type { FetchedVendorModel } from '../../../../contracts/ipc/generated/L02-llm-manager.ts';
import { AUTH_MODE_NONE } from './protocol.ts';
import { BUILTIN_MODELS, PROVIDER_TYPE, VENDOR_ID } from './opencode_go.ts';

export const PROBE_CONTEXT_WINDOW_KEYS = [
  'context_length',
  'context_window',
  'max_context_length',
  'max_model_len',
] as const;
export const PROBE_MAX_OUTPUT_KEYS = [
  'max_output_tokens',
  'max_completion_tokens',
  'top_provider.max_completion_tokens',
] as const;
const OPENAI_EXCLUDED_MODEL_NEEDLES = ['tts', 'whisper', 'video', 'kolors', 'flux', 'dall-e', 'audio'];
const MAX_PAGES = 20;
const ERROR_BODY_LIMIT = 2048;

export type VendorModelsKind = 'gemini' | 'anthropic' | 'openai';

export interface FetchLikeResponse {
  readonly status: number;
  readonly statusText: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}
export type VendorModelsFetch = (url: string, init: {
  method: 'GET';
  headers: [string, string][];
  redirect: 'manual';
  signal: AbortSignal;
}) => Promise<FetchLikeResponse>;

function valueAtPath(item: unknown, path: string): unknown {
  let current: unknown = item;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** `probe_u32_field`：只接受正整数（JSON number 或可解析字符串），超出 u32 忽略。 */
export function probeU32Field(item: unknown, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = valueAtPath(item, key);
    let number: number | undefined;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) number = value;
    else if (typeof value === 'string') {
      const trimmed = value.trim();
      if (/^\d+$/.test(trimmed)) number = Number(trimmed);
    }
    if (number === undefined || !Number.isSafeInteger(number) || number > 0xffff_ffff) continue;
    if (number > 0) return number;
  }
  return null;
}

/** providers/openai-chat.rs `normalize_ollama_root_base_url`。 */
export function normalizeOllamaRootBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(rustTrim(baseUrl));
  } catch {
    return baseUrl;
  }
  if (url.port === '11434' && (url.pathname === '' || url.pathname === '/') && !url.href.includes('?')) {
    url.pathname = '/v1';
    return url.href.replace(/\/+$/, '');
  }
  return baseUrl;
}

/** `vendor_models_endpoint`（commands.rs:2952–3026）。 */
export function vendorModelsEndpoint(
  baseUrl: string, providerType: string, apiProtocol: string | null,
): { url: URL; kind: VendorModelsKind } {
  let url: URL;
  try {
    url = new URL(rustTrim(normalizeOllamaRootBaseUrl(baseUrl)));
  } catch {
    throw AppError.validation('供应商 Base URL 无效');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') {
    throw AppError.validation('供应商 Base URL 必须是有效的 HTTP(S) 地址');
  }
  const provider = rustTrim(providerType).toLowerCase();
  const protocol = rustTrim(apiProtocol ?? '').toLowerCase();
  let path = url.pathname.replace(/\/+$/, '');
  const usesOpenaiProtocol = protocol === 'openai_chat_completions' || protocol === 'openai_responses';
  let kind: VendorModelsKind;
  if (!usesOpenaiProtocol && (protocol === 'google_generate_content' || provider === 'gemini' || provider === 'google')) {
    for (const suffix of ['/v1beta/models', '/v1/models', '/models']) {
      if (path.toLowerCase().endsWith(suffix)) {
        path = path.slice(0, path.length - suffix.length);
        break;
      }
    }
    if (path === '') path = '/v1beta';
    else if (!path.endsWith('/v1beta') && !path.endsWith('/v1')) path += '/v1beta';
    path += '/models';
    kind = 'gemini';
  } else if (!usesOpenaiProtocol && (protocol === 'anthropic_messages' || provider === 'anthropic' || provider === 'claude')) {
    for (const suffix of ['/v1/messages', '/v1/models', '/messages', '/models']) {
      if (path.toLowerCase().endsWith(suffix)) {
        path = path.slice(0, path.length - suffix.length);
        break;
      }
    }
    if (!path.endsWith('/v1')) path += '/v1';
    path += '/models';
    kind = 'anthropic';
  } else {
    for (const suffix of ['/chat/completions', '/responses', '/models']) {
      if (path.toLowerCase().endsWith(suffix)) {
        path = path.slice(0, path.length - suffix.length);
        break;
      }
    }
    path += '/models';
    kind = 'openai';
  }
  url.pathname = path;
  url.search = '';
  url.hash = '';
  return { url, kind };
}

const HOP_BY_HOP_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);

/** RFC 7230 `token`：Node `http.validateHeaderName` 接受的字符集。 */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Node `http.validateHeaderName`：非法名称抛 `TypeError`（调用方只关心是否抛出）。 */
function validateHeaderName(name: string): void {
  if (!HEADER_NAME.test(name)) throw new TypeError(`Invalid HTTP token "${name}"`);
}

/** Node `http.validateHeaderValue`：缺值或 `\t`/0x20–0x7e/0x80–0xff 之外的字符抛 `TypeError`。 */
function validateHeaderValue(name: string, value: string | undefined): void {
  if (value === undefined) throw new TypeError(`Invalid value "undefined" for header "${name}"`);
  if (/[^\t\x20-\x7e\x80-\xff]/.test(value)) throw new TypeError(`Invalid character in header content ["${name}"]`);
}

/** `vendor_model_headers`（commands.rs:3029–3084）。 */
export function vendorModelHeaders(vendor: Pick<VendorConfig, 'headers' | 'apiKey'>, kind: VendorModelsKind): [string, string][] {
  const headers = new Map<string, [string, string]>();
  for (const [name, value] of Object.entries(vendor.headers ?? {})) {
    if (HOP_BY_HOP_HEADERS.has(name.trim().toLowerCase())) continue;
    try {
      validateHeaderName(name);
    } catch {
      throw AppError.validation(`无效的供应商请求头名称: ${name}`);
    }
    try {
      validateHeaderValue(name, value);
    } catch {
      throw AppError.validation('供应商请求头包含无效字符');
    }
    headers.set(name.toLowerCase(), [name, value]);
  }
  const key = vendor.apiKey.trim();
  const set = (name: string, value: string): void => {
    try {
      validateHeaderValue(name, value);
    } catch {
      throw AppError.validation('API 密钥包含无效字符');
    }
    headers.set(name.toLowerCase(), [name, value]);
  };
  if (kind === 'gemini' && key !== '') {
    try {
      validateHeaderValue('x-goog-api-key', key);
    } catch {
      throw AppError.validation('Gemini API 密钥包含无效字符');
    }
    headers.set('x-goog-api-key', ['x-goog-api-key', key]);
  } else if (kind === 'anthropic') {
    headers.set('anthropic-version', ['anthropic-version', '2023-06-01']);
    if (key !== '') {
      try {
        validateHeaderValue('x-api-key', key);
      } catch {
        throw AppError.validation('Anthropic API 密钥包含无效字符');
      }
      headers.set('x-api-key', ['x-api-key', key]);
    }
  } else if (kind === 'openai' && key !== '') {
    set('Authorization', `Bearer ${key}`);
  }
  return [...headers.values()];
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** 单页模型解析（commands.rs:3183–3282）。 */
export function parseVendorModelsPage(
  body: unknown, kind: VendorModelsKind,
): { models: Map<string, FetchedVendorModel>; cursor: string | null } {
  const models = new Map<string, FetchedVendorModel>();
  const root = objectOf(body);
  if (kind === 'gemini') {
    const items = root?.models;
    if (!Array.isArray(items)) throw AppError.network('Gemini 模型响应缺少 models 数组');
    for (const item of items) {
      const obj = objectOf(item);
      if (!obj) continue;
      const methods = Array.isArray(obj.supportedGenerationMethods) ? obj.supportedGenerationMethods : [];
      if (!methods.some((method) => method === 'generateContent')) continue;
      if (typeof obj.name !== 'string') continue;
      const rawId = obj.name;
      const id = rawId.startsWith('models/') ? rawId.slice('models/'.length) : rawId;
      const label = typeof obj.displayName === 'string' ? obj.displayName : id;
      models.set(id, {
        id,
        label,
        contextWindow: probeU32Field(item, ['inputTokenLimit']),
        maxOutputTokens: probeU32Field(item, ['outputTokenLimit']),
      });
    }
    const token = root?.nextPageToken;
    return { models, cursor: typeof token === 'string' ? token : null };
  }
  const items = root?.data;
  if (!Array.isArray(items)) throw AppError.network('供应商模型响应缺少 data 数组');
  for (const item of items) {
    const obj = objectOf(item);
    if (!obj || typeof obj.id !== 'string') continue;
    const id = obj.id;
    if (kind === 'anthropic' && typeof obj.type === 'string' && obj.type !== 'model') continue;
    const lower = id.toLowerCase();
    if (kind === 'openai' && OPENAI_EXCLUDED_MODEL_NEEDLES.some((needle) => lower.includes(needle))) continue;
    const label = typeof obj.display_name === 'string' ? obj.display_name : id;
    models.set(id, {
      id,
      label,
      contextWindow: probeU32Field(item, PROBE_CONTEXT_WINDOW_KEYS),
      maxOutputTokens: probeU32Field(item, PROBE_MAX_OUTPUT_KEYS),
    });
  }
  const hasMore = root?.has_more === true;
  let cursor: string | null = null;
  if (hasMore) {
    if (typeof root?.last_id === 'string') cursor = root.last_id;
    else {
      const last = objectOf(items[items.length - 1]);
      cursor = typeof last?.id === 'string' ? last.id : null;
    }
  }
  return { models, cursor };
}

function withQuery(url: URL, kind: VendorModelsKind, cursor: string | null): string {
  const page = new URL(url.href);
  if (kind === 'gemini') {
    page.searchParams.append('pageSize', '100');
    if (cursor !== null) page.searchParams.append('pageToken', cursor);
  } else if (kind === 'anthropic') {
    page.searchParams.append('limit', '1000');
    if (cursor !== null) page.searchParams.append('after_id', cursor);
  } else if (cursor !== null) {
    page.searchParams.append('after', cursor);
  }
  return page.href;
}

function statusText(response: FetchLikeResponse): string {
  return response.statusText ? `${response.status} ${response.statusText}` : String(response.status);
}

export interface VendorModelsRuntime {
  fetch: VendorModelsFetch;
}

/** `fetch_vendor_models`（commands.rs:3106–3298）。 */
export async function fetchVendorModels(
  vendor: VendorConfig, runtime: VendorModelsRuntime,
): Promise<FetchedVendorModel[]> {
  if (vendor.id === VENDOR_ID || vendor.providerType.toLowerCase() === PROVIDER_TYPE) {
    return BUILTIN_MODELS.map((model) => ({
      id: model.model,
      label: model.label,
      contextWindow: null,
      maxOutputTokens: model.maxOutputTokens,
    }));
  }
  const usesNoAuth = (vendor.authMode ?? '').toLowerCase() === AUTH_MODE_NONE;
  if (!usesNoAuth && vendor.apiKey.trim() === '') {
    const backup = vendor.apiKeys.map((key) => key.trim()).find((key) => key !== '');
    if (backup === undefined) throw AppError.validation('供应商尚未配置 API 密钥');
    vendor = { ...vendor, apiKey: backup };
  }
  const { url, kind } = vendorModelsEndpoint(vendor.baseUrl, vendor.providerType, vendor.apiProtocol);
  const headers = vendorModelHeaders(vendor, kind);
  const timeoutMs = Math.min(Math.max(vendor.defaultTimeoutMs ?? 30_000, 1_000), 120_000);

  const models = new Map<string, FetchedVendorModel>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const pageUrl = withQuery(url, kind, cursor);
    let response: FetchLikeResponse;
    try {
      response = await runtime.fetch(pageUrl, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw AppError.network(`获取供应商模型失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status < 200 || response.status >= 300) {
      const detail = Array.from(await response.text().catch(() => '')).slice(0, ERROR_BODY_LIMIT).join('');
      throw AppError.network(`获取供应商模型失败: ${statusText(response)} - ${detail}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw AppError.network(`解析供应商模型响应失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = parseVendorModelsPage(body, kind);
    for (const [id, model] of parsed.models) models.set(id, model);
    cursor = parsed.cursor;
    if (cursor === null || cursor === '') break;
  }
  return [...models.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}
