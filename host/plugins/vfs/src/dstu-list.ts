/** dstu/handlers.rs `dstu_list`, `dstu_list_deleted` and handler_utils/list_helpers.rs. */
import { CommandError } from '../../../kernel/api.ts';
import { rustTrim, utf8ByteLength, compareUtf8 } from '../../../platform/util/portable.ts';
import { parseRfc3339 } from '../../../platform/time/index.ts';
import type { VfsDatabase } from '../api.ts';
import type { DstuNode, DstuNodeType } from './dstu-types.ts';
import {
  DstuListOptions,
  createFolderNode,
  dstuNodeTypeFromString,
  withNodeTimestamps,
} from './dstu-types.ts';
import {
  essayToDstuNode,
  examToDstuNode,
  fileToDstuNode,
  itemTypeToDstuNodeType,
  mindmapToDstuNode,
  noteToDstuNode,
  sessionToDstuNode,
  textbookToDstuNode,
  translationToDstuNode,
} from './node-converters.ts';
import { buildSimpleResourcePath } from './paths.ts';
import type { VfsFolderItem } from './folder-types.ts';
import {
  folderExistsWithConn,
  listAllAssignedItemIdsWithConn,
  listFoldersByParentWithConn,
  listItemsByFolderWithConn,
} from '../repository/folders.ts';
import {
  getCanonicalFolderIdForItemWithConn,
  safeListFolderMountsWithConn,
} from '../repository/study-spaces.ts';
import type { StudySpaceMount } from '../../vfs-repos/api.ts';
import { getResourcePathWithConn } from '../repository/locations.ts';
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
  listDeletedEssaySessionsWithConn,
  listDeletedExamsWithConn,
  listDeletedNotesWithConn,
  listDeletedTextbooksWithConn,
  listDeletedTranslationsWithConn,
  listEssaySessionsWithConn,
  listExamsWithConn,
  listFilesByTypeWithConn,
  listMindmapsWithConn,
  listNotesWithConn,
  listTextbooksWithConn,
  listTranslationsWithConn,
  type NoteListLog,
} from '../repository/resources.ts';
import { buildFolderPathWithConn } from '../repository/folders.ts';

export interface DstuListDeps {
  readonly database: VfsDatabase;
  readonly log?: NoteListLog;
}

function command<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(error instanceof Error ? error.message : String(error));
  }
}

/** `is_memory_system_hidden_name` (handlers.rs:92-98; `len` is UTF-8 bytes). */
export function isMemorySystemHiddenName(name: string): boolean {
  const trimmed = rustTrim(name);
  return utf8ByteLength(trimmed) > 4 && trimmed.startsWith('__') && trimmed.endsWith('__');
}

/** Rust `String::cmp` is byte-wise over UTF-8. */
function compareRustStrings(left: string, right: string): number {
  return compareUtf8(left, right);
}

function isFavoriteMetadata(node: DstuNode): boolean {
  if (node.metadata === null || typeof node.metadata !== 'object') return false;
  const metadata = node.metadata as Record<string, unknown>;
  return metadata.isFavorite === true || metadata.favorite === true || metadata.is_favorite === true;
}

function sortNodes(results: DstuNode[], sortBy: string | undefined, sortOrder: string | undefined): void {
  const field = sortBy ?? 'updatedAt';
  const ascending = sortOrder === 'asc';
  results.sort((left, right) => {
    const cmp = field === 'name'
      ? compareRustStrings(left.name, right.name)
      : field === 'createdAt'
        ? left.createdAt - right.createdAt
        : left.updatedAt - right.updatedAt;
    return ascending ? cmp : -cmp;
  });
}

function paginate(results: DstuNode[], limit: number, offset: number): DstuNode[] {
  let page = results;
  if (offset > 0) page = page.slice(offset);
  if (page.length > limit) page = page.slice(0, limit);
  return page;
}

function nodeTypeOfFilter(value: DstuNodeType | null | undefined): DstuNodeType | undefined {
  if (value !== null && value !== undefined && typeof value === 'object') {
    // Generated `de` unions model unit variants as `{ note: null }`.
    const key = Object.keys(value as unknown as Record<string, unknown>)[0];
    return key === undefined ? undefined : dstuNodeTypeFromString(key);
  }
  return typeof value === 'string' ? dstuNodeTypeFromString(value) : undefined;
}

function itemTypeToNodeType(itemType: string): DstuNodeType | undefined {
  return itemTypeToDstuNodeType(itemType);
}

