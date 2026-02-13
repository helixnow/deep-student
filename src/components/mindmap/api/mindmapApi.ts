/**
 * 知识导图 Tauri API 封装
 */

import { invoke } from '@tauri-apps/api/core';
import type {
  VfsMindMap,
  CreateMindMapParams,
  UpdateMindMapParams,
} from '../types';

/**
 * 创建知识导图
 */
export async function createMindMap(params: CreateMindMapParams): Promise<VfsMindMap> {
  return invoke<VfsMindMap>('vfs_create_mindmap', { params });
}

/**
 * 获取知识导图元数据
 */
export async function getMindMap(mindmapId: string): Promise<VfsMindMap | null> {
  return invoke<VfsMindMap | null>('vfs_get_mindmap', { mindmapId });
}

/**
 * 获取知识导图内容
 */
export async function getMindMapContent(mindmapId: string): Promise<string | null> {
  return invoke<string | null>('vfs_get_mindmap_content', { mindmapId });
}

/**
 * 更新知识导图
 */
export async function updateMindMap(
  mindmapId: string,
  params: UpdateMindMapParams
): Promise<VfsMindMap> {
  return invoke<VfsMindMap>('vfs_update_mindmap', { mindmapId, params });
}

/**
 * 删除知识导图（软删除）
 */
export async function deleteMindMap(mindmapId: string): Promise<void> {
  return invoke<void>('vfs_delete_mindmap', { mindmapId });
}

/**
 * 列出所有知识导图
 */
export async function listMindMaps(): Promise<VfsMindMap[]> {
  return invoke<VfsMindMap[]>('vfs_list_mindmaps');
}

/**
 * 设置知识导图收藏状态
 */
export async function setMindMapFavorite(
  mindmapId: string,
  isFavorite: boolean
): Promise<void> {
  return invoke<void>('vfs_set_mindmap_favorite', { mindmapId, isFavorite });
}
