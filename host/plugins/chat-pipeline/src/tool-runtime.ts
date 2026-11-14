/** WP-026: composition only. Registry/context, approval policy, authorization and stores retain their owners. */
import type { Context } from '@deepseek-ai/cordis';
import { bindPlanToCall, getGroupWithConn, getSessionWithConn, isPlanActiveForBinding, markPlanApproved,
  newPendingPlan, type ChatSessionService, type PlanAuthorityState, type ToolExecutor,
  type ToolExecutorRegistry } from '../../chat/api.ts';
import {
  GeneralToolExecutor, InMemoryToolSchemaRegistry, MCP_SERVER_PROPOSE, MCP_SERVER_REMOVE, MCP_SERVER_SET_ENABLED,
  MCP_SERVER_UPDATE,
} from '../../agent-skills/portable.ts';
import type { AgentToolExecutor } from '../../agent-skills/api.ts';
import type { ToolRegistry } from '../../mcp/api.ts';
import { orderExecutorsByRoster } from '../../../kernel/agent-roster.ts';
import { is_external_mcp_tool_name } from '../../../platform/errors/api.ts';
import { parseRfc3339 } from '../../../platform/time/index.ts';
import type { ParsedDateTime } from '../../../platform/time/api.ts';
import {
  effectiveSensitivity, ignoresBroadApprovalBypassForArgs,
  isExternalMcpCall, isLocalShellExecuteTool, isPrivilegeEscalationToolForArgs, makeRuntimeScopeKey,
  neverRememberApprovalForArgs, redactToolArgumentsForDisplay,
  runtimeApprovalScope, runtimeRootBindingFromArgs, shellCommandDecision, vfsFileExists,
} from '../../agent-workspace/portable.ts';
import {
  todoCompletedCount, todoTotalCount, trustedAutomationError, trustedAutomationPreauthorized,
} from '../../agent-orchestration/portable.ts';
import type { TodoList } from '../../agent-orchestration/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import type { AuthorityState } from '../api.ts';
import type { PendingPlan } from './approval-gate.ts';
import { globalPlanGateManager } from './authority-mode.ts';
import { bindToolExecutorRegistry } from './tool-executor-binding.ts';
import { ToolPackExecutor, type ToolPackLogger, type ToolPackRegistry } from './tool-pack-executor.ts';
import type { ChatToolRuntime, ToolAdvertisement } from './tool-round.ts';
import { chatPipelineApprovalRuntime } from './approval-runtime.ts';
import { immutableCommandGuardForToolCall } from './hooks.ts';

/** repo.rs:2851/2898/2915. Kept as a narrow consumer contract until L04 publishes these atomic operations. */
export interface ToolRuntimeAuthorityOwner {
  getSessionAuthorityState(sessionId: string): AuthorityState;
  createPendingPlan(summary: string, bindingKey: string): PendingPlan;
  setSessionPlanState(sessionId: string, plan: PendingPlan | null): unknown;
  consumeSessionPlanBinding(sessionId: string, bindingKey: string, now: Date): boolean;
}
/** todo_executor.rs:213–261. No-list is handled by the caller, not by a replacement store. */
export interface ToolRuntimeTodoOwner {
  getTodoList(sessionId: string): TodoList | null;
  persistTodoList(sessionId: string, messageId: string, variantId: string | null, list: TodoList): void;
}

const PROVIDER_METHODS = ['getSessionAuthorityState', 'setSessionPlanState',
  'consumeSessionPlanBinding'] as const satisfies readonly (keyof ChatSessionService)[];
type ProviderMethod = typeof PROVIDER_METHODS[number];

