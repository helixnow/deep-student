import i18n from 'i18next';
import type { AttachmentMeta, Message } from '../types/message';
import type { Block, BlockType, BlockStatus } from '../types/block';
import type { ContextRef } from '../../resources/types';
import type { EditMessageResult, RetryMessageResult } from '../../adapters/types';
import type { ChatStore } from '../types';
import type { ChatStoreState, SetState, GetState } from './types';
import { getErrorMessage } from '../../../utils/errorUtils';
import { showGlobalNotification } from '../../../components/UnifiedNotification';
import { logChatV2 } from '../../debug/chatV2Logger';
import { modeRegistry, blockRegistry } from '../../registry';
import { chunkBuffer } from '../middleware/chunkBuffer';
import { clearEventContext, clearBridgeState } from '../middleware/eventBridge';
import { batchUpdate, updateSingleBlock } from './immerHelpers';
import { debugLog } from '../../../debug-panel/debugMasterSwitch';
import { generateId, showOperationLockNotification, OPERATION_LOCK_TIMEOUT_MS, IS_VITEST } from './createChatStore';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

export function createMessageActions(
  set: SetState,
  getState: GetState,
) {
  let lockWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  return {
        sendMessage: async (
          content: string,
          attachments?: AttachmentMeta[]
        ): Promise<void> => {
          // 🔧 严重修复：通过回调调用后端
          // 获取发送回调（由 TauriAdapter 注入）
          const sendCallback = (getState() as ChatStoreState & ChatStore & {
            _sendCallback?: ((
              content: string,
              attachments: AttachmentMeta[] | undefined,
              userMessageId: string,
              assistantMessageId: string
            ) => Promise<void>) | null
          })._sendCallback;

          // 生成消息 ID
          const userMessageId = generateId('msg');
          const assistantMessageId = generateId('msg');

          if (sendCallback) {
            // 有回调，通过回调发送（回调内部会调用 sendMessageWithIds 和后端）
            await sendCallback(content, attachments, userMessageId, assistantMessageId);
          } else {
            // 无回调，仅更新本地状态（仅用于测试）
            if (!IS_VITEST) {
              console.warn(
                '[ChatStore] sendMessage: No send callback set. Use setSendCallback() to inject backend logic. ' +
                'Message will only be added locally.'
              );
            }

            await getState().sendMessageWithIds(
              content,
              attachments,
              userMessageId,
              assistantMessageId
            );
          }
        },

        sendMessageWithIds: async (
          content: string,
          attachments: AttachmentMeta[] | undefined,
          userMessageId: string,
          assistantMessageId: string
        ): Promise<void> => {
          const state = getState();
          if (!state.canSend()) {
            throw new Error(i18n.t('chatV2:store.cannotSendWhileStreaming', 'Cannot send while streaming'));
          }

          // 🔒 审计修复: 立即设置 sending 状态，防止 canSend() 通过后的异步窗口内双重发送
          // 原代码在 await activateSkill() 之后才设置 streaming，存在竞态窗口
          set({ sessionStatus: 'sending' });

          try {
          // ★ 修复：发送前修复 skill 状态一致性
          // repairSkillState 会清除无对应 ref 的 activeSkillIds
          getState().repairSkillState();

          // 🔧 P0修复：先调用 onSendMessage，如果抛出错误则中止发送
          // 使用 getResolved 确保继承链上的 onSendMessage 不被遗漏
          const modePlugin = modeRegistry.getResolved(state.mode);
          if (modePlugin?.onSendMessage) {
            // 让错误向上传播，阻止消息发送
            modePlugin.onSendMessage(state, content);
          }
          } catch (prepError) {
            // 🔒 审计修复: 预处理失败时重置 sessionStatus，避免永久卡在 'sending'
            set({ sessionStatus: 'idle' });
            throw prepError;
          }

          // 🆕 统一用户消息处理：从 pendingContextRefs 构建 contextSnapshot
          // 发送时同步设置，确保前端 Store 和后端持久化数据一致
          const userContextSnapshot = state.pendingContextRefs.length > 0
            ? {
                userRefs: state.pendingContextRefs.map(ref => ({
                  resourceId: ref.resourceId,
                  hash: ref.hash,
                  typeId: ref.typeId,
                  displayName: ref.displayName,
                  injectModes: ref.injectModes,
                })),
                retrievalRefs: [], // 检索引用由后端填充
              }
            : undefined;

          // 创建用户消息
          const userMessage = {
            id: userMessageId,
            role: 'user' as const,
            blockIds: [] as string[],
            timestamp: Date.now(),
            attachments: attachments ?? state.attachments,
            // 🆕 统一用户消息处理：同步设置 contextSnapshot
            _meta: userContextSnapshot ? { contextSnapshot: userContextSnapshot } : undefined,
          };

          // 创建助手消息（带参数快照）
          // 🔧 三轮修复：_meta.modelId 优先使用 modelDisplayName（可识别的模型显示名称），
          // 避免初始化为配置 UUID（前端 ProviderIcon 无法识别）
          const assistantMessage = {
            id: assistantMessageId,
            role: 'assistant' as const,
            blockIds: [] as string[],
            timestamp: Date.now(),
            _meta: {
              modelId: state.chatParams.modelDisplayName || state.chatParams.modelId,
              modelDisplayName: state.chatParams.modelDisplayName,
              chatParams: { ...state.chatParams },
            },
          };

          // 创建用户内容块
          const userBlockId = generateId('blk');
          const userBlock = {
            id: userBlockId,
            type: 'content' as BlockType,
            status: 'success' as BlockStatus,
            messageId: userMessageId,
            content,
            startedAt: Date.now(),
            endedAt: Date.now(),
          };

          // 更新用户消息的 blockIds
          userMessage.blockIds = [userBlockId];

          set((s) => ({
            sessionStatus: 'streaming',
            messageMap: new Map(s.messageMap)
              .set(userMessageId, userMessage)
              .set(assistantMessageId, assistantMessage),
            messageOrder: [...s.messageOrder, userMessageId, assistantMessageId],
            blocks: new Map(s.blocks).set(userBlockId, userBlock),
            currentStreamingMessageId: assistantMessageId,
            // 清空输入框
            inputValue: '',
            attachments: [],
            // 🆕 Prompt 6: 发送完成后清空上下文引用
            // ★ P0-01+P0-04 修复：只清空非 sticky 的引用，保留 skill 等持久引用
            pendingContextRefs: s.pendingContextRefs.filter((ref) => ref.isSticky === true),
            pendingContextRefsDirty: false,
          }));

          if (!IS_VITEST) {
            console.log(
              '[ChatStore] sendMessageWithIds:',
              'user:',
              userMessageId,
              'assistant:',
              assistantMessageId
            );
          }
        },

        deleteMessage: async (messageId: string): Promise<void> => {
          const state = getState();
          if (!state.canDelete(messageId)) {
            throw new Error(i18n.t('chatV2:store.cannotDeleteLocked', 'Cannot delete locked message'));
          }

          // 🆕 P1-1: 检查操作锁
          if (state.messageOperationLock) {
            console.warn('[ChatStore] deleteMessage: Operation in progress, ignoring:', state.messageOperationLock);
            // 🔧 P2修复：显示用户友好的提示（带节流）
            showOperationLockNotification();
            return;
          }

          const message = state.messageMap.get(messageId);
          if (!message) return;

          set({ messageOperationLock: { messageId, operation: 'delete' } });
          if (lockWatchdogTimer) clearTimeout(lockWatchdogTimer);
          lockWatchdogTimer = setTimeout(() => {
            if (getState().messageOperationLock) {
              console.error('[ChatStore] Operation lock timeout, force releasing');
              set({ messageOperationLock: null });
            }
          }, OPERATION_LOCK_TIMEOUT_MS);

          try {
            // 获取删除回调
            const deleteCallback = (getState() as ChatStoreState & ChatStore & { _deleteCallback?: ((messageId: string) => Promise<void>) | null })._deleteCallback;

            // 如果有回调，先调用后端删除
            if (deleteCallback) {
              try {
                await deleteCallback(messageId);
              } catch (error) {
                const errorMsg = getErrorMessage(error);
                console.error('[ChatStore] deleteMessage backend failed:', errorMsg);
                // 🔧 P1修复：显示错误提示（使用 i18n）
                const deleteFailedMsg = i18n.t('chatV2:messageItem.actions.deleteFailed');
                showGlobalNotification('error', `${deleteFailedMsg}: ${errorMsg}`);
                throw error;
              }
            }

            // ✅ P0-006 & CRITICAL-007 修复：使用 immer 优化批量删除操作
            // 从 draft 内部获取 message，避免闭包引用外部状态导致的竞态条件
            set(batchUpdate((draft) => {
              const message = draft.messageMap.get(messageId);
              if (!message) return;

              draft.messageMap.delete(messageId);
              message.blockIds.forEach((blockId) => draft.blocks.delete(blockId));

              // 🆕 补充清理：删除变体内的 blocks，避免残留
              if (message.variants) {
                message.variants.forEach((variant) => {
                  variant.blockIds?.forEach((blockId) => draft.blocks.delete(blockId));
                });
              }
              draft.messageOrder = draft.messageOrder.filter((id) => id !== messageId);
            }));

            console.log('[ChatStore] deleteMessage completed:', messageId);
          } finally {
            if (lockWatchdogTimer) { clearTimeout(lockWatchdogTimer); lockWatchdogTimer = null; }
            set({ messageOperationLock: null });
          }
        },

        editMessage: (messageId: string, content: string): void => {
          const state = getState();
          if (!state.canEdit(messageId)) {
            throw new Error(i18n.t('chatV2:store.cannotEditLocked', 'Cannot edit locked message'));
          }

          const message = state.messageMap.get(messageId);
          if (!message || message.role !== 'user') return;

          // 找到内容块并更新
          const contentBlockId = message.blockIds.find((id) => {
            const block = state.blocks.get(id);
            return block?.type === 'content';
          });

          if (contentBlockId) {
            // ✅ P0-006: 使用 immer 优化
            set(updateSingleBlock(contentBlockId, (draft) => {
              draft.content = content;
            }));

            // 🔧 同步修复：调用后端同步块内容
            const updateBlockContentCallback = (getState() as ChatStoreState & ChatStore & {
              _updateBlockContentCallback?: ((blockId: string, content: string) => Promise<void>) | null
            })._updateBlockContentCallback;

            if (updateBlockContentCallback) {
              updateBlockContentCallback(contentBlockId, content).catch((error) => {
                console.error('[ChatStore] editMessage sync failed:', getErrorMessage(error));
                showGlobalNotification(
                  'warning',
                  i18n.t('common:chat.edit_save_failed')
                );
              });
            }
          }
        },

        editAndResend: async (
          messageId: string,
          newContent: string
        ): Promise<void> => {
          // 🔧 调试日志：记录 editAndResend 调用
          logChatV2('message', 'store', 'editAndResend_called', {
            messageId,
            newContentLength: newContent.length,
          }, 'info', { messageId });

          const state = getState();

          // 🔧 调试日志：记录 canEdit 检查
          const canEditResult = state.canEdit(messageId);
          logChatV2('message', 'store', 'editAndResend_canEdit_check', {
            messageId,
            canEdit: canEditResult,
            sessionStatus: state.sessionStatus,
            activeBlockIds: Array.from(state.activeBlockIds),
          }, canEditResult ? 'info' : 'warning', { messageId });

          if (!canEditResult) {
            throw new Error(i18n.t('chatV2:store.cannotEditLocked', 'Cannot edit locked message'));
          }

          // 🆕 P1-1: 检查操作锁
          if (state.messageOperationLock) {
            // 🔧 调试日志：操作锁阻止
            logChatV2('message', 'store', 'editAndResend_operation_locked', {
              messageId,
              existingLock: state.messageOperationLock,
            }, 'warning', { messageId });
            console.warn('[ChatStore] editAndResend: Operation in progress, ignoring:', state.messageOperationLock);
            // 🔧 P2修复：显示用户友好的提示（带节流）
            showOperationLockNotification();
            return;
          }

          // 验证消息存在且是用户消息
          const message = state.messageMap.get(messageId);
          if (!message) {
            throw new Error(i18n.t('chatV2:store.messageNotFound', 'Message not found'));
          }
          if (message.role !== 'user') {
            throw new Error(i18n.t('chatV2:store.canOnlyEditUser', 'Can only edit user messages'));
          }

          // 🔧 P0修复：调用模式插件的 onSendMessage 钩子
          // 这确保模式约束（如 OCR 进行中时阻止发送）被正确检查
          // 使用 getResolved 确保继承链上的 onSendMessage 不被遗漏
          const modePlugin = modeRegistry.getResolved(state.mode);
          if (modePlugin?.onSendMessage) {
            // 让错误向上传播，阻止编辑重发
            modePlugin.onSendMessage(state, newContent);
          }

          // 获取操作锁
          set({ messageOperationLock: { messageId, operation: 'edit' } });

          // 获取编辑并重发回调
          // 🆕 P1-2: 支持传递新的上下文引用（ContextRef[] 类型）
          // 🆕 P1 状态同步修复: 回调返回 EditMessageResult
          const editAndResendCallback = (getState() as ChatStoreState & ChatStore & { _editAndResendCallback?: ((messageId: string, newContent: string, newContextRefs?: ContextRef[]) => Promise<EditMessageResult>) | null })._editAndResendCallback;

          if (!editAndResendCallback) {
            // 🔧 调试日志：回调未设置
            logChatV2('message', 'store', 'editAndResend_callback_missing', {
              messageId,
            }, 'error', { messageId });
            console.warn(
              '[ChatStore] editAndResend: No callback set. Use setEditAndResendCallback() to inject logic.'
            );
            // 释放操作锁
            set({ messageOperationLock: null });
            return;
          }

          // 🔧 P1修复：保存状态快照，用于失败时回滚
          // 在修改本地状态之前，保存当前状态的深拷贝
          const currentState = getState();
          const snapshotMessageMap = new Map(currentState.messageMap);
          const snapshotMessageOrder = [...currentState.messageOrder];
          const snapshotBlocks = new Map(currentState.blocks);
          
          // 保存被编辑消息的原始内容块
          const contentBlockId = message.blockIds.find((id) => {
            const block = currentState.blocks.get(id);
            return block?.type === 'content';
          });
          const originalContentBlock = contentBlockId ? currentState.blocks.get(contentBlockId) : null;

          // 找出需要删除的消息（该用户消息之后的所有消息）
          // 这些消息基于旧的用户输入，编辑后将变得无效
          const messageIndex = currentState.messageOrder.indexOf(messageId);
          const messagesToDelete = messageIndex >= 0 
            ? currentState.messageOrder.slice(messageIndex + 1) 
            : [];

          // 更新原用户消息内容（本地）
          if (contentBlockId) {
            set((s) => {
              const block = s.blocks.get(contentBlockId);
              if (block) {
                const newBlocks = new Map(s.blocks);
                newBlocks.set(contentBlockId, { ...block, content: newContent });
                return { blocks: newBlocks };
              }
              return {};
            });
          }

          // 删除后续消息（本地）
          if (messagesToDelete.length > 0) {
            // 🔧 调试日志：记录删除后续消息
            logChatV2('message', 'store', 'editAndResend_deleting_messages', {
              messageId,
              messagesToDelete,
              count: messagesToDelete.length,
            }, 'info', { messageId });
            console.log('[ChatStore] editAndResend: Deleting subsequent messages:', messagesToDelete);
            set((s) => {
              const newMessageMap = new Map(s.messageMap);
              const newBlocks = new Map(s.blocks);
              
              for (const msgId of messagesToDelete) {
                const msg = newMessageMap.get(msgId);
                if (msg) {
                  // 删除消息的所有块
                  msg.blockIds.forEach((blockId) => newBlocks.delete(blockId));
                  newMessageMap.delete(msgId);
                }
              }
              
              return {
                messageMap: newMessageMap,
                messageOrder: s.messageOrder.filter((id) => !messagesToDelete.includes(id)),
                blocks: newBlocks,
              };
            });
          }

          // 设置状态为流式中
          set({ sessionStatus: 'streaming' });

          // 🔧 调试日志：记录流式开始
          logChatV2('message', 'store', 'editAndResend_streaming_started', {
            messageId,
            newContentLength: newContent.length,
          }, 'info', { messageId });

          console.log('[ChatStore] editAndResend:', messageId, 'new content length:', newContent.length);

          try {
            // 🆕 P1-2: 获取当前的 pendingContextRefs（ContextRef[] 类型）
            // Adapter 层负责转换为 SendContextRef[]
            const pendingRefs = currentState.pendingContextRefs;
            const pendingRefsDirty = currentState.pendingContextRefsDirty === true;
            const newContextRefs: ContextRef[] | undefined = pendingRefsDirty
              ? [...pendingRefs]
              : undefined;
            
            // 调用编辑并重发回调（由 TauriAdapter 提供）
            // 🆕 P1-2: 传递新的上下文引用（ContextRef[] 类型）
            // 🆕 P1 状态同步修复: 接收完整的 EditMessageResult
            const result = await editAndResendCallback(messageId, newContent, newContextRefs);
            const newMessageId = result.newMessageId;
            
            // 🆕 P1 状态同步修复: 处理后端返回的 deletedMessageIds
            // 清理前端中被后端删除的消息引用（可能包含前端未知的消息）
            if (result.deletedMessageIds && result.deletedMessageIds.length > 0) {
              const deletedIds = result.deletedMessageIds;
              logChatV2('message', 'store', 'editAndResend_sync_deleted_messages', {
                messageId,
                deletedIds,
                count: deletedIds.length,
              }, 'info', { messageId });
              
              set((s) => {
                const newMessageMap = new Map(s.messageMap);
                const newBlocks = new Map(s.blocks);
                const deletedSet = new Set(deletedIds);
                
                for (const deletedId of deletedIds) {
                  const msg = newMessageMap.get(deletedId);
                  if (msg) {
                    // 删除消息的所有块
                    msg.blockIds.forEach((blockId) => newBlocks.delete(blockId));
                    // 删除消息的所有变体块
                    if (msg.variants) {
                      msg.variants.forEach((v) => {
                        v.blockIds?.forEach((blockId) => newBlocks.delete(blockId));
                      });
                    }
                    newMessageMap.delete(deletedId);
                  }
                }
                
                return {
                  messageMap: newMessageMap,
                  messageOrder: s.messageOrder.filter((id) => !deletedSet.has(id)),
                  blocks: newBlocks,
                };
              });
              
              console.log('[ChatStore] editAndResend: Synced deleted messages from backend:', deletedIds);
            }
            
            if (newMessageId) {
              // 在 Store 中创建空的助手消息
              // 后端返回的 newMessageId 是新的助手消息 ID
              // 需要创建空消息以便后续的块事件能够关联到它
              const currentChatParams = getState().chatParams;
              // 🔧 三轮修复：_meta.modelId 优先使用 modelDisplayName
              const newAssistantMessage = {
                id: newMessageId,
                role: 'assistant' as const,
                blockIds: [] as string[],
                timestamp: Date.now(),
                _meta: {
                  modelId: currentChatParams.modelDisplayName || currentChatParams.modelId,
                  modelDisplayName: currentChatParams.modelDisplayName,
                  chatParams: { ...currentChatParams },
                },
              };
              
              set((s) => ({
                messageMap: new Map(s.messageMap).set(newMessageId, newAssistantMessage),
                messageOrder: s.messageOrder.includes(newMessageId) 
                  ? s.messageOrder 
                  : [...s.messageOrder, newMessageId],
                currentStreamingMessageId: newMessageId,
              }));
              
              console.log('[ChatStore] editAndResend: Created assistant message:', newMessageId);
            }
            
            // 🆕 P1-2 修复：清空 pendingContextRefs（已使用）
            // ★ P0-01+P0-04 修复：只清空非 sticky 的引用，保留 skill 等持久引用
            set((s) => ({
              pendingContextRefs: s.pendingContextRefs.filter((ref) => ref.isSticky === true),
              pendingContextRefsDirty: false,
            }));

            // 🔧 调试日志：记录成功
            logChatV2('message', 'store', 'editAndResend_completed', {
              messageId,
              newMessageId,
              deletedMessageIds: result.deletedMessageIds,
              newVariantId: result.newVariantId,
            }, 'success', { messageId });
          } catch (error) {
            // 🔧 P1修复：发生错误时完整回滚状态
            const errorMsg = getErrorMessage(error);

            // 🔧 调试日志：记录失败
            logChatV2('message', 'store', 'editAndResend_failed', {
              messageId,
              error: errorMsg,
            }, 'error', { messageId });

            console.error('[ChatStore] editAndResend failed, rolling back state:', errorMsg);
            
            // 回滚到快照状态
            // 🔧 Bug修复：同时清空 activeBlockIds，防止 isStreaming 状态残留
            // 🔧 P1修复：合并为原子操作，如果有原始内容块，在同一次 set() 中恢复
            const blocksToRestore = (contentBlockId && originalContentBlock)
              ? new Map(snapshotBlocks).set(contentBlockId, originalContentBlock)
              : snapshotBlocks;

            set({
              sessionStatus: 'idle',
              currentStreamingMessageId: null,
              messageMap: snapshotMessageMap,
              messageOrder: snapshotMessageOrder,
              blocks: blocksToRestore,
              activeBlockIds: new Set(),
            });
            
            console.log('[ChatStore] editAndResend: State rolled back to snapshot');
            // 注意：错误通知由 TauriAdapter.executeEditAndResend 统一处理，避免重复通知
            throw error;
          } finally {
            // 🔧 P1修复：统一使用 finally 释放操作锁，确保任何情况下都能正确释放
            set({ messageOperationLock: null });
          }
        },

        /**
         * 🆕 更新消息元数据（局部更新，不替换整个 _meta）
         * 用于在流式完成后更新 usage 等字段
         */
        updateMessageMeta: (
          messageId: string,
          metaUpdate: Partial<import('../types/message').MessageMeta>
        ): void => {
          const state = getState();
          const message = state.messageMap.get(messageId);
          if (!message) {
            console.warn('[ChatStore] updateMessageMeta: Message not found:', messageId);
            return;
          }

          set((s) => {
            const msg = s.messageMap.get(messageId);
            if (!msg) return {};

            const newMessageMap = new Map(s.messageMap);
            newMessageMap.set(messageId, {
              ...msg,
              _meta: {
                ...msg._meta,
                ...metaUpdate,
              },
            });

            return { messageMap: newMessageMap };
          });

          // 日志记录便于调试
          if (metaUpdate.usage) {
            console.log(
              '[ChatStore] updateMessageMeta: Updated usage for message',
              messageId,
              'source:',
              metaUpdate.usage.source,
              'total:',
              metaUpdate.usage.totalTokens
            );
          }
        },

        /**
         * ★ 文档28 Prompt10：更新消息的 contextSnapshot.pathMap
         * 用于在发送消息时设置上下文引用的真实路径
         */
        updateMessagePathMap: (
          messageId: string,
          pathMap: Record<string, string>
        ): void => {
          const state = getState();
          const message = state.messageMap.get(messageId);
          if (!message) {
            console.warn('[ChatStore] updateMessagePathMap: Message not found:', messageId);
            return;
          }

          set((s) => {
            const msg = s.messageMap.get(messageId);
            if (!msg) return {};

            const newMessageMap = new Map(s.messageMap);
            const existingSnapshot = msg._meta?.contextSnapshot;
            
            newMessageMap.set(messageId, {
              ...msg,
              _meta: {
                ...msg._meta,
                contextSnapshot: existingSnapshot
                  ? {
                      ...existingSnapshot,
                      pathMap: {
                        ...existingSnapshot.pathMap,
                        ...pathMap,
                      },
                    }
                  : {
                      userRefs: [],
                      retrievalRefs: [],
                      pathMap,
                    },
              },
            });

            return { messageMap: newMessageMap };
          });

          console.log(
            '[ChatStore] updateMessagePathMap: Updated pathMap for message',
            messageId,
            'entries:',
            Object.keys(pathMap).length
          );
        },

        retryMessage: async (
          messageId: string,
          modelOverride?: string
        ): Promise<void> => {
          // 🔧 调试日志：记录 retryMessage 调用
          logChatV2('message', 'store', 'retryMessage_called', {
            messageId,
            modelOverride,
          }, 'info', { messageId });

          const state = getState();

          // 🔧 调试日志：记录 canEdit 检查
          const canEditResult = state.canEdit(messageId);
          logChatV2('message', 'store', 'retryMessage_canEdit_check', {
            messageId,
            canEdit: canEditResult,
            sessionStatus: state.sessionStatus,
            activeBlockIds: Array.from(state.activeBlockIds),
          }, canEditResult ? 'info' : 'warning', { messageId });

          if (!canEditResult) {
            throw new Error(i18n.t('chatV2:store.cannotRetryLocked', 'Cannot retry locked message'));
          }

          // 🆕 P1-1: 检查操作锁
          if (state.messageOperationLock) {
            // 🔧 调试日志：操作锁阻止
            logChatV2('message', 'store', 'retryMessage_operation_locked', {
              messageId,
              existingLock: state.messageOperationLock,
            }, 'warning', { messageId });
            console.warn('[ChatStore] retryMessage: Operation in progress, ignoring:', state.messageOperationLock);
            // 🔧 P2修复：显示用户友好的提示（带节流）
            showOperationLockNotification();
            return;
          }

          // 验证消息存在且是助手消息
          const message = state.messageMap.get(messageId);
          if (!message) {
            throw new Error(i18n.t('chatV2:store.messageNotFound', 'Message not found'));
          }
          if (message.role !== 'assistant') {
            throw new Error(i18n.t('chatV2:store.canOnlyRetryAssistant', 'Can only retry assistant messages'));
          }

          // 🔧 P0修复：调用模式插件的 onSendMessage 钩子
          // 重试时也需要检查模式约束（如 OCR 进行中时阻止重试）
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

          // 获取重试回调
          // 🆕 P1 状态同步修复: 回调返回 RetryMessageResult
          const retryCallback = (getState() as ChatStoreState & ChatStore & { _retryCallback?: ((messageId: string, modelOverride?: string) => Promise<RetryMessageResult>) | null })._retryCallback;

          if (!retryCallback) {
            // 🔧 调试日志：回调未设置
            logChatV2('message', 'store', 'retryMessage_callback_missing', {
              messageId,
            }, 'error', { messageId });
            console.warn(
              '[ChatStore] retryMessage: No retry callback set. Use setRetryCallback() to inject retry logic.'
            );
            return;
          }

          // 获取操作锁
          set({ messageOperationLock: { messageId, operation: 'retry' } });

          // 🔧 P1补充修复：保存重试前的关键状态（避免失败回滚到 streaming）
          const preRetrySessionStatus = state.sessionStatus;
          const preRetryCurrentStreamingMessageId = state.currentStreamingMessageId;

          // 设置状态为流式中
          set({ sessionStatus: 'streaming' });

          // 🔧 调试日志：记录流式开始
          logChatV2('message', 'store', 'retryMessage_streaming_started', {
            messageId,
            modelOverride,
          }, 'info', { messageId });

          console.log(
            '[ChatStore] retryMessage:',
            messageId,
            'model override:',
            modelOverride
          );

          let snapshot: {
            messageMap: Map<string, Message>;
            messageOrder: string[];
            blocks: Map<string, Block>;
            activeBlockIds: Set<string>;
            streamingVariantIds: Set<string>;
            currentStreamingMessageId: string | null;
            sessionStatus: ChatStoreState['sessionStatus'];
          } | null = null;
          try {
            // 🔧 语义修正：重试是"替换"原消息内容，而不是创建新消息
            // 1. 先清空原消息的块（前端状态），同时删除对应的 blocks
            // 2. 后端会删除数据库中的块并使用原消息 ID 重新生成
            const currentState = getState();
            const originalBlockIds = message.blockIds || [];
            const resolvedModelId = modelOverride || currentState.chatParams.modelId;
            // 🔧 三轮修复：resolvedModelDisplayName 用于 _meta.modelId（前端图标显示）
            // modelOverride 来自前端传入，可能是配置 UUID 也可能是显示名称
            const resolvedModelDisplayName =
              modelOverride && modelOverride !== currentState.chatParams.modelId
                ? modelOverride // modelOverride 作为 displayName 的最佳猜测
                : (currentState.chatParams.modelDisplayName || currentState.chatParams.modelId);

            // 🔧 P1补充修复：保存状态快照，失败时回滚（与 editAndResend 保持一致）
            snapshot = {
              messageMap: new Map(currentState.messageMap),
              messageOrder: [...currentState.messageOrder],
              blocks: new Map(currentState.blocks),
              activeBlockIds: new Set(currentState.activeBlockIds),
              streamingVariantIds: new Set(currentState.streamingVariantIds),
              currentStreamingMessageId: preRetryCurrentStreamingMessageId,
              sessionStatus: preRetrySessionStatus,
            };

            // 🔧 修复 Issue 2：删除后续消息（与 editAndResend 保持一致）
            // 重试助手消息时，该消息之后的所有消息都应该被删除
            const messageIndex = currentState.messageOrder.indexOf(messageId);
            const subsequentMessages = messageIndex >= 0
              ? currentState.messageOrder.slice(messageIndex + 1)
              : [];

            if (subsequentMessages.length > 0) {
              // 🔧 L-015 修复：通知用户即将删除后续消息（store 层安全网，覆盖所有调用路径）
              showGlobalNotification(
                'warning',
                i18n.t('chatV2:messageItem.actions.retryDeletingSubsequent', { count: subsequentMessages.length })
              );

              // 🔧 调试日志：记录即将删除的后续消息
              logChatV2('message', 'store', 'retryMessage_deleting_subsequent', {
                messageId,
                subsequentMessages,
                count: subsequentMessages.length,
              }, 'info', { messageId });

              console.log('[ChatStore] retryMessage: Deleting subsequent messages:', subsequentMessages);

              // 删除后续消息（本地状态）
              set((s) => {
                const newMessageMap = new Map(s.messageMap);
                const newBlocks = new Map(s.blocks);

                for (const msgId of subsequentMessages) {
                  const msg = newMessageMap.get(msgId);
                  if (msg) {
                    // 删除消息的所有块
                    msg.blockIds.forEach((blockId) => newBlocks.delete(blockId));
                    newMessageMap.delete(msgId);
                  }
                }

                return {
                  messageMap: newMessageMap,
                  messageOrder: s.messageOrder.filter((id) => !subsequentMessages.includes(id)),
                  blocks: newBlocks,
                };
              });
            }

            // 🔧 调试日志：记录清除块
            logChatV2('message', 'store', 'retryMessage_clearing_blocks', {
              messageId,
              originalBlockIds,
              count: originalBlockIds.length,
            }, 'info', { messageId });

            set((s) => {
              const newMessageMap = new Map(s.messageMap);
              const newBlocks = new Map(s.blocks);

              // 清空原消息的块列表
              const originalMessage = newMessageMap.get(messageId);
              if (originalMessage) {
                newMessageMap.set(messageId, {
                  ...originalMessage,
                  blockIds: [], // 清空块列表，准备接收新内容
                  _meta: {
                    ...originalMessage._meta,
                  // 🔧 三轮修复：_meta.modelId 使用 resolvedModelDisplayName 而非 resolvedModelId
                  // resolvedModelId 可能是配置 UUID，resolvedModelDisplayName 是可显示的模型名称
                  modelId: resolvedModelDisplayName || resolvedModelId,
                  modelDisplayName: resolvedModelDisplayName,
                    chatParams: { ...currentState.chatParams },
                  },
                });
              }

              // 从 blocks Map 中删除原消息的块
              for (const blockId of originalBlockIds) {
                newBlocks.delete(blockId);
              }

              return {
                messageMap: newMessageMap,
                blocks: newBlocks,
                currentStreamingMessageId: messageId, // 使用原消息 ID
              };
            });

            console.log('[ChatStore] retryMessage: Cleared blocks for message:', messageId, 'preparing for regeneration');

            // 调用重试回调（由 TauriAdapter 提供）
            // 🆕 P1 状态同步修复: 接收完整的 RetryMessageResult
            const result = await retryCallback(messageId, modelOverride);
            const returnedMessageId = result.messageId;
            
            // 验证返回的 ID 与原消息 ID 一致
            if (returnedMessageId && returnedMessageId !== messageId) {
              console.warn(
                '[ChatStore] retryMessage: Backend returned different ID:',
                returnedMessageId,
                'expected:',
                messageId
              );
            }
            
            // 🆕 P1 状态同步修复: 处理后端返回的 deletedVariantIds
            // 清理前端中被后端删除的变体引用
            if (result.deletedVariantIds && result.deletedVariantIds.length > 0) {
              const deletedVariantIds = result.deletedVariantIds;
              logChatV2('message', 'store', 'retryMessage_sync_deleted_variants', {
                messageId,
                deletedVariantIds,
                count: deletedVariantIds.length,
              }, 'info', { messageId });
              
              set((s) => {
                const newMessageMap = new Map(s.messageMap);
                const newBlocks = new Map(s.blocks);
                const newStreamingVariantIds = new Set(s.streamingVariantIds);
                const deletedSet = new Set(deletedVariantIds);
                
                const msg = newMessageMap.get(messageId);
                if (msg && msg.variants) {
                  // 过滤掉被删除的变体
                  const remainingVariants = msg.variants.filter((v) => !deletedSet.has(v.id));
                  
                  // 清理被删除变体的 blocks
                  for (const variant of msg.variants) {
                    if (deletedSet.has(variant.id) && variant.blockIds) {
                      variant.blockIds.forEach((blockId) => newBlocks.delete(blockId));
                    }
                  }
                  
                  // 从 streamingVariantIds 中移除
                  for (const variantId of deletedVariantIds) {
                    newStreamingVariantIds.delete(variantId);
                  }
                  
                  // 如果当前激活的变体被删除，选择第一个剩余的变体
                  let newActiveVariantId = msg.activeVariantId;
                  if (msg.activeVariantId && deletedSet.has(msg.activeVariantId)) {
                    newActiveVariantId = remainingVariants.length > 0 ? remainingVariants[0].id : undefined;
                  }
                  
                  newMessageMap.set(messageId, {
                    ...msg,
                    variants: remainingVariants,
                    activeVariantId: newActiveVariantId,
                  });
                }
                
                return {
                  messageMap: newMessageMap,
                  blocks: newBlocks,
                  streamingVariantIds: newStreamingVariantIds,
                };
              });
              
              console.log('[ChatStore] retryMessage: Synced deleted variants from backend:', deletedVariantIds);
            }
            
            console.log('[ChatStore] retryMessage: Retry initiated for message:', messageId);

            // 🔧 调试日志：记录成功
            logChatV2('message', 'store', 'retryMessage_completed', {
              messageId,
              returnedMessageId,
              deletedVariantIds: result.deletedVariantIds,
              newVariantId: result.newVariantId,
            }, 'success', { messageId });
          } catch (error) {
            // 发生错误时恢复状态
            // 🔧 Bug修复：同时清空 activeBlockIds，防止 isStreaming 状态残留
            const errorMsg = getErrorMessage(error);

            // 🔧 调试日志：记录失败
            logChatV2('message', 'store', 'retryMessage_failed', {
              messageId,
              error: errorMsg,
            }, 'error', { messageId });

            console.error('[ChatStore] retryMessage failed:', errorMsg);

            // 回滚到快照状态（包含 messageMap/messageOrder/blocks）
            if (snapshot) {
              set({
                sessionStatus: snapshot.sessionStatus,
                currentStreamingMessageId: snapshot.currentStreamingMessageId,
                messageMap: snapshot.messageMap,
                messageOrder: snapshot.messageOrder,
                blocks: snapshot.blocks,
                activeBlockIds: snapshot.activeBlockIds,
                streamingVariantIds: snapshot.streamingVariantIds,
              });
            }
            // 注意：错误通知由 TauriAdapter.executeRetry 统一处理，避免重复通知
            throw error;
          } finally {
            // 🔧 P1修复：统一使用 finally 释放操作锁，确保任何情况下都能正确释放
            set({ messageOperationLock: null });
          }
        },

        abortStream: async (): Promise<void> => {
          const state = getState();
          if (!state.canAbort()) return;

          // 🔧 P0修复：获取中断回调（由 TauriAdapter 注入）
          const abortCallback = (getState() as ChatStoreState & ChatStore & {
            _abortCallback?: (() => Promise<void>) | null
          })._abortCallback;

          set({ sessionStatus: 'aborting' });

          // 调用后端取消（如果有回调）
          if (abortCallback) {
            try {
              await abortCallback();
            } catch (error) {
              console.error('[ChatStore] Abort callback failed:', error);
              // 即使后端失败，也继续更新本地状态
            }
          } else {
            if (!IS_VITEST) {
              console.warn(
                '[ChatStore] abortStream: No abort callback set. ' +
                'Backend will not be notified. Use setAbortCallback() to inject backend logic.'
              );
            }
          }

          // 处理活跃块
          const activeBlockIds = Array.from(state.activeBlockIds);
          set((s) => {
            const newBlocks = new Map(s.blocks);

            activeBlockIds.forEach((blockId) => {
              const block = newBlocks.get(blockId);
              if (block) {
                // 🔧 P1修复：使用 blockRegistry 确定正确的中断行为
                // 而不是硬编码 thinking/content 判断
                const plugin = blockRegistry.get(block.type);
                const onAbort = plugin?.onAbort ?? 'mark-error';
                const shouldKeepContent = onAbort === 'keep-content';
                
                newBlocks.set(blockId, {
                  ...block,
                  status: shouldKeepContent ? 'success' : 'error',
                  error: shouldKeepContent ? undefined : 'aborted',
                  endedAt: Date.now(),
                });
              }
            });

            return {
              sessionStatus: 'idle',
              currentStreamingMessageId: null,
              activeBlockIds: new Set(),
              blocks: newBlocks,
            };
          });

          // 注意：后端通知已由上方的 _abortCallback 处理
        },

        forceResetToIdle: (): void => {
          console.warn('[ChatStore] forceResetToIdle called - emergency state recovery');
          const sessionId = getState().sessionId;

          // 清理中间件状态
          chunkBuffer.flushSession(sessionId);
          clearEventContext(sessionId);
          clearBridgeState(sessionId);

          set((s) => {
            const newBlocks = new Map(s.blocks);
            
            s.activeBlockIds.forEach((blockId) => {
              const block = newBlocks.get(blockId);
              if (block && block.status !== 'success' && block.status !== 'error') {
                newBlocks.set(blockId, {
                  ...block,
                  status: 'error',
                  error: 'force_reset',
                  endedAt: Date.now(),
                });
              }
            });

            return {
              sessionStatus: 'idle',
              currentStreamingMessageId: null,
              activeBlockIds: new Set(),
              blocks: newBlocks,
              streamingVariantIds: new Set(),
              messageOperationLock: null,
              pendingApprovalRequest: null,
              pendingParallelModelIds: null,
              modelRetryTarget: null,
            };
          });
        },

  };
}
