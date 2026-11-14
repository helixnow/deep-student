/**
 * Retry / edit-and-resend restoration helpers. Rust source:
 * `chat_v2/handlers/send_message.rs:264-269,344-438,1700-1997`.
 * Resource rows belong to L11 (`vfsRepo.resources`), dereferencing to L05
 * (`agentVfsResolver`); this module only orchestrates them.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { ResourceRepository } from '../../vfs-repos/api.ts';
import type { VfsContextRefData, VfsResourceRef } from '../../agent-workspace/api.ts';
import type { SendContextRef, SendOptions } from '../../../../contracts/ipc/generated/_shared.ts';
import type { BackendSendOptions } from '../../chat-pipeline/api.ts';
import type { ChatMessage, ContextSnapshot, MessageMeta } from '../api.ts';
import { getMessageBlocks } from '../repository/blocks.ts';
import { getSessionMessages } from '../repository/messages.ts';
import { ChatV2Error } from './error.ts';
import { errorText, type ChatLogger } from './logger.ts';
import { compareUtf8, utf8ByteLength } from '../../../platform/util/portable.ts';

type FormattedBlock = SendContextRef['formattedBlocks'][number];

/** The resource and dereference owners this module consumes. */
export interface ContextRefRestoreDeps {
  /** `vfs_db.get_conn_safe()`. */
  getConnection(): SqlExecutor;
  resources: Pick<ResourceRepository, 'getByHash' | 'getResource'>;
  /** L05 `resolve_context_ref_data_to_blocks` bound to vfs.db and its blobs dir. */
  resolveContextRefDataToBlocks(data: VfsContextRefData, isMultimodal: boolean): Promise<FormattedBlock[]>;
}

/** `apply_replay_mode_overrides` (send_message.rs:264-269). */
export function applyReplayModeOverrides<T extends SendOptions>(options: T): T {
  return options.replayMode == null ? options : { ...options, temperature: 0 };
}

function isOriginalReplay(mode: SendOptions['replayMode']): boolean {
  return mode === 'original' || (mode !== null && typeof mode === 'object' && 'original' in mode);
}

/** Rust `Vec<String>::sort` + `dedup` (byte order, adjacent duplicates). */
function sortDedup(values: readonly string[]): string[] {
  const sorted = [...values].sort((a, b) => compareUtf8(a, b));
  return sorted.filter((value, index) => index === 0 || value !== sorted[index - 1]);
}

/** `apply_original_skill_snapshot_overrides` (send_message.rs:344-438). */
export function applyOriginalSkillSnapshotOverrides(options: BackendSendOptions,
  preferred: MessageMeta | null | undefined, fallback: MessageMeta | null | undefined): BackendSendOptions {
  if (!isOriginalReplay(options.replayMode)) return options;
  if (options.skillAdmissionErrors != null) return options;
  const snapshot = preferred?.skillSnapshotAfter ?? preferred?.skillSnapshotBefore
    ?? fallback?.skillSnapshotAfter ?? fallback?.skillSnapshotBefore ?? null;
  const runtime = preferred?.skillRuntimeAfter ?? preferred?.skillRuntimeBefore
    ?? fallback?.skillRuntimeAfter ?? fallback?.skillRuntimeBefore ?? null;
  if (snapshot === null && runtime === null) return options;
  const next: BackendSendOptions = { ...options };
  let pinned = runtime?.activeSkillIds ?? [];
  if (snapshot !== null) pinned = snapshot.manualPinnedSkillIds ?? [];
  pinned = sortDedup(pinned);
  if (pinned.length > 0) next.activeSkillIds = pinned;
  const allowed = runtime?.executionAllowedTools;
  if (allowed != null) next.executionAllowedTools = sortDedup(allowed);
  if (runtime !== null) {
    const contents = runtime.skillContents ?? {};
    if (Object.keys(contents).length > 0) {
      next.skillContents = structuredClone(contents);
      next.replaySkillContents = structuredClone(contents);
    }
    const dependencies = runtime.skillDependencies ?? {};
    if (Object.keys(dependencies).length > 0) next.skillDependencies = structuredClone(dependencies);
    const embedded = runtime.skillEmbeddedTools ?? {};
    if (Object.keys(embedded).length > 0) {
      next.skillEmbeddedTools = structuredClone(embedded) as NonNullable<SendOptions['skillEmbeddedTools']>;
    }
    const schemas = runtime.mcpToolSchemas ?? [];
    if (schemas.length > 0) next.mcpToolSchemas = structuredClone(schemas) as NonNullable<SendOptions['mcpToolSchemas']>;
    const servers = runtime.selectedMcpServers ?? [];
    if (servers.length > 0) next.mcpTools = [...servers];
  } else if (snapshot !== null) {
    const servers = snapshot.effectiveAllowedExternalServers ?? [];
    if (servers.length > 0) next.mcpTools = [...servers];
  }
  return next;
}

