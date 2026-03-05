/**
 * Chat V2 - Store 类型定义
 *
 * ChatStore 是单会话的 SSOT（唯一真相源）。
 * 包含核心状态、Actions 签名和 Guards 签名。
 */

import type { Block, BlockStatus, BlockType } from './block';
import type { AttachmentMeta, Message, MessageMeta, Variant, VariantStatus, SharedContext, SourceInfo } from './message';
import type { BackendVariantEvent } from '../store/variantActions';
import type {
  ChatParams,
  PanelStates,
  SessionStatus,
  TokenUsage,
  createDefaultChatParams,
  createDefaultPanelStates,
} from './common';
import type { ContextRef } from '../../context/types';
import type { EditMessageResult, RetryMessageResult } from '../../adapters/types';

// 重新导出共享类型
export type { ChatParams, PanelStates, SessionStatus } from './common';
export type { Variant, VariantStatus, SharedContext } from './message';
export { createDefaultChatParams, createDefaultPanelStates } from './common';

// SessionStatus, ChatParams, PanelStates 从 common.ts 导入

// ============================================================================
// LoadSessionResponse 类型（避免循环引用，此处定义简化版本）
// ============================================================================

/**
 * 后端块结构（简化版）
 */
export interface BackendBlockForRestore {
  id: string;
  messageId: string;
  type: string;
  status: string;
  content?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  citations?: Array<{
    type: 'rag' | 'memory' | 'web' | 'multimodal' | 'image' | 'search';
    title?: string;
    url?: string;
    snippet?: string;
    score?: number;
  }>;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  /** 🔧 P3修复：第一个有效 chunk 到达时间（用于排序，保持思维链交替顺序） */
  firstChunkAt?: number;
}

/**
 * 后端变体结构（用于恢复）
 */
export interface BackendVariantForRestore {
  id: string;
  modelId: string;
  blockIds: string[];
  status: VariantStatus;
  error?: string;
  createdAt: number;
}

/**
 * 后端共享上下文结构（用于恢复）
 */
export interface BackendSharedContextForRestore {
  ragSources?: SourceInfo[];
  memorySources?: SourceInfo[];
  webSearchSources?: SourceInfo[];
  multimodalSources?: SourceInfo[];
}

/**
 * 后端消息结构（简化版）
 */
export interface BackendMessageForRestore {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  blockIds: string[];
  timestamp: number;
  persistentStableId?: string;
  parentId?: string;
  supersedes?: string;
  // 🔧 注意：后端使用 serde(rename = "_meta") 序列化，字段名必须是 _meta
  _meta?: {
    modelId?: string;
    modelDisplayName?: string;
    chatParams?: ChatParams;
    usage?: TokenUsage;
    // 🆕 统一用户消息处理：上下文快照（用户添加的上下文引用）
    contextSnapshot?: import('../../context/types').ContextSnapshot;
    // 注意：sources/toolResults/ankiCards 等数据现在统一存储在 blocks 表中，
    // 通过 msg.blockIds 引用，无需从 _meta 恢复
  };
  attachments?: AttachmentMeta[];
  // 🔧 变体字段
  activeVariantId?: string;
  variants?: BackendVariantForRestore[];
  sharedContext?: BackendSharedContextForRestore;
}

/**
 * 会话状态（简化版）
 */
export interface SessionStateForRestore {
  sessionId: string;
  chatParams?: ChatParams;
  features?: Record<string, boolean>;
  modeState?: Record<string, unknown>;
  inputValue?: string;
  panelStates?: PanelStates;
  /** 待发送的上下文引用列表（JSON 格式） */
  pendingContextRefsJson?: string;
  /** 🆕 渐进披露：已加载的 Skill IDs（JSON 格式） */
  loadedSkillIdsJson?: string;
  /** 🆕 手动激活的 Skill ID 列表（JSON 格式，支持多选） */
  activeSkillIdsJson?: string;
  updatedAt: string;
}

/**
 * 加载会话响应类型（用于 restoreFromBackend）
 */
export interface LoadSessionResponseType {
  session: {
    id: string;
    mode: string;
    title?: string;
    persistStatus: 'active' | 'archived' | 'deleted';
    createdAt: string;
    updatedAt: string;
    groupId?: string;
    metadata?: Record<string, unknown>;
  };
  messages: BackendMessageForRestore[];
  blocks: BackendBlockForRestore[];
  state?: SessionStateForRestore;
}

