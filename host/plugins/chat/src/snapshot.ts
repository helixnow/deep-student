/**
 * Conversation snapshot export/import. Rust source:
 * `chat_v2/handlers/snapshot_handlers.rs`.
 */
import { utf8ByteLength } from '../../../platform/util/index.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import type {
  ChatMessage, ChatSession, ExportMessagesChunk, ExportSessionMeta, ImportSessionResult,
  MessageBlock, SessionState, Variant,
} from '../api.ts';
import { StorageError, type DatabaseHandle } from '../../../platform/storage/api.ts';
import { ChatV2Error } from './error.ts';
import { generateSessionId } from './types.ts';
import type { ChatLogger } from './logger.ts';
import { createSession, getSession } from '../repository/sessions.ts';
import { createMessage, getSessionMessages } from '../repository/messages.ts';
import { createBlock, getMessageBlocks, toWireBlock } from '../repository/blocks.ts';
import { loadSessionState, saveSessionState } from '../repository/session-state.ts';

export const SNAPSHOT_FORMAT = 'deepstudent-conversation-snapshot';
export const SNAPSHOT_VERSION = 1;
export const EXPORT_PAGE_SIZE = 100;
export const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;

export function generateMessageId(): string { return `msg_${globalThis.crypto.randomUUID()}`; }
export function generateBlockId(): string { return `blk_${globalThis.crypto.randomUUID()}`; }
export function generateVariantId(): string { return `var_${globalThis.crypto.randomUUID()}`; }

/** `remap_ids_in_value` (manage_session.rs:105-127): exact string match only. */
export function remapIdsInValue(value: unknown, idMap: Map<string, string>): unknown {
  if (typeof value === 'string') return idMap.get(value) ?? value;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = remapIdsInValue(value[index], idMap);
    }
    return value;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) record[key] = remapIdsInValue(record[key], idMap);
  }
  return value;
}

/** `chat_v2_export_session_meta` (snapshot_handlers.rs:82-114). */
export function exportSessionMeta(db: DatabaseHandle, sessionId: string, appVersion: string, log?: ChatLogger): ExportSessionMeta {
  const session = getSession(db, sessionId);
  if (!session) throw new ChatV2Error('SessionNotFound', sessionId);
  const sessionState = loadSessionState(db, sessionId);
  const messages = getSessionMessages(db, sessionId, log);
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    exportedAt: toRfc3339(),
    appVersion,
    session,
    sessionState,
    messageCount: messages.length,
    pageSize: EXPORT_PAGE_SIZE,
  };
}

/** `chat_v2_export_session_messages` (snapshot_handlers.rs:116-154). */
export function exportSessionMessages(
  db: DatabaseHandle, sessionId: string, offset: number, limit: number | null | undefined,
  log?: ChatLogger,
): ExportMessagesChunk {
  const allMessages = getSessionMessages(db, sessionId, log);
  const pageSize = Math.max(limit ?? EXPORT_PAGE_SIZE, 1);
  const start = Math.min(offset, allMessages.length);
  const end = Math.min(start + pageSize, allMessages.length);
  const messages = allMessages.slice(start, end);
  const blocks: MessageBlock[] = [];
  for (const message of messages) {
    for (const block of getMessageBlocks(db, message.id, log)) blocks.push(toWireBlock(block));
  }
  return {
    messages,
    blocks,
    nextOffset: end < allMessages.length ? end : null,
  };
}

/** ConversationSnapshot v1 (snapshot_handlers.rs:166-177). */
interface ConversationSnapshot {
  format: string;
  version: number;
  session: ChatSession;
  sessionState?: SessionState | null;
  messages?: ChatMessage[];
  blocks?: MessageBlock[];
}

