/**
 * `SubagentExecutor` (subagent_executor.rs:167–1077): `subagent_call` creates (or resumes) a worker in a
 * workspace, dispatches it through the L04 `chatWorkerRuntime` service and, with `wait`, polls the
 * subagent task row until a terminal state.
 *
 * Registered through L07 `agentTools` in the workspace-coordinator roster group (roster.rs:93).
 */
import type {
  ChatExecutionContext, ChatSession, ChatSessionService, ChatWorkerRuntimeService, ToolCall, ToolResultInfo,
  ToolSensitivity,
} from '../../chat/api.ts';
import {
  AgentProfileResolver, MAX_SUBAGENT_DEPTH, SUBAGENT_WAIT_BUDGET_SECS, WORKSPACE_WORKER_READY_EVENT,
  newSubagentTask, validatePersonaModelConfig,
} from '../../agent-workspace/portable.ts';
import type {
  AgentProfile, JsonValue, SubagentTaskData, WorkspaceCoordinator,
} from '../../agent-workspace/api.ts';
import { agentOrchestrationWorkspaceRuntime } from './workspace-runtime.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import type { Json } from '../api.ts';
import {
  buildProfileSkillSnapshot, buildTaskContent, canHandleSubagentTool, deriveWorkspaceName, isOwnAgentCompletion,
  parseSubagentArgs, type SubagentCallArgs,
} from './subagent-args.ts';

export const SUBAGENT_EXECUTOR_NAME = 'SubagentExecutor';
const SUBAGENT_POLL_INTERVAL_MS = 500;
const RESULT_SUMMARY_BUDGET_CHARS = 4000;
const AGENT_SETTLE_GRACE_MS = 3_000;

type JsonObject = { [key: string]: JsonValue };

