import type { ChatStoreState, SetState, GetState } from './types';
import { addToSet, removeFromSet } from './immerHelpers';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { chunkBuffer } from '../middleware/chunkBuffer';
import { resetTransientRuntimes } from './transientRuntimeRegistry';

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
          // Flush and discard any buffered token batches before transitioning
          // to idle. This covers terminal events that race with abort/error
          // state updates and prevents stale chunks leaking into the next run.
          if (state.sessionId) {
            chunkBuffer.flushAndCleanupSession(state.sessionId);
          }
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

          // 流终止（成功/错误/取消）时收掉未决审批栏：pipeline 等待审批期间不可能
          // 发出 stream_complete，pending 审批与流终止并存即意味着审批已随流死亡；
          // 其终止事件（无 messageId 的虚拟块）在流结束后会被事件桥静默丢弃，
          // 本地直接清理，避免审批栏永久占位。审批队列运行时一并重置。
          const hasPendingToolApproval = state.pendingBlockingInteraction?.kind === 'tool_approval';
          if (hasPendingToolApproval) {
            resetTransientRuntimes(state.setPendingApproval);
          }

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

            // 🔧 终态归一化：按 firstChunkAt/startedAt 稳定重排 blockIds。
            // 晚到/重放块（startedAt 早于末尾块）可能在流式期间被追加到消息
            // 末尾（EventBridge 对 start 无重放防护时会克隆块），流结束后归位，
            // 避免工具块/思维链始终渲染在消息底部。仅乱序时排序，正常消息
            // 保持原引用（零拷贝）。
            if (currentMessageId) {
              const msg = newMessageMap.get(currentMessageId);
              if (msg) {
                const keyOf = (id: string): number => {
                  const b = newBlocks.get(id);
                  return (b?.firstChunkAt ?? b?.startedAt ?? 0) || 0;
                };
                const normalize = (ids: string[]): string[] | null => {
                  let disordered = false;
                  for (let i = 1; i < ids.length; i++) {
                    if (keyOf(ids[i]) < keyOf(ids[i - 1])) {
                      disordered = true;
                      break;
                    }
                  }
                  // Array.prototype.sort 稳定：相同时间戳保持原顺序
                  return disordered
                    ? [...ids].sort((aId, bId) => keyOf(aId) - keyOf(bId))
                    : null;
                };
                const sortedMain = normalize(msg.blockIds);
                const sortedVariants = msg.variants?.map((v) => normalize(v.blockIds)) ?? [];
                if (sortedMain || sortedVariants.some((x) => x !== null)) {
                  newMessageMap = new Map(newMessageMap);
                  newMessageMap.set(currentMessageId, {
                    ...msg,
                    ...(sortedMain ? { blockIds: sortedMain } : {}),
                    ...(msg.variants
                      ? {
                          variants: msg.variants.map((v, i) =>
                            sortedVariants[i] ? { ...v, blockIds: sortedVariants[i]! } : v
                          ),
                        }
                      : {}),
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
              ...(hasPendingToolApproval
                ? { pendingBlockingInteraction: null, pendingApprovalRequest: null }
                : {}),
            };
          });

          console.log('[ChatStore] Stream completed (reason:', reason + '), status reset to idle');
        },
  };
}
