/** pipeline.rs:599–1260 — execute / execute_with_emitter / execute_internal.
 * Owner reads/writes go through injected owner ports; L03 owns order, cancellation and terminals.
 */
import type { Context } from '@deepseek-ai/cordis';
import { ChatV2Error, type ChatV2Emitter, type ChatV2State } from '../../chat/api.ts';
import type { ApiConfig, LLMManager } from '../../llm/api.ts';
import type { WindowRef } from '../../../kernel/api.ts';
import { utf8ByteLength } from '../../../platform/util/index.ts';
import type { PipelineSendRequest } from '../api.ts';
import { PipelineContext } from './pipeline-context.ts';
import type { PipelinePersistence } from './incremental-persistence.ts';
import type { PipelineFinalPersistence } from './final-persistence.ts';
import type { PipelineHistoryLoader } from './history-loader.ts';
import { compileFrozenContext, type ContextCompilationPorts } from './context-compiler.ts';
import { freezeExecutionContext } from './freeze-execution.ts';
import type { LlmOcrModels } from '../../llm/api.ts';
import { buildSystemPromptWithProfileAndAgents, type CanvasNoteInfo, type RendererCapabilities } from './prompt-builder.ts';
import { usableTokens } from './compaction-budget.ts';
import { isConfigIdFormat } from './constants.ts';
import { ToolLoop, errorMessage, type ToolLoopDependencies } from './tool-loop.ts';
import type { CompactionOutcome } from './compaction-outcome.ts';
import { compactionDidCompact, compactionIsFailed, compactionReasonCode, compactionTokenEstimates } from './compaction-outcome.ts';
import { hasTokens } from './token-usage.ts';
import type { CanonicalContentPart } from '../../chat/api.ts';
import type { CanonicalVfsImage } from './images.ts';
import { InjectionThrottle } from '../../agent-workspace/portable.ts';
import type { InjectionResult } from '../../agent-workspace/api.ts';

/** context_compiler.rs:261–335 build_canonical_current_content.
 * `vfsImages` is the VFS owner read (resolve_canonical_vfs_images); null mirrors Rust's vfs_db = None.
 */
export function buildCanonicalCurrentContent(ctx: PipelineContext,
  vfsImages: ((resourceId: string) => CanonicalVfsImage[]) | null): CanonicalContentPart[] {
  const result: CanonicalContentPart[] = [];
  if (ctx.userContent !== '') result.push({ type: 'text', text: ctx.userContent });
  for (const ref of ctx.userContextRefs) {
    const pinned = ctx.options.groupPinnedResourceIds?.includes(ref.resourceId) ?? false;
    let sawImage = false;
    for (const image of vfsImages === null ? [] : vfsImages(ref.resourceId)) {
      sawImage = true;
      result.push({ type: 'image_ref', image_id: image.imageId, name: image.name ?? ref.displayName ?? null,
        resource_id: ref.resourceId, source_id: image.sourceId, blob_hash: image.blobHash,
        content_hash: image.contentHash, mime_type: image.mimeType, pinned, retrieval_hit: false });
    }
    if (!sawImage) {
      let offset = 0;
      for (const block of ref.formattedBlocks) {
        if (block.type !== 'image') continue;
        sawImage = true;
        result.push({ type: 'image_ref', image_id: `${ref.resourceId}:image:${offset++}`, name: ref.displayName ?? null,
          resource_id: ref.resourceId, source_id: null, blob_hash: null, content_hash: ref.hash,
          mime_type: block.mediaType, pinned, retrieval_hit: false });
      }
    }
    if (!sawImage) {
      result.push({ type: 'file_ref', file_id: ref.resourceId, resource_id: ref.resourceId, blob_hash: null,
        content_hash: ref.hash, mime_type: 'application/octet-stream', name: ref.displayName ?? null });
    }
  }
  return result;
}

type Log = Pick<Context['logger'], 'info' | 'warn' | 'error' | 'debug'>;

