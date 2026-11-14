/** The variant pipeline's writes: multi_variant.rs:3297 save_multi_variant_results and
 * :3193 update_variant_after_retry.
 */
import {
  ChatV2Error, type CanonicalContentPart, type ChatMessage, type ContextSnapshot, type SharedContext, type Variant,
} from '../../chat/api.ts';
import type { PipelineContext } from './pipeline-context.ts';
import type { PersistenceBlock } from './persistence-port.ts';
import { buildReplaySkillPayloadSnapshot } from './persistence.ts';
import { errorMessage } from './tool-loop.ts';
import type { VariantDependencies, VariantExecution } from './variant-run-ports.ts';

type PersistDeps = Pick<VariantDependencies,
  'owner' | 'log' | 'connection' | 'incrementResourceRefsWithinSave' | 'updateSessionSkillState'>;

/** multi_variant.rs:3297 save_multi_variant_results — one IMMEDIATE transaction. */
export function saveMultiVariantResults(deps: PersistDeps, sessionId: string, userMessageId: string, assistantMessageId: string,
  userContent: string, options: PipelineContext['options'], shared: SharedContext, contexts: readonly VariantExecution[],
  active: string | null, snapshot: ContextSnapshot | null, canonical: CanonicalContentPart[]): void {
  const { owner, log } = deps;
  const now = Date.now();
  try {
    deps.connection().transaction(tx => {
      const user = owner.buildUserMessage({ id: userMessageId, sessionId, content: userContent, attachments: [],
        contextSnapshot: snapshot, canonicalContent: canonical, executionSnapshot: null, timestamp: now });
      if (options.userMessageOrigin != null) { user.message._meta ??= {}; user.message._meta.inboundOrigin = structuredClone(options.userMessageOrigin); }
      owner.createMessageWithConn(tx, user.message);
      owner.createBlockWithConn(tx, user.block);
      const ids: string[] = [];
      const pending: PersistenceBlock[] = [];
      let index = 0;
      const retrieval = (blockId: string | null | undefined, sources: unknown[] | null | undefined, type: string) => {
        if (blockId == null || sources == null || sources.length === 0) return;
        pending.push({ id: blockId, messageId: assistantMessageId, type, status: 'success', toolOutput: { sources },
          startedAt: now, endedAt: now, firstChunkAt: now, blockIndex: index++ });
        ids.push(blockId);
      };
      retrieval(shared.ragBlockId, shared.ragSources, 'rag');
      retrieval(shared.memoryBlockId, shared.memorySources, 'memory');
      retrieval(shared.webSearchBlockId, shared.webSearchSources, 'web_search');
      log.debug(`[ChatV2::pipeline] Multi-variant retrieval blocks saved: ${index} blocks`);
      const variants: Variant[] = [];
      for (const ctx of contexts) {
        for (const block of ctx.getInterleavedBlocks()) {
          block.messageId = assistantMessageId;
          if (block.type === 'content') {
            block.status = ctx.status() === 'success' ? 'success' : ctx.status() === 'error' ? 'error' : 'running';
            const error = ctx.error();
            if (error === null) delete block.error; else block.error = error;
          }
          ids.push(block.id);
          pending.push(block);
        }
        variants.push(ctx.toVariant());
        log.debug(`[ChatV2::pipeline] Saved blocks for variant ${ctx.variantId()}: status=${ctx.status()}`);
      }
      const hasSources = [shared.ragSources, shared.memorySources, shared.graphSources, shared.webSearchSources,
        shared.multimodalSources].some(list => (list?.length ?? 0) > 0);
      const runtime = buildReplaySkillPayloadSnapshot(options);
      const assistant: ChatMessage = { id: assistantMessageId, sessionId, role: 'assistant', blockIds: ids, timestamp: now,
        _meta: { chatParams: { temperature: options.temperature ?? null, maxTokens: options.maxTokens ?? null,
          enableThinking: options.enableThinking ?? null, reasoningEffort: options.reasoningEffort ?? null,
          thinkingBudget: options.thinkingBudget ?? null, multiVariantMode: true },
        ...(hasSources ? { sources: { rag: shared.ragSources ?? null, memory: shared.memorySources ?? null,
          graph: shared.graphSources ?? null, webSearch: shared.webSearchSources ?? null, multimodal: shared.multimodalSources ?? null } } : {}),
        ...(snapshot === null ? {} : { contextSnapshot: snapshot }),
        ...(runtime === null ? {} : { skillRuntimeBefore: runtime, skillRuntimeAfter: runtime }) },
        activeVariantId: active, variants, sharedContext: structuredClone(shared) };
      owner.createMessageWithConn(tx, assistant);
      if (snapshot !== null && ((snapshot.userRefs?.length ?? 0) + (snapshot.retrievalRefs?.length ?? 0)) > 0) {
        deps.incrementResourceRefsWithinSave([...(snapshot.userRefs ?? []), ...(snapshot.retrievalRefs ?? [])].map(ref => ref.resourceId));
      }
      for (const block of pending) owner.createBlockWithConn(tx, block);
      log.info(`[ChatV2::pipeline] Multi-variant results saved: user_msg=${userMessageId}, assistant_msg=${assistantMessageId}, variants=${contexts.length}`);
    }, { behavior: 'immediate' });
  } catch (error) {
    log.warn(`[ChatV2::pipeline] Multi-variant save rolled back: ${errorMessage(error)}`);
    throw error instanceof ChatV2Error ? error : new ChatV2Error('Database', errorMessage(error));
  }
}

