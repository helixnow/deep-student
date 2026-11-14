/** multi_variant.rs:1067 execute_single_variant_with_config — one variant's stream and tool loop over the
 * L04 VariantExecutionContext, with its system prompt (:2061), config lookup and compaction excludes (:2270).
 */
import {
  ChatV2Error, type CanonicalContentPart, type SharedContext, type TokenUsage, type VariantMeta,
} from '../../chat/api.ts';
import {
  LLM_ERROR_CODE_COMPACTION_REQUIRED, type ApiConfig, type LlmStreamHooks, type StandardModel2Output,
} from '../../llm/api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import type { McpToolSchema, SkillStateSnapshot } from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import type { SendContextRef } from '../../../../contracts/ipc/generated/_shared.ts';
import type { WindowRef } from '../../../kernel/api.ts';
import { preBudgetOutput } from '../../../kernel/agent-api.ts';
import { compareUtf8, rustTrim } from '../../../platform/util/portable.ts';
import type { PipelineSendRequest } from '../api.ts';
import { PipelineContext } from './pipeline-context.ts';
import type { LegacyChatMessage } from './microcompact.ts';
import { compileFrozenContext } from './context-compiler.ts';
import { freezeExecutionContext } from './freeze-execution.ts';
import { buildCanonicalCurrentContent } from './execute.ts';
import { PromptBuilder } from './prompt-builder.ts';
import { bindStreamingSink } from './stream-sink.ts';
import { StreamHooksGuard } from './stream-hooks-guard.ts';
import { VariantStreamingAdapter, type VariantMessageBlock, type VariantStreamHost } from './variant-adapter.ts';
import type { StreamEventMeta, StreamingToolCall } from './llm-adapter.ts';
import { buildRunScopedStreamEvent } from './parallel-exec.ts';
import { effectiveMaxToolRounds, LLM_STREAM_MAX_TOTAL_SECS } from './constants.ts';
import { errorMessage, loadMcpToolPolicy, loadStreamIdleConfig } from './tool-loop.ts';
import { messageForModel2 } from './unified-text-stream.ts';
import { runStreamWithWatchdog, sinkUntilAbandoned } from './stream-watchdog.ts';
import { isMcpToolAllowedByPolicy, prepareExternalToolSchema, isLoadSkillsToolName } from './canonical-tools.ts';
import { freezeToolFaceForPromptCache, mergeRoundResultsInCallOrder, type ToolFacePrefixSnapshot } from './tool-face.ts';
import {
  anchoredSkillIdsInHistory, buildInLoopSkillMessages, buildTransientSkillMessagesWithAudit,
  insertSkillMessagesAfterToolResult, insertTransientSkillMessages, type SessionSkillState,
} from './skill-injection.ts';
import { canonicalImageBlobHashes, countRequestImages, insertRetrievalPageImageMessage, RetrievalPageImageBudget } from './retrieval-images.ts';
import { sourceUserCanonicalBeforeAssistant } from './multi-variant.ts';
import type { VariantDependencies, VariantExecution } from './variant-run-ports.ts';

/** multi_variant.rs:4 session_skill_state_from_snapshot (legacy_migrated=false is not modelled in the L03 view). */
function stateFromSnapshot(snapshot: SkillStateSnapshot): SessionSkillState {
  return { manualPinnedSkillIds: snapshot.manualPinnedSkillIds ?? [], modeRequiredBundleIds: snapshot.modeRequiredBundleIds ?? [],
    agenticSessionSkillIds: snapshot.agenticSessionSkillIds ?? [], branchLocalSkillIds: snapshot.branchLocalSkillIds ?? [],
    version: snapshot.version };
}
const byteSort = (values: string[]) => values.sort(compareUtf8);
/** types.rs:1276 with_added_branch_local_skills */
function withAddedBranchLocalSkills(state: SessionSkillState, ids: readonly string[]): SessionSkillState {
  const branch = [...state.branchLocalSkillIds];
  for (const id of ids) if (!branch.includes(id)) branch.push(id);
  return { ...state, branchLocalSkillIds: [...new Set(byteSort(branch))], version: state.version + 1 };
}