function fetchResourceAsDstuNode(
  deps: DstuListDeps,
  conn: ReturnType<VfsDatabase['getConnSafe']>,
  item: VfsFolderItem,
): DstuNode | undefined {
  switch (item.itemType) {
    case 'note': {
      const note = getNoteWithConn(conn, item.itemId);
      return note === undefined ? undefined : noteToDstuNode(note);
    }
    case 'textbook': {
      const textbook = getTextbookWithConn(conn, item.itemId);
      return textbook === undefined ? undefined : textbookToDstuNode(textbook);
    }
    case 'exam': {
      const exam = getExamWithConn(conn, item.itemId);
      return exam === undefined ? undefined : examToDstuNode(exam);
    }
    case 'translation': {
      const translation = getTranslationWithConn(conn, item.itemId);
      return translation === undefined ? undefined : translationToDstuNode(translation);
    }
    case 'essay': {
      const essay = getEssayWithConn(conn, item.itemId);
      if (essay !== undefined) return essayToDstuNode(essay);
      const session = getEssaySessionWithConn(conn, item.itemId);
      return session === undefined ? undefined : sessionToDstuNode(session);
    }
    case 'image':
    case 'file': {
      const file = getFileWithConn(conn, item.itemId);
      return file === undefined ? undefined : fileToDstuNode(file);
    }
    case 'mindmap': {
      const mindmap = getMindmapWithConn(conn, item.itemId);
      return mindmap === undefined ? undefined : mindmapToDstuNode(mindmap);
    }
    default:
      return undefined;
  }
}

/** `list_resources_by_type_with_folder_path` (list_helpers.rs:21-251). */
export function listResourcesByTypeWithFolderPath(
  deps: DstuListDeps,
  typeFilter: DstuNodeType,
  options: DstuListOptions,
): DstuNode[] {
  const limit = options.getLimit();
  const offset = options.getOffset();
  const conn = deps.database.getConnSafe();
  const results: DstuNode[] = [];
  const withPath = (node: DstuNode, id: string): void => {
    node.path = getResourcePathWithConn(conn, id);
    results.push(node);
  };

  switch (typeFilter) {
    case 'note': {
      const requiredTags = (options.tags ?? [])
        .map(tag => rustTrim(tag).toLowerCase())
        .filter(tag => tag !== '');
      if (requiredTags.length === 0) {
        for (const note of listNotesWithConn(conn, options.search, limit, offset, deps.log)) {
          withPath(noteToDstuNode(note), note.id);
        }
        return results;
      }

      const pageSize = Math.min(Math.max(limit, 50), 200);
      let skipped = 0;
      let pageOffset = 0;
      let rounds = 0;
      for (;;) {
        const notes = listNotesWithConn(conn, options.search, pageSize, pageOffset, deps.log);
        if (notes.length === 0) break;
        for (const note of notes) {
          const noteTags = new Set(note.tags.map(tag => rustTrim(tag).toLowerCase()));
          if (!requiredTags.every(tag => noteTags.has(tag))) continue;
          if (skipped < offset) {
            skipped += 1;
            continue;
          }
          withPath(noteToDstuNode(note), note.id);
          if (results.length >= limit) break;
        }
        if (results.length >= limit) break;
        pageOffset += pageSize;
        rounds += 1;
        if (rounds > 10_000) break;
      }
      return results;
    }
    case 'textbook': {
      for (const textbook of listTextbooksWithConn(conn, limit, offset)) {
        withPath(textbookToDstuNode(textbook), textbook.id);
      }
      return results;
    }
    case 'exam': {
      for (const exam of listExamsWithConn(conn, options.search, limit, offset)) {
        withPath(examToDstuNode(exam), exam.id);
      }
      return results;
    }
    case 'translation': {
      for (const translation of listTranslationsWithConn(conn, options.search, limit, offset)) {
        withPath(translationToDstuNode(translation), translation.id);
      }
      return results;
    }
    case 'essay': {
      for (const session of listEssaySessionsWithConn(conn, limit, offset)) {
        withPath(sessionToDstuNode(session), session.id);
      }
      return results;
    }
    case 'image': {
      for (const file of listFilesByTypeWithConn(conn, 'image', limit, offset)) {
        withPath(fileToDstuNode(file), file.id);
      }
      return results;
    }
    case 'file': {
      for (const file of listFilesByTypeWithConn(conn, 'document', limit, offset)) {
        withPath(fileToDstuNode(file), file.id);
      }
      return results;
    }
    case 'mindmap': {
      for (const mindmap of listMindmapsWithConn(conn)) {
        withPath(mindmapToDstuNode(mindmap), mindmap.id);
      }
      return results;
    }
    default:
      return results;
  }
}

