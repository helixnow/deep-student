/**
 * DSTU trash commands: dstu_soft_delete / dstu_trash_restore / dstu_list_trash /
 * dstu_permanently_delete / dstu_empty_trash / dstu_purge_all.
 * Rust: dstu/trash_handlers.rs and dstu/handler_utils/delete_helpers.rs.
 */
import * as path from '../../../platform/util/path.ts';
import { fs, type LocalDirent } from './local-runtime.ts';
import { CommandError } from '../../../kernel/api.ts';
import type { VfsDatabase, VfsExamSheet, VfsFile, VfsMindMap, VfsTextbook, VfsTranslation } from '../api.ts';
import type { VfsEssaySession as RepoEssaySession } from '../../vfs-repos/api.ts';
import type { VfsNote } from '../../../../contracts/ipc/generated/_shared.ts';
import type { DstuNode, DstuNodeType } from './dstu-types.ts';
import { createFolderNode, dstuNodeTypePreviewType } from './dstu-types.ts';
import { DstuFailure } from './dstu-error.ts';
import { emitDstuWatchEvent, type DstuCommandLog, type LocationDeps } from './locations.ts';
import { noteToDstuNode, textbookToDstuNode, translationToDstuNode,
  examToDstuNode, essayToDstuNode, sessionToDstuNode, fileToDstuNode, mindmapToDstuNode } from './node-converters.ts';
import type { VfsEssay } from '../api.ts';
import { parseRfc3339 } from '../../../platform/time/index.ts';
import { extractResourceInfo } from './path-utils.ts';
import {
  getMindmapWithConn,
  listDeletedMindmapsWithConn,
  purgeDeletedMindmapsWithConn,
  purgeMindmapWithConn,
  restoreMindmapWithConn,
} from '../repository/resources.ts';
import { deleteMindmapWithConn } from '../repository/delete.ts';
import {
  collectDeletedNoteIdsWithConn,
  collectDeleteManyResourceIdsWithConn,
  collectPurgeAllResourceIdsWithConn,
  collectTrashResourceIdsWithConn,
  isTrashedWithConn,
  listDeletedIdsWithConn,
  listNoteIdsInFolderTreeWithConn,
  listSessionEssayResourceIdsWithConn,
  lookupResourceIdWithConn,
} from '../repository/trash.ts';
import { notesRepository, vfsRepositories } from '../repository/services.ts';

export interface DstuTrashDeps extends LocationDeps {
  readonly database: VfsDatabase;
  readonly log: DstuCommandLog;
  /** Required L12 vfsIndex hooks, resolved from the plugin's declared injection. */
  readonly index: {
    cleanup(resourceId: string): Promise<void>;
    /** Rust background task: `let _ = delete_by_resource("text"|"multimodal", rid)` per id; caller logs. */
    cleanupVectors(resourceIds: readonly string[]): Promise<void>;
  };
}

function command<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(error instanceof Error ? error.message : String(error));
  }
}

/** Commands whose Rust error type is `DstuError` reject with its serde object. */
function commandDstu<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CommandError) throw error;
    if (error instanceof DstuFailure) throw new CommandError(error.toJSON());
    throw new CommandError({ type: 'Internal', message: failureMessage(error) });
  }
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `helper_error` (delete_helpers.rs:16-25). */
function helperError(action: string, resourceType: string, id: string, error: unknown): Error {
  return new Error(`VFS error: ${action} failed (type=${resourceType}, id=${id}): ${failureMessage(error)}`);
}

function invalidType(resourceType: string, id: string): DstuFailure {
  return new DstuFailure('InvalidNodeType', `${resourceType} (id=${id})`);
}

function unknownItemType(itemType: string): DstuFailure {
  return new DstuFailure('InvalidPath', `Unknown item type: ${itemType}`);
}

function beginImmediate<T>(deps: DstuTrashDeps, operation: (conn: ReturnType<VfsDatabase['getConnSafe']>) => T): T {
  const conn = deps.database.getConnSafe();
  conn.exec('BEGIN IMMEDIATE');
  try {
    const value = operation(conn);
    conn.exec('COMMIT');
    return value;
  } catch (error) {
    try { conn.exec('ROLLBACK'); }
    catch (rollbackError) { // boundary-allow empty-catch: Rust `let _ = conn.execute("ROLLBACK")` 忽略回滚失败
      void rollbackError;
    }
    throw error;
  }
}

