/**
 * L04 chat plugin entry point: service wiring only. Command bodies live in
 * `src/register.ts`; persistence lives in `repository/`.
 */
import { definePlugin, Slot } from '../../../kernel/api.ts';
import type { HostPlugin, PluginPlatform } from '../../../kernel/core.ts';
import { ChatV2State } from '../api.ts';
import { setChatLocalFs, type ChatLocalFs } from './local-fs.ts';
import { chatWorkspaceRuntime, setChatWorkspaceRuntime, type ChatWorkspaceRuntime } from './runtime-roots.ts';
import type { ChatLogger } from './logger.ts';
import { disposeAllChatEmitters } from './events.ts';
import { createChatSessionService } from './service.ts';
import { registerChatCommands, registerChatCompactionCommand, registerChatContinueCommand, registerChatRetryCommands,
  registerChatSendCommands,
  registerChatVariantRetryCommand, registerChatVariantsRetryCommand } from './register.ts';
import type { SendPipelinePort } from './send-message.ts';
import type { GoalRuntime } from './goal-runtime.ts';
import type { VariantRetryPipelinePort, VariantsRetryBatchPipelinePort } from './variant-retry.ts';
import type { DispatchedWorkerCanceller } from './retry-actions.ts';
import type { CompactionPipelinePort } from './compaction-actions.ts';
import { chatSessionService, chatStateService, chatWorkerRuntimeService } from '../api.ts';
import type { AutomationSchedulerLike } from './kill-switch.ts';
import { EmergencyCancelHooks } from './kill-switch.ts';
import type { StaleAnkiBlockReaper } from './stale-anki-reaper.ts';
import type { SystemNotificationService } from '../../../../electron/api.ts';
import type { AgentToolsService } from '../../agent-skills/api.ts';
import type { RuntimeRootLookup, VfsFolderServiceLike } from './group-actions.ts';
import type { AgentVfsResolver, RuntimeRootsService } from '../../agent-workspace/api.ts';
import { MobileApprovalManager } from './mobile-approval.ts';
import { createMobileVfsResolver } from './mobile-vfs-resolver.ts';
import { escapeXmlContent } from '../../agent-workspace/portable.ts';
import type { WindowRef } from '../../../kernel/protocol.ts';
import type { ResourceRepository, FolderRepository } from '../../vfs-repos/api.ts';
import type { VfsReferenceAccess } from './reference-counts.ts';
import type { WorkspaceRuntimeCoordinator } from '../api.ts';
import type { ApprovalManager } from '../../agent-workspace/api.ts';
import type { PlanGateManager } from '../../chat-pipeline/api.ts';
import type {} from '../../agent-orchestration/api.ts';
import type { SuperSessionHook } from './deletion.ts';
import type { SettingsService } from '../../../platform/settings/api.ts';
import { ChatV2Error } from './error.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { LLMManager } from '../../llm/api.ts';
import type { OcrManager } from './ocr.ts';
import { reconcileChatStartup } from './startup.ts';
import { attachmentNotFoundError, requiredAttachmentId, localizedAttachmentFailure } from './attachment-errors.ts';
import { loadSessionRagScope } from './retrieval-scope.ts';
import { restoreRevocationEpochsFromDb } from './grants.ts';
import { registerStageContextAttachmentsCommand } from './stage-context-command.ts';
import { AttachmentStageExecutor, type AttachmentStageRepository } from './attachment-stage-executor.ts';
import type { StageAttachmentRepository } from './attachment-stage.ts';
import { CompletionDispatcherRuntime } from './completion-dispatcher.ts';
import { registerWorkspaceWorkerCommands, workerRuntimeDeps } from './register-workspace-workers.ts';
import { workerRuntimeSurfaces, type WorkerPipelinePort, type WorkerRuntimeDeps } from './workspace-run-agent.ts';
import { createWorkerRuntimeService } from './worker-runtime-service.ts';
import type { AgentCompletionOutbox } from '../../agent-workspace/api.ts';

