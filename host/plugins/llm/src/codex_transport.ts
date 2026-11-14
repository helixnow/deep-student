/**
 * OpenAI Codex OAuth 非流式响应桥接（model2_pipeline.rs
 * read_codex_response_body_limited / normalize_codex_error_response /
 * bridge_codex_nonstream_response）。
 *
 * Codex 的后端在非流式请求上仍可能返回 SSE：这里把它折叠为标准 Responses
 * JSON；错误响应则只保留稳定的错误码，避免把上游多余信息透传给调用方。
 */
import { codexSseToResponsesJson, type JsonObject } from '../../llm-providers/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { logWarn } from './logging.ts';

export const CODEX_ERROR_RESPONSE_BODY_LIMIT_BYTES = 256 * 1024;
export const CODEX_NONSTREAM_SSE_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

const DROPPED_HEADERS = ['content-length', 'content-encoding', 'transfer-encoding'];

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

async function readBodyWithLimit(response: Response, limit: number, context: string): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number.parseInt(declared, 10);
    if (Number.isFinite(length) && length > limit) {
      throw AppError.llm(`OpenAI Codex ${context}超过大小限制`);
    }
  }
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > limit) {
        throw AppError.llm(`OpenAI Codex ${context}超过大小限制`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error !== null && typeof error === 'object'
      && (error as { error_type?: unknown }).error_type === 'LLM') {
      throw error;
    }
    throw AppError.llm(`读取 OpenAI Codex ${context}失败`);
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** 读取 Codex 响应体并强制大小上限（超限/读取失败都转为 LLM 错误）。 */
export async function readCodexResponseBodyLimited(
  response: Response,
  limit: number,
  context: string,
): Promise<Uint8Array> {
  return readBodyWithLimit(response, limit, context);
}

function isCodexUsageLimitBody(body: string): boolean {
  const lower = body.toLowerCase();
  return lower.includes('usage_limit_reached')
    || lower.includes('usage_not_included')
    || lower.includes('rate_limit_exceeded')
    || lower.includes('usage limit');
}

function sanitizeCodexErrorCode(value: string): string | null {
  const code = [...value]
    .filter((character) => /[A-Za-z0-9_.-]/.test(character))
    .slice(0, 64)
    .join('');
  return code === '' ? null : code;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function objectField(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : null;
}

/** 错误体 → 稳定错误码（`/error/code` → `error` → `code` → `/detail/code`）。 */
export function codexErrorCode(body: string, status: number): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    parsed = undefined;
  }
  const object = objectField(parsed);
  const errorValue = object?.error;
  const fromErrorObject = objectField(errorValue)?.code;
  const candidate = stringField(fromErrorObject)
    ?? stringField(errorValue)
    ?? stringField(object?.code)
    ?? stringField(objectField(object?.detail)?.code);
  if (candidate !== null) {
    const sanitized = sanitizeCodexErrorCode(candidate);
    if (sanitized !== null) return sanitized;
  }
  const lower = body.toLowerCase();
  for (const known of ['usage_limit_reached', 'usage_not_included', 'rate_limit_exceeded']) {
    if (lower.includes(known)) return known;
  }
  return `http_${status}`;
}

function rebuildResponse(
  status: number,
  headers: Headers,
  body: string,
  forceJsonContentType: boolean,
): Response {
  const rebuilt = new Headers(headers);
  for (const name of DROPPED_HEADERS) rebuilt.delete(name);
  if (forceJsonContentType) rebuilt.set('content-type', 'application/json; charset=utf-8');
  return new Response(body, { status, headers: rebuilt });
}

/**
 * Codex 错误响应归一化：404 + usage limit 映射为 429，响应体只保留
 * `{error:{code,message}}`（丢弃上游原始 message）。
 */
export async function normalizeCodexErrorResponse(response: Response): Promise<Response> {
  if (isSuccess(response.status)) return response;
  const status = response.status;
  const headers = response.headers;
  const bodyBytes = await readCodexResponseBodyLimited(
    response, CODEX_ERROR_RESPONSE_BODY_LIMIT_BYTES, '错误响应',
  );
  const body = new TextDecoder('utf-8').decode(bodyBytes);
  const code = codexErrorCode(body, status);
  const mappedStatus = status === 404 && isCodexUsageLimitBody(body) ? 429 : status;
  const safeBody = JSON.stringify({
    error: { code, message: 'OpenAI Codex request failed' },
  });
  return rebuildResponse(mappedStatus, headers, safeBody, true);
}

function isEventStreamContentType(value: string | null): boolean {
  if (value === null) return false;
  const mime = value.split(';')[0]?.trim().toLowerCase() ?? '';
  return mime === 'text/event-stream';
}

/** 成功响应若仍是 SSE，则折叠为标准 Responses JSON。 */
export async function bridgeCodexNonstreamResponse(response: Response): Promise<Response> {
  if (!isSuccess(response.status)
    || !isEventStreamContentType(response.headers.get('content-type'))) {
    return response;
  }
  const status = response.status;
  const headers = response.headers;
  const sseBytes = await readCodexResponseBodyLimited(
    response, CODEX_NONSTREAM_SSE_BODY_LIMIT_BYTES, 'SSE 响应',
  );
  let sse: string;
  try {
    sse = new TextDecoder('utf-8', { fatal: true }).decode(sseBytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw AppError.llm('OpenAI Codex SSE 响应不是有效 UTF-8');
  }
  let canonical: JsonObject;
  try {
    canonical = codexSseToResponsesJson(sse);
  } catch (error) {
    logWarn(`[OpenAI Codex OAuth] failed to bridge SSE response: ${error instanceof Error ? error.message : String(error)}`);
    throw AppError.llm('OpenAI Codex 响应流不完整或格式无效');
  }
  return rebuildResponse(status, headers, JSON.stringify(canonical), true);
}
