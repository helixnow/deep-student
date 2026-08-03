import { describe, expect, it, vi } from 'vitest';
import { createChatStore } from '../createChatStore';

describe('subagent read-only store guards', () => {
  it('rejects sends before invoking the adapter callback', async () => {
    const store = createChatStore('subagent_worker_1');
    let callbackCalls = 0;
    store.getState().setSendCallback(async () => {
      callbackCalls += 1;
    });

    expect(store.getState().canSend()).toBe(false);
    await store.getState().sendMessage('should not send');

    expect(callbackCalls).toBe(0);
  });

  it('rejects sends for a normal ID with subagent mode', async () => {
    const store = createChatStore('sess_normal');
    store.setState({ mode: 'subagent' });
    let callbackCalls = 0;
    store.getState().setSendCallback(async () => {
      callbackCalls += 1;
    });

    expect(store.getState().canSend()).toBe(false);
    await store.getState().sendMessage('should not send');

    expect(callbackCalls).toBe(0);
  });

  it('rejects system wakes for subagent sessions', async () => {
    const store = createChatStore('agent_worker_1');
    const callback = vi.fn();
    store.getState().setWakeSessionCallback(callback);

    await store.getState().wakeSession('[子代理完成通知] should not wake');

    expect(callback).not.toHaveBeenCalled();
    expect(store.getState().messageOrder).toEqual([]);
  });

  it('creates only an assistant placeholder for a system wake', async () => {
    const store = createChatStore('sess_parent');
    const callback = vi.fn().mockResolvedValue(undefined);
    store.getState().setWakeSessionCallback(callback);

    await store.getState().wakeSession('[子代理完成通知] complete');

    expect(callback).toHaveBeenCalledTimes(1);
    expect(store.getState().messageOrder).toHaveLength(1);
    const message = store.getState().messageMap.get(store.getState().messageOrder[0]);
    expect(message?.role).toBe('assistant');
    expect(store.getState().sessionStatus).toBe('streaming');
    expect(store.getState().currentStreamingMessageId).toBe(message?.id);
  });

  it('rejects edit-and-resend before invoking the adapter callback', async () => {
    const store = createChatStore('agent_worker_1');
    let callbackCalls = 0;
    store.getState().setEditAndResendCallback(async () => {
      callbackCalls += 1;
      return { newMessageId: 'msg_new', deletedMessageIds: [] };
    });

    expect(store.getState().canEdit('msg_user')).toBe(false);
    await store.getState().editAndResend('msg_user', 'should not resend');

    expect(callbackCalls).toBe(0);
  });
});