// ============================================================================
// ChatStore 类型定义
// ============================================================================

/**
 * ChatStore 完整类型定义
 * 包含状态、Actions 和 Guards
 */
export interface ChatStore {
  // ========== 核心状态（✅ 持久化） ==========

  /** 会话 ID */
  sessionId: string;

  /** 会话模式（由注册表管理） */
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
   * ❌ 不持久化（运行时状态）
   */
  isDataLoaded: boolean;

  // ========== 消息（✅ 持久化，性能优化） ==========

  /** 消息 Map，O(1) 查找 */
  messageMap: Map<string, Message>;

  /** 消息顺序数组 */
  messageOrder: string[];

  // ========== 块（✅ 持久化） ==========

  /** 块 Map，O(1) 查找 */
  blocks: Map<string, Block>;

  // ========== 流式追踪（❌ 不持久化） ==========

  /** 当前正在流式的消息 ID */
  currentStreamingMessageId: string | null;

  /** 当前活跃的块 ID 集合 */
  activeBlockIds: Set<string>;

  // ========== 变体追踪（❌ 不持久化） ==========

  /** 正在流式的变体 ID 集合 */
  streamingVariantIds: Set<string>;

  // ========== 对话参数（✅ 持久化，从全局复制） ==========

  /** 对话参数 */
  chatParams: ChatParams;

  // ========== 功能开关（✅ 持久化，通用化） ==========

  /** 功能开关 Map，key 由插件定义 */
  features: Map<string, boolean>;

  // ========== 模式特定状态（✅ 持久化，由模式插件管理） ==========

  /** 模式状态，结构由插件定义 */
  modeState: Record<string, unknown> | null;

  // ========== 输入框状态（✅ 持久化草稿） ==========

  /** 输入框内容 */
  inputValue: string;

  /** 附件列表（只存元数据） */
  attachments: AttachmentMeta[];

  /** 面板状态 */
  panelStates: PanelStates;

  // ========== 🆕 上下文引用（✅ 持久化） ==========

  /** 待发送的上下文引用列表（只存引用，不存内容） */
  pendingContextRefs: ContextRef[];
  /** pendingContextRefs 是否被用户在当前轮编辑中显式修改过（用于 editAndResend 三态语义） */
  pendingContextRefsDirty: boolean;

  // ========== 🆕 消息操作锁（❌ 不持久化） ==========

  /** 当前进行中的消息操作（防止重复操作） */
  messageOperationLock: {
    messageId: string;
    operation: 'retry' | 'edit' | 'delete' | 'resend';
  } | null;

  // ========== 🆕 工具审批请求（❌ 不持久化，文档 29 P1-3） ==========

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

  // ========== 🆕 Skills 系统（❌ 不持久化） ==========

  /** 当前激活的 Skill ID 列表（支持多选） */
  activeSkillIds: string[];

  // ========== 守卫方法 ==========

  /** 是否可以发送消息 */
  canSend(): boolean;

  /** 是否可以编辑指定消息 */
  canEdit(messageId: string): boolean;

  /** 是否可以删除指定消息 */
  canDelete(messageId: string): boolean;

  /** 是否可以中断流式 */
  canAbort(): boolean;

  /** 指定块是否锁定（正在运行） */
  isBlockLocked(blockId: string): boolean;

  /** 指定消息是否锁定（任意块在运行） */
  isMessageLocked(messageId: string): boolean;

  // ========== 消息 Actions ==========

  /** 发送消息 */
  sendMessage(content: string, attachments?: AttachmentMeta[]): Promise<void>;

  /**
   * 使用指定 ID 发送消息（支持消息 ID 统一）
   * @param content 消息内容
   * @param attachments 附件列表
   * @param userMessageId 前端生成的用户消息 ID
   * @param assistantMessageId 前端生成的助手消息 ID
   */
  sendMessageWithIds(
    content: string,
    attachments: AttachmentMeta[] | undefined,
    userMessageId: string,
    assistantMessageId: string
  ): Promise<void>;

  /** 删除消息（异步，会同步到后端） */
  deleteMessage(messageId: string): Promise<void>;

  /** 编辑消息（仅本地更新，不触发重发） */
  editMessage(messageId: string, content: string): void;

