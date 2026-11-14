/** `get_resource_by_type_and_id` (dstu/handler_utils/crud.rs:27-150). */
import type { VfsDatabase } from '../api.ts';
import type { DstuNode } from './dstu-types.ts';
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
import {
  getEssaySessionWithConn,
  getEssayWithConn,
  getExamWithConn,
  getFileWithConn,
  getMindmapWithConn,
  getNoteWithConn,
  getTextbookWithConn,
  getTranslationWithConn,
} from '../repository/resources.ts';

export interface ResourceFetchDeps {
  readonly database: VfsDatabase;
}

/** Rust `Ok(None)` maps to `null`; storage failures propagate as thrown errors. */
export function getResourceByTypeAndId(
  deps: ResourceFetchDeps,
  resourceType: string,
  id: string,
): DstuNode | null {
  const conn = deps.database.getConnSafe();
  switch (resourceType) {
    case 'notes': {
      const note = getNoteWithConn(conn, id);
      return note === undefined ? null : noteToDstuNode(note);
    }
    case 'textbooks': {
      const textbook = getTextbookWithConn(conn, id);
      return textbook === undefined ? null : textbookToDstuNode(textbook);
    }
    case 'translations': {
      const translation = getTranslationWithConn(conn, id);
      return translation === undefined ? null : translationToDstuNode(translation);
    }
    case 'exams': {
      const exam = getExamWithConn(conn, id);
      return exam === undefined ? null : examToDstuNode(exam);
    }
    case 'essays': {
      const essay = getEssayWithConn(conn, id);
      if (essay !== undefined) return essayToDstuNode(essay);
      const session = getEssaySessionWithConn(conn, id);
      return session === undefined ? null : sessionToDstuNode(session);
    }
    case 'files':
    case 'attachments': {
      const file = getFileWithConn(conn, id);
      return file === undefined ? null : fileToDstuNode(file);
    }
    case 'mindmaps': {
      const mindmap = getMindmapWithConn(conn, id);
      return mindmap === undefined ? null : mindmapToDstuNode(mindmap);
    }
    default:
      throw new Error(`Unsupported resource type: ${resourceType}`);
  }
}
