/**
 * Chat V2 - 变体 (Variant) 相关 Actions
 *
 * 实现多模型并行变体的管理方法。
 * 核心原则：隔离优先 - 每个变体是完全独立的 LLM 执行上下文。
 */

import type { Message, Variant, VariantStatus } from '../types/message';
import type { Block } from '../types/block';
import type { TokenUsage } from '../types/common';
import { getErrorMessage } from '../../../utils/errorUtils';
import { showGlobalNotification } from '../../../components/UnifiedNotification';
import i18n from 'i18next';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 后端变体事件
 */
export interface BackendVariantEvent {
  type: string;
  messageId?: string;
  variantId?: string;
  modelId?: string;
  status?: VariantStatus;
  error?: string;
  sequenceId?: number;
  /** Token 使用统计（variant_end 事件携带） */
  usage?: TokenUsage;
}

/**
 * 变体 Actions 接口
 */
export interface VariantActions {
  // ========== 变体管理 ==========

  /** 切换激活的变体 (乐观更新 + 150ms 防抖) */
  switchVariant(messageId: string, variantId: string): Promise<void>;

  /** 删除变体 */
  deleteVariant(messageId: string, variantId: string): Promise<void>;

  /** 重试变体 */
  retryVariant(
    messageId: string,
    variantId: string,
    modelOverride?: string
  ): Promise<void>;

  /** 取消变体 */
  cancelVariant(variantId: string): Promise<void>;

  /** 重试所有变体（重新生成所有变体的回复） */
  retryAllVariants(messageId: string): Promise<void>;

  // ========== 后端事件处理 ==========

  /** 处理变体开始事件 */
  handleVariantStart(event: BackendVariantEvent): void;

  /** 处理变体结束事件 */
  handleVariantEnd(event: BackendVariantEvent): void;

  // ========== Block 归属 ==========

  /** 将 block 添加到变体 */
  addBlockToVariant(
    messageId: string,
    variantId: string,
    blockId: string
  ): void;

  /** 将 block 添加到消息 (单变体兼容) */
  addBlockToMessage(messageId: string, blockId: string): void;

  // ========== 查询方法 ==========

  /** 获取激活的变体 */
  getActiveVariant(messageId: string): Variant | undefined;

  /** 获取消息的所有变体 */
  getVariants(messageId: string): Variant[];

  /** 判断是否为多变体消息 */
  isMultiVariantMessage(messageId: string): boolean;

  /** 获取显示的 blockIds (考虑变体) */
  getDisplayBlockIds(messageId: string): string[];
}

/**
 * 变体相关的 Store 状态
 */
export interface VariantState {
  /** 正在流式的变体 ID 集合 */
  streamingVariantIds: Set<string>;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 生成变体 ID
 */
export function generateVariantId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `var_${timestamp}_${random}`;
}

/**
 * 判断变体状态是否可切换
 * - 可切换：pending、streaming、success、cancelled
 * - 不可切换：error
 */
export function canSwitchToVariant(variant: Variant): boolean {
  return variant.status !== 'error';
}

/**
 * 确定 active_variant_id（按优先级）
 * 1. 第一个 success 变体
 * 2. 第一个 cancelled 变体
 * 3. 第一个变体（即使是 error）
 */
export function determineActiveVariantId(variants: Variant[]): string | undefined {
  if (variants.length === 0) return undefined;

  // 优先选择 success
  const successVariant = variants.find((v) => v.status === 'success');
  if (successVariant) return successVariant.id;

  // 其次选择 cancelled
  const cancelledVariant = variants.find((v) => v.status === 'cancelled');
  if (cancelledVariant) return cancelledVariant.id;

  // 兜底：第一个变体
  return variants[0].id;
}

// ============================================================================
// 防抖工具
// ============================================================================

/** 防抖定时器存储 */
const switchVariantDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * 清理指定消息的防抖定时器（P1 内存泄漏修复）
 */
export function clearVariantDebounceTimer(messageId: string): void {
  const existingTimer = switchVariantDebounceTimers.get(messageId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    switchVariantDebounceTimers.delete(messageId);
  }
}

/**
 * 清理指定会话的所有防抖定时器（单会话销毁/驱逐时调用）
 *
 * Timer keys use the format `sessionId:messageId`, so we iterate and
 * clear only entries belonging to the given session.
 */