/** prompt.rs:58–94 sources. Rust keeps several as Option providers; a null result is Rust's None. */
export interface PromptSources {
  canvasNote(ctx: PipelineContext): Promise<CanvasNoteInfo | null>;
  userProfile(ctx: PipelineContext): Promise<string | null>;
  learnerProfile(ctx: PipelineContext): string | null;
  agentsInstructions(ctx: PipelineContext): string | null;
  activeGoal(sessionId: string): string | null;
  insightHints(ctx: PipelineContext): string | null;
  rendererCapabilities(): RendererCapabilities;
}

/** pipeline.rs:414 accumulate_goal_usage and summary.rs session metadata (owner effects after success). */
export interface TurnEffects {
  accumulateGoalUsage(sessionId: string, emitter: ChatV2Emitter, totalTokens: number, elapsedMs: number): void;
}
/** summary.rs:51/293; installed only when L02 title generation and the L04 metadata writer exist. */
export interface SessionMetadataRuntime {
  shouldGenerate(sessionId: string, userContent: string, assistantContent: string): Promise<boolean>;
  generate(sessionId: string, userContent: string, assistantContent: string, emitter: ChatV2Emitter): Promise<void>;
}

export interface CompactionRuntime {
  /** compaction.rs run_compaction (turn-end / in-loop checkpoint). */
  runCompaction(ctx: PipelineContext, emitter: ChatV2Emitter): Promise<CompactionOutcome>;
  compactForRequest(ctx: PipelineContext, emitter: ChatV2Emitter, error: unknown): Promise<boolean>;
  runOverflowCompaction(ctx: PipelineContext, modelOverride: string | null, emitter: ChatV2Emitter): Promise<CompactionOutcome>;
}

export interface ExecutionDependencies extends Omit<ToolLoopDependencies,
  'reloadHistoryAndRecompile' | 'runCompaction' | 'compactForRequest' | 'runOverflowCompaction' | 'window'> {
  ocr: LlmOcrModels;
  persistence: PipelinePersistence;
  finalPersistence: PipelineFinalPersistence;
  history: PipelineHistoryLoader;
  compilePorts: ContextCompilationPorts;
  prompt: PromptSources;
  effects: TurnEffects;
  sessionMetadata: SessionMetadataRuntime | null;
  compaction: CompactionRuntime | null;
  canonicalVfsImages: ((resourceId: string) => CanonicalVfsImage[]) | null;
  /** state.rs:897 Super turn overrides (L06 owner); null when the owner does not publish it. */
  superTurnOverrides: ((request: PipelineSendRequest, hasWindow: boolean) => void) | null;
  /** pipeline.rs:608 schedule_memory_flush_recovery (memory_flush.rs:572). */
  scheduleMemoryFlushRecovery: (() => void) | null;
  windowEmitter(window: WindowRef, sessionId: string, streamGeneration: number | null): ChatV2Emitter;
  multiVariantEnabled(): boolean;
  multiVariant: ((window: WindowRef, request: PipelineSendRequest, modelIds: string[], signal: AbortSignal,
    state: ChatV2State | null) => Promise<string>) | null;
}

/** types.rs feature_flags::is_multi_variant_enabled (env read once per process in Rust). */
let multiVariantFlag: boolean | undefined;
export function isMultiVariantEnabled(): boolean {
  multiVariantFlag ??= (() => {
    const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.CHAT_V2_MULTI_VARIANT_ENABLED;
    if (raw === undefined) return true;
    return !['false', '0', 'no'].includes(raw.replace(/[A-Z]/g, c => c.toLowerCase()));
  })();
  return multiVariantFlag;
}

const optionString = (value: string | null | undefined) => value == null ? 'None' : `Some(${JSON.stringify(value)})`;

