/**
 * 翻译流式传输（移植 `dstu-tutor/src/translation/pipeline.rs` 的 HTTP/SSE 部分）。
 *
 * 适配器选择跟随 `llm@1` 的协议解析；三种协议（OpenAI Chat/Responses、Anthropic、
 * Gemini）的请求体经L01实际适配器与L02共享请求策略构建。
 */
import { AppError } from '../../../platform/errors/api.ts';
import type { StreamFailure } from '../api.ts';
import type { ApiConfig, LLMManager } from '../../llm/api.ts';
import { effectiveApiProtocolForConfig, applyReasoningConfig,
  preparePlainProviderRequest, prepareProviderRequest, providerAdapterForConfig } from '../../llm/api.ts';
import { OpenAIAdapter, OpenAIResponsesAdapter, AnthropicAdapter, GeminiAdapter,
  type ProviderAdapter, type LlmCodexAuthService, type PreparedProviderRequest as CodexPreparedRequest, type JsonValue } from '../../llm-providers/api.ts';
import { logWarn } from './logging.ts';
import { create_model_wrap_token_filter, SseEventBuffer } from '../../../platform/util/portable.ts';

export interface StreamOptions {
  temperature: number;
  maxTokens: number | null;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  maxRequestAttempts: number;
  enableThinking: boolean | null;
}
export const IDLE_TIMEOUT_MS = 90_000;
export const TOTAL_TIMEOUT_MS = 600_000;
export const MAX_REQUEST_ATTEMPTS = 3;
export const RETRY_BACKOFF_BASE_MS = 500;
export function defaultStreamOptions(): StreamOptions {
  return {
    temperature: 0.3,
    maxTokens: null,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    totalTimeoutMs: TOTAL_TIMEOUT_MS,
    maxRequestAttempts: MAX_REQUEST_ATTEMPTS,
    enableThinking: null,
  };
}

export class StreamError extends Error implements StreamFailure {
  readonly code: string;
  readonly retriable: boolean;
  constructor(message: string, code: string, retriable: boolean) {
    super(message);
    this.name = 'StreamError';
    this.code = code;
    this.retriable = retriable;
  }
}

/** llm_manager/mod.rs:4082 `effective_max_tokens`. */
export function effectiveMaxTokens(maxOutputTokens: number, maxTokensLimit: number | null): number {
  return maxTokensLimit === null ? maxOutputTokens : Math.min(maxOutputTokens, maxTokensLimit);
}


type JsonObject = { [key: string]: unknown };

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function field(value: unknown, key: string): unknown {
  return isObject(value) ? value[key] : undefined;
}

/** 翻译请求体（pipeline.rs:120–143）。 */
export function buildTranslationRequestBody(
  config: ApiConfig, systemPrompt: string, userPrompt: string, options: StreamOptions,
): JsonObject {
  const maxTokens = options.maxTokens ?? effectiveMaxTokens(config.maxOutputTokens, config.maxTokensLimit);
  const body: { [key: string]: JsonValue } = {
    model: config.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: options.temperature,
    max_tokens: maxTokens,
    stream: true,
  };
  applyReasoningConfig(body, config, options.enableThinking);
  return body;
}

export { applyReasoningConfig };

export interface PreparedRequest {
  url: string;
  headers: [string, string][];
  body: JsonObject;
  codexRequest?: CodexPreparedRequest;
}

/** Plain provider path uses the same L02 policy and L01 transport adapters. */
export function prepareTranslationRequest(
  config: ApiConfig, apiKey: string, systemPrompt: string, userPrompt: string,
  options: StreamOptions, stream = true,
): PreparedRequest {
  const body = buildTranslationRequestBody(config, systemPrompt, userPrompt, options);
  body.stream = stream;
  const prepared = preparePlainProviderRequest(providerAdapterForConfig(config), config, body as JsonValue, apiKey, null, '翻译请求构建失败');
  return { ...prepared, body: prepared.body as JsonObject };
}

export interface ParsedStreamEvent {
  type: 'content' | 'done' | 'safety';
  text?: string;
  info?: unknown;
}

