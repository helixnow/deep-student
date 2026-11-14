/**
 * L04 command registration. Business logic lives in `src/*` modules; this file
 * only adapts `ctx` services to the ported command bodies.
 */
import { rustTrim } from '../../../platform/util/index.ts';
import { CommandError } from '../../../kernel/api.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { Commands } from '../api.ts';
import { ChatV2Error, ChatV2State } from '../api.ts';
import { asyncCommandResult, chatDatabase, commandResult, snapshotCommandResult, editGoal, ensureSessionWritable,
  validateSessionId } from './handlers.ts';
import { performOcr, type OcrManager } from './ocr.ts';
import { emitFailureCount, SESSION_EVENT_TYPE } from './events.ts';
import {
  archiveSessionAction, authorityModeFromMetadata, createSessionAction, restoreSessionAction,
  saveSessionAction, setAuthorityModeAction, setPermissionPresetAction, updateSessionSettingsAction,
} from './session-actions.ts';
import {
  ankiCardsFromBlockByDocumentId, copyBlockContent, updateBlockContentAction, updateBlockToolOutputAction,
  upsertStreamingBlockAction,
} from './block-actions.ts';
import { clearGoal, pauseGoal, resumeGoal } from './goal-actions.ts';
import { cancelVariantAction, deleteVariantAction, switchVariantAction } from './variant-actions.ts';
import { exportSessionJsonl, exportSessionResponse } from './session-export.ts';
import { exportSessionMessages, exportSessionMeta, importSession } from './snapshot.ts';
import { deleteMessageAction, deleteSessionAction, emptyDeletedSessionsAction, softDeleteSessionCommand } from './deletion.ts';
import {
  emergencyStopCommand, emitKillSwitchChanged, killSwitchStatus, resumeAgents, resumeAutomations,
  type AutomationSchedulerLike, type EmergencyCancelHooks,
} from './kill-switch.ts';
import {
  archiveGroupAction, createGroupAction, deleteGroupAction, getGroupAction, listGroupsAction,
  restoreGroupAction, updateGroupAction, type RuntimeRootLookupGetter, type VfsFolderServiceLike,
} from './group-actions.ts';
import { cancelApproval, clearApprovalHistory, respondToApproval } from './approval.ts';
import { respondToAskUser } from './ask-user.ts';
import { listAgentProfiles, readAgentProfileFile, deleteAgentProfileFile, saveAgentProfileFile } from './workspace-profiles.ts';
import { cancelSleepAction, cancelWorkspaceAgentAction, closeWorkspaceAction, manualWakeAction,
  type WorkspaceRuntimeCoordinator } from './workspace-runtime.ts';
import {
  workspaceCommandResult, workspaceCreateAction, workspaceGetAction, workspaceGetContextAction, workspaceGetDocumentAction,
  workspaceListAgentsAction, workspaceListAllAction, workspaceListDocumentsAction,
  workspaceListMessagesAction, workspaceSendMessageAction, workspaceSetContextAction,
} from './workspace-actions.ts';
import { checkMigrationStatus, migrateLegacyChat, rollbackMigration } from './legacy-migration.ts';
import { compactSessionAction, undoCompactionAction, type CompactionPipelinePort } from './compaction-actions.ts';
import { branchSessionAction } from './session-branch.ts';
import { editAndResendAction, retryMessageAction, type RetryCommandDeps } from './retry-actions.ts';
import type { MessageSender, SendGoalRuntime } from './send-message.ts';
import { continueMessageAction, type ContinueCommandDeps } from './continue-actions.ts';
import { retryVariantAction, retryVariantsAction, type VariantRetryDeps, type VariantsRetryDeps } from './variant-retry.ts';
import { planGateRespondAction } from './plan-gate.ts';
import type { SettingsService } from '../../../platform/settings/api.ts';
import type { ApprovalManager } from '../../agent-workspace/api.ts';
import type { PlanGateManager } from '../../chat-pipeline/api.ts';
import type { SuperSessionHook } from './deletion.ts';
import type { StaleAnkiBlockReaperSlot } from './stale-anki-reaper.ts';
import { countSessions, getSession, listAgentSessions, listSessions, listSessionsReferencing,
  updateSessionGroup } from '../repository/sessions.ts';
import { getGroup, reorderGroups } from '../repository/groups.ts';
import { getGoal } from '../repository/goals.ts';
import { addManualTag, getSessionTags, getTagsForSessions, listAllTags, rebuildContentFts,
  removeTag, searchContent, searchSessions } from '../repository/search.ts';
import { countSessionMessages, loadSessionMessagesWindow, messageSummary } from '../repository/messages.ts';
import { loadRagScope, saveRagScope } from '../repository/session-state.ts';
import { loadSessionFull, loadSessionTail } from '../repository/load-session.ts';
import { toWireBlock } from '../repository/blocks.ts';
import { errorText, type ChatLogger } from './logger.ts';
import { chatLocalFs } from './local-fs.ts';
import type { VfsReferenceAccess } from './reference-counts.ts';
import type { SystemNotificationService } from '../../../../electron/api.ts';
import type { LLMManager } from '../../llm/api.ts';

