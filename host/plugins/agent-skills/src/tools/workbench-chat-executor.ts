/** roster.rs:126 `WorkbenchToolExecutor` bound to the chat ExecutionContext (workbench_bridge.rs transport). */
import type { BackendEvents, WindowRef } from '../../../../kernel/api.ts';
import type { SettingsStore } from '../../../../platform/settings/api.ts';
import type { FeatureFlagsService } from '../../../../platform/storage/api.ts';
import { EVENT_TYPE, type ExecutionContext, type ToolCall, type ToolExecutor, type ToolResultInfo } from '../../../chat/api.ts';
import type { AcrBridgeLogger, BridgeEventBus } from '../workbench-bridge.ts';
import { WorkbenchToolExecutor, type WorkbenchGateEnvironment } from './workbench-executor.ts';

/**
 * Window-targeted ACR transport: Rust listens on and emits to `ctx.window_ref()`, so a
 * windowless call fails before the request is emitted instead of broadcasting app-wide.
 */
export function windowBridgeEventBus(events: BackendEvents, window: () => WindowRef | null): BridgeEventBus {
  const require = (action: string): WindowRef => {
    const target = window();
    if (target === null) {
      throw new Error(`ACR bridge requires the calling frontend window (ExecutionContext.window_ref) before ${action}`);
    }
    return target;
  };
  return {
    emit(event, payload) { events.emitTo({ kind: 'Window', label: require('emitting').window }, event, payload); },
    listen(event, handler) { return events.listenWindow(require('subscribing'), event, payload => handler(payload)); },
  };
}

export interface WorkbenchGateSources {
  settings?: SettingsStore | undefined;
  featureFlags?: FeatureFlagsService | undefined;
  app: { version: string; debug: boolean };
}

/** `resolve_workbench_gates` environment; null mirrors Rust's missing `Arc<Database>` state. */
export function workbenchGateEnvironment(sources: WorkbenchGateSources): WorkbenchGateEnvironment | null {
  const { settings, featureFlags } = sources;
  if (settings === undefined || featureFlags === undefined) return null;
  return {
    featureFlagEnabled(name) {
      return featureFlags.load({
        getSetting: key => settings.get(key),
        saveSetting: (key, value) => { settings.save(key, value); },
      }, sources.app.version, { debug: sources.app.debug }).isFeatureEnabled(name);
    },
    settings,
  };
}

export interface WorkbenchChatToolDeps {
  events(): BackendEvents;
  gates(): WorkbenchGateEnvironment | null;
  logger: AcrBridgeLogger;
}

export class WorkbenchChatToolExecutor implements ToolExecutor {
  private readonly core = new WorkbenchToolExecutor();
  private readonly deps: WorkbenchChatToolDeps;
  constructor(deps: WorkbenchChatToolDeps) { this.deps = deps; }

  name(): string { return this.core.name(); }
  canHandle(toolName: string): boolean { return this.core.canHandle(toolName); }
  sensitivityLevel(toolName: string): 'low' | 'medium' | 'high' { return this.core.sensitivityLevel(toolName); }
  concurrencyClass(toolName: string): 'serial' { return this.core.concurrencyClass(toolName); }
  managesCancellation(toolName: string): boolean { return this.core.managesCancellation(toolName); }

  execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    return this.core.execute(call, {
      sessionId: ctx.session_id,
      toolCallId: ctx.runId(),
      blockId: ctx.block_id,
      events: windowBridgeEventBus(this.deps.events(), () => ctx.tryWindow()),
      gates: this.deps.gates(),
      cancel: ctx.cancellation_token,
      emitProgressChunk: chunk => ctx.emitter.emitChunk(EVENT_TYPE.TOOL_CALL, ctx.block_id, chunk, null),
      emitToolCallStart: (name, args, callId) => ctx.emitToolCallStart(name, args, callId),
      emitToolCallEnd: payload => ctx.emitToolCallEnd(payload),
      emitToolCallError: error => ctx.emitToolCallError(error),
      saveToolBlock: result => ctx.saveToolBlock(result as ToolResultInfo),
      logger: this.deps.logger,
    }) as Promise<ToolResultInfo>;
  }
}
