/**
 * VFS 文件夹类型定义
 *
 * 数据契约来源：23-VFS文件夹架构与上下文注入改造任务分配.md 契约 C
 *
 * Prompt 6/7 共用类型定义
 */

// ============================================================================
// C1: 文件夹实体
// ============================================================================

/**
 * VFS 文件夹实体
 *
 * 对应后端 VfsFolder 结构
 */
export interface VfsFolder {
  /** 文件夹 ID，格式：fld_{nanoid(10)} */
  id: string;
  /** 父文件夹 ID（null 表示根级） */
  parentId: string | null;
  /** 显示标题 */
  title: string;
  /** 可选图标标识 */
  icon?: string;
  /** 可选颜色标识 */
  color?: string;
  /** 展开状态 */
  isExpanded: boolean;
  /** 同级排序 */
  sortOrder: number;
  /** 是否为内置文件夹（不可删除） */
  isBuiltin?: boolean;
  /** 内置文件夹类型（exam | translation | essay） */
  builtinType?: 'exam' | 'translation' | 'essay';
  /** 创建时间（毫秒时间戳） */
  createdAt: number;
  /** 更新时间（毫秒时间戳） */
  updatedAt: number;
}

// ============================================================================
// 内置文件夹定义
// ============================================================================

/** 内置文件夹类型 */
export type BuiltinFolderType = 'exam' | 'translation' | 'essay';

/** 内置文件夹 ID 常量 */
export const BUILTIN_FOLDER_IDS = {
  EXAM: '__builtin_exam__',
  TRANSLATION: '__builtin_translation__',
  ESSAY: '__builtin_essay__',
} as const;

/** 内置文件夹配置 */
export const BUILTIN_FOLDERS: Record<BuiltinFolderType, { id: string; titleKey: string; icon: string }> = {
  exam: { id: BUILTIN_FOLDER_IDS.EXAM, titleKey: 'folder.builtinExam', icon: 'ClipboardList' },
  translation: { id: BUILTIN_FOLDER_IDS.TRANSLATION, titleKey: 'folder.builtinTranslation', icon: 'Languages' },
  essay: { id: BUILTIN_FOLDER_IDS.ESSAY, titleKey: 'folder.builtinEssay', icon: 'PenTool' },
};

// ============================================================================
// C2: 文件夹内容项
// ============================================================================

/**
 * 文件夹内容项类型
 */
export type FolderItemType = 'note' | 'textbook' | 'exam' | 'translation' | 'essay' | 'image' | 'file' | 'mindmap';

/**
 * VFS 文件夹内容项
 *
 * 对应后端 VfsFolderItem 结构
 */
export interface VfsFolderItem {
  /** 内容项 ID，格式：fi_{nanoid(10)} */
  id: string;
  /** 所属文件夹 ID（null 表示根级） */
  folderId: string | null;
  /** 内容类型 */
  itemType: FolderItemType;
  /** 资源 ID（note_xxx, tb_xxx 等） */
  itemId: string;
  /** 同级排序 */
  sortOrder: number;
  /** 创建时间（毫秒时间戳） */
  createdAt: number;
}

// ============================================================================
// C3: 文件夹树节点
// ============================================================================

/**
 * 文件夹树节点
 *
 * 包含子文件夹和内容项，用于树形视图渲染
 */
export interface FolderTreeNode {
  /** 文件夹信息 */
  folder: VfsFolder;
  /** 子文件夹列表 */
  children: FolderTreeNode[];
  /** 文件夹内的内容项列表 */
  items: VfsFolderItem[];
}

// ============================================================================
// C4: 文件夹资源聚合结果
// ============================================================================

/**
 * 文件夹资源信息
 *
 * 用于上下文注入时描述单个资源
 */
export interface FolderResourceInfo {
  /** 内容类型 */
  itemType: string;
  /** 资源 ID */
  itemId: string;
  /** VFS resources 表 ID（如有） */
  resourceId?: string;
  /** 资源标题 */
  title: string;
  /** 资源在文件夹树中的路径 */
  path: string;
  /** 资源内容（按需加载） */
  content?: string;
}

/**
 * 文件夹资源聚合结果
 *
 * 递归获取文件夹内所有资源的结果，用于 Chat V2 上下文注入
 */
export interface FolderResourcesResult {
  /** 文件夹 ID */
  folderId: string;
  /** 文件夹标题 */
  folderTitle: string;
  /** 文件夹完整路径，如 "高考复习/函数" */
  path: string;
  /** 资源总数 */
  totalCount: number;
  /** 资源列表 */
  resources: FolderResourceInfo[];
}

// ============================================================================
// C5: 文件夹上下文数据（Chat V2 注入用）
// ============================================================================

/**
 * 文件夹上下文数据
 *
 * Chat V2 注入时使用的数据结构
 */
export interface FolderContextData {
  /** 文件夹 ID */
  folderId: string;
  /** 文件夹标题 */
  folderTitle: string;
  /** 文件夹完整路径 */
  path: string;
  /** 资源列表 */
  resources: Array<{
    itemType: string;
    itemId: string;
    title: string;
    path: string;
    content: string;
  }>;
}

// ============================================================================
// 错误码定义（契约 H）
// ============================================================================

/**
 * 文件夹错误码
 */
export const FOLDER_ERRORS = {
  /** 文件夹不存在 */
  NOT_FOUND: 'FOLDER_NOT_FOUND',
  /** 文件夹已存在（幂等检查） */
  ALREADY_EXISTS: 'FOLDER_ALREADY_EXISTS',
  /** 超过最大深度 */
  DEPTH_EXCEEDED: 'FOLDER_DEPTH_EXCEEDED',
  /** 内容项不存在 */
  ITEM_NOT_FOUND: 'FOLDER_ITEM_NOT_FOUND',
  /** 迁移失败 */
  MIGRATION_FAILED: 'MIGRATION_FAILED',
  /** 无效的父文件夹 */
  INVALID_PARENT: 'INVALID_PARENT',
  /** 超过最大文件夹数量 */
  COUNT_EXCEEDED: 'FOLDER_COUNT_EXCEEDED',
} as const;

export type FolderErrorCode = typeof FOLDER_ERRORS[keyof typeof FOLDER_ERRORS];

// ============================================================================
// 全局约束（契约 F）
// ============================================================================

/**
 * 文件夹系统约束常量
 */
export const FOLDER_CONSTRAINTS = {
  /** 最大文件夹深度 */
  MAX_DEPTH: 10,
  /** 最大文件夹数 */
  MAX_FOLDERS: 500,
  /** 单文件夹最大内容数 */
  MAX_ITEMS_PER_FOLDER: 1000,
  /** 文件夹名称最大长度 */
  MAX_TITLE_LENGTH: 100,
  /** 批量注入最大资源数 */
  MAX_INJECT_RESOURCES: 50,
} as const;

// ============================================================================
// 辅助类型
// ============================================================================

/**
 * 创建文件夹的参数
 */
export interface CreateFolderParams {
  title: string;
  parentId?: string;
  icon?: string;
  color?: string;
}

/**
 * 添加内容项的参数
 */
export interface AddItemParams {
  folderId: string | null;
  itemType: FolderItemType;
  itemId: string;
}
