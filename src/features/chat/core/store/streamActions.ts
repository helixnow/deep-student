import type { ChatStoreState, SetState, GetState } from './types';
import { addToSet, removeFromSet } from './immerHelpers';
import { debugLog } from '@/debug-panel/debugMasterSwitch';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

export function createStreamActions(
  set: SetState,
  getState: GetState,
) {
  return {
        completeStream: (
          reason: 'success' | 'error' | 'cancelled' = 'success',
          terminalError?: string,
        ): void => {
          const state = getState();
          // 🔧 P0修复：支持 streaming 和 aborting 状态
          // aborting 状态时，后端可能仍然发送 stream_complete/stream_error
          // 需要正确处理以重置状态
          if (state.sessionStatus !== 'streaming' && state.sessionStatus !== 'aborting') {
            // 🔧 Bug修复：即使状态已经是 idle，也要确保清空 activeBlockIds
            // 防止因其他地方的 bug 导致 isStreaming 状态残留
            if (state.sessionStatus === 'idle') {
              // Defensive cleanup for a terminal event that arrived after a
              // status race. Leaving currentStreamingMessageId behind causes
              // subsequent autonomous streams to be rejected as conflicts.
              if (state.activeBlockIds.size > 0 || state.currentStreamingMessageId !== null) {
                console.warn(
                  '[ChatStore] completeStream: Found stale stream state while idle, cleaning up:',
                  {
                    activeBlockIds: Array.from(state.activeBlockIds),
                    currentStreamingMessageId: state.currentStreamingMessageId,
                  }
                );
                set({
                  activeBlockIds: new Set(),
                  currentStreamingMessageId: null,
                });
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

            // 3. 清理仍停留在 preparing 的孤儿块（pending，不会被上面的 running 检查捕获）。
            // 文案必须跟 reason 一致：success 路径绝不能写 "cancelled"，否则会出现
            // 「加载技能组执行失败 / Stream cancelled…」闪红后再成功的误报。
            // error 路径优先展示调用方传入的归一化终态错误，通用兜底文案会掩盖后端真实原因。
            const normalizedTerminalError = terminalError?.trim();
            const preparingErrorText =
              reason === 'error'
                ? normalizedTerminalError || 'Stream ended with error before tool execution'
                : 'Stream cancelled before tool execution';
            const removedPreparingIds: string[] = [];
            for (const blockId of messageBlockIds) {
              const block = newBlocks.get(blockId);
              if (block && block.isPreparing) {
                console.warn(
                  '[ChatStore] completeStream: Found orphan preparing block, cleaning:',
                  blockId,
                  'toolName=', block.toolName,
                  'reason=', reason,
                );
                if (reason === 'success') {
                  // 成功收尾：未执行的 preparing 预览块直接移除，避免空「执行完成」卡。
                  newBlocks.delete(blockId);
                  removedPreparingIds.push(blockId);
                } else {
                  newBlocks.set(blockId, {
                    ...block,
                    isPreparing: false,
                    status: 'error',
                    error: preparingErrorText,
                    endedAt: now,
                  });
                }
                updatedCount++;
              }
            }

            if (updatedCount > 0) {
              console.log('[ChatStore] completeStream: Updated', updatedCount, 'blocks to', reason);
            }

            // 清除 preparingToolCall；若 success 移除了孤儿 preparing，同步修剪 message.blockIds
            let newMessageMap = s.messageMap;
            if (currentMessageId) {
              const msg = s.messageMap.get(currentMessageId);
              if (msg) {
                const dropPreparingMeta = Boolean(msg._meta?.preparingToolCall);
                const dropBlockIds =
                  removedPreparingIds.length > 0
                    ? msg.blockIds.filter((id) => !removedPreparingIds.includes(id))
                    : null;
                if (dropPreparingMeta || dropBlockIds) {
                  newMessageMap = new Map(s.messageMap);
                  const newMeta = { ...msg._meta };
                  delete newMeta.preparingToolCall;
                  newMessageMap.set(currentMessageId, {
                    ...msg,
                    ...(dropBlockIds ? { blockIds: dropBlockIds } : {}),
                    _meta: newMeta,
                  });
                }
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
