/**
 * Binds {@link SettingsModelsToolExecutor} to the chat tool runtime: `ctx.main_db` settings rows go through the
 * F4 `*WithConn` seam, `ctx.llm_manager` keeps the Rust `None` → DEPENDENCY_UNAVAILABLE behaviour, and events
 * are app-wide like Rust `window.app_handle().emit`.
 */
import type { SettingsWithConn } from '../../../platform/settings/api.ts';
import type { ChatExecutionContext, ToolCall, ToolExecutor, ToolResultInfo } from '../../chat/api.ts';
import type { MediaService } from '../../media/api.ts';
import {
  SettingsModelsToolExecutor, type SettingsModelsDatabase, type SettingsModelsLlmManager,
  type SettingsModelsProbe, type ToolExecutionContext,
} from './settings_models_executor.ts';

export interface SettingsModelsRuntimeDeps {
  settings: SettingsWithConn;
  /** The llm plugin's own manager surface; used only when the call context carries `llm_manager`. */
  manager: SettingsModelsLlmManager;
  /** Network/credential probe used by the self-config tools; absent keeps those tools unavailable. */
  probe?: SettingsModelsProbe | null;
  voiceInput: Pick<MediaService, 'isAsrModel' | 'asrProviderSupported'>;
  emit(event: string, payload: unknown): void;
  warn(message: string): void;
}

export class SettingsModelsRuntimeExecutor implements ToolExecutor {
  private readonly inner = new SettingsModelsToolExecutor();
  private readonly deps: SettingsModelsRuntimeDeps;

  constructor(deps: SettingsModelsRuntimeDeps) { this.deps = deps; }

  name(): string { return this.inner.name(); }
  canHandle(toolName: string): boolean { return this.inner.canHandle(toolName); }
  sensitivityLevel(toolName: string) { return this.inner.sensitivityLevel(toolName); }
  concurrencyClass(toolName: string) { return this.inner.concurrencyClass(toolName); }

  execute(call: ToolCall, context: ChatExecutionContext): Promise<ToolResultInfo> {
    const conn = context.main_db;
    const settings = this.deps.settings;
    const database: SettingsModelsDatabase | null = conn === null ? null : {
      get: key => settings.getWithConn(conn, key),
      save: (key, value) => { settings.saveWithConn(conn, key, value); },
      listByPrefix: prefix => settings.listByPrefixWithConn(conn, prefix),
    };
    const toolContext: ToolExecutionContext = {
      blockId: context.block_id,
      database,
      llm: context.llm_manager === null ? null : this.deps.manager,
      probe: this.deps.probe ?? null,
      voiceInput: this.deps.voiceInput,
      appEvents: { emit: (event, payload) => this.deps.emit(event, payload) },
      emitToolCallStart: (name, args, callId) => context.emitToolCallStart(name, args, callId),
      emitToolCallEnd: payload => context.emitToolCallEnd(payload),
      emitToolCallError: error => context.emitToolCallError(error),
      saveToolBlock: result => context.saveToolBlock(result as ToolResultInfo),
      warn: message => this.deps.warn(message),
    };
    return this.inner.execute(call, toolContext) as Promise<ToolResultInfo>;
  }
}
