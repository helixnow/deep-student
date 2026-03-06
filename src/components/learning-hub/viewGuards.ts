/**
 * Learning Hub 视图/文件夹语义辅助。
 *
 * 将真实文件夹 ID 与虚拟视图语义分离，
 * 避免在创建、导入、搜索等通用链路里误把伪视图当成真实父目录。
 */

import type { FinderPathLike, FinderViewKind } from './learningHubContracts';
import { SPECIAL_VIEW_KINDS, getViewCapabilities } from './learningHubContracts';

export const SPECIAL_VIEW_FOLDER_IDS = [
  'root',
  'trash',
  'recent',
  'favorites',
  'indexStatus',
  'memory',
  'desktop',
] as const;

export type SpecialViewFolderId = (typeof SPECIAL_VIEW_FOLDER_IDS)[number];

export function isSpecialViewFolderId(folderId: string | null | undefined): folderId is SpecialViewFolderId {
  if (!folderId) return false;
  return SPECIAL_VIEW_FOLDER_IDS.includes(folderId as SpecialViewFolderId);
}

export function isRealFolderId(folderId: string | null | undefined): folderId is string {
  return Boolean(folderId && !isSpecialViewFolderId(folderId) && folderId.startsWith('fld_'));
}

export function isSpecialViewPath(path: FinderPathLike | null | undefined): boolean {
  if (!path) return false;
  return SPECIAL_VIEW_KINDS.includes(path.viewKind);
}

export function getCreatableFolderId(pathOrFolderId: FinderPathLike | string | null | undefined): string | null {
  if (typeof pathOrFolderId === 'string' || pathOrFolderId == null) {
    return isRealFolderId(pathOrFolderId) ? pathOrFolderId : null;
  }

  if (pathOrFolderId.viewKind !== 'folder') {
    return null;
  }

  return isRealFolderId(pathOrFolderId.folderId) ? pathOrFolderId.folderId : null;
}

export function getViewKindFromFolderId(folderId: string | null | undefined): FinderViewKind {
  if (!folderId || folderId === 'root') return 'folder';
  if (folderId === 'favorites') return 'favorites';
  if (folderId === 'recent') return 'recent';
  if (folderId === 'trash') return 'trash';
  if (folderId === 'indexStatus') return 'indexStatus';
  if (folderId === 'memory') return 'memory';
  if (folderId === 'desktop') return 'desktop';
  return 'folder';
}

export function canCreateInView(path: FinderPathLike): boolean {
  return getViewCapabilities(path.viewKind).canCreate;
}