/** Adapter host over the L04 VariantExecutionContext (variant_adapter.rs drives ctx directly). */
class VariantHostBridge implements VariantStreamHost {
  private readonly ctx: VariantExecution;
  private readonly sink: ReturnType<typeof bindStreamingSink>;
  lastActivity = performance.now();
  constructor(ctx: VariantExecution) { this.ctx = ctx; this.sink = bindStreamingSink(ctx.emitter()); }
  get variantId(): string { return this.ctx.variantId(); }
  get messageId(): string { return this.ctx.messageId(); }
  addInterleavedBlock(block: VariantMessageBlock): number {
    return this.ctx.addInterleavedBlock({ id: block.id, messageId: block.messageId, type: block.blockType,
      status: block.status, content: block.content, startedAt: block.startedAt, endedAt: block.endedAt,
      firstChunkAt: block.firstChunkAt, blockIndex: block.blockIndex });
  }
  appendInterleavedBlockContent(blockId: string, text: string): boolean { return this.ctx.appendInterleavedBlockContent(blockId, text); }
  getThinkingBlockId(): string | null { return this.ctx.getThinkingBlockId(); }
  getContentBlockId(): string | null { return this.ctx.getContentBlockId(); }
  setThinkingBlockId(id: string): void { this.ctx.setThinkingBlockId(id); }
  setContentBlockId(id: string): void { this.ctx.setContentBlockId(id); }
  appendContent(text: string): void { this.ctx.appendContent(text); }
  appendReasoning(text: string): void { this.ctx.appendReasoning(text); }
  addToolCall(call: StreamingToolCall): void { this.ctx.addToolCall(call); }
  takeToolCalls(): StreamingToolCall[] { return this.ctx.takeToolCalls(); }
  setUsage(usage: TokenUsage): void { this.ctx.setUsage(usage); }
  resetForNewRound(): void { this.ctx.resetForNewRound(); }
  emitToolCallPreparingStart(toolCallId: string, toolName: string, blockId: string, metadata?: StreamEventMeta): void {
    this.sink.emitToolCallPreparingStart(this.messageId, toolCallId, toolName, blockId, {
      variantId: this.variantId, skillStateVersion: metadata?.skillStateVersion ?? null, roundId: metadata?.roundId ?? null });
  }
  emitStart(type: string, blockId: string, payload: unknown | null): void { this.ctx.emitStart(type, blockId, payload); }
  emitChunk(type: string, blockId: string, chunk: string): void { this.ctx.emitChunk(type, blockId, chunk); }
  emitEnd(type: string, blockId: string, result: unknown | null): void { this.ctx.emitEnd(type, blockId, result); }
  emitError(type: string, blockId: string, error: string): void {
    this.sink.emitError(type, blockId, error, {
      variantId: this.variantId, skillStateVersion: null, roundId: null });
  }
}

async function resolveApiConfigById(deps: VariantDependencies, key: string | null | undefined): Promise<ApiConfig | null> {
  if (key == null) return null;
  const trimmed = rustTrim(key);
  if (trimmed === '') return null;
  let configs: ApiConfig[];
  try { configs = await deps.llm.getApiConfigs(); }
  catch (error) {
    deps.log.warn(`[ChatV2::pipeline] resolve_api_config_by_id: failed to load API configs (key=${trimmed}): ${errorMessage(error)}; falling back to defaults`);
    return null;
  }
  return configs.find(config => config.id === trimmed) ?? configs.find(config => config.model === trimmed) ?? null;
}

/** multi_variant.rs:2061 build_system_prompt_with_shared_context */
function buildPrompt(deps: VariantDependencies, options: PipelineContext['options'], shared: SharedContext) {
  // canvas_note_source / VFS todo summary / memory profile / goals are owner providers (Rust Option sources).
  if (options.canvasNoteId != null) deps.missing('canvas note source (variant)', 'canvas note is not injected for variants');
  if (options.memoryEnabled !== false) deps.missing('memory profile (variant)', 'user profile is not injected for variants');
  deps.missing('VfsTodoRepo.get_active_todo_summary', 'active todo summary is not injected for variants');
  return new PromptBuilder(options.systemPromptOverride).withSharedContext(shared).withOptions(options)
    .withCanvasNote(null).withUserProfile(null).withActiveTodos(null).withActiveGoal(null)
    .withRendererCapabilities(deps.rendererCapabilities()).buildSplit();
}

