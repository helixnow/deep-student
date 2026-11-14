/**
 * Response bodies for single_shot_stream.ts (`llm_manager/single_shot_stream.rs`): SSE framing and accumulation,
 * the bounded stream and complete-body readers, and the non-streaming completion parse.
 */
import { AppError } from '../../../platform/errors/api.ts';
import type { AppError as AppErrorValue } from '../../../platform/errors/api.ts';
import type { ApiConfig } from '../api.ts';
import {
  convertAnthropicResponseToOpenai, convertGeminiNonstreamResponseToOpenai,
  normalizeOpenaiNonstreamResponse,
  type JsonValue, type ProviderAdapter, type StreamEvent,
} from '../../llm-providers/api.ts';
import { effectiveApiProtocolForConfig } from './protocol.ts';
import { SseEventBuffer, decodeUtf8Lossy, encodeUtf8, extractStreamDataPayload, utf8ByteLength } from '../../../platform/util/portable.ts';
import type {
  AttemptFailure, DeltaCallback, SingleShotCompletion, SingleShotOptions, SingleShotResponse, TransportMode,
} from './single_shot_stream.ts';

export function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = encodeUtf8(text);
  if (bytes.length <= maxBytes) return text;
  return decodeUtf8Lossy(bytes.subarray(0, maxBytes)).replace(/\uFFFD+$/, '');
}

export function isAppErrorLike(value: unknown): value is AppErrorValue {
  return value !== null && typeof value === 'object'
    && typeof (value as AppErrorValue).error_type === 'string'
    && typeof (value as AppErrorValue).message === 'string';
}

// ---------------------------------------------------------------------------
// SSE framing
// ---------------------------------------------------------------------------

function isDoneMarker(block: string): boolean {
  return SseEventBuffer.checkDoneMarker(block);
}

// ---------------------------------------------------------------------------
// Stream accumulation
// ---------------------------------------------------------------------------

export interface Accumulated {
  content: string;
  reasoningBytes: number;
  finishReason: string | null;
  usage: JsonValue | null;
  delivered: boolean;
  aborted: boolean;
  done: boolean;
}

export function emptyAccumulated(): Accumulated {
  return {
    content: '', reasoningBytes: 0, finishReason: null, usage: null,
    delivered: false, aborted: false, done: false,
  };
}

export function asObject(value: JsonValue | null | undefined): { [key: string]: JsonValue } | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function mergeUsage(acc: Accumulated, incoming: JsonValue): void {
  const source = asObject(incoming);
  if (source === null) return;
  acc.usage ??= {};
  const merged = asObject(acc.usage);
  if (merged === null) return;
  for (const [key, value] of Object.entries(source)) {
    // Anthropic splits usage across message_start/message_delta; keeping the
    // first non-zero value avoids clobbering it with a later 0.
    const keepExisting = value === 0
      && typeof merged[key] === 'number' && merged[key] !== 0;
    if (!keepExisting) merged[key] = value;
  }
}

function pushContent(
  acc: Accumulated, text: string, onDelta: DeltaCallback | undefined,
): void {
  if (text === '') return;
  acc.content += text;
  if (onDelta !== undefined) {
    acc.delivered = true;
    if (!onDelta(text)) acc.aborted = true;
  }
}

