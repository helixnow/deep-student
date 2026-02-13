/**
 * Chat V2 - Store 模块导出
 */

// ============================================================================
// Store 工厂函数
// ============================================================================

export { createChatStore, createStore_ } from './createChatStore';

// ============================================================================
// chatStore 类型重导出
// ============================================================================

export * from './chatStore';

// ============================================================================
// 类型导出
// ============================================================================

export type {
  ChatStoreState,
  SetState,
  GetState,
  Block,
  BlockType,
  BlockStatus,
  Message,
  AttachmentMeta,
  Variant,
  VariantStatus,
  SharedContext,
  SessionStatus,
  ChatParams,
  PanelStates,
  ChatStore,
} from './types';

// ============================================================================
// 工厂函数
// ============================================================================

export {
  createDefaultPanelStates,
  createDefaultChatParams,
  createInitialState,
} from './types';

// ============================================================================
// Actions 说明
// ============================================================================

// 所有 Actions 直接在 createChatStore.ts 中定义
// 独立模块：contextActions.ts（上下文引用）、variantActions.ts（变体管理）

// ============================================================================
// 守卫
// ============================================================================

export { createGuards, type Guards } from './guards';

// ============================================================================
// 变体 Actions
// ============================================================================

export {
  createVariantActions,
  generateVariantId,
  canSwitchToVariant,
  determineActiveVariantId,
  debouncedSwitchVariantBackend,
  clearVariantDebounceTimer,
  clearVariantDebounceTimersForSession,
  clearAllVariantDebounceTimers,
  type VariantActions,
  type VariantState,
  type VariantCallbacks,
  type BackendVariantEvent,
} from './variantActions';

// ============================================================================
// 选择器
// ============================================================================

export {
  // 基础选择器
  selectSessionId,
  selectMode,
  selectSessionStatus,
  selectMessageOrder,
  selectChatParams,
  selectInputValue,
  selectAttachments,
  selectPanelStates,
  selectCurrentStreamingMessageId,
  selectModeState,
  // 消息选择器
  selectMessage,
  selectOrderedMessages,
  selectMessageCount,
  // 块选择器
  selectBlock,
  selectMessageBlocks,
  selectActiveBlockIds,
  selectIsBlockStreaming,
  // 功能开关选择器
  selectFeature,
  selectAllFeatures,
  // 派生状态选择器
  selectIsStreaming,
  selectIsAborting,
  selectIsIdle,
  selectHasMessages,
  selectLastMessage,
  selectLastAssistantMessage,
  selectLastUserMessage,
  // 组合选择器工厂
  createMessageContentSelector,
  createMessageThinkingSelector,
} from './selectors';

export type { ChatStoreInstance } from './selectors';
