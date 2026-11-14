/** Unified model-2 establishment and read phases, model2_pipeline.rs:6295–7292. */
import { createWebCrypto } from '../../../platform/crypto/web.ts';
import { delay } from './delay.ts';
const randomInt = (min: number, max: number): number => createWebCrypto().randomInt(min, max);
import type { ApiConfig, LLMManager, LlmProviderRequests, Model2EventCollector, UnifiedModel2StreamInput } from '../api.ts';
import type { LlmCodexAuthService } from '../../llm-providers/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { SseEventBuffer } from '../../../platform/util/portable.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';
import { redactSensitiveText } from '../../../platform/log/redact.ts';
import { chatV2SessionScopeAndGeneration } from './stream_scope.ts';
import { tagEstablishFailure, attachLlmErrorCode, LLM_ERROR_CODE_CONTEXT_WINDOW_EXCEEDED, providerBodyIndicatesContextWindow } from './routing.ts';
import { responsesStreamInterruptionMessage, validateStreamTermination, validateStreamPayload } from './stream_validation.ts';
import { logDebug, logError, logInfo, logWarn } from './logging.ts';
import type { LlmRequestInit } from './http_proxy.ts';

export type Model2Prepared = Awaited<ReturnType<LlmProviderRequests['prepareModel2Async']>>;
export const STREAMING_REQUEST_TIMEOUT_MS = 7_200_000;
export const STREAMING_IDLE_TIMEOUT_MS = 600_000;
export const model2Timestamp = (): string => new Date().toISOString().replace('T', ' ').replace('Z', '');
export function emitModel2(input: UnifiedModel2StreamInput, channel: string, payload: unknown,
  failure: string | null, level: 'warn' | 'error' = 'warn'): void {
  try { input.sink.emit(channel, payload); }
  catch (error) { if (failure !== null) (level === 'warn' ? logWarn : logError)(`${failure}: ${error instanceof Error ? error.message : String(error)}`); }
}
function retryProgress(input: UnifiedModel2StreamInput, count: number, maximum: number): void {
  const scope = chatV2SessionScopeAndGeneration(input.streamEvent);
  if (scope === null || input.messageId == null) return;
  emitModel2(input, `chat_v2_session_${scope[0]}`, { sessionId: scope[0], eventType: 'stream_reconnect',
    messageId: input.messageId, retryAttempt: count, retryMax: maximum, timestamp: Date.now(),
    ...(scope[1] === null ? {} : { streamGeneration: scope[1] }) }, null);
}
function headers(prepared: Model2Prepared, config: ApiConfig): Headers {
  const result = new Headers();
  if (!prepared.request.codex) {
    result.set('Accept', 'text/event-stream, application/json, text/plain, */*');
    result.set('Accept-Encoding', 'identity');
    if (!prepared.request.opencodeGo) {
      result.set('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8');
      result.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    }
  }
  for (const [name, value] of prepared.request.headers) result.set(name, value);
  if (!prepared.request.codex && !prepared.request.opencodeGo) {
    let url: URL | null;
    try { url = new URL(config.baseUrl); } catch { url = null; }
    if (url && ['http:', 'https:'].includes(url.protocol) && url.hostname) {
      result.set('Origin', `${url.protocol}//${url.hostname}`);
      result.set('Referer', `${url.protocol}//${url.hostname}/`);
    }
  }
  return result;
}

