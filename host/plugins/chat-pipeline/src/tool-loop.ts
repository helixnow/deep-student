/** tool_loop.rs:468–2510 — execute_with_tools: one frozen request per round, same future for all rounds. */
import type { Context } from '@deepseek-ai/cordis';
import { ChatV2Error, type ChatV2Emitter, type TokenUsage } from '../../chat/api.ts';
import {
  LLM_ERROR_CODE_COMPACTION_REQUIRED, LLM_ERROR_CODE_CONTEXT_WINDOW_EXCEEDED, llmErrorCode,
  type ApiConfig, type LLMManager, type LlmModel2Streaming, type LlmStreamEvents, type LlmStreamHooks,
  type StandardModel2Output, type StreamEventSink as LlmStreamEventSink,
} from '../../llm/api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import type { McpToolSchema } from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import { rustTrim, utf8ByteLength } from '../../../platform/util/index.ts';
import type { PipelineContext } from './pipeline-context.ts';
import type { LegacyChatMessage } from './microcompact.ts';
import { ChatV2StreamingAdapter, type StreamingToolCall } from './llm-adapter.ts';
import { bindStreamingSink } from './stream-sink.ts';
import { StreamHooksGuard } from './stream-hooks-guard.ts';
import { buildRunScopedStreamEvent, isRetryableLlmError } from './parallel-exec.ts';
import { accumulate, fromEstimate } from './token-usage.ts';
import { estimateTokensWithModel } from './token-budget.ts';
import { parseU64 } from './budget.ts';
import { runStreamWithWatchdog, sinkUntilAbandoned } from './stream-watchdog.ts';
import { effectiveMaxToolRounds, LLM_STREAM_MAX_TOTAL_SECS, LLM_STREAM_TIMEOUT_SECS } from './constants.ts';
import {
  anchoredSkillIdsInHistory, buildTransientSkillMessagesWithAudit, insertSkillMessagesAfterToolResult,
  insertTransientSkillMessages, skillBodyDigest, type SessionSkillState, type SkillInjectionAudit,
  type TransientSkillMessages,
} from './skill-injection.ts';
import { isMcpToolAllowedByPolicy, prepareExternalToolSchema } from './canonical-tools.ts';
import {
  assignFinalRoundReasoningItems, freezeToolFaceForPromptCache, retainFailedRoundUsage,
  type ToolFacePrefixSnapshot,
} from './tool-face.ts';
import { shouldCompact } from './compaction-budget.ts';
import { insertRetrievalPageImageMessage } from './retrieval-images.ts';
import { messageForModel2 } from './unified-text-stream.ts';
import type { CompactionOutcome } from './compaction-outcome.ts';
import { compactionDidCompact, compactionIsFailed, compactionReasonCode, compactionTokenEstimates } from './compaction-outcome.ts';
import { InjectionThrottle } from '../../agent-workspace/portable.ts';
import type { InjectionResult } from '../../agent-workspace/api.ts';
import type { WorkspaceInjectionRuntime } from './workspace-injection.ts';

type Log = Pick<Context['logger'], 'info' | 'warn' | 'error' | 'debug'>;
export const errorMessage = (error: unknown): string => error instanceof Error ? error.message
  : error !== null && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    ? error.message : String(error);
const errorDetails = (error: unknown): unknown =>
  error !== null && typeof error === 'object' && 'details' in error ? (error as { details: unknown }).details : null;
const codeOf = (error: unknown): string | null => {
  const details = errorDetails(error);
  return details === null || details === undefined ? null
    : llmErrorCode({ details } as Parameters<typeof llmErrorCode>[0]);
};

/** tools/attempt_completion.rs TOOL_NAME. */
export const ATTEMPT_COMPLETION_TOOL_NAME = 'attempt_completion';
const LLM_MAX_RETRIES = 2;
const LLM_RETRY_DELAY_MS = 1000;

/** Session tool-face baseline as loaded by helpers.rs:1034 (memory cache + L04 persisted prefix). */
export interface ToolFaceBaselineStore {
  load(sessionId: string): ToolFacePrefixSnapshot;
  storeOrder(sessionId: string, baseline: readonly string[]): void;
}

/** Owner-provided pieces of one round. Each one is a real owner call; none is replaced by L03 logic. */
export interface ToolLoopDependencies {
  llm: LLMManager;
  streamEvents: LlmStreamEvents;
  model2: LlmModel2Streaming;
  log: Log;
  readSetting(key: string): string | null;
  toolFace: ToolFaceBaselineStore;
  loadEffectiveSkillState(sessionId: string, options: PipelineContext['options']): SessionSkillState;
  /** llm_usage::record_llm_usage_cache_ext (F3 owner); absence is logged by the composer. */
  recordUsage(record: RoundUsageRecord): void;
  /** Whether the event outlet has a window (Rust emitter.try_window().is_some()). */
  streamSinkFor(emitter: ChatV2Emitter): LlmStreamEventSink;
  window: import('../../../kernel/api.ts').WindowRef | null;
  reloadHistoryAndRecompile(ctx: PipelineContext): Promise<void>;
  runCompaction(ctx: PipelineContext, emitter: ChatV2Emitter): Promise<CompactionOutcome>;
  compactForRequest(ctx: PipelineContext, emitter: ChatV2Emitter, error: unknown): Promise<boolean>;
  runOverflowCompaction(ctx: PipelineContext, modelOverride: string | null, emitter: ChatV2Emitter):
    Promise<CompactionOutcome>;
  /** tool_loop.rs:1823–2442; executes one returned tool-call round. */
  toolRounds: ToolRoundRunner | null;
  workspace: WorkspaceInjectionRuntime | null;
}

export interface RoundUsageRecord {
  model: string; promptTokens: number; completionTokens: number; reasoningTokens: number | null;
  cachedTokens: number | null; cacheWriteTokens: number | null; sessionId: string; success: boolean;
  errorMessage: string | null; protocol: string | null; tokenSource: string | null;
}

