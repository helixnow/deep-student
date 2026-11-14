/**
 * `dstu_copy` (dstu/handlers.rs:2244-2798) plus its folder recursion helpers.
 *
 * Copies create brand new owner-lane resources; folder membership is written
 * through the folder repository, and every failed child copy is logged and
 * skipped exactly like the Rust implementation.
 */
import { CommandError } from '../../../kernel/api.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import type {
  VfsDatabase,
  VfsExamSheet,
  VfsFile,
  VfsMindMap,
  VfsNote,
  VfsTextbook,
  VfsTranslation,
} from '../api.ts';
import type { VfsEssaySession as RepoEssaySession } from '../../vfs-repos/api.ts';
import {
  createFolderNode,
  createdEvent,
  withNodeMetadata,
  withNodeTimestamps,
  type DstuNode,
} from './dstu-types.ts';
import { DstuFailure } from './dstu-error.ts';
import { emitDstuWatchEvent, type LocationDeps } from './locations.ts';
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
import { extractResourceInfo } from './path-utils.ts';
import { buildSimpleResourcePath } from './paths.ts';
import {
  addItemToFolderWithConn,
  createFolderItemRecord,
  createFolderRecord,
  createFolderWithConn,
  getFolderWithConn,
  listFoldersByParentWithConn,
  listItemsByFolderWithConn,
} from '../repository/folders.ts';
import type { VfsFolderItem } from './folder-types.ts';
import {
  createMindmapWithConn,
  createMindmapInFolderWithConn,
  type CreateMindMapParams,
} from '../repository/create.ts';
import {
  getMindmapContentWithConn,
  getMindmapWithConn,
} from '../repository/resources.ts';
import { notesRepository, vfsRepositories } from '../repository/services.ts';

export type DstuCopyDeps = LocationDeps;

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function command<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(failureMessage(error));
  }
}

const MAX_COPY_DEPTH = 10;
const DEFAULT_MINDMAP_CONTENT = '{"version":"1.0","root":{"id":"root","text":"根节点","children":[]}}';

function notFound(path: string): DstuFailure {
  return new DstuFailure('NotFound', path);
}

function invalidNodeType(resourceType: string): DstuFailure {
  return new DstuFailure('InvalidNodeType', resourceType);
}

/** Rust `str::trim_end_matches(".pdf")`: strips every trailing occurrence. */
function trimTrailingPdf(fileName: string): string {
  let base = fileName;
  while (base.endsWith('.pdf')) base = base.slice(0, -4);
  return base;
}

interface TranslationContent {
  source: string;
  translated: string;
}

/** `serde_json::from_str(..).unwrap_or({"source":"","translated":""})` + field reads. */
function parseTranslationContent(content: string): TranslationContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = { source: '', translated: '' };
  }
  const record = parsed !== null && typeof parsed === 'object'
    ? parsed as Record<string, unknown>
    : {};
  return {
    source: typeof record.source === 'string' ? record.source : '',
    translated: typeof record.translated === 'string' ? record.translated : '',
  };
}

function getNote(deps: DstuCopyDeps, id: string): VfsNote | undefined {
  return notesRepository().getNote(id, deps.database.getConnSafe()) ?? undefined;
}

function getNoteContent(deps: DstuCopyDeps, id: string): string {
  return notesRepository().getNoteContent(id, deps.database.getConnSafe()) ?? '';
}

function getTextbook(deps: DstuCopyDeps, id: string): VfsTextbook | undefined {
  return vfsRepositories().textbooks.getTextbook(deps.database.getConnSafe(), id) ?? undefined;
}

function getTranslation(deps: DstuCopyDeps, id: string): VfsTranslation | undefined {
  return vfsRepositories().translations.getTranslation(deps.database.getConnSafe(), id) ?? undefined;
}

function getTranslationContent(deps: DstuCopyDeps, id: string): string {
  const content = vfsRepositories().translations.getTranslationContent(deps.database.getConnSafe(), id);
  return content ?? '{"source":"","translated":""}';
}