const FAVORITE_TYPES: readonly DstuNodeType[] = [
  'note', 'textbook', 'exam', 'translation', 'essay', 'image', 'file', 'mindmap',
];

function listRoot(deps: DstuListDeps, options: DstuListOptions): DstuNode[] {
  const conn = deps.database.getConnSafe();
  const results: DstuNode[] = [];

  for (const folder of listFoldersByParentWithConn(conn, null)) {
    results.push(withNodeTimestamps(
      createFolderNode(folder.id, folder.title, folder.title),
      folder.createdAt,
      folder.updatedAt,
    ));
  }

  for (const item of listItemsByFolderWithConn(conn, null)) {
    const node = fetchResourceAsDstuNode(deps, conn, item);
    if (node !== undefined) results.push(node);
  }

  const assigned = listAllAssignedItemIdsWithConn(conn);
  for (const note of listNotesWithConn(conn, null, 1000, 0, deps.log)) {
    if (!assigned.has(note.id)) results.push(noteToDstuNode(note));
  }
  for (const textbook of listTextbooksWithConn(conn, 1000, 0)) {
    if (!assigned.has(textbook.id)) results.push(textbookToDstuNode(textbook));
  }
  for (const exam of listExamsWithConn(conn, null, 1000, 0)) {
    if (!assigned.has(exam.id)) results.push(examToDstuNode(exam));
  }
  for (const translation of listTranslationsWithConn(conn, null, 1000, 0)) {
    if (!assigned.has(translation.id)) results.push(translationToDstuNode(translation));
  }
  for (const session of listEssaySessionsWithConn(conn, 1000, 0)) {
    if (!assigned.has(session.id)) results.push(sessionToDstuNode(session));
  }
  return results;
}

function fetchMountedResourceAsDstuNode(
  deps: DstuListDeps,
  conn: ReturnType<VfsDatabase['getConnSafe']>,
  mount: StudySpaceMount,
): DstuNode | undefined {
  switch (mount.itemType) {
    case 'image':
    case 'file': {
      const file = getFileWithConn(conn, mount.itemId);
      if (file === undefined || (file.deletedAt !== undefined && file.deletedAt !== null)) {
        return undefined;
      }
      return fileToDstuNode(file);
    }
    case 'textbook': {
      const textbook = getTextbookWithConn(conn, mount.itemId);
      if (textbook === undefined) return undefined;
      const deletedAt = (textbook as { deletedAt?: string | null }).deletedAt;
      if (deletedAt !== undefined && deletedAt !== null) return undefined;
      return textbookToDstuNode(textbook);
    }
    default:
      return fetchResourceAsDstuNode(deps, conn, {
        id: mount.id,
        folderId: mount.targetFolderId,
        itemType: mount.itemType,
        itemId: mount.itemId,
        sortOrder: 0,
        createdAt: 0,
      });
  }
}

function attachMountMetadata(
  node: DstuNode,
  mount: StudySpaceMount,
  extra: Record<string, unknown>,
): DstuNode {
  const existing =
    node.metadata !== null && typeof node.metadata === 'object' && !Array.isArray(node.metadata)
      ? (node.metadata as Record<string, unknown>)
      : {};
  node.metadata = {
    ...existing,
    ...extra,
    isMounted: true,
    mountId: mount.id,
    mountSpaceId: mount.spaceId,
  };
  return node;
}

