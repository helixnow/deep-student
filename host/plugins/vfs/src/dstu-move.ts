/** dstu/handlers.rs `dstu_move` (1771-1875) and `dstu_rename` (1890-2237). */
import { CommandError } from '../../../kernel/api.ts';
import { parseRfc3339 } from '../../../platform/time/index.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import type { VfsDatabase } from '../api.ts';
import { DstuFailure } from './dstu-error.ts';
import {
  createFolderNode,
  createResourceNode,
  movedEvent,
  updatedEvent,
  withNodeMetadata,
  withNodeTimestamps,
  type DstuNode,
} from './dstu-types.ts';
import { emitDstuWatchEvent, type DstuCommandLog, type LocationDeps } from './locations.ts';
import { getResourceByTypeAndId } from './dstu-resource.ts';
import {
  examToDstuNode,
  fileToDstuNode,
  noteToDstuNode,
  textbookToDstuNode,
  translationToDstuNode,
} from './node-converters.ts';
import { extractResourceInfo } from './path-utils.ts';
import { canonicalFolderItemType } from './folder-types.ts';
import {
  clearFolderItemCachedPathWithConn,
  moveItemToFolderWithConn,
  updateFolderWithConn,
} from '../repository/folders.ts';
import {
  getEssaySessionWithConn,
  getFolderWithConn,
  getTextbookWithConn,
} from '../repository/resources.ts';
import {
  updateEssaySessionWithConn,
  updateExamNameWithConn,
  updateFileNameWithConn,
  updateMindmapWithConn,
  updateTextbookFileNameWithConn,
  updateNoteWithConn,
  updateTranslationTitleWithConn,
} from '../repository/update.ts';

export interface DstuMoveDeps extends LocationDeps {
  readonly database: VfsDatabase;
  readonly log: DstuCommandLog;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function command<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(error instanceof Error ? error.message : String(error));
  }
}

/** `dstu_move` (handlers.rs:1771-1875). */
export function moveCommand(deps: DstuMoveDeps, src: string, dst: string): DstuNode {
  return command(() => {
    deps.log.info('[DSTU::handlers] dstu_move: src=%s, dst=%s', src, dst);
    let parsedSrc: { resourceType: string; id: string };
    try {
      parsedSrc = extractResourceInfo(src);
    } catch (error) {
      deps.log.error('[DSTU::handlers] dstu_move: FAILED - src=%s, error=%s', src, errorText(error));
      throw error;
    }
    const { resourceType, id: srcId } = parsedSrc;
    const itemType = (() => {
      switch (resourceType) {
        case 'notes': return 'note';
        case 'textbooks': return 'textbook';
        case 'exams': return 'exam';
        case 'translations': return 'translation';
        case 'essays': return 'essay';
        case 'folders': return 'folder';
        case 'mindmaps': return 'mindmap';
        case 'files':
        case 'images':
        case 'attachments': return 'file';
        default: throw new DstuFailure('InvalidNodeType', resourceType);
      }
    })();

    const trimmed = rustTrim(dst);
    let destFolderId: string | undefined;
    if (trimmed !== '' && trimmed !== '/') {
      let destination: { resourceType: string; id: string };
      try {
        destination = extractResourceInfo(dst);
      } catch (error) {
        deps.log.error('[DSTU::handlers] dstu_move: FAILED - dst=%s, error=%s', dst, errorText(error));
        throw error;
      }
      if (destination.resourceType !== 'folders') {
        throw new Error('Destination must be a folder');
      }
      destFolderId = destination.id;
    }

    try {
      moveItemToFolderWithConn(deps.database.getConnSafe(), itemType, srcId, destFolderId);
    } catch (error) {
      deps.log.error(
        '[DSTU::handlers] dstu_move: FAILED - type=%s, id=%s, error=%s', itemType, srcId, errorText(error),
      );
      throw error;
    }

    let node: DstuNode | null;
    try {
      node = getResourceByTypeAndId(deps, resourceType, srcId);
    } catch (error) {
      deps.log.error(
        '[DSTU::handlers] dstu_move: FAILED - get_resource error, id=%s, error=%s', srcId, errorText(error),
      );
      throw error;
    }
    if (node === null) {
      deps.log.error('[DSTU::handlers] dstu_move: FAILED - resource not found after move, id=%s', srcId);
      throw new DstuFailure('NotFound', src);
    }
    emitDstuWatchEvent(deps, movedEvent(src, node.path, node));
    deps.log.info('[DSTU::handlers] dstu_move: moved %s to %s', src, node.path);
    return node;
  });
}

