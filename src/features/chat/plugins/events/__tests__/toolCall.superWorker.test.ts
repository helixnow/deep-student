import { describe, expect, it, vi } from 'vitest';
import { eventRegistry } from '@/features/chat/registry/eventRegistry';
import type { ChatStore } from '@/features/chat/core/types';

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

import { isSubagentEmbedToolName } from '../toolCall';

function createStore(): ChatStore {
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
    sessionId: 'sess-super',
    mode: 'chat',
    sessionStatus: 'streaming',
    currentStreamingMessageId: 'msg-1',
    messageMap,
    messageOrder: ['msg-1'],
    blocks,
    activeBlockIds,
    chatParams: { modelId: 'm' },
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
  };
  return new Proxy(base, {
    get(target, prop: string) {
      if (!(prop in target)) target[prop] = vi.fn();
      return target[prop];
    },
  }) as unknown as ChatStore;
}

describe('Super worker tools render as subagent_embed', () => {
  it('recognizes builtin-prefixed super worker tools', () => {
    expect(isSubagentEmbedToolName('builtin-super_dispatch_worker')).toBe(true);
    expect(isSubagentEmbedToolName('builtin-super_message_worker')).toBe(true);
    expect(isSubagentEmbedToolName('builtin-subagent_call')).toBe(true);
    expect(isSubagentEmbedToolName('builtin-super_close_worker')).toBe(false);
    expect(isSubagentEmbedToolName('builtin-super_list_workers')).toBe(false);
  });

  it.each(['builtin-super_dispatch_worker', 'builtin-super_message_worker'])(
    'tool_call onStart maps %s to subagent_embed',
    (toolName) => {
      const store = createStore();
      const handler = eventRegistry.get('tool_call')!;
      const id = handler.onStart!(store, 'msg-1', {
        toolName,
        toolCallId: `call-${toolName}`,
        toolInput: { title: 't', task: 'do it' },
      }, `blk-${toolName}`);
      expect(store.blocks.get(id)?.type).toBe('subagent_embed');
    },
  );

  it.each(['builtin-super_dispatch_worker', 'builtin-super_message_worker'])(
    'tool_call_preparing onStart maps %s to subagent_embed',
    (toolName) => {
      const store = createStore();
      const preparing = eventRegistry.get('tool_call_preparing')!;
      const id = preparing.onStart!(store, 'msg-1', {
        toolName,
        toolCallId: `prep-${toolName}`,
      });
      expect(store.blocks.get(id)?.type).toBe('subagent_embed');
    },
  );

  it('keeps other super tools as mcp_tool', () => {
    const store = createStore();
    const handler = eventRegistry.get('tool_call')!;
    const id = handler.onStart!(store, 'msg-1', {
      toolName: 'builtin-super_list_workers',
      toolCallId: 'call-list',
      toolInput: {},
    }, 'blk-list');
    expect(store.blocks.get(id)?.type).toBe('mcp_tool');
  });
});