/** Called once per composed turn; absence keeps the existing explicit unavailable-tool-runtime error. */
export function composeChatToolRuntime(ctx: Context,
  missing: { note(capability: string, consequence: string): void }): ChatToolRuntime | null {
  const chat: ChatSessionService = ctx.chatSession;
  const absent = PROVIDER_METHODS.filter(name => typeof chat[name] !== 'function');
  if (absent.length > 0) {
    missing.note(`chatSession.${absent.join('/chatSession.')}`, 'central tool runtime requires the L04 authority/atomic Plan owner operations');
    return null;
  }
  const authority = chatSessionAuthorityOwner(chat);
  const todo: Partial<ToolRuntimeTodoOwner> | undefined = ctx.get('agentTodo');
  if (typeof todo?.persistTodoList !== 'function' || typeof todo.getTodoList !== 'function') {
    missing.note('agentTodo.persistTodoList', 'central tool runtime requires the L06 todo persistence owner');
    return null;
  }
  // The MCP registry is optional: platforms without `dstu.mcp` (mobile) still expose every
  // registered built-in executor. Only the executor registry itself is required.
  if (!ctx.get('agentTools')) {
    missing.note('agentTools', 'central tool runtime requires registered tool executors');
    return null;
  }
  return bindChatToolRuntime(ctx, authority, todo as ToolRuntimeTodoOwner);
}

/** chrono `DateTime<Utc>` view of the consumer's sampled instant (millisecond source, no rounding). */
function chronoNow(now: Date): ParsedDateTime {
  const parsed = parseRfc3339(now.toISOString());
  if (parsed === null) throw new RangeError(`unrepresentable plan-check instant: ${now.toISOString()}`);
  return parsed;
}

/**
 * Adapts the WP-168 L04 provider (api.ts:251-254, value-level Plan operations) to the consumer contract.
 * createPendingPlan = hooks.rs:1447-1448 `PlanAuthorityState::new_pending(summary)` + `bind_to_call(key)`;
 * markApproved = types.rs `mark_approved(ttl)`; isActiveForBinding = types.rs `is_active_for_binding`.
 */
export function chatSessionAuthorityOwner(chat: Pick<ChatSessionService, ProviderMethod>): ToolRuntimeAuthorityOwner {
  const plans = new WeakMap<PendingPlan, PlanAuthorityState>();
  return {
    getSessionAuthorityState(sessionId) {
      const state = chat.getSessionAuthorityState(sessionId);
      const plan = state.plan;
      return {
        authorityMode: state.authorityMode, permissionPreset: state.permissionPreset,
        plan: plan === undefined ? null
          : { isActiveForBinding: (bindingKey, now) => isPlanActiveForBinding(plan, bindingKey, chronoNow(now)) },
      };
    },
    createPendingPlan(summary, bindingKey) {
      const plan = newPendingPlan(summary);
      bindPlanToCall(plan, bindingKey);
      const pending: PendingPlan = {
        planId: plan.planId,
        markApproved: ttlSecs => markPlanApproved(plan, BigInt(ttlSecs)),
      };
      plans.set(pending, plan);
      return pending;
    },
    setSessionPlanState(sessionId, pending) {
      if (pending === null) return chat.setSessionPlanState(sessionId, null);
      const plan = plans.get(pending);
      if (plan === undefined) throw new TypeError(`plan ${pending.planId} was not created by createPendingPlan`);
      return chat.setSessionPlanState(sessionId, plan);
    },
    consumeSessionPlanBinding: (sessionId, bindingKey, now) =>
      chat.consumeSessionPlanBinding(sessionId, bindingKey, chronoNow(now)),
  };
}

/** pipeline.rs: the pipeline builds ToolPack itself, holding a weak handle to the registry it joins. */
export interface ToolPackTail {
  registry: () => ToolPackRegistry | null;
  log: ToolPackLogger;
}

/**
 * roster.rs + pipeline.rs `assemble_registry`: executable registrations in Rust dispatch order,
 * with the pipeline-owned ToolPack and General catch-all appended as the fixed tail when no
 * plugin registered them. Routing-only entries (no `execute`) never enter dispatch, so their
 * tools stay unadvertised.
 */
