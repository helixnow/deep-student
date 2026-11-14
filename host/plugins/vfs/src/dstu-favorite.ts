/** dstu/handlers.rs `dstu_set_favorite` (handlers.rs:4555-4832). */
import { CommandError } from '../../../kernel/api.ts';
import type { VfsDatabase } from '../api.ts';
import {
  createFolderNode,
  updatedEvent,
  withNodeMetadata,
  withNodeTimestamps,
  type DstuNode,
} from './dstu-types.ts';
import {
  essayToDstuNode,
  examToDstuNode,
  fileToDstuNode,
  mindmapToDstuNode,
  noteToDstuNode,
  sessionToDstuNode,
  textbookToDstuNode,
  translationToDstuNode,
} from './node-converters.ts';
import { emitDstuWatchEvent, type DstuCommandLog, type LocationDeps } from './locations.ts';
import { extractResourceInfo } from './path-utils.ts';
import {
  getEssaySessionWithConn,
  getEssayWithConn,
  getExamWithConn,
  getFileWithConn,
  getFolderWithConn,
  getMindmapWithConn,
  getNoteWithConn,
  getTextbookWithConn,
  getTranslationWithConn,
} from '../repository/resources.ts';
import {
  setExamFavoriteWithConn,
  setFileFavoriteWithConn,
  setFolderFavoriteWithConn,
  setMindmapFavoriteWithConn,
  setNoteFavoriteLooseWithConn,
  setTextbookFavoriteWithConn,
  setTranslationFavoriteWithConn,
  updateEssaySessionWithConn,
} from '../repository/update.ts';

export interface DstuSetFavoriteArgs {
  path: string;
  favorite: boolean;
}

export interface DstuSetFavoriteDeps extends LocationDeps {
  readonly database: VfsDatabase;
  readonly log: DstuCommandLog;
}

function command<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(error instanceof Error ? error.message : String(error));
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Rust per-branch shape (handlers.rs:4580-4820): `set_favorite` Ok→info SUCCESS /
 * Err→error FAILED; then `get_*` Ok(None)→warn not-found + "操作失败" /
 * Err→error `get_<label> error`.
 */
function favoriteBranch<T>(
  deps: DstuSetFavoriteDeps,
  args: DstuSetFavoriteArgs,
  id: string,
  labels: { type: string; notFound: string; get: string },
  set: () => void,
  get: () => T | undefined,
): T {
  try {
    set();
  } catch (error) {
    deps.log.error(
      '[DSTU::handlers] dstu_set_favorite: FAILED - type=%s, id=%s, error=%s', labels.type, id, errorText(error));
    throw error;
  }
  deps.log.info(
    '[DSTU::handlers] dstu_set_favorite: SUCCESS - type=%s, id=%s, favorite=%s', labels.type, id, args.favorite);
  let value: T | undefined;
  try {
    value = get();
  } catch (error) {
    deps.log.error(
      '[DSTU::handlers] dstu_set_favorite: FAILED - get_%s error, id=%s, error=%s', labels.get, id, errorText(error));
    throw error;
  }
  if (value === undefined) {
    deps.log.warn(
      '[DSTU::handlers] dstu_set_favorite: FAILED - %s not found after set_favorite, id=%s', labels.notFound, id);
    throw new Error('操作失败');
  }
  return value;
}