/** `get_message_content` (send_message.rs:1700-1720). */
export function getMessageContent(db: SqlExecutor, messageId: string): string {
  const content = getMessageBlocks(db, messageId)
    .filter(block => block.type === 'content')
    .flatMap(block => block.content == null ? [] : [block.content])
    .join('');
  if (content === '') throw new ChatV2Error('Other', 'Message has no content blocks');
  return content;
}

/** `locate_preceding_user_message` (send_message.rs:1727-1742). */
export function locatePrecedingUserMessage(messages: readonly ChatMessage[], assistant: ChatMessage): ChatMessage | undefined {
  const position = messages.findIndex(message => message.id === assistant.id);
  if (position >= 0) return messages.slice(0, position).reverse().find(message => message.role === 'user');
  return [...messages].reverse().find(message => message.role === 'user' && message.timestamp <= assistant.timestamp);
}

export interface UserMessageRestoreResult {
  content: string;
  messageMeta: MessageMeta | null;
  contextSnapshot: ContextSnapshot | null;
  timestamp: number;
}

/** `find_preceding_user_message_with_attachments` (send_message.rs:1809-1847). */
export function findPrecedingUserMessageWithAttachments(db: SqlExecutor, sessionId: string,
  assistant: ChatMessage): UserMessageRestoreResult {
  const message = locatePrecedingUserMessage(getSessionMessages(db, sessionId), assistant);
  if (message === undefined) throw new ChatV2Error('Other', 'No preceding user message found');
  const content = getMessageContent(db, message.id);
  return { content, messageMeta: message._meta ?? null,
    contextSnapshot: message._meta?.contextSnapshot ?? null, timestamp: message.timestamp };
}

const STAGED_PREFIX = '__staged_attachment__:';

/** `filter_path_map_for_send_refs` (send_message.rs:1774-1807). */
export function filterPathMapForSendRefs(pathMap: Record<string, string> | null | undefined,
  refs: readonly SendContextRef[] | null | undefined): Record<string, string> | null {
  if (pathMap == null || refs == null) return null;
  const entries = Object.entries(pathMap);
  if (entries.length === 0 || refs.length === 0) return null;
  const keep = new Set(refs.map(ref => ref.resourceId));
  const filtered = entries.filter(([key]) => keep.has(key) || (key.startsWith(STAGED_PREFIX)
    && [...keep].some(resourceId => key.slice(STAGED_PREFIX.length).startsWith(`${resourceId}:`))));
  return filtered.length === 0 ? null : Object.fromEntries(filtered);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function unitEnum<T extends string>(value: unknown, variants: readonly T[]): T | null {
  if (record(value)) {
    const keys = Object.keys(value);
    if (keys.length !== 1 || value[keys[0]!] !== null) return null;
    value = keys[0];
  }
  return typeof value === 'string' && variants.includes(value as T) ? value as T : null;
}
const RESOURCE_TYPES = ['note', 'textbook', 'exam', 'translation', 'essay', 'image',
  'file', 'retrieval', 'mindmap', 'insightcard'] as const;

/** `serde_json::from_str::<VfsContextRefData>`: any mismatch takes the legacy branch. */
export function decodeVfsContextRefData(text: string): VfsContextRefData | null {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return null; }
  if (!record(data) || !Array.isArray(data.refs)) return null;
  if (data.truncated !== undefined && typeof data.truncated !== 'boolean') return null;
  if (data.totalCount !== undefined && (typeof data.totalCount !== 'number'
    || !Number.isInteger(data.totalCount) || data.totalCount < 0 || data.totalCount >= 2 ** 64)) return null;
  const refs: VfsResourceRef[] = [];
  for (const raw of data.refs) {
    if (!record(raw) || typeof raw.sourceId !== 'string' || typeof raw.resourceHash !== 'string'
      || typeof raw.name !== 'string') return null;
    const type = unitEnum(raw.type, RESOURCE_TYPES);
    if (type === null) return null;
    if ([raw.resourceId, raw.snippet].some(value => value != null && typeof value !== 'string')) return null;
    const ref: VfsResourceRef = { sourceId: raw.sourceId, resourceHash: raw.resourceHash, type, name: raw.name };
    if (raw.resourceId != null) ref.resourceId = raw.resourceId as string;
    if (raw.snippet != null) ref.snippet = raw.snippet as string;
    if (raw.injectModes != null) {
      if (!record(raw.injectModes)) return null;
      const modes: NonNullable<VfsResourceRef['injectModes']> = {};
      const image = raw.injectModes.image;
      if (image != null) {
        if (!Array.isArray(image)) return null;
        const parsed = image.map(value => unitEnum(value, ['image', 'ocr'] as const));
        if (parsed.some(value => value === null)) return null;
        modes.image = parsed as ('image' | 'ocr')[];
      }
      const pdf = raw.injectModes.pdf;
      if (pdf != null) {
        if (!Array.isArray(pdf)) return null;
        const parsed = pdf.map(value => unitEnum(value, ['text', 'ocr', 'image'] as const));
        if (parsed.some(value => value === null)) return null;
        modes.pdf = parsed as ('text' | 'ocr' | 'image')[];
      }
      ref.injectModes = modes;
    }
    refs.push(ref);
  }
  return { refs, truncated: data.truncated === true,
    totalCount: typeof data.totalCount === 'number' ? data.totalCount : 0 };
}

