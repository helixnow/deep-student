/**
 * Chat V2 - 活动时间线类型定义
 *
 * 定义时间线相关的数据类型
 */

import type { BlockType, BlockStatus } from '../../core/types/block';

// ============================================================================
// 时间线条目状态
// ============================================================================

/**
 * 时间线条目状态
 */
export type TimelineEntryStatus = 'pending' | 'running' | 'success' | 'error' | 'cancelled';

/**
 * 时间线条目类型
 */
export type TimelineEntryKind = 'thinking' | 'tool';

/**
 * 工具块类型
 */
export const TOOL_BLOCK_TYPES: BlockType[] = ['mcp_tool'];

// ============================================================================
// 时间线条目
// ============================================================================

/**
 * 时间线条目
 */
export interface TimelineEntry {
  /** 唯一标识 */
  id: string;
  /** 条目类型 */
  kind: TimelineEntryKind;
  /** 显示标签 */
  label: string;
  /** 条目状态 */
  status: TimelineEntryStatus;
  /** 摘要描述 */
  summary?: string;
  /** 图标名称 */
  icon?: string;
  /** 开始时间 */
  startedAt?: number;
  /** 结束时间 */
  endedAt?: number;
  /** 结果数量（检索类型用） */
  resultCount?: number;
  /** 扩展元数据 */
  meta?: Record<string, unknown>;
}

// ============================================================================
// 思考统计
// ============================================================================

/**
 * 思考统计
 */
export interface ThinkingStats {
  /** 思考用时（秒） */
  durationSeconds: number;
  /** 状态 */
  status: TimelineEntryStatus;
  /** 是否正在思考 */
  isThinking: boolean;
}

// ============================================================================
// Block 类型到条目类型的映射
// ============================================================================

/**
 * 检索块类型列表
 */
export const RETRIEVAL_BLOCK_TYPES: BlockType[] = ['rag', 'memory', 'web_search', 'multimodal_rag', 'academic_search'];

/**
 * 判断是否为检索块类型
 */
export function isRetrievalBlockType(type: BlockType): boolean {
  return RETRIEVAL_BLOCK_TYPES.includes(type);
}

/**
 * 将 BlockStatus 转换为 TimelineEntryStatus
 */
export function blockStatusToTimelineStatus(status: BlockStatus): TimelineEntryStatus {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'running':
      return 'running';
    case 'success':
      return 'success';
    case 'error':
      return 'error';
    default:
      return 'pending';
  }
}

