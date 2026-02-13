/**
 * Chat V2 - Store 内部类型定义
 *
 * 定义 Store 实现所需的内部类型
 */

import type { Block, BlockType, BlockStatus } from '../types/block';
import type { Message, MessageMeta, AttachmentMeta, Variant, VariantStatus, SharedContext } from '../types/message';
import type {
  SessionStatus,
  ChatParams,
  PanelStates,
  ChatStore,
} from '../types/store';
import { createDefaultChatParams, createDefaultPanelStates } from '../types/common';
import type { ContextRef } from '../../context/types';
import type { EditMessageResult, RetryMessageResult } from '../../adapters/types';

// ============================================================================
// 重新导出常用类型
// ============================================================================

export type {
  Block,
  BlockType,
  BlockStatus,
  Message,
  MessageMeta,
  AttachmentMeta,
  Variant,
  VariantStatus,
  SharedContext,
  SessionStatus,
  ChatParams,
  PanelStates,
  ChatStore,
};

// ============================================================================
// Callback 类型定义（🔧 P1修复：类型安全）
// ============================================================================

/**
 * 所有 Callback 的类型定义
 *
 * 🔧 P1修复：将所有 Callback 正式定义为类型，避免类型断言
 * 这些 Callback 由 TauriAdapter 注入，用于前后端通信
 */
export interface StoreCallbacks {
  /** 发送消息回调 */
  _sendCallback?: ((
    content: string,
    attachments: AttachmentMeta[] | undefined,
    userMessageId: string,
    assistantMessageId: string
  ) => Promise<void>) | null;

  /** 
   * 重试消息回调 
   * 🆕 P1 状态同步修复: 返回 RetryMessageResult 用于前端状态同步
   */
  _retryCallback?: ((messageId: string, modelOverride?: string) => Promise<RetryMessageResult>) | null;

  /** 删除消息回调 */
  _deleteCallback?: ((messageId: string) => Promise<void>) | null;

  /** 
   * 编辑并重发回调 
   * 🆕 P1 状态同步修复: 返回 EditMessageResult 用于前端状态同步
   */
  _editAndResendCallback?: ((
    messageId: string,
    newContent: string,
    newContextRefs?: ContextRef[]
  ) => Promise<EditMessageResult>) | null;

  /** 保存会话回调 */
  _saveCallback?: (() => Promise<void>) | null;

  /** 加载会话回调 */
  _loadCallback?: (() => Promise<void>) | null;

  /** 中断流式回调 */
  _abortCallback?: (() => Promise<void>) | null;

  /** 更新块内容回调 */
  _updateBlockContentCallback?: ((blockId: string, content: string) => Promise<void>) | null;

  /** 更新会话设置回调 */
  _updateSessionSettingsCallback?: ((settings: { title?: string }) => Promise<void>) | null;

  /** 切换变体回调 */
  _switchVariantCallback?: ((messageId: string, variantId: string) => Promise<void>) | null;

  /** 删除变体回调 */
  _deleteVariantCallback?: ((
    messageId: string,
    variantId: string
  ) => Promise<{ variantDeleted?: boolean; messageDeleted?: boolean; newActiveId?: string }>) | null;

  /** 重试变体回调 */
  _retryVariantCallback?: ((
    messageId: string,
    variantId: string,
    modelOverride?: string
  ) => Promise<void>) | null;

  /** 重试所有变体回调 */
  _retryAllVariantsCallback?: ((
    messageId: string,
    variantIds: string[]
  ) => Promise<void>) | null;

  /** 取消变体回调 */
  _cancelVariantCallback?: ((variantId: string) => Promise<void>) | null;

  /** 🔧 P0 修复：继续执行消息回调 */
  _continueMessageCallback?: ((messageId: string, variantId?: string) => Promise<void>) | null;
}

// ============================================================================
// Store 状态类型（不含 Actions）
// ============================================================================

/**
 * ChatStore 的纯状态部分（不含方法）
 *
 * 🔧 P1修复：继承 StoreCallbacks 以获得类型安全的 Callback 定义
 */
export interface ChatStoreState extends StoreCallbacks {
  /** 会话 ID */
  sessionId: string;

  /** 会话模式 */
  mode: string;

  /** 会话标题 */
  title: string;

  /** 会话简介（自动生成） */
  description: string;

  /** 分组 ID（可选） */
  groupId: string | null;

  /** 会话元数据 */
  sessionMetadata: Record<string, unknown> | null;

  /** 会话状态 */
  sessionStatus: SessionStatus;

  /**
   * 🔧 性能优化：标记会话数据是否已从后端加载
   * - true: 数据已加载，切换回此会话时跳过 loadSession
   * - false: 需要从后端加载数据
   */
  isDataLoaded: boolean;

  /** 消息 Map */
  messageMap: Map<string, Message>;