  /** 编辑消息并重发（更新内容后触发重新生成） */
  editAndResend(messageId: string, newContent: string): Promise<void>;

  /**
   * 🆕 更新消息元数据（局部更新，不替换整个 _meta）
   * 用于在流式完成后更新 usage 等字段
   * @param messageId 消息 ID
   * @param metaUpdate 要更新的元数据字段
   */
  updateMessageMeta(messageId: string, metaUpdate: Partial<MessageMeta>): void;

  /**
   * ★ 文档28 Prompt10：更新消息的 contextSnapshot.pathMap
   * 用于在发送消息时设置上下文引用的真实路径
   * @param messageId 消息 ID
   * @param pathMap 资源 ID -> 真实路径 的映射
   */
  updateMessagePathMap(messageId: string, pathMap: Record<string, string>): void;

  /** 重试消息 */
  retryMessage(messageId: string, modelOverride?: string): Promise<void>;

  /** 中断流式 */
  abortStream(): Promise<void>;

  /** 
   * 强制重置到 idle 状态（应急恢复机制）
   * 用于 abortStream 失败时的最后手段，跳过所有守卫检查
   */
  forceResetToIdle(): void;

  // ========== 块 Actions ==========

  /** 创建块，返回 blockId */
  createBlock(messageId: string, type: BlockType): string;

  /** 使用指定 ID 创建块（后端传递 blockId 时使用） */
  createBlockWithId(messageId: string, type: BlockType, blockId: string): string;

  /** 更新块内容（流式追加） */
  updateBlockContent(blockId: string, chunk: string): void;

  /** 批量更新块内容（性能优化：只创建一次 Map） */
  batchUpdateBlockContent(updates: Array<{ blockId: string; content: string }>): void;

  /** 更新块状态 */
  updateBlockStatus(blockId: string, status: BlockStatus): void;

  /** 设置块结果（工具块） */
  setBlockResult(blockId: string, result: unknown): void;

  /** 设置块错误 */
  setBlockError(blockId: string, error: string): void;

  /** 更新块字段（工具块专用，设置 toolName/toolInput 等） */
  updateBlock(blockId: string, updates: Partial<Block>): void;

  /** 🆕 2026-01-17: 删除块（从 blocks Map、消息 blockIds、activeBlockIds 中移除） */
  deleteBlock?(blockId: string): void;

  /** 🆕 2026-02-16: 原地替换块 ID（保持 blockIds 顺序不变，用于 preparing→执行块转换） */
  replaceBlockId?(oldBlockId: string, newBlockId: string): void;

  /** 🆕 2026-01-15: 设置工具调用准备中状态（LLM 正在生成工具调用参数） */
  setPreparingToolCall?(
    messageId: string,
    info: { toolCallId: string; toolName: string }
  ): void;

  /** 🆕 2026-01-15: 清除工具调用准备中状态（工具调用已开始执行） */
  clearPreparingToolCall?(messageId: string): void;

  // ========== 流式追踪 Actions ==========

  /** 设置当前流式消息 */
  setCurrentStreamingMessage(messageId: string | null): void;

  /** 添加活跃块 */
  addActiveBlock(blockId: string): void;

  /** 移除活跃块 */
  removeActiveBlock(blockId: string): void;

  /**
   * 完成流式生成
   * 将 sessionStatus 重置为 idle，清理流式状态
   * @param reason - 完成原因：'success' 正常完成，'error' 流式错误，'cancelled' 用户取消
   */
  completeStream(reason?: 'success' | 'error' | 'cancelled'): void;

  // ========== 对话参数 Actions ==========

  /** 设置对话参数 */
  setChatParams(params: Partial<ChatParams>): void;

  /** 重置对话参数 */
  resetChatParams(): void;

  // ========== 功能开关 Actions ==========

  /** 设置功能开关 */
  setFeature(key: string, enabled: boolean): void;

  /** 切换功能开关 */
  toggleFeature(key: string): void;

  /** 获取功能开关状态 */
  getFeature(key: string): boolean;

  // ========== 模式状态 Actions ==========

  /** 设置模式状态（整体替换） */
  setModeState(state: Record<string, unknown> | null): void;

  /** 更新模式状态（合并更新） */
  updateModeState(updates: Record<string, unknown>): void;

  // ========== 会话元信息 Actions ==========

  /** 设置会话标题 */
  setTitle(title: string): void;

