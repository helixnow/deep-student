/**
 * Chat V2 - 队列变更动作（A3/A4/A5）
 *
 * 实现输入消息队列的所有 mutation：入队、移除、清空、提升、重试、回拢、交换。
 * 所有动作均为纯状态变更，无副作用，由 InputBarV2 在阻塞期内触发。
 */

import type { GetState, SetState, ChatStoreState } from './types';
import type { QueuedMessage } from '../types/queue';
import { QUEUE_HARD_CAP, QUEUE_DEQUEUE_BREATHER_MS, readBlockingInteraction } from '../types/queue';
import type { AttachmentMeta } from '../types/common';
import type { ContextRef } from '../../context/types';

// ============================================================================
// 类型定义
// ============================================================================

export interface QueueActions {
  /** 在队尾追加一条 pending 消息；超过硬上限则 no-op */
  enqueueMessage: (
    content: string,
    attachments: AttachmentMeta[],
    contextRefs: ContextRef[],
  ) => void;

  /** 按 id 移除队列项；找不到则 no-op */
  removeQueued: (id: string) => void;

  /** 清空整个队列（包括 failed 项） */
  clearQueue: () => void;

  /** 将匹配项移动到队首；已是队首或不存在则 no-op */
  promoteQueued: (id: string) => void;

  /** 将 failed 项重置为 pending 并清理 error；找不到则 no-op */
  retryFailed: (id: string) => void;

  /** 取回队列项到草稿，并从队列移除；找不到则 no-op */
  recallToDraft: (id: string) => void;

  /**
   * 草稿与队列项的净零交换：
   * - 若当前草稿为空（trim 后为空且无附件），等同 recallToDraft
   * - 否则：移除目标项 → 将当前草稿作为新 pending 追加到队尾 → 草稿填入目标项内容
   */
  swapQueueWithDraft: (id: string) => void;

  /**
   * 将队列项标记为「已引导」。出队成功后该标志会传播到对应 user message 的
   * `_meta.steered`，从而在聊天页渲染「已引导对话」徽章。
   * 找不到则 no-op；已是 steered 也 no-op（幂等）。
   */
  markSteered: (id: string) => void;

  /**
   * 自动出队下一项：当 sessionStatus 为 idle、队列非空、未在出队、无阻塞交互、
   * 且无 failed 项时，将队首项移除并通过 store.sendMessage 发送。
   * 失败时将该项以 status='failed' + error 消息重新插回队首。
   * 若该项 steered=true，发送成功后会更新 user message 的 _meta.steered。
   */
  maybeDequeue: () => Promise<void>;
}

// ============================================================================
// 唯一 id 生成
// ============================================================================

let _counter = 0;
/**
 * 生成 q_ 前缀的 client-side 队列项 id。
 * 同步连续调用也保证唯一（计数器递增 + 时间戳）。
 */
function genQueuedId(): string {
  _counter += 1;
  return `q_${Date.now().toString(36)}_${_counter.toString(36)}`;
}

// ============================================================================
// 工厂函数
// ============================================================================

