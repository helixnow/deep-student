/**
 * Chat `ToolExecutor` shells for mcp_propose_executor.rs / mcp_manage_executor.rs: the
 * propose/update/set_enabled/remove flows live in the lane cores; this file binds them to the
 * secure `mcp.tools.list`, plain-settings provenance, the settings-changed event and the
 * connection probe, and reproduces the Rust `execute` envelope (start → end/error → save).
 */
import type { ExecutionContext, ToolCall, ToolExecutor, ToolResultInfo } from '../../../chat/api.ts';
import type { BackendEvents } from '../../../../kernel/api.ts';
import type { SettingsStore } from '../../../../platform/settings/api.ts';
import { emitMcpListChanged, readMcpToolsList, writeMcpToolsList } from './mcp-settings-store.ts';
import { ENV_PLACEHOLDER, McpProposeExecutor, parseProposeInput, type McpTransport } from './mcp-propose-executor.ts';
import { MCP_SERVER_REMOVE, MCP_SERVER_SET_ENABLED, MCP_SERVER_UPDATE, McpManageExecutor } from './mcp-manage-executor.ts';

const STDIO_TEST_TIMEOUT_SECS = 15;
const REMOTE_TEST_TIMEOUT_SECS = 30;

/** `crate::mcp::test_helpers` probes, one per transport. */
export interface McpConnectionTester {
  testStdio(command: string, args: string[], env: Record<string, string>): Promise<unknown>;
  testWebSocket(url: string): Promise<unknown>;
  testSse(endpoint: string): Promise<unknown>;
  testHttp(endpoint: string): Promise<unknown>;
  testStreamableHttp(url: string): Promise<unknown>;
}

export interface McpToolExecutorDeps {
  settings(): SettingsStore;
  events(): BackendEvents;
  /** `null` = build without MCP probes (Rust `#[cfg(not(feature = "mcp"))]`). */
  tester(): McpConnectionTester | null;
  warn(message: string): void;
}

export type McpProbes = Pick<typeof import('../../../mcp/api.ts'),
  'testStdio' | 'testSse' | 'testHttp' | 'testWebSocket' | 'testStreamableHttpRmcp'>;

