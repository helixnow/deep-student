import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import pipeline from '../../chat-pipeline/index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { newSession } from '../src/types.ts';
import type { ChatSessionService, MessageBlock } from '../api.ts';

describe('repo.rs replay sidecar via chatSession', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let service: ChatSessionService;
  const messageId = 'msg_replay';
  beforeEach(async () => {
    f = databaseFixture();
    host = await createTestHost({ plugins: [plugin], provide: {
      storage: f.storage, vfs: vfsStub, nativeTokenizer: {}, settings: {}, vfsRepo: {}, agentVfsResolver: {},
    } });
    service = host.ctx.chatSession;
    service.createSession(newSession('sess_replay', 'chat'));
    service.createMessage({ id: messageId, sessionId: 'sess_replay', role: 'assistant', timestamp: 1000, blockIds: [] });
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });
  function block(id: string, content?: string, tool = false): MessageBlock {
    const result: MessageBlock = { id, messageId, type: tool ? 'mcp_tool' : 'content', status: 'pending',
      ...(content === undefined ? {} : { content }), ...(tool ? { toolName: 'builtin-note_read', toolInput: { id: 'n1' } } : {}) };
    service.createBlock(result); return result;
  }
  function oldSchema() { for (const column of ['llm_content', 'tool_call_id', 'round_text']) f.db.exec(`ALTER TABLE chat_v2_blocks DROP COLUMN ${column}`); }
  function replay() { return service.getBlockReplayMapWithConn(f.db, messageId); }

  it('test_block_replay_sidecar_roundtrip_and_copy', () => {
    block('blk_user', '原始用户输入'); block('blk_tool', undefined, true);
    service.updateBlockReplayWithConn(f.db, 'blk_user', { llmContent: '<user_query>\n原始用户输入\n</user_query>', toolCallId: null, roundText: null });
    service.updateBlockReplayWithConn(f.db, 'blk_tool', { llmContent: null, toolCallId: 'call_live_abc', roundText: '我先读一下笔记。' });
    expect(replay().get('blk_user')?.llmContent).toBe('<user_query>\n原始用户输入\n</user_query>');
    expect(replay().get('blk_tool')?.toolCallId).toBe('call_live_abc');
    expect(replay().get('blk_tool')?.roundText).toBe('我先读一下笔记。');
    service.createBlock({ ...service.getBlock('blk_tool')!, id: 'blk_copy' });
    expect(replay().has('blk_copy')).toBe(false);
    service.copyBlockReplayWithConn(f.db, 'blk_tool', 'blk_copy');
    expect(replay().get('blk_copy')).toEqual(replay().get('blk_tool'));
  });
  it('test_update_block_invalidates_llm_content_on_content_change', () => {
    const user = block('blk_user', '编辑前的问题'); const tool = block('blk_tool', 'tool text', true);
    service.updateBlockReplayWithConn(f.db, user.id, { llmContent: '<user_query>\n编辑前的问题\n</user_query>', toolCallId: null, roundText: null });
    service.updateBlockReplayWithConn(f.db, tool.id, { llmContent: null, toolCallId: 'call_live_inv', roundText: '我先读一下。' });
    service.updateBlock({ ...user, status: 'success' });
    expect(replay().get(user.id)?.llmContent).toBe('<user_query>\n编辑前的问题\n</user_query>');
    service.updateBlock({ ...user, status: 'success', content: '编辑后的新问题' });
    expect(replay().has(user.id)).toBe(false);
    service.updateBlock({ ...tool, content: 'tool text changed' });
    expect(replay().get(tool.id)).toEqual({ llmContent: null, toolCallId: 'call_live_inv', roundText: '我先读一下。' });
    service.updateBlockReplayWithConn(f.db, user.id, { llmContent: '重新写入的包装', toolCallId: null, roundText: null });
    service.clearBlockLlmContentWithConn(f.db, user.id);
    expect(replay().has(user.id)).toBe(false);
  });
  it('test_update_block_fallback_without_replay_columns', () => {
    oldSchema(); const b = block('blk_old', '原文');
    service.updateBlock({ ...b, content: '改后' });
    expect(service.getBlock(b.id)?.content).toBe('改后');
    expect(() => service.clearBlockLlmContentWithConn(f.db, b.id)).not.toThrow();
    expect(() => service.updateBlock({ ...b, id: 'blk_missing' })).toThrow('Block not found: blk_missing');
  });
  it('test_block_replay_sidecar_fallback_without_columns', () => {
    oldSchema(); block('blk_old');
    const logs: string[] = [];
    host.ctx.logger.exporter({ levels: { default: 4 }, export(message) { if (message.type === 'debug') logs.push(String(message.args[0])); } });
    expect(() => service.updateBlockReplayWithConn(f.db, 'blk_old', { llmContent: 'wrapped', toolCallId: 'call_x', roundText: null })).not.toThrow();
    expect(replay().size).toBe(0);
    expect(() => service.copyBlockReplayWithConn(f.db, 'blk_old', 'blk_old')).not.toThrow();
    expect(logs).toContain('[ChatV2::Repo] Replay columns missing (V20260806 not applied), skipping sidecar write for block blk_old');
  });
  it('empty updates preserve existing sidecars and an outer transaction rolls back targeted writes', () => {
    block('blk_tx');
    service.updateBlockReplayWithConn(f.db, 'blk_tx', { llmContent: 'before', toolCallId: null, roundText: null });
    service.updateBlockReplayWithConn(f.db, 'blk_tx', { llmContent: null, toolCallId: null, roundText: null });
    expect(replay().get('blk_tx')?.llmContent).toBe('before');
    expect(() => f.db.transaction(tx => {
      service.updateBlockReplayWithConn(tx, 'blk_tx', { llmContent: 'after', toolCallId: 'new', roundText: null });
      throw new Error('rollback');
    })).toThrow('rollback');
    expect(replay().get('blk_tx')).toEqual({ llmContent: 'before', toolCallId: null, roundText: null });
    f.db.exec("CREATE TRIGGER fail_sidecar BEFORE UPDATE ON chat_v2_blocks BEGIN SELECT RAISE(FAIL, 'sidecar blocked'); END");
    expect(() => service.updateBlockReplayWithConn(f.db, 'blk_tx', { llmContent: 'after', toolCallId: null, roundText: null })).toThrow('sidecar blocked');
  });
  it('L03 early and incremental persistence use the real L04 writer and transaction', async () => {
    await host.install(pipeline);
    block('blk_user', 'bare'); block('blk_tool', undefined, true);
    const execution = host.ctx.chatPipeline.createPipelineContext({ sessionId: 'sess_replay', content: 'bare', userMessageId: messageId });
    execution.compiledCurrentUserMessage = { role: 'user', content: '<user_query>wrapped</user_query>' };
    host.ctx.chatPipeline.persistUserLlmContentEarly(execution, service);
    expect(replay().get('blk_user')?.llmContent).toBe('<user_query>wrapped</user_query>');
    execution.toolResults = [{ toolName: 'builtin-note_read', input: {}, output: null, success: true,
      blockId: 'blk_tool', toolCallId: 'call_live' }];
    execution.roundTextByToolCallId.set('call_live', 'tool preamble');
    f.db.transaction(tx => host.ctx.chatPipeline.persistReplaySidecar(tx, execution, 'blk_user', null, service));
    expect(replay().get('blk_tool')).toEqual({ llmContent: null, toolCallId: 'call_live', roundText: 'tool preamble' });
  });
});
