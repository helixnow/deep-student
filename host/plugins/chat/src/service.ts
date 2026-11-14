/**
 * `chatSession` service implementation (`chat.session@1` in the old table).
 *
 * Rust source: `chat_v2/repo.rs` accessors surfaced through `ChatV2Database`.
 * Cross-lane consumers get the same synchronous repository functions the
 * commands use; blocks returned to them are wire blocks (`blockIndex` stripped).
 */
import type {
  ChatMessage, ChatSession, ChatSessionService, ChatV2Database, MessageBlock, SessionState,
} from '../api.ts';
import { StorageError, type StorageService } from '../../../platform/storage/api.ts';
import { getSession, createSession, updateSession, deleteSessionHard } from '../repository/sessions.ts';
import { getSessionAuthorityState, setSessionPlanState, consumeSessionPlanBinding } from '../repository/session-authority.ts';
import { getMessage, getSessionMessages, createMessage, updateMessage,
  getSessionMessageIds, getMessagesByIds, hasReplayMetadata } from '../repository/messages.ts';
import { getHistoryBlocksWithReplay } from '../repository/history-replay.ts';
import {
  getBlock, getMessageBlocks, createBlock, updateBlock, toWireBlock, copyBlockReplay, appendBlockIdAtomically, listBlockPositions,
  getCompactionSummaryMessageIds, appendWorkspaceInjectionBlockId,
} from '../repository/blocks.ts';
import { loadSessionState, saveSessionSkillState } from '../repository/session-state.ts';
import { readSchemaVersion, readStatistics } from '../repository/database.ts';
import { chatDatabase } from './handlers.ts';
import type { ChatLogger } from './logger.ts';
import { loadAgentsInstructions } from './agents-md.ts';
import { ChatExecutionContext } from './execution-context.ts';
import { MessageSender, createSendExecution } from './send-message.ts';
import { GoalRuntime } from './goal-runtime.ts';
import { VariantExecutionContext, ParallelExecutionManager } from './variant-context.ts';
import { ToolExecutorRegistry } from './executor-registry.ts';
import { assembleExecutorRegistry } from './executor-roster.ts';
import type { AgentToolExecutor } from '../../agent-skills/api.ts';
import type { EmergencyCancelHooks } from './kill-switch.ts';
import type { StaleAnkiBlockReaperSlot } from './stale-anki-reaper.ts';
import { isToolAllowedByExecutionPolicy } from './tool-policy.ts';
import { tokenUsageFromApi, tokenUsageFromApiWithCache, tokenUsageFromEstimate,
  tokenUsageZero, tokenUsageHasTokens, accumulateTokenUsage } from './types.ts';
import { newVariant, setVariantStreaming, setVariantSuccess, setVariantError, setVariantCancelled,
  variantWithUsage, setVariantUsage, getVariantUsage, newSharedContext, sharedContextHasSources,
  isMultiVariant, getActiveBlockIds, addVariant, removeVariant, variantCount, selectBestActiveVariant } from './variant-values.ts';
import { buildUserMessage } from './user-message-builder.ts';
import { newUserMessage, newAssistantMessage, newMessageBlock, setBlockRunning,
  setBlockSuccess, setBlockError, appendBlockContent } from './message-values.ts';
import { getFrozenToolSchemaOrder, mergeFrozenToolSchemaOrder, getAvailableSkillsSnapshot,
  freezeAvailableSkillsSnapshot, getToolFacePrefix, advanceToolFacePrefix,
  getMicrocompactAnchor, setMicrocompactAnchor, markAvailableSkillsSnapshotStale } from './session-metadata.ts';
import { databaseOperation } from '../repository/errors.ts';
import { updateBlockReplay, getBlockReplayMap, clearBlockLlmContent } from '../repository/block-replay.ts';
import { createCompaction, getActiveCompaction, getCompactionById, listCompactions,
  setSessionLastCompaction, clearSessionLastCompaction, invalidateCompactionForMessage } from '../repository/compactions.ts';

