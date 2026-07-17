/**
 * Chat V2 - 会话分组类型
 */

export interface SessionGroup {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  systemPrompt?: string;
  defaultSkillIds: string[];
  pinnedResourceIds: string[];
  workspaceId?: string;
  /** 课题默认 runtime root（workspace / authorized_*）；未绑定为 null */
  defaultRuntimeRootId?: string | null;
  /** 本机展示用绝对路径缓存；跨机忽略 */
  preferredProjectRootPath?: string | null;
  sortOrder: number;
  persistStatus: 'active' | 'archived' | 'deleted';
  createdAt: string;
  updatedAt: string;
}

export interface CreateGroupRequest {
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  systemPrompt?: string;
  defaultSkillIds?: string[];
  pinnedResourceIds?: string[];
  workspaceId?: string;
  defaultRuntimeRootId?: string | null;
  preferredProjectRootPath?: string | null;
}

export interface UpdateGroupRequest {
  name?: string;
  description?: string;
  icon?: string;
  color?: string;
  systemPrompt?: string;
  defaultSkillIds?: string[];
  pinnedResourceIds?: string[];
  workspaceId?: string;
  /** 传 '' 或 null 表示清除绑定（与 systemPrompt 清空习惯一致） */
  defaultRuntimeRootId?: string | null;
  preferredProjectRootPath?: string | null;
  sortOrder?: number;
  persistStatus?: 'active' | 'archived' | 'deleted';
}
