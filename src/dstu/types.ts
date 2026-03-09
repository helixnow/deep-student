/**
 * DSTU 访达协议层类型定义
 *
 * DSTU (DS-Tauri-Unified) 是 VFS 虚拟文件系统与上层应用之间的统一访问接口，
 * 类似于操作系统的文件管理器协议。
 *
 * 数据契约来源：21-VFS虚拟文件系统架构设计.md 第四章 4.2
 */

// ============================================================================
// 核心类型
// ============================================================================

/**
 * DSTU 资源节点类型
 *
 * 对应后端 DstuNodeType 枚举
 *
 * 类型说明：
 * - folder: 文件夹
 * - note: 笔记
 * - textbook: 教材
 * - exam: 题目集
 * - translation: 翻译
 * - essay: 作文
 * - image: 图片
 * - file: 文件/附件
 * - retrieval: 检索结果（RAG 知识库检索）
 */
export type DstuNodeType =
  | 'folder'
  | 'note'
  | 'textbook'
  | 'exam'
  | 'translation'
  | 'essay'
  | 'image'
  | 'file'
  | 'mindmap'
  | 'retrieval';

/**
 * 预览类型
 *
 * 决定 Learning Hub 中的预览面板如何渲染该资源
 */
export type DstuPreviewType =
  | 'markdown'
  | 'pdf'
  | 'card'
  | 'exam'
  | 'image'
  | 'audio'
  | 'video'
  | 'mindmap'
  | 'none'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'text';

/**
 * DSTU 资源节点
 *
 * 统一的资源描述结构，无论底层是笔记、教材还是题目集
 */
export interface DstuNode {
  /** 资源 ID，格式如 note_abc123, tb_xyz789 */
  id: string;

  /**
   * 完整路径
   *
   * 27-DSTU统一虚拟路径架构改造：
   * - 文件夹优先模式下返回文件夹层级路径，如 "/高考复习/函数/note_abc123"
   * - 根目录资源返回 "/note_abc123"
   * - 文件夹节点的 path 为其完整层级路径，如 "/高考复习/函数"
   */
  path: string;

  /** 显示名称 */
  name: string;

  /** 节点类型 */
  type: DstuNodeType;

  // ========== 元数据 ==========

  /** 内容大小（字节） */
  size?: number;

  /** 创建时间（Unix 毫秒） */
  createdAt: number;

  /** 更新时间（Unix 毫秒） */
  updatedAt: number;

  // ========== 文件夹特有 ==========

  /** 子节点（仅文件夹类型） */
  children?: DstuNode[];

  /** 子节点数量（懒加载时使用） */
  childCount?: number;

  // ========== 资源特有 ==========

  /** VFS resources 表的 ID */
  resourceId?: string;

  /** 稳定的业务 ID（与 id 相同，但语义明确，用于引用模式） */
  sourceId: string;

  /** 资源内容 hash（用于校验引用有效性，资源未同步时可为空） */
  resourceHash?: string;

  /** 预览类型，决定预览面板渲染方式 */
  previewType?: DstuPreviewType;

  /** 扩展元数据（类型特定的额外信息） */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// 操作选项
// ============================================================================

/**
 * DSTU 列表选项
 *
 * 用于 dstu.list() 和 dstu.search() 的查询参数
 * 
 * ## 文件夹优先模型（27-DSTU统一虚拟路径架构改造设计.md）
 * - `folderId`: 指定文件夹 ID，列出该文件夹下的所有资源（混合类型）
 * - `typeFilter`: 按类型筛选（智能文件夹），返回的资源路径仍是文件夹路径
 * 
 * ## 兼容模式
 * - 若 `folderId` 和 `typeFilter` 都未指定，走原有的类型路径逻辑
 */
export interface DstuListOptions {
  // ========== 文件夹优先模型字段 ==========

  /** 文件夹 ID（文件夹导航模式）
   * 指定后列出该文件夹下的所有资源（混合类型：笔记+翻译+图片等）
   */
  folderId?: string;

  /** 类型筛选（智能文件夹模式）
   * 按类型筛选资源，但返回的 path 仍是文件夹路径
   */
  typeFilter?: DstuNodeType;

  /** ★ 收藏筛选 - 仅返回已收藏的资源 */
  isFavorite?: boolean;

  // ========== 原有字段 ==========

  /** 是否递归列出子目录 */
  recursive?: boolean;

  /** 过滤类型（旧版，保留兼容） */
  types?: DstuNodeType[];

  /** 搜索关键词 */
  search?: string;

  /** 标签过滤（仅笔记类资源） */
  tags?: string[];

  /** 排序字段 */
  sortBy?: 'name' | 'createdAt' | 'updatedAt';

