/** dstu/handlers.rs `dstu_set_metadata` (handlers.rs:3349-4225). */
import { CommandError } from '../../../kernel/api.ts';
import type { VfsDatabase } from '../api.ts';
import { DstuFailure } from './dstu-error.ts';
import { getFileNode } from './dstu-get.ts';
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
import { emitDstuWatchEvent, type LocationDeps } from './locations.ts';
import { inferResourceTypeFromId } from './path-utils.ts';
import { canonicalFolderItemType } from './folder-types.ts';
import { parseSerdeJson } from '../repository/json.ts';
import {
  clearFolderItemCachedPathWithConn,
  getFolderItemByCachedPathWithConn,
  getFolderWithConn,
  updateFolderWithConn,
} from '../repository/folders.ts';
import {
  getEssaySessionWithConn,
  getEssayWithConn,
  getExamWithConn,
  getFileWithConn,
  getMindmapWithConn,
  getTextbookWithConn,
  getTranslationWithConn,
} from '../repository/resources.ts';
import {
  getTranslationContentWithConn,
  replaceTextbookBookmarksIfVersion,
  replaceTextbookHighlightsIfVersion,
  setEssayFavoriteLooseWithConn,
  setExamFavoriteWithConn,
  setFileFavoriteWithConn,
  setMindmapFavoriteWithConn,
  setTextbookFavoriteWithConn,
  setTranslationFavoriteWithConn,
  setTranslationQualityRatingWithConn,
  updateEssayFieldLooseWithConn,
  updateEssaySessionWithConn,
  updateEssayTitleWithConn,
  updateExamNameWithConn,
  updateFileNameWithConn,
  updateMindmapWithConn,
  updateNoteMetadataWithConn,
  updateTextbookBookmarksWithConn,
  updateTextbookFileNameWithConn,
  updateTextbookReadingProgressWithConn,
  updateTranslationContentWithConn,
  type NoteMetadataUpdate,
} from '../repository/update.ts';

export interface DstuSetMetadataArgs {
  path: string;
  metadata: unknown;
  expectedUpdatedAt?: string | null;
}

