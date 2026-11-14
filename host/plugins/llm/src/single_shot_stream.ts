/**
 * Streamed transport for single-shot structured requests
 * (`llm_manager/single_shot_stream.rs`).
 *
 * Sends `stream: true` and bounds the request by an *idle* timeout plus a
 * generous hard cap instead of a fixed total time: a slow-but-progressing
 * generation is never cut, a silent gateway is. Reasoning chunks are counted
 * (activity) but discarded from the returned text.
 *
 * If a provider rejects streaming (HTTP 400/422 mentioning `stream`) the
 * request is retried once non-streaming and that config is remembered for the
 * rest of the process.
 *
 * Everything that touches the clock or the wire is injectable: `send` builds
 * and performs one attempt, `opts.cancel` is an `AbortSignal`, and the response
 * body is an async byte stream.
 */
import { AppError } from '../../../platform/errors/api.ts';
import type { ApiConfig } from '../api.ts';
import type { JsonValue, ProviderAdapter } from '../../llm-providers/api.ts';
import { redactSensitiveText } from '../../../platform/log/redact.ts';
import { logWarn } from './logging.ts';
import {
  asObject, emptyAccumulated, intoCompletion, isAppErrorLike, parseCompleteBody, readBodyLimited, readSseBody, truncateUtf8,
  type Accumulated,
} from './single_shot_body.ts';
import { removeKey } from './json_map.ts';
export { extractStreamDataPayload } from '../../../platform/util/portable.ts';
export { finishReasonFromBlock } from './single_shot_body.ts';

export type TransportMode = 'stream' | 'nonStream';

export function isStreamMode(mode: TransportMode): boolean {
  return mode === 'stream';
}

export const DEFAULT_HEADER_TIMEOUT_MS = 180_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 20 * 60_000;
export const DEFAULT_NONSTREAM_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_MAX_STREAM_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const RETRY_AFTER_CAP_MS = 60_000;

/** Timeouts / limits / retry budget for {@link runSingleShot}. */
export interface SingleShotOptions {
  label: string;
  headerTimeoutMs: number;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  nonstreamTimeoutMs: number;
  maxStreamBytes: number;
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  cancel?: AbortSignal;
}

export function defaultSingleShotOptions(label: string): SingleShotOptions {
  return {
    label,
    headerTimeoutMs: DEFAULT_HEADER_TIMEOUT_MS,
    idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
    totalTimeoutMs: DEFAULT_TOTAL_TIMEOUT_MS,
    nonstreamTimeoutMs: DEFAULT_NONSTREAM_TIMEOUT_MS,
    maxStreamBytes: DEFAULT_MAX_STREAM_BYTES,
    maxRetries: 2,
    backoffBaseMs: 2_000,
    backoffMaxMs: 30_000,
  };
}

/** Upper bound of one attempt in the given mode. */
export function attemptBudget(opts: SingleShotOptions, mode: TransportMode): number {
  return isStreamMode(mode) ? opts.totalTimeoutMs : opts.nonstreamTimeoutMs;
}

/** Result of a single-shot completion. */
export interface SingleShotCompletion {
  content: string;
  reasoningBytes: number;
  finishReason: string | null;
  usage: JsonValue | null;
  mode: TransportMode;
  attempts: number;
  interrupted: string | null;
  aborted: boolean;
}

/** One HTTP response handed back by a sender, plus the adapter that owns its state. */
export interface SingleShotResponse {
  status: number;
  headers: Record<string, string | undefined>;
  adapter: ProviderAdapter;
  isCodex: boolean;
  body: AsyncIterable<Uint8Array>;
  /** Drop the transport before retry/backoff or returning a partial completion. */
  close?(): Promise<void>;
}

export type SingleShotSender =
  (mode: TransportMode, requestTimeoutMs: number) => Promise<SingleShotResponse>;

export type DeltaCallback = (delta: string) => boolean;

// ---------------------------------------------------------------------------
// Process-lifetime memory of configs that reject `stream: true`.
// ---------------------------------------------------------------------------

const STREAM_UNSUPPORTED = new Set<string>();

function streamFallbackKey(config: Pick<ApiConfig, 'id' | 'baseUrl' | 'model'>): string {
  return `${config.id}\u001f${config.baseUrl.trim()}\u001f${config.model}`;
}

export function isStreamKnownUnsupported(config: Pick<ApiConfig, 'id' | 'baseUrl' | 'model'>): boolean {
  return STREAM_UNSUPPORTED.has(streamFallbackKey(config));
}