function getExam(deps: DstuCopyDeps, id: string): VfsExamSheet | undefined {
  return vfsRepositories().exams.getExamSheet(deps.database.getConnSafe(), id) ?? undefined;
}

function getSession(deps: DstuCopyDeps, id: string): RepoEssaySession | undefined {
  return vfsRepositories().essays.getSession(deps.database.getConnSafe(), id) ?? undefined;
}

function getFile(deps: DstuCopyDeps, id: string): VfsFile | undefined {
  return vfsRepositories().files.getFile(deps.database.getConnSafe(), id) ?? undefined;
}

function getMindmap(deps: DstuCopyDeps, id: string): VfsMindMap | undefined {
  return getMindmapWithConn(deps.database.getConnSafe(), id);
}

function getMindmapContent(deps: DstuCopyDeps, id: string): string {
  return getMindmapContentWithConn(deps.database.getConnSafe(), id) ?? DEFAULT_MINDMAP_CONTENT;
}

function copyTranslation(
  deps: DstuCopyDeps,
  translation: VfsTranslation,
  title: string | null,
): VfsTranslation {
  const content = parseTranslationContent(getTranslationContent(deps, translation.id));
  return vfsRepositories().translations.createTranslation(deps.database.getConnSafe(), {
    title,
    source: content.source,
    translated: content.translated,
    srcLang: translation.srcLang,
    tgtLang: translation.tgtLang,
    engine: translation.engine ?? null,
    model: translation.model ?? null,
  });
}

function copyEssaySession(
  deps: DstuCopyDeps,
  session: RepoEssaySession,
  title: string,
): RepoEssaySession {
  return vfsRepositories().essays.createSession(deps.database.getConnSafe(), {
    title,
    essayType: session.essay_type,
    gradeLevel: session.grade_level,
    customPrompt: session.custom_prompt,
  });
}

function copyMindmap(
  deps: DstuCopyDeps,
  mindmap: VfsMindMap,
  title: string,
  content: string,
): VfsMindMap {
  const params: CreateMindMapParams = {
    title,
    description: mindmap.description ?? null,
    content,
    defaultView: mindmap.defaultView,
    theme: mindmap.theme ?? null,
  };
  return createMindmapWithConn(deps.database.getConnSafe(), params);
}

