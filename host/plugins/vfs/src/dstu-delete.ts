/** dstu/handlers.rs `dstu_delete` + handler_utils/delete_helpers.rs soft delete. */
import { CommandError } from '../../../kernel/api.ts';
import type { VfsDatabase } from '../api.ts';
import { DstuFailure } from './dstu-error.ts';
import { deletedEvent } from './dstu-types.ts';
import { emitDstuWatchEvent, type DstuCommandLog, type LocationDeps } from './locations.ts';
import { extractResourceInfo, isUuidFormat } from './path-utils.ts';
import { currentDeviceId } from '../repository/create.ts';
import {
  deleteEssaySessionWithFolderItemWithConn,
  deleteEssayWithFolderItemWithConn,
  deleteExamSheetWithFolderItemWithConn,
  deleteFileWithConn,
  deleteMindmapWithConn,
  deleteNoteWithFolderItemWithConn,
  deleteTextbookWithFolderItemWithConn,
  deleteTranslationWithConn,
} from '../repository/delete.ts';
import { deleteFolderWithConn } from '../repository/folders.ts';
import { lookupDeleteResourceIdWithConn } from '../repository/trash.ts';
import type { DstuTrashDeps } from './dstu-trash.ts';
import {
  getEssayWithConn,
  getExamWithConn,
  getNoteWithConn,
  getTextbookWithConn,
  getTranslationWithConn,
} from '../repository/resources.ts';

export interface DstuDeleteDeps extends LocationDeps {
  readonly database: VfsDatabase;
  readonly log: DstuCommandLog;
  /** handlers.rs:1734-1746 background Lance cleanup after a successful delete. */
  readonly index: Pick<DstuTrashDeps['index'], 'cleanupVectors'>;
}

function command<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(error instanceof Error ? error.message : String(error));
  }
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `delete_helpers::helper_error` (delete_helpers.rs:16-25). */
function helperError(action: string, resourceType: string, id: string, error: unknown): Error {
  return new Error(
    `VFS error: ${action} failed (type=${resourceType}, id=${id}): ${failureMessage(error)}`,
  );
}

/** Rust ignores per-table lookup failures during the UUID fallback. */
function probe<T>(read: () => T | undefined): T | undefined {
  try { return read(); }
  catch (error) { void error; return undefined; }
}

/** `fallback_lookup_uuid_resource` (crud.rs:236-300); only the node type is consumed. */
function fallbackLookupUuidResource(deps: Pick<DstuDeleteDeps, 'database'>, uuidId: string): string | undefined {
  const conn = deps.database.getConnSafe();
  if (probe(() => getTextbookWithConn(conn, uuidId)) !== undefined) return 'textbooks';
  if (probe(() => getNoteWithConn(conn, uuidId)) !== undefined) return 'notes';
  if (probe(() => getExamWithConn(conn, uuidId)) !== undefined) return 'exams';
  if (probe(() => getTranslationWithConn(conn, uuidId)) !== undefined) return 'translations';
  if (probe(() => getEssayWithConn(conn, uuidId)) !== undefined) return 'essays';
  return undefined;
}

function logDeleteSuccess(deps: Pick<DstuDeleteDeps, 'log'>, type: string, id: string): void {
  deps.log.info('[DSTU::delete_helpers] delete_resource_by_type: SUCCESS - type=%s, id=%s', type, id);
}

/** `delete_resource_by_type` (delete_helpers.rs:31-141). */
export function deleteResourceByType(
  deps: Pick<DstuDeleteDeps, 'database' | 'log'>,
  resourceType: string,
  id: string,
): void {
  const conn = deps.database.getConnSafe();
  try {
    switch (resourceType) {
      case 'notes':
      case 'note':
        deleteNoteWithFolderItemWithConn(conn, id);
        logDeleteSuccess(deps, 'note', id);
        return;
      case 'textbooks':
      case 'textbook':
        deleteTextbookWithFolderItemWithConn(conn, id);
        logDeleteSuccess(deps, 'textbook', id);
        return;
      case 'translations':
      case 'translation':
        deleteTranslationWithConn(conn, id);
        logDeleteSuccess(deps, 'translation', id);
        return;
      case 'exams':
      case 'exam':
        deleteExamSheetWithFolderItemWithConn(conn, id);
        logDeleteSuccess(deps, 'exam', id);
        return;
      case 'essays':
      case 'essay':
        if (id.startsWith('essay_session_')) {
          deleteEssaySessionWithFolderItemWithConn(conn, id);
          logDeleteSuccess(deps, 'essay_session', id);
        } else {
          deleteEssayWithFolderItemWithConn(conn, id);
          logDeleteSuccess(deps, 'essay', id);
        }
        return;
      case 'folders':
      case 'folder':
        deleteFolderWithConn(conn, id, { deviceId: currentDeviceId(), log: deps.log });
        logDeleteSuccess(deps, 'folder', id);
        return;
      case 'images':
      case 'image':
      case 'files':
      case 'file':
      case 'attachments':
      case 'attachment':
        deleteFileWithConn(conn, id);
        logDeleteSuccess(deps, 'file', id);
        return;
      case 'mindmaps':
      case 'mindmap':
        deleteMindmapWithConn(conn, id);
        logDeleteSuccess(deps, 'mindmap', id);
        return;
      default:
        throw new DstuFailure('InvalidNodeType', `${resourceType} (id=${id})`);
    }
  } catch (error) {
    if (error instanceof DstuFailure) throw error;
    throw helperError('delete', resourceType, id, error);
  }
}

/** `dstu_delete` (handlers.rs:1663-1755). */
export function deleteCommand(deps: DstuDeleteDeps, path: string): null {
  return command(() => {
    deps.log.info('[DSTU::handlers] dstu_delete: path=%s', path);
    let parsed: { resourceType: string; id: string };
    try {
      parsed = extractResourceInfo(path);
    } catch (error) {
      deps.log.error('[DSTU::handlers] dstu_delete: FAILED - path=%s, error=%s', path, failureMessage(error));
      throw error;
    }
    let { resourceType } = parsed;
    const { id } = parsed;

    // UUID fallback: migrated rows may be recorded as folders but belong to
    // another table (handlers.rs:1687-1705).
    if (resourceType === 'folders' && isUuidFormat(id)) {
      const actualType = fallbackLookupUuidResource(deps, id);
      if (actualType !== undefined) {
        deps.log.info(
          '[DSTU::handlers] dstu_delete: UUID fallback found actual type=%s, id=%s', actualType, id);
        resourceType = actualType;
      }
    }

    // handlers.rs:1707-1727: resolve resource_id before deleting for vector cleanup.
    let resourceId: string | undefined;
    try {
      resourceId = lookupDeleteResourceIdWithConn(deps.database.getConnSafe(), resourceType, id);
    } catch { // boundary-allow empty-catch: Rust `get_conn_safe().ok()` skips cleanup when no connection
      resourceId = undefined;
    }

    deleteResourceByType(deps, resourceType, id);
    emitDstuWatchEvent(deps, deletedEvent(path));

    if (resourceId !== undefined) {
      const rid = resourceId;
      void deps.index.cleanupVectors([rid]).then(() =>
        deps.log.info('[DSTU::handlers] dstu_delete: cleaned up vectors for %s', rid));
    }

    deps.log.info('[DSTU::handlers] dstu_delete: deleted type=%s, id=%s', resourceType, id);
    return null;
  });
}