export async function establishModel2(prepared: Model2Prepared, config: ApiConfig, input: UnifiedModel2StreamInput,
  requestId: string, maximum: number, manager: LLMManager, cancel: AbortSignal,
  fetcher: typeof fetch, codex: LlmCodexAuthService): Promise<{ response: Response; close(): void }> {
  let count = 0;
  const cancelled = (): never => { throw AppError.llm('请求已被用户取消'); };
  const wait = async (milliseconds: number): Promise<void> => {
    retryProgress(input, count, maximum);
    const deadline = performance.now() + milliseconds;
    while (performance.now() < deadline) {
      if (cancel.aborted || await manager.consumePendingCancel(input.streamEvent)) cancelled();
      await delay(Math.min(500, Math.max(0, deadline - performance.now())));
    }
  };
  for (;;) {
    if (cancel.aborted) cancelled();
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    cancel.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, STREAMING_REQUEST_TIMEOUT_MS);
    const close = (): void => { clearTimeout(timer); cancel.removeEventListener('abort', abort); controller.abort(); };
    let response: Response;
    try {
      const send: typeof fetch = (url, options) => fetcher(url, { ...options,
        signal: options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
        requestTimeoutMs: STREAMING_REQUEST_TIMEOUT_MS } as LlmRequestInit);
      response = prepared.codexRequest !== null
        ? await codex.sendStreamWithSingleRefresh(prepared.codexRequest, { fetch: send, timeoutMs: STREAMING_REQUEST_TIMEOUT_MS })
        : await send(prepared.request.url, { method: 'POST', headers: headers(prepared, config), body: JSON.stringify(prepared.request.body) });
    } catch (error) {
      close();
      if (cancel.aborted) {
        emitModel2(input, `${input.streamEvent}_cancelled`, { id: requestId, reason: 'user_cancelled_during_connect' }, null);
        cancelled();
      }
      if (error !== null && typeof error === 'object' && 'error_type' in error && error.error_type !== 'Network') throw error;
      const detail = redactSensitiveText(error !== null && typeof error === 'object' && 'message' in error
        ? String(error.message) : String(error));
      if (count >= maximum) throw tagEstablishFailure(AppError.network(`模型二API请求失败: ${detail}`), null);
      count++;
      const waitMs = randomInt(4000, 5001);
      logWarn(`[模型二API] 建连失败，等待 ${waitMs}ms 后重试 (${count}/${maximum}): ${detail}`);
      await wait(waitMs); continue;
    }
    if (response.ok) return { response, close };
    const status = response.status;
    if ((status === 429 || status >= 500 && status <= 599) && count < maximum) {
      const retryAfter = response.headers.get('Retry-After');
      const seconds = retryAfter !== null && /^\+?\d+$/.test(retryAfter) ? BigInt(retryAfter) : null;
      const waitMs = status === 429 && seconds !== null && seconds <= 0xffff_ffff_ffff_ffffn
        ? Number(seconds < 120n ? seconds : 120n) * 1000 : randomInt(4000, 5001);
      close();
      if (response.body) await response.body.cancel().catch(error => logDebug(`释放重试响应: ${String(error)}`));
      count++;
      logWarn(`[模型二API] ${status === 429 ? '遇到速率限制(429)' : `服务端错误(${status})`}，等待 ${waitMs}ms 后重试 (${count}/${maximum})`);
      await wait(waitMs); continue;
    }
    let body: string;
    try { body = redactSensitiveText(await response.text().catch(() => '')); } finally { close(); }
    let error = status === 401 ? AppError.configuration(`模型二API认证失败: API Key 无效或已过期 (HTTP 401) - ${body}`)
      : AppError.llm(status === 403 ? `模型二API访问被拒绝 (HTTP 403) - ${body}`
        : status === 429 ? `模型二API请求失败: 速率限制(429)，已重试${maximum}次仍失败 - ${body}`
          : status >= 500 && status <= 599 ? `模型二API服务端错误: HTTP ${status} - 已重试${maximum}次仍失败 - ${body}`
            : `模型二API请求失败: HTTP ${status} - ${body}`);
    logError(error.message);
    if ([400, 413, 422].includes(status) && providerBodyIndicatesContextWindow(body)) error = attachLlmErrorCode(error, LLM_ERROR_CODE_CONTEXT_WINDOW_EXCEEDED);
    throw tagEstablishFailure(error, status);
  }
}

