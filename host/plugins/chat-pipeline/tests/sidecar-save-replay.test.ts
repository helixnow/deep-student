import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPipelineHost } from './chat-host.ts';
import { persistenceStorePort } from './persistence-store-port.ts';
import { historyStorePort } from './history-store-port.ts';
import type { PipelineHistoryStore, PipelinePersistenceStore, PipelineContext } from '../api.ts';
import { makeEmptyMessage } from '../src/microcompact.ts';

let host: Awaited<ReturnType<typeof createPipelineHost>>;
const writePort = persistenceStorePort();
let sequence = 0;
beforeAll(async () => { host = await createPipelineHost({ provide: { pendingWrites: writePort } }); }, 60_000);
afterAll(async () => { await host?.dispose(); });
const BARE = '帮我总结这份周报';
const original = '<user_query>\n帮我总结这份周报\n</user_query>\n\n<injected_context>\n<runtime_facts>\n当前日期: 2026-08-20\n</runtime_facts>\n</injected_context>';
const wrapped = original.replace('2026-08-20', '2026-08-26');

async function turn(sidecar: string | null = null) {
  const session = `sidecar_${++sequence}`;
  const sessions = host.ctx.chatSession;
  sessions.createSession({ id: session, mode: 'chat', titleLocked: false, persistStatus: 'active',
    createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z' });
  const store = host.ctx.get('pendingWrites') as PipelinePersistenceStore;
  const save = host.ctx.chatPipeline.createPersistence(store);
  const ctx = host.ctx.chatPipeline.createPipelineContext({ sessionId: session, content: BARE });
  ctx.compiledCurrentUserMessage = makeEmptyMessage('user', wrapped);
  await save.saveUserMessageImmediately(ctx);
  const conn = sessions.database.getConnSafe();
  const id = store.getMessageBlocksWithConn(conn, ctx.userMessageId)[0]!.id;
  store.updateBlockReplayWithConn(conn, id, { llmContent: sidecar, toolCallId: null, roundText: null });
  const loader = host.ctx.chatPipeline.createHistoryLoader(historyStorePort(sessions, store));
  const read = () => conn.pluck<string | null>('SELECT llm_content FROM chat_v2_blocks WHERE id = ?', [id]);
  const next = () => host.ctx.chatPipeline.createPipelineContext({ sessionId: session, content: 'next' });
  const replay = async () => { const context = next(); await loader.loadChatHistory(context); return context.chatHistory[0]!.content; };
  const retry = (reuse = false) => {
    const context = host.ctx.chatPipeline.createPipelineContext({ sessionId: session, content: BARE,
      userMessageId: reuse ? ctx.userMessageId : undefined,
      assistantMessageId: ctx.assistantMessageId, options: { skipUserMessageSave: true } });
    context.compiledCurrentUserMessage = makeEmptyMessage('user', wrapped);
    return context;
  };
  const intermediate = async (context: PipelineContext) => {
    context.addInterleavedBlock({ id: `blk_reply_${session}`, messageId: context.assistantMessageId,
      type: 'content', status: 'success', content: 'reply', blockIndex: 0 });
    await save.saveIntermediateResults(context);
  };
  return { ctx, save, store, conn, id, read, replay, retry, loader, intermediate, next };
}

describe('crash/retry/history contracts through L03 save and loader, external L04 store only', () => {
  it('crash_after_send_without_early_persist_replays_bare_user_content', async () => {
    const t = await turn(); const live = t.ctx.liveUserLlmContent()!;
    expect(t.read()).toBeNull();
    const text = await t.replay();
    expect(text).toBe(BARE); expect(text).not.toContain('<user_query>');
    expect(text).not.toContain('<injected_context>'); expect(text).not.toBe(live);
  });
  it('crash_after_send_with_early_persist_replays_live_wrapped_bytes', async () => {
    const t = await turn(); t.save.persistUserLlmContentEarly(t.ctx);
    expect(t.read()).toBe(wrapped);
    const text = await t.replay(); expect(text).toBe(t.ctx.liveUserLlmContent());
    expect(text).toContain('<user_query>'); expect(text).toContain('<injected_context>');
  });
  it('empty_llm_content_sidecar_falls_back_to_bare_content', async () => { const t = await turn(''); expect(await t.replay()).toBe(BARE); });
  it('whitespace_only_llm_content_sidecar_is_replayed_verbatim', async () => { const t = await turn(' \n\t'); expect(await t.replay()).toBe(' \n\t'); });
  it('crash_before_first_send_is_harmless_no_cross_turn_drift', async () => { const t = await turn(); expect(t.read()).toBeNull(); expect(await t.replay()).toBe(BARE); });
  it('crash_after_early_persist_before_send_replays_persisted_wrapper', async () => {
    const t = await turn(); t.save.persistUserLlmContentEarly(t.ctx);
    expect(t.read()).toBe(wrapped); expect(await t.replay()).toBe(wrapped); expect(await t.replay()).not.toBe(BARE);
  });
  it('save_point_rebuild_preserves_early_sidecar_and_rewrites_idempotently', async () => {
    const t = await turn(); t.save.persistUserLlmContentEarly(t.ctx);
    await t.save.saveUserMessageImmediately(t.ctx); expect(t.read()).toBe(wrapped);
    await t.intermediate(t.ctx); expect(t.read()).toBe(wrapped); expect(await t.replay()).toBe(t.ctx.liveUserLlmContent());
  });
  it('edit_resend_invalidates_stale_sidecar_then_early_persist_backfills', async () => {
    const t = await turn(original);
    const editedBare = '帮我总结这份周报，并单独列出风险项';
    t.conn.transaction(conn => { conn.run('UPDATE chat_v2_blocks SET content = ?, llm_content = NULL WHERE id = ?', [editedBare, t.id]); });
    expect(await t.replay()).toBe(editedBare); expect(await t.replay()).not.toBe(original);
    const ctx = t.retry(true); ctx.userContent = editedBare;
    ctx.compiledCurrentUserMessage = makeEmptyMessage('user', wrapped.replace(BARE, editedBare));
    t.save.persistUserLlmContentEarly(ctx);
    expect(await t.replay()).toBe(ctx.liveUserLlmContent()); expect(await t.replay()).not.toBe(original);
  });
  it('legacy_multi_content_blocks_write_and_read_hit_same_first_row', async () => {
    const t = await turn();
    t.store.createBlockWithConn(t.conn, { id: `orphan_${t.id}`, messageId: t.ctx.userMessageId,
      type: 'content', status: 'success', content: '孤儿块残留', blockIndex: 1 });
    t.save.persistUserLlmContentEarly(t.ctx);
    expect(t.read()).toBe(wrapped); expect(await t.replay()).toBe(wrapped);
  });
  it('legacy_multi_content_blocks_empty_first_sidecar_masks_later_wrapper: actual history fallback joins bare content blocks', async () => {
    const t = await turn('');
    const orphan = `orphan_${t.id}`;
    t.store.createBlockWithConn(t.conn, { id: orphan, messageId: t.ctx.userMessageId,
      type: 'content', status: 'success', content: '', blockIndex: 1 });
    t.store.updateBlockReplayWithConn(t.conn, orphan, { llmContent: wrapped, toolCallId: null, roundText: null });
    expect(await t.replay()).toBe(BARE);
  });
  it('early_persist_preserves_multibyte_bytes_exactly', async () => {
    const t = await turn();
    const text = '<user_query>\n总结📝 café 週報\u200brésumé\n</user_query>\n\n<injected_context>\n<runtime_facts>\n当前日期: 2026-08-26\n</runtime_facts>\n</injected_context>';
    t.ctx.compiledCurrentUserMessage = makeEmptyMessage('user', text); t.save.persistUserLlmContentEarly(t.ctx);
    const actual = await t.replay(); expect(Buffer.from(actual)).toEqual(Buffer.from(text));
    expect(Buffer.byteLength(actual)).toBe(Buffer.byteLength(text));
  });
  it('retry_fresh_user_message_id_skips_early_and_save_point_sidecar_writes', async () => {
    const t = await turn(original), ctx = t.retry();
    const write = vi.mocked(writePort.updateBlockReplayWithConn); write.mockClear();
    t.save.persistUserLlmContentEarly(ctx); expect(write).not.toHaveBeenCalled();
    await t.intermediate(ctx); expect(write).not.toHaveBeenCalled(); expect(t.read()).toBe(original);
  });
  it('retry_leaves_stale_sidecar_next_turn_drifts_from_retry_live_bytes', async () => {
    const t = await turn(original); t.save.persistUserLlmContentEarly(t.retry());
    const text = await t.replay(); expect(text).toBe(original); expect(text).not.toBe(wrapped);
    expect(text).toContain('2026-08-20'); expect(text).not.toContain('2026-08-26');
  });
  it('retry_after_crash_window_null_sidecar_misses_backfill', async () => {
    const t = await turn(); t.save.persistUserLlmContentEarly(t.retry());
    expect(t.read()).toBeNull(); expect(await t.replay()).toBe(BARE); expect(await t.replay()).not.toBe(wrapped);
  });
  it('retry_live_request_double_includes_preceding_user_message', async () => {
    const t = await turn(original), ctx = t.retry(); await t.loader.loadChatHistory(ctx);
    const request = [...ctx.chatHistory, ctx.compiledCurrentUserMessage!].filter(m => m.role === 'user').map(m => m.content);
    expect(request).toHaveLength(2); expect(request.filter(text => text.includes(BARE))).toHaveLength(2);
    expect(request).toEqual([original, wrapped]); expect(request[0]).not.toBe(request[1]);
  });
  it('retry_reusing_preceding_user_id_closes_sidecar_gaps', async () => {
    const t = await turn(original), ctx = t.retry(true); await t.loader.loadChatHistory(ctx);
    expect([...ctx.chatHistory, ctx.compiledCurrentUserMessage!].map(m => m.content)).toEqual([wrapped]);
    t.save.persistUserLlmContentEarly(ctx); expect(t.read()).toBe(wrapped); expect(await t.replay()).toBe(ctx.liveUserLlmContent());
  });
  it('retry_reusing_preceding_user_id_backfills_null_sidecar', async () => {
    const t = await turn(); t.save.persistUserLlmContentEarly(t.retry(true));
    expect(t.read()).toBe(wrapped); expect(await t.replay()).toBe(wrapped);
  });
  it('empty_live_content_never_persists_and_empty_sidecar_falls_back_bare', async () => {
    const t = await turn(''); t.ctx.compiledCurrentUserMessage!.content = '';
    expect(t.ctx.liveUserLlmContent()).toBeNull(); t.save.persistUserLlmContentEarly(t.ctx); expect(t.read()).toBe('');
    t.ctx.compiledCurrentUserMessage!.content = wrapped; expect(t.ctx.liveUserLlmContent()).toBe(wrapped);
    expect(await t.replay()).toBe(BARE);
  });
  it('edit_and_resend_clears_stale_llm_content', async () => {
    const t = await turn('<user_query>\n编辑前的问题\n</user_query>');
    t.conn.transaction(conn => { conn.run('UPDATE chat_v2_blocks SET content = ?, llm_content = NULL WHERE id = ?', ['编辑后的新问题', t.id]); });
    const ctx = t.next(); await t.loader.loadChatHistory(ctx);
    expect(ctx.chatHistory).toHaveLength(1); expect(ctx.chatHistory[0]!.content).toBe('编辑后的新问题');
    expect(ctx.chatHistory[0]!.content).not.toContain('编辑前的问题');
  });
  it('edit_and_resend_skip_user_save_rewrites_llm_content', async () => {
    const t = await turn('<user_query>\n编辑前的问题\n</user_query>');
    t.conn.transaction(conn => { conn.run('UPDATE chat_v2_blocks SET content = ?, llm_content = NULL WHERE id = ?', ['编辑后的新问题', t.id]); });
    const edit = t.retry(true); edit.userContent = '编辑后的新问题';
    edit.compiledCurrentUserMessage = makeEmptyMessage('user', host.ctx.chatPipeline.wrapUserMessageText(edit.userContent, null));
    expect(edit.liveUserLlmContent()).toContain('编辑后的新问题');
    edit.addInterleavedBlock({ id: `edited_${t.id}`, messageId: edit.assistantMessageId, type: 'content', status: 'success', content: '新回答', blockIndex: 0 });
    await t.save.saveIntermediateResults(edit);
    const next = t.next(); await t.loader.loadChatHistory(next);
    expect(next.chatHistory).toHaveLength(2); expect(next.chatHistory[0]).toMatchObject({ role: 'user', content: edit.liveUserLlmContent() });
    expect(next.chatHistory[0]!.content).not.toContain('编辑前的问题');
    expect(next.chatHistory[1]).toMatchObject({ role: 'assistant', content: '新回答' });
  });
});
