/**
 * VFS 文件夹 API Mock 实现
 *
 * 数据契约来源：23-VFS文件夹架构与上下文注入改造任务分配.md
 *
 * Prompt 6: 前端 DSTU 文件夹 API 封装（Mock 部分）
 *
 * 使用内存 Map 模拟后端，供并行开发使用
 */

import type {
  VfsFolder,
  VfsFolderItem,
  FolderTreeNode,
  FolderResourcesResult,
  FolderItemType,
} from '../types/folder';
import { FOLDER_CONSTRAINTS, FOLDER_ERRORS } from '../types/folder';

// ============================================================================
// 内存存储
// ============================================================================

/** 文件夹存储 */
const foldersStore = new Map<string, VfsFolder>();

/** 文件夹内容项存储 */
const folderItemsStore = new Map<string, VfsFolderItem>();


// ============================================================================
// ID 生成
// ============================================================================

/**
 * 简单的 nanoid 替代（Mock 用）
 */
function generateId(prefix: string, length = 10): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `${prefix}_${result}`;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 获取文件夹深度
 */
function getFolderDepth(folderId: string | null): number {
  if (!folderId) return 0;
  const folder = foldersStore.get(folderId);
  if (!folder) return 0;
  return 1 + getFolderDepth(folder.parentId);
}

/**
 * 获取文件夹路径
 */
function getFolderPath(folderId: string | null): string {
  if (!folderId) return '';
  const folder = foldersStore.get(folderId);
  if (!folder) return '';
  const parentPath = getFolderPath(folder.parentId);
  return parentPath ? `${parentPath}/${folder.title}` : folder.title;
}

/**
 * 获取所有文件夹数量
 */
function countAllFolders(): number {
  return foldersStore.size;
}

/**
 * 递归获取所有子文件夹 ID
 */
function getChildFolderIds(folderId: string): string[] {
  const result: string[] = [];
  foldersStore.forEach((folder) => {
    if (folder.parentId === folderId) {
      result.push(folder.id);
      result.push(...getChildFolderIds(folder.id));
    }
  });
  return result;
}

/**
 * 构建文件夹树
 */
function buildFolderTree(
  parentId: string | null
): FolderTreeNode[] {
  const folders: VfsFolder[] = [];
  foldersStore.forEach((folder) => {
    if (folder.parentId === parentId) {
      folders.push(folder);
    }
  });

  // 按 sortOrder 排序
  folders.sort((a, b) => a.sortOrder - b.sortOrder);

  return folders.map((folder) => {
    // 获取文件夹内的内容项
    const items: VfsFolderItem[] = [];
    folderItemsStore.forEach((item) => {
      if (item.folderId === folder.id) {
        items.push(item);
      }
    });
    items.sort((a, b) => a.sortOrder - b.sortOrder);

    return {
      folder,
      children: buildFolderTree(folder.id),
      items,
    };
  });
}

// ============================================================================
// Mock API 实现
// ============================================================================

/**
 * 文件夹 API Mock 实现
 */
