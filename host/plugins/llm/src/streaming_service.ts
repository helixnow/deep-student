/** Runtime implementation of LLMManager::single_shot_completion (single_shot_stream.rs:998). */
import type { LlmStreamingService } from '../api.ts';
import type { LlmAdapterService, LlmCodexAuthService } from '../../llm-providers/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { effectiveApiProtocolForConfig } from './protocol.ts';
import { prepareProviderRequest } from './prepared_request.ts';
import { bodyForMode, runSingleShot, type SingleShotResponse } from './single_shot_stream.ts';
import { logWarn } from './logging.ts';
import type { LlmRequestInit } from './http_proxy.ts';

export function createLlmStreamingService(
  adapters: LlmAdapterService,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  codex?: LlmCodexAuthService,
): LlmStreamingService {
  return {
    async singleShotCompletion(config, requestBody, apiKey, sessionId, buildErrorContext, opts, onDelta) {
      const outstanding = new Set<AbortController>();
      const abort = (): void => { for (const controller of outstanding) controller.abort(); };
      opts.cancel?.addEventListener('abort', abort, { once: true });
      try {
        return await runSingleShot(opts, config, async (mode, requestTimeout) => {
          const protocol = effectiveApiProtocolForConfig(config);
          const adapter = adapters.createAdapter(protocol === 'anthropic_messages' ? 'anthropic'
            : protocol === 'google_generate_content' ? 'gemini'
              : protocol === 'openai_responses' ? 'openai_responses' : 'openai');
          const body = bodyForMode(requestBody, mode);
          const { request: prepared, codexRequest } = await prepareProviderRequest(
            adapters, codex, adapter, config, body, apiKey, sessionId, buildErrorContext);
          const controller = new AbortController();
          outstanding.add(controller);
          if (opts.cancel?.aborted) controller.abort();
          // Header deadline drops the actual fetch as Rust dropping its future does.
          const timer = setTimeout(() => controller.abort(), mode === 'stream'
            ? Math.min(opts.headerTimeoutMs, requestTimeout) : requestTimeout);
          let response: Response;
          try {
            const init: LlmRequestInit = { method: 'POST', headers: prepared.headers,
              body: JSON.stringify(prepared.body), signal: controller.signal, requestTimeoutMs: requestTimeout };
            if (codexRequest !== null && codex !== undefined) {
              const send = (input: Parameters<typeof fetch>[0], options?: RequestInit): Promise<Response> => fetcher(input,
                { ...options, signal: options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
                  requestTimeoutMs: requestTimeout } as LlmRequestInit);
              response = await (mode === 'stream' ? codex.sendStreamWithSingleRefresh(codexRequest, { fetch: send, timeoutMs: requestTimeout })
                : codex.sendWithSingleRefresh(codexRequest, { fetch: send, timeoutMs: requestTimeout }));
            } else response = await fetcher(prepared.url, init);
          } catch (error) {
            outstanding.delete(controller);
            if (error !== null && typeof error === 'object' && 'error_type' in error) throw error;
            throw AppError.network(`${opts.label} 请求失败: ${error instanceof Error ? error.message : String(error)}`);
          } finally { clearTimeout(timer); }
          const reader = response.body?.getReader();
          let closed = false;
          const close = async (): Promise<void> => {
            if (closed) return;
            closed = true;
            controller.abort();
            outstanding.delete(controller);
            if (reader !== undefined) {
              try { await reader.cancel(); }
              catch (error) { logWarn(`[SingleShot] 关闭响应流失败: ${error instanceof Error ? error.message : String(error)}`); }
              reader.releaseLock();
            }
          };
          const responseBody: AsyncIterable<Uint8Array> = {
            [Symbol.asyncIterator]() {
              return {
                next: async () => {
                  if (reader === undefined) return { done: true as const, value: undefined };
                  const result = await reader.read();
                  return result.done ? { done: true as const, value: undefined } : { done: false as const, value: result.value };
                },
                return: async () => { await close(); return { done: true as const, value: undefined }; },
              };
            },
          };
          return { status: response.status, headers: Object.fromEntries(response.headers), adapter,
            isCodex: codexRequest !== null, body: responseBody, close } satisfies SingleShotResponse;
        }, onDelta ?? undefined);
      } finally {
        abort();
        opts.cancel?.removeEventListener('abort', abort);
      }
    },
  };
}
