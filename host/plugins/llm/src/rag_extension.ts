/**
 * RAG 扩展的请求体与嵌入错误分类（移植
 * `dstu-llm/src/llm_manager/rag_extension.rs` 中可独立复用的部分）。
 */
import type { ApiConfig } from '../api.ts';
import { AppError, type JsonValue } from '../../../platform/errors/api.ts';
import { effectiveMaxTokens } from './generation.ts';
import { tagEstablishFailure } from './routing.ts';
import { rustTrim } from '../../../platform/util/portable.ts';

export type JsonObject = { [key: string]: JsonValue };

/** 嵌入/重排序请求体（rag_extension.rs:18 `rag_translation_request_body`）。 */
export function ragTranslationRequestBody(
  config: ApiConfig, messages: readonly JsonValue[],
): JsonObject {
  return {
    model: config.model,
    messages: [...messages],
    temperature: 0.3,
    max_tokens: effectiveMaxTokens(config.maxOutputTokens, config.maxTokensLimit),
    stream: false,
  };
}

/** 嵌入/重排序 HTTP 错误的结构化分类（写入 `details.embedding_error`）。 */
export type EmbeddingErrorKind =
  | 'Auth'
  | 'RateLimited'
  | 'InvalidRequest'
  | 'Server'
  | 'Network'
  | 'Unknown';

export function embeddingErrorKindFromStatus(status: number): EmbeddingErrorKind {
  if (status === 401 || status === 403) return 'Auth';
  if (status === 429) return 'RateLimited';
  if (status === 400 || status === 404 || status === 422) return 'InvalidRequest';
  if (status === 408 || (status >= 500 && status <= 599)) return 'Server';
  return 'Unknown';
}

/** 写入 details 的稳定字符串值。 */
export function embeddingErrorKindAsStr(kind: EmbeddingErrorKind): string {
  switch (kind) {
    case 'Auth': return 'auth';
    case 'RateLimited': return 'rate_limited';
    case 'InvalidRequest': return 'invalid_request';
    case 'Server': return 'server';
    case 'Network': return 'network';
    case 'Unknown': return 'unknown';
  }
}

/** 解析 Retry-After 响应头（仅支持秒数形式；HTTP-date 形式返回 null）。 */
export function parseRetryAfterSecs(headers: Headers): number | bigint | null {
  const raw = headers.get('retry-after');
  if (raw === null) return null;
  // HeaderValue::to_str only accepts visible ASCII; u64::from_str allows '+'.
  if (!/^[\t\x20-\x7e]*$/.test(raw)) return null;
  const trimmed = rustTrim(raw);
  if (!/^\+?\d+$/.test(trimmed)) return null;
  const value = BigInt(trimmed);
  if (value > 0xffff_ffff_ffff_ffffn) return null;
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

function objectOf(value: JsonValue | undefined): { [key: string]: JsonValue } | null {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
    ? value : null;
}

/** 从结构化错误中读取服务端建议的 Retry-After 秒数。 */
export function embeddingErrorRetryAfterSecs(error: { details: unknown }): number | bigint | null {
  const embedding = errorObject(errorObject(error.details)?.embedding_error);
  const value = embedding?.retry_after_secs;
  if (typeof value === 'bigint') return value >= 0n && value <= 0xffff_ffff_ffff_ffffn ? value : null;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 2 ** 64 ? value : null;
}

function errorObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** 从结构化错误中读取错误分类字符串。 */
export function embeddingErrorKind(error: { details: unknown }): string | null {
  const embedding = errorObject(errorObject(error.details)?.embedding_error);
  const value = embedding?.kind;
  return typeof value === 'string' ? value : null;
}

/**
 * 为嵌入类调用错误附加结构化元数据：
 * - `details.llm_failover`：复用 routing 的建立阶段打标；
 * - `details.embedding_error`：kind / http_status / retry_after_secs。
 */
export type EmbeddingFailure = Omit<AppError, 'details'> & { details: JsonValue | {
  [key: string]: JsonValue | { kind: string; http_status: number | null; retry_after_secs: number | bigint | null };
} };

export function tagEmbeddingFailure(
  error: AppError, httpStatus: number | null, retryAfterSecs: number | bigint | null,
): EmbeddingFailure {
  const kind = httpStatus === null
    ? 'Network'
    : embeddingErrorKindFromStatus(httpStatus);
  const tagged = tagEstablishFailure(error, httpStatus);
  const details = objectOf(tagged.details);
  if (details === null) return tagged;
  return { ...tagged, details: { ...details, embedding_error: {
    kind: embeddingErrorKindAsStr(kind),
    http_status: httpStatus,
    retry_after_secs: retryAfterSecs,
  } } };
}
