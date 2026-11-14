// Rust chatanki_executor.rs: resolve_target_context_refs (:10392), extract_latest_user_content (:9084),
// resolve_context_ref_from_any_id / resolve_context_ref_from_vfs_source /
// resolve_file_like_source_id_by_resource_id (:10549–10690), and the
// `files.extracted_text` reads in collect_ref_text_for_metrics (:9208).
// Built on L04 `chatSession.getSessionMessages` and L11 `vfsDatabase` + `vfsRepo`.
import type { ChatAnkiRefResolver, ContextRef, VfsResourceRef } from '../api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { VfsFile, VfsReposService } from '../../vfs-repos/api.ts';
import { rustTrim } from '../../../platform/util/text.ts';
import { unsupportedChatankiResourceMessage } from './context-refs.ts';
import { looksLikeMaterialText } from './run-vfs-text.ts';

export interface ChatAnkiSessionMessageSource {
  getSessionMessages(sessionId: string): ReadonlyArray<{
    _meta?: { contextSnapshot?: { userRefs?: readonly ContextRef[] | null } | null } | null;
  }>;
}

export interface ChatAnkiVfsReadSource {
  repos: VfsReposService;
  conn(): SqlExecutor;
}

/** L04 reads behind `extract_latest_user_content` (:9084) and `resolve_target_context_refs` (:10392). */
export interface ChatAnkiSessionHistorySource {
  getSessionMessages(sessionId: string): ReadonlyArray<{
    id: string;
    role: string;
    _meta?: { contextSnapshot?: { userRefs?: readonly ContextRef[] | null } | null } | null;
  }>;
  getMessageBlocks(messageId: string): ReadonlyArray<{ type: string; content?: string | null }>;
}

const SESSION_REF_TYPES = new Set(['file', 'image', 'folder']);

/**
 * `resolve_target_context_refs`: with ids, the newest snapshot ref per id in request order (none found is
 * an `Err`); without ids, the newest snapshot that has any file/image/folder ref.
 */
export function resolveTargetContextRefs(
  messages: ChatAnkiSessionHistorySource, sessionId: string, preferredIds: readonly string[] | null,
): ContextRef[] {
  const history = messages.getSessionMessages(sessionId);
  if (preferredIds !== null) {
    const preferred: string[] = [];
    for (const id of preferredIds) {
      if (rustTrim(id).length === 0 || preferred.includes(id)) continue;
      preferred.push(id);
    }
    if (preferred.length === 0) return [];
    const found = new Map<string, ContextRef>();
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const userRefs = history[index]?._meta?.contextSnapshot?.userRefs;
      if (userRefs === undefined || userRefs === null) continue;
      for (const ref of userRefs) {
        if (!SESSION_REF_TYPES.has(ref.typeId) || !preferred.includes(ref.resourceId)) continue;
        if (!found.has(ref.resourceId)) found.set(ref.resourceId, ref);
      }
      if (found.size >= preferred.length) break;
    }
    if (found.size === 0) {
      throw new Error(`Preferred resource not found in current session context: ${preferred.join(',')}`);
    }
    return preferred.flatMap((id) => {
      const ref = found.get(id);
      return ref === undefined ? [] : [ref];
    });
  }
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const userRefs = history[index]?._meta?.contextSnapshot?.userRefs;
    if (userRefs === undefined || userRefs === null) continue;
    const refs = userRefs.filter((ref) => SESSION_REF_TYPES.has(ref.typeId));
    if (refs.length > 0) return [...refs];
  }
  return [];
}

/** `extract_latest_user_content`: the newest user message whose joined content blocks look like material. */
export function extractLatestUserContent(messages: ChatAnkiSessionHistorySource, sessionId: string): string | null {
  const history = messages.getSessionMessages(sessionId);
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    if (message.role !== 'user') continue;
    const parts: string[] = [];
    for (const block of messages.getMessageBlocks(message.id)) {
      if (block.type !== 'content' || block.content === undefined || block.content === null) continue;
      const trimmed = rustTrim(block.content);
      if (trimmed.length > 0) parts.push(trimmed);
    }
    const joined = rustTrim(parts.join('\n\n'));
    if (joined.length === 0) continue;
    if (looksLikeMaterialText(joined)) return joined;
  }
  return null;
}

/**
 * `resolve_target_context_refs(..., Some(ids))`: newest snapshot wins per id,
 * returned in request order. Rust's "none found" `Err` is swallowed by every
 * analyze caller, so it is an empty list here.
 */
export function resolveSessionContextRefs(
  messages: ChatAnkiSessionMessageSource, sessionId: string, requestedIds: readonly string[],
): ContextRef[] {
  const preferred: string[] = [];
  for (const id of requestedIds) {
    if (rustTrim(id).length === 0 || preferred.includes(id)) continue;
    preferred.push(id);
  }
  if (preferred.length === 0) return [];
  const found = new Map<string, ContextRef>();
  const history = messages.getSessionMessages(sessionId);
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const userRefs = history[index]?._meta?.contextSnapshot?.userRefs;
    if (userRefs === undefined || userRefs === null) continue;
    for (const ref of userRefs) {
      if (!SESSION_REF_TYPES.has(ref.typeId) || !preferred.includes(ref.resourceId)) continue;
      if (!found.has(ref.resourceId)) found.set(ref.resourceId, ref);
    }
    if (found.size >= preferred.length) break;
  }
  return preferred.flatMap((id) => {
    const ref = found.get(id);
    return ref === undefined ? [] : [ref];
  });
}

