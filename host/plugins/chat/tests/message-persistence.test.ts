import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import pipeline from '../../chat-pipeline/index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { newSession } from '../src/types.ts';
import { saveSessionStateWithConn, type ChatSessionService, type LoadSessionResponse } from '../api.ts';

describe('repo.rs remaining message persistence contracts', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let s: ChatSessionService;
  beforeEach(async () => {
    f = databaseFixture(); host = await createTestHost({ plugins: [plugin], provide: {
      storage: f.storage, vfs: vfsStub, nativeTokenizer: {}, settings: {}, vfsRepo: {}, agentVfsResolver: {},
    } });
    s = host.ctx.chatSession; s.createSession(newSession('sess_persist', 'chat'));
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });
  it('test_insert_or_replace_message_cascades_blocks', () => {
    const message = s.newAssistantMessage('sess_persist'); message.blockIds = ['blk_anki']; s.createMessage(message);
    s.createBlock({ id: 'blk_anki', messageId: message.id, type: 'anki_cards', status: 'pending' });
    expect(s.getBlock('blk_anki')).not.toBeNull(); s.createMessage(message);
    expect(s.getBlock('blk_anki')).not.toBeNull(); expect(s.getMessage(message.id)?.blockIds).toEqual(['blk_anki']);
  });
  it('test_retry_block_upsert_reloads_one_final_logical_block', async () => {
    const message = s.newAssistantMessage('sess_persist'); message.blockIds = ['blk_retry_logical']; s.createMessage(message);
    const block = { id: 'blk_retry_logical', messageId: message.id, type: 'mcp_tool', status: 'error',
      toolName: 'builtin-web_fetch', toolInput: { url: 'https://example.com' }, error: 'connection reset by peer' };
    s.createBlock(block); s.createBlock({ ...block, status: 'success', error: undefined, toolOutput: { ok: true, _auto_retry_attempts: 1 } });
    const loaded = await host.invoke<LoadSessionResponse>('chat_v2_load_session', { sessionId: 'sess_persist' });
    const blocks = loaded.blocks.filter(candidate => candidate.messageId === message.id);
    expect(blocks).toHaveLength(1); expect(blocks[0]?.id).toBe('blk_retry_logical'); expect(blocks[0]?.status).toBe('success');
    expect(blocks[0]?.error).toBeUndefined(); expect(blocks[0]?.toolOutput).toMatchObject({ _auto_retry_attempts: 1 });
  });
  it('test_cascade_delete', () => {
    const user = s.newUserMessage('sess_persist', []); const assistant = s.newAssistantMessage('sess_persist');
    s.createMessage(user); s.createMessage(assistant);
    const thinking = s.newMessageBlock(assistant.id, 'thinking', 0); const content = s.newMessageBlock(assistant.id, 'content', 1);
    s.createBlock(thinking); s.createBlock(content);
    expect(s.getMessage(user.id)).not.toBeNull(); expect(s.getMessage(assistant.id)).not.toBeNull();
    expect(s.getBlock(thinking.id)).not.toBeNull(); expect(s.getBlock(content.id)).not.toBeNull();
    s.deleteSessionV2('sess_persist');
    expect(s.getSession('sess_persist')).toBeNull(); expect(s.getMessage(user.id)).toBeNull(); expect(s.getMessage(assistant.id)).toBeNull();
    expect(s.getBlock(thinking.id)).toBeNull(); expect(s.getBlock(content.id)).toBeNull();
  });
  it('test_pending_context_refs_json_persistence', () => {
    const raw = '[{"resourceId":"res_abc123","hash":"sha256_xyz","typeId":"note"}]';
    saveSessionStateWithConn(f.db, 'sess_persist', { sessionId: 'sess_persist', pendingContextRefsJson: raw, updatedAt: '2026-01-01T00:00:00+00:00' });
    expect(s.loadSessionState('sess_persist')?.pendingContextRefsJson).toBe(raw);
  });
  it('test_pending_context_refs_json_empty_array', () => {
    saveSessionStateWithConn(f.db, 'sess_persist', { sessionId: 'sess_persist', pendingContextRefsJson: '[]', updatedAt: '2026-01-01T00:00:00+00:00' });
    expect(s.loadSessionState('sess_persist')?.pendingContextRefsJson).toBe('[]');
  });
  it('test_pending_context_refs_json_none', () => {
    saveSessionStateWithConn(f.db, 'sess_persist', { sessionId: 'sess_persist', updatedAt: '2026-01-01T00:00:00+00:00' });
    const loaded = s.loadSessionState('sess_persist'); expect(loaded).not.toBeNull(); expect(loaded?.pendingContextRefsJson).toBeUndefined();
  });
  it('test_save_results_basic', () => {
    const user = s.newUserMessage('sess_persist', ['blk_user_1']); s.createMessage(user);
    s.createBlock({ id: 'blk_user_1', messageId: user.id, type: 'content', status: 'success', content: '用户问题内容', startedAt: 1000, endedAt: 1001 });
    const assistant = s.newAssistantMessage('sess_persist'); s.createMessage(assistant);
    for (let i = 0; i < 3; i++) s.createBlock({ ...s.newMessageBlock(assistant.id, i === 0 ? 'thinking' : 'content', i),
      status: 'success', content: `块内容 ${i}`, startedAt: 2000 + i, endedAt: 2001 + i });
    expect(s.getSessionMessages('sess_persist')).toHaveLength(2);
    expect(s.getMessageBlocks(assistant.id)).toHaveLength(3);
    const [blocks] = s.getHistoryBlocksWithReplayWithConn(f.db, [assistant.id]);
    expect(blocks.get(assistant.id)?.map(block => block.blockIndex)).toEqual([0, 1, 2]);
  });
  it('test_load_chat_history_basic', () => {
    for (let i = 0; i < 5; i++) {
      const message = i % 2 === 0 ? s.newUserMessage('sess_persist', [`blk_${i}`]) : s.newAssistantMessage('sess_persist');
      s.createMessage(message); s.createBlock({ id: `blk_${i}`, messageId: message.id, type: 'content', status: 'success', content: `消息 ${i} 的内容`, startedAt: i * 1000, endedAt: i * 1000 + 100 });
    }
    const messages = s.getSessionMessages('sess_persist'); expect(messages).toHaveLength(5);
    for (const message of messages) expect(s.getMessageBlocks(message.id).length).toBeGreaterThan(0);
  });
  it('test_load_chat_history_content_only', async () => {
    await host.install(pipeline);
    const message = s.newAssistantMessage('sess_persist'); s.createMessage(message);
    for (const [i, [type, content]] of [['thinking', '这是思维链内容，不应该被提取'], ['content', '这是主要内容，应该被提取'],
      ['rag', '这是 RAG 结果，不应该被提取'], ['content', '这是第二段内容，也应该被提取']].entries()) {
      s.createBlock({ ...s.newMessageBlock(message.id, type!, i), status: 'success', content });
    }
    const blocks = s.getMessageBlocks(message.id); expect(blocks).toHaveLength(4);
    const text = host.ctx.chatPipeline.contentTextFromBlocks(blocks);
    expect(text).toContain('这是主要内容'); expect(text).toContain('这是第二段内容'); expect(text).not.toContain('思维链'); expect(text).not.toContain('RAG');
  });
});
