import type { TFunction } from 'i18next';
import {
  ATTACHMENT_AUDIO_EXTENSIONS,
  ATTACHMENT_CODE_TEXT_EXTENSIONS,
  ATTACHMENT_VIDEO_EXTENSIONS,
} from '@/features/chat/core/constants';
import type { DstuNode } from '@/dstu';
import type { FinderPath } from '../stores/finderStore';

/** 教材导入进度事件类型 */
interface TextbookImportProgress {
  file_name: string;
  stage: 'hashing' | 'copying' | 'rendering' | 'saving' | 'done' | 'error';
  current_page?: number;
  total_pages?: number;
  progress: number;
  error?: string;
}

// ============================================================================
// ★ 拖拽导入：文件类型分类常量（模块级，避免每次渲染重建）
// ============================================================================

/** 文档类扩展名集合（通过 textbooks_add 后端命令导入） */
const DOCUMENT_EXTENSIONS = new Set([
  'pdf', 'docx', 'txt', 'md', 'markdown', 'html', 'htm',
  'xlsx', 'xls', 'xlsb', 'ods',
  'pptx', 'epub', 'rtf',
  'csv', 'json', 'xml',
  // 源码 / 配置：后端按纯文本导入（计算机类课程资料常见 .py/.c/.sql 等）
  ...ATTACHMENT_CODE_TEXT_EXTENSIONS,
]);

/** 图片类扩展名集合 */
const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'heic', 'heif',
]);

/** 音视频扩展名集合（作为附件导入，打开即进入音视频学习：转写、字幕、讲义） */
const MEDIA_EXTENSIONS = new Set<string>([
  ...ATTACHMENT_AUDIO_EXTENSIONS,
  ...ATTACHMENT_VIDEO_EXTENSIONS,
]);

/**
 * ★ 2026-07-20（P3 引导）：需要引导到专属模块导入的格式。
 * 资源库不直接接收这类文件，拖入时给出明确的模块引导而非笼统"导入失败"。
 */
const MODULE_GUIDANCE_EXTENSIONS: Record<string, 'flashcards' | 'mindmap'> = {
  apkg: 'flashcards',
  colpkg: 'flashcards',
  xmind: 'mindmap',
  opml: 'mindmap',
  mm: 'mindmap',
  mmap: 'mindmap',
};

/** 从文件名获取扩展名 */
const getFileExtension = (name: string): string =>
  (name.split('.').pop() || '').toLowerCase();

/** ★ Bug4: canvas 模式下不应显示的特殊视图（仅显示层 fallback，不写回 store） */
const CANVAS_BLOCKED_VIEW_KINDS = new Set(['indexStatus', 'memory', 'desktop']);
const CANVAS_FALLBACK_PATH = {
  viewKind: 'folder' as const,
  breadcrumbs: [] as Array<{ id: string; name: string; dstuPath: string }>,
  folderId: null as string | null,
  typeFilter: null as null,
};
const PENDING_FOLDER_ID_PREFIX = '__pending_new_folder__';

type SoftDeleteTarget = { id: string; type: string; name: string };

const isPendingFolderId = (id: string | null | undefined): boolean =>
  Boolean(id?.startsWith(PENDING_FOLDER_ID_PREFIX));

interface PendingFolderDraft {
  node: DstuNode;
  parentFolderId: string | null;
}

/** 侧栏使用的 learningHub 命名空间翻译函数 */
export type SidebarT = TFunction<'learningHub'>;

/** 显示层生效路径：store 路径或 canvas fallback */
export type EffectiveFinderPath = FinderPath | typeof CANVAS_FALLBACK_PATH;

/** 删除确认对话框目标：仅永久删 / 清空 / 回收站批永久删 */
export type DeleteConfirmTarget = {
  type: 'permanent' | 'emptyTrash' | 'batch';
  permanentDeleteInfo?: { id: string; itemType: string };
  batchIds?: Set<string>;
  message: string;
};

export type { TextbookImportProgress, SoftDeleteTarget, PendingFolderDraft };
export {
  DOCUMENT_EXTENSIONS,
  IMAGE_EXTENSIONS,
  MEDIA_EXTENSIONS,
  MODULE_GUIDANCE_EXTENSIONS,
  getFileExtension,
  CANVAS_BLOCKED_VIEW_KINDS,
  CANVAS_FALLBACK_PATH,
  PENDING_FOLDER_ID_PREFIX,
  isPendingFolderId,
};
