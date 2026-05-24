/**
 * Notes feature - public API
 */

// Main components
export { default as NotesHome } from './NotesHome';
export { NoteEditorPortal } from './NoteEditorPortal';
export { NotesCrepeEditor } from './NotesCrepeEditor';
export { NotesContextPanel } from './NotesContextPanel';
export { NotesHeader } from './NotesHeader';
export { NotesLibraryManager } from './NotesLibraryManager';
export { NotesSidebar } from './NotesSidebar';
export { NotesSidebarV2 } from './NotesSidebarV2';
export { default as NotesTabsBar } from './NotesTabsBar';
export { PreviewPanel } from './PreviewPanel';
export { default as TreeDragTest } from './TreeDragTest';
export { AIDiffPanel } from './AIDiffPanel';
export { InvalidReferenceOverlay } from './InvalidReferenceOverlay';
export { DndKitTreeAdapter } from './DndKitTreeAdapter';
export { TreeWithDndKit } from './TreeWithDndKit';

// Context
export { useNotes, useNotesOptional, NotesProvider } from './NotesContext';
export type { CanvasAIStatus, CanvasNoteMetadata, CanvasModeState, LearningHubContent } from './NotesContext';

// DndFileTree
export { DndFileTree, ReferenceIcon } from './DndFileTree';
export type { TreeData, TreeNode, DragInfo, TreeCallbacks, NodeType, ReferenceData, ReferenceNode, SourceDatabase, PreviewType } from './DndFileTree';

// Reference selector
export { ReferenceSelector, ReferenceSelectorItem, listTextbooks } from './reference-selector';
export type { ReferenceSelectorProps, ReferenceSelectorType, ReferenceSelectResult, TextbookListItem, UnifiedResourceItem } from './reference-selector';

// Preview
export { MarkdownPreview } from './preview/MarkdownPreview';
export { PDFPreview } from './preview/PDFPreview';
export { ImagePreview } from './preview/ImagePreview';
export { ExamPreview } from './preview/ExamPreview';
export { AudioPreview } from './preview/AudioPreview';
export { VideoPreview } from './preview/VideoPreview';

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
  SOURCE_DB_DISPLAY_NAMES,
  SOURCE_DB_ICONS,
  SOURCE_DB_PREVIEW_TYPES,
  getSourceDbIcon,
  getSourceDbPreviewType,
  isValidSourceDatabase,
  isValidPreviewType,
  isValidReferenceNode,
  createReferenceNode,
} from './types';
export type { ExtendedFolderStructure, CreateReferenceNodeParams } from './types';

// Store
export { useNotesTreeStore, computeVisibleOrder, getParentChain, toPersistenceSnapshot } from './stores/notesTreeStore';
export type { DropPosition, FlattenedTreeNode, NotesTreePersistenceSnapshot } from './stores/notesTreeStore';

// Utilities
export { fetchReferenceContent } from './learningHubApi';
export type { ContentMetadata, FetchContentParams } from './learningHubApi';
