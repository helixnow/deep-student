/**
 * Session branching. Rust source: `chat_v2/handlers/manage_session.rs:1578-2059`.
 *
 * Copies the source prefix in one IMMEDIATE transaction, remaps every
 * message/block/variant id and clones a self-contained active compaction.
 * VFS reference increments belong to the VFS lane and are omitted here.
 */
import type { ChatLogger } from './logger.ts';
import { adjustVfsRefsWithRetry, messageResourceIds, type VfsReferenceAccess } from './reference-counts.ts';
import type {
  ChatMessage, ChatSession, SessionState, SharedContext, Variant,
} from '../api.ts';
import type { DatabaseHandle, TransactionScope } from '../../../platform/storage/api.ts';
import { StorageError } from '../../../platform/storage/api.ts';
import { now, toRfc3339Opts } from '../../../platform/time/index.ts';
import { ChatV2Error } from './error.ts';
import { ensureSessionWritable } from './handlers.ts';
import { generateSessionId } from './types.ts';
import { generateVariantId, remapIdsInValue } from './snapshot.ts';
import { resolvedSkillState } from './session-metadata.ts';
import { applySkillState } from './session-actions.ts';
import type { SessionSkillState } from '../repository/session-state.ts';
import type { SkillState } from './session-actions.ts';
import { incrementSkillVersion } from './session-skill-state.ts';
import {
  copyBlockReplay, createBlock, getBlock, getMessageBlocks, updateBlock,
  type StoredBlock,
} from '../repository/blocks.ts';
import {
  createMessage, getMessage, getSessionMessages,
} from '../repository/messages.ts';
import { createSession, getSession } from '../repository/sessions.ts';
import {
  createCompaction, getActiveCompaction, historyBoundaryId, setSessionLastCompaction,
  type CompactionRecord,
} from '../repository/compactions.ts';
import { loadSessionState, saveSessionState } from '../repository/session-state.ts';

export const SUPER_AGENT_METADATA_KEY = 'super_agent';

