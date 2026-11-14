/**
 * L04 ↔ PTC adapter.
 *
 * `PtcExecutor` owns the Starlark program, budgets, trace and result envelope.
 * L04 owns dispatch, authority checks, timeouts and cancellation. This adapter
 * is the production registration object (`pipeline.rs:155-180`: `PtcExecutor`
 * sits before the `GeneralToolExecutor` catch-all) and maps L04's snake_case
 * `ExecutionContext` onto the lane's `PtcExecutionContext`.
 *
 * Every script `call()` is handed back to `admitted_tool_dispatcher` with a
 * derived child context: parent `session_id` is retained for tree budgets,
 * `block_id` becomes `<parent>-ptc-<seq>`, and shell approval is never inherited.
 */
import type {
  AdmittedToolDispatcher, ExecutionContext, ToolCall, ToolExecutor, ToolResultInfo,
} from '../../../chat/api.ts';
import type { AgentToolResultInfo } from '../../../../kernel/agent-api.ts';
import type { NativeStarlark } from '../../../../platform/native/starlark/api.ts';
import { PtcExecutor, type PtcSubContext } from './ptc-executor.ts';
import type { PtcDescriptorPolicy, PtcLogger } from './ptc-runtime.ts';

export interface PtcToolExecutorOptions {
  logger?: PtcLogger;
  descriptors?: PtcDescriptorPolicy;
  /** Host Context `nativeStarlark` resolver (profile replacement stays observable). */
  nativeStarlark: NativeStarlark | (() => NativeStarlark);
  /** Resolve `<artifacts root>/ptc`; `create=false` matches Rust object_read. */
  artifactRoot?(sessionId: string): string | null;
}

type ScopedContext = ExecutionContext & {
  scopedWithCancellationToken?(token: AbortSignal): ExecutionContext;
};

export class PtcToolExecutor implements ToolExecutor {
  private readonly ptc: PtcExecutor;
  private readonly artifactRoot: ((sessionId: string) => string | null) | undefined;

  constructor(options: PtcToolExecutorOptions) {
    this.ptc = new PtcExecutor({
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.descriptors === undefined ? {} : { descriptors: options.descriptors }),
      nativeStarlark: options.nativeStarlark,
    });
    this.artifactRoot = options.artifactRoot;
  }

  canHandle(toolName: string): boolean { return this.ptc.canHandle(toolName); }
  name(): string { return this.ptc.name(); }
  sensitivityLevel(toolName: string): 'medium' { return this.ptc.sensitivityLevel(toolName); }
  concurrencyClass(toolName: string): 'serial' { return this.ptc.concurrencyClass(toolName); }
  resultCharBudget(toolName: string): null { return this.ptc.resultCharBudget(toolName); }

  async execute(call: ToolCall, context: ExecutionContext): Promise<ToolResultInfo> {
    const dispatcher = context.admitted_tool_dispatcher;
    const ptcContext = {
      sessionId: context.session_id,
      messageId: context.message_id,
      blockId: context.block_id,
      toolCallId: context.tool_call_id ?? call.id,
      variantId: context.variant_id,
      roundId: context.round_id,
      skillStateVersion: context.skill_state_version,
      artifactRoot: this.artifactRoot?.(context.session_id) ?? null,
      cancel: context.cancellation_token ?? new AbortController().signal,
      emitToolCallStart: (name: string, args: unknown, callId: string | null) =>
        context.emitToolCallStart(name, args, callId),
      emitToolCallEnd: (payload: unknown) => context.emitToolCallEnd(payload),
      emitToolCallError: (error: string) => context.emitToolCallError(error),
      saveToolBlock: (result: ToolResultInfo) => context.saveToolBlock(result),
      ...(dispatcher === null ? {} : {
        dispatcher: {
          dispatchWithAdmission: (subCall: ToolCall, subContext: PtcSubContext) =>
            this.dispatch(dispatcher, context, subCall, subContext),
        },
      }),
    };
    return this.ptc.execute(call, ptcContext);
  }

  private async dispatch(
    dispatcher: AdmittedToolDispatcher,
    parent: ExecutionContext,
    call: ToolCall,
    sub: PtcSubContext,
  ): Promise<AgentToolResultInfo> {
    return normalizeToolResult(await dispatcher.dispatchWithAdmission(call, childContext(parent, sub)));
  }
}

/** L04 wire allows `null` on optional fields; the kernel executor shape omits them. */
function normalizeToolResult(result: ToolResultInfo): AgentToolResultInfo {
  return {
    toolName: result.toolName,
    input: result.input,
    output: result.output,
    success: result.success,
    ...(result.toolCallId == null ? {} : { toolCallId: result.toolCallId }),
    ...(result.blockId == null ? {} : { blockId: result.blockId }),
    ...(result.error == null ? {} : { error: result.error }),
    ...(result.durationMs == null ? {} : { durationMs: result.durationMs }),
    ...(result.reasoningContent == null ? {} : { reasoningContent: result.reasoningContent }),
    ...(result.thoughtSignature == null ? {} : { thoughtSignature: result.thoughtSignature }),
  };
}

/** Rust `PtcSubContextTemplate::build`: child block/cancel, parent session/runId. */
export function childContext(parent: ExecutionContext, sub: PtcSubContext): ExecutionContext {
  const scoped = parent as ScopedContext;
  let child: ExecutionContext;
  if (typeof scoped.scopedWithCancellationToken === 'function') {
    child = scoped.scopedWithCancellationToken(sub.cancel);
  } else {
    child = Object.create(Object.getPrototypeOf(parent)) as ExecutionContext;
    Object.assign(child, parent);
  }
  Object.assign(child, {
    block_id: sub.blockId,
    tool_call_id: sub.toolCallId === '' ? parent.tool_call_id : sub.toolCallId,
    variant_id: sub.variantId ?? child.variant_id,
    round_id: sub.roundId ?? child.round_id,
    skill_state_version: sub.skillStateVersion ?? child.skill_state_version,
    cancellation_token: sub.cancel,
    // Guard approval binds one top-level command; script sub-calls never inherit.
    shell_guard_approved: false,
    shell_authority_admission: null,
    admitted_tool_dispatcher: parent.admitted_tool_dispatcher,
  });
  return child;
}
