/**
 * Chat V2 - 会话类型定义
 */

export interface ChatSession {
  id: string;
  mode: string;
  title?: string;
  /** 会话简介（自动生成） */
  description?: string;
  /** 持久化状态 */
  persistStatus?: 'active' | 'archived' | 'deleted';
  createdAt: string;
  updatedAt: string;
  /** 分组 ID（可选） */
  groupId?: string;
  /** 扩展元数据（可选） */
  metadata?: Record<string, unknown>;
}
