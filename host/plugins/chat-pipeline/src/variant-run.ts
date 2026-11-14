/** pipeline/multi_variant.rs — execute_multi_variant / execute_variants_retry_batch / execute_variant_retry:
 * spawn, join and converge the variants. One variant's run is variant-run-single.ts, the writes are
 * variant-run-persist.ts, the L04 ports are variant-run-ports.ts.
 * Variant state (VariantExecutionContext / ParallelExecutionManager) is the L04 owner's; L03 drives it.
 */
import {
  ChatV2Error, StreamGuard, type ChatMessage, type ChatV2State, type SharedContext, type Variant, type ContextSnapshot,
} from '../../chat/api.ts';
import type { ApiConfig } from '../../llm/api.ts';
import { CommandError, type WindowRef } from '../../../kernel/api.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';
import type { PipelineSendRequest, VariantRetrySpec } from '../api.ts';
import { PipelineContext, type AttachmentInput } from './pipeline-context.ts';
import { freezeExecutionContext } from './freeze-execution.ts';
import { buildCanonicalCurrentContent, isMultiVariantEnabled } from './execute.ts';
import { isConfigIdFormat } from './constants.ts';
import { errorMessage } from './tool-loop.ts';
import type { ToolFacePrefixSnapshot } from './tool-face.ts';
import { buildReplaySkillPayloadSnapshot } from './persistence.ts';
import { accumulate, hasTokens, zero } from './token-usage.ts';
import type { VariantDependencies, VariantExecution } from './variant-run-ports.ts';
import { saveMultiVariantResults, updateVariantAfterRetry } from './variant-run-persist.ts';
import { runVariant } from './variant-run-single.ts';

export {
  VARIANT_OWNER_METHODS, type RestoredSkillState, type VariantDependencies, type VariantExecution,
  type VariantExecutionManager,
} from './variant-run-ports.ts';

const optionString = (value: string | null | undefined) => value == null ? 'None' : `Some(${JSON.stringify(value)})`;
const DEFAULT_MAX_VARIANTS = 10;

export class VariantPipeline {
  private readonly deps: VariantDependencies;
  constructor(deps: VariantDependencies) { this.deps = deps; }

  /** Spawn and join (tokio::spawn + join_all; a rejected task maps to ctx.fail("Task panicked: …")). */
  private async joinVariants(contexts: readonly VariantExecution[], run: (ctx: VariantExecution) => Promise<void>,
    state: ChatV2State | null, label: string, untracked: string): Promise<void> {
    const { log } = this.deps;
    const settled = await Promise.allSettled(contexts.map(ctx => {
      const task = run(ctx).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
      if (state !== null) return state.spawnTracked(task);
      log.warn(untracked);
      return task;
    }));
    settled.forEach((outcome, index) => {
      const ctx = contexts[index]!;
      if (outcome.status === 'rejected') {
        log.error(`[ChatV2::pipeline] ${label} ${ctx.variantId()} task panicked: ${errorMessage(outcome.reason)}`);
        ctx.fail(`Task panicked: ${errorMessage(outcome.reason)}`);
      } else if (outcome.value.ok) log.info(`[ChatV2::pipeline] ${label} ${ctx.variantId()} completed successfully`);
      else log.error(`[ChatV2::pipeline] ${label} ${ctx.variantId()} failed: ${errorMessage(outcome.value.error)}`);
    });
  }

  private converge(sessionId: string, contexts: readonly VariantExecution[]): void {
    const prefixes = contexts.flatMap((ctx, index) => {
      const prefix = ctx.getMeta()?.toolFacePrefix;
      return prefix == null ? [] : [[index, prefix as ToolFacePrefixSnapshot] as const];
    });
    if (prefixes.length > 0) this.deps.toolFace.converge(sessionId, prefixes);
  }

  /** multi_variant.rs:337 register_existing_token(`${session}:${variant}`, ctx.cancel_token()). */
  private registerVariantCancel(state: ChatV2State | null, key: string, ctx: VariantExecution): void {
    if (state === null) return;
    state.registerExistingToken(key, ctx.cancelController());
    this.deps.log.debug(`[ChatV2::pipeline] Registered cancel token for variant: ${key}`);
  }