/** handlers.rs:1998-2024: strict RFC3339, created→0 / updated→created fallback with warn. */
function essaySessionNode(log: DstuMoveDeps['log'], session: {
  id: string; title: string; totalRounds: number; isFavorite: boolean;
  createdAt: string; updatedAt: string;
}): DstuNode {
  let createdAt = parseRfc3339(session.createdAt)?.millis;
  if (createdAt === undefined) {
    log.warn(
      "[DSTU::handlers] Failed to parse created_at '%s': %s, using epoch fallback",
      session.createdAt, 'input contains invalid characters',
    );
    createdAt = 0;
  }
  let updatedAt = parseRfc3339(session.updatedAt)?.millis;
  if (updatedAt === undefined) {
    log.warn(
      "[DSTU::handlers] Failed to parse updated_at '%s': %s, using epoch fallback",
      session.updatedAt, 'input contains invalid characters',
    );
    updatedAt = createdAt;
  }
  const node = createResourceNode(session.id, `/${session.id}`, session.title, 'essay', session.id);
  return withNodeMetadata(
    withNodeTimestamps(node, createdAt, updatedAt),
    { totalRounds: session.totalRounds, isFavorite: session.isFavorite },
  );
}

/** Rust per-branch `match repo { Ok => info SUCCESS, Err => error FAILED; return Err }`. */
function renameStep<T>(deps: DstuMoveDeps, type: string, id: string, operation: () => T): T {
  let result: T;
  try {
    result = operation();
  } catch (error) {
    deps.log.error('[DSTU::handlers] dstu_rename: FAILED - type=%s, id=%s, error=%s', type, id, errorText(error));
    throw error;
  }
  deps.log.info('[DSTU::handlers] dstu_rename: SUCCESS - type=%s, id=%s', type, id);
  return result;
}

