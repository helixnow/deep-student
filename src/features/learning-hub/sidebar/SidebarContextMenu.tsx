import type React from 'react';
import { LearningHubContextMenu, type ContextMenuTarget } from '../components/LearningHubContextMenu';
import type { LearningHubSidebarProps, ResourceListItem } from '../types';
import type { EffectiveFinderPath } from './sidebarConstants';

export interface SidebarContextMenuProps {
  mode: LearningHubSidebarProps['mode'];
  contextMenuOpen: boolean;
  setContextMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  contextMenuPosition: { x: number; y: number };
  contextMenuTarget: ContextMenuTarget;
  effectivePath: EffectiveFinderPath;
  isTrashView: boolean;
  canCreateInCurrentView: boolean;
  canDeleteInCurrentView: boolean;
  canMoveInCurrentView: boolean;
  canAddToChatInCurrentView: boolean;
  handleNewFolder: () => void;
  handleNewNote: () => Promise<void>;
  handleNewExam: () => Promise<void>;
  handleNewTextbook: () => Promise<void>;
  handleNewTranslation: () => Promise<void>;
  handleNewEssay: () => Promise<void>;
  handleNewMindMap: () => Promise<void>;
  handleImportMarkdownNote: (folderId?: string | null) => Promise<void>;
  handleRefresh: () => Promise<void>;
  handleOpenFolder: (folderId: string) => void;
  handleOpenRenameDialog: (folderId: string) => void;
  selectedIds: Set<string>;
  handleBatchDelete: () => void;
  handleDeleteFolder: (folderId: string) => Promise<void>;
  onOpenApp: LearningHubSidebarProps['onOpenApp'];
  handleOpenRenameResourceDialog: (resource: ResourceListItem) => void;
  handleDeleteResource: (resource: ResourceListItem) => Promise<void>;
  handleToggleFavorite: (resource: ResourceListItem) => Promise<void>;
  handleCopyFromContextMenu: (target: ContextMenuTarget) => void;
  canPasteHere: boolean;
  handleDuplicateFromContextMenu: (target: ContextMenuTarget) => void;
  handlePaste: () => void;
  clipboardCount: number;
  handleExportResource: (resource: ResourceListItem) => Promise<void>;
  handleExportFolder: (folderId: string) => Promise<void>;
  handleRestoreItem: (id: string, itemType: string) => Promise<void>;
  handlePermanentDeleteItem: (id: string, itemType: string) => void;
  handleEmptyTrash: () => void;
  handleReferenceToChat: (target: ContextMenuTarget, options?: { openAttachmentPanel?: boolean }) => Promise<boolean>;
  handleMakeCards: (target: ContextMenuTarget) => Promise<void>;
  handleMoveTo: (target: ContextMenuTarget) => void;
}

/** 访达右键菜单接线（canvas 模式禁用） */
export function SidebarContextMenu({
  mode,
  contextMenuOpen,
  setContextMenuOpen,
  contextMenuPosition,
  contextMenuTarget,
  effectivePath,
  isTrashView,
  canCreateInCurrentView,
  canDeleteInCurrentView,
  canMoveInCurrentView,
  canAddToChatInCurrentView,
  handleNewFolder,
  handleNewNote,
  handleNewExam,
  handleNewTextbook,
  handleNewTranslation,
  handleNewEssay,
  handleNewMindMap,
  handleImportMarkdownNote,
  handleRefresh,
  handleOpenFolder,
  handleOpenRenameDialog,
  selectedIds,
  handleBatchDelete,
  handleDeleteFolder,
  onOpenApp,
  handleOpenRenameResourceDialog,
  handleDeleteResource,
  handleToggleFavorite,
  handleCopyFromContextMenu,
  canPasteHere,
  handleDuplicateFromContextMenu,
  handlePaste,
  clipboardCount,
  handleExportResource,
  handleExportFolder,
  handleRestoreItem,
  handlePermanentDeleteItem,
  handleEmptyTrash,
  handleReferenceToChat,
  handleMakeCards,
  handleMoveTo,
}: SidebarContextMenuProps) {
  return (
    <LearningHubContextMenu
      open={mode !== 'canvas' && contextMenuOpen}
      onOpenChange={setContextMenuOpen}
      position={contextMenuPosition}
      target={contextMenuTarget}
      dataView="folder"
      currentFolderId={effectivePath.folderId}
      isTrashView={isTrashView}
      canCreate={canCreateInCurrentView}
      canDelete={canDeleteInCurrentView}
      canMove={canMoveInCurrentView}
      canAddToChat={canAddToChatInCurrentView}
      onCreateFolder={canCreateInCurrentView ? () => handleNewFolder() : undefined}
      onCreateItem={canCreateInCurrentView ? (type, _folderId) => {
        switch (type) {
          case 'note':
            handleNewNote();
            break;
          case 'exam':
            handleNewExam();
            break;
          case 'textbook':
            handleNewTextbook();
            break;
          case 'translation':
            handleNewTranslation();
            break;
          case 'essay':
            handleNewEssay();
            break;
          case 'mindmap':
            handleNewMindMap();
            break;
        }
      } : undefined}
      onImportMarkdownNote={canCreateInCurrentView ? (folderId) => {
        void handleImportMarkdownNote(folderId);
      } : undefined}
      onRefresh={handleRefresh}
      onOpenFolder={handleOpenFolder}
      onRenameFolder={handleOpenRenameDialog}
      onDeleteFolder={canDeleteInCurrentView ? (folderId) => {
        if (selectedIds.size > 1 && selectedIds.has(folderId)) {
          handleBatchDelete();
        } else {
          handleDeleteFolder(folderId);
        }
      } : undefined}
      onOpenResource={(resource) => {
        if (onOpenApp && 'id' in resource) {
          onOpenApp(resource as ResourceListItem);
        }
      }}
      onRenameResource={handleOpenRenameResourceDialog}
      onDeleteResource={canDeleteInCurrentView ? (resource) => {
        if (selectedIds.size > 1 && selectedIds.has(resource.id)) {
          handleBatchDelete();
        } else {
          handleDeleteResource(resource);
        }
      } : undefined}
      onToggleFavorite={handleToggleFavorite}
      onCopy={isTrashView ? undefined : handleCopyFromContextMenu}
      onDuplicate={canPasteHere ? handleDuplicateFromContextMenu : undefined}
      onPaste={canPasteHere ? handlePaste : undefined}
      pasteCount={clipboardCount}
      onExportResource={handleExportResource}
      onExportFolder={handleExportFolder}
      onRestoreItem={handleRestoreItem}
      onPermanentDeleteItem={handlePermanentDeleteItem}
      onEmptyTrash={handleEmptyTrash}
      onReferenceToChat={
        canAddToChatInCurrentView ? handleReferenceToChat : undefined
      }
      onMakeCards={canAddToChatInCurrentView ? handleMakeCards : undefined}
      onMoveTo={canMoveInCurrentView ? handleMoveTo : undefined}
    />
  );
}
