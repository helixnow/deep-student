/** dstu/handlers.rs `dstu_update` (handlers.rs:1439-1660). */
import { CommandError } from '../../../kernel/api.ts';
import type { VfsDatabase } from '../api.ts';
import { updatedEvent, type DstuNode } from './dstu-types.ts';
import type { NoteLeaseAuth } from '../../../../contracts/ipc/generated/_shared.ts';
import { DstuFailure } from './dstu-error.ts';
import { noteToDstuNode } from './node-converters.ts';
import { parseRfc3339 } from '../../../platform/time/index.ts';
import { getResourceByTypeAndId } from './dstu-resource.ts';
import { emitDstuWatchEvent, type LocationDeps } from './locations.ts';
import { parseSerdeJson } from '../repository/json.ts';
import { parseJsonDocument, stringifyJsonValue } from '../../../platform/util/api.ts';
import { notesLeaseRepository } from '../repository/services.ts';
import {
  getEssayWithConn,
  getMindmapWithConn,
  getNoteWithConn,
  getTranslationWithConn,
} from '../repository/resources.ts';
import {
  authorizedNoteLeaseWrite,
  updateEssaySessionWithConn,
  updateExamPreviewJsonTextWithConn,
  updateMindmapContentWithConn,
  updateNoteWithConn,
  updateResourceDataWithConn,
} from '../repository/update.ts';

const MAX_CONTENT_SIZE = 1024 * 1024;

export interface DstuUpdateArgs {
  path: string;
  content: string;
  resourceType: string;
  expectedUpdatedAtMs?: number | null;
  lease?: NoteLeaseAuth | null;
}

export interface DstuUpdateDeps {
  readonly database: VfsDatabase;
  readonly log: LocationDeps['log'];
  readonly emit?: (event: string, payload: unknown) => void;
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

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function contentLimitError(contentBytes: number): string {
  return `内容大小超出限制: ${contentBytes} 字节 `
    + `(${(contentBytes / (1024 * 1024)).toFixed(2)} MB) `
    + `(最大允许: ${MAX_CONTENT_SIZE} 字节 (${MAX_CONTENT_SIZE / (1024 * 1024)} MB))`;
}

function parseJsonOr(content: string, label: string): unknown {
  try {
    return parseSerdeJson(content);
  } catch (error) {
    throw new Error(`Invalid JSON content for ${label}: ${failureMessage(error)}`);
  }
}

function stringField(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key];
  return typeof value === 'string' ? value : undefined;
}

function updateTranslationContent(
  deps: DstuUpdateDeps,
  translationId: string,
  content: string,
): void {
  const parsed = parseJsonOr(content, 'translation');
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "Translation content must contain at least 'source' or 'translated' field",
    );
  }
  const object = parsed as Record<string, unknown>;
  if (!('source' in object) && !('translated' in object)) {
    throw new Error(
      "Translation content must contain at least 'source' or 'translated' field",
    );
  }

  const conn = deps.database.getConnSafe();
  let translation;
  try {
    translation = getTranslationWithConn(conn, translationId);
  } catch (error) {
    throw new Error(`Failed to get translation: ${failureMessage(error)}`);
  }
  if (translation === undefined) {
    throw new Error(`Translation not found: ${translationId}`);
  }
  try {
    updateResourceDataWithConn(conn, translation.resourceId, content);
  } catch (error) {
    throw new Error(`Failed to update translation content: ${failureMessage(error)}`);
  }
}

/** `serde_json::from_str::<Value>` → `to_string`: arbitrary_precision keeps number spelling, preserve_order keeps keys. */
function updateExamContent(deps: DstuUpdateDeps, examId: string, content: string): void {
  parseJsonOr(content, 'exam');
  const previewText = stringifyJsonValue(parseJsonDocument(content));
  try {
    updateExamPreviewJsonTextWithConn(deps.database.getConnSafe(), examId, previewText);
  } catch (error) {
    throw new Error(`Failed to update exam content: ${failureMessage(error)}`);
  }
}

function updateEssayContent(deps: DstuUpdateDeps, id: string, content: string): void {
  const conn = deps.database.getConnSafe();
  if (id.startsWith('essay_session_')) {
    const parsed = parseJsonOr(content, 'essay session');
    const object = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
    const title = stringField(object, 'title');
    const isFavorite = typeof object.is_favorite === 'boolean' ? object.is_favorite : undefined;
    const essayType = stringField(object, 'essayType');
    const gradeLevel = stringField(object, 'gradeLevel');
    const customPrompt = stringField(object, 'customPrompt');
    if (title === undefined
      && isFavorite === undefined
      && essayType === undefined
      && gradeLevel === undefined
      && customPrompt === undefined) {
      throw new Error(
        'Essay session update requires at least one field: '
        + 'title/is_favorite/essayType/gradeLevel/customPrompt',
      );
    }
    try {
      updateEssaySessionWithConn(conn, id, { title, isFavorite, essayType, gradeLevel, customPrompt });
    } catch (error) {
      throw new Error(`Failed to update essay session: ${failureMessage(error)}`);
    }
    return;
  }

  let essay;
  try {
    essay = getEssayWithConn(conn, id);
  } catch (error) {
    throw new Error(`Failed to get essay: ${failureMessage(error)}`);
  }
  if (essay === undefined) {
    throw new Error(`Essay not found: ${id}`);
  }
  try {
    updateResourceDataWithConn(conn, essay.resourceId, content);
  } catch (error) {
    throw new Error(`Failed to update essay content: ${failureMessage(error)}`);
  }
}

