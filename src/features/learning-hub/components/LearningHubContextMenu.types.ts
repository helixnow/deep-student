import type { ResourceListItem } from '../types';
import type { FolderTreeNode, VfsFolderItem } from '@/dstu/types/folder';

export type ContextMenuTarget =
  | { type: 'empty' }
  | { type: 'folder'; folder: FolderTreeNode }
  | { type: 'folderItem'; item: VfsFolderItem }
  | { type: 'resource'; resource: ResourceListItem };

export interface LearningHubContextMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  position: { x: number; y: number };
  target: ContextMenuTarget;
  dataView: 'folder' | 'resource';
  currentFolderId?: string | null;
  isTrashView?: boolean;
  canCreate?: boolean;
  canDelete?: boolean;
  canMove?: boolean;
  canAddToChat?: boolean;
  onCreateFolder?: (parentId: string | null) => void;
  onCreateItem?: (type: 'note' | 'exam' | 'textbook' | 'translation' | 'essay' | 'mindmap', folderId: string | null) => void;
  onImportMarkdownNote?: (folderId: string | null) => void;
  onRefresh?: () => void;
  onOpenFolder?: (folderId: string) => void;
  onRenameFolder?: (folderId: string) => void;
  onDeleteFolder?: (folderId: string) => void;
  onOpenResource?: (resource: ResourceListItem | VfsFolderItem) => void;
  onRenameResource?: (resource: ResourceListItem) => void;
  onDeleteResource?: (resource: ResourceListItem) => void;
  onReferenceToChat?: (target: ContextMenuTarget) => void;
  onMakeCards?: (target: ContextMenuTarget) => void;
  onCopy?: (target: ContextMenuTarget) => void;
  onDuplicate?: (target: ContextMenuTarget) => void;
  onPaste?: () => void;
  pasteCount?: number;
  onMoveTo?: (target: ContextMenuTarget) => void;
  onToggleFavorite?: (resource: ResourceListItem) => void;
  onRestoreItem?: (id: string, itemType: string) => void;
  onPermanentDeleteItem?: (id: string, itemType: string) => void;
  onEmptyTrash?: () => void;
  onExportResource?: (resource: ResourceListItem) => void;
  onExportFolder?: (folderId: string) => void;
  onMountToSpace?: (target: ContextMenuTarget) => void;
  onUnmountFromCurrentFolder?: (mountId: string) => void;
  activeMountId?: string | null;
}
