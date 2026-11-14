/**
 * Port of `legacy_tool_provider.rs`: expose the legacy executor roster as a
 * catch-all `ToolProvider` without changing dispatch semantics.
 *
 * Dispatch still belongs to the legacy registry (watchdogs, cancellation,
 * budgets, approvals). The projection exists for duplicate/missing validation
 * and the new/old resolution oracle. The adapter's `execute` refuses to run
 * because the legacy 35-field execution context cannot be built from the new
 * one; every call must go through the legacy registry.
 */
import {
  DEFAULT_TOOL_RESULT_CHAR_BUDGET,
  ToolDescriptor,
  ToolRegistryBuilder,
} from '../../../../kernel/agent-api.ts';
import type {
  AgentToolCall,
  AgentToolResultInfo,
  ToolConcurrency,
  ToolExecutor,
  ToolProvider,
  ToolSensitivity,
} from '../../../../kernel/agent-api.ts';

export const LEGACY_PROVIDER_ID = 'chat_v2.legacy';
const DEFAULT_TIMEOUT_SECS = 120;

/** Legacy `chat_v2::tools::ToolExecutor` (metadata surface used by the projection). */
export interface LegacyToolExecutor {
  canHandle(toolName: string): boolean;
  sensitivityLevel?(toolName: string): ToolSensitivity;
  sensitivityLevelForCall?(toolName: string, args: unknown): ToolSensitivity;
  hasDynamicSensitivity?(toolName: string): boolean;
  concurrencyClass?(toolName: string): ToolConcurrency;
  managesCancellation?(toolName: string): boolean;
  resultCharBudget?(toolName: string): number | null;
  name(): string;
}

/** `ToolExecutorRegistry` surface used by the provider (L04-owned). */
export interface LegacyExecutorRegistry {
  executors(): readonly LegacyToolExecutor[];
  getExecutor(toolName: string): LegacyToolExecutor | undefined;
}

/** `chat_v2::tool_descriptors::ToolDescriptor` (L06-owned data; supplied by caller). */
export interface LegacyToolDescriptor {
  name: string;
  sensitivity: 'Low' | 'Medium' | 'High';
  timeoutSecs: number | null;
  headlessAllowed: boolean;
  ptcAllowed: boolean;
}

export interface LegacyToolLogger {
  debug?(message: string): void;
  error?(message: string): void;
}

function lowerSensitivity(level: LegacyToolDescriptor['sensitivity']): ToolSensitivity {
  return level.toLowerCase() as ToolSensitivity;
}

/** `project_descriptor`: bare name + `builtin-` alias and name-level policy only. */
export function projectLegacyDescriptor(legacy: LegacyToolDescriptor): ToolDescriptor {
  const timeout = legacy.timeoutSecs === null
    ? DEFAULT_TIMEOUT_SECS
    : legacy.timeoutSecs === 0 ? null : legacy.timeoutSecs;
  return new ToolDescriptor(legacy.name)
    .withAliases([`builtin-${legacy.name}`])
    .withSensitivity(lowerSensitivity(legacy.sensitivity))
    .withTimeout(timeout)
    .withHeadless(legacy.headlessAllowed ? 'read_only' : 'blocked')
    .withPtc(legacy.ptcAllowed ? 'read_only' : 'denied');
}

export class LegacyExecutorAdapter implements ToolExecutor {
  readonly inner: LegacyToolExecutor;

  constructor(inner: LegacyToolExecutor) { this.inner = inner; }

  static wrap(inner: LegacyToolExecutor): LegacyExecutorAdapter { return new LegacyExecutorAdapter(inner); }

  canHandle(toolName: string): boolean { return this.inner.canHandle(toolName); }

  async execute(call: AgentToolCall, _ctx: unknown): Promise<AgentToolResultInfo> {
    throw new Error(
      `legacy executor \`${this.inner.name()}\` must be dispatched through ToolExecutorRegistry (tool \`${call.name}\`)`,
    );
  }

