/**
 * Chat V2 - Tauri 适配器类型定义
 *
 * 定义与后端交互的数据类型，与后端 types.rs 保持对齐。
 */

import type { Block, BlockStatus, BlockType } from '../core/types/block';
import type { AttachmentMeta, MessageMeta, SourceInfo } from '../core/types/message';
import type { ChatParams, PanelStates, TokenUsage } from '../core/types/common';
import type { SendContextRef, ContentBlock } from '../resources/types';

// ============================================================================
// 发送选项 - 与后端 SendOptions 对齐
// ============================================================================

/**
 * 发送消息的完整选项
 * 与后端 SendOptions 结构对齐
 */
export interface SendOptions {
  // ChatParams 对应
  modelId?: string;
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  contextLimit?: number;
  maxTokens?: number;
  enableThinking?: boolean;
  replayMode?: 'original' | 'current';
  skillStateVersion?: number;
  disableTools?: boolean;
  model2OverrideId?: string;

  // RAG 选项
  ragEnabled?: boolean;
  ragLibraryIds?: string[];
  ragTopK?: number;
  /** 🔧 P1-35: RAG 启用重排序（Rerank）*/
  ragEnableReranking?: boolean;
  memoryEnabled?: boolean;

  // 🆕 多模态知识库检索选项
  /** 启用多模态知识库检索 */
  multimodalRagEnabled?: boolean;
  /** 多模态检索数量（Top-K），默认 10 */
  multimodalTopK?: number;
  /** 多模态检索启用精排 */
  multimodalEnableReranking?: boolean;
  /** 多模态检索知识库 ID 过滤 */
  multimodalLibraryIds?: string[];

  // 工具选项
  mcpTools?: string[];
  /**
   * MCP 工具的完整 Schema 列表
   *
   * 由前端从 mcpService 获取选中服务器的工具 Schema，传递给后端。
   * 后端直接使用这些 Schema 注入到 LLM，而不需要自己连接 MCP 服务器。
   *
   * 结构与 OpenAI function calling 兼容：
   * - name: 工具名称
   * - description: 工具描述
   * - inputSchema: JSON Schema 定义参数
   */
  mcpToolSchemas?: Array<{
    name: string;
    description?: string;
    inputSchema?: unknown;
  }>;
  webSearchEnabled?: boolean;
  searchEngines?: string[];

  // Anki 选项
  ankiEnabled?: boolean;
  ankiTemplateId?: string;
  ankiOptions?: Record<string, unknown>;

  // 系统提示
  systemPromptOverride?: string;
  systemPromptAppend?: string;

  // ========== 多变体选项 ==========
  /** 多模型并行的模型 ID 列表（2+ 个模型时触发多变体模式） */
  parallelModelIds?: string[];
  /** 变体数量上限（默认 10，范围 1-20） */
  maxVariantsPerMessage?: number;

  // ========== 工具递归限制 ==========
  /** 工具递归最大深度（1-100，默认 30） */
  maxToolRecursion?: number;

  // ========== Canvas 智能笔记选项 ==========
  /** Canvas 模式绑定的笔记 ID */
  canvasNoteId?: string;

  // ========== 统一工具注入选项 ==========
  /**
   * Schema 注入型工具 ID 列表
   *
   * 需要注入到 LLM 的工具 Schema，LLM 可主动调用。
   * 遵循文档 26：统一工具注入系统架构设计。
   * 
   * 来源：
   * - Canvas 工具（note_read, note_append 等）
   * - 上下文引用关联的工具
   * - 模式插件启用的工具
   */
  schemaToolIds?: string[];

  /**
   * 🆕 上下文类型的 System Prompt Hints
   *
   * 告知 LLM 用户消息中 XML 标签的含义和用途。
   * 在 System Prompt 中生成 <user_context_format_guide> 块。
   */
  contextTypeHints?: string[];

  /** 当前会话激活的 Skill IDs（用于后端 fail-closed 白名单判定） */
  activeSkillIds?: string[];

  /** Skill 白名单工具 ID 列表 */
  skillAllowedTools?: string[];
  /** Skill 内容（SKILL.md 内容） */
  skillContents?: string[];
  /** Skill 内嵌工具 Schema */
  skillEmbeddedTools?: unknown[];
  /** 关闭工具白名单检查 */
  disableToolWhitelist?: boolean;
  /** 图片压缩质量策略 */
  visionQuality?: string;
}

