/**
 * Chat V2 - 会话类型定义
 */

export interface ChatSession {
  id: string;
  mode: string;
  title?: string;
  /** 会话简介（自动生成） */
  description?: string;
  /**
   * 标题锁定标志
   *
   * 业界最佳实践：用户手动改名后置 true，自动摘要 LLM 不再覆盖。
   * 后端默认 false，允许首轮对话后自动生成标题。
   */
  titleLocked?: boolean;
  /** 持久化状态 */
  persistStatus?: 'active' | 'archived' | 'deleted';
  createdAt: string;
  updatedAt: string;
  /** 分组 ID（可选） */
  groupId?: string;
  /** 扩展元数据（可选） */
  metadata?: Record<string, unknown>;
}