export function clearVariantDebounceTimersForSession(sessionId: string): void {
  const prefix = `${sessionId}:`;
  for (const [key, timer] of switchVariantDebounceTimers.entries()) {
    if (key.startsWith(prefix)) {
      clearTimeout(timer);
      switchVariantDebounceTimers.delete(key);
    }
  }
}

/**
 * 清理所有防抖定时器（全部会话销毁时调用）
 */
export function clearAllVariantDebounceTimers(): void {
  for (const timer of switchVariantDebounceTimers.values()) {
    clearTimeout(timer);
  }
  switchVariantDebounceTimers.clear();
}

/**
 * 防抖执行切换变体的后端同步
 */
export function debouncedSwitchVariantBackend(
  sessionId: string,
  messageId: string,
  variantId: string,
  callback: () => Promise<void>,
  delay: number = 150
): void {
  const key = `${sessionId}:${messageId}`;

  // 清除之前的定时器
  const existingTimer = switchVariantDebounceTimers.get(key);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // 设置新的定时器
  const timer = setTimeout(async () => {
    switchVariantDebounceTimers.delete(key);
    try {
      await callback();
    } catch (error: unknown) {
      console.error('[VariantActions] Debounced backend sync failed:', getErrorMessage(error));
    }
  }, delay);

  switchVariantDebounceTimers.set(key, timer);
}

// ============================================================================
// Actions 工厂
// ============================================================================

/**
 * Store 访问器类型
 */
interface StoreAccessor {
  get: () => {
    messageMap: Map<string, Message>;
    blocks: Map<string, Block>;
    streamingVariantIds: Set<string>;
    sessionId: string;
  };
  set: (
    partial:
      | Partial<{
          messageMap: Map<string, Message>;
          blocks: Map<string, Block>;
          streamingVariantIds: Set<string>;
        }>
      | ((state: {
          messageMap: Map<string, Message>;
          blocks: Map<string, Block>;
          streamingVariantIds: Set<string>;
        }) => Partial<{
          messageMap: Map<string, Message>;
          blocks: Map<string, Block>;
          streamingVariantIds: Set<string>;
        }>)
  ) => void;
}

/**
 * 回调注入类型
 */
interface VariantCallbacks {
  switchVariantCallback?: (
    messageId: string,
    variantId: string
  ) => Promise<void>;
  deleteVariantCallback?: (
    messageId: string,
    variantId: string
  ) => Promise<{ variantDeleted?: boolean; messageDeleted?: boolean; newActiveId?: string }>;
  retryVariantCallback?: (
    messageId: string,
    variantId: string,
    modelOverride?: string
  ) => Promise<void>;
  cancelVariantCallback?: (variantId: string) => Promise<void>;
}

/**
 * 创建变体相关的 Actions
 */