function rfc3339Millis(value: string | null | undefined, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  return parseRfc3339(value)?.millis ?? fallback;
}

/** `lookup_resource_id` (trash_handlers.rs:30-50). */
function lookupResourceId(deps: DstuTrashDeps, itemType: string, itemId: string): string | undefined {
  try { return lookupResourceIdWithConn(deps.database.getConnSafe(), itemType, itemId); }
  catch { return undefined; }
}

function cleanupVectorIndex(deps: DstuTrashDeps, resourceId: string): void {
  void deps.index.cleanup(resourceId).catch((error: unknown) => {
    deps.log.warn(
      '[DSTU::trash] Failed to clean up full index for %s: %s',
      resourceId,
      failureMessage(error),
    );
  });
}

/** `mark_resource_pending_after_restore` (trash_handlers.rs:91-108). */
function markResourcePendingAfterRestore(deps: DstuTrashDeps, itemType: string, itemId: string): void {
  const resourceId = lookupResourceId(deps, itemType, itemId);
  if (resourceId === undefined) return;
  try {
    vfsRepositories().indexStates.markPending(deps.database.getConnSafe(), resourceId);
  } catch (error) {
    deps.log.warn(
      '[DSTU::trash] Failed to mark restored resource %s pending: %s',
      resourceId,
      failureMessage(error),
    );
  }
}

/** `delete_resource_by_type_with_conn` (delete_helpers.rs:118-173) for batch commands. */
export function deleteResourceByTypeWithConn(
  deps: DstuTrashDeps,
  conn: ReturnType<VfsDatabase['getConnSafe']>,
  resourceType: string,
  id: string,
): void {
  // Rust wraps note/textbook failures with helper_error and surfaces the other
  // repositories' Display text verbatim (delete_helpers.rs:118-172).
  const wrapsError = resourceType === 'notes' || resourceType === 'note'
    || resourceType === 'textbooks' || resourceType === 'textbook';
  try {
    switch (resourceType) {
      case 'notes':
      case 'note':
        notesRepository().deleteNote(id, conn);
        return;
      case 'textbooks':
      case 'textbook':
        vfsRepositories().textbooks.deleteTextbook(conn, id);
        return;
      case 'translations':
      case 'translation':
        vfsRepositories().translations.deleteTranslation(conn, id);
        return;
      case 'exams':
      case 'exam':
        vfsRepositories().exams.deleteExamSheet(conn, id);
        return;
      case 'essays':
      case 'essay':
        if (id.startsWith('essay_session_')) {
          vfsRepositories().essays.deleteSessionWithFolderItem(conn, id);
        } else {
          vfsRepositories().essays.deleteEssay(conn, id);
        }
        return;
      case 'folders':
      case 'folder':
        vfsRepositories().folders.deleteFolder(conn, id);
        return;
      case 'images':
      case 'image':
      case 'files':
      case 'file':
      case 'attachments':
      case 'attachment':
        vfsRepositories().files.deleteFile(conn, id);
        return;
      case 'mindmaps':
      case 'mindmap':
        deleteMindmapWithConn(conn, id);
        return;
      default:
        throw invalidType(resourceType, id);
    }
  } catch (error) {
    if (error instanceof DstuFailure) throw error;
    throw wrapsError
      ? helperError('delete_with_conn', resourceType, id, error)
      : new Error(failureMessage(error));
  }
}

/** `restore_resource_by_type_with_conn` (delete_helpers.rs:407-455). */
export function restoreResourceByTypeWithConn(
  deps: DstuTrashDeps,
  conn: ReturnType<VfsDatabase['getConnSafe']>,
  resourceType: string,
  id: string,
  action: 'restore' | 'restore_with_conn' = 'restore_with_conn',
): void {
  try {
    switch (resourceType) {
      case 'notes':
      case 'note':
        notesRepository().restoreNote(id, conn);
        return;
      case 'textbooks':
      case 'textbook':
        vfsRepositories().textbooks.restoreTextbook(conn, id);
        return;
      case 'translations':
      case 'translation':
        vfsRepositories().translations.restoreTranslation(conn, id);
        return;
      case 'exams':
      case 'exam':
        vfsRepositories().exams.restoreExam(conn, id);
        return;
      case 'essays':
      case 'essay':
        if (id.startsWith('essay_session_')) {
          vfsRepositories().essays.restoreSession(conn, id);
        } else {
          vfsRepositories().essays.restoreEssay(conn, id);
        }
        return;
      case 'folders':
      case 'folder':
        vfsRepositories().folders.restoreFolder(conn, id);
        return;
      case 'images':
      case 'image':
      case 'files':
      case 'file':
      case 'attachments':
      case 'attachment':
        vfsRepositories().files.restoreFile(conn, id);
        return;
      case 'mindmaps':
      case 'mindmap':
        restoreMindmapWithConn(conn, id);
        return;
      default:
        throw invalidType(resourceType, id);
    }
  } catch (error) {
    if (error instanceof DstuFailure) throw error;
    if (['note', 'notes', 'textbook', 'textbooks'].includes(resourceType)) {
      throw helperError(action, resourceType, id, error);
    }
    throw error;
  }
}

