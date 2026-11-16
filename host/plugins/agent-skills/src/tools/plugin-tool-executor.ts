/**
 * Executor for agent tools declared by community / workshop plugins (manifest `agentTools`,
 * `docs/plugins/SDK.md` §3.4). No Rust counterpart: Rust had no community plugins.
 *
 * The kernel (`host/kernel/plugin-agent-tools.ts`) lists the tools of currently loaded plugins and runs a
 * handler under its plugin's execution identity. This executor is the policy side:
 *
 * - it answers only for the exact `plugin_<digest>_<name>` names the kernel lists right now, so a plugin can
 *   neither claim a built-in or MCP tool name nor keep a tool after it is disabled or uninstalled;
 * - sensitivity is never `low`: every call goes through the same approval gate as other medium / high tools;
 * - the handler gets a JSON copy of the arguments, an abort signal and a `fetch` limited to HTTPS GET on the
 *   hosts the manifest declares (`net:<host>`), through the pinned public transport;
 * - results must be plain JSON and are clipped by the registry's result budget;
 * - the model gets the result inside a data boundary (`externalDataBoundary`): what a plugin read from outside is data,
 *   not instructions, and the turn is marked so the approval gate asks before any high-sensitivity call after it (F17).
 */
import type { ExecutionContext, ToolCall, ToolResultInfo } from '../../../chat/api.ts';
import type {
  PluginAgentTool, PluginAgentToolContext, PluginAgentToolFetchResult, PluginAgentTools,
} from '../../../../kernel/plugin-agent-tools.ts';
import type { HttpService } from '../../../../platform/http/api.ts';
import type { AgentSchemaTool, AgentToolConcurrency, AgentToolExecutor, AgentToolSensitivity } from './executor-registry.ts';
import { externalDataBoundary, markExternalPluginData } from './external-data-taint.ts';

export const PLUGIN_AGENT_TOOL_EXECUTOR_NAME = 'PluginAgentToolExecutor';
/** Response body cap for a tool's `fetch` (bytes). A calendar or a small JSON document fits; a download does not. */
export const PLUGIN_TOOL_FETCH_MAX_BYTES = 1024 * 1024;
/** Redirect hops a tool's `fetch` follows; every hop must stay on a declared host. */
export const PLUGIN_TOOL_FETCH_MAX_REDIRECTS = 3;
/** Whole-request timeout of one `fetch` (ms), including the body. */
export const PLUGIN_TOOL_FETCH_TIMEOUT_MS = 20_000;
/** Requests one tool call may make. */
export const PLUGIN_TOOL_FETCH_MAX_REQUESTS = 8;

export interface PluginToolExecutorDeps {
  /** Kernel listing; absent on hosts without it (the executor then offers nothing). */
  tools(): PluginAgentTools | null;
  http(): Pick<HttpService, 'fetchBytes'> | null;
  warn(message: string): void;
}

/** Why a URL is refused, or null when the tool may read it. Exported for tests. */
export function pluginToolUrlProblem(raw: unknown, hosts: readonly string[]): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return 'url must be a non-empty string of at most 2048 characters';
  let url: URL;
  try { url = new URL(raw); } catch { return 'url is not a valid absolute URL'; }
  if (url.protocol !== 'https:') return 'only https: URLs are allowed';
  if (url.username !== '' || url.password !== '') return 'URLs with credentials are not allowed';
  if (url.port !== '') return 'URLs with an explicit port are not allowed';
  // WHATWG URL already lower-cases and IDNA-encodes the host; the manifest stores lower-case ASCII names.
  if (!hosts.includes(url.hostname)) return `host "${url.hostname}" is not declared by the plugin (declared: ${hosts.length ? hosts.join(', ') : 'none'})`;
  return null;
}