type CompletionDispatcherRuntimeHeadless = ReturnType<ConstructorParameters<typeof CompletionDispatcherRuntime>[0]['headlessTurn']>;

/** A stream that ignores its abort must not hold unload or host shutdown longer than this. */
const TRACKED_TASK_SHUTDOWN_MS = 2_000;

/** Cordis exposes printf-style loggers; chat code uses plain string messages. */
function chatLogger(ctx: Context): ChatLogger {
  return {
    error: (format: string, ...params: unknown[]) => ctx.logger.error(format, ...params),
    warn: (format: string, ...params: unknown[]) => ctx.logger.warn(format, ...params),
    info: (format: string, ...params: unknown[]) => ctx.logger.info(format, ...params),
    debug: (format: string, ...params: unknown[]) => ctx.logger.debug(format, ...params),
  };
}

/** 平台差异部分：桌面入口注入 `node:fs` / `node:os` 同步端口，移动端入口不注入（AGENTS.md 发现与附件暂存降级）。 */
export interface ChatPluginOptions {
  platforms?: readonly PluginPlatform[];
  /** `() => port` 在 apply 时求值并安装；缺省用无本地文件系统的端口。 */
  localFs?: (ctx: Context) => ChatLocalFs;
  /** runtime root / 人设文件列表端口；缺省按“无本地文件系统”降级。 */
  workspaceRuntime?: () => ChatWorkspaceRuntime;
}

