/**
 * 社区 / 工坊插件给智能体新增的工具（清单 `agentTools`，`docs/plugins/SDK.md` §3.4）。
 *
 * 这里只做三件事：按清单与当前运行状态列出工具、给每个工具派生一个不会与内置工具或 MCP 工具同名的名字、
 * 在插件自己的执行身份下调用它的处理方法。审批、敏感度、超时、联网策略都不在内核里：它们属于注册执行器的
 * 官方插件（`host/plugins/agent-skills/src/tools/plugin-tool-executor.ts`）和对话管线。
 *
 * 列表每次从 `HostRuntime` 的已安装插件现算，没有单独的注册表：插件停用或卸载后工具随之消失，
 * 重启后只要插件仍被装载就重新出现。
 *
 * 可移植：不依赖 Node 内建模块。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { findNonJson } from './json.ts';
import { FIBER_ACTIVE, assertKernelSurface, type InstalledPlugin, type KernelState } from './kernel.ts';
import { grantedNetHosts, type PluginAgentToolDeclaration } from './manifest.ts';
import { pluginServiceName } from './plugin-id.ts';
import type { PluginAgentToolContext } from './plugin-agent-tool-context.ts';
export type { PluginAgentToolContext, PluginAgentToolFetchResult } from './plugin-agent-tool-context.ts';

/** 模型看到的插件工具名前缀。内置工具没有这个前缀，外部 MCP 工具是 `mcp_` / `mcp.tools.`。 */
export const PLUGIN_AGENT_TOOL_PREFIX = 'plugin_';

/** FNV-1a 64 位（十六进制）。只用来把插件 id 缩成固定长度的名字段，不是安全摘要。 */
function fnv1a64Hex(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * 插件工具在模型工具面与对话记录里的名字：`plugin_<id 摘要 12 位>_<name>`。只含 `[a-z0-9_]`，最长 52 个字符，
 * 满足各家模型对函数名的限制；同一插件 id 的摘要不变，所以重启、升级后历史对话里的工具块仍对得上。
 */
export function pluginAgentToolName(pluginId: string, toolName: string): string {
  return `${PLUGIN_AGENT_TOOL_PREFIX}${fnv1a64Hex(pluginId).slice(0, 12)}_${toolName}`;
}

/** 名字是否是插件工具的形状（不代表该工具当前可用）。 */
export function isPluginAgentToolName(name: string): boolean {
  return /^plugin_[0-9a-f]{12}_[a-z][a-z0-9_]{1,31}$/.test(name);
}

/** 一个当前可调用的插件工具。 */
export interface PluginAgentTool extends PluginAgentToolDeclaration {
  /** 模型工具面上的名字（{@link pluginAgentToolName}）。 */
  readonly qualifiedName: string;
  readonly pluginId: string;
  /** 插件的展示名（清单 `displayName`），没有时为插件 id。 */
  readonly pluginTitle: string;
  /** 清单 `net:<主机名>` 授予的主机；工具上下文的 `fetch` 只放行它们。 */
  readonly netHosts: readonly string[];
}


export interface PluginAgentTools {
  /** 当前可调用的插件工具（安装顺序）。 */
  list(): readonly PluginAgentTool[];
  /** 在所属插件的执行身份下调用；参数与返回值必须是纯 JSON。工具不存在或插件已停用时抛错。 */
  call(qualifiedName: string, args: unknown, context: PluginAgentToolContext): Promise<unknown>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 内核：社区插件声明的智能体工具。只给官方插件用（社区插件 `KERNEL_API_FORBIDDEN`）。 */
    pluginAgentTools: PluginAgentTools;
  }
}

interface ResolvedTool {
  tool: PluginAgentTool;
  entry: InstalledPlugin;
  service: Record<string, unknown>;
}

export class PluginAgentToolsService extends Service implements PluginAgentTools {
  private readonly kernel: KernelState;
  private readonly plugins: () => readonly InstalledPlugin[];
  private readonly reported = new Set<string>();

  constructor(ctx: Context, kernel: KernelState, plugins: () => readonly InstalledPlugin[]) {
    super(ctx, 'pluginAgentTools');
    this.kernel = kernel;
    this.plugins = plugins;
  }

