/**
 * Chat V2 - Message 类型定义
 *
 * 消息是对话的基本单元，每条消息包含多个块的引用。
 * 支持多模型并行变体 (Variant) 机制。
 */

import type { AttachmentMeta, ChatParams, TokenUsage } from './common';
import type { ContextSnapshot } from '../../context/types';

// 重新导出共享类型
export type { AttachmentMeta } from './common';

// ============================================================================
// 变体 (Variant) 类型定义
// ============================================================================

/**
 * 变体状态
 * - pending: 等待开始
 * - streaming: 流式生成中
 * - success: 成功完成
 * - error: 失败
 * - cancelled: 被用户取消
 */
export type VariantStatus = 'pending' | 'streaming' | 'success' | 'error' | 'cancelled' | 'interrupted';

/**
 * 回答变体
 * 每个变体代表一个模型的独立回答
 */
export interface Variant {
  /** 变体 ID (var_xxx) */
  id: string;

  /** 生成此变体的模型 ID */
  modelId: string;

  /** 属于此变体的块 ID 列表 */
  blockIds: string[];

  /** 变体状态 */
  status: VariantStatus;

  /** 错误信息 (status=error 时) */
  error?: string;

  /** 创建时间戳 */
  createdAt: number;

  /** Token 使用统计（多变体模式，每个变体独立统计） */
  usage?: TokenUsage;
}

// ============================================================================
// 消息角色
// ============================================================================

/**
 * 消息角色
 */
export type MessageRole = 'user' | 'assistant';

// ============================================================================
// 共享上下文
// ============================================================================

/**
 * 共享上下文 - 检索结果，所有变体共享，只读
 */
export interface SharedContext {
  /** RAG 检索结果 */
  ragSources?: SourceInfo[];

  /** Memory 检索结果 */
  memorySources?: SourceInfo[];

  /** Graph RAG 结果 */
  graphSources?: SourceInfo[];

  /** Web 搜索结果 */
  webSearchSources?: SourceInfo[];

  /** 多模态知识库结果 */
  multimodalSources?: SourceInfo[];
}

// ============================================================================
// 消息结构
// ============================================================================

/**
 * 消息结构
 */
export interface Message {
  /** 消息唯一标识 */
  id: string;

  /** 消息角色 */
  role: MessageRole;

  /** 引用的块 ID 列表（有序，单变体时使用） */
  blockIds: string[];

  /** 消息创建时间戳 */
  timestamp: number;

  /** 消息级元数据（助手消息必须包含模型信息） */
  _meta?: MessageMeta;

  /** 用户消息附件 */
  attachments?: AttachmentMeta[];

  /** 持久化稳定 ID（用于数据库关联） */
  persistentStableId?: string;

  // ========== 多模型并行变体 (Variant) ==========

  /** 当前激活的变体 ID */
  activeVariantId?: string;

  /** 变体列表（助手消息，多模型并行时使用） */
  variants?: Variant[];

  /** 共享上下文（检索结果，所有变体共享） */
  sharedContext?: SharedContext;
}

// ============================================================================
// 消息元数据
// ============================================================================

/**
 * 消息级元数据
 * 助手消息记录生成时使用的模型和参数
 */
export interface MessageMeta {
  /** 生成此消息使用的模型 ID */
  modelId?: string;

  /** 生成此消息使用的模型显示名称（用于 UI 展示） */
  modelDisplayName?: string;

  /** 生成此消息使用的对话参数快照 */
  chatParams?: Partial<ChatParamsSnapshot>;

  /** 来源信息（知识检索结果） */
  sources?: MessageSources;

  /** 工具调用结果 */
  toolResults?: ToolResult[];

  /** Anki 卡片（如果制卡模式生成） */
  ankiCards?: AnkiCardInfo[];

  /** Token 使用统计（单变体模式） */
  usage?: TokenUsage;

  /** 上下文快照（发送时保存的上下文引用） */
  contextSnapshot?: ContextSnapshot;

  /** 完整请求体（开发者调试用） */
  rawRequest?: unknown;

  /** 🆕 2026-01-15: 正在准备中的工具调用信息（LLM 正在生成参数） */
  preparingToolCall?: {
    toolCallId: string;
    toolName: string;
  };
}

/**
 * 对话参数快照（消息级别）
 * 使用 ChatParams 的子集
 */
export type ChatParamsSnapshot = Partial<ChatParams>;

/**
 * 消息来源信息
 */
export interface MessageSources {
  /** 文档 RAG 来源 */
  rag?: SourceInfo[];

  /** 用户记忆来源 */
  memory?: SourceInfo[];

  /** 知识图谱来源 */
  graph?: SourceInfo[];

  /** 网络搜索来源 */
  webSearch?: SourceInfo[];

  /** 多模态知识库来源 */
  multimodal?: SourceInfo[];
}

/**
 * 单个来源信息
 */
export interface SourceInfo {
  /** 来源标题 */
  title?: string;

  /** 来源 URL 或路径 */
  url?: string;

  /** 内容片段 */
  snippet?: string;

  /** 相关度分数 */
  score?: number;

  /** 额外元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 工具调用结果
 */
export interface ToolResult {
  /** 工具名称 */
  toolName: string;

  /** 工具输入 */
  input: Record<string, unknown>;

  /** 工具输出 */
  output: unknown;

  /** 是否成功 */
  success: boolean;

  /** 错误信息 */
  error?: string;
}

/**
 * Anki 卡片信息（简化版，详细定义在 types/ 中）
 */
export interface AnkiCardInfo {
  /** 卡片 ID */
  id?: string;

  /** 正面内容 */
  front: string;

  /** 背面内容 */
  back: string;

  /** 标签 */
  tags?: string[];
}

// ============================================================================
// 附件
// ============================================================================

// AttachmentMeta 从 common.ts 导入
// 附件类型定义在 common.ts 中

// ============================================================================
// 消息创建参数
// ============================================================================

/**
 * 创建用户消息的参数
 */
export interface CreateUserMessageParams {
  /** 文本内容 */
  content: string;

  /** 附件列表 */
  attachments?: AttachmentMeta[];
}

/**
 * 创建助手消息的参数
 */
export interface CreateAssistantMessageParams {
  /** 模型 ID */
  modelId: string;

  /** 对话参数快照 */
  chatParams?: Partial<ChatParamsSnapshot>;
}