export async function readModel2(response: Response, prepared: Model2Prepared, input: UnifiedModel2StreamInput,
  requestId: string, manager: Pick<LLMManager, 'consumePendingCancel' | 'clearCancelStream'>,
  cancel: AbortSignal, collector: Model2EventCollector,
): Promise<{ cancelled: boolean; responseBytes: number }> {
  const reader = response.body?.getReader();
  const buffer = new SseEventBuffer();
  let wasCancelled = false, responseBytes = 0, failure: string | null = null;
  try {
    for (;;) {
      const pending = await manager.consumePendingCancel(input.streamEvent);
      if (cancel.aborted || pending) { wasCancelled = true; break; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let removeCancel = (): void => {};
      const read = reader?.read() ?? Promise.resolve({ done: true as const, value: undefined });
      const outcome = await Promise.race([
        read.then(value => ({ kind: 'read' as const, value }), error => ({ kind: 'error' as const, error })),
        new Promise<{ kind: 'cancel' } | { kind: 'idle' }>(resolve => {
          const abort = (): void => resolve({ kind: 'cancel' });
          cancel.addEventListener('abort', abort, { once: true });
          removeCancel = () => cancel.removeEventListener('abort', abort);
          timer = setTimeout(() => resolve({ kind: 'idle' }), STREAMING_IDLE_TIMEOUT_MS);
          if (cancel.aborted) abort();
        }),
      ]);
      clearTimeout(timer); removeCancel();
      if (cancel.aborted || outcome.kind === 'cancel') { wasCancelled = true; break; }
      if (outcome.kind === 'idle') {
        logWarn(`[Stream Loop] 空闲超时（600s 无数据），主动结束流: ${input.streamEvent}`);
        failure = responsesStreamInterruptionMessage('idle_timeout', prepared.request.codex); break;
      }
      if (outcome.kind === 'error') {
        const detail = redactSensitiveText(outcome.error instanceof Error ? outcome.error.message : String(outcome.error));
        logError(`流读取错误: ${detail}`);
        const state = collector.snapshot();
        if (state.content || state.reasoning) {
          logWarn('部分内容已接收，标记为可恢复的中断');
          emitModel2(input, `${input.streamEvent}_truncated`, { reason: 'stream_read_error', error: detail,
            content_len: utf8ByteLength(state.content), reasoning_len: utf8ByteLength(state.reasoning), chunk_count: state.chunkCount,
            stream_event: input.streamEvent, timestamp: model2Timestamp() }, '发送截断警示事件失败');
          failure = responsesStreamInterruptionMessage('read_error', prepared.request.codex); break;
        }
        logError('没有接收到任何内容，这是完全失败');
        const payload = { error: `流式请求失败: ${detail}`, stream_event: input.streamEvent, timestamp: model2Timestamp() };
        emitModel2(input, `${input.streamEvent}_error`, payload, '发送作用域错误事件失败', 'error');
        emitModel2(input, 'stream_error', payload, '发送全局错误事件失败', 'error');
        throw AppError.network(payload.error);
      }
      const next = outcome.value;
      if (!next.done) responseBytes += next.value.length;
      const blocks = next.done ? buffer.flush() : buffer.processBytes(next.value);
      for (const block of blocks) {
        const events = prepared.adapter.parseStream(block);
        collector.dispatch(events.length === 0 && SseEventBuffer.checkDoneMarker(block) ? [{ type: 'Done' }] : events);
        if (collector.ended) break;
      }
      if (next.done && !collector.ended) collector.dispatch(prepared.adapter.finishStream());
      if (collector.ended || next.done) break;
    }
    if (wasCancelled) {
      logInfo(`[Cancel] 流循环检测到取消信号，准备中断: ${input.streamEvent}`);
      emitModel2(input, `${input.streamEvent}_cancelled`, { id: requestId, reason: 'user_cancelled', timestamp: model2Timestamp() }, '发送取消事件失败');
    } else {
      const state = collector.snapshot();
      const error = validateStreamTermination(prepared.requiresExplicitStreamCompletion, state.terminalSuccess,
        state.terminalFailure ?? failure, prepared.request.codex);
      if (error) throw error;
    }
    collector.finishPending();
    const state = collector.snapshot();
    const error = validateStreamPayload(wasCancelled, state.content, state.reasoning, state.toolCalls.length);
    if (error) throw error;
    return { cancelled: wasCancelled, responseBytes };
  } finally {
    if (reader) {
      try { await reader.cancel(); } catch (error) { logDebug(`流释放完成: ${String(error)}`); }
      reader.releaseLock();
    }
    await manager.clearCancelStream(input.streamEvent);
  }
}