/** multi_variant.rs:3193 update_variant_after_retry */
export function updateVariantAfterRetry(deps: PersistDeps, messageId: string, ctx: VariantExecution): void {
  const { owner, log } = deps;
  const conn = deps.connection();
  const message = owner.getMessageWithConn(conn, messageId);
  if (message === null) throw new ChatV2Error('MessageNotFound', messageId);
  const variant = message.variants?.find(v => v.id === ctx.variantId());
  if (variant !== undefined) {
    variant.status = ctx.status();
    const error = ctx.error();
    if (error === null) delete variant.error; else variant.error = error;
    variant.blockIds = ctx.blockIds();
    const meta = ctx.getMeta();
    if (meta === null) delete variant.meta; else variant.meta = meta;
    const usage = ctx.getUsage();
    if (usage.totalTokens > 0) variant.usage = usage; else delete variant.usage;
  }
  if (ctx.status() === 'success') {
    message.activeVariantId = ctx.variantId();
    log.info(`[ChatV2::pipeline] Auto-activated successful retry variant: ${ctx.variantId()}`);
  }
  for (const block of ctx.getInterleavedBlocks()) {
    block.messageId = messageId;
    if (block.type === 'content') {
      const status = ctx.status();
      block.status = status === 'success' ? 'success' : status === 'error' ? 'error' : status === 'cancelled' ? 'success' : 'running';
      const error = ctx.error();
      if (error === null) delete block.error; else block.error = error;
    }
    owner.createBlockWithConn(conn, block);
    if (!message.blockIds.includes(block.id)) message.blockIds.push(block.id);
  }
  owner.updateMessageWithConn(conn, message);
  if (ctx.status() === 'success') {
    const activeVariant = message.variants?.find(v => v.id === ctx.variantId());
    const snapshot = activeVariant?.meta?.skillSnapshotAfter ?? activeVariant?.meta?.skillSnapshotBefore ?? null;
    if (snapshot != null) {
      const hadBranch = (snapshot.branchLocalSkillIds?.length ?? 0) > 0;
      deps.updateSessionSkillState(message.sessionId, {
        manualPinnedSkillIds: [...(snapshot.manualPinnedSkillIds ?? [])],
        modeRequiredBundleIds: [...(snapshot.modeRequiredBundleIds ?? [])],
        agenticSessionSkillIds: [...(snapshot.agenticSessionSkillIds ?? [])], branchLocalSkillIds: [],
        effectiveAllowedExternalServers: [...(snapshot.effectiveAllowedExternalServers ?? [])],
        version: hadBranch ? snapshot.version + 1 : snapshot.version, legacyMigrated: false });
    }
  }
  log.debug(`[ChatV2::pipeline] Updated variant after retry: variant=${ctx.variantId()}, blocks=${ctx.blockIds().length}`);
}