export interface ToolRoundInput {
  ctx: PipelineContext; emitter: ChatV2Emitter; adapter: ChatV2StreamingAdapter;
  toolCalls: StreamingToolCall[]; recursionDepth: number; frozenToolSchemas: Map<string, unknown>;
  mcpToolNameMapping: Map<string, { rawToolName: string; preferredServerId: string | null }>;
  state: ToolRoundState;
  /** tool_loop.rs:2382: invoked after post-save/empty-argument stop, before task completion. */
  injectWorkspaceMessages(): void;
}
/** Window-level state carried between rounds (tool_loop.rs:478–534). */
export interface ToolRoundState {
  injectedSkillIds: Set<string>;
  inLoopSkillBatches: [string, string | null, LegacyChatMessage[]][];
  retrievalPageImageBatches: [string, LegacyChatMessage][];
  retrievalPageImageBudget: unknown;
  cumulativeSkillAudit: SkillInjectionAudit;
  previousEmptyRequiredTools: Set<string>;
}
export type ToolRoundOutcome = 'continue' | 'return';
export interface ToolRoundRunner {
  run(input: ToolRoundInput): Promise<ToolRoundOutcome>;
  /** The executing runtime's tool face; null keeps schemas exactly as the request supplied them. */
  readonly advertisement?: import('./tool-round.ts').ToolAdvertisement | null;
}

/** helpers.rs:186–225 */
export function loadMcpToolPolicy(read: (key: string) => string | null): [string[], string[]] {
  const list = (key: string) => (read(key) ?? '').split(',').map(rustTrim).filter(entry => entry !== '');
  const raw = read('mcp.tools.advertise_all_tools');
  const advertiseAll = raw !== null && ['true', '1'].includes(rustTrim(raw).replace(/[A-Z]/g, c => c.toLowerCase()));
  return [advertiseAll ? [] : list('mcp.tools.whitelist'), list('mcp.tools.blacklist')];
}

/** helpers.rs:345–385 load_stream_idle_config. Read failures are .ok().flatten() → default. */
export function loadStreamIdleConfig(read: (key: string) => string | null): { idleMs: number; cancelOnIdle: boolean } {
  const safe = (key: string) => { try { return read(key); } catch { return null; } };
  const rawTimeout = safe('chat.stream.timeout_ms');
  const timeout = rawTimeout === null ? null : parseU64(rawTimeout);
  const idleMs = timeout === null || timeout === 0n ? LLM_STREAM_TIMEOUT_SECS * 1000
    : Number(((timeout + 999n) / 1000n) > 7200n ? 7201n : (timeout + 999n) / 1000n) * 1000;
  const rawCancel = safe('chat.stream.auto_cancel_on_timeout');
  const cancelOnIdle = rawCancel === null || !['0', 'false'].includes(rustTrim(rawCancel).replace(/[A-Z]/g, c => c.toLowerCase()));
  return { idleMs, cancelOnIdle };
}

/** tool_loop.rs:862–911 vision_quality smart default. */
export function resolveVisionQuality(ctx: PipelineContext, log: Log): string {
  const specified = ctx.options.visionQuality;
  if (specified != null && specified !== '' && specified !== 'auto') {
    log.debug(`[ChatV2::pipeline] vision_quality: user specified '${specified}'`);
    return specified;
  }
  let images = 0; let pdfOrTextbook = false;
  for (const ref of ctx.userContextRefs) {
    for (const block of ref.formattedBlocks) if (block.type === 'image') images += 1;
    const type = ref.typeId.toLowerCase();
    if (type.includes('pdf') || type.includes('textbook') || type.includes('file') || ref.resourceId.startsWith('tb_')) {
      pdfOrTextbook = true;
    }
  }
  const quality = pdfOrTextbook || images >= 6 ? 'low' : images >= 2 ? 'medium' : 'high';
  log.info(`[ChatV2::pipeline] vision_quality: auto -> '${quality}' (images=${images}, has_pdf_or_textbook=${pdfOrTextbook})`);
  return quality;
}

/** token_resources.rs:21–130 get_or_estimate_usage. */
function getOrEstimateUsage(adapter: ChatV2StreamingAdapter, messages: readonly LegacyChatMessage[],
  completion: string, systemPrompt: string, modelId: string | null | undefined, log: Log): TokenUsage {
  const api = adapter.getApiUsage();
  if (api !== null) {
    log.debug(`[ChatV2::pipeline] Using API usage: prompt=${api.promptTokens}, completion=${api.completionTokens}`);
    return api;
  }
  log.debug('[ChatV2::pipeline] API usage not available, using estimation');
  let prompt = systemPrompt === '' ? '' : `${systemPrompt}\n`;
  for (const entry of messages) {
    prompt += `${entry.role}: ${entry.content}\n`;
    if (entry.thinking_content != null) prompt += `${entry.thinking_content}\n`;
    if (entry.tool_call != null) prompt += `${JSON.stringify(entry.tool_call.args_json)}\n`;
    if (entry.tool_result?.data_json != null) prompt += `${JSON.stringify(entry.tool_result.data_json)}\n`;
  }
  const reasoning = adapter.getAccumulatedReasoning();
  const reasoningTokens = reasoning === null || reasoning === '' ? null : estimateTokensWithModel(reasoning, modelId);
  const usage = fromEstimate(estimateTokensWithModel(prompt, modelId) + messages.length * 4,
    Math.min(0xffff_ffff, estimateTokensWithModel(completion, modelId) + (reasoningTokens ?? 0)), true);
  return reasoningTokens === null ? usage : { ...usage, reasoningTokens };
}

function sleepCancellable(ms: number, signal: AbortSignal | null): Promise<boolean> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(true); return; }
    const abort = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(false); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Rust protocol attribution for usage rows; resolved from the active config or null. */