  /** multi_variant.rs:86 execute_multi_variant */
  async executeMultiVariant(window: WindowRef, request: PipelineSendRequest, modelIds: string[], cancellation: AbortSignal,
    state: ChatV2State | null): Promise<string> {
    const { log, owner } = this.deps;
    const started = performance.now();
    const sessionId = request.sessionId;
    const userContent = request.content;
    const options = structuredClone(request.options ?? {});
    const quality = options.visionQuality;
    if (quality == null || quality === '' || quality === 'auto') {
      let images = 0; let pdf = false;
      for (const ref of request.userContextRefs ?? []) {
        for (const block of ref.formattedBlocks) if (block.type === 'image') images++;
        const type = ref.typeId.toLowerCase();
        if (type.includes('pdf') || type.includes('textbook') || type.includes('file') || ref.resourceId.startsWith('tb_')) pdf = true;
      }
      const auto = pdf || images >= 6 ? 'low' : images >= 2 ? 'medium' : 'high';
      log.info(`[ChatV2::pipeline] Multi-variant vision_quality: auto -> '${auto}' (images=${images}, has_pdf_or_textbook=${pdf})`);
      options.visionQuality = auto;
    }
    const maxVariants = options.maxVariantsPerMessage ?? DEFAULT_MAX_VARIANTS;
    if (modelIds.length > maxVariants) {
      throw new ChatV2Error('LimitExceeded', `Variant count ${modelIds.length} exceeds maximum allowed ${maxVariants}`);
    }
    if (modelIds.length === 0) throw new ChatV2Error('Other', 'No model IDs provided');
    let configs: ApiConfig[];
    try { configs = await this.deps.llm.getApiConfigs(); }
    // AppError Display is its message (models.rs:1038); CommandError.message is the JSON-encoded value.
    catch (error) {
      throw new ChatV2Error('Other', `Failed to get API configs: ${errorMessage(error instanceof CommandError ? error.value : error)}`);
    }
    const byId = new Map(configs.map(config => [config.id, config]));
    const resolved: [string, string][] = modelIds.map(id => {
      const config = byId.get(id);
      if (config !== undefined) return [config.model, config.id];
      if (isConfigIdFormat(id)) {
        log.warn(`[ChatV2::pipeline] Config not found for id and id is a config format, using empty display name: ${id}`);
        return ['', id];
      }
      log.warn(`[ChatV2::pipeline] Config not found for id: ${id}, using as model name`);
      return [id, id];
    });
    log.info(`[ChatV2::pipeline] execute_multi_variant: session=${sessionId}, models=${JSON.stringify(resolved.map(([model]) => model))}, content_len=${utf8ByteLength(userContent)}`);
    const userMessageId = request.userMessageId ?? `msg_${globalThis.crypto.randomUUID()}`;
    const assistantMessageId = request.assistantMessageId ?? `msg_${globalThis.crypto.randomUUID()}`;
    const emitter = this.deps.windowEmitter(window, sessionId, options.streamGeneration == null ? null : Number(options.streamGeneration));
    try {
      log.info(`[ChatV2::pipeline] Tool-based retrieval mode (multi-variant): skipping shared pre-call retrievals for session=${sessionId}`);
      const shared: SharedContext = {};
      log.debug('[ChatV2::pipeline] Shared retrievals completed: has_sources=false');
      emitter.emitStreamStart(assistantMessageId, null);
      const baseOptions = structuredClone(options);
      if (resolved[0] !== undefined) { baseOptions.modelId = resolved[0][1]; baseOptions.model2OverrideId = resolved[0][1]; }
      const temp = new PipelineContext({ ...request, userMessageId, assistantMessageId, options: baseOptions });
      temp.initContextSnapshot(log);
      await freezeExecutionContext(temp, this.deps.llm, this.deps.ocr, () => buildCanonicalCurrentContent(temp, null), log);
      const canonical = structuredClone(temp.canonicalContent);
      temp.executionSnapshot = null;
      if (!(options.skipUserMessageSave ?? false)) {
        try {
          const conn = this.deps.connection();
          const user = owner.buildUserMessage({ id: userMessageId, sessionId, content: userContent,
            attachments: [], contextSnapshot: structuredClone(temp.contextSnapshot), canonicalContent: canonical,
            executionSnapshot: null, timestamp: Date.now() });
          if (options.userMessageOrigin != null) { user.message._meta ??= {}; user.message._meta.inboundOrigin = structuredClone(options.userMessageOrigin); }
          owner.createMessageWithConn(conn, user.message);
          owner.createBlockWithConn(conn, user.block);
          log.info(`[ChatV2::pipeline] Multi-variant: User message saved immediately: id=${userMessageId}`);
        } catch (error) { log.warn(`[ChatV2::pipeline] Multi-variant: Failed to save user message immediately: ${errorMessage(error)}`); }
      }
      const controller = new AbortController();
      const forward = () => controller.abort();
      if (cancellation.aborted) forward(); else cancellation.addEventListener('abort', forward, { once: true });
      const manager = this.deps.createManager(controller);
      const contexts: [VariantExecution, string][] = [];
      for (const [model, configId] of resolved) {
        const variantId = `var_${globalThis.crypto.randomUUID()}`;
        const ctx = manager.createVariant(variantId, model, assistantMessageId, shared, emitter);
        ctx.setConfigId(configId);
        const variantOptions = structuredClone(options);
        variantOptions.modelId = configId; variantOptions.model2OverrideId = configId;
        const freeze = new PipelineContext({ ...request, userMessageId, assistantMessageId, options: variantOptions });
        freeze.initContextSnapshot(log);
        await freezeExecutionContext(freeze, this.deps.llm, this.deps.ocr, () => buildCanonicalCurrentContent(freeze, null), log);
        ctx.setMeta({ executionSnapshot: freeze.executionSnapshot });
        this.registerVariantCancel(state, `${sessionId}:${variantId}`, ctx);
        contexts.push([ctx, configId]);
      }
      const skeletonVariants = contexts.map(([ctx]) => {
        const variant: Variant = { id: ctx.variantId(), modelId: ctx.modelId(), configId: ctx.getConfigId() ?? '', blockIds: [],
          status: 'pending', createdAt: Date.now() };
        const meta = ctx.getMeta();
        if (meta !== null) variant.meta = meta;
        return variant;
      });
      const runtime = buildReplaySkillPayloadSnapshot(options);
      const skeleton: ChatMessage = { id: assistantMessageId, sessionId, role: 'assistant', blockIds: [], timestamp: Date.now(),
        _meta: { chatParams: { reasoningEffort: options.reasoningEffort ?? null, thinkingBudget: options.thinkingBudget ?? null,
          multiVariantMode: true }, ...(runtime === null ? {} : { skillRuntimeBefore: runtime, skillRuntimeAfter: runtime }) },
        activeVariantId: skeletonVariants[0]?.id ?? null, variants: skeletonVariants, sharedContext: structuredClone(shared) };
      try {
        owner.createMessageWithConn(this.deps.connection(), skeleton);
        log.info(`[ChatV2::pipeline] Persisted skeleton assistant message: id=${assistantMessageId}, variants=${contexts.length}`);
      } catch (error) { log.warn(`[ChatV2::pipeline] Failed to persist skeleton assistant message (non-fatal): ${errorMessage(error)}`); }
      const contextRefs = structuredClone(request.userContextRefs ?? []);
      const baseline = this.deps.toolFace.load(sessionId);
      const metas = new Map(contexts.map(([ctx]) => [ctx.variantId(), ctx.getMeta()]));
      const configIds = new Map(contexts.map(([ctx, configId]) => [ctx.variantId(), configId]));
      await this.joinVariants(contexts.map(([ctx]) => ctx), ctx => runVariant(this.deps, ctx, configIds.get(ctx.variantId())!,
        metas.get(ctx.variantId()) ?? null, options, userContent, sessionId, shared, structuredClone(contextRefs), baseline, window),
      state, 'Variant', '[ChatV2::pipeline] spawn_tracked unavailable, using untracked tokio::spawn for variant task');
      this.converge(sessionId, contexts.map(([ctx]) => ctx));
      const active = manager.getFirstSuccess();
      log.info(`[ChatV2::pipeline] Multi-variant execution completed: active_variant=${optionString(active)}, success=${manager.successCount()}, error=${manager.errorCount()}`);
      let snapshot: ContextSnapshot | null = null;
      if ((request.userContextRefs ?? []).length > 0) {
        snapshot = { userRefs: temp.contextSnapshot.userRefs, retrievalRefs: [] };
        log.debug(`[ChatV2::pipeline] Multi-variant context snapshot: user_refs=${snapshot.userRefs!.length}, retrieval_refs=0`);
      }
      let saveError: unknown = null;
      try {
        saveMultiVariantResults(this.deps, sessionId, userMessageId, assistantMessageId, userContent, options, shared,
          contexts.map(([ctx]) => ctx), active, snapshot, canonical);
      } catch (error) { saveError = error; }
      if (state !== null) {
        for (const [ctx] of contexts) state.removeStream(`${sessionId}:${ctx.variantId()}`);
        log.debug(`[ChatV2::pipeline] Cleaned up ${contexts.length} variant cancel tokens`);
      }
      cancellation.removeEventListener('abort', forward);
      if (saveError !== null) {
        emitter.emitStreamError(assistantMessageId, errorMessage(saveError));
        throw saveError;
      }
      const duration = Math.floor(performance.now() - started);
      const total = zero();
      for (const [ctx] of contexts) { const usage = ctx.getUsage(); if (hasTokens(usage)) accumulate(total, usage); }
      emitter.emitStreamCompleteWithUsage(assistantMessageId, duration, hasTokens(total) ? total : null);
      log.info(`[ChatV2::pipeline] Multi-variant pipeline completed in ${duration}ms`);
      const activeCtx = active === null ? undefined : contexts.find(([ctx]) => ctx.variantId() === active)?.[0];
      if (activeCtx !== undefined) {
        this.deps.triggerAutoMemoryExtraction(options.memoryEnabled, userContent, activeCtx.getAccumulatedContent(), activeCtx.getToolResults());
        this.deps.missing('llm.callAgentChatTitleRawPrompt + chatSession session-metadata writer', 'session title/tags are not generated');
      }
      return assistantMessageId;
    } finally { emitter.dispose(); }
  }

