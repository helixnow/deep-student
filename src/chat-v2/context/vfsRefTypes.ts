/**
 * Chat V2 - VFS 引用模式类型定义
 *
 * 遵循文档 24 契约 B：上下文引用数据结构
 *
 * 核心设计原则：引用模式 vs 快照模式
 * - 存储：sourceId（稳定业务 ID）+ resourceHash（内容版本）
 * - 不存储：path、content（发送时实时获取）
 *
 * @see 24-LRFS统一入口模型与访达式资源管理器.md - 契约 B
 */

// ============================================================================
// VFS 资源类型
// ============================================================================

/**
 * VFS 支持的资源类型
 * ★ 2026-01 添加 mindmap 类型支持
 */
export type VfsResourceType =
  | 'note'
  | 'textbook'
  | 'exam'
  | 'translation'
  | 'essay'
  | 'image'
  | 'file'
  | 'retrieval'   // ★ 检索结果
  | 'mindmap';    // ★ 知识导图

// ============================================================================
// 上下文引用数据结构
// ============================================================================

/**
 * 图片注入模式（与 common.ts 对应）
 */
export type ImageInjectMode = 'image' | 'ocr';

/**
 * PDF 注入模式（与 common.ts 对应）
 */
export type PdfInjectMode = 'text' | 'ocr' | 'image';

/**
 * 资源注入模式配置
 */
export interface ResourceInjectModes {
  /** 图片注入模式（支持多选） */
  image?: ImageInjectMode[];
  /** PDF 注入模式（支持多选） */
  pdf?: PdfInjectMode[];
}

/**
 * 单个资源引用
 *
 * ★ 只存储引用信息，不存储 path 和 content
 */
export interface VfsResourceRef {
  /** ★ 稳定的业务 ID（note_xxx, tb_xxx, tr_xxx）- 文件移动后不变 */
  sourceId: string;

  /** ★ 资源 hash（标识内容版本） */
  resourceHash: string;

  /** 资源类型 */
  type: VfsResourceType;

  /** 资源名称/标题（注入时的名称，用于显示） */
  name: string;

  /** ★ 用户选择的注入模式（可选，不传则使用默认模式） */
  injectModes?: ResourceInjectModes;
}

/**
 * 上下文引用数据 - 存储在 Chat V2 Resource.data 中
 *
 * ★ 只存储引用信息，不存储 path 和 content
 */
export interface VfsContextRefData {
  /** 资源引用列表（单个资源或文件夹内多个资源） */
  refs: VfsResourceRef[];

  /** 总数量 */
  totalCount: number;

  /** 是否截断（超过 50 个限制） */
  truncated: boolean;
}

/**
 * 多模态内容块（与后端 ContentBlock 对应）
 *
 * @see 25-题目集识别VFS存储与多模态上下文注入改造.md
 */
export interface MultimodalContentBlock {
  type: 'text' | 'image';
  /** 文本内容（type='text' 时） */
  text?: string;
  /** 图片 MIME 类型（type='image' 时） */
  mediaType?: string;
  /** 图片 base64 数据（type='image' 时） */
  base64?: string;
}

/**
 * 解析后的完整资源数据（发送时实时获取）
 */
export interface ResolvedResource {
  /** 稳定的业务 ID */
  sourceId: string;

  /** 资源 hash */
  resourceHash: string;

  /** 资源类型 */
  type: VfsResourceType;

  /** 资源名称/标题 */
  name: string;

  /** ★ 当前路径（实时获取，从 folder_items.cached_path 或计算） */
  path: string;

  /** ★ 内容（实时获取，从 resources.data 或 blob） */
  content?: string;

  /** 字节大小（可选） */
  byteSize?: number;

  /** 是否找到（资源可能已被删除） */
  found: boolean;

  /** 资源解析警告信息（如 PDF 文本提取失败等非致命错误） */
  warning?: string;

  /** 额外元数据（来自领域表） */
  metadata?: Record<string, unknown>;

  /**
   * ★ 多模态内容块（文档25扩展）
   *
   * 对于题目集识别（exam）类型，这里存储图文交替的 ContentBlock[]。
   * ★ 2025-12-10 统一改造：由后端 vfs_resolve_resource_refs 命令统一填充，
   * 前端无需额外调用。
   */
  multimodalBlocks?: MultimodalContentBlock[];
}

// ============================================================================
// 路径增强的文件夹项
// ============================================================================

/**
 * 增强的 folder_items 数据（包含缓存路径）
 */
export interface FolderItemWithPath {
  /** 文件夹项 ID */
  id: string;

  /** 所属文件夹（null = 根级） */
  folderId: string | null;

  /** 资源类型 */
  itemType: VfsResourceType;

  /** 资源 ID（note_xxx, tb_xxx） */
  itemId: string;

  /** 排序顺序 */
  sortOrder: number;

  /** ★ 新增：缓存的完整路径 */
  cachedPath: string | null;

  /** 创建时间戳 */
  createdAt: number;
}

// ============================================================================
// DSTU Node 扩展（兼容现有）
// ============================================================================

