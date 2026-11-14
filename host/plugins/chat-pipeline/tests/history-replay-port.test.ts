import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ToolResultInfo } from '../../chat/api.ts';
import type { BlockReplayData, PipelineHistoryStore, PersistenceBlock } from '../api.ts';
import { createPipelineHost } from './chat-host.ts';

let host: Awaited<ReturnType<typeof createPipelineHost>>;
const messages = new Map<string, ChatMessage>();
const blocks = new Map<string, PersistenceBlock[]>();
const replay = new Map<string, BlockReplayData>();
const owner: PipelineHistoryStore = {
  getSessionMessageIdsWithConn: vi.fn<PipelineHistoryStore['getSessionMessageIdsWithConn']>((_conn, id) => [...messages.values()].filter(m => m.sessionId === id).map(m => m.id)),
  getMessagesByIdsWithConn: vi.fn<PipelineHistoryStore['getMessagesByIdsWithConn']>((_conn, _session, ids) => ids.map(id => structuredClone(messages.get(id)!))),
  getHistoryBlocksWithReplayWithConn: vi.fn<PipelineHistoryStore['getHistoryBlocksWithReplayWithConn']>((_conn, ids) => [new Map(ids.map(id => [id, structuredClone(blocks.get(id) ?? [])])), structuredClone(replay)]),
  getMessageBlocksWithConn: vi.fn((_conn, id) => structuredClone(blocks.get(id) ?? [])),
  getActiveCompactionWithConn: vi.fn<PipelineHistoryStore['getActiveCompactionWithConn']>(() => null),
  getCompactionSummaryMessageIdsWithConn: vi.fn<PipelineHistoryStore['getCompactionSummaryMessageIdsWithConn']>(() => []),
  markAvailableSkillsSnapshotStaleWithConn: vi.fn<PipelineHistoryStore['markAvailableSkillsSnapshotStaleWithConn']>(() => null),
};
beforeAll(async () => { host = await createPipelineHost({ provide: { pendingHistoryStore: owner } }); }, 60_000);
afterAll(async () => { await host?.dispose(); });
let counter = 0;
function turn() {
  const session = `history_port_${++counter}`;
  const ctx = host.ctx.chatPipeline.createPipelineContext({ sessionId: session, content: 'next',
    userMessageId: `current_user_${counter}`, assistantMessageId: `current_assistant_${counter}` });
  const loader = host.ctx.chatPipeline.createHistoryLoader(host.ctx.get('pendingHistoryStore') as PipelineHistoryStore);
  return { session, ctx, loader };
}
function content(id: string, text: string, index = 0): PersistenceBlock {
  return { id: `blk_${id}_${index}`, messageId: id, type: 'content', status: 'success', content: text, blockIndex: index };
}
function put(session: string, id: string, role: 'user' | 'assistant', values: PersistenceBlock[], extra: Partial<ChatMessage> = {}) {
  const message: ChatMessage = { id, sessionId: session, role, blockIds: values.map(b => b.id), timestamp: messages.size, ...extra };
  messages.set(id, message); blocks.set(id, values); return message;
}
const data = (value: Partial<BlockReplayData>): BlockReplayData => ({ llmContent: null, toolCallId: null, roundText: null, ...value });