  /** 消息顺序 */
  messageOrder: string[];

  /** 块 Map */
  blocks: Map<string, Block>;

  /** 当前流式消息 ID */
  currentStreamingMessageId: string | null;

  /** 活跃块 ID 集合 */
  activeBlockIds: Set<string>;

  // ========== 变体追踪（✔️ 运行时状态） ==========

  /** 正在流式的变体 ID 集合 */
  streamingVariantIds: Set<string>;

  /** 待发送的并行模型 ID 列表（发送后清空） */
  pendingParallelModelIds: string[] | null;

  // ========== 模型重试追踪（✔️ 运行时状态） ==========

  /** 待重试的消息 ID（用于底部面板模型选择重试） */
  modelRetryTarget: string | null;

  // ========== 🆕 消息操作锁（✔️ 运行时状态） ==========

  /** 当前进行中的消息操作（防止重复操作） */
  messageOperationLock: {
    messageId: string;
    operation: 'retry' | 'edit' | 'delete' | 'resend';
  } | null;

  // ========== 🆕 上下文引用（✔️ 持久化） ==========

  /** 待发送的上下文引用列表（只存引用，不存内容） */
  pendingContextRefs: ContextRef[];

  // ========== 🆕 工具审批请求（✔️ 运行时状态，文档 29 P1-3） ==========

  /** 待处理的工具审批请求 */
  pendingApprovalRequest: {
    toolCallId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    sensitivity: 'low' | 'medium' | 'high';
    description: string;
    timeoutSeconds: number;
    resolvedStatus?: 'approved' | 'rejected' | 'timeout' | 'expired' | 'error';
    resolvedReason?: string;
  } | null;

  // ========== 🆕 Skills 系统（✔️ 运行时状态） ==========

  /** 当前激活的 Skill ID 列表（支持多选） */
  activeSkillIds: string[];

  /** 对话参数 */
  chatParams: ChatParams;

  /** 功能开关 */
  features: Map<string, boolean>;

  /** 模式状态 */
  modeState: Record<string, unknown> | null;

  /** 输入框内容 */
  inputValue: string;

  /** 附件列表 */
  attachments: AttachmentMeta[];

  /** 面板状态 */
  panelStates: PanelStates;
}

// ============================================================================
// Store Setter 类型
// ============================================================================

/**
 * Zustand set 函数类型
 */
export type SetState = (
  partial:
    | Partial<ChatStoreState>
    | ((state: ChatStoreState) => Partial<ChatStoreState>),
  replace?: boolean
) => void;

/**
 * Zustand get 函数类型
 */
export type GetState = () => ChatStoreState & ChatStore;

// ============================================================================
// 初始状态工厂（从 common.ts 导入，此处为唯一出口）
// ============================================================================

// 🔧 审计修复：移除重复定义，统一使用 common.ts 中的完整版本
// （包含 modelDisplayName、maxToolRecursion 等字段）
export { createDefaultChatParams, createDefaultPanelStates };

/**
 * 创建初始 Store 状态
 */
export function createInitialState(sessionId: string, title?: string, description?: string): ChatStoreState {
  return {
    sessionId,
    mode: 'chat',
    title: title ?? '',
    description: description ?? '',
    groupId: null,
    sessionMetadata: null,
    sessionStatus: 'idle',
    isDataLoaded: false, // 🔧 性能优化：新会话尚未加载数据
    messageMap: new Map(),
    messageOrder: [],
    blocks: new Map(),
    currentStreamingMessageId: null,
    activeBlockIds: new Set(),
    streamingVariantIds: new Set(),
    pendingParallelModelIds: null,
    modelRetryTarget: null,
    messageOperationLock: null, // 🆕 消息操作锁初始为 null
    pendingContextRefs: [], // 🆕 上下文引用初始为空数组
    pendingApprovalRequest: null, // 🆕 工具审批请求初始为 null（文档 29 P1-3）
    activeSkillIds: [], // 🆕 Skills 系统：当前激活的 Skill ID 列表（支持多选）
    chatParams: createDefaultChatParams(),
    features: new Map(),
    modeState: null,
    inputValue: '',
    attachments: [],
    panelStates: createDefaultPanelStates(),
    // 🔧 P1修复：Callback 初始值
    _sendCallback: null,
    _retryCallback: null,
    _deleteCallback: null,
    _editAndResendCallback: null,
    _saveCallback: null,
    _loadCallback: null,
    _abortCallback: null,
    _updateBlockContentCallback: null,
    _updateSessionSettingsCallback: null,
    _switchVariantCallback: null,
    _deleteVariantCallback: null,
    _retryVariantCallback: null,
    _retryAllVariantsCallback: null,
    _cancelVariantCallback: null,
    _continueMessageCallback: null,
  };
}