export interface DstuSetMetadataDeps extends LocationDeps {
  readonly database: VfsDatabase;
  /** Rust `Window::emit` for `pdf-annotations:changed`. */
  readonly emitToWindow?: (event: string, payload: unknown) => void;
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

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** serde_json `Value::get`; non-object containers yield None. */
function field(metadata: unknown, key: string): unknown {
  return asObject(metadata)?.[key];
}

function hasField(metadata: unknown, key: string): boolean {
  const object = asObject(metadata);
  return object !== undefined && Object.hasOwn(object, key);
}

function stringField(metadata: unknown, key: string): string | undefined {
  const value = field(metadata, key);
  return typeof value === 'string' ? value : undefined;
}

function boolField(metadata: unknown, key: string): boolean | undefined {
  const value = field(metadata, key);
  return typeof value === 'boolean' ? value : undefined;
}

/** serde_json `Value::as_i64`; only integral JSON numbers qualify. */
function i64Field(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/** Rust `i64 as i32` wraps around. */
function asInt32(value: number): number {
  return Number(BigInt.asIntN(32, BigInt(value)));
}

/** `parse_note_metadata_update` (handlers.rs:106-164). */
export function parseNoteMetadataUpdate(
  metadata: unknown,
  expectedUpdatedAt: string | null | undefined,
): NoteMetadataUpdate {
  const object = asObject(metadata);
  if (object === undefined) throw new Error('笔记 metadata 必须是键值对象');

  const unknown = Object.keys(object)
    .filter(key => key !== 'title' && key !== 'tags' && key !== 'isFavorite' && key !== 'props');
  if (unknown.length > 0) {
    throw new Error(
      `不支持的笔记 metadata 字段: ${unknown.join(', ')}；自定义字段请放入 props`,
    );
  }

  let title: string | undefined;
  if (Object.hasOwn(object, 'title')) {
    if (typeof object.title !== 'string') throw new Error('title 必须是字符串');
    title = object.title;
  }

  let tags: string[] | undefined;
  if (Object.hasOwn(object, 'tags')) {
    if (!Array.isArray(object.tags)) throw new Error('tags 必须是字符串数组');
    tags = [];
    for (const value of object.tags) {
      if (typeof value !== 'string') throw new Error('tags 必须是字符串数组');
      tags.push(value);
    }
  }

  let isFavorite: boolean | undefined;
  if (Object.hasOwn(object, 'isFavorite')) {
    if (typeof object.isFavorite !== 'boolean') throw new Error('isFavorite 必须是布尔值');
    isFavorite = object.isFavorite;
  }

  let props: unknown;
  if (Object.hasOwn(object, 'props')) {
    const value = object.props;
    if (value === null) props = {};
    else if (typeof value === 'object' && !Array.isArray(value)) props = value;
    else throw new Error('props 必须是键值对象或 null');
  }

  return {
    ...(title === undefined ? {} : { title }),
    ...(tags === undefined ? {} : { tags }),
    ...(isFavorite === undefined ? {} : { isFavorite }),
    ...(props === undefined ? {} : { props }),
    ...(expectedUpdatedAt === undefined || expectedUpdatedAt === null
      ? {}
      : { expectedUpdatedAt }),
  };
}

interface ResolvedTarget {
  resourceType: string;
  id: string;
}

const CACHED_PATH_TYPES: Record<string, string> = {
  note: 'notes',
  textbook: 'textbooks',
  exam: 'exams',
  translation: 'translations',
  essay: 'essays',
  image: 'images',
  file: 'files',
  folder: 'folders',
};

function resolveTarget(deps: DstuSetMetadataDeps, path: string): ResolvedTarget {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const conn = deps.database.getConnSafe();
  const folderItem = getFolderItemByCachedPathWithConn(conn, normalizedPath);
  if (folderItem !== undefined) {
    const resourceType = CACHED_PATH_TYPES[folderItem.itemType];
    if (resourceType === undefined) {
      throw new DstuFailure('InvalidNodeType', folderItem.itemType);
    }
    return { resourceType, id: folderItem.itemId };
  }

  const segments = normalizedPath.split('/').filter(segment => segment !== '');
  if (segments.length !== 1) throw new Error('资源不存在');
  const id = segments[0]!;
  const resourceType = inferResourceTypeFromId(id);
  if (resourceType === 'unknown') throw new Error('资源不存在');
  return { resourceType, id };
}

function updateTranslations(
  deps: DstuSetMetadataDeps,
  id: string,
  metadata: unknown,
): DstuNode {
  const conn = deps.database.getConnSafe();
  const favorite = boolField(metadata, 'isFavorite');
  if (favorite !== undefined) setTranslationFavoriteWithConn(conn, id, favorite);

  const rating = i64Field(field(metadata, 'qualityRating'));
  if (rating !== undefined) {
    setTranslationQualityRatingWithConn(conn, id, asInt32(rating));
  }

  if (hasField(metadata, 'sourceText') || hasField(metadata, 'translatedText')) {
    let currentSource = '';
    let currentTranslated = '';
    const content = getTranslationContentWithConn(conn, id);
    if (content !== undefined) {
      try {
        const parsed = parseSerdeJson(content);
        const object = asObject(parsed);
        if (object !== undefined) {
          if (typeof object.source === 'string') currentSource = object.source;
          if (typeof object.translated === 'string') currentTranslated = object.translated;
        }
      } catch (error) {
        // Rust treats malformed stored content as empty for the field merge.
        void error;
        currentSource = '';
        currentTranslated = '';
      }
    }
    const source = stringField(metadata, 'sourceText') ?? currentSource;
    const translated = stringField(metadata, 'translatedText') ?? currentTranslated;
    updateTranslationContentWithConn(conn, id, source, translated);
  }

  const updated = getTranslationWithConn(conn, id);
  if (updated === undefined) throw new Error('操作失败');
  return translationToDstuNode(updated);
}

function updateEssays(deps: DstuSetMetadataDeps, id: string, metadata: unknown): DstuNode {
  const conn = deps.database.getConnSafe();

  if (id.startsWith('essay_session_')) {
    const title = stringField(metadata, 'title');
    const isFavorite = boolField(metadata, 'isFavorite');
    const essayType = stringField(metadata, 'essayType');
    const gradeLevel = stringField(metadata, 'gradeLevel');
    const customPrompt = stringField(metadata, 'customPrompt');
    if (title === undefined
      && isFavorite === undefined
      && essayType === undefined
      && gradeLevel === undefined
      && customPrompt === undefined) {
      throw new Error('Essay session metadata update requires at least one field');
    }
    updateEssaySessionWithConn(conn, id, { title, isFavorite, essayType, gradeLevel, customPrompt });
    const session = getEssaySessionWithConn(conn, id);
    if (session === undefined) throw new Error('操作失败');
    return sessionToDstuNode(session);
  }

  const favorite = boolField(metadata, 'isFavorite');
  if (favorite !== undefined) setEssayFavoriteLooseWithConn(conn, id, favorite);
  const title = stringField(metadata, 'title');
  if (title !== undefined) updateEssayTitleWithConn(conn, id, title);
  const gradeLevel = stringField(metadata, 'gradeLevel');
  if (gradeLevel !== undefined) {
    updateEssayFieldLooseWithConn(conn, id, 'grade_level', gradeLevel);
  }
  const essayType = stringField(metadata, 'essayType');
  if (essayType !== undefined) {
    updateEssayFieldLooseWithConn(conn, id, 'essay_type', essayType);
  }

  const updated = getEssayWithConn(conn, id);
  if (updated === undefined) throw new Error('操作失败');
  return essayToDstuNode(updated);
}

function emitAnnotationsChanged(
  deps: DstuSetMetadataDeps,
  updated: { id: string; updatedAt: string },
  normalizedPath: string,
  id: string,
): void {
  if (deps.emitToWindow === undefined) return;
  try {
    deps.emitToWindow('pdf-annotations:changed', {
      textbook_id: id,
      resource_path: normalizedPath,
      kind: 'highlights',
      updated_at: updated.updatedAt,
    });
  } catch (error) {
    deps.log.warn(
      '[DSTU::handlers] failed to emit pdf-annotations:changed for %s: %s',
      id,
      failureMessage(error),
    );
  }
}

function updateTextbooks(
  deps: DstuSetMetadataDeps,
  id: string,
  metadata: unknown,
  expectedUpdatedAt: string | null | undefined,
  normalizedPath: string,
): DstuNode {
  const conn = deps.database.getConnSafe();

  let annotationUpdate: NonNullable<ReturnType<typeof getTextbookWithConn>> | undefined;
  if (hasField(metadata, 'highlights')) {
    const highlights = field(metadata, 'highlights');
    if (!Array.isArray(highlights)) {
      throw new Error('INVALID_ARGUMENT: textbook highlights must be an array');
    }
    if (highlights.length > 500) {
      throw new Error('INVALID_ARGUMENT: textbook highlights cannot exceed 500 items');
    }
    if (expectedUpdatedAt === undefined || expectedUpdatedAt === null) {
      throw new Error(
        'CONFLICT(textbooks.annotations_conflict): expected_updated_at is required when '
        + 'replacing highlights',
      );
    }
    annotationUpdate = replaceTextbookHighlightsIfVersion(
      conn, id, highlights, expectedUpdatedAt,
    );
  }

  if (annotationUpdate === undefined) {
    const progress = field(metadata, 'readingProgress');
    const page = i64Field(field(progress, 'page'));
    if (page !== undefined) updateTextbookReadingProgressWithConn(conn, id, asInt32(page));

    if (hasField(metadata, 'bookmarks')) {
      const bookmarks = field(metadata, 'bookmarks');
      if (!Array.isArray(bookmarks)) {
        throw new Error('INVALID_ARGUMENT: textbook bookmarks must be an array');
      }
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== null) {
        replaceTextbookBookmarksIfVersion(conn, id, bookmarks, expectedUpdatedAt);
      } else if (hasField(metadata, 'readingProgress')) {
        deps.log.warn(
          '[DSTU::handlers] dstu_set_metadata: skip versionless bookmarks piggybacked on '
          + 'readingProgress, id=%s',
          id,
        );
      } else {
        updateTextbookBookmarksWithConn(conn, id, bookmarks);
      }
    }

    const favorite = boolField(metadata, 'isFavorite') ?? boolField(metadata, 'favorite');
    if (favorite !== undefined) setTextbookFavoriteWithConn(conn, id, favorite);

    const title = stringField(metadata, 'title') ?? stringField(metadata, 'fileName');
    if (title !== undefined) updateTextbookFileNameWithConn(conn, id, title);
  }

  let updated = annotationUpdate;
  if (updated === undefined) {
    updated = getTextbookWithConn(conn, id);
    if (updated === undefined) throw new Error('操作失败');
  }
  if (hasField(metadata, 'highlights')) {
    emitAnnotationsChanged(deps, updated, normalizedPath, id);
  }
  return textbookToDstuNode(updated);
}

function updateExams(deps: DstuSetMetadataDeps, id: string, metadata: unknown): DstuNode {
  const conn = deps.database.getConnSafe();
  const favorite = boolField(metadata, 'isFavorite');
  if (favorite !== undefined) setExamFavoriteWithConn(conn, id, favorite);
  const name = stringField(metadata, 'name');
  if (name !== undefined) updateExamNameWithConn(conn, id, name);

  const updated = getExamWithConn(conn, id);
  if (updated === undefined) throw new Error('操作失败');
  return examToDstuNode(updated);
}

function updateFiles(
  deps: DstuSetMetadataDeps,
  id: string,
  metadata: unknown,
  expectedUpdatedAt: string | null | undefined,
  normalizedPath: string,
): DstuNode {
  const conn = deps.database.getConnSafe();

  if (hasField(metadata, 'highlights')) {
    const file = getFileWithConn(conn, id);
    if (file === undefined) throw new DstuFailure('NotFound', normalizedPath);
    const node = fileToDstuNode(file);
    if (node.type !== 'textbook') {
      throw new Error('INVALID_ARGUMENT: highlights are only supported for PDF files');
    }
    updateTextbooks(deps, id, metadata, expectedUpdatedAt, normalizedPath);
    const updated = getFileNode(conn, id);
    if (!updated) throw new DstuFailure('NotFound', normalizedPath);
    return updated;
  }

  const progress = field(metadata, 'readingProgress');
  const page = i64Field(field(progress, 'page'));
  if (page !== undefined) updateTextbookReadingProgressWithConn(conn, id, asInt32(page));

  if (hasField(metadata, 'bookmarks')) {
    const bookmarks = field(metadata, 'bookmarks');
    if (!Array.isArray(bookmarks)) {
      throw new Error('INVALID_ARGUMENT: file bookmarks must be an array');
    }
    if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== null) {
      replaceTextbookBookmarksIfVersion(conn, id, bookmarks, expectedUpdatedAt);
    } else if (hasField(metadata, 'readingProgress')) {
      deps.log.warn(
        '[DSTU::handlers] dstu_set_metadata: skip versionless bookmarks piggybacked on '
        + 'readingProgress, id=%s',
        id,
      );
    } else {
      updateTextbookBookmarksWithConn(conn, id, bookmarks);
    }
  }