/** `dstu_rename` (handlers.rs:1880-2237). */
export function renameCommand(deps: DstuMoveDeps, path: string, newName: string): DstuNode {
  return command(() => {
    deps.log.info('[DSTU::handlers] dstu_rename: path=%s, new_name=%s', path, newName);
    let parsed: { resourceType: string; id: string };
    try {
      parsed = extractResourceInfo(path);
    } catch (error) {
      deps.log.error('[DSTU::handlers] dstu_rename: FAILED - path=%s, error=%s', path, errorText(error));
      throw error;
    }
    const { resourceType, id } = parsed;
    const conn = deps.database.getConnSafe();

    let node: DstuNode;
    switch (resourceType) {
      case 'notes':
        node = noteToDstuNode(renameStep(deps, 'note', id, () => updateNoteWithConn(conn, id, { title: newName })));
        break;
      case 'exams':
        node = examToDstuNode(renameStep(deps, 'exam', id, () => updateExamNameWithConn(conn, id, newName)));
        break;
      case 'essays': {
        try {
          updateEssaySessionWithConn(conn, id, { title: newName });
        } catch (error) {
          deps.log.error(
            '[DSTU::handlers] dstu_rename: FAILED - update_session error, id=%s, error=%s', id, errorText(error),
          );
          throw error;
        }
        deps.log.info('[DSTU::handlers] dstu_rename: updated essay session, id=%s', id);
        let session: ReturnType<typeof getEssaySessionWithConn>;
        try {
          session = getEssaySessionWithConn(conn, id);
        } catch (error) {
          deps.log.error(
            '[DSTU::handlers] dstu_rename: FAILED - get_session error, id=%s, error=%s', id, errorText(error),
          );
          throw error;
        }
        if (session === undefined) {
          deps.log.error('[DSTU::handlers] dstu_rename: FAILED - essay not found after rename, id=%s', id);
          throw new DstuFailure('NotFound', path);
        }
        node = essaySessionNode(deps.log, session);
        break;
      }
      case 'translations':
        node = translationToDstuNode(
          renameStep(deps, 'translation', id, () => updateTranslationTitleWithConn(conn, id, newName)),
        );
        break;
      case 'textbooks': {
        const textbook = renameStep(deps, 'textbook', id, () => {
          updateTextbookFileNameWithConn(conn, id, newName);
          const updated = getTextbookWithConn(conn, id);
          if (updated === undefined) throw new DstuFailure('NotFound', path);
          return updated;
        });
        node = textbookToDstuNode(textbook);
        break;
      }
      case 'files':
        node = fileToDstuNode(renameStep(deps, 'file', id, () => updateFileNameWithConn(conn, id, newName)));
        break;
      case 'images':
        node = fileToDstuNode(renameStep(deps, 'image', id, () => updateFileNameWithConn(conn, id, newName)));
        break;
      case 'mindmaps': {
        node = renameStep(deps, 'mindmap', id, () => {
          updateMindmapWithConn(conn, id, { title: newName }, deps.log);
          const fetched = getResourceByTypeAndId(deps, 'mindmaps', id);
          if (fetched === null) throw new DstuFailure('NotFound', path);
          return fetched;
        });
        break;
      }
      case 'folders': {
        let folder: ReturnType<typeof getFolderWithConn>;
        try {
          folder = getFolderWithConn(conn, id);
        } catch (error) {
          deps.log.error(
            '[DSTU::handlers] dstu_rename: FAILED - get_folder error, id=%s, error=%s', id, errorText(error),
          );
          throw error;
        }
        if (folder === undefined) {
          deps.log.error('[DSTU::handlers] dstu_rename: FAILED - folder not found, id=%s', id);
          throw new DstuFailure('NotFound', path);
        }
        try {
          updateFolderWithConn(conn, { ...folder, title: newName }, deps.log);
        } catch (error) {
          deps.log.error(
            '[DSTU::handlers] dstu_rename: FAILED - update_folder error, id=%s, error=%s', id, errorText(error),
          );
          throw error;
        }
        deps.log.info('[DSTU::handlers] dstu_rename: SUCCESS - type=folder, id=%s', id);
        node = withNodeMetadata(
          withNodeTimestamps(
            createFolderNode(folder.id, `/${folder.id}`, newName),
            folder.createdAt,
            folder.updatedAt,
          ),
          {
            isExpanded: folder.isExpanded,
            isFavorite: folder.isFavorite,
            icon: folder.icon ?? null,
            color: folder.color ?? null,
          },
        );
        break;
      }
      default:
        throw new DstuFailure('InvalidNodeType', resourceType);
    }

    // handlers.rs:2186-2205 clears cached_path for the canonical item type;
    // the argument is the plural resource type, so this only matches the
    // literal Rust SQL (usually a no-op) and must not fail the rename.
    try {
      clearFolderItemCachedPathWithConn(conn, id, canonicalFolderItemType(resourceType));
    } catch (error) {
      deps.log.warn(
        '[DSTU::handlers] dstu_rename: failed to clear cached_path for %s: %s',
        id,
        error instanceof Error ? error.message : String(error),
      );
    }

    emitDstuWatchEvent(deps, updatedEvent(path, node));
    deps.log.info('[DSTU::handlers] dstu_rename: renamed %s to %s (cached_path cleared)', path, newName);
    return node;
  });
}
