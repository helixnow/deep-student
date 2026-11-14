/**
 * OpenCode Go 订阅接入（移植 `dstu-llm/src/llm_manager/opencode_go.rs`）。
 * 端点常量、内置模型、用量接口解析与错误分类逐条对应。
 */
import type { OpenCodeGoUsage } from '../api.ts';
import type { OpenCodeGoUsageWindow } from '../../../../contracts/ipc/generated/L02-llm-manager.ts';
import { OPENCODE_GO_BUILTIN_MODELS, OPENCODE_GO_OPENAI_BASE_URL, OPENCODE_GO_PROVIDER_TYPE, OPENCODE_GO_VENDOR_ID } from './data/builtin_catalog.ts';

export const VENDOR_ID = OPENCODE_GO_VENDOR_ID;
export const PROVIDER_TYPE = OPENCODE_GO_PROVIDER_TYPE;
export const OPENAI_BASE_URL = OPENCODE_GO_OPENAI_BASE_URL;
export const ANTHROPIC_BASE_URL = 'https://opencode.ai/inference/go/anthropic/v1';
export const GOOGLE_BASE_URL = 'https://opencode.ai/inference/go/google/v1beta';
export const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
export const SESSION_HEADER = 'x-opencode-session';
export const USAGE_SESSION_ID = 'deepstudent-usage';
export const TASK_SESSION_ID = 'deepstudent-task';
export const BUILTIN_MODELS = OPENCODE_GO_BUILTIN_MODELS;

const SESSION_HEADER_MAX_LEN = 128;

export function userAgent(appVersion: string): string {
  return `DeepStudent/${appVersion}`;
}

function isGoRootUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return false;
  }
  if (url.hostname.toLowerCase() !== 'opencode.ai') return false;
  const path = url.pathname.replace(/\/+$/, '');
  return path.startsWith('/inference/go') || path.startsWith('/zen/go');
}

export function isOpencodeGoConfig(config: {
  vendorId: string | null;
  providerType: string | null;
  baseUrl: string;
}): boolean {
  return (
    config.vendorId === VENDOR_ID ||
    (config.providerType !== null && config.providerType.toLowerCase() === PROVIDER_TYPE) ||
    isGoRootUrl(config.baseUrl)
  );
}

export function baseUrlForProtocol(currentBaseUrl: string, effectiveProtocol: string): string {
  if (!isGoRootUrl(currentBaseUrl)) return currentBaseUrl;
  switch (effectiveProtocol) {
    case 'anthropic_messages':
      return ANTHROPIC_BASE_URL;
    case 'google_generate_content':
      return GOOGLE_BASE_URL;
    default:
      return OPENAI_BASE_URL;
  }
}

export function modelAdapterForProtocol(protocol: string): string {
  if (protocol === 'anthropic_messages') return 'anthropic';
  if (protocol === 'google_generate_content') return 'google';
  return 'general';
}

export function sessionHeaderValue(sessionId: string): string | null {
  const sanitized = [...sessionId.trim()]
    .filter((ch) => /[a-zA-Z0-9_.:-]/.test(ch))
    .slice(0, SESSION_HEADER_MAX_LEN)
    .join('');
  return sanitized === '' ? null : sanitized;
}

/** OpenCode Go 请求必须携带的身份头。 */
export function identityHeaders(sessionId: string, appVersion: string): [string, string][] {
  const headers: [string, string][] = [['User-Agent', userAgent(appVersion)]];
  const session = sessionHeaderValue(sessionId);
  if (session !== null) headers.push([SESSION_HEADER, session]);
  return headers;
}

// ------------------------------------------------------------------ 用量

export type OpenCodeGoUsageErrorKind = 'KeyExpired' | 'Unauthorized' | 'Http' | 'Network' | 'Malformed';

export class OpenCodeGoUsageError extends Error {
  readonly kind: OpenCodeGoUsageErrorKind;
  readonly status: number | null;
  constructor(kind: OpenCodeGoUsageErrorKind, detail: string | null = null, status: number | null = null) {
    super(
      kind === 'KeyExpired'
        ? 'OpenCode Go API Key 已过期，请在 OpenCode Console 重新生成后填入'
        : kind === 'Unauthorized'
          ? 'OpenCode Go 鉴权失败：API Key 无效，或该账号没有有效的 Go 订阅'
          : kind === 'Http'
            ? `OpenCode Go 用量接口返回 HTTP ${status}`
            : kind === 'Network'
              ? `无法连接 OpenCode Go：${detail}`
              : 'OpenCode Go 用量数据无法解析',
    );
    this.name = 'OpenCodeGoUsageError';
    this.kind = kind;
    this.status = status;
  }

  get category(): string {
    switch (this.kind) {
      case 'KeyExpired':
      case 'Unauthorized':
        return 'auth';
      case 'Http':
        return this.status === 429 ? 'rate_limit' : (this.status ?? 0) >= 500 ? 'server' : 'provider_error';
      case 'Network':
        return 'network';
      default:
        return 'format';
    }
  }
}

function valueAsF64(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function valueAsTimestampMs(value: unknown): number | null {
  if (typeof value === 'string') {
    const parsed = Date.parse(value.trim());
    if (!Number.isNaN(parsed)) return parsed;
  }
  const raw = valueAsF64(value);
  if (raw === null) return null;
  return Math.trunc(raw < 1_000_000_000_000 ? raw * 1000 : raw);
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseUsage(payload: unknown): OpenCodeGoUsage {
  const usage = objectOf(objectOf(payload)?.['usage']);
  if (usage === null) throw new OpenCodeGoUsageError('Malformed');
  const windows: OpenCodeGoUsageWindow[] = [];
  for (const [window, key] of [
    ['five_hour', 'rolling'],
    ['weekly', 'weekly'],
    ['monthly', 'monthly'],
  ] as const) {
    const entry = objectOf(usage[key]);
    if (entry === null) continue;
    const percent = valueAsF64(entry['percent']);
    if (percent === null) continue;
    windows.push({
      window,
      usedPercent: Math.min(100, Math.max(0, percent)),
      resetsAtMs: valueAsTimestampMs(entry['resetsAt']),
    });
  }
  if (windows.length === 0) throw new OpenCodeGoUsageError('Malformed');
  return { windows };
}

export function isKeyExpiredBody(body: unknown): boolean {
  const error = objectOf(objectOf(body)?.['error']);
  return error?.['code'] === 'api_key_expired';
}

/** 查询订阅用量；只读、不消耗额度、不产生推理流量。 */
export async function fetchUsage(
  apiKey: string, appVersion: string, fetchImpl: typeof fetch = fetch,
): Promise<OpenCodeGoUsage> {
  const key = apiKey.trim();
  if (key === '') throw new OpenCodeGoUsageError('Unauthorized');
  let response: Response;
  try {
    response = await fetchImpl(USAGE_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': userAgent(appVersion),
        [SESSION_HEADER]: USAGE_SESSION_ID,
        Authorization: `Bearer ${key}`,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new OpenCodeGoUsageError('Network', error instanceof Error ? error.message : String(error));
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  const status = response.status;
  if (status === 401 && isKeyExpiredBody(body)) throw new OpenCodeGoUsageError('KeyExpired');
  if (status === 401 || status === 403) throw new OpenCodeGoUsageError('Unauthorized');
  if (status < 200 || status >= 300) throw new OpenCodeGoUsageError('Http', null, status);
  return parseUsage(body);
}
