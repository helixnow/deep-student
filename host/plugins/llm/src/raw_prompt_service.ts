/** Raw-prompt owner exits, model2_pipeline.rs:8570–8613 and :8748–9346.
 * Every exit composes the real L01 provider adapter, shared request preparation (Codex/remote
 * images), the failover driver, the RAW_PROMPT audit log and F3 usage records.
 */
import { delay } from './delay.ts';
import { AppError, type JsonValue } from '../../../platform/errors/api.ts';
import { redactSensitiveText } from '../../../platform/log/redact.ts';
import { charCount, statusLine, utf8ByteLength } from '../../../platform/util/portable.ts';
import type {
  ApiConfig, ImagePayload, LLMManager, LlmCallerType, LlmRawPrompt, LlmUsageRecorder, StandardModel2Output,
} from '../api.ts';
import type { LlmAdapterService, LlmCodexAuthService, ProviderAdapter } from '../../llm-providers/api.ts';
import { effectiveApiProtocolForConfig } from './protocol.ts';
import {
  attachLlmErrorCode, classifyLlmError, ESTABLISH_RETRIES_WITHOUT_FALLBACK, LLM_ERROR_CODE_CONTEXT_WINDOW_EXCEEDED,
  providerBodyIndicatesContextWindow, runWithFailover, tagEstablishFailure,
} from './routing.ts';
import { applyReasoningConfig, type JsonObject } from './question_authoring.ts';
import { applyGenerationParams } from './generation.ts';
import { resolveQuirks } from './provider_quirks.ts';
import { requestAdapterForConfig } from './adapters/registry.ts';
import { prepareProviderRequest, type PreparedProviderRequest } from './prepared_request.ts';
import { normalizeNonstreamResponseToOpenaiForConfig } from './mod_compat.ts';
import { rawPromptThinkingOverride, type RawPromptOptions } from './stream_validation.ts';
import { logLlmRequestAudit, type DebugPersistConfig } from './audit_log.ts';
import { extractUsageTokens } from './usage.ts';
import { estimateTokens } from './tokens.ts';
import { logDebug, logWarn } from './logging.ts';

/** Rust `Display for CallerType` (dstu-storage llm_usage/types.rs:64). */
export function callerTypeToString(value: LlmCallerType): string {
  return typeof value === 'string' ? value : `other:${value.other}`;
}

export interface RawPromptRuntime {
  manager: Pick<LLMManager, 'getModel2Config' | 'getApiConfigs' | 'getFailoverPolicy' | 'getChatTitleModelConfig'
    | 'getMemoryDecisionModelConfig'>;
  candidateApiKeysFor(config: ApiConfig): Promise<string[]>;
  adapters: LlmAdapterService;
  codex: LlmCodexAuthService | undefined;
  fetch: typeof fetch;
  /** Global failover notifications (Rust run_with_failover with stream_sink=None). */
  emit(channel: string, payload: JsonValue): void;
  /** Rust build_debug_persist_config. */
  debugPersistConfig(): DebugPersistConfig | null;
  /** F3 recorder; absence is logged (see BLOCKERS.md F3 usage public boundary). */
  usage(): LlmUsageRecorder | undefined;
  sleep?(milliseconds: number): Promise<void>;
}

export function adapterFor(adapters: LlmAdapterService, config: ApiConfig): ProviderAdapter {
  const protocol = effectiveApiProtocolForConfig(config);
  return adapters.createAdapter(protocol === 'anthropic_messages' ? 'anthropic'
    : protocol === 'google_generate_content' ? 'gemini' : protocol === 'openai_responses' ? 'openai_responses' : 'openai');
}

function transportHeaders(request: PreparedProviderRequest, config: ApiConfig): [string, string][] {
  const headers = new Headers({ Accept: 'application/json', 'Accept-Encoding': 'identity' });
  if (!request.opencodeGo) {
    headers.set('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8');
    headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
  }
  for (const [key, value] of request.headers) headers.set(key, value);
  if (!request.opencodeGo) {
    let base: URL | null;
    try { base = new URL(config.baseUrl); } catch { base = null; } // boundary-allow empty-catch: Rust `if let Ok(parsed_url)`
    if (base && ['http:', 'https:'].includes(base.protocol) && base.hostname !== '') {
      headers.set('Origin', `${base.protocol}//${base.hostname}`);
      headers.set('Referer', `${base.protocol}//${base.hostname}/`);
    }
  }
  return [...headers];
}

