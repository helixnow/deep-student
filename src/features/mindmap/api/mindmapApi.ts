/**
 * 知识导图 Tauri API 封装
 *
 * 所有 command 调用统一经过 invokeMindMap，把后端返回的字符串错误
 * 归一化为可判别的 MindMapApiError（携带错误码 + 原始错误）。
 */

import { invoke } from '@tauri-apps/api/core';
import type {
  VfsMindMap,
  CreateMindMapParams,
  UpdateMindMapParams,
} from '../types';

// ============================================================================
// 类型化错误
// ============================================================================

/**
 * 后端错误码标记常量（后端以字符串错误返回，消息中包含这些标记）。
 * 导出供 store / UI 收敛判断逻辑使用，避免散落的魔法字符串。
 */
export const MINDMAP_ERROR_CODES = {
  /** 乐观并发冲突：expectedUpdatedAt 与服务端 updatedAt 不一致 */
  UPDATE_CONFLICT: 'MINDMAP_UPDATE_CONFLICT',
} as const;

export type MindMapErrorCode =
  (typeof MINDMAP_ERROR_CODES)[keyof typeof MINDMAP_ERROR_CODES];

/**
 * 归一化后的导图 API 错误。
 * message 保留后端原始错误文本（含错误码标记），旧的 `message.includes(...)`
 * 判断方式仍然兼容；新代码应优先使用 `code` 字段或 isMindMapConflictError。
 */
export class MindMapApiError extends Error {
  /** 可判别的错误码；无法识别时为 null */
  readonly code: MindMapErrorCode | null;
  /** 出错的 Tauri command 名 */
  readonly command: string;

  constructor(command: string, message: string, code: MindMapErrorCode | null, cause?: unknown) {
    super(message, { cause });
    this.name = 'MindMapApiError';
    this.command = command;
    this.code = code;
  }
}

function extractErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function detectErrorCode(message: string): MindMapErrorCode | null {
  for (const code of Object.values(MINDMAP_ERROR_CODES)) {
    if (message.includes(code)) return code;
  }
  return null;
}

/**
 * 把任意 invoke 抛出的错误归一化为 MindMapApiError（幂等：已归一化则原样返回）
 */
export function normalizeMindMapError(command: string, error: unknown): MindMapApiError {
  if (error instanceof MindMapApiError) return error;
  const message = extractErrorMessage(error);
  return new MindMapApiError(command, message, detectErrorCode(message), error);
}

/**
 * 判断错误是否为保存乐观并发冲突（MINDMAP_UPDATE_CONFLICT）。
 * 同时兼容归一化前（字符串 / 普通 Error）与归一化后的形态。
 */
export function isMindMapConflictError(error: unknown): boolean {
  if (error instanceof MindMapApiError) {
    return error.code === MINDMAP_ERROR_CODES.UPDATE_CONFLICT;
  }
  return extractErrorMessage(error).includes(MINDMAP_ERROR_CODES.UPDATE_CONFLICT);
}

/** 统一的 invoke 包装：错误归一化为 MindMapApiError */
async function invokeMindMap<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw normalizeMindMapError(command, error);
  }
}

// ============================================================================
// 元数据 / 内容 CRUD
// ============================================================================

/**
 * 更新导图参数（API 层扩展）：在 UpdateMindMapParams 基础上增加 versionSource。
 * 后端 UpdateMindMapInput 支持可选 camelCase `versionSource` 字段，用于标记
 * 本次保存产生的版本快照来源（如 'manual' | 'auto' | 'chat_update'）；
 * 后端未合入该字段时会忽略未知字段，透传安全。
 */
export interface UpdateMindMapApiParams extends UpdateMindMapParams {
  /** 版本快照来源标记，可选，透传给后端 */
  versionSource?: string;
}

/**
 * 创建知识导图
 */
export async function createMindMap(params: CreateMindMapParams): Promise<VfsMindMap> {
  return invokeMindMap<VfsMindMap>('vfs_create_mindmap', { params });
}

/**
 * 获取知识导图元数据
 */
export async function getMindMap(mindmapId: string): Promise<VfsMindMap | null> {
  return invokeMindMap<VfsMindMap | null>('vfs_get_mindmap', { mindmapId });
}

/**
 * 获取知识导图内容
 */
export async function getMindMapContent(mindmapId: string): Promise<string | null> {
  return invokeMindMap<string | null>('vfs_get_mindmap_content', { mindmapId });
}

/**
 * 更新知识导图
 */
export async function updateMindMap(
  mindmapId: string,
  params: UpdateMindMapApiParams
): Promise<VfsMindMap> {
  return invokeMindMap<VfsMindMap>('vfs_update_mindmap', { mindmapId, params });
}

/**
 * 删除知识导图（软删除）
 */
export async function deleteMindMap(mindmapId: string): Promise<void> {
  return invokeMindMap<void>('vfs_delete_mindmap', { mindmapId });
}

/**
 * 列出所有知识导图
 */
export async function listMindMaps(): Promise<VfsMindMap[]> {
  return invokeMindMap<VfsMindMap[]>('vfs_list_mindmaps');
}

/**
 * 设置知识导图收藏状态
 */
export async function setMindMapFavorite(
  mindmapId: string,
  isFavorite: boolean
): Promise<void> {
  return invokeMindMap<void>('vfs_set_mindmap_favorite', { mindmapId, isFavorite });
}

// ============================================================================
// 版本历史
// ============================================================================

/**
 * 思维导图版本元数据（对齐后端 VfsMindMapVersion 的 camelCase 序列化）
 */
export interface VfsMindMapVersion {
  /** 版本 ID（格式：mv_{nanoid(10)}） */
  versionId: string;
  /** 所属思维导图 ID */
  mindmapId: string;
  /** 关联的资源 ID（版本内容存 resources.data） */
  resourceId: string;
  /** 快照当时的标题 */
  title: string;
  /** 版本标签（可选） */
  label?: string;
  /** 来源：'chat_update' | 'chat_edit_nodes' | 'manual' | 'auto' */
  source?: string;
  /** 创建时间 */
  createdAt: string;
}

/**
 * 获取思维导图的版本历史列表
 */
export async function getMindMapVersions(mindmapId: string): Promise<VfsMindMapVersion[]> {
  return invokeMindMap<VfsMindMapVersion[]>('vfs_get_mindmap_versions', { mindmapId });
}

/**
 * 获取指定版本的元数据
 */
export async function getMindMapVersion(versionId: string): Promise<VfsMindMapVersion | null> {
  return invokeMindMap<VfsMindMapVersion | null>('vfs_get_mindmap_version', { versionId });
}

/**
 * 获取指定版本的导图内容（MindMapDocument JSON 字符串）
 */
export async function getMindMapVersionContent(versionId: string): Promise<string | null> {
  return invokeMindMap<string | null>('vfs_get_mindmap_version_content', { versionId });
}

/**
 * 恢复思维导图到指定版本（服务端把版本内容写回当前文档并返回最新元数据）。
 * 调用方约定：恢复前应先保存当前未保存修改（UI 层负责），恢复后重新 loadMindMap。
 */
export async function restoreMindMapVersion(versionId: string): Promise<VfsMindMap> {
  return invokeMindMap<VfsMindMap>('vfs_restore_mindmap_version', { versionId });
}
