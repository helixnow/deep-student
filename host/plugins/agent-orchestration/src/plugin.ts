import { join } from '../../../platform/util/path.ts';
import { CommandError, definePlugin, type WindowRef } from '../../../kernel/api.ts';
import type { HostPlugin, PluginPlatform } from '../../../kernel/core.ts';
import { localNodeRuntime, setLocalNodeRuntime, type LocalNodeRuntime } from './local-node-runtime.ts';
import {
  setAgentOrchestrationWorkspaceRuntime, type AgentOrchestrationWorkspaceRuntime,
} from './workspace-runtime.ts';
import type { Commands } from '../../../../contracts/ipc/generated/L06-agent-orchestration.ts';
import type {
  AutomationCreateCommandRequest, AutomationUpdateCommandRequest, DeliverInboxRequest,
  DeliverOutcome,
} from '../../../../contracts/ipc/generated/L06-agent-orchestration.ts';
import type {
  AgentSubagentService, BackgroundResidencyState, HeadlessSessionTurn, HeadlessTurnOutcome, HeadlessTurnRequest,
  HeadlessTurnResult, Json,
} from '../api.ts';
import type {} from '../../../platform/settings/api.ts';
import type { StartupFinalizerOptions } from '../../../platform/storage/api.ts';
import type { BackgroundTasks } from '../../../platform/diagnostics/api.ts';
import type {} from '../../vfs-repos/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { agentOrchestrationWorkspaceRuntime } from './workspace-runtime.ts';
import { KILL_SWITCH_STATE_UNAVAILABLE_MESSAGE, type ChatV2State } from '../../chat/api.ts';
import { automationSummary, retryAutomationRun } from '../repository/automation-summary.ts';
import {
  automationListResponse, automationToListItem, cancelAutomationRun, createAutomation, insertAutomation,
  deleteAutomation, ensureHeartbeatAutomation, listAutomationRuns, loadAutomations,
  recoverStaleAutomationRuns, setAutomationEnabled, setRunDeliveryMarker, updateAutomationFull,
} from '../repository/automations.ts';
import { deliverAutomationTodo, type AutomationTodoRepository } from '../repository/automation-todo.ts';
import { heartbeatHasPendingWork } from '../repository/automation-heartbeat.ts';
import { migrateLegacyAutomations } from '../repository/automation-legacy.ts';
import { migrateLegacyDb } from '../repository/legacy.ts';
import {
  loadPersistedTodoListWithConn, persistTodoListWithConn, restoreTodoListFromDbWithConn,
} from '../repository/todo.ts';
import { getTodoList } from './todo-store.ts';
import type { TodoList } from './todo.ts';
import { setHeadlessPolicyLogger } from './headless.ts';
import { setSessionToolsLogger } from '../repository/session-tools.ts';
import { automationCommandError, errorMessage } from './automation-errors.ts';
import { createFieldsFromRequest, updateFieldsFromRequest } from './automation-request.ts';
import { onceAutomationCompleted } from './automation-schedule.ts';
import {
  SCHEDULER_POLL_SECS, AutomationSchedulerState, type AutomationDispatchPort, type AutomationRuntimeDeps,
  cancelActiveAutomationRunsForEmergencyStop, runAutomationNow, setAutomationRuntimeLogger, tickAutomations,
} from './automation-runtime.ts';
import { normalizeTrustedProfile } from './trusted-profile.ts';
import { readEnabled, readSettings, writeSettings } from './settings.ts';
import { parseDeliverInboxRequest } from './super-session.ts';
import { setInboundLogger } from './inbound.ts';
import { setCustomAgentLogger } from './custom-agent.ts';
import { CustomAgentExecutor } from './custom-agent-executor.ts';
import { SubagentExecutor } from './subagent-executor.ts';
import { SuperSessionExecutor } from './super-session-executor.ts';
import { AttemptCompletionExecutor } from './attempt-completion-executor.ts';
import { AskUserExecutor } from './ask-user-executor.ts';
import { CoordinatorSleepExecutor } from './coordinator-sleep-executor.ts';
import { GoalExecutor } from './goal-executor.ts';
import { RolePackExecutor } from './role-pack-executor.ts';
import { SelfInspectExecutor } from './self-inspect-executor.ts';
import { TaskAuditExecutor } from './task-audit-executor.ts';
import { SessionToolExecutor } from './session-tool-executor.ts';
import { AutomationExecutor } from './automation-executor.ts';
import { TodoListExecutor } from './todo-executor.ts';
import type {} from '../../agent-skills/api.ts';
import { createSuperSessionLookup } from '../repository/super-session.ts';
import {
  cancelWorkersDispatchedIn as superSessionCancelWorkersDispatchedIn,
  disabledState as superSessionDisabledState, emitChanged as emitSuperSessionChanged,
  ensure as superSessionEnsure, getState as superSessionGetState,
  onSessionRemoved as superSessionOnSessionRemoved,
  setEnabled as superSessionSetEnabled, type SuperSessionDeps,
} from './super-state.ts';
import {
  deliverInbox, resolveSuperInboxDeps, SEND_MESSAGE_PIPELINE_SERVICE,
  type SendMessagePipeline,
} from './super-inbox-drain.ts';
import {
  deliverPendingAgentNotifications, deliverRunNotification, notificationLanguage, POLICY_SETTING_KEY,
  type NotificationDeps, type SystemNotificationPort,
} from './automation-notifications.ts';

/** `lib.rs:1725-1730`：只有 `"true"` 才算开启。 */
const QUICK_ASSISTANT_BACKGROUND_KEY = 'quick_assistant.background_enabled';

/** Rust `{:?}` of `Option<String>`. */
function rustOptionDebug(value: string | null): string {
  return value === null ? 'None' : `Some(${JSON.stringify(value)})`;
}

