import type { Block, BlockType, BlockStatus } from '../types/block';
import type { ChatStoreState, SetState, GetState } from './types';
import {
  updateSingleBlock,
  updateMultipleBlocks,
  batchUpdate,
  addToSet,
  removeFromSet,
} from './immerHelpers';
import { debugLog } from '../../../debug-panel/debugMasterSwitch';
import { generateId, createBlockInternal } from './createChatStore';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

export function createBlockActions(
  set: SetState,
  getState: GetState,
) {
  return {
        // ========== 块 Actions ==========

        /**
         * 🔧 P3重构：抽取公共的块创建逻辑
         * createBlock 和 createBlockWithId 共享此内部实现
         * 注意：flushSync 已移至 createBlockInternal 内部
         */
        createBlock: (messageId: string, type: BlockType): string => {
          const blockId = generateId('blk');
          return createBlockInternal(messageId, type, blockId, set, getState);
        },

        createBlockWithId: (
          messageId: string,
          type: BlockType,
          blockId: string
        ): string => {
          return createBlockInternal(messageId, type, blockId, set, getState);
        },

        updateBlockContent: (blockId: string, chunk: string): void => {
          // ✅ P0-006: 使用 immer 优化，避免每次都复制整个 Map
          set(updateSingleBlock(blockId, (draft) => {
            // 🔧 记录第一个有效 chunk 到达时间（用于排序）
            if (!draft.firstChunkAt && chunk.length > 0) {
              draft.firstChunkAt = Date.now();
            }
            draft.content = (draft.content || '') + chunk;
            // 🛡️ 防止 race condition：流式 chunk 延迟到达时覆盖已完成块的终态
            // 若块已标记为 'success' 或 'error'，保留终态不回退为 'running'
            if (draft.status !== 'success' && draft.status !== 'error') {
              draft.status = 'running';
            }
          }));
        },

        /**
         * 批量更新多个块的内容（性能优化）
         * ✅ P0-006: 使用 immer 优化批量更新
         */
        batchUpdateBlockContent: (
          updates: Array<{ blockId: string; content: string }>
        ): void => {
          if (updates.length === 0) return;

          set(updateMultipleBlocks((draft) => {
            const now = Date.now();
            for (const { blockId, content } of updates) {
              const block = draft.get(blockId);
              if (block) {
                // 🔧 记录第一个有效 chunk 到达时间（用于排序）
                if (!block.firstChunkAt && content.length > 0) {
                  block.firstChunkAt = now;
                }
                block.content = (block.content || '') + content;
                // 🛡️ 防止 race condition：流式 chunk 延迟到达时覆盖已完成块的终态
                // 若块已标记为 'success' 或 'error'，保留终态不回退为 'running'
                if (block.status !== 'success' && block.status !== 'error') {
                  block.status = 'running';
                }
              }
            }
          }));
        },

        updateBlockStatus: (blockId: string, status: BlockStatus): void => {
          // ✅ CRITICAL-002 修复: 在 batchUpdate 内部完成所有更新
          set((s) => {
            const block = s.blocks.get(blockId);
            if (!block) return {};

            return batchUpdate((draft) => {
              const draftBlock = draft.blocks.get(blockId);
              if (draftBlock) {
                draftBlock.status = status;
                draftBlock.endedAt = status === 'success' || status === 'error' ? Date.now() : undefined;

                // ✅ 健壮性优化：只有块存在时才从活跃集合移除
                if (status === 'success' || status === 'error') {
                  draft.activeBlockIds = removeFromSet(draft.activeBlockIds, blockId);
                }
              }
            })(s);
          });
        },

        setBlockResult: (blockId: string, result: unknown): void => {
          // ✅ CRITICAL-002 修复: 在 batchUpdate 内部完成所有更新
          set((s) => {
            const block = s.blocks.get(blockId);
            if (!block) return {};

            // 🔧 2026-01-18 修复：统一 toolOutput 结构
            // 后端 emit_end 发送 { result: output, durationMs: ... }
            // 但数据库保存的是直接的 output
            // 这里提取 result.result（如果存在），保持与数据库加载一致
            let toolOutput = result;
            if (result && typeof result === 'object' && 'result' in result) {
              toolOutput = (result as { result: unknown }).result;
            }

            return batchUpdate((draft) => {
              const draftBlock = draft.blocks.get(blockId);
              if (draftBlock) {
                draftBlock.toolOutput = toolOutput;
                // 🔧 L-013 修复：检查 toolOutput 是否包含错误标记
                // 后端 tool executor 成功返回的结果中可能带有 success: false 或 error 字段
                const hasError = toolOutput && typeof toolOutput === 'object' && (
                  'error' in (toolOutput as Record<string, unknown>) ||
                  (toolOutput as Record<string, unknown>).success === false
                );
                draftBlock.status = hasError ? 'error' : 'success';
                draftBlock.endedAt = Date.now();
                // ✅ 健壮性优化：只有块存在时才从活跃集合移除
                draft.activeBlockIds = removeFromSet(draft.activeBlockIds, blockId);
              }
            })(s);
          });
        },

        setBlockError: (blockId: string, error: string): void => {
          // ✅ CRITICAL-002 修复: 在 batchUpdate 内部完成所有更新
          set((s) => {
            const block = s.blocks.get(blockId);
            if (!block) return {};

            return batchUpdate((draft) => {
              const draftBlock = draft.blocks.get(blockId);
              if (draftBlock) {
                draftBlock.error = error;
                draftBlock.status = 'error';
                draftBlock.endedAt = Date.now();
                // ✅ 健壮性优化：只有块存在时才从活跃集合移除
                draft.activeBlockIds = removeFromSet(draft.activeBlockIds, blockId);
              }
            })(s);
          });
        },

        updateBlock: (blockId: string, updates: Partial<Block>): void => {
          // ✅ P0-006: 使用 immer 优化
          set(updateSingleBlock(blockId, (draft) => {
            Object.assign(draft, updates);
          }));
        },

        // 🆕 2026-01-17: 删除块（从 blocks Map、消息 blockIds、activeBlockIds 中移除）
        deleteBlock: (blockId: string): void => {
          const state = getState();
          const block = state.blocks.get(blockId);
          if (!block) {
            console.warn(`[ChatStore] deleteBlock: block ${blockId} not found`);
            return;
          }

          console.log(`[ChatStore] deleteBlock: removing block ${blockId} from message ${block.messageId}`);

          set((s) => {
            const newBlocks = new Map(s.blocks);
            newBlocks.delete(blockId);

            const newMessageMap = new Map(s.messageMap);
            const message = newMessageMap.get(block.messageId);
            if (message) {
              newMessageMap.set(block.messageId, {
                ...message,
                blockIds: message.blockIds.filter((id) => id !== blockId),
              });
            }

            return {
              blocks: newBlocks,
              messageMap: newMessageMap,
              activeBlockIds: removeFromSet(s.activeBlockIds, blockId),
            };
          });
        },

        // 🆕 2026-02-16: 原地替换块 ID（保持 blockIds 顺序不变）
        // 用于 preparing 块 → 执行块的转换，避免 deleteBlock+createBlock 破坏顺序
        replaceBlockId: (oldBlockId: string, newBlockId: string): void => {
          const state = getState();
          const block = state.blocks.get(oldBlockId);
          if (!block) {
            console.warn(`[ChatStore] replaceBlockId: old block ${oldBlockId} not found`);
            return;
          }

          console.log(`[ChatStore] replaceBlockId: ${oldBlockId} → ${newBlockId} (in-place)`);

          set((s) => {
            // 1. blocks Map: 删除旧 key，插入新 key（保留块数据）
            const newBlocks = new Map(s.blocks);
            const blockData = newBlocks.get(oldBlockId);
            if (!blockData) return {};

            // 防御：newBlockId 不应已存在（UUID 碰撞极罕见，但避免静默覆盖）
            if (newBlocks.has(newBlockId) && newBlockId !== oldBlockId) {
              console.warn(`[ChatStore] replaceBlockId: newBlockId ${newBlockId} already exists, overwriting`);
            }

            newBlocks.delete(oldBlockId);
            newBlocks.set(newBlockId, { ...blockData, id: newBlockId });

            // 2. message.blockIds: 原地替换，保持顺序
            const newMessageMap = new Map(s.messageMap);
            const message = newMessageMap.get(blockData.messageId);
            if (message) {
              // 2a. 替换 message.blockIds 中的旧 ID
              const newBlockIds = message.blockIds.map((id) => (id === oldBlockId ? newBlockId : id));

              // 2b. 替换 variant.blockIds 中的旧 ID（preparing 块可能在变体中）
              const newVariants = message.variants?.map((v) => {
                if (!v.blockIds.includes(oldBlockId)) return v;
                return {
                  ...v,
                  blockIds: v.blockIds.map((id) => (id === oldBlockId ? newBlockId : id)),
                };
              });

              newMessageMap.set(blockData.messageId, {
                ...message,
                blockIds: newBlockIds,
                ...(newVariants ? { variants: newVariants } : {}),
              });
            }

            // 3. activeBlockIds: 替换
            const newActiveBlockIds = new Set(s.activeBlockIds);
            if (newActiveBlockIds.has(oldBlockId)) {
              newActiveBlockIds.delete(oldBlockId);
              newActiveBlockIds.add(newBlockId);
            }

            return {
              blocks: newBlocks,
              messageMap: newMessageMap,
              activeBlockIds: newActiveBlockIds,
            };
          });
        },

        // 🆕 2026-01-15: 设置工具调用准备中状态
        setPreparingToolCall: (
          messageId: string,
          info: { toolCallId: string; toolName: string }
        ): void => {
          console.log(
            `[ChatStore] Setting preparing tool call: ${info.toolName} (id: ${info.toolCallId}) for message: ${messageId}`
          );
          // 在消息元数据中存储准备中的工具调用信息
          // 这允许 UI 显示"正在准备工具调用: xxx"
          const state = getState();
          const message = state.messageMap.get(messageId);
          if (message) {
            set((s) => {
              const newMessageMap = new Map(s.messageMap);
              const msg = newMessageMap.get(messageId);
              if (msg) {
                newMessageMap.set(messageId, {
                  ...msg,
                  _meta: {
                    ...msg._meta,
                    preparingToolCall: info,
                  },
                });
              }
              return { messageMap: newMessageMap };
            });
          }
        },

        // 🆕 2026-01-15: 清除工具调用准备中状态
        clearPreparingToolCall: (messageId: string): void => {
          const state = getState();
          const message = state.messageMap.get(messageId);
          if (message && message._meta?.preparingToolCall) {
            set((s) => {
              const newMessageMap = new Map(s.messageMap);
              const msg = newMessageMap.get(messageId);
              if (msg) {
                const newMeta = { ...msg._meta };
                delete newMeta.preparingToolCall;
                newMessageMap.set(messageId, {
                  ...msg,
                  _meta: newMeta,
                });
              }
              return { messageMap: newMessageMap };
            });
          }
        },

        // ========== 流式追踪 Actions ==========

        setCurrentStreamingMessage: (messageId: string | null): void => {
          set({ currentStreamingMessageId: messageId });
        },

        addActiveBlock: (blockId: string): void => {
          // ✅ P0-006: 使用优化的 Set 操作，避免不必要的复制
          set((s) => ({
            activeBlockIds: addToSet(s.activeBlockIds, blockId),
          }));
        },

        removeActiveBlock: (blockId: string): void => {
          // ✅ P0-006: 使用优化的 Set 操作，避免不必要的复制
          set((s) => ({
            activeBlockIds: removeFromSet(s.activeBlockIds, blockId),
          }));
        },
  };
}
