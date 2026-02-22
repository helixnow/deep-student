/**
 * Chat V2 - 资源库类型定义
 *
 * 与后端 resource_types.rs 对齐，遵循文档 16/24 数据契约。
 *
 * 核心概念：
 * - Resource: 资源实体，存储实际内容，基于 hash 去重
 * - ContextRef: 上下文引用，只包含 resourceId + hash + typeId
 * - SendContextRef: 发送时的引用，包含 formattedBlocks
 *
 * 文档 24 扩展（引用模式）：
 * - VfsContextRefData: 存储在 Resource.data 中的引用数据
 * - _resolvedResources: 发送时实时解析的资源列表
 */

import type { ResolvedResource } from '../context/types';
import type { ResourceInjectModes } from '../context/vfsRefTypes';

// ============================================================================
// 资源类型枚举
// ============================================================================

/**
 * 资源类型
 *
 * | type        | 对应 typeId   | 优先级 | 描述          |
 * |-------------|--------------|--------|---------------|
 * | note        | note         | 10     | 笔记快照      |
 * | card        | card         | 20     | 题目卡片快照  |
 * | exam        | exam         | 22     | 题目集识别 ★   |
 * | essay       | essay        | 23     | 作文 ★       |
 * | translation | translation  | 24     | 翻译 ★       |
 * | textbook    | textbook     | 25     | 教材 ★       |
 * | image       | image        | 30     | 图片          |
 * | file        | file         | 30     | 文件附件      |
 * | retrieval   | retrieval    | 50     | 检索结果      |
 * | folder      | folder       | 100    | 文件夹 ★     |
 */
export type ResourceType = 'image' | 'file' | 'note' | 'card' | 'exam' | 'essay' | 'translation' | 'textbook' | 'retrieval' | 'folder';

// ============================================================================
// 内容块类型（兼容 OpenAI/Anthropic/Gemini）
// ============================================================================

/**
 * 文本内容块
 */
export interface TextContentBlock {
  type: 'text';
  text: string;
}

/**
 * 图片内容块
 */
export interface ImageContentBlock {
  type: 'image';
  mediaType: string;
  base64: string;
}

/**
 * 内容块（用于格式化输出）
 */
export type ContentBlock = TextContentBlock | ImageContentBlock;

// ============================================================================
// 资源实体
// ============================================================================

/**
 * 资源元数据
 */
export interface ResourceMetadata {
  /** 资源名称（文件名、笔记标题等） */
  name?: string;
  /** MIME 类型 */
  mimeType?: string;
  /** 资源大小（字节） */
  size?: number;
  /** 标题（笔记、卡片等） */
  title?: string;
  /** 检索来源（rag/memory/graph/web） */
  source?: string;
  /** 其他扩展字段 */
  [key: string]: unknown;
}

/**
 * 资源实体（存储在资源库中）
 *
 * 遵循文档 16 第三章 3.1 数据契约
 * 扩展支持文档 24 VFS 引用模式
 */
export interface Resource {
  /** 资源 ID（格式：res_{nanoid(10)}） */
  id: string;

  /** 内容哈希（SHA-256，唯一标识版本，用于去重） */
  hash: string;

  /** 资源类型 */
  type: ResourceType;

  /** 原始数据 ID（noteId, cardId 等，用于跳转定位） */
  sourceId?: string;

  /** 实际内容（Base64 编码的二进制或纯文本字符串） */
  data: string;

  /** 元数据 */
  metadata?: ResourceMetadata;

  /** 引用计数 */
  refCount: number;

  /** 创建时间戳（毫秒） */
  createdAt: number;

  /**
   * ★ VFS 引用模式：解析后的资源数据（发送时填充，非持久化）
   *
   * 当资源类型为 folder/note/textbook/exam/essay 等 VFS 类型时，
   * data 中存储的是 VfsContextRefData（只有 sourceId + hash 引用）。
   * 发送前调用 vfs_resolve_resource_refs 实时解析，填充此字段。
   *
   * @see VfsContextRefData
   * @see ResolvedResource
   */
  _resolvedResources?: ResolvedResource[];
}

// ============================================================================
// 上下文引用
// ============================================================================

/**
 * 上下文引用（消息中只存这个，不存实际内容）
 *
 * 遵循文档 16 第三章 3.2 数据契约
 */
export interface ContextRef {
  /** 资源 ID */
  resourceId: string;

  /** 内容哈希（精确定位版本） */
  hash: string;

  /** 类型 ID（用于获取格式化方法） */
  typeId: string;

  /**
   * ★ P0-01 扩展：是否为持久引用
   *
   * - true: 持久引用（如激活的技能），发送消息后不清除
   * - false/undefined: 一次性引用（如附件），发送后清除
   */
  isSticky?: boolean;