function rememberStreamUnsupported(config: Pick<ApiConfig, 'id' | 'baseUrl' | 'model'>): void {
  STREAM_UNSUPPORTED.add(streamFallbackKey(config));
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** 408/429 and 5xx (incl. Cloudflare 520-524, Anthropic 529) are transient. */
export function isRetryableHttpStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  if (status === 501 || status === 505) return false;
  return status >= 500 && status <= 599;
}

/** Whether a 400/422 body says the `stream` parameter itself is rejected. */
export function bodyRejectsStreaming(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  return body.toLowerCase().includes('stream');
}

export type AttemptFailure =
  | { kind: 'retryable'; error: AppError; retryAfterMs: number | null }
  | { kind: 'streamUnsupported'; error: AppError }
  | { kind: 'fatal'; error: AppError }
  | { kind: 'cancelled' };

function cancelledError(label: string): AppError {
  return AppError.llm(`${label} 请求已取消`);
}

function httpFailure(
  label: string,
  mode: TransportMode,
  status: number,
  body: string,
  retryAfterMs: number | null,
): AttemptFailure {
  const redacted = redactSensitiveText(body);
  const details: { [key: string]: JsonValue } = {
    status,
    body: truncateUtf8(redacted, 2_000),
    stream: isStreamMode(mode),
  };
  if (retryAfterMs !== null) {
    details.retry_after_seconds = Math.floor(retryAfterMs / 1_000);
    details.retry_after_ms = Math.round(retryAfterMs);
  }
  const error = AppError.with_details(
    'LLM',
    `${label} 接口返回错误 ${status}: ${truncateUtf8(redacted, 300)}`,
    details,
  );
  if (isStreamMode(mode) && bodyRejectsStreaming(status, body)) {
    return { kind: 'streamUnsupported', error };
  }
  if (isRetryableHttpStatus(status)) return { kind: 'retryable', error, retryAfterMs };
  return { kind: 'fatal', error };
}

function headerValue(headers: Record<string, string | undefined>, name: string): string | null {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value ?? null;
  }
  return null;
}

function parseRetryAfter(response: SingleShotResponse): number | null {
  const raw = headerValue(response.headers, 'retry-after');
  if (raw === null) return null;
  const seconds = Number(raw.trim());
  if (!Number.isInteger(seconds)) return null;
  return seconds * 1_000;
}

function isJsonContentType(response: SingleShotResponse): boolean {
  const raw = headerValue(response.headers, 'content-type');
  if (raw === null) return false;
  const mime = (raw.split(';')[0] ?? '').trim().toLowerCase();
  return mime === 'application/json' || mime.endsWith('+json');
}

// ---------------------------------------------------------------------------
// Timed await helpers (the clock is plain `setTimeout`)
// ---------------------------------------------------------------------------

type SentOutcome =
  | { kind: 'response'; response: SingleShotResponse }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'error'; error: unknown };

