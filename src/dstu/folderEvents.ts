/**
 * Client-side notification for mutations that only touch the folder tables.
 *
 * The native DSTU watch stream reports resource changes, but folder commands
 * do not currently emit equivalent events. Consumers that render a folder
 * tree can subscribe to this event and refresh their derived structure.
 */
export const DSTU_FOLDER_CHANGE_EVENT = 'dstu:folder-change' as const;

export type DstuFolderChangeKind =
  | 'folder-created'
  | 'folder-renamed'
  | 'folder-deleted'
  | 'folder-moved'
  | 'item-added'
  | 'item-removed'
  | 'item-moved'
  | 'folders-reordered'
  | 'items-reordered';

export interface DstuFolderChangeDetail {
  kind: DstuFolderChangeKind;
  folderId?: string | null;
  parentId?: string | null;
  itemId?: string;
  itemType?: string;
}

/** Publish only after the underlying native mutation has succeeded. */
export function emitDstuFolderChange(detail: DstuFolderChangeDetail): void {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
  window.dispatchEvent(new CustomEvent<DstuFolderChangeDetail>(DSTU_FOLDER_CHANGE_EVENT, { detail }));
}