/** 插件本体（可移植）：入口按平台在 `index.ts` / `mobile.ts` 之间选择。 */
export function createChatPlugin(options: ChatPluginOptions = {}): HostPlugin {
  return definePlugin({
  meta: {
    id: 'dstu.chat', lane: 'L04-chat-session', provides: [
      'chatState', 'chatSession', 'chatAttachmentErrors', 'chatRetrievalScope', 'chatWorkerRuntime',
      // The mobile profile has no `dstu.agent-workspace`; chat publishes the approval manager the
      // tool runtime and `chat_v2_tool_approval_*` read so sensitive tools can still be approved.
      ...(options.platforms?.includes('mobile') === true ? ['agentApproval'] : []),
    ],
    ...(options.platforms === undefined ? {} : { platforms: options.platforms }),
    commands: [
      'chat_v2_get_session', 'chat_v2_list_sessions', 'chat_v2_count_sessions',
      'chat_v2_add_tag', 'chat_v2_remove_tag', 'chat_v2_get_session_tags', 'chat_v2_get_tags_batch',
      'chat_v2_list_all_tags', 'chat_v2_search_sessions', 'chat_v2_search_content', 'rebuild_chat_fts',
      'chat_v2_goal_get', 'chat_v2_goal_edit',
      'chat_v2_has_active_stream', 'chat_v2_get_emit_failure_count',
      'chat_v2_create_session', 'chat_v2_update_session_settings', 'chat_v2_archive_session',
      'chat_v2_save_session', 'chat_v2_restore_session', 'chat_v2_list_agent_sessions',
      'chat_v2_session_message_count', 'chat_v2_get_message_summary', 'chat_v2_set_authority_mode',
      'chat_v2_set_permission_preset', 'chat_v2_get_rag_scope', 'chat_v2_set_rag_scope',
      'chat_v2_copy_block_content', 'chat_v2_update_block_content',
      'chat_v2_update_block_tool_output', 'chat_v2_upsert_streaming_block',
      'chat_v2_load_session', 'chat_v2_load_messages_page',
      'chat_v2_cancel_stream', 'chat_v2_goal_pause', 'chat_v2_goal_resume', 'chat_v2_goal_clear',
      'chat_v2_soft_delete_session', 'chat_v2_reorder_groups', 'chat_v2_move_session_to_group',
      'chat_v2_freeze_available_skills_snapshot', 'chat_v2_list_sessions_referencing',
      'chat_v2_switch_variant', 'chat_v2_delete_variant', 'chat_v2_cancel_variant',
      'chat_v2_get_anki_cards_from_block_by_document_id',
      'chat_v2_delete_message', 'chat_v2_delete_session', 'chat_v2_empty_deleted_sessions',
      'chat_v2_export_session', 'chat_v2_export_session_jsonl',
      'chat_v2_export_session_meta', 'chat_v2_export_session_messages', 'chat_v2_import_session',
      'chat_v2_kill_switch_status', 'chat_v2_emergency_stop', 'chat_v2_resume_agents',
      'chat_v2_resume_automations',
      'workspace_create', 'workspace_get', 'workspace_list_agents', 'workspace_send_message',
      'workspace_close', 'workspace_delete', 'workspace_cancel_agent', 'workspace_manual_wake', 'workspace_cancel_sleep',
      'workspace_run_agent', 'workspace_create_agent', 'workspace_restore_executions',
      'workspace_list_messages', 'workspace_set_context', 'workspace_get_context',
      'workspace_list_documents', 'workspace_get_document', 'workspace_list_all', 'workspace_list_agent_profiles',
      'workspace_read_agent_profile_file', 'workspace_delete_agent_profile_file',
      'workspace_save_agent_profile_file',
      'chat_v2_create_group', 'chat_v2_update_group',
      'chat_v2_get_group', 'chat_v2_list_groups', 'chat_v2_archive_group',
      'chat_v2_restore_group', 'chat_v2_delete_group',
      'chat_v2_tool_approval_respond', 'chat_v2_tool_approval_cancel',
      'chat_v2_clear_approval_history', 'chat_v2_ask_user_respond',
      'chat_v2_check_migration_status', 'chat_v2_migrate_legacy_chat',
      'chat_v2_rollback_migration', 'chat_v2_undo_compaction',
      'chat_v2_compact_session', 'chat_v2_retry_message', 'chat_v2_edit_and_resend',
      'chat_v2_retry_variant', 'chat_v2_retry_variants',
      'chat_v2_branch_session', 'chat_v2_plan_gate_respond', 'chat_v2_perform_ocr',
      'chat_v2_stage_context_attachments', 'chat_v2_send_message', 'chat_v2_wake_session', 'chat_v2_continue_message',
    ],
  },
  // `vfs` is published by dstu.vfs and backs topic-folder provisioning.
  inject: ['storage', 'vfs'],
  apply(ctx) {
    if (options.platforms?.includes('mobile') === true && ctx.get('agentApproval') === undefined) {
      ctx.provide('agentApproval', new MobileApprovalManager());
    }
    setChatLocalFs(options.localFs?.(ctx) ?? null);
    ctx.effect(() => () => setChatLocalFs(null));
    setChatWorkspaceRuntime(options.workspaceRuntime?.() ?? null);
    ctx.effect(() => () => setChatWorkspaceRuntime(null));
    const log = chatLogger(ctx);
    reconcileChatStartup(ctx.storage, log);
    const eventOwner = ctx.backendEvents;
    const state = new ChatV2State(log);
    // Streams run detached through spawnTracked: abort them on unload and give the tracked
    // work a bounded window to persist and emit its cancelled state.
    let streamShutdown: Promise<boolean> | undefined;
    const shutdownStreams = (): Promise<boolean> => streamShutdown ??= (() => {
      state.cancelAllStreams();
      return state.shutdownTasks(TRACKED_TASK_SHUTDOWN_MS);
    })();
    // Cordis starts all disposers of a scope together, last-registered first: emitters are
    // flushed only after the tracked work settled, or it would open new chunk windows.
    ctx.effect(() => async () => {
      await shutdownStreams();
      disposeAllChatEmitters(eventOwner);
    });
    ctx.provide(chatStateService.name, state);
    const emergencyHooks = new EmergencyCancelHooks();
    const staleAnkiReaper = new Slot<StaleAnkiBlockReaper>();
    let tools: AgentToolsService | undefined;
    let stageAttachments: AttachmentStageRepository | undefined;
    const attachmentStage = new AttachmentStageExecutor({ dataDir: () => ctx.app.dataDir,
      attachments: () => stageAttachments, warn: message => log.warn(message) });
    ctx.inject(['agentTools'], linked => {
      tools = linked.agentTools;
      const registration = linked.agentTools.registerToolExecutors([attachmentStage]);
      return () => { registration.dispose(); tools = undefined; };
    });
    let goalRuntime: GoalRuntime | undefined;
    const sessions = createChatSessionService(ctx.storage, log, emergencyHooks, () => tools?.toolExecutors() ?? [],
      staleAnkiReaper, () => goalRuntime);
    ctx.provide(chatSessionService.name, sessions);
    // grants.rs: ChatV2Database::new restores persisted revocation epochs (max semantics).
    restoreRevocationEpochsFromDb(sessions.database, log);
    ctx.provide('chatAttachmentErrors', { requiredId: requiredAttachmentId, notFound: attachmentNotFoundError, localize: localizedAttachmentFailure });
    ctx.provide('chatRetrievalScope', { loadSessionRagScope });

    // Child injections track late providers and service replacement without
    // blocking unrelated chat commands on the pipeline or automation runtime.
    let gates: PlanGateManager | undefined;
    ctx.inject(['chatPipeline'], linked => {
      gates = linked.chatPipeline.planGateManager;
      const pipeline = linked.chatPipeline as typeof linked.chatPipeline & Partial<CompactionPipelinePort>;
      if (typeof pipeline.runCompactionForSession === 'function') {
        registerChatCompactionCommand(linked, sessions.database, state, {
          runCompactionForSession: pipeline.runCompactionForSession.bind(pipeline),
          compactionStatus: pipeline.compactionStatus.bind(pipeline),
          compactionReasonCode: pipeline.compactionReasonCode.bind(pipeline),
          compactionTokenEstimates: pipeline.compactionTokenEstimates.bind(pipeline),
        });
      }
      return () => { gates = undefined; };
    });
    const planGateManager = (): PlanGateManager | undefined => gates;
    let approvals: ApprovalManager | undefined;
    ctx.inject(['agentApproval'], linked => {
      approvals = linked.agentApproval;
      return () => { approvals = undefined; };
    });
    const approvalManager = (): ApprovalManager | undefined => approvals;
    let scheduler: AutomationSchedulerLike | undefined;
    ctx.inject(['agentAutomation'], linked => {
      scheduler = linked.agentAutomation;
      return () => { scheduler = undefined; };
    });
    const automation = (): AutomationSchedulerLike | undefined => scheduler;
    let folders: FolderRepository | undefined;
    const vfs = (): VfsFolderServiceLike => ({ version: 1, database: ctx.vfs.database, folders });
    let roots: RuntimeRootsService | undefined;
    ctx.inject(['runtimeRoots'], linked => {
      roots = linked.runtimeRoots;
      return () => { roots = undefined; };
    });
    const runtimeRoots = (): RuntimeRootLookup | undefined => {
      if (roots === undefined) return undefined;
      const service = roots;
      return { resolve: rootId => service.rootById(rootId, { session_id: 'session-preview' }) };
    };
    let workspace: WorkspaceRuntimeCoordinator | undefined;
    ctx.inject(['agentWorkspace'], linked => {
      workspace = linked.agentWorkspace;
      return () => { workspace = undefined; };
    });
    const workspaceCoordinator = (): WorkspaceRuntimeCoordinator | undefined => workspace;
    let resources: ResourceRepository | undefined;
    ctx.inject(['vfsRepo'], linked => {
      resources = linked.vfsRepo.resources;
      folders = linked.vfsRepo.folders;
      return () => { resources = undefined; folders = undefined; };
    });
    // attachment_stage_executor.rs:1350-1362 needs L11 getInlineDataWithConn; register only once it is published.
    ctx.inject(['vfsRepo'], linked => {
      const attachments = linked.vfsRepo.attachments as typeof linked.vfsRepo.attachments
        & Partial<Pick<StageAttachmentRepository, 'getInlineDataWithConn'>>;
      if (typeof attachments.getInlineDataWithConn !== 'function') return;
      const repo = attachments as StageAttachmentRepository & typeof linked.vfsRepo.attachments;
      stageAttachments = repo;
      registerStageContextAttachmentsCommand(linked, {
        dataDir: ctx.app.dataDir,
        vfsDatabase: () => ctx.vfs.database,
        attachments: () => repo,
      });
      return () => { stageAttachments = undefined; };
    });
    const requireResources = (): ResourceRepository => {
      if (resources === undefined) throw new Error('VfsResourceRepo is not available');
      return resources;
    };
    const vfsRefs: VfsReferenceAccess = {
      getConnection: () => ctx.vfs.database.getConnSafe(),
      increment: (conn, id) => requireResources().incrementRef(conn, id),
      decrement: (conn, id) => requireResources().decrementRef(conn, id),
      decrementMany: (conn, ids) => requireResources().decrementRefs(conn, ids),
    };
    let ocr: OcrManager | undefined;
    ctx.inject(['llm'], linked => {
      const manager = linked.llm as LLMManager & Partial<OcrManager>;
      if (typeof manager.getOcrAdapter === 'function' && typeof manager.callOcrModelRawPrompt === 'function') {
        ocr = { getOcrAdapter: manager.getOcrAdapter.bind(manager),
          callOcrModelRawPrompt: manager.callOcrModelRawPrompt.bind(manager) };
      }
      return () => { ocr = undefined; };
    });
    let subagent: SuperSessionHook | undefined;
    let headlessTurn: CompletionDispatcherRuntimeHeadless | undefined;
    ctx.inject(['agentSubagent'], linked => {
      subagent = linked.agentSubagent;
      const service = linked.agentSubagent;
      headlessTurn = typeof service.runHeadlessAgentTurn === 'function' ? service.runHeadlessAgentTurn.bind(service) : undefined;
      return () => { subagent = undefined; headlessTurn = undefined; };
    });
    let completionOutbox: AgentCompletionOutbox | undefined;
    ctx.inject(['agentCompletionOutbox'], linked => {
      completionOutbox = linked.agentCompletionOutbox;
      return () => { completionOutbox = undefined; };
    });
    // completion_dispatcher.rs window probe: Tauri `app.webview_windows()` non-empty.
    const openWindows = new Set<string>();
    // goal/runtime.rs:435 resolve_emit_window: `app.webview_windows()` keyed by webview label.
    const webviews = new Map<string, WindowRef>();
    ctx.on('host/window', (ref, windowState) => {
      if (windowState === 'created') { openWindows.add(ref.window); webviews.set(ref.webview, { ...ref }); }
      else if (windowState === 'destroyed') { openWindows.delete(ref.window); webviews.delete(ref.webview); }
    });
    /** `webviews.get("main")` else the first webview (Rust HashMap order is unspecified; first-created here). */
    const resolveEmitWindow = (): WindowRef | null => webviews.get('main') ?? webviews.values().next().value ?? null;
    const completionDispatcher = new CompletionDispatcherRuntime({
      outbox: () => completionOutbox, db: sessions.database, storage: ctx.storage,
      coordinator: () => workspace, state, hasWindow: () => openWindows.size > 0,
      emit: (event, payload) => ctx.backendEvents.emit(event, payload),
      headlessTurn: () => headlessTurn, log,
    });
    ctx.effect(() => () => { completionDispatcher.stop(); });
    let workerRuntime: (() => WorkerRuntimeDeps) | undefined;
    ctx.provide(chatWorkerRuntimeService.name, createWorkerRuntimeService({
      db: sessions.database, state, log, coordinator: () => workspace, runtime: () => workerRuntime?.(),
    }));
    ctx.inject(['chatPipeline'], linked => {
      // workspace_handlers.rs worker runtime: needs L03 execute (+ budget attach) and L05/L06 surfaces.
      const executable = linked.chatPipeline as typeof linked.chatPipeline & Partial<Pick<WorkerPipelinePort, 'execute'>>;
      const surfaces = workerRuntimeSurfaces();
      if (typeof executable.execute !== 'function' || surfaces === null) return;
      const workerDeps = {
        db: sessions.database, state, surfaces, log, dispatcher: completionDispatcher,
        coordinator: () => workspace, outbox: () => completionOutbox,
        pipeline: {
          execute: executable.execute.bind(executable),
          attachChildToTree: (parent: string, child: string, declared?: Parameters<WorkerPipelinePort['attachChildToTree']>[2]) =>
            executable.attachChildToTree(parent, child, declared),
        },
      };
      registerWorkspaceWorkerCommands(linked, workerDeps);
      const runtime = workerRuntimeDeps(linked, workerDeps);
      workerRuntime = runtime;
      return () => { if (workerRuntime === runtime) workerRuntime = undefined; };
    });
    const superSession = (): SuperSessionHook | undefined => subagent;
    const settings = (): SettingsService => {
      const service = ctx.get('settings') as SettingsService | undefined;
      if (service === undefined) throw new ChatV2Error('Database', 'Settings service is unavailable');
      return service;
    };

    /** L05 resolver when a workspace provider is loaded (desktop); VFS-only fallback on mobile. */
    const contextResolver = (): AgentVfsResolver =>
      ctx.get('agentVfsResolver') ?? createMobileVfsResolver(ctx);
    // send_message.rs retry/edit: only when the real L03 execute entry and every
    // owner they read through (L02 models, L11 resources, L05 resolver) are present.
    ctx.inject(['chatPipeline', 'llm', 'vfsRepo'], linked => {
      const pipeline = linked.chatPipeline as typeof linked.chatPipeline & Partial<SendPipelinePort>;
      if (typeof pipeline.execute !== 'function') return;
      const execute = pipeline.execute.bind(pipeline);
      const llm = linked.llm;
      registerChatRetryCommands(linked, {
        database: sessions.database, state, log, vfsRefs,
        superSession: () => {
          const service = subagent as Partial<DispatchedWorkerCanceller> | undefined;
          return typeof service?.cancelWorkersDispatchedIn === 'function' ? service as DispatchedWorkerCanceller : undefined;
        },
        pipeline: { execute },
        llm: { getApiConfigs: () => llm.getApiConfigs(), selectModelFor: (...args) => llm.selectModelFor(...args) },
        contextRefs: {
          getConnection: () => ctx.vfs.database.getConnSafe(),
          resources: linked.vfsRepo.resources,
          resolveContextRefDataToBlocks: (data, multimodal) => contextResolver().resolveContextRefDataToBlocks(data, multimodal),
        },
      });
      registerChatContinueCommand(linked, {
        database: sessions.database, state, log, pipeline: { execute },
        llm: { getApiConfigs: () => llm.getApiConfigs(), selectModelFor: (...args) => llm.selectModelFor(...args) },
        contextRefs: {
          getConnection: () => ctx.vfs.database.getConnSafe(),
          resources: linked.vfsRepo.resources,
          resolveContextRefDataToBlocks: (data, multimodal) => contextResolver().resolveContextRefDataToBlocks(data, multimodal),
        },
      });
    });
    // send_message.rs chat_v2_send_message / chat_v2_wake_session: only with the real L03 execute entry.
    // One GoalRuntime per pipeline binding (runtime.rs in-flight continuation registry + background spawn).
    ctx.inject(['chatPipeline', 'llm', 'backgroundTasks'], linked => {
      const pipeline = linked.chatPipeline as typeof linked.chatPipeline & Partial<SendPipelinePort>;
      if (typeof pipeline.execute !== 'function') return;
      let port: SendPipelinePort | undefined = { execute: pipeline.execute.bind(pipeline) };
      const llm = linked.llm;
      const events = { emit: (event: string, payload: unknown) => linked.backendEvents.emit(event, payload) };
      const goals = sessions.createGoalRuntime({
        state, background: linked.backgroundTasks, pipeline: () => port, resolveWindow: resolveEmitWindow,
        events, escapeObjective: escapeXmlContent,
      });
      registerChatSendCommands(linked, sessions.createMessageSender({
        state, pipeline: port, events, goals,
        llm: { getApiConfigs: () => llm.getApiConfigs(), selectModelFor: (...args) => llm.selectModelFor(...args) },
      }));
      goalRuntime = goals;
      return () => {
        port = undefined;
        if (goalRuntime === goals) goalRuntime = undefined;
      };
    });
    ctx.inject(['chatPipeline', 'llm', 'vfsRepo'], linked => {
      const pipeline = linked.chatPipeline as typeof linked.chatPipeline & Partial<VariantRetryPipelinePort>;
      if (typeof pipeline.executeVariantRetry !== 'function') return;
      const executeVariantRetry = pipeline.executeVariantRetry.bind(pipeline);
      const llm = linked.llm;
      registerChatVariantRetryCommand(linked, {
        database: sessions.database, state, log, pipeline: { executeVariantRetry },
        llm: { getApiConfigs: () => llm.getApiConfigs(), selectModelFor: (...args) => llm.selectModelFor(...args) },
        resources: { getConnection: () => ctx.vfs.database.getConnSafe(), resources: linked.vfsRepo.resources },
        resolveContextRefDataToContent: (data, multimodal) => contextResolver().resolveContextRefDataToContent(data, multimodal),
      });
    });
    ctx.inject(['chatPipeline', 'llm', 'vfsRepo'], linked => {
      const pipeline = linked.chatPipeline as typeof linked.chatPipeline & Partial<VariantsRetryBatchPipelinePort>;
      if (typeof pipeline.executeVariantsRetryBatch !== 'function') return;
      const executeVariantsRetryBatch = pipeline.executeVariantsRetryBatch.bind(pipeline);
      const llm = linked.llm;
      registerChatVariantsRetryCommand(linked, {
        database: sessions.database, state, log, pipeline: { executeVariantsRetryBatch },
        llm: { getApiConfigs: () => llm.getApiConfigs(), selectModelFor: (...args) => llm.selectModelFor(...args) },
        resources: { getConnection: () => ctx.vfs.database.getConnSafe(), resources: linked.vfsRepo.resources },
        resolveContextRefDataToContent: (data, multimodal) => contextResolver().resolveContextRefDataToContent(data, multimodal),
      });
    });
    registerChatCommands({
      ctx, state, log, settings, approvalManager, automation, vfs, runtimeRoots,
      planGateManager, superSession, workspaceCoordinator, ocrManager: () => ocr, goals: () => goalRuntime,
      appVersion: ctx.app.version,
      vfsRefs, cleanupRuntimeRoots: sessionId => chatWorkspaceRuntime().cleanupSessionRuntimeRoots(ctx.app.dataDir, sessionId),
      initializeRuntimeRoots: sessionId => {
        chatWorkspaceRuntime().sessionRoot(ctx.app.dataDir, sessionId, 'artifact', true);
        chatWorkspaceRuntime().sessionRoot(ctx.app.dataDir, sessionId, 'temp', true);
      },
      emergencyHooks, staleAnkiReaper,
      notification: () => ctx.get('systemNotification') as SystemNotificationService | undefined,
    });
    // Registered last so unload aborts the streams before any chat service, command or
    // child scope above is withdrawn. Host shutdown disposes plugins one at a time in reverse
    // install order and stops waiting on each after PLUGIN_DISPOSE_TIMEOUT_MS (1.5 s), so past
    // that the emitter flush finishes in the background; this 2 s bound ends a plain unload.
    ctx.effect(() => async () => { await shutdownStreams(); });
  },
});
}