  /** 设置会话简介（自动生成） */
  setDescription(description: string): void;

  /** 设置会话摘要（标题 + 简介） */
  setSummary(title: string, description: string): void;

  // ========== 输入框 Actions ==========

  /** 设置输入框内容 */
  setInputValue(value: string): void;

  /** 添加附件 */
  addAttachment(attachment: AttachmentMeta): void;

  /** 更新附件（按 ID 原地更新，避免闪烁） */
  updateAttachment(attachmentId: string, updates: Partial<AttachmentMeta>): void;

  /** 移除附件 */
  removeAttachment(attachmentId: string): void;

  /** 清空附件 */
  clearAttachments(): void;

  /** 设置面板状态 */
  setPanelState(panel: keyof PanelStates, open: boolean): void;

  // ========== 🆕 上下文引用 Actions ==========

  /**
   * 添加上下文引用
   * @param ref 上下文引用
   */
  addContextRef(ref: ContextRef): void;

  /**
   * 移除上下文引用
   * @param resourceId 资源 ID
   */
  removeContextRef(resourceId: string): void;

  /**
   * 清空上下文引用
   * @param typeId 可选，只清空指定类型
   */
  clearContextRefs(typeId?: string): void;

  /**
   * 按类型获取上下文引用
   * @param typeId 类型 ID
   * @returns 该类型的上下文引用数组
   */
  getContextRefsByType(typeId: string): ContextRef[];

  /**
   * 获取启用的工具 ID 列表
   * 根据 pendingContextRefs 中的类型收集关联工具
   * @returns 去重后的工具 ID 数组
   */
  getEnabledTools(): string[];

  /**
   * 更新上下文引用的注入模式
   * @param resourceId 资源 ID
   * @param injectModes 注入模式配置
   */
  updateContextRefInjectModes(resourceId: string, injectModes: import('../../../chat-v2/context/vfsRefTypes').ResourceInjectModes | undefined): void;

  // ========== 🆕 Skills Actions ==========

  /**
   * 激活 Skill
   * @param skillId Skill ID
   * @returns 是否激活成功
   */
  activateSkill(skillId: string): Promise<boolean>;

  /**
   * 取消激活 Skill
   * @param skillId 可选，指定取消激活的 Skill ID，不传则取消全部
   */
  deactivateSkill(skillId?: string): void;

  /**
   * 获取当前激活的 Skill ID 列表
   * @returns 当前激活的 Skill ID 数组
   */
  getActiveSkillIds(): string[];

  /**
   * 检查指定 Skill 是否激活
   * @param skillId Skill ID
   * @returns 是否激活
   */
  isSkillActive(skillId: string): boolean;

  /**
   * 检查是否有激活的 Skill（纯查询，无副作用）
   * @returns 是否有激活的 skill
   */
  hasActiveSkill(): boolean;

  /**
   * 修复 activeSkillIds 与 pendingContextRefs 的不一致状态
   * 应在明确的入口点调用（会话恢复后、发送消息前等），不要在 getter/render 中调用
   */
  repairSkillState(): void;

  /**
   * 获取所有激活的 Skill 信息
   * @returns Skill 元数据数组
   */
  getActiveSkillsInfo(): Promise<Array<{
    id: string;
    name: string;
    description: string;
    /** 🆕 P1-B: allowedTools 用于工具可见性过滤 */
    allowedTools?: string[];
  }>>;

  // ========== 🆕 工具审批 Actions（文档 29 P1-3） ==========

  /**
   * 设置待处理的审批请求
   * @param request 审批请求数据
   */
  setPendingApproval(request: {
    toolCallId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    sensitivity: 'low' | 'medium' | 'high';
    description: string;
    timeoutSeconds: number;
    resolvedStatus?: 'approved' | 'rejected' | 'timeout' | 'expired' | 'error';
    resolvedReason?: string;
  } | null): void;

  /**
   * 清除待处理的审批请求
   */
  clearPendingApproval(): void;

  // ========== 会话 Actions ==========

  /**
   * 初始化会话（从全局配置复制默认值）
   * @param mode - 会话模式
   * @param initConfig - 可选的初始化配置（传递给模式插件 onInit）
   */
  initSession(mode: string, initConfig?: Record<string, unknown>): Promise<void>;

  /** 加载会话（从数据库） */
  loadSession(sessionId: string): Promise<void>;

