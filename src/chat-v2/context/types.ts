/**
 * Chat V2 - 统一上下文注入系统 - 类型定义
 *
 * 遵循文档16：统一上下文注入系统架构设计
 * 扩展支持文档24：VFS 引用模式上下文注入
 *
 * 核心概念：
 * - Resource: 资源实体，存储实际内容，基于 hash 去重
 * - ContextRef: 上下文引用，只包含 resourceId + hash + typeId
 * - SendContextRef: 发送时的引用，包含 formattedBlocks
 * - ContextTypeDefinition: 类型定义，包含 formatToBlocks 方法
 */

// 导入 VFS 引用模式类型（避免重复定义）
import type {
  ResolvedResource,
  VfsResourceType,
  VfsContextRefData,
  VfsResourceRef,
  FolderItemWithPath,
  DstuNodeExtended,
  ResourceInjectModes,
} from './vfsRefTypes';

// 重导出 VFS 类型供使用者方便访问
export type {
  ResolvedResource,
  VfsResourceType,
  VfsContextRefData,
  VfsResourceRef,
  FolderItemWithPath,
  DstuNodeExtended,
} from './vfsRefTypes';

// ============================================================================
// 资源类型
// ============================================================================

/**
 * 资源类型枚举
 * 对应后端 ResourceType 枚举
 *
 * | type        | 优先级 | 描述        |
 * |-------------|--------|-------------|
 * | note        | 10     | 笔记快照    |
 * | card        | 20     | 题目卡片快照 |
 * | exam        | 22     | 题目集识别 ★  |
 * | essay       | 23     | 作文批改 ★  |
 * | textbook    | 25     | 教材 ★      |
 * | image       | 30     | 图片        |
 * | file        | 30     | 文件附件    |
 * | retrieval   | 50     | 检索结果    |
 * | folder      | 100    | 文件夹 ★    |
 * | translation | -      | 翻译        |
 */
export type ResourceType = 'image' | 'file' | 'note' | 'card' | 'exam' | 'essay' | 'textbook' | 'retrieval' | 'folder' | 'translation';

/**
 * 资源元数据
 */
export interface ResourceMetadata {
  /** 资源名称 */
  name?: string;
  /** MIME 类型 */
  mimeType?: string;
  /** 文件大小（字节） */
  size?: number;
  /** 标题 */
  title?: string;
  /** 额外元数据 */
  [key: string]: unknown;
}

/**
 * 资源实体（存储在资源库中）
 * 对应后端 Resource 结构
 */
export interface Resource {
  /** 资源 ID (res_{nanoid(10)}) */
  id: string;

  /** 内容哈希（唯一标识版本，用于去重） */
  hash: string;

  /** 资源类型 */
  type: ResourceType;

  /** 原始数据 ID（noteId, cardId 等，用于跳转定位） */
  sourceId?: string;

  /** 实际内容（文本或 base64 编码的二进制） */
  data: string;

  /** 元数据 */
  metadata?: ResourceMetadata;

  /** 引用计数 */
  refCount: number;

  /** 创建时间戳（毫秒） */
  createdAt: number;

  /**
   * ★ 解析后的 VFS 引用数据（发送时填充，非持久化）
   * 
   * 仅在发送前由 resolveVfsRefs 函数填充，用于 VFS 类型资源的实时内容获取。
   * 格式化时使用此字段而非 data 字段中的引用信息。
   */
  _resolvedResources?: ResolvedResource[];
}

/**
 * 创建资源的参数
 */
export interface CreateResourceParams {
  /** 资源类型 */
  type: ResourceType;
  /** 实际内容 */
  data: string;
  /** 原始数据 ID */
  sourceId?: string;
  /** 元数据 */
  metadata?: ResourceMetadata;
}

/**
 * 创建资源的结果
 */
export interface CreateResourceResult {
  /** 资源 ID */
  resourceId: string;
  /** 内容哈希 */
  hash: string;
  /** 是否新创建（false 表示复用已有） */
  isNew: boolean;
}

// ============================================================================
// 上下文引用
// ============================================================================

/**
 * 上下文引用（消息中只存这个，不存实际内容）
 * 对应后端 ContextRef 结构
 */
export interface ContextRef {
  /** 资源 ID */
  resourceId: string;

  /** 内容哈希（精确定位版本） */
  hash: string;

  /** 类型 ID（用于获取格式化方法） */
  typeId: string;

  /**
   * ★ 是否为持久引用（sticky）
   *
   * - true: 持久引用，发送消息后不会被清空（如技能）
   * - false/undefined: 一次性引用，发送后清空（如附件、临时上下文）
   *
   * 设计原则：skill 等需要持续生效的上下文设置为 sticky，
   * 用户主动取消激活或切换会话时才清除。
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
 * 上下文快照（只存引用）
 * 存储在 Message._meta.contextSnapshot
 */
export interface ContextSnapshot {
  /** 用户提供的上下文引用 */
  userRefs: ContextRef[];

  /** 系统检索的上下文引用 */
  retrievalRefs: ContextRef[];

  /**
   * ★ 文档28改造：资源路径映射
   * 
   * 存储 resourceId -> 真实路径 的映射，用于 UI 显示。
   * 旧消息可能没有此字段（向后兼容）。
   */
  pathMap?: Record<string, string>;
}

// ============================================================================
// 内容块
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
  /** MIME 类型，如 'image/png', 'image/jpeg' */
  mediaType: string;
  /** Base64 编码的图片数据 */
  base64: string;
}

