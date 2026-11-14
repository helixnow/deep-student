/**
 * OCR 引擎传输与渐进对冲协调（移植 `dstu-llm/src/llm_manager/exam_engine.rs`
 * 的请求构建、超时与 `next_ocr_result` 部分）。
 *
 * 对冲策略：多个引擎并发请求，先返回者胜出；落败引擎通过 AbortSignal 取消，
 * 使其 HTTP 响应流被关闭，避免供应商在后台继续生成。
 */
import type { ApiConfig } from '../api.ts';
import type { LlmAdapterService, LlmCodexAuthService, JsonValue } from '../../llm-providers/api.ts';
import { effectiveMaxTokens } from './generation.ts';
import { createLlmStreamingService } from './streaming_service.ts';
import { defaultSingleShotOptions } from './single_shot_stream.ts';
import { recognizeDeepseekPage } from './deepseek_ocr_api.ts';

export type JsonObject = { [key: string]: unknown };

/** 预构建的单引擎 OCR 请求；只保存配置与 OpenAI 形状的请求体。 */
export interface PreparedOcrRequest {
  idx: number;
  engineName: string;
  modelName: string;
  config: ApiConfig;
  apiKey: string;
  requestBody: JsonObject;
  isCodex: boolean;
  deepseekImage?: string;
}

export type OcrOutcome = { ok: true; value: string } | { ok: false; error: string };
export type OcrRequestResult = readonly [number, OcrOutcome];

/** 传输层依赖；测试与宿主注入 `fetch`。 */
export interface OcrTransport {
  fetch: typeof fetch;
  adapters: LlmAdapterService;
  codex?: LlmCodexAuthService;
}

export interface HedgeEngineOptions {
  label: string;
  maxRetries: number;
  headerTimeoutMs: number;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  nonstreamTimeoutMs: number;
}

/**
 * 对冲 OCR 单引擎传输参数：引擎内不重试（对冲本身就是冗余），流式按空闲超时
 * 判活。与 exam_engine.rs 的四个常量一致。
 */
export const HEDGE_ENGINE_HEADER_TIMEOUT_MS = 60_000;
export const HEDGE_ENGINE_IDLE_TIMEOUT_MS = 45_000;
export const HEDGE_ENGINE_TOTAL_TIMEOUT_MS = 300_000;
export const HEDGE_ENGINE_NONSTREAM_TIMEOUT_MS = 180_000;

export function hedgeEngineOptions(request: PreparedOcrRequest): HedgeEngineOptions {
  return {
    label: `OCR-Hedge #${request.idx} (${request.engineName})`,
    maxRetries: 0,
    headerTimeoutMs: HEDGE_ENGINE_HEADER_TIMEOUT_MS,
    idleTimeoutMs: HEDGE_ENGINE_IDLE_TIMEOUT_MS,
    totalTimeoutMs: HEDGE_ENGINE_TOTAL_TIMEOUT_MS,
    nonstreamTimeoutMs: HEDGE_ENGINE_NONSTREAM_TIMEOUT_MS,
  };
}

/** 外层兜底时限：一次流式尝试 + 可能的一次非流式回退。 */
export function hedgeEngineOuterDeadline(options: HedgeEngineOptions): number {
  return options.totalTimeoutMs + options.nonstreamTimeoutMs + 5_000;
}

/** Rust：整秒用 `{n}s`，否则用 `{n}ms`。 */
export function ocrTimeoutLabel(timeoutMs: number): string {
  return timeoutMs % 1_000 === 0 ? `${timeoutMs / 1_000}s` : `${timeoutMs}ms`;
}

export function buildOcrRequestBody(
  config: ApiConfig,
  messages: readonly JsonObject[],
  temperature: number,
): JsonObject {
  return {
    model: config.model,
    messages,
    temperature,
    max_tokens: effectiveMaxTokens(config.maxOutputTokens, config.maxTokensLimit),
  };
}

/**
 * 总超时包装：超时后中止底层操作（关闭 HTTP 流）并返回 Rust 同文案的错误。
 */