/** Best-effort finish reason from a raw SSE block across provider formats. */
export function finishReasonFromBlock(block: string): string | null {
  const payload = extractStreamDataPayload(block);
  if (payload === null) return null;
  let value: JsonValue;
  try {
    value = JSON.parse(payload.trim()) as JsonValue;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const obj = asObject(value);
  if (obj === null) return null;
  const asReason = (v: JsonValue | undefined): string | null => {
    if (typeof v !== 'string') return null;
    const trimmed = v.trim();
    return trimmed === '' ? null : trimmed;
  };
  const choices = obj.choices;
  const firstChoice = Array.isArray(choices) ? asObject(choices[0] ?? null) : null;
  const delta = asObject(obj.delta);
  const candidates = obj.candidates;
  const firstCandidate = Array.isArray(candidates) ? asObject(candidates[0] ?? null) : null;
  const response = asObject(obj.response);
  return asReason(firstChoice?.finish_reason)
    ?? asReason(delta?.stop_reason)
    ?? asReason(firstCandidate?.finishReason)
    ?? asReason(asObject(response?.incomplete_details)?.reason)
    ?? (obj.type === 'response.completed' ? 'completed' : null);
}

function handleEvents(
  label: string,
  events: StreamEvent[],
  acc: Accumulated,
  onDelta: DeltaCallback | undefined,
): AttemptFailure | null {
  for (const event of events) {
    switch (event.type) {
      case 'ContentChunk':
        pushContent(acc, event.value as string, onDelta);
        break;
      case 'ReasoningChunk':
        acc.reasoningBytes += utf8ByteLength(event.value as string);
        break;
      case 'Usage':
        mergeUsage(acc, event.value);
        break;
      case 'Done':
        acc.done = true;
        break;
      case 'SafetyBlocked': {
        const info = asObject(event.value);
        const reason = typeof info?.reason === 'string' ? info.reason : '';
        const isProviderError = info?.type === 'provider_error';
        if (reason === 'length') {
          // Output budget exhausted: hand back what we have.
          acc.finishReason = 'length';
          acc.done = true;
        } else if (isProviderError && (reason === 'stream_error' || reason === 'insufficient_system_resource')) {
          return {
            kind: 'retryable',
            error: AppError.with_details(
              'Network',
              `${label} 流式响应中途报错: ${reason}`,
              (info ?? null) as JsonValue,
            ),
            retryAfterMs: null,
          };
        } else {
          return {
            kind: 'fatal',
            error: AppError.with_details(
              'LLM',
              `${label} 请求被供应商终止: ${reason === '' ? 'blocked' : reason}`,
              (info ?? null) as JsonValue,
            ),
          };
        }
        break;
      }
      default:
        break;
    }
    if (acc.aborted || acc.done) break;
  }
  return null;
}

function handleBlock(
  label: string,
  block: string,
  adapter: ProviderAdapter,
  acc: Accumulated,
  onDelta: DeltaCallback | undefined,
): AttemptFailure | null {
  const reason = finishReasonFromBlock(block);
  if (reason !== null && acc.finishReason === null) acc.finishReason = reason;
  const doneMarker = isDoneMarker(block);
  const failure = handleEvents(label, adapter.parseStream(block), acc, onDelta);
  if (failure !== null) return failure;
  if (doneMarker) acc.done = true;
  return null;
}

// ---------------------------------------------------------------------------
// Timed await helpers (the clock is plain `setTimeout`)
// ---------------------------------------------------------------------------

type NextOutcome =
  | { kind: 'chunk'; value: Uint8Array }
  | { kind: 'end' }
  | { kind: 'idle' }
  | { kind: 'total' }
  | { kind: 'cancelled' }
  | { kind: 'error'; error: unknown };

function awaitNext(
  iterator: AsyncIterator<Uint8Array>,
  idleMs: number,
  remainingMs: number,
  signal: AbortSignal | undefined,
): Promise<NextOutcome> {
  if (remainingMs <= 0) return Promise.resolve({ kind: 'total' });
  return new Promise<NextOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: NextOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => finish({ kind: 'cancelled' });
    const idleTimer = setTimeout(() => finish({ kind: 'idle' }), idleMs);
    const totalTimer = setTimeout(() => finish({ kind: 'total' }), remainingMs);
    if (signal !== undefined) {
      if (signal.aborted) { finish({ kind: 'cancelled' }); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    iterator.next().then(
      (result) => finish(result.done === true ? { kind: 'end' } : { kind: 'chunk', value: result.value }),
      (error: unknown) => finish({ kind: 'error', error }),
    );
  });
}

// ---------------------------------------------------------------------------
// Body readers
// ---------------------------------------------------------------------------

interface BodyReadFailure {
  failure: AttemptFailure;
}

export async function readSseBody(
  response: SingleShotResponse,
  opts: SingleShotOptions,
  deadline: number,
  onDelta: DeltaCallback | undefined,
): Promise<{ acc: Accumulated; failure: AttemptFailure | null }> {
  const label = opts.label;
  const acc = emptyAccumulated();
  const iterator = response.body[Symbol.asyncIterator]();
  const buffer = new SseEventBuffer();
  let received = 0;

  for (;;) {
    const outcome = await awaitNext(
      iterator, opts.idleTimeoutMs, deadline - Date.now(), opts.cancel,
    );
    if (outcome.kind === 'cancelled') return { acc, failure: { kind: 'cancelled' } };
    if (outcome.kind === 'total') {
      return {
        acc,
        failure: {
          kind: 'fatal',
          error: AppError.network(
            `${label} 流式响应超过总时长上限 ${Math.floor(opts.totalTimeoutMs / 1_000)}s`,
          ),
        },
      };
    }
    if (outcome.kind === 'idle') {
      return {
        acc,
        failure: {
          kind: 'retryable',
          error: AppError.network(
            `${label} 流式响应空闲超过 ${opts.idleTimeoutMs / 1_000}s 无数据`,
          ),
          retryAfterMs: null,
        },
      };
    }
    if (outcome.kind === 'error') {
      const detail = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      return {
        acc,
        failure: {
          kind: 'retryable',
          error: AppError.network(`${label} 流式读取中断: ${detail}`),
          retryAfterMs: null,
        },
      };
    }
    if (outcome.kind === 'end') break;

    received += outcome.value.length;
    if (received > opts.maxStreamBytes) {
      return {
        acc,
        failure: {
          kind: 'fatal',
          error: AppError.llm(`${label} 流式响应超过大小上限 ${opts.maxStreamBytes} bytes`),
        },
      };
    }
    for (const block of buffer.processBytes(outcome.value)) {
      const failure = handleBlock(label, block, response.adapter, acc, onDelta);
      if (failure !== null) return { acc, failure };
      if (acc.done || acc.aborted) return { acc, failure: null };
    }
  }

  // Transport EOF: drain a trailing event without a blank-line terminator,
  // then let stateful adapters resolve a finish reason without `[DONE]`.
  for (const block of buffer.flush()) {
    const failure = handleBlock(label, block, response.adapter, acc, onDelta);
    if (failure !== null) return { acc, failure };
    if (acc.done || acc.aborted) return { acc, failure: null };
  }
  return finishSseBody(label, response.adapter, acc, onDelta);
}

function finishSseBody(
  label: string, adapter: ProviderAdapter, acc: Accumulated, onDelta: DeltaCallback | undefined,
): { acc: Accumulated; failure: AttemptFailure | null } {
  const finishFailure = handleEvents(label, adapter.finishStream(), acc, onDelta);
  if (finishFailure !== null) return { acc, failure: finishFailure };
  if (!acc.done && !acc.aborted && adapter.requiresExplicitStreamCompletion()) {
    return {
      acc,
      failure: {
        kind: 'retryable',
        error: AppError.network(`${label} 流式响应提前结束（未收到结束标记）`),
        retryAfterMs: null,
      },
    };
  }
  return { acc, failure: null };
}

export async function readBodyLimited(
  response: SingleShotResponse,
  label: string,
  limit: number,
  deadline: number,
  cancel: AbortSignal | undefined,
  truncate: boolean,
): Promise<string | BodyReadFailure> {
  const iterator = response.body[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        failure: {
          kind: 'retryable',
          error: AppError.network(`${label} 读取响应超时`),
          retryAfterMs: null,
        },
      };
    }
    const outcome = await awaitNext(iterator, remaining, remaining, cancel);
    if (outcome.kind === 'cancelled') return { failure: { kind: 'cancelled' } };
    if (outcome.kind === 'total' || outcome.kind === 'idle') {
      return {
        failure: {
          kind: 'retryable',
          error: AppError.network(`${label} 读取响应超时`),
          retryAfterMs: null,
        },
      };
    }
    if (outcome.kind === 'error') {
      const detail = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      return {
        failure: {
          kind: 'retryable',
          error: AppError.network(`${label} 读取响应失败: ${detail}`),
          retryAfterMs: null,
        },
      };
    }
    if (outcome.kind === 'end') break;
    if (length + outcome.value.length > limit) {
      if (truncate) {
        const room = Math.max(0, limit - length);
        chunks.push(outcome.value.subarray(0, room));
        length += room;
        break;
      }
      return {
        failure: {
          kind: 'fatal',
          error: AppError.llm(`${label} 响应超过大小上限 ${limit} bytes`),
        },
      };
    }
    chunks.push(outcome.value);
    length += outcome.value.length;
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  return decodeUtf8Lossy(joined);
}