/**
 * 扩展的 DstuNode - 新增 sourceId 和 cachedPath
 */
export interface DstuNodeExtended {
  /** 资源 ID */
  id: string;

  /** ★ 优先使用 cachedPath，否则回退到虚拟路径 */
  path: string;

  /** 资源名称 */
  name: string;

  /** 资源类型 */
  type: VfsResourceType;

  /** 资源大小 */
  size?: number;

  /** 创建时间戳 */
  createdAt: number;

  /** 更新时间戳 */
  updatedAt: number;

  /** 预览类型（兼容旧 card，并覆盖新版富文档/音视频类型） */
  previewType?:
    | 'markdown'
    | 'pdf'
    | 'card'
    | 'exam'
    | 'image'
    | 'docx'
    | 'xlsx'
    | 'pptx'
    | 'text'
    | 'audio'
    | 'video'
    | 'mindmap'
    | 'none';

  /** 额外元数据 */
  metadata?: Record<string, unknown>;

  /** ★ 新增：稳定的业务 ID（用于上下文注入引用） */
  sourceId: string;

  /** ★ 新增：关联的 resource_id（用于获取内容） */
  resourceId?: string;

  /** ★ 新增：资源 hash（用于版本标识） */
  resourceHash?: string;
}

// ============================================================================
// 错误码
// ============================================================================

/**
 * VFS 引用模式错误码
 */
export const VFS_REF_ERRORS = {
  RESOURCE_NOT_FOUND: 'VFS_RESOURCE_NOT_FOUND',
  RESOURCE_DELETED: 'VFS_RESOURCE_DELETED',
  PATH_NOT_COMPUTED: 'VFS_PATH_NOT_COMPUTED',
  INJECTION_LIMIT_EXCEEDED: 'VFS_INJECTION_LIMIT_EXCEEDED',
} as const;

// ============================================================================
// 统一类型映射常量（单一数据源 - SSOT）
// ============================================================================

/**
 * ★ 需要实时解析 VFS 引用的资源类型（统一定义）
 *
 * 这些类型的 Resource.data 存储的是 VfsContextRefData（引用信息），
 * 发送前需要调用 vfs_resolve_resource_refs 命令获取实际内容。
 *
 * ★★★ 重要：此数组是前端 VFS 类型的唯一数据源（SSOT）★★★
 * - contextHelper.ts 必须从此处导入
 * - 所有 formatToBlocks 必须强制使用 _resolvedResources
 * - 禁止任何兼容模式/回退逻辑
 *
 * 后端对应：ref_handlers.rs 的 get_source_id_type() 函数
 * ★ 2026-01 添加 mindmap 类型支持
 */
export const VFS_REF_TYPES = [
  'folder',       // fld_xxx - 文件夹（展开内部资源）
  'note',         // note_xxx - 笔记
  'textbook',     // tb_xxx - 教材
  'exam',         // exam_xxx - 题目集识别
  'essay',        // essay_xxx - 作文
  'translation',  // tr_xxx - 翻译
  'image',        // att_xxx (type=image) - 图片附件
  'file',         // att_xxx (type=file) - 文档附件
  'mindmap',      // mm_xxx - 知识导图
] as const;

/**
 * VFS 引用类型（从常量数组派生）
 */
export type VfsRefType = typeof VFS_REF_TYPES[number];

/**
 * 检查资源类型是否需要 VFS 引用解析
 */
export function isVfsRefType(typeId: string): typeId is VfsRefType {
  return VFS_REF_TYPES.includes(typeId as VfsRefType);
}

// ============================================================================
// 常量
// ============================================================================

/**
 * 批量注入最大资源数
 */
export const VFS_MAX_INJECTION_ITEMS = 50;

/**
 * 路径缓存最大长度
 */
export const VFS_MAX_PATH_LENGTH = 1000;

/**
 * 最大路径深度
 */
export const VFS_MAX_PATH_DEPTH = 10;

// ============================================================================
// 类型守卫
// ============================================================================

/**
 * 检查是否为有效的 VFS 资源类型
 * @deprecated 使用 isVfsRefType 替代
 * ★ 2026-01 添加 mindmap 类型支持
 */
export function isVfsResourceType(type: string): type is VfsResourceType {
  return ['note', 'textbook', 'exam', 'translation', 'essay', 'image', 'file', 'retrieval', 'mindmap'].includes(type);
}

/**
 * 检查是否为 VfsContextRefData 结构
 */
export function isVfsContextRefData(data: unknown): data is VfsContextRefData {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return (
    Array.isArray(obj.refs) &&
    typeof obj.totalCount === 'number' &&
    typeof obj.truncated === 'boolean'
  );
}

/**
 * 检查是否为 VfsResourceRef 结构
 */
export function isVfsResourceRef(ref: unknown): ref is VfsResourceRef {
  if (!ref || typeof ref !== 'object') return false;
  const obj = ref as Record<string, unknown>;
  return (
    typeof obj.sourceId === 'string' &&
    typeof obj.resourceHash === 'string' &&
    typeof obj.type === 'string' &&
    typeof obj.name === 'string'
  );
}