/** `chat_v2_import_session` (snapshot_handlers.rs:187-491). */
export function importSession(db: DatabaseHandle, snapshotJson: string, log?: ChatLogger): ImportSessionResult {
  if (utf8ByteLength(snapshotJson) > MAX_SNAPSHOT_BYTES) {
    throw new ChatV2Error('Validation', `Snapshot exceeds maximum size of ${MAX_SNAPSHOT_BYTES} bytes`);
  }
  let snapshot: ConversationSnapshot;
  try {
    snapshot = JSON.parse(snapshotJson) as ConversationSnapshot;
  } catch (error) {
    throw new ChatV2Error('Validation', `Invalid snapshot JSON: ${(error as Error).message}`);
  }
  if (snapshot === null || typeof snapshot !== 'object') {
    throw new ChatV2Error('Validation', 'Invalid snapshot JSON: expected an object');
  }
  if (snapshot.format !== SNAPSHOT_FORMAT) {
    throw new ChatV2Error('Validation',
      `Unknown snapshot format: ${snapshot.format} (expected ${SNAPSHOT_FORMAT})`);
  }
  if (snapshot.version !== SNAPSHOT_VERSION) {
    throw new ChatV2Error('Validation',
      `Unsupported snapshot version: ${snapshot.version} (supported: ${SNAPSHOT_VERSION})`);
  }
  const sourceMessages = snapshot.messages ?? [];
  const sourceBlocks = snapshot.blocks ?? [];
  const warnings: string[] = [];

  const newSessionId = generateSessionId();
  const messageIdMap = new Map<string, string>();
  const blockIdMap = new Map<string, string>();
  for (const message of sourceMessages) messageIdMap.set(message.id, generateMessageId());

  let orphanBlocks = 0;
  const validBlocks = sourceBlocks.filter((block) => {
    const ok = messageIdMap.has(block.messageId);
    if (!ok) orphanBlocks += 1;
    return ok;
  });
  if (orphanBlocks > 0) {
    warnings.push(`Skipped ${orphanBlocks} orphan blocks (message not in snapshot)`);
  }
  for (const block of validBlocks) blockIdMap.set(block.id, generateBlockId());

  const now = toRfc3339();
  const sourceMetadata = snapshot.session.metadata;
  const metadataBase = sourceMetadata ?? {};
  let metadata: unknown = metadataBase;
  if (metadataBase !== null && typeof metadataBase === 'object' && !Array.isArray(metadataBase)) {
    metadata = { ...(metadataBase as Record<string, unknown>) };
    (metadata as Record<string, unknown>).importedFrom = {
      sourceSessionId: snapshot.session.id,
      importedAt: now,
    };
  }

  const newSession: ChatSession = {
    id: newSessionId,
    mode: snapshot.session.mode,
    title: snapshot.session.title === null || snapshot.session.title === undefined
      ? snapshot.session.title : `${snapshot.session.title} (imported)`,
    description: snapshot.session.description,
    summaryHash: snapshot.session.summaryHash,
    titleLocked: true,
    persistStatus: 'active',
    createdAt: snapshot.session.createdAt,
    updatedAt: now,
    metadata,
    groupId: null,
    tagsHash: null,
    tags: null,
  };

  const newMessages: ChatMessage[] = [];
  for (const message of sourceMessages) {
    const newMessageId = messageIdMap.get(message.id)!;
    const newBlockIds = message.blockIds.map(id => blockIdMap.get(id) ?? id);
    const newParentId = message.parentId === null || message.parentId === undefined
      ? message.parentId : messageIdMap.get(message.parentId);
    const newSupersedes = message.supersedes === null || message.supersedes === undefined
      ? message.supersedes : messageIdMap.get(message.supersedes);
    const newVariants = message.variants === null || message.variants === undefined
      ? message.variants : message.variants.map((variant): Variant => ({
        id: generateVariantId(),
        modelId: variant.modelId,
        configId: variant.configId,
        blockIds: variant.blockIds.map(id => blockIdMap.get(id) ?? id),
        status: variant.status,
        error: variant.error,
        createdAt: variant.createdAt,
        usage: variant.usage,
        meta: variant.meta,
      }));
    let newActiveVariantId: string | null = null;
    if (message.activeVariantId !== null && message.activeVariantId !== undefined
      && message.variants !== null && message.variants !== undefined
      && newVariants !== null && newVariants !== undefined) {
      const index = message.variants.findIndex(variant => variant.id === message.activeVariantId);
      if (index >= 0 && newVariants[index]) newActiveVariantId = newVariants[index].id;
    }
    const newSharedContext = message.sharedContext === null || message.sharedContext === undefined
      ? message.sharedContext : {
        ...message.sharedContext,
        ragBlockId: remapBlockId(message.sharedContext.ragBlockId, blockIdMap),
        memoryBlockId: remapBlockId(message.sharedContext.memoryBlockId, blockIdMap),
        graphBlockId: remapBlockId(message.sharedContext.graphBlockId, blockIdMap),
        webSearchBlockId: remapBlockId(message.sharedContext.webSearchBlockId, blockIdMap),
        multimodalBlockId: remapBlockId(message.sharedContext.multimodalBlockId, blockIdMap),
      };
    newMessages.push({
      id: newMessageId,
      sessionId: newSessionId,
      role: message.role,
      blockIds: newBlockIds,
      timestamp: message.timestamp,
      persistentStableId: message.persistentStableId,
      parentId: newParentId,
      supersedes: newSupersedes,
      _meta: message._meta,
      attachments: message.attachments,
      activeVariantId: newActiveVariantId,
      variants: newVariants,
      sharedContext: newSharedContext,
    });
  }

  const combinedIdMap = new Map<string, string>([...messageIdMap, ...blockIdMap]);
  const newBlocks: MessageBlock[] = validBlocks.map((block) => {
    const newBlock: MessageBlock = {
      id: blockIdMap.get(block.id)!,
      messageId: messageIdMap.get(block.messageId)!,
      type: block.type,
      status: block.status,
      content: block.content,
      toolName: block.toolName,
      error: block.error,
      startedAt: block.startedAt,
      endedAt: block.endedAt,
      firstChunkAt: block.firstChunkAt,
    };
    // serde reads a JSON null into Option::None, so only present values reach the *_json columns.
    if (block.toolInput != null) newBlock.toolInput = remapIdsInValue(block.toolInput, combinedIdMap);
    if (block.toolOutput != null) newBlock.toolOutput = remapIdsInValue(block.toolOutput, combinedIdMap);
    if (block.citations != null) newBlock.citations = block.citations;
    return newBlock;
  });

  const sourceState = snapshot.sessionState;
  const newSessionState: SessionState | null = sourceState === null || sourceState === undefined
    ? null : {
      sessionId: newSessionId,
      chatParams: sourceState.chatParams,
      features: sourceState.features,
      modeState: sourceState.modeState,
      inputValue: undefined,
      panelStates: undefined,
      updatedAt: now,
      pendingContextRefsJson: undefined,
      loadedSkillIdsJson: sourceState.loadedSkillIdsJson,
      activeSkillIdsJson: sourceState.activeSkillIdsJson,
      skillStateJson: sourceState.skillStateJson,
    };

  const hasResourceRefs = newMessages.some((message) => {
    const snapshotRef = message._meta?.contextSnapshot;
    if (snapshotRef === undefined || snapshotRef === null) return false;
    return [...(snapshotRef.userRefs ?? []), ...(snapshotRef.retrievalRefs ?? [])]
      .some(ref => typeof ref.resourceId === 'string' && ref.resourceId !== '');
  });
  if (hasResourceRefs) {
    warnings.push('Snapshot references VFS resources; they may not exist locally and are not relinked');
  }

  let messageCount = 0;
  let blockCount = 0;
  let readyToCommit = false;
  try {
    db.transaction((tx) => {
      createSession(tx, newSession);
      messageCount = newMessages.length;
      for (const message of newMessages) createMessage(tx, message, log);
      blockCount = newBlocks.length;
      for (const block of newBlocks) createBlock(tx, block);
      if (newSessionState !== null) saveSessionState(tx, newSessionId, newSessionState);
      readyToCommit = true;
    }, { behavior: 'immediate' });
  } catch (error) {
    if (readyToCommit && error instanceof StorageError) {
      throw new ChatV2Error('Other', `Failed to commit import transaction: ${error.message}`);
    }
    throw error;
  }
  log?.info(`[ChatV2::handlers] Import committed: session=${newSessionId}, ${messageCount} messages, ${blockCount} blocks, ${warnings.length} warnings`);

  return {
    sessionId: newSessionId,
    messageCount,
    blockCount,
    warnings,
  };
}

function remapBlockId(id: string | null | undefined, blockIdMap: Map<string, string>): string | null {
  if (id === null || id === undefined) return null;
  return blockIdMap.get(id) ?? null;
}
