/**
 * Chat V2 - Store 工厂函数（SSOT 单一数据源）
 *
 * 创建独立的 ChatStore 实例。
 * 每个会话一个实例，互不共享状态。
 *
 * ## 架构职责分离
 *
 * | 文件 | 职责 |
 * |------|------|
 * | createChatStore.ts | 状态定义 + 所有通用 Actions |
 * | contextActions.ts | 上下文引用 Actions |
 * | variantActions.ts | 变体管理 Actions |
 * | guards.ts | 操作守卫（状态校验） |
 * | selectors.ts | 派生状态查询 |
 * | types.ts | 类型定义 |
 *
 * ## Callback 注入模式
 *
 * Store 不直接调用后端，而是通过 TauriAdapter 注入的 Callback 解耦：
 * - setSendCallback: 消息发送
 * - setRetryCallback: 消息重试
 * - setDeleteCallback: 消息删除
 * - setSaveCallback: 会话保存
 * - 等等...
 *
 * @see TauriAdapter - 后端通信层，注入 Callbacks
 */

import { createStore, type StoreApi } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { flushSync } from 'react-dom';
import type { ChatStore, LoadSessionResponseType } from '../types';
import type { Block, BlockStatus, BlockType } from '../types/block';
import type { AttachmentMeta, Message, Variant, VariantStatus } from '../types/message';
import {
  type BackendVariantEvent,
  canSwitchToVariant,
  determineActiveVariantId,
  debouncedSwitchVariantBackend,
} from './variantActions';
import type { ChatParams, PanelStates } from '../types/common';
import { createGuards } from './guards';
import { getErrorMessage } from '../../../utils/errorUtils';
import { sessionSwitchPerf } from '../../debug/sessionSwitchPerf';
import { showGlobalNotification } from '../../../components/UnifiedNotification';
import i18n from 'i18next';
import { autoSave } from '../middleware/autoSave';
import {
  createInitialState,
  createDefaultChatParams,
  createDefaultPanelStates,
  type ChatStoreState,
  type SetState,
  type GetState,
} from './types';
import { modeRegistry, blockRegistry } from '../../registry';
import { logMultiVariant } from '../../../debug-panel/plugins/MultiVariantDebugPlugin';
import { logChatV2, logAttachment } from '../../debug/chatV2Logger';
import { debugLog } from '../../../debug-panel/debugMasterSwitch';
import { createContextActions } from './contextActions';
import { createSkillActions } from './skillActions';
import type { ContextRef } from '../../resources/types';
import type { EditMessageResult, RetryMessageResult } from '../../adapters/types';
import { SKILL_INSTRUCTION_TYPE_ID } from '../../skills/types';
import { skillDefaults } from '../../skills/skillDefaults';
import { usePdfProcessingStore } from '../../../stores/pdfProcessingStore';
import {
  updateSingleBlock,
  updateSingleMessage,
  updateMessageAndBlocks,
  updateMultipleMessages,
  updateMultipleBlocks,
  batchUpdate,
  addToSet,
  removeFromSet,
  addMultipleToSet,
  removeMultipleFromSet,
} from './immerHelpers';

const IS_VITEST = typeof process !== 'undefined' && Boolean(process.env?.VITEST);
const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

// ============================================================================
// ID 生成
// ============================================================================

let idCounter = 0;

/**
 * ID 计数器重置阈值
 * 🔧 P2修复：防止 idCounter 溢出
 * 选择 100 万作为阈值，因为：
 * 1. 远小于 Number.MAX_SAFE_INTEGER（约 9 千万亿）
 * 2. 单次会话几乎不可能产生这么多 ID
 * 3. 结合 timestamp 和 random，重置后仍能保证唯一性
 */
const ID_COUNTER_RESET_THRESHOLD = 1_000_000;

/**
 * 生成唯一 ID
 */
function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  const counter = (idCounter++).toString(36);

  // 🔧 P2修复：超过阈值时重置计数器
  if (idCounter >= ID_COUNTER_RESET_THRESHOLD) {
    idCounter = 0;
  }

  return `${prefix}_${timestamp}_${random}_${counter}`;
}

// ============================================================================
// 操作锁提示节流
// ============================================================================

/**
 * 🔧 P2修复：操作锁提示节流
 * 避免频繁弹窗打扰用户
 */
let lastOperationLockNotificationTime = 0;
const OPERATION_LOCK_NOTIFICATION_THROTTLE_MS = 3000; // 3 秒内只提示一次

/**
 * 显示操作锁提示（带节流）
 */
