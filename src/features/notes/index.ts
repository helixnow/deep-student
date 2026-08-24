/**
 * Notes feature - public API
 */

// Main components（历史 NotesHome 视图已下线删除，2026-08）
export { NotesCrepeEditor } from './NotesCrepeEditor';
export { NotesContextPanel } from './NotesContextPanel';
export { NotesLibraryManager } from './NotesLibraryManager';
export { AIDiffPanel } from './AIDiffPanel';

// Context
export { useNotes, useNotesOptional, NotesProvider } from './NotesContext';
export type { CanvasAIStatus, CanvasNoteMetadata, CanvasModeState, LearningHubContent } from './NotesContext';

// DndFileTree 组件已于 2026-08 零挂载删除（workbench 笔记树独立实现，见
// src/features/workbench/apps/notes/tree/）；树数据类型迁至 notesUtils（见下方导出）。

// Preview 组件组（MarkdownPreview/PDFPreview/ImagePreview/ExamPreview）
// 已于 2026-08 确认零消费方后删除；预览统一走 learning-hub 与 DSTU editors。

// Types
export {
  isReferenceId,
  isFolderId,
  isNoteId,
  generateRefId,
  generateFolderId,
  getNodeType,
  NOTE_ID_PREFIX,
  FOLDER_ID_PREFIX,
  REFERENCE_ID_PREFIX,
  SOURCE_DATABASES,
  EXTENDED_SOURCE_DATABASES,
  PREVIEW_TYPES,
  SOURCE_DB_DISPLAY_NAMES,
  SOURCE_DB_ICONS,
  SOURCE_DB_PREVIEW_TYPES,
  getSourceDbIcon,
  getSourceDbPreviewType,
  isValidSourceDatabase,
  isExtendedSourceDatabase,
  isValidPreviewType,
  isValidReferenceNode,
  createReferenceNode,
} from './types';
export type {
  ExtendedFolderStructure,
  CreateReferenceNodeParams,
  ExtendedSourceDatabase,
  ReferenceNode,
  SourceDatabase,
  PreviewType,
} from './types';

// Store（兼容空壳，勿在新代码使用；树状态由 workbench NotesWorkspaceTree 自持）
export { useNotesTreeStore } from './stores/notesTreeStore';

// Utilities
export {
  fetchReferenceContent,
  fetchReferenceNode,
  validateReference,
  batchValidateReferences,
  mapSourceToResourceType,
  canReferenceToChat,
} from './learningHubApi';
export type { ContentMetadata, FetchContentParams } from './learningHubApi';

// ============================================================================
// 稳定跨模块 API（barrel 补充导出，2026-07）
//
// 以下模块此前只能 deep import（如 '@/features/notes/openNoteEvent'），
// 现同时从 barrel 导出。仅新增导出，deep import 路径继续可用，勿删除。
// ============================================================================

// Open-note event ownership（chat / workbench / crepe 三方契约）
export {
  NOTES_OWNED_OPEN_NOTE_SOURCES,
  isNotesOwnedOpenNoteSource,
  shouldChatHandleOpenNote,
  shouldWorkbenchHandleOpenNote,
} from './openNoteEvent';
export type { NotesOwnedOpenNoteSource, DstuOpenNoteDetail } from './openNoteEvent';

// Wikilinks（workbench 反链面板等消费）
export {
  parseWikiLinks,
  parseNoteMentions,
  parseNoteLinks,
  createWikiLinkIndex,
  resolveWikiLinks,
  getWikiLinkRelationships,
} from './wikilinks';
export type {
  WikiLink,
  WikiLinkNoteReference,
  WikiLinkNoteContent,
  WikiLinkNoteContentMap,
  WikiLinkMatchKind,
  WikiLinkTargetResolution,
  ResolvedWikiLink,
  WikiLinkRelationship,
  UnresolvedWikiLink,
  WikiLinkRelationships,
  WikiLinkIndex,
} from './wikilinks';

// Markdown 窗口化（learning-hub / settings 消费）
export {
  DEFAULT_INITIAL_LINE_WINDOW,
  MIN_INITIAL_LINE_WINDOW,
  MAX_INITIAL_LINE_WINDOW,
  DEFAULT_LOAD_MORE_PRELOAD_PX,
  clampInitialLineWindow,
  getLoadMoreLineChunk,
  shouldWindowMarkdown,
  createMarkdownWindow,
  expandMarkdownWindow,
  composeWindowedSave,
  shouldRequestLoadMore,
} from './markdownWindow';
export type { MarkdownWindow, MarkdownLoadMoreResult, ViewportMetrics } from './markdownWindow';
export {
  MARKDOWN_INITIAL_LINE_WINDOW_SETTING,
  loadInitialLineWindowSetting,
  saveInitialLineWindowSetting,
} from './markdownWindowSettings';

// 幽灵链创建 / 查找与标题跳转桥 / 焦点模式（workbench 消费）
export {
  CREATE_FROM_WIKILINK_EVENT,
  setWikilinkCreateContext,
  createNoteFromWikilinkTitle,
  refreshWikilinksAfterCreate,
  parseCreateFromWikilinkEvent,
} from './createFromWikilink';
export {
  NOTES_FIND_QUERY_EVENT,
  publishNotesFindQuery,
  consumeNotesFindQuery,
} from './findQueryBridge';
export type { NotesFindQuery } from './findQueryBridge';
export {
  NOTES_HEADING_TARGET_EVENT,
  publishNotesHeadingTarget,
  consumeNotesHeadingTarget,
} from './headingTargetBridge';
export type { NotesHeadingTarget } from './headingTargetBridge';
export { updateFocusModeOwners } from './focusModeOwnership';
export type { NotesFocusModeEventDetail } from './focusModeOwnership';

// 模板
export { getNoteTemplates, renderNoteTemplate, applyNoteTemplate } from './noteTemplates';
export type { NoteTemplate, NoteTemplateId, NoteTemplateVariables } from './noteTemplates';

// 树 / 内容工具（NotesEditorHeader / 侧栏等消费）
export {
  normalizeContentForEditor,
  sortTreeChildren,
  getPathToNote,
  buildTreeData,
  deriveNoteTitleText,
} from './notesUtils';
export type {
  TreeBuildParams,
  TreeSortMethod,
  TreeData,
  TreeNode,
  NodeType,
  ReferenceData,
} from './notesUtils';
