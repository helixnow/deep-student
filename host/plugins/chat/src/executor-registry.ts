/** Rust tools/executor_registry.rs:24-515. Ordered dispatch, scoped cancellation and watchdogs. */
import { DEFAULT_TOOL_RESULT_CHAR_BUDGET } from '../../../kernel/api.ts';
import { toAgentJson, withToolResultBudget } from '../../../kernel/agent-api.ts';
import { is_external_mcp_tool_name, with_localized_message } from '../../../platform/errors/api.ts';
import { lookupToolDescriptor } from './tool-descriptors.ts';
import { MCP_SERVER_UPDATE, MCP_SERVER_SET_ENABLED, MCP_SERVER_REMOVE, MCP_SERVER_PROPOSE } from '../../../kernel/agent-tool-descriptors.ts';
import type { ToolCall, ToolConcurrency, ToolExecutor, ToolResultInfo, ToolSensitivity } from '../api.ts';
import type { ChatExecutionContext } from './execution-context.ts';
import type { ChatLogger } from './logger.ts';

/** L05 approval_scope is a separate owner; callers provide its two concrete-call policies. */
export interface ToolApprovalPolicyPort {
  ignoresBroadApprovalBypassForArgs(toolName: string, args: unknown): boolean;
  neverRememberApprovalForArgs(toolName: string, args: unknown): boolean;
}
export interface ToolRiskSnapshot {
  toolName: string; baseSensitivity: ToolSensitivity; dynamic: boolean; protected: boolean; neverRemember: boolean;
}
// Built lazily: agent-skills/api.ts and chat/api.ts import each other, so these bindings may still be
// in their temporal dead zone while this module evaluates.
let builtinMcpManagementNames: ReadonlySet<string> | undefined;
function builtinMcpManagement(): ReadonlySet<string> {
  return builtinMcpManagementNames ??= new Set<string>([MCP_SERVER_UPDATE, MCP_SERVER_SET_ENABLED, MCP_SERVER_REMOVE, MCP_SERVER_PROPOSE]);
}

export function getToolTimeoutSecs(toolName: string): number {
  const bare = toolName.startsWith('builtin-') ? toolName.slice(8) : toolName;
  const descriptor = lookupToolDescriptor(bare);
  return descriptor === null ? is_external_mcp_tool_name(bare) ? 180 : 120 : descriptor.timeoutSecs ?? 120;
}
export function getExecutorTimeoutSecs(toolName: string, executorName: string): number {
  const configured = getToolTimeoutSecs(toolName);
  if (configured === 0) return 0;
  return ['WorkbenchToolExecutor', 'CanvasToolExecutor', 'BuiltinResourceExecutor'].includes(executorName)
    ? Math.max(configured, 180) : configured;
}
export function registryCancelledError(toolName: string): string {
  return JSON.stringify(with_localized_message({ code: 'TOOL_CANCELLED',
    hint: 'The run was cancelled by the user or a parent task; do not retry automatically.', retryable: false },
  'chat.tools.registry.errors.tool_cancelled', { tool: toolName },
  `工具 '${toolName}' 执行已取消。`, `Tool '${toolName}' execution cancelled.`));
}
export function registryTimeoutError(toolName: string, seconds: number): string {
  return JSON.stringify(with_localized_message({ code: 'TOOL_TIMEOUT',
    hint: 'Retry the call; if it keeps timing out, reduce the workload or check network / index status first.', retryable: true },
  'chat.tools.registry.errors.tool_timeout', { tool: toolName, timeoutSecs: seconds },
  `工具 '${toolName}' 执行超时（${seconds} 秒）。`, `Tool '${toolName}' execution timed out after ${seconds}s.`));
}

