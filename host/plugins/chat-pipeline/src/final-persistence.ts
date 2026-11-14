/** persistence.rs:860–1549. Transaction/ordering belongs to L03; all chat writes use L04 ports. */
import type { Context } from '@deepseek-ai/cordis';
import { ChatV2Error, type MessageMeta, type MessageBlock } from '../../chat/api.ts';
import type { AsyncTransaction, DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import { utf8ByteLength } from '../../../platform/util/index.ts';
import type { PipelineContext } from './pipeline-context.ts';
import type { PersistenceBlock, PipelineFinalStore, PipelinePostCommitEffects } from './persistence-port.ts';
import { existingUserContentBlockId, persistReplaySidecar } from './replay-persistence.ts';
import { buildReplaySkillPayloadSnapshot } from './persistence.ts';
import { isConfigIdFormat } from './constants.ts';
import { cloneAgentJson } from '../../../kernel/agent-api.ts';

type Log = Pick<Context['logger'], 'debug' | 'info' | 'warn' | 'error'>;
const text = (error: unknown) => error instanceof Error ? error.message : String(error);
const debugError = (error: unknown) => error instanceof ChatV2Error
  ? `${error.kind}${error.data === undefined ? '' : `(${JSON.stringify(error.data)})`}` : JSON.stringify(text(error));
const blockId = () => `blk_${globalThis.crypto.randomUUID()}`;

/** pipeline.rs:495 differs from context.rs static mapping; preserve the final-save branch. */
function savedToolType(tool: string): string {
  const name = tool.replace(/^(?:builtin-|mcp_)/, '');
  if (name.startsWith('workbench_') || ['note_append', 'note_replace', 'note_set', 'mindmap_edit_nodes'].includes(name)) return 'workbench_ops';
  switch (name) {
    case 'rag_search': case 'multimodal_search': case 'unified_search': return 'rag';
    case 'memory_search': return 'memory';
    case 'web_search': return 'web_search';
    case 'insight_recall': return 'insight_recall';
    case 'graph_search': return 'graph';
    case 'image_generate': return 'image_gen';
    case 'render_generative_ui': return 'generative_ui';
    case 'ask_user': return 'ask_user';
    default: return 'mcp_tool';
  }
}

export class PipelineFinalPersistence {
  private readonly connection: () => DatabaseHandle;
  private readonly store: PipelineFinalStore;
  private readonly effects: PipelinePostCommitEffects;
  private readonly log: Log;
  constructor(connection: () => DatabaseHandle, store: PipelineFinalStore, effects: PipelinePostCommitEffects, log: Log) {
    this.connection = connection; this.store = store; this.effects = effects; this.log = log;
  }

  async saveResults(ctx: PipelineContext): Promise<void> {
    this.log.debug(`[ChatV2::pipeline] Saving results for session=${ctx.sessionId}`);
    const db = this.connection();
    let tx: AsyncTransaction;
    try { tx = await db.begin({ behavior: 'immediate' }); }
    catch (error) {
      this.log.error(`[ChatV2::pipeline] Failed to begin transaction for save_results: ${text(error)}`);
      throw new ChatV2Error('Database', `Failed to begin transaction: ${text(error)}`);
    }
    try { this.saveInner(tx, ctx); }
    catch (error) {
      try { await tx.rollback(); this.log.warn(`[ChatV2::pipeline] Transaction rolled back for session=${ctx.sessionId}: ${debugError(error)}`); }
      catch (rollback) { this.log.error(`[ChatV2::pipeline] Failed to rollback transaction: ${text(rollback)} (original error: ${debugError(error)})`); }
      throw error;
    }
    try { await tx.commit(); }
    catch (error) {
      this.log.error(`[ChatV2::pipeline] Failed to commit transaction: ${text(error)}`);
      if (tx.active) {
        try { await tx.rollback(); }
        catch (rollback) { this.log.error(`[ChatV2::pipeline] Rollback after COMMIT failure: ${text(rollback)}`); }
      }
      throw new ChatV2Error('Database', `Failed to commit transaction: ${text(error)}`);
    }
    this.log.debug(`[ChatV2::pipeline] Transaction committed for session=${ctx.sessionId}`);
    const ids = [...ctx.contextSnapshot.userRefs, ...ctx.contextSnapshot.retrievalRefs].map(ref => ref.resourceId);
    if (ids.length) {
      await this.effects.incrementResourceRefs(ids);
      this.log.debug(`[ChatV2::pipeline] Incremented refs for ${ids.length} resources after message save`);
    }
    this.effects.triggerAutoMemoryExtraction(ctx);
    this.effects.onTurnCommitted(ctx);
  }

  private collectBlocks(ctx: PipelineContext): PersistenceBlock[] {
    const now = Date.now(), start = now - ctx.elapsedMs();
    const blocks: PersistenceBlock[] = [];
    const append = (block: MessageBlock) => { blocks.push({ ...cloneAgentJson(block), blockIndex: blocks.length }); };
    const retrievals = () => {
      for (const [key, type] of [['rag', 'rag'], ['memory', 'memory'], ['webSearch', 'web_search']] as const) {
        const sources = ctx.retrievedSources[key];
        if (!sources?.length) continue;
        append({ id: ctx.streamingRetrievalBlockIds.get(type) ?? blockId(), messageId: ctx.assistantMessageId,
          type, status: 'success', toolOutput: { sources: structuredClone(sources) }, startedAt: start, endedAt: now, firstChunkAt: start });
      }
    };
    if (ctx.interleavedBlockIds.length) {
      this.log.info(`[ChatV2::pipeline] Using interleaved blocks for save: count=${ctx.interleavedBlockIds.length}`);
      retrievals(); ctx.interleavedBlocks.forEach(append);
      return blocks;
    }
    if (ctx.generatedBlocks.length) {
      ctx.generatedBlocks.filter(b => b.type === 'thinking').forEach(append);
      retrievals(); ctx.generatedBlocks.filter(b => b.type !== 'thinking').forEach(append);
    } else if (ctx.finalContent !== '' || (ctx.finalReasoning != null && ctx.finalReasoning !== '')) {
      this.log.info(`[ChatV2::pipeline] save_results priority 3: final_content_len=${utf8ByteLength(ctx.finalContent)}, final_reasoning=${ctx.finalReasoning == null ? 'None' : `Some("${utf8ByteLength(ctx.finalReasoning)}chars")`}`);
      if (ctx.finalReasoning != null && ctx.finalReasoning !== '') append({ id: ctx.streamingThinkingBlockId ?? blockId(),
        messageId: ctx.assistantMessageId, type: 'thinking', status: 'success', content: ctx.finalReasoning,
        startedAt: start, endedAt: now, firstChunkAt: start });
      retrievals();
      if (ctx.finalContent !== '') append({ id: ctx.streamingContentBlockId ?? blockId(), messageId: ctx.assistantMessageId,
        type: 'content', status: 'success', content: ctx.finalContent, startedAt: start, endedAt: now, firstChunkAt: start });
    }
    for (const result of ctx.toolResults) {
      const startedAt = now - (result.durationMs ?? 0);
      append({ id: result.blockId ?? blockId(), messageId: ctx.assistantMessageId, type: savedToolType(result.toolName),
        status: result.success ? 'success' : 'error', toolName: result.toolName, toolInput: result.input,
        toolOutput: result.output, ...(result.success || result.error == null ? {} : { error: result.error }),
        startedAt, endedAt: now, firstChunkAt: startedAt });
    }
    return blocks;
  }

  private saveInner(conn: SqlExecutor, ctx: PipelineContext): void {
    let userBlock: string | null;
    if (!(ctx.options.skipUserMessageSave ?? false)) {
      const user = this.store.buildUserMessage({ id: ctx.userMessageId, sessionId: ctx.sessionId, content: ctx.userContent,
        attachments: structuredClone(ctx.attachments), contextSnapshot: structuredClone(ctx.contextSnapshot),
        canonicalContent: structuredClone(ctx.canonicalContent), executionSnapshot: structuredClone(ctx.executionSnapshot), timestamp: Date.now() });
      if (ctx.options.userMessageOrigin != null) { user.message._meta ??= {}; user.message._meta.inboundOrigin = structuredClone(ctx.options.userMessageOrigin); }
      this.store.createMessageWithConn(conn, user.message); this.store.createBlockWithConn(conn, user.block);
      userBlock = user.block.id;
      this.log.debug(`[ChatV2::pipeline] Saved user message: id=${ctx.userMessageId}, content_len=${utf8ByteLength(ctx.userContent)}`);
    } else {
      userBlock = existingUserContentBlockId(conn, (c, id) => this.store.getMessageBlocksWithConn(c, id), ctx.userMessageId);
      this.log.debug(`[ChatV2::pipeline] Skipped user message save (skip_user_message_save=true): id=${ctx.userMessageId}, existing_content_block=${userBlock === null ? 'None' : `Some(${JSON.stringify(userBlock)})`}`);
    }
    const blocks = this.collectBlocks(ctx);
    const ids = blocks.map(b => b.id);
    const preserved = this.store.getMessageBlocksWithConn(conn, ctx.assistantMessageId).filter(b => b.type === 'anki_cards');
    const preservedIds = new Set(preserved.map(b => b.id));
    let existingIds: string[] = [];
    try { existingIds = this.store.getMessageWithConn(conn, ctx.assistantMessageId)?.blockIds ?? []; }
    catch { existingIds = []; } // Rust optional query/JSON errors ignored at persistence.rs:1301–1325.
    for (const id of existingIds) {
      if (preservedIds.has(id) || ids.includes(id)) continue;
      this.log.info(`[ChatV2::pipeline] 🔧 P37: Preserving frontend-appended block_id: ${id}`); ids.push(id);
    }
    for (const block of preserved.filter(b => !ids.includes(b.id)).sort((a, b) => a.blockIndex - b.blockIndex)) {
      if (!ids.includes(block.id)) ids.splice(Math.min(block.blockIndex, ids.length), 0, block.id);
    }
    const positions = new Map(ids.map((id, index) => [id, index]));
    const options = ctx.options;
    const chatParams: Record<string, unknown> = {};
    for (const key of ['modelId', 'temperature', 'contextLimit', 'maxTokens', 'enableThinking', 'reasoningEffort', 'thinkingBudget', 'disableTools', 'model2OverrideId'] as const) {
      chatParams[key] = options[key] ?? null;
    }
    const model = ctx.modelDisplayName ?? [options.model2OverrideId, options.modelId].find(id => id != null && !isConfigIdFormat(id));
    const skillSnapshot = buildReplaySkillPayloadSnapshot(options);
    const anchors = options.skillInjectionAnchors;
    const meta: MessageMeta = {
      ...(model == null ? {} : { modelId: model }),
      ...(ctx.executionSnapshot === null ? {} : { executionSnapshot: structuredClone(ctx.executionSnapshot) }),
      chatParams, usage: structuredClone(ctx.tokenUsage),
      ...([ctx.retrievedSources.rag, ctx.retrievedSources.memory, ctx.retrievedSources.webSearch].some(v => v != null)
        ? { sources: structuredClone(ctx.retrievedSources) } : {}),
      ...(ctx.toolResults.length ? { toolResults: cloneAgentJson(ctx.toolResults) } : {}),
      ...(ctx.contextSnapshot.userRefs.length || ctx.contextSnapshot.retrievalRefs.length ? { contextSnapshot: structuredClone(ctx.contextSnapshot) } : {}),
      ...(skillSnapshot === null ? {} : { skillRuntimeBefore: structuredClone(skillSnapshot), skillRuntimeAfter: structuredClone(skillSnapshot) }),
      ...(ctx.responseReasoningByToolCallId.size ? { responseReasoningItems: Object.fromEntries(ctx.responseReasoningByToolCallId) } : {}),
      ...(anchors != null && ((anchors.turnSkillIds?.length ?? 0) || (anchors.toolAnchored?.length ?? 0)) ? { skillInjectionAnchors: structuredClone(anchors) } : {}),
      ...(ctx.responseWebSearchItems.length ? { openai_responses_web_search_items: structuredClone(ctx.responseWebSearchItems) } : {}),
    };
    const message = { id: ctx.assistantMessageId, sessionId: ctx.sessionId, role: 'assistant' as const, blockIds: ids, timestamp: Date.now(), _meta: meta };
    if (options.skipAssistantMessageSave ?? false) {
      this.log.debug(`[ChatV2::pipeline] Updating existing assistant message for retry: id=${ctx.assistantMessageId}`);
      this.store.updateMessageWithConn(conn, message);
    } else this.store.createMessageWithConn(conn, message);
    for (const block of blocks) this.store.createBlockWithConn(conn, { ...block, messageId: ctx.assistantMessageId, blockIndex: positions.get(block.id) ?? block.blockIndex });
    const pipelineIds = new Set(blocks.map(b => b.id));
    for (const block of preserved) {
      if (pipelineIds.has(block.id)) continue;
      try { this.store.createBlockWithConn(conn, { ...block, messageId: ctx.assistantMessageId, blockIndex: positions.get(block.id) ?? block.blockIndex }); }
      catch (error) { this.log.error(`[ChatV2::pipeline] Failed to re-insert preserved anki_cards block: message_id=${ctx.assistantMessageId}, block_id=${block.id}, err=${debugError(error)}`); }
    }
    persistReplaySidecar(conn, ctx, userBlock, null, this.store);
    this.log.info(`[ChatV2::pipeline] Results saved: session=${ctx.sessionId}, user_msg=${ctx.userMessageId}, assistant_msg=${ctx.assistantMessageId}, blocks=${ctx.generatedBlocks.length}, content_len=${utf8ByteLength(ctx.finalContent)}`);
  }
}