/** multi_variant.rs:2270 */
function compactionExcludeIds(deps: VariantDependencies, sessionId: string, assistantId: string): string[] {
  const conn = deps.connection();
  const messages = deps.owner.getMessagesByIdsWithConn(conn, sessionId, deps.owner.getSessionMessageIdsWithConn(conn, sessionId));
  const ids = [assistantId];
  const index = messages.findIndex(message => message.id === assistantId);
  if (index >= 0) {
    const user = messages.slice(0, index).reverse().find(message => message.role === 'user');
    if (user !== undefined) ids.push(user.id);
  }
  return ids;
}

/** multi_variant.rs:1067 execute_single_variant_with_config */
export async function runVariant(deps: VariantDependencies, ctx: VariantExecution, configId: string, variantMeta: VariantMeta | null,
  inputOptions: PipelineContext['options'], userContent: string, sessionId: string, shared: SharedContext,
  contextRefs: SendContextRef[], baseline: ToolFacePrefixSnapshot, window: WindowRef | null): Promise<void> {
  const { log, owner } = deps;
  const maxToolRounds = effectiveMaxToolRounds(inputOptions.maxToolRecursion);
  let options = structuredClone(inputOptions);
  options.modelId = configId; options.model2OverrideId = configId;
  if (ctx.isCancelled()) { ctx.cancel(); return; }
  const compile = new PipelineContext({ sessionId, content: userContent, options, assistantMessageId: ctx.messageId(),
    userContextRefs: contextRefs } as PipelineSendRequest);
  compile.initContextSnapshot(log);
  compile.setCancellationToken(ctx.cancelToken());
  if (contextRefs.length === 0) {
    const conn = deps.connection();
    const messages = owner.getMessagesByIdsWithConn(conn, sessionId, owner.getSessionMessageIdsWithConn(conn, sessionId));
    const canonical = sourceUserCanonicalBeforeAssistant(messages, ctx.messageId());
    if (canonical !== null) {
      const kept: CanonicalContentPart[] = canonical.filter(part => part.type !== 'derived_artifact_ref');
      kept.push(...(variantMeta?.canonicalArtifacts ?? []));
      compile.canonicalContent = kept;
    }
  }
  await freezeExecutionContext(compile, deps.llm, deps.ocr, () => buildCanonicalCurrentContent(compile, null), log);
  options = structuredClone(compile.options);
  const parts = buildPrompt(deps, options, shared);
  compile.turnVolatileContext = parts.turnVolatile;
  compile.chatHistory = await deps.history.loadVariantChatHistory(sessionId, ctx.messageId());
  await compileFrozenContext(compile, deps.compilePorts, log);
  const meta: VariantMeta = structuredClone(variantMeta ?? {});
  meta.executionSnapshot = compile.executionSnapshot;
  const artifacts = compile.canonicalContent.filter(part => part.type === 'derived_artifact_ref');
  if (artifacts.length > 0) meta.canonicalArtifacts = artifacts; else delete meta.canonicalArtifacts;
  ctx.setMeta(meta);
  ctx.startStreaming();
  const snapshot = compile.executionSnapshot;
  const seed = snapshot !== null && snapshot.resolvedModelIsMultimodal
    ? [snapshot.generationPlan.imageBudget, canonicalImageBlobHashes(compile.canonicalContent)] as const : null;
  const systemPrompt = parts.stableSystem;
  const history = compile.chatHistory;
  compile.chatHistory = [];
  if (compile.compiledCurrentUserMessage === null) throw new ChatV2Error('Other', 'variant user message was not compiled');
  const current = compile.compiledCurrentUserMessage;
  const enableThinking = options.enableThinking ?? true;
  const maxInput = options.contextLimit ?? null;
  const hasTools = (options.mcpToolSchemas?.length ?? 0) > 0;
  const disableTools = (options.disableTools ?? false) || !hasTools;
  const baseHistoryLen = history.length;
  const messages: LegacyChatMessage[] = [...history, current];
  const pageBudget = seed === null ? null : new RetrievalPageImageBudget(seed[0], countRequestImages(messages), seed[1]);
  const wrapConfig = await resolveApiConfigById(deps, options.modelId);
  const host = new VariantHostBridge(ctx);
  const adapter = new VariantStreamingAdapter(host, { enableThinking, skillStateVersion: options.skillStateVersion,
    roundId: 'variant-tool-round-0', modelConfig: wrapConfig });
  const streamEvent = buildRunScopedStreamEvent(sessionId, ctx.variantId(), globalThis.crypto.randomUUID().replaceAll('-', ''),
    options.streamGeneration ?? null);
  const touch = <T extends unknown[]>(fn: (...args: T) => void) => (...args: T) => { host.lastActivity = performance.now(); fn(...args); };
  const hooks: LlmStreamHooks = {
    onContentChunk: touch((text: string) => adapter.onContentChunk(text)),
    onReasoningChunk: touch((text: string) => adapter.onReasoningChunk(text)),
    onToolCallStart: touch((id: string, name: string) => adapter.onToolCallStart(id, name)),
    onToolCallArgsDelta: touch((id: string, delta: string) => adapter.onToolCallArgsDelta(id, delta)),
    onToolCall: touch(value => adapter.onToolCall(value as unknown as LegacyChatMessage)),
    onToolResult: touch(value => adapter.onToolResult(value as unknown as LegacyChatMessage)),
    onUsage: touch(value => adapter.onUsage(value)),
    onComplete: touch(() => adapter.onComplete()),
  };
  const guard = new StreamHooksGuard(deps.streamEvents, deps.llm, streamEvent, hooks);
  deps.streamEvents.registerStreamHooks(streamEvent, hooks);
  try {
    const context: Record<string, JsonValue> = {};
    if (shared.ragSources != null) context.prefetched_rag_sources = structuredClone(shared.ragSources) as JsonValue;
    if (shared.memorySources != null) context.prefetched_memory_sources = structuredClone(shared.memorySources) as JsonValue;
    if (shared.graphSources != null) context.prefetched_graph_sources = structuredClone(shared.graphSources) as JsonValue;
    if (shared.webSearchSources != null) context.prefetched_web_search_sources = structuredClone(shared.webSearchSources) as JsonValue;
    context.memory_enabled = options.memoryEnabled ?? true;
    context.rag_enabled = options.ragEnabled ?? true;
    context.web_search_enabled = options.webSearchEnabled ?? true;
    context.vision_quality = options.visionQuality ?? 'auto';
    const mapping = new Map<string, { rawToolName: string; preferredServerId: string | null }>();
    const [whitelist, blacklist] = loadMcpToolPolicy(key => { try { return deps.readSetting(key); } catch { return null; } });
    const frozenOrder = [...baseline.order];
    const frozenSchemas = new Map<string, unknown>();
    let variantDigest = baseline.schemaDigest;
    const advertisement = deps.toolRounds?.advertisement ?? null;
    const prepareAll = (schemas: readonly McpToolSchema[], refreshed: boolean): unknown[] => {
      const withheld: string[] = [];
      const values = schemas.filter(tool => isMcpToolAllowedByPolicy(tool, whitelist, blacklist)).flatMap(tool => {
        const prepared = prepareExternalToolSchema(tool, true);
        if (prepared === null) {
          log.warn(refreshed ? `[ChatV2::VariantPipeline] Skipping refreshed MCP tool with blank API name: raw='${tool.name}'`
            : `[ChatV2::VariantPipeline] Skipping MCP tool with blank API name: raw='${tool.name}'`);
          return [];
        }
        if (!refreshed && tool.serverId != null && rustTrim(tool.serverId) === '') {
          log.warn(`[ChatV2::VariantPipeline] Ignoring blank MCP server id for tool '${prepared.rawToolName}'`);
        }
        // RUST-FIX(RF-W02-executable-only-tool-face): multi_variant.rs:898 advertises every frontend schema to the variant.
        if (advertisement !== null && !advertisement.advertises(prepared.rawToolName)) {
          withheld.push(prepared.rawToolName);
          return [];
        }
        mapping.set(prepared.apiName, { rawToolName: prepared.rawToolName, preferredServerId: prepared.preferredServerId });
        return [prepared.schema];
      });
      if (withheld.length > 0) {
        log.info(`[ChatV2::VariantPipeline] Withheld ${withheld.length} tool schema(s) without an executable executor: ${JSON.stringify(withheld)}`);
      }
      return values;
    };
    if (!disableTools && options.mcpToolSchemas != null) {
      const values = prepareAll(options.mcpToolSchemas as McpToolSchema[], false);
      if (values.length > 0) {
        const digest = freezeToolFaceForPromptCache(values, frozenOrder, frozenSchemas);
        if (digest !== null) variantDigest = digest;
        context.custom_tools = values as JsonValue;
        log.info(`[ChatV2::VariantPipeline] variant=${ctx.variantId()} injected ${values.length} tools`);
      }
    }
    const snapshotState = variantMeta?.skillSnapshotAfter ?? variantMeta?.skillSnapshotBefore ?? null;
    let skillState = snapshotState !== null ? stateFromSnapshot(snapshotState)
      : deps.loadEffectiveSkillState(sessionId, options);
    const injected = anchoredSkillIdsInHistory(messages);
    const contents = () => new Map(Object.entries(options.replaySkillContents ?? options.skillContents ?? {}));
    const dependencies = options.skillDependencies == null ? null : new Map(Object.entries(options.skillDependencies));
    const turnSkills = buildTransientSkillMessagesWithAudit(skillState, contents(), dependencies, options.contextLimit ?? null, injected);
    for (const id of turnSkills.audit.injectedSkillIds) injected.add(id);
    const audit = structuredClone(turnSkills.audit);
    insertTransientSkillMessages(messages, baseHistoryLen, turnSkills.messages);
    let toolRound = 0;
    let compactionCheckedRound: number | null = null;
    let historyPrefixLen = baseHistoryLen;
    const idle = () => Math.max(0, performance.now() - host.lastActivity);
    for (;;) {
      if (ctx.isCancelled()) { ctx.cancel(); break; }
      const auditRound = `variant-tool-round-${toolRound}`;
      ctx.emitter().emitSkillInjectionAudit(ctx.messageId(), { injectedSkillIds: audit.injectedSkillIds,
        droppedSkillIds: audit.droppedSkillIds, missingSkillIds: audit.missingSkillIds,
        estimatedTokens: audit.estimatedTokens, skillStateVersion: audit.skillStateVersion },
      ctx.variantId(), audit.skillStateVersion, auditRound);
      context.chat_v2_compaction_checked = compactionCheckedRound === toolRound;
      const idleConfig = loadStreamIdleConfig(deps.readSetting);
      const outlet = deps.streamSinkFor(ctx.emitter());
      const raced = await runStreamWithWatchdog({
        cancellation: ctx.cancelToken(),
        start: abandoned => deps.model2.callUnifiedModel2Stream({ context: { ...context },
          chatHistory: messages.map(messageForModel2), subject: '', enableChainOfThought: true, enableThinking,
          taskContext: 'chat_v2_variant', sink: sinkUntilAbandoned(outlet, abandoned), streamEvent,
          messageId: ctx.messageId(), traceId: null, window, disableTools, maxInputTokensOverride: maxInput,
          modelOverrideId: options.modelId ?? null, systemPromptOverride: systemPrompt,
          paramOverrides: { temperature: options.temperature, topP: options.topP, frequencyPenalty: options.frequencyPenalty,
            presencePenalty: options.presencePenalty, maxOutputTokens: options.maxTokens },
          reasoningEffortOverride: options.reasoningEffort ?? null, thinkingBudgetOverride: options.thinkingBudget ?? null }),
        cancelUpstream: () => {
          // Revoke hooks first: the transport's cancellation epilogue must not reach the variant adapter.
          deps.streamEvents.unregisterStreamHooksIfOwner(streamEvent, hooks);
          return deps.llm.requestCancelStream(streamEvent);
        },
        idleLimitMs: idleConfig.idleMs, totalLimitMs: LLM_STREAM_MAX_TOTAL_SECS * 1000,
        cancelOnIdle: idleConfig.cancelOnIdle, idleElapsed: idle,
      });
      let result: { ok: true; value: StandardModel2Output } | { ok: false; error: unknown } | null;
      if (raced.kind === 'cancelled') {
        log.info(`[ChatV2::VariantPipeline] LLM call cancelled via token, variant=${ctx.variantId()}, round=${toolRound}`);
        result = null;
      } else if (raced.kind === 'idleTimeout') {
        log.error(`[ChatV2::VariantPipeline] LLM stream idle timeout after ${raced.idleSecs}s, variant=${ctx.variantId()}, round=${toolRound}`);
        await guard.cleanup();
        const message = `LLM stream timed out: no data received for ${raced.idleSecs}s`;
        adapter.failPreparingBlocks(message);
        ctx.fail(message);
        throw new ChatV2Error('Timeout', message);
      } else if (raced.kind === 'totalTimeout') {
        log.error(`[ChatV2::VariantPipeline] LLM stream exceeded absolute limit ${raced.totalSecs}s, variant=${ctx.variantId()}, round=${toolRound}`);
        await guard.cleanup();
        const message = `LLM stream exceeded absolute time limit (${raced.totalSecs}s)`;
        adapter.failPreparingBlocks(message);
        ctx.fail(message);
        throw new ChatV2Error('Timeout', message);
      } else result = raced.outcome.ok ? { ok: true, value: raced.outcome.value } : { ok: false, error: raced.outcome.error };
      if (result === null) { ctx.cancel(); break; }
      if (result.ok) {
        if (result.value.cancelled) { ctx.cancel(); break; }
      } else {
        const details = result.error !== null && typeof result.error === 'object' && 'details' in result.error
          ? (result.error as { details: unknown }).details : null;
        const code = details !== null && typeof details === 'object' ? (details as Record<string, unknown>).llm_error_code : undefined;
        if (code === LLM_ERROR_CODE_COMPACTION_REQUIRED) {
          compactionCheckedRound = toolRound;
          const excludes = compactionExcludeIds(deps, sessionId, ctx.messageId());
          if (await deps.compactForRequest(sessionId, options, excludes, ctx.emitter(), ctx.cancelToken(), result.error)) {
            compile.chatHistory = await deps.history.loadVariantChatHistory(sessionId, ctx.messageId());
            await compileFrozenContext(compile, deps.compilePorts, log);
            const reloaded = compile.chatHistory;
            compile.chatHistory = [];
            messages.splice(0, historyPrefixLen, ...reloaded);
            historyPrefixLen = reloaded.length;
          }
          adapter.resetForNewRound();
          continue;
        }
        await guard.cleanup();
        const message = errorMessage(result.error);
        adapter.failPreparingBlocks(message);
        ctx.fail(message);
        throw new ChatV2Error('Llm', message);
      }
      const toolCalls = adapter.takeToolCalls();
      if (toolCalls.length === 0) { adapter.finalizeAll(); ctx.complete(); break; }
      log.info(`[ChatV2::VariantPipeline] variant=${ctx.variantId()} round=${toolRound} has ${toolCalls.length} tool calls`);
      const currentReasoning = ctx.getAccumulatedReasoning();
      adapter.finalizeAll();
      ctx.setPendingReasoning(currentReasoning);
      if (deps.toolRounds === null) {
        const message = 'tool round execution requires the chatToolRuntime owner service, which is not installed';
        await guard.cleanup();
        adapter.failPreparingBlocks(message);
        ctx.fail(message);
        throw new ChatV2Error('Tool', message);
      }
      adapter.markPreparingPromoted();
      const roundId = `variant-tool-round-${toolRound}`;
      const authoringBase = await resolveApiConfigById(deps, options.model2OverrideId ?? options.modelId);
      const authoring = authoringBase === null ? null : structuredClone(authoringBase);
      if (authoring !== null && options.maxTokens != null) authoring.maxOutputTokens = options.maxTokens;
      const calls = toolCalls.map(call => ({ id: call.id, name: call.name, arguments: call.arguments as JsonValue }));
      const executed = await deps.toolRounds.executeToolCalls(calls, ctx.emitter(), { sessionId,
        messageId: ctx.messageId(), variantId: ctx.variantId(), options, cancellation: ctx.cancelToken() },
      roundId, authoring, mapping);
      const results = mergeRoundResultsInCallOrder(calls, executed, []);
      log.info(`[ChatV2::VariantPipeline] variant=${ctx.variantId()} tool execution: ${results.filter(r => r.success).length}/${results.length} succeeded`);
      const pendingBatches: [string, string | null, LegacyChatMessage[]][] = [];
      for (const result of results) {
        if (!isLoadSkillsToolName(result.toolName) || !result.success) continue;
        // RUST-FIX(RF-W05-variant-loaded-skill-ids-truncation): multi_variant.rs:1719 read the budgeted output.
        const inner = (preBudgetOutput(result) as { result?: Record<string, unknown> } | null)?.result;
        const ids = inner?.loaded_skill_ids ?? inner?.skill_ids;
        if (!Array.isArray(ids)) continue;
        const loaded = ids.filter((id): id is string => typeof id === 'string');
        if (loaded.length === 0) continue;
        const embedded = options.skillEmbeddedTools;
        if (embedded != null) {
          const schemas = (options.mcpToolSchemas ??= []) as McpToolSchema[];
          const names = new Set(schemas.map(tool => tool.name));
          let added = 0;
          for (const id of loaded) for (const tool of embedded[id] ?? []) {
            if (!names.has(tool.name)) { schemas.push(tool as McpToolSchema); names.add(tool.name); added++; }
          }
          if (added > 0) {
            log.info(`[ChatV2::VariantPipeline] 🆕 Progressive disclosure: added ${added} tools from skills ${JSON.stringify(loaded)}`);
            const refreshed = prepareAll(schemas, true);
            const digest = freezeToolFaceForPromptCache(refreshed, frozenOrder, frozenSchemas);
            if (digest !== null) variantDigest = digest;
            context.custom_tools = refreshed as JsonValue;
          }
        }
        skillState = withAddedBranchLocalSkills(skillState, loaded);
        options.skillStateVersion = skillState.version;
        const anchor = result.toolCallId;
        if (anchor == null || anchor === '') continue;
        const batch = buildInLoopSkillMessages(loaded, contents(), dependencies, options.contextLimit ?? null, injected, skillState.version);
        audit.missingSkillIds.push(...batch.audit.missingSkillIds);
        audit.droppedSkillIds.push(...batch.audit.droppedSkillIds);
        if (batch.audit.injectedSkillIds.length === 0) continue;
        for (const id of batch.audit.injectedSkillIds) injected.add(id);
        audit.injectedSkillIds.push(...batch.audit.injectedSkillIds);
        audit.estimatedTokens += batch.audit.estimatedTokens;
        audit.skillStateVersion = skillState.version;
        const last = results.at(-1)?.toolCallId;
        pendingBatches.push([anchor, last == null || last === '' ? null : last, batch.messages]);
      }
      for (const call of toolCalls) {
        const message: LegacyChatMessage = { ...messageForTemplate('assistant', ''), thinking_content: currentReasoning,
          tool_call: { id: call.id, tool_name: call.name, args_json: structuredClone(call.arguments) as JsonValue } };
        messages.push(message);
      }
      for (const result of results) {
        const content = result.success ? JSON.stringify(result.output) ?? '{}' : `Error: ${result.error ?? 'Unknown error'}`;
        messages.push({ ...messageForTemplate('tool', content), tool_result: { call_id: result.toolCallId ?? '',
          ok: result.success, error: result.error ?? null, error_details: null, data_json: structuredClone(result.output) as JsonValue,
          usage: null, citations: null } });
        ctx.addToolResult(result);
      }
      for (const [anchor, last, batch] of pendingBatches) insertSkillMessagesAfterToolResult(messages, anchor, last, batch);
      if (pageBudget !== null) {
        const last = results.at(-1)?.toolCallId;
        if (last != null && last !== '') {
          const page = deps.buildRetrievalPageImageInjection(results, pageBudget);
          if (page !== null) insertRetrievalPageImageMessage(messages, last, page);
        }
      }
      if (results.some(r => (r.output as { task_completed?: unknown } | null)?.task_completed === true)) {
        log.info(`[ChatV2::VariantPipeline] variant=${ctx.variantId()} task_completed detected, stopping`);
        ctx.complete();
        break;
      }
      toolRound += 1;
      ctx.incrementToolRound();
      if (maxToolRounds !== null && toolRound >= maxToolRounds) {
        log.warn(`[ChatV2::VariantPipeline] variant=${ctx.variantId()} reached max tool rounds (${maxToolRounds})`);
        ctx.complete();
        break;
      }
      adapter.resetForNewRound();
    }
    const finalMeta = ctx.getMeta() ?? {};
    finalMeta.toolFacePrefix = { generation: baseline.generation, order: [...frozenOrder], schemaDigest: variantDigest };
    ctx.setMeta(finalMeta);
  } finally { await guard.cleanup(); }
}

function messageForTemplate(role: string, content: string): LegacyChatMessage {
  return { role, content, timestamp: new Date().toISOString(), thinking_content: null, thought_signature: null,
    rag_sources: null, memory_sources: null, graph_sources: null, web_search_sources: null, image_paths: null,
    image_base64: null, doc_attachments: null, multimodal_content: null, tool_call: null, tool_result: null,
    overrides: null, relations: null, persistent_stable_id: null, metadata: null };
}
