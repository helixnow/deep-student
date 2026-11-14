/** pipeline.rs::stream_grade: retry establishment only; cancel/drop on every exit. */
import { delay } from '../delay.ts';
import { AppError } from '../../../../platform/errors/api.ts';
import type { JsonValue } from '../../../../platform/errors/api.ts';
import type { ApiConfig, LLMManager } from '../../api.ts';
import type { ProviderAdapter, LlmCodexAuthService } from '../../../llm-providers/api.ts';
import { effectiveMaxTokens } from '../generation.ts';
import { applyReasoningConfig } from '../question_authoring.ts';
import { prepareProviderRequest } from '../prepared_request.ts';
import { SseEventBuffer } from '../stream_validation.ts';
import { create_model_wrap_token_filter } from '../../../../platform/util/portable.ts';
import { logWarn } from '../logging.ts';
import { classifyLlmHttpError, errorIsRetryable, EssayGradingError, guessImageMime } from './pipeline.ts';
import { errorText } from './errors.ts';

export interface EssayStreamRequest {
  config: ApiConfig;
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
  streamEvent: string;
  essayImages: string[];
  topicImages: string[];
  signal: AbortSignal;
}
export type EssayStreamTransport = (request: EssayStreamRequest, onChunk: (chunk: string) => void)
  => Promise<'completed' | 'cancelled' | 'incomplete'>;