export function createVariantActions(
  store: StoreAccessor,
  callbacks: VariantCallbacks
): VariantActions {
  return {
    // ========== 变体管理 ==========

    switchVariant: async (messageId: string, variantId: string): Promise<void> => {
      const state = store.get();
      const message = state.messageMap.get(messageId);

      if (!message) {
        console.warn('[VariantActions] switchVariant: Message not found:', messageId);
        return;
      }

      // 验证变体存在
      const variant = message.variants?.find((v) => v.id === variantId);
      if (!variant) {
        console.warn('[VariantActions] switchVariant: Variant not found:', variantId);
        return;
      }

      // 验证变体状态可切换（error 状态不可切换）
      if (!canSwitchToVariant(variant)) {
        const errorMsg = i18n.t('chatV2:variant.cannotActivateFailed');
        showGlobalNotification('warning', errorMsg);
        console.warn('[VariantActions] switchVariant: Cannot switch to error variant:', variantId);
        return;
      }

      // 🆕 保存原始状态用于回滚
      const previousActiveVariantId = message.activeVariantId;

      // 乐观更新：立即更新本地状态
      store.set((s) => {
        const newMessageMap = new Map(s.messageMap);
        const msg = newMessageMap.get(messageId);
        if (msg) {
          newMessageMap.set(messageId, {
            ...msg,
            activeVariantId: variantId,
          });
        }
        return { messageMap: newMessageMap };
      });

      console.log('[VariantActions] switchVariant (optimistic):', messageId, '->', variantId);

      // 防抖同步到后端（含失败回滚）
      if (callbacks.switchVariantCallback) {
        debouncedSwitchVariantBackend(store.get().sessionId, messageId, variantId, async () => {
          try {
            await callbacks.switchVariantCallback!(messageId, variantId);
            console.log('[VariantActions] switchVariant (backend synced):', messageId, '->', variantId);
          } catch (error: unknown) {
            // 🆕 后端失败时回滚本地状态
            console.error('[VariantActions] switchVariant backend failed, rolling back:', getErrorMessage(error));
            store.set((s) => {
              const newMessageMap = new Map(s.messageMap);
              const msg = newMessageMap.get(messageId);
              if (msg) {
                newMessageMap.set(messageId, {
                  ...msg,
                  activeVariantId: previousActiveVariantId,  // 允许 undefined
                });
              }
              return { messageMap: newMessageMap };
            });
            // 显示错误通知
            showGlobalNotification('error', i18n.t('chatV2:variant.switchFailed'));
            throw error; // 重新抛出错误让调用方知道
          }
        });
      }
    },

    deleteVariant: async (messageId: string, variantId: string): Promise<void> => {
      const state = store.get();
      const message = state.messageMap.get(messageId);

      if (!message) {
        console.warn('[VariantActions] deleteVariant: Message not found:', messageId);
        return;
      }

      const variants = message.variants ?? [];
      const variantIndex = variants.findIndex((v) => v.id === variantId);

      if (variantIndex === -1) {
        console.warn('[VariantActions] deleteVariant: Variant not found:', variantId);
        return;
      }

      // 检查是否是最后一个变体
      if (variants.length <= 1) {
        const errorMsg = i18n.t('chatV2:variant.cannotDeleteLast');
        showGlobalNotification('warning', errorMsg);
        console.warn('[VariantActions] deleteVariant: Cannot delete last variant');
        return;
      }

      const variantToDelete = variants[variantIndex];
      const blockIdsToDelete = variantToDelete.blockIds;

      // 调用后端删除
      if (callbacks.deleteVariantCallback) {
        try {
          const result = await callbacks.deleteVariantCallback(messageId, variantId);

          if (result.messageDeleted) {
            // 消息被删除（理论上不应该发生，因为我们已经检查了）
            console.warn('[VariantActions] deleteVariant: Message was deleted');
            return;
          }

          // 更新本地状态
          store.set((s) => {
            const newMessageMap = new Map(s.messageMap);
            const newBlocks = new Map(s.blocks);
            const newStreamingVariantIds = new Set(s.streamingVariantIds);

            const msg = newMessageMap.get(messageId);
            if (msg) {
              const newVariants = (msg.variants ?? []).filter((v) => v.id !== variantId);
              const newActiveId = result.newActiveId ?? determineActiveVariantId(newVariants);

              newMessageMap.set(messageId, {
                ...msg,
                variants: newVariants,
                activeVariantId: newActiveId,
              });
            }

            // 清理 blocks
            for (const blockId of blockIdsToDelete) {
              newBlocks.delete(blockId);
            }

            // 从 streamingVariantIds 中移除已删除的变体
            newStreamingVariantIds.delete(variantId);

            return { messageMap: newMessageMap, blocks: newBlocks, streamingVariantIds: newStreamingVariantIds };
          });

          console.log('[VariantActions] deleteVariant completed:', variantId);
        } catch (error: unknown) {
          const errorMsg = getErrorMessage(error);
          console.error('[VariantActions] deleteVariant failed:', errorMsg);
          showGlobalNotification('error', i18n.t('chatV2:variant.deleteFailed') + ': ' + errorMsg);
          throw error;
        }
      }
    },

    retryVariant: async (
      messageId: string,
      variantId: string,
      modelOverride?: string
    ): Promise<void> => {
      const state = store.get();
      const message = state.messageMap.get(messageId);

      if (!message) {
        console.warn('[VariantActions] retryVariant: Message not found:', messageId);
        return;
      }

      const variant = message.variants?.find((v) => v.id === variantId);
      if (!variant) {
        console.warn('[VariantActions] retryVariant: Variant not found:', variantId);
        return;
      }

      // 只能重试 error 或 cancelled 状态的变体
      if (variant.status !== 'error' && variant.status !== 'cancelled') {
        console.warn('[VariantActions] retryVariant: Can only retry error/cancelled variants');
        return;
      }

      if (callbacks.retryVariantCallback) {
        try {
          // 重置变体状态为 pending，清空旧 blocks
          store.set((s) => {
            const newMessageMap = new Map(s.messageMap);
            const newBlocks = new Map(s.blocks);
            const newStreamingVariantIds = new Set(s.streamingVariantIds);

            const msg = newMessageMap.get(messageId);
            if (msg) {
              const newVariants = (msg.variants ?? []).map((v) =>
                v.id === variantId
                  ? { ...v, status: 'pending' as VariantStatus, error: undefined, blockIds: [] }
                  : v
              );

              // 清理旧的 blocks
              for (const blockId of variant.blockIds) {
                newBlocks.delete(blockId);
              }

              newMessageMap.set(messageId, {
                ...msg,
                variants: newVariants,
              });
            }

            newStreamingVariantIds.add(variantId);

            return {
              messageMap: newMessageMap,
              blocks: newBlocks,
              streamingVariantIds: newStreamingVariantIds,
            };
          });

          await callbacks.retryVariantCallback(messageId, variantId, modelOverride);
          console.log('[VariantActions] retryVariant started:', variantId);
        } catch (error: unknown) {
          const errorMsg = getErrorMessage(error);
          console.error('[VariantActions] retryVariant failed:', errorMsg);

          // 恢复错误状态
          store.set((s) => {
            const newMessageMap = new Map(s.messageMap);
            const newStreamingVariantIds = new Set(s.streamingVariantIds);

            const msg = newMessageMap.get(messageId);
            if (msg) {
              const newVariants = (msg.variants ?? []).map((v) =>
                v.id === variantId
                  ? { ...v, status: 'error' as VariantStatus, error: errorMsg }
                  : v
              );
              newMessageMap.set(messageId, { ...msg, variants: newVariants });
            }

            newStreamingVariantIds.delete(variantId);

            return {
              messageMap: newMessageMap,
              streamingVariantIds: newStreamingVariantIds,
            };
          });

          showGlobalNotification('error', i18n.t('chatV2:variant.retryFailed') + ': ' + errorMsg);
          throw error;
        }
      }
    },

    cancelVariant: async (variantId: string): Promise<void> => {
      if (callbacks.cancelVariantCallback) {
        try {
          await callbacks.cancelVariantCallback(variantId);
          console.log('[VariantActions] cancelVariant:', variantId);
        } catch (error: unknown) {
          console.error('[VariantActions] cancelVariant failed:', getErrorMessage(error));
          throw error;
        }
      }
    },

    retryAllVariants: async (messageId: string): Promise<void> => {
      const state = store.get();
      const message = state.messageMap.get(messageId);

      if (!message) {
        console.warn('[VariantActions] retryAllVariants: Message not found:', messageId);
        return;
      }

      const variants = message.variants ?? [];
      if (variants.length === 0) {
        console.warn('[VariantActions] retryAllVariants: No variants found');
        return;
      }

      // 筛选可重试的变体（error 或 cancelled 状态）
      const retryableVariants = variants.filter(
        (v) => v.status === 'error' || v.status === 'cancelled'
      );

      if (retryableVariants.length === 0) {
        // 如果没有可重试的变体，则重试所有已完成的变体
        const completedVariants = variants.filter(
          (v) => v.status === 'success'
        );
        if (completedVariants.length > 0) {
          console.log('[VariantActions] retryAllVariants: Retrying all completed variants');
          // 并行重试所有已完成的变体
          await Promise.allSettled(
            completedVariants.map(async (v) => {
              if (callbacks.retryVariantCallback) {
                // 先重置状态为 pending
                store.set((s) => {
                  const newMessageMap = new Map(s.messageMap);
                  const newBlocks = new Map(s.blocks);
                  const newStreamingVariantIds = new Set(s.streamingVariantIds);

                  const msg = newMessageMap.get(messageId);
                  if (msg) {
                    const newVariants = (msg.variants ?? []).map((variant) =>
                      variant.id === v.id
                        ? { ...variant, status: 'pending' as VariantStatus, error: undefined, blockIds: [] }
                        : variant
                    );

                    // 清理旧的 blocks
                    for (const blockId of v.blockIds) {
                      newBlocks.delete(blockId);
                    }

                    newMessageMap.set(messageId, {
                      ...msg,
                      variants: newVariants,
                    });
                  }

                  newStreamingVariantIds.add(v.id);

                  return {
                    messageMap: newMessageMap,
                    blocks: newBlocks,
                    streamingVariantIds: newStreamingVariantIds,
                  };
                });

                await callbacks.retryVariantCallback(messageId, v.id);
              }
            })
          );
          console.log('[VariantActions] retryAllVariants completed for all variants');
          return;
        }
        console.warn('[VariantActions] retryAllVariants: No retryable variants');
        return;
      }

      console.log('[VariantActions] retryAllVariants: Retrying', retryableVariants.length, 'variants');

      // 并行重试所有可重试的变体
      await Promise.allSettled(
        retryableVariants.map(async (v) => {
          if (callbacks.retryVariantCallback) {
            // 先重置状态为 pending
            store.set((s) => {
              const newMessageMap = new Map(s.messageMap);
              const newBlocks = new Map(s.blocks);
              const newStreamingVariantIds = new Set(s.streamingVariantIds);

              const msg = newMessageMap.get(messageId);
              if (msg) {
                const newVariants = (msg.variants ?? []).map((variant) =>
                  variant.id === v.id
                    ? { ...variant, status: 'pending' as VariantStatus, error: undefined, blockIds: [] }
                    : variant
                );

                // 清理旧的 blocks
                for (const blockId of v.blockIds) {
                  newBlocks.delete(blockId);
                }

                newMessageMap.set(messageId, {
                  ...msg,
                  variants: newVariants,
                });
              }

              newStreamingVariantIds.add(v.id);

              return {
                messageMap: newMessageMap,
                blocks: newBlocks,
                streamingVariantIds: newStreamingVariantIds,
              };
            });

            await callbacks.retryVariantCallback(messageId, v.id);
          }
        })
      );

      console.log('[VariantActions] retryAllVariants completed');
    },

    // ========== 后端事件处理 ==========

    handleVariantStart: (event: BackendVariantEvent): void => {
      const { messageId, variantId, modelId } = event;
      if (!messageId || !variantId || !modelId) {
        console.warn('[VariantActions] handleVariantStart: Missing required fields');
        return;
      }

      store.set((s) => {
        const newMessageMap = new Map(s.messageMap);
        const newStreamingVariantIds = new Set(s.streamingVariantIds);

        const message = newMessageMap.get(messageId);
        if (message) {
          const existingVariants = message.variants ?? [];
          const existingVariant = existingVariants.find((v) => v.id === variantId);

          if (existingVariant) {
            // 更新现有变体状态
            const newVariants = existingVariants.map((v) =>
              v.id === variantId ? { ...v, status: 'streaming' as VariantStatus } : v
            );
            newMessageMap.set(messageId, { ...message, variants: newVariants });
          } else {
            // 创建新变体
            const newVariant: Variant = {
              id: variantId,
              modelId,
              blockIds: [],
              status: 'streaming',
              createdAt: Date.now(),
            };
            const newVariants = [...existingVariants, newVariant];

            // 如果是第一个变体，设为激活
            const activeVariantId = message.activeVariantId ?? variantId;

            newMessageMap.set(messageId, {
              ...message,
              variants: newVariants,
              activeVariantId,
            });
          }
        }

        newStreamingVariantIds.add(variantId);

        return {
          messageMap: newMessageMap,
          streamingVariantIds: newStreamingVariantIds,
        };
      });

      console.log('[VariantActions] handleVariantStart:', variantId, 'model:', modelId);
    },

    handleVariantEnd: (event: BackendVariantEvent): void => {
      const { variantId, status, error, usage } = event;
      if (!variantId || !status) {
        console.warn('[VariantActions] handleVariantEnd: Missing required fields');
        return;
      }

      store.set((s) => {
        const newMessageMap = new Map(s.messageMap);
        const newStreamingVariantIds = new Set(s.streamingVariantIds);

        // 找到包含此变体的消息
        for (const [msgId, message] of newMessageMap.entries()) {
          const variant = message.variants?.find((v) => v.id === variantId);
          if (variant) {
            const newVariants = (message.variants ?? []).map((v) =>
              v.id === variantId
                ? {
                    ...v,
                    status,
                    error: error ?? undefined,
                    // 🆕 P0修复：存储变体级别的 Token 统计
                    usage: usage ?? v.usage,
                  }
                : v
            );

            // 如果当前激活的是此变体且变成了 error，需要切换到其他可用变体
            let newActiveId = message.activeVariantId;
            if (message.activeVariantId === variantId && status === 'error') {
              newActiveId = determineActiveVariantId(newVariants);
            }

            newMessageMap.set(msgId, {
              ...message,
              variants: newVariants,
              activeVariantId: newActiveId,
            });
            break;
          }
        }

        newStreamingVariantIds.delete(variantId);

        return {
          messageMap: newMessageMap,
          streamingVariantIds: newStreamingVariantIds,
        };
      });

      // 🆕 P0修复：日志中包含 usage 信息
      console.log('[VariantActions] handleVariantEnd:', variantId, 'status:', status, usage ? `tokens: ${usage.totalTokens}` : '');
    },

    // ========== Block 归属 ==========

    addBlockToVariant: (
      messageId: string,
      variantId: string,
      blockId: string
    ): void => {
      store.set((s) => {
        const newMessageMap = new Map(s.messageMap);
        const message = newMessageMap.get(messageId);

        if (message) {
          // 1. 从 message.blockIds 移除该 block（避免重复）
          // createBlockWithId 会先将 block 添加到 message.blockIds，这里需要移除
          const newMessageBlockIds = message.blockIds.filter((id) => id !== blockId);

          // 2. 将 block 添加到 variant.blockIds
          const newVariants = (message.variants ?? []).map((v) => {
            if (v.id === variantId) {
              // 检查是否已存在，避免重复添加
              if (v.blockIds.includes(blockId)) {
                return v;
              }

              // 🔧 直接追加，排序由 getDisplayBlockIds 根据 firstChunkAt 时间戳处理
              return {
                ...v,
                blockIds: [...v.blockIds, blockId],
              };
            }
            return v;
          });

          newMessageMap.set(messageId, {
            ...message,
            blockIds: newMessageBlockIds,  // 更新 message.blockIds（移除已归属到变体的块）
            variants: newVariants,
          });
        }

        return { messageMap: newMessageMap };
      });

      console.log('[VariantActions] addBlockToVariant:', blockId, '->', variantId);
    },

    addBlockToMessage: (messageId: string, blockId: string): void => {
      store.set((s) => {
        const newMessageMap = new Map(s.messageMap);
        const message = newMessageMap.get(messageId);

        if (message) {
          // 🔧 直接追加，排序由 getDisplayBlockIds 根据 firstChunkAt 时间戳处理
          newMessageMap.set(messageId, {
            ...message,
            blockIds: [...message.blockIds, blockId],
          });
        }

        return { messageMap: newMessageMap };
      });

      console.log('[VariantActions] addBlockToMessage:', blockId, '->', messageId);
    },

    // ========== 查询方法 ==========

    getActiveVariant: (messageId: string): Variant | undefined => {
      const state = store.get();
      const message = state.messageMap.get(messageId);

      if (!message || !message.variants || message.variants.length === 0) {
        return undefined;
      }

      return message.variants.find((v) => v.id === message.activeVariantId);
    },

    getVariants: (messageId: string): Variant[] => {
      const state = store.get();
      const message = state.messageMap.get(messageId);
      return message?.variants ?? [];
    },

    /**
     * 判断消息是否为多变体消息
     *
     * 判断标准：variants.length > 1
     * - variants 为 null/undefined：返回 false
     * - variants 为空数组 []：返回 false
     * - variants 只有 1 个元素（单变体重试产生）：返回 false
     * - variants 有 2+ 个元素（真正的多变体）：返回 true
     *
     * 注意：此判断逻辑需与后端 types.rs 的 is_multi_variant() 保持一致
     */
    isMultiVariantMessage: (messageId: string): boolean => {
      const state = store.get();
      const message = state.messageMap.get(messageId);
      return (message?.variants?.length ?? 0) > 1;
    },

    // ================================================================
    // displayBlockIds 计算逻辑（独立模块备用实现）
    // ================================================================
    // 
    // 【注意】此实现与 createChatStore.ts 中的 getDisplayBlockIds 保持一致。
    // 权威实现位于 createChatStore.ts，此处是为了让 createVariantActions
    // 返回的对象可以独立使用（如单元测试）。
    // 
    // 【统一逻辑】（需与后端 types.rs::get_active_block_ids 保持一致）：
    //   1. 无变体时：返回 message.blockIds
    //   2. 有变体时：返回 activeVariant.blockIds
    //   3. 找不到激活变体时：回退到 message.blockIds
    // ================================================================
    getDisplayBlockIds: (messageId: string): string[] => {
      const state = store.get();
      const message = state.messageMap.get(messageId);

      if (!message) {
        return [];
      }

      // 无变体时返回 message.blockIds
      if (!message.variants || message.variants.length === 0) {
        return message.blockIds;
      }

      // 有变体时返回激活变体的 blockIds，找不到时回退到 message.blockIds
      const activeVariant = message.variants.find(
        (v) => v.id === message.activeVariantId
      );

      return activeVariant?.blockIds ?? message.blockIds;
    },
  };
}

// ============================================================================
// 导出
// ============================================================================

export type { VariantCallbacks, StoreAccessor };