function isAppError(error: unknown): error is AppError {
  return typeof error === 'object' && error !== null && 'error_type' in error && 'message' in error;
}

/**
 * L04 发布 headless 管线后可被本 lane 消费的最小接口（`headless.rs:1275/1381`）。
 * 生产装配在 `chatSession` / `chatPipeline` 上探测这两个方法；没有 provider
 * 时不发布 `agentSubagent` 的对应能力（见 ACCEPTANCE O1 的协调结论）。
 */
interface HeadlessRunner {
  runHeadlessTurn(request: HeadlessTurnRequest): Promise<HeadlessTurnResult>;
  runHeadlessAgentTurn(request: HeadlessSessionTurn): Promise<HeadlessTurnOutcome>;
}

/** F2 `startupGate` 的最小消费面；F3 的 finalizer 全部成功后才由组合根标记 ready。 */
interface StartupGateReader {
  isStartupReady(): boolean;
  waitStartupReady(timeout: number): Promise<boolean>;
}

/** 与 F2 `STARTUP_READY_WAIT` 一致：等待平台启动收尾完成的上限。 */
const STARTUP_READY_TIMEOUT_MS = 120_000;

/** 内核在关停开始、任何插件 dispose 之前广播一次（W01，对应 Rust `RunEvent::ExitRequested`）。 */
const HOST_EXITING_EVENT = 'host/exiting';

function asHeadlessRunner(value: unknown): HeadlessRunner | null {
  if (value === null || typeof value !== 'object') return null;
  const candidate = value as Partial<HeadlessRunner>;
  if (typeof candidate.runHeadlessTurn !== 'function') return null;
  if (typeof candidate.runHeadlessAgentTurn !== 'function') return null;
  return candidate as HeadlessRunner;
}

/** 平台差异部分：桌面入口注入 `node:fs` / `node:os` 实现，移动端入口不注入（人设文件降级）。 */
export interface AgentOrchestrationPluginOptions {
  platforms?: readonly PluginPlatform[];
  /** `() => runtime` 在 apply 时求值并安装；缺省用无本地文件系统的端口。 */
  localNodeRuntime?: () => LocalNodeRuntime;
  /** runtime root / skill package 根端口；缺省按“无本地文件系统”降级。 */
  workspaceRuntime?: () => AgentOrchestrationWorkspaceRuntime;
  /**
   * 自动化调度器（启动恢复 + 15s tick）。缺省开启；移动端没有 `dstu.shell` 的启动门，入口传 `'off'`，
   * 只保留退出/卸载标记与命令面。
   */
  automationScheduler?: 'startup-gated' | 'off';
}