export function assembleRuntimeExecutors(registered: readonly AgentToolExecutor[], workspace: boolean,
  toolPack?: ToolPackTail): { executors: ToolExecutor[]; missing: string[] } {
  const executable = registered.filter(entry => typeof entry.execute === 'function') as ToolExecutor[];
  const has = (name: string) => executable.some(entry => entry.name() === name);
  const tail: ToolExecutor[] = [];
  if (toolPack !== undefined && !has('ToolPackExecutor')) tail.push(new ToolPackExecutor(toolPack));
  if (!has('GeneralToolExecutor')) tail.push(new GeneralToolExecutor() as ToolExecutor);
  return orderExecutorsByRoster([...executable, ...tail], { workspace });
}

/** Schema-injected tools (`schema_tool_ids`) come only from executors that will run them. */
export function schemaToolRegistry(executors: readonly ToolExecutor[]): InMemoryToolSchemaRegistry {
  const registry = new InMemoryToolSchemaRegistry();
  for (const executor of executors) {
    for (const tool of (executor as AgentToolExecutor).schemaTools?.() ?? []) registry.register(tool.id, tool.schema);
  }
  return registry;
}

/** executor_registry.rs: these `mcp_`-spelled names are builtin management tools, not external MCP. */
const BUILTIN_MCP_MANAGEMENT = new Set<string>([MCP_SERVER_UPDATE, MCP_SERVER_SET_ENABLED, MCP_SERVER_REMOVE, MCP_SERVER_PROPOSE]);

/**
 * A builtin name is served only by a specific executor; external MCP names by the General tail.
 * RUST-FIX(RF-W02-executable-only-tool-face): names without an executable executor are not advertised.
 */
export function toolAdvertisement(registry: Pick<ToolExecutorRegistry, 'getExecutor'>,
  inject: (ids: readonly string[] | null, llmContext: Map<string, unknown>) => number): ToolAdvertisement {
  return {
    injectSchemaTools: inject,
    advertises: name => {
      const executor = registry.getExecutor(name);
      if (executor === null) return false;
      if (executor.name() !== 'GeneralToolExecutor') return true;
      return is_external_mcp_tool_name(name) && !BUILTIN_MCP_MANAGEMENT.has(name);
    },
  };
}

/**
 * `dstu.mcp` is a desktop-only plugin today. Built-in `agentTools` executors do not need an external
 * MCP registry, so an absent `/mcp` service only removes external MCP servers: every `mcp_*` call
 * resolves through this registry and reports the missing capability instead of disabling the whole
 * tool face (which is what mobile saw when this composition required both services).
 */
const NO_EXTERNAL_MCP: ToolRegistry = {
  detectToolConflicts: async () => [],
  stripMcpNamespace: name => name,
  callTool: async name => {
    throw new Error(`external MCP tools are unavailable on this platform (requested ${name})`);
  },
};

