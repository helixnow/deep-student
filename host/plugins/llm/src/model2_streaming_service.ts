/** Unified model-2 orchestration (model2_pipeline.rs:5191–7556). */
import { sha256HexSync } from '../../../platform/crypto/sync.ts';
const randomUUID = () => globalThis.crypto.randomUUID();
import { join } from '../../../platform/util/path.ts';
import type { ApiConfig, LLMManager, LlmMcpTools, LlmModel2Streaming, LlmProviderRequests,
  LlmStreamEvents, UnifiedModel2StreamInput } from '../api.ts';
import type { LlmCodexAuthService, JsonValue } from '../../llm-providers/api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import type { LogService } from '../../../platform/log/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';
import { runWithFailover } from './routing.ts';
import { chatMessagesRequireMultimodal } from './input_guard.ts';
import { applyRuntimeReasoningOverrides } from './runtime_reasoning.ts';
import { buildModel2Request, readModel2Setting, type WebSearchFallback } from './model2_request.ts';
import { establishModel2, readModel2, emitModel2, model2Timestamp } from './model2_transport.ts';
import { extractReasoningSections } from './model2_reasoning.ts';
import { logAndEmitLlmRequest } from './audit_log.ts';
import { logDebug, logInfo } from './logging.ts';
import { extractUsageTokens, type UsageTokens } from './usage.ts';
import { estimateTokens } from './tokens.ts';
import { chatV2StreamIdentity } from './stream_scope.ts';
import { effectiveApiProtocolForConfig } from './protocol.ts';
import { resolveQuirks } from './provider_quirks.ts';
import { requestAdapterForConfig } from './adapters/registry.ts';
import { removeKey } from './json_map.ts';
import { runtimeEnv } from './runtime_env.ts';

/** Pending F3 public boundary: no direct writes to the usage owner's tables. */
export type Model2UsageRecorder = import('../api.ts').LlmUsageRecorder;
export interface Model2StreamingRuntime {
  manager: LLMManager;
  settings: Pick<SettingsStore, 'get'>;
  requests: LlmProviderRequests;
  events: LlmStreamEvents;
  mcp: LlmMcpTools;
  codex: LlmCodexAuthService;
  fetch: typeof fetch;
  candidateApiKeysFor(config: ApiConfig): Promise<string[]>;
  dataDir: string;
  log?: LogService;
  usage(): Model2UsageRecorder | undefined;
  webSearch(): WebSearchFallback | null;
}