  const favorite = boolField(metadata, 'isFavorite');
  if (favorite !== undefined) setFileFavoriteWithConn(conn, id, favorite);

  const fileName = stringField(metadata, 'fileName');
  if (fileName !== undefined) updateFileNameWithConn(conn, id, fileName);

  const updated = getFileWithConn(conn, id);
  if (updated === undefined) throw new Error('操作失败');
  return fileToDstuNode(updated);
}

function updateMindmaps(deps: DstuSetMetadataDeps, id: string, metadata: unknown): DstuNode {
  const conn = deps.database.getConnSafe();

  const favorite = boolField(metadata, 'isFavorite');
  if (favorite !== undefined) setMindmapFavoriteWithConn(conn, id, favorite);

  const title = stringField(metadata, 'title');
  const description = stringField(metadata, 'description');
  if (title !== undefined || description !== undefined) {
    updateMindmapWithConn(conn, id, { title, description }, deps.log);
  }

  const updated = getMindmapWithConn(conn, id);
  if (updated === undefined) throw new Error('操作失败');
  return mindmapToDstuNode(updated);
}

function updateFolders(
  deps: DstuSetMetadataDeps,
  id: string,
  metadata: unknown,
  path: string,
): DstuNode {
  const conn = deps.database.getConnSafe();
  const folder = getFolderWithConn(conn, id);
  if (folder === undefined) throw new DstuFailure('NotFound', path);

  const updatedFolder = { ...folder };
  let hasChanges = false;

  const favoriteValue = hasField(metadata, 'isFavorite')
    ? field(metadata, 'isFavorite')
    : field(metadata, 'favorite');
  if (typeof favoriteValue === 'boolean') {
    updatedFolder.isFavorite = favoriteValue;
    hasChanges = true;
  }

  const title = stringField(metadata, 'title');
  if (title !== undefined) {
    updatedFolder.title = title;
    hasChanges = true;
  }
  const icon = stringField(metadata, 'icon');
  if (icon !== undefined) {
    updatedFolder.icon = icon;
    hasChanges = true;
  }
  const color = stringField(metadata, 'color');
  if (color !== undefined) {
    updatedFolder.color = color;
    hasChanges = true;
  }

  if (hasChanges) updateFolderWithConn(conn, updatedFolder, deps.log);

  const node = withNodeMetadata(
    withNodeTimestamps(
      createFolderNode(folder.id, `/${folder.id}`, updatedFolder.title),
      folder.createdAt,
      folder.updatedAt,
    ),
    {
      isExpanded: folder.isExpanded,
      isFavorite: updatedFolder.isFavorite,
      icon: updatedFolder.icon ?? null,
      color: updatedFolder.color ?? null,
    },
  );
  return node;
}