  /** multi_variant.rs:2831 execute_variants_retry_batch */
  async executeVariantsRetryBatch(window: WindowRef, sessionId: string, messageId: string, variants: VariantRetrySpec[],
    userContent: string, _attachments: AttachmentInput[], shared: SharedContext, options: PipelineContext['options'],
    cancellation: AbortSignal, state: ChatV2State | null): Promise<void> {
    const { log } = this.deps;
    log.info(`[ChatV2::pipeline] execute_variants_retry_batch: session=${sessionId}, message=${messageId}, variants=${variants.length}`);
    if (variants.length === 0) throw new ChatV2Error('Validation', 'No variant IDs provided for batch retry');
    const emitter = this.deps.windowEmitter(window, sessionId, options.streamGeneration == null ? null : Number(options.streamGeneration));
    const controller = new AbortController();
    const forward = () => controller.abort();
    if (cancellation.aborted) forward(); else cancellation.addEventListener('abort', forward, { once: true });
    try {
      const manager = this.deps.createManager(controller);
      const contexts: [VariantExecution, VariantRetrySpec][] = [];
      const guards: StreamGuard[] = [];
      for (const spec of variants) {
        const ctx = manager.createVariant(spec.variantId, spec.modelId, messageId, shared, emitter);
        ctx.setConfigId(spec.configId);
        if (state !== null) {
          // multi_variant.rs:2889 register_existing_token_owned + generation-owned StreamGuard.
          const key = `${sessionId}:${spec.variantId}`;
          guards.push(new StreamGuard(state, key, state.registerExistingTokenOwned(key, ctx.cancelController())));
          log.debug(`[ChatV2::pipeline] Registered cancel token for retry variant: ${key}`);
        }
        contexts.push([ctx, spec]);
      }
      const baseline = this.deps.toolFace.load(sessionId);
      await this.joinVariants(contexts.map(([ctx]) => ctx), ctx => {
        const spec = contexts.find(([candidate]) => candidate === ctx)![1];
        return runVariant(this.deps, ctx, spec.configId, spec.meta, options, userContent, sessionId, shared, [], baseline, window);
      }, state, 'Retry variant', '[ChatV2::pipeline] spawn_tracked unavailable, using untracked tokio::spawn for retry variant task');
      this.converge(sessionId, contexts.map(([ctx]) => ctx));
      let updateError: unknown = null;
      for (const [ctx] of contexts) {
        try { updateVariantAfterRetry(this.deps, messageId, ctx); }
        catch (error) {
          log.error(`[ChatV2::pipeline] Failed to update retry variant ${ctx.variantId()}: ${errorMessage(error)}`);
          updateError ??= error;
        }
      }
      // Generation-owned guards clean up retry child keys without deleting a newer retry.
      for (const guard of guards) guard.dispose();
      if (updateError !== null) throw updateError;
    } finally {
      cancellation.removeEventListener('abort', forward);
      emitter.dispose();
    }
  }

