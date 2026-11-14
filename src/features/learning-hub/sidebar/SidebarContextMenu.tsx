import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  SpaceMountPickerDialog,
  type MountableItemTarget,
} from '@/components/study-space/SpaceMountPickerDialog';
import { useStudySpaceStore } from '@/stores/studySpaceStore';
import { getErrorMessage } from '@/utils/errorUtils';
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
  onMountToSpace?: (target: ContextMenuTarget) => void;
  onUnmountFromCurrentFolder?: (mountId: string) => void;
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
  onMountToSpace,
  onUnmountFromCurrentFolder,
}: SidebarContextMenuProps) {
  const { t } = useTranslation('learningHub');
  const mountsBySpaceId = useStudySpaceStore((s) => s.mountsBySpaceId);
  const unmountItemFromSpace = useStudySpaceStore((s) => s.unmountItemFromSpace);
  const [mountPickerItem, setMountPickerItem] = useState<MountableItemTarget | null>(null);

  const targetItemId = useMemo(() => {
    if (contextMenuTarget.type === 'resource') return contextMenuTarget.resource.id;
    if (contextMenuTarget.type === 'folder') return contextMenuTarget.folder.folder.id;
    return null;
  }, [contextMenuTarget]);

  const activeMountInFolder = useMemo(() => {
    if (!targetItemId || !effectivePath.folderId) return null;
    for (const mounts of Object.values(mountsBySpaceId)) {
      const matched = mounts.find(
        (m) => m.targetFolderId === effectivePath.folderId && m.itemId === targetItemId,
      );
      if (matched) return matched;
    }
    return null;
  }, [effectivePath.folderId, mountsBySpaceId, targetItemId]);

  const defaultHandleMountToSpace = useCallback(
    (target: ContextMenuTarget) => {
      if (target.type === 'resource') {
        setMountPickerItem({
          itemId: target.resource.id,
          itemType: target.resource.type,
          title: target.resource.title,
          canonicalFolderId: effectivePath.folderId ?? null,
        });
      } else if (target.type === 'folder') {
        setMountPickerItem({
          itemId: target.folder.folder.id,
          itemType: 'folder',
          title: target.folder.folder.title,
          canonicalFolderId: target.folder.folder.parentId ?? effectivePath.folderId ?? null,
        });
      }
    },
    [effectivePath.folderId],
  );

  const defaultHandleUnmount = useCallback(
    async (mountId: string) => {
      try {
        const spaceId =
          activeMountInFolder?.id === mountId
            ? activeMountInFolder.spaceId
            : Object.values(mountsBySpaceId)
                .flat()
                .find((m) => m.id === mountId)?.spaceId ?? '';
        await unmountItemFromSpace(spaceId, { mountId });
        showGlobalNotification('success', t('spaceMount.unmountSuccess'));
        await handleRefresh();
      } catch (error: unknown) {
        showGlobalNotification('error', getErrorMessage(error));
      }
    },
    [activeMountInFolder, handleRefresh, mountsBySpaceId, t, unmountItemFromSpace],
  );

  const effectiveMountHandler =
    mode === 'canvas' || isTrashView
      ? undefined
      : (onMountToSpace ?? defaultHandleMountToSpace);
  const effectiveUnmountHandler =
    mode === 'canvas' || isTrashView
      ? undefined
      : (onUnmountFromCurrentFolder ?? ((mountId: string) => void defaultHandleUnmount(mountId)));

  return (
    <>
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
        onCreateItem={canCreateInCurrentView ? (type) => {
          const creators: Partial<Record<string, () => void>> = {
            note: handleNewNote,
            exam: handleNewExam,
            textbook: handleNewTextbook,
            translation: handleNewTranslation,
            essay: handleNewEssay,
            mindmap: handleNewMindMap,
          };
          if (Object.hasOwn(creators, type)) creators[type]?.();
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
        onMountToSpace={effectiveMountHandler}
        onUnmountFromCurrentFolder={effectiveUnmountHandler}
        activeMountId={activeMountInFolder?.id ?? null}
      />

      {mountPickerItem ? (
        <SpaceMountPickerDialog
          open={Boolean(mountPickerItem)}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setMountPickerItem(null);
          }}
          item={mountPickerItem}
          onMounted={() => {
            void handleRefresh();
          }}
        />
      ) : null}
    </>
  );
}
