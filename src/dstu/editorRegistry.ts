/**
 * DSTU 编辑器注册表
 *
 * 类比操作系统的文件类型关联机制（Launch Services），
 * 定义资源类型 → 编辑器组件 → 打开位置的映射。
 *
 * @see 21-VFS虚拟文件系统架构设计.md 第四章 4.7
 */

import type { DstuNodeType } from './types';
import type {
  EditorRegistryEntry,
  ResourceCapabilities,
  EditorComponent,
} from './editorTypes';

// ============================================================================
// 预定义能力集
// ============================================================================

/**
 * 完全可编辑资源的能力集
 */
const FULL_EDIT_CAPABILITIES: ResourceCapabilities = {
  editable: true,
  deletable: true,
  movable: true,
  copyable: true,
  shareable: true,
  versionable: false,
  referenceable: true,
};

/**
 * 只读资源的能力集
 */
const VIEW_ONLY_CAPABILITIES: ResourceCapabilities = {
  editable: false,
  deletable: true,
  movable: true,
  copyable: true,
  shareable: true,
  versionable: false,
  referenceable: true,
};

/**
 * 翻译资源的能力集（无科目，不可移动）
 */
const TRANSLATION_CAPABILITIES: ResourceCapabilities = {
  editable: false,
  deletable: true,
  movable: false, // 翻译无科目，不支持移动
  copyable: true,
  shareable: true,
  versionable: false,
  referenceable: true,
};

/**
 * 题目集资源的能力集
 */
const EXAM_CAPABILITIES: ResourceCapabilities = {
  editable: true,
  deletable: true,
  movable: true,
  copyable: false, // 题目集不支持复制
  shareable: false,
  versionable: false,
  referenceable: true,
};

// ============================================================================
// 懒加载编辑器组件
// ============================================================================

/**
 * 懒加载笔记编辑器
 *
 * 实际组件路径：src/components/notes/components/NoteEditorView.tsx
 * 需要包装以符合 EditorProps 接口
 */
const lazyNoteEditor = (): Promise<{ default: EditorComponent }> =>
  import('./editors/NoteEditorWrapper').then((m) => ({ default: m.NoteEditorWrapper }));

/**
 * 懒加载 PDF 查看器
 *
 * 实际组件路径：src/components/TextbookPdfViewer.tsx
 */
const lazyPDFViewer = (): Promise<{ default: EditorComponent }> =>
  import('./editors/PDFViewerWrapper').then((m) => ({ default: m.PDFViewerWrapper }));

/**
 * 懒加载题目集编辑器
 *
 * 实际组件路径：src/components/notes/preview/ExamPreview.tsx
 */
const lazyExamEditor = (): Promise<{ default: EditorComponent }> =>
  import('./editors/ExamEditorWrapper').then((m) => ({ default: m.ExamEditorWrapper }));

/**
 * 懒加载翻译查看器
 */
const lazyTranslationViewer = (): Promise<{ default: EditorComponent }> =>
  import('./editors/TranslationViewerWrapper').then((m) => ({ default: m.TranslationViewerWrapper }));

/**
 * 懒加载作文编辑器
 */
const lazyEssayEditor = (): Promise<{ default: EditorComponent }> =>
  import('./editors/EssayEditorWrapper').then((m) => ({ default: m.EssayEditorWrapper }));

/**
 * 懒加载图片查看器
 */
const lazyImageViewer = (): Promise<{ default: EditorComponent }> =>
  import('./editors/ImageViewerWrapper').then((m) => ({ default: m.ImageViewerWrapper }));

/**
 * 懒加载通用文件查看器
 */
const lazyFileViewer = (): Promise<{ default: EditorComponent }> =>
  import('./editors/FileViewerWrapper').then((m) => ({ default: m.FileViewerWrapper }));

/**
 * 懒加载知识导图编辑器
 */
const lazyMindMapEditor = (): Promise<{ default: EditorComponent }> =>
  import('./editors/MindMapEditorWrapper').then((m) => ({ default: m.MindMapEditorWrapper }));

// ============================================================================
// 编辑器注册表
// ============================================================================

/**
 * 编辑器注册表
 *
 * 定义每种资源类型的：
 * - 编辑器组件
 * - 默认编辑模式
 * - 默认打开位置
 * - 资源能力
 * - 图标和显示名称
 */