/** `dstu_set_favorite` (handlers.rs:4555-4832). Returns null on success. */
export function setFavoriteCommand(deps: DstuSetFavoriteDeps, args: DstuSetFavoriteArgs): null {
  return command(() => {
    deps.log.info('[DSTU::handlers] dstu_set_favorite: path=%s, favorite=%s', args.path, args.favorite);
    let parsed: { resourceType: string; id: string };
    try {
      parsed = extractResourceInfo(args.path);
    } catch (error) {
      deps.log.error(
        '[DSTU::handlers] dstu_set_favorite: FAILED - path=%s, error=%s', args.path, errorText(error));
      throw error;
    }
    const { resourceType, id } = parsed;
    const conn = deps.database.getConnSafe();
    const fav = args.favorite;

    let node: DstuNode;
    switch (resourceType) {
      case 'notes':
        node = noteToDstuNode(favoriteBranch(deps, args, id, { type: 'note', notFound: 'note', get: 'note' },
          () => setNoteFavoriteLooseWithConn(conn, id, fav), () => getNoteWithConn(conn, id)));
        break;
      case 'textbooks':
        node = textbookToDstuNode(favoriteBranch(deps, args, id,
          { type: 'textbook', notFound: 'textbook', get: 'textbook' },
          () => setTextbookFavoriteWithConn(conn, id, fav), () => getTextbookWithConn(conn, id)));
        break;
      case 'exams':
        node = examToDstuNode(favoriteBranch(deps, args, id, { type: 'exam', notFound: 'exam', get: 'exam_sheet' },
          () => setExamFavoriteWithConn(conn, id, fav), () => getExamWithConn(conn, id)));
        break;
      case 'folders': {
        const folder = favoriteBranch(deps, args, id, { type: 'folder', notFound: 'folder', get: 'folder' },
          () => setFolderFavoriteWithConn(conn, id, fav), () => getFolderWithConn(conn, id));
        node = withNodeMetadata(
          withNodeTimestamps(
            createFolderNode(folder.id, `/${folder.id}`, folder.title),
            folder.createdAt,
            folder.updatedAt,
          ),
          {
            isExpanded: folder.isExpanded,
            icon: folder.icon ?? null,
            color: folder.color ?? null,
          },
        );
        break;
      }
      case 'images':
      case 'files':
        node = fileToDstuNode(favoriteBranch(deps, args, id, { type: resourceType, notFound: 'file', get: 'file' },
          () => setFileFavoriteWithConn(conn, id, fav), () => getFileWithConn(conn, id)));
        break;
      case 'translations':
        node = translationToDstuNode(favoriteBranch(deps, args, id,
          { type: 'translation', notFound: 'translation', get: 'translation' },
          () => setTranslationFavoriteWithConn(conn, id, fav), () => getTranslationWithConn(conn, id)));
        break;
      case 'essays': {
        // Rust tries `update_session` first for every essay id; single-round
        // essays therefore fail with `EssaySession not found` before the
        // fallback below can run.
        try {
          updateEssaySessionWithConn(conn, id, { isFavorite: fav });
        } catch (error) {
          deps.log.error(
            '[DSTU::handlers] dstu_set_favorite: FAILED - type=essay, id=%s, error=%s', id, errorText(error));
          throw error;
        }
        deps.log.info(
          '[DSTU::handlers] dstu_set_favorite: SUCCESS - type=essay_session, id=%s, favorite=%s', id, fav);
        let session: ReturnType<typeof getEssaySessionWithConn>;
        try {
          session = getEssaySessionWithConn(conn, id);
        } catch (error) {
          deps.log.error(
            '[DSTU::handlers] dstu_set_favorite: FAILED - get_session error, id=%s, error=%s', id, errorText(error));
          throw error;
        }
        if (session !== undefined) {
          node = sessionToDstuNode(session);
        } else {
          deps.log.warn('[DSTU::handlers] dstu_set_favorite: session not found, trying essay, id=%s', id);
          let essay: ReturnType<typeof getEssayWithConn>;
          try {
            essay = getEssayWithConn(conn, id);
          } catch (error) {
            deps.log.error(
              '[DSTU::handlers] dstu_set_favorite: FAILED - get_essay error, id=%s, error=%s', id, errorText(error));
            throw error;
          }
          if (essay === undefined) {
            deps.log.warn('[DSTU::handlers] dstu_set_favorite: FAILED - essay not found, id=%s', id);
            throw new Error('操作失败');
          }
          node = essayToDstuNode(essay);
        }
        break;
      }
      case 'mindmaps':
        node = mindmapToDstuNode(favoriteBranch(deps, args, id,
          { type: 'mindmap', notFound: 'mindmap', get: 'mindmap' },
          () => setMindmapFavoriteWithConn(conn, id, fav), () => getMindmapWithConn(conn, id)));
        break;
      default:
        throw new Error(
          `Resource type '${resourceType}' does not support favorite operation`,
        );
    }

    emitDstuWatchEvent(deps, updatedEvent(args.path, node));
    deps.log.info('[DSTU::handlers] dstu_set_favorite: set %s to favorite=%s', args.path, fav);
    return null;
  });
}