/** `restore_resource_by_type` (delete_helpers.rs:355-402). */
function restoreResourceByType(deps: DstuTrashDeps, resourceType: string, id: string): void {
  restoreResourceByTypeWithConn(deps, deps.database.getConnSafe(), resourceType, id, 'restore');
}

/** `purge_resource_by_type_if_trashed` (delete_helpers.rs:239-352). */
function purgeResourceByTypeIfTrashed(deps: DstuTrashDeps, resourceType: string, id: string): void {
  beginImmediate(deps, (conn) => {
    const trashed = isTrashedWithConn(conn, resourceType, id);
    if (trashed === undefined) throw invalidType(resourceType, id);
    if (!trashed) {
      throw new Error(
        `资源 ${id} (type=${resourceType}) 不在回收站中，无法永久删除。请先将其移到回收站。`,
      );
    }

    try {
      switch (resourceType) {
        case 'notes':
        case 'note':
          notesRepository().purgeNote(id, conn);
          break;
        case 'textbooks':
        case 'textbook':
          vfsRepositories().textbooks.purgeTextbookWithConn(conn, id, deps.database.blobsDir());
          break;
        case 'translations':
        case 'translation':
          vfsRepositories().translations.purgeTranslation(conn, id);
          break;
        case 'exams':
        case 'exam':
          vfsRepositories().exams.purgeExamSheetWithConn(conn, id);
          break;
        case 'essays':
        case 'essay':
          if (id.startsWith('essay_session_')) {
            vfsRepositories().essays.purgeSessionWithConn(conn, id);
          } else {
            vfsRepositories().essays.purgeEssayWithConn(conn, id);
          }
          break;
        case 'folders':
        case 'folder':
          vfsRepositories().folders.purgeFolder(conn, id, deps.database.blobsDir());
          break;
        case 'images':
        case 'image':
        case 'files':
        case 'file':
        case 'attachments':
        case 'attachment':
          vfsRepositories().files.purgeFileWithConn(conn, id, deps.database.blobsDir());
          break;
        case 'mindmaps':
        case 'mindmap':
          purgeMindmapWithConn(conn, id);
          break;
        default:
          throw invalidType(resourceType, id);
      }
    } catch (error) {
      if (error instanceof DstuFailure) throw error;
      throw helperError('purge', resourceType, id, error);
    }
  });

  if (['textbooks', 'textbook', 'exams', 'exam', 'folders', 'folder',
    'images', 'image', 'files', 'file', 'attachments', 'attachment'].includes(resourceType)) {
    try {
      vfsRepositories().blobs.cleanupUnreferenced(deps.database.getConnSafe(), deps.database.blobsDir());
    } catch (error) {
      deps.log.warn(
        '[DSTU::delete_helpers] Post-purge blob sweep failed (will retry later): %s',
        failureMessage(error),
      );
    }
  }
}

/** `cleanup_note_asset_dirs` (trash_handlers.rs:589-635). */
function cleanupNoteAssetDirs(
  log: DstuTrashDeps['log'],
  appDataDir: string,
  noteIds: readonly string[],
): void {
  if (noteIds.length === 0) return;
  const notesAssetsRoot = path.join(appDataDir, 'notes_assets');
  let baseDir: string;
  try {
    if (!fs.statSync(notesAssetsRoot).isDirectory()) return;
    baseDir = fs.realpathSync(notesAssetsRoot);
  } catch {
    return;
  }
  let subjects: LocalDirent[];
  try { subjects = fs.readdirDirentsSync(notesAssetsRoot); }
  catch { return; }
  for (const subject of subjects) {
    if (!subject.isDirectory()) continue;
    const subjectPath = path.join(notesAssetsRoot, subject.name);
    for (const noteId of noteIds) {
      if (noteId === '' || noteId.includes('/') || noteId.includes('\\') || noteId.includes('..')) {
        continue;
      }
      const dir = path.join(subjectPath, noteId);
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
        const canonical = fs.realpathSync(dir);
        if (!(canonical === baseDir || canonical.startsWith(`${baseDir}${path.sep}`))) continue;
        if (!fs.statSync(canonical).isDirectory()) continue;
        fs.rmSync(canonical, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        log.warn(`[DSTU::trash] Failed to remove note assets dir ${dir}: ${failureMessage(error)}`);
      }
    }
  }
}

