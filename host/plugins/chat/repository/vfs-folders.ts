/** Topic-folder adapter. L11 owns all VFS SQL and cache invalidation (D1 single writer). */
import { nanoid } from 'nanoid';
import { now } from '../../../platform/time/index.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { FolderRepository, VfsFolder } from '../../vfs-repos/api.ts';
export { MAX_FOLDER_TITLE_LENGTH, MAX_FOLDER_DEPTH, MAX_FOLDERS_COUNT } from '../../vfs/portable.ts';

export interface VfsFolderRecord {
  id: string; parentId: string | null; title: string; icon: string | null; color: string | null;
  isExpanded: boolean; isFavorite: boolean; sortOrder: number; createdAt: number; updatedAt: number;
}
export function generateFolderId(): string { return `fld_${nanoid(10)}`; }
export function newVfsFolder(title: string, parentId: string | null, icon: string | null): VfsFolderRecord {
  const millis = now().millis;
  return { id: generateFolderId(), parentId, title, icon, color: null, isExpanded: true,
    isFavorite: false, sortOrder: 0, createdAt: millis, updatedAt: millis };
}
function toFolder(folder: VfsFolderRecord): VfsFolder {
  return { ...folder, parentId: folder.parentId ?? undefined, icon: folder.icon ?? undefined, color: folder.color ?? undefined };
}
export function getVfsFolder(conn: SqlExecutor, id: string, folders: FolderRepository): VfsFolderRecord | null {
  const folder = folders.getFolder(conn, id);
  return folder === null ? null : { ...folder, parentId: folder.parentId ?? null, icon: folder.icon ?? null, color: folder.color ?? null };
}
export function vfsFolderExists(conn: SqlExecutor, id: string, folders: FolderRepository): boolean {
  return folders.folderExists(conn, id);
}
export function generateUniqueFolderTitle(conn: SqlExecutor, title: string, parentId: string | null,
  excludeId: string | null, folders: FolderRepository): string {
  return folders.generateUniqueFolderTitle(conn, title, parentId, excludeId);
}
export function createVfsFolder(conn: SqlExecutor, folder: VfsFolderRecord, folders: FolderRepository): void {
  folders.createFolder(conn, toFolder(folder));
}
export function renameVfsFolder(conn: SqlExecutor, folder: VfsFolderRecord, folders: FolderRepository): void {
  folders.updateFolder(conn, toFolder(folder));
}
