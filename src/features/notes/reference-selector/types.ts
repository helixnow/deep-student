/**
 * 引用选择器 - 类型定义
 *
 * 用于选择教材/题目集识别资源进行引用
 */

import type { SourceDatabase, PreviewType } from '../types/reference';

/**
 * 教材列表项（精简信息）
 */
export interface TextbookListItem {
  id: string;
  title: string;
  updatedAt: number;
  /** 封面缩略图路径（可选） */
  coverPath?: string;
}

/**
 * 题目集识别会话列表项（精简信息）★ Prompt 7 新增
 */
export interface ExamSessionListItem {
  id: string;
  /** 试卷名称（可选） */
  examName?: string;
  /** 状态：pending | completed | processing */
  status: string;
  /** 创建时间 Unix 时间戳（毫秒） */
  createdAt: number;
}

/**
 * 引用选择器类型
 */
export type ReferenceSelectorType = 'textbook' | 'exam_session';

/**
 * 引用选择器属性
 */
export interface ReferenceSelectorProps {
  /** 是否打开 */
  open: boolean;
  /** 打开状态变更回调 */
  onOpenChange: (open: boolean) => void;
  /** 选择器类型 */
  type: ReferenceSelectorType;
  /** 选择回调 */
  onSelect: (item: ReferenceSelectResult) => void;
  /** 已存在的引用列表（用于禁用已引用的资源） */
  existingRefs?: Array<{ sourceDb: string; sourceId: string }>;
}

/**
 * 引用选择结果
 */
export interface ReferenceSelectResult {
  sourceDb: SourceDatabase;
  sourceId: string;
  title: string;
  previewType: PreviewType;
}

/**
 * 统一的资源列表项（内部使用）
 */
export interface UnifiedResourceItem {
  id: string;
  title: string;
  updatedAt: number;
  thumbnail?: string;
  sourceDb: SourceDatabase;
  previewType: PreviewType;
}