/** `wants_trash_type` (trash_handlers.rs:548-562). */
function wantsTrashType(filter: ReadonlySet<string> | undefined, typeName: string): boolean {
  if (filter === undefined) return true;
  for (const value of filter) {
    if (value === typeName || value === `${typeName}s`) return true;
    if (typeName === 'file'
      && (value === 'image' || value === 'images' || value === 'attachment' || value === 'attachments')) {
      return true;
    }
    if (typeName === 'textbook' && value === 'textbooks') return true;
  }
  return false;
}

function resourceNode(
  id: string,
  name: string,
  type: DstuNodeType,
  resourceId: string,
  createdAt: number,
  updatedAt: number,
  size?: number,
): DstuNode {
  return {
    id,
    sourceId: id,
    path: `/_trash/${id}`,
    name,
    type,
    ...(size === undefined ? {} : { size }),
    createdAt,
    updatedAt,
    resourceId,
    previewType: dstuNodeTypePreviewType(type),
  };
}

/** `dstu_list_trash` / `list_trash_with_db` (trash_handlers.rs:238-546). */
export function listTrashCommand(
  deps: DstuTrashDeps,
  limit: number | null | undefined,
  offset: number | null | undefined,
  itemTypes: readonly string[] | null | undefined,
): DstuNode[] {
  return commandDstu(() => {
    const effectiveLimit = limit ?? 100;
    const effectiveOffset = offset ?? 0;
    const filter = itemTypes === null || itemTypes === undefined
      ? undefined
      : new Set(itemTypes.map(value => value.toLowerCase()));
    const conn = deps.database.getConnSafe();
    const pageLimit = effectiveLimit + effectiveOffset;
    const nodes: DstuNode[] = [];

    try {
    if (wantsTrashType(filter, 'folder')) {
      for (const folder of vfsRepositories().folders.listDeletedFolders(conn, pageLimit, 0)) {
        nodes.push({
          id: folder.id,
          sourceId: folder.id,
          path: `/_trash/${folder.id}`,
          name: folder.title,
          type: 'folder',
          createdAt: folder.createdAt,
          updatedAt: folder.updatedAt,
          previewType: 'none',
        });
      }
    }

    if (wantsTrashType(filter, 'note')) {
      for (const note of notesRepository().listDeletedNotes(pageLimit, 0, conn)) {
        nodes.push(resourceNode(
          note.id,
          note.title,
          'note',
          note.resourceId,
          rfc3339Millis(note.createdAt),
          rfc3339Millis(note.updatedAt),
        ));
      }
    }

    if (wantsTrashType(filter, 'textbook')) {
      for (const textbook of vfsRepositories().textbooks.listDeletedTextbooks(conn, pageLimit, 0)) {
        nodes.push(resourceNode(
          textbook.id,
          textbook.fileName,
          'textbook',
          textbook.resourceId ?? textbook.id,
          rfc3339Millis(textbook.createdAt),
          rfc3339Millis(textbook.updatedAt),
          textbook.size,
        ));
      }
    }

    if (wantsTrashType(filter, 'exam')) {
      for (const exam of vfsRepositories().exams.listDeletedExams(conn, pageLimit, 0)) {
        nodes.push(resourceNode(
          exam.id,
          exam.examName ?? '未命名题目集',
          'exam',
          exam.id,
          rfc3339Millis(exam.createdAt),
          rfc3339Millis(exam.updatedAt),
        ));
      }
    }

    if (wantsTrashType(filter, 'translation')) {
      for (const translation of vfsRepositories().translations.listDeletedTranslations(conn, pageLimit, 0)) {
        const createdAt = rfc3339Millis(translation.createdAt);
        nodes.push(resourceNode(
          translation.id,
          translation.title ?? '未命名翻译',
          'translation',
          translation.resourceId,
          createdAt,
          rfc3339Millis(translation.updatedAt, createdAt),
        ));
      }
    }

    if (wantsTrashType(filter, 'essay')) {
      for (const session of vfsRepositories().essays.listDeletedSessions(conn, pageLimit, 0)) {
        nodes.push(resourceNode(
          session.id,
          session.title,
          'essay',
          session.id,
          rfc3339Millis(session.created_at),
          rfc3339Millis(session.updated_at),
        ));
      }
    }

    if (wantsTrashType(filter, 'file')) {
      for (const file of vfsRepositories().files.listDeletedFiles(conn, pageLimit, 0)) {
        nodes.push(resourceNode(
          file.id,
          file.fileName,
          file.fileType === 'image' ? 'image' : 'file',
          file.resourceId ?? file.id,
          rfc3339Millis(file.createdAt),
          rfc3339Millis(file.updatedAt),
          file.size,
        ));
      }
    }

    if (wantsTrashType(filter, 'mindmap')) {
      for (const mindmap of listDeletedMindmapsWithConn(conn, pageLimit, 0)) {
        nodes.push(resourceNode(
          mindmap.id,
          mindmap.title,
          'mindmap',
          mindmap.resourceId === '' ? mindmap.id : mindmap.resourceId,
          rfc3339Millis(mindmap.createdAt),
          rfc3339Millis(mindmap.updatedAt),
        ));
      }
    }

    } catch (error) {
      if (error instanceof DstuFailure) throw error;
      throw new DstuFailure('VfsError', failureMessage(error));
    }

    nodes.sort((left, right) => right.updatedAt - left.updatedAt);
    return effectiveOffset < nodes.length
      ? nodes.slice(effectiveOffset, effectiveOffset + effectiveLimit)
      : [];
  });
}

