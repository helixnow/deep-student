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
  workspaceId?: string;
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
  workspaceId?: string;
}

export interface UpdateGroupRequest {
  name?: string;
  description?: string;
  icon?: string;
  color?: string;
  systemPrompt?: string;
  defaultSkillIds?: string[];
  workspaceId?: string;
  sortOrder?: number;
  persistStatus?: 'active' | 'archived' | 'deleted';
}
