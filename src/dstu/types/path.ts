/**
 * DSTU 真实路径系统类型定义
 *
 * 数据契约来源：28-DSTU真实路径架构重构任务分配.md 契约 D
 *
 * 核心设计原则：
 * 1. 位置唯一性：资源的位置只由 folder_items.folder_id 决定
 * 2. 路径真实性：DSTU 路径反映真实的文件夹层级
 * 3. 标识分离：id 用于唯一标识，hash 用于内容引用
 */

// ============================================================================
// D1: 路径解析结果
// ============================================================================

/**
 * 路径解析结果
 *
 * 解析 DSTU 路径后的结构化数据
 *
 * @example
 * ```typescript
 * // 解析 "/高考复习/函数/note_abc123"
 * {
 *   fullPath: "/高考复习/函数/note_abc123",
 *   folderPath: "/高考复习/函数",
 *   resourceId: "note_abc123",
 *   resourceType: "note",
 *   isRoot: false,
 *   isVirtual: false,
 * }
 * ```
 */
export interface ParsedPath {
  /** 完整路径 */
  fullPath: string;
  /** 文件夹部分（不含资源 ID），null 表示根目录 */
  folderPath: string | null;
  /** 资源 ID（最后一段），null 表示路径指向文件夹 */
  resourceId: string | null;
  /**
   * 资源 ID 别名
   * @deprecated 使用 resourceId 替代
   */
  id: string | null;
  /** 资源类型（从 ID 前缀推断），null 表示无法推断或为文件夹 */
  resourceType: string | null;
  /** 是否为根目录 */
  isRoot: boolean;
  /** 是否为虚拟路径（@trash, @recent 等） */
  isVirtual: boolean;
  /** 虚拟路径类型（trash, recent, favorites, all 等），仅当 isVirtual 为 true 时有值 */
  virtualType?: string;
}

// ============================================================================
// D2: 资源定位信息
// ============================================================================

/**
 * 资源定位信息
 *
 * 完整描述资源的位置信息
 */
export interface ResourceLocation {
  /** 资源唯一 ID（如 note_abc123, tb_xyz789） */
  id: string;
  /** 资源类型（note, textbook, exam, translation, essay, folder 等） */
  resourceType: string;
  /** 所在文件夹 ID，null 表示根目录 */
  folderId: string | null;
  /** 文件夹路径（如 "/高考复习/函数"） */
  folderPath: string;
  /** 完整路径（如 "/高考复习/函数/note_abc123"） */
  fullPath: string;
  /** 内容哈希（如有），用于校验引用有效性 */
  hash?: string;
}

// ============================================================================
// D3: 路径工具函数类型
// ============================================================================

/**
 * 纯前端路径工具接口
 *
 * 所有方法为纯函数，不调用后端
 */
export interface PathUtils {
  /**
   * 解析路径
   * @param path 完整路径
   * @returns 解析结果
   */
  parse(path: string): ParsedPath;

  /**
   * 构建路径
   * @param folderId 文件夹 ID，null 表示根目录
   * @param resourceId 资源 ID
   * @returns 完整路径字符串（注意：需要后端配合获取文件夹路径）
   */
  build(folderPath: string | null, resourceId: string): string;

  /**
   * 从资源 ID 推断资源类型
   * @param id 资源 ID
   * @returns 资源类型，无法推断返回 null
   */
  getResourceType(id: string): string | null;

  /**
   * 验证路径格式是否有效
   * @param path 路径字符串
   * @returns 是否有效
   */
  isValidPath(path: string): boolean;

  /**
   * 检查是否为虚拟路径
   * @param path 路径字符串
   * @returns 是否为虚拟路径
   */
  isVirtualPath(path: string): boolean;

  /**
   * 获取路径的父文件夹路径
   * @param path 完整路径
   * @returns 父路径，根目录返回 null
   */
  getParentPath(path: string): string | null;

  /**
   * 获取路径的最后一段（文件名/资源 ID）
   * @param path 完整路径
   * @returns 最后一段
   */
  getBasename(path: string): string;

  /**
   * 连接路径段
   * @param segments 路径段数组
   * @returns 完整路径
   */
  join(...segments: string[]): string;
}