  private warnOnce(key: string, message: string): void {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.kernel.root.logger('host').warn(message);
  }

  private resolve(): ResolvedTool[] {
    const resolved: ResolvedTool[] = [];
    const taken = new Set<string>();
    for (const entry of this.plugins()) {
      const declared = entry.manifest?.agentTools ?? [];
      // 只认经清单筛查装载的社区插件：官方插件直接向 agentTools 登记执行器，不走这条路。
      if (!declared.length || entry.packageRoot === undefined || entry.manifest === undefined) continue;
      if ((entry.fiber.state as number) !== FIBER_ACTIVE) continue;
      const serviceName = pluginServiceName(entry.id);
      if (!(entry.plugin.meta.provides ?? []).includes(serviceName)) {
        this.warnOnce(`${entry.id}@${entry.manifest.version}:service`, `[host] plugin "${entry.id}" declares agentTools but does not provide its primary service "${serviceName}"; its tools are not offered`);
        continue;
      }
      const service = this.kernel.root.get(serviceName) as Record<string, unknown> | undefined;
      if (service === undefined || service === null) continue;
      const netHosts = Object.freeze(grantedNetHosts(entry.manifest));
      for (const declaration of declared) {
        const qualifiedName = pluginAgentToolName(entry.id, declaration.name);
        if (typeof service[declaration.name] !== 'function') {
          this.warnOnce(`${entry.id}@${entry.manifest.version}:${declaration.name}`, `[host] plugin "${entry.id}" declares agent tool "${declaration.name}" but service "${serviceName}" has no such method; the tool is not offered`);
          continue;
        }
        if (taken.has(qualifiedName)) {
          this.warnOnce(`${qualifiedName}:${entry.id}`, `[host] agent tool name "${qualifiedName}" of plugin "${entry.id}" collides with an earlier plugin; the tool is not offered`);
          continue;
        }
        taken.add(qualifiedName);
        resolved.push({ entry, service, tool: Object.freeze({ ...declaration, qualifiedName, pluginId: entry.id,
          pluginTitle: entry.manifest.displayName ?? entry.id, netHosts }) });
      }
    }
    return resolved;
  }

  list(): readonly PluginAgentTool[] {
    assertKernelSurface(this.kernel, this.ctx.fiber, 'ctx.pluginAgentTools.list');
    return this.resolve().map(item => item.tool);
  }

  async call(qualifiedName: string, args: unknown, context: PluginAgentToolContext): Promise<unknown> {
    assertKernelSurface(this.kernel, this.ctx.fiber, 'ctx.pluginAgentTools.call');
    const target = this.resolve().find(item => item.tool.qualifiedName === qualifiedName);
    if (!target) throw new Error(`PLUGIN_TOOL_UNAVAILABLE: no enabled plugin offers the tool "${qualifiedName}"`);
    const input = args === undefined || args === null ? {} : args;
    if (typeof input !== 'object' || Array.isArray(input)) throw new Error('PLUGIN_TOOL_INVALID_ARGUMENTS: tool arguments must be a JSON object');
    const problem = findNonJson(input);
    if (problem) throw new Error(`PLUGIN_TOOL_INVALID_ARGUMENTS: tool arguments are not plain JSON: ${problem}`);
    const handler = target.service[target.tool.name] as (args: unknown, tool: PluginAgentToolContext) => unknown;
    // 插件拿到的是参数的副本和冻结的窄上下文：没有执行上下文、会话、事件发射器或其他宿主对象。
    const invoke = () => handler.call(target.service, structuredClone(input), Object.freeze({ signal: context.signal, fetch: context.fetch }));
    const value = await (this.kernel.execution ? this.kernel.execution.run(target.entry.fiber, invoke) : invoke());
    const output = value === undefined ? null : value;
    const outputProblem = findNonJson(output);
    if (outputProblem) throw new Error(`PLUGIN_TOOL_INVALID_RESULT: tool "${target.tool.name}" of plugin "${target.entry.id}" returned a value that is not plain JSON: ${outputProblem}`);
    return output;
  }
}