/** `dstu_soft_delete` (trash_handlers.rs:114-177). */
export function softDeleteCommand(deps: DstuTrashDeps, id: string, itemType: string): null {
  return commandDstu(() => {
    try {
      switch (itemType) {
        case 'folder': vfsRepositories().folders.deleteFolder(deps.database.getConnSafe(), id); break;
        case 'note': notesRepository().deleteNote(id, deps.database.getConnSafe()); break;
        case 'textbook': vfsRepositories().textbooks.deleteTextbook(deps.database.getConnSafe(), id); break;
        case 'exam': vfsRepositories().exams.deleteExamSheet(deps.database.getConnSafe(), id); break;
        case 'translation': vfsRepositories().translations.deleteTranslation(deps.database.getConnSafe(), id); break;
        case 'essay': vfsRepositories().essays.deleteSession(deps.database.getConnSafe(), id); break;
        case 'image':
        case 'file': vfsRepositories().files.deleteFile(deps.database.getConnSafe(), id); break;
        case 'mindmap': deleteMindmapWithConn(deps.database.getConnSafe(), id); break;
        default:
          deps.log.warn('[DSTU::trash] Unknown item type for soft delete: %s', itemType);
          throw unknownItemType(itemType);
      }
    } catch (error) {
      if (error instanceof DstuFailure) throw error;
      throw new DstuFailure('VfsError', failureMessage(error));
    }

    const resourceId = lookupResourceId(deps, itemType, id);
    if (resourceId !== undefined) cleanupVectorIndex(deps, resourceId);
    emitDstuWatchEvent(deps, { type: 'deleted', path: `/${itemType}s/${id}` });
    return null;
  });
}

/** `dstu_trash_restore` (trash_handlers.rs:181-231). */
export function trashRestoreCommand(deps: DstuTrashDeps, id: string, itemType: string): null {
  return commandDstu(() => {
    try {
      switch (itemType) {
        case 'folder': vfsRepositories().folders.restoreFolder(deps.database.getConnSafe(), id); break;
        case 'note': notesRepository().restoreNote(id, deps.database.getConnSafe()); break;
        case 'textbook': vfsRepositories().textbooks.restoreTextbook(deps.database.getConnSafe(), id); break;
        case 'exam': vfsRepositories().exams.restoreExam(deps.database.getConnSafe(), id); break;
        case 'translation': vfsRepositories().translations.restoreTranslation(deps.database.getConnSafe(), id); break;
        case 'essay': vfsRepositories().essays.restoreSession(deps.database.getConnSafe(), id); break;
        case 'image':
        case 'file': vfsRepositories().files.restoreFile(deps.database.getConnSafe(), id); break;
        case 'mindmap': restoreMindmapWithConn(deps.database.getConnSafe(), id); break;
        default:
          deps.log.warn('[DSTU::trash] Unknown item type for restore: %s', itemType);
          throw unknownItemType(itemType);
      }
    } catch (error) {
      if (error instanceof DstuFailure) throw error;
      throw new DstuFailure('VfsError', failureMessage(error));
    }
    markResourcePendingAfterRestore(deps, itemType, id);
    emitDstuWatchEvent(deps, { type: 'restored', path: `/_trash/${id}` });
    return null;
  });
}