function statusDebug(status: string): string {
  if (status === 'archived') return 'Archived';
  if (status === 'deleted') return 'Deleted';
  return 'Active';
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function remapOptionalBlockId(
  value: string | null | undefined, blockIdMap: Map<string, string>,
): string | null {
  if (value === null || value === undefined) return null;
  return blockIdMap.get(value) ?? null;
}

function copySharedContext(
  source: SharedContext, blockIdMap: Map<string, string>,
): SharedContext {
  const target: SharedContext = {};
  if (source.ragSources !== undefined) target.ragSources = source.ragSources;
  if (source.memorySources !== undefined) target.memorySources = source.memorySources;
  if (source.graphSources !== undefined) target.graphSources = source.graphSources;
  if (source.webSearchSources !== undefined) target.webSearchSources = source.webSearchSources;
  if (source.multimodalSources !== undefined) target.multimodalSources = source.multimodalSources;
  const blockFields = ['ragBlockId', 'memoryBlockId', 'graphBlockId',
    'webSearchBlockId', 'multimodalBlockId'] as const;
  for (const field of blockFields) {
    const mapped = remapOptionalBlockId(source[field], blockIdMap);
    if (mapped !== null) target[field] = mapped;
  }
  return target;
}

/** `SessionSkillState::without_branch_local_skills` (types.rs:1290-1298). */
function withoutBranchLocalSkills(state: SessionSkillState): SkillState {
  const next: SkillState = {
    manualPinnedSkillIds: [...(state.manualPinnedSkillIds ?? [])],
    modeRequiredBundleIds: [...(state.modeRequiredBundleIds ?? [])],
    agenticSessionSkillIds: [...(state.agenticSessionSkillIds ?? [])],
    branchLocalSkillIds: [...(state.branchLocalSkillIds ?? [])],
    effectiveAllowedExternalServers: [...(state.effectiveAllowedExternalServers ?? [])],
    version: state.version ?? 0,
    ...(state.legacyMigrated === undefined ? {} : { legacyMigrated: state.legacyMigrated }),
  };
  if (next.branchLocalSkillIds.length > 0) {
    next.branchLocalSkillIds = [];
    next.version = incrementSkillVersion(next.version);
  }
  next.legacyMigrated = false;
  return next;
}

function isSummaryOnly(record: CompactionRecord): boolean {
  return record.tailStartMessageId === record.summaryMessageId;
}

/** `branch_session_in_db` (manage_session.rs:1578-2059). */
export function branchSessionInDb(
  db: DatabaseHandle, sourceSessionId: string, upToMessageId: string,
  log?: ChatLogger,
): [ChatSession, string[]] {
  let branched: [ChatSession, string[]] | undefined;
  try {
    db.transaction((tx) => {
      branched = branchInTransaction(tx, sourceSessionId, upToMessageId, log);
    }, { behavior: 'immediate' });
  } catch (error) {
    if (error instanceof StorageError) {
      throw new ChatV2Error('Database', branched === undefined ? error.message : `Failed to commit branch transaction: ${error.message}`);
    }
    throw error;
  }
  return branched!;
}

function branchInTransaction(
  tx: TransactionScope, sourceSessionId: string, upToMessageId: string,
  log?: ChatLogger,
): [ChatSession, string[]] {
  const sourceSession = getSession(tx, sourceSessionId);
  if (sourceSession === null) throw new ChatV2Error('SessionNotFound', sourceSessionId);
  const sourceCompaction = getActiveCompaction(tx, sourceSessionId, log);
  if (sourceSession.persistStatus !== 'active') {
    throw new ChatV2Error('Validation',
      `Source session is not active (status: ${statusDebug(sourceSession.persistStatus)}): ${sourceSessionId}`);
  }

  const sourceMessages = getSessionMessages(tx, sourceSessionId, log);
  const cutIndex = sourceMessages.findIndex(message => message.id === upToMessageId);
  if (cutIndex < 0) {
    throw new ChatV2Error('MessageNotFound',
      `${upToMessageId} (not found in session ${sourceSessionId})`);
  }
  const messagesToCopy = sourceMessages.slice(0, cutIndex + 1);
  const resourceIds = messagesToCopy.flatMap(messageResourceIds);

  const allBlockIds = new Set<string>();
  for (const message of messagesToCopy) {
    for (const blockId of message.blockIds) allBlockIds.add(blockId);
    for (const variant of message.variants ?? []) {
      for (const blockId of variant.blockIds) allBlockIds.add(blockId);
    }
  }
  const sortedBlockIds = [...allBlockIds].sort();
  const sourceBlocks = new Map<string, StoredBlock>();
  for (const blockId of sortedBlockIds) {
    const block = getBlock(tx, blockId);
    if (block !== null) sourceBlocks.set(blockId, block);
  }

  const timestamp = now();
  const wireTimestamp = toRfc3339Opts(timestamp.epochNanos, 'AutoSi', true);
  const newSessionId = generateSessionId();
  // Rust distinguishes SQL NULL (`None` → `{}`) from a JSON `null` payload
  // (`Some(Value::Null)` → kept as-is, no `branchedFrom` insertion).
  const metadataSource: unknown = sourceSession.metadata === undefined
    ? {} : cloneJson(sourceSession.metadata);
  if (metadataSource !== null && typeof metadataSource === 'object' && !Array.isArray(metadataSource)) {
    const metadata = metadataSource as Record<string, unknown>;
    if (SUPER_AGENT_METADATA_KEY in metadata) {
      delete metadata[SUPER_AGENT_METADATA_KEY];
      delete metadata.pinned;
    }
    metadata.branchedFrom = {
      sessionId: sourceSessionId,
      messageId: upToMessageId,
      compactionId: sourceCompaction === null ? null : sourceCompaction.id,
      branchedAt: timestamp.rfc3339,
    };
  }

  const newSession: ChatSession = {
    id: newSessionId,
    mode: 'chat',
    title: sourceSession.title === undefined || sourceSession.title === null
      ? null : `${sourceSession.title} (branch)`,
    description: sourceSession.description,
    titleLocked: true,
    persistStatus: 'active',
    createdAt: wireTimestamp,
    updatedAt: wireTimestamp,
    metadata: metadataSource,
    groupId: sourceSession.groupId,
  };
  createSession(tx, newSession);

  const messageIdMap = new Map<string, string>();
  for (const message of messagesToCopy) messageIdMap.set(message.id, `msg_${globalThis.crypto.randomUUID()}`);
  const blockIdMap = new Map<string, string>();
  for (const blockId of sortedBlockIds) blockIdMap.set(blockId, `blk_${globalThis.crypto.randomUUID()}`);

  for (const message of messagesToCopy) {
    const newMessageId = messageIdMap.get(message.id);
    if (newMessageId === undefined) {
      throw new ChatV2Error('Other', `Branch id remap missing entry for message ${message.id}`);
    }
    const newBlockIds = message.blockIds.map(id => blockIdMap.get(id) ?? id);
    const newParentId = message.parentId === null || message.parentId === undefined
      ? undefined : messageIdMap.get(message.parentId);
    const newSupersedes = message.supersedes === null || message.supersedes === undefined
      ? undefined : messageIdMap.get(message.supersedes);

    let newVariants: Variant[] | undefined;
    if (message.variants !== undefined && message.variants !== null) {
      newVariants = message.variants.map(variant => ({
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
    }
    let newActiveVariantId: string | undefined;
    if (message.activeVariantId !== undefined && message.activeVariantId !== null
      && message.variants !== undefined && message.variants !== null && newVariants !== undefined) {
      const index = message.variants.findIndex(variant => variant.id === message.activeVariantId);
      if (index >= 0 && index < newVariants.length) newActiveVariantId = newVariants[index]!.id;
    }

    const newSharedContext = message.sharedContext === undefined || message.sharedContext === null
      ? undefined : copySharedContext(message.sharedContext, blockIdMap);

    const newMessage: ChatMessage = {
      id: newMessageId,
      sessionId: newSessionId,
      role: message.role,
      blockIds: newBlockIds,
      timestamp: message.timestamp,
    };
    if (message.persistentStableId !== undefined) newMessage.persistentStableId = message.persistentStableId;
    if (newParentId !== undefined) newMessage.parentId = newParentId;
    if (newSupersedes !== undefined) newMessage.supersedes = newSupersedes;
    if (message._meta !== undefined) newMessage._meta = message._meta;
    if (message.attachments !== undefined) newMessage.attachments = message.attachments;
    if (newActiveVariantId !== undefined) newMessage.activeVariantId = newActiveVariantId;
    if (newVariants !== undefined) newMessage.variants = newVariants;
    if (newSharedContext !== undefined) newMessage.sharedContext = newSharedContext;
    createMessage(tx, newMessage, log);
  }

  const combinedIdMap = new Map<string, string>([...messageIdMap, ...blockIdMap]);
  for (const [oldBlockId, newBlockId] of blockIdMap) {
    const sourceBlock = sourceBlocks.get(oldBlockId);
    if (sourceBlock === undefined) continue;
    const newMessageId = messageIdMap.get(sourceBlock.messageId) ?? sourceBlock.messageId;
    const newToolInput = sourceBlock.toolInput === undefined
      ? undefined : remapIdsInValue(cloneJson(sourceBlock.toolInput), combinedIdMap);
    const newToolOutput = sourceBlock.toolOutput === undefined
      ? undefined : remapIdsInValue(cloneJson(sourceBlock.toolOutput), combinedIdMap);
    const newBlock: StoredBlock = {
      id: newBlockId,
      messageId: newMessageId,
      type: sourceBlock.type,
      status: sourceBlock.status,
      blockIndex: sourceBlock.blockIndex,
    };
    if (sourceBlock.content !== undefined) newBlock.content = sourceBlock.content;
    if (sourceBlock.toolName !== undefined) newBlock.toolName = sourceBlock.toolName;
    if (newToolInput !== undefined) newBlock.toolInput = newToolInput;
    if (newToolOutput !== undefined) newBlock.toolOutput = newToolOutput;
    if (sourceBlock.citations !== undefined) newBlock.citations = sourceBlock.citations;
    if (sourceBlock.error !== undefined) newBlock.error = sourceBlock.error;
    if (sourceBlock.startedAt !== undefined) newBlock.startedAt = sourceBlock.startedAt;
    if (sourceBlock.endedAt !== undefined) newBlock.endedAt = sourceBlock.endedAt;
    if (sourceBlock.firstChunkAt !== undefined) newBlock.firstChunkAt = sourceBlock.firstChunkAt;
    createBlock(tx, newBlock);
    copyBlockReplay(tx, oldBlockId, newBlockId);
  }

  if (sourceCompaction !== null) {
    cloneCompaction(tx, sourceCompaction, newSessionId, messageIdMap, timestamp.millis, log);
  }

  const sourceState = loadSessionState(tx, sourceSessionId);
  if (sourceState !== null) {
    // Rust builds a fresh SessionState (drafts/context refs cleared) and then
    // `set_skill_state` backfills active/loaded id columns from the trimmed state.
    const branchedState: SessionState = {
      sessionId: newSessionId,
      chatParams: sourceState.chatParams,
      features: sourceState.features,
      modeState: sourceState.modeState,
      inputValue: null,
      panelStates: null,
      updatedAt: timestamp.rfc3339,
      pendingContextRefsJson: null,
    };
    applySkillState(branchedState, withoutBranchLocalSkills(resolvedSkillState(sourceState)));
    saveSessionState(tx, newSessionId, branchedState);
  }

  return [newSession, resourceIds];
}

/** Steps 10 of `branch_session_in_db`: clone a self-contained active compaction. */
function cloneCompaction(
  tx: TransactionScope, sourceRecord: CompactionRecord, newSessionId: string,
  messageIdMap: Map<string, string>, nowMs: number,
  log?: ChatLogger,
): void {
  const summaryOnly = isSummaryOnly(sourceRecord);
  let tailStartMessageId: string | null =
    messageIdMap.get(sourceRecord.tailStartMessageId) ?? null;
  let summaryMessageId: string | null = messageIdMap.get(sourceRecord.summaryMessageId) ?? null;
  const boundarySurvives = sourceRecord.rangeEndMessageId !== null
    && messageIdMap.has(sourceRecord.rangeEndMessageId);

  if (summaryMessageId === null && (tailStartMessageId !== null || (summaryOnly && boundarySurvives))) {
    const sourceSummary = getMessage(tx, sourceRecord.summaryMessageId);
    if (sourceSummary !== null) {
      const sourceSummaryBlocks = getMessageBlocks(tx, sourceRecord.summaryMessageId, log);
      const newSummaryMessageId = `msg_${globalThis.crypto.randomUUID()}`;
      const newBlockIds: string[] = [];
      const copiedBlocks: Array<[string, StoredBlock]> = [];
      for (const sourceBlock of sourceSummaryBlocks) {
        const newBlockId = `blk_${globalThis.crypto.randomUUID()}`;
        const newBlock: StoredBlock = {
          ...sourceBlock, id: newBlockId, messageId: newSummaryMessageId,
        };
        newBlockIds.push(newBlockId);
        copiedBlocks.push([sourceBlock.id, newBlock]);
      }
      const newSummary: ChatMessage = {
        ...sourceSummary,
        id: newSummaryMessageId,
        sessionId: newSessionId,
        blockIds: newBlockIds,
        parentId: null,
        supersedes: null,
      };
      createMessage(tx, newSummary, log);
      for (const [sourceBlockId, newBlock] of copiedBlocks) {
        createBlock(tx, newBlock);
        copyBlockReplay(tx, sourceBlockId, newBlock.id);
      }
      summaryMessageId = newSummaryMessageId;
    }
  }

  if (summaryOnly) {
    tailStartMessageId = boundarySurvives ? summaryMessageId : null;
  }
  if (summaryMessageId === null || tailStartMessageId === null) return;

  const branchRecord: CompactionRecord = {
    id: `cmp_${globalThis.crypto.randomUUID()}`,
    sessionId: newSessionId,
    summaryMessageId,
    tailStartMessageId,
    tailStartTimeCreated: sourceRecord.tailStartTimeCreated,
    reason: 'branch',
    isAuto: false,
    isOverflow: sourceRecord.isOverflow,
    tokensBefore: null,
    tokensAfter: null,
    modelId: sourceRecord.modelId,
    modelConfigId: sourceRecord.modelConfigId,
    previousCompactionId: null,
    rangeStartMessageId: sourceRecord.rangeStartMessageId === null
      ? null : (messageIdMap.get(sourceRecord.rangeStartMessageId) ?? null),
    rangeEndMessageId: sourceRecord.rangeEndMessageId === null
      ? null : (messageIdMap.get(sourceRecord.rangeEndMessageId) ?? null),
    compactedMessageCount: sourceRecord.compactedMessageCount,
    createdAt: nowMs,
  };
  createCompaction(tx, branchRecord);
  setSessionLastCompaction(tx, newSessionId, branchRecord.id, log);

  for (const block of getMessageBlocks(tx, branchRecord.summaryMessageId, log)) {
    if (block.type !== 'compaction_summary') continue;
    const metadata = block.toolOutput ?? {};
    if (metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)) {
      const object = metadata as Record<string, unknown>;
      object.sessionId = newSessionId;
      object.compactionId = branchRecord.id;
      object.previousCompactionId = null;
      object.reason = 'branch';
      object.rangeStartMessageId = branchRecord.rangeStartMessageId;
      object.rangeEndMessageId = branchRecord.rangeEndMessageId;
      object.tailStartMessageId = branchRecord.tailStartMessageId;
      delete object.tokensBefore;
      delete object.tokensAfter;
      delete object.tailMessageCount;
    }
    updateBlock(tx, { ...block, toolOutput: metadata }, log);
  }
}

/** `chat_v2_branch_session` (manage_session.rs:711-759). */
export function branchSessionAction(
  db: DatabaseHandle, sourceSessionId: string, upToMessageId: string,
  log: ChatLogger, refs: VfsReferenceAccess,
): ChatSession {
  log.info(`[ChatV2::handlers] chat_v2_branch_session: source=${sourceSessionId}, upTo=${upToMessageId}`);
  if (!sourceSessionId.startsWith('sess_') && !sourceSessionId.startsWith('agent_')
    && !sourceSessionId.startsWith('subagent_')) {
    throw new ChatV2Error('Validation', `Invalid source session_id format: ${sourceSessionId}`);
  }
  ensureSessionWritable(db, sourceSessionId);
  const [session, resourceIds] = branchSessionInDb(db, sourceSessionId, upToMessageId, log);
  adjustVfsRefsWithRetry(refs, resourceIds, 'increment', `branch_session(${sourceSessionId} -> ${session.id})`, log);
  log.info(`[ChatV2::handlers] Branched session created: id=${session.id}, from=${sourceSessionId}`);
  return session;
}
