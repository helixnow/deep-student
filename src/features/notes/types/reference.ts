/**
 * 学习资源管理器 - 引用节点类型定义
 *
 * 根据文档18《统一学习资源管理器架构设计》第四章"数据契约"定义
 *
 * 核心概念：
 * - ReferenceNode: 引用节点，作为"快捷方式"指向其他数据库中的资源
 * - 引用不存内容，只存元信息，实际内容保留在原生数据库
 */

import { nanoid } from 'nanoid';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 引用节点支持的来源数据库（窄集合）
 *
 * 这是「引用节点 UI」（侧栏引用、图标、显示名等）当前支持的来源集合，
 * 由 reference.test.ts 合同锁定：`isValidSourceDatabase('notes')` 必须为 false。
 *
 * | 值              | 实际数据库              | 数据类型       |
 * |-----------------|------------------------|----------------|
 * | 'textbooks'     | textbooks.db           | Textbook       |
 * | 'chat_v2'       | chat_v2.db             | Resource       |
 * | 'exam_sessions' | app.exam_sheet_sessions| ExamSession ★  |
 *
 * 如需 DSTU 全量支持面（含 notes/translations/essays 等），
 * 使用 {@link ExtendedSourceDatabase}。
 */
export const SOURCE_DATABASES = ['textbooks', 'chat_v2', 'exam_sessions'] as const;

export type SourceDatabase = (typeof SOURCE_DATABASES)[number];

/**
 * DSTU 层可寻址的来源数据库全量集合（宽集合）
 *
 * `SourceDatabase` 的超集。learningHubApi（DSTU 内容获取封装）按此集合工作：
 * 后端 dstu_get / dstu_get_content 按资源 ID 前缀全局寻址，任何这些库的
 * 资源都可以通过 `/${sourceId}` 取到。
 *
 * 历史说明（B8 修复，2026-07）：此前 learningHubApi.ts 与本文件各自维护一套
 * `SourceDatabase` 并已漂移。现统一以本文件为单一来源，learningHubApi 从这里
 * re-export，既有 `import { SourceDatabase } from '../learningHubApi'` 不受影响。
 */
export const EXTENDED_SOURCE_DATABASES = [
  'notes',
  'textbooks',
  'chat_v2',
  'exam_sessions',
  'translations',
  'essays',
  'attachments',
  'mindmaps',
] as const;

export type ExtendedSourceDatabase = (typeof EXTENDED_SOURCE_DATABASES)[number];

/**
 * 预览类型
 *
 * | 类型      | 渲染方式          | 说明                |
 * |-----------|-------------------|---------------------|
 * | markdown  | Markdown 渲染     | 笔记、文本内容      |
 * | pdf       | PDF 预览          | 教材、PDF 文档      |
 * | image     | 图片预览          | 图片附件            |
 * | exam      | 题目集预览        | 题目集识别结果      |
 * | docx      | Word 文档预览     | DOCX 文件           |
 * | xlsx      | Excel 表格预览    | XLSX/XLS/ODS 文件   |
 * | pptx      | PPT 演示预览      | PPTX 文件           |
 * | epub      | EPUB 阅读器        | EPUB 电子书          |
 * | text      | 纯文本预览        | TXT/MD/HTML 等      |
 * | audio     | 音频预览          | MP3/WAV/OGG 等      |
 * | video     | 视频预览          | MP4/WEBM/MOV 等     |
 * | mindmap   | 知识导图预览      | 知识导图            |
 * | none      | 不支持预览        | 其他类型文件        |
 *
 * ★ 2026-01 清理：移除 'card' 类型（错题系统废弃）
 * ★ 2026-01 添加：docx/xlsx/pptx/text 类型，与后端 DstuPreviewType 对齐
 * ★ 2026-01 添加：audio/video 类型，支持音视频预览
 */
export const PREVIEW_TYPES = [
  'markdown',
  'pdf',
  'image',
  'exam',
  'docx',
  'xlsx',
  'pptx',
  'epub',
  'text',
  'audio',
  'video',
  'mindmap',
  'none',
] as const;

export type PreviewType = (typeof PREVIEW_TYPES)[number];

