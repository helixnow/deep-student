/** roster.rs:50 `ConnectorToolExecutor` bound to the chat ExecutionContext (connector_executor.rs:1227-1295). */
import type { SettingsStore } from '../../../../platform/settings/api.ts';
import type { ExecutionContext, ToolCall, ToolExecutor, ToolResultInfo } from '../../../chat/api.ts';
import type { JsonValue, ToolRegistry } from '../../../mcp/api.ts';
import { isSensitiveKey } from '../../../../platform/secrets/sensitive-key.ts';
import { createWebhookProvider } from './connector-webhook-provider.ts';
import {
  CONNECTOR_COMMIT_TOOL, CONNECTOR_CONFIRM_TOOL, CONNECTOR_DRAFT_TOOL, CONNECTOR_REGISTRY_KEY, CONNECTOR_REGISTRY_TOOL,
  ConnectorToolExecutor, errorText, type ConnectorExecutionContext, type ConnectorLogger, type ConnectorSettings,
} from './connector-executor.ts';

export interface ConnectorChatToolDeps {
  /** `ctx.main_db` settings; null mirrors "Main database not available". */
  settings(): SettingsStore | null;
  /** `ctx.tool_registry` — the MCP registry the tool loop binds into every execution context. */
  toolRegistry(): ToolRegistry | null;
  logger: ConnectorLogger & { warn(message: string): void };
}

type Args = Record<string, unknown>;
const asArgs = (value: unknown): Args => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Args : {};

/**
 * The core reads `connectors.registry.v1` synchronously (`db.get_secret`); the Host secure store
 * is async, so the value (or its read error) is fetched once per call and replayed.
 */
export async function connectorSettings(settings: SettingsStore, loadWebhookSecrets = false): Promise<ConnectorSettings> {
  let registry: { value: string | null } | { error: unknown };
  try { registry = { value: await settings.getSecret(CONNECTOR_REGISTRY_KEY) }; }
  catch (error) { registry = { error }; }
  const secrets = new Map<string, { value: string | null } | { error: unknown }>();
  if (loadWebhookSecrets && 'value' in registry) {
    // Only prefetch registry-declared sensitive keys. Never fall back to plaintext settings.
    let entries: unknown = [];
    try { entries = JSON.parse(registry.value ?? '[]'); }
    catch { entries = []; } // Prefetch no secrets; the core's strict registry parser reports the configuration error.
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        const key: unknown = entry?.provider === 'webhook' ? entry.webhook?.secretSettingKey : undefined;
        if (typeof key !== 'string' || !isSensitiveKey(key) || secrets.has(key)) continue;
        try { secrets.set(key, { value: await settings.getSecret(key) }); }
        catch (error) { secrets.set(key, { error }); }
      }
    }
  }
  return {
    getSecret(key) {
      const result = key === CONNECTOR_REGISTRY_KEY ? registry : secrets.get(key);
      if (result === undefined) throw new Error(`secret '${key}' is not available to the connector executor`);
      if ('error' in result) throw result.error;
      return result.value;
    },
    getSetting: key => settings.get(key),
  };
}

export class ConnectorChatToolExecutor implements ToolExecutor {
  private readonly core = new ConnectorToolExecutor();
  private readonly deps: ConnectorChatToolDeps;
  constructor(deps: ConnectorChatToolDeps) { this.deps = deps; }

  name(): string { return this.core.name(); }
  canHandle(toolName: string): boolean { return this.core.canHandle(toolName); }
  sensitivityLevel(toolName: string): 'low' | 'medium' | 'high' { return this.core.sensitivityLevel(toolName); }

  async execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    const started = Date.now();
    ctx.emitToolCallStart(call.name, call.arguments, call.id);
    let output: unknown;
    let failure: string | null = null;
    try { output = await this.dispatch(call, ctx); }
    catch (error) { failure = errorText(error); }
    const durationMs = Date.now() - started;
    let result: ToolResultInfo;
    if (failure === null) {
      ctx.emitToolCallEnd({ result: output, durationMs });
      result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, output, success: true, durationMs };
    } else {
      ctx.emitToolCallError(failure);
      result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments,
        output: null, success: false, error: failure, durationMs };
    }
    try { ctx.saveToolBlock(result); }
    catch (error) { this.deps.logger.warn(`[ConnectorToolExecutor] Failed to save tool block: ${errorText(error)}`); }
    return result;
  }

  private async dispatch(call: ToolCall, ctx: ExecutionContext): Promise<unknown> {
    const args = asArgs(call.arguments);
    switch (ConnectorToolExecutor.stripNamespace(call.name)) {
      case CONNECTOR_REGISTRY_TOOL: return this.core.executeRegistry(await this.context(ctx));
      case CONNECTOR_DRAFT_TOOL: return this.core.executeDraft(args, await this.context(ctx));
      case CONNECTOR_CONFIRM_TOOL: return this.core.executeConfirm(args, await this.context(ctx));
      case CONNECTOR_COMMIT_TOOL: return this.core.executeCommit(args, await this.context(ctx, true));
      default: throw new Error('Unknown connector tool');
    }
  }

  private async context(ctx: ExecutionContext, loadWebhookSecrets = false): Promise<ConnectorExecutionContext> {
    const settings = this.deps.settings();
    const registry = this.deps.toolRegistry();
    const chatV2Db = ctx.chat_v2_db?.getConn();
    return {
      sessionId: ctx.session_id,
      ...(settings === null ? {} : { mainDb: await connectorSettings(settings, loadWebhookSecrets) }),
      createWebhookProvider,
      ...(chatV2Db === undefined ? {} : { chatV2Db }),
      ...(registry === null ? {} : {
        callTool: async (name: string, providerArgs: Args) => {
          const [ok, data, error] = await registry.callTool(name, providerArgs as JsonValue, {
            supports_tools: true, mcp_client: null, stream_event: null, stage: 'connector_commit',
            memory_enabled: null, window: ctx.tauri_window,
          });
          return { ok, data, ...(error === null ? {} : { error }) };
        },
      }),
      logger: this.deps.logger,
    };
  }
}