/** `resolve_context_ref_from_vfs_source`: live file row joined to a live resource with a non-empty hash. */
function resolveContextRefFromVfsSource(vfs: ChatAnkiVfsReadSource, sourceId: string): ContextRef | null {
  if (!sourceId.startsWith('file_') && !sourceId.startsWith('tb_') && !sourceId.startsWith('att_')) return null;
  const conn = vfs.conn();
  const file = vfs.repos.files.getFile(conn, sourceId);
  if (file === null || file.deletedAt !== undefined || file.resourceId === undefined) return null;
  const resource = vfs.repos.resources.getLiveResource(conn, file.resourceId);
  const hash = resource?.hash ?? '';
  if (rustTrim(hash).length === 0) return null;
  const typeId = file.fileType.toLowerCase() === 'image' || (file.mimeType ?? '').toLowerCase().startsWith('image/')
    ? 'image' : 'file';
  const ref: ContextRef = { resourceId: sourceId, hash, typeId };
  if (rustTrim(file.fileName).length > 0) ref.displayName = file.fileName;
  return ref;
}

/** `resolve_file_like_source_id_by_resource_id`: a live file whose resource_id is this resource. */
function resolveFileLikeSourceIdByResourceId(vfs: ChatAnkiVfsReadSource, resourceId: string): string | null {
  const conn = vfs.conn();
  const fileId = vfs.repos.attachments.resolveFileId(conn, resourceId);
  if (fileId === null) return null;
  const file: VfsFile | null = vfs.repos.files.getFile(conn, fileId);
  return file !== null && file.deletedAt === undefined && file.resourceId === resourceId ? file.id : null;
}

/** `resolve_context_ref_from_any_id`: unsupported kinds and unmappable resources throw (Rust `Err`). */
export function resolveContextRefFromAnyId(vfs: ChatAnkiVfsReadSource, rawId: string): ContextRef | null {
  const trimmed = rustTrim(rawId);
  if (trimmed.length === 0) return null;
  const unsupported = unsupportedChatankiResourceMessage(trimmed);
  if (unsupported !== null) throw new Error(unsupported);
  const direct = resolveContextRefFromVfsSource(vfs, trimmed);
  if (direct !== null) return direct;
  if (!trimmed.startsWith('res_')) return null;

  const resource = vfs.repos.resources.getResource(vfs.conn(), trimmed);
  if (resource === null) throw new Error(`Resource '${trimmed}' not found in VFS.`);
  if (resource.sourceId !== undefined) {
    const unsupportedSource = unsupportedChatankiResourceMessage(resource.sourceId);
    if (unsupportedSource !== null) throw new Error(unsupportedSource);
    const bySource = resolveContextRefFromVfsSource(vfs, resource.sourceId);
    if (bySource !== null) return bySource;
  }

  let sourceId: string | null;
  switch (resource.type) {
    case 'file': case 'image': case 'textbook':
      sourceId = resolveFileLikeSourceIdByResourceId(vfs, resource.id);
      break;
    case 'mindmap':
      throw new Error(`Resource '${trimmed}' is a mindmap resource and cannot be used directly by chatanki_run. Please choose the underlying file/image resource instead.`);
    case 'note':
      throw new Error(`Resource '${trimmed}' is a note resource and cannot be used directly by chatanki_run. Please export or attach the source file/text first.`);
    case 'exam': case 'essay': case 'translation':
      throw new Error(`Resource '${trimmed}' has unsupported type '${resource.type}' for chatanki_run direct input.`);
    case 'insight_card': case 'insightcard':
      throw new Error(`Resource '${trimmed}' is an insight card; use the insight SRS projection channel instead of chatanki_run.`);
    default:
      sourceId = null;
  }
  if (sourceId === null) {
    throw new Error(`Resource '${trimmed}' exists, but chatanki_run cannot map it to a readable file/image source ID.`);
  }
  return resolveContextRefFromVfsSource(vfs, sourceId);
}

/**
 * File refs read `substr(extracted_text, 1, maxChars)` by source id (no deleted
 * filter, as in Rust); images have none; other refs use their snippet.
 */
export function refTextFromVfs(vfs: ChatAnkiVfsReadSource, ref: VfsResourceRef, maxChars: number): string | null {
  if (ref.type === 'image') return null;
  if (ref.type !== 'file') return ref.snippet ?? null;
  const text = vfs.repos.files.getFile(vfs.conn(), ref.sourceId)?.extractedText;
  if (text === undefined) return null;
  const chars = [...text];
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join('');
}

/** Session snapshot refs need only chat; VFS fallback and file text need the VFS services (else unresolved). */
export function createChatAnkiRefResolver(
  messages: ChatAnkiSessionMessageSource, vfs: () => ChatAnkiVfsReadSource | null,
): ChatAnkiRefResolver {
  return {
    resolveSessionRefs: (sessionId, ids) => resolveSessionContextRefs(messages, sessionId, ids),
    resolveVfsRef: (id) => {
      const source = vfs();
      return source === null ? null : resolveContextRefFromAnyId(source, id);
    },
    refText: (ref, maxChars) => {
      const source = vfs();
      return source === null ? null : refTextFromVfs(source, ref, maxChars);
    },
  };
}
