/**
 * 官方内置资源类型表。
 *
 * 这是 `resource.types` 槽位的官方贡献，也是 W37 golden 的唯一真源：
 * - `OFFICIAL_RESOURCE_TYPES`：W17 契约字段，逐项与 `resource-type-matrix.json` 对齐；
 * - `OFFICIAL_RESOURCE_TYPE_UI`：消费者 UI 投影（图标 token、骨架、拖拽字形、XML 标签等），
 *   契约字段表达不了的视觉细节留在这里，避免把菜单图标集合撑成 UI 图标全集。
 *
 * `all` 是浏览筛选值、`folder` 是容器、`retrieval` 是检索结果，都不是可打开资源类型，
 * 因此不在表中；未知/聚合类型由 `lookup.ts` 统一按 fallback 处理。
 */
import type { DstuNodeType } from '@/dstu/types';
import type { ResourceOperation, ResourceTypeDefinition } from './contracts';

/** 可打开的资源类型（与 `FolderItemType` 同集，不含 folder/retrieval/all）。 */
export const OFFICIAL_RESOURCE_TYPE_IDS = [
  'note',
  'textbook',
  'exam',
  'translation',
  'essay',
  'image',
  'file',
  'mindmap',
] as const;

export type OfficialResourceType = (typeof OFFICIAL_RESOURCE_TYPE_IDS)[number];

/** 所有官方类型都支持的操作（与当前右键菜单/桌面快捷方式能力一致）。 */
export const OFFICIAL_RESOURCE_OPERATIONS: readonly ResourceOperation[] = [
  'open',
  'preview',
  'rename',
  'move',
  'delete',
  'copy',
  'favorite',
  'add-to-chat',
  'add-to-desktop',
];

/** 官方类型的稳定顺序：侧栏筛选、菜单、回归快照都按它排序。 */
export const OFFICIAL_RESOURCE_TYPE_ORDER: Readonly<Record<OfficialResourceType, number>> = {
  note: 10,
  textbook: 20,
  exam: 30,
  translation: 40,
  essay: 50,
  image: 60,
  file: 70,
  mindmap: 80,
};

/**
 * 契约中 `icon` 是菜单图标集合，覆盖不到 `BookOpen` / `Image` 等资源图标；
 * 没有精确对应项时省略（消费者用 `OFFICIAL_RESOURCE_TYPE_UI.iconToken` 渲染）。
 */
const MENU_ICON: Partial<Record<OfficialResourceType, ResourceTypeDefinition['icon']>> = {
  note: 'FileText',
  exam: 'Clipboard',
  essay: 'Pencil',
  file: 'FileText',
};

const PREVIEW: Readonly<Record<OfficialResourceType, NonNullable<ResourceTypeDefinition['preview']>>> = {
  note: 'markdown',
  textbook: 'pdf',
  exam: 'exam',
  translation: 'markdown',
  essay: 'markdown',
  image: 'image',
  file: 'none',
  mindmap: 'mindmap',
};

const LABEL_KEY: Readonly<Record<OfficialResourceType, string>> = {
  note: 'learningHub:resourceType.note',
  textbook: 'learningHub:resourceType.textbook',
  exam: 'learningHub:resourceType.exam',
  translation: 'learningHub:resourceType.translation',
  essay: 'learningHub:resourceType.essay',
  image: 'learningHub:resourceType.image',
  file: 'learningHub:resourceType.file',
  mindmap: 'learningHub:resourceType.mindmap',
};

function definition(type: OfficialResourceType): ResourceTypeDefinition {
  return {
    type,
    labelKey: LABEL_KEY[type],
    icon: MENU_ICON[type],
    order: OFFICIAL_RESOURCE_TYPE_ORDER[type],
    preview: PREVIEW[type],
    operations: OFFICIAL_RESOURCE_OPERATIONS,
  };
}

export const OFFICIAL_RESOURCE_TYPES: Readonly<Record<OfficialResourceType, ResourceTypeDefinition>> = {
  note: definition('note'),
  textbook: definition('textbook'),
  exam: definition('exam'),
  translation: definition('translation'),
  essay: definition('essay'),
  image: definition('image'),
  file: definition('file'),
  mindmap: definition('mindmap'),
};