/** `update_content_by_type` (content_helpers.rs:522-620). */
export function updateContentByType(
  deps: DstuUpdateDeps,
  resourceType: string,
  id: string,
  content: string,
): void {
  const contentBytes = byteLength(content);
  if (contentBytes > MAX_CONTENT_SIZE) throw new Error(contentLimitError(contentBytes));

  switch (resourceType) {
    case 'notes':
    case 'note':
      updateNoteWithConn(deps.database.getConnSafe(), id, { content });
      return;
    case 'translations':
    case 'translation':
      updateTranslationContent(deps, id, content);
      return;
    case 'mindmaps':
    case 'mindmap':
      updateMindmapContentWithConn(deps.database.getConnSafe(), id, { content }, deps.log);
      return;
    case 'exams':
    case 'exam':
      updateExamContent(deps, id, content);
      return;
    case 'textbooks':
    case 'textbook':
      throw new Error('Textbook content update not supported: PDF files cannot be directly edited');
    case 'files':
    case 'file':
    case 'images':
    case 'image':
      throw new Error(
        `${resourceType} content update not supported: binary files cannot be directly edited`,
      );
    case 'essays':
    case 'essay':
      updateEssayContent(deps, id, content);
      return;
    default:
      throw new DstuFailure('InvalidNodeType', resourceType);
  }
}

function fetchUpdatedNode(deps: DstuUpdateDeps, resourceType: string, id: string): DstuNode {
  const node = getResourceByTypeAndId(deps, resourceType, id);
  if (node === null) throw new DstuFailure('NotFound', id);
  return node;
}

/** `dstu_update` (handlers.rs:1439-1660). `webview` feeds `NoteLeaseRepo::authorized`. */
export function updateCommand(
  deps: DstuUpdateDeps,
  args: DstuUpdateArgs,
  webview: string,
): DstuNode {
  return command(() => {
    const contentBytes = byteLength(args.content);
    if (contentBytes > MAX_CONTENT_SIZE) throw new Error(contentLimitError(contentBytes));

    const id = args.path.replace(/^\/+/, '');
    if (id === '') {
      throw new DstuFailure('InvalidPath', 'Update path must contain resource ID');
    }

    let node: DstuNode;
    switch (args.resourceType) {
      case 'notes':
      case 'note': {
        const conn = deps.database.getConnSafe();
        let expectedUpdatedAt: string | undefined;
        if (args.expectedUpdatedAtMs !== null && args.expectedUpdatedAtMs !== undefined) {
          const current = getNoteWithConn(conn, id);
          if (current === undefined) throw new Error(`Note not found: ${id}`);
          const currentMs = parseRfc3339(current.updatedAt)?.millis ?? 0;
          if (currentMs > args.expectedUpdatedAtMs) {
            throw new Error(
              'CONFLICT(notes.conflict): The note has been updated elsewhere, please refresh. '
              + `(expected=${args.expectedUpdatedAtMs}, actual=${currentMs})`,
            );
          }
          expectedUpdatedAt = current.updatedAt;
        }
        const params = { content: args.content, expectedUpdatedAt };
        const updated = args.lease === null || args.lease === undefined
          ? updateNoteWithConn(conn, id, params)
          : authorizedNoteLeaseWrite(
            conn,
            args.lease,
            webview,
            notesLeaseRepository().now(),
            true,
            () => updateNoteWithConn(conn, id, params),
          );
        node = noteToDstuNode(updated);
        break;
      }
      case 'textbooks':
      case 'textbook':
        throw new Error('Textbook content update not supported');
      case 'mindmaps':
      case 'mindmap': {
        const conn = deps.database.getConnSafe();
        let expectedUpdatedAt: string | undefined;
        if (args.expectedUpdatedAtMs !== null && args.expectedUpdatedAtMs !== undefined) {
          const current = getMindmapWithConn(conn, id);
          if (current === undefined) throw new Error(`Mindmap not found: ${id}`);
          const currentMs = parseRfc3339(current.contentUpdatedAt)?.millis ?? 0;
          if (currentMs > args.expectedUpdatedAtMs) {
            throw new Error(
              'MINDMAP_UPDATE_CONFLICT: The mindmap has been updated elsewhere, please refresh. '
              + `(expected=${args.expectedUpdatedAtMs}, actual=${currentMs})`,
            );
          }
          expectedUpdatedAt = current.contentUpdatedAt;
        }
        try {
          updateMindmapContentWithConn(conn, id, {
            content: args.content,
            expectedUpdatedAt,
          }, deps.log);
        } catch (error) {
          throw new Error(`Failed to update mindmap content: ${failureMessage(error)}`);
        }
        node = fetchUpdatedNode(deps, 'mindmaps', id);
        break;
      }
      case 'translations':
      case 'translation':
      case 'exams':
      case 'exam':
      case 'essays':
      case 'essay': {
        updateContentByType(deps, args.resourceType, id, args.content);
        const plural = args.resourceType === 'translation' || args.resourceType === 'translations'
          ? 'translations'
          : args.resourceType === 'exam' || args.resourceType === 'exams'
            ? 'exams'
            : 'essays';
        node = fetchUpdatedNode(deps, plural, id);
        break;
      }
      case 'images':
      case 'image':
      case 'files':
      case 'file':
        throw new Error(
          `${args.resourceType} content update not supported: binary files cannot be directly edited`,
        );
      default:
        throw new DstuFailure('InvalidNodeType', args.resourceType);
    }

    emitDstuWatchEvent(deps, updatedEvent(args.path, node));
    return node;
  });
}