  /**
   * 显示名称（可选）
   *
   * 用于 UI 显示，如技能名称、笔记标题等
   * 如果未提供，UI 会使用 typeId 作为显示标签
   */
  displayName?: string;

  /**
   * 技能 ID（可选）
   *
   * 仅当 typeId 为 'skill_instruction' 时使用
   * 用于同步更新 activeSkillIds，避免异步查找
   */
  skillId?: string;

  /**
   * 是否为自动加载的引用（可选）
   *
   * - true: 由系统自动加载（默认技能、会话恢复等），不在输入栏显示气泡
   * - false/undefined: 用户手动添加，在输入栏显示气泡
   */
  autoLoaded?: boolean;

  /**
   * ★ 注入模式配置（可选）
   *
   * 用于图片和 PDF 附件的注入模式选择：
   * - image: 图片模式（'image', 'ocr'）
   * - pdf: PDF 模式（'text', 'ocr', 'image'）
   *
   * 如果未设置，使用默认行为（根据模型是否支持多模态决定）
   */
  injectModes?: ResourceInjectModes;
}

/**
 * 发送时的上下文引用（含格式化内容）
 *
 * 消息持久化只存 ContextRef，不存 formattedBlocks
 */
export interface SendContextRef extends ContextRef {
  /** 格式化后的内容块（发送时填充，后端直接使用） */
  formattedBlocks: ContentBlock[];
}

/**
 * 上下文快照（只存引用）
 *
 * 存储在 Message._meta.contextSnapshot 中
 */
export interface ContextSnapshot {
  /** 用户提供的上下文引用 */
  userRefs: ContextRef[];

  /** 系统检索的上下文引用 */
  retrievalRefs: ContextRef[];
}

// ============================================================================
// API 参数和返回类型
// ============================================================================

/**
 * 创建资源参数
 */
export interface CreateResourceParams {
  /** 资源类型 */
  type: ResourceType;

  /** 实际内容（字符串或 ArrayBuffer） */
  data: string | ArrayBuffer;

  /** 原始数据 ID（可选，用于跳转定位） */
  sourceId?: string;

  /** 元数据（可选） */
  metadata?: ResourceMetadata;
}

/**
 * 创建资源结果
 *
 * 遵循文档 16 第五章 5.2 核心接口
 */
export interface CreateResourceResult {
  /** 资源 ID */
  resourceId: string;

  /** 内容哈希 */
  hash: string;

  /** 是否为新创建（false 表示复用已有资源） */
  isNew: boolean;
}

// ============================================================================
// 大文件限制常量
// ============================================================================

/**
 * 图片大小限制（10MB）
 */
export const IMAGE_SIZE_LIMIT = 10 * 1024 * 1024;

/**
 * 文件大小限制（50MB）
 */
export const FILE_SIZE_LIMIT = 50 * 1024 * 1024;

// ============================================================================
// 资源库 API 接口
// ============================================================================

/**
 * 资源库 API 接口
 *
 * 遵循文档 16 第五章 5.2 核心接口
 */
export interface ResourceStoreApi {
  /**
   * 创建或复用资源（基于哈希去重）
   *
   * @param params 创建参数
   * @returns 资源 ID 和哈希，以及是否为新创建
   */
  createOrReuse(params: CreateResourceParams): Promise<CreateResourceResult>;

  /**
   * 通过 ID + hash 获取资源（精确版本）
   *
   * @param resourceId 资源 ID
   * @param hash 内容哈希
   * @returns 资源实体或 null
   */
  get(resourceId: string, hash: string): Promise<Resource | null>;

  /**
   * 获取资源的最新版本（用于版本失效时回退）
   *
   * @param resourceId 资源 ID
   * @returns 最新版本的资源实体或 null
   */
  getLatest(resourceId: string): Promise<Resource | null>;

  /**
   * 检查资源是否存在
   *
   * @param resourceId 资源 ID
   * @returns 是否存在
   */
  exists(resourceId: string): Promise<boolean>;

  /**
   * 增加引用计数（消息保存时调用）
   *
   * @param resourceId 资源 ID
   */
  incrementRef(resourceId: string): Promise<void>;

  /**
   * 减少引用计数（消息删除时调用）
   *
   * @param resourceId 资源 ID
   */
  decrementRef(resourceId: string): Promise<void>;

  /**
   * 获取某原始数据的所有版本
   *
   * @param sourceId 原始数据 ID（noteId, cardId 等）
   * @returns 资源版本列表
   */
  getVersionsBySource(sourceId: string): Promise<Resource[]>;
}