function showOperationLockNotification(): void {
  const now = Date.now();
  if (now - lastOperationLockNotificationTime >= OPERATION_LOCK_NOTIFICATION_THROTTLE_MS) {
    lastOperationLockNotificationTime = now;
    showGlobalNotification('info', i18n.t('chatV2:chat.operation_in_progress'));
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 🔧 P3重构：块创建内部实现
 * 抽取 createBlock 和 createBlockWithId 的公共逻辑
 *
 * @param messageId 消息 ID
 * @param type 块类型
 * @param blockId 块 ID
 * @param set Zustand set 函数
 * @param _getState Zustand getState 函数（保留以备后用）
 * @returns 创建的块 ID
 */
function createBlockInternal(
  messageId: string,
  type: BlockType,
  blockId: string,
  set: SetState,
  _getState: GetState
): string {
  const block = {
    id: blockId,
    type,
    status: 'pending' as BlockStatus,
    messageId,
    startedAt: Date.now(),
  };

  // 🔧 FIX: 对于流式块（content/thinking），使用 flushSync 包裹 set()
  // 确保 React 立即处理状态更新，挂载 BlockRendererWithStore 组件
  // 这样后续的 chunk 事件才能被正确渲染
  const doUpdate = () => {
    set((s) => {
      let message = s.messageMap.get(messageId);

      // 先添加 block
      const blocksUpdate = updateMultipleBlocks((draft) => {
        draft.set(blockId, block);
      })(s);

      // 🔧 P0修复：消息不存在时自动创建占位消息
      // 解决 stream_start 和 thinking/start 事件竞态条件导致块不显示的问题
      // 场景：thinking/start 事件先于 stream_start 到达，此时消息还未创建
      if (!message) {
        console.warn(
          '[ChatStore] createBlockInternal: Message not found, creating placeholder:',
          messageId,
          'for block:',
          blockId,
          'type:',
          type
        );
        // 创建占位消息
        const placeholderMessage = {
          id: messageId,
          role: 'assistant' as const,
          blockIds: [blockId], // 直接包含新块
          timestamp: Date.now(),
        };
        const newMessageMap = new Map(s.messageMap);
        newMessageMap.set(messageId, placeholderMessage);
        
        // 添加到消息顺序（如果不存在）
        const newMessageOrder = s.messageOrder.includes(messageId)
          ? s.messageOrder
          : [...s.messageOrder, messageId];
        
        return {
          blocks: blocksUpdate.blocks,
          messageMap: newMessageMap,
          messageOrder: newMessageOrder,
          activeBlockIds: addToSet(s.activeBlockIds, blockId),
          // 🔧 同时设置流式状态
          sessionStatus: 'streaming' as const,
          currentStreamingMessageId: messageId,
        };
      }

      // 更新消息的 blockIds
      // 🔧 直接追加，排序由 getDisplayBlockIds 根据 firstChunkAt 时间戳处理
      const messageUpdate = updateSingleMessage(messageId, (draft) => {
        draft.blockIds.push(blockId);
      })(s);

      return {
        blocks: blocksUpdate.blocks,
        messageMap: messageUpdate.messageMap,
        activeBlockIds: addToSet(s.activeBlockIds, blockId),
      };
    });
  };

  // 对于流式块，使用 flushSync 强制同步渲染
  if (type === 'content' || type === 'thinking') {
    try {
      flushSync(doUpdate);
    } catch {
      // flushSync 在某些情况下可能失败，降级为普通更新
      doUpdate();
    }
  } else {
    doUpdate();
  }

  return blockId;
}

// ============================================================================
// Store 工厂函数
// ============================================================================

/**
 * 创建 ChatStore 实例
 *
 * @param sessionId - 会话 ID
 * @returns Zustand Store API
 */
export function createChatStore(sessionId: string): StoreApi<ChatStore> {
  return createStore<ChatStore>()(
    subscribeWithSelector((set, get) => {
      // 获取状态的类型安全包装
      const getState = () => get() as ChatStoreState & ChatStore;

      // 参数/功能变更后触发节流自动保存
      const scheduleAutoSaveIfReady = () => {
        try {
          const state = getState();
          if (state.sessionId) {
            autoSave.scheduleAutoSave(state as ChatStore);
          }
        } catch (_) { /* 初始化阶段可能无 sessionId */ }
      };

      // 创建守卫方法
      const guards = createGuards(getState);

      // 创建上下文引用 Actions
      const contextActions = createContextActions(
        set as Parameters<typeof createContextActions>[0],
        getState
      );

      // 创建 Skill Actions
      const skillActions = createSkillActions(
        set as Parameters<typeof createSkillActions>[0],
        getState
      );

      return {
        // ========== 初始状态 ==========
        ...createInitialState(sessionId),

        // ========== 守卫方法 ==========
        ...guards,

        // ========== 🆕 上下文引用 Actions ==========
        ...contextActions,

        // ========== 🆕 Skills Actions ==========
        ...skillActions,

        // ========== 消息 Actions ==========

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

          // 获取操作锁
          set({ messageOperationLock: { messageId, operation: 'delete' } });

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
            // 释放操作锁
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
                  i18n.t('chat.edit_save_failed', { defaultValue: '消息编辑保存失败，请重试' })
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
            const newContextRefs = pendingRefs.length > 0 ? [...pendingRefs] : undefined;
            
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
          // 强制重置到 idle 状态，跳过所有守卫检查
          // 用于 abortStream 失败时的应急恢复
          set((s) => {
            const newBlocks = new Map(s.blocks);
            
            // 将所有活跃块标记为 error（强制中断）
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
            };
          });
        },

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

        // ========== 对话参数 Actions ==========

        setChatParams: (params: Partial<ChatParams>): void => {
          set((s) => ({
            chatParams: { ...s.chatParams, ...params },
          }));
          scheduleAutoSaveIfReady();
        },

        resetChatParams: (): void => {
          // 🔧 R1-2: 重置时保留当前 modelId/modelDisplayName，避免 API 调用失败
          const current = getState().chatParams;
          const defaults = createDefaultChatParams();
          set({
            chatParams: {
              ...defaults,
              modelId: current.modelId,
              modelDisplayName: current.modelDisplayName,
            },
          });
          scheduleAutoSaveIfReady();
        },

        // ========== 功能开关 Actions ==========

        setFeature: (key: string, enabled: boolean): void => {
          set((s) => {
            const newFeatures = new Map(s.features);
            newFeatures.set(key, enabled);
            return { features: newFeatures };
          });
        },

        toggleFeature: (key: string): void => {
          set((s) => {
            const newFeatures = new Map(s.features);
            newFeatures.set(key, !s.features.get(key));
            return { features: newFeatures };
          });
        },

        getFeature: (key: string): boolean => {
          return getState().features.get(key) ?? false;
        },

        // ========== 模式状态 Actions ==========

        setModeState: (state: Record<string, unknown> | null): void => {
          set({ modeState: state });
        },

        updateModeState: (updates: Record<string, unknown>): void => {
          set((s) => ({
            modeState: s.modeState ? { ...s.modeState, ...updates } : updates,
          }));
        },

        // ========== 会话元信息 Actions ==========

        setTitle: (title: string): void => {
          set({ title });
          console.log('[ChatStore] Title set:', title);

          // 调用后端同步会话设置
          const updateSessionSettingsCallback = (getState() as ChatStoreState & ChatStore & {
            _updateSessionSettingsCallback?: ((settings: { title?: string }) => Promise<void>) | null
          })._updateSessionSettingsCallback;

          if (updateSessionSettingsCallback) {
            updateSessionSettingsCallback({ title }).catch((error) => {
              console.error('[ChatStore] setTitle sync failed:', getErrorMessage(error));
            });
          }
        },

        setDescription: (description: string): void => {
          set({ description });
          console.log('[ChatStore] Description set:', description);
          // 注意：description 由后端自动生成，不需要回调同步
        },

        setSummary: (title: string, description: string): void => {
          set({ title, description });
          console.log('[ChatStore] Summary set:', { title, description });
          // 注意：summary 由后端自动生成并通过事件通知，不需要回调同步
        },

        // ========== 输入框 Actions ==========

        setInputValue: (value: string): void => {
          set({ inputValue: value });
        },

        addAttachment: (attachment: AttachmentMeta): void => {
          set((s) => {
            // ★ Bug3 修复：按 resourceId 去重，避免从资源库重复引用时附件列表重复
            if (attachment.resourceId) {
              const exists = s.attachments.some(a => a.resourceId === attachment.resourceId);
              if (exists) {
                console.log('[ChatStore] addAttachment: 相同 resourceId 已存在（跳过）', attachment.resourceId);
                return {};
              }
            }
            return { attachments: [...s.attachments, attachment] };
          });
        },

        updateAttachment: (attachmentId: string, updates: Partial<AttachmentMeta>): void => {
          set((s) => ({
            attachments: s.attachments.map((a) =>
              a.id === attachmentId ? { ...a, ...updates } : a
            ),
          }));
        },

        removeAttachment: (attachmentId: string): void => {
          const state = getState();
          // 查找要删除的附件，获取其 resourceId
          const attachment = state.attachments.find((a) => a.id === attachmentId);

          // ★ 调试日志：记录 Store 移除操作
          logAttachment('store', 'remove_attachment', {
            attachmentId,
            sourceId: attachment?.sourceId,
            resourceId: attachment?.resourceId,
            fileName: attachment?.name,
            status: attachment?.status,
          });

          set((s) => ({
            attachments: s.attachments.filter((a) => a.id !== attachmentId),
          }));

          // 同步移除对应的 ContextRef（如果存在 resourceId）
          if (attachment?.resourceId) {
            state.removeContextRef(attachment.resourceId);
            console.log('[ChatStore] removeAttachment: Removed ContextRef for', attachment.resourceId);
            
            // ★ P0 修复：清理 pdfProcessingStore 中的状态，防止内存泄漏和状态污染
            // ★ P0 修复：使用 sourceId 作为 key（与后端事件一致）
            if (attachment.sourceId) {
              usePdfProcessingStore.getState().remove(attachment.sourceId);
              // ★ 调试日志：记录 Store 清理
              logAttachment('store', 'processing_store_cleanup', {
                sourceId: attachment.sourceId,
                attachmentId,
              });
              console.log('[ChatStore] removeAttachment: Removed pdfProcessingStore status for sourceId', attachment.sourceId);
            }
          }

          // 🔧 P1-25: 释放 Blob URL，避免内存泄漏
          if (attachment?.previewUrl?.startsWith('blob:')) {
            URL.revokeObjectURL(attachment.previewUrl);
            console.log('[ChatStore] removeAttachment: Revoked Blob URL');
          }
        },

        clearAttachments: (): void => {
          const state = getState();

          // ★ 调试日志：记录清空操作
          const attachmentCount = state.attachments.length;
          const attachmentInfo = state.attachments.map(a => ({
            id: a.id,
            sourceId: a.sourceId,
            name: a.name,
            status: a.status,
          }));
          logAttachment('store', 'clear_attachments_start', {
            count: attachmentCount,
            attachments: attachmentInfo,
          });

          // 🔧 P1-25: 释放所有 Blob URLs，避免内存泄漏
          const blobUrls = state.attachments
            .filter((a) => a.previewUrl?.startsWith('blob:'))
            .map((a) => a.previewUrl!);
          for (const url of blobUrls) {
            URL.revokeObjectURL(url);
          }
          if (blobUrls.length > 0) {
            console.log('[ChatStore] clearAttachments: Revoked', blobUrls.length, 'Blob URLs');
          }

          // 获取所有附件的 resourceId，用于清除对应的 ContextRefs
          const resourceIds = state.attachments
            .filter((a) => a.resourceId)
            .map((a) => a.resourceId!);
          
          // ★ P0 修复：获取 sourceId 用于清理 pdfProcessingStore
          const sourceIds = state.attachments
            .filter((a) => a.sourceId)
            .map((a) => a.sourceId!);

          set({ attachments: [] });

          // 同步清除对应的 ContextRefs
          for (const resourceId of resourceIds) {
            state.removeContextRef(resourceId);
          }
          if (resourceIds.length > 0) {
            console.log('[ChatStore] clearAttachments: Removed', resourceIds.length, 'ContextRefs');
          }
          
          // ★ P0 修复：使用 sourceId 清理 pdfProcessingStore（与后端事件 key 一致）
          for (const sourceId of sourceIds) {
            usePdfProcessingStore.getState().remove(sourceId);
          }
          if (sourceIds.length > 0) {
            // ★ 调试日志：记录 Store 清理
            logAttachment('store', 'processing_store_batch_cleanup', {
              sourceIds,
              count: sourceIds.length,
            });
            console.log('[ChatStore] clearAttachments: Cleared', sourceIds.length, 'pdfProcessingStore entries (sourceIds)');
          }
        },

        setPanelState: (panel: keyof PanelStates, open: boolean): void => {
          set((s) => ({
            panelStates: { ...s.panelStates, [panel]: open },
          }));
        },

        // ========== 🆕 工具审批 Actions（文档 29 P1-3） ==========

        setPendingApproval: (request: {
          toolCallId: string;
          toolName: string;
          arguments: Record<string, unknown>;
          sensitivity: 'low' | 'medium' | 'high';
          description: string;
          timeoutSeconds: number;
          resolvedStatus?: 'approved' | 'rejected' | 'timeout' | 'expired' | 'error';
          resolvedReason?: string;
        } | null): void => {
          set({ pendingApprovalRequest: request });
          if (request) {
            console.log('[ChatStore] setPendingApproval:', request.toolName, request.toolCallId);
          }
        },

        clearPendingApproval: (): void => {
          set({ pendingApprovalRequest: null });
          console.log('[ChatStore] clearPendingApproval');
        },

        // ========== 会话 Actions ==========

        initSession: async (mode: string, initConfig?: Record<string, unknown>): Promise<void> => {
          // 🔧 P0修复：保存当前 modeState（如果外部已预设）
          const presetModeState = getState().modeState;

          set({
            mode,
            sessionStatus: 'idle',
            messageMap: new Map(),
            messageOrder: [],
            blocks: new Map(),
            currentStreamingMessageId: null,
            activeBlockIds: new Set(),
            streamingVariantIds: new Set(), // 🔧 变体状态初始化
            pendingContextRefs: [], // 🆕 上下文引用初始化
            chatParams: createDefaultChatParams(),
            features: new Map(),
            // 🔧 P0修复：保留预设的 modeState，让 onInit 决定如何处理
            modeState: presetModeState,
            inputValue: '',
            attachments: [],
            panelStates: createDefaultPanelStates(),
          });

          // 调用模式插件初始化，传递 initConfig
          // 🔧 P1修复：使用 getResolved 获取合并了继承链的完整插件
          const modePlugin = modeRegistry.getResolved(mode);
          if (modePlugin?.onInit) {
            try {
              // 🔧 P0修复：传递 initConfig 给 onInit
              await modePlugin.onInit(getState(), initConfig as Record<string, unknown> | undefined);
              console.log('[ChatV2:Store] Mode plugin initialized:', mode, 'config:', initConfig);
            } catch (error) {
              console.error('[ChatV2:Store] Mode plugin init failed:', mode, error);
            }
          }
        },

        loadSession: async (_sessionId: string): Promise<void> => {
          // 🔧 严重修复：通过回调调用后端加载
          const loadCallback = (getState() as ChatStoreState & ChatStore & {
            _loadCallback?: (() => Promise<void>) | null
          })._loadCallback;

          if (loadCallback) {
            await loadCallback();
          } else {
            console.warn(
              '[ChatStore] loadSession: No load callback set. Use setLoadCallback() to inject load logic.'
            );
          }
        },

        saveSession: async (): Promise<void> => {
          const state = getState() as ChatStoreState & ChatStore & { _saveCallback?: (() => Promise<void>) | null };
          if (state._saveCallback) {
            try {
              await state._saveCallback();
              console.log('[ChatStore] saveSession completed via callback');
            } catch (error) {
              console.error('[ChatStore] saveSession failed:', error);
              throw error;
            }
          } else {
            console.warn(
              '[ChatStore] saveSession: No save callback set. Use setSaveCallback() to inject save logic.'
            );
          }
        },

        setSaveCallback: (
          callback: (() => Promise<void>) | null
        ): void => {
          // 将回调存储在状态中（使用下划线前缀表示内部字段）
          set({ _saveCallback: callback } as Partial<ChatStoreState>);
          console.log(
            '[ChatStore] Save callback',
            callback ? 'set' : 'cleared'
          );
        },

        setRetryCallback: (
          // 🆕 P1 状态同步修复: 回调返回 RetryMessageResult
          callback: ((messageId: string, modelOverride?: string) => Promise<RetryMessageResult>) | null
        ): void => {
          // 将重试回调存储在状态中（使用下划线前缀表示内部字段）
          set({ _retryCallback: callback } as Partial<ChatStoreState>);
          console.log(
            '[ChatStore] Retry callback',
            callback ? 'set' : 'cleared'
          );
        },

        setDeleteCallback: (
          callback: ((messageId: string) => Promise<void>) | null
        ): void => {
          set({ _deleteCallback: callback } as Partial<ChatStoreState>);
          console.log(
            '[ChatStore] Delete callback',
            callback ? 'set' : 'cleared'
          );
        },

        setEditAndResendCallback: (
          // 🆕 P1-2: 支持传递新的上下文引用（ContextRef[] 类型）
          // 🆕 P1 状态同步修复: 回调返回 EditMessageResult
          callback: ((messageId: string, newContent: string, newContextRefs?: ContextRef[]) => Promise<EditMessageResult>) | null
        ): void => {
          set({ _editAndResendCallback: callback } as Partial<ChatStoreState>);
          console.log(
            '[ChatStore] EditAndResend callback',
            callback ? 'set' : 'cleared'
          );
        },

        setSendCallback: (
          callback: ((
            content: string,
            attachments: AttachmentMeta[] | undefined,
            userMessageId: string,
            assistantMessageId: string
          ) => Promise<void>) | null
        ): void => {
          set({ _sendCallback: callback } as Partial<ChatStoreState>);
          console.log(
            '[ChatStore] Send callback',
            callback ? 'set' : 'cleared'
          );
        },

        setAbortCallback: (
          callback: (() => Promise<void>) | null
        ): void => {
          set({ _abortCallback: callback } as Partial<ChatStoreState>);
          console.log(
            '[ChatStore] Abort callback',
            callback ? 'set' : 'cleared'
          );
        },

        // 🔧 P0 修复：继续执行中断的消息（回调注入 + fallback）
        setContinueMessageCallback: (
          callback: ((messageId: string, variantId?: string) => Promise<void>) | null
        ): void => {
          set({ _continueMessageCallback: callback } as Partial<ChatStoreState>);
          console.log(
            '[ChatStore] ContinueMessage callback',
            callback ? 'set' : 'cleared'
          );
        },

        continueMessage: async (messageId: string, variantId?: string): Promise<void> => {
          const continueCallback = (getState() as ChatStoreState & ChatStore & {
            _continueMessageCallback?: ((messageId: string, variantId?: string) => Promise<void>) | null
          })._continueMessageCallback;

          if (continueCallback) {
            try {
              await continueCallback(messageId, variantId);
              console.log('[ChatStore] continueMessage succeeded (same-message continue):', messageId);
              return;
            } catch (error) {
              // 后端 continue_message 可能因无 TodoList 等原因失败
              // 回退到 sendMessage('继续') 作为兜底
              console.warn(
                '[ChatStore] continueMessage callback failed, falling back to sendMessage:',
                getErrorMessage(error)
              );
            }
          }

          // Fallback：发送"继续"消息（创建新轮次）
          await getState().sendMessage(i18n.t('chatV2:store.continueMessage', { defaultValue: 'continue' }));
        },

        setLoadCallback: (
          callback: (() => Promise<void>) | null
        ): void => {
          set({ _loadCallback: callback } as Partial<ChatStoreState>);
          console.log(
            '[ChatStore] Load callback',
            callback ? 'set' : 'cleared'
          );
        },

        setUpdateBlockContentCallback: (
          callback: ((blockId: string, content: string) => Promise<void>) | null
        ): void => {
          set({ _updateBlockContentCallback: callback } as Partial<ChatStoreState>);
          console.log(
            '[ChatStore] UpdateBlockContent callback',
            callback ? 'set' : 'cleared'
          );
        },

        setUpdateSessionSettingsCallback: (
          callback: ((settings: { title?: string }) => Promise<void>) | null
        ): void => {
          set({ _updateSessionSettingsCallback: callback } as Partial<ChatStoreState>);
          console.log(
            '[ChatStore] UpdateSessionSettings callback',
            callback ? 'set' : 'cleared'
          );
        },

        restoreFromBackend: (response: LoadSessionResponseType): void => {
          const { session, messages, blocks, state } = response;
          const t0 = performance.now();

          // 1. 按 timestamp 排序消息（确保消息顺序正确）
          const tSortStart = performance.now();
          const sortedMessages = [...messages].sort(
            (a, b) => a.timestamp - b.timestamp
          );
          const tSortEnd = performance.now();
          sessionSwitchPerf.mark('set_data_start', {
            phase: 'sort_messages',
            ms: tSortEnd - tSortStart,
          });

          // 2. 转换块数据（先处理，后面可能需要添加从 sources 恢复的块）
          const tBlockMapStart = performance.now();
          const blocksMap = new Map<string, Block>();
          for (const blk of blocks) {
            const block: Block = {
              id: blk.id,
              messageId: blk.messageId,
              type: blk.type as BlockType,
              status: blk.status as BlockStatus,
              content: blk.content,
              toolName: blk.toolName,
              toolInput: blk.toolInput as Record<string, unknown> | undefined,
              toolOutput: blk.toolOutput,
              citations: blk.citations,
              error: blk.error,
              startedAt: blk.startedAt,
              endedAt: blk.endedAt,
              // 🔧 P3修复：恢复 firstChunkAt 用于排序（保持思维链交替顺序）
              firstChunkAt: blk.firstChunkAt,
            };
            blocksMap.set(blk.id, block);
          }
          const tBlockMapEnd = performance.now();
          sessionSwitchPerf.mark('set_data_end', {
            phase: 'build_blocks_map',
            ms: tBlockMapEnd - tBlockMapStart,
            blockCount: blocksMap.size,
          });

          // 3. 转换消息数据
          // 注意：所有块（包括检索块、工具调用块等）现在都统一存储在 blocks 表中，
          // 直接通过 msg.blockIds 引用，无需从 meta 中恢复
          const tMsgMapStart = performance.now();
          const messageMap = new Map<string, Message>();
          const messageOrder: string[] = [];

          for (const msg of sortedMessages) {
            const message: Message = {
              id: msg.id,
              role: msg.role,
              blockIds: msg.blockIds, // 直接使用后端返回的 blockIds
              timestamp: msg.timestamp,
              persistentStableId: msg.persistentStableId,
              attachments: msg.attachments,
              // 🔧 修复：后端 serde(rename = "_meta") 序列化，字段名是 _meta
              // 🆕 统一用户消息处理：确保 contextSnapshot 被正确恢复
              _meta: msg._meta
                ? {
                    modelId: msg._meta.modelId,
                    // 🔒 审计修复: 添加 modelDisplayName 恢复（原代码遗漏此字段，
                    // 导致恢复后消息显示模型 ID 而非用户友好名称）
                    modelDisplayName: msg._meta.modelDisplayName,
                    chatParams: msg._meta.chatParams,
                    usage: msg._meta.usage,
                    contextSnapshot: msg._meta.contextSnapshot,
                  }
                : undefined,
              // 🔧 变体字段恢复
              activeVariantId: msg.activeVariantId,
              variants: msg.variants,
              sharedContext: msg.sharedContext,
            };
            messageMap.set(msg.id, message);
            messageOrder.push(msg.id);
          }
          const tMsgMapEnd = performance.now();
          sessionSwitchPerf.mark('set_data_end', {
            phase: 'build_messages_map',
            ms: tMsgMapEnd - tMsgMapStart,
            messageCount: messageOrder.length,
          });

          // 4. 转换状态数据
          const chatParams = state?.chatParams ?? createDefaultChatParams();
          const features = new Map(Object.entries(state?.features ?? {}));
          const panelStates = state?.panelStates ?? createDefaultPanelStates();
          const modeState = state?.modeState ?? null;
          const inputValue = state?.inputValue ?? '';

          // 🆕 Prompt 7: 恢复待发送的上下文引用
          //
          // 🛡️ 鲁棒性改造：多级降级解析，防止 JSON 异常导致引用丢失
          //
          // 策略：
          // 1. 标准 JSON.parse
          // 2. 逐个元素解析（处理数组部分损坏）
          // 3. 字符串扫描提取 ContextRef 对象（安全的非正则方法，防止 ReDoS）
          // 4. 详细日志记录 + 用户通知
          let pendingContextRefs: import('../../context/types').ContextRef[] = [];
          let parseResult: 'success' | 'partial' | 'failed' = 'success';

          if (state?.pendingContextRefsJson) {
            // 📊 解析统计
            const stats = {
              originalLength: state.pendingContextRefsJson.length,
              parsedCount: 0,
              failedCount: 0,
              method: '' as 'standard' | 'incremental' | 'string-scan' | 'none',
            };

            try {
              // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
              // 第一级：标准 JSON.parse
              // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
              const parsed = JSON.parse(state.pendingContextRefsJson);

              // 验证是否为数组
              if (!Array.isArray(parsed)) {
                throw new Error('Parsed result is not an array');
              }

              // 验证并过滤有效的 ContextRef
              const validated = parsed.filter((item: unknown): item is import('../../context/types').ContextRef => {
                return isValidContextRef(item);
              });

              // ★ P0-03 补齐旧数据迁移：历史数据可能没有 isSticky 字段
              // - skill_instruction 必须视为持久引用（持续生效直到取消）
              pendingContextRefs = validated.map((ref) => {
                if (ref.typeId === SKILL_INSTRUCTION_TYPE_ID) {
                  return { ...ref, isSticky: true };
                }
                return ref;
              });
              stats.parsedCount = validated.length;
              stats.failedCount = parsed.length - validated.length;
              stats.method = 'standard';

              console.log('[ChatStore] ✅ Restored pendingContextRefs (standard):', {
                total: validated.length,
                failed: stats.failedCount,
              });

            } catch (standardError) {
              console.warn('[ChatStore] ⚠️ Standard JSON.parse failed, trying incremental parse...', standardError);

              try {
                // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                // 第二级：逐个元素解析（处理数组部分损坏）
                // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                const jsonStr = state.pendingContextRefsJson.trim();

                // 检查是否是数组格式
                if (!jsonStr.startsWith('[') || !jsonStr.endsWith(']')) {
                  throw new Error('Not an array format');
                }

                // 提取数组内容（去除首尾方括号）
                const arrayContent = jsonStr.slice(1, -1).trim();

                if (arrayContent) {
                  // 尝试提取每个对象
                  // 使用更健壮的方法：查找所有顶层的 {...} 对象
                  const objectMatches: string[] = [];
                  let depth = 0;
                  let startIdx = -1;

                  for (let i = 0; i < arrayContent.length; i++) {
                    const char = arrayContent[i];

                    if (char === '{') {
                      if (depth === 0) {
                        startIdx = i;
                      }
                      depth++;
                    } else if (char === '}') {
                      depth--;
                      if (depth === 0 && startIdx !== -1) {
                        objectMatches.push(arrayContent.substring(startIdx, i + 1));
                        startIdx = -1;
                      }
                    }
                  }

                  if (objectMatches && objectMatches.length > 0) {
                    const incrementalRefs: import('../../context/types').ContextRef[] = [];

                    for (const objStr of objectMatches) {
                      try {
                        const obj = JSON.parse(objStr);
                        if (isValidContextRef(obj)) {
                          incrementalRefs.push(obj);
                          stats.parsedCount++;
                        } else {
                          stats.failedCount++;
                          console.warn('[ChatStore] Invalid ContextRef object:', obj);
                        }
                      } catch (itemError) {
                        stats.failedCount++;
                        console.warn('[ChatStore] Failed to parse individual item:', objStr, itemError);
                      }
                    }

                    if (incrementalRefs.length > 0) {
                      // ★ P0-03 补齐旧数据迁移：历史数据可能没有 isSticky 字段
                      pendingContextRefs = incrementalRefs.map((ref) => {
                        if (ref.typeId === SKILL_INSTRUCTION_TYPE_ID) {
                          return { ...ref, isSticky: true };
                        }
                        return ref;
                      });
                      stats.method = 'incremental';
                      parseResult = stats.failedCount > 0 ? 'partial' : 'success';

                      console.log('[ChatStore] ✅ Restored pendingContextRefs (incremental):', {
                        total: incrementalRefs.length,
                        failed: stats.failedCount,
                      });
                    } else {
                      throw new Error('No valid objects found in incremental parse');
                    }
                  } else {
                    throw new Error('No object patterns found');
                  }
                } else {
                  // 空数组
                  pendingContextRefs = [];
                  stats.method = 'incremental';
                  console.log('[ChatStore] Empty array detected');
                }

              } catch (incrementalError) {
                console.warn('[ChatStore] ⚠️ Incremental parse failed, trying string scanning extraction...', incrementalError);

                try {
                  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                  // 第三级：字符串扫描提取 ContextRef（安全的非正则方法）
                  //
                  // 安全设计说明：
                  // 1. 完全避免复杂正则表达式，防止 ReDoS 攻击
                  // 2. 使用简单的字符扫描，时间复杂度 O(n)
                  // 3. 添加超时保护机制，防止长时间运行
                  // 4. 对每个候选对象进行安全的 JSON 解析
                  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

                  // 性能监控：记录开始时间
                  const scanStartTime = performance.now();
                  const SCAN_TIMEOUT_MS = 5000; // 5秒超时保护

                  /**
                   * 从字符串中提取可能的 ContextRef 对象
                   * 使用简单的字符扫描，避免正则表达式回溯问题
                   */
                  const extractPossibleContextRefs = (jsonString: string): import('../../context/types').ContextRef[] => {
                    const refs: import('../../context/types').ContextRef[] = [];
                    let i = 0;
                    let objectsScanned = 0;
                    const maxObjectsToScan = 10000; // 最多扫描10000个对象，防止无限循环

                    while (i < jsonString.length) {
                      // 超时检查
                      if (performance.now() - scanStartTime > SCAN_TIMEOUT_MS) {
                        console.warn('[ChatStore] ⚠️ String scanning timeout, returning partial results');
                        break;
                      }

                      // 对象数量限制检查
                      if (objectsScanned >= maxObjectsToScan) {
                        console.warn('[ChatStore] ⚠️ Max objects scanned limit reached, returning partial results');
                        break;
                      }

                      // 查找对象开始位置
                      const start = jsonString.indexOf('{', i);
                      if (start === -1) break;

                      // 查找匹配的结束大括号（使用深度计数）
                      let depth = 0;
                      let end = start;
                      let foundEnd = false;

                      // 扫描最多1000个字符，防止单个对象过大
                      const maxScanLength = 1000;
                      const scanLimit = Math.min(start + maxScanLength, jsonString.length);

                      for (let j = start; j < scanLimit; j++) {
                        const char = jsonString[j];

                        if (char === '{') {
                          depth++;
                        } else if (char === '}') {
                          depth--;
                          if (depth === 0) {
                            end = j + 1;
                            foundEnd = true;
                            break;
                          }
                        }
                      }

                      if (foundEnd) {
                        const candidate = jsonString.substring(start, end);
                        objectsScanned++;

                        // 快速预检：必须包含所有必需字段
                        if (
                          candidate.includes('"resourceId"') &&
                          candidate.includes('"hash"') &&
                          candidate.includes('"typeId"')
                        ) {
                          // 尝试安全解析
                          try {
                            const obj = JSON.parse(candidate);

                            // 验证是否为有效的 ContextRef
                            if (isValidContextRef(obj)) {
                              refs.push(obj);
                              stats.parsedCount++;
                            } else {
                              stats.failedCount++;
                            }
                          } catch (parseError) {
                            // JSON 解析失败，继续扫描
                            stats.failedCount++;
                          }
                        }

                        // 移动到下一个位置
                        i = end;
                      } else {
                        // 没有找到匹配的结束大括号，跳过这个开始位置
                        i = start + 1;
                      }
                    }

                    return refs;
                  };

                  // 执行字符串扫描提取
                  const scanRefs = extractPossibleContextRefs(state.pendingContextRefsJson);
                  const scanDuration = performance.now() - scanStartTime;

                  if (scanRefs.length > 0) {
                    // ★ P0-03 补齐旧数据迁移：历史数据可能没有 isSticky 字段
                    pendingContextRefs = scanRefs.map((ref) => {
                      if (ref.typeId === SKILL_INSTRUCTION_TYPE_ID) {
                        return { ...ref, isSticky: true };
                      }
                      return ref;
                    });
                    stats.method = 'string-scan';
                    parseResult = 'partial'; // 字符串扫描一定是部分恢复

                    console.log('[ChatStore] ✅ Restored pendingContextRefs (string-scan):', {
                      total: scanRefs.length,
                      failed: stats.failedCount,
                      durationMs: scanDuration.toFixed(2),
                      performance: scanDuration < 100 ? '🚀 excellent' : scanDuration < 500 ? '✅ good' : '⚠️ slow',
                    });
                  } else {
                    throw new Error('No valid refs extracted by string scanning');
                  }

                } catch (scanError) {
                  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                  // 所有方法都失败
                  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                  stats.method = 'none';
                  parseResult = 'failed';

                  console.error('[ChatStore] ❌ All parse methods failed:', {
                    standardError,
                    incrementalError,
                    scanError,
                    originalJson: state.pendingContextRefsJson.substring(0, 500) + '...', // 只记录前500字符
                  });
                }
              }
            }

            // 📊 最终统计日志
            console.log('[ChatStore] Pending context refs parse summary:', {
              parseResult,
              stats,
              finalCount: pendingContextRefs.length,
            });

            // 🔔 用户通知（部分恢复或失败时）
            if (parseResult === 'partial') {
              // 延迟通知，避免阻塞初始化
              setTimeout(() => {
                const message = stats.parsedCount > 0
                  ? i18n.t('chatV2:chat.context_restored', { parsedCount: stats.parsedCount, failedCount: stats.failedCount })
                  : i18n.t('chatV2:chat.context_partially_corrupted');

                console.warn('[ChatStore] 🔔 User notification:', message);
                showGlobalNotification('warning', message);
              }, 1000);
            } else if (parseResult === 'failed') {
              setTimeout(() => {
                const message = i18n.t('chatV2:chat.context_corrupted');
                console.error('[ChatStore] 🔔 User notification:', message);
                showGlobalNotification('error', message);
              }, 1000);
            }
          }

          // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          // 辅助函数：验证 ContextRef 有效性
          // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          function isValidContextRef(obj: unknown): obj is import('../../context/types').ContextRef {
            if (!obj || typeof obj !== 'object') {
              return false;
            }

            const ref = obj as Record<string, unknown>;

            // 检查必需字段
            if (typeof ref.resourceId !== 'string' || !ref.resourceId.trim()) {
              return false;
            }
            if (typeof ref.hash !== 'string' || !ref.hash.trim()) {
              return false;
            }
            if (typeof ref.typeId !== 'string' || !ref.typeId.trim()) {
              return false;
            }

            // 额外验证：resourceId 格式（res_{nanoid(10)}）
            if (!/^res_[a-zA-Z0-9_-]{10}$/.test(ref.resourceId)) {
              console.warn('[ChatStore] Invalid resourceId format:', ref.resourceId);
              return false;
            }

            // 额外验证：hash 格式（SHA-256 hex）
            if (!/^[a-f0-9]{64}$/.test(ref.hash)) {
              console.warn('[ChatStore] Invalid hash format:', ref.hash);
              return false;
            }

            return true;
          }

          // 5. 设置状态（重置运行时状态）
          // 🚀 性能优化 V2：使用 queueMicrotask 延迟 Promise 回调
          //
          // 问题分析：set() 触发 React 在微任务中同步渲染，阻塞后续微任务 ~300ms
          //
          // 解决方案：
          // 1. 一次性 set() 所有状态（避免 UI 闪烁）
          // 2. 在 set() 前用 queueMicrotask 预先安排一个"让步"点
          //    让 loadSession Promise 可以更快 resolve

          // 🔧 安全解析 activeSkillIdsJson（统一为一次解析，防止 JSON 异常中断恢复）
          // ★ 2026-02 修复：当后端未保存 activeSkillIdsJson 时（新会话未发消息就触发 restore），
          //   保留 createSessionWithDefaults 已写入的 activeSkillIds，而非用空数组覆盖。
          //   若当前 store 也为空，回退到 skillDefaults（用户全局默认技能配置）。
          let restoredActiveSkillIds: string[] = [];
          if (state?.activeSkillIdsJson) {
            try {
              const parsed = JSON.parse(state.activeSkillIdsJson);
              if (Array.isArray(parsed)) {
                restoredActiveSkillIds = parsed.filter((id): id is string => typeof id === 'string');
              }
            } catch (e) {
              console.warn('[ChatStore] Failed to parse activeSkillIdsJson, falling back to defaults:', e);
            }
          } else {
            // 后端无保存 → 保留 createSessionWithDefaults 已设置的值，或回退到用户默认
            const currentSkillIds = getState().activeSkillIds;
            restoredActiveSkillIds = currentSkillIds.length > 0
              ? currentSkillIds
              : skillDefaults.getAll();
            console.log('[ChatStore] No saved activeSkillIds, using fallback:', restoredActiveSkillIds);
          }

          // 📊 细粒度打点：set 开始
          sessionSwitchPerf.mark('set_start', {
            messageCount: messageOrder.length,
            blockCount: blocksMap.size,
          });

          // 一次性更新所有状态
          set({
            sessionId: session.id,
            mode: session.mode,
            title: session.title ?? '',
            description: '', // 文档 28 改造：description 由后端事件更新，恢复时初始化为空
            groupId: session.groupId ?? null,
            sessionMetadata: session.metadata ?? null,
            sessionStatus: 'idle',
            isDataLoaded: true,
            messageMap,
            messageOrder,
            blocks: blocksMap,
            currentStreamingMessageId: null,
            activeBlockIds: new Set(),
            streamingVariantIds: new Set(),
            chatParams,
            features,
            modeState,
            inputValue,
            attachments: [],
            panelStates,
            pendingContextRefs,
            // 从安全解析的结果恢复（支持多选）
            activeSkillIds: restoredActiveSkillIds,
          });

          // 📊 细粒度打点：set 结束
          sessionSwitchPerf.mark('set_end');
          
          // 📊 细粒度打点：微任务检查点
          Promise.resolve().then(() => {
            sessionSwitchPerf.mark('microtask_check');
          });
          sessionSwitchPerf.mark('set_data_end', {
            phase: 'restore_total',
            ms: performance.now() - t0,
          });
          
          console.log('[ChatStore] Session restored from backend:', session.id, 'isDataLoaded: true');

          // 🔧 统一的异步恢复路径：资源验证 + 技能 ContextRef 重建
          // 合并原有的三条竞态路径为单一 queueMicrotask
          queueMicrotask(async () => {
            try {
              // === Step 0: 注入分组关联来源（pinned resources） ===
              const currentGroupId = getState().groupId;
              if (currentGroupId) {
                try {
                  const { invoke } = await import('@tauri-apps/api/core');
                  const group = await invoke<{ pinnedResourceIds?: string[] } | null>('chat_v2_get_group', { groupId: currentGroupId });
                  const pinnedIds = group?.pinnedResourceIds ?? [];
                  if (pinnedIds.length > 0) {
                    const { getResourceRefsV2 } = await import('../../context/vfsRefApi');
                    const { resourceStoreApi } = await import('../../resources');
                    const refsResult = await getResourceRefsV2(pinnedIds);
                    if (refsResult.ok && refsResult.value.refs.length > 0) {
                      const currentRefs = getState().pendingContextRefs;
                      const newRefs = [...currentRefs];
                      // Build a set of existing resourceIds for fast dedup
                      const existingResourceIds = new Set(currentRefs.map((r) => r.resourceId));
                      for (const vfsRef of refsResult.value.refs) {
                        try {
                          const resourceResult = await resourceStoreApi.createOrReuse({
                            type: vfsRef.type as import('../../context/types').ResourceType,
                            data: JSON.stringify({ refs: [vfsRef], totalCount: 1, truncated: false }),
                            sourceId: vfsRef.sourceId,
                            metadata: { name: vfsRef.name, title: vfsRef.name },
                          });
                          // Skip if same resourceId already in refs (exact content match via hash)
                          if (existingResourceIds.has(resourceResult.resourceId)) continue;
                          existingResourceIds.add(resourceResult.resourceId);

                          const contextRef: import('../../context/types').ContextRef = {
                            resourceId: resourceResult.resourceId,
                            hash: resourceResult.hash,
                            typeId: vfsRef.type,
                            isSticky: true,
                            displayName: vfsRef.name,
                          };
                          newRefs.push(contextRef);
                        } catch (refErr) {
                          console.warn('[ChatStore] Failed to create pinned resource ref:', vfsRef.sourceId, refErr);
                        }
                      }
                      if (newRefs.length > currentRefs.length) {
                        set({ pendingContextRefs: newRefs });
                        console.log('[ChatStore] Injected group pinned resources:', newRefs.length - currentRefs.length);
                      }
                    }
                  }
                } catch (groupErr) {
                  console.warn('[ChatStore] Failed to inject group pinned resources:', groupErr);
                }
              }

              // === Step 1: 恢复手动激活 Skills 的 ContextRefs ===
              if (restoredActiveSkillIds.length > 0) {
                try {
                  const { skillRegistry } = await import('../../skills/registry');
                  const { createResourceFromSkill } = await import('../../skills/resourceHelper');

                  for (const skillId of restoredActiveSkillIds) {
                    const skill = skillRegistry.get(skillId);
                    if (!skill) {
                      console.warn('[ChatStore] Active skill not found during restore:', skillId);
                      continue;
                    }

                    const contextRef = await createResourceFromSkill(skill);
                    if (!contextRef) {
                      console.warn('[ChatStore] Failed to create contextRef for active skill:', skillId);
                      continue;
                    }

                    // 避免重复添加同一 skill_instruction ref
                    const currentRefs = getState().pendingContextRefs;
                    const hasSkillRef = currentRefs.some(
                      (ref) => ref.typeId === SKILL_INSTRUCTION_TYPE_ID && ref.resourceId === contextRef.resourceId
                    );

                    if (!hasSkillRef) {
                      set({ pendingContextRefs: [...currentRefs, contextRef] });
                    }
                  }
                  console.log('[ChatStore] Restored active skill contextRefs:', restoredActiveSkillIds);
                } catch (error) {
                  console.warn('[ChatStore] Failed to restore active skill contextRefs:', error);
                }
              }

              // === Step 2: 兼容恢复 — 如果 activeSkillIdsJson 为空但存在 skill refs，从 refs 推断 ===
              if (restoredActiveSkillIds.length === 0 && pendingContextRefs.length > 0) {
                const orphanSkillRefs = pendingContextRefs.filter(
                  (ref) => ref.typeId === SKILL_INSTRUCTION_TYPE_ID && ref.isSticky
                );
                if (orphanSkillRefs.length > 0) {
                  const { resourceStoreApi } = await import('../../resources');
                  const inferredIds: string[] = [];
                  for (const skillRef of orphanSkillRefs) {
                    // 优先使用 ref.skillId（如果存在）
                    if (skillRef.skillId) {
                      if (!inferredIds.includes(skillRef.skillId)) {
                        inferredIds.push(skillRef.skillId);
                      }
                      continue;
                    }
                    // 否则从资源元数据推断
                    try {
                      const resource = await resourceStoreApi.get(skillRef.resourceId, skillRef.hash);
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      const skillId = (resource?.metadata as any)?.skillId as string | undefined;
                      if (skillId && !inferredIds.includes(skillId)) {
                        inferredIds.push(skillId);
                      }
                    } catch (e) {
                      console.warn('[ChatStore] Failed to infer skill from ref:', e);
                    }
                  }
                  if (inferredIds.length > 0) {
                    set({ activeSkillIds: inferredIds } as Partial<ChatStoreState>);
                    console.log('[ChatStore] Inferred activeSkillIds from orphan refs:', inferredIds);
                  }
                }
              }

              // === Step 3: 验证资源有效性 ===
              // 🔧 使用 getState() 获取最新的 refs（包含 Step 1 新增的 skill refs）
              const currentRefsForValidation = getState().pendingContextRefs;
              if (currentRefsForValidation.length > 0) {
                const { resourceStoreApi } = await import('../../resources');
                const validRefs: import('../../context/types').ContextRef[] = [];
                const invalidRefs: string[] = [];

                for (const ref of currentRefsForValidation) {
                  try {
                    const exists = await resourceStoreApi.exists(ref.resourceId);
                    if (exists) {
                      validRefs.push(ref);
                    } else {
                      invalidRefs.push(ref.resourceId);
                    }
                  } catch {
                    // 验证失败时保留引用（宁可多保留，避免丢失用户数据）
                    validRefs.push(ref);
                  }
                }

                if (invalidRefs.length > 0) {
                  console.warn('[ChatStore] Removing invalid refs:', invalidRefs.length);
                  set({ pendingContextRefs: validRefs });
                  showGlobalNotification('warning', i18n.t('chatV2:chat.context_invalid_removed', { count: invalidRefs.length }));
                }
              }

              // 🔧 修复：会话恢复完成后修复 skill 状态一致性
              // repairSkillState 从 hasActiveSkill getter 中提取，避免 getter 副作用
              getState().repairSkillState();
            } catch (e) {
              console.error('[ChatStore] Failed during unified session restore:', e);
            }
          });

          // 🔧 Canvas 笔记引用恢复：始终发射事件以确保会话切换时状态正确同步
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const canvasNoteId = (modeState as any)?.canvasNoteId as string | undefined;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const canvasNoteHistory = (modeState as any)?.canvasNoteHistory as string[] | undefined;
          
          // 始终发射事件，即使没有 Canvas 状态（用于清理上一个会话的状态）
          console.log('[ChatStore] Syncing canvas note reference:', { canvasNoteId, canvasNoteHistory });
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('canvas:restore-note', { 
              detail: { 
                noteId: canvasNoteId || null,
                noteHistory: canvasNoteHistory || [],
              } 
            }));
          }, 0);

          // 🆕 渐进披露：恢复已加载的 Skills
          // 🔧 增加 registry 就绪等待，避免 skills 尚未加载完成导致 notFound
          if (state?.loadedSkillIdsJson) {
            queueMicrotask(async () => {
              try {
                const skillIds: string[] = JSON.parse(state.loadedSkillIdsJson);
                if (skillIds.length > 0) {
                  // 等待 skillRegistry 初始化完成（带超时保护）
                  const { skillRegistry } = await import('../../skills/registry');
                  if (!skillRegistry.isInitialized()) {
                    const ready = await skillRegistry.waitForInitialized(5000);
                    if (!ready) {
                      console.warn('[ChatStore] Skill registry not ready after 5s, restoring loaded skills anyway');
                    }
                  }

                  const { loadSkillsToSession } = await import('../../skills/progressiveDisclosure');
                  const attemptRestoreLoadedSkills = () => loadSkillsToSession(session.id, skillIds);
                  const loadResult = attemptRestoreLoadedSkills();
                  console.log('[ChatStore] Restored loaded skills:', {
                    sessionId: session.id,
                    requestedSkills: skillIds,
                    loadedCount: loadResult.loaded.length,
                    notFoundCount: loadResult.notFound.length,
                  });

                  // 🔧 如果部分技能未找到，可能是 skills 仍在加载中：订阅 registry 更新并重试（有限次数）
                  if (loadResult.notFound.length > 0) {
                    const { subscribeToSkillRegistry } = await import('../../skills/registry');
                    let retries = 0;
                    const maxRetries = 3;
                    const unsubscribe = subscribeToSkillRegistry(() => {
                      retries++;
                      const retryResult = attemptRestoreLoadedSkills();
                      console.log('[ChatStore] Retry restoring loaded skills:', {
                        sessionId: session.id,
                        retry: retries,
                        loadedCount: retryResult.loaded.length,
                        notFoundCount: retryResult.notFound.length,
                      });

                      if (retryResult.notFound.length === 0 || retries >= maxRetries) {
                        unsubscribe();
                      }
                    });

                    // 超时兜底：避免极端情况下不触发更新导致订阅常驻
                    setTimeout(() => {
                      try {
                        unsubscribe();
                      } catch {
                        // ignore
                      }
                    }, 5000);
                  }
                }
              } catch (e) {
                console.warn('[ChatStore] Failed to restore loaded skills:', e);
              }
            });
          }
        },

        // ========== 辅助方法 ==========

        getMessage: (messageId: string) => {
          return getState().messageMap.get(messageId);
        },

        getMessageBlocks: (messageId: string) => {
          const state = getState();
          const message = state.messageMap.get(messageId);
          if (!message) return [];
          return message.blockIds
            .map((id) => state.blocks.get(id))
            .filter((b): b is NonNullable<typeof b> => b !== undefined);
        },

        getOrderedMessages: () => {
          const state = getState();
          return state.messageOrder
            .map((id) => state.messageMap.get(id))
            .filter((m): m is NonNullable<typeof m> => m !== undefined);
        },

        // ========== 变体 Actions ==========

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
    })
  );
}

/**
 * 创建 ChatStore 实例的别名（为了兼容）
 */
export const createStore_ = createChatStore;