/**
 * 内容块（兼容 OpenAI/Anthropic/Gemini）
 */
export type ContentBlock = TextContentBlock | ImageContentBlock;

// ============================================================================
// 发送时的上下文引用
// ============================================================================

/**
 * 发送时的上下文引用（含格式化内容）
 * 发送时构建，后端直接使用 formattedBlocks
 */
export interface SendContextRef extends ContextRef {
  /** 格式化后的内容块（发送时填充，后端直接使用） */
  formattedBlocks: ContentBlock[];
}

// ============================================================================
// 格式化选项（文档25：多模态上下文注入）
// ============================================================================

/**
 * 格式化选项
 * 用于传递模型能力等上下文信息到 formatToBlocks
 *
 * @see 25-题目集识别VFS存储与多模态上下文注入改造.md
 */
export interface FormatOptions {
  /**
   * 模型是否支持多模态（图片输入）
   * 
   * ★ 取自 ApiConfig.is_multimodal，不要使用 inferCapabilities 推断
   */
  isMultimodal?: boolean;

  /**
   * ★ 用户选择的注入模式
   * 
   * 用于图片和 PDF 附件的注入模式选择：
   * - image.image: 注入原始图片（需多模态模型）
   * - image.ocr: 注入 OCR 文本
   * - pdf.text: 注入解析文本
   * - pdf.ocr: 注入页面 OCR 文本
   * - pdf.image: 注入页面图片（需多模态模型）
   */
  injectModes?: import('./vfsRefTypes').ResourceInjectModes;
}

// ============================================================================
// 上下文类型定义
// ============================================================================

/**
 * 上下文类型定义
 * 用于注册表，定义如何格式化资源
 */
export interface ContextTypeDefinition {
  /** 类型 ID（唯一） */
  typeId: string;

  /** XML 标签名（用于包裹内容） */
  xmlTag: string;

  /** 中文标签 */
  label: string;

  /** 英文标签 */
  labelEn: string;

  /** 关联的工具 ID 列表 */
  tools?: string[];

  /** 优先级（越小越靠前，默认 100） */
  priority?: number;

  /**
   * System Prompt 中的标签格式说明
   * 用于告知 LLM 用户消息中该标签的含义和用途
   * 示例：'<canvas_note title="..." note-id="...">笔记内容</canvas_note> - 用户当前打开的 Canvas 笔记'
   */
  systemPromptHint?: string;

  /**
   * 格式化资源为 ContentBlock[]
   * 组装 Prompt 时调用
   * 
   * ★ 文档25扩展：支持 options 参数传递模型能力
   * 
   * @param resource 资源实体
   * @param options 格式化选项（可选，包含 isMultimodal 等）
   * @returns 格式化后的内容块数组
   */
  formatToBlocks: (resource: Resource, options?: FormatOptions) => ContentBlock[];
}

// ============================================================================
// 类型守卫
// ============================================================================

/**
 * 判断是否为文本内容块
 */
export function isTextContentBlock(block: ContentBlock): block is TextContentBlock {
  return block.type === 'text';
}

/**
 * 判断是否为图片内容块
 */
export function isImageContentBlock(block: ContentBlock): block is ImageContentBlock {
  return block.type === 'image';
}

/**
 * 判断是否为有效的资源类型
 */
export function isValidResourceType(type: string): type is ResourceType {
  return ['image', 'file', 'note', 'card', 'exam', 'essay', 'textbook', 'retrieval', 'folder', 'translation'].includes(type);
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 创建文本内容块
 */
export function createTextBlock(text: string): TextContentBlock {
  return { type: 'text', text };
}

/**
 * 创建图片内容块
 */
export function createImageBlock(mediaType: string, base64: string): ImageContentBlock {
  return { type: 'image', mediaType, base64 };
}

/**
 * 创建 XML 包裹的文本块
 * @param tag XML 标签名
 * @param content 内容
 * @param attrs 可选的属性
 */
export function createXmlTextBlock(
  tag: string,
  content: string,
  attrs?: Record<string, string | undefined>
): TextContentBlock {
  const attrStr = attrs
    ? Object.entries(attrs)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => ` ${k}="${escapeXmlAttr(v!)}"`)
        .join('')
    : '';

  return createTextBlock(`<${tag}${attrStr}>\n${content}\n</${tag}>`);
}

/**
 * 转义 XML 属性值
 */
function escapeXmlAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 创建空的上下文快照
 */
export function createEmptyContextSnapshot(): ContextSnapshot {
  return {
    userRefs: [],
    retrievalRefs: [],
  };
}

/**
 * 合并上下文快照
 */
export function mergeContextSnapshots(
  base: ContextSnapshot,
  override: Partial<ContextSnapshot>
): ContextSnapshot {
  return {
    userRefs: override.userRefs ?? base.userRefs,
    retrievalRefs: override.retrievalRefs ?? base.retrievalRefs,
  };
}

// ============================================================================
// VFS 引用模式类型守卫（使用从 vfsRefTypes 导入的类型）
// ============================================================================

/**
 * 判断是否为有效的 VFS 资源类型
 */
export function isValidVfsResourceType(type: string): type is VfsResourceType {
  return ['note', 'textbook', 'exam', 'translation', 'essay', 'image', 'file'].includes(type);
}

/**
 * 创建空的 VFS 上下文引用数据
 */
export function createEmptyVfsContextRefData(): VfsContextRefData {
  return {
    refs: [],
    totalCount: 0,
    truncated: false,
  };
}
