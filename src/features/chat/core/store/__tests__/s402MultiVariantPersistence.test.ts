import { describe, expect, it, vi } from 'vitest';
import { createChatStore } from '../createChatStore';
import type { LoadSessionResponseType } from '../../types';

describe('S4-02 multi-variant regenerate, switch, and reload hydration', () => {
  it('defers switchVariant backend sync while retry is in-flight, syncs once retryCallback resolves, and keeps streaming blocks on v2 even when viewing v1', async () => {
    vi.useFakeTimers();
    try {
      const store = createChatStore('sess_s402_fe');
      const msgId = 'msg_mwvfrh4p_p4776u_1';

      store.getState().restoreFromBackend({
        session: {
          id: 'sess_s402_fe',
          mode: 'chat',
          persistStatus: 'active',
          createdAt: '2026-11-25T01:19:32.000Z',
          updatedAt: '2026-11-25T01:19:32.000Z',
        },
        messages: [
          { id: 'msg_mwvfrh4p_p4776u_0', sessionId: 'sess_s402_fe', role: 'user', blockIds: ['blk_u'], timestamp: 100 },
          { id: msgId, sessionId: 'sess_s402_fe', role: 'assistant', blockIds: ['blk_v1'], timestamp: 200, _meta: { modelId: 'DeepSeek-V3' } },
        ],
        blocks: [
          { id: 'blk_u', messageId: 'msg_mwvfrh4p_p4776u_0', type: 'content', status: 'success', content: 'prompt' },
          { id: 'blk_v1', messageId: msgId, type: 'content', status: 'success', content: 'v1 answer' },
        ],
      });

      const switchCalls: Array<[string, string]> = [];
      store.getState().setSwitchVariantCallback(async (mId, vId) => {
        switchCalls.push([mId, vId]);
      });

      let resolveRetry!: (res: { success: boolean; messageId: string; newVariantId: string }) => void;
      store.getState().setRetryCallback(
        () =>
          new Promise((resolve) => {
            resolveRetry = resolve;
          }),
      );

      const retryPromise = store.getState().retryMessage(msgId);

      // Optimistic < 2 / 2 > state before retryCallback settles
      const optimisticMsg = store.getState().getMessage(msgId)!;
      expect(optimisticMsg.variants).toHaveLength(2);
      expect(optimisticMsg.variants![0]).toMatchObject({
        id: `var_v1_${msgId}`,
        blockIds: ['blk_v1'],
        meta: { versioned: true },
      });

      // User clicks `<` to switch to v1 while retry IPC is still in flight
      await store.getState().switchVariant(msgId, `var_v1_${msgId}`);
      await vi.advanceTimersByTimeAsync(500);
      // MUST NOT fire premature chat_v2_switch_variant before SQLite commits var_v1!
      expect(switchCalls).toEqual([]);
      expect(store.getState().getDisplayBlockIds(msgId)).toEqual(['blk_v1']);

      // Streaming block for v2 arrives while user is viewing v1
      store.getState().createBlockWithId(msgId, 'content', 'blk_v2');
      store.getState().updateBlockContent('blk_v2', 'v2 answer');

      // Retry IPC resolves with real backend variant ID
      resolveRetry({ success: true, messageId: msgId, newVariantId: 'var_real_v2' });
      await retryPromise;
      await vi.advanceTimersByTimeAsync(500);

      // Deferred switch sync now fires cleanly once SQLite has var_v1!
      expect(switchCalls).toEqual([[msgId, `var_v1_${msgId}`]]);

      store.getState().completeStream('success');
      const finalMsg = store.getState().getMessage(msgId)!;
      expect(finalMsg.activeVariantId).toBe(`var_v1_${msgId}`);
      expect(finalMsg.variants!.map((v) => ({ id: v.id, blockIds: v.blockIds, status: v.status }))).toEqual([
        { id: `var_v1_${msgId}`, blockIds: ['blk_v1'], status: 'success' },
        { id: 'var_real_v2', blockIds: ['blk_v2'], status: 'success' },
      ]);

      // Reload hydration test (restoreFromBackend on fresh store)
      const reloadedStore = createChatStore('sess_s402_fe');
      const reloadPayload: LoadSessionResponseType = {
        session: {
          id: 'sess_s402_fe',
          mode: 'chat',
          persistStatus: 'active',
          createdAt: '2026-11-25T01:19:32.000Z',
          updatedAt: '2026-11-25T01:20:00.000Z',
        },
        messages: [
          { id: 'msg_mwvfrh4p_p4776u_0', sessionId: 'sess_s402_fe', role: 'user', blockIds: ['blk_u'], timestamp: 100 },
          {
            id: msgId,
            sessionId: 'sess_s402_fe',
            role: 'assistant',
            blockIds: ['blk_v2'],
            timestamp: 200,
            activeVariantId: `var_v1_${msgId}`,
            variants: [
              { id: `var_v1_${msgId}`, modelId: 'DeepSeek-V3', blockIds: ['blk_v1'], status: 'success', createdAt: 200, meta: { versioned: true } },
              { id: 'var_real_v2', modelId: 'DeepSeek-V3', blockIds: ['blk_v2'], status: 'success', createdAt: 205, meta: { versioned: true } },
            ],
          },
        ],
        blocks: [
          { id: 'blk_u', messageId: 'msg_mwvfrh4p_p4776u_0', type: 'content', status: 'success', content: 'prompt' },
          { id: 'blk_v1', messageId: msgId, type: 'content', status: 'success', content: 'v1 answer' },
          { id: 'blk_v2', messageId: msgId, type: 'content', status: 'success', content: 'v2 answer' },
        ],
      };

      reloadedStore.getState().restoreFromBackend(reloadPayload);
      const hydrated = reloadedStore.getState().getMessage(msgId)!;
      expect(hydrated.variants).toHaveLength(2);
      expect(hydrated.variants!.every((v) => v.meta?.versioned === true)).toBe(true);
      expect(hydrated.activeVariantId).toBe(`var_v1_${msgId}`);
      expect(reloadedStore.getState().getDisplayBlockIds(msgId)).toEqual(['blk_v1']);

      await reloadedStore.getState().switchVariant(msgId, 'var_real_v2');
      expect(reloadedStore.getState().getDisplayBlockIds(msgId)).toEqual(['blk_v2']);
    } finally {
      vi.useRealTimers();
    }
  });
});
