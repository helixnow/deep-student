/**
 * Chat V2 - 主入口
 *
 * 统一导出所有公共 API
 */

// ============================================================================
// 初始化（导入即注册所有插件）
// ============================================================================

export * from './init';

// ============================================================================
// 核心类型
// ============================================================================

export type {
  // Block
  BlockType,
  BlockStatus,
  Block,
  Citation,
  CreateBlockParams,
  UpdateBlockParams,
  // Message
  MessageRole,
  Message,
  MessageMeta,
  ChatParamsSnapshot,
  MessageSources,
  SourceInfo,
  ToolResult,
  AnkiCardInfo,
  AttachmentMeta,
  CreateUserMessageParams,
  CreateAssistantMessageParams,
  // Store
  SessionStatus,
  ChatParams,
  PanelStates,
  ChatStore,
  SessionPersistData,
} from './core/types';

// ============================================================================
// 注册表
// ============================================================================

export {
  Registry,
  modeRegistry,
  blockRegistry,
  eventRegistry,
} from './registry';

export type {
  ModeConfig,
  ModePlugin,
  BlockComponentProps,
  OnAbortBehavior,
  BlockRendererPlugin,
  EventHandler,
} from './registry';

// ============================================================================
// 组件
// ============================================================================

export {
  ChatContainer,
  MessageList,
  MessageItem,
  BlockRenderer,
  InputBar,
} from './components';

export type {
  ChatContainerProps,
  MessageListProps,
  MessageItemProps,
  BlockRendererProps,
  InputBarProps,
} from './components';

// ============================================================================
// Hooks
// ============================================================================

export {
  // 单会话 Store 选择器
  useMessage,
  useMessageOrder,
  useMessageBlocks,
  useBlock,
  useSessionStatus,
  useCanSend,
  useCanAbort,
  useInputValue,
  useAttachments,
  usePanelStates,
  useChatParams,
  useFeature,
  useModeState,
  useCurrentStreamingMessageId,
  useActiveBlockIds,
  useIsBlockActive,
  // 会话管理
  useChatSession,
  useChatSessionIfExists,
  useHasSession,
  // 组合 Hook（推荐）
  useConnectedSession,
  // 后端适配器 Hook
  useTauriAdapter,
  // 多会话监听
  useStreamingSessions,
  useSessionCount,
  useDestroySession,
  useDestroyAllSessions,
} from './hooks';

export type {
  UseConnectedSessionResult,
  UseTauriAdapterResult,
} from './hooks';

// ============================================================================
// Session 管理
// ============================================================================

export { sessionManager } from './core/session';

export type {
  ISessionManager,
  CreateSessionOptions,
  SessionManagerEvent,
  SessionManagerEventType,
  SessionManagerListener,
} from './core/session';

// ============================================================================
// Store 工厂
// ============================================================================

export { createChatStore } from './core/store';

// ============================================================================
// Adapters - 后端通信适配器
// ============================================================================

export { ChatV2TauriAdapter } from './adapters';

export type {
  SendOptions,
  SendMessageRequest,
  SessionEventPayload,
  SessionEventType,
  LoadSessionResponse,
  SessionInfo,
  BackendMessage,
  BackendBlock,
  SessionState,
  SessionSettings,
  CreateSessionRequest,
} from './adapters';

// ============================================================================
// Skills - 技能系统
// ============================================================================

export {
  // 注册表
  skillRegistry,
  getSkill,
  getAutoInvokeSkills,
  getSkillContextTypeId,
  // 类型定义
  SKILL_INSTRUCTION_TYPE_ID,
  SKILL_DEFAULT_PRIORITY,
  SKILL_XML_TAG,
  DEFAULT_SKILL_LOAD_CONFIG,
  validateSkillMetadata,
  // 解析器
  parseSkillFile,
  isValidSkillFile,
  extractSkillMetadata,
  // 初始化
  initializeSkillSystem,
  isSkillSystemInitialized,
  resetSkillSystem,
  // 加载器
  loadSkillsFromFileSystem,
  reloadSkills,
  loadSingleSkill,
  // 资源辅助
  createResourceFromSkill,
  createResourcesFromSkills,
  isSkillContextRef,
  // UI 组件
  SkillCard,
  ActiveSkillBadge,
  ActiveSkillBadgeCompact,
  NoActiveSkillButton,
  SkillSelector,
  // Hooks
  useSkillList,
  useSkillDetails,
  useSkillsByLocation,
  useAutoInvokeSkills,
  useSkillSearch,
  useSkillSummary,
} from './skills';

export type {
  SkillMetadata,
  SkillDefinition,
  SkillLocation,
  SkillLoadConfig,
  SkillResourceMetadata,
  SkillParseResult,
  SkillValidationResult,
  SkillCardProps,
  ActiveSkillBadgeProps,
  NoActiveSkillProps,
  SkillSelectorProps,
} from './skills';