/** pipeline.rs:705–1000 single-variant runtime. */
export class PipelineExecution {
  private readonly deps: ExecutionDependencies;
  private readonly loop: ToolLoop;
  private readonly window: WindowRef | null;
  constructor(deps: ExecutionDependencies, window: WindowRef | null) {
    this.deps = deps;
    this.window = window;
    const compaction = deps.compaction;
    const unavailable = () => new ChatV2Error('Other', 'compaction runtime is not installed');
    this.loop = new ToolLoop({ ...deps, window,
      reloadHistoryAndRecompile: async ctx => { await deps.history.loadChatHistory(ctx); await this.compile(ctx); },
      runCompaction: (ctx, emitter) => compaction === null ? Promise.reject(unavailable()) : compaction.runCompaction(ctx, emitter),
      compactForRequest: (ctx, emitter, error) => compaction === null ? Promise.reject(unavailable())
        : compaction.compactForRequest(ctx, emitter, error),
      runOverflowCompaction: (ctx, model, emitter) => compaction === null ? Promise.reject(unavailable())
        : compaction.runOverflowCompaction(ctx, model, emitter),
    });
  }

  private compile(ctx: PipelineContext): Promise<void> {
    return compileFrozenContext(ctx, this.deps.compilePorts, this.deps.log);
  }

  /** pipeline.rs:599 */
  async execute(window: WindowRef, request: PipelineSendRequest, signal: AbortSignal,
    state: ChatV2State | null): Promise<string> {
    const { log } = this.deps;
    this.deps.scheduleMemoryFlushRecovery?.();
    request = structuredClone(request);
    this.deps.superTurnOverrides?.(request, true);
    const enabled = this.deps.multiVariantEnabled();
    log.info(`[ChatV2::pipeline] Feature flags: multi_variant_enabled=${enabled}`);
    log.info(`[ChatV2::pipeline] execute() received options: ${request.options == null ? 'None'
      : `Some("parallelModelIds=${request.options.parallelModelIds == null ? 'None' : `Some(${JSON.stringify(request.options.parallelModelIds)})`}, modelId=${optionString(request.options.modelId)}")`}`);
    const ids = request.options?.parallelModelIds;
    if (ids != null && ids.length >= 2) {
      if (!enabled) {
        log.warn(`[ChatV2::pipeline] Multi-variant DISABLED by feature flag. Received ${ids.length} models, forcing single-variant mode with first model: ${optionString(ids[0])}`);
        if (request.options != null) { request.options.modelId = ids[0]; request.options.parallelModelIds = null; }
      } else {
        log.info(`[ChatV2::pipeline] Multi-variant mode detected: ${ids.length} models`);
        if (this.deps.multiVariant === null) {
          throw new ChatV2Error('Other', 'multi-variant execution runtime is not installed');
        }
        return this.deps.multiVariant(window, request, [...ids], signal, state);
      }
    }
    const emitter = this.deps.windowEmitter(window, request.sessionId,
      request.options?.streamGeneration == null ? null : Number(request.options.streamGeneration));
    // Rust drops the Arc'd emitter when the turn returns; Drop flushes the chunk batch window.
    try { return await this.executeWithEmitter(emitter, request, signal, state, true); }
    finally { emitter.dispose(); }
  }

