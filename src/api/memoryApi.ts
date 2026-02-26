import { invoke } from '@tauri-apps/api/core';

export interface MemoryConfig {
  memoryRootFolderId: string | null;
  memoryRootFolderTitle: string | null;
  autoCreateSubfolders: boolean;
  defaultCategory: string;
  privacyMode: boolean;
}

export interface MemorySearchResult {
  noteId: string;
  noteTitle: string;
  folderPath: string;
  chunkText: string;
  score: number;
}

export interface MemoryListItem {
  id: string;
  title: string;
  folderPath: string;
  updatedAt: string;
}

export interface MemoryReadOutput {
  noteId: string;
  title: string;
  content: string;
  folderPath: string;
  updatedAt: string;
}

export interface MemoryWriteOutput {
  noteId: string;
  isNew: boolean;
}

export interface SmartWriteOutput {
  noteId: string;
  event: 'ADD' | 'UPDATE' | 'APPEND' | 'DELETE' | 'NONE';
  isNew: boolean;
  confidence: number;
  reason: string;
  resourceId?: string;
  downgraded: boolean;
}

export interface FolderTreeNode {
  folder: {
    id: string;
    parentId: string | null;
    title: string;
    sortOrder: number;
    isExpanded: boolean;
    createdAt: string;
    updatedAt: string;
  };
  children: FolderTreeNode[];
  items: Array<{
    id: string;
    folderId: string | null;
    itemType: string;
    itemId: string;
    sortOrder: number;
    createdAt: string;
  }>;
}

export async function getMemoryConfig(): Promise<MemoryConfig> {
  return invoke<MemoryConfig>('memory_get_config');
}

export async function setMemoryRootFolder(folderId: string): Promise<void> {
  return invoke('memory_set_root_folder', { folderId });
}

export async function setMemoryPrivacyMode(enabled: boolean): Promise<void> {
  return invoke('memory_set_privacy_mode', { enabled });
}

export async function setMemoryAutoCreateSubfolders(enabled: boolean): Promise<void> {
  return invoke('memory_set_auto_create_subfolders', { enabled });
}

export async function setMemoryDefaultCategory(category: string): Promise<void> {
  return invoke('memory_set_default_category', { category });
}

export async function createMemoryRootFolder(title: string): Promise<string> {
  return invoke<string>('memory_create_root_folder', { title });
}

export async function searchMemory(
  query: string,
  topK?: number
): Promise<MemorySearchResult[]> {
  return invoke<MemorySearchResult[]>('memory_search', { query, topK });
}

export async function readMemory(
  noteId: string
): Promise<MemoryReadOutput | null> {
  return invoke<MemoryReadOutput | null>('memory_read', { noteId });
}

export async function writeMemory(
  title: string,
  content: string,
  folderPath?: string,
  mode?: 'create' | 'update' | 'append'
): Promise<MemoryWriteOutput> {
  return invoke<MemoryWriteOutput>('memory_write', {
    folderPath,
    title,
    content,
    mode,
  });
}

export async function listMemory(
  folderPath?: string,
  limit?: number,
  offset?: number
): Promise<MemoryListItem[]> {
  return invoke<MemoryListItem[]>('memory_list', {
    folderPath,
    limit,
    offset,
  });
}

export async function getMemoryTree(): Promise<FolderTreeNode | null> {
  return invoke<FolderTreeNode | null>('memory_get_tree');
}

// ★ 修复风险2：按 note_id 更新记忆
export async function updateMemoryById(
  noteId: string,
  title?: string,
  content?: string
): Promise<MemoryWriteOutput> {
  return invoke<MemoryWriteOutput>('memory_update_by_id', {
    noteId,
    title,
    content,
  });
}

// ★ 修复风险3：删除记忆
export async function deleteMemory(noteId: string): Promise<void> {
  return invoke('memory_delete', { noteId });
}

export interface MemoryExportItem {
  title: string;
  content: string;
  folder: string;
  updatedAt: string;
}

export async function exportAllMemories(): Promise<MemoryExportItem[]> {
  return invoke<MemoryExportItem[]>('memory_export_all');
}

export async function writeMemorySmart(
  title: string,
  content: string,
  folderPath?: string
): Promise<SmartWriteOutput> {
  return invoke<SmartWriteOutput>('memory_write_smart', {
    folderPath,
    title,
    content,
  });
}
