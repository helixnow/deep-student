/**
 * Chat V2 - Block 类型定义
 *
 * 块是消息内容的最小单元，每个块有独立的状态机。
 * 块类型通过注册表管理，可扩展。
 */

import type { BlockStatus, BlockType } from './common';

// 重新导出共享类型
export type { BlockStatus, BlockType } from './common';

// ============================================================================
// 块结构
// ============================================================================

/**
 * 通用块结构
 * 所有块类型共享此基础结构
 */
export interface Block {
  /** 块唯一标识 */
  id: string;

  /** 块类型（可扩展） */
  type: BlockType;

  /** 块状态 */
  status: BlockStatus;

  /** 绑定的消息 ID（必须） */
  messageId: string;

  // ========== 流式块专用 ==========

  /** 流式内容（thinking/content 等） */
  content?: string;

  // ========== 工具调用专用 ==========

  /** 工具名称 */
  toolName?: string;

  /** 工具输入参数 */
  toolInput?: Record<string, unknown>;

  /** 工具输出结果 */
  toolOutput?: unknown;

  /** 🆕 工具调用参数正在生成中（LLM 正在累积参数） */
  isPreparing?: boolean;

  /** 🆕 工具调用 ID（用于 preparing 块和 tool_call 块的关联） */
  toolCallId?: string;

  // ========== 知识检索专用 ==========

  /** 引用来源列表 */
  citations?: Citation[];

  // ========== 错误信息 ==========

  /** 错误描述 */
  error?: string;

  /** 用户主动中断标记（keep-content 块在 abort 时设置） */
  aborted?: boolean;

  // ========== 时间戳 ==========

  /** 块创建/开始时间 */
  startedAt?: number;

  /** 第一个有效 chunk 到达时间（用于排序） */
  firstChunkAt?: number;

  /** 块结束时间 */
  endedAt?: number;
}

// ============================================================================
// 引用来源
// ============================================================================

/**
 * 知识检索块的引用来源
 * ★ 2026-01 扩展：新增 multimodal、image、search 类型
 */
export interface Citation {
  /** 来源类型 */
  type: 'rag' | 'memory' | 'web' | 'multimodal' | 'image' | 'search';

  /** 来源标题 */
  title?: string;

  /** 来源 URL 或文件路径 */
  url?: string;

  /** 来源内容片段 */
  snippet?: string;

  /** 相关度分数 */
  score?: number;
}

// ============================================================================
// 块创建参数
// ============================================================================

/**
 * 创建块时的参数
 */
export interface CreateBlockParams {
  /** 绑定的消息 ID */
  messageId: string;

  /** 块类型 */
  type: BlockType;

  /** 初始内容（可选） */
  initialContent?: string;

  /** 工具名称（工具块） */
  toolName?: string;

  /** 工具输入（工具块） */
  toolInput?: Record<string, unknown>;
}

// ============================================================================
// 块更新参数
// ============================================================================

/**
 * 更新块时的参数
 */
export interface UpdateBlockParams {
  /** 块 ID */
  blockId: string;

  /** 追加的内容（流式块） */
  chunk?: string;

  /** 新状态 */
  status?: BlockStatus;

  /** 工具结果 */
  result?: unknown;

  /** 错误信息 */
  error?: string;
}
