/**
 * Chat V2 - 队列变更动作（A3/A4/A5）
 *
 * 实现输入消息队列的所有 mutation：入队、移除、清空、提升、重试、回拢、交换。
 * 所有动作均为纯状态变更，无副作用，由 InputBarV2 在阻塞期内触发。
 */

import type { GetState, SetState, ChatStoreState } from './types';
import type { QueuedMessage } from '../types/queue';
import { QUEUE_HARD_CAP } from '../types/queue';
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
  };
}