export function bindChatToolRuntime(ctx: Context, authority: ToolRuntimeAuthorityOwner,
  todo: ToolRuntimeTodoOwner): ChatToolRuntime {
  const tools = ctx.get('agentTools'), mcp = ctx.get('mcp');
  if (!tools) throw new Error('central tool runtime requires agentTools');
  let registryRef: ToolExecutorRegistry | null = null;
  const { executors, missing } = assembleRuntimeExecutors(tools.toolExecutors(), ctx.get('agentWorkspace') !== undefined,
    { registry: () => registryRef, log: ctx.logger });
  if (missing.length > 0) ctx.logger.debug(`[agent_wiring] executor roster entries without an executable registration (tools withheld): ${JSON.stringify(missing)}`);
  const registry = ctx.chatSession.createExecutorRegistry(executors, {
    ignoresBroadApprovalBypassForArgs, neverRememberApprovalForArgs,
  });
  registryRef = registry;
  const schemas = schemaToolRegistry(executors);
  const binding = bindToolExecutorRegistry(ctx, registry, mcp?.registry ?? NO_EXTERNAL_MCP);
  const settings = ctx.settings;
  return {
    ...binding,
    advertisement: toolAdvertisement(registry, (ids, llmContext) => tools.injectToolSchemas(ids, llmContext, schemas)),
    gate: {
      killSwitchError: () => {
        const state = ctx.get('chatState');
        if (!state) return null; // Rust pipeline.kill_switch == None.
        try { state.killSwitch.ensureAllowed(); return null; }
        catch (error) { return errorMessage(error); }
      },
      executionPolicyAllows: (name, args, allowed) => ctx.chatSession.isToolAllowedByExecutionPolicy(name, args, allowed),
      trustedAutomationError, trustedAutomationPreauthorized,
      isLocalShell: isLocalShellExecuteTool, isExternalMcp: isExternalMcpCall,
      immutableGuard: call => immutableCommandGuardForToolCall(call, isLocalShellExecuteTool, () => {
        const home = ctx.get('paths')?.os.home ?? null;
        return home === null || home === '' ? null : home;
      }),
      shellCommandDecision: (call, local) => shellCommandDecision(call, local, settings),
      resolveLocalShellApprovalArguments: (call, emitter, sessionId, roots) =>
        chatPipelineApprovalRuntime().resolveLocalShellApprovalArguments(call, emitter, sessionId, roots, {
          settings, dataDir: ctx.app.dataDir, windowsFiles: ctx.get('nativeWindowsFiles'), logger: ctx.logger,
          authorityState: id => authority.getSessionAuthorityState(id),
          preferredRuntimeRootId: id => preferredRuntimeRootId(ctx, id), warn: message => ctx.logger.warn(message),
        }),
      runtimeRootBinding: runtimeRootBindingFromArgs, runtimeScopeKey: makeRuntimeScopeKey,
      baseSensitivity: (name, args) => registry.getSensitivityForCall(name, args),
      effectiveSensitivity: (base, name, args) => effectiveSensitivity(base, name, args, settings),
      authorityState: id => authority.getSessionAuthorityState(id),
      consumePlanBinding: (id, key, now) => authority.consumeSessionPlanBinding(id, key, now),
      newPendingPlan: (summary, key) => authority.createPendingPlan(summary, key),
      setPlanState: (id, plan) => { authority.setSessionPlanState(id, plan); },
      isPrivilegeEscalation: isPrivilegeEscalationToolForArgs, neverRememberApproval: neverRememberApprovalForArgs,
      redactForDisplay: redactToolArgumentsForDisplay, runtimeApprovalScope,
      approvalManager: ctx.get('agentApproval') ?? null, planGates: globalPlanGateManager(),
    },
    vfsFileExists: id => vfsFileExists(id, ctx.get('vfs') ?? null, ctx.vfsRepo),
    persistTodoList: (sessionId, messageId) => {
      const list = todo.getTodoList(sessionId);
      if (list === null) return;
      try {
        todo.persistTodoList(sessionId, messageId, null, list);
        ctx.logger.debug(`[ChatV2::pipeline] TodoList persisted: session=${sessionId}, progress=${todoCompletedCount(list)}/${todoTotalCount(list)}`);
      }
      catch (error) { ctx.logger.warn(`[ChatV2::pipeline] Failed to persist TodoList: ${errorMessage(error)}`); }
    },
  };
}

/** runtime_roots.rs:1414–1499: combine L04 public reads on the same connection for L05's binding port. */
function preferredRuntimeRootId(ctx: Context, sessionId: string): string | null {
  let conn;
  try { conn = ctx.chatSession.database.getConnSafe(); }
  catch (error) {
    ctx.logger.warn(`[runtime_roots] failed to open chat_v2 db while resolving preferred root for session '${sessionId}': ${errorMessage(error)}`);
    return null;
  }
  let session;
  try { session = getSessionWithConn(conn, sessionId); }
  catch (error) {
    ctx.logger.warn(`[runtime_roots] failed to load session '${sessionId}' for preferred root: ${errorMessage(error)}`);
    return null;
  }
  const groupId = rustTrim(session?.groupId ?? '');
  if (groupId === '') return null;
  try { return rustTrim(getGroupWithConn(conn, groupId)?.defaultRuntimeRootId ?? '') || null; }
  catch (error) {
    ctx.logger.warn(`[runtime_roots] failed to load group '${groupId}' for preferred root: ${errorMessage(error)}`);
    return null;
  }
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