/**
 * 引用节点
 *
 * 存储在 FolderStructure.references 中，作为"快捷方式"指向原生数据
 * - 删除引用只移除快捷方式，不影响原数据
 * - 原数据被删除时，引用变为"失效"状态
 */
export interface ReferenceNode {
  /** 来源数据库 */
  sourceDb: SourceDatabase;
  /** 原生数据 ID */
  sourceId: string;
  /** 显示标题（创建引用时快照） */
  title: string;
  /** 图标覆盖（可选，用于自定义显示） */
  icon?: string;
  /** 预览类型 */
  previewType: PreviewType;
  /** 引用创建时间（Unix 时间戳毫秒） */
  createdAt: number;
}

/**
 * 扩展后的文件夹结构
 *
 * 在原有 FolderStructure 基础上新增 references 字段
 * references 字段可选，兼容旧数据（无此字段时自动初始化为 {}）
 */
export interface ExtendedFolderStructure {
  /** 文件夹映射：fld_xxx -> { title, children } */
  folders: Record<string, { title: string; children: string[] }>;
  /** 根级别子节点 ID 列表 */
  rootChildren: string[];
  /** ★ 新增：引用节点映射 ref_xxx -> ReferenceNode */
  references?: Record<string, ReferenceNode>;
}

// ============================================================================
// ID 前缀常量
// ============================================================================

/** 笔记 ID 前缀 */
export const NOTE_ID_PREFIX = 'note_';
/** 文件夹 ID 前缀（注意：实际使用 fld_ 而非 folder_） */
export const FOLDER_ID_PREFIX = 'fld_';
/** 引用 ID 前缀 */
export const REFERENCE_ID_PREFIX = 'ref_';

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 检查 ID 是否为引用节点 ID
 * @param id 节点 ID
 * @returns 是否为 ref_xxx 格式
 */
export function isReferenceId(id: string): boolean {
  return typeof id === 'string' && id.startsWith(REFERENCE_ID_PREFIX);
}

/**
 * 检查 ID 是否为文件夹 ID
 * @param id 节点 ID
 * @returns 是否为 fld_xxx 格式
 */
export function isFolderId(id: string): boolean {
  return typeof id === 'string' && id.startsWith(FOLDER_ID_PREFIX);
}

/**
 * 检查 ID 是否为笔记 ID
 *
 * 注意：笔记 ID 可能是旧格式（无前缀）或新格式（note_xxx）
 * 这里采用排除法：不是文件夹、不是引用，则认为是笔记
 *
 * @param id 节点 ID
 * @returns 是否为笔记 ID
 */
export function isNoteId(id: string): boolean {
  if (typeof id !== 'string' || !id) return false;
  // 排除法：不是文件夹、不是引用
  return !isFolderId(id) && !isReferenceId(id);
}

/**
 * 生成引用节点 ID
 * @returns ref_{nanoid(8)} 格式的 ID
 */
export function generateRefId(): string {
  return `${REFERENCE_ID_PREFIX}${nanoid(8)}`;
}

/**
 * 生成文件夹 ID
 * @returns fld_{nanoid(8)} 格式的 ID
 */
export function generateFolderId(): string {
  return `${FOLDER_ID_PREFIX}${nanoid(8)}`;
}

/**
 * 获取节点类型
 * @param id 节点 ID
 * @returns 节点类型
 */
export function getNodeType(id: string): 'folder' | 'reference' | 'note' {
  if (isFolderId(id)) return 'folder';
  if (isReferenceId(id)) return 'reference';
  return 'note';
}

// ============================================================================
// SourceDatabase 辅助
// ============================================================================

/**
 * SourceDatabase 显示名称映射
 */
export const SOURCE_DB_DISPLAY_NAMES: Record<SourceDatabase, { zh: string; en: string }> = {
  textbooks: { zh: '教材', en: 'Textbook' },
  chat_v2: { zh: '附件', en: 'Attachment' },
  exam_sessions: { zh: '题目集识别', en: 'Exam Session' },
};

/**
 * SourceDatabase 对应的默认图标（Lucide 图标名）
 */