function listFolder(deps: DstuListDeps, folderId: string, options: DstuListOptions): DstuNode[] {
  const conn = deps.database.getConnSafe();
  const folder = getFolderWithConn(conn, folderId);
  if (folder === undefined) throw new CommandError('文件夹不存在');
  const folderPath = buildFolderPathWithConn(conn, folderId);
  const typeFilter = nodeTypeOfFilter(options.getTypeFilter());
  const results: DstuNode[] = [];
  const seen = new Set<string>();

  for (const subFolder of listFoldersByParentWithConn(conn, folderId)) {
    seen.add(`folder:${subFolder.id}`);
    if (isMemorySystemHiddenName(subFolder.title)) continue;
    results.push(withNodeTimestamps(
      createFolderNode(subFolder.id, `${folderPath}/${subFolder.title}`, subFolder.title),
      subFolder.createdAt,
      subFolder.updatedAt,
    ));
  }

  for (const item of listItemsByFolderWithConn(conn, folderId)) {
    seen.add(`${item.itemType}:${item.itemId}`);
    if (item.itemType === 'textbook') seen.add(`file:${item.itemId}`);
    if (item.itemType === 'file') seen.add(`textbook:${item.itemId}`);
    if (typeFilter !== undefined) {
      const nodeType = itemTypeToNodeType(item.itemType);
      if (nodeType !== undefined && nodeType !== typeFilter) continue;
    }
    const node = fetchResourceAsDstuNode(deps, conn, item);
    if (node === undefined) continue;
    if (isMemorySystemHiddenName(node.name)) continue;
    results.push(node);
  }

  for (const mount of safeListFolderMountsWithConn(conn, folderId)) {
    const key = `${mount.itemType}:${mount.itemId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (mount.itemType === 'folder') {
      if (typeFilter !== undefined && typeFilter !== 'folder') continue;
      if (!folderExistsWithConn(conn, mount.itemId)) continue;
      const mountedFolder = getFolderWithConn(conn, mount.itemId);
      if (mountedFolder === undefined || isMemorySystemHiddenName(mountedFolder.title)) continue;
      const folderNode = withNodeTimestamps(
        createFolderNode(mountedFolder.id, `${folderPath}/${mountedFolder.title}`, mountedFolder.title),
        mountedFolder.createdAt,
        mountedFolder.updatedAt,
      );
      results.push(
        attachMountMetadata(folderNode, mount, {
          canonicalParentId: mountedFolder.parentId ?? null,
        }),
      );
      continue;
    }

    if (typeFilter !== undefined) {
      const nodeType = itemTypeToNodeType(mount.itemType);
      if (nodeType !== undefined && nodeType !== typeFilter) continue;
    }
    const node = fetchMountedResourceAsDstuNode(deps, conn, mount);
    if (node === undefined || isMemorySystemHiddenName(node.name)) continue;
    const canonicalFolderId = getCanonicalFolderIdForItemWithConn(conn, mount.itemType, mount.itemId);
    results.push(
      attachMountMetadata(node, mount, {
        canonicalFolderId,
      }),
    );
  }

  return results;
}

/** `dstu_list` (handlers.rs:172-446). `path` is only logged by Rust. */
export function listCommand(
  deps: DstuListDeps,
  options: DstuListOptions | null | undefined,
): DstuNode[] {
  return command(() => {
    const opts = DstuListOptions.from(options ?? undefined);
    const folderId = opts.getFolderId() ?? undefined;
    const isRoot = folderId === undefined
      || folderId === ''
      || folderId === 'root'
      || folderId === 'null';
    const typeFilter = nodeTypeOfFilter(opts.getTypeFilter());

    if (opts.isFavorite === true) {
      let results: DstuNode[] = [];
      for (const nodeType of FAVORITE_TYPES) {
        results = results.concat(listResourcesByTypeWithFolderPath(deps, nodeType, opts));
      }
      results = results.filter(isFavoriteMetadata);
      results = results.filter(node => !isMemorySystemHiddenName(node.name));
      sortNodes(results, opts.sortBy ?? undefined, opts.sortOrder ?? undefined);
      return results;
    }

    if (typeFilter !== undefined && (isRoot || opts.folderId === undefined)) {
      return listResourcesByTypeWithFolderPath(deps, typeFilter, opts)
        .filter(node => !isMemorySystemHiddenName(node.name));
    }

    let results: DstuNode[];
    if (isRoot) {
      return listRoot(deps, opts);
    } else if (folderId !== undefined) {
      results = listFolder(deps, folderId, opts);
    } else if (typeFilter !== undefined) {
      results = listResourcesByTypeWithFolderPath(deps, typeFilter, opts);
    } else {
      results = [];
    }

    results = results.filter(node => !isMemorySystemHiddenName(node.name));
    sortNodes(results, opts.sortBy ?? undefined, opts.sortOrder ?? undefined);
    return paginate(results, opts.getLimit(), opts.getOffset());
  });
}

function deletedNoteNodes(deps: DstuListDeps, limit: number, offset: number): DstuNode[] {
  const conn = deps.database.getConnSafe();
  return listDeletedNotesWithConn(conn, limit, offset).map(note => ({
    id: note.id,
    sourceId: note.id,
    name: note.title,
    path: buildSimpleResourcePath(note.id),
    type: 'note',
    createdAt: parseRfc3339(note.createdAt)?.millis ?? 0,
    updatedAt: parseRfc3339(note.updatedAt)?.millis ?? 0,
    resourceId: note.resourceId,
    previewType: 'markdown',
    metadata: {
      tags: note.tags,
      is_favorite: note.isFavorite,
      deleted_at: note.deletedAt ?? null,
    },
  }));
}

function deletedTextbookNodes(deps: DstuListDeps, limit: number, offset: number): DstuNode[] {
  const conn = deps.database.getConnSafe();
  return listDeletedTextbooksWithConn(conn, limit, offset).map(textbook => ({
    id: textbook.id,
    sourceId: textbook.id,
    name: textbook.fileName,
    path: buildSimpleResourcePath(textbook.id),
    type: 'textbook',
    size: textbook.size,
    createdAt: parseRfc3339(textbook.createdAt)?.millis ?? 0,
    updatedAt: parseRfc3339(textbook.updatedAt)?.millis ?? 0,
    ...(textbook.resourceId === null || textbook.resourceId === undefined
      ? {}
      : { resourceId: textbook.resourceId }),
    previewType: 'pdf',
    metadata: {
      file_name: textbook.fileName,
      page_count: textbook.pageCount ?? null,
      isFavorite: textbook.isFavorite,
    },
  }));
}

function deletedExamNodes(deps: DstuListDeps, limit: number, offset: number): DstuNode[] {
  const conn = deps.database.getConnSafe();
  return listDeletedExamsWithConn(conn, limit, offset).map(exam => ({
    id: exam.id,
    sourceId: exam.id,
    name: exam.examName ?? '未命名题目集',
    path: buildSimpleResourcePath(exam.id),
    type: 'exam',
    createdAt: parseRfc3339(exam.createdAt)?.millis ?? 0,
    updatedAt: parseRfc3339(exam.updatedAt)?.millis ?? 0,
    resourceId: exam.resourceId ?? `res_${exam.id}`,
    previewType: 'exam',
    metadata: {
      status: exam.status,
      temp_id: exam.tempId,
      linked_mistake_ids: exam.linkedMistakeIds ?? null,
    },
  }));
}

function deletedTranslationNodes(deps: DstuListDeps, limit: number, offset: number): DstuNode[] {
  const conn = deps.database.getConnSafe();
  return listDeletedTranslationsWithConn(conn, limit, offset).map(translation => {
    const createdAt = parseRfc3339(translation.createdAt)?.millis ?? 0;
    return {
      id: translation.id,
      sourceId: translation.id,
      name: `${translation.srcLang} → ${translation.tgtLang}`,
      path: buildSimpleResourcePath(translation.id),
      type: 'translation',
      createdAt,
      updatedAt: createdAt,
      resourceId: translation.resourceId,
      previewType: 'translation',
      metadata: {
        src_lang: translation.srcLang,
        tgt_lang: translation.tgtLang,
        engine: translation.engine ?? null,
        model: translation.model ?? null,
        is_favorite: translation.isFavorite,
        quality_rating: translation.qualityRating ?? null,
      },
    };
  });
}

function deletedEssayNodes(deps: DstuListDeps, limit: number, offset: number): DstuNode[] {
  const conn = deps.database.getConnSafe();
  return listDeletedEssaySessionsWithConn(conn, limit, offset).map(session => {
    const createdAt = parseRfc3339(session.createdAt)?.millis ?? 0;
    return {
      id: session.id,
      sourceId: session.id,
      name: session.title,
      path: buildSimpleResourcePath(session.id),
      type: 'essay',
      createdAt,
      updatedAt: parseRfc3339(session.updatedAt)?.millis ?? 0,
      resourceId: session.id,
      previewType: 'essay',
      metadata: {
        essay_type: session.essayType ?? null,
        grade_level: session.gradeLevel ?? null,
        total_rounds: session.totalRounds,
        latest_score: session.latestScore ?? null,
        is_favorite: session.isFavorite,
        is_session: true,
      },
    };
  });
}

/** `dstu_list_deleted` (handlers.rs:4858-5093). */
export function listDeletedCommand(
  deps: DstuListDeps,
  resourceType: string,
  limit?: number | null,
  offset?: number | null,
): DstuNode[] {
  return command(() => {
    const pageLimit = limit ?? 100;
    const pageOffset = offset ?? 0;
    switch (resourceType) {
      case 'notes': return deletedNoteNodes(deps, pageLimit, pageOffset);
      case 'textbooks': return deletedTextbookNodes(deps, pageLimit, pageOffset);
      case 'exams': return deletedExamNodes(deps, pageLimit, pageOffset);
      case 'translations': return deletedTranslationNodes(deps, pageLimit, pageOffset);
      case 'essays': return deletedEssayNodes(deps, pageLimit, pageOffset);
      default:
        throw new CommandError(
          `Resource type '${resourceType}' does not support list_deleted operation`,
        );
    }
  });
}