  /** 排序方向 */
  sortOrder?: 'asc' | 'desc';

  /** 分页：数量限制 */
  limit?: number;

  /** 分页：偏移量 */
  offset?: number;
}

/**
 * DSTU 创建选项
 *
 * 用于 dstu.create() 创建新资源
 */
export interface DstuCreateOptions {
  /** 资源类型 */
  type: DstuNodeType;

  /** 资源名称 */
  name: string;

  /** 内容（笔记等文本资源） */
  content?: string;

  /** 文件（教材等二进制资源） */
  file?: File | Blob;

  /** 扩展元数据 */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// 事件类型
// ============================================================================

/**
 * DSTU 监听事件类型
 *
 * ★ P1-009: 添加 'restored' 和 'purged' 事件类型
 * - restored: 资源从回收站恢复
 * - purged: 资源被永久删除
 */
export type DstuWatchEventType = 'created' | 'updated' | 'deleted' | 'moved' | 'restored' | 'purged';

/**
 * DSTU 监听事件
 *
 * 用于 dstu.watch() 监听资源变化
 */
export interface DstuWatchEvent {
  /** 事件类型 */
  type: DstuWatchEventType;

  /** 资源路径 */
  path: string;

  /** 资源节点（删除事件可能为空） */
  node?: DstuNode;

  /** 移动事件的旧路径 */
  oldPath?: string;
}

// ============================================================================
// API 接口
// ============================================================================

/**
 * DSTU API 接口
 *
 * 统一的资源访问接口，类似文件系统 API
 *
 * 约束：
 * 1. 所有方法返回 Promise
 * 2. 路径格式：/{type}/{id} 或 /{resource_id}
 */
export interface DstuApi {
  // ========== 基础文件系统操作 ==========

  /**
   * 列出目录内容
   * @param path 路径，使用 '/' 并通过 options.typeFilter 筛选类型
   * @param options 列表选项（typeFilter, folderId 等）
   * @returns 资源节点数组
   */
  list(path: string, options?: DstuListOptions): Promise<DstuNode[]>;

  /**
   * 获取资源详情
   * @param path 资源路径，如 '/note_123' 或 '/高考复习/note_123'
   * @returns 资源节点，不存在返回 null
   */
  get(path: string): Promise<DstuNode | null>;

  /**
   * 创建资源
   * @param path 父目录路径，使用 '/' 表示根目录
   * @param options 创建选项（包含 type 字段指定资源类型）
   * @returns 新创建的资源节点
   */
  create(path: string, options: DstuCreateOptions): Promise<DstuNode>;

  /**
   * 更新资源内容
   * @param path 资源路径
   * @param content 新内容
   * @param resourceType 资源类型（如 "note"、"textbook" 等）
   * @returns 更新后的资源节点
   */
  update(path: string, content: string, resourceType: string): Promise<DstuNode>;

  /**
   * 删除资源
   * @param path 资源路径
   */
  delete(path: string): Promise<void>;

  /**
   * 移动资源（跨科目移动）
   * @param srcPath 源路径
   * @param dstPath 目标路径
   * @returns 移动后的资源节点
   */
  move(srcPath: string, dstPath: string): Promise<DstuNode>;

  /**
   * 重命名资源（更新显示名称/标题）
   * @param path 资源路径
   * @param newName 新名称
   * @returns 重命名后的资源节点
   */
  rename(path: string, newName: string): Promise<DstuNode>;

  /**
   * 复制资源
   * @param srcPath 源路径
   * @param dstPath 目标路径
   * @returns 复制后的新资源节点
   */
  copy(srcPath: string, dstPath: string): Promise<DstuNode>;

  // ========== 高级操作 ==========

  /**
   * 搜索资源
   * @param query 搜索关键词
   * @param options 搜索选项
   * @returns 匹配的资源节点数组
   */
  search(query: string, options?: DstuListOptions): Promise<DstuNode[]>;

  /**
   * 获取资源内容
   * @param path 资源路径
   * @returns 文本内容或二进制 Blob
   */
  getContent(path: string): Promise<string | Blob>;

  /**
   * 设置资源元数据
   * @param path 资源路径
   * @param metadata 元数据对象
   */
  setMetadata(path: string, metadata: Record<string, unknown>): Promise<void>;

  /**
   * 设置收藏状态
   * @param path 资源路径
   * @param isFavorite 是否收藏
   */
  setFavorite(path: string, isFavorite: boolean): Promise<void>;

  /**
   * 监听资源变化
   * @param path 监听路径（可以是目录）
   * @param callback 事件回调
   * @returns 取消监听函数
   */
  watch(path: string, callback: (event: DstuWatchEvent) => void): () => void;

  // ========== 回收站操作 ==========

