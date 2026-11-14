/** goal/runtime.rs:69-441. The goal owner drives continuation, not the automation lane. */
import type { WindowRef } from '../../../kernel/api.ts';
import type { BackgroundTasks } from '../../../platform/diagnostics/api.ts';
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import type { ChatV2Database, GoalRecord } from '../api.ts';
import { claimContinuation, getRuntimeGoal, getGoal, updateStatus } from '../repository/goals.ts';
import { continuationSteering } from './goal-steering.ts';
import { ChatV2Error } from './error.ts';
import { buildGoalUpdatedPayload, type BackendEventsLike } from './events.ts';
import { errorText, type ChatLogger } from './logger.ts';
import { generateMessageId } from './message-values.ts';
import { runSendMessagePipeline, type SendGoalRuntime, type SendPipelinePort, type BackendSendRequest } from './send-message.ts';
import type { ChatV2State } from './state.ts';

export interface GoalRuntimeDeps {
  state: ChatV2State;
  background: BackgroundTasks;
  pipeline(): SendPipelinePort | undefined;
  resolveWindow(): WindowRef | null | Promise<WindowRef | null>;
  events: BackendEventsLike;
  escapeObjective(text: string): string;
}

export class GoalRuntime implements SendGoalRuntime {
  private readonly database: ChatV2Database;
  private readonly log: ChatLogger;
  private readonly deps: GoalRuntimeDeps;
  private readonly inFlight = new Set<string>();
  constructor(database: ChatV2Database, log: ChatLogger, deps: GoalRuntimeDeps) {
    this.database = database; this.log = log; this.deps = deps;
  }

  spawnContinuation(_window: WindowRef, sessionId: string): void {
    this.deps.background.spawn(() => this.runContinuationLoop(sessionId));
  }

  cancelInFlight(sessionId: string): boolean {
    return this.inFlight.has(sessionId) && this.deps.state.cancelStream(sessionId);
  }

  settleActive(_window: WindowRef, sessionId: string, status: 'paused' | 'blocked'): void {
    let conn: DatabaseHandle;
    try { conn = this.database.getConn(); }
    catch (error) {
      this.log.warn(`[ChatV2::goal] settle_active_goal_on_turn_end: get_conn failed (session=${sessionId}): ${errorText(error)}`);
      return;
    }
    let goal: GoalRecord | null;
    try { goal = getGoal(conn, sessionId); }
    catch (error) {
      this.log.warn(`[ChatV2::goal] settle_active_goal_on_turn_end: load goal failed (session=${sessionId}): ${errorText(error)}`);
      return;
    }
    if (goal?.status === 'active') this.updateStatusAndEmit(conn, sessionId, goal.goalId, status);
  }

  private updateStatusAndEmit(conn: SqlExecutor, sessionId: string, expected: string, status: string): void {
    let updated: GoalRecord | null;
    try { updated = updateStatus(conn, sessionId, expected, status); }
    catch (error) {
      this.log.warn(`[ChatV2::goal] status update failed: session=${sessionId}, goal=${expected}, new_status=${status}, error=${errorText(error)}`);
      return;
    }
    if (updated === null) {
      this.log.debug(`[ChatV2::goal] status update skipped (goal changed concurrently): session=${sessionId}, expected_goal=${expected}, new_status=${status}`);
      return;
    }
    try { this.deps.events.emit(`chat_v2_session_${sessionId}`, buildGoalUpdatedPayload(sessionId, updated)); }
    catch (error) { this.log.warn(`[ChatV2::goal] Failed to emit goal_updated event: session=${sessionId}, error=${errorText(error)}`); }
  }

  /** runtime.rs:220/241/375/388 silently stop if the follow-up connection is unavailable. */
  private finishStatus(sessionId: string, expected: string, status: string): void {
    let conn: DatabaseHandle;
    try { conn = this.database.getConn(); } catch { return; }
    this.updateStatusAndEmit(conn, sessionId, expected, status);
  }

