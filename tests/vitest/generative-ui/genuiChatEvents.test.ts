/**
 * WP-F：generative_ui 事件接线（preparing 占位 → start 接管 → awaitAnswer pending → end 写交互）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/debug-panel/plugins/ToolCallLifecycleDebugPlugin', () => ({
  emitToolCallDebug: vi.fn(),
  trackPreparing: vi.fn(),
  trackStart: vi.fn(),
  trackEnd: vi.fn(),
}));

import { eventRegistry } from '@/features/chat/registry/eventRegistry';
import '@/features/chat/plugins/events/toolCall';
import '@/features/chat/plugins/events/generativeUI';
import type { ChatStore } from '@/features/chat/core/types';

const SESSION_ID = 'sess_genui';

function createStore(overrides: Record<string, unknown> = {}) {
  const blocks = new Map<string, any>();
  const messageMap = new Map<string, any>([
    ['msg-1', { id: 'msg-1', role: 'assistant', blockIds: [] }],
  ]);
  const activeBlockIds = new Set<string>();
  let next = 0;
  const createBlockWithId = (messageId: string, type: string, blockId: string) => {
    blocks.set(blockId, { id: blockId, messageId, type, content: '', status: 'pending' });
    const message = messageMap.get(messageId);
    if (message && !message.blockIds.includes(blockId)) message.blockIds.push(blockId);
    activeBlockIds.add(blockId);
    return blockId;
  };
  const base: Record<string, unknown> = {
    sessionId: SESSION_ID,
    sessionStatus: 'streaming',
    currentStreamingMessageId: 'msg-1',
    messageMap,
    messageOrder: ['msg-1'],
    blocks,
    activeBlockIds,
    queuedMessages: [],
    activeSkillIds: [],
    createBlockWithId: vi.fn(createBlockWithId),
    createBlock: vi.fn((messageId: string, type: string) =>
      createBlockWithId(messageId, type, `blk-${++next}`)),
    updateBlock: vi.fn((blockId: string, patch: Record<string, unknown>) => {
      const block = blocks.get(blockId);
      if (block) blocks.set(blockId, { ...block, ...patch });
    }),
    updateBlockStatus: vi.fn((blockId: string, status: string) => {
      const block = blocks.get(blockId);
      if (block) blocks.set(blockId, { ...block, status });
    }),
    updateBlockContent: vi.fn((blockId: string, chunk: string) => {
      const block = blocks.get(blockId);
      if (block) blocks.set(blockId, { ...block, content: (block.content ?? '') + chunk, status: 'running' });
    }),
    replaceBlockId: vi.fn((oldId: string, newId: string) => {
      const block = blocks.get(oldId);
      if (!block) return;
      blocks.delete(oldId);
      blocks.set(newId, { ...block, id: newId });
      const message = messageMap.get(block.messageId);
      if (message) message.blockIds = message.blockIds.map((id: string) => (id === oldId ? newId : id));
      if (activeBlockIds.delete(oldId)) activeBlockIds.add(newId);
    }),
    setBlockError: vi.fn((blockId: string, error: string) => {
      const block = blocks.get(blockId);
      if (block) blocks.set(blockId, { ...block, status: 'error', error });
    }),
    setPreparingToolCall: vi.fn(),
    clearPreparingToolCall: vi.fn(),
    ...overrides,
  };
  return new Proxy(base, {
    get(target, prop: string) {
      if (!(prop in target)) target[prop] = vi.fn();
      return target[prop];
    },
  }) as unknown as ChatStore & Record<string, any>;
}

const INTENT = {
  version: '1',
  blocks: [
    {
      type: 'choice',
      id: 'q1',
      props: {
        question: '选哪个？',
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
      },
    },
  ],
};

function prepare(store: ChatStore, toolName = 'builtin-render_generative_ui') {
  const handler = eventRegistry.get('tool_call_preparing')!;
  return handler.onStart!(store, 'msg-1', { toolCallId: 'call-1', toolName }, 'prep-1');
}

describe('WP-F generative_ui chat events', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ status: 'accepted' });
  });

  it('preparing for render_generative_ui creates a generative_ui preparing block', () => {
    const store = createStore();
    const id = prepare(store);
    const block = store.blocks.get(id)!;
    expect(block.type).toBe('generative_ui');
    expect(block.isPreparing).toBe(true);
    expect(block.toolCallId).toBe('call-1');

  });

  it('non-genui preparing keeps mcp_tool', () => {
    const store = createStore();
    const handler = eventRegistry.get('tool_call_preparing')!;
    const id = handler.onStart!(store, 'msg-1', { toolCallId: 'c', toolName: 'builtin-web_search' }, 'p');
    expect(store.blocks.get(id)!.type).toBe('mcp_tool');
  });

  it('onStart with toolCallId adopts the preparing block via replaceBlockId and clears args content', () => {
    const store = createStore();
    prepare(store);
    store.updateBlockContent('prep-1', '{"intent":{"version":"1","blocks":[');

    const handler = eventRegistry.get('generative_ui')!;
    const id = handler.onStart!(store, 'msg-1', { toolCallId: 'call-1' }, 'blk-exec');

    expect(id).toBe('blk-exec');
    expect(store.replaceBlockId).toHaveBeenCalledWith('prep-1', 'blk-exec');
    expect(store.createBlockWithId).toHaveBeenCalledTimes(1); // 只有 preparing 那一次
    expect(store.blocks.has('prep-1')).toBe(false);
    const block = store.blocks.get('blk-exec')!;
    expect(block).toMatchObject({
      type: 'generative_ui',
      isPreparing: false,
      content: '',
      toolCallId: 'call-1',
      status: 'running',
    });
    expect(store.messageMap.get('msg-1').blockIds).toEqual(['blk-exec']);
    expect(store.clearPreparingToolCall).toHaveBeenCalledWith('msg-1');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('onStart without preparing block falls back to createBlockWithId', () => {
    const store = createStore();
    const handler = eventRegistry.get('generative_ui')!;
    const id = handler.onStart!(store, 'msg-1', { toolCallId: 'call-x' }, 'blk-new');
    expect(id).toBe('blk-new');
    expect(store.blocks.get('blk-new')).toMatchObject({ type: 'generative_ui', toolCallId: 'call-x' });
  });

  it('awaitAnswer start writes a pending interaction and does not dismiss when queue is empty', () => {
    const store = createStore();
    prepare(store);
    const handler = eventRegistry.get('generative_ui')!;
    handler.onStart!(store, 'msg-1', { toolCallId: 'call-1', awaitAnswer: true }, 'blk-exec');
    expect(store.blocks.get('blk-exec')!.toolOutput).toEqual({
      awaitAnswer: true,
      interaction: { mode: 'await', toolCallId: 'call-1', state: 'pending' },
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('awaitAnswer start with queued user messages dismisses immediately (user_message)', () => {
    const store = createStore({ queuedMessages: [{ id: 'q1', content: 'hi' }] });
    const handler = eventRegistry.get('generative_ui')!;
    handler.onStart!(store, 'msg-1', { toolCallId: 'call-1', awaitAnswer: true }, 'blk-exec');
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('chat_v2_genui_dismiss_answer', {
      sessionId: SESSION_ID,
      toolCallId: 'call-1',
      reason: 'user_message',
    });
  });

  it('onEnd writes intent + interaction + answer into toolOutput', () => {
    const store = createStore();
    const handler = eventRegistry.get('generative_ui')!;
    handler.onStart!(store, 'msg-1', { toolCallId: 'call-1', awaitAnswer: true }, 'blk-exec');
    handler.onChunk!(store, 'blk-exec', JSON.stringify(INTENT));
    handler.onEnd!(store, 'blk-exec', {
      intent: INTENT,
      isStreaming: false,
      interaction: { mode: 'await', toolCallId: 'call-1', state: 'answered', answeredAt: 1 },
      answer: {
        summary: '选了 B',
        data: { q1: { selected: ['b'] } },
        resolved: [{ blockId: 'q1', selected: [{ id: 'b', label: 'B' }] }],
        trust: 'untrusted_user_input',
      },
    });
    const block = store.blocks.get('blk-exec')!;
    expect(block.status).toBe('success');
    expect(block.toolOutput.intent).toMatchObject({ version: '1' });
    expect(block.toolOutput.isStreaming).toBe(false);
    expect(block.toolOutput.interaction).toEqual({
      mode: 'await',
      toolCallId: 'call-1',
      state: 'answered',
      answeredAt: 1,
    });
    expect(block.toolOutput.answer).toMatchObject({ summary: '选了 B', data: { q1: { selected: ['b'] } } });
  });

  it('onEnd for dismissed await carries interaction without answer', () => {
    const store = createStore();
    const handler = eventRegistry.get('generative_ui')!;
    handler.onStart!(store, 'msg-1', { toolCallId: 'call-1', awaitAnswer: true }, 'blk-exec');
    handler.onEnd!(store, 'blk-exec', {
      intent: INTENT,
      interaction: { mode: 'await', toolCallId: 'call-1', state: 'dismissed', reason: 'user_message' },
    });
    const output = store.blocks.get('blk-exec')!.toolOutput;
    expect(output.interaction).toMatchObject({ state: 'dismissed', reason: 'user_message' });
    expect(output.answer).toBeUndefined();
  });

  it('onEnd for non-await blocks keeps the plain { intent, isStreaming } shape', () => {
    const store = createStore();
    const handler = eventRegistry.get('generative_ui')!;
    handler.onStart!(store, 'msg-1', {}, 'blk-plain');
    handler.onEnd!(store, 'blk-plain', {
      intent: { version: '1', blocks: [{ type: 'text', props: { body: 'hi' } }] },
    });
    expect(Object.keys(store.blocks.get('blk-plain')!.toolOutput).sort()).toEqual(['intent', 'isStreaming']);
  });
});
