/**
 * Chat V2 - Store 选择器
 *
 * 细粒度选择器，避免不必要的重渲染。
 * 选择器是纯函数，基于状态返回派生数据。
 */

import type { StoreApi, UseBoundStore } from 'zustand';
import type { ChatStoreState, Block, Message } from './types';
import type { ChatStore } from '../types/store';

// ============================================================================
// 选择器类型
// ============================================================================

/**
 * Store 类型（Zustand）
 */
export type ChatStoreInstance = UseBoundStore<StoreApi<ChatStore>>;

// ============================================================================
// 基础选择器
// ============================================================================

/**
 * 选择会话 ID
 */
export const selectSessionId = (state: ChatStoreState): string => state.sessionId;

/**
 * 选择会话模式
 */
export const selectMode = (state: ChatStoreState): string => state.mode;

/**
 * 选择会话状态
 */
export const selectSessionStatus = (state: ChatStoreState) => state.sessionStatus;

/**
 * 选择消息顺序数组
 */
export const selectMessageOrder = (state: ChatStoreState): string[] => state.messageOrder;

/**
 * 选择对话参数
 */
export const selectChatParams = (state: ChatStoreState) => state.chatParams;

/**
 * 选择输入框内容
 */
export const selectInputValue = (state: ChatStoreState): string => state.inputValue;

/**
 * 选择附件列表
 */
export const selectAttachments = (state: ChatStoreState) => state.attachments;

/**
 * 选择面板状态
 */
export const selectPanelStates = (state: ChatStoreState) => state.panelStates;

/**
 * 选择当前流式消息 ID
 */
export const selectCurrentStreamingMessageId = (state: ChatStoreState) =>
  state.currentStreamingMessageId;

/**
 * 选择模式状态
 */
export const selectModeState = (state: ChatStoreState) => state.modeState;

// ============================================================================
// 消息选择器
// ============================================================================

/**
 * 选择指定消息
 */
export const selectMessage =
  (messageId: string) =>
  (state: ChatStoreState): Message | undefined =>
    state.messageMap.get(messageId);

/**
 * 选择有序消息列表
 * 使用缓存避免 useStore 场景下的无效重渲染
 */
let _cachedMessageOrder: string[] | null = null;
let _cachedMessageMap: Map<string, Message> | null = null;
let _cachedResult: Message[] = [];

export const selectOrderedMessages = (state: ChatStoreState): Message[] => {
  if (state.messageOrder === _cachedMessageOrder && state.messageMap === _cachedMessageMap) {
    return _cachedResult;
  }
  _cachedMessageOrder = state.messageOrder;
  _cachedMessageMap = state.messageMap;
  _cachedResult = state.messageOrder
    .map((id) => state.messageMap.get(id))
    .filter((msg): msg is Message => msg !== undefined);
  return _cachedResult;
};

/**
 * 选择消息数量
 */
export const selectMessageCount = (state: ChatStoreState): number =>
  state.messageOrder.length;

// ============================================================================
// 块选择器
// ============================================================================

/**
 * 选择指定块
 */
export const selectBlock =
  (blockId: string) =>
  (state: ChatStoreState): Block | undefined =>
    state.blocks.get(blockId);

/**
 * 选择消息的所有块
 */
export const selectMessageBlocks =
  (messageId: string) =>
  (state: ChatStoreState): Block[] => {
    const message = state.messageMap.get(messageId);
    if (!message) return [];

    return message.blockIds
      .map((id) => state.blocks.get(id))
      .filter((block): block is Block => block !== undefined);
  };

/**
 * 选择活跃块 ID 集合
 */
export const selectActiveBlockIds = (state: ChatStoreState): Set<string> =>
  state.activeBlockIds;

/**
 * 检查块是否正在流式
 */
export const selectIsBlockStreaming =
  (blockId: string) =>
  (state: ChatStoreState): boolean =>
    state.activeBlockIds.has(blockId);

// ============================================================================
// 功能开关选择器
// ============================================================================

/**
 * 选择功能开关
 */
export const selectFeature =
  (key: string) =>
  (state: ChatStoreState): boolean =>
    state.features.get(key) ?? false;

/**
 * 选择所有功能开关
 */
export const selectAllFeatures = (state: ChatStoreState): Map<string, boolean> =>
  state.features;

// ============================================================================
// 派生状态选择器
// ============================================================================

/**
 * 选择是否正在流式
 */
export const selectIsStreaming = (state: ChatStoreState): boolean =>
  state.sessionStatus === 'streaming';

/**
 * 选择是否正在中断
 */
export const selectIsAborting = (state: ChatStoreState): boolean =>
  state.sessionStatus === 'aborting';

/**
 * 选择是否空闲
 */
export const selectIsIdle = (state: ChatStoreState): boolean =>
  state.sessionStatus === 'idle';

/**
 * 选择是否有消息
 */
export const selectHasMessages = (state: ChatStoreState): boolean =>
  state.messageOrder.length > 0;

/**
 * 选择最后一条消息
 */
export const selectLastMessage = (state: ChatStoreState): Message | undefined => {
  const lastId = state.messageOrder[state.messageOrder.length - 1];
  return lastId ? state.messageMap.get(lastId) : undefined;
};

/**
 * 选择最后一条助手消息
 */
export const selectLastAssistantMessage = (state: ChatStoreState): Message | undefined => {
  for (let i = state.messageOrder.length - 1; i >= 0; i--) {
    const msg = state.messageMap.get(state.messageOrder[i]);
    if (msg?.role === 'assistant') return msg;
  }
  return undefined;
};

/**
 * 选择最后一条用户消息
 */
export const selectLastUserMessage = (state: ChatStoreState): Message | undefined => {
  for (let i = state.messageOrder.length - 1; i >= 0; i--) {
    const msg = state.messageMap.get(state.messageOrder[i]);
    if (msg?.role === 'user') return msg;
  }
  return undefined;
};

// ============================================================================
// 组合选择器工厂
// ============================================================================

/**
 * 创建消息内容选择器
 * 返回消息的第一个 content 块的内容
 */
export const createMessageContentSelector =
  (messageId: string) =>
  (state: ChatStoreState): string => {
    const message = state.messageMap.get(messageId);
    if (!message) return '';

    for (const blockId of message.blockIds) {
      const block = state.blocks.get(blockId);
      if (block?.type === 'content' && block.content) {
        return block.content;
      }
    }
    return '';
  };

/**
 * 创建消息 thinking 内容选择器
 * 返回消息的所有 thinking 块的内容
 */
export const createMessageThinkingSelector =
  (messageId: string) =>
  (state: ChatStoreState): string => {
    const message = state.messageMap.get(messageId);
    if (!message) return '';

    const thinkingContents: string[] = [];
    for (const blockId of message.blockIds) {
      const block = state.blocks.get(blockId);
      if (block?.type === 'thinking' && block.content) {
        thinkingContents.push(block.content);
      }
    }
    return thinkingContents.join('\n\n');
  };