export const editorRegistry: Record<DstuNodeType, EditorRegistryEntry> = {
  // ========== 笔记 ==========
  note: {
    type: 'note',
    editor: lazyNoteEditor,
    defaultMode: 'edit',
    defaultLocation: 'page', // 笔记默认独立页面编辑
    capabilities: FULL_EDIT_CAPABILITIES,
    icon: 'FileText',
    displayName: 'dstu:types.note',
  },

  // ========== 教材 ==========
  textbook: {
    type: 'textbook',
    editor: lazyPDFViewer,
    defaultMode: 'view',
    defaultLocation: 'fullscreen', // 教材默认全屏阅读
    capabilities: VIEW_ONLY_CAPABILITIES,
    icon: 'BookOpen',
    displayName: 'dstu:types.textbook',
  },

  // ========== 题目集 ==========
  exam: {
    type: 'exam',
    editor: lazyExamEditor,
    defaultMode: 'edit',
    defaultLocation: 'page',
    capabilities: EXAM_CAPABILITIES,
    icon: 'ClipboardList',
    displayName: 'dstu:types.exam',
  },

  // ========== 翻译 ==========
  translation: {
    type: 'translation',
    editor: lazyTranslationViewer,
    defaultMode: 'view',
    defaultLocation: 'panel', // 翻译默认面板预览
    capabilities: TRANSLATION_CAPABILITIES,
    icon: 'Languages',
    displayName: 'dstu:types.translation',
  },

  // ========== 作文 ==========
  essay: {
    type: 'essay',
    editor: lazyEssayEditor,
    defaultMode: 'edit',
    defaultLocation: 'page',
    capabilities: {
      ...FULL_EDIT_CAPABILITIES,
      copyable: false, // 作文不支持复制
    },
    icon: 'PenTool',
    displayName: 'dstu:types.essay',
  },

  // ========== 图片 ==========
  image: {
    type: 'image',
    editor: lazyImageViewer,
    defaultMode: 'view',
    defaultLocation: 'modal', // 图片默认弹窗查看
    capabilities: {
      ...VIEW_ONLY_CAPABILITIES,
      versionable: false,
    },
    icon: 'Image',
    displayName: 'dstu:types.image',
  },

  // ========== 通用文件 ==========
  file: {
    type: 'file',
    editor: lazyFileViewer,
    defaultMode: 'view',
    defaultLocation: 'panel',
    capabilities: {
      editable: false,
      deletable: true,
      movable: true,
      copyable: true,
      shareable: true,
      versionable: false,
      referenceable: false, // 通用文件不可引用到对话
    },
    icon: 'File',
    displayName: 'dstu:types.file',
  },

  // ========== 文件夹 ==========
  folder: {
    type: 'folder',
    editor: lazyFileViewer, // 文件夹没有编辑器，使用占位
    defaultMode: 'view',
    defaultLocation: 'panel',
    capabilities: {
      editable: false,
      deletable: true,
      movable: true,
      copyable: false,
      shareable: false,
      versionable: false,
      referenceable: false,
    },
    icon: 'Folder',
    displayName: 'dstu:types.folder',
  },

  // ========== 检索结果 ==========
  retrieval: {
    type: 'retrieval',
    editor: lazyNoteEditor, // 检索结果使用笔记编辑器显示
    defaultMode: 'view',
    defaultLocation: 'panel',
    capabilities: {
      editable: false,
      deletable: true,
      movable: false,
      copyable: true,
      shareable: false,
      versionable: false,
      referenceable: true,
    },
    icon: 'Search',
    displayName: 'dstu:types.retrieval',
  },

  // ========== 知识导图 ==========
  mindmap: {
    type: 'mindmap',
    editor: lazyMindMapEditor,
    defaultMode: 'edit',
    defaultLocation: 'page',
    capabilities: FULL_EDIT_CAPABILITIES,
    icon: 'GitBranch',
    displayName: 'dstu:types.mindmap',
  },
};

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 获取资源类型的编辑器注册项
 */
export function getEditorEntry(type: DstuNodeType): EditorRegistryEntry {
  return editorRegistry[type];
}

/**
 * 获取资源类型的能力定义
 */
export function getCapabilities(type: DstuNodeType): ResourceCapabilities {
  return editorRegistry[type].capabilities;
}

/**
 * 检查资源类型是否支持某个能力
 */
export function hasCapability(
  type: DstuNodeType,
  capability: keyof ResourceCapabilities
): boolean {
  return editorRegistry[type].capabilities[capability];
}

/**
 * 获取所有支持引用到对话的资源类型
 */
export function getReferenceableTypes(): DstuNodeType[] {
  return Object.entries(editorRegistry)
    .filter(([_, entry]) => entry.capabilities.referenceable)
    .map(([type]) => type as DstuNodeType);
}

/**
 * 获取所有可编辑的资源类型
 */
export function getEditableTypes(): DstuNodeType[] {
  return Object.entries(editorRegistry)
    .filter(([_, entry]) => entry.capabilities.editable)
    .map(([type]) => type as DstuNodeType);
}

/**
 * 加载编辑器组件（支持懒加载）
 */
export async function loadEditorComponent(type: DstuNodeType): Promise<EditorComponent> {
  const entry = editorRegistry[type];
  const editor = entry.editor;

  if (typeof editor === 'function' && editor.length === 0) {
    // 懒加载函数
    const module = await (editor as () => Promise<{ default: EditorComponent }>)();
    return module.default;
  }

  return editor as EditorComponent;
}
