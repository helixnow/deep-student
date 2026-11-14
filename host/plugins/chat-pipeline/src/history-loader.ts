/** history.rs::load_chat_history. Repository operations stay behind L04 owner ports. */
import type { Context } from '@deepseek-ai/cordis';
import type { ChatMessage } from '../../chat/api.ts';
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import { decodeUtf8Strict, rustTrim, utf8ByteLength } from '../../../platform/util/index.ts';
import type { PipelineHistoryStore } from './history-port.ts';
import type { PersistenceBlock } from './persistence-port.ts';
import type { PipelineContext } from './pipeline-context.ts';
import type { LegacyChatMessage } from './microcompact.ts';
import { makeSummarySystemMessage } from './compaction-prompts.ts';
import { activeVariantArtifactsByUser, buildToolRoundMessages, canonicalContentForHistory,
  filterBlocksForActiveVariant, historyMessage, isToolCallBlock, repairToolChain, restoreWorkspaceInjections, validateToolChain } from './history-replay.ts';
import { insertTransientSkillMessages, parseSkillInjectionAnchors, rebuildAnchoredSkillMessagesGated } from './skill-injection.ts';
import { toBase64, fromBase64 } from '../../../platform/crypto/encoding.ts';

type Logger = Pick<Context['logger'], 'warn' | 'info' | 'debug'>;
export interface HistoryDependencies {
  getConnection(): DatabaseHandle;
  getVfsConnection(): SqlExecutor | null;
  resolveSnapshot(original: string, message: ChatMessage, conn: SqlExecutor): Promise<[string, string[]]>;
  extractDocument(name: string, base64: string): Promise<string>;
  logger: Logger;
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export class PipelineHistoryLoader {
  private readonly store: PipelineHistoryStore;
  private readonly deps: HistoryDependencies;
  constructor(store: PipelineHistoryStore, deps: HistoryDependencies) { this.store = store; this.deps = deps; }

  private compactionView(conn: SqlExecutor, session: string, ids: string[]): [LegacyChatMessage | null, string[]] {
    const log = this.deps.logger;
    try {
      const artifacts = new Set(this.store.getCompactionSummaryMessageIdsWithConn(conn, session));
      ids = ids.filter(id => !artifacts.has(id));
    } catch (error) { log.warn(`[compaction] failed to identify summary artifacts for session=${session}: ${errorText(error)}`); }
    let record;
    try { record = this.store.getActiveCompactionWithConn(conn, session); }
    catch (error) {
      log.warn(`[compaction] apply_compaction_view: get_active_compaction failed for session=${session}: ${errorText(error)}; falling back to raw history (may exceed context window)`);
      return [null, ids];
    }
    if (record === null) return [null, ids];
    let summary = '';
    try { summary = this.store.getMessageBlocksWithConn(conn, record.summaryMessageId).find(b => b.type === 'compaction_summary')?.content ?? ''; }
    catch (error) { log.warn(`[compaction] apply_compaction_view: read summary blocks failed for session=${session} msg=${record.summaryMessageId}: ${errorText(error)}`); }
    if (rustTrim(summary) === '') {
      log.warn(`[compaction] apply_compaction_view: summary text is empty for session=${session}; falling back to raw history`);
      return [null, ids];
    }
    const summaryOnly = record.tailStartMessageId === record.summaryMessageId;
    const boundary = summaryOnly ? record.rangeEndMessageId ?? '' : record.tailStartMessageId;
    const index = ids.indexOf(boundary);
    if (index < 0) {
      log.warn(`[compaction] tail boundary missing for session=${session} compaction=${record.id}; using raw history`);
      return [null, ids];
    }
    return [makeSummarySystemMessage(summary, record.id), ids.slice(index + (summaryOnly ? 1 : 0))];
  }

  private async documents(message: ChatMessage): Promise<NonNullable<LegacyChatMessage['doc_attachments']> | null> {
    const docs: NonNullable<LegacyChatMessage['doc_attachments']> = [];
    for (const attachment of message.attachments ?? []) {
      if (attachment.type !== 'document') continue;
      const doc = { name: attachment.name, mime_type: attachment.mimeType, size_bytes: attachment.size,
        text_content: null as string | null, base64_content: null as string | null };
      const value = attachment.previewUrl?.startsWith('data:') ? attachment.previewUrl.split(',')[1] : undefined;
      if (value !== undefined) {
        const isText = attachment.mimeType.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript'].includes(attachment.mimeType);
        if (isText) {
          try {
            const bytes = fromBase64(value);
            if (toBase64(bytes) === value) doc.text_content = decodeUtf8Strict(bytes);
          } catch { doc.text_content = null; } // Rust STANDARD.decode(...).ok().and_then(String::from_utf8(...).ok()).
        } else {
          doc.base64_content = value;
          try {
            doc.text_content = await this.deps.extractDocument(attachment.name, value);
            this.deps.logger.debug(`[ChatV2::pipeline] Extracted ${utf8ByteLength(doc.text_content)} chars from history document: ${attachment.name}`);
          } catch (error) { this.deps.logger.debug(`[ChatV2::pipeline] Could not parse history document ${attachment.name}: ${errorText(error)}`); }
        }
      }
      docs.push(doc);
    }
    return docs.length ? docs : null;
  }

  async loadChatHistory(ctx: PipelineContext): Promise<void> {
    const log = this.deps.logger;
    log.debug(`[ChatV2::pipeline] Loading chat history for session=${ctx.sessionId}`);
    const conn = this.deps.getConnection();
    let vfs: SqlExecutor | null = null;
    try { vfs = this.deps.getVfsConnection(); }
    catch (error) { log.warn(`[ChatV2::pipeline] Failed to get vfs.db connection for history context_snapshot: ${errorText(error)}`); }
    const allIds = this.store.getSessionMessageIdsWithConn(conn, ctx.sessionId);
    if (!allIds.length) {
      log.debug(`[ChatV2::pipeline] No chat history found for session=${ctx.sessionId}`);
      ctx.chatHistory = []; return;
    }
    const [summary, ids] = this.compactionView(conn, ctx.sessionId,
      allIds.filter(id => id !== ctx.userMessageId && id !== ctx.assistantMessageId));
    if (!ids.length) {
      log.debug(`[ChatV2::pipeline] No chat history after excluding current messages for session=${ctx.sessionId}`);
      ctx.chatHistory = summary === null ? [] : [summary]; return;
    }
    const messages = this.store.getMessagesByIdsWithConn(conn, ctx.sessionId, ids);
    const [byMessage, replay] = this.store.getHistoryBlocksWithReplayWithConn(conn, messages.map(m => m.id));
    const activeArtifacts = activeVariantArtifactsByUser(messages);
    const mismatches: string[] = [];
    const skillContents = ctx.options.replaySkillContents ?? ctx.options.skillContents;
    const skills = skillContents == null ? null : new Map(Object.entries(skillContents));
    log.debug(`[ChatV2::pipeline] Loading all ${messages.length} unsummarized messages`);
    const history: LegacyChatMessage[] = [];
    let lastUser: number | null = null;
    for (const message of messages) {
      const blocks = filterBlocksForActiveVariant(message, byMessage.get(message.id) ?? []);
      if (message.role === 'assistant') lastUser = restoreWorkspaceInjections(blocks, history, lastUser);
      const anchorValue = message.role === 'assistant' ? message._meta?.skillInjectionAnchors : null;
      const anchors = anchorValue == null ? null : parseSkillInjectionAnchors(JSON.stringify(anchorValue));
      if (anchors?.turnSkillIds.length) {
        const restored = rebuildAnchoredSkillMessagesGated(anchors.turnSkillIds, skills, anchors, mismatches, log);
        if (restored.length) {
          const at = anchors.beforeTurnUser ? Math.min(lastUser ?? history.length, history.length) : history.length;
          const before = history.length;
          insertTransientSkillMessages(history, at, restored);
          if (lastUser !== null && at <= lastUser) lastUser += history.length - before;
        }
      }
      let content = blocks.filter(b => b.type === 'content').map(b => b.content ?? '').join('');
      let pendingThinking: string | null = null;
      const tools: [string | null, typeof blocks[number]][] = [];
      for (const block of blocks) {
        if (block.type === 'thinking') {
          if (block.content != null && block.content !== '') pendingThinking = pendingThinking === null ? block.content : `${pendingThinking}\n${block.content}`;
        } else if (isToolCallBlock(block)) { tools.push([pendingThinking, block]); pendingThinking = null; }
      }
      const thinking = tools.length ? pendingThinking : blocks.filter(b => b.type === 'thinking').map(b => b.content ?? '').join('') || null;
      let override: string | null = null;
      if (message.role === 'user') {
        for (const block of blocks) {
          if (block.type !== 'content') continue;
          const value = replay.get(block.id)?.llmContent;
          if (value != null) { override = value === '' ? null : value; break; }
        }
      }
      let vfsImages: string[] = [];
      if (message.role === 'user') {
        if (vfs !== null) [content, vfsImages] = await this.deps.resolveSnapshot(content, message, vfs);
        if (override !== null) content = override;
      }
      let pending = anchors?.toolAnchored ?? [];
      if (message.role === 'assistant') {
        for (const [index, [reasoning, tool]] of tools.entries()) {
          const pair = buildToolRoundMessages(message._meta, replay.get(tool.id), tool, reasoning);
          history.push(...pair);
          const callId = pair[1].tool_result!.call_id;
          const rest = [];
          for (const anchor of pending) {
            if ((anchor.roundLastToolCallId ?? anchor.toolCallId) !== callId) { rest.push(anchor); continue; }
            history.push(...rebuildAnchoredSkillMessagesGated(anchor.skillIds, skills, anchors, mismatches, log));
          }
          pending = rest;
          log.debug(`[ChatV2::pipeline] Loaded tool call from history: tool=${tool.toolName ?? ''}, block_type=${tool.type}, block_id=${tool.id}, index=${index}, has_thinking=${reasoning !== null}`);
        }
        if (tools.length) for (const anchor of pending) {
          log.warn(`[ChatV2::pipeline] P1-8: tool-anchored skills ${JSON.stringify(anchor.skillIds)} did not match any tool_call_id (anchor=${anchor.toolCallId}); appending after tool messages`);
          history.push(...rebuildAnchoredSkillMessagesGated(anchor.skillIds, skills, anchors, mismatches, log));
        }
      }
      const images = (message.attachments ?? []).filter(a => a.type === 'image')
        .flatMap(a => { const value = a.previewUrl?.split(',')[1]; return value === undefined ? [] : [value]; });
      images.push(...vfsImages);
      const documents = await this.documents(message);
      if (content === '' && !images.length && documents === null && (thinking === null || rustTrim(thinking) === '')) continue;
      const out = historyMessage(message.role, content === '' && message.role === 'user' ? '[用户发送了附件]' : content);
      out.thinking_content = thinking;
      out.image_base64 = images.length ? images : null;
      out.doc_attachments = documents;
      out.persistent_stable_id = message.persistentStableId ?? null;
      const metadata: Record<string, unknown> = {};
      const canonical = canonicalContentForHistory(message, activeArtifacts.get(message.id));
      if (canonical !== null) metadata.canonicalContent = canonical;
      if (message.role === 'assistant') {
        if (message._meta?.openai_responses_web_search_items?.length) metadata.openai_responses_web_search_items = structuredClone(message._meta.openai_responses_web_search_items);
        const item = message._meta?.responseReasoningItems?.__final_assistant__;
        if (item !== undefined) metadata.openai_responses_reasoning_item = structuredClone(item);
      }
      out.metadata = Object.keys(metadata).length ? metadata : null;
      if (message.role === 'user') lastUser = history.length;
      history.push(out);
    }
    log.info(`[ChatV2::pipeline] Loaded ${history.length} messages from history for session=${ctx.sessionId}`);
    if (mismatches.length) {
      log.warn(`[ChatV2::pipeline] skill_digest_generation_signal: session_id=${ctx.sessionId}, mismatch_count=${mismatches.length}, skill_ids=${JSON.stringify(mismatches)} — history replay prefix drifted at these skill positions; requesting new available_skills prefix generation`);
      try {
        const generation = this.deps.getConnection().transaction(tx =>
          this.store.markAvailableSkillsSnapshotStaleWithConn(tx, ctx.sessionId), { behavior: 'immediate' });
        if (generation !== null) log.info(`[ChatV2::pipeline] skill_digest_generation_signal: available_skills catalog pending generation declared: session_id=${ctx.sessionId}, pending_generation=${generation}`);
        else log.debug(`[ChatV2::pipeline] skill_digest_generation_signal: session never froze an available_skills snapshot; nothing to regenerate (signal logged only): session_id=${ctx.sessionId}`);
      } catch (error) { log.warn(`[ChatV2::pipeline] skill_digest_generation_signal: failed to persist pending generation marker (signal degraded to log only, send not blocked): session_id=${ctx.sessionId}, error=${errorText(error)}`); }
    }
    if (summary !== null) history.unshift(summary);
    if (!validateToolChain(history, log)) repairToolChain(history, log);
    ctx.chatHistory = history;
  }

  /** multi_variant.rs:2293 load_variant_chat_history — excludes this attempt's assistant and its source user. */
  async loadVariantChatHistory(sessionId: string, assistantMessageId: string | null): Promise<LegacyChatMessage[]> {
    const log = this.deps.logger;
    log.debug(`[ChatV2::pipeline] Loading variant chat history for session=${sessionId}`);
    const conn = this.deps.getConnection();
    let vfs: SqlExecutor | null = null;
    try { vfs = this.deps.getVfsConnection(); }
    catch (error) { log.warn(`[ChatV2::pipeline] Failed to get vfs.db connection for variant history context_snapshot: ${errorText(error)}`); }
    const allIds = this.store.getSessionMessageIdsWithConn(conn, sessionId);
    if (!allIds.length) {
      log.debug(`[ChatV2::pipeline] No variant chat history found for session=${sessionId}`);
      return [];
    }
    let all = this.store.getMessagesByIdsWithConn(conn, sessionId, allIds);
    if (assistantMessageId !== null) {
      const index = all.findIndex(message => message.id === assistantMessageId);
      if (index >= 0) {
        const sourceUser = all.slice(0, index).reverse().find(message => message.role === 'user')?.id ?? null;
        all = all.filter(message => message.id !== assistantMessageId && (sourceUser === null || message.id !== sourceUser));
      }
    }
    const [summary, ids] = this.compactionView(conn, sessionId, all.map(message => message.id));
    const keep = new Set(ids);
    const messages = all.filter(message => keep.has(message.id));
    const [byMessage, replay] = this.store.getHistoryBlocksWithReplayWithConn(conn, messages.map(m => m.id));
    const activeArtifacts = activeVariantArtifactsByUser(messages);
    log.debug(`[ChatV2::pipeline] Loading all ${messages.length} unsummarized variant messages`);
    const history: LegacyChatMessage[] = [];
    let lastUser: number | null = null;
    for (const message of messages) {
      const blocks = filterBlocksForActiveVariant(message, byMessage.get(message.id) ?? []);
      if (message.role === 'assistant') lastUser = restoreWorkspaceInjections(blocks, history, lastUser);
      let content = blocks.filter(b => b.type === 'content').map(b => b.content ?? '').join('');
      const thinkingText = blocks.filter(b => b.type === 'thinking').map(b => b.content ?? '').join('');
      const thinking = thinkingText === '' ? null : thinkingText;
      const tools = blocks.filter(b => b.type === 'mcp_tool').sort((a, b) => (a as PersistenceBlock).blockIndex - (b as PersistenceBlock).blockIndex);
      let override: string | null = null;
      if (message.role === 'user') {
        for (const block of blocks) {
          if (block.type !== 'content') continue;
          const value = replay.get(block.id)?.llmContent;
          if (value != null) { override = value === '' ? null : value; break; }
        }
      }
      let vfsImages: string[] = [];
      if (message.role === 'user') {
        if (vfs !== null) [content, vfsImages] = await this.deps.resolveSnapshot(content, message, vfs);
        if (override !== null) content = override;
      }
      if (message.role === 'assistant') {
        for (const [index, tool] of tools.entries()) {
          history.push(...buildToolRoundMessages(message._meta, replay.get(tool.id), tool, null));
          log.debug(`[ChatV2::pipeline] Loaded variant tool call from history: tool=${tool.toolName ?? ''}, block_id=${tool.id}, index=${index}`);
        }
      }
      const images = (message.attachments ?? []).filter(a => a.type === 'image')
        .flatMap(a => { const value = a.previewUrl?.split(',')[1]; return value === undefined ? [] : [value]; });
      images.push(...vfsImages);
      const documents = await this.documents(message);
      if (content === '' && !images.length && documents === null && (thinking === null || rustTrim(thinking) === '')) continue;
      const out = historyMessage(message.role, content === '' && message.role === 'user' ? '[用户发送了附件]' : content);
      out.thinking_content = thinking;
      out.image_base64 = images.length ? images : null;
      out.doc_attachments = documents;
      out.persistent_stable_id = message.persistentStableId ?? null;
      const canonical = canonicalContentForHistory(message, activeArtifacts.get(message.id));
      out.metadata = canonical === null ? null : { canonicalContent: canonical };
      if (message.role === 'user') lastUser = history.length;
      history.push(out);
    }
    log.info(`[ChatV2::pipeline] Loaded ${history.length} variant messages from history for session=${sessionId}`);
    if (!validateToolChain(history, log)) repairToolChain(history, log);
    if (summary !== null) history.unshift(summary);
    return history;
  }
}
