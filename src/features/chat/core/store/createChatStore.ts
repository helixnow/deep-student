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
import { getErrorMessage } from '@/utils/errorUtils';
import { sessionSwitchPerf } from '../../debug/sessionSwitchPerf';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import i18n from 'i18next';
import { autoSave } from '../middleware/autoSave';
import { chunkBuffer } from '../middleware/chunkBuffer';
import { clearEventContext, clearBridgeState } from '../middleware/eventBridge';
import {
  createInitialState,
  createDefaultChatParams,
  createDefaultPanelStates,
  type ChatStoreState,
  type SetState,
  type GetState,
} from './types';
import { modeRegistry, blockRegistry } from '../../registry';
import { logMultiVariant } from '@/debug-panel/plugins/MultiVariantDebugPlugin';
import { logChatV2, logAttachment } from '../../debug/chatV2Logger';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { createContextActions } from './contextActions';
import { createSkillActions } from './skillActions';
import { createMessageActions } from './messageActions';
import { createBlockActions } from './blockActions';
import { createStreamActions } from './streamActions';
import { createSessionActions } from './sessionActions';
import { createRestoreActions } from './restoreActions';
import { createVariantStoreActions } from './variantStoreActions';
import { createQueueActions } from './queueActions';
import { readBlockingInteraction } from '../types/queue';
import type { ContextRef } from '../../resources/types';
import type { EditMessageResult, RetryMessageResult } from '../../adapters/types';
import { SKILL_INSTRUCTION_TYPE_ID } from '../../skills/types';
import { skillDefaults } from '../../skills/skillDefaults';
import { usePdfProcessingStore } from '@/features/pdf/stores/pdfProcessingStore';
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

export const IS_VITEST = typeof process !== 'undefined' && Boolean(process.env?.VITEST);
const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

export const OPERATION_LOCK_TIMEOUT_MS = 30_000;

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
export function generateId(prefix: string): string {
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
export function showOperationLockNotification(): void {
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
export function createBlockInternal(
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
  const store = createStore<ChatStore>()(
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

      // 创建队列 Actions
      const queueActions = createQueueActions(
        set as Parameters<typeof createQueueActions>[0],
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

        ...createMessageActions(set as SetState, getState),
        ...createBlockActions(set as SetState, getState),
        ...createStreamActions(set as SetState, getState),
        ...createSessionActions(set as SetState, getState, scheduleAutoSaveIfReady),
        ...createRestoreActions(set as SetState, getState),

        // ========== 队列 Actions ==========
        ...queueActions,

        // ========== 辅助方法 ==========

        pendingApprovalRequest: null,

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

        ...createVariantStoreActions(set as SetState, getState),
      };
    })
  );

  // Auto-progress queue when status returns to idle OR when a blocking
  // interaction clears. This is the dequeue heartbeat — fired by zustand's
  // subscribe. The prev-state diff prevents re-firing on unrelated changes
  // and avoids infinite loops.
  //
  // Blocking-interaction reads use the shared `readBlockingInteraction` helper
  // so this works regardless of whether the codebase exposes the field as
  // `pendingApprovalRequest` (HEAD) or `pendingBlockingInteraction` (refactor).
  let prevStatus = store.getState().sessionStatus;
  let prevBlocking = readBlockingInteraction(store.getState());
  store.subscribe((state) => {
    const justBecameIdle = prevStatus !== 'idle' && state.sessionStatus === 'idle';
    const nextBlocking = readBlockingInteraction(state);
    const blockingCleared = prevBlocking !== null && nextBlocking === null;
    prevStatus = state.sessionStatus;
    prevBlocking = nextBlocking;
    if (justBecameIdle || blockingCleared) {
      void state.maybeDequeue();
    }
  });

  return store;
}

/**
 * 创建 ChatStore 实例的别名（为了兼容）
 */
export const createStore_ = createChatStore;
