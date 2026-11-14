import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import pipeline from '../../chat-pipeline/index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { newSession } from '../src/types.ts';

describe('L03 PipelinePersistence with real L04 transaction store', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  beforeEach(async () => {
    f = databaseFixture(); host = await createTestHost({ plugins: [plugin, pipeline], provide: {
      storage: f.storage, vfs: vfsStub, settings: {}, nativeTokenizer: {}, vfsRepo: {}, agentVfsResolver: {},
    } });
    host.ctx.chatSession.createSession(newSession('sess_incremental', 'chat'));
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });
  it('binds user construction, inbound origin and early replay without a writer substitute', async () => {
    const sessions = host.ctx.chatSession; const pipe = host.ctx.chatPipeline;
    const save = pipe.createPersistence(sessions);
    const execution = pipe.createPipelineContext({ sessionId: 'sess_incremental', content: 'bare' });
    execution.options.userMessageOrigin = { kind: 'super_inbox', items: [] };
    await save.saveUserMessageImmediately(execution);
    expect(sessions.getMessage(execution.userMessageId)?._meta?.inboundOrigin).toEqual({ kind: 'super_inbox', items: [] });
    execution.compiledCurrentUserMessage = { role: 'user', content: '<user_query>完整📝 wrapper</user_query>' };
    save.persistUserLlmContentEarly(execution);
    const userBlock = sessions.getMessageBlocks(execution.userMessageId)[0]!;
    expect(sessions.getBlockReplayMapWithConn(f.db, execution.userMessageId).get(userBlock.id)?.llmContent).toBe('<user_query>完整📝 wrapper</user_query>');
    execution.addInterleavedBlock({ id: 'blk_reply', messageId: execution.assistantMessageId, type: 'content', status: 'success', content: 'reply', blockIndex: 0 });
    await save.saveIntermediateResults(execution);
    expect(sessions.getMessage(execution.userMessageId)?._meta?.inboundOrigin).toEqual({ kind: 'super_inbox', items: [] });
    expect(sessions.getMessage(execution.assistantMessageId)?._meta?.inboundOrigin).toBeUndefined();
    expect(sessions.getBlockReplayMapWithConn(f.db, execution.userMessageId).get(userBlock.id)?.llmContent).toBe('<user_query>完整📝 wrapper</user_query>');
  });
  it('preserves external payloads and dirty-state rollback through the same F3 transaction', async () => {
    const sessions = host.ctx.chatSession; const pipe = host.ctx.chatPipeline;
    const save = pipe.createPersistence(sessions);
    const execution = pipe.createPipelineContext({ sessionId: 'sess_incremental', content: 'bare' });
    execution.options.skipUserMessageSave = true;
    execution.addInterleavedBlock({ id: 'blk_first', messageId: execution.assistantMessageId, type: 'content', status: 'success', content: 'first', blockIndex: 0 });
    await save.saveIntermediateResults(execution);
    sessions.createBlockWithConn(f.db, { id: 'blk_anki', messageId: execution.assistantMessageId, type: 'anki_cards', status: 'success', blockIndex: 1, toolOutput: { secret: 'must remain' } });
    f.db.exec("CREATE TRIGGER prohibit_external_rewrite BEFORE UPDATE ON chat_v2_blocks WHEN OLD.id IN ('blk_anki', 'blk_first') BEGIN SELECT RAISE(ABORT, 'clean payload rewritten'); END");
    execution.addInterleavedBlock({ id: 'blk_second', messageId: execution.assistantMessageId, type: 'content', status: 'success', content: 'second', blockIndex: 2 });
    await save.saveIntermediateResults(execution);
    expect(sessions.getMessage(execution.assistantMessageId)?.blockIds).toContain('blk_anki');
    expect(sessions.getBlock('blk_anki')?.toolOutput).toEqual({ secret: 'must remain' });
    expect(execution.dirtyInterleavedBlockIds.size).toBe(0);
    f.db.exec("CREATE TRIGGER reject_second BEFORE UPDATE ON chat_v2_blocks WHEN OLD.id = 'blk_second' BEGIN SELECT RAISE(ABORT, 'forced rollback'); END");
    execution.addInterleavedBlock({ ...execution.interleavedBlocks[1]!, content: 'changed' });
    await expect(save.saveIntermediateResults(execution)).rejects.toThrow('forced rollback');
    expect(execution.dirtyInterleavedBlockIds.has('blk_second')).toBe(true);
    expect(sessions.getBlock('blk_second')?.content).toBe('second');
    f.db.exec('DROP TRIGGER reject_second');
    await save.saveIntermediateResults(execution);
    expect(execution.dirtyInterleavedBlockIds.size).toBe(0); expect(sessions.getBlock('blk_second')?.content).toBe('changed');
  });
});
