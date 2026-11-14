/**
 * Codex response normalization and non-stream bridging
 * (`model2_pipeline.rs` normalize_codex_error_response /
 * bridge_codex_nonstream_response / rebuild_codex_response).
 */
import type { PluginLogger } from '../../api.ts';
import { AppError } from '../../../../platform/errors/api.ts';
import { decodeUtf8Strict } from '../../../../platform/util/portable.ts';
import { field, object, parseJson, string } from '../json.ts';
import { codexSseToResponsesJson } from './protocol.ts';

/** model2_pipeline.rs:54. */
export const CODEX_ERROR_RESPONSE_BODY_LIMIT_BYTES = 256 * 1024;
/** model2_pipeline.rs:55. */
export const CODEX_NONSTREAM_SSE_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

const CONTENT_TYPE = 'content-type';

function isSuccess(response: Response): boolean {
  return response.status >= 200 && response.status < 300;
}

function isEventStream(response: Response): boolean {
  const raw = response.headers.get(CONTENT_TYPE);
  if (raw === null) return false;
  // reqwest HeaderValue::to_str accepts visible ASCII plus HTAB, not obs-text.
  // Validate the whole value before splitting off MIME parameters (Rust :4726).
  if (/[^\t\x20-\x7e]/.test(raw)) return false;
  const mime = (raw.split(';')[0] ?? '').trim().toLowerCase();
  return mime === 'text/event-stream';
}

/** `read_codex_response_body_limited`; bounded streaming read, never buffers past the limit. */
export async function readCodexResponseBodyLimited(
  response: Response, limit: number, context: string, logger?: PluginLogger,
): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > limit) {
      throw AppError.llm(`OpenAI Codex ${context}超过大小限制`);
    }
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let next: ReadableStreamReadResult<Uint8Array>;
    try {
      next = await reader.read();
    } catch (error) {
      logger?.warn(
        `[OpenAI Codex OAuth] failed to read ${context}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw AppError.llm(`读取 OpenAI Codex ${context}失败`);
    }
    if (next.done) break;
    const value = next.value;
    total += value.byteLength;
    if (total > limit) {
      void reader.cancel().catch(() => undefined);
      throw AppError.llm(`OpenAI Codex ${context}超过大小限制`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** `rebuild_codex_response`: strip transport headers and force JSON when requested. */
function rebuildCodexResponse(
  status: number, headers: Headers, body: string, forceJsonContentType: boolean,
): Response {
  const rebuilt = new Headers(headers);
  rebuilt.delete('content-length');
  rebuilt.delete('content-encoding');
  rebuilt.delete('transfer-encoding');
  if (forceJsonContentType) rebuilt.set(CONTENT_TYPE, 'application/json; charset=utf-8');
  try {
    return new Response(body, { status, headers: rebuilt });
  } catch {
    throw AppError.llm('无法重建 OpenAI Codex 响应');
  }
}

/** model2_pipeline.rs:4611 `is_codex_usage_limit_body`. */
export function isCodexUsageLimitBody(body: string): boolean {
  const lower = body.toLowerCase();
  return lower.includes('usage_limit_reached')
    || lower.includes('usage_not_included')
    || lower.includes('rate_limit_exceeded')
    || lower.includes('usage limit');
}

/** model2_pipeline.rs:4623 `sanitize_codex_error_code`. */
function sanitizeCodexErrorCode(value: string): string | undefined {
  const code = [...value]
    .filter(char => /[A-Za-z0-9_.-]/.test(char))
    .join('')
    .slice(0, 64);
  return code === '' ? undefined : code;
}

/** model2_pipeline.rs:4628 `codex_error_code`. */
export function codexErrorCode(body: string, status: number): string {
  const parsed = parseJson(body);
  const error = field(parsed, 'error');
  // Rust's Option chain stops at the first *string*, including an empty one:
  // /error/code -> error(string) -> code -> /detail/code. Sanitization happens
  // once after the chain; an empty/invalid first string falls through to the
  // keyword/HTTP fallback rather than trying the next field.
  const candidate = string(field(error, 'code'))
    ?? (typeof error === 'string' ? error : undefined)
    ?? string(field(parsed, 'code'))
    ?? string(field(field(parsed, 'detail'), 'code'));
  if (candidate !== undefined) {
    const sanitized = sanitizeCodexErrorCode(candidate);
    if (sanitized !== undefined) return sanitized;
  }
  const lower = body.toLowerCase();
  for (const code of ['usage_limit_reached', 'usage_not_included', 'rate_limit_exceeded']) {
    if (lower.includes(code)) return code;
  }
  return `http_${status}`;
}

/**
 * model2_pipeline.rs:4690 `normalize_codex_error_response`.
 *
 * Non-2xx bodies are read with a hard bound, reduced to a sanitized error code,
 * and rebuilt so upstream messages/headers never reach the caller. A 404 whose
 * body is a usage-limit response is mapped to 429 for retry classification.
 */
export async function normalizeCodexErrorResponse(
  response: Response, logger?: PluginLogger,
): Promise<Response> {
  if (isSuccess(response)) return response;
  const status = response.status;
  const bodyBytes = await readCodexResponseBodyLimited(
    response, CODEX_ERROR_RESPONSE_BODY_LIMIT_BYTES, '错误响应', logger,
  );
  // String::from_utf8_lossy preserves a leading BOM; TextDecoder strips it by
  // default. ignoreBOM=true retains it without changing this lossy branch.
  const body = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bodyBytes);
  const code = codexErrorCode(body, status);
  const mappedStatus = status === 404 && isCodexUsageLimitBody(body) ? 429 : status;
  const safeBody = JSON.stringify({
    error: { code, message: 'OpenAI Codex request failed' },
  });
  return rebuildCodexResponse(mappedStatus, response.headers, safeBody, true);
}

/**
 * model2_pipeline.rs:4722 `bridge_codex_nonstream_response`.
 *
 * Successful `text/event-stream` responses are read with a 32 MiB bound,
 * decoded as strict UTF-8, converted to the canonical Responses JSON object,
 * and rebuilt as an application/json response. Non-SSE responses pass through.
 */
export async function bridgeCodexNonstreamResponse(
  response: Response, logger?: PluginLogger,
): Promise<Response> {
  if (!isSuccess(response) || !isEventStream(response)) return response;
  const status = response.status;
  const bodyBytes = await readCodexResponseBodyLimited(
    response, CODEX_NONSTREAM_SSE_BODY_LIMIT_BYTES, 'SSE 响应', logger,
  );
  let sse: string;
  try {
    sse = decodeUtf8Strict(bodyBytes);
  } catch {
    throw AppError.llm('OpenAI Codex SSE 响应不是有效 UTF-8');
  }
  let canonical;
  try {
    canonical = codexSseToResponsesJson(sse);
  } catch (error) {
    logger?.warn(
      `[OpenAI Codex OAuth] failed to bridge SSE response: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw AppError.llm('OpenAI Codex 响应流不完整或格式无效');
  }
  let body: string;
  try {
    body = JSON.stringify(canonical);
  } catch {
    throw AppError.llm('无法序列化 OpenAI Codex 响应');
  }
  return rebuildCodexResponse(status, response.headers, body, true);
}