export async function runOcrWithDeadline<T>(
  engineIdx: number,
  engineName: string,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  cancel?: AbortSignal,
): Promise<T> {
  const message = `Engine #${engineIdx} (${engineName}) timed out (${ocrTimeoutLabel(timeoutMs)})`;
  const controller = new AbortController();
  const onCancel = (): void => controller.abort(cancel?.reason);
  if (cancel !== undefined) {
    if (cancel.aborted) onCancel();
    else cancel.addEventListener('abort', onCancel, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    cancel?.removeEventListener('abort', onCancel);
  }
}

function messageOf(error: unknown): string {
  return error !== null && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
}

/** Same single-shot protocol handling and stream-rejection fallback as Rust. */
async function streamOcrCompletion(
  transport: OcrTransport,
  request: PreparedOcrRequest,
  signal: AbortSignal,
): Promise<string> {
  const opts = hedgeEngineOptions(request);
  try {
    if (request.deepseekImage !== undefined) return await recognizeDeepseekPage(transport.fetch,
      request.apiKey, request.deepseekImage, 'text_recognition', signal);
    const result = await createLlmStreamingService(transport.adapters, transport.fetch).singleShotCompletion(
      request.config, request.requestBody as JsonValue, request.apiKey, null, opts.label,
      { ...defaultSingleShotOptions(opts.label), ...opts, cancel: signal });
    return result.content;
  } catch (error) {
    throw new Error(`Engine #${request.idx} (${request.engineName}) failed: ${messageOf(error)}`);
  }
}

/**
 * 执行普通 OCR 引擎请求。被取消（对冲已有赢家 / 调用方取消）时 future 等价物
 * 通过 AbortSignal 中止，连同响应流一起关闭连接。
 */
export async function runSingleOcrRequest(
  transport: OcrTransport,
  request: PreparedOcrRequest,
  options: { cancel?: AbortSignal } = {},
): Promise<string> {
  const optionsForEngine = hedgeEngineOptions(request);
  const controller = new AbortController();
  const cancelError = new Error('OCR cancelled');
  const onCancel = (): void => controller.abort(cancelError);
  if (options.cancel !== undefined) {
    if (options.cancel.aborted) onCancel();
    else options.cancel.addEventListener('abort', onCancel, { once: true });
  }
  const cancelled = new Promise<never>((_resolve, reject) => {
    const signal = controller.signal;
    const rejectWithReason = (): void => reject(
      signal.reason instanceof Error ? signal.reason : cancelError,
    );
    if (signal.aborted) rejectWithReason();
    else signal.addEventListener('abort', rejectWithReason, { once: true });
  });

  try {
    return await Promise.race([
      runOcrWithDeadline(
        request.idx,
        request.engineName,
        hedgeEngineOuterDeadline(optionsForEngine),
        (signal) => streamOcrCompletion(transport, request, signal),
        options.cancel,
      ),
      cancelled,
    ]);
  } finally {
    options.cancel?.removeEventListener('abort', onCancel);
  }
}

/** 远端（后台通道）结果来源；`null` 表示通道已关闭。 */
export interface OcrResultChannel {
  next(): Promise<OcrRequestResult | null>;
}

// A JS Promise cannot be dropped like a Rust recv future. Retain a losing
// receive until a later select consumes it, otherwise its result disappears.
const pendingReceives = new WeakMap<OcrResultChannel, Promise<OcrRequestResult | null>>();

/**
 * 本地（Codex）请求集合：对齐 `FuturesUnordered` 语义——结果保留到被取走，
 * `next()` 等待下一次完成。
 */
export class LocalOcrRequests {
  private readonly completions: OcrRequestResult[] = [];
  private readonly inFlight = new Set<number>();
  private readonly listeners: (() => void)[] = [];
  private sequence = 0;

  add(idx: number, request: Promise<string>): void {
    const id = ++this.sequence;
    this.inFlight.add(id);
    void request.then(
      (value) => {
        this.inFlight.delete(id);
        this.finish([idx, { ok: true, value }]);
      },
      (error: unknown) => {
        this.inFlight.delete(id);
        this.finish([idx, { ok: false, error: messageOf(error) }]);
      },
    );
  }

  private finish(result: OcrRequestResult): void {
    this.completions.push(result);
    for (const listener of this.listeners.splice(0)) listener();
  }

  isEmpty(): boolean {
    return this.inFlight.size === 0 && this.completions.length === 0;
  }

  take(): OcrRequestResult | null {
    return this.completions.shift() ?? null;
  }

  /** 等待下一次本地请求完成（供 nextOcrResult 与后台通道并发等待）。 */
  changed(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.listeners.push(resolve);
    });
  }
}

/**
 * 取下一个 OCR 结果：本地 Codex 请求与后台通道并发时取先完成者；
 * 后台通道关闭后仍会等待活动中的本地请求（回归用例
 * `local_codex_result_survives_closed_background_channel`）。
 */
export async function nextOcrResult(
  channel: OcrResultChannel,
  localRequests: LocalOcrRequests,
): Promise<OcrRequestResult | null> {
  for (;;) {
    const buffered = localRequests.take();
    if (buffered !== null) return buffered;
    let remote = pendingReceives.get(channel);
    if (remote === undefined) { remote = channel.next(); pendingReceives.set(channel, remote); }
    if (localRequests.isEmpty()) {
      const result = await remote;
      pendingReceives.delete(channel);
      return result;
    }

    const changed = localRequests.changed();
    const winner = await Promise.race([
      changed.then(() => ({ source: 'local' as const })),
      remote.then((result) => ({ source: 'remote' as const, result })),
    ]);
    if (winner.source === 'local') continue;
    pendingReceives.delete(channel);
    if (winner.result !== null) return winner.result;
    // 后台通道关闭：等待本地请求完成，而不是返回 None 提前结束。
    await changed;
  }
}
