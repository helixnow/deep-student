import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPipelineHost } from './chat-host.ts';
import { persistenceStorePort } from './persistence-store-port.ts';
import type { PipelinePersistenceStore, PersistenceBlock } from '../src/persistence-port.ts';
import { makeEmptyMessage } from '../src/microcompact.ts';

let host: Awaited<ReturnType<typeof createPipelineHost>>;
const store = persistenceStorePort();
beforeAll(async () => { host = await createPipelineHost({ provide: { pendingChatPersistence: store } }); }, 60_000);
afterAll(async () => { await host?.dispose(); });
let sequence = 0;
function context() {
  const sessionId = `sess_incremental_${++sequence}`;
  host.ctx.chatSession.createSession({ id: sessionId, mode: 'chat', titleLocked: false,
    persistStatus: 'active', createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z' });
  return host.ctx.chatPipeline.createPipelineContext({ sessionId, content: 'bare input' });
}
function persistence() {
  return host.ctx.chatPipeline.createPersistence(host.ctx.get('pendingChatPersistence') as PipelinePersistenceStore);
}
function block(messageId: string, id: string, content: string, blockIndex: number): PersistenceBlock {
  return { messageId, id, type: 'content', status: 'success', content, blockIndex };
}

describe('persistence.rs::incremental_save_tests through production L03 orchestration', () => {
  it('user_message_persists_inbound_origin_from_internal_option', async () => {
    const save = persistence();
    const plain = context();
    await save.saveUserMessageImmediately(plain);
    expect(host.ctx.chatSession.getMessage(plain.userMessageId)!._meta?.inboundOrigin).toBeUndefined();
    const origin = { kind: 'super_inbox', items: [{ type: 'worker.completed', workerId: 'agent_1' }] };
    const ctx = context();
    ctx.options.userMessageOrigin = origin;
    await save.saveUserMessageImmediately(ctx);
    expect(host.ctx.chatSession.getMessage(ctx.userMessageId)!._meta?.inboundOrigin).toEqual(origin);
    ctx.addInterleavedBlock(block(ctx.assistantMessageId, 'blk_inbound_origin_0', 'reply', 0));
    await save.saveIntermediateResults(ctx);
    const saved = host.ctx.chatSession.getMessage(ctx.userMessageId)!;
    expect(saved._meta?.inboundOrigin).toEqual(origin);
    expect(host.ctx.chatSession.getMessage(ctx.assistantMessageId)!._meta?.inboundOrigin).toBeUndefined();
    expect(JSON.parse(JSON.stringify(saved._meta)).inboundOrigin).toEqual(origin);
  });

  it('intermediate_saves_write_only_changed_payloads_and_retain_dirty_on_rollback', async () => {
    const db = host.ctx.chatSession.database.getConnSafe();
    db.exec(`CREATE TABLE perf_payload_writes (block_id TEXT);
      CREATE TRIGGER perf_insert AFTER INSERT ON chat_v2_blocks WHEN NEW.id LIKE 'blk_dirty_%'
      BEGIN INSERT INTO perf_payload_writes VALUES (NEW.id); END;
      CREATE TRIGGER perf_update AFTER UPDATE OF content, status, tool_output_json ON chat_v2_blocks
      WHEN NEW.id LIKE 'blk_dirty_%' BEGIN INSERT INTO perf_payload_writes VALUES (NEW.id); END;`);
    const ctx = context();
    ctx.options.skipUserMessageSave = true;
    const save = persistence();
    for (let index = 0; index < 50; index++) {
      ctx.addInterleavedBlock(block(ctx.assistantMessageId, `blk_dirty_${String(index).padStart(3, '0')}`, `payload ${index}`, index));
      await save.saveIntermediateResults(ctx);
    }
    expect(db.pluck('SELECT COUNT(*) FROM perf_payload_writes')).toBe(50);
    const anki = { ...block(ctx.assistantMessageId, 'blk_external_anki', 'external payload', 7), type: 'anki_cards' };
    store.createBlockWithConn(db, anki);
    await save.saveIntermediateResults(ctx);
    expect(host.ctx.chatSession.getMessage(ctx.assistantMessageId)!.blockIds).toContain(anki.id);
    expect(host.ctx.chatSession.getBlock(anki.id)!.content).toBe(anki.content);
    let changed = { ...ctx.interleavedBlocks.at(-1)!, content: 'replacement using the same block ID' };
    ctx.addInterleavedBlock(changed);
    db.exec(`CREATE TRIGGER perf_reject BEFORE UPDATE ON chat_v2_blocks WHEN NEW.id = 'blk_dirty_049'
      BEGIN SELECT RAISE(ABORT, 'forced rollback'); END;`);
    await expect(save.saveIntermediateResults(ctx)).rejects.toThrow('forced rollback');
    expect(ctx.dirtyInterleavedBlockIds.has(changed.id)).toBe(true);
    expect(host.ctx.chatSession.getBlock(changed.id)!.content).toBe('payload 49');
    db.exec('DROP TRIGGER perf_reject');
    await save.saveIntermediateResults(ctx);
    expect(ctx.dirtyInterleavedBlockIds.size).toBe(0);
    expect(host.ctx.chatSession.getBlock(changed.id)!.content).toBe(changed.content);
    expect(db.pluck('SELECT COUNT(*) FROM perf_payload_writes')).toBe(51);
    db.exec(`CREATE TABLE perf_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE perf_deferred (parent_id INTEGER REFERENCES perf_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER perf_commit_reject AFTER UPDATE ON chat_v2_blocks WHEN NEW.id = 'blk_dirty_049'
      BEGIN INSERT INTO perf_deferred VALUES (999); END;`);
    changed = { ...changed, content: 'after failed commit' };
    ctx.addInterleavedBlock(changed);
    await expect(save.saveIntermediateResults(ctx)).rejects.toThrow('Failed to commit transaction');
    expect(ctx.dirtyInterleavedBlockIds.has(changed.id)).toBe(true);
    expect(host.ctx.chatSession.getBlock(changed.id)!.content).toBe('replacement using the same block ID');
    db.exec('DROP TRIGGER perf_commit_reject');
    await save.saveIntermediateResults(ctx);
    expect(ctx.dirtyInterleavedBlockIds.size).toBe(0);
    expect(host.ctx.chatSession.getBlock(changed.id)!.content).toBe(changed.content);
  });

  it('save_intermediate_results_with_retry retains early sidecar, retries once, and preserves dirty after two failures', async () => {
    const ctx = context();
    const save = persistence();
    await save.saveUserMessageImmediately(ctx);
    ctx.compiledCurrentUserMessage = makeEmptyMessage('user', '完整📝 wrapper');
    save.persistUserLlmContentEarly(ctx);
    const db = host.ctx.chatSession.database.getConnSafe();
    const readSidecar = () => db.pluck('SELECT llm_content FROM chat_v2_blocks WHERE message_id = ?', [ctx.userMessageId]);
    expect(readSidecar()).toBe('完整📝 wrapper');
    ctx.addInterleavedBlock(block(ctx.assistantMessageId, 'blk_retry_save', 'generated', 0));
    const writes = vi.mocked(store.createBlockWithConn);
    writes.mockImplementationOnce(() => { throw new Error('busy first attempt'); });
    const warn = vi.spyOn(host.ctx.logger, 'warn');
    const info = vi.spyOn(host.ctx.logger, 'info');
    const error = vi.spyOn(host.ctx.logger, 'error');
    expect(await save.saveIntermediateResultsWithRetry(ctx, 'before-tool')).toBe(true);
    expect(info).toHaveBeenCalledWith(`[ChatV2::pipeline] Intermediate save retry succeeded at before-tool (session=${ctx.sessionId})`);
    expect(readSidecar()).toBe('完整📝 wrapper');
    ctx.addInterleavedBlock(block(ctx.assistantMessageId, 'blk_retry_save', 'replacement', 0));
    writes.mockImplementationOnce(() => { throw new Error('first failure'); })
      .mockImplementationOnce(() => { throw new Error('second failure'); });
    expect(await save.saveIntermediateResultsWithRetry(ctx, 'before-next-llm')).toBe(false);
    expect(ctx.dirtyInterleavedBlockIds.has('blk_retry_save')).toBe(true);
    expect(host.ctx.chatSession.getBlock('blk_retry_save')!.content).toBe('generated');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('retrying once'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('continuing without persistence — generated blocks may be lost on refresh until the next save point'));
    warn.mockRestore(); info.mockRestore(); error.mockRestore();
  });
});