export class ToolExecutorRegistry {
  private readonly roster: ToolExecutor[];
  private readonly log: ChatLogger;
  private readonly approval: ToolApprovalPolicyPort;
  constructor(executors: readonly ToolExecutor[], approval: ToolApprovalPolicyPort, log: ChatLogger) {
    this.roster = [...executors]; this.approval = approval; this.log = log;
  }
  register(executor: ToolExecutor): void {
    this.log.debug(`[ToolExecutorRegistry] Registering executor: ${executor.name()}`);
    this.roster.push(executor);
  }
  getExecutor(toolName: string): ToolExecutor | null {
    if (is_external_mcp_tool_name(toolName) && !builtinMcpManagement().has(toolName)) {
      return this.roster.find(executor => executor.name() === 'GeneralToolExecutor') ?? null;
    }
    return this.roster.find(executor => executor.canHandle(toolName)) ?? null;
  }
  getSensitivity(toolName: string): ToolSensitivity | null {
    const executor = this.getExecutor(toolName);
    return executor === null ? null : executor.sensitivityLevel?.(toolName) ?? 'low';
  }
  getSensitivityForCall(toolName: string, args: unknown): ToolSensitivity | null {
    const executor = this.getExecutor(toolName);
    return executor === null ? null : executor.sensitivityLevelForCall?.(toolName, args) ?? executor.sensitivityLevel?.(toolName) ?? 'low';
  }
  describeRiskForCall(toolName: string, args: unknown): ToolRiskSnapshot | null {
    const executor = this.getExecutor(toolName);
    if (executor === null) return null;
    const baseSensitivity = this.getSensitivityForCall(toolName, args);
    if (baseSensitivity === null) return null;
    return { toolName, baseSensitivity, dynamic: executor.hasDynamicSensitivity?.(toolName) ?? false,
      protected: this.approval.ignoresBroadApprovalBypassForArgs(toolName, args),
      neverRemember: this.approval.neverRememberApprovalForArgs(toolName, args) };
  }
  getConcurrencyClass(toolName: string): ToolConcurrency { return this.getExecutor(toolName)?.concurrencyClass?.(toolName) ?? 'serial'; }
  managesCancellation(toolName: string): boolean { return this.getExecutor(toolName)?.managesCancellation?.(toolName) ?? false; }
  canHandle(toolName: string): boolean { return this.getExecutor(toolName) !== null; }
  hasSpecificExecutor(toolName: string): boolean {
    const executor = this.getExecutor(toolName);
    return executor !== null && executor.name() !== 'GeneralToolExecutor';
  }
  isNoTimeoutTool(toolName: string): boolean { return getToolTimeoutSecs(toolName) === 0; }
  len(): number { return this.roster.length; }
  isEmpty(): boolean { return this.roster.length === 0; }
  executorNames(): string[] { return this.roster.map(executor => executor.name()); }
  executors(): readonly ToolExecutor[] { return this.roster; }

  async execute(call: ToolCall, context: ChatExecutionContext): Promise<ToolResultInfo> {
    if (context.isCancelled()) {
      this.log.info(`[ToolExecutorRegistry] Tool execution cancelled before start: ${call.name} (id=${call.id})`);
      throw new Error(registryCancelledError(call.name));
    }
    const executor = this.getExecutor(call.name);
    if (executor === null) throw new Error(`No executor found for tool: ${call.name}`);
    this.log.debug(`[ToolExecutorRegistry] Executing tool '${call.name}' with executor '${executor.name()}'`);
    const seconds = getExecutorTimeoutSecs(call.name, executor.name());
    const managesCancellation = executor.managesCancellation?.(call.name) ?? false;
    const controller = new AbortController();
    const parent = context.cancellation_token;
    // AbortSignal.any retains parent propagation after a successful call while
    // native weak links avoid retaining finished scopes on a long-running parent.
    const signal = parent === null ? controller.signal : AbortSignal.any([parent, controller.signal]);
    const scoped = context.scopedWithCancellationToken(signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onCancelled: (() => void) | undefined;
    try {
      const futures = [executor.execute(call, scoped)];
      if (seconds === 0) this.log.debug(`[ToolExecutorRegistry] Tool '${call.name}' timeout disabled`);
      else {
        this.log.debug(`[ToolExecutorRegistry] Tool '${call.name}' timeout set to ${seconds}s`);
        futures.push(new Promise<ToolResultInfo>((_resolve, reject) => {
          timer = setTimeout(() => {
            this.log.error(`[ToolExecutorRegistry] ${managesCancellation ? 'Self-cancelling tool' : 'Tool'} execution timeout after ${seconds}s: ${call.name} (id=${call.id})`);
            controller.abort();
            reject(new Error(managesCancellation
              ? `RESULT_UNKNOWN: Tool '${call.name}' execution timed out after ${seconds}s; terminal result unknown`
              : registryTimeoutError(call.name, seconds)));
          }, seconds * 1000);
        }));
      }
      if (!managesCancellation && parent !== null) futures.push(new Promise<ToolResultInfo>((_resolve, reject) => {
        onCancelled = () => {
          this.log.info(`[ToolExecutorRegistry] Tool execution cancelled: ${call.name} (id=${call.id})`);
          controller.abort(); reject(new Error(registryCancelledError(call.name)));
        };
        parent.addEventListener('abort', onCancelled, { once: true });
        if (parent.aborted) onCancelled();
      }));
      const raced = await Promise.race(futures);
      const output = toAgentJson(raced.output);
      // RUST-FIX(RF-W02-agent-json-bigint): bigint output threw in budgeting and history; Value has no such state.
      const result = output === raced.output ? raced : { ...raced, output };
      const budget = executor.resultCharBudget === undefined ? DEFAULT_TOOL_RESULT_CHAR_BUDGET : executor.resultCharBudget(call.name);
      // RUST-FIX(RF-W02-loaded-skill-ids-truncation): withToolResultBudget carries the pre-budget output for the loop.
      return budget === null ? result : withToolResultBudget(result, budget);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onCancelled !== undefined) parent?.removeEventListener('abort', onCancelled);
    }
  }
}