  /** 保存会话（到数据库） */
  saveSession(): Promise<void>;

  /**
   * 设置保存回调函数
   * 由 TauriAdapter 调用，注入实际的保存逻辑
   */
  setSaveCallback(callback: (() => Promise<void>) | null): void;

  /**
   * 设置重试回调函数
   * 由 TauriAdapter 调用，注入实际的重试逻辑
   * 🆕 P1 状态同步修复: 返回完整的 RetryMessageResult 用于前端状态同步
   * @param callback 重试回调，参数为 (messageId, modelOverride?)，返回 RetryMessageResult
   */
  setRetryCallback(
    callback: ((messageId: string, modelOverride?: string) => Promise<RetryMessageResult>) | null
  ): void;

  /**
   * 设置删除回调函数
   * 由 TauriAdapter 调用，注入实际的删除逻辑
   * @param callback 删除回调，参数为 messageId
   */
  setDeleteCallback(
    callback: ((messageId: string) => Promise<void>) | null
  ): void;

  /**
   * 设置编辑并重发回调函数
   * 由 TauriAdapter 调用，注入实际的编辑重发逻辑
   * 🆕 P1-2: 支持传递新的上下文引用（ContextRef[] 类型，Adapter 层负责转换为 SendContextRef[]）
   * 🆕 P1 状态同步修复: 返回完整的 EditMessageResult 用于前端状态同步
   * @param callback 编辑重发回调，参数为 (messageId, newContent, newContextRefs?)，返回 EditMessageResult
   */
  setEditAndResendCallback(
    callback: ((messageId: string, newContent: string, newContextRefs?: ContextRef[]) => Promise<EditMessageResult>) | null
  ): void;

  /**
   * 设置发送消息回调函数
   * 由 TauriAdapter 调用，注入实际的发送逻辑
   * @param callback 发送回调，参数为 (content, attachments, userMessageId, assistantMessageId)
   */
  setSendCallback(
    callback: ((
      content: string,
      attachments: AttachmentMeta[] | undefined,
      userMessageId: string,
      assistantMessageId: string
    ) => Promise<void>) | null
  ): void;

  /**
   * 设置中断流式回调函数
   * 由 TauriAdapter 调用，注入实际的后端取消逻辑
   * @param callback 中断回调
   */
  setAbortCallback(
    callback: (() => Promise<void>) | null
  ): void;

  /**
   * 🔧 P0 修复：设置继续执行消息的回调函数
   * 由 TauriAdapter 调用，注入实际的 continue_message 逻辑
   * @param callback 继续回调，参数为 (messageId, variantId?)
   */
  setContinueMessageCallback(
    callback: ((messageId: string, variantId?: string) => Promise<void>) | null
  ): void;

  /**
   * 🔧 P0 修复：继续执行中断的消息
   * 优先调用后端 continue_message（同消息内继续），失败时 fallback 到 sendMessage
   * @param messageId 要继续的助手消息 ID
   * @param variantId 可选的变体 ID
   */
  continueMessage(messageId: string, variantId?: string): Promise<void>;

  /**
   * 设置加载会话回调函数
   * 由 TauriAdapter 调用，注入实际的后端加载逻辑
   * @param callback 加载回调
   */
  setLoadCallback(
    callback: (() => Promise<void>) | null
  ): void;

  /**
   * 设置更新块内容回调函数
   * 由 TauriAdapter 调用，注入实际的块内容更新逻辑
   * @param callback 更新回调，参数为 (blockId, content)
   */
  setUpdateBlockContentCallback(
    callback: ((blockId: string, content: string) => Promise<void>) | null
  ): void;

  /**
   * 设置更新会话设置回调函数
   * 由 TauriAdapter 调用，注入实际的会话设置更新逻辑
   * @param callback 更新回调，参数为 { title? }
   */
  setUpdateSessionSettingsCallback(
    callback: ((settings: { title?: string }) => Promise<void>) | null
  ): void;

  /** 从后端响应恢复状态（适配器调用） */
  restoreFromBackend(response: LoadSessionResponseType): void;

  // ========== 辅助方法（O(1) 查找） ==========

  /** 获取消息 */
  getMessage(messageId: string): Message | undefined;

  /** 获取消息的所有块 */
  getMessageBlocks(messageId: string): Block[];

  /** 获取有序消息列表 */
  getOrderedMessages(): Message[];

