/**
 * Chat V2 - Hooks 导出
 *
 * 包含所有 Chat V2 相关的 React Hooks。
 */

// ============================================================================
// 单会话 Store 选择器
// ============================================================================

export {
  useMessage,
  useMessageOrder,
  useMessageBlocks,
  useBlock,
  useSessionStatus,
  useCanSend,
  useCanAbort,
  useTitle,
  useInputValue,
  useAttachments,
  usePanelStates,
  useChatParams,
  useFeature,
  useModeState,
  useCurrentStreamingMessageId,
  useActiveBlockIds,
  useIsBlockActive,
} from './useChatStore';

// ============================================================================
// 会话管理（基础）
// ============================================================================

export {
  useChatSession,
  useChatSessionIfExists,
  useHasSession,
} from './useChatSession';

// ============================================================================
// 多会话监听
// ============================================================================

export {
  useStreamingSessions,
  useSessionCount,
  useDestroySession,
  useDestroyAllSessions,
} from './useStreamingSessions';

// ============================================================================
// SessionManager Hooks（高级多会话管理）
// ============================================================================

export {
  // 核心 Hooks
  useSessionStore,
  useSessionStoreSelector,
  useSessionStoreApi,
  // 生命周期管理
  useSessionWithLifecycle,
  // 状态监听
  useSessionManagerEvents,
  useAllSessionIds,
  useIsSessionStreaming,
  // 便捷操作
  useDestroyMultipleSessions,
  useSessionStats,
  // 常量
  MAX_SESSIONS,
  // Re-exports
  sessionManager,
  type ISessionManager,
  type CreateSessionOptions,
  type SessionManagerEvent,
  type SessionManagerListener,
  type ChatStoreApi,
  type SessionStats,
} from './SessionManager';

// ============================================================================
// Tauri 适配器
// ============================================================================

export {
  useTauriAdapter,
  type UseTauriAdapterResult,
} from './useTauriAdapter';

// ============================================================================
// 组合 Hook（推荐）
// ============================================================================

export {
  useConnectedSession,
  type UseConnectedSessionResult,
} from './useConnectedSession';

// ============================================================================
// 变体 UI Hook（多模型并行）
// ============================================================================

export {
  useVariantUI,
  type UseVariantUIOptions,
  type UseVariantUIResult,
} from './useVariantUI';

// ============================================================================
// 可用模型列表（多变体支持）
// ============================================================================

export {
  useAvailableModels,
  clearModelsCache,
} from './useAvailableModels';

// ============================================================================
// 附件上下文引用管理
// ============================================================================

export {
  useAttachmentContextRef,
  type UseAttachmentContextRefOptions,
  type UseAttachmentContextRefReturn,
  type AttachmentResourceMapping,
} from './useAttachmentContextRef';

// ============================================================================
// 文件夹上下文引用管理
// ============================================================================

export {
  useFolderContextRef,
  type UseFolderContextRefOptions,
  type UseFolderContextRefReturn,
  type InjectFolderResult,
  type FolderResourcesResult,
  type FolderResourceInfo,
} from './useFolderContextRef';

// ============================================================================
// 图片预览（从上下文引用获取）
// ============================================================================

export {
  useImagePreviewsFromRefs,
  type ImagePreview,
  type UseImagePreviewsFromRefsResult,
} from './useImagePreviewsFromRefs';

// ============================================================================
// 文件预览（从上下文引用获取）
// ============================================================================

export {
  useFilePreviewsFromRefs,
  type FilePreview,
  type UseFilePreviewsFromRefsResult,
} from './useFilePreviewsFromRefs';

export {
  useSessionManagement,
  getTimeGroup,
  groupSessionsByTime,
  type ChatSession,
  type TimeGroup,
} from './useSessionManagement';

export { useGroupManagement } from './useGroupManagement';
export { useGroupCollapse } from './useGroupCollapse';

export { useTrashManagement } from './useTrashManagement';

export { useDeleteConfirmation } from './useDeleteConfirmation';
