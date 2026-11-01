import { describe, expect, it, vi } from 'vitest';
import { createChatStore } from '../createChatStore';
import type { DeliverOutcome } from '../../types';

function startedOutcome(userMessageId: string, assistantMessageId: string): DeliverOutcome {
  return {
    status: 'started',
    userMessage: {
      id: userMessageId,
      content: '<super_agent_inbox>worker done</super_agent_inbox>',
      timestampMs: 1_700_000_000_000,
      inboundOrigin: { kind: 'worker', workerId: 'w1' },
    },
    assistantMessageId,
  };
}

describe('store.deliverSuperInbox', () => {
  it('enters streaming with an assistant placeholder and inserts the backend user message before it', async () => {
    const store = createChatStore('sess_super');
    let seenDuringCall: { status: string; order: string[]; streaming: string | null } | null = null;
    const callback = vi.fn(async (userMessageId: string, assistantMessageId: string, force: boolean) => {
      const s = store.getState();
      seenDuringCall = {
        status: s.sessionStatus,
        order: [...s.messageOrder],
        streaming: s.currentStreamingMessageId,
      };
      expect(force).toBe(false);
      return startedOutcome(userMessageId, assistantMessageId);
    });
    store.getState().setDeliverInboxCallback(callback);

    const outcome = await store.getState().deliverSuperInbox();

    expect(callback).toHaveBeenCalledTimes(1);
    const [userMessageId, assistantMessageId] = callback.mock.calls[0];
    expect(userMessageId).not.toBe(assistantMessageId);
    expect(seenDuringCall).toEqual({
      status: 'streaming',
      order: [assistantMessageId],
      streaming: assistantMessageId,
    });
    expect(outcome.status).toBe('started');

    const state = store.getState();
    expect(state.messageOrder).toEqual([userMessageId, assistantMessageId]);
    expect(state.sessionStatus).toBe('streaming');
    expect(state.currentStreamingMessageId).toBe(assistantMessageId);
    const user = state.messageMap.get(userMessageId)!;
    expect(user.role).toBe('user');
    expect(user.timestamp).toBe(1_700_000_000_000);
    expect(user._meta?.inboundOrigin).toEqual({ kind: 'worker', workerId: 'w1' });
    expect(user.blockIds).toHaveLength(1);
    const block = state.blocks.get(user.blockIds[0])!;
    expect(block.type).toBe('content');
    expect(block.content).toBe('<super_agent_inbox>worker done</super_agent_inbox>');
    expect(state.messageMap.get(assistantMessageId)?.role).toBe('assistant');
  });

  it('passes force=true through to the callback', async () => {
    const store = createChatStore('sess_super');
    const callback = vi.fn(async () => ({ status: 'empty' } as DeliverOutcome));
    store.getState().setDeliverInboxCallback(callback);

    await store.getState().deliverSuperInbox({ force: true });

    expect(callback.mock.calls[0][2]).toBe(true);
  });

  it.each<DeliverOutcome>([
    { status: 'empty' },
    { status: 'busy' },
    { status: 'disabled' },
    { status: 'paused', autoTurns: 20 },
  ])('rolls back the placeholder without throwing on %o', async (result) => {
    const store = createChatStore('sess_super');
    store.setState({ messageOrder: ['msg_existing'], messageMap: new Map([['msg_existing', {
      id: 'msg_existing', role: 'user', blockIds: [], timestamp: 1,
    }]]) } as any);
    store.getState().setDeliverInboxCallback(vi.fn(async () => result));

    const outcome = await store.getState().deliverSuperInbox();

    expect(outcome).toEqual(result);
    const state = store.getState();
    expect(state.sessionStatus).toBe('idle');
    expect(state.currentStreamingMessageId).toBeNull();
    expect(state.messageOrder).toEqual(['msg_existing']);
    expect([...state.messageMap.keys()]).toEqual(['msg_existing']);
  });

  it('rolls back and rethrows when the callback fails', async () => {
    const store = createChatStore('sess_super');
    store.getState().setDeliverInboxCallback(vi.fn(async () => {
      throw new Error('boom');
    }));

    await expect(store.getState().deliverSuperInbox()).rejects.toThrow('boom');

    const state = store.getState();
    expect(state.sessionStatus).toBe('idle');
    expect(state.currentStreamingMessageId).toBeNull();
    expect(state.messageOrder).toEqual([]);
  });

  it('returns busy without calling back when the session is not idle', async () => {
    const store = createChatStore('sess_super');
    const callback = vi.fn();
    store.getState().setDeliverInboxCallback(callback);
    store.setState({ sessionStatus: 'streaming', currentStreamingMessageId: 'msg_other' } as any);

    const outcome = await store.getState().deliverSuperInbox();

    expect(outcome).toEqual({ status: 'busy' });
    expect(callback).not.toHaveBeenCalled();
    expect(store.getState().currentStreamingMessageId).toBe('msg_other');
  });

  it('returns disabled when no callback is injected', async () => {
    const store = createChatStore('sess_super');
    expect(await store.getState().deliverSuperInbox()).toEqual({ status: 'disabled' });
    expect(store.getState().sessionStatus).toBe('idle');
    expect(store.getState().messageOrder).toEqual([]);
  });

  it('never delivers into a subagent session', async () => {
    const store = createChatStore('subagent_worker_1');
    const callback = vi.fn();
    store.getState().setDeliverInboxCallback(callback);
    expect(await store.getState().deliverSuperInbox()).toEqual({ status: 'disabled' });
    expect(callback).not.toHaveBeenCalled();
  });
});

describe('guards.canEdit for inbound messages', () => {
  it('refuses to edit a message carrying _meta.inboundOrigin, but keeps delete native', () => {
    const store = createChatStore('sess_super');
    store.setState({
      messageOrder: ['msg_inbound', 'msg_human'],
      messageMap: new Map([
        ['msg_inbound', {
          id: 'msg_inbound', role: 'user', blockIds: [], timestamp: 1,
          _meta: { inboundOrigin: { kind: 'worker' } },
        }],
        ['msg_human', { id: 'msg_human', role: 'user', blockIds: [], timestamp: 2 }],
      ]),
    } as any);

    expect(store.getState().canEdit('msg_inbound')).toBe(false);
    expect(store.getState().canEdit('msg_human')).toBe(true);
    expect(store.getState().canDelete('msg_inbound')).toBe(true);
  });
});