/** 插件本体（可移植）：入口按平台在 `index.ts` / `mobile.ts` 之间选择。 */
export function createAgentOrchestrationPlugin(options: AgentOrchestrationPluginOptions = {}): HostPlugin {
  return definePlugin({
  meta: {
    id: 'dstu.agent-orchestration',
    lane: 'L06-agent-orchestration',
    commands: ['super_session_get_settings', 'super_session_set_settings',
      'chat_v2_automation_summary', 'chat_v2_automation_set_background_enabled',
      'chat_v2_automation_retry_run', 'chat_v2_automation_list', 'chat_v2_automation_create',
      'chat_v2_automation_set_enabled', 'chat_v2_automation_update', 'chat_v2_automation_delete',
      'chat_v2_automation_runs', 'chat_v2_automation_cancel_run', 'chat_v2_automation_run_now',
      'chat_v2_super_deliver_inbox', 'super_session_ensure', 'super_session_get_state',
      'super_session_set_enabled', 'chat_v2_background_subagent'],
    provides: ['agentAutomation', 'agentSubagent', 'agentTodo'],
    // The shell asks this on main-window close (electron/shell/background-residency.ts); markAppExiting stays Host-only.
    remote: { agentAutomation: ['backgroundResidency'] },
    ...(options.platforms === undefined ? {} : { platforms: options.platforms }),
  },
  inject: ['settings', 'storage'],
  apply(ctx) {
    setLocalNodeRuntime(options.localNodeRuntime?.() ?? null);
    ctx.effect(() => () => setLocalNodeRuntime(null));
    setAgentOrchestrationWorkspaceRuntime(options.workspaceRuntime?.() ?? null);
    ctx.effect(() => () => setAgentOrchestrationWorkspaceRuntime(null));
    const automationSchedulerEnabled = options.automationScheduler !== 'off';
    setHeadlessPolicyLogger(ctx.logger);
    // The connection is resolved per operation; restore performs the same fresh read as Rust.
    ctx.provide('agentTodo', {
      persistTodoList: (sessionId: string, messageId: string, variantId: string | null, list: TodoList) =>
        persistTodoListWithConn(ctx.storage.database('chat_v2'), sessionId, messageId, variantId, list, ctx.logger),
      loadPersistedTodoList: (sessionId: string) =>
        loadPersistedTodoListWithConn(ctx.storage.database('chat_v2'), sessionId, ctx.logger),
      restoreTodoListFromDb: (sessionId: string) =>
        restoreTodoListFromDbWithConn(ctx.storage.database('chat_v2'), sessionId, ctx.logger),
      getTodoList,
    });
    const openDatabase = () => {
      try { return ctx.storage.database('mistakes'); }
      catch (error) {
        throw automationCommandError(AppError.database(`Failed to open automation database: ${errorMessage(error)}`));
      }
    };
    const runCommand = <T>(operation: () => T): T => {
      try { return operation(); }
      catch (error) {
        if (isAppError(error)) throw automationCommandError(error);
        throw error;
      }
    };
    const emitChanged = (action: string, automationId = '') => {
      try { ctx.backendEvents.emit('chat_v2://automations_changed', { action, automationId }); }
      catch (error) { ctx.logger.warn(`[AutomationScheduler] failed to emit automations_changed (action=${action}, automation=${automationId}): ${errorMessage(error)}`); }
    };
    const onceFinalizeLogHooks = () => ({
      info: (message: string) => ctx.logger.info(message),
      warn: (message: string) => ctx.logger.warn(message),
    });
    const onceFinalizeHooks = () => ({
      ...onceFinalizeLogHooks(),
      emitChanged: (action: string, automationId: string) => emitChanged(action, automationId),
    });
    const resolveHeadlessRunner = (): HeadlessRunner | null => {
      // L04 把 headless.rs 的入口发布到 chatSession；L03 若把执行入口放在
      // chatPipeline 上同样可消费。运行期探测，避免插件安装顺序造成假缺失。
      for (const candidate of [ctx.get('chatSession') as unknown, ctx.get('chatPipeline') as unknown]) {
        const runner = asHeadlessRunner(candidate);
        if (runner !== null) return runner;
      }
      return null;
    };
    const systemNotification = (): SystemNotificationPort | undefined => {
      let candidate: unknown;
      try { candidate = ctx.get('systemNotification' as never); }
      catch { return undefined; }
      if (candidate === null || typeof candidate !== 'object') return undefined;
      const service = candidate as Partial<SystemNotificationPort>;
      if (typeof service.policy !== 'function' || typeof service.notificationsDisabled !== 'function'
        || typeof service.notify !== 'function') {
        return undefined;
      }
      return candidate as SystemNotificationPort;
    };
    const backgroundTasks = (): BackgroundTasks | undefined => {
      try { return ctx.get('backgroundTasks') as BackgroundTasks | undefined; }
      catch { return undefined; }
    };
    const notificationDeps = (): NotificationDeps => {
      const notification = systemNotification();
      return {
        db: openDatabase(),
        settings: ctx.settings,
        shell: { request: (op, args) => ctx.shell.request(op, args) },
        ...(notification === undefined ? {} : { notification }),
        logger: { warn: (message) => ctx.logger.warn(message) },
        now: () => Date.now(),
      };
    };
    ctx.commands.register('chat_v2_automation_summary', () => runCommand(() => {
      const summary = automationSummary(openDatabase());
      let backgroundEnabled = true;
      try { backgroundEnabled = ctx.settings.get('chat_v2.automation_background_enabled') !== 'false'; }
      catch { backgroundEnabled = true; }
      return { enabledCount: summary.enabledCount, runningCount: summary.runningCount,
        failedCount: summary.failedCount, nextRunAt: summary.nextRunAt, backgroundEnabled,
        onceCompletedCount: summary.onceCompletedCount, lastFailedRunAt: summary.lastFailedRunAt };
    }));
    ctx.commands.register('chat_v2_automation_list', () => runCommand(() => automationListResponse(openDatabase())));
    ctx.commands.register<Commands['chat_v2_automation_create']['args'], unknown>(
      'chat_v2_automation_create', ({ request }) => runCommand(() => {
        const automation = createAutomation(openDatabase(), createFieldsFromRequest(request,
          request.trustedProfile == null ? null : normalizeTrustedProfile(request.trustedProfile)));
        emitChanged('create', automation.id);
        return { success: true, automation: automationToListItem(automation, Date.now()) };
      }),
    );
    ctx.commands.register<Commands['chat_v2_automation_set_enabled']['args'], unknown>(
      'chat_v2_automation_set_enabled', ({ automationId, expectedVersion, enabled }) => runCommand(() => {
        const { previous, current } = setAutomationEnabled(openDatabase(), automationId, expectedVersion, enabled);
        emitChanged('set_enabled', automationId);
        return { success: true, previous: automationToListItem(previous, Date.now()),
          current: automationToListItem(current, Date.now()) };
      }),
    );
    ctx.commands.register<Commands['chat_v2_automation_update']['args'], unknown>(
      'chat_v2_automation_update', ({ request }) => runCommand(() => {
        const automationId = rustTrim(request.automationId);
        if (automationId === '') throw automationCommandError(AppError.validation('automationId must not be empty'));
        const trustedProfile = Object.hasOwn(request, 'trustedProfile')
          ? { value: request.trustedProfile == null ? null : normalizeTrustedProfile(request.trustedProfile) } : undefined;
        const { previous, current } = updateAutomationFull(openDatabase(), automationId, request.expectedVersion,
          updateFieldsFromRequest(request, trustedProfile));
        emitChanged('update', automationId);
        const response: Record<string, unknown> = {
          success: true, previous: automationToListItem(previous, Date.now()),
          current: automationToListItem(current, Date.now()), next_trigger: current.next_run_at,
        };
        if (onceAutomationCompleted(current)) {
          response.once_completed = true;
          response.once_completed_notice = '该一次性任务的时点已执行完成，本次更新不会使其再次触发；如需再次运行请重新启用或手动运行。';
        }
        return response;
      }),
    );
    ctx.commands.register<Commands['chat_v2_automation_delete']['args'], unknown>(
      'chat_v2_automation_delete', ({ automationId, expectedVersion }) => runCommand(() => {
        const deleted = deleteAutomation(openDatabase(), automationId, expectedVersion);
        emitChanged('delete', automationId);
        return { success: true, automationId, deleted: automationToListItem(deleted, Date.now()), reversible: false };
      }),
    );
    ctx.commands.register<Commands['chat_v2_automation_runs']['args'], unknown>(
      'chat_v2_automation_runs', ({ automationId, limit }) => runCommand(() => {
        const runs = listAutomationRuns(openDatabase(), automationId ?? null, limit ?? 50);
        return { runs, count: runs.length };
      }),
    );
    ctx.commands.register<Commands['chat_v2_automation_cancel_run']['args'], unknown>(
      'chat_v2_automation_cancel_run', ({ runId }) => runCommand(() => {
        cancelAutomationRun(openDatabase(), runId, onceFinalizeLogHooks());
        emitChanged('cancel_run');
        return { success: true, runId };
      }),
    );
    ctx.commands.register<Commands['chat_v2_automation_set_background_enabled']['args'], unknown>(
      'chat_v2_automation_set_background_enabled', ({ enabled }) => {
        try { ctx.settings.save('chat_v2.automation_background_enabled', enabled ? 'true' : 'false'); }
        catch (error) {
          throw automationCommandError(AppError.database(`Failed to persist background flag: ${errorMessage(error)}`));
        }
        emitChanged('background');
        return { success: true, enabled };
      },
    );
    ctx.commands.register<Commands['chat_v2_automation_retry_run']['args'], unknown>(
      'chat_v2_automation_retry_run', ({ runId }) => runCommand(() => {
        retryAutomationRun(openDatabase(), runId);
        emitChanged('retry');
        return { success: true, runId };
      }),
    );
    const scheduler = new AutomationSchedulerState();
    const runtimeDeps = (): AutomationRuntimeDeps => ({
      db: openDatabase(),
      dispatch: createDispatchPort(),
      log: {
        info: (message) => ctx.logger.info(message),
        warn: (message) => ctx.logger.warn(message),
        error: (message) => ctx.logger.error(message),
      },
      now: () => Date.now(),
      scheduler,
    });
    ctx.commands.register<Commands['chat_v2_automation_run_now']['args'], unknown>(
      'chat_v2_automation_run_now', ({ automationId, expectedVersion }) => runCommand(
        () => runAutomationNow(runtimeDeps(), automationId, expectedVersion)),
    );

    function createDispatchPort(): AutomationDispatchPort {
      return {
        ensureKillSwitchAllowed() {
          const state = ctx.get('chatState') as ChatV2State | undefined;
          // L04 kill_switch.rs: fail-closed when the state is unavailable.
          if (state === undefined) {
            throw automationCommandError(AppError.validation(KILL_SWITCH_STATE_UNAVAILABLE_MESSAGE));
          }
          try {
            state.killSwitch.ensureAllowed();
          } catch (error) {
            // Rust `run_automation_now_core` 把该拒绝映射为 validation JSON 字符串；
            // 普通 Error 会被 kernel 当成 handler panic，前端 Promise 永不 settle。
            throw automationCommandError(AppError.validation(errorMessage(error)));
          }
        },
        emitChanged(action, automationId) { emitChanged(action, automationId); },
        notificationLanguage() {
          let raw: string | null = null;
          try { raw = ctx.settings.get('language'); } catch { raw = null; }
          return notificationLanguage(raw);
        },
        async runHeadlessTurn(request) {
          const runner = resolveHeadlessRunner();
          if (runner === null) {
            // 依赖未发布：调度层把该错误落为 spawn_error（不伪装成功）。
            // agentSubagent 的同名能力在没有 runner 时不会发布（见下）。
            throw new Error('Automation agent turn requires the headless pipeline (chatSession.runHeadlessTurn / chatPipeline.runHeadlessTurn), which is not published.');
          }
          return runner.runHeadlessTurn(request);
        },
        async deliverNotify(claimed, nowMs) {
          // notify 路径的 OS 到点提醒由调度器在调用本方法前发送；这里只负责
          // VFS 待办（L11 TodoRepository + 本 lane 的 automation_todo_deliveries）。
          const todoDelivered = deliverAutomationTodo({
            vfs: ctx.storage.database('vfs'),
            todos: ctx.get('vfsRepo')?.todos as AutomationTodoRepository | undefined,
            log: { warn: (message) => ctx.logger.warn(message) },
            emit: (event, payload) => { ctx.backendEvents.emit(event, payload); },
          }, claimed.run_id, claimed.automation.name, claimed.automation.prompt, nowMs);
          if (!todoDelivered) return { delivered: [] };
          try {
            const marked = setRunDeliveryMarker(openDatabase(), claimed.run_id, claimed.attempt,
              'running', 'todo', true);
            return { delivered: marked ? ['todo'] : [] };
          } catch (error) {
            ctx.logger.warn(`[AutomationScheduler] failed to persist todo delivery for '${claimed.run_id}': ${errorMessage(error)}`);
            return { delivered: [] };
          }
        },
        sendRunNotification(request) {
          return deliverRunNotification(notificationDeps(), request);
        },
        deliverPendingNotifications() {
          return deliverPendingAgentNotifications(notificationDeps());
        },
        emitRunCompleted(payload) {
          try {
            ctx.backendEvents.emit('chat_v2_automation_run_completed', payload);
          } catch (error) {
            ctx.logger.warn(`[AutomationScheduler] failed to emit run_completed for run '${payload.runId}': ${errorMessage(error)}`);
          }
        },
        heartbeatIdlePrecheck() {
          return heartbeatHasPendingWork(ctx.storage.database('vfs'), Date.now());
        },
      };
    }

    setInboundLogger((message) => ctx.logger.warn(message));
    setCustomAgentLogger((message, error) => ctx.logger.warn(`${message}: ${errorMessage(error)}`));
    setSessionToolsLogger((message) => ctx.logger.warn(message));
    setAutomationRuntimeLogger({ info: (m) => ctx.logger.info(m), warn: (m) => ctx.logger.warn(m), error: (m) => ctx.logger.error(m) });
    // lib.rs:3251: ExitRequested marks the scheduler exiting first. The kernel broadcasts `host/exiting` at the start of
    // shutdown, before any dispose; the scheduler disposer below repeats it when the event is not available.
    (ctx.on as unknown as (name: string, listener: () => void) => () => boolean)(HOST_EXITING_EVENT, () => {
      scheduler.markAppExiting();
    });
    const startupGate = (): StartupGateReader | undefined => {
      let candidate: unknown;
      try { candidate = ctx.get('startupGate' as never); }
      catch { return undefined; }
      if (candidate === null || typeof candidate !== 'object') return undefined;
      const gate = candidate as Partial<StartupGateReader>;
      if (typeof gate.isStartupReady !== 'function' || typeof gate.waitStartupReady !== 'function') {
        return undefined;
      }
      return candidate as StartupGateReader;
    };
    /**
     * V09 P1-3: register a startup finalizer that survives a reinstall. The withdrawable form (`late: 'run'` +
     * `signal`, W10 `startup-finalizers.ts`) passes through the storage wrapper unchanged. A registry without it rejects
     * a name left by an earlier instance (FINALIZER_DUPLICATE) or a registration after the run started
     * (FINALIZER_LATE_REGISTRATION); the hook then runs once the startup gate is ready, i.e. after every finalizer
     * succeeded. Hooks must be idempotent and return early once `signal` is aborted.
     */
    const registerStartupHook = (name: string, hook: () => void, signal: AbortSignal, label: string): void => {
      const options: StartupFinalizerOptions & { late: 'run'; signal: AbortSignal } = { late: 'run', signal };
      try {
        ctx.storage.registerFinalizer(name, hook, options);
        return;
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (code !== 'FINALIZER_DUPLICATE' && code !== 'FINALIZER_LATE_REGISTRATION') {
          ctx.logger.error(`${label} startup finalizer registration failed: ${errorMessage(error)}`);
          return;
        }
        ctx.logger.info(`${label} startup finalizer "${name}" not registered (${code}); running it after the startup gate`);
      }
      const gate = startupGate();
      if (gate === undefined) {
        ctx.logger.error(`${label} startup gate unavailable; startup finalizer "${name}" not run`);
        return;
      }
      void gate.waitStartupReady(STARTUP_READY_TIMEOUT_MS).then((ready) => {
        if (signal.aborted) return;
        if (!ready) {
          ctx.logger.error(`${label} startup gate was not marked ready; startup finalizer "${name}" not run`);
          return;
        }
        hook();
      }).catch((error: unknown) => {
        ctx.logger.error(`${label} startup finalizer "${name}" failed after the startup gate: ${errorMessage(error)}`);
      });
    };
    ctx.effect(() => {
      // automations.rs:5568–5635：启动时先迁移 legacy、回收孤儿、预置心跳，
      // 完成之后才进入每 15s 的 tick 循环；暂停/退出期间循环仍在但派发为空操作。
      let initialized = false;
      let disposed = false;
      let timer: ReturnType<typeof setInterval> | null = null;
      let ticking = false;

      const initializeScheduler = (): void => {
        if (initialized) return;
        initialized = true;
        let startup: AutomationRuntimeDeps | null = null;
        try {
          startup = runtimeDeps();
        } catch (error) {
          ctx.logger.warn(`[AutomationScheduler] scheduler startup deferred (database unavailable): ${errorMessage(error)}`);
        }
        if (startup === null) return;
        try {
          migrateLegacyAutomations(ctx.settings, startup.db, insertAutomation);
        } catch (error) {
          ctx.logger.warn(`[AutomationScheduler] legacy migration failed: ${errorMessage(error)}`);
        }
        try {
          const recovered = recoverStaleAutomationRuns(startup.db, Date.now(), onceFinalizeHooks());
          if (recovered > 0) ctx.logger.info(`[AutomationScheduler] recovered ${recovered} stale automation runs`);
        } catch (error) {
          ctx.logger.warn(`[AutomationScheduler] stale run recovery failed: ${errorMessage(error)}`);
        }
        try {
          if (ensureHeartbeatAutomation(startup.db)) {
            ctx.logger.info('[AutomationScheduler] provisioned default heartbeat automation (disabled)');
          }
        } catch (error) {
          ctx.logger.warn(`[AutomationScheduler] ensure_heartbeat_automation failed: ${errorMessage(error)}`);
        }
      };

      const runTick = async (): Promise<void> => {
        try {
          await tickAutomations(runtimeDeps());
        } catch (error) {
          ctx.logger.warn(`[AutomationScheduler] tick failed: ${errorMessage(error)}`);
        } finally {
          ticking = false;
        }
      };
      const startTicking = (): void => {
        if (disposed || timer !== null) return;
        timer = setInterval(() => {
          // headless 通知/待办投递是异步的；上一轮未结束时跳过本轮到点检查，
          // 防止同一 run 被并发派发（单飞守卫之外的第二道保险）。
          if (ticking) return;
          ticking = true;
          const background = backgroundTasks();
          if (background === undefined) {
            void runTick();
            return;
          }
          // F4 `backgroundTasks`：进程退出时等待在途 tick（Rust spawn_blocking 的准入）。
          const spawned = background.spawn(runTick);
          if (spawned === null) {
            ctx.logger.warn('[AutomationScheduler] tick rejected: background tasks are shutting down');
            ticking = false;
          }
        }, SCHEDULER_POLL_SECS * 1000);
      };

      // F3 finalizer 只做恢复初始化；tick 等组合根在 runStartupFinalizers 全部
      // 成功并 markStartupReady 后才启动，避免后续 finalizer 失败时仍然抢跑。
      const startAfterStartupReady = (): void => {
        if (disposed) return;
        const gate = startupGate();
        if (gate === undefined) {
          ctx.logger.error('[AutomationScheduler] startup gate unavailable; scheduler tick not started');
          return;
        }
        void gate.waitStartupReady(STARTUP_READY_TIMEOUT_MS).then((ready) => {
          if (disposed) return;
          if (!ready) {
            ctx.logger.error('[AutomationScheduler] startup gate was not marked ready; scheduler tick not started');
            return;
          }
          startTicking();
        }).catch((error: unknown) => {
          ctx.logger.error(`[AutomationScheduler] failed while waiting for startup gate: ${errorMessage(error)}`);
        });
      };

      const runStartupFinalizer = (): void => {
        if (disposed) return;
        initializeScheduler();
        startAfterStartupReady();
      };

      // D2：F3 `registerFinalizer` 由平台排序执行启动恢复；tick 仍要等 startupGate ready，
      // 重装时（finalizer 已跑过或旧实例的同名登记还在）同样在 ready 之后初始化。
      // 移动端没有 `dstu.shell` 的启动门：不登记启动恢复与 15s tick（命令面照常注册，
      // 需要调度器的调用自行报不可用）；退出/卸载标记仍然保留。
      const finalizers = new AbortController();
      if (automationSchedulerEnabled) {
        registerStartupHook('l06.automationSchedulerStartup', runStartupFinalizer, finalizers.signal, '[AutomationScheduler]');
      }

      return () => {
        // V09 P1-5: dispatched runs are cancelled as shutdown and left for startup recovery, like ExitRequested.
        scheduler.markAppExiting();
        finalizers.abort();
        disposed = true;
        if (timer !== null) clearInterval(timer);
      };
    });

    // automations.rs:4779-4792: settings error -> enabled (true); load error -> false.
    const shouldKeepBackground = (): boolean => {
      let backgroundEnabled = true;
      try { backgroundEnabled = ctx.settings.get('chat_v2.automation_background_enabled') !== 'false'; }
      catch { backgroundEnabled = true; }
      if (!backgroundEnabled) return false;
      try { return loadAutomations(openDatabase()).some((automation) => automation.enabled); }
      catch { return false; }
    };
    // lib.rs:1724-1730 / system_notification: an unreadable setting counts as absent.
    const readSettingOrNull = (key: string): string | null => {
      try { return ctx.settings.get(key); }
      catch { return null; }
    };
    ctx.provide('agentAutomation', {
      list: () => automationListResponse(openDatabase()) as unknown as Json,
      create: async (request: AutomationCreateCommandRequest) => automationToListItem(runCommand(() => {
        const automation = createAutomation(openDatabase(), createFieldsFromRequest(request,
          request.trustedProfile == null ? null : normalizeTrustedProfile(request.trustedProfile)));
        emitChanged('create', automation.id);
        return automation;
      }), Date.now()) as unknown as Json,
      update: async (request: AutomationUpdateCommandRequest) => {
        const trustedProfile = Object.hasOwn(request, 'trustedProfile')
          ? { value: request.trustedProfile == null ? null : normalizeTrustedProfile(request.trustedProfile) }
          : undefined;
        const { current } = runCommand(() => updateAutomationFull(openDatabase(), rustTrim(request.automationId),
          request.expectedVersion, updateFieldsFromRequest(request, trustedProfile)));
        emitChanged('update', request.automationId);
        return automationToListItem(current, Date.now()) as unknown as Json;
      },
      setEnabled: async (automationId: string, expectedVersion: number, enabled: boolean) => {
        const { current } = runCommand(() => setAutomationEnabled(openDatabase(), automationId, expectedVersion, enabled));
        emitChanged('set_enabled', automationId);
        return automationToListItem(current, Date.now()) as unknown as Json;
      },
      delete: async (automationId: string, expectedVersion: number) => {
        const deleted = runCommand(() => deleteAutomation(openDatabase(), automationId, expectedVersion));
        emitChanged('delete', automationId);
        return automationToListItem(deleted, Date.now()) as unknown as Json;
      },
      runNow: async (automationId: string, expectedVersion: number) => runCommand(
        () => runAutomationNow(runtimeDeps(), automationId, expectedVersion)) as unknown as Json,
      runs: (automationId: string | null, limit: number | null) =>
        listAutomationRuns(openDatabase(), automationId, limit ?? 50) as unknown as Json,
      retryRun: async (runId: string) => {
        retryAutomationRun(openDatabase(), runId);
        emitChanged('retry');
        return { success: true, runId } as unknown as Json;
      },
      cancelRun: async (runId: string) => {
        cancelAutomationRun(openDatabase(), runId, onceFinalizeLogHooks());
        emitChanged('cancel_run');
        return { success: true, runId } as unknown as Json;
      },
      summary: () => automationSummary(openDatabase()) as unknown as Json,
      setBackgroundEnabled: (enabled: boolean) => {
        ctx.settings.save('chat_v2.automation_background_enabled', enabled ? 'true' : 'false');
        emitChanged('background');
        return { success: true, enabled } as unknown as Json;
      },
      shouldKeepBackground,
      backgroundResidency: (): BackgroundResidencyState => ({
        automation: shouldKeepBackground(),
        superAgent: readEnabled(ctx.settings),
        quickAssistant: readSettingOrNull(QUICK_ASSISTANT_BACKGROUND_KEY) === 'true',
        notificationsDisabled: readSettingOrNull(POLICY_SETTING_KEY) === 'never',
      }),
      pauseScheduler: () => { scheduler.pause(); },
      resumeScheduler: () => { scheduler.resume(); },
      isSchedulerPaused: () => scheduler.isPaused(),
      markAppExiting: () => { scheduler.markAppExiting(); },
      appIsExiting: () => scheduler.isExiting(),
      cancelActiveRunsForEmergencyStop: () => { cancelActiveAutomationRunsForEmergencyStop(); },
    });
    const superInboxDeps = (pipeline: SendMessagePipeline | null) => resolveSuperInboxDeps(ctx, {
      reportWarning: (warning) => {
        // Rust 只记 warn（inbox.rs 没有 warning 事件）。
        ctx.logger.warn(`[SuperSession::inbox] ${warning.code}: ${warning.message}`);
      },
      emitInboxChanged: ({ sessionId, pendingInbox }) => {
        ctx.backendEvents.emit('super_session_inbox_changed', { sessionId, pendingInbox });
      },
      ...(pipeline === null ? {} : { pipeline }),
    });
    const deliverSuperInbox = (
      request: DeliverInboxRequest, pipeline: SendMessagePipeline | null, window: WindowRef,
    ): Promise<DeliverOutcome> => {
      const parsed = parseDeliverInboxRequest(request);
      return deliverInbox(superInboxDeps(pipeline), {
        ...parsed,
        options: {
          modelId: parsed.options.modelId,
          replayMode: request.options?.replayMode ?? null,
          temperature: request.options?.temperature ?? null,
        },
        window,
      });
    };
    // `chat.send@1` 由 chat-pipeline 发布；未发布时不注册投递命令，
    // 避免把固定抛错的空壳命令暴露给前端（ACCEPTANCE O1）。
    ctx.inject([SEND_MESSAGE_PIPELINE_SERVICE], linked => {
      const pipeline = linked.get(SEND_MESSAGE_PIPELINE_SERVICE) as SendMessagePipeline;
      // 注册挂在 linked fiber 上：provider 消失时随注入作用域撤销，
      // 重新发布后可再次注册（不会留下指向旧管线的命令）。
      linked.commands.register<Commands['chat_v2_super_deliver_inbox']['args'], Commands['chat_v2_super_deliver_inbox']['result']>(
        'chat_v2_super_deliver_inbox', async ({ request }, call) => {
          ctx.logger.info(`[SuperSession] chat_v2_super_deliver_inbox: session_id=${request.sessionId}, force=${request.force}`);
          try {
            return await deliverSuperInbox(request, pipeline, call.source) as Commands['chat_v2_super_deliver_inbox']['result'];
          } catch (error) {
            throw new CommandError(error instanceof Error ? error.message : String(error));
          }
        },
      );
    });
    // roster.rs:43/64/65/79: unconditional App-roster entries owned by this lane.
    ctx.inject(['agentTools'], scope => {
      const log = { info: (message: string) => ctx.logger.info(message), warn: (message: string) => ctx.logger.warn(message) };
      const registration = scope.agentTools.registerToolExecutors([
        new AttemptCompletionExecutor(log), new TodoListExecutor(log), new GoalExecutor(log), new AskUserExecutor(log),
        new RolePackExecutor(log.warn), new SelfInspectExecutor(log.warn), new TaskAuditExecutor(log.warn),
        new SessionToolExecutor(log),
        new AutomationExecutor({ database: openDatabase, runtime: runtimeDeps, emitChanged, warn: log.warn }),
      ]);
      scope.effect(() => () => registration.dispose());
    });
    // roster.rs:93–98: Subagent / SuperSession / CustomAgent join only when a WorkspaceCoordinator exists.
    // L07 registration is scoped to both providers; disposal withdraws only this entry.
    ctx.inject(['agentTools', 'agentWorkspace'], scope => {
      const executor = new CustomAgentExecutor(scope.agentWorkspace, (message) => ctx.logger.warn(message));
      const sleep = new CoordinatorSleepExecutor(scope.agentWorkspace,
        { info: (message: string) => ctx.logger.info(message), warn: (message: string) => ctx.logger.warn(message) });
      const log = { info: (message: string) => ctx.logger.info(message), warn: (message: string) => ctx.logger.warn(message),
        debug: (message: string) => ctx.logger.debug(message) };
      const workerRuntime = () => ctx.get('chatWorkerRuntime');
      const subagent = new SubagentExecutor({ coordinator: scope.agentWorkspace, workerRuntime,
        chatSession: () => ctx.get('chatSession'), log });
      scope.commands.register<Commands['chat_v2_background_subagent']['args'], boolean>(
        'chat_v2_background_subagent', ({ sessionId, blockId }) => subagent.background(sessionId, blockId));
      const superSession = new SuperSessionExecutor({ coordinator: scope.agentWorkspace, subagent,
        superDeps: () => superSessionDeps(), workerRuntime, log });
      const registration = scope.agentTools.registerToolExecutors([subagent, superSession, executor, sleep]);
      scope.effect(() => () => registration.dispose());
    });
    const superSessionDeps = (): SuperSessionDeps => {
      const chat = ctx.get('chatSession') as SuperSessionDeps['chat'] | undefined;
      if (chat === undefined) throw new Error('ChatV2Database 未初始化');
      const workspace = ctx.get('agentWorkspace') as SuperSessionDeps['workspace'] | undefined;
      if (workspace === undefined) throw new Error('WorkspaceCoordinator 未初始化');
      let chatDb;
      try { chatDb = ctx.storage.database('chat_v2'); }
      catch (error) { throw new Error(`ChatV2Database 未初始化: ${errorMessage(error)}`); }
      return {
        chat,
        lookup: createSuperSessionLookup(chatDb),
        workspace,
        streams: (ctx.get('chatState') as SuperSessionDeps['streams'] | undefined) ?? null,
        settings: ctx.settings,
        events: {
          changed: (payload) => {
            try { ctx.backendEvents.emit('super_session_changed', payload); }
            catch (error) { ctx.logger.warn(`[SuperSession] emit super_session_changed failed: ${errorMessage(error)}`); }
          },
          inboxChanged: (payload) => {
            try { ctx.backendEvents.emit('super_session_inbox_changed', payload); }
            catch (error) { ctx.logger.warn(`[SuperSession] emit super_session_inbox_changed failed: ${errorMessage(error)}`); }
          },
        },
        logger: { info: (message) => ctx.logger.info(message), warn: (message) => ctx.logger.warn(message) },
        ensureRuntimeRoots: (sessionId) => {
          // Rust `chat_v2/runtime_roots.rs:805–809` `ensure_session_runtime_roots`：
          // 先 artifact_root(create=true)，再 temp_root(create=true)；任一失败由 ensure() 统一告警。
          agentOrchestrationWorkspaceRuntime().sessionRoot(ctx.app.dataDir, sessionId, 'artifact', true);
          agentOrchestrationWorkspaceRuntime().sessionRoot(ctx.app.dataDir, sessionId, 'temp', true);
        },
      };
    };
    const runSuperCommand = <T>(operation: () => T): T => {
      try { return operation(); }
      catch (error) { throw new CommandError(error instanceof Error ? error.message : String(error)); }
    };
    const ensureSuperState = (): ReturnType<typeof superSessionEnsure> => {
      // commands.rs:33–39: 未启用时直接返回 disabled，不读取 chat/workspace 依赖。
      if (!readEnabled(ctx.settings)) return superSessionDisabledState();
      const deps = superSessionDeps();
      const state = superSessionEnsure(deps);
      emitSuperSessionChanged(deps, true, state.sessionId);
      return state;
    };
    const getSuperState = (): ReturnType<typeof superSessionGetState> => {
      // commands.rs:18–19: disabled 时 get_state 同样不触碰依赖；启用时 ensure
      // 失败由 state.rs 记录 warn 并返回 enabled=true 的兜底快照。
      if (!readEnabled(ctx.settings)) return superSessionDisabledState();
      try {
        return superSessionGetState(superSessionDeps());
      } catch (error) {
        ctx.logger.warn(`[SuperSession] ensure failed in get_state: ${errorMessage(error)}`);
        return { enabled: true, sessionId: null, workspaceId: null, pendingInbox: 0 };
      }
    };
    ctx.commands.register('super_session_get_settings', () => runSuperCommand(() => readSettings(ctx.settings)));
    ctx.commands.register<Commands['super_session_ensure']['args'], Commands['super_session_ensure']['result']>(
      'super_session_ensure', () => runSuperCommand(ensureSuperState),
    );
    ctx.commands.register<Commands['super_session_get_state']['args'], Commands['super_session_get_state']['result']>(
      'super_session_get_state', getSuperState,
    );
    ctx.commands.register<Commands['super_session_set_enabled']['args'], Commands['super_session_set_enabled']['result']>(
      'super_session_set_enabled', ({ enabled }) => runSuperCommand(() => superSessionSetEnabled(superSessionDeps(), enabled)),
    );
    ctx.commands.register<Commands['super_session_set_settings']['args'], null>(
      'super_session_set_settings', ({ settings }) => {
        try {
          writeSettings(ctx.settings, { instructions: settings.instructions ?? '' });
          return null;
        } catch (error) {
          throw new CommandError(error instanceof Error ? error.message : String(error));
        }
      },
    );

    // state.rs:1025-1062 `super_session::init`（lib.rs:1713，数据库就绪后）：旧 superagent.db
    // 开关迁移，启用时 ensure()；不发事件、不启动后台循环，错误只记日志。
    const superSessionFinalizer = new AbortController();
    ctx.effect(() => () => superSessionFinalizer.abort());
    const superSessionStartup = (): void => {
      if (superSessionFinalizer.signal.aborted) return;
      const legacy = join(ctx.app.dataDir, 'superagent', 'superagent.db');
      if (localNodeRuntime().exists(legacy)) {
        try {
          const flag = migrateLegacyDb(ctx.storage, legacy, ctx.settings, (message) => ctx.logger.warn(message));
          ctx.logger.info(`[SuperSession] Migrated legacy superagent.db (enabled=${flag === null ? 'None' : `Some(${flag})`})`);
        } catch (error) {
          ctx.logger.warn(`[SuperSession] Legacy superagent.db migration failed: ${errorMessage(error)}`);
        }
      }
      if (!readEnabled(ctx.settings)) {
        ctx.logger.info('[SuperSession] initialized (disabled)');
        return;
      }
      try {
        const state = superSessionEnsure(superSessionDeps());
        ctx.logger.info(`[SuperSession] initialized: session=${rustOptionDebug(state.sessionId)}, `
          + `workspace=${rustOptionDebug(state.workspaceId)}, pending=${state.pendingInbox}`);
      } catch (error) {
        ctx.logger.warn(`[SuperSession] ensure on init failed: ${errorMessage(error)}`);
      }
    };
    registerStartupHook('l06.superSessionStartup', superSessionStartup, superSessionFinalizer.signal, '[SuperSession]');

    const subagentService: AgentSubagentService = {
      getState: () => getSuperState(),
      setEnabled: (enabled: boolean) => superSessionSetEnabled(superSessionDeps(), enabled),
      ensure: () => ensureSuperState(),
      getSettings: () => readSettings(ctx.settings),
      setSettings: (settings) => { writeSettings(ctx.settings, { instructions: settings.instructions ?? '' }); },
      isEnabled: () => readEnabled(ctx.settings),
      onSessionRemoved: (sessionId: string, hard: boolean) => {
        superSessionOnSessionRemoved(superSessionDeps(), sessionId, hard);
      },
      cancelWorkersDispatchedIn: (sessionId: string, messageIds: string[]) => {
        superSessionCancelWorkersDispatchedIn(superSessionDeps(), sessionId, messageIds);
      },
      // 依赖服务就绪时能力才可见；缺失时为 undefined（不发布固定抛错的占位）。
      get deliverInbox() {
        const pipeline = ctx.get(SEND_MESSAGE_PIPELINE_SERVICE) as SendMessagePipeline | undefined;
        if (pipeline === undefined) return undefined;
        return (request: DeliverInboxRequest, window: WindowRef) => deliverSuperInbox(request, pipeline, window);
      },
      get runHeadlessTurn() {
        const runner = resolveHeadlessRunner();
        if (runner === null) return undefined;
        return (request: HeadlessTurnRequest) => runner.runHeadlessTurn(request);
      },
      get runHeadlessAgentTurn() {
        const runner = resolveHeadlessRunner();
        if (runner === null) return undefined;
        return (request: HeadlessSessionTurn) => runner.runHeadlessAgentTurn(request);
      },
    };
    ctx.provide('agentSubagent', subagentService);
  },
});
}