function debugOption(value: unknown): string {
  return value == null ? 'None' : `Some(${JSON.stringify(value)})`;
}

/** `restore_context_refs_from_snapshot` (send_message.rs:1849-1997). */
export async function restoreContextRefsFromSnapshot(deps: ContextRefRestoreDeps, snapshot: ContextSnapshot,
  isMultimodal: boolean, log: ChatLogger): Promise<SendContextRef[]> {
  const result: SendContextRef[] = [];
  let conn: SqlExecutor;
  try { conn = deps.getConnection(); }
  catch (error) {
    log.warn(`[ChatV2::handlers] Failed to get vfs.db connection for restore: ${errorText(error)}`);
    return result;
  }
  const userRefs = snapshot.userRefs ?? [];
  for (const contextRef of userRefs) {
    let resource = null;
    try { resource = deps.resources.getByHash(conn, contextRef.hash); } catch { resource = null; }
    if (resource === null) {
      try { resource = deps.resources.getResource(conn, contextRef.resourceId); } catch { resource = null; }
    }
    if (resource === null) {
      log.warn(`[ChatV2::handlers] Failed to restore context ref (resource not found): resource_id=${contextRef.resourceId}`);
      continue;
    }
    const dataStr = resource.data ?? '';
    const refData = decodeVfsContextRefData(dataStr);
    let formattedBlocks: FormattedBlock[];
    if (refData !== null) {
      if (contextRef.injectModes != null) {
        log.info(`[ChatV2::handlers] Restoring inject_modes from snapshot: ${JSON.stringify(contextRef.injectModes)}`);
        for (const ref of refData.refs) ref.injectModes = structuredClone(contextRef.injectModes) as VfsResourceRef['injectModes'];
      }
      const blocks = await deps.resolveContextRefDataToBlocks(refData, isMultimodal);
      formattedBlocks = blocks.length === 0 ? [{ type: 'text', text: `[资源已删除: ${contextRef.resourceId}]` }] : blocks;
    } else {
      log.warn(`[ChatV2::handlers] Context snapshot data is not VfsContextRefData, ignored: resource_id=${contextRef.resourceId}, data_len=${utf8ByteLength(dataStr)}`);
      formattedBlocks = [{ type: 'text', text: `[旧版上下文引用已忽略: ${contextRef.displayName ?? contextRef.resourceId}]` }];
    }
    const stagedPrefix = `${STAGED_PREFIX}${contextRef.resourceId}:`;
    const stagedMetadata: unknown[] = [];
    for (const [key, value] of Object.entries(snapshot.pathMap ?? {})) {
      if (!key.startsWith(stagedPrefix)) continue;
      try { stagedMetadata.push(JSON.parse(value)); } catch { continue; }
    }
    if (stagedMetadata.length > 0) {
      formattedBlocks.push({ type: 'text', text: `<attachment_metadata>${JSON.stringify(stagedMetadata)}</attachment_metadata>` });
    }
    result.push({ resourceId: contextRef.resourceId, hash: contextRef.hash, typeId: contextRef.typeId, formattedBlocks,
      displayName: contextRef.displayName ?? null,
      injectModes: contextRef.injectModes == null ? null : structuredClone(contextRef.injectModes) as SendContextRef['injectModes'] });
    log.debug(`[ChatV2::handlers] Restored context ref: resource_id=${contextRef.resourceId}, type_id=${contextRef.typeId}, inject_modes=${debugOption(contextRef.injectModes)}`);
  }
  log.info(`[ChatV2::handlers] Restored ${result.length} context refs from snapshot (user_refs=${userRefs.length})`);
  return result;
}