/** Translation consumes only these three variants of the shared stateful provider parser. */
export function parseProtocolBlock(block: string, protocol: string, adapter?: ProviderAdapter): ParsedStreamEvent[] {
  const parser = adapter ?? (protocol === 'anthropic_messages' ? new AnthropicAdapter()
    : protocol === 'google_generate_content' ? new GeminiAdapter()
      : protocol === 'openai_responses' ? new OpenAIResponsesAdapter() : new OpenAIAdapter());
  const events: ParsedStreamEvent[] = [];
  for (const event of parser.parseStream(block)) {
    if (event.type === 'ContentChunk') events.push({ type: 'content', text: event.value });
    else if (event.type === 'Done') events.push({ type: 'done' });
    else if (event.type === 'SafetyBlocked') events.push({ type: 'safety', info: event.value });
  }
  return events;
}

/** `http_failure`（pipeline.rs:646–658）。 */
export function httpFailure(status: number): StreamError {
  if (status === 400) return new StreamError('翻译请求参数无效，请检查模型配置', 'http_400', false);
  if (status === 401) return new StreamError('API 密钥无效或已过期，请检查设置', 'http_401', false);
  if (status === 402) return new StreamError('API 账户余额不足，请充值后重试', 'http_402', false);
  if (status === 403) return new StreamError('API 访问被拒绝，请检查账户权限', 'http_403', false);
  if (status === 404) return new StreamError('模型或接口不存在，请检查模型配置', 'http_404', false);
  if (status === 408) return new StreamError('翻译请求超时，请重试', 'http_408', true);
  if (status === 413) return new StreamError('翻译文本过大，请缩短后重试', 'http_413', false);
  if (status === 429) return new StreamError('请求过于频繁，请稍后重试', 'rate_limited', true);
  if (status >= 500 && status <= 599) {
    return new StreamError('翻译服务暂时不可用，请稍后重试', 'http_5xx', true);
  }
  if (status >= 400 && status < 500) {
    return new StreamError('翻译请求被拒绝，请检查配置', 'http_4xx', false);
  }
  return new StreamError('翻译请求失败，请重试', 'http_error', true);
}

/** `network_failure`（pipeline.rs:660–672）。 */
export function networkFailure(context: string, error: unknown): StreamError {
  const name = field(error, 'name');
  if (name === 'TimeoutError') {
    return new StreamError(`${context}：连接超时`, 'timeout_connect', true);
  }
  const cause = field(error, 'cause');
  const code = field(cause, 'code') ?? field(error, 'code');
  const message = error instanceof Error ? error.message : String(error);
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return new StreamError(`${context}：无法连接翻译服务`, 'network_unreachable', true);
  }
  return new StreamError(`${context}: ${message}`, 'network', true);
}

/** `classify_provider_block`（pipeline.rs:676–718）。 */
export function classifyProviderBlock(info: unknown): StreamError {
  const reason = typeof field(info, 'reason') === 'string' ? field(info, 'reason') as string : '';
  const blockType = typeof field(info, 'type') === 'string' ? field(info, 'type') as string : '';
  const details = field(info, 'details');
  const detailMessage = typeof field(details, 'message') === 'string' ? field(details, 'message') as string : '';
  const isContentBlock = blockType === 'content_blocked' || blockType === 'safety_error'
    || reason.includes('safety') || reason.includes('refusal') || reason.includes('content_filter');
  if (isContentBlock) {
    return new StreamError('翻译内容被安全策略拦截，请调整文本后重试', 'content_filtered', false);
  }
  const detailReason = typeof field(details, 'reason') === 'string' ? field(details, 'reason') as string : '';
  if (detailReason === 'max_output_tokens' || reason.includes('max_output_tokens')) {
    return new StreamError('译文超出模型输出长度上限，请缩短选区或在设置中更换翻译模型', 'max_output_tokens', false);
  }
  const message = detailMessage === '' ? '翻译服务返回错误，请稍后重试' : `翻译服务返回错误：${detailMessage}`;
  return new StreamError(message, 'provider_error', false);
}

export type StreamStatus = 'completed' | 'cancelled' | 'incomplete';