// ---------------------------------------------------------------------------
// Non-streaming body
// ---------------------------------------------------------------------------

function normalizeNonstreamResponseToOpenai(config: ApiConfig, json: JsonValue): JsonValue {
  switch (effectiveApiProtocolForConfig(config)) {
    case 'anthropic_messages': {
      const converted = convertAnthropicResponseToOpenai(json, config.model);
      if (converted === undefined) throw AppError.llm('Anthropic 响应格式无法转换为 OpenAI 格式');
      return converted;
    }
    case 'google_generate_content':
      return convertGeminiNonstreamResponseToOpenai(json, config.model);
    default:
      return normalizeOpenaiNonstreamResponse(json);
  }
}

export function parseCompleteBody(
  label: string,
  body: string,
  config: ApiConfig,
  response: SingleShotResponse,
  onDelta: DeltaCallback | undefined,
): { acc: Accumulated; failure: AttemptFailure | null } {
  let parsed: JsonValue | undefined;
  try {
    parsed = JSON.parse(body.trim()) as JsonValue;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }

  if (parsed === undefined) {
    // Not JSON: some gateways send SSE with a JSON content type.
    if (body.includes('data:')) {
      const acc = emptyAccumulated();
      const buffer = new SseEventBuffer();
      const blocks = [
        ...buffer.processBytes(encodeUtf8(body)),
        ...buffer.flush(),
      ];
      for (const block of blocks) {
        const failure = handleBlock(label, block, response.adapter, acc, onDelta);
        if (failure !== null) return { acc, failure };
        if (acc.done || acc.aborted) return { acc, failure: null };
      }
      return finishSseBody(label, response.adapter, acc, onDelta);
    }
    return {
      acc: emptyAccumulated(),
      failure: {
        kind: 'fatal',
        error: AppError.llm(`${label} 响应不是有效 JSON: ${truncateUtf8(body, 200)}`),
      },
    };
  }

  let openaiLike: JsonValue;
  try {
    openaiLike = normalizeNonstreamResponseToOpenai(config, parsed);
  } catch (error) {
    return {
      acc: emptyAccumulated(),
      failure: { kind: 'fatal', error: isAppErrorLike(error) ? error : AppError.llm(String(error)) },
    };
  }

  const acc = emptyAccumulated();
  const choices = asObject(openaiLike)?.choices;
  const firstChoice = Array.isArray(choices) ? asObject(choices[0] ?? null) : null;
  const message = asObject(firstChoice?.message);
  pushContent(acc, typeof message?.content === 'string' ? message.content : '', onDelta);
  const finishReason = firstChoice?.finish_reason;
  acc.finishReason = typeof finishReason === 'string' ? finishReason : null;
  const usage = asObject(asObject(parsed)?.usage ?? null) ?? asObject(asObject(openaiLike)?.usage ?? null);
  acc.usage = usage === null ? null : structuredClone(usage);
  acc.done = true;
  return { acc, failure: null };
}

export function intoCompletion(
  acc: Accumulated, mode: TransportMode, attempts: number,
): SingleShotCompletion {
  return {
    content: acc.content,
    reasoningBytes: acc.reasoningBytes,
    finishReason: acc.finishReason,
    usage: acc.usage,
    mode,
    attempts,
    interrupted: null,
    aborted: acc.aborted,
  };
}