export const folderApiMock = {
  // ==========================================================================
  // 文件夹管理
  // ==========================================================================

  /**
   * 创建文件夹
   */
  async createFolder(
    title: string,
    parentId?: string,
    icon?: string,
    color?: string
  ): Promise<VfsFolder> {
    // 验证标题长度
    if (title.length > FOLDER_CONSTRAINTS.MAX_TITLE_LENGTH) {
      throw new Error(`Title too long, max ${FOLDER_CONSTRAINTS.MAX_TITLE_LENGTH} characters`);
    }

    // 验证父文件夹
    if (parentId) {
      const parent = foldersStore.get(parentId);
      if (!parent) {
        throw new Error(FOLDER_ERRORS.INVALID_PARENT);
      }
      // 检查深度限制
      const depth = getFolderDepth(parentId);
      if (depth >= FOLDER_CONSTRAINTS.MAX_DEPTH - 1) {
        throw new Error(FOLDER_ERRORS.DEPTH_EXCEEDED);
      }
    }

    // 检查数量限制
    if (countAllFolders() >= FOLDER_CONSTRAINTS.MAX_FOLDERS) {
      throw new Error(FOLDER_ERRORS.COUNT_EXCEEDED);
    }

    const now = Date.now();
    const folder: VfsFolder = {
      id: generateId('fld'),
      parentId: parentId || null,
      title,
      icon,
      color,
      isExpanded: true,
      sortOrder: countAllFolders(),
      createdAt: now,
      updatedAt: now,
    };

    foldersStore.set(folder.id, folder);
    return folder;
  },

  /**
   * 获取文件夹
   */
  async getFolder(folderId: string): Promise<VfsFolder | null> {
    return foldersStore.get(folderId) || null;
  },

  /**
   * 重命名文件夹
   */
  async renameFolder(folderId: string, title: string): Promise<void> {
    const folder = foldersStore.get(folderId);
    if (!folder) {
      throw new Error(FOLDER_ERRORS.NOT_FOUND);
    }
    if (title.length > FOLDER_CONSTRAINTS.MAX_TITLE_LENGTH) {
      throw new Error(`Title too long, max ${FOLDER_CONSTRAINTS.MAX_TITLE_LENGTH} characters`);
    }
    folder.title = title;
    folder.updatedAt = Date.now();
    foldersStore.set(folderId, folder);
  },

  /**
   * 删除文件夹
   *
   * 级联删除子文件夹，内容项的 folderId 置为 null
   */
  async deleteFolder(folderId: string): Promise<void> {
    const folder = foldersStore.get(folderId);
    if (!folder) {
      throw new Error(FOLDER_ERRORS.NOT_FOUND);
    }

    // 获取所有子文件夹
    const childIds = getChildFolderIds(folderId);
    const allFolderIds = [folderId, ...childIds];

    // 将这些文件夹中的内容项移到根级
    folderItemsStore.forEach((item, key) => {
      if (item.folderId && allFolderIds.includes(item.folderId)) {
        item.folderId = null;
        folderItemsStore.set(key, item);
      }
    });

    // 删除所有文件夹
    allFolderIds.forEach((id) => foldersStore.delete(id));
  },

  /**
   * 移动文件夹
   */
  async moveFolder(folderId: string, newParentId?: string): Promise<void> {
    const folder = foldersStore.get(folderId);
    if (!folder) {
      throw new Error(FOLDER_ERRORS.NOT_FOUND);
    }

    if (newParentId) {
      const newParent = foldersStore.get(newParentId);
      if (!newParent) {
        throw new Error(FOLDER_ERRORS.INVALID_PARENT);
      }
      // 不能移动到自己的子文件夹
      const childIds = getChildFolderIds(folderId);
      if (childIds.includes(newParentId)) {
        throw new Error(FOLDER_ERRORS.INVALID_PARENT);
      }
      // 检查深度
      const newDepth = getFolderDepth(newParentId) + 1;
      if (newDepth >= FOLDER_CONSTRAINTS.MAX_DEPTH) {
        throw new Error(FOLDER_ERRORS.DEPTH_EXCEEDED);
      }
    }

    folder.parentId = newParentId || null;
    folder.updatedAt = Date.now();
    foldersStore.set(folderId, folder);
  },

  /**
   * 设置文件夹展开状态
   */
  async setFolderExpanded(folderId: string, isExpanded: boolean): Promise<void> {
    const folder = foldersStore.get(folderId);
    if (!folder) {
      throw new Error(FOLDER_ERRORS.NOT_FOUND);
    }
    folder.isExpanded = isExpanded;
    folder.updatedAt = Date.now();
    foldersStore.set(folderId, folder);
  },

  // ==========================================================================
  // 内容管理
  // ==========================================================================

  /**
   * 添加内容到文件夹
   */
  async addItem(
    folderId: string | null,
    itemType: FolderItemType,
    itemId: string
  ): Promise<VfsFolderItem> {
    // 检查是否已存在
    let existingKey: string | null = null;
    folderItemsStore.forEach((item, key) => {
      if (
        item.itemType === itemType &&
        item.itemId === itemId
      ) {
        existingKey = key;
      }
    });

    if (existingKey) {
      // 已存在，更新 folderId
      const existingItem = folderItemsStore.get(existingKey)!;
      existingItem.folderId = folderId;
      folderItemsStore.set(existingKey, existingItem);
      return existingItem;
    }

    // 验证文件夹
    if (folderId) {
      const folder = foldersStore.get(folderId);
      if (!folder) {
        throw new Error(FOLDER_ERRORS.NOT_FOUND);
      }
    }

    const now = Date.now();
    const item: VfsFolderItem = {
      id: generateId('fi'),
      folderId,
      itemType,
      itemId,
      sortOrder: 0,
      createdAt: now,
    };

    folderItemsStore.set(item.id, item);
    return item;
  },

  /**
   * 从文件夹移除内容
   */
  async removeItem(
    itemType: string,
    itemId: string
  ): Promise<void> {
    let keyToDelete: string | null = null;
    folderItemsStore.forEach((item, key) => {
      if (
        item.itemType === itemType &&
        item.itemId === itemId
      ) {
        keyToDelete = key;
      }
    });

    if (keyToDelete) {
      folderItemsStore.delete(keyToDelete);
    }
  },

  /**
   * 移动内容到另一文件夹
   */
  async moveItem(
    itemType: string,
    itemId: string,
    newFolderId?: string
  ): Promise<void> {
    // 验证新文件夹
    if (newFolderId) {
      const folder = foldersStore.get(newFolderId);
      if (!folder) {
        throw new Error(FOLDER_ERRORS.NOT_FOUND);
      }
    }

    folderItemsStore.forEach((item, key) => {
      if (
        item.itemType === itemType &&
        item.itemId === itemId
      ) {
        item.folderId = newFolderId || null;
        folderItemsStore.set(key, item);
      }
    });
  },

  // ==========================================================================
  // 查询
  // ==========================================================================

  /**
   * 列出所有文件夹
   */
  async listFolders(): Promise<VfsFolder[]> {
    const folders: VfsFolder[] = [];
    foldersStore.forEach((folder) => {
      folders.push(folder);
    });
    return folders.sort((a, b) => a.sortOrder - b.sortOrder);
  },

  /**
   * 获取文件夹树
   */
  async getFolderTree(): Promise<FolderTreeNode[]> {
    return buildFolderTree(null);
  },

  /**
   * 获取文件夹内的内容项
   */
  async getFolderItems(
    folderId?: string
  ): Promise<VfsFolderItem[]> {
    const items: VfsFolderItem[] = [];
    folderItemsStore.forEach((item) => {
      if (item.folderId === (folderId || null)) {
        items.push(item);
      }
    });
    return items.sort((a, b) => a.sortOrder - b.sortOrder);
  },

  // ==========================================================================
  // 上下文注入专用
  // ==========================================================================

  /**
   * 递归获取文件夹内所有资源
   */
  async getFolderAllResources(
    folderId: string,
    includeSubfolders: boolean,
    includeContent: boolean
  ): Promise<FolderResourcesResult> {
    const folder = foldersStore.get(folderId);
    if (!folder) {
      throw new Error(FOLDER_ERRORS.NOT_FOUND);
    }

    // 收集所有要查询的文件夹 ID
    const folderIds = [folderId];
    if (includeSubfolders) {
      folderIds.push(...getChildFolderIds(folderId));
    }

    // 收集所有内容项
    const items: VfsFolderItem[] = [];
    folderItemsStore.forEach((item) => {
      if (item.folderId && folderIds.includes(item.folderId)) {
        items.push(item);
      }
    });

    // 构建资源信息
    const resources = items.map((item) => ({
      itemType: item.itemType,
      itemId: item.itemId,
      resourceId: undefined,
      title: `Mock ${item.itemType} ${item.itemId}`,
      path: getFolderPath(item.folderId),
      content: includeContent ? `Mock content for ${item.itemId}` : undefined,
    }));

    return {
      folderId,
      folderTitle: folder.title,
      path: getFolderPath(folderId),
      totalCount: resources.length,
      resources,
    };
  },

  // ==========================================================================
  // 排序
  // ==========================================================================

  /**
   * 重新排序文件夹
   */
  async reorderFolders(folderIds: string[]): Promise<void> {
    folderIds.forEach((id, index) => {
      const folder = foldersStore.get(id);
      if (folder) {
        folder.sortOrder = index;
        folder.updatedAt = Date.now();
        foldersStore.set(id, folder);
      }
    });
  },

  /**
   * 重新排序内容项
   */
  async reorderItems(folderId: string | null, itemIds: string[]): Promise<void> {
    itemIds.forEach((id, index) => {
      const item = folderItemsStore.get(id);
      if (item) {
        item.sortOrder = index;
        folderItemsStore.set(id, item);
      }
    });
  },

  // ==========================================================================
  // 测试辅助方法
  // ==========================================================================

  /**
   * 清空所有数据（测试用）
   */
  _clearAll(): void {
    foldersStore.clear();
    folderItemsStore.clear();
  },

  /**
   * 获取内部存储状态（测试用）
   */
  _getStoreState(): {
    folders: Map<string, VfsFolder>;
    items: Map<string, VfsFolderItem>;
  } {
    return {
      folders: new Map(foldersStore),
      items: new Map(folderItemsStore),
    };
  },
};