/** `dstu_permanently_delete` (trash_handlers.rs:799-917). */
export function permanentlyDeleteCommand(deps: DstuTrashDeps, id: string, itemType: string): null {
  return commandDstu(() => {
    const conn = deps.database.getConnSafe();
    const resourceId = lookupResourceId(deps, itemType, id);
    const sessionEssayResourceIds = itemType === 'essay' && id.startsWith('essay_session_')
      ? listSessionEssayResourceIdsWithConn(conn, id)
      : [];
    const noteIdsToCleanup = itemType === 'note' || itemType === 'notes'
      ? [id]
      : itemType === 'folder' || itemType === 'folders'
        ? listNoteIdsInFolderTreeWithConn(conn, id)
        : [];

    try {
      purgeResourceByTypeIfTrashed(deps, itemType, id);
    } catch (error) {
      if (error instanceof DstuFailure) throw error;
      throw new DstuFailure('VfsError', failureMessage(error));
    }

    cleanupNoteAssetDirs(deps.log, deps.database.appDataDir(), noteIdsToCleanup);
    if (resourceId !== undefined) cleanupVectorIndex(deps, resourceId);
    for (const childResourceId of sessionEssayResourceIds) cleanupVectorIndex(deps, childResourceId);
    emitDstuWatchEvent(deps, { type: 'purged', path: `/_trash/${id}` });
    return null;
  });
}

/** `dstu_purge` (handlers.rs:4460-4533). Errors are returned as plain strings. */
export function purgeCommand(deps: DstuTrashDeps, path: string): null {
  return command(() => {
    const { resourceType, id } = extractResourceInfo(path);
    let resourceId: string | undefined;
    try {
      [resourceId] = collectDeleteManyResourceIdsWithConn(deps.database.getConnSafe(), [{ resourceType, id }]);
    } catch { // boundary-allow empty-catch: handlers.rs:4482 uses get_conn_safe().ok() and query_row().ok()
      resourceId = undefined;
    }
    try {
      purgeResourceByTypeIfTrashed(deps, resourceType, id);
    } catch (error) {
      if (error instanceof DstuFailure) throw new Error(error.message);
      throw error;
    }
    emitDstuWatchEvent(deps, { type: 'purged', path });
    if (resourceId !== undefined) {
      void deps.index.cleanupVectors([resourceId]).then(() =>
        deps.log.info('[DSTU::handlers] dstu_purge: cleaned up vectors for %s', resourceId));
    }
    return null;
  });
}