export function createChatSessionService(storage: StorageService, log: ChatLogger, hooks: EmergencyCancelHooks,
  contributions: () => readonly AgentToolExecutor[], staleAnkiReaper: StaleAnkiBlockReaperSlot,
  activeGoalRuntime: () => GoalRuntime | undefined): ChatSessionService {
  const db = () => chatDatabase(storage);
  const database: ChatV2Database = {
    getConn: db,
    getConnSafe: db,
    dbPath: () => storage.pathOf('chat_v2'),
    isInMaintenanceMode: () => {
      try { storage.database('chat_v2'); return false; }
      catch (error) {
        if (error instanceof StorageError && error.code === 'MAINTENANCE') return true;
        throw error;
      }
    },
    getSchemaVersion: () => readSchemaVersion(db()),
    getStatistics: () => readStatistics(db()),
  };
  return {
    database,
    createMessageSender: deps => new MessageSender(database, log, deps),
    createSendExecution,
    createGoalRuntime: deps => new GoalRuntime(database, log, deps),
    activeGoalRuntime,
    registerEmergencyCancelHook: hook => hooks.register(hook),
    registerStaleAnkiBlockReaper: reaper => staleAnkiReaper.provide(reaper),
    loadAgentsInstructions: workspaceRoot => loadAgentsInstructions(workspaceRoot, log),
    createExecutionContext: init => new ChatExecutionContext(init, log),
    createVariantExecutionContext: (id, model, message, shared, emitter, parent) => new VariantExecutionContext(id, model, message, shared, emitter, parent, log),
    createParallelExecutionManager: controller => new ParallelExecutionManager(log, controller),
    createExecutorRegistry: (executors, approval) => new ToolExecutorRegistry(executors, approval, log),
    assembleExecutorRegistry: (additional, approval, workspace) => assembleExecutorRegistry(contributions(), additional, approval, workspace, log),
    isToolAllowedByExecutionPolicy,
    hasReplayMetadata,
    tokenUsageFromApi, tokenUsageFromApiWithCache, tokenUsageFromEstimate,
    tokenUsageZero, tokenUsageHasTokens, accumulateTokenUsage,
    newVariant, setVariantStreaming, setVariantSuccess, setVariantError, setVariantCancelled,
    variantWithUsage, setVariantUsage, getVariantUsage, newSharedContext, sharedContextHasSources,
    isMultiVariant, getActiveBlockIds, addVariant, removeVariant, variantCount, selectBestActiveVariant,
    buildUserMessage: params => buildUserMessage(params, log),
    newUserMessage, newAssistantMessage, newMessageBlock, setBlockRunning,
    setBlockSuccess, setBlockError, appendBlockContent,
    getFrozenToolSchemaOrder: sessionId => getFrozenToolSchemaOrder(db(), sessionId),
    mergeFrozenToolSchemaOrder: (sessionId, baseline) => databaseOperation(() => db().transaction(
      tx => mergeFrozenToolSchemaOrder(tx, sessionId, baseline), { behavior: 'immediate' })),
    getAvailableSkillsSnapshot: sessionId => getAvailableSkillsSnapshot(db(), sessionId),
    updateSessionSkillStateV2: (sessionId, skillState) => saveSessionSkillState(db(), sessionId, skillState),
    freezeAvailableSkillsSnapshot: (sessionId, snapshot) => databaseOperation(() => db().transaction(
      tx => freezeAvailableSkillsSnapshot(tx, sessionId, snapshot), { behavior: 'immediate' })),
    getToolFacePrefix: sessionId => getToolFacePrefix(db(), sessionId),
    advanceToolFacePrefix: (sessionId, snapshot) => databaseOperation(() => db().transaction(
      tx => advanceToolFacePrefix(tx, sessionId, snapshot), { behavior: 'immediate' })),
    getMicrocompactAnchor: sessionId => getMicrocompactAnchor(db(), sessionId),
    setMicrocompactAnchor: (sessionId, anchor) => databaseOperation(() => db().transaction(
      tx => setMicrocompactAnchor(tx, sessionId, anchor), { behavior: 'immediate' })),
    getSession: (sessionId: string): ChatSession | null => getSession(db(), sessionId),
    getSessionAuthorityState: sessionId => getSessionAuthorityState(db(), sessionId),
    setSessionPlanState: (sessionId, plan) => setSessionPlanState(db(), sessionId, plan, log),
    consumeSessionPlanBinding: (sessionId, bindingKey, now) => consumeSessionPlanBinding(db(), sessionId, bindingKey, now, log),
    createSession: (session: ChatSession): void => createSession(db(), session),
    updateSession: (session: ChatSession): void => updateSession(db(), session),
    deleteSessionV2: sessionId => databaseOperation(() => db().transaction(tx => deleteSessionHard(tx, sessionId, log), { behavior: 'immediate' })),
    getMessage: (messageId: string): ChatMessage | null => getMessage(db(), messageId),
    getSessionMessages: (sessionId: string): ChatMessage[] => getSessionMessages(db(), sessionId, log),
    getSessionMessageIdsWithConn: getSessionMessageIds,
    getMessagesByIdsWithConn: (conn, sessionId, ids) => getMessagesByIds(conn, sessionId, ids, log),
    getHistoryBlocksWithReplayWithConn: (conn, ids) => getHistoryBlocksWithReplay(conn, ids, log),
    createMessage: (message: ChatMessage): void => createMessage(db(), message, log),
    createMessageWithConn: (conn, message) => createMessage(conn, message, log),
    getMessageWithConn: getMessage,
    updateMessageWithConn: (conn, message) => updateMessage(conn, message, log),
    getCompactionSummaryMessageIdsWithConn: getCompactionSummaryMessageIds,
    markAvailableSkillsSnapshotStaleWithConn: markAvailableSkillsSnapshotStale,
    createBlockWithConn: createBlock,
    getMessageBlocksWithConn: (conn, messageId) => getMessageBlocks(conn, messageId, log),
    listBlockPositionsWithConn: listBlockPositions,
    updateMessage: (message: ChatMessage): void => updateMessage(db(), message, log),
    getBlock: (blockId: string): MessageBlock | null => {
      const block = getBlock(db(), blockId);
      return block === null ? null : toWireBlock(block);
    },
    getMessageBlocks: (messageId: string): MessageBlock[] =>
      getMessageBlocks(db(), messageId, log).map(toWireBlock),
    createBlock: (block: MessageBlock): void => createBlock(db(), block),
    appendBlockIdToMessageWithConn: appendBlockIdAtomically,
    appendWorkspaceInjectionBlockIdWithConn: appendWorkspaceInjectionBlockId,
    updateBlock: (block: MessageBlock): void => updateBlock(db(), block, log),
    updateBlockReplayWithConn: (conn, blockId, replay) => updateBlockReplay(conn, blockId, replay, log),
    getBlockReplayMapWithConn: getBlockReplayMap,
    copyBlockReplayWithConn: copyBlockReplay,
    clearBlockLlmContentWithConn: clearBlockLlmContent,
    createCompactionWithConn: createCompaction,
    getActiveCompactionWithConn: (conn, sessionId) => getActiveCompaction(conn, sessionId, log),
    getCompactionByIdWithConn: getCompactionById,
    listCompactionsWithConn: listCompactions,
    setSessionLastCompactionWithConn: (conn, sessionId, compactionId) => setSessionLastCompaction(conn, sessionId, compactionId, log),
    clearSessionLastCompactionWithConn: (conn, sessionId) => clearSessionLastCompaction(conn, sessionId, log),
    invalidateCompactionForMessageWithConn: (conn, sessionId, messageId) => invalidateCompactionForMessage(conn, sessionId, messageId, log),
    loadSessionState: (sessionId: string): SessionState | null => loadSessionState(db(), sessionId),
  };
}