// ============================================================================
// 附件输入 - 与后端 AttachmentInput 对齐
// ============================================================================

/**
 * 附件输入（发送时的数据结构）
 * 与后端 AttachmentInput 结构对齐
 * 
 * @deprecated 附件现在通过统一上下文注入系统（userContextRefs）处理。
 * 新代码应使用 resourceStoreApi.createOrReuse() 创建资源，
 * 然后通过 store.addContextRef() 添加上下文引用。
 * 此类型保留仅用于向后兼容旧版本数据加载。
 */
export interface AttachmentInput {
  /** 文件名 */
  name: string;

  /** MIME 类型 */
  mimeType: string;

  /** Base64 编码的文件内容（二进制文件） */
  base64Content?: string;

  /** 文本内容（文本文件） */
  textContent?: string;

  /** 额外元数据 */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// 发送消息请求 - 与后端 SendMessageRequest 对齐
// ============================================================================

/**
 * 发送消息请求
 */
export interface SendMessageRequest {
  /** 会话 ID */
  sessionId: string;

  /** 消息内容 */
  content: string;

  /**
   * 附件列表（使用 AttachmentInput 而非 AttachmentMeta）
   * @deprecated 附件现在通过 userContextRefs 传递，此字段保留仅用于向后兼容
   */
  attachments?: AttachmentInput[];

  /** 发送选项 */
  options?: SendOptions;

  /**
   * 前端生成的用户消息 ID（可选，用于 ID 统一）
   * 如果提供，后端必须使用此 ID 而非自己生成
   */
  userMessageId?: string;

  /**
   * 前端生成的助手消息 ID（可选，用于 ID 统一）
   * 如果提供，后端必须使用此 ID 而非自己生成
   */
  assistantMessageId?: string;

  /**
   * 🆕 用户上下文引用列表（含格式化内容）
   *
   * 遵循文档 16：统一上下文注入系统
   * - 前端从资源库获取内容并调用 formatToBlocks 填充 formattedBlocks
   * - 后端直接使用 formattedBlocks，不需要知道类型定义
   * - 消息持久化时只存 ContextRef，不存 formattedBlocks
   */
  userContextRefs?: SendContextRef[];

  /**
   * ★ 文档28 Prompt10：资源路径映射
   * 
   * 存储 resourceId -> 真实路径 的映射，用于 UI 显示。
   * 前端在发送消息时获取路径，后端保存到 context_snapshot.path_map。
   */
  pathMap?: Record<string, string>;

  /**
   * 🆕 工作区 ID（多 Agent 协作）
   * 
   * 如果当前会话属于某个工作区，传递工作区 ID。
   * 后端 Pipeline 会根据此 ID 启用空闲期消息注入机制。
   */
  workspaceId?: string;
}

// ============================================================================
// 会话级事件 - 与后端 SessionEvent 对齐
// ============================================================================

/**
 * 会话级事件类型
 */
export type SessionEventType =
  | 'stream_start'
  | 'stream_complete'
  | 'stream_error'
  | 'stream_cancelled'
  | 'save_complete'
  | 'save_error'
  | 'title_updated'
  | 'summary_updated'
  | 'variant_deleted';

/**
 * 会话级事件 Payload
 * 与后端 SessionEvent 对齐
 */
export interface SessionEventPayload {
  /** 会话 ID */
  sessionId: string;

  /** 事件类型 */
  eventType: SessionEventType;

  /** 关联的消息 ID */
  messageId?: string;

  /** 模型标识符（stream_start 事件携带，用于前端显示） */
  modelId?: string;

  /** 错误信息 */
  error?: string;

  /** 持续时间（毫秒） */
  durationMs?: number;

  /** 时间戳 */
  timestamp: number;

  /** 
   * 🆕 Token 使用统计（stream_complete 事件携带）
   * 由后端在流式完成时计算并返回
   */
  usage?: TokenUsage;

  /** 标题（title_updated/summary_updated 事件携带） */
  title?: string;

  /** 简介（summary_updated 事件携带） */
  description?: string;

  /** 变体 ID（variant_deleted 事件携带） */
  variantId?: string;

  /** Skill 状态版本 */
  skillStateVersion?: number;

  /** 回放模式 */
  replayMode?: 'original' | 'current';

  /** 剩余变体数量（variant_deleted 事件携带） */
  remainingCount?: number;

