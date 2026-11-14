/** Folder domain types shared by the repository and DSTU command layer. */

export interface VfsFolder {
  id: string;
  parentId?: string;
  title: string;
  icon?: string;
  color?: string;
  isExpanded: boolean;
  isFavorite: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface VfsFolderItem {
  id: string;
  folderId?: string;
  itemType: string;
  itemId: string;
  sortOrder: number;
  createdAt: number;
  cachedPath?: string;
}

export interface FolderTreeNode {
  folder: VfsFolder;
  children: FolderTreeNode[];
  items: VfsFolderItem[];
}

export interface FolderResourceInfo {
  itemType: string;
  itemId: string;
  resourceId?: string;
  title: string;
  path: string;
  content?: string;
}

export interface FolderResourcesResult {
  folderId: string;
  folderTitle: string;
  path: string;
  totalCount: number;
  resources: FolderResourceInfo[];
}

export interface BreadcrumbItem {
  id: string;
  name: string;
}

/** Contract F folder constraints (vfs/mod.rs:166-179). */
export const MAX_FOLDER_DEPTH = 10;
export const MAX_FOLDERS_COUNT = 500;
export const MAX_FOLDER_TITLE_LENGTH = 100;
export const MAX_INJECT_RESOURCES = 50;
export const MAX_BATCH_SIZE = 100;

/** Contract H folder error codes (vfs/types.rs:2683-2698). */
export const folderErrors = {
  NOT_FOUND: 'FOLDER_NOT_FOUND',
  ALREADY_EXISTS: 'FOLDER_ALREADY_EXISTS',
  DEPTH_EXCEEDED: 'FOLDER_DEPTH_EXCEEDED',
  ITEM_NOT_FOUND: 'FOLDER_ITEM_NOT_FOUND',
  MIGRATION_FAILED: 'MIGRATION_FAILED',
  INVALID_PARENT: 'INVALID_PARENT',
  COUNT_EXCEEDED: 'FOLDER_COUNT_EXCEEDED',
} as const;

/** `textbook` is stored as `file` everywhere folder membership is persisted. */
export function canonicalFolderItemType(itemType: string): string {
  return itemType === 'textbook' ? 'file' : itemType;
}