  /** pipeline.rs:705 */
  async executeWithEmitter(emitter: ChatV2Emitter, request: PipelineSendRequest, signal: AbortSignal,
    state: ChatV2State | null, alreadyCloned = false): Promise<string> {
    const { log } = this.deps;
    if (!alreadyCloned) request = structuredClone(request);
    this.deps.superTurnOverrides?.(request, emitter.tryWindow() !== null);
    const parallel = request.options?.parallelModelIds;
    if (parallel != null && parallel.length >= 2) {
      throw new ChatV2Error('Validation', 'multi-variant execution requires a windowed emitter; use execute()');
    }
    const ctx = new PipelineContext(request);
    ctx.initContextSnapshot(log);
    ctx.setCancellationToken(signal);
    const sessionId = ctx.sessionId;
    const assistantId = ctx.assistantMessageId;
    let streamStarted = false;
    try {
      await freezeExecutionContext(ctx, this.deps.llm, this.deps.ocr,
        () => buildCanonicalCurrentContent(ctx, this.deps.canonicalVfsImages), log);
      log.info(`[ChatV2::pipeline] Single variant: options.model_id = ${optionString(ctx.options.modelId)}`);
      ctx.modelDisplayName = await this.resolveModelName(ctx.options.modelId ?? null, this.deps.llm);
      log.info(`[ChatV2::pipeline] Emitting stream_start with model_name: ${optionString(ctx.modelDisplayName)}`);
      emitter.emitStreamStart(assistantId, ctx.modelDisplayName);
      streamStarted = true;
      log.info(`[ChatV2::pipeline] Starting pipeline for session=${sessionId}, assistant_msg=${assistantId}`);
      if (!(ctx.options.skipUserMessageSave ?? false)) {
        try {
          await this.deps.persistence.saveUserMessageImmediately(ctx);
          log.info(`[ChatV2::pipeline] User message saved immediately: id=${ctx.userMessageId}`);
        } catch (error) {
          log.error(`[ChatV2::pipeline] Failed to save user message immediately (will rely on save_results as fallback): ${errorMessage(error)}`);
        }
      }
      await this.executeInternal(ctx, emitter, signal);
    } catch (error) {
      const cancelled = error instanceof ChatV2Error && error.kind === 'Cancelled';
      if (!streamStarted && !cancelled) {
        // The request was admitted even if model selection failed. Persist a failed reply
        // alongside the question so it stays visible and retryable after reopening.
        emitter.emitStreamStart(assistantId, null);
        ctx.generatedBlocks.push({ id: `blk_${globalThis.crypto.randomUUID()}`, messageId: assistantId,
          type: 'content', status: 'error', error: errorMessage(error),
          startedAt: ctx.startedAtEpochMs, endedAt: Date.now() });
      }
      const reason = cancelled ? 'cancel' : 'error';
      if (cancelled) log.info(`[ChatV2::pipeline] Pipeline cancelled for session=${sessionId}, attempting to save partial results...`);
      else log.error(`[ChatV2::pipeline] Pipeline error for session=${sessionId}: ${errorMessage(error)}, attempting to save partial results...`);
      const adapter = ctx.currentAdapter;
      if (adapter !== null) {
        if (ctx.finalContent === '') ctx.finalContent = adapter.getAccumulatedContent();
        if (ctx.finalReasoning === null) ctx.finalReasoning = adapter.getAccumulatedReasoning();
        ctx.streamingThinkingBlockId ??= adapter.getThinkingBlockId();
        ctx.streamingContentBlockId ??= adapter.getContentBlockId();
        ctx.collectStreamedTextSegments(adapter.getTextSegments(), assistantId);
        log.info(`[ChatV2::pipeline] Retrieved partial content from adapter on ${reason}: content_len=${utf8ByteLength(ctx.finalContent)}, reasoning_len=${ctx.finalReasoning === null ? 'None' : `Some(${utf8ByteLength(ctx.finalReasoning)})`}`);
      }
      try {
        await this.deps.finalPersistence.saveResults(ctx);
        log.info(`[ChatV2::pipeline] Partial results saved on ${reason}: content_len=${utf8ByteLength(ctx.finalContent)}, reasoning_len=${ctx.finalReasoning === null ? 'None' : `Some(${utf8ByteLength(ctx.finalReasoning)})`}`);
      } catch (saveError) {
        log.warn(`[ChatV2::pipeline] Failed to save partial results on ${reason}: ${errorMessage(saveError)}`);
      }
      if (cancelled) emitter.emitStreamCancelled(assistantId);
      else if (error instanceof ChatV2Error && error.kind === 'ContextWindowExceeded') {
        const data = error.data as { message: string; details: unknown };
        emitter.emitStreamErrorWithDetails(assistantId, error.message, error.code(), data.details);
      } else emitter.emitStreamError(assistantId, errorMessage(error));
      throw error;
    }
    emitter.emitStreamCompleteWithUsage(assistantId, ctx.elapsedMs(), hasTokens(ctx.tokenUsage) ? ctx.tokenUsage : null);
    this.deps.effects.accumulateGoalUsage(sessionId, emitter, ctx.tokenUsage.totalTokens, ctx.elapsedMs());
    log.info(`[ChatV2::pipeline] Pipeline completed for session=${sessionId}, duration=${ctx.elapsedMs()}ms`);
    const userContent = ctx.userContent, assistantContent = ctx.finalContent;
    const metadata = this.deps.sessionMetadata;
    if (metadata !== null && await metadata.shouldGenerate(sessionId, userContent, assistantContent)) {
      const task = metadata.generate(sessionId, userContent, assistantContent, emitter);
      if (state !== null) void state.spawnTracked(task);
      else {
        log.warn('[ChatV2::pipeline] spawn_tracked unavailable, using untracked tokio::spawn for metadata task');
        void task.catch(() => undefined);
      }
    }
    return assistantId;
  }

