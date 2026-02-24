import type { ChatStoreState, SetState, GetState } from './types';
import { addToSet, removeFromSet } from './immerHelpers';
import { debugLog } from '../../../debug-panel/debugMasterSwitch';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

export function createStreamActions(
  set: SetState,
  getState: GetState,
) {
  return {
        completeStream: (reason: 'success' | 'error' | 'cancelled' = 'success'): void => {
          const state = getState();
          // 🔧 P0修复：支持 streaming 和 aborting 状态
          // aborting 状态时，后端可能仍然发送 stream_complete/stream_error
          // 需要正确处理以重置状态
          if (state.sessionStatus !== 'streaming' && state.sessionStatus !== 'aborting') {
            // 🔧 Bug修复：即使状态已经是 idle，也要确保清空 activeBlockIds
            // 防止因其他地方的 bug 导致 isStreaming 状态残留
            if (state.sessionStatus === 'idle') {
              // 只在有残留的 activeBlockIds 时处理
              if (state.activeBlockIds.size > 0) {
                console.warn(
                  '[ChatStore] completeStream: Found stale activeBlockIds while in idle state, cleaning up:',
                  Array.from(state.activeBlockIds)
                );
                set({ activeBlockIds: new Set() });
              }
              return;
            }
            console.warn(
              '[ChatStore] completeStream called but sessionStatus is unexpected:',
              state.sessionStatus
            );
            return;
          }

          // 🔧 2026-01-11 修复：不仅更新 activeBlockIds 中的块，还要更新当前流式消息的所有 running 块
          // 解决 Gemini 思维链一直显示"思考中"的问题（thinking 块可能没有收到 thinking/end 事件）
          const currentMessageId = state.currentStreamingMessageId;
          const currentMessage = currentMessageId ? state.messageMap.get(currentMessageId) : null;
          const messageBlockIds = currentMessage?.blockIds || [];

          // 根据 reason 将所有活跃块标记为对应状态
          set((s) => {
            const newBlocks = new Map(s.blocks);
            const now = Date.now();
            let updatedCount = 0;

            // 1. 更新 activeBlockIds 中的块
            s.activeBlockIds.forEach((blockId) => {
              const block = newBlocks.get(blockId);
              if (block && block.status !== 'success' && block.status !== 'error') {
                if (reason === 'success') {
                  newBlocks.set(blockId, {
                    ...block,
                    status: 'success',
                    endedAt: now,
                  });
                } else {
                  newBlocks.set(blockId, {
                    ...block,
                    status: 'error',
                    error: reason === 'error' ? 'Stream ended with error' : 'Stream cancelled',
                    endedAt: now,
                  });
                }
                updatedCount++;
              }
            });

            // 2. 🔧 额外安全措施：遍历当前流式消息的所有块，确保 running 状态的块被更新
            // 这可以捕获那些因某种原因没有在 activeBlockIds 中但仍处于 running 状态的块（如 thinking 块）
            for (const blockId of messageBlockIds) {
              const block = newBlocks.get(blockId);
              if (block && block.status === 'running') {
                console.warn(
                  '[ChatStore] completeStream: Found running block not in activeBlockIds, fixing:',
                  blockId,
                  'type=', block.type
                );
                if (reason === 'success') {
                  newBlocks.set(blockId, {
                    ...block,
                    status: 'success',
                    endedAt: now,
                  });
                } else {
                  newBlocks.set(blockId, {
                    ...block,
                    status: 'error',
                    error: reason === 'error' ? 'Stream ended with error' : 'Stream cancelled',
                    endedAt: now,
                  });
                }
                updatedCount++;
              }
            }

            // 3. 🆕 2026-01-16: 清理 preparing 块（流式取消时可能遗留）
            // preparing 块的状态是 pending，不会被上面的 running 检查捕获
            for (const blockId of messageBlockIds) {
              const block = newBlocks.get(blockId);
              if (block && block.isPreparing) {
                console.warn(
                  '[ChatStore] completeStream: Found orphan preparing block, cleaning:',
                  blockId,
                  'toolName=', block.toolName
                );
                newBlocks.set(blockId, {
                  ...block,
                  isPreparing: false,
                  status: 'error',
                  error: 'Stream cancelled before tool execution',
                  endedAt: now,
                });
                updatedCount++;
              }
            }

            if (updatedCount > 0) {
              console.log('[ChatStore] completeStream: Updated', updatedCount, 'blocks to', reason);
            }

            // 🆕 2026-01-15: 清除 preparingToolCall 状态
            // 流式完成或取消时，清理消息元数据中的 preparingToolCall
            let newMessageMap = s.messageMap;
            if (currentMessageId) {
              const msg = s.messageMap.get(currentMessageId);
              if (msg && msg._meta?.preparingToolCall) {
                newMessageMap = new Map(s.messageMap);
                const newMeta = { ...msg._meta };
                delete newMeta.preparingToolCall;
                newMessageMap.set(currentMessageId, { ...msg, _meta: newMeta });
              }
            }

            return {
              sessionStatus: 'idle',
              currentStreamingMessageId: null,
              activeBlockIds: new Set(),
              blocks: newBlocks,
              messageMap: newMessageMap,
            };
          });

          console.log('[ChatStore] Stream completed (reason:', reason + '), status reset to idle');
        },
  };
}