/** 一个类型的 UI 投影：契约之外的消费者细节集中在这里，不再散落 switch。 */
export interface ResourceTypeUi {
  /** Learning Hub 资源图标 token（`RESOURCE_TYPE_CONFIG.icon`）。 */
  iconToken: string;
  /** Learning Hub 资源图标色调 class。 */
  color: string;
  /** 统一预览类型（`ResourceListItem.previewType`）。 */
  previewType: 'markdown' | 'pdf' | 'image' | 'exam' | 'none' | 'docx' | 'xlsx' | 'pptx' | 'epub' | 'text' | 'audio' | 'video' | 'mindmap';
  /** 资源窗口加载骨架变体。 */
  skeleton: 'pdf' | 'text' | 'image' | 'generic' | 'mindmap';
  /** files 窗口 hover 预览的类型文案 key（workbench 命名空间）。 */
  previewLabelKey: string;
  /** 指针拖出 files 窗口时的随行字形。 */
  dragGlyph: string;
  /** 文件夹上下文 XML 的资源标签名。 */
  xmlTag: string;
  /** 引用到对话时的 VFS 类型（当前与资源类型同名）。 */
  vfsType: OfficialResourceType;
  /** 引用附件创建的 MIME 兜底。 */
  mime: string;
  /** 聊天右侧资源卡图标 token（phosphor 组件名由消费方映射）。 */
  chatIconToken: 'FileText' | 'BookOpen' | 'ClipboardText' | 'Image' | 'File';
  /** 聊天上下文引用方形图标 token（`ResourceIcons` 组件名）。 */
  refIconToken: 'NoteIcon' | 'TextbookIcon' | 'ExamIcon' | 'EssayIcon' | 'TranslationIcon' | 'MindmapIcon' | 'GenericFileIcon';
  /** 资源组编辑器图标 token（phosphor 组件名由消费方映射）。 */
  editorIconToken: 'FileText' | 'BookOpen' | 'ClipboardText' | 'Translate' | 'PenNib' | 'Image' | 'Brain' | 'File';
  /** 从聊天「在学习中心打开」时派发的事件；`null` = 走通用 `NAVIGATE_TO_VIEW`。 */
  chatOpenEvent: 'navigateToExamSheet' | 'navigateToNote' | 'navigateToEssay' | 'navigateToTranslation' | null;
  /** 回收站列表的 `listDeleted` 资源组；没有回收站分组的类型不列。 */
  trashType?: string;
  /** 多模态 RAG 的 `SourceType` 归一化结果。 */
  multimodalSourceType: 'exam' | 'textbook' | 'image' | 'file';
}

/** 资源类型 → 应用 typeId（`apps/content/typeMap.ts` 的映射，集中到此）。 */
export const RESOURCE_TYPE_APP_ID: Readonly<Record<OfficialResourceType, string>> = {
  note: 'notes',
  textbook: 'file-preview',
  exam: 'exam',
  translation: 'translation',
  essay: 'essay',
  image: 'file-preview',
  file: 'file-preview',
  mindmap: 'notes',
};

/** 资源类型 → 来源数据库（`types.ts:itemTypeToSourceDb` 的映射）。 */
export const RESOURCE_TYPE_SOURCE_DB: Readonly<Record<OfficialResourceType, string>> = {
  note: 'notes',
  textbook: 'textbooks',
  exam: 'exam_sessions',
  translation: 'translations',
  essay: 'essays',
  image: 'attachments',
  file: 'attachments',
  mindmap: 'mindmaps',
};

