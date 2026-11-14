import { CommandError } from '../../../kernel/api.ts';
import type { VfsDatabase } from '../api.ts';
import { createFolderNode, withNodeMetadata, withNodeTimestamps, type DstuNode } from './dstu-types.ts';
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
import { parseDstuPath } from './paths.ts';
import { extractResourceInfo, isUuidFormat } from './path-utils.ts';
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

export interface DstuGetDeps {
  readonly database: VfsDatabase;
}

function command<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(error instanceof Error ? error.message : String(error));
  }
}

function folderNode(folder: { id: string; title: string; createdAt: number; updatedAt: number }, path: string): DstuNode {
  return withNodeTimestamps(createFolderNode(folder.id, path, folder.title), folder.createdAt, folder.updatedAt);
}

function fallbackLookupUuidResource(deps: DstuGetDeps, conn: ReturnType<VfsDatabase['getConnSafe']>, id: string): DstuNode | null {
  const textbook = getTextbookWithConn(conn, id);
  if (textbook !== undefined) return textbookToDstuNode(textbook);
  const note = getNoteWithConn(conn, id);
  if (note !== undefined) return noteToDstuNode(note);
  const exam = getExamWithConn(conn, id);
  if (exam !== undefined) return examToDstuNode(exam);
  const translation = getTranslationWithConn(conn, id);
  if (translation !== undefined) return translationToDstuNode(translation);
  const essay = getEssayWithConn(conn, id);
  if (essay !== undefined) return essayToDstuNode(essay);
  return null;
}

export function getFileNode(conn: ReturnType<VfsDatabase['getConnSafe']>, id: string): DstuNode | null {
  const file = getFileWithConn(conn, id);
  if (file === undefined) return null;
  const node = fileToDstuNode(file);
  if (node.type !== 'textbook') return node;
  const pdf = getTextbookWithConn(conn, id);
  return withNodeMetadata(node, {
    ...(node.metadata as Record<string, unknown> | undefined),
    highlights: pdf?.highlights ?? [],
    annotationRevision: file.updatedAt,
    ...(file.ocrPagesJson ? { ocrPagesJson: file.ocrPagesJson } : {}),
  });
}

function getTextbookNode(conn: ReturnType<VfsDatabase['getConnSafe']>, id: string): DstuNode | null {
  const textbook = getTextbookWithConn(conn, id);
  if (textbook === undefined) return null;
  const node = textbookToDstuNode(textbook);
  const ocrPagesJson = getFileWithConn(conn, id)?.ocrPagesJson;
  return ocrPagesJson ? withNodeMetadata(node, { ...(node.metadata as Record<string, unknown> | undefined), ocrPagesJson }) : node;
}

/** `dstu_get` (handlers.rs:467-660). */
export function getCommand(deps: DstuGetDeps, path: string): DstuNode | null {
  return command(() => {
    const { resourceType, id } = extractResourceInfo(path);
    const conn = deps.database.getConnSafe();
    switch (resourceType) {
      case 'notes': {
        const note = getNoteWithConn(conn, id);
        return note === undefined ? null : noteToDstuNode(note);
      }
      case 'textbooks': {
        return getTextbookNode(conn, id);
      }
      case 'exams': {
        const exam = getExamWithConn(conn, id);
        return exam === undefined ? null : examToDstuNode(exam);
      }
      case 'translations': {
        const translation = getTranslationWithConn(conn, id);
        return translation === undefined ? null : translationToDstuNode(translation);
      }
      case 'essays': {
        const essay = getEssayWithConn(conn, id);
        if (essay !== undefined) return essayToDstuNode(essay);
        const session = getEssaySessionWithConn(conn, id);
        return session === undefined ? null : sessionToDstuNode(session);
      }
      case 'folders': {
        const folder = getFolderWithConn(conn, id);
        if (folder !== undefined) return folderNode(folder, `/${folder.id}`);
        return isUuidFormat(id) ? fallbackLookupUuidResource(deps, conn, id) : null;
      }
      case 'mindmaps': {
        const mindmap = getMindmapWithConn(conn, id);
        return mindmap === undefined ? null : mindmapToDstuNode(mindmap);
      }
      case 'files': {
        return getFileNode(conn, id);
      }
      default:
        return null;
    }
  });
}

/** `dstu_get_resource_by_path` (handlers.rs:6042-6130). */
export function getResourceByPathCommand(deps: DstuGetDeps, path: string): DstuNode | null {
  return command(() => {
    const parsed = parseDstuPath(path);
    if (parsed.isRoot) return createFolderNode('root', '/', '根目录');
    if (parsed.isVirtual) {
      const name = parsed.fullPath.replace(/^\/@/, '');
      return createFolderNode(`@${name}`, parsed.fullPath, name);
    }
    if (parsed.resourceId === null) return null;

    const resourceId = parsed.resourceId;
    const conn = deps.database.getConnSafe();
    switch (parsed.resourceType) {
      case 'note': {
        const note = getNoteWithConn(conn, resourceId);
        return note === undefined ? null : noteToDstuNode(note);
      }
      case 'textbook': {
        return getTextbookNode(conn, resourceId);
      }
      case 'exam': {
        const exam = getExamWithConn(conn, resourceId);
        return exam === undefined ? null : examToDstuNode(exam);
      }
      case 'translation': {
        const translation = getTranslationWithConn(conn, resourceId);
        return translation === undefined ? null : translationToDstuNode(translation);
      }
      case 'essay': {
        const session = getEssaySessionWithConn(conn, resourceId);
        return session === undefined ? null : sessionToDstuNode(session);
      }
      case 'folder': {
        const folder = getFolderWithConn(conn, resourceId);
        return folder === undefined ? null : createFolderNode(folder.id, parsed.fullPath, folder.title);
      }
      case 'file': {
        return getFileNode(conn, resourceId);
      }
      default:
        return null;
    }
  });
}