  private async runContinuationLoop(sessionId: string): Promise<void> {
    for (;;) {
      await new Promise<void>(resolve => setTimeout(resolve, 150));
      const pipeline = this.deps.pipeline();
      if (pipeline === undefined) {
        this.log.debug(`[ChatV2::goal] ChatV2Pipeline unavailable; stop continuation: session=${sessionId}`);
        return;
      }
      const window = await this.deps.resolveWindow();
      if (window === null) {
        this.log.warn(`[ChatV2::goal] no window available; stop continuation: session=${sessionId}`);
        return;
      }
      let conn: DatabaseHandle;
      try { conn = this.database.getConn(); }
      catch (error) {
        this.log.warn(`[ChatV2::goal] get_conn failed; stop continuation: session=${sessionId}, error=${errorText(error)}`);
        return;
      }
      let goal;
      try { goal = getRuntimeGoal(conn, sessionId); }
      catch (error) {
        this.log.warn(`[ChatV2::goal] load goal failed; stop continuation: session=${sessionId}, error=${errorText(error)}`);
        return;
      }
      if (goal === null) {
        this.log.debug(`[ChatV2::goal] no goal; stop continuation: session=${sessionId}`);
        return;
      }
      if (goal.status !== 'active') {
        this.log.debug(`[ChatV2::goal] goal not active (status=${goal.status}); stop continuation: session=${sessionId}`);
        return;
      }
      if (goal.continuationCount >= 20n) {
        this.log.warn(`[ChatV2::goal] continuation count exhausted (count=${goal.continuationCount}); goal → budget_limited: session=${sessionId}`);
        this.finishStatus(sessionId, goal.goalId, 'budget_limited');
        return;
      }
      if (goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) {
        this.log.warn(`[ChatV2::goal] token budget exhausted (used=${goal.tokensUsed} >= budget=${goal.tokenBudget}); goal → budget_limited: session=${sessionId}`);
        this.finishStatus(sessionId, goal.goalId, 'budget_limited');
        return;
      }
      const request: BackendSendRequest = { sessionId,
        content: continuationSteering(goal, this.deps.escapeObjective),
        options: { skipUserMessageSave: true, schemaToolIds: ['goal_create', 'goal_update', 'goal_get'] },
        userMessageId: null, assistantMessageId: generateMessageId(), userContextRefs: null, pathMap: null, workspaceId: null };
      const registration = this.deps.state.tryRegisterStreamOwned(sessionId);
      if (registration === null) {
        this.log.debug(`[ChatV2::goal] session busy or kill switch tripped; skip continuation: session=${sessionId}`);
        return;
      }
      this.inFlight.add(sessionId);
      const releaseClaim = () => {
        this.inFlight.delete(sessionId);
        this.deps.state.removeStreamIfGeneration(sessionId, registration.generation);
      };
      try { conn = this.database.getConn(); }
      catch (error) {
        this.log.warn(`[ChatV2::goal] get_conn for continuation claim failed (session=${sessionId}): ${errorText(error)}`);
        releaseClaim(); return;
      }
      let claimed: boolean;
      try { claimed = claimContinuation(conn, sessionId, goal.goalId, 20); }
      catch (error) {
        this.log.warn(`[ChatV2::goal] continuation claim failed (session=${sessionId}, goal=${goal.goalId}): ${errorText(error)}; aborting turn`);
        releaseClaim(); return;
      }
      if (!claimed) {
        this.log.debug(`[ChatV2::goal] continuation claim lost (goal paused/cleared/replaced or budget exhausted); stop: session=${sessionId}`);
        releaseClaim(); return;
      }
      try {
        await runSendMessagePipeline(pipeline, this.deps.state, window, request, registration.token);
      } catch (error) {
        this.inFlight.delete(sessionId);
        if (error instanceof ChatV2Error && error.kind === 'Cancelled') {
          this.log.debug(`[ChatV2::goal] continuation cancelled; goal → paused: session=${sessionId}`);
          this.finishStatus(sessionId, goal.goalId, 'paused');
        } else {
          this.log.warn(`[ChatV2::goal] continuation turn failed; goal → blocked: session=${sessionId}, error=${errorText(error)}`);
          this.finishStatus(sessionId, goal.goalId, 'blocked');
        }
        return;
      }
      this.inFlight.delete(sessionId);
      this.log.debug(`[ChatV2::goal] continuation turn completed: session=${sessionId}`);
    }
  }
}