describe('history.rs replay_consistency_tests through L03 production loader (external L04 port)', () => {
  it('history_keeps_more_than_four_hundred_short_messages', async () => {
    const { session, ctx, loader } = turn();
    for (let i = 0; i < 450; i++) put(session, `${session}_${i}`, 'user', [content(`${session}_${i}`, `turn ${i}`)]);
    put(session, ctx.userMessageId, 'user', [content(ctx.userMessageId, 'current user')]);
    put(session, ctx.assistantMessageId, 'assistant', [content(ctx.assistantMessageId, 'current assistant')]);
    ctx.options.contextLimit = 1_000_448;
    await loader.loadChatHistory(ctx);
    expect(ctx.chatHistory).toHaveLength(450);
    expect(ctx.chatHistory[0]!.content).toContain('turn 0');
    expect(ctx.chatHistory[449]!.content).toContain('turn 449');
    ctx.options.contextLimit = 1;
    await loader.loadChatHistory(ctx);
    expect(ctx.chatHistory).toHaveLength(450);
    expect(ctx.chatHistory.some(m => m.content.startsWith('current'))).toBe(false);
  });
  it('unsummarized_history_keeps_old_tool_outputs_verbatim', async () => {
    const { session, ctx, loader } = turn();
    const payload = 'important historical tool output '.repeat(100);
    for (let i = 0; i < 6; i++) {
      put(session, `${session}_u${i}`, 'user', [content(`${session}_u${i}`, 'read file')]);
      put(session, `${session}_a${i}`, 'assistant', [{ ...content(`${session}_a${i}`, ''),
        type: 'mcp_tool', toolName: 'builtin-workspace_read_file', toolInput: { path: 'file.txt' }, toolOutput: { content: payload } }]);
    }
    await loader.loadChatHistory(ctx);
    const results = ctx.chatHistory.filter(m => m.role === 'tool');
    expect(results).toHaveLength(6);
    expect(results.every(m => m.content.includes(payload))).toBe(true);
    expect(host.ctx.chatPipeline.validateToolChain(ctx.chatHistory)).toBe(true);
  });
  it('replay_uses_sidecar_columns_and_matches_live_bytes', async () => {
    const { session, ctx, loader } = turn();
    const user = content(`${session}_u`, '帮我读一下笔记');
    put(session, user.messageId, 'user', [user]);
    const wrapped = '<user_query>\n帮我读一下笔记\n</user_query>\n\n<injected_context>\n<runtime_facts>\n当前日期: 2026-08-23\n</runtime_facts>\n</injected_context>';
    replay.set(user.id, data({ llmContent: wrapped }));
    const reasoning = { type: 'reasoning', id: 'rs_live_1' };
    const result: ToolResultInfo = { toolCallId: 'call_live_123', blockId: 'blk_hist_tool', toolName: 'builtin-note_read',
      input: { id: 'n1' }, output: { ok: true, text: '笔记内容' }, success: true, durationMs: 5,
      reasoningContent: '先读笔记再回答', thoughtSignature: 'sig-live-1' };
    const aid = `${session}_a`;
    put(session, aid, 'assistant', [
      { ...content(aid, '先读笔记再回答'), type: 'thinking' },
      { ...content(aid, '', 1), id: result.blockId!, type: 'mcp_tool', toolName: result.toolName,
        toolInput: result.input, toolOutput: result.output }, content(aid, '笔记里说……', 2),
    ], { _meta: { toolResults: [result], responseReasoningItems: { call_live_123: reasoning } } });
    replay.set(result.blockId!, data({ toolCallId: 'call_live_123', roundText: '我先读一下笔记。' }));
    await loader.loadChatHistory(ctx);
    expect(ctx.chatHistory).toHaveLength(4);
    expect(ctx.chatHistory[0]).toMatchObject({ role: 'user', content: wrapped });
    const live = host.ctx.chatPipeline.createPipelineContext({ sessionId: session, content: 'next' });
    live.toolResults = [result]; live.roundTextByToolCallId.set('call_live_123', '我先读一下笔记。');
    live.responseReasoningByToolCallId.set('call_live_123', reasoning);
    const pair = live.allToolResultsToMessages();
    expect(pair).toHaveLength(2);
    for (const key of ['role', 'content', 'thinking_content', 'thought_signature', 'metadata', 'tool_call'] as const) {
      expect(ctx.chatHistory[1]![key]).toEqual(pair[0]![key]);
    }
    expect(ctx.chatHistory[1]!.tool_call!.id).toBe('call_live_123');
    expect(ctx.chatHistory[2]!.role).toBe(pair[1]!.role);
    expect(ctx.chatHistory[2]!.content).toBe(pair[1]!.content);
    expect(ctx.chatHistory[2]!.tool_result!.call_id).toBe(pair[1]!.tool_result!.call_id);
    expect(ctx.chatHistory[3]).toMatchObject({ role: 'assistant', content: '笔记里说……' });
  });
  it('replay_attaches_final_reasoning_item_to_plain_assistant_message', async () => {
    const { session, ctx, loader } = turn();
    put(session, `${session}_u`, 'user', [content(`${session}_u`, '随便聊聊')]);
    const item = { type: 'reasoning', id: 'rs_final_1', encrypted_content: 'enc-final-state' };
    put(session, `${session}_a`, 'assistant', [content(`${session}_a`, '这是纯文本回答。')],
      { _meta: { responseReasoningItems: { __final_assistant__: item } } });
    await loader.loadChatHistory(ctx);
    expect(ctx.chatHistory).toHaveLength(2);
    expect(ctx.chatHistory[1]).toMatchObject({ role: 'assistant', content: '这是纯文本回答。',
      metadata: { openai_responses_reasoning_item: item } });
    expect(ctx.chatHistory[1]!.tool_call).toBeNull();
  });
  it('replay_falls_back_to_legacy_rebuild_without_sidecar_data', async () => {
    const { session, ctx, loader } = turn();
    put(session, `${session}_u`, 'user', [content(`${session}_u`, '原始问题')]);
    const aid = `${session}_a`;
    put(session, aid, 'assistant', [{ ...content(aid, ''), id: 'blk_fb_tool', type: 'mcp_tool',
      toolName: 'builtin-note_read', toolInput: { id: 'n2' }, toolOutput: { ok: true } }, content(aid, '回答', 1)]);
    await loader.loadChatHistory(ctx);
    expect(ctx.chatHistory).toHaveLength(4);
    expect(ctx.chatHistory[0]!.content).toBe('原始问题');
    expect(ctx.chatHistory[1]!.tool_call!.id).toBe('tc_fb_tool');
    expect(ctx.chatHistory[1]!.content).toBe('');
    expect(ctx.chatHistory[2]!.tool_result!.call_id).toBe('tc_fb_tool');
  });
  it('replay_filters_blocks_to_active_variant', async () => {
    const { session, ctx, loader } = turn();
    put(session, `${session}_u`, 'user', [content(`${session}_u`, '多模型对比')]);
    const aid = `${session}_a`, a = content(aid, 'A 变体回答'), b = content(aid, 'B 变体回答', 1);
    put(session, aid, 'assistant', [a, b], { activeVariantId: 'var_2', variants: [
      { id: 'var_1', modelId: 'model-var_1', status: 'success', blockIds: [a.id], createdAt: 0 },
      { id: 'var_2', modelId: 'model-var_2', status: 'success', blockIds: [b.id], createdAt: 0 },
    ] });
    await loader.loadChatHistory(ctx);
    expect(ctx.chatHistory).toHaveLength(2);
    expect(ctx.chatHistory[1]!.content).toBe('B 变体回答');
  });
  it('replay_attaches_web_search_items_from_meta', async () => {
    const { session, ctx, loader } = turn();
    put(session, `${session}_u`, 'user', [content(`${session}_u`, '今天有什么新闻')]);
    const item = { type: 'web_search_call', id: 'ws_live_1', status: 'completed',
      search_results: [{ url: 'https://a.example.com', title: 'A' }] };
    put(session, `${session}_a`, 'assistant', [content(`${session}_a`, '根据搜索结果……')],
      { _meta: { openai_responses_web_search_items: [item] } });
    await loader.loadChatHistory(ctx);
    expect(ctx.chatHistory).toHaveLength(2);
    expect(ctx.chatHistory[1]).toMatchObject({ role: 'assistant', metadata: { openai_responses_web_search_items: [item] } });
    expect(ctx.chatHistory[0]!.metadata ?? {}).not.toHaveProperty('openai_responses_web_search_items');
  });
  it('replay_restores_workspace_injection_before_turn_user', async () => {
    const { session, ctx, loader } = turn();
    put(session, `${session}_u`, 'user', [content(`${session}_u`, '开始任务')]);
    const aid = `${session}_a`;
    put(session, aid, 'assistant', [{ ...content(aid, '[来自工作区] 主代理插话：优先处理 A'),
      type: 'workspace_injection', toolOutput: { workspace_id: 'ws_1', message_count: 1 } }, content(aid, '收到，先处理 A', 1)]);
    await loader.loadChatHistory(ctx);
    expect(ctx.chatHistory).toHaveLength(3);
    expect(ctx.chatHistory[0]).toMatchObject({ role: 'user', content: '[来自工作区] 主代理插话：优先处理 A',
      metadata: { workspace_injection: true, workspace_id: 'ws_1' } });
    expect(ctx.chatHistory[1]).toMatchObject({ role: 'user', content: '开始任务' });
    expect(ctx.chatHistory[2]).toMatchObject({ role: 'assistant', content: '收到，先处理 A' });
  });

  it('lightweight_compaction_view_preserves_boundaries_and_fallbacks: actual loader filters artifacts before tail slicing', async () => {
    const { session, ctx, loader } = turn();
    const head = `${session}_head`, tail = `${session}_tail`, summary = `${session}_summary`;
    put(session, head, 'user', [content(head, 'old')]);
    put(session, tail, 'user', [content(tail, 'kept')]);
    put(session, summary, 'assistant', [{ ...content(summary, 'summary text'), type: 'compaction_summary' }]);
    const record = { id: 'cmp_test', summaryMessageId: summary, tailStartMessageId: tail, rangeEndMessageId: null };
    vi.mocked(owner.getCompactionSummaryMessageIdsWithConn).mockReturnValue([summary]);
    vi.mocked(owner.getActiveCompactionWithConn).mockReturnValue(record);
    try {
      await loader.loadChatHistory(ctx);
      expect(ctx.chatHistory).toHaveLength(2);
      expect(ctx.chatHistory[0]!.content).toContain('<compacted_context>');
      expect(ctx.chatHistory[0]!.content).toContain('summary text');
      expect(ctx.chatHistory[1]!.content).toBe('kept');
      vi.mocked(owner.getActiveCompactionWithConn).mockReturnValue({ ...record, tailStartMessageId: summary, rangeEndMessageId: tail });
      await loader.loadChatHistory(ctx); expect(ctx.chatHistory).toHaveLength(1);
      blocks.get(summary)![0]!.content = '  \n';
      await loader.loadChatHistory(ctx); expect(ctx.chatHistory.map(m => m.content)).toEqual(['old', 'kept']);
      blocks.get(summary)![0]!.content = 'summary text';
      vi.mocked(owner.getActiveCompactionWithConn).mockReturnValue({ ...record, tailStartMessageId: 'missing' });
      await loader.loadChatHistory(ctx); expect(ctx.chatHistory.map(m => m.content)).toEqual(['old', 'kept']);
      vi.mocked(owner.getActiveCompactionWithConn).mockImplementationOnce(() => { throw new Error('read compaction failed'); });
      await loader.loadChatHistory(ctx); expect(ctx.chatHistory.map(m => m.content)).toEqual(['old', 'kept']);
    } finally {
      vi.mocked(owner.getCompactionSummaryMessageIdsWithConn).mockReturnValue([]);
      vi.mocked(owner.getActiveCompactionWithConn).mockReturnValue(null);
    }
  });

  it('replay keeps attachment-only and reasoning-only messages, current canonical artifacts, and digest signals', async () => {
    const { session, ctx, loader } = turn();
    const uid = `${session}_u`, aid = `${session}_a`;
    put(session, uid, 'user', [], { attachments: [
      { id: 'image', name: 'a.png', type: 'image', mimeType: 'image/png', size: 2, status: 'ready', previewUrl: 'data:image/png;base64,eA==,ignored' },
      { id: 'doc', name: 'a.txt', type: 'document', mimeType: 'text/plain', size: 2, status: 'ready', previewUrl: 'data:text/plain;base64,5paH5pys' },
    ] });
    put(session, aid, 'assistant', [{ ...content(aid, 'reasoning only'), type: 'thinking' }], {
      _meta: { skillInjectionAnchors: { turnSkillIds: ['missing', 'edited', 'ok'], beforeTurnUser: true,
        skillContentDigests: { edited: host.ctx.chatPipeline.skillBodyDigest('edited', 'old') } } },
    });
    ctx.options.skillContents = { edited: 'new', ok: 'stable' };
    const warn = vi.spyOn(host.ctx.logger, 'warn');
    vi.mocked(owner.markAvailableSkillsSnapshotStaleWithConn).mockClear();
    await loader.loadChatHistory(ctx);
    expect(ctx.chatHistory.some(m => m.content.includes('<skill_instructions id="ok">'))).toBe(true);
    const user = ctx.chatHistory.find(m => m.content === '[用户发送了附件]')!;
    expect(user.image_base64).toEqual(['eA==']);
    expect(user.doc_attachments?.[0]?.text_content).toBe('文本');
    expect(ctx.chatHistory.at(-1)).toMatchObject({ role: 'assistant', content: '', thinking_content: 'reasoning only' });
    expect(owner.markAvailableSkillsSnapshotStaleWithConn).toHaveBeenCalledExactlyOnceWith(expect.anything(), session);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("anchored skill 'missing' has no content"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("anchored skill 'edited' content digest mismatch"));
    warn.mockRestore();
  });
});