export interface SubagentExecutorDeps {
  coordinator: WorkspaceCoordinator;
  /** L04 `chatWorkerRuntime`: ChatV2State / ChatV2Pipeline / ChatV2Database seams of dispatch_agent_run. */
  workerRuntime(): ChatWorkerRuntimeService | undefined;
  /** L04 `chatSession`: session reads, rollback and per-run usage. */
  chatSession(): Pick<ChatSessionService, 'getSession' | 'deleteSessionV2' | 'getMessage'> | undefined;
  log: { info(message: string): void; warn(message: string): void; debug?(message: string): void };
  /** Test seam for the wait loop; production uses the Rust constants. */
  timing?: { pollIntervalMs: number; waitBudgetMs: number; settleGraceMs: number };
  now?(): number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** `ulid::Ulid::new()`: 48-bit millisecond time + 80 random bits, Crockford Base32. */
function ulid(time = Date.now()): string {
  let out = '';
  for (let rest = time, index = 0; index < 10; index++) { out = CROCKFORD[rest % 32] + out; rest = Math.floor(rest / 32); }
  const random = crypto.getRandomValues(new Uint8Array(16));
  for (const byte of random) out += CROCKFORD[byte % 32];
  return out;
}

function sleep(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

function raceCancellation<T>(work: Promise<T>, signal: AbortSignal | null): Promise<{ value: T } | 'cancelled'> {
  if (signal === null) return work.then(value => ({ value }));
  if (signal.aborted) { work.catch(() => undefined); return Promise.resolve('cancelled'); }
  return new Promise((resolve, reject) => {
    const onAbort = () => { work.catch(() => undefined); resolve('cancelled'); };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(value => { signal.removeEventListener('abort', onAbort); resolve({ value }); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}

interface DispatchedRun { messageId: string; status: string; runtime: ChatWorkerRuntimeService }
interface SubagentWaitRun {
  workspaceId: string; agentSessionId: string; taskId: string; runId: string; taskMessageId: string;
  autoCreatedWorkspace: boolean; profileId: string; skillId: string | null; runtime: ChatWorkerRuntimeService;
  resumed: boolean; watchAgentSettle: boolean;
}

export class SubagentExecutor {
  private readonly deps: SubagentExecutorDeps;
  private readonly activeWaits = new Map<string, { sessionId: string; background: AbortController }>();
  constructor(deps: SubagentExecutorDeps) { this.deps = deps; }

  name(): string { return SUBAGENT_EXECUTOR_NAME; }
  canHandle(toolName: string): boolean { return canHandleSubagentTool(toolName); }
  sensitivityLevel(_toolName: string): ToolSensitivity { return 'medium'; }
  /** The wait loop must stop the child pipeline itself on parent cancellation (subagent_executor.rs:1067). */
  managesCancellation(_toolName: string): boolean { return true; }

  /** Releases only this parent's tool wait. The dispatched child run is not cancelled or restarted. */
  background(sessionId: string, blockId: string): boolean {
    const wait = this.activeWaits.get(blockId);
    if (wait === undefined || wait.sessionId !== sessionId) return false;
    wait.background.abort();
    return true;
  }

  private get coordinator(): WorkspaceCoordinator { return this.deps.coordinator; }
  private timing() {
    return this.deps.timing ?? { pollIntervalMs: SUBAGENT_POLL_INTERVAL_MS, waitBudgetMs: SUBAGENT_WAIT_BUDGET_SECS * 1000,
      settleGraceMs: AGENT_SETTLE_GRACE_MS };
  }
  private now(): number { return this.deps.now?.() ?? Date.now(); }

  /** `get_subagent_depth`: fail-closed when the chat database is unavailable. */
  private subagentDepth(ctx: ChatExecutionContext): number {
    const store = ctx.chat_v2_db === null ? null : this.deps.workerRuntime()?.sessionStore ?? null;
    if (store === null) throw new Error('chat_v2_db not available for subagent depth check');
    let metadata: JsonValue | null;
    try { metadata = store.sessionMetadata(ctx.session_id); }
    catch (error) { throw new Error(`Failed to query session for depth: ${message(error)}`); }
    const depth = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata.subagent_depth : undefined;
    return typeof depth === 'number' && Number.isInteger(depth) && depth >= 0 ? depth : 0;
  }

  /** Contract C5: best-effort stop of the child pipeline after parent cancellation. */
  private async cancelSubagentRun(runtime: ChatWorkerRuntimeService, workspaceId: string, agentSessionId: string): Promise<void> {
    try { await runtime.cancelWorkspaceAgentBackend(workspaceId, agentSessionId); }
    catch (error) {
      this.deps.log.warn(`[SubagentExecutor] Failed to cancel subagent ${agentSessionId} after parent cancellation: ${message(error)}`);
    }
  }

  private rollbackSubagentSession(ctx: ChatExecutionContext, agentSessionId: string): void {
    const chat = this.deps.chatSession();
    if (ctx.chat_v2_db === null || chat === undefined) return;
    try { chat.deleteSessionV2(agentSessionId); }
    catch (error) { this.deps.log.warn(`[SubagentExecutor] Failed to roll back subagent session ${agentSessionId}: ${message(error)}`); }
  }

  /** `dispatch_agent_run`: honours the cancellation token while the dispatch waits on the worker semaphore. */
  private async dispatchAgentRun(ctx: ChatExecutionContext, workspaceId: string, agentSessionId: string): Promise<DispatchedRun> {
    const window = ctx.windowRef();
    const runtime = this.deps.workerRuntime();
    if (runtime === undefined) throw new Error('ChatV2State not available for subagent runtime');
    if (!runtime.isRunAvailable()) throw new Error('ChatV2Pipeline not available for subagent runtime');
    const outcome = await raceCancellation(runtime.runWorkspaceAgentBackend({ workspace_id: workspaceId,
      agent_session_id: agentSessionId, requester_session_id: ctx.session_id, reminder: null }, window), ctx.cancellation_token);
    if (outcome === 'cancelled') {
      await this.cancelSubagentRun(runtime, workspaceId, agentSessionId);
      throw new Error('Subagent call cancelled');
    }
    return { messageId: outcome.value.message_id, status: outcome.value.status, runtime };
  }

  private emitDispatched(ctx: ChatExecutionContext, line: JsonObject): void {
    ctx.emitter.emitChunk('tool_call', ctx.block_id, `${JSON.stringify(line)}\n`, null);
  }

  /** Contract C7: follow-up on an existing worker; no depth check, registration or profile write. */
  private async executeResumeCall(args: SubagentCallArgs, resumeId: string, ctx: ChatExecutionContext): Promise<JsonValue> {
    const workspaceId = args.workspaceId;
    if (workspaceId === null) {
      throw new Error('resume_agent_session_id requires workspace_id (it is included in the original subagent_call return value)');
    }
    if (this.coordinator.getWorkspace(workspaceId) === null) throw new Error(`Workspace not found: ${workspaceId}`);
    const agent = this.coordinator.getAgent(workspaceId, resumeId);
    if (agent === null) throw new Error(`Agent ${resumeId} not found in workspace ${workspaceId}; it may have been unregistered`);
    if (agent.role !== 'worker') throw new Error(`Agent ${resumeId} is not a worker and cannot be resumed`);
    const chat = ctx.chat_v2_db === null ? undefined : this.deps.chatSession();
    if (chat === undefined) throw new Error('chat_v2_db not available for resuming subagent');
    let session: ChatSession | null;
    try { session = chat.getSession(resumeId); }
    catch (error) { throw new Error(`Failed to query subagent session: ${message(error)}`); }
    if (session === null) throw new Error(`Chat session not found for agent ${resumeId}; the subagent conversation was deleted`);

    let profileId = 'worker';
    try { profileId = AgentProfileResolver.resolveForAgent(agent).id; }
    catch { profileId = 'worker'; }

    const taskManager = this.coordinator.getTaskManager(workspaceId);
    const task = newSubagentTask(workspaceId, resumeId, agent.skillId, args.task);
    try { taskManager.createTask(task); }
    catch (error) { throw new Error(`Failed to persist resume task: ${message(error)}`); }
    const sent = this.coordinator.sendMessage(workspaceId, ctx.session_id, resumeId, 'task', buildTaskContent(args));
    const run = await this.dispatchAgentRun(ctx, workspaceId, resumeId);
    const idempotent = run.messageId === '';
    this.deps.log.info(`[SubagentExecutor] Resumed subagent ${resumeId} in workspace ${workspaceId} (task_id=${task.id}, idempotent_dispatch=${idempotent})`);

    if (!args.wait) {
      return { agent_session_id: resumeId, workspace_id: workspaceId, skill_id: args.skillId, task_message_id: sent.id,
        run_id: run.messageId, status: run.status, auto_created_workspace: false, profile_id: profileId, resumed: true,
        message: 'Follow-up task was delivered to the existing subagent (wait=false; not waiting for completion).' };
    }
    return this.waitForCompletion(ctx, { workspaceId, agentSessionId: resumeId, taskId: task.id, runId: run.messageId,
      taskMessageId: sent.id, autoCreatedWorkspace: false, profileId, skillId: args.skillId, runtime: run.runtime,
      resumed: true, watchAgentSettle: idempotent });
  }

  /** `execute_subagent_call_with_args`: also the Super-session entry (fixed workspace, wait=false, title, metadata). */
  async executeWithArgs(args: SubagentCallArgs, ctx: ChatExecutionContext): Promise<JsonValue> {
    if (ctx.isCancelled()) throw new Error('Subagent call cancelled before start');
    if (args.resumeAgentSessionId !== null) {
      const unsupported = [args.profile !== null && 'profile', args.skillId !== null && 'skill_id', args.model !== null && 'model']
        .filter((field): field is string => field !== false);
      if (unsupported.length > 0) {
        throw new Error(`resume_agent_session_id reuses the persisted agent profile; [${unsupported.join(', ')}] cannot be overridden during resume. Omit these fields or create a new subagent.`);
      }
      return this.executeResumeCall(args, args.resumeAgentSessionId, ctx);
    }

    const depth = this.subagentDepth(ctx);
    if (depth >= MAX_SUBAGENT_DEPTH) {
      throw new Error(`Maximum subagent nesting depth (${MAX_SUBAGENT_DEPTH}) exceeded. Current depth: ${depth}. Recursive subagent creation is not allowed to prevent resource exhaustion.`);
    }

    let workspaceId: string;
    let autoCreated = false;
    if (args.workspaceId !== null) {
      if (this.coordinator.getWorkspace(args.workspaceId) === null) throw new Error(`Workspace not found: ${args.workspaceId}`);
      workspaceId = args.workspaceId;
    } else {
      const workspace = this.coordinator.createWorkspace(ctx.session_id, deriveWorkspaceName(args.task));
      this.coordinator.registerAgent(workspace.id, ctx.session_id, 'coordinator', null, null);
      workspaceId = workspace.id;
      autoCreated = true;
    }

    const customAgentsDir = this.coordinator.customAgentsDir();
    const profile: AgentProfile = AgentProfileResolver.resolveWithCustom({ profileId: args.profile, skillId: args.skillId,
      overrides: { model: args.model } }, customAgentsDir === null ? null
        : agentOrchestrationWorkspaceRuntime().customProfileSource(customAgentsDir));
    const skillContents = buildProfileSkillSnapshot(profile.skills,
      ctx.skill_contents === null ? null : new Map(Object.entries(ctx.skill_contents)));
    if (profile.model !== null) {
      const manager = ctx.llm_manager;
      if (manager === null) {
        throw new Error(`Cannot validate persona model '${profile.model}': model catalog is unavailable. Runtime fallback is disabled for explicit persona models.`);
      }
      let configs;
      try { configs = await manager.getApiConfigs(); }
      catch (error) { throw new Error(`Failed to read model catalog: ${message(error)}`); }
      validatePersonaModelConfig(profile.model, configs);
    }

    const agentSessionId = `subagent_${profile.id}_${ulid()}`;
    const label = args.skillId ?? profile.id;
    const store = ctx.chat_v2_db === null ? null : this.deps.workerRuntime()?.sessionStore ?? null;
    if (store === null) throw new Error('chat_v2_db not available for creating subagent session');
    const systemPrompt = `You are a subagent in workspace ${workspaceId}. Complete the delegated task; the runtime delivers your final answer to the parent agent.`;
    const now = toRfc3339();
    try {
      store.createSession({ id: agentSessionId, mode: 'subagent', title: args.title ?? `Subagent: ${label}`,
        description: `工作区 ${workspaceId.slice(0, 8)} 的子代理`, summary_hash: null, title_locked: true,
        persist_status: 'active', created_at: now, updated_at: now, group_id: null, tags_hash: null, tags: null,
        metadata: { workspace_id: workspaceId, role: 'worker', skill_id: args.skillId, system_prompt: systemPrompt,
          is_subagent: true, parent_session_id: ctx.session_id, subagent_depth: depth + 1,
          profile_skill_contents: Object.fromEntries(skillContents),
          effective_agent_profile: { id: profile.id, model_id: profile.model, reasoning_effort: profile.reasoningEffort,
            skill_ids: [...profile.skills] } } });
    } catch (error) { throw new Error(`Failed to create subagent session: ${message(error)}`); }
    this.deps.log.info(`[SubagentExecutor] Created chat_v2 session for subagent: ${agentSessionId}`);

    let agent;
    try {
      agent = this.coordinator.registerAgent(workspaceId, agentSessionId, 'worker', args.skillId,
        AgentProfileResolver.persistIntoMetadata((args.agentMetadata ?? undefined) as JsonValue | undefined, profile));
    } catch (error) {
      this.rollbackSubagentSession(ctx, agentSessionId);
      throw new Error(`Failed to register subagent: ${message(error)}`);
    }

    const taskManager = this.coordinator.getTaskManager(workspaceId);
    const task = newSubagentTask(workspaceId, agentSessionId, args.skillId, args.task);
    try { taskManager.createTask(task); }
    catch (error) {
      try { this.coordinator.unregisterAgent(workspaceId, agentSessionId); }
      catch (unregisterError) {
        this.deps.log.warn(`[SubagentExecutor] Failed to roll back agent registration for ${agentSessionId}: ${message(unregisterError)}`);
      }
      this.rollbackSubagentSession(ctx, agentSessionId);
      throw new Error(`Failed to persist subagent task: ${message(error)}`);
    }
    this.deps.log.info(`[SubagentExecutor] Persisted subagent task: task_id=${task.id}, agent=${agentSessionId}`);

    const sent = this.coordinator.sendMessage(workspaceId, ctx.session_id, agentSessionId, 'task', buildTaskContent(args));
    const run = await this.dispatchAgentRun(ctx, workspaceId, agentSessionId);
    try {
      ctx.windowRef();
      ctx.services.backendEvents.emit(WORKSPACE_WORKER_READY_EVENT, { workspace_id: workspaceId,
        agent_session_id: agentSessionId, skill_id: args.skillId, runtime_managed: true });
    } catch (error) {
      this.deps.log.warn(`[SubagentExecutor] Failed to emit compatibility worker_ready event: ${message(error)}`);
    }

    if (!args.wait) {
      return { agent_session_id: agent.sessionId, workspace_id: workspaceId, skill_id: args.skillId,
        task_message_id: sent.id, run_id: run.messageId, status: run.status, auto_created_workspace: autoCreated,
        profile_id: profile.id, resumed: false,
        message: 'Subagent was created and dispatched by the backend runtime (wait=false; not waiting for completion).' };
    }
    return this.waitForCompletion(ctx, { workspaceId, agentSessionId, taskId: task.id, runId: run.messageId,
      taskMessageId: sent.id, autoCreatedWorkspace: autoCreated, profileId: profile.id, skillId: args.skillId,
      runtime: run.runtime, resumed: false, watchAgentSettle: false });
  }

  private async waitForCompletion(ctx: ChatExecutionContext, run: SubagentWaitRun): Promise<JsonValue> {
    const wait = { sessionId: ctx.session_id, background: new AbortController() };
    this.activeWaits.set(ctx.block_id, wait);
    try {
      // Register before publishing the action, so a click on the first chunk can release the wait.
      this.emitDispatched(ctx, { phase: 'dispatched', workspace_id: run.workspaceId,
        agent_session_id: run.agentSessionId, run_id: run.runId, status: 'running',
        resumed: run.resumed, can_background: true });
      return await this.pollForCompletion(ctx, run, wait.background.signal);
    } finally {
      this.activeWaits.delete(ctx.block_id);
    }
  }

  /** `wait_for_subagent_completion`: poll the task row; contract C7 settle fallback for idempotent resumes. */
  private async pollForCompletion(ctx: ChatExecutionContext, run: SubagentWaitRun, background: AbortSignal): Promise<JsonValue> {
    const { workspaceId, agentSessionId } = run;
    const timing = this.timing();
    const taskManager = this.coordinator.getTaskManager(workspaceId);
    const deadline = this.now() + timing.waitBudgetMs;
    let settledSince: number | null = null;
    let settledWithoutTerminal = false;
    let terminal: SubagentTaskData | null = null;
    const waitSignal = ctx.cancellation_token === null
      ? background : AbortSignal.any([ctx.cancellation_token, background]);
    for (;;) {
      if (background.aborted) {
        return { workspace_id: workspaceId, agent_session_id: agentSessionId, run_id: run.runId,
          task_message_id: run.taskMessageId, status: 'running', backgrounded: true,
          auto_created_workspace: run.autoCreatedWorkspace, profile_id: run.profileId, skill_id: run.skillId,
          resumed: run.resumed,
          message: 'The user moved this subagent to the background. The same run is still executing; its result will be delivered automatically. Continue other work or finish this turn. Do not call coordinator_sleep or dispatch the same task again just to wait for it.' };
      }
      if (ctx.isCancelled()) {
        await this.cancelSubagentRun(run.runtime, workspaceId, agentSessionId);
        throw new Error('Subagent call cancelled');
      }
      try {
        const task = taskManager.getTask(run.taskId);
        if (task !== null && (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled')) {
          terminal = task;
          break;
        }
      } catch (error) {
        this.deps.log.warn(`[SubagentExecutor] Transient error polling subagent task ${run.taskId}: ${message(error)}`);
      }
      if (run.watchAgentSettle) {
        try {
          const agent = this.coordinator.getAgent(workspaceId, agentSessionId);
          if (agent !== null && ['idle', 'completed', 'failed', 'cancelled', 'closed'].includes(agent.status)) {
            settledSince ??= this.now();
            if (this.now() - settledSince >= timing.settleGraceMs) { settledWithoutTerminal = true; break; }
          } else {
            settledSince = null;
          }
        } catch (error) {
          this.deps.log.warn(`[SubagentExecutor] Transient error polling agent ${agentSessionId} status: ${message(error)}`);
        }
      }
      if (this.now() >= deadline) break;
      await sleep(timing.pollIntervalMs, waitSignal);
    }

    const common = { workspace_id: workspaceId, agent_session_id: agentSessionId, run_id: run.runId,
      task_message_id: run.taskMessageId };
    if (terminal === null) {
      const hint = settledWithoutTerminal
        ? 'Subagent finished its active run without finalizing this follow-up task; the follow-up message may still be pending in its inbox. Call subagent_call again with the same resume_agent_session_id to trigger another run.'
        : 'Subagent is still running; use coordinator_sleep or wait for the automatic completion wakeup.';
      return { ...common, status: 'running', auto_created_workspace: run.autoCreatedWorkspace, profile_id: run.profileId,
        skill_id: run.skillId, resumed: run.resumed, message: hint };
    }

    try {
      for (const queued of this.coordinator.drainInbox(workspaceId, ctx.session_id, 10)) {
        if (isOwnAgentCompletion(queued.content, agentSessionId)) {
          this.deps.log.debug?.(`[SubagentExecutor] Swallowed duplicate completion message ${queued.id} for agent ${agentSessionId}`);
          continue;
        }
        try { this.coordinator.reEnqueueMessage(workspaceId, ctx.session_id, queued.id); }
        catch (error) { this.deps.log.warn(`[SubagentExecutor] Failed to re-enqueue inbox message ${queued.id}: ${message(error)}`); }
      }
    } catch (error) {
      this.deps.log.warn(`[SubagentExecutor] Failed to drain parent inbox for dedup: ${message(error)}`);
    }

    const output = terminal.resultSummary ?? '';
    const result: JsonObject = { ...common, status: terminal.status, output,
      output_truncated: [...output].length >= RESULT_SUMMARY_BUDGET_CHARS, auto_created_workspace: run.autoCreatedWorkspace,
      profile_id: run.profileId, skill_id: run.skillId, resumed: run.resumed,
      token_usage: run.runId === '' || ctx.chat_v2_db === null ? null : this.runUsage(run.runId) };
    if (terminal.status === 'failed') {
      result.error = terminal.resultSummary !== null && terminal.resultSummary !== ''
        ? terminal.resultSummary : 'Subagent failed without an error summary';
    }
    return result;
  }

  /** `worker_message_usage`: message meta usage → active variant → any variant. */
  private runUsage(runId: string): JsonValue {
    let stored;
    try { stored = this.deps.chatSession()?.getMessage(runId) ?? null; }
    catch { return null; }
    if (stored === null) return null;
    if (stored._meta?.usage != null) return stored._meta.usage as unknown as JsonValue;
    const variants = stored.variants;
    if (variants == null) return null;
    const active = stored.activeVariantId ?? null;
    return (variants.find(variant => active !== null && variant.id === active)?.usage
      ?? variants.find(variant => variant.usage != null)?.usage ?? null) as unknown as JsonValue;
  }

  async execute(call: ToolCall, ctx: ChatExecutionContext): Promise<ToolResultInfo> {
    const started = performance.now();
    ctx.emitToolCallStart(call.name, call.arguments, call.id);
    let output: JsonValue;
    try {
      if (ctx.isCancelled()) throw new Error('Subagent call cancelled before start');
      output = await this.executeWithArgs(parseSubagentArgs(call.arguments as Json), ctx);
    } catch (error) {
      const durationMs = Math.trunc(performance.now() - started);
      const text = message(error);
      ctx.emitToolCallError(text);
      const failure: ToolResultInfo = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name,
        input: call.arguments, output: null, success: false, error: text, durationMs };
      try { ctx.saveToolBlock(failure); }
      catch (saveError) { this.deps.log.warn(`[SubagentExecutor] Failed to save tool block: ${message(saveError)}`); }
      return failure;
    }
    const durationMs = Math.trunc(performance.now() - started);
    ctx.emitToolCallEnd({ result: output, durationMs });
    const success: ToolResultInfo = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name,
      input: call.arguments, output, success: true, durationMs };
    try { ctx.saveToolBlock(success); }
    catch (saveError) { this.deps.log.warn(`[SubagentExecutor] Failed to save tool block: ${message(saveError)}`); }
    return success;
  }
}