// ============================================================================
// D4: 批量操作类型
// ============================================================================

/**
 * 批量移动请求
 */
export interface BatchMoveRequest {
  /** 要移动的资源 ID 列表 */
  itemIds: string[];
  /** 目标文件夹 ID，null 表示根目录 */
  targetFolderId: string | null;
}

/**
 * 批量移动失败项
 */
export interface FailedMoveItem {
  /** 失败的资源 ID */
  itemId: string;
  /** 失败原因 */
  error: string;
}

/**
 * 批量移动结果（逐项处理，结构化结果）
 *
 * 逐项处理移动操作，返回成功和失败的详细信息：
 * - 成功项正常移动并发射事件
 * - 失败项记录原因，不影响其他项
 */
export interface BatchMoveResult {
  /** 成功移动的资源位置信息 */
  successes: ResourceLocation[];
  /** 移动失败的项及原因 */
  failedItems: FailedMoveItem[];
  /** 移动的总数量 */
  totalCount: number;
}

// ============================================================================
// D6: 资源 ID 前缀映射
// ============================================================================

/**
 * 资源 ID 前缀到类型的映射
 *
 * 用于从 ID 前缀推断资源类型
 */
export const RESOURCE_ID_PREFIX_MAP: Record<string, string> = {
  note_: 'note',
  tb_: 'textbook',
  exam_: 'exam',
  tr_: 'translation',
  essay_: 'essay',
  fld_: 'folder',
  att_: 'attachment',
  img_: 'image',
  file_: 'file',
  mm_: 'mindmap',
} as const;

/**
 * 资源类型到 ID 前缀的映射
 */
export const RESOURCE_TYPE_TO_PREFIX: Record<string, string> = {
  note: 'note_',
  textbook: 'tb_',
  exam: 'exam_',
  translation: 'tr_',
  essay: 'essay_',
  folder: 'fld_',
  attachment: 'att_',
  image: 'img_',
  file: 'file_',
  mindmap: 'mm_',
} as const;

// ============================================================================
// D7: 虚拟路径常量
// ============================================================================

// ============================================================================
// D6.5: 资源 ID 长度限制
// ============================================================================

/**
 * 资源 ID 最大长度
 * 
 * [PATH-006] 安全限制：防止超长资源 ID 导致的性能问题和潜在攻击
 * 与后端 path_types.rs 保持一致
 */
export const MAX_RESOURCE_ID_LENGTH = 128;

/**
 * 虚拟路径前缀
 */
export const VIRTUAL_PATH_PREFIXES = {
  /** 回收站 */
  TRASH: '/@trash',
  /** 最近使用 */
  RECENT: '/@recent',
  /** 收藏 */
  FAVORITES: '/@favorites',
  /** 全部 */
  ALL: '/@all',
} as const;

/**
 * 虚拟路径类型
 */
export type VirtualPathType = 'trash' | 'recent' | 'favorites' | 'all';

// ============================================================================
// D8: 路径错误类型
// ============================================================================

/**
 * 路径错误码
 */
export const PATH_ERROR_CODES = {
  /** 路径格式无效 */
  INVALID_FORMAT: 'PATH_INVALID_FORMAT',
  /** 资源不存在 */
  NOT_FOUND: 'PATH_NOT_FOUND',
  /** 文件夹不存在 */
  FOLDER_NOT_FOUND: 'PATH_FOLDER_NOT_FOUND',
  /** 路径冲突（已存在同名资源） */
  CONFLICT: 'PATH_CONFLICT',
  /** 循环引用（文件夹移动到自己的子文件夹） */
  CIRCULAR_REFERENCE: 'PATH_CIRCULAR_REFERENCE',
} as const;

export type PathErrorCode = typeof PATH_ERROR_CODES[keyof typeof PATH_ERROR_CODES];

/**
 * 路径错误
 */
export interface PathError extends Error {
  /** 错误码 */
  code: PathErrorCode;
  /** 相关路径 */
  path?: string;
}

/**
 * 创建路径错误
 */
export function createPathError(
  code: PathErrorCode,
  message: string,
  path?: string
): PathError {
  const error = new Error(message) as PathError;
  error.code = code;
  error.path = path;
  error.name = 'PathError';
  return error;
}