type Args<K extends keyof Commands> = Commands[K]['args'];

export function registerChatCompactionCommand(ctx: Context, database: import('../api.ts').ChatV2Database,
  state: ChatV2State, pipeline: CompactionPipelinePort): void {
  ctx.commands.register<Args<'chat_v2_compact_session'>>('chat_v2_compact_session', args => asyncCommandResult(() =>
    compactSessionAction(database, state, pipeline, args.sessionId, args.modelConfigId, args.contextLimit ?? null)));
}

/** send_message.rs:919/1268: registered only when the real L03 execute entry and VFS owners are provided. */
export function registerChatRetryCommands(ctx: Context, deps: RetryCommandDeps): void {
  ctx.commands.register<Args<'chat_v2_retry_message'>>('chat_v2_retry_message', (a, call) => asyncCommandResult(() =>
    retryMessageAction(deps, a.sessionId, a.messageId, a.options ?? null, call.source)));
  ctx.commands.register<Args<'chat_v2_edit_and_resend'>>('chat_v2_edit_and_resend', (a, call) => asyncCommandResult(() =>
    editAndResendAction(deps, a.sessionId, a.messageId, a.newContent, a.newContextRefs ?? null,
      a.newPathMap ?? null, a.options ?? null, call.source)));
}

/** send_message.rs:461/717: registered only when L03 publishes `execute`; the invoking window is the emit target. */
export function registerChatSendCommands(ctx: Context, sender: MessageSender): void {
  ctx.commands.register<Args<'chat_v2_send_message'>>('chat_v2_send_message', (a, call) => asyncCommandResult(() =>
    sender.send(a.request, call.source)));
  ctx.commands.register<Args<'chat_v2_wake_session'>>('chat_v2_wake_session', (a, call) => asyncCommandResult(() =>
    sender.wake(a.sessionId, a.content, a.assistantMessageId ?? null, a.options ?? null, call.source)));
}

/** send_message.rs:2010-2237: registered with retry/edit (same L03 execute + VFS restore owners). */
export function registerChatContinueCommand(ctx: Context, deps: ContinueCommandDeps): void {
  ctx.commands.register<Args<'chat_v2_continue_message'>>('chat_v2_continue_message', (a, call) => asyncCommandResult(() =>
    continueMessageAction(deps, a.sessionId, a.messageId, a.variantId ?? null, a.options ?? null, call.source)));
}

/** variant_handlers.rs:154-188: registered only when L03 publishes `executeVariantRetry`. */
export function registerChatVariantRetryCommand(ctx: Context, deps: VariantRetryDeps): void {
  ctx.commands.register<Args<'chat_v2_retry_variant'>>('chat_v2_retry_variant', (a, call) => asyncCommandResult(async () => {
    const override = a.modelOverride ?? null;
    deps.log.info(`[ChatV2::VariantHandler] retry_variant: session_id=${a.sessionId}, message_id=${a.messageId}, variant_id=${a.variantId}, model_override=${override === null ? 'None' : `Some(${JSON.stringify(override)})`}`);
    ensureSessionWritable(deps.database.getConnSafe(), a.sessionId);
    return retryVariantAction(deps, a.sessionId, a.messageId, a.variantId, override, a.options ?? null, call.source);
  }));
}

/** variant_handlers.rs:198-233: registered only when L03 publishes `executeVariantsRetryBatch`. */
export function registerChatVariantsRetryCommand(ctx: Context, deps: VariantsRetryDeps): void {
  ctx.commands.register<Args<'chat_v2_retry_variants'>>('chat_v2_retry_variants', (a, call) => asyncCommandResult(async () => {
    deps.log.info(`[ChatV2::VariantHandler] retry_variants: session_id=${a.sessionId}, message_id=${a.messageId}, variant_count=${a.variantIds.length}`);
    ensureSessionWritable(deps.database.getConnSafe(), a.sessionId);
    return retryVariantsAction(deps, a.sessionId, a.messageId, a.variantIds, a.options ?? null, call.source);
  }));
}

/** `DEFAULT_PAGE_LIMIT` / `MAX_PAGE_LIMIT` (load_messages_page.rs:17-19). */
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 500;

