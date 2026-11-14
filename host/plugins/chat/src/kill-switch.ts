/**
 * Agent kill switch commands. Rust source: `chat_v2/kill_switch.rs:193-295`.
 *
 * The automation scheduler lives in L06 (`agentAutomation`); this module
 * only asks it for its pause state and never keeps a duplicate flag.
 */
import { CommandError } from '../../../kernel/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import type { KillSwitchStatus } from '../api.ts';
import type { ChatV2State } from './state.ts';
import { KILL_SWITCH_CHANGED_EVENT } from './state.ts';
import { errorText, type ChatLogger } from './logger.ts';
import { HookSet } from '../../../kernel/api.ts';
import type { ApprovalManager } from '../../agent-workspace/api.ts';
import type { SystemNotificationService } from '../../../../electron/api.ts';
import { markAllWorkersCancelled, type WorkspaceRuntimeCoordinator } from './workspace-runtime.ts';

export interface EmergencyCancelHook { cancelForEmergencyStop(reason: string): number }
export class EmergencyCancelHooks extends HookSet<EmergencyCancelHook> {
  run(reason: string): number { return this.snapshot().reduce((count, hook) => count + hook.cancelForEmergencyStop(reason), 0); }
}

export interface EmergencyStopDeps {
  state: ChatV2State;
  automation: AutomationSchedulerLike | undefined;
  hooks: EmergencyCancelHooks;
  approvals: ApprovalManager | undefined;
  workspace: WorkspaceRuntimeCoordinator | undefined;
  notification: SystemNotificationService | undefined;
  emit(status: KillSwitchStatus): void;
  log: ChatLogger;
}

export async function emergencyStopCommand(deps: EmergencyStopDeps, rawReason: string | null | undefined): Promise<KillSwitchStatus> {
  const reason = rustTrim(rawReason ?? '') || 'user_emergency_stop';
  const newlyTripped = !deps.state.killSwitch.isTripped();
  const initial = emergencyStop(deps.state, deps.automation, reason);
  const cancelledPipelines = deps.hooks.run(reason);
  const rejectedApprovals = deps.approvals?.rejectAllPending(reason) ?? 0;
  const cancelledWorkers = deps.workspace === undefined ? 0 : markAllWorkersCancelled(deps.workspace, deps.state, reason, deps.log);
  if (newlyTripped) {
    if (deps.notification?.notificationsDisabled()) {
      deps.log.info('[ChatV2::kill_switch] system notifications disabled by policy; skipped emergency notification');
    } else {
      try {
        if (deps.notification === undefined) throw new Error('systemNotification service is unavailable');
        const result = await deps.notification.notify({ title: 'Agent emergency stop',
          body: `All agent streams cancelled. Automations paused. Reason: ${reason}` });
        if (result.error !== null) deps.log.warn('[ChatV2::kill_switch] Failed to show emergency notification: ' + result.error);
      } catch (error) {
        deps.log.warn('[ChatV2::kill_switch] Failed to show emergency notification: ' + errorText(error));
      }
    }
  }
  const status = killSwitchStatus(deps.state, deps.automation);
  if (initial.cancelledStreams !== undefined) status.cancelledStreams = initial.cancelledStreams;
  deps.emit(status);
  deps.log.warn(`[ChatV2::kill_switch] emergency_stop: newly_tripped=${newlyTripped}, cancelled_streams=${initial.cancelledStreams ?? 0}, rejected_approvals=${rejectedApprovals}, cancelled_workers=${cancelledWorkers}, cancelled_chatanki_pipelines=${cancelledPipelines}, reason=${reason}`);
  return status;
}

/** The subset of L06 `AgentAutomationService` the kill switch drives. */
export interface AutomationSchedulerLike {
  isSchedulerPaused(): boolean;
  pauseScheduler(): void;
  resumeScheduler(): void;
  cancelActiveRunsForEmergencyStop(): void;
}

export type AutomationLookup = () => AutomationSchedulerLike | undefined;

function schedulerPaused(automation: AutomationSchedulerLike | undefined): boolean {
  return automation === undefined ? false : automation.isSchedulerPaused();
}

/** `KillSwitchStatus::status_snapshot` (kill_switch.rs:110-121). */
export function killSwitchStatus(
  state: ChatV2State, automation: AutomationSchedulerLike | undefined,
): KillSwitchStatus {
  return state.killSwitch.statusSnapshot(schedulerPaused(automation));
}

/**
 * `chat_v2_emergency_stop` (kill_switch.rs:193-252).
 *
 * Immediate state/scheduler portion; emergencyStopCommand runs the remaining
 * hooks, approval drain, worker bookkeeping, notification and event in order.
 */
export function emergencyStop(
  state: ChatV2State, automation: AutomationSchedulerLike | undefined, reason: string | null | undefined,
): KillSwitchStatus {
  const trimmed = rustTrim(reason ?? '');
  const effectiveReason = trimmed === '' ? 'user_emergency_stop' : trimmed;

  state.killSwitch.trip(effectiveReason);
  automation?.pauseScheduler();
  const cancelledStreams = state.cancelAllStreams();
  automation?.cancelActiveRunsForEmergencyStop();

  const status = killSwitchStatus(state, automation);
  if (cancelledStreams > 0) status.cancelledStreams = cancelledStreams;
  return status;
}

/** `chat_v2_resume_agents` (kill_switch.rs:254-269): automations stay paused. */
export function resumeAgents(
  state: ChatV2State, automation: AutomationSchedulerLike | undefined,
): KillSwitchStatus {
  state.killSwitch.reset();
  return killSwitchStatus(state, automation);
}

/** `chat_v2_resume_automations` (kill_switch.rs:271-289). */
export function resumeAutomations(
  state: ChatV2State, automation: AutomationSchedulerLike | undefined,
): KillSwitchStatus {
  if (state.killSwitch.isTripped()) {
    // Raw string error, not a ChatV2Error JSON envelope.
    throw new CommandError(
      'Cannot resume automations while AgentKillSwitch is still tripped. Call chat_v2_resume_agents first.');
  }
  automation?.resumeScheduler();
  return killSwitchStatus(state, automation);
}

/** `emit_kill_switch_changed` (kill_switch.rs:152-160): failures only warn. */
export function emitKillSwitchChanged(
  emit: (event: string, payload: KillSwitchStatus) => void, status: KillSwitchStatus, log?: ChatLogger,
): void {
  try {
    emit(KILL_SWITCH_CHANGED_EVENT, status);
  } catch (error) {
    log?.warn(`[ChatV2::kill_switch] Failed to emit ${KILL_SWITCH_CHANGED_EVENT}: ` + errorText(error));
  }
}
