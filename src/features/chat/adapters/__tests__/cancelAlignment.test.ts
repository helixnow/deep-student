import { describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { alignCancelledMessageWithArchive, type CancelAlignmentHost } from '../tauri/cancelAlignment';

type LiveBlock = { id: string; messageId: string; type: string; status: string; content?: string };

function host(blocks: LiveBlock[], over: Partial<{ streaming: string | null; windowStart: number }> = {}) {
  const live = new Map(blocks.map((b) => [b.id, { ...b }]));
  const message = { id: 'm2', role: 'assistant', blockIds: blocks.map((b) => b.id) };
  const state = {
    get blocks() { return live; },
    get currentStreamingMessageId() { return over.streaming ?? null; },
    getOrderedMessages: () => [{ id: 'm1', role: 'user', blockIds: [] }, message],
    createBlockWithId: vi.fn((messageId: string, type: string, id: string) => {
      live.set(id, { id, messageId, type, status: 'pending' });
      message.blockIds.push(id);
      return id;
    }),
    updateBlock: vi.fn((id: string, patch: Partial<LiveBlock>) => { live.set(id, { ...live.get(id)!, ...patch }); }),
  };
  const h = {
    sessionId: 's1',
    setupGeneration: 1,
    historyWindowStartOffset: over.windowStart ?? 10,
    store: state,
    getCurrentState: () => state,
    isSessionRuntimeOwner: () => true,
  } as unknown as CancelAlignmentHost;
  return { h, live, message, state };
}

const archived = (blocks: Array<Partial<LiveBlock> & { id: string }>) => ({
  messages: [{ id: 'm1', role: 'user', blockIds: [] }, { id: 'm2', role: 'assistant', blockIds: blocks.map((b) => b.id) }],
  blocks: blocks.map((b) => ({ messageId: 'm2', type: 'content', status: 'success', ...b })),
  totalMessageCount: 12,
});

describe('alignCancelledMessageWithArchive', () => {
  it('adds the segment the host persisted after the UI stopped listening', async () => {
    const { h, live, message } = host([{ id: 'b1', messageId: 'm2', type: 'thinking', status: 'success', content: 'think' }]);
    invoke.mockResolvedValueOnce(archived([
      { id: 'b1', type: 'thinking', content: 'think' },
      { id: 'b2', type: 'content', content: 'partial answer' },
    ]));
    await expect(alignCancelledMessageWithArchive(h, 'm2')).resolves.toBe(1);
    expect(invoke).toHaveBeenLastCalledWith('chat_v2_load_messages_page', { sessionId: 's1', offset: 10, limit: 3 });
    expect(message.blockIds).toEqual(['b1', 'b2']);
    expect(live.get('b2')).toMatchObject({ type: 'content', status: 'success', content: 'partial answer' });
  });

  it('extends a block whose archived content continues the visible text', async () => {
    const { h, live } = host([{ id: 'b1', messageId: 'm2', type: 'content', status: 'success', content: 'hello' }]);
    invoke.mockResolvedValueOnce(archived([{ id: 'b1', content: 'hello world' }]));
    await expect(alignCancelledMessageWithArchive(h, 'm2')).resolves.toBe(1);
    expect(live.get('b1')!.content).toBe('hello world');
  });

  it('never drops visible text the archive does not contain', async () => {
    const { h, live, state } = host([{ id: 'b1', messageId: 'm2', type: 'content', status: 'success', content: 'hello world' }]);
    invoke.mockResolvedValueOnce(archived([{ id: 'b1', content: 'hello' }]));
    await expect(alignCancelledMessageWithArchive(h, 'm2')).resolves.toBe(0);
    expect(live.get('b1')!.content).toBe('hello world');
    expect(state.updateBlock).not.toHaveBeenCalled();
  });

  it('leaves the message alone if it started streaming again before the archive arrived', async () => {
    const { h, state } = host([{ id: 'b1', messageId: 'm2', type: 'content', status: 'success', content: 'x' }], { streaming: 'm2' });
    invoke.mockResolvedValueOnce(archived([{ id: 'b1', content: 'x' }, { id: 'b2', content: 'y' }]));
    await expect(alignCancelledMessageWithArchive(h, 'm2')).resolves.toBe(0);
    expect(state.createBlockWithId).not.toHaveBeenCalled();
  });

  it('falls back to the full session when the page does not contain the message', async () => {
    const { h, message } = host([], { windowStart: 0 });
    invoke
      .mockResolvedValueOnce({ messages: [], blocks: [], totalMessageCount: 2 })
      .mockResolvedValueOnce(archived([{ id: 'b9', content: 'late' }]));
    await expect(alignCancelledMessageWithArchive(h, 'm2')).resolves.toBe(1);
    expect(invoke).toHaveBeenLastCalledWith('chat_v2_load_session', { sessionId: 's1' });
    expect(message.blockIds).toEqual(['b9']);
  });
});