export interface ChatCommandDeps {
  ctx: Context;
  state: ChatV2State;
  log: ChatLogger;
  settings: () => SettingsService;
  approvalManager: () => ApprovalManager | undefined;
  automation: () => AutomationSchedulerLike | undefined;
  vfs: () => VfsFolderServiceLike | undefined;
  runtimeRoots: RuntimeRootLookupGetter;
  planGateManager: () => PlanGateManager | undefined;
  superSession: () => SuperSessionHook | undefined;
  workspaceCoordinator: () => WorkspaceRuntimeCoordinator | undefined;
  ocrManager: () => OcrManager | undefined;
  /** Bound only while the L03 execute entry is available (same binding as send/wake). */
  goals: () => Pick<SendGoalRuntime, 'spawnContinuation'> | undefined;
  vfsRefs: VfsReferenceAccess;
  cleanupRuntimeRoots(sessionId: string): void;
  initializeRuntimeRoots(sessionId: string): void;
  emergencyHooks: EmergencyCancelHooks;
  staleAnkiReaper: StaleAnkiBlockReaperSlot;
  notification(): SystemNotificationService | undefined;
  appVersion: string;
}

export function registerChatCommands(deps: ChatCommandDeps): void {
  const { ctx, state, log } = deps;
    ctx.commands.register<Args<'chat_v2_perform_ocr'>>('chat_v2_perform_ocr', a =>
      asyncCommandResult(() => performOcr(a.request, deps.ocrManager(), log)));
    ctx.commands.register<Args<'chat_v2_tool_approval_respond'>>('chat_v2_tool_approval_respond',
      a => commandResult(() => {
        respondToApproval(approvalManager(), settings(), ctx.backendEvents, {
          sessionId: a.sessionId, toolCallId: a.toolCallId, toolName: a.toolName,
          approved: a.approved, reason: a.reason ?? null, remember: a.remember,
          rememberSession: a.rememberSession ?? null,
        }, log);
        return null;
      }));
    ctx.commands.register<Args<'chat_v2_tool_approval_cancel'>>('chat_v2_tool_approval_cancel',
      a => commandResult(() => { cancelApproval(approvalManager(), a.toolCallId); return null; }));
    ctx.commands.register<Args<'chat_v2_ask_user_respond'>>('chat_v2_ask_user_respond', a =>
      commandResult(() => {
        respondToAskUser({
          toolCallId: a.toolCallId, selectedTexts: a.selectedTexts,
          selectedIndices: a.selectedIndices, customText: a.customText ?? null, source: a.source,
        }, log);
        return null;
      }));
    ctx.commands.register('chat_v2_clear_approval_history', () =>
      commandResult(() => clearApprovalHistory(approvalManager(), settings(), log)));
    ctx.commands.register('chat_v2_check_migration_status', () =>
      commandResult(() => checkMigrationStatus(dataDb(), db())));
    ctx.commands.register('chat_v2_migrate_legacy_chat', () =>
      commandResult(() => migrateLegacyChat(dataDb(), db(), ctx.backendEvents, log)));
    ctx.commands.register('chat_v2_rollback_migration', () =>
      commandResult(() => rollbackMigration(dataDb(), db(), ctx.backendEvents, log)));
    ctx.commands.register<Args<'chat_v2_undo_compaction'>>('chat_v2_undo_compaction', a =>
      commandResult(() => undoCompactionAction(db(), state, a.sessionId, a.compactionId, log)));
    ctx.commands.register<Args<'chat_v2_branch_session'>>('chat_v2_branch_session', a =>
      commandResult(() => branchSessionAction(db(), a.sourceSessionId, a.upToMessageId, log, deps.vfsRefs)));
    ctx.commands.register<Args<'chat_v2_plan_gate_respond'>>('chat_v2_plan_gate_respond', a =>
      commandResult(() => {
        planGateRespondAction(planGateManager(), {
          sessionId: a.sessionId, planId: a.planId, toolCallId: a.toolCallId,
          approved: a.approved, reason: a.reason ?? null,
        });
        return null;
      }));
    ctx.commands.register<Args<'chat_v2_create_group'>>('chat_v2_create_group', a =>
      commandResult(() => createGroupAction(db(), vfs(), a.request, runtimeRoots, log)));
    ctx.commands.register<Args<'chat_v2_update_group'>>('chat_v2_update_group', a =>
      commandResult(() => updateGroupAction(db(), vfs(), a.groupId, a.request, runtimeRoots)));
    ctx.commands.register<Args<'chat_v2_get_group'>>('chat_v2_get_group', a =>
      commandResult(() => getGroupAction(db(), vfs(), a.groupId)));
    ctx.commands.register<Args<'chat_v2_list_groups'>>('chat_v2_list_groups', a =>
      commandResult(() => listGroupsAction(db(), vfs(), a.status ?? null, a.workspaceId ?? null, log)));
    ctx.commands.register<Args<'chat_v2_archive_group'>>('chat_v2_archive_group', a =>
      commandResult(() => { archiveGroupAction(db(), a.groupId, vfs()); return null; }));
    ctx.commands.register<Args<'chat_v2_restore_group'>>('chat_v2_restore_group', a =>
      commandResult(() => restoreGroupAction(db(), vfs(), a.groupId)));
    ctx.commands.register<Args<'chat_v2_delete_group'>>('chat_v2_delete_group', a =>
      commandResult(() => { deleteGroupAction(db(), state, a.groupId, deps.staleAnkiReaper, log, vfs()); return null; }));
    ctx.commands.register('chat_v2_kill_switch_status', () =>
      killSwitchStatus(state, automation()));
    ctx.commands.register<Args<'chat_v2_emergency_stop'>>('chat_v2_emergency_stop', a => emergencyStopCommand({
      state, automation: automation(), hooks: deps.emergencyHooks, approvals: approvalManager(), workspace: workspaceCoordinator(),
      notification: deps.notification(), emit: emitKillSwitch, log,
    }, a.reason ?? null));
    ctx.commands.register('chat_v2_resume_agents', () => {
      const status = resumeAgents(state, automation());
      emitKillSwitch(status);
      log.info(`[ChatV2::kill_switch] resume_agents: automations_paused=${status.automationsPaused}`);
      return status;
    });
    ctx.commands.register('chat_v2_resume_automations', () => {
      const status = resumeAutomations(state, automation());
      emitKillSwitch(status);
      log.info('[ChatV2::kill_switch] resume_automations');
      return status;
    });
    ctx.commands.register<Args<'chat_v2_has_active_stream'>>('chat_v2_has_active_stream', a => state.hasActiveStream(a.sessionId));
    ctx.commands.register<Args<'chat_v2_export_session_meta'>>('chat_v2_export_session_meta', a => snapshotCommandResult(() =>
      exportSessionMeta(db(), a.sessionId, deps.appVersion, log)));
    ctx.commands.register<Args<'chat_v2_export_session_messages'>>('chat_v2_export_session_messages', a => snapshotCommandResult(() =>
      exportSessionMessages(db(), a.sessionId, a.offset, a.limit ?? null, log)));
    ctx.commands.register<Args<'chat_v2_import_session'>>('chat_v2_import_session', a => snapshotCommandResult(() =>
      importSession(db(), a.snapshotJson, log)));
    ctx.commands.register<Args<'chat_v2_export_session'>>('chat_v2_export_session', a => commandResult(() =>
      exportSessionResponse(db(), a.sessionId, a.format ?? null, a.includeThinking ?? null, log)));
    ctx.commands.register<Args<'chat_v2_export_session_jsonl'>>('chat_v2_export_session_jsonl', a => commandResult(() => {
      if (rustTrim(a.sessionId) === '') {
        throw new ChatV2Error('Validation', 'Invalid session ID: empty or whitespace-only');
      }
      if (!a.targetPath.toLowerCase().endsWith('.jsonl')) {
        throw new ChatV2Error('Validation',
          `Invalid export path '${a.targetPath}': expected a .jsonl file`);
      }
      const exported = exportSessionJsonl(db(), a.sessionId, a.options ?? null, deps.appVersion, log);
      try {
        chatLocalFs().writeText(a.targetPath, exported.text);
      } catch (error) {
        throw new ChatV2Error('IoError',
          `${a.targetPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return exported.summary;
    }));
    ctx.commands.register<Args<'chat_v2_switch_variant'>>('chat_v2_switch_variant', a => commandResult(() => {
      switchVariantAction(db(), a.sessionId, a.messageId, a.variantId, log);
      return null;
    }));
    ctx.commands.register<Args<'chat_v2_delete_variant'>>('chat_v2_delete_variant', a => commandResult(() => {
      const result = deleteVariantAction(db(), a.sessionId, a.messageId, a.variantId, log);
      try {
        ctx.backendEvents.emit(`chat_v2_session_${a.sessionId}`, {
          eventType: SESSION_EVENT_TYPE.VARIANT_DELETED,
          messageId: a.messageId,
          variantId: a.variantId,
          remainingCount: result.remainingCount,
          newActiveVariantId: result.newActiveVariantId,
        });
      } catch (error) {
        // Rust logs a warning and still returns the deletion result.
        log.warn('[ChatV2::VariantHandler] Failed to emit variant_deleted event: ' + errorText(error));
      }
      log.info(`[ChatV2::VariantHandler] Variant deleted: message_id=${a.messageId}, variant_id=${a.variantId}, remaining=${result.remainingCount}`);
      return result;
    }));
    ctx.commands.register<Args<'chat_v2_cancel_variant'>>('chat_v2_cancel_variant', a => commandResult(() => {
      cancelVariantAction(db(), state, a.sessionId, a.variantId, log);
      return null;
    }));
    ctx.commands.register<Args<'chat_v2_cancel_stream'>>('chat_v2_cancel_stream', a => commandResult(() => {
      log.info(`[ChatV2::handlers] chat_v2_cancel_stream: session_id=${a.sessionId}, message_id=${a.messageId}`);
      if (!state.cancelStream(a.sessionId)) {
        // The pipeline's Cancelled branch owns the stream_cancelled event; no
        // duplicate event is emitted here.
        throw new ChatV2Error('Other', 'No active stream to cancel');
      }
      log.info(`[ChatV2::handlers] Stream cancellation requested: session=${a.sessionId}, message=${a.messageId}`);
      return null;
    }));
    ctx.commands.register('chat_v2_get_emit_failure_count', () => emitFailureCount());
    const db = () => chatDatabase(ctx.storage);
    // Legacy chat lives in the F4 `mistakes` database; a missing main DB is a
    // DATABASE_ERROR, same as Rust's `ChatV2Error::Database(e.to_string())`.
    const dataDb = () => {
      try {
        return ctx.storage.database('mistakes');
      } catch (error) {
        throw new ChatV2Error('Database', errorText(error));
      }
    };
    // Cross-lane capabilities are resolved lazily through the renamed services
    // (L05 approval, L05 workspace, L06 automation/subagent, L03 pipeline, VFS).
    const { approvalManager, automation, vfs, runtimeRoots, settings, planGateManager, superSession,
      workspaceCoordinator } = deps;
    const emitKillSwitch = (status: Parameters<typeof emitKillSwitchChanged>[1]) =>
      emitKillSwitchChanged((event, payload) => ctx.backendEvents.emit(event, payload), status, log);
    ctx.commands.register<Args<'chat_v2_get_session'>>('chat_v2_get_session', ({ sessionId }) => commandResult(() => {
      validateSessionId(sessionId, 'session_id');
      return getSession(db(), sessionId);
    }));
    ctx.commands.register<Args<'chat_v2_list_sessions'>>('chat_v2_list_sessions', a => commandResult(() =>
      listSessions(db(), a.status ?? null, a.groupId ?? null, a.limit ?? 50, a.offset ?? 0, log)));
    ctx.commands.register<Args<'chat_v2_count_sessions'>>('chat_v2_count_sessions', a => commandResult(() =>
      countSessions(db(), a.status ?? null, a.groupId ?? null)));
    ctx.commands.register<Args<'chat_v2_add_tag'>>('chat_v2_add_tag', a => commandResult(() => {
      validateSessionId(a.sessionId);
      if (!rustTrim(a.tag)) throw new ChatV2Error('Validation', 'Tag must not be empty');
      addManualTag(db(), a.sessionId, a.tag);
      return null;
    }));
    ctx.commands.register<Args<'chat_v2_remove_tag'>>('chat_v2_remove_tag', a => commandResult(() => {
      validateSessionId(a.sessionId);
      if (!rustTrim(a.tag)) throw new ChatV2Error('Validation', 'Tag must not be empty');
      removeTag(db(), a.sessionId, a.tag);
      return null;
    }));
    ctx.commands.register<Args<'chat_v2_get_session_tags'>>('chat_v2_get_session_tags', a => commandResult(() => {
      validateSessionId(a.sessionId);
      return getSessionTags(db(), a.sessionId);
    }));
    ctx.commands.register<Args<'chat_v2_get_tags_batch'>>('chat_v2_get_tags_batch', a => commandResult(() => getTagsForSessions(db(), a.sessionIds)));
    ctx.commands.register('chat_v2_list_all_tags', () => commandResult(() => listAllTags(db())));
    ctx.commands.register<Args<'chat_v2_search_sessions'>>('chat_v2_search_sessions', a => commandResult(() => {
      if (!rustTrim(a.query)) return [];
      return searchSessions(db(), a.query, Math.min(a.limit ?? 50, 200), a.includeArchived ?? false, log);
    }));
    ctx.commands.register<Args<'chat_v2_search_content'>>('chat_v2_search_content', a => commandResult(() => {
      if (!rustTrim(a.query)) return [];
      const id = a.sessionId && rustTrim(a.sessionId) ? a.sessionId : null;
      if (id !== null) validateSessionId(id);
      return searchContent(db(), a.query, Math.min(a.limit ?? 50, 200), a.dateFrom ?? null, a.dateTo ?? null, id, a.includeArchived ?? false, log);
    }));
    ctx.commands.register('rebuild_chat_fts', () => commandResult(() => rebuildContentFts(db())));
    ctx.commands.register<Args<'chat_v2_goal_get'>>('chat_v2_goal_get', a => commandResult(() => getGoal(db(), a.sessionId)));
    const emitGoal = (sessionId: string, goal: unknown) =>
      ctx.backendEvents.emit(`chat_v2_session_${sessionId}`, { eventType: 'goal_updated', sessionId, goal });
    ctx.commands.register<Args<'chat_v2_goal_edit'>>('chat_v2_goal_edit', a => commandResult(() => {
      const goal = editGoal(db(), a.sessionId, a.objective, a.tokenBudget ?? null);
      emitGoal(a.sessionId, goal);
      return goal;
    }));
    ctx.commands.register<Args<'chat_v2_goal_pause'>>('chat_v2_goal_pause', a => commandResult(() => {
      const { goal, changed } = pauseGoal(db(), a.sessionId);
      if (changed) emitGoal(a.sessionId, goal);
      return goal;
    }));
    ctx.commands.register<Args<'chat_v2_goal_resume'>>('chat_v2_goal_resume', (a, call) => commandResult(() => {
      const { goal, changed } = resumeGoal(db(), a.sessionId);
      if (!changed) return goal;
      emitGoal(a.sessionId, goal);
      // goal_handlers.rs:167 spawn_goal_continuation_if_idle.
      const goals = deps.goals();
      if (goals === undefined) log.debug(`[ChatV2::goal] ChatV2Pipeline unavailable; stop continuation: session=${a.sessionId}`);
      else goals.spawnContinuation(call.source, a.sessionId);
      return goal;
    }));
    ctx.commands.register<Args<'chat_v2_goal_clear'>>('chat_v2_goal_clear', a => commandResult(() => {
      clearGoal(db(), a.sessionId);
      emitGoal(a.sessionId, null);
      return null;
    }));

    // ============================================================
    // manage_session.rs
    // ============================================================

    ctx.commands.register<Args<'chat_v2_create_session'>>('chat_v2_create_session', a => commandResult(() =>
      createSessionAction(db(), a.mode, a.title ?? null, a.metadata ?? null, a.groupId ?? null, log, deps.initializeRuntimeRoots)));
    ctx.commands.register<Args<'chat_v2_update_session_settings'>>('chat_v2_update_session_settings', a => commandResult(() => {
      validateSessionId(a.sessionId);
      return updateSessionSettingsAction(db(), a.sessionId, a.settings);
    }));
    ctx.commands.register<Args<'chat_v2_archive_session'>>('chat_v2_archive_session', a => commandResult(() => {
      validateSessionId(a.sessionId);
      archiveSessionAction(db(), a.sessionId);
      return null;
    }));
    ctx.commands.register<Args<'chat_v2_save_session'>>('chat_v2_save_session', a => commandResult(() => {
      saveSessionAction(db(), a.sessionId, a.sessionState);
      return null;
    }));
    ctx.commands.register<Args<'chat_v2_restore_session'>>('chat_v2_restore_session', a => commandResult(() => {
      validateSessionId(a.sessionId);
      return restoreSessionAction(db(), a.sessionId);
    }));
    ctx.commands.register<Args<'chat_v2_list_agent_sessions'>>('chat_v2_list_agent_sessions', a => commandResult(() =>
      listAgentSessions(db(), a.workspaceId ?? null, a.limit ?? 50, log)));
    ctx.commands.register<Args<'chat_v2_session_message_count'>>('chat_v2_session_message_count', a => commandResult(() =>
      countSessionMessages(db(), a.sessionId)));
    ctx.commands.register('chat_v2_get_message_summary', () => commandResult(() => messageSummary(db())));
    ctx.commands.register<Args<'chat_v2_set_authority_mode'>>('chat_v2_set_authority_mode', a => commandResult(() =>
      setAuthorityModeAction(db(), a.sessionId, a.mode, log)));
    ctx.commands.register<Args<'chat_v2_set_permission_preset'>>('chat_v2_set_permission_preset', a => commandResult(() =>
      setPermissionPresetAction(db, a.sessionId, a.preset, a.confirm ?? null, approvalManager())));
    ctx.commands.register<Args<'chat_v2_get_rag_scope'>>('chat_v2_get_rag_scope', a => commandResult(() =>
      loadRagScope(db(), a.sessionId)));
    ctx.commands.register<Args<'chat_v2_set_rag_scope'>>('chat_v2_set_rag_scope', a => commandResult(() => {
      try {
        saveRagScope(db(), a.sessionId, a.folderIds);
      } catch (error) {
        // Rust maps FK failures to this plain string instead of a ChatV2Error JSON.
        if (error instanceof ChatV2Error && error.kind === 'Database'
          && error.message.includes('FOREIGN KEY')) {
          throw new CommandError('会话尚未保存，请先发送一条消息后再设置检索范围');
        }
        throw error;
      }
      return null;
    }));

    // ============================================================
    // block_actions.rs
    // ============================================================

    ctx.commands.register<Args<'chat_v2_delete_message'>>('chat_v2_delete_message', a => commandResult(() => {
      deleteMessageAction(db(), state, a.sessionId, a.messageId, log, deps.vfsRefs);
      return null;
    }));
    ctx.commands.register<Args<'chat_v2_delete_session'>>('chat_v2_delete_session', a => commandResult(() => {
      deleteSessionAction(db(), state, a.sessionId, superSession(), log, deps.vfsRefs, deps.cleanupRuntimeRoots,
        deps.staleAnkiReaper);
      return null;
    }));
    ctx.commands.register('chat_v2_empty_deleted_sessions', () => commandResult(() => {
      const purged = emptyDeletedSessionsAction(db(), superSession(), log, deps.vfsRefs, deps.cleanupRuntimeRoots);
      return purged.length;
    }));
    ctx.commands.register<Args<'chat_v2_get_anki_cards_from_block_by_document_id'>>('chat_v2_get_anki_cards_from_block_by_document_id',
      a => commandResult(() => ankiCardsFromBlockByDocumentId(db(), a.documentId)));
    ctx.commands.register<Args<'chat_v2_copy_block_content'>>('chat_v2_copy_block_content', a => commandResult(() =>
      copyBlockContent(db(), a.blockId, a.format ?? null)));
    ctx.commands.register<Args<'chat_v2_update_block_content'>>('chat_v2_update_block_content', a => commandResult(() =>
      updateBlockContentAction(db(), a.blockId, a.content, id => state.hasActiveStream(id), log)));
    ctx.commands.register<Args<'chat_v2_update_block_tool_output'>>('chat_v2_update_block_tool_output', a => commandResult(() => {
      updateBlockToolOutputAction(db(), a.blockId, a.toolOutputJson, log);
      return null;
    }));
    ctx.commands.register<Args<'chat_v2_upsert_streaming_block'>>('chat_v2_upsert_streaming_block', a => commandResult(() => {
      upsertStreamingBlockAction(db(), {
        blockId: a.blockId, messageId: a.messageId, sessionId: a.sessionId ?? null,
        blockType: a.blockType, content: a.content, status: a.status ?? null,
        toolName: a.toolName ?? null, toolInputJson: a.toolInputJson ?? null,
        toolOutputJson: a.toolOutputJson ?? null,
      }, log);
      return null;
    }));

    // ============================================================
    // load_session.rs / load_messages_page.rs
    // ============================================================

    ctx.commands.register<Args<'chat_v2_load_session'>>('chat_v2_load_session', a => commandResult(() => {
      if (rustTrim(a.sessionId) === '') {
        throw new ChatV2Error('Validation', 'Invalid session ID: empty or whitespace-only');
      }
      const tailLimit = a.tailLimit ?? null;
      const response = tailLimit !== null && tailLimit > 0
        ? loadSessionTail(db(), a.sessionId, tailLimit, log)
        : loadSessionFull(db(), a.sessionId, log);
      if (authorityModeFromMetadata(response.session.metadata) !== 'craft') {
        response.session = setAuthorityModeAction(db(), a.sessionId, 'craft');
      }
      return response;
    }));
    ctx.commands.register<Args<'chat_v2_soft_delete_session'>>('chat_v2_soft_delete_session', a => commandResult(() => {
      softDeleteSessionCommand(db(), state, a.sessionId, superSession(), log, deps.staleAnkiReaper);
      return null;
    }));
    // ============================================================
    // workspace_handlers.rs (coordinator-only commands)
    // ============================================================

    ctx.commands.register('workspace_list_agent_profiles', () => workspaceCommandResult(() =>
      listAgentProfiles(workspaceCoordinator(), log)));
    ctx.commands.register<Args<'workspace_read_agent_profile_file'>>('workspace_read_agent_profile_file', a => workspaceCommandResult(() =>
      readAgentProfileFile(workspaceCoordinator(), a.fileName)));
    ctx.commands.register<Args<'workspace_save_agent_profile_file'>>('workspace_save_agent_profile_file', async a => {
      try {
        const llm = ctx.get('llm') as LLMManager | undefined;
        if (llm === undefined) throw new Error('LLMManager is not available');
        return await saveAgentProfileFile(workspaceCoordinator(), llm, a.fileName, a.content, a.overwrite, log);
      } catch (error) { throw new CommandError(errorText(error)); }
    });
    ctx.commands.register<Args<'workspace_delete_agent_profile_file'>>('workspace_delete_agent_profile_file', async a => {
      try { await deleteAgentProfileFile(workspaceCoordinator(), a.fileName, log); return null; }
      catch (error) { throw new CommandError(errorText(error)); }
    });
    ctx.commands.register<Args<'workspace_close'>>('workspace_close', a => workspaceCommandResult(() => {
      closeWorkspaceAction(workspaceCoordinator(), state, a.sessionId, a.workspaceId, log); return null;
    }));
    ctx.commands.register<Args<'workspace_delete'>>('workspace_delete', a => workspaceCommandResult(() => {
      closeWorkspaceAction(workspaceCoordinator(), state, a.sessionId, a.workspaceId, log, true); return null;
    }));
    ctx.commands.register<Args<'workspace_cancel_agent'>>('workspace_cancel_agent', a => workspaceCommandResult(() =>
      cancelWorkspaceAgentAction(workspaceCoordinator(), state, a.sessionId, a.workspaceId, a.agentSessionId, log)));
    ctx.commands.register<Args<'workspace_manual_wake'>>('workspace_manual_wake', a => workspaceCommandResult(() =>
      manualWakeAction(workspaceCoordinator(), a.request, log)));
    ctx.commands.register<Args<'workspace_cancel_sleep'>>('workspace_cancel_sleep', a => workspaceCommandResult(() =>
      cancelSleepAction(workspaceCoordinator(), a.sessionId, a.workspaceId, a.sleepId, log)));
    ctx.commands.register<Args<'workspace_create'>>('workspace_create', a => workspaceCommandResult(() =>
      workspaceCreateAction(workspaceCoordinator(), a.sessionId, a.request)));
    ctx.commands.register<Args<'workspace_get'>>('workspace_get', a => workspaceCommandResult(() =>
      workspaceGetAction(workspaceCoordinator(), a.sessionId, a.workspaceId)));
    ctx.commands.register<Args<'workspace_list_agents'>>('workspace_list_agents', a => workspaceCommandResult(() =>
      workspaceListAgentsAction(workspaceCoordinator(), a.sessionId, a.workspaceId)));
    ctx.commands.register<Args<'workspace_send_message'>>('workspace_send_message', a => workspaceCommandResult(() =>
      workspaceSendMessageAction(workspaceCoordinator(), a.sessionId, a.request)));
    ctx.commands.register<Args<'workspace_list_messages'>>('workspace_list_messages', a => workspaceCommandResult(() =>
      workspaceListMessagesAction(workspaceCoordinator(), a.sessionId, a.workspaceId, a.limit ?? null)));
    ctx.commands.register<Args<'workspace_set_context'>>('workspace_set_context', a => workspaceCommandResult(() => {
      workspaceSetContextAction(workspaceCoordinator(), a.sessionId, a.workspaceId, a.key, a.value);
      return null;
    }));
    ctx.commands.register<Args<'workspace_get_context'>>('workspace_get_context', a => workspaceCommandResult(() =>
      workspaceGetContextAction(workspaceCoordinator(), a.sessionId, a.workspaceId, a.key)));
    ctx.commands.register<Args<'workspace_list_documents'>>('workspace_list_documents', a => workspaceCommandResult(() =>
      workspaceListDocumentsAction(workspaceCoordinator(), a.sessionId, a.workspaceId)));
    ctx.commands.register<Args<'workspace_get_document'>>('workspace_get_document', a => workspaceCommandResult(() =>
      workspaceGetDocumentAction(workspaceCoordinator(), a.sessionId, a.workspaceId, a.documentId)));
    ctx.commands.register<Args<'workspace_list_all'>>('workspace_list_all', a => workspaceCommandResult(() => {
      let connection;
      try { connection = chatDatabase(ctx.storage); }
      catch (error) { throw new CommandError(`Failed to get connection: ${errorText(error)}`); }
      return workspaceListAllAction(workspaceCoordinator(), a.sessionId, connection, log);
    }));

    ctx.commands.register<Args<'chat_v2_reorder_groups'>>('chat_v2_reorder_groups', a => commandResult(() => {
      reorderGroups(db(), a.groupIds);
      return null;
    }));
    ctx.commands.register<Args<'chat_v2_move_session_to_group'>>('chat_v2_move_session_to_group', a => commandResult(() => {
      const normalized = a.groupId !== null && a.groupId !== undefined && rustTrim(a.groupId) !== ''
        ? a.groupId : null;
      if (normalized !== null) {
        const group = getGroup(db(), normalized);
        if (!group || group.persistStatus !== 'active') {
          throw new ChatV2Error('GroupNotFound', normalized);
        }
      }
      updateSessionGroup(db(), a.sessionId, normalized);
      return null;
    }));
    ctx.commands.register<Args<'chat_v2_freeze_available_skills_snapshot'>>('chat_v2_freeze_available_skills_snapshot', a => commandResult(() => {
      validateSessionId(a.sessionId);
      return ctx.chatSession.freezeAvailableSkillsSnapshot(a.sessionId, a.snapshot);
    }));
    ctx.commands.register<Args<'chat_v2_list_sessions_referencing'>>('chat_v2_list_sessions_referencing', a => commandResult(() =>
      listSessionsReferencing(db(), a.sourceIds, Math.min(Math.max(a.limit ?? 20, 1), 100))));
    ctx.commands.register<Args<'chat_v2_load_messages_page'>>('chat_v2_load_messages_page', a => commandResult(() => {
      if (rustTrim(a.sessionId) === '') {
        throw new ChatV2Error('Validation', 'Invalid session ID: empty or whitespace-only');
      }
      const offset = a.offset ?? 0;
      const limit = Math.min(Math.max(a.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
      const window = loadSessionMessagesWindow(db(), a.sessionId, offset, limit, null, log);
      const consumed = Math.min(offset + window.messages.length, 0xffff_ffff);
      const nextOffset = window.messages.length > 0 && consumed < window.total ? consumed : null;
      return {
        messages: window.messages,
        blocks: window.blocks.map(toWireBlock),
        totalMessageCount: window.total,
        offset,
        limit,
        ...(nextOffset === null ? {} : { nextOffset }),
      };
    }));
}