export interface TransportControl {
  consumePendingCancel(streamEvent: string): Promise<boolean>;
  subscribeCancelStream(streamEvent: string): Promise<AbortSignal>;
  clearCancelStream(streamEvent: string): Promise<void>;
  clearCancelArtifacts(streamEvent: string): Promise<void>;
}

export interface StreamRuntime {
  codex?: LlmCodexAuthService;
  readonly fetch: typeof fetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

const defaultRuntime: StreamRuntime = {
  fetch: (input, init) => globalThis.fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => performance.now(),
};

function isDoneMarker(block: string): boolean {
  return SseEventBuffer.checkDoneMarker(block);
}

interface StreamBudget { idleTimeoutMs: number }

async function readBody(
  response: Response, protocol: string, name: string, runtime: StreamRuntime,
  controller: AbortController, budget: StreamBudget, deadline: number,
  onChunk: (chunk: string) => void,
  config: ApiConfig, adapter: ProviderAdapter,
): Promise<StreamStatus> {
  const body = response.body;
  if (body === null) {
    await controller.abort('incomplete');
    return 'incomplete';
  }
  const reader = body.getReader();
  const buffer = new SseEventBuffer();
  let ended = false;
  let terminal: StreamError | null = null;
  let abortReason: string | null = null;
  const wrapFilter = create_model_wrap_token_filter(config.providerType, config.providerScope, config.model);
  const flush = (block: string): void => {
    if (block.trim() === '') return;
    if (isDoneMarker(block)) { ended = true; return; }
    for (const event of parseProtocolBlock(block, protocol, adapter)) {
      if (event.type === 'content') {
        const filtered = wrapFilter.process(event.text ?? '');
        if (filtered !== '') onChunk(filtered);
      }
      else if (event.type === 'done') { ended = true; return; }
      else if (event.type === 'safety') {
        logWarn(`[Translation] 供应商流内错误/安全拦截: ${JSON.stringify(event.info)}`);
        terminal ??= classifyProviderBlock(event.info);
      }
    }
  };
  try {
  while (!ended) {
    if (controller.signal.aborted && controller.signal.reason === 'cancel') return 'cancelled';
    const now = runtime.now();
    if (now >= deadline) {
      throw new StreamError('翻译总时长超限，请缩短文本或稍后重试', 'timeout_total', true);
    }
    const idleDeadline = Math.min(now + budget.idleTimeoutMs, deadline);
    const timer = setTimeout(() => {
      abortReason = runtime.now() >= deadline ? 'timeout_total' : 'timeout_idle';
      void controller.abort(abortReason);
    }, Math.max(0, idleDeadline - now));
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await abortable(reader.read(), controller.signal);
    } catch (error) {
      clearTimeout(timer);
      if (abortReason === 'cancel') return 'cancelled';
      if (controller.signal.aborted && controller.signal.reason === 'cancel') return 'cancelled';
      if (abortReason === 'timeout_total') {
        throw new StreamError('翻译总时长超限，请缩短文本或稍后重试', 'timeout_total', true);
      }
      if (abortReason === 'timeout_idle') {
        throw new StreamError('翻译服务长时间无响应，已中断。请重试。', 'timeout_idle', true);
      }
      throw networkFailure('读取流失败', error);
    }
    clearTimeout(timer);
    if (result.done) break;
    for (const block of buffer.processBytes(result.value)) {
      flush(block);
      if (ended) break;
    }
  }
  if (!ended) for (const block of buffer.flush()) { flush(block); if (ended) break; }
  if (terminal !== null) throw terminal;
  const wrapTail = wrapFilter.flush();
  if (wrapTail !== '') onChunk(wrapTail);
  if (!ended) logWarn('⚠️ [Translation] SSE 流未收到完成标记就结束，结果可能不完整');
  return ended ? 'completed' : 'incomplete';
  } finally {
    controller.abort();
    try { await reader.cancel(); } catch { // boundary-allow empty-catch: Rust drop(stream) has no fallible result
    }
    reader.releaseLock();
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); }
  });
}