/** `dstu_empty_trash` (trash_handlers.rs:642-795). */
export function emptyTrashCommand(deps: DstuTrashDeps, itemTypes: readonly string[] | null | undefined): number {
  return commandDstu(() => {
    const filter = itemTypes === null || itemTypes === undefined
      ? undefined
      : new Set(itemTypes.map(value => value.toLowerCase()));
    const conn = deps.database.getConnSafe();
    const blobsDir = deps.database.blobsDir();
    const appDataDir = deps.database.appDataDir();

    const resourceIdsToCleanup = collectTrashResourceIdsWithConn(conn);
    const noteIdsToCleanup = collectDeletedNoteIdsWithConn(conn);

    const totalDeleted = beginImmediate(deps, (tx) => {
      let total = 0;
      const sep = (operation: () => number): void => {
        try { total += operation(); }
        catch (error) { throw new DstuFailure('VfsError', failureMessage(error)); }
      };
      if (wantsTrashType(filter, 'folder')) {
        sep(() => vfsRepositories().folders.purgeDeletedFolders(tx, blobsDir));
      }
      if (wantsTrashType(filter, 'note')) {
        sep(() => notesRepository().purgeDeletedNotes(tx));
      }
      if (wantsTrashType(filter, 'exam')) {
        sep(() => {
          let count = 0;
          for (const id of listDeletedIdsWithConn(tx, 'exam_sheets')) {
            vfsRepositories().exams.purgeExamSheetWithConn(tx, id);
            count += 1;
          }
          return count;
        });
      }
      if (wantsTrashType(filter, 'translation')) {
        sep(() => {
          let count = 0;
          for (const id of listDeletedIdsWithConn(tx, 'translations')) {
            vfsRepositories().translations.purgeTranslation(tx, id);
            count += 1;
          }
          return count;
        });
      }
      if (wantsTrashType(filter, 'essay')) {
        sep(() => {
          let count = 0;
          for (const id of listDeletedIdsWithConn(tx, 'essay_sessions')) {
            vfsRepositories().essays.purgeSessionWithConn(tx, id);
            count += 1;
          }
          return count;
        });
      }
      if (wantsTrashType(filter, 'textbook')) {
        sep(() => vfsRepositories().textbooks.purgeDeletedTextbooks(tx, blobsDir));
      }
      if (wantsTrashType(filter, 'file')) {
        sep(() => vfsRepositories().files.purgeDeletedFiles(tx, blobsDir));
      }
      if (wantsTrashType(filter, 'mindmap')) {
        sep(() => purgeDeletedMindmapsWithConn(tx));
      }
      return total;
    });

    try {
      vfsRepositories().blobs.cleanupUnreferenced(conn, blobsDir);
    } catch (error) {
      deps.log.warn('[DSTU::trash] dstu_empty_trash: post-purge blob sweep failed: %s', failureMessage(error));
    }
    cleanupNoteAssetDirs(deps.log, appDataDir, noteIdsToCleanup);

    if (totalDeleted > 0) emitDstuWatchEvent(deps, { type: 'purged', path: '/_trash' });
    for (const resourceId of resourceIdsToCleanup) cleanupVectorIndex(deps, resourceId);
    return totalDeleted;
  });
}

/** `dstu_purge_all` (handlers.rs:5142-5238). */
export function purgeAllCommand(deps: DstuTrashDeps, resourceType: string): number {
  return command(() => {
    const conn = deps.database.getConnSafe();
    const resourceIdsToCleanup = collectPurgeAllResourceIdsWithConn(conn, resourceType);

    let count: number;
    try {
      if (resourceType === 'notes') {
        count = notesRepository().purgeDeletedNotes(conn);
      } else if (resourceType === 'textbooks') {
        count = vfsRepositories().textbooks.purgeDeletedTextbooks(conn, deps.database.blobsDir());
      } else {
        throw new Error(`Resource type '${resourceType}' does not support purge_all operation`);
      }
    } catch (error) {
      if (error instanceof DstuFailure) throw error;
      throw new DstuFailure('VfsError', failureMessage(error));
    }

    emitDstuWatchEvent(deps, { type: 'purged', path: `/${resourceType}/_trash` });
    if (resourceIdsToCleanup.length > 0) {
      void deps.index.cleanupVectors(resourceIdsToCleanup).then(() => deps.log.info(
        '[DSTU::handlers] dstu_purge_all: cleaned up vectors for %s resources', resourceIdsToCleanup.length));
    }
    return count;
  });
}

/** `dstu_restore` (handlers.rs:4235-4458). */
export function restoreCommand(deps: DstuTrashDeps, path: string): DstuNode {
  return command(() => {
    const { resourceType, id } = extractResourceInfo(path);
    try {
      restoreResourceByType(deps, resourceType, id);
    } catch (error) {
      if (error instanceof DstuFailure) throw error;
      throw new Error(failureMessage(error));
    }
    const node = fetchRestoredNode(deps, resourceType, id, path);
    emitDstuWatchEvent(deps, { type: 'restored', path, ...(node === undefined ? {} : { node }) });
    if (node === undefined) {
      throw new Error(`Resource restored but failed to retrieve node info: ${path}`);
    }
    return node;
  });
}