export function createQueueActions(set: SetState, getState: GetState): QueueActions {
  return {
    enqueueMessage: (content, attachments, contextRefs) => {
      const state = getState() as ChatStoreState;
      if (state.queuedMessages.length >= QUEUE_HARD_CAP) return;
      const item: QueuedMessage = {
        id: genQueuedId(),
        content,
        attachments,
        contextRefs,
        createdAt: Date.now(),
        status: 'pending',
      };
      set((s) => ({ queuedMessages: [...(s as ChatStoreState).queuedMessages, item] }));
    },

    removeQueued: (id) => {
      set((s) => ({
        queuedMessages: (s as ChatStoreState).queuedMessages.filter((q) => q.id !== id),
      }));
    },

    clearQueue: () => {
      set({ queuedMessages: [] });
    },

    promoteQueued: (id) => {
      set((s) => {
        const queue = (s as ChatStoreState).queuedMessages;
        const idx = queue.findIndex((q) => q.id === id);
        if (idx <= 0) return {};
        const item = queue[idx];
        return {
          queuedMessages: [item, ...queue.slice(0, idx), ...queue.slice(idx + 1)],
        };
      });
    },

    retryFailed: (id) => {
      set((s) => ({
        queuedMessages: (s as ChatStoreState).queuedMessages.map((q) => {
          if (q.id !== id) return q;
          // 通过解构剥离 error 字段，避免遗留 undefined own-property
          const { error: _err, ...rest } = q;
          void _err;
          return { ...rest, status: 'pending' as const };
        }),
      }));
    },

    recallToDraft: (id) => {
      set((s) => {
        const state = s as ChatStoreState;
        const item = state.queuedMessages.find((q) => q.id === id);
        if (!item) return {};
        return {
          queuedMessages: state.queuedMessages.filter((q) => q.id !== id),
          inputValue: item.content,
          attachments: item.attachments,
          pendingContextRefs: item.contextRefs,
        };
      });
    },

    swapQueueWithDraft: (id) => {
      set((s) => {
        const state = s as ChatStoreState;
        const item = state.queuedMessages.find((q) => q.id === id);
        if (!item) return {};
        const draftEmpty = !state.inputValue.trim() && state.attachments.length === 0;
        const without = state.queuedMessages.filter((q) => q.id !== id);
        const nextQueue: QueuedMessage[] = draftEmpty
          ? without
          : [
              ...without,
              {
                id: genQueuedId(),
                content: state.inputValue,
                attachments: state.attachments,
                contextRefs: state.pendingContextRefs,
                createdAt: Date.now(),
                status: 'pending',
              },
            ];
        return {
          queuedMessages: nextQueue,
          inputValue: item.content,
          attachments: item.attachments,
          pendingContextRefs: item.contextRefs,
        };
      });
    },

    markSteered: (id) => {
      set((s) => ({
        queuedMessages: (s as ChatStoreState).queuedMessages.map((q) =>
          q.id === id && !q.steered ? { ...q, steered: true } : q,
        ),
      }));
    },

    maybeDequeue: async () => {
      // Read state at entry; sendMessage is wired onto the store by createChatStore.
      const s0 = getState() as ChatStoreState & {
        sendMessage?: (content: string, attachments: AttachmentMeta[]) => Promise<void>;
        updateMessageMeta?: (messageId: string, meta: { steered?: boolean }) => void;
      };

      if (s0.sessionStatus !== 'idle') return;
      if (s0.queuedMessages.length === 0) return;
      if (s0.dequeuing) return;
      if (readBlockingInteraction(s0) !== null) return;
      if (s0.queuedMessages.some((q) => q.status === 'failed')) return;

      // Defensive: if sendMessage is not wired yet (mid-init / teardown), bail
      // BEFORE removing the head item — otherwise we'd silently drop messages.
      if (typeof s0.sendMessage !== 'function') return;

      const [head, ...rest] = s0.queuedMessages;
      set({ queuedMessages: rest, dequeuing: true });

      // 300ms breather: clears dequeuing flag for race-prevention + visual gap.
      // After clearing, re-trigger maybeDequeue — covers the case where the
      // stream finished within the breather (idle transition fired but our
      // own `dequeuing=true` blocked the subscription's nudge).
      setTimeout(() => {
        set({ dequeuing: false });
        // Fire-and-forget; the guard will short-circuit if no longer applicable.
        const cur = getState() as ChatStoreState & {
          maybeDequeue?: () => Promise<void>;
        };
        if (typeof cur.maybeDequeue === 'function') {
          void cur.maybeDequeue();
        }
      }, QUEUE_DEQUEUE_BREATHER_MS);

      try {
        await s0.sendMessage(head.content, head.attachments);
        // Propagate the steered flag to the freshly-created user message so the
        // chat UI can render the「已引导对话」badge above it.
        // We locate the user message by scanning the message order tail —
        // sendMessage just appended it, and `dequeuing=true` blocks further
        // enqueue/dequeue, so the latest user message is unambiguous.
        if (head.steered && typeof s0.updateMessageMeta === 'function') {
          const after = getState() as ChatStoreState;
          for (let i = after.messageOrder.length - 1; i >= 0; i -= 1) {
            const msg = after.messageMap.get(after.messageOrder[i]);
            if (msg?.role === 'user') {
              s0.updateMessageMeta(msg.id, { steered: true });
              break;
            }
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        set((cur) => ({
          queuedMessages: [
            { ...head, status: 'failed' as const, error: errorMsg },
            ...(cur as ChatStoreState).queuedMessages,
          ],
        }));
      }
    },
  };
}