/** `copy_resource_to_folder` (handlers.rs:2917-3234). */
function copyResourceToFolder(
  deps: DstuCopyDeps,
  item: VfsFolderItem,
  destFolderId: string,
): void {
  const conn = deps.database.getConnSafe();
  switch (item.itemType) {
    case 'note': {
      const note = getNote(deps, item.itemId);
      if (note === undefined) throw new Error(`笔记不存在: ${item.itemId}`);
      const content = getNoteContent(deps, item.itemId);
      const newNote = notesRepository().createNote(
        { title: note.title, content, tags: note.tags },
        conn,
      );
      addItemToFolderWithConn(
        conn,
        createFolderItemRecord(destFolderId, 'note', newNote.id),
      );
      return;
    }
    case 'textbook': {
      const textbook = getTextbook(deps, item.itemId);
      if (textbook === undefined) throw new Error(`教材不存在: ${item.itemId}`);
      const copy = vfsRepositories().textbooks.copyTextbook(conn, textbook.id, textbook.fileName);
      addItemToFolderWithConn(
        conn,
        createFolderItemRecord(destFolderId, 'file', copy.id),
      );
      return;
    }
    case 'translation': {
      const translation = getTranslation(deps, item.itemId);
      if (translation === undefined) throw new Error(`翻译不存在: ${item.itemId}`);
      const copy = copyTranslation(deps, translation, translation.title ?? null);
      addItemToFolderWithConn(
        conn,
        createFolderItemRecord(destFolderId, 'translation', copy.id),
      );
      return;
    }
    case 'exam': {
      // The exam repository writes its own folder item for the destination.
      vfsRepositories().exams.copyExamSheet(conn, item.itemId, destFolderId);
      return;
    }
    case 'essay': {
      const session = getSession(deps, item.itemId);
      if (session === undefined) throw new Error(`作文会话不存在: ${item.itemId}`);
      const copy = copyEssaySession(deps, session, session.title);
      addItemToFolderWithConn(
        conn,
        createFolderItemRecord(destFolderId, 'essay', copy.id),
      );
      return;
    }
    case 'file':
    case 'image': {
      const file = getFile(deps, item.itemId);
      if (file === undefined) throw new Error(`文件不存在: ${item.itemId}`);
      const copy = vfsRepositories().files.copyFile(conn, item.itemId, file.fileName);
      addItemToFolderWithConn(
        conn,
        createFolderItemRecord(destFolderId, item.itemType, copy.id),
      );
      return;
    }
    case 'mindmap': {
      const mindmap = getMindmap(deps, item.itemId);
      if (mindmap === undefined) throw new Error(`知识导图不存在: ${item.itemId}`);
      const copy = copyMindmap(
        deps,
        mindmap,
        mindmap.title,
        getMindmapContent(deps, item.itemId),
      );
      addItemToFolderWithConn(
        conn,
        createFolderItemRecord(destFolderId, 'mindmap', copy.id),
      );
      return;
    }
    default:
      deps.log.warn(
        '[DSTU::handlers] copy_resource_to_folder: unsupported item type: %s',
        item.itemType,
      );
  }
}

/** `copy_folder_recursive` (handlers.rs:2839-2915). */
function copyFolderRecursive(
  deps: DstuCopyDeps,
  srcFolderId: string,
  destParentId: string | undefined,
  depth: number,
): DstuNode {
  if (depth >= MAX_COPY_DEPTH) {
    deps.log.warn(
      '[DSTU::handlers] copy_folder_recursive: max depth reached, src_folder_id=%s',
      srcFolderId,
    );
    throw new Error(`文件夹复制深度超出限制（最大 ${MAX_COPY_DEPTH} 层）`);
  }

  const conn = deps.database.getConnSafe();
  const folder = getFolderWithConn(conn, srcFolderId);
  if (folder === undefined) {
    deps.log.warn(
      '[DSTU::handlers] copy_folder_recursive: folder not found, id=%s',
      srcFolderId,
    );
    throw new Error(`文件夹不存在: ${srcFolderId}`);
  }

  const newTitle = depth === 0 ? `${folder.title} (副本)` : folder.title;
  const newFolder = createFolderRecord(newTitle, destParentId, folder.icon, folder.color);
  try {
    createFolderWithConn(conn, newFolder);
  } catch (error) {
    deps.log.warn(
      '[DSTU::handlers] copy_folder_recursive: create_folder error, error=%s',
      failureMessage(error),
    );
    throw error;
  }

  let subFolders: typeof folder[] = [];
  try {
    subFolders = listFoldersByParentWithConn(conn, srcFolderId);
  } catch (error) {
    deps.log.warn(
      '[DSTU::handlers] copy_folder_recursive: list_folders_by_parent error, id=%s, error=%s',
      srcFolderId,
      failureMessage(error),
    );
  }
  for (const subFolder of subFolders) {
    try {
      copyFolderRecursive(deps, subFolder.id, newFolder.id, depth + 1);
    } catch (error) {
      deps.log.warn(
        '[DSTU::handlers] copy_folder_recursive: failed to copy subfolder %s: %s',
        subFolder.id,
        failureMessage(error),
      );
    }
  }

  let items: VfsFolderItem[] = [];
  try {
    items = listItemsByFolderWithConn(conn, srcFolderId);
  } catch (error) {
    deps.log.warn(
      '[DSTU::handlers] copy_folder_recursive: list_items_by_folder error, id=%s, error=%s',
      srcFolderId,
      failureMessage(error),
    );
  }
  for (const item of items) {
    try {
      copyResourceToFolder(deps, item, newFolder.id);
    } catch (error) {
      deps.log.warn(
        '[DSTU::handlers] copy_folder_recursive: failed to copy item %s/%s: %s',
        item.itemType,
        item.itemId,
        failureMessage(error),
      );
    }
  }

  const node = createFolderNode(newFolder.id, buildSimpleResourcePath(newFolder.id), newFolder.title);
  return withNodeMetadata(
    withNodeTimestamps(node, newFolder.createdAt, newFolder.updatedAt),
    {
      isExpanded: newFolder.isExpanded,
      isFavorite: newFolder.isFavorite,
      icon: newFolder.icon ?? null,
      color: newFolder.color ?? null,
    },
  );
}