  sensitivityLevel(toolName: string): ToolSensitivity {
    return this.inner.sensitivityLevel?.(toolName) ?? 'low';
  }
  sensitivityLevelForCall(toolName: string, args: unknown): ToolSensitivity {
    return this.inner.sensitivityLevelForCall?.(toolName, args) ?? this.sensitivityLevel(toolName);
  }
  hasDynamicSensitivity(toolName: string): boolean {
    return this.inner.hasDynamicSensitivity?.(toolName) ?? false;
  }
  concurrencyClass(toolName: string): ToolConcurrency {
    return this.inner.concurrencyClass?.(toolName) ?? 'serial';
  }
  managesCancellation(toolName: string): boolean {
    return this.inner.managesCancellation?.(toolName) ?? false;
  }
  resultCharBudget(toolName: string): number | null {
    return this.inner.resultCharBudget === undefined
      ? DEFAULT_TOOL_RESULT_CHAR_BUDGET : this.inner.resultCharBudget(toolName);
  }
  name(): string { return this.inner.name(); }
}

export class LegacyToolProvider implements ToolProvider<ToolExecutor> {
  readonly id: string = LEGACY_PROVIDER_ID;
  private readonly legacy: LegacyExecutorRegistry;
  private readonly projected: readonly ToolDescriptor[];
  /** Same order as `legacy.executors()`. */
  private readonly adapters: readonly LegacyExecutorAdapter[];
  private readonly byExecutor: ReadonlyMap<LegacyToolExecutor, LegacyExecutorAdapter>;

  constructor(
    legacy: LegacyExecutorRegistry,
    descriptors: readonly LegacyToolDescriptor[] | readonly ToolDescriptor[],
  ) {
    this.legacy = legacy;
    this.projected = descriptors.map(descriptor => descriptor instanceof ToolDescriptor
      ? descriptor
      : projectLegacyDescriptor(descriptor as LegacyToolDescriptor));
    this.adapters = legacy.executors().map(executor => LegacyExecutorAdapter.wrap(executor));
    const byExecutor = new Map<LegacyToolExecutor, LegacyExecutorAdapter>();
    legacy.executors().forEach((executor, index) => byExecutor.set(executor, this.adapters[index]!));
    this.byExecutor = byExecutor;
  }

  /** `ToolProvider::descriptors`. */
  descriptors(): readonly ToolDescriptor[] { return this.projected; }

  /** Reuses the legacy resolution: external MCP short-circuit → first-wins `canHandle`. */
  executor(toolName: string): ToolExecutor | undefined {
    const legacy = this.legacy.getExecutor(toolName);
    return legacy === undefined ? undefined : this.byExecutor.get(legacy);
  }

  executors(): readonly LegacyExecutorAdapter[] { return this.adapters; }

  isCatchAll(): boolean { return true; }
}

/** `build_tool_registry`: one catch-all provider over the legacy roster. */
export function buildLegacyToolRegistry(
  legacy: LegacyExecutorRegistry,
  descriptors: readonly LegacyToolDescriptor[] | readonly ToolDescriptor[],
) {
  return new ToolRegistryBuilder<ToolExecutor>()
    .withProvider(new LegacyToolProvider(legacy, descriptors))
    .build();
}

/** Startup validation: failures are logged and never change dispatch. */
export function validateLegacyRegistry(
  legacy: LegacyExecutorRegistry,
  descriptors: readonly LegacyToolDescriptor[] | readonly ToolDescriptor[],
  logger: LegacyToolLogger = {},
): string | undefined {
  try {
    const registry = buildLegacyToolRegistry(legacy, descriptors);
    logger.debug?.(`[ChatV2::legacy_tool_provider] agent-api registry validated: ${registry.len()} entries`);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error?.(`[ChatV2::legacy_tool_provider] agent-api registry validation failed: ${message}`);
    return message;
  }
}