  /** pipeline.rs:190–269 display-name resolution. */
  private async resolveModelName(configId: string | null, llm: LLMManager): Promise<string | null> {
    const { log } = this.deps;
    if (configId !== null && configId !== '') {
      let configs: ApiConfig[];
      try { configs = await llm.getApiConfigs(); }
      catch (error) {
        log.warn(`[ChatV2::pipeline] Failed to get API configs for model name: ${errorMessage(error)}`);
        return null;
      }
      log.info(`[ChatV2::pipeline] Found ${configs.length} API configs, looking for config_id: ${configId}`);
      let found = configs.find(config => config.id === configId)?.model
        ?? configs.find(config => config.model === configId)?.model ?? null;
      if (found === null) {
        if (isConfigIdFormat(configId)) {
          log.warn(`[ChatV2::pipeline] config_id is a config UUID/builtin ID, not usable as display name: ${configId}`);
        } else {
          log.info(`[ChatV2::pipeline] Using config_id as model_name directly (not a config ID pattern): ${configId}`);
          found = configId;
        }
      }
      log.info(`[ChatV2::pipeline] Resolved model_name: ${optionString(found)}`);
      return found;
    }
    log.info('[ChatV2::pipeline] options.model_id is None/empty, getting default model name');
    try {
      const [config] = await llm.selectModelFor('default', null, {});
      log.info(`[ChatV2::pipeline] Default model resolved: ${config.model}`);
      return config.model;
    } catch (error) {
      log.warn(`[ChatV2::pipeline] Failed to get default model: ${errorMessage(error)}`);
      return null;
    }
  }

  /** prompt.rs:58–94 */
  private async buildSystemPrompt(ctx: PipelineContext): Promise<string> {
    const sources = this.deps.prompt;
    const canvasNote = await sources.canvasNote(ctx);
    const userProfile = await sources.userProfile(ctx);
    const agents = sources.agentsInstructions(ctx);
    const activeGoal = sources.activeGoal(ctx.sessionId);
    const insightHints = sources.insightHints(ctx);
    const rendererCapabilities = sources.rendererCapabilities();
    const parts = buildSystemPromptWithProfileAndAgents({ options: ctx.options, sources: ctx.retrievedSources,
      canvasNote, userProfile, learnerProfile: sources.learnerProfile(ctx), projectAgentsInstructions: agents,
      activeGoal, insightHints, rendererCapabilities });
    ctx.turnVolatileContext = parts.turnVolatile;
    return parts.stableSystem;
  }