export function createModel2StreamingService(runtime: Model2StreamingRuntime): LlmModel2Streaming {
  const { manager } = runtime;
  async function attempt(config: ApiConfig, retries: number, input: UnifiedModel2StreamInput) {
    logDebug(`[model2_stream] 单次尝试: model=${config.model}, establish_max_retries=${retries}`);
    // Ordinary chat usage is recorded by L03's tool loop; variants/legacy require the F3 owner port.
    const usage = runtime.usage();
    if (input.taskContext !== 'chat_v2' && !usage) throw AppError.configuration('统一流式用量记录需要 F3 llmUsage.recordLlmUsageCacheExtWithIdentity 服务');
    if (runtimeEnv('CHAT_V2_CACHE_DEBUG') === '1' && !usage) throw AppError.configuration('Prompt-cache 调试需要 F3 llmUsage.cacheDebugEnabled 服务');
    const body = await buildModel2Request(config, input, runtime.settings, runtime.mcp, runtime.webSearch());
    const requestBytes = utf8ByteLength(JSON.stringify(body));
    const started = performance.now();
    const requestId = randomUUID();
    const cancel = await manager.subscribeCancelStream(input.streamEvent);
    let close: (() => void) | undefined;
    try {
      if (await manager.consumePendingCancel(input.streamEvent)) throw AppError.llm('请求已被用户取消');
      const requestAdapter = requestAdapterForConfig(config);
      if (body.tools !== undefined && requestAdapter.shouldDisableThinkingForTools(config, body)) {
        for (const key of ['enable_thinking', 'include_thoughts', 'thinking_budget', 'thinking']) removeKey(body, key);
        logDebug(`[LLMManager] Adapter ${requestAdapter.id} disabled thinking for tool calls`);
      }
      const prepared = await runtime.requests.prepareModel2Async(config, body, input.streamEvent, input.messageId ?? null,
        usage?.cacheDebugEnabled() ?? false);
      const persist = readModel2Setting(runtime.settings, 'debug.persist_logs') === 'true'
        ? { log_dir: runtime.log?.debugLogs.ensureDir() ?? join(runtime.dataDir, 'logs', 'debug-logs') } : null;
      logAndEmitLlmRequest('CHAT_STREAM', input.sink, input.streamEvent, input.messageId ?? null,
        config.model, prepared.request.url, prepared.request.body, persist);
      emitModel2(input, `${input.streamEvent}_start`, { id: requestId, model: config.model, request_bytes: requestBytes }, '发送开始事件失败');
      const established = await establishModel2(prepared, config, input, requestId, retries, manager, cancel, runtime.fetch, runtime.codex);
      close = established.close;
      emitModel2(input, `${input.streamEvent}_id`, { request_id: input.streamEvent, stream_event: input.streamEvent,
        timestamp: model2Timestamp() }, '发送ID事件失败');
      await runtime.log?.structured.logLlmUsage('start', config.name, config.model, config.modelAdapter, requestBytes, 0, 0, 0, null, null);
      const collector = runtime.events.create({ streamEvent: input.streamEvent, requestId, sink: input.sink,
        requireTerminalSuccess: prepared.requiresExplicitStreamCompletion, isCodex: prepared.request.codex });
      const read = await readModel2(established.response, prepared, input, requestId, manager, cancel, collector);
      const state = collector.snapshot();
      logDebug('流式响应完成统计（脱敏）:');
      for (const [label, text] of [['主内容', state.content], ['思维链', state.reasoning]] as const) {
        logDebug(`  - ${label}长度: ${utf8ByteLength(text)} 字符, hash: ${sha256HexSync(text).slice(0, 8)}`);
      }
      collector.complete(read.cancelled, input.enableChainOfThought);
      let reasoning: JsonValue = null;
      if (input.enableChainOfThought) {
        const policy = resolveQuirks(config).reasoning_passback;
        reasoning = { full_response: state.content, enabled: true, is_reasoning_model: policy !== 'no_passback', model_adapter: config.modelAdapter };
        if (policy !== 'no_passback') {
          reasoning.reasoning_content = state.reasoning || null;
          reasoning.parsed_sections = extractReasoningSections(state.reasoning || state.content);
          reasoning.passback_policy = policy === 'deep_seek_style' ? 'deepseek_style' : 'reasoning_details';
        }
      }
      const tokens = extractUsageTokens(state.usage, estimateTokens(state.content), Math.max(1, Math.floor(requestBytes / 4)));
      const durationMs = Math.floor(performance.now() - started);
      await runtime.log?.structured.logLlmUsage('end', config.name, config.model, config.modelAdapter,
        requestBytes, read.responseBytes, tokens.promptTokens, tokens.completionTokens, durationMs, null);
      if (input.taskContext !== 'chat_v2' && usage) {
        const identity = chatV2StreamIdentity(input.streamEvent) ?? { sessionId: input.streamEvent, variantId: null, runId: null };
        usage.recordLlmUsageCacheExtWithIdentity({ ...tokens, ...identity, callerType: 'chat_v2', model: config.model,
          durationMs, success: !read.cancelled, errorMessage: read.cancelled ? 'cancelled' : null,
          adapter: effectiveApiProtocolForConfig(config), tokenSource: state.usage === null ? 'heuristic' : 'api' });
      }
      return { assistant_message: read.cancelled ? '' : state.content, raw_response: 'stream_response',
        chain_of_thought_details: reasoning, cancelled: read.cancelled };
    } finally { close?.(); await manager.clearCancelArtifacts(input.streamEvent); }
  }
  return {
    callUnifiedModel2StreamWithConfig: attempt,
    async callUnifiedModel2Stream(input) {
      logInfo(`调用统一模型二接口(流式): 科目=${input.subject}, 思维链=${input.enableChainOfThought}, override_model=${input.modelOverrideId ?? 'None'}`);
      const task = input.taskContext?.includes('review') ? 'review' : input.taskContext === 'tag_generation' ? 'tag_generation' : 'default';
      try {
        const [primary] = await manager.selectModelFor(task, input.modelOverrideId, input.paramOverrides);
        return await runWithFailover({ getFailoverPolicy: () => manager.getFailoverPolicy(), getApiConfigs: () => manager.getApiConfigs(),
          candidateApiKeysFor: runtime.candidateApiKeysFor, emit: (name, payload) => input.sink.emit(name, payload) },
        { task, scenario: 'ChatMain', userPinned: input.modelOverrideId != null, attemptsHandle429Internally: true,
          requiredIsMultimodal: chatMessagesRequireMultimodal(input.chatHistory), paramOverrides: input.paramOverrides }, primary,
        async (config, retries) => {
          applyRuntimeReasoningOverrides(config, input.enableThinking, input.reasoningEffortOverride, input.thinkingBudgetOverride);
          return attempt(config, retries, input);
        });
      } finally { await manager.clearCancelArtifacts(input.streamEvent); }
    },
  };
}