function fetchRestoredNode(
  deps: DstuTrashDeps,
  resourceType: string,
  id: string,
  path: string,
): DstuNode | undefined {
  const conn = deps.database.getConnSafe();
  try {
    switch (resourceType) {
      case 'notes':
      case 'note': {
        const note = notesRepository().getNote(id, conn);
        return note === null ? undefined : noteNode(note, path);
      }
      case 'textbooks':
      case 'textbook': {
        const textbook = vfsRepositories().textbooks.getTextbook(conn, id);
        return textbook === null ? undefined : textbookNode(textbook, path);
      }
      case 'translations':
      case 'translation': {
        const translation = vfsRepositories().translations.getTranslation(conn, id);
        return translation === null ? undefined : translationNode(translation, path);
      }
      case 'exams':
      case 'exam': {
        const exam = vfsRepositories().exams.getExamSheet(conn, id);
        return exam === null ? undefined : examNode(exam, path);
      }
      case 'essays':
      case 'essay': {
        if (id.startsWith('essay_session_')) {
          const session = vfsRepositories().essays.getSession(conn, id);
          return session === null ? undefined : sessionNode(session, path);
        }
        const essay = vfsRepositories().essays.getEssay(conn, id);
        return essay === null ? undefined : essayNode(essay, path);
      }
      case 'folders':
      case 'folder': {
        const folder = vfsRepositories().folders.getFolder(conn, id);
        return folder === null ? undefined : createFolderNode(folder.id, path, folder.title);
      }
      case 'images':
      case 'image':
      case 'files':
      case 'file':
      case 'attachments':
      case 'attachment': {
        const file = vfsRepositories().files.getFile(conn, id);
        return file === null ? undefined : fileNode(file, path);
      }
      case 'mindmaps':
      case 'mindmap': {
        const mindmap = getMindmapNode(conn, id);
        return mindmap === undefined ? undefined : mindmapNode(mindmap, path);
      }
      default:
        return undefined;
    }
  } catch (error) {
    deps.log.warn('[DSTU::handlers] dstu_restore: get node error, id=%s, error=%s', id, failureMessage(error));
    return undefined;
  }
}

/** `dstu_restore_many` (handlers.rs:5428-5529). */
export function restoreManyCommand(deps: DstuTrashDeps, paths: readonly string[]): number {
  return command(() => {
    const MAX_BATCH_SIZE = 100;
    if (paths.length > MAX_BATCH_SIZE) {
      throw new Error(`批量操作数量超出限制：最多允许 ${MAX_BATCH_SIZE} 个，实际 ${paths.length} 个`);
    }
    if (paths.length === 0) return 0;
    const restored = beginImmediate(deps, (conn) => {
      const done: string[] = [];
      for (const path of paths) {
        let parsed: { resourceType: string; id: string };
        try {
          parsed = extractResourceInfo(path);
        } catch (error) {
          throw new Error(`路径解析失败 (${path}): ${failureMessage(error)}`);
        }
        try {
          restoreResourceByTypeWithConn(deps, conn, parsed.resourceType, parsed.id);
        } catch (error) {
          throw new Error(
            `恢复失败 (type=${parsed.resourceType}, id=${parsed.id}): ${failureMessage(error)}`,
          );
        }
        done.push(path);
      }
      return done;
    });
    for (const path of restored) emitDstuWatchEvent(deps, { type: 'restored', path });
    return restored.length;
  });
}

/** Shared node mappers used by restore. */
function noteNode(note: VfsNote, _path: string): DstuNode { return noteToDstuNode(note); }
function textbookNode(textbook: VfsTextbook, path: string): DstuNode {
  return textbookToDstuNode(textbook);
}
function translationNode(translation: VfsTranslation, path: string): DstuNode {
  return translationToDstuNode(translation);
}
function examNode(exam: VfsExamSheet, path: string): DstuNode {
  return examToDstuNode(exam);
}
function essayNode(essay: VfsEssay, path: string): DstuNode {
  return essayToDstuNode(essay);
}
function sessionNode(session: RepoEssaySession, path: string): DstuNode {
  return sessionToDstuNode({ id: session.id, title: session.title, essayType: session.essay_type,
    gradeLevel: session.grade_level, totalRounds: session.total_rounds, latestScore: session.latest_score,
    isFavorite: session.is_favorite, createdAt: session.created_at, updatedAt: session.updated_at });
}
function fileNode(file: VfsFile, path: string): DstuNode {
  return fileToDstuNode(file);
}
function getMindmapNode(conn: ReturnType<VfsDatabase['getConnSafe']>, id: string): VfsMindMap | undefined {
  return getMindmapWithConn(conn, id);
}
function mindmapNode(mindmap: VfsMindMap, path: string): DstuNode {
  return mindmapToDstuNode(mindmap);
}
