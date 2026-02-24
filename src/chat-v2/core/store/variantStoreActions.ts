import { flushSync } from 'react-dom';
import i18n from 'i18next';
import type { Variant, VariantStatus } from '../types/message';
import type { ChatStore } from '../types';
import type { ChatStoreState, SetState, GetState } from './types';
import {
  type BackendVariantEvent,
  canSwitchToVariant,
  determineActiveVariantId,
  debouncedSwitchVariantBackend,
} from './variantActions';
import { getErrorMessage } from '../../../utils/errorUtils';
import { showGlobalNotification } from '../../../components/UnifiedNotification';
import { logMultiVariant } from '../../../debug-panel/plugins/MultiVariantDebugPlugin';
import { modeRegistry } from '../../registry';
import {
  updateSingleMessage,
  batchUpdate,
  addToSet,
  removeFromSet,
  addMultipleToSet,
  removeMultipleFromSet,
} from './immerHelpers';
import { debugLog } from '../../../debug-panel/debugMasterSwitch';
import { showOperationLockNotification } from './createChatStore';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

export function createVariantStoreActions(
  set: SetState,
  getState: GetState,
) {
  return {
        switchVariant: async (messageId: string, variantId: string): Promise<void> => {
          const state = getState();
          const message = state.messageMap.get(messageId);

          if (!message) {
            console.warn('[ChatStore] switchVariant: Message not found:', messageId);
            return;
          }

          const variant = message.variants?.find((v) => v.id === variantId);
          if (!variant) {
            console.warn('[ChatStore] switchVariant: Variant not found:', variantId);
            return;
          }

          // 验证变体状态可切换（error 状态不可切换）
          if (!canSwitchToVariant(variant)) {
            const errorMsg = i18n.t('chatV2:variant.cannotActivateFailed');
            showGlobalNotification('warning', errorMsg);
            console.warn('[ChatStore] switchVariant: Cannot switch to error variant:', variantId);
            return;
          }

          // ✅ P0-006: 使用 immer 优化乐观更新
          set(updateSingleMessage(messageId, (draft) => {
            draft.activeVariantId = variantId;
          }));

          console.log('[ChatStore] switchVariant (optimistic):', messageId, '->', variantId);

          // 防抖同步到后端
          const switchCallback = (getState() as ChatStoreState & ChatStore & {
            _switchVariantCallback?: ((messageId: string, variantId: string) => Promise<void>) | null
          })._switchVariantCallback;

          if (switchCallback) {
            const { sessionId } = getState();
            debouncedSwitchVariantBackend(sessionId, messageId, variantId, async () => {
              await switchCallback(messageId, variantId);
              console.log('[ChatStore] switchVariant (backend synced):', messageId, '->', variantId);
            });
          }
        },

        deleteVariant: async (messageId: string, variantId: string): Promise<void> => {
          const state = getState();
          const message = state.messageMap.get(messageId);

          if (!message) {
            console.warn('[ChatStore] deleteVariant: Message not found:', messageId);
            return;
          }

          const variants = message.variants ?? [];
          const variantIndex = variants.findIndex((v) => v.id === variantId);

          if (variantIndex === -1) {
            console.warn('[ChatStore] deleteVariant: Variant not found:', variantId);
            return;
          }

          // 检查是否是最后一个变体
          if (variants.length <= 1) {
            const errorMsg = i18n.t('chatV2:variant.cannotDeleteLast');
            showGlobalNotification('warning', errorMsg);
            console.warn('[ChatStore] deleteVariant: Cannot delete last variant');
            return;
          }

          const variantToDelete = variants[variantIndex];
          const blockIdsToDelete = variantToDelete.blockIds;

          const deleteCallback = (getState() as ChatStoreState & ChatStore & {
            _deleteVariantCallback?: ((
              messageId: string,
              variantId: string
            ) => Promise<{ variantDeleted?: boolean; messageDeleted?: boolean; newActiveId?: string }>) | null
          })._deleteVariantCallback;

          if (deleteCallback) {
            try {
              const result = await deleteCallback(messageId, variantId);

              if (result.messageDeleted) {
                console.warn('[ChatStore] deleteVariant: Message was deleted');
                return;
              }

              // ✅ P0-006: 使用 immer 优化批量删除操作
              set(batchUpdate((draft) => {
                const msg = draft.messageMap.get(messageId);
                if (msg) {
                  msg.variants = (msg.variants ?? []).filter((v) => v.id !== variantId);
                  msg.activeVariantId = result.newActiveId ?? determineActiveVariantId(msg.variants);

                  // 🔧 P2修复：从 msg.blockIds 中移除已删除的块 ID
                  msg.blockIds = (msg.blockIds ?? []).filter(
                    (id) => !blockIdsToDelete.includes(id)
                  );

                  // 🆕 轻微修复：同步更新 _meta.modelId（避免删除变体后模型头像滞留）
                  const activeVariant = msg.variants?.find((v) => v.id === msg.activeVariantId);
                  if (activeVariant) {
                    if (!msg._meta) {
                      msg._meta = {};
                    }
                    msg._meta.modelId = activeVariant.modelId;
                  }
                }

                // 清理 blocks
                for (const blockId of blockIdsToDelete) {
                  draft.blocks.delete(blockId);
                }
              }));

              console.log('[ChatStore] deleteVariant completed:', variantId);
            } catch (error) {
              const errorMsg = getErrorMessage(error);
              console.error('[ChatStore] deleteVariant failed:', errorMsg);
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
          const state = getState();
          const message = state.messageMap.get(messageId);

          if (!message) {
            console.warn('[ChatStore] retryVariant: Message not found:', messageId);
            return;
          }

          const variant = message.variants?.find((v) => v.id === variantId);
          if (!variant) {
            console.warn('[ChatStore] retryVariant: Variant not found:', variantId);
            return;
          }

          // 只能重试 error 或 cancelled 状态的变体
          if (variant.status !== 'error' && variant.status !== 'cancelled') {
            console.warn('[ChatStore] retryVariant: Can only retry error/cancelled variants');
            return;
          }

          // 🆕 P1修复：检查操作锁（与 retryMessage 保持一致）
          if (state.messageOperationLock) {
            console.warn('[ChatStore] retryVariant: Operation in progress, ignoring:', state.messageOperationLock);
            showOperationLockNotification();
            return;
          }

          // 🆕 P1修复：调用模式插件的 onSendMessage 钩子
          // 重试变体时也需要检查模式约束（如 OCR 进行中时阻止重试）
          // 使用 getResolved 确保继承链上的 onSendMessage 不被遗漏
          const modePlugin = modeRegistry.getResolved(state.mode);
          if (modePlugin?.onSendMessage) {
            // 获取前一条用户消息的内容
            const msgIndex = state.messageOrder.indexOf(messageId);
            const prevUserMsgId = msgIndex > 0 ? state.messageOrder[msgIndex - 1] : null;
            const prevUserMsg = prevUserMsgId ? state.messageMap.get(prevUserMsgId) : null;
            const userContent = prevUserMsg?.role === 'user'
              ? state.blocks.get(prevUserMsg.blockIds.find(id => state.blocks.get(id)?.type === 'content') || '')?.content || ''
              : '';
            // 让错误向上传播，阻止重试
            modePlugin.onSendMessage(state, userContent);
          }

          // 🆕 P1修复补充：设置操作锁（防止重试期间删除消息等操作）
          // 使用 'retry' 类型，与 retryMessage 保持一致
          set({ messageOperationLock: { messageId, operation: 'retry' } });

          // 🔧 补充：变体重试期间进入 streaming，避免并发发送
          set({ sessionStatus: 'streaming', currentStreamingMessageId: messageId });

          const retryCallback = (getState() as ChatStoreState & ChatStore & {
            _retryVariantCallback?: ((
              messageId: string,
              variantId: string,
              modelOverride?: string
            ) => Promise<void>) | null
          })._retryVariantCallback;

          if (retryCallback) {
            try {
              // ✅ CRITICAL-002 修复: 在 batchUpdate 内部完成所有更新
              const oldBlockIds = variant.blockIds;
              set(batchUpdate((draft) => {
                const msg = draft.messageMap.get(messageId);
                if (msg) {
                  const variantIndex = msg.variants?.findIndex((v) => v.id === variantId) ?? -1;
                  if (variantIndex !== -1 && msg.variants) {
                    msg.variants[variantIndex].status = 'pending';
                    msg.variants[variantIndex].error = undefined;
                    msg.variants[variantIndex].blockIds = [];
                  }

                  // 清理旧的 blocks
                  for (const blockId of oldBlockIds) {
                    draft.blocks.delete(blockId);
                  }
                }

                // 在 draft 内部更新 streamingVariantIds
                draft.streamingVariantIds = addToSet(draft.streamingVariantIds, variantId);
              }));

              await retryCallback(messageId, variantId, modelOverride);
              console.log('[ChatStore] retryVariant started:', variantId);
            } catch (error) {
              const errorMsg = getErrorMessage(error);
              console.error('[ChatStore] retryVariant failed:', errorMsg);

              // ✅ CRITICAL-002 修复: 在 batchUpdate 内部完成所有更新
              set(batchUpdate((draft) => {
                const msg = draft.messageMap.get(messageId);
                if (msg) {
                  const variantIndex = msg.variants?.findIndex((v) => v.id === variantId) ?? -1;
                  if (variantIndex !== -1 && msg.variants) {
                    msg.variants[variantIndex].status = 'error';
                    msg.variants[variantIndex].error = errorMsg;
                  }
                }

                // 在 draft 内部更新 streamingVariantIds
                draft.streamingVariantIds = removeFromSet(draft.streamingVariantIds, variantId);
              }));

              // 后端调用失败时，恢复到 idle
              set({ sessionStatus: 'idle', currentStreamingMessageId: null, activeBlockIds: new Set() });
              showGlobalNotification('error', i18n.t('chatV2:variant.retryFailed') + ': ' + errorMsg);
              throw error;
            } finally {
              // 🔧 P1修复：统一使用 finally 释放操作锁，确保任何情况下都能正确释放
              set({ messageOperationLock: null });
            }
          } else {
            console.warn('[ChatStore] retryVariant: No retryVariant callback set. Use setRetryVariantCallback() to inject backend logic.');
            // 释放锁并恢复状态，避免永久阻塞
            set({ messageOperationLock: null, sessionStatus: 'idle', currentStreamingMessageId: null });
          }
        },

        cancelVariant: async (variantId: string): Promise<void> => {
          // 🔧 P0 修复：乐观更新——立即将 variant 标记为 cancelled 并从 streamingVariantIds 移除
          // 解决后端找不到活跃流时静默返回 Ok 导致前端状态永久卡在 streaming 的问题
          // 与后续 variant_end 事件兼容（handleVariantEnd 是幂等的）
          set((s) => {
            return batchUpdate((draft) => {
              // 找到包含此变体的消息
              for (const [, message] of draft.messageMap.entries()) {
                const variant = message.variants?.find((v) => v.id === variantId);
                if (variant && (variant.status === 'streaming' || variant.status === 'pending')) {
                  variant.status = 'cancelled' as VariantStatus;
                  // 将该变体内 running 状态的块标记为 error，并从 activeBlockIds 移除
                  // （与 handleVariantEnd 的块清理逻辑对齐）
                  for (const blockId of variant.blockIds) {
                    const block = draft.blocks.get(blockId);
                    if (block && block.status === 'running') {
                      block.status = 'error';
                      block.error = 'cancelled';
                      block.endedAt = Date.now();
                      draft.activeBlockIds = removeFromSet(draft.activeBlockIds, blockId);
                    }
                  }
                  // 从 streamingVariantIds 移除
                  draft.streamingVariantIds = removeFromSet(draft.streamingVariantIds, variantId);
                  // 如果所有变体都结束了，恢复 sessionStatus 到 idle
                  if (draft.streamingVariantIds.size === 0 && draft.sessionStatus === 'streaming') {
                    draft.sessionStatus = 'idle';
                    draft.currentStreamingMessageId = null;
                    draft.activeBlockIds = new Set();
                  }
                  break;
                }
              }
            })(s);
          });

          const cancelCallback = (getState() as ChatStoreState & ChatStore & {
            _cancelVariantCallback?: ((variantId: string) => Promise<void>) | null
          })._cancelVariantCallback;

          if (cancelCallback) {
            try {
              await cancelCallback(variantId);
              console.log('[ChatStore] cancelVariant:', variantId);
            } catch (error) {
              // 后端调用失败不回滚：变体可能已自然结束，乐观更新状态仍然正确
              console.error('[ChatStore] cancelVariant backend call failed (non-fatal):', getErrorMessage(error));
            }
          }
        },

        retryAllVariants: async (messageId: string): Promise<void> => {
          const state = getState();

          // 🆕 P1修复：检查操作锁（避免并发操作）
          if (state.messageOperationLock) {
            console.warn('[ChatStore] retryAllVariants: Operation in progress, ignoring:', state.messageOperationLock);
            showOperationLockNotification();
            return;
          }

          const message = state.messageMap.get(messageId);

          if (!message) {
            console.warn('[ChatStore] retryAllVariants: Message not found:', messageId);
            return;
          }

          const variants = message.variants ?? [];
          if (variants.length === 0) {
            console.warn('[ChatStore] retryAllVariants: No variants found');
            return;
          }

          // 筛选可重试的变体（优先 error/cancelled，否则 success）
          const retryableVariants = variants.filter(
            (v) => v.status === 'error' || v.status === 'cancelled'
          );
          const fallbackVariants = retryableVariants.length === 0
            ? variants.filter((v) => v.status === 'success')
            : [];
          const targetVariants = retryableVariants.length > 0 ? retryableVariants : fallbackVariants;

          if (targetVariants.length === 0) {
            console.warn('[ChatStore] retryAllVariants: No retryable variants');
            return;
          }

          // 🆕 P1修复：调用模式插件的 onSendMessage 钩子（与 retryVariant 保持一致）
          // 使用 getResolved 确保继承链上的 onSendMessage 不被遗漏
          const modePlugin = modeRegistry.getResolved(state.mode);
          if (modePlugin?.onSendMessage) {
            const msgIndex = state.messageOrder.indexOf(messageId);
            const prevUserMsgId = msgIndex > 0 ? state.messageOrder[msgIndex - 1] : null;
            const prevUserMsg = prevUserMsgId ? state.messageMap.get(prevUserMsgId) : null;
            const userContent = prevUserMsg?.role === 'user'
              ? state.blocks.get(prevUserMsg.blockIds.find(id => state.blocks.get(id)?.type === 'content') || '')?.content || ''
              : '';
            modePlugin.onSendMessage(state, userContent);
          }

          const retryAllCallback = (getState() as ChatStoreState & ChatStore & {
            _retryAllVariantsCallback?: ((messageId: string, variantIds: string[]) => Promise<void>) | null
          })._retryAllVariantsCallback;

          if (!retryAllCallback) {
            console.warn(
              '[ChatStore] retryAllVariants: No retryAllVariants callback set. Use setRetryAllVariantsCallback() to inject backend logic.'
            );
            return;
          }

          const variantIds = targetVariants.map((variant) => variant.id);

          console.log('[ChatStore] retryAllVariants: Retrying', variantIds.length, 'variants');

          // 使用单一锁，避免批量重试被阻塞
          set({ messageOperationLock: { messageId, operation: 'retry' } });
          // 🔧 补充：批量重试期间进入 streaming，避免并发发送
          set({ sessionStatus: 'streaming', currentStreamingMessageId: messageId });

          try {
            // 重置目标变体状态并清理旧块
            set(batchUpdate((draft) => {
              const msg = draft.messageMap.get(messageId);
              if (!msg || !msg.variants) return;

              const targetSet = new Set(variantIds);
              for (const variant of msg.variants) {
                if (!targetSet.has(variant.id)) continue;

                const oldBlockIds = variant.blockIds;
                variant.status = 'pending';
                variant.error = undefined;
                variant.blockIds = [];

                for (const blockId of oldBlockIds) {
                  draft.blocks.delete(blockId);
                }
              }

              draft.streamingVariantIds = addMultipleToSet(draft.streamingVariantIds, variantIds);
            }));

            await retryAllCallback(messageId, variantIds);
            console.log('[ChatStore] retryAllVariants completed');
          } catch (error) {
            const errorMsg = getErrorMessage(error);
            console.error('[ChatStore] retryAllVariants failed:', errorMsg);

            set(batchUpdate((draft) => {
              const msg = draft.messageMap.get(messageId);
              if (!msg || !msg.variants) return;

              const targetSet = new Set(variantIds);
              for (const variant of msg.variants) {
                if (!targetSet.has(variant.id)) continue;
                variant.status = 'error';
                variant.error = errorMsg;
              }

              draft.streamingVariantIds = removeMultipleFromSet(draft.streamingVariantIds, variantIds);
            }));

            set({ sessionStatus: 'idle', currentStreamingMessageId: null, activeBlockIds: new Set() });
            showGlobalNotification('error', i18n.t('chatV2:variant.retryFailed') + ': ' + errorMsg);
            throw error;
          } finally {
            set({ messageOperationLock: null });
          }
        },

        handleVariantStart: (event: BackendVariantEvent): void => {
          const { messageId, variantId, modelId } = event;
          
          logMultiVariant('store', 'handleVariantStart_called', {
            messageId,
            variantId,
            modelId,
          }, 'info');

          if (!messageId || !variantId || !modelId) {
            logMultiVariant('store', 'handleVariantStart_missing_fields', {
              messageId,
              variantId,
              modelId,
            }, 'error');
            return;
          }

          // ✅ CRITICAL-002 修复: 在 batchUpdate 内部完成所有更新
          set((s) => {
            const message = s.messageMap.get(messageId);

            logMultiVariant('store', 'handleVariantStart_message_lookup', {
              messageId,
              messageFound: !!message,
              existingVariantsCount: message?.variants?.length ?? 0,
              currentActiveVariantId: message?.activeVariantId,
            }, message ? 'info' : 'warning');

            if (!message) {
              // 🆕 防御性：消息不存在时创建占位消息 + 变体
              const placeholderMessage = {
                id: messageId,
                role: 'assistant' as const,
                blockIds: [] as string[],
                timestamp: Date.now(),
                activeVariantId: variantId,
                variants: [
                  {
                    id: variantId,
                    modelId,
                    blockIds: [] as string[],
                    status: 'streaming' as VariantStatus,
                    createdAt: Date.now(),
                  },
                ],
                _meta: { modelId },
              };

              const newMessageMap = new Map(s.messageMap).set(messageId, placeholderMessage);
              const newMessageOrder = s.messageOrder.includes(messageId)
                ? s.messageOrder
                : [...s.messageOrder, messageId];

              return {
                sessionStatus: 'streaming' as const,
                currentStreamingMessageId: messageId,
                messageMap: newMessageMap,
                messageOrder: newMessageOrder,
                streamingVariantIds: addToSet(s.streamingVariantIds, variantId),
              };
            }

            const existingVariants = message.variants ?? [];
            const existingVariant = existingVariants.find((v) => v.id === variantId);

            return batchUpdate((draft) => {
              const msg = draft.messageMap.get(messageId);
              if (!msg) return;

              if (existingVariant) {
                // 更新现有变体状态
                const variantIndex = msg.variants!.findIndex((v) => v.id === variantId);
                if (variantIndex !== -1) {
                  msg.variants![variantIndex].status = 'streaming';
                  // 🔧 修复：更新变体的 modelId（重试时可能使用不同模型）
                  msg.variants![variantIndex].modelId = modelId;
                }
                // 🔧 修复：如果是当前激活的变体，同步更新消息的 _meta.modelId
                // 解决重试时模型图标显示为空的问题
                if (msg.activeVariantId === variantId) {
                  if (!msg._meta) {
                    msg._meta = {};
                  }
                  msg._meta.modelId = modelId;
                }
                logMultiVariant('store', 'handleVariantStart_update_existing', {
                  variantId,
                  modelId,
                  newStatus: 'streaming',
                  updatedMeta: msg.activeVariantId === variantId,
                }, 'info');
              } else {
                // 创建新变体
                const newVariant: Variant = {
                  id: variantId,
                  modelId,
                  blockIds: [],
                  status: 'streaming',
                  createdAt: Date.now(),
                };

                if (!msg.variants) {
                  msg.variants = [];
                }
                msg.variants.push(newVariant);

                // 如果是第一个变体，设为激活
                if (!msg.activeVariantId) {
                  msg.activeVariantId = variantId;
                }

                // 🔧 修复：如果是当前激活的变体（包括刚设为激活的），同步更新消息的 _meta.modelId
                // 解决多变体模式下模型图标显示为空的问题
                if (msg.activeVariantId === variantId) {
                  if (!msg._meta) {
                    msg._meta = {};
                  }
                  msg._meta.modelId = modelId;
                }

                logMultiVariant('store', 'handleVariantStart_create_new', {
                  variantId,
                  modelId,
                  isFirstVariant: !message.activeVariantId,
                  activeVariantId: msg.activeVariantId,
                  totalVariants: msg.variants.length,
                  updatedMeta: msg.activeVariantId === variantId,
                }, 'success');
              }

              // 在 draft 内部更新 streamingVariantIds
              draft.streamingVariantIds = addToSet(draft.streamingVariantIds, variantId);
            })(s);
          });
        },

        handleVariantEnd: (event: BackendVariantEvent): void => {
          const { variantId, status, error, usage } = event;

          logMultiVariant('store', 'handleVariantEnd_called', {
            variantId,
            status,
            error,
            // 🆕 P0修复：日志中包含 usage 信息
            usage: usage ? { total: usage.totalTokens, source: usage.source } : undefined,
          }, status === 'error' ? 'error' : 'info');

          if (!variantId || !status) {
            logMultiVariant('store', 'handleVariantEnd_missing_fields', {
              variantId,
              status,
            }, 'error');
            return;
          }

          // ✅ CRITICAL-002 修复: 在 batchUpdate 内部完成所有更新
          set((s) => {
            // 找到包含此变体的消息
            let foundMessageId: string | null = null;
            let variantBlockIds: string[] = [];

            for (const [msgId, message] of s.messageMap.entries()) {
              const variant = message.variants?.find((v) => v.id === variantId);
              if (variant) {
                foundMessageId = msgId;
                variantBlockIds = variant.blockIds;
                break;
              }
            }

            if (!foundMessageId) {
              logMultiVariant('store', 'handleVariantEnd_complete', {
                variantId,
                status,
                foundMessageId: null,
                variantBlockIds: [],
                remainingStreamingVariants: s.streamingVariantIds.size - 1,
              }, 'warning');
              const newStreamingVariantIds = removeFromSet(s.streamingVariantIds, variantId);
              return {
                streamingVariantIds: newStreamingVariantIds,
                ...(newStreamingVariantIds.size === 0 && s.sessionStatus === 'streaming'
                  ? { sessionStatus: 'idle', currentStreamingMessageId: null, activeBlockIds: new Set() }
                  : {}),
              };
            }

            return batchUpdate((draft) => {
              const msg = draft.messageMap.get(foundMessageId);
              if (!msg) return;

              const variantIndex = msg.variants!.findIndex((v) => v.id === variantId);
              if (variantIndex !== -1) {
                msg.variants![variantIndex].status = status as VariantStatus;
                msg.variants![variantIndex].error = error ?? undefined;
                // 🆕 P0修复：存储变体级别的 Token 统计
                if (usage) {
                  msg.variants![variantIndex].usage = usage;
                }
              }

              // 🔧 P0修复：更新变体内部所有块的状态
              // 当变体结束时，需要将其内部所有 running 状态的块标记为 success/error
              // 解决 thinking 块状态未更新导致 UI 仍显示"思考中..."的问题
              if (status === 'success' || status === 'error') {
                const blockStatus = status === 'success' ? 'success' : 'error';
                const now = Date.now();
                let updatedBlockCount = 0;

                for (const blockId of variantBlockIds) {
                  const block = draft.blocks.get(blockId);
                  if (block && block.status === 'running') {
                    block.status = blockStatus;
                    block.endedAt = now;
                    updatedBlockCount++;
                    // 同时从 activeBlockIds 移除
                    draft.activeBlockIds = removeFromSet(draft.activeBlockIds, blockId);
                  }
                }

                if (updatedBlockCount > 0) {
                  logMultiVariant('store', 'handleVariantEnd_blocks_updated', {
                    variantId,
                    updatedBlockCount,
                    variantBlockIds,
                    blockStatus,
                  }, 'info');
                }
              }

              // 如果当前激活的是此变体且变成了 error，需要切换到其他可用变体
              if (msg.activeVariantId === variantId && status === 'error') {
                msg.activeVariantId = determineActiveVariantId(msg.variants ?? []);
                // 🔧 P1-3 修复：切换活跃变体时同步更新 _meta.modelId
                // 与 handleVariantStart / deleteVariant 保持一致
                const newActiveVariant = msg.variants?.find(v => v.id === msg.activeVariantId);
                if (newActiveVariant?.modelId) {
                  if (!msg._meta) {
                    msg._meta = {};
                  }
                  msg._meta.modelId = newActiveVariant.modelId;
                }
              }

              // 在 draft 内部更新 streamingVariantIds
              draft.streamingVariantIds = removeFromSet(draft.streamingVariantIds, variantId);

              // 🔧 补充：所有变体结束后，恢复 sessionStatus
              if (draft.streamingVariantIds.size === 0 && draft.sessionStatus === 'streaming') {
                draft.sessionStatus = 'idle';
                draft.currentStreamingMessageId = null;
                draft.activeBlockIds = new Set();
              }

              logMultiVariant('store', 'handleVariantEnd_complete', {
                variantId,
                status,
                foundMessageId,
                variantBlockIds,
                remainingStreamingVariants: draft.streamingVariantIds.size,
                // 🆕 P0修复：日志中包含 usage 信息
                usage: usage ? { total: usage.totalTokens, source: usage.source } : undefined,
              }, status === 'success' ? 'success' : 'warning');
            })(s);
          });
        },

        addBlockToVariant: (
          messageId: string,
          variantId: string,
          blockId: string
        ): void => {
          logMultiVariant('store', 'addBlockToVariant_called', {
            messageId,
            variantId,
            blockId,
          }, 'info');

          // ✅ P0-006: 使用 immer 优化
          set((s) => {
            const message = s.messageMap.get(messageId);

            if (!message) {
              logMultiVariant('store', 'addBlockToVariant_message_not_found', {
                messageId,
                variantId,
                blockId,
              }, 'error');
              return {};
            }

            const variant = message.variants?.find(v => v.id === variantId);
            logMultiVariant('store', 'addBlockToVariant_variant_lookup', {
              messageId,
              variantId,
              blockId,
              variantFound: !!variant,
              variantBlockIdsBefore: variant?.blockIds ?? [],
              messageBlockIdsBefore: message.blockIds,
            }, variant ? 'info' : 'warning');

            return updateSingleMessage(messageId, (draft) => {
              // 🔧 将 block 添加到 variant.blockIds
              if (!draft.variants) {
                draft.variants = [];
              }

              let variantIndex = draft.variants.findIndex(v => v.id === variantId);
              if (variantIndex === -1) {
                // 🆕 防御性补齐：变体不存在时创建占位变体，避免 block 丢失
                draft.variants.push({
                  id: variantId,
                  modelId: draft._meta?.modelId ?? '',
                  blockIds: [],
                  status: 'streaming',
                  createdAt: Date.now(),
                });
                variantIndex = draft.variants.length - 1;
                if (!draft.activeVariantId) {
                  draft.activeVariantId = variantId;
                }
              }

              const targetVariant = draft.variants[variantIndex];
              // 避免重复添加
              if (targetVariant.blockIds.includes(blockId)) {
                logMultiVariant('store', 'addBlockToVariant_already_exists', {
                  variantId,
                  blockId,
                }, 'warning');
                return;
              }

              // 🔧 直接追加，排序由 getDisplayBlockIds 根据 firstChunkAt 时间戳处理
              targetVariant.blockIds.push(blockId);

              // 🔧 从 message.blockIds 移除该 block（避免重复）
              // handler.onStart 会将 block 添加到 message.blockIds
              // 多变体模式下，block 应该只存在于 variant.blockIds
              const blockIndex = draft.blockIds.indexOf(blockId);
              if (blockIndex !== -1) {
                draft.blockIds.splice(blockIndex, 1);
              }

              const updatedVariant = draft.variants?.find(v => v.id === variantId);
              logMultiVariant('store', 'addBlockToVariant_complete', {
                messageId,
                variantId,
                blockId,
                variantBlockIdsAfter: updatedVariant?.blockIds ?? [],
                messageBlockIdsAfter: draft.blockIds,
              }, 'success');
            })(s);
          });

          // 🔧 FIX: 对于 content 和 thinking 块，强制 React 同步提交更新
          // addBlockToVariant 在变体模式下被调用，需要确保块立即在UI中可见
          const block = getState().blocks.get(blockId);
          if (block && (block.type === 'content' || block.type === 'thinking')) {
            try {
              flushSync(() => {});
            } catch {
              // flushSync 可能失败，忽略
            }
          }
        },

        addBlockToMessage: (messageId: string, blockId: string): void => {
          set((s) => {
            const newMessageMap = new Map(s.messageMap);
            const message = newMessageMap.get(messageId);

            if (message) {
              newMessageMap.set(messageId, {
                ...message,
                blockIds: [...message.blockIds, blockId],
              });
            }

            return { messageMap: newMessageMap };
          });

          console.log('[ChatStore] addBlockToMessage:', blockId, '->', messageId);
        },

        getActiveVariant: (messageId: string): Variant | undefined => {
          const state = getState();
          const message = state.messageMap.get(messageId);

          if (!message || !message.variants || message.variants.length === 0) {
            return undefined;
          }

          return message.variants.find((v) => v.id === message.activeVariantId);
        },

        getVariants: (messageId: string): Variant[] => {
          const state = getState();
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
          const state = getState();
          const message = state.messageMap.get(messageId);
          return (message?.variants?.length ?? 0) > 1;
        },

        // ================================================================
        // 【权威实现】displayBlockIds 计算逻辑
        // ================================================================
        // 
        // 此函数是前端计算 displayBlockIds 的权威实现。
        // 
        // 【统一逻辑】（需与后端 types.rs::get_active_block_ids 保持一致）：
        //   1. 无变体时：返回 message.blockIds
        //   2. 有变体时：返回 activeVariant.blockIds
        //   3. 找不到激活变体时：回退到 message.blockIds
        // 
        // 【其他位置的调用方】应该使用此方法，不要重复实现：
        //   - useVariantUI.ts 已改为调用此方法
        //   - variantActions.ts 中的实现是独立模块的备用实现
        // ================================================================
        getDisplayBlockIds: (messageId: string): string[] => {
          const state = getState();
          const message = state.messageMap.get(messageId);

          if (!message) {
            return [];
          }

          // Step 1: 获取 blockIds
          let blockIds: string[];
          
          // 无变体时：返回 message.blockIds
          if (!message.variants || message.variants.length === 0) {
            blockIds = message.blockIds;
          } else {
            // 有变体时：返回 activeVariant.blockIds，找不到时回退到 message.blockIds
            const activeVariant = message.variants.find(
              (v) => v.id === message.activeVariantId
            );
            blockIds = activeVariant?.blockIds ?? message.blockIds;
          }

          // Step 2: 直接返回原始顺序，不再排序
          // 后端已经保证了正确的交替顺序（thinking → tool → thinking → tool）
          // 前端排序会破坏这个顺序（因为多个 thinking 块的 firstChunkAt 相同）
          return blockIds;
        },

        // ========== 变体回调设置 ==========

        setSwitchVariantCallback: (
          callback: ((messageId: string, variantId: string) => Promise<void>) | null
        ): void => {
          set({ _switchVariantCallback: callback } as Partial<ChatStoreState>);
          console.log('[ChatStore] SwitchVariant callback', callback ? 'set' : 'cleared');
        },

        setDeleteVariantCallback: (
          callback: ((
            messageId: string,
            variantId: string
          ) => Promise<{ variantDeleted?: boolean; messageDeleted?: boolean; newActiveId?: string }>) | null
        ): void => {
          set({ _deleteVariantCallback: callback } as Partial<ChatStoreState>);
          console.log('[ChatStore] DeleteVariant callback', callback ? 'set' : 'cleared');
        },

        setRetryVariantCallback: (
          callback: ((
            messageId: string,
            variantId: string,
            modelOverride?: string
          ) => Promise<void>) | null
        ): void => {
          set({ _retryVariantCallback: callback } as Partial<ChatStoreState>);
          console.log('[ChatStore] RetryVariant callback', callback ? 'set' : 'cleared');
        },

        setRetryAllVariantsCallback: (
          callback: ((messageId: string, variantIds: string[]) => Promise<void>) | null
        ): void => {
          set({ _retryAllVariantsCallback: callback } as Partial<ChatStoreState>);
          console.log('[ChatStore] RetryAllVariants callback', callback ? 'set' : 'cleared');
        },

        setCancelVariantCallback: (
          callback: ((variantId: string) => Promise<void>) | null
        ): void => {
          set({ _cancelVariantCallback: callback } as Partial<ChatStoreState>);
          console.log('[ChatStore] CancelVariant callback', callback ? 'set' : 'cleared');
        },

        // ========== 多变体触发 ==========

        setPendingParallelModelIds: (modelIds: string[] | null): void => {
          set({ pendingParallelModelIds: modelIds });
          if (modelIds && modelIds.length > 1) {
            console.log('[ChatStore] PendingParallelModelIds set:', modelIds);
          }
          // 🔧 调试日志
          if ((window as any).__multiVariantDebug?.log) {
            (window as any).__multiVariantDebug.log('store', 'setPendingParallelModelIds', {
              modelIds: modelIds ?? [],
              count: modelIds?.length ?? 0,
              // 多变体判断：variants.length > 1（统一标准，单变体重试产生的 1 个变体不算多变体）
              isMultiVariant: (modelIds?.length ?? 0) > 1,
            }, (modelIds?.length ?? 0) > 1 ? 'success' : 'info');
          }
        },

        // ========== 模型重试支持 ==========

        setModelRetryTarget: (messageId: string | null): void => {
          set({ modelRetryTarget: messageId });
          console.log('[ChatStore] ModelRetryTarget', messageId ? `set: ${messageId}` : 'cleared');
        },
  };
}