  /** 新的激活变体 ID（variant_deleted 事件携带） */
  newActiveVariantId?: string;
}

// ============================================================================
// 加载会话响应 - 与后端 LoadSessionResponse 对齐
// ============================================================================

/**
 * 会话信息
 */
export interface SessionInfo {
  id: string;
  mode: string;
  title?: string;
  /** 会话简介（自动生成） */
  description?: string;
  persistStatus: 'active' | 'archived' | 'deleted';
  createdAt: string; // ISO 8601
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

/**
 * 后端消息结构
 */
export interface BackendMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  blockIds: string[];
  timestamp: number;
  persistentStableId?: string;
  parentId?: string;
  supersedes?: string;
  _meta?: MessageMeta;
  attachments?: AttachmentMeta[];
}

/**
 * 后端块结构
 * 注意：后端 block_type 序列化为 type
 */
export interface BackendBlock {
  id: string;
  messageId: string;
  type: string; // 后端 block_type 序列化为 type
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
  /** 第一个有效 chunk 到达时间（用于排序） */
  firstChunkAt?: number;
}

/**
 * 加载会话响应
 * 与后端 LoadSessionResponse 对齐
 */
export interface LoadSessionResponse {
  session: SessionInfo;
  messages: BackendMessage[];
  blocks: BackendBlock[];
  state?: SessionState;
}

/**
 * 会话状态 - 与后端 SessionState 对齐
 */
export interface SessionState {
  sessionId: string;
  chatParams?: ChatParams;
  features?: Record<string, boolean>;
  modeState?: Record<string, unknown>;
  inputValue?: string;
  panelStates?: PanelStates;
  /** 待发送的上下文引用列表（JSON 格式） */
  pendingContextRefsJson?: string;
  /** 渐进披露：已加载的 Skill IDs（JSON 格式） */
  loadedSkillIdsJson?: string;
  /** 手动激活的 Skill ID 列表（JSON 格式，支持多选） */
  activeSkillIdsJson?: string;
  /** 结构化 Skill 状态（JSON 格式） */
  skillStateJson?: string;
  updatedAt: string;
}

// ============================================================================
// 会话设置 - 与后端 SessionSettings 对齐
// ============================================================================

/**
 * 会话设置
 */
export interface SessionSettings {
  title?: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// 编辑/重试消息结果 - P1 状态同步修复
// ============================================================================

/**
 * 编辑消息操作的返回结果
 * 
 * 用于前端同步后端状态变更：
 * - 后端可能删除旧消息
 * - 后端可能创建新消息（ID 不同于请求时的 messageId）
 * - 后端可能创建新变体
 */
export interface EditMessageResult {
  /** 操作是否成功 */
  success: boolean;
  /** 新创建的助手消息 ID（编辑用户消息后触发的新回复） */
  newMessageId?: string;
  /** 后端删除的消息 ID 列表（前端需同步清理） */
  deletedMessageIds?: string[];
  /** 新创建的变体 ID（多变体模式下） */
  newVariantId?: string;
  /** 错误信息（success=false 时） */
  error?: string;
}

/**
 * 重试消息操作的返回结果
 * 
 * 用于前端同步后端状态变更：
 * - 后端可能删除旧变体
 * - 后端可能创建新变体
 */
export interface RetryMessageResult {
  /** 操作是否成功 */
  success: boolean;
  /** 返回的消息 ID（通常与请求的 messageId 相同） */
  messageId?: string;
  /** 新创建的变体 ID（多变体模式下） */
  newVariantId?: string;
  /** 后端删除的变体 ID 列表（前端需同步清理） */
  deletedVariantIds?: string[];
  /** 错误信息（success=false 时） */
  error?: string;
}

// ============================================================================
// 创建会话请求
// ============================================================================

/**
 * 创建会话请求
 */
export interface CreateSessionRequest {
  mode: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// 辅助类型
// ============================================================================

/**
 * 将 BackendBlock 转换为前端 Block 类型
 */
export function convertBackendBlock(b: BackendBlock): Block {
  return {
    id: b.id,
    messageId: b.messageId,
    type: b.type as BlockType,
    status: b.status as BlockStatus,
    content: b.content,
    toolName: b.toolName,
    toolInput: b.toolInput as Record<string, unknown> | undefined,
    toolOutput: b.toolOutput,
    citations: b.citations,
    error: b.error,
    startedAt: b.startedAt,
    endedAt: b.endedAt,
    firstChunkAt: b.firstChunkAt,
  };
}