async function requestOnce(
  prepared: PreparedRequest, runtime: StreamRuntime, options: StreamOptions, deadline: number,
  controller: AbortController,
): Promise<Response> {
    const now = runtime.now();
    if (now >= deadline) throw new StreamError('翻译总时长超限，请缩短文本或稍后重试', 'timeout_total', true);
    let response: Response;
    try {
      if (prepared.codexRequest !== undefined && runtime.codex !== undefined) {
        response = await runtime.codex.sendStreamWithSingleRefresh(prepared.codexRequest, {
          timeoutMs: Math.min(options.totalTimeoutMs, 300_000),
          fetch: (input, init) => runtime.fetch(input, { ...init,
            signal: init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal }),
        });
      } else response = await runtime.fetch(prepared.url, {
        method: 'POST',
        headers: prepared.headers,
        body: JSON.stringify(prepared.body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason === 'cancel') throw controller.signal.reason;
      throw networkFailure('翻译请求失败', error);
    }
    if (response.status < 200 || response.status >= 300) {
      let text = '';
      try {
        text = await response.text();
      } catch { // boundary-allow empty-catch: Rust `resp.text().await.unwrap_or_default()` 忽略读取错误
      }
      const snippet = Array.from(text).slice(0, 600).join('');
      logWarn(`❌ [Translation] API error ${response.status}: ${snippet}`);
      if (response.status === 400 && (text.includes('content_filter') || text.includes('content_policy') || text.includes('ResponsibleAIPolicy'))) {
        throw new StreamError('翻译内容被安全策略拦截，请调整文本后重试', 'content_filtered', false);
      }
      throw httpFailure(response.status);
    }
    return response;
}

export interface StreamTranslateRequest {
  config: ApiConfig;
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
  streamEvent: string;
  control: TransportControl;
  onChunk: (chunk: string) => void;
  options?: Partial<StreamOptions>;
  runtime?: StreamRuntime;
}

/** `stream_translate_inner`（pipeline.rs:740–1032）。 */
export async function streamTranslate(request: StreamTranslateRequest): Promise<StreamStatus> {
  const options: StreamOptions = { ...defaultStreamOptions(), ...request.options };
  const runtime = request.runtime ?? defaultRuntime;
  const deadline = runtime.now() + options.totalTimeoutMs;
  if (await request.control.consumePendingCancel(request.streamEvent)) return 'cancelled';
  const adapter = providerAdapterForConfig(request.config);
  const controller = new AbortController();
  const cancelSignal = await request.control.subscribeCancelStream(request.streamEvent);
  const onCancel = (): void => controller.abort('cancel');
  cancelSignal.addEventListener('abort', onCancel, { once: true });
  if (cancelSignal.aborted) onCancel();
  let attempt = 0;
  try {
  let response: Response;
  for (;;) {
    attempt++;
    if (controller.signal.aborted || await request.control.consumePendingCancel(request.streamEvent)) return 'cancelled';
    if (runtime.now() >= deadline) {
      throw new StreamError('翻译总时长超限，请缩短文本或稍后重试', 'timeout_total', true);
    }
    const body = buildTranslationRequestBody(request.config, request.systemPrompt, request.userPrompt, options);
    const built = await prepareProviderRequest({}, runtime.codex, adapter, request.config, body as JsonValue,
      request.apiKey, request.streamEvent, '翻译请求构建失败');
    const prepared: PreparedRequest = { ...built.request, body: built.request.body as JsonObject,
      ...(built.codexRequest === null ? {} : { codexRequest: built.codexRequest }) };
    let failure: StreamError;
    const requestTimer = setTimeout(() => controller.abort('timeout_total'),
      Math.max(0, deadline - runtime.now()));
    try {
      response = await abortable(requestOnce(prepared, runtime, options, deadline, controller), controller.signal);
      break;
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason === 'cancel') return 'cancelled';
      if (controller.signal.aborted && controller.signal.reason === 'timeout_total') {
        throw new StreamError('翻译总时长超限，请缩短文本或稍后重试', 'timeout_total', true);
      }
      if (!(error instanceof StreamError)) throw error;
      failure = error;
    } finally {
      clearTimeout(requestTimer);
    }
    if (!failure.retriable || attempt >= options.maxRequestAttempts) throw failure;
    const backoff = RETRY_BACKOFF_BASE_MS * 3 ** (attempt - 1);
    logWarn(`🔁 [Translation] 请求失败（${failure.code}），${backoff}ms 后重试（第 ${attempt + 1}/${options.maxRequestAttempts} 次尝试）`);
    try { await abortable(runtime.sleep(backoff), controller.signal); }
    catch (error) { if (controller.signal.aborted && controller.signal.reason === 'cancel') return 'cancelled'; throw error; }
    if (await request.control.consumePendingCancel(request.streamEvent)) return 'cancelled';
  }
  return await readBody(response, effectiveApiProtocolForConfig(request.config), request.streamEvent,
    runtime, controller, { idleTimeoutMs: options.idleTimeoutMs }, deadline, request.onChunk, request.config, adapter);
  } finally {
    controller.abort();
    cancelSignal.removeEventListener('abort', onCancel);
    await request.control.clearCancelStream(request.streamEvent);
  }
}

/** 非流式单次补全（`call_llm_for_boundary`）。 */
export async function completeChat(
  config: ApiConfig, apiKey: string, userPrompt: string,
  runtime: StreamRuntime = defaultRuntime, maxTokens: number | null = null,
): Promise<string> {
  const options: StreamOptions = {
    ...defaultStreamOptions(), temperature: config.temperature, maxTokens,
  };
  const prepared = prepareTranslationRequest(config, apiKey, '', userPrompt, options, false);
  let response: Response;
  try {
    response = await runtime.fetch(prepared.url, {
      method: 'POST',
      headers: prepared.headers,
      body: JSON.stringify(prepared.body),
    });
  } catch (error) {
    throw networkFailure('LLM 请求失败', error);
  }
  const text = await response.text();
  if (response.status < 200 || response.status >= 300) {
    throw new StreamError(`LLM 请求失败: ${response.status} - ${text.slice(0, 2048)}`, 'http_error', false);
  }
  let json: unknown;
  try { json = JSON.parse(text); } catch (error) {
    throw new StreamError(`解析 LLM 响应失败: ${error instanceof Error ? error.message : String(error)}`, 'internal', false);
  }
  return extractNonstreamText(json, effectiveApiProtocolForConfig(config));
}

export function extractNonstreamText(json: unknown, protocol: string): string {
  if (protocol === 'anthropic_messages') {
    const content = field(json, 'content');
    if (Array.isArray(content)) {
      return content.map((part) => {
        const text = field(part, 'text');
        return typeof text === 'string' ? text : '';
      }).join('');
    }
    return '';
  }
  if (protocol === 'google_generate_content') {
    const candidates = field(json, 'candidates');
    if (Array.isArray(candidates)) {
      return candidates.flatMap((candidate) => {
        const parts = field(field(candidate, 'content'), 'parts');
        return Array.isArray(parts) ? parts : [];
      }).map((part) => {
        const text = field(part, 'text');
        return typeof text === 'string' ? text : '';
      }).join('');
    }
    return '';
  }
  if (protocol === 'openai_responses') {
    const direct = field(json, 'output_text');
    if (typeof direct === 'string') return direct;
    const output = field(json, 'output');
    if (Array.isArray(output)) {
      return output.flatMap((item) => {
        const content = field(item, 'content');
        return Array.isArray(content) ? content : [];
      }).map((part) => {
        const text = field(part, 'text');
        return typeof text === 'string' ? text : '';
      }).join('');
    }
    return '';
  }
  const choices = field(json, 'choices');
  if (Array.isArray(choices) && choices.length > 0) {
    const content = field(field(choices[0], 'message'), 'content');
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((part) => {
        const text = field(part, 'text');
        return typeof text === 'string' ? text : '';
      }).join('');
    }
  }
  return '';
}

/** `AppError` 包装（命令边界）。 */
export function streamErrorToAppError(error: StreamError): ReturnType<typeof AppError.llm> {
  return AppError.llm(error.message);
}

export type { LLMManager };