export const SOURCE_DB_ICONS: Record<SourceDatabase, string> = {
  textbooks: 'BookOpen',
  chat_v2: 'Paperclip',
  exam_sessions: 'FileSpreadsheet',
};

/**
 * SourceDatabase 对应的默认 PreviewType
 */
export const SOURCE_DB_PREVIEW_TYPES: Record<SourceDatabase, PreviewType> = {
  textbooks: 'pdf',
  chat_v2: 'none',
  exam_sessions: 'exam',
};

/**
 * 获取 SourceDatabase 的默认图标
 * @param sourceDb 来源数据库
 * @returns Lucide 图标名
 */
export function getSourceDbIcon(sourceDb: SourceDatabase): string {
  return SOURCE_DB_ICONS[sourceDb] || 'File';
}

/**
 * 获取 SourceDatabase 的默认 PreviewType
 * @param sourceDb 来源数据库
 * @returns 预览类型
 */
export function getSourceDbPreviewType(sourceDb: SourceDatabase): PreviewType {
  return SOURCE_DB_PREVIEW_TYPES[sourceDb] || 'none';
}

// ============================================================================
// 类型守卫
// ============================================================================

/**
 * 检查值是否为有效的 SourceDatabase（窄集合，引用节点 UI 支持面）
 *
 * 注意：`'notes'` 等 DSTU 可寻址库在此返回 false（合同测试锁定）。
 * 需要宽集合判定时使用 {@link isExtendedSourceDatabase}。
 *
 * @param value 待检查的值
 * @returns 是否为有效的 SourceDatabase
 */
export function isValidSourceDatabase(value: unknown): value is SourceDatabase {
  return (SOURCE_DATABASES as readonly string[]).includes(value as string);
}

/**
 * 检查值是否为 DSTU 层可寻址的来源数据库（宽集合）
 *
 * @param value 待检查的值
 * @returns 是否为有效的 ExtendedSourceDatabase
 */
export function isExtendedSourceDatabase(value: unknown): value is ExtendedSourceDatabase {
  return (EXTENDED_SOURCE_DATABASES as readonly string[]).includes(value as string);
}

/**
 * 检查值是否为有效的 PreviewType
 * @param value 待检查的值
 * @returns 是否为有效的 PreviewType
 *
 * ★ 2026-01 清理：移除 'card' 类型（错题系统废弃）
 * ★ 2026-01 添加：docx/xlsx/pptx/text 类型
 * ★ 2026-07 修复：改为由 PREVIEW_TYPES 派生，消除此前守卫漏掉 'epub'
 *   而类型联合含 'epub' 的漂移（守卫与类型不一致会让合法节点校验失败）。
 */
export function isValidPreviewType(value: unknown): value is PreviewType {
  return (PREVIEW_TYPES as readonly string[]).includes(value as string);
}

/**
 * 检查对象是否为有效的 ReferenceNode
 * @param obj 待检查的对象
 * @returns 是否为有效的 ReferenceNode
 */
export function isValidReferenceNode(obj: unknown): obj is ReferenceNode {
  if (!obj || typeof obj !== 'object') return false;
  const node = obj as Record<string, unknown>;
  return (
    isValidSourceDatabase(node.sourceDb) &&
    typeof node.sourceId === 'string' &&
    node.sourceId.length > 0 &&
    typeof node.title === 'string' &&
    isValidPreviewType(node.previewType) &&
    typeof node.createdAt === 'number' &&
    node.createdAt > 0
  );
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 ReferenceNode 的参数
 */
export interface CreateReferenceNodeParams {
  sourceDb: SourceDatabase;
  sourceId: string;
  title: string;
  icon?: string;
  previewType?: PreviewType;
}

/**
 * 创建 ReferenceNode
 *
 * @param params 创建参数
 * @returns 完整的 ReferenceNode
 */
export function createReferenceNode(params: CreateReferenceNodeParams): ReferenceNode {
  return {
    sourceDb: params.sourceDb,
    sourceId: params.sourceId,
    title: params.title,
    icon: params.icon,
    previewType: params.previewType ?? getSourceDbPreviewType(params.sourceDb),
    createdAt: Date.now(),
  };
}