function protocolOf(config: ApiConfig | null): string | null {
  if (config === null) return null;
  const value = (config as { apiProtocol?: string | null }).apiProtocol;
  return value ?? 'openai_chat_completions';
}

/** compaction.rs:1419 resolve_active_api_config: select_model_for(default, override) .ok(). */
export function resolveActiveApiConfig(llm: LLMManager, ctx: PipelineContext): Promise<ApiConfig | null> {
  const key = ctx.options.model2OverrideId ?? ctx.options.modelId ?? null;
  return llm.selectModelFor('default', key, { temperature: ctx.options.temperature,
    topP: ctx.options.topP, frequencyPenalty: ctx.options.frequencyPenalty,
    presencePenalty: ctx.options.presencePenalty, maxOutputTokens: ctx.options.maxTokens })
    .then(([config]) => config, () => null);
}

export class ToolLoop {
  private readonly deps: ToolLoopDependencies;
  constructor(deps: ToolLoopDependencies) { this.deps = deps; }

  resolveActiveApiConfig(ctx: PipelineContext): Promise<ApiConfig | null> {
    return resolveActiveApiConfig(this.deps.llm, ctx);
  }

  async executeWithTools(ctx: PipelineContext, emitter: ChatV2Emitter, systemPrompt: string,
    initialDepth: number): Promise<void> {
    const { log } = this.deps;
    const signal = ctx.cancellationToken();
    // pipeline.rs:1143: once the outer cancellation wins, this future has no continuation.
    const ensureActive = () => { if (signal?.aborted) throw new ChatV2Error('Cancelled'); };
    ensureActive();
    let recursionDepth = initialDepth;
    // tool_loop.rs:480–483: one throttle per execute_with_tools, not per tool round.
    const workspaceInjectionThrottle = new InjectionThrottle();
    let overflowRecoveryAttempted = false;
    let frozenTurnSkillInjection: TransientSkillMessages | null = null;
    const baseline = this.deps.toolFace.load(ctx.sessionId);
    const frozenToolSchemaOrder = [...baseline.order];
    const prefixGeneration = baseline.generation;
    let baselineSchemaDigest = baseline.schemaDigest;
    const frozenToolSchemas = new Map<string, unknown>();
    const state: ToolRoundState = {
      injectedSkillIds: new Set(), inLoopSkillBatches: [], retrievalPageImageBatches: [],
      retrievalPageImageBudget: null,
      cumulativeSkillAudit: { injectedSkillIds: [], droppedSkillIds: [], missingSkillIds: [], estimatedTokens: 0, skillStateVersion: 0 },
      previousEmptyRequiredTools: new Set(),
    };
    let compactionCheckedDepth: number | null = null;
    for (;;) {
      ensureActive();
      // hooks.rs default chain: ApprovalGateHook.before_turn is the trait default; TaskAuditHook logs.
      log.debug(`[ChatV2::audit] turn_start session=${ctx.sessionId} depth=${recursionDepth} accumulated_tool_results=${ctx.toolResults.length}`);
      const maxRecursion = effectiveMaxToolRounds(ctx.options.maxToolRecursion);
      if (maxRecursion !== null && !ctx.lastRoundHeartbeat && recursionDepth > maxRecursion) {
        log.warn(`[ChatV2::pipeline] Tool recursion limit reached: depth=${recursionDepth}, max=${maxRecursion}`);
        const limitMessage = `⚠️ 已达到工具调用限制（${maxRecursion} 轮）\n\nAI 已执行了 ${maxRecursion} 轮工具调用。为防止无限循环，已暂停自动执行。\n\n如果任务尚未完成，您可以：\n• 发送「继续」让 AI 继续执行\n• 发送新的指令调整方向\n• 手动完成剩余步骤`;
        pushToolLimitBlock(ctx, emitter, limitMessage,
          { content: limitMessage, recursionDepth, maxRecursion }, log);
        return;
      }
      if (ctx.needsCompaction) {
        compactionCheckedDepth = recursionDepth;
        // hooks.rs TaskAuditHook::before_compaction (ApprovalGateHook keeps the trait default).
        log.info(`[ChatV2::audit] in_loop_compaction_start session=${ctx.sessionId} depth=${recursionDepth} history_len=${ctx.chatHistory.length}`);
        try {
          const outcome = await this.deps.runCompaction(ctx, emitter);
          ensureActive();
          if (compactionDidCompact(outcome)) {
            const [before, after] = compactionTokenEstimates(outcome);
            emitter.emitCompactionCompleted(before, after);
            await this.deps.reloadHistoryAndRecompile(ctx);
            ensureActive();
          } else if (compactionIsFailed(outcome)) {
            const reason = compactionReasonCode(outcome);
            if (reason !== null) emitter.emitCompactionFailed(reason);
          }
        } catch (error) {
          ensureActive();
          log.error(`[ChatV2::pipeline] In-loop compaction failed for session=${ctx.sessionId} (history preserved): ${errorMessage(error)}`);
          ctx.needsCompaction = false;
          emitter.emitCompactionFailed('internalError');
        }
      }
      log.info(`[ChatV2::pipeline] Executing LLM call: session=${ctx.sessionId}, recursion_depth=${recursionDepth}, tool_results=${ctx.toolResults.length}`);
      const enableThinking = ctx.options.enableThinking ?? true;
      log.info(`[ChatV2::pipeline] enable_thinking=${enableThinking} (from options: ${ctx.options.enableThinking == null ? 'None' : `Some(${ctx.options.enableThinking})`})`);
      const wrapConfig = await this.resolveActiveApiConfig(ctx);
      ensureActive();
      const roundId = `tool-round-${recursionDepth}`;
      const adapter = new ChatV2StreamingAdapter(bindStreamingSink(emitter), ctx.assistantMessageId, {
        enableThinking, skillStateVersion: ctx.options.skillStateVersion, roundId, modelConfig: wrapConfig,
      });
      ctx.currentAdapter = adapter;

      const messages = structuredClone(ctx.chatHistory);
      if (frozenTurnSkillInjection === null) {
        const skillState = this.deps.loadEffectiveSkillState(ctx.sessionId, ctx.options);
        const contents = new Map(Object.entries(ctx.options.replaySkillContents ?? ctx.options.skillContents ?? {}));
        state.injectedSkillIds = anchoredSkillIdsInHistory(ctx.chatHistory);
        const dependencies = ctx.options.skillDependencies == null ? null
          : new Map(Object.entries(ctx.options.skillDependencies));
        const built = buildTransientSkillMessagesWithAudit(skillState, contents, dependencies,
          ctx.options.contextLimit ?? null, state.injectedSkillIds);
        for (const id of built.audit.injectedSkillIds) state.injectedSkillIds.add(id);
        state.cumulativeSkillAudit = structuredClone(built.audit);
        if (built.audit.injectedSkillIds.length > 0) {
          // types.rs SkillInjectionAnchors::default(): empty vectors/maps, before_turn_user=false.
          const anchors = ctx.options.skillInjectionAnchors ??= { beforeTurnUser: false };
          anchors.turnSkillIds = [...built.audit.injectedSkillIds];
          anchors.beforeTurnUser = ctx.options.isContinue !== true;
          for (const id of built.audit.injectedSkillIds) {
            const body = contents.get(id);
            if (body !== undefined) (anchors.skillContentDigests ??= {})[id] = skillBodyDigest(id, body);
          }
        }
        frozenTurnSkillInjection = built;
      }
      const audit = structuredClone(state.cumulativeSkillAudit);
      insertTransientSkillMessages(messages, messages.length, structuredClone(frozenTurnSkillInjection.messages));
      emitter.emitSkillInjectionAudit(ctx.assistantMessageId, {
        injectedSkillIds: audit.injectedSkillIds, droppedSkillIds: audit.droppedSkillIds,
        missingSkillIds: audit.missingSkillIds, estimatedTokens: audit.estimatedTokens,
        skillStateVersion: audit.skillStateVersion,
      }, null, audit.skillStateVersion, roundId);
      if (ctx.options.isContinue !== true) {
        if (ctx.compiledCurrentUserMessage === null) {
          throw new ChatV2Error('Other', 'current user message was not compiled before the provider request');
        }
        messages.push(structuredClone(ctx.compiledCurrentUserMessage));
      }
      log.debug(`[ChatV2::pipeline] Built LLM messages: history=${ctx.chatHistory.length}, transient_skills=${audit.injectedSkillIds.length}, current_user=${ctx.options.isContinue !== true}, content_len=${utf8ByteLength(ctx.userContent)}, has_images=${ctx.attachments.some(a => a.mimeType.startsWith('image/'))}, has_docs=${ctx.attachments.some(a => !a.mimeType.startsWith('image/'))}`);
      if (ctx.toolResults.length > 0) {
        const toolMessages = ctx.allToolResultsToMessages();
        messages.push(...toolMessages);
        for (const [anchor, roundLast, batch] of state.inLoopSkillBatches) {
          insertSkillMessagesAfterToolResult(messages, anchor, roundLast, structuredClone(batch));
        }
        for (const [roundLast, page] of state.retrievalPageImageBatches) {
          insertRetrievalPageImageMessage(messages, roundLast, structuredClone(page));
        }
        log.debug(`[ChatV2::pipeline] Added ALL ${toolMessages.length} tool result messages to chat history (tool_results count: ${ctx.toolResults.length})`);
      }

      const llmContext = new Map<string, unknown>();
      llmContext.set('chat_v2_compaction_checked', compactionCheckedDepth === recursionDepth);
      if (ctx.retrievedSources.rag != null) llmContext.set('prefetched_rag_sources', structuredClone(ctx.retrievedSources.rag));
      if (ctx.retrievedSources.memory != null) llmContext.set('prefetched_memory_sources', structuredClone(ctx.retrievedSources.memory));
      if (ctx.retrievedSources.webSearch != null) llmContext.set('prefetched_web_search_sources', structuredClone(ctx.retrievedSources.webSearch));
      llmContext.set('memory_enabled', ctx.options.memoryEnabled ?? true);
      llmContext.set('rag_enabled', ctx.options.ragEnabled ?? true);
      llmContext.set('web_search_enabled', ctx.options.webSearchEnabled ?? true);
      llmContext.set('vision_quality', resolveVisionQuality(ctx, log));

      const ids = ctx.options.schemaToolIds;
      let effectiveIds: string[] | null = null;
      if (ids != null && ids.length > 0) {
        effectiveIds = [...ids];
        if (!effectiveIds.includes(ATTEMPT_COMPLETION_TOOL_NAME)) {
          effectiveIds.push(ATTEMPT_COMPLETION_TOOL_NAME);
          log.debug('[ChatV2::pipeline] Auto-injected attempt_completion tool (Agent mode)');
        }
      }
      // The runtime that executes tools owns the schema registry, so an injected schema always has an executor.
      const advertisement = this.deps.toolRounds?.advertisement ?? null;
      if (advertisement === null && effectiveIds !== null) {
        log.debug('[ChatV2::pipeline] No tool runtime schema registry, schema_tool_ids are not advertised');
      }
      const injected = advertisement === null ? 0 : advertisement.injectSchemaTools(effectiveIds, llmContext);
      if (injected > 0) log.info(`[ChatV2::pipeline] Injected ${injected} tool schemas via schema_tool_ids`);
      if (ctx.workspaceId !== null) {
        log.debug('[ChatV2::pipeline] Workspace session detected, tools should come from builtin MCP server');
      }
      const mapping = new Map<string, { rawToolName: string; preferredServerId: string | null }>();
      const schemas = ctx.options.mcpToolSchemas as McpToolSchema[] | null | undefined;
      log.info(`[ChatV2::pipeline] 🔍 MCP tool schemas check: count=${schemas?.length ?? 0}, is_some=${schemas != null}`);
      if (schemas != null && schemas.length > 0) {
        log.info(`[ChatV2::pipeline] Processing ${schemas.length} MCP tool schemas from frontend`);
        const [whitelist, blacklist] = loadMcpToolPolicy(key => { try { return this.deps.readSetting(key); } catch { return null; } });
        log.debug(`[ChatV2::pipeline] MCP policy: whitelist=${JSON.stringify(whitelist)}, blacklist=${JSON.stringify(blacklist)}`);
        const values: unknown[] = [];
        const withheld: string[] = [];
        for (const tool of schemas) {
          const allowed = isMcpToolAllowedByPolicy(tool, whitelist, blacklist);
          if (!allowed && blacklist.includes(tool.name)) log.debug(`[ChatV2::pipeline] Tool '${tool.name}' blocked by blacklist`);
          else if (!allowed) log.debug(`[ChatV2::pipeline] Tool '${tool.name}' not in whitelist`);
          if (!allowed) continue;
          const prepared = prepareExternalToolSchema(tool, true);
          if (prepared === null) {
            log.warn(`[ChatV2::pipeline] Skipping MCP tool with blank API name: raw='${tool.name}'`);
            continue;
          }
          if (tool.serverId != null && rustTrim(tool.serverId) === '') {
            log.warn(`[ChatV2::pipeline] Ignoring blank MCP server id for tool '${prepared.rawToolName}'`);
          }
          // RUST-FIX(RF-W02-executable-only-tool-face): Rust advertises every frontend schema; withheld names never enter the frozen order.
          if (advertisement !== null && !advertisement.advertises(prepared.rawToolName)) {
            withheld.push(prepared.rawToolName);
            continue;
          }
          mapping.set(prepared.apiName, { rawToolName: prepared.rawToolName, preferredServerId: prepared.preferredServerId });
          values.push(prepared.schema);
        }
        const passed = values.length + withheld.length;
        if (passed < schemas.length) log.info(`[ChatV2::pipeline] MCP policy filtered: ${passed}/${schemas.length} tools allowed`);
        if (withheld.length > 0) log.info(`[ChatV2::pipeline] Withheld ${withheld.length} tool schema(s) without an executable executor: ${JSON.stringify(withheld)}`);
        if (values.length > 0) {
          const existing = llmContext.get('custom_tools');
          if (existing !== undefined) {
            if (Array.isArray(existing)) {
              existing.push(...values);
              log.info(`[ChatV2::pipeline] Appended ${values.length} MCP tools to custom_tools`);
            }
          } else {
            llmContext.set('custom_tools', values);
            log.info(`[ChatV2::pipeline] Injected ${values.length} MCP tools as custom_tools`);
          }
        }
        log.debug(`[ChatV2::pipeline] MCP tools (before filter): ${JSON.stringify(schemas.map(tool => tool.name))}`);
      }
      const customTools = llmContext.get('custom_tools');
      if (Array.isArray(customTools)) {
        const digest = freezeToolFaceForPromptCache(customTools, frozenToolSchemaOrder, frozenToolSchemas);
        if (digest !== null && digest !== baselineSchemaDigest) {
          log.info(`[ChatV2::pipeline] Tool schema digest changed (session_id=${ctx.sessionId}, generation=${prefixGeneration}, ${baselineSchemaDigest === null ? 'None' : `Some(${JSON.stringify(baselineSchemaDigest.slice(0, 12))})`} -> Some(${JSON.stringify(digest.slice(0, 12))})); single-variant path keeps generation unchanged — 变更随下一稳定窗口/多变体 converge 评估`);
          baselineSchemaDigest = digest;
        }
        this.deps.toolFace.storeOrder(ctx.sessionId, frozenToolSchemaOrder);
      }

      const streamEvent = buildRunScopedStreamEvent(ctx.sessionId, ctx.assistantMessageId,
        globalThis.crypto.randomUUID().replaceAll('-', ''), ctx.options.streamGeneration ?? null);
      const hooks: LlmStreamHooks = {
        onContentChunk: value => adapter.onContentChunk(value),
        onReasoningChunk: value => adapter.onReasoningChunk(value),
        onToolCallStart: (id, name) => adapter.onToolCallStart(id, name),
        onToolCallArgsDelta: (id, delta) => adapter.onToolCallArgsDelta(id, delta),
        onToolCall: value => adapter.onToolCall(value as unknown as LegacyChatMessage),
        onUsage: value => adapter.onUsage(value), onResponseReasoningItem: value => adapter.onResponseReasoningItem(value),
        onThoughtSignature: value => adapter.onThoughtSignature(value), onWebSearch: value => adapter.onWebSearch(value),
        onComplete: () => adapter.onComplete(),
      };
      const guard = new StreamHooksGuard(this.deps.streamEvents, this.deps.llm, streamEvent, hooks);
      this.deps.streamEvents.registerStreamHooks(streamEvent, hooks);
      const modelOverride = ctx.options.model2OverrideId ?? ctx.options.modelId ?? null;
      const maxInput = ctx.options.contextLimit ?? null;
      const outlet = this.deps.streamSinkFor(emitter);
      log.info(`[ChatV2::pipeline] Calling LLMManager, stream_event=${streamEvent}, model_override=${modelOverride === null ? 'None' : `Some(${JSON.stringify(modelOverride)})`}, top_p=${ctx.options.topP ?? 'None'}, max_tokens=${ctx.options.maxTokens ?? 'None'}, max_input_tokens=${maxInput ?? 'None'}`);
      const context: Record<string, JsonValue> = {};
      for (const [key, value] of llmContext) context[key] = value as JsonValue;
      context.deepseek_web_tools_disabled = ctx.options.disableTools ?? false;
      const history = messages.map(messageForModel2);
      const idle = loadStreamIdleConfig(this.deps.readSetting);
      const call = async (): Promise<StandardModel2Output> => {
        ensureActive();
        const outcome = await runStreamWithWatchdog({
          cancellation: signal,
          start: abandoned => this.deps.model2.callUnifiedModel2Stream({ context, chatHistory: history, subject: '',
            enableChainOfThought: true, enableThinking, taskContext: 'chat_v2', sink: sinkUntilAbandoned(outlet, abandoned),
            streamEvent, messageId: ctx.assistantMessageId, traceId: null, window: this.deps.window, disableTools: true,
            maxInputTokensOverride: maxInput, modelOverrideId: modelOverride, systemPromptOverride: systemPrompt,
            paramOverrides: { temperature: ctx.options.temperature, topP: ctx.options.topP,
              frequencyPenalty: ctx.options.frequencyPenalty, presencePenalty: ctx.options.presencePenalty,
              maxOutputTokens: ctx.options.maxTokens },
            reasoningEffortOverride: ctx.options.reasoningEffort ?? null,
            thinkingBudgetOverride: ctx.options.thinkingBudget ?? null }),
          cancelUpstream: () => {
            // Revoke callbacks before waking the transport: its cancellation epilogue can
            // flush pending tools. Those hooks belonged to the Rust future that was dropped.
            this.deps.streamEvents.unregisterStreamHooksIfOwner(streamEvent, hooks);
            return this.deps.llm.requestCancelStream(streamEvent);
          },
          idleLimitMs: idle.idleMs, totalLimitMs: LLM_STREAM_MAX_TOTAL_SECS * 1000,
          cancelOnIdle: idle.cancelOnIdle, idleElapsed: () => adapter.idleElapsedMs(),
        });
        ensureActive();
        if (outcome.kind === 'cancelled') throw new ChatV2Error('Cancelled');
        if (outcome.kind === 'idleTimeout') {
          throw Object.assign(new Error(`LLM stream call timed out: no data received for ${outcome.idleSecs}s`), { idle: outcome.idleSecs });
        }
        if (outcome.kind === 'totalTimeout') {
          throw Object.assign(new Error(`LLM stream call exceeded absolute time limit (${outcome.totalSecs}s)`), { total: outcome.totalSecs });
        }
        if (outcome.outcome.ok === false) throw outcome.outcome.error;
        return outcome.outcome.value;
      };
      const logTimeout = (error: unknown, retry: number) => {
        const record = error as { idle?: number; total?: number };
        if (record?.idle !== undefined) log.error(retry === 0
          ? `[ChatV2::pipeline] LLM stream idle timeout after ${record.idle}s without data, session=${ctx.sessionId}`
          : `[ChatV2::pipeline] LLM stream retry idle timeout after ${record.idle}s, session=${ctx.sessionId}, retry=${retry}/${LLM_MAX_RETRIES}`);
        if (record?.total !== undefined) log.error(retry === 0
          ? `[ChatV2::pipeline] LLM stream exceeded absolute limit ${record.total}s, session=${ctx.sessionId}`
          : `[ChatV2::pipeline] LLM stream retry exceeded absolute limit ${record.total}s, session=${ctx.sessionId}, retry=${retry}/${LLM_MAX_RETRIES}`);
      };
      let result: { ok: true; value: StandardModel2Output } | { ok: false; error: unknown };
      try {
        try { result = { ok: true, value: await call() }; }
        catch (error) { ensureActive(); logTimeout(error, 0); result = { ok: false, error }; }
        ensureActive();
        const hasOutput = adapter.getAccumulatedContent() !== '' || (adapter.getAccumulatedReasoning() ?? '') !== '' || adapter.hasPreparingBlocks();
        if (result.ok === false && hasOutput) {
          log.warn(`[ChatV2::pipeline] Stream failed after output; suppressing automatic retry/failover for session=${ctx.sessionId}`);
        }
        const localCompaction = result.ok === false && codeOf(result.error) === LLM_ERROR_CODE_COMPACTION_REQUIRED;
        if (result.ok === false && !hasOutput && !localCompaction) {
          for (let retry = 1; retry <= LLM_MAX_RETRIES; retry++) {
            if (signal?.aborted) break;
            const text = errorMessage(result.error);
            if (!isRetryableLlmError(text)) break;
            const delay = LLM_RETRY_DELAY_MS * (1 << (retry - 1));
            log.warn(`[ChatV2::pipeline] Transient LLM error, retry ${retry}/${LLM_MAX_RETRIES} after ${delay}ms: ${text}`);
            emitter.emitStreamReconnect(ctx.assistantMessageId, retry, LLM_MAX_RETRIES);
            if (await sleepCancellable(delay, signal)) throw new ChatV2Error('Cancelled');
            this.deps.streamEvents.unregisterStreamHooksIfOwner(streamEvent, hooks);
            adapter.resetStreamState();
            this.deps.streamEvents.registerStreamHooks(streamEvent, hooks);
            try { result = { ok: true, value: await call() }; }
            catch (error) { ensureActive(); logTimeout(error, retry); result = { ok: false, error }; }
            ensureActive();
            if (result.ok === true) { log.info(`[ChatV2::pipeline] LLM retry ${retry} succeeded`); break; }
            if (adapter.getAccumulatedContent() !== '' || (adapter.getAccumulatedReasoning() ?? '') !== '' || adapter.hasPreparingBlocks()) {
              log.warn(`[ChatV2::pipeline] Stream failed after output; suppressing automatic retry/failover for session=${ctx.sessionId}`);
              break;
            }
          }
        }
        await guard.cleanup();
      } finally { await guard.cleanup(); }
      ensureActive();

      if (result.ok === false && codeOf(result.error) === LLM_ERROR_CODE_COMPACTION_REQUIRED) {
        compactionCheckedDepth = recursionDepth;
        log.info(`[ChatV2::audit] in_loop_compaction_start session=${ctx.sessionId} depth=${recursionDepth} history_len=${ctx.chatHistory.length}`);
        const compacted = await this.deps.compactForRequest(ctx, emitter, result.error);
        ensureActive();
        if (compacted) {
          await this.deps.reloadHistoryAndRecompile(ctx);
          ensureActive();
        }
        adapter.resetStreamState();
        continue;
      }
      const hasOutputNow = adapter.getAccumulatedContent() !== '' || (adapter.getAccumulatedReasoning() ?? '') !== '' || adapter.hasPreparingBlocks();
      const details = result.ok === true ? null : errorDetails(result.error);
      const stage = details !== null && typeof details === 'object'
        ? ((details as { budget?: { stage?: unknown } }).budget?.stage ?? null) : null;
      const inputOverflow = result.ok === false && codeOf(result.error) === LLM_ERROR_CODE_CONTEXT_WINDOW_EXCEEDED && stage === 'input_guard';
      if (inputOverflow && !hasOutputNow && !adapter.hasToolCalls() && !overflowRecoveryAttempted) {
        overflowRecoveryAttempted = true;
        try {
          const outcome = await this.deps.runOverflowCompaction(ctx, modelOverride, emitter);
          ensureActive();
          if (compactionDidCompact(outcome)) {
            const [before, after] = compactionTokenEstimates(outcome);
            emitter.emitCompactionCompleted(before, after);
            await this.deps.reloadHistoryAndRecompile(ctx);
            ensureActive();
            adapter.resetStreamState();
            continue;
          }
          if (compactionIsFailed(outcome)) {
            const reason = compactionReasonCode(outcome);
            if (reason !== null) emitter.emitCompactionFailed(reason);
          }
        } catch (error) {
          ensureActive();
          log.warn(`[compaction] overflow recovery failed: ${errorMessage(error)}`);
          emitter.emitCompactionFailed('internalError');
        }
      }

      if (result.ok === false) {
        const failed = retainFailedRoundUsage(ctx.tokenUsage, adapter.getApiUsage());
        if (failed !== null) {
          log.info(`[ChatV2::pipeline] Retained partial usage from failed LLM round ${recursionDepth}: prompt=${failed.promptTokens}, completion=${failed.completionTokens}, total=${failed.totalTokens}; accumulated_total=${ctx.tokenUsage.totalTokens}`);
        }
        const text = errorMessage(result.error);
        const protocol = protocolOf(await this.resolveActiveApiConfig(ctx));
        ensureActive();
        const externallyCancelled = signal?.aborted ?? false;
        const model = ctx.modelDisplayName ?? ctx.options.modelId ?? 'unknown';
        this.deps.recordUsage({ model, promptTokens: failed?.promptTokens ?? 0, completionTokens: failed?.completionTokens ?? 0,
          reasoningTokens: failed?.reasoningTokens ?? null, cachedTokens: failed?.cachedTokens ?? null,
          cacheWriteTokens: failed?.cacheWriteTokens ?? null, sessionId: ctx.sessionId, success: false,
          errorMessage: externallyCancelled ? `cancelled by user (original error: ${text})` : text,
          protocol, tokenSource: failed?.source ?? null });
        if (externallyCancelled) {
          log.info(`[ChatV2::pipeline] LLM round ended after external cancellation, mapping to Cancelled (original error: ${text})`);
          const content = adapter.getAccumulatedContent(); const reasoning = adapter.getAccumulatedReasoning();
          if (content !== '' || (reasoning ?? '') !== '') {
            ctx.finalContent = content; ctx.finalReasoning = reasoning;
            ctx.streamingThinkingBlockId = adapter.getThinkingBlockId();
            ctx.streamingContentBlockId = adapter.getContentBlockId();
            ctx.collectStreamedTextSegments(adapter.getTextSegments(), ctx.assistantMessageId);
          }
          adapter.finalizeAll();
          ctx.pendingReasoningForApi = null;
          throw new ChatV2Error('Cancelled');
        }
        adapter.onError(text);
        log.error(`[ChatV2::pipeline] LLM call failed: ${text}`);
        if (codeOf(result.error) === LLM_ERROR_CODE_CONTEXT_WINDOW_EXCEEDED) {
          const budget = details !== null && typeof details === 'object' ? (details as { budget?: unknown }).budget ?? null : null;
          throw new ChatV2Error('ContextWindowExceeded', { message: text,
            details: { budget, lastRoundInputTokens: ctx.tokenUsage.lastRoundInputTokens ?? null } });
        }
        if (text.toLowerCase().includes('timed out')) throw new ChatV2Error('Timeout', text);
        throw new ChatV2Error('Llm', text);
      }

      const output = result.value;
      log.info(`[ChatV2::pipeline] LLM call succeeded, cancelled=${output.cancelled}, content_len=${utf8ByteLength(output.assistant_message)}`);
      ctx.finalContent = adapter.getAccumulatedContent();
      ctx.finalReasoning = adapter.getAccumulatedReasoning();
      ctx.streamingThinkingBlockId = adapter.getThinkingBlockId();
      ctx.streamingContentBlockId = adapter.getContentBlockId();
      log.info(`[ChatV2::pipeline] After LLM call: final_content_len=${utf8ByteLength(ctx.finalContent)}, final_reasoning=${ctx.finalReasoning === null ? 'None' : `Some(${utf8ByteLength(ctx.finalReasoning)})`}, thinking_block_id=${ctx.streamingThinkingBlockId === null ? 'None' : `Some(${JSON.stringify(ctx.streamingThinkingBlockId)})`}, content_block_id=${ctx.streamingContentBlockId === null ? 'None' : `Some(${JSON.stringify(ctx.streamingContentBlockId)})`}`);
      if (ctx.finalContent === '' && output.assistant_message !== '') ctx.finalContent = output.assistant_message;
      const usage = getOrEstimateUsage(adapter, messages, ctx.finalContent, systemPrompt, ctx.options.modelId, log);
      accumulate(ctx.tokenUsage, usage);
      log.info(`[ChatV2::pipeline] Token usage for round ${recursionDepth}: prompt=${usage.promptTokens}, completion=${usage.completionTokens}, total=${usage.totalTokens}, source=${usage.source}; Accumulated: prompt=${ctx.tokenUsage.promptTokens}, completion=${ctx.tokenUsage.completionTokens}, total=${ctx.tokenUsage.totalTokens}, source=${ctx.tokenUsage.source}`);
      const active = await this.resolveActiveApiConfig(ctx);
      ensureActive();
      if (!ctx.needsCompaction && shouldCompact({ tokenUsage: ctx.tokenUsage, options: ctx.options }, active)) {
        ctx.needsCompaction = true;
      }
      this.deps.recordUsage({ model: ctx.modelDisplayName ?? ctx.options.modelId ?? 'unknown',
        promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
        reasoningTokens: usage.reasoningTokens ?? null, cachedTokens: usage.cachedTokens ?? null,
        cacheWriteTokens: usage.cacheWriteTokens ?? null, sessionId: ctx.sessionId, success: true,
        errorMessage: null, protocol: protocolOf(active), tokenSource: usage.source });

      if (output.cancelled) {
        const dropped = adapter.takeToolCalls();
        if (dropped.length > 0) {
          log.warn(`[ChatV2::pipeline] LLM stream cancelled internally, discarding ${dropped.length} pending tool call(s) without execution, session=${ctx.sessionId}`);
        }
        ctx.collectStreamedTextSegments(adapter.getTextSegments(), ctx.assistantMessageId);
        adapter.finalizeAll();
        ctx.pendingReasoningForApi = null;
        throw new ChatV2Error('Cancelled');
      }
      const toolCalls = adapter.takeToolCalls();
      const webSources = adapter.takeWebSearchSources();
      if (webSources !== null && webSources.length > 0) {
        log.info(`[ChatV2::pipeline] Server-side web search sources: ${webSources.length} (session=${ctx.sessionId})`);
        ctx.retrievedSources.webSearch = webSources as never;
      }
      const webItems = adapter.takeWebSearchItems();
      if (webItems.length > 0) {
        log.debug(`[ChatV2::pipeline] Collected ${webItems.length} server-side web_search_call item(s) for replay (session=${ctx.sessionId})`);
        ctx.mergeResponseWebSearchItems(webItems);
      }
      if (toolCalls.length > 0) {
        log.info(`[ChatV2::pipeline] LLM returned ${toolCalls.length} tool calls, executing (parallel-safe calls run concurrently)...`);
        if (this.deps.toolRounds === null) {
          const missingServiceMsg = 'tool round execution requires the chatToolRuntime owner service, which is not installed';
          adapter.failPreparingBlocks(missingServiceMsg);
          throw new ChatV2Error('Tool', missingServiceMsg);
        }
        adapter.markPreparingPromoted();
        const next = await this.deps.toolRounds.run({ ctx, emitter, adapter, toolCalls, recursionDepth,
          frozenToolSchemas, mcpToolNameMapping: mapping, state,
          injectWorkspaceMessages: () => {
            ensureActive();
            const workspace = this.deps.workspace, workspaceId = ctx.workspaceId;
            if (workspace === null || workspaceId === null) return;
            let result: InjectionResult;
            // Rust if let Ok at tool_loop.rs:2389 deliberately ignores check errors.
            try { result = workspace.injector.checkAndInject(workspaceInjectionThrottle, workspaceId, ctx.sessionId, 2); }
            catch { return; }
            if (result.messages.length === 0) return;
            workspace.apply(ctx, emitter, workspaceId, result.messages, roundId);
            log.info(`[ChatV2::pipeline] Workspace tool-phase injection: ${result.messages.length} messages, depth=${recursionDepth}`);
          } });
        ensureActive();
        if (next === 'return') return;
        log.debug(`[ChatV2::pipeline] Continuing tool loop, depth=${recursionDepth}->${recursionDepth + 1}`);
        recursionDepth += 1;
        continue;
      }
      assignFinalRoundReasoningItems(ctx.responseReasoningByToolCallId as Map<string, JsonValue>,
        adapter.getResponseReasoningItems() as [string | null, JsonValue][]);
      ctx.collectStreamedTextSegments(adapter.getTextSegments(), ctx.assistantMessageId);
      ctx.pendingReasoningForApi = null;
      log.info(`[ChatV2::pipeline] LLM call completed without tool calls, recursion_depth=${recursionDepth}, total interleaved_blocks=${ctx.interleavedBlockIds.length}`);
      return;
    }
  }
}

/** tool_loop.rs:2521–2580 push_tool_limit_block. */
export function pushToolLimitBlock(ctx: PipelineContext, emitter: ChatV2Emitter, limitMessage: string,
  payload: Record<string, unknown>, log: Log): void {
  const blockId = ChatV2StreamingAdapter.generateBlockId();
  const now = Date.now();
  emitter.emitStart('tool_limit', ctx.assistantMessageId, blockId, null, null);
  emitter.emitEnd('tool_limit', blockId, payload, null);
  ctx.addInterleavedBlock({ id: blockId, messageId: ctx.assistantMessageId, type: 'tool_limit',
    status: 'success', content: limitMessage, startedAt: now, endedAt: now, firstChunkAt: now });
  log.info(`[ChatV2::pipeline] Created tool_limit block: id=${blockId}, message_id=${ctx.assistantMessageId}`);
}