/** mcp_propose_executor.rs:150–190 probe arguments: no cwd/framing, no-op progress, no api key or headers. */
export function createMcpConnectionTester(probes: McpProbes,
  log: (level: 'info' | 'warn' | 'error', message: string) => void): McpConnectionTester {
  return {
    testStdio: (command, args, env) => probes.testStdio(command, args, env, null, null, () => undefined, log),
    testWebSocket: url => probes.testWebSocket(url),
    testSse: endpoint => probes.testSse(endpoint, null, null, log),
    testHttp: endpoint => probes.testHttp(endpoint, null, null, log),
    testStreamableHttp: url => probes.testStreamableHttpRmcp(url, null),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** mcp_propose_executor.rs `run_connection_test`; placeholders never reach the child env. */
export async function runConnectionTest(tester: McpConnectionTester | null, transport: McpTransport,
  entry: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (tester === null) return { success: false, error: 'MCP 功能未启用（当前构建未包含 mcp feature）' };
  const str = (key: string) => typeof entry[key] === 'string' ? entry[key] as string : '';
  let probe: Promise<unknown>;
  if (transport === 'stdio') {
    const args = Array.isArray(entry.args) ? entry.args.filter((item): item is string => typeof item === 'string') : [];
    const env = Object.fromEntries(Object.entries(asRecord(entry.env))
      .filter((pair): pair is [string, string] => typeof pair[1] === 'string' && pair[1] !== ENV_PLACEHOLDER));
    probe = tester.testStdio(str('command'), args, env);
  } else if (transport === 'websocket') probe = tester.testWebSocket(str('url'));
  else if (transport === 'sse') probe = tester.testSse(str('url'));
  else if (transport === 'http') probe = tester.testHttp(str('url'));
  else probe = tester.testStreamableHttp(str('url'));
  const seconds = transport === 'stdio' ? STDIO_TEST_TIMEOUT_SECS : REMOTE_TEST_TIMEOUT_SECS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Record<string, unknown>>(resolve => {
    timer = setTimeout(() => resolve({ success: false, error: `connection test timed out after ${seconds}s` }), seconds * 1000);
  });
  try { return await Promise.race([probe.then(asRecord), timeout]); }
  finally { clearTimeout(timer); }
}

function bindDependencies(deps: McpToolExecutorDeps) {
  return {
    readList: () => readMcpToolsList(deps.settings()),
    writeList: (list: readonly unknown[]) => writeMcpToolsList(deps.settings(), list),
    getSetting: async (key: string) => deps.settings().get(key),
    saveSetting: async (key: string, value: string) => {
      try { deps.settings().save(key, value); }
      catch (error) { throw new Error(`failed to write provenance: ${errorText(error)}`); }
    },
    deleteSetting: async (key: string) => {
      try { deps.settings().delete(key); }
      catch (error) { throw new Error(`failed to delete proposal provenance: ${errorText(error)}`); }
    },
    runConnectionTest: (transport: McpTransport, entry: Record<string, unknown>) => runConnectionTest(deps.tester(), transport, entry),
    emitListChanged: (action: string) => { emitMcpListChanged(deps.events(), action); },
    warn: deps.warn,
  };
}

async function envelope(executor: string, call: ToolCall, ctx: ExecutionContext, warn: (message: string) => void,
  run: () => Promise<unknown>): Promise<ToolResultInfo> {
  const start = Date.now();
  ctx.emitToolCallStart(call.name, call.arguments, call.id);
  let result: ToolResultInfo;
  try {
    const output = await run();
    const durationMs = Date.now() - start;
    ctx.emitToolCallEnd({ result: output, durationMs });
    result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, output, success: true, durationMs };
  } catch (error) {
    const durationMs = Date.now() - start;
    const message = errorText(error);
    ctx.emitToolCallError(message);
    result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments,
      output: null, success: false, error: message, durationMs };
  }
  try { ctx.saveToolBlock(result); }
  catch (error) { warn(`[${executor}] Failed to save tool block: ${errorText(error)}`); }
  return result;
}

export class McpProposeToolExecutor implements ToolExecutor {
  private readonly core = new McpProposeExecutor();
  private readonly deps: McpToolExecutorDeps;
  constructor(deps: McpToolExecutorDeps) { this.deps = deps; }

  name(): string { return this.core.name(); }
  /** Rust strips only `builtin-`. */
  canHandle(toolName: string): boolean {
    return toolName === 'mcp_server_propose' || toolName === 'builtin-mcp_server_propose';
  }
  sensitivityLevel(): 'high' { return 'high'; }

  execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    return envelope(this.name(), call, ctx, this.deps.warn, async () =>
      this.core.executeProposal(parseProposeInput(call.arguments), { sessionId: ctx.session_id }, bindDependencies(this.deps)));
  }
}

export class McpManageToolExecutor implements ToolExecutor {
  private readonly core = new McpManageExecutor();
  private readonly deps: McpToolExecutorDeps;
  constructor(deps: McpToolExecutorDeps) { this.deps = deps; }

  name(): string { return this.core.name(); }
  canHandle(toolName: string): boolean { return this.core.canHandle(toolName); }
  sensitivityLevel(toolName: string): 'medium' | 'high' { return this.core.sensitivityLevel(toolName); }

  execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    return envelope(this.name(), call, ctx, this.deps.warn, async () => {
      const short = McpManageExecutor.shortName(call.name);
      const context = { sessionId: ctx.session_id };
      const bound = bindDependencies(this.deps);
      if (short === MCP_SERVER_UPDATE) return this.core.executeUpdate(call.arguments, context, bound);
      if (short === MCP_SERVER_SET_ENABLED) return this.core.executeSetEnabled(call.arguments, context, bound);
      if (short === MCP_SERVER_REMOVE) return this.core.executeRemove(call.arguments, context, bound);
      throw new Error(`Unsupported MCP manage tool: ${short}`);
    });
  }
}