  // ========== 变体 Actions ==========

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

  /** 处理变体开始事件 */
  handleVariantStart(event: BackendVariantEvent): void;

  /** 处理变体结束事件 */
  handleVariantEnd(event: BackendVariantEvent): void;

  /** 将 block 添加到变体 */
  addBlockToVariant(
    messageId: string,
    variantId: string,
    blockId: string
  ): void;

  /** 将 block 添加到消息 (单变体兼容) */
  addBlockToMessage(messageId: string, blockId: string): void;

  /** 获取激活的变体 */
  getActiveVariant(messageId: string): Variant | undefined;

  /** 获取消息的所有变体 */
  getVariants(messageId: string): Variant[];

  /** 判断是否为多变体消息 */
  isMultiVariantMessage(messageId: string): boolean;

  /** 获取显示的 blockIds (考虑变体) */
  getDisplayBlockIds(messageId: string): string[];

  // ========== 变体回调设置 ==========

  /** 设置切换变体回调 */
  setSwitchVariantCallback(
    callback: ((messageId: string, variantId: string) => Promise<void>) | null
  ): void;

  /** 设置删除变体回调 */
  setDeleteVariantCallback(
    callback: ((
      messageId: string,
      variantId: string
    ) => Promise<{ variantDeleted?: boolean; messageDeleted?: boolean; newActiveId?: string }>) | null
  ): void;

  /** 设置重试变体回调 */
  setRetryVariantCallback(
    callback: ((
      messageId: string,
      variantId: string,
      modelOverride?: string
    ) => Promise<void>) | null
  ): void;

  /** 设置重试所有变体回调 */
  setRetryAllVariantsCallback(
    callback: ((messageId: string, variantIds: string[]) => Promise<void>) | null
  ): void;

  /** 设置取消变体回调 */
  setCancelVariantCallback(
    callback: ((variantId: string) => Promise<void>) | null
  ): void;

  // ========== 多变体触发 ==========

  /** 待发送的并行模型 ID 列表 */
  pendingParallelModelIds: string[] | null;

  /** 设置待发送的并行模型 ID 列表（发送前调用，发送后自动清空） */
  setPendingParallelModelIds(modelIds: string[] | null): void;

  // ========== 模型重试支持 ==========

  /** 待重试的消息 ID（用于底部面板模型选择重试） */
  modelRetryTarget: string | null;

  /** 设置待重试的消息 ID（点击消息模型名时调用，重试完成后清空） */
  setModelRetryTarget(messageId: string | null): void;
}

// 默认值工厂函数从 common.ts 导入

// ============================================================================
// 持久化相关类型
// ============================================================================

/**
 * 会话持久化数据
 */
export interface SessionPersistData {
  sessionId: string;
  mode: string;
  messageMap: Array<[string, Message]>;
  messageOrder: string[];
  blocks: Array<[string, Block]>;
  chatParams: ChatParams;
  features: Array<[string, boolean]>;
  modeState: Record<string, unknown> | null;
  inputValue: string;
  attachments: AttachmentMeta[];
  panelStates: PanelStates;
}

/**
 * 序列化 Store 状态用于持久化
 */
export function serializeStoreState(store: ChatStore): SessionPersistData {
  return {
    sessionId: store.sessionId,
    mode: store.mode,
    messageMap: Array.from(store.messageMap.entries()),
    messageOrder: store.messageOrder,
    blocks: Array.from(store.blocks.entries()),
    chatParams: store.chatParams,
    features: Array.from(store.features.entries()),
    modeState: store.modeState,
    inputValue: store.inputValue,
    attachments: store.attachments,
    panelStates: store.panelStates,
  };
}

/**
 * 反序列化持久化数据
 */
export function deserializeStoreState(
  data: SessionPersistData
): Partial<ChatStore> {
  return {
    sessionId: data.sessionId,
    mode: data.mode,
    messageMap: new Map(data.messageMap),
    messageOrder: data.messageOrder,
    blocks: new Map(data.blocks),
    chatParams: data.chatParams,
    features: new Map(data.features),
    modeState: data.modeState,
    inputValue: data.inputValue,
    attachments: data.attachments,
    panelStates: data.panelStates,
    // 运行时状态重置
    sessionStatus: 'idle',
    currentStreamingMessageId: null,
    activeBlockIds: new Set(),
    streamingVariantIds: new Set(),
  };
}
