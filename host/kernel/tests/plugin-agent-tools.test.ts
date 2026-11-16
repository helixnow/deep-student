/**
 * 社区 / 工坊插件给智能体新增工具（清单 `agentTools`，`docs/plugins/SDK.md` §3.4）：清单规则、内核的列表与调用、
 * 插件停用后工具消失、社区插件自己不能读取或调用这张表。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { definePlugin, type HostPlugin } from '../api.ts';
import { KERNEL_ONLY_SERVICES } from '../kernel.ts';
import { checkManifest, checkPluginModule, grantedNetHosts, type PluginManifest } from '../manifest.ts';
import { isPluginAgentToolName, pluginAgentToolName, type PluginAgentToolContext } from '../plugin-agent-tools.ts';
import { createTestHost, type TestHost } from '../testing.ts';

const ID = 'alice.timetable';
const PACKAGE_ROOT = '/opt/community/alice.timetable';
const TOOL = { name: 'lookup_timetable', title: '查课表', description: '读取教务日历，返回某一天的课程。' };

function pkg(ds: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'deepstudent-plugin-timetable', version: '1.0.0', engines: { deepStudent: '>=0.20.0 <1.0.0' },
    deepStudent: { manifestVersion: 1, id: ID, platforms: ['desktop'], host: './index.ts',
      permissions: ['agent:tools', 'net:calendar.example.edu.cn'], agentTools: [TOOL], ...ds },
  };
}
const screen = (value: Record<string, unknown>) => checkManifest(value, { appVersion: '0.20.1', context: 'community-install', platform: 'desktop' });
function manifest(ds: Record<string, unknown> = {}): PluginManifest {
  const result = screen(pkg(ds));
  if (!result.ok) throw result.error;
  return result.manifest;
}
const reason = (ds: Record<string, unknown>) => {
  const result = screen(pkg(ds));
  return result.ok ? 'ok' : result.error.message;
};

let host: TestHost | null = null;
afterEach(async () => {
  await host?.dispose();
  host = null;
});

const context = (fetch: PluginAgentToolContext['fetch'] = async () => { throw new Error('no network in this test'); }): PluginAgentToolContext =>
  ({ signal: new AbortController().signal, fetch });

function timetablePlugin(seen: unknown[] = [], service: Record<string, unknown> = {}): HostPlugin {
  return definePlugin({
    meta: { id: ID, version: '1.0.0', provides: ['aliceTimetable'] },
    apply(ctx) {
      ctx.provide('aliceTimetable', {
        async lookup_timetable(args: { date?: string }, tool: PluginAgentToolContext) {
          seen.push({ args, keys: Object.keys(tool).sort(), frozen: Object.isFrozen(tool) });
          const response = await tool.fetch('https://calendar.example.edu.cn/timetable.ics');
          return { date: args.date ?? 'today', body: response.text };
        },
        ...service,
      });
    },
  });
}

describe('manifest: agentTools and the agent / net permission kinds', () => {
  it('accepts a declared tool, fills defaults and exposes the granted hosts', () => {
    const value = manifest();
    expect(value.agentTools).toEqual([{ ...TOOL, parameters: { type: 'object', properties: {}, additionalProperties: false }, sensitivity: 'medium' }]);
    expect(grantedNetHosts(value)).toEqual(['calendar.example.edu.cn']);
    expect(manifest({ agentTools: [{ ...TOOL, sensitivity: 'high' }] }).agentTools![0]!.sensitivity).toBe('high');
    // 没有声明工具的清单与以前一样。
    expect(manifest({ permissions: ['service:storage'], agentTools: undefined }).agentTools).toEqual([]);
  });

  it('requires the declaration and the permission together, and a Host half to run the tool', () => {
    expect(reason({ permissions: ['net:calendar.example.edu.cn'] })).toContain('MANIFEST_INVALID: /deepStudent/agentTools requires the "agent:tools" permission');
    expect(reason({ agentTools: undefined, permissions: ['agent:tools'] })).toContain('declares "agent:tools" without /deepStudent/agentTools');
    expect(reason({ host: undefined, ui: './dist/ui.js' })).toContain('requires a "host" entry');
    expect(reason({ agentTools: undefined, permissions: ['net:calendar.example.edu.cn'] })).toContain('network access is only available to agent tools');
  });

  it('rejects names that could shadow object members, duplicates, low sensitivity and non-object parameters', () => {
    expect(reason({ agentTools: [TOOL, TOOL] })).toContain('/deepStudent/agentTools/1/name duplicates "lookup_timetable"');
    expect(reason({ agentTools: [{ ...TOOL, name: 'constructor' }] })).toContain('"constructor" is reserved');
    expect(reason({ agentTools: [{ ...TOOL, name: 'then' }] })).toContain('"then" is reserved');
    for (const name of ['Lookup', 'lookup-timetable', '_private', 'a', 'web_search '.trim() + '!']) {
      expect(reason({ agentTools: [{ ...TOOL, name }] }), name).toContain('MANIFEST_INVALID');
    }
    expect(reason({ agentTools: [{ ...TOOL, sensitivity: 'low' }] })).toContain('MANIFEST_INVALID');
    expect(reason({ agentTools: [{ ...TOOL, parameters: { type: 'string' } }] })).toContain('MANIFEST_INVALID');
    expect(reason({ agentTools: [{ ...TOOL, parameters: { type: 'object', description: 'x'.repeat(5000) } }] })).toContain('/parameters exceeds 4096 characters');
    expect(reason({ agentTools: [{ ...TOOL, handler: 'x' }] })).toContain('unknown field "handler"');
  });

  it('accepts only exact lower-case public host names for net, and still refuses unknown kinds', () => {
    for (const host of ['*.example.edu.cn', 'localhost', '10.0.0.1', '127.0.0.1', 'Example.edu.cn', 'example.edu.cn:8443', 'example.edu.cn/path', '[::1]']) {
      expect(reason({ permissions: ['agent:tools', `net:${host}`] }), host).toContain('MANIFEST_INVALID');
    }
    expect(reason({ permissions: ['agent:tools', 'agent:everything'] })).toContain('MANIFEST_INVALID');
    expect(reason({ permissions: ['agent:tools', 'network:example.com'] }))
      .toBe('PERMISSION_UNKNOWN_KIND: unknown permission kind in "network:example.com" (v1 knows "service", "net", "agent")');
  });

  it('does not let full trust skip service declarations for a plugin that declares tools', () => {
    const plugin = definePlugin({ meta: { id: ID, version: '1.0.0', provides: ['aliceTimetable'] }, inject: ['notes'], apply() {} });
    expect(checkPluginModule({ ...manifest(), trust: 'full' }, plugin)?.message)
      .toBe('PERMISSION_UNDECLARED: injects "notes" without declaring "service:notes" in deepStudent.permissions');
    expect(checkPluginModule({ ...manifest({ permissions: ['agent:tools', 'service:notes'] }), trust: 'full' }, plugin)).toBeNull();
    // 没有工具的完全信任插件保持原行为。
    expect(checkPluginModule({ ...manifest({ agentTools: undefined, permissions: [] }), trust: 'full' }, plugin)).toBeNull();
  });
});

describe('kernel: listing and calling plugin tools', () => {
  it('derives a stable name that cannot collide with built-in or MCP tool names', () => {
    const name = pluginAgentToolName(ID, 'lookup_timetable');
    expect(name).toMatch(/^plugin_[0-9a-f]{12}_lookup_timetable$/);
    expect(name).toBe(pluginAgentToolName(ID, 'lookup_timetable'));
    expect(name).not.toBe(pluginAgentToolName('alice.timetable2', 'lookup_timetable'));
    expect(isPluginAgentToolName(name)).toBe(true);
    for (const other of ['web_search', 'builtin-web_search', 'mcp_lookup_timetable', 'dstu_plugin_status', 'plugin_lookup_timetable']) {
      expect(isPluginAgentToolName(other), other).toBe(false);
    }
    // 最长的 id 与工具名也在各家模型的函数名长度限制（64）之内。
    expect(pluginAgentToolName(ID, `a${'b'.repeat(31)}`).length).toBeLessThanOrEqual(64);
  });

  it('lists the tools of a loaded community plugin and runs the handler with a narrow context', async () => {
    host = await createTestHost();
    const seen: unknown[] = [];
    const installed = await host.runtime.installIsolated({ plugin: timetablePlugin(seen), packageRoot: PACKAGE_ROOT, manifest: manifest({ displayName: '课表' }) });
    expect(installed.ok).toBe(true);
    const tools = host.ctx.get('pluginAgentTools')!;
    const qualified = pluginAgentToolName(ID, 'lookup_timetable');
    expect(tools.list()).toEqual([expect.objectContaining({
      qualifiedName: qualified, pluginId: ID, pluginTitle: '课表', name: 'lookup_timetable', title: '查课表',
      sensitivity: 'medium', netHosts: ['calendar.example.edu.cn'],
    })]);
    const args = { date: '2026-11-16' };
    const output = await tools.call(qualified, args, { ...context(async url => ({ status: 200, ok: true, contentType: 'text/calendar', text: `ics from ${url}` })), extra: 'ambient' } as PluginAgentToolContext);
    expect(output).toEqual({ date: '2026-11-16', body: 'ics from https://calendar.example.edu.cn/timetable.ics' });
    // 插件拿到的是参数副本和只有 signal / fetch 的冻结上下文：调用方多放的东西不会传进去。
    expect(seen).toEqual([{ args: { date: '2026-11-16' }, keys: ['fetch', 'signal'], frozen: true }]);
    expect(host.runtime.uiManifestV2().plugins.find(plugin => plugin.id === ID)?.agentTools).toEqual([{ name: qualified, title: '查课表' }]);
  });

  it('rejects arguments and results that are not plain JSON, and unknown tools', async () => {
    host = await createTestHost();
    await host.runtime.installIsolated({ plugin: timetablePlugin([], { lookup_timetable: () => ({ when: new Date() }) }), packageRoot: PACKAGE_ROOT, manifest: manifest() });
    const tools = host.ctx.get('pluginAgentTools')!;
    const qualified = pluginAgentToolName(ID, 'lookup_timetable');
    await expect(tools.call(qualified, {}, context())).rejects.toThrow('PLUGIN_TOOL_INVALID_RESULT');
    await expect(tools.call(qualified, [1], context())).rejects.toThrow('PLUGIN_TOOL_INVALID_ARGUMENTS: tool arguments must be a JSON object');
    await expect(tools.call(qualified, { f: () => 1 }, context())).rejects.toThrow('PLUGIN_TOOL_INVALID_ARGUMENTS');
    await expect(tools.call('web_search', {}, context())).rejects.toThrow('PLUGIN_TOOL_UNAVAILABLE');
  });

  it('offers nothing for a missing handler, an official plugin, or after the plugin is unloaded', async () => {
    host = await createTestHost();
    const tools = host.ctx.get('pluginAgentTools')!;
    // 声明了工具但主服务上没有同名方法。
    const missing = definePlugin({ meta: { id: ID, version: '1.0.0', provides: ['aliceTimetable'] }, apply(ctx) { ctx.provide('aliceTimetable', { other() { return 1; } }); } });
    await host.runtime.installIsolated({ plugin: missing, packageRoot: PACKAGE_ROOT, manifest: manifest() });
    expect(tools.list()).toEqual([]);
    await host.runtime.unload(ID);
    // 没有 packageRoot 的（官方）插件不走这条路。
    await host.runtime.installIsolated({ plugin: timetablePlugin(), manifest: manifest() });
    expect(tools.list()).toEqual([]);
    await host.runtime.unload(ID);

    await host.runtime.installIsolated({ plugin: timetablePlugin(), packageRoot: PACKAGE_ROOT, manifest: manifest() });
    expect(tools.list().map(tool => tool.name)).toEqual(['lookup_timetable']);
    await host.runtime.unload(ID);
    expect(tools.list()).toEqual([]);
    await expect(tools.call(pluginAgentToolName(ID, 'lookup_timetable'), {}, context())).rejects.toThrow('PLUGIN_TOOL_UNAVAILABLE');
    expect(host.runtime.uiManifestV2().plugins.some(plugin => plugin.agentTools !== undefined)).toBe(false);
  });

  it('is kernel-only: a community plugin can neither inject nor use the listing', async () => {
    expect(KERNEL_ONLY_SERVICES).toContain('pluginAgentTools');
    host = await createTestHost();
    await host.runtime.installIsolated({ plugin: timetablePlugin(), packageRoot: PACKAGE_ROOT, manifest: manifest() });
    const outcomes: string[] = [];
    let call: Promise<string> | undefined;
    const snoop = definePlugin({
      meta: { id: 'alice.snoop', version: '1.0.0' },
      apply(ctx) {
        try { outcomes.push(JSON.stringify(ctx.get('pluginAgentTools')!.list())); } catch (error) { outcomes.push((error as Error).message); }
        call = Promise.resolve().then(() => ctx.get('pluginAgentTools')!.call(pluginAgentToolName(ID, 'lookup_timetable'), {}, context()))
          .then(() => 'ok', (error: Error) => error.message);
      },
    });
    await host.runtime.installIsolated({ plugin: snoop, packageRoot: '/opt/community/alice.snoop' });
    expect(outcomes).toEqual(['KERNEL_API_FORBIDDEN: ctx.pluginAgentTools.list is not available to community plugins in plugin API v1']);
    await expect(call).resolves.toBe('KERNEL_API_FORBIDDEN: ctx.pluginAgentTools.call is not available to community plugins in plugin API v1');
    const injecting = definePlugin({ meta: { id: ID, version: '1.0.0' }, inject: ['pluginAgentTools'], apply() {} });
    expect(checkPluginModule({ ...manifest({ permissions: ['agent:tools', 'service:pluginAgentTools'] }), trust: 'full' }, injecting)?.message)
      .toContain('KERNEL_API_FORBIDDEN: injects kernel services "pluginAgentTools"');
  });
});