/** The `fetch` handed to one tool call. Exported for tests. */
export function pluginToolFetch(tool: Pick<PluginAgentTool, 'netHosts' | 'pluginId'>, http: Pick<HttpService, 'fetchBytes'> | null,
  signal: AbortSignal): PluginAgentToolContext['fetch'] {
  let requests = 0;
  return async (raw: string): Promise<PluginAgentToolFetchResult> => {
    let current = raw;
    for (let hop = 0; ; hop++) {
      const problem = pluginToolUrlProblem(current, tool.netHosts);
      if (problem !== null) throw new Error(`PLUGIN_TOOL_NET_DENIED: ${problem}`);
      if (http === null) throw new Error('PLUGIN_TOOL_NET_UNAVAILABLE: this host has no HTTP service');
      if (++requests > PLUGIN_TOOL_FETCH_MAX_REQUESTS) throw new Error(`PLUGIN_TOOL_NET_DENIED: more than ${PLUGIN_TOOL_FETCH_MAX_REQUESTS} requests in one tool call`);
      // public-pinned: the transport resolves the host, refuses private / link-local / metadata addresses and
      // connects to the address it checked. The Host transport keeps no cookie jar and adds no credentials.
      const response = await http.fetchBytes(current, {
        method: 'GET', destination: 'public-pinned', redirect: 'manual', signal, timeoutMs: PLUGIN_TOOL_FETCH_TIMEOUT_MS,
        maxBytes: PLUGIN_TOOL_FETCH_MAX_BYTES, headers: { accept: 'text/calendar, application/json, text/*;q=0.8, */*;q=0.1' },
      });
      const location = response.headers.location;
      if (response.status >= 300 && response.status < 400 && location !== undefined) {
        if (hop >= PLUGIN_TOOL_FETCH_MAX_REDIRECTS) throw new Error(`PLUGIN_TOOL_NET_DENIED: more than ${PLUGIN_TOOL_FETCH_MAX_REDIRECTS} redirects`);
        current = new URL(location, current).href;
        continue;
      }
      return Object.freeze({
        status: response.status, ok: response.ok, contentType: response.headers['content-type'] ?? null,
        text: new TextDecoder('utf-8').decode(response.bytes),
      });
    }
  };
}

export class PluginAgentToolExecutor implements AgentToolExecutor {
  private readonly deps: PluginToolExecutorDeps;
  constructor(deps: PluginToolExecutorDeps) { this.deps = deps; }

  private list(): readonly PluginAgentTool[] {
    try { return this.deps.tools()?.list() ?? []; }
    catch (error) {
      this.deps.warn(`[PluginAgentToolExecutor] cannot list plugin tools: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }
  private find(name: string): PluginAgentTool | undefined { return this.list().find(tool => tool.qualifiedName === name); }

  name(): string { return PLUGIN_AGENT_TOOL_EXECUTOR_NAME; }
  /** Exact, currently listed names only: no prefix match, no `builtin-` alias. */
  canHandle(name: string): boolean { return this.find(name) !== undefined; }
  sensitivityLevel(name: string): AgentToolSensitivity { return this.find(name)?.sensitivity === 'high' ? 'high' : 'medium'; }
  concurrencyClass(): AgentToolConcurrency { return 'serial'; }

  schemaTools(): AgentSchemaTool[] {
    return this.list().map(tool => ({ id: tool.qualifiedName, schema: { type: 'function', function: {
      name: tool.qualifiedName,
      // The model sees who provides the tool; the plugin's own text cannot pose as a built-in capability.
      description: `[用户插件「${tool.pluginTitle}」提供的工具「${tool.title}」] ${tool.description}`,
      parameters: tool.parameters,
    } } }));
  }
  /** Offered in every conversation without the front end listing them (it does not know user plugins' tools). */
  ambientSchemaToolIds(): string[] { return this.list().map(tool => tool.qualifiedName); }

  async execute(rawCall: unknown, rawContext: unknown): Promise<ToolResultInfo> {
    const call = rawCall as ToolCall, ctx = rawContext as ExecutionContext;
    const started = performance.now();
    ctx.emitToolCallStart(call.name, call.arguments, call.id);
    const base = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments };
    try {
      const tool = this.find(call.name), tools = this.deps.tools();
      if (tool === undefined || tools === null) throw new Error(`PLUGIN_TOOL_UNAVAILABLE: no enabled plugin offers the tool "${call.name}"`);
      const signal = ctx.cancellation_token ?? new AbortController().signal;
      const output = await tools.call(tool.qualifiedName, call.arguments, { signal, fetch: pluginToolFetch(tool, this.deps.http(), signal) });
      ctx.emitToolCallEnd(output);
      markExternalPluginData(ctx.session_id, ctx.message_id, tool.pluginTitle);
      // The card shows the plugin's own result; the model reads it inside the data boundary.
      const bounded = { notice: externalDataBoundary(tool.pluginTitle), plugin: tool.pluginTitle, tool: tool.title, data: output };
      return { ...base, output: bounded, success: true, durationMs: Math.trunc(performance.now() - started) } as ToolResultInfo;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.emitToolCallError(message);
      return { ...base, output: null, success: false, error: message, durationMs: Math.trunc(performance.now() - started) } as ToolResultInfo;
    }
  }
}