  private raceCancel<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(new ChatV2Error('Cancelled'));
    let remove = () => {};
    const stopped = new Promise<never>((_resolve, reject) => {
      const abort = () => reject(new ChatV2Error('Cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      remove = () => signal.removeEventListener('abort', abort);
    });
    return Promise.race([work, stopped]).finally(remove);
  }

  /** pipeline.rs:1062 */
  private async executeInternal(ctx: PipelineContext, emitter: ChatV2Emitter, signal: AbortSignal): Promise<void> {
    const { log } = this.deps;
    ctx.initContextSnapshot(log);
    if (signal.aborted) throw new ChatV2Error('Cancelled');
    if (ctx.options.contextLimit == null || ctx.options.contextLimit === 0) {
      const config = await this.loop.resolveActiveApiConfig(ctx);
      if (config !== null) {
        const usable = usableTokens(config);
        if (usable > 0) {
          log.debug(`[ChatV2::pipeline] context_limit not configured; adopting provider usable budget ${usable} for session=${ctx.sessionId}`);
          ctx.options.contextLimit = usable;
        }
      }
    }
    await this.deps.history.loadChatHistory(ctx);
    if (signal.aborted) throw new ChatV2Error('Cancelled');
    // retrieval.rs:27 — tool-based retrieval mode: pre-call retrieval is intentionally empty.
    log.info(`[ChatV2::pipeline] Tool-based retrieval mode: skipping pre-call retrievals for session=${ctx.sessionId}`);
    // token_resources.rs:171: retrieved_sources stay empty after the no-op stage, so no retrieval
    // resources are created and the snapshot gains no retrieval refs.
    ctx.addRetrievalRefsToSnapshot([], log);
    const systemPrompt = await this.buildSystemPrompt(ctx);
    await this.raceCancel(this.compile(ctx), signal);
    try { this.deps.persistence.persistUserLlmContentEarly(ctx); }
    catch (error) {
      log.warn(`[ChatV2::pipeline] persist_user_llm_content_early failed (non-fatal, later save points may retry when the target block exists): session=${ctx.sessionId}, err=${errorMessage(error)}`);
    }
    if (signal.aborted) throw new ChatV2Error('Cancelled');
    // Rust select drops execute_with_tools. JS promises cannot be dropped: the loop must
    // stop cooperatively and finish its provider/hook cleanup before partial persistence.
    try { await this.loop.executeWithTools(ctx, emitter, systemPrompt, 0); }
    catch (error) {
      if (error instanceof ChatV2Error && error.kind === 'Cancelled' && signal.aborted) log.info('[ChatV2::pipeline] LLM call cancelled');
      throw error;
    }
    // pipeline.rs:1152–1214: a single idle check with a separate throttle. A continuation starts
    // a new tool-loop lifetime; it does not re-enter this idle checkpoint.
    const workspace = this.deps.workspace, workspaceId = ctx.workspaceId;
    if (workspace !== null && workspaceId !== null) {
      let result: InjectionResult | null = null;
      try { result = workspace.injector.checkAndInject(new InjectionThrottle(), workspaceId, ctx.sessionId, 3); }
      catch (error) { log.warn(`[ChatV2::pipeline] Workspace injection check failed: ${errorMessage(error)}`); }
      if (result !== null && result.messages.length > 0) {
        workspace.apply(ctx, emitter, workspaceId, result.messages, null);
        log.info(`[ChatV2::pipeline] Workspace idle injection: ${result.messages.length} messages injected, should_continue=${result.shouldContinue}`);
        if (result.shouldContinue || ctx.shouldContinueForWorkspace()) {
          try { await this.loop.executeWithTools(ctx, emitter, systemPrompt, 0); }
          catch (error) {
            if (error instanceof ChatV2Error && error.kind === 'Cancelled' && signal.aborted) {
              log.info('[ChatV2::pipeline] Workspace continuation cancelled');
            }
            throw error;
          }
        }
      }
    }
    await this.deps.finalPersistence.saveResults(ctx);
    if (ctx.needsCompaction) {
      try {
        if (this.deps.compaction === null) throw new ChatV2Error('Other', 'compaction runtime is not installed');
        const outcome = await this.deps.compaction.runCompaction(ctx, emitter);
        if (compactionDidCompact(outcome)) {
          const [before, after] = compactionTokenEstimates(outcome);
          emitter.emitCompactionCompleted(before, after);
        }
        if (compactionIsFailed(outcome)) {
          const reason = compactionReasonCode(outcome);
          if (reason !== null) emitter.emitCompactionFailed(reason);
        }
      } catch (error) {
        log.error(`[ChatV2::pipeline] run_compaction failed for session=${ctx.sessionId} (history preserved): ${errorMessage(error)}`);
        ctx.needsCompaction = false;
        emitter.emitCompactionFailed('internalError');
      }
    }
  }
}