function isAppError(value: unknown): value is AppError {
  return value !== null && typeof value === 'object' && 'error_type' in value && 'message' in value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A cancelled Rust future is dropped at its current await, before further side effects. */
function checkVisualCancellation(signal: AbortSignal | null): void {
  if (signal?.aborted) throw AppError.llm('visual observation cancelled');
}

export function createRawPromptService(runtime: RawPromptRuntime): LlmRawPrompt {
  const sleep = runtime.sleep ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));

  function record(callerType: LlmCallerType, model: string, success: boolean, errorMessage: string | null,
    adapter: string, tokenSource: 'api' | 'heuristic', tokens: ReturnType<typeof extractUsageTokens> | null,
    withCacheWrite: boolean): void {
    const recorder = runtime.usage();
    const values = tokens ?? { promptTokens: 0, completionTokens: 0, reasoningTokens: null, cachedTokens: null, cacheWriteTokens: null };
    logDebug(`[LLM Usage] 记录使用量: model=${model}, prompt=${values.promptTokens}, completion=${values.completionTokens}, success=${success}, adapter=${adapter}, token_source=${tokenSource}`);
    if (recorder === undefined) {
      logWarn('[LLM Usage] F3 llmUsage 记录服务未安装，本次 RAW_PROMPT 用量未落库');
      return;
    }
    recorder.recordLlmUsageCacheExtWithIdentity({ ...values, cacheWriteTokens: withCacheWrite ? values.cacheWriteTokens : null,
      callerType, model, sessionId: null, variantId: null, runId: null, durationMs: null,
      success, errorMessage, adapter, tokenSource });
  }

  /** model2_pipeline.rs:8996 call_raw_prompt_attempt. */
  async function attempt(config: ApiConfig, prompt: string, images: ImagePayload[] | null, opts: RawPromptOptions,
    callerType: LlmCallerType, establishMaxRetries: number, signal: AbortSignal | null = null,
    agentSessionId: string | null = null): Promise<StandardModel2Output> {
    checkVisualCancellation(signal);
    if (images !== null && images.length > 0 && !config.isMultimodal) {
      throw AppError.configuration(`当前请求包含图片，但模型配置 ${config.id} 不支持多模态输入`);
    }
    const quirks = resolveQuirks(config);
    const contentParts: JsonValue[] = [{ type: 'text', text: prompt }];
    const requested = images?.length ?? 0;
    const attached: ImagePayload[] = [];
    if (images !== null && config.isMultimodal) {
      for (const payload of images) {
        contentParts.push({ type: 'image_url', image_url: { url: `data:${payload.mime};base64,${payload.base64}` } });
        attached.push(payload);
      }
    }
    const body: JsonObject = { model: config.model, messages: [{ role: 'user', content: contentParts }],
      stream: false, temperature: config.temperature };
    const thinkingOverride = rawPromptThinkingOverride(opts);
    if (thinkingOverride === null) requestAdapterForConfig(config).validateReasoningConfig(config);
    applyReasoningConfig(body, config, thinkingOverride);
    applyGenerationParams(body, config, quirks);
    const maximum = body.max_completion_tokens ?? body.max_tokens;
    if (maximum !== undefined) body.max_total_tokens = maximum;
    if (opts.forceJson && quirks.force_json_response_format) body.response_format = { type: 'json_object' };

    logDebug(`[RAW_PROMPT] 发送简化请求到: ${config.baseUrl} (经适配器) | 请求图片数: ${requested} | 实际附加: ${attached.length} | prompt字符数: ${charCount(prompt)}`);
    attached.slice(0, 3).forEach((payload, index) => {
      logDebug(`[RAW_PROMPT_DEBUG] image[${index}]: mime=${payload.mime}, base64_length=${utf8ByteLength(payload.base64)}`);
    });

    const adapter = adapterFor(runtime.adapters, config);
    const promptCacheKey = callerTypeToString(callerType);
    const { request, codexRequest } = await prepareProviderRequest(runtime.adapters, runtime.codex, adapter, config,
      body as JsonValue, config.apiKey, promptCacheKey, 'RAW prompt 请求构建失败', agentSessionId);
    checkVisualCancellation(signal);
    logLlmRequestAudit('RAW_PROMPT', request.url, config.model, body as JsonValue, runtime.debugPersistConfig());
    const usageProtocol = effectiveApiProtocolForConfig(config);

    const maxAttempts = Math.max(1, establishMaxRetries);
    let normalized: JsonValue;
    for (let attemptIndex = 1; ; attemptIndex++) {
      checkVisualCancellation(signal);
      try {
        let response: Response;
        if (codexRequest !== null && runtime.codex !== undefined) {
          const send: typeof fetch = (input, init) => runtime.fetch(input, { ...init,
            ...(signal !== null ? { signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal } : {}) });
          response = await runtime.codex.sendWithSingleRefresh(codexRequest, { fetch: send });
        } else {
          try {
            response = await runtime.fetch(request.url, { method: 'POST', headers: transportHeaders(request, config),
              body: JSON.stringify(request.body), ...(signal !== null ? { signal } : {}) });
          } catch (error) {
            throw tagEstablishFailure(AppError.network(`RAW_PROMPT API请求失败: ${messageOf(error)}`), null);
          }
        }
        if (!response.ok) {
          const text = redactSensitiveText(await response.text().catch(() => ''));
          let error = AppError.llm(`RAW_PROMPT API请求失败: ${statusLine(response.status)} - ${text}`);
          if ([400, 413, 422].includes(response.status) && providerBodyIndicatesContextWindow(text)) {
            error = attachLlmErrorCode(error, LLM_ERROR_CODE_CONTEXT_WINDOW_EXCEEDED);
          }
          throw tagEstablishFailure(error, response.status);
        }
        let json: JsonValue;
        try { json = await response.json() as JsonValue; } catch (error) {
          checkVisualCancellation(signal);
          const message = `解析RAW_PROMPT响应失败: ${messageOf(error)}`;
          record(callerType, config.model, false, message, usageProtocol, 'heuristic', null, false);
          throw tagEstablishFailure(AppError.llm(message), null);
        }
        checkVisualCancellation(signal);
        try { normalized = normalizeNonstreamResponseToOpenaiForConfig(config, json); } catch (error) {
          const value = isAppError(error) ? error : AppError.llm(messageOf(error));
          record(callerType, config.model, false, value.message, usageProtocol, 'heuristic', null, false);
          throw tagEstablishFailure(value, null);
        }
        break;
      } catch (error) {
        checkVisualCancellation(signal);
        const value = isAppError(error) ? error : AppError.llm(messageOf(error));
        if (classifyLlmError(value) !== 'RetryableTransient' || attemptIndex >= maxAttempts) throw value;
        const backoff = 300 * 2 ** Math.min(attemptIndex - 1, 3);
        logWarn(`[RAW_PROMPT] 瞬态失败（${value.message}），${backoff}ms 后重试 ${attemptIndex + 1}/${maxAttempts}`);
        if (signal === null) await sleep(backoff);
        else {
          try { await delay(backoff, undefined, { signal }); }
          catch (error) { checkVisualCancellation(signal); throw error; }
        }
      }
    }

    const object = normalized as { choices?: { message?: { content?: unknown } }[]; usage?: JsonValue } | null;
    const content = object?.choices?.[0]?.message?.content;
    const assistantMessage = typeof content === 'string' ? content : '';
    const usage = object !== null && typeof object === 'object' && !Array.isArray(object) && 'usage' in object
      ? object.usage : undefined;
    const tokens = extractUsageTokens(usage ?? null, estimateTokens(assistantMessage),
      Math.max(1, Math.floor(utf8ByteLength(prompt) / 4)));
    record(callerType, config.model, true, null, usageProtocol, usage === undefined ? 'heuristic' : 'api', tokens, true);
    return { assistant_message: assistantMessage, raw_response: JSON.stringify(normalized),
      chain_of_thought_details: null, cancelled: false };
  }

  /** model2_pipeline.rs:8950 call_raw_prompt_with_config_scoped. A non-null agent session allows
   * OpenCode Go and becomes its `x-opencode-session` (prepare_agent_provider_request). */
  async function withFailover(config: ApiConfig, prompt: string, images: ImagePayload[] | null,
    opts: RawPromptOptions, callerType: LlmCallerType, task: string,
    agentSessionId: string | null = null, signal: AbortSignal | null = null): Promise<StandardModel2Output> {
    // Stop at the same await boundaries as dropping the Rust failover future. The shared
    // driver retains its policy/key/model decisions; only its caller-owned waits are cancellable.
    async function checked<T>(operation: () => Promise<T>): Promise<T> {
      checkVisualCancellation(signal);
      const value = await operation();
      checkVisualCancellation(signal);
      return value;
    }
    return runWithFailover({
      getFailoverPolicy: () => checked(() => runtime.manager.getFailoverPolicy()),
      getApiConfigs: () => checked(() => runtime.manager.getApiConfigs()),
      candidateApiKeysFor: (candidate) => checked(() => runtime.candidateApiKeysFor(candidate)),
      emit: (channel, payload) => { checkVisualCancellation(signal); runtime.emit(channel, payload); },
      ...(signal !== null ? { sleep: (milliseconds: number) => delay(milliseconds, undefined, { signal }) }
        : runtime.sleep ? { sleep: runtime.sleep } : {}),
    }, {
      task, scenario: 'BackgroundTask', userPinned: false, attemptsHandle429Internally: false,
      requiredIsMultimodal: images !== null && images.length > 0 ? true : null,
    }, config, (candidate, establishRetries) => attempt(candidate, prompt, images, opts, callerType, establishRetries, signal,
      agentSessionId));
  }

  /** model2_pipeline.rs:8786 call_raw_prompt_with_config_id_and_images_inner. */
  async function withConfigIdAndImages(configId: string, prompt: string, images: ImagePayload[],
    callerType: LlmCallerType, signal: AbortSignal | null = null): Promise<StandardModel2Output> {
    if (images.length === 0) throw AppError.configuration('多模态 raw prompt 至少需要一张图片');
    const configs = await runtime.manager.getApiConfigs();
    checkVisualCancellation(signal);
    const config = configs.find((candidate) => candidate.id === configId || candidate.model === configId);
    if (config === undefined) throw AppError.configuration(`找不到指定的多模态模型配置: ${configId}`);
    if (!config.enabled) throw AppError.configuration(`指定的多模态模型已禁用: ${configId}`);
    if (!config.isMultimodal || config.isEmbedding || config.isReranker || config.isImageGeneration) {
      throw AppError.configuration(`指定配置不是可用于视觉理解的多模态语言模型: ${configId}`);
    }
    return attempt(config, prompt, images, { forceJson: false, disableThinking: false }, callerType,
      ESTABLISH_RETRIES_WITHOUT_FALLBACK, signal);
  }

  /** model2_pipeline.rs:8702 call_with_config_id_raw_prompt_scoped, shared by both public exits. */
  async function withConfigIdScoped(configId: string, prompt: string, agentSessionId: string | null,
    signal: AbortSignal | null = null): Promise<StandardModel2Output> {
    checkVisualCancellation(signal);
    const configs = await runtime.manager.getApiConfigs();
    checkVisualCancellation(signal);
    let config = configs.find((candidate) => candidate.id === configId)
      ?? configs.find((candidate) => candidate.model === configId);
    if (config === undefined) {
      logWarn(`[compaction] config_id/model '${configId}' 未找到，回退到 Model2 默认配置`);
      config = await runtime.manager.getModel2Config();
    }
    // CR-R2-01: force_json=false so gpt-* models keep Markdown summaries.
    return withFailover(structuredClone(config), prompt, null, { forceJson: false, disableThinking: false }, 'chat_v2',
      'compaction', agentSessionId, signal);
  }

  return {
    /** :8682; synthesis.rs:73–77 drops the future on its caller-owned timeout. */
    async callWithConfigIdRawPrompt(configId, prompt, signal) {
      if (signal?.aborted) throw signal.reason;
      try {
        return await withConfigIdScoped(configId, prompt, null, signal ?? null);
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        throw error;
      }
    },
    /** model2_pipeline.rs:8692, retaining the real agent session. */
    callAgentCompactionRawPrompt: (configId, prompt, agentSessionId) =>
      withConfigIdScoped(configId, prompt, agentSessionId),
    /** model2_pipeline.rs:8867 → :8876 call_chat_title_raw_prompt_scoped. */
    async callAgentChatTitleRawPrompt(prompt, agentSessionId) {
      const config = await runtime.manager.getChatTitleModelConfig();
      return withFailover(config, prompt, null, { forceJson: true, disableThinking: true }, 'chat_v2', 'chat_title',
        agentSessionId);
    },
    async callModel2RawPrompt(prompt, images, callerType) {
      const config = await runtime.manager.getModel2Config();
      return withFailover(config, prompt, images, { forceJson: true, disableThinking: false }, callerType, 'utility');
    },
    /** model2_pipeline.rs:8632 → :8898 call_raw_prompt_with_config, else :8570 call_model2_raw_prompt. */
    async callAnkiRoutedRawPrompt(decision, task, prompt, images, signal) {
      if (signal?.aborted) throw signal.reason;
      const opts = { forceJson: true, disableThinking: false };
      try {
        if (decision !== null) {
          // `get_api_configs().await.ok()`: a read failure takes the same model2 fallback as a vanished config.
          const configs = await runtime.manager.getApiConfigs().catch((): ApiConfig[] => []);
          checkVisualCancellation(signal ?? null);
          const config = configs.find((candidate) => candidate.id === decision.configId && candidate.enabled
            && !candidate.isEmbedding && !candidate.isReranker && !candidate.isImageGeneration);
          if (config !== undefined) return await withFailover(config, prompt, images, opts, 'anki', task, null, signal ?? null);
          logDebug(`[ANKI_ROUTING] ${decision.role} 角色配置 ${decision.configId} 已不可用，回退 model2`);
        }
        const config = await runtime.manager.getModel2Config();
        return await withFailover(config, prompt, images, opts, 'anki', 'utility', null, signal ?? null);
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        throw error;
      }
    },
    async callModel2RawPromptOpts(prompt, forceJson, callerType, task, cancellation) {
      if (cancellation?.aborted) throw AppError.validation('cancelled');
      try {
        const config = await runtime.manager.getModel2Config();
        return await withFailover(config, prompt, null, { forceJson, disableThinking: false }, callerType, task,
          null, cancellation ?? null);
      } catch (error) {
        // handout.rs:41–62 owns this cancellation error. Wait for the aborted transport/
        // timer to unwind instead of racing a Promise that could still record a late result.
        if (cancellation?.aborted) throw AppError.validation('cancelled');
        throw error;
      }
    },
    /** model2_pipeline.rs:8842 call_memory_decision_raw_prompt → :8909 call_raw_prompt_with_config. */
    async callMemoryDecisionRawPrompt(prompt, signal) {
      // Rust consumers cancel by dropping this future (semantic_dedup.rs:335 tokio::time::timeout);
      // the cancellation outcome is the caller's, so reject with its own abort reason.
      if (signal?.aborted) throw signal.reason;
      try {
        const config = await runtime.manager.getMemoryDecisionModelConfig();
        return await withFailover(config, prompt, null, { forceJson: true, disableThinking: false }, 'memory',
          'memory_decision', null, signal ?? null);
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        throw error;
      }
    },
    callRawPromptWithConfigIdAndImages: (configId, prompt, images, callerType) =>
      withConfigIdAndImages(configId, prompt, images, callerType),
    async callRawPromptWithConfigIdAndImagesCancellable(configId, prompt, images, callerType, cancellation) {
      // tokio::select! biased: an already-cancelled token wins before the request future is polled;
      // cancelling also aborts the in-flight HTTP request (Rust drops the future).
      if (cancellation.aborted) throw AppError.llm('visual observation cancelled');
      return new Promise<StandardModel2Output>((resolve, reject) => {
        const onAbort = (): void => reject(AppError.llm('visual observation cancelled'));
        cancellation.addEventListener('abort', onAbort, { once: true });
        withConfigIdAndImages(configId, prompt, images, callerType, cancellation).then(resolve, reject)
          .finally(() => cancellation.removeEventListener('abort', onAbort));
      });
    },
  };
}