/** `is_subfolder_of` (handlers.rs:2785-2837). */
function isSubfolderOf(
  deps: DstuCopyDeps,
  potentialChild: string,
  potentialParent: string,
): boolean {
  if (potentialChild === potentialParent) return true;
  let currentId = potentialChild;
  let depth = 0;
  const MAX_DEPTH = 100;
  while (depth < MAX_DEPTH) {
    const folder = getFolderWithConn(deps.database.getConnSafe(), currentId);
    if (folder === undefined) return false;
    if (folder.parentId === undefined) return false;
    if (folder.parentId === potentialParent) return true;
    currentId = folder.parentId;
    depth += 1;
  }
  return false;
}

/** `dstu_copy` (handlers.rs:2244-2784). Errors are plain strings. */
export function copyCommand(deps: DstuCopyDeps, src: string, dst: string): DstuNode {
  return command(() => {
    const { resourceType: srcResourceType, id: srcId } = extractResourceInfo(src);
    const conn = deps.database.getConnSafe();

    const trimmedDest = rustTrim(dst);
    let destFolderId: string | undefined;
    if (trimmedDest !== '' && trimmedDest !== '/') {
      let parsed: { resourceType: string; id: string };
      try {
        parsed = extractResourceInfo(dst);
      } catch (error) {
        throw new Error(`Invalid destination path: ${failureMessage(error)}`);
      }
      if (parsed.resourceType !== 'folders') {
        throw new Error('Destination must be a folder');
      }
      destFolderId = parsed.id;
    }

    let node: DstuNode;
    switch (srcResourceType) {
      case 'notes': {
        const note = getNote(deps, srcId);
        if (note === undefined) throw notFound(src);
        const content = getNoteContent(deps, srcId);
        const newNote = notesRepository().createNote(
          { title: `${note.title} (副本)`, content, tags: note.tags },
          conn,
        );
        if (destFolderId !== undefined) {
          try {
            addItemToFolderWithConn(
              conn,
              createFolderItemRecord(destFolderId, 'note', newNote.id),
            );
          } catch (error) {
            deps.log.warn(
              '[DSTU::handlers] dstu_copy: failed to add note to folder %s: %s',
              destFolderId,
              failureMessage(error),
            );
          }
        }
        node = noteToDstuNode(newNote);
        break;
      }
      case 'textbooks': {
        const textbook = getTextbook(deps, srcId);
        if (textbook === undefined) throw notFound(src);
        const newFileName = `${trimTrailingPdf(textbook.fileName)} (副本)`
          + (textbook.fileName.endsWith('.pdf') ? '.pdf' : '');
        const copy = vfsRepositories().textbooks.copyTextbook(conn, textbook.id, newFileName);
        if (destFolderId !== undefined) {
          try {
            addItemToFolderWithConn(
              conn,
              createFolderItemRecord(destFolderId, 'file', copy.id),
            );
          } catch (error) {
            deps.log.warn(
              '[DSTU::handlers] dstu_copy: failed to add textbook to folder %s: %s',
              destFolderId,
              failureMessage(error),
            );
          }
        }
        node = textbookToDstuNode(copy);
        break;
      }
      case 'translations': {
        const translation = getTranslation(deps, srcId);
        if (translation === undefined) throw notFound(src);
        const copy = copyTranslation(
          deps,
          translation,
          translation.title == null ? null : `${translation.title} (副本)`,
        );
        if (destFolderId !== undefined) {
          try {
            addItemToFolderWithConn(
              conn,
              createFolderItemRecord(destFolderId, 'translation', copy.id),
            );
          } catch (error) {
            deps.log.warn(
              '[DSTU::handlers] dstu_copy: failed to add translation to folder %s: %s',
              destFolderId,
              failureMessage(error),
            );
          }
        }
        node = translationToDstuNode(copy);
        break;
      }
      case 'exams': {
        const exam = getExam(deps, srcId);
        if (exam === undefined) throw notFound(src);
        const copy = vfsRepositories().exams.copyExamSheet(conn, srcId, destFolderId ?? null);
        node = examToDstuNode(copy);
        break;
      }
      case 'essays': {
        const session = getSession(deps, srcId);
        if (session === undefined) throw notFound(src);
        const copy = copyEssaySession(deps, session, `${session.title} (副本)`);
        if (destFolderId !== undefined) {
          try {
            addItemToFolderWithConn(
              conn,
              createFolderItemRecord(destFolderId, 'essay', copy.id),
            );
          } catch (error) {
            deps.log.warn(
              '[DSTU::handlers] dstu_copy: failed to add essay to folder %s: %s',
              destFolderId,
              failureMessage(error),
            );
          }
        }
        node = sessionToDstuNode({
          id: copy.id,
          title: copy.title,
          essayType: copy.essay_type,
          gradeLevel: copy.grade_level,
          totalRounds: copy.total_rounds,
          latestScore: copy.latest_score,
          isFavorite: copy.is_favorite,
          createdAt: copy.created_at,
          updatedAt: copy.updated_at,
        });
        break;
      }
      case 'files':
      case 'images': {
        const file = getFile(deps, srcId);
        if (file === undefined) throw notFound(src);
        const copy = vfsRepositories().files.copyFile(conn, srcId, `${file.fileName} (副本)`);
        if (destFolderId !== undefined) {
          const itemType = srcResourceType === 'images' ? 'image' : 'file';
          try {
            addItemToFolderWithConn(
              conn,
              createFolderItemRecord(destFolderId, itemType, copy.id),
            );
          } catch (error) {
            deps.log.warn(
              '[DSTU::handlers] dstu_copy: failed to add file to folder %s: %s',
              destFolderId,
              failureMessage(error),
            );
          }
        }
        node = fileToDstuNode(copy);
        break;
      }
      case 'mindmaps': {
        const mindmap = getMindmap(deps, srcId);
        if (mindmap === undefined) throw notFound(src);
        const params: CreateMindMapParams = {
          title: `${mindmap.title} (副本)`,
          description: mindmap.description ?? null,
          content: getMindmapContent(deps, srcId),
          defaultView: mindmap.defaultView,
          theme: mindmap.theme ?? null,
        };
        const copy = createMindmapInFolderWithConn(conn, params, destFolderId);
        node = mindmapToDstuNode(copy);
        break;
      }
      case 'folders': {
        if (destFolderId !== undefined && isSubfolderOf(deps, destFolderId, srcId)) {
          deps.log.warn(
            '[DSTU::handlers] dstu_copy: FAILED - circular reference detected, src=%s, dest=%s',
            srcId,
            destFolderId,
          );
          throw new Error('Cannot copy a folder into itself or its subfolder');
        }
        node = copyFolderRecursive(deps, srcId, destFolderId, 0);
        break;
      }
      default:
        throw invalidNodeType(srcResourceType);
    }

    emitDstuWatchEvent(deps, createdEvent(node.path, node));
    return node;
  });
}