  /** multi_variant.rs:3053 execute_variant_retry */
  async executeVariantRetry(window: WindowRef, sessionId: string, messageId: string, variantId: string, modelId: string,
    userContent: string, _attachments: AttachmentInput[], shared: SharedContext, options: PipelineContext['options'],
    cancellation: AbortSignal): Promise<void> {
    const { log } = this.deps;
    log.info(`[ChatV2::pipeline] execute_variant_retry: session=${sessionId}, message=${messageId}, variant=${variantId}, model=${modelId}`);
    const emitter = this.deps.windowEmitter(window, sessionId, options.streamGeneration == null ? null : Number(options.streamGeneration));
    const controller = new AbortController();
    const forward = () => controller.abort();
    if (cancellation.aborted) forward(); else cancellation.addEventListener('abort', forward, { once: true });
    try {
      let display: string;
      try {
        const configs = await this.deps.llm.getApiConfigs();
        const found = configs.find(c => c.id === modelId)?.model ?? configs.find(c => c.model === modelId)?.model;
        if (found !== undefined) display = found;
        else if (isConfigIdFormat(modelId)) {
          log.warn(`[ChatV2::pipeline] variant retry: config_id is not a display name: ${modelId}`);
          display = '';
        } else display = modelId;
      } catch { display = modelId; }
      const manager = this.deps.createManager(controller);
      const ctx = manager.createVariant(variantId, display, messageId, shared, emitter);
      const baseline = this.deps.toolFace.load(sessionId);
      let failure: unknown = null;
      try { await runVariant(this.deps, ctx, modelId, null, options, userContent, sessionId, shared, [], baseline, window); }
      catch (error) { failure = error; }
      const prefix = ctx.getMeta()?.toolFacePrefix;
      if (prefix != null) this.deps.toolFace.converge(sessionId, [[0, prefix as ToolFacePrefixSnapshot]]);
      if (failure === null) {
        updateVariantAfterRetry(this.deps, messageId, ctx);
        log.info(`[ChatV2::pipeline] Variant retry completed: variant=${variantId}, status=${ctx.status()}`);
        return;
      }
      log.error(`[ChatV2::pipeline] Variant retry failed: variant=${variantId}, error=${errorMessage(failure)}`);
      try { updateVariantAfterRetry(this.deps, messageId, ctx); }
      catch (error) { log.error(`[ChatV2::pipeline] Failed to update variant status after error: ${errorMessage(error)}`); }
      throw failure;
    } finally {
      cancellation.removeEventListener('abort', forward);
      emitter.dispose();
    }
  }
}
export { isMultiVariantEnabled };