/** Cancellation must settle even while a provider has not produced its next byte. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => { reject(signal.reason); };
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

export function gradingRequestBody(request: EssayStreamRequest): { [key: string]: JsonValue } {
  const { config, systemPrompt, userPrompt, essayImages, topicImages } = request;
  let content: JsonValue = userPrompt;
  if (config.isMultimodal && (essayImages.length > 0 || topicImages.length > 0)) {
    const parts: JsonValue[] = [];
    for (const [images, label] of [
      [topicImages, '【题目/参考材料图片】'],
      [essayImages, '【学生作文原图】以下是学生手写/打印作文的原始图片，请直接阅读图片内容进行批改：'],
    ] as const) {
      if (images.length === 0) continue;
      parts.push({ type: 'text', text: label });
      for (const image of images) parts.push({ type: 'image_url', image_url: {
        url: `data:${guessImageMime(image)};base64,${image}`,
      } });
    }
    parts.push({ type: 'text', text: userPrompt });
    content = parts;
  }
  const body = {
    model: config.model,
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content }],
    temperature: Math.abs(Math.fround(config.temperature) - Math.fround(0.7)) > 2 ** -23 ? config.temperature : 0.3,
    max_tokens: effectiveMaxTokens(config.maxOutputTokens, config.maxTokensLimit),
    stream: true,
  };
  applyReasoningConfig(body, config, null);
  return body;
}

export function createEssayTransport(
  llm: LLMManager, adapterFor: (config: ApiConfig) => ProviderAdapter,
  fetcher: typeof fetch = (...args) => fetch(...args), idleTimeoutMs = 90_000,
  codex?: LlmCodexAuthService,
): EssayStreamTransport {
  return async (request, onChunk) => {
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    let cancelSignal: AbortSignal | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const body = gradingRequestBody(request);
      const adapter = adapterFor(request.config);
      await llm.consumePendingCancel(request.streamEvent);
      cancelSignal = await llm.subscribeCancelStream(request.streamEvent);
      request.signal.addEventListener('abort', cancel, { once: true });
      cancelSignal.addEventListener('abort', cancel, { once: true });
      if (request.signal.aborted || cancelSignal.aborted) return 'cancelled';
      let response: Response | undefined;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const { request: prepared, codexRequest } = await prepareProviderRequest({}, codex, adapter,
            request.config, body, request.apiKey, request.streamEvent, '批改请求构建失败');
          try {
            if (codexRequest !== null && codex !== undefined) response = await codex.sendStreamWithSingleRefresh(codexRequest,
              { fetch: (input, init) => fetcher(input, { ...init,
                signal: init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal }) });
            else response = await fetcher(prepared.url, { method: 'POST', headers: prepared.headers,
              body: JSON.stringify(prepared.body), signal: controller.signal });
          } catch (error) {
            if (controller.signal.aborted) return 'cancelled';
            throw new EssayGradingError('Network', `批改请求失败: ${errorText(error)}`, {
              code: 'ESSAY_LLM_REQUEST_FAILED', category: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network', retryable: true,
            });
          }
          if (!response.ok) {
            const text = await response.text().catch(() => ''); // Rust unwrap_or_default
            throw classifyLlmHttpError(response.status, text);
          }
          break;
        } catch (error) {
          if (controller.signal.aborted) return 'cancelled';
          if (!(error instanceof EssayGradingError) || !errorIsRetryable(error) || attempt === 3) throw error;
          const backoff = Math.min(800 * 2 ** (attempt - 1), 8000);
          logWarn(`[EssayGrading] 批改请求第 ${attempt} 次尝试失败，${backoff}ms 后重试: ${error.message}`);
          try { await delay(backoff, undefined, { signal: controller.signal }); }
          catch (error) { if (controller.signal.aborted) return 'cancelled'; throw error; }
          if (await llm.consumePendingCancel(request.streamEvent)) return 'cancelled';
        }
      }
      if (!response?.body) return 'incomplete';
      reader = response.body.getReader();
      const buffer = new SseEventBuffer();
      const wrapFilter = create_model_wrap_token_filter(request.config.providerType, request.config.providerScope, request.config.model);
      const finish = (status: 'completed' | 'incomplete'): 'completed' | 'incomplete' => {
        const tail = wrapFilter.flush();
        if (tail !== '') onChunk(tail);
        return status;
      };
      const consume = (blocks: string[]): boolean => {
        for (const block of blocks) {
          if (SseEventBuffer.checkDoneMarker(block)) return true;
          for (const event of adapter.parseStream(block)) {
            if (event.type === 'ContentChunk') {
              const filtered = wrapFilter.process(event.value);
              if (filtered !== '') onChunk(filtered);
            }
            if (event.type === 'Done') return true;
          }
        }
        return false;
      };
      for (;;) {
        if (controller.signal.aborted || await llm.consumePendingCancel(request.streamEvent)) return 'cancelled';
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, idleTimeoutMs);
        let next: ReadableStreamReadResult<Uint8Array>;
        try { next = await abortable(reader.read(), controller.signal); }
        catch (error) {
          if (timedOut) {
            logWarn('[EssayGrading] 流式响应空闲超过 90 秒，判定为挂起并中断');
            throw AppError.with_details('Network', '批改流式响应超过 90 秒无数据，已中断。请检查网络连接后重试。',
              { code: 'ESSAY_STREAM_IDLE_TIMEOUT', category: 'timeout', retryable: true });
          }
          if (controller.signal.aborted) return 'cancelled';
          throw AppError.with_details('Network', `读取流失败: ${errorText(error)}`,
            { code: 'ESSAY_STREAM_READ_FAILED', category: 'network', retryable: true });
        } finally { clearTimeout(timer); }
        if (next.done) break;
        if (consume(buffer.processBytes(next.value))) return finish('completed');
      }
      if (consume(buffer.flush())) return finish('completed');
      finish('incomplete');
      logWarn('[EssayGrading] SSE 流未收到 DONE 标记就结束，结果可能不完整');
      return 'incomplete';
    } finally {
      request.signal.removeEventListener('abort', cancel);
      cancelSignal?.removeEventListener('abort', cancel);
      controller.abort();
      if (reader !== undefined) {
        try { await reader.cancel(); } catch { // boundary-allow empty-catch: Rust drop(response.bytes_stream()) has no fallible cleanup result
        }
        reader.releaseLock();
      }
      await llm.clearCancelStream(request.streamEvent);
    }
  };
}