  /**
   * 列出已删除的资源
   * @param resourceType 资源类型
   * @param limit 返回数量限制
   * @param offset 分页偏移
   */
  listDeleted(
    resourceType: string,
    limit?: number,
    offset?: number
  ): Promise<DstuNode[]>;

  /**
   * 恢复已删除的资源
   * @param path 资源路径
   */
  restore(path: string): Promise<DstuNode>;

  /**
   * 永久删除资源
   * @param path 资源路径
   */
  purge(path: string): Promise<void>;

  /**
   * 清空回收站
   * @param resourceType 资源类型
   */
  purgeAll(resourceType: string): Promise<number>;

  // ========== 批量操作 ==========

  /**
   * 批量删除资源（移到回收站）
   * @param paths 资源路径数组
   * @returns 成功删除的数量
   */
  deleteMany(paths: string[]): Promise<number>;

  /**
   * 批量恢复已删除的资源
   * @param paths 资源路径数组
   * @returns 成功恢复的数量
   */
  restoreMany(paths: string[]): Promise<number>;

  /**
   * 批量移动资源
   * @param paths 源路径数组
   * @param destFolder 目标文件夹路径
   * @returns 成功移动的数量
   */
  moveMany(paths: string[], destFolder: string): Promise<number>;

  /**
   * 在文件夹内搜索
   * @param folderId VFS 文件夹 ID（null 表示根目录/全局搜索）
   * @param query 搜索关键词
   * @param options 搜索选项
   * @returns 匹配的资源节点数组
   */
  searchInFolder(
    folderId: string | null,
    query: string,
    options?: DstuListOptions
  ): Promise<DstuNode[]>;
}

// ============================================================================
// 空资源模板
// ============================================================================

/**
 * 空资源模板接口
 *
 * 定义各资源类型创建空文件时的默认状态
 */
export interface DstuEmptyResourceTemplate {
  /** 默认名称 */
  defaultName: string;
  /** 默认内容（文本资源） */
  content?: string;
  /** 默认元数据 */
  metadata?: Record<string, unknown>;
  /** 预览类型 */
  previewType?: DstuPreviewType;
}

/**
 * 各资源类型的空文件模板
 *
 * 新建资源时使用这些默认值
 */
export const EMPTY_RESOURCE_TEMPLATES: Record<
  Exclude<DstuNodeType, 'folder' | 'file' | 'image'>,
  DstuEmptyResourceTemplate
> = {
  note: {
    defaultName: '无标题笔记',
    content: '',
    metadata: { tags: [] },
    previewType: 'markdown',
  },
  textbook: {
    defaultName: '新教材',
    metadata: {},
    previewType: 'pdf',
  },
  exam: {
    defaultName: '新题目集',
    metadata: { status: 'empty', pageCount: 0, questionCount: 0 },
    previewType: 'exam',
  },
  translation: {
    defaultName: '新翻译',
    metadata: {
      sourceText: '',
      translatedText: '',
      srcLang: 'en',
      tgtLang: 'zh',
      formality: 'auto',
    },
    previewType: 'markdown',
  },
  essay: {
    defaultName: '新作文',
    metadata: {
      essayType: '',
      gradeLevel: '',
      inputText: '',
      totalRounds: 0,
    },
    previewType: 'markdown',
  },
  mindmap: {
    defaultName: '新思维导图',
    content: JSON.stringify({
      version: '1.0',
      root: {
        id: 'root',
        text: '中心主题',
        children: []
      },
      meta: {
        createdAt: new Date().toISOString()
      }
    }),
    metadata: { theme: 'default', defaultView: 'mindmap' },
    previewType: 'mindmap',
  },
  retrieval: {
    defaultName: '检索结果',
    content: '',
    metadata: { type: 'rag_result', query: '' },
    previewType: 'markdown',
  },
};

// ============================================================================
// 辅助类型
// ============================================================================

/**
 * 路径解析结果
 *
 * 用于解析 DSTU 路径格式
 */
export interface ParsedDstuPath {
  /** 资源类型 */
  resourceType: DstuNodeType | null;

  /** 资源 ID */
  id: string | null;
}

/**
 * DSTU 错误类型
 */
export interface DstuError extends Error {
  /** 错误代码 */
  code: 'NOT_FOUND' | 'INVALID_PATH' | 'PERMISSION_DENIED' | 'CONFLICT' | 'INTERNAL';

  /** 相关路径 */
  path?: string;
}

/**
 * 创建 DSTU 错误
 */
export function createDstuError(
  code: DstuError['code'],
  message: string,
  path?: string
): DstuError {
  const error = new Error(message) as DstuError;
  error.code = code;
  error.path = path;
  error.name = 'DstuError';
  return error;
}
