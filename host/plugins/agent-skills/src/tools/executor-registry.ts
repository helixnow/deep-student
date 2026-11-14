/**
 * Tool-executor registration surface published through `agentTools`
 * (ARCHITECTURE.md §2 "工具"; service rename table maps `agent.tools@1` to
 * `agentTools`).
 *
 * Rust keeps executor instances in L04 `chat_v2/tools/executor_registry.rs`;
 * plugins that own executors (L07, L10, L21, L24, …) hand their routing objects
 * to that registry during assembly. The Host equivalent lets each owning plugin
 * publish the same objects on `ctx.agentTools`; dispatch, timeout, approval and
 * cancellation remain with L04's registry so this module only stores
 * registrations in registration order (Rust `ToolExecutorRegistry::register`
 * appends: `executor_registry.rs:201–207`).
 */
import { HookSet, type Disposer } from '../../../../kernel/api.ts';

export type AgentToolSensitivity = 'low' | 'medium' | 'high';
export type AgentToolConcurrency = 'read_only' | 'safe_parallel' | 'serial';

/** One `SchemaToolRegistry` entry (registry.rs ToolDefinition: id + OpenAI function schema). */
export interface AgentSchemaTool {
  readonly id: string;
  readonly schema: unknown;
}

/**
 * Common routing surface of a tool executor.
 *
 * `name()` must be the Rust roster name (`host/kernel/agent-roster.ts`); the chat tool runtime
 * orders registrations by that roster. Only entries with `execute` are dispatched, and a builtin
 * tool's schema is advertised to the model only when an executable entry `canHandle`s it, so a
 * routing-only entry (no `execute`) keeps its tools hidden instead of failing at call time.
 * `execute` receives the L04 `ToolCall` / `ExecutionContext` (`host/plugins/chat/api.ts`).
 */
export interface AgentToolExecutor {
  name(): string;
  canHandle(toolName: string): boolean;
  sensitivityLevel?(toolName: string): AgentToolSensitivity;
  sensitivityLevelForCall?(toolName: string, args: unknown): AgentToolSensitivity;
  hasDynamicSensitivity?(toolName: string): boolean;
  concurrencyClass?(toolName: string): AgentToolConcurrency;
  managesCancellation?(toolName: string): boolean;
  resultCharBudget?(toolName: string): number | null;
  execute?(call: unknown, context: unknown): Promise<unknown>;
  /**
   * Tools injected through `schema_tool_ids` rather than the frontend tool list
   * (Rust `SchemaToolRegistry::new_with_builtin_tools`: attempt_completion, todo_*, goal_*).
   */
  schemaTools?(): readonly AgentSchemaTool[];
}

/** Registration order is preserved; lookup is the dispatcher's responsibility. */
export class AgentToolExecutorRegistry {
  private readonly registered = new HookSet<readonly AgentToolExecutor[]>();

  /** One identity per call, independent of executor names or object identity. */
  register(executors: readonly AgentToolExecutor[]): Disposer {
    return this.registered.register(executors.slice());
  }

  all(): readonly AgentToolExecutor[] {
    return this.registered.snapshot().flat();
  }
}
