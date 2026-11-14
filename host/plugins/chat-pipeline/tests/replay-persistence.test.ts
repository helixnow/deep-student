import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReplaySidecarWriter } from '../api.ts';
import { makeEmptyMessage } from '../src/microcompact.ts';
import { createPipelineHost } from './chat-host.ts';

const writer: ReplaySidecarWriter = { updateBlockReplayWithConn: vi.fn() };
let host: Awaited<ReturnType<typeof createPipelineHost>>;
beforeAll(async () => {
  host = await createPipelineHost({ provide: { replayWriter: writer } });
  host.ctx.chatSession.createSession({ id: 'sess_replay', mode: 'chat', titleLocked: false,
    persistStatus: 'active', createdAt: '2026-08-26T00:00:00Z', updatedAt: '2026-08-26T00:00:00Z' });
}, 60_000);
afterAll(async () => { await host?.dispose(); });

function execution(content: string | null, userMessageId = 'msg_replay') {
  const ctx = host.ctx.chatPipeline.createPipelineContext({ sessionId: 'sess_replay', content: 'bare', userMessageId });
  ctx.compiledCurrentUserMessage = content === null ? null : makeEmptyMessage('user', content);
  return ctx;
}

describe('persistence.rs:423–537 L03 orchestration with requested L04 writer', () => {
  it('live_user_llm_content excludes uncompiled/empty content and preserves whitespace and UTF-8', () => {
    for (const value of [null, '']) expect(execution(value).liveUserLlmContent()).toBeNull();
    for (const value of ['  \n', '<user_query>📝 café 週報\u200brésumé</user_query>']) {
      expect(execution(value).liveUserLlmContent()).toBe(value);
    }
  });

  it('persist_user_llm_content_early chooses the first existing content block and never a new retry id', () => {
    const pipeline = host.ctx.chatPipeline;
    const store = host.ctx.get('replayWriter') as ReplaySidecarWriter;
    const update = vi.mocked(writer.updateBlockReplayWithConn);
    update.mockClear();
    const sessions = host.ctx.chatSession;
    sessions.createMessage({ id: 'msg_replay', sessionId: 'sess_replay', role: 'user',
      blockIds: ['blk_second', 'blk_think', 'blk_first'], timestamp: 1 });
    for (const block of [
      { id: 'blk_second', type: 'content', blockIndex: 2 },
      { id: 'blk_think', type: 'thinking', blockIndex: 0 },
      { id: 'blk_first', type: 'content', blockIndex: 1 },
    ]) sessions.createBlock({ ...block, messageId: 'msg_replay', status: 'success', content: 'bare' });
    pipeline.persistUserLlmContentEarly(execution(null), store);
    pipeline.persistUserLlmContentEarly(execution(''), store);
    pipeline.persistUserLlmContentEarly(execution('wrapped', 'msg_retry_new'), store);
    expect(update).not.toHaveBeenCalled();
    pipeline.persistUserLlmContentEarly(execution('  \n'), store);
    expect(update).toHaveBeenCalledExactlyOnceWith(sessions.database.getConnSafe(), 'blk_first', {
      llmContent: '  \n', toolCallId: null, roundText: null,
    });
  });

  it('persist_user_llm_content_early preserves lookup-skip versus connection/write error propagation', () => {
    const store = host.ctx.get('replayWriter') as ReplaySidecarWriter;
    const update = vi.mocked(writer.updateBlockReplayWithConn);
    update.mockClear();
    const sessions = host.ctx.chatSession;
    const lookup = vi.spyOn(sessions, 'getMessageBlocks').mockImplementationOnce(() => { throw new Error('read failed'); });
    expect(() => host.ctx.chatPipeline.persistUserLlmContentEarly(execution('wrapped'), store)).not.toThrow();
    expect(update).not.toHaveBeenCalled();
    lookup.mockRestore();
    const getConn = vi.spyOn(sessions.database, 'getConnSafe').mockImplementationOnce(() => { throw new Error('connection failed'); });
    expect(() => host.ctx.chatPipeline.persistUserLlmContentEarly(execution('wrapped'), store)).toThrow('connection failed');
    getConn.mockRestore();
    update.mockImplementationOnce(() => { throw new Error('write failed'); });
    expect(() => host.ctx.chatPipeline.persistUserLlmContentEarly(execution('wrapped'), store)).toThrow('write failed');
  });

  it('persist_replay_sidecar writes user then eligible dirty tool results using the caller connection', () => {
    const store = host.ctx.get('replayWriter') as ReplaySidecarWriter;
    const update = vi.mocked(writer.updateBlockReplayWithConn);
    update.mockClear();
    const ctx = execution('wrapped');
    ctx.toolResults = [
      { toolName: 't', input: {}, output: null, success: true },
      { blockId: 'blk_empty', toolCallId: '', toolName: 't', input: {}, output: null, success: true },
      { blockId: 'blk_clean', toolCallId: 'c0', toolName: 't', input: {}, output: null, success: true },
      { blockId: 'blk_dirty', toolCallId: 'c1', toolName: 't', input: {}, output: null, success: false },
      { blockId: 'blk_no_text', toolCallId: 'c2', toolName: 't', input: {}, output: null, success: true },
    ];
    ctx.roundTextByToolCallId.set('c1', '');
    const dirty = new Set(['blk_empty', 'blk_dirty', 'blk_no_text']);
    const conn = host.ctx.chatSession.database.getConnSafe();
    host.ctx.chatPipeline.persistReplaySidecar(conn, ctx, 'blk_first', dirty, store);
    expect(update.mock.calls).toEqual([
      [conn, 'blk_first', { llmContent: 'wrapped', toolCallId: null, roundText: null }],
      [conn, 'blk_dirty', { llmContent: null, toolCallId: 'c1', roundText: '' }],
      [conn, 'blk_no_text', { llmContent: null, toolCallId: 'c2', roundText: null }],
    ]);
    expect([...dirty]).toEqual(['blk_empty', 'blk_dirty', 'blk_no_text']);
    update.mockClear();
    update.mockImplementationOnce(() => { throw new Error('transaction write failed'); });
    expect(() => host.ctx.chatPipeline.persistReplaySidecar(conn, ctx, null, null, store)).toThrow('transaction write failed');
    expect(update.mock.calls.map(call => call[1])).toEqual(['blk_clean']);
  });
});