/** `dstu_set_metadata` (handlers.rs:3349-4225). */
export function setMetadataCommand(
  deps: DstuSetMetadataDeps,
  args: DstuSetMetadataArgs,
): null {
  return command(() => {
    const normalizedPath = args.path.startsWith('/') ? args.path : `/${args.path}`;
    const { resourceType, id } = resolveTarget(deps, args.path);

    let node: DstuNode;
    const conn = deps.database.getConnSafe();
    switch (resourceType) {
      case 'notes': {
        const update = parseNoteMetadataUpdate(args.metadata, args.expectedUpdatedAt);
        node = noteToDstuNode(updateNoteMetadataWithConn(conn, id, update));
        break;
      }
      case 'translations':
        node = updateTranslations(deps, id, args.metadata);
        break;
      case 'essays':
        node = updateEssays(deps, id, args.metadata);
        break;
      case 'textbooks':
      case 'textbook':
        node = updateTextbooks(deps, id, args.metadata, args.expectedUpdatedAt, normalizedPath);
        break;
      case 'exams':
      case 'exam':
        node = updateExams(deps, id, args.metadata);
        break;
      case 'files':
      case 'file':
      case 'images':
      case 'image':
        node = updateFiles(deps, id, args.metadata, args.expectedUpdatedAt, normalizedPath);
        break;
      case 'mindmaps':
      case 'mindmap':
        node = updateMindmaps(deps, id, args.metadata);
        break;
      case 'folders':
      case 'folder':
        node = updateFolders(deps, id, args.metadata, args.path);
        break;
      default:
        throw new DstuFailure('InvalidNodeType', resourceType);
    }

    // handlers.rs:4195-4206: stale cached paths are cleared best-effort.
    try {
      clearFolderItemCachedPathWithConn(conn, id, canonicalFolderItemType(resourceType));
    } catch (error) {
      deps.log.warn(
        '[DSTU::handlers] dstu_set_metadata: failed to clear cached_path for %s: %s',
        id,
        failureMessage(error),
      );
    }

    emitDstuWatchEvent(deps, updatedEvent(args.path, node));
    return null;
  });
}