export const OFFICIAL_RESOURCE_TYPE_UI: Readonly<Record<OfficialResourceType, ResourceTypeUi>> = {
  note: {
    iconToken: 'FileText',
    color: 'text-blue-500',
    previewType: 'markdown',
    skeleton: 'text',
    previewLabelKey: 'workbench:files.preview.type.note',
    dragGlyph: 'N',
    xmlTag: 'note_item',
    vfsType: 'note',
    mime: 'text/markdown',
    chatIconToken: 'FileText',
    refIconToken: 'NoteIcon',
    editorIconToken: 'FileText',
    chatOpenEvent: 'navigateToNote',
    trashType: 'notes',
    multimodalSourceType: 'file',
  },
  textbook: {
    iconToken: 'BookOpen',
    color: 'text-orange-500',
    previewType: 'pdf',
    skeleton: 'pdf',
    previewLabelKey: 'workbench:files.preview.type.textbook',
    dragGlyph: 'T',
    xmlTag: 'textbook_item',
    vfsType: 'textbook',
    mime: 'application/pdf',
    chatIconToken: 'BookOpen',
    refIconToken: 'TextbookIcon',
    editorIconToken: 'BookOpen',
    chatOpenEvent: null,
    trashType: 'textbooks',
    multimodalSourceType: 'textbook',
  },
  exam: {
    iconToken: 'ClipboardList',
    color: 'text-green-500',
    previewType: 'exam',
    skeleton: 'pdf',
    previewLabelKey: 'workbench:files.preview.type.exam',
    dragGlyph: 'E',
    xmlTag: 'exam_item',
    vfsType: 'exam',
    mime: 'application/json',
    chatIconToken: 'ClipboardText',
    refIconToken: 'ExamIcon',
    editorIconToken: 'ClipboardText',
    chatOpenEvent: 'navigateToExamSheet',
    trashType: 'exams',
    multimodalSourceType: 'exam',
  },
  translation: {
    iconToken: 'Languages',
    color: 'text-purple-500',
    previewType: 'markdown',
    skeleton: 'text',
    previewLabelKey: 'workbench:files.preview.type.translation',
    dragGlyph: 'L',
    xmlTag: 'translation_item',
    vfsType: 'translation',
    mime: 'text/markdown',
    chatIconToken: 'FileText',
    refIconToken: 'TranslationIcon',
    editorIconToken: 'Translate',
    chatOpenEvent: 'navigateToTranslation',
    trashType: 'translations',
    multimodalSourceType: 'file',
  },
  essay: {
    iconToken: 'PenTool',
    color: 'text-pink-500',
    previewType: 'markdown',
    skeleton: 'text',
    previewLabelKey: 'workbench:files.preview.type.essay',
    dragGlyph: 'A',
    xmlTag: 'essay_item',
    vfsType: 'essay',
    mime: 'text/markdown',
    chatIconToken: 'FileText',
    refIconToken: 'EssayIcon',
    editorIconToken: 'PenNib',
    chatOpenEvent: 'navigateToEssay',
    trashType: 'essays',
    multimodalSourceType: 'file',
  },
  image: {
    iconToken: 'Image',
    color: 'text-cyan-500',
    previewType: 'image',
    skeleton: 'image',
    previewLabelKey: 'workbench:files.preview.type.image',
    dragGlyph: 'I',
    xmlTag: 'resource_item',
    vfsType: 'image',
    mime: 'image/png',
    chatIconToken: 'Image',
    refIconToken: 'GenericFileIcon',
    editorIconToken: 'Image',
    chatOpenEvent: null,
    multimodalSourceType: 'image',
  },
  file: {
    iconToken: 'File',
    color: 'text-gray-500',
    previewType: 'none',
    skeleton: 'generic',
    previewLabelKey: 'workbench:files.preview.type.file',
    dragGlyph: 'F',
    xmlTag: 'resource_item',
    vfsType: 'file',
    mime: 'application/octet-stream',
    chatIconToken: 'File',
    refIconToken: 'GenericFileIcon',
    editorIconToken: 'File',
    chatOpenEvent: null,
    multimodalSourceType: 'file',
  },
  mindmap: {
    iconToken: 'Workflow',
    color: 'text-indigo-500',
    previewType: 'mindmap',
    skeleton: 'mindmap',
    previewLabelKey: 'workbench:files.preview.type.mindmap',
    dragGlyph: 'M',
    xmlTag: 'resource_item',
    vfsType: 'mindmap',
    mime: 'application/json',
    chatIconToken: 'FileText',
    refIconToken: 'MindmapIcon',
    editorIconToken: 'Brain',
    chatOpenEvent: null,
    multimodalSourceType: 'file',
  },
};

/** 官方类型的 `DstuNodeType` 收窄（不含 folder/retrieval）。 */
export function isOfficialResourceType(value: string): value is OfficialResourceType {
  return Object.prototype.hasOwnProperty.call(OFFICIAL_RESOURCE_TYPES, value);
}

/** 把 `DstuNodeType` 收窄到官方资源类型。 */
export function asOfficialResourceType(value: DstuNodeType | string): OfficialResourceType | null {
  return isOfficialResourceType(value) ? value : null;
}
