// cmd/notes.rs asset commands. Base dir is the app's active data directory;
// subject normalization and path validation stay in repository/assets.ts.
import {
  AssetError, assetKeyFromRelativePath, listNoteAssets, normalizeSubject, resolveAssetPath,
  saveNoteAsset, scanOrphanAssets,
} from '../repository/assets.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { Commands } from '../../../../contracts/ipc/generated/L10-notes.ts';
import { notesLocalRuntime } from './local-runtime.ts';
import { assetFailure, errorMessage } from './command-utils.ts';

export function saveAsset(
  baseDir: string,
  subject: string | null | undefined,
  noteId: string,
  base64Data: string,
  defaultExt: string | null | undefined,
): Commands['notes_save_asset']['result'] {
  try {
    return saveNoteAsset(baseDir, normalizeSubject(subject), noteId, base64Data, defaultExt ?? 'jpg');
  } catch (error) {
    return assetFailure(error);
  }
}

export function listAssets(
  baseDir: string,
  subject: string | null | undefined,
  noteId: string,
): Commands['notes_list_assets']['result'] {
  try {
    return listNoteAssets(baseDir, normalizeSubject(subject), noteId);
  } catch (error) {
    return assetFailure(error);
  }
}

export function assetsIndexScan(
  baseDir: string,
  subject: string | null | undefined,
  noteId: string,
): number {
  try {
    return listNoteAssets(baseDir, normalizeSubject(subject), noteId).length;
  } catch (error) {
    return assetFailure(error);
  }
}

function deleteJournaled(activeDir: string, relativePath: string, phase: string): boolean {
  const key = assetKeyFromRelativePath(relativePath);
  if (key === null) throw new AssetError('validation', phase === 'bulk'
    ? `资产路径无效: ${relativePath}` : '拒绝删除：资产路径无效');
  let localPath: string;
  try {
    localPath = notesLocalRuntime().assetLocalPathFromKey(key);
  } catch (error) {
    throw new AssetError('validation', errorMessage(error));
  }
  try {
    return notesLocalRuntime().deleteAssetWithJournal(activeDir, key, localPath);
  } catch (error) {
    throw new AssetError('filesystem', phase === 'bulk'
      ? `批量删除资产安全链失败: ${errorMessage(error)}`
      : `删除资产安全链失败: ${errorMessage(error)}`);
  }
}

export function removeAsset(baseDir: string, relativePath: string): Commands['notes_delete_asset']['result'] {
  try {
    return deleteJournaled(baseDir, relativePath, 'single');
  } catch (error) {
    return assetFailure(error);
  }
}

export function removeAssets(
  baseDir: string,
  paths: readonly string[],
): Commands['notes_assets_bulk_delete']['result'] {
  try {
    let deleted = 0;
    for (const path of paths) {
      if (deleteJournaled(baseDir, path, 'bulk')) deleted += 1;
    }
    return deleted;
  } catch (error) {
    return assetFailure(error);
  }
}

export function resolveAsset(baseDir: string, relativePath: string): Commands['notes_resolve_asset_path']['result'] {
  try {
    return resolveAssetPath(baseDir, relativePath);
  } catch (error) {
    return assetFailure(error);
  }
}

export function scanOrphans(
  baseDir: string,
  subject: string | null | undefined,
  conn: SqlExecutor,
): Commands['notes_assets_scan_orphans']['result'] {
  try {
    return scanOrphanAssets(baseDir, normalizeSubject(subject), conn);
  } catch (error) {
    return assetFailure(error);
  }
}