function awaitSend(
  send: SingleShotSender, mode: TransportMode, timeoutMs: number,
  headerBound: number, signal: AbortSignal | undefined,
): Promise<SentOutcome> {
  return new Promise<SentOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: SentOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(headerTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => finish({ kind: 'cancelled' });
    const headerTimer = setTimeout(() => finish({ kind: 'timeout' }), headerBound);
    if (signal !== undefined) {
      if (signal.aborted) { finish({ kind: 'cancelled' }); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    send(mode, timeoutMs).then(
      (response) => finish({ kind: 'response', response }),
      (error: unknown) => finish({ kind: 'error', error }),
    );
  });
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (completed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(completed);
    };
    const onAbort = (): void => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    if (signal !== undefined) {
      if (signal.aborted) { finish(false); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

type AttemptOutcome =
  | { ok: Accumulated }
  | { partial: Accumulated; failure: AttemptFailure };

/**
 * Run a single-shot completion with streaming transport, retries and the
 * stream-unsupported fallback.
 *
 * `send(mode, requestTimeoutMs)` must build a *fresh* provider request for the
 * given transport mode (with `stream` set accordingly) and send it.
 */
export async function runSingleShot(
  opts: SingleShotOptions,
  config: ApiConfig,
  send: SingleShotSender,
  onDelta?: DeltaCallback,
): Promise<SingleShotCompletion> {
  const label = opts.label;
  let mode: TransportMode = isStreamKnownUnsupported(config) ? 'nonStream' : 'stream';
  let fallbackUsed = false;
  let retries = 0;
  let attempts = 0;

  for (;;) {
    if (opts.cancel?.aborted === true) throw cancelledError(label);
    attempts += 1;
    const requestTimeout = attemptBudget(opts, mode);
    const deadline = Date.now() + requestTimeout;
    // A streaming server answers headers before generation finishes; a
    // non-streaming one only after, so only stream mode gets a header bound.
    const headerBound = isStreamMode(mode)
      ? Math.min(opts.headerTimeoutMs, requestTimeout)
      : requestTimeout;

    const sent = await awaitSend(send, mode, requestTimeout, headerBound, opts.cancel);
    let outcome: AttemptOutcome;

    if (sent.kind === 'cancelled') throw cancelledError(label);
    if (sent.kind === 'error') {
      const failure: AttemptFailure = isAppErrorLike(sent.error) && sent.error.error_type === 'Network'
        ? { kind: 'retryable', error: sent.error, retryAfterMs: null }
        : { kind: 'fatal', error: isAppErrorLike(sent.error) ? sent.error : AppError.llm(String(sent.error)) };
      outcome = { partial: emptyAccumulated(), failure };
    } else if (sent.kind === 'timeout') {
      outcome = {
        partial: emptyAccumulated(),
        failure: {
          kind: 'retryable',
          error: AppError.network(
            `${label} 等待响应头超时（${headerBound / 1_000}s）`,
          ),
          retryAfterMs: null,
        },
      };
    } else {
      const response = sent.response;
      try {
      if (response.status < 200 || response.status >= 300) {
        const retryAfterMs = parseRetryAfter(response);
        const read = await readBodyLimited(
          response, label, MAX_ERROR_BODY_BYTES, deadline, opts.cancel, true,
        );
        const body = typeof read === 'string' ? read : '';
        outcome = {
          partial: emptyAccumulated(),
          failure: httpFailure(label, mode, response.status, body, retryAfterMs),
        };
      } else if (isStreamMode(mode) && !(isJsonContentType(response) && !response.isCodex)) {
        const read = await readSseBody(response, opts, deadline, onDelta);
        outcome = read.failure === null
          ? { ok: read.acc }
          : { partial: read.acc, failure: read.failure };
      } else {
        // Non-streaming fallback, or a provider that ignored `stream: true`
        // and answered with one JSON document.
        const read = await readBodyLimited(
          response, label, opts.maxStreamBytes, deadline, opts.cancel, false,
        );
        if (typeof read === 'string') {
          const parsed = parseCompleteBody(label, read, config, response, onDelta);
          outcome = parsed.failure === null
            ? { ok: parsed.acc }
            : { partial: parsed.acc, failure: parsed.failure };
        } else {
          outcome = { partial: emptyAccumulated(), failure: read.failure };
        }
      }
      } finally { await response.close?.(); }
    }

    if ('ok' in outcome) return intoCompletion(outcome.ok, mode, attempts);
    const { partial, failure } = outcome;

    // Content already handed to the caller cannot be retried without
    // duplicating it; return the partial answer and let the caller decide.
    if (partial.delivered) {
      if (failure.kind === 'cancelled') throw cancelledError(label);
      const completion = intoCompletion(partial, mode, attempts);
      completion.interrupted = failure.error.message;
      logWarn(`[SingleShot] ${label} 流式中断，已向调用方交付 ${Array.from(partial.content).length} 字符，不再重试: ${failure.error.message}`);
      return completion;
    }

    if (failure.kind === 'cancelled') throw cancelledError(label);
    if (failure.kind === 'fatal') throw failure.error;
    if (failure.kind === 'streamUnsupported') {
      if (fallbackUsed) throw failure.error;
      fallbackUsed = true;
      logWarn(`[SingleShot] ${label} 流式参数被拒绝，回退非流式: ${failure.error.message}`);
      rememberStreamUnsupported(config);
      mode = 'nonStream';
      continue;
    }

    if (retries >= opts.maxRetries) throw failure.error;
    retries += 1;
    const backoff = Math.min(
      opts.backoffBaseMs * 2 ** Math.min(retries - 1, 16),
      opts.backoffMaxMs,
    );
    const delay = failure.retryAfterMs === null
      ? backoff
      : Math.min(failure.retryAfterMs, RETRY_AFTER_CAP_MS);
    const completed = await sleep(delay, opts.cancel);
    if (!completed) throw cancelledError(label);
  }
}

/** Request body for a transport mode: `stream` is overwritten per attempt. */
export function bodyForMode(body: JsonValue, mode: TransportMode): JsonValue {
  const cloned = structuredClone(body);
  const obj = asObject(cloned);
  if (obj !== null) {
    obj.stream = isStreamMode(mode);
    if (!isStreamMode(mode)) removeKey(obj, 'stream_options');
  }
  return cloned;
}
