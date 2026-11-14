import { afterEach, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { ErrorDetailsBuilder } from '../../../platform/errors/api.ts';
// boundary-allow cross-plugin-impl: L22 集成测试需安装真实 L19 MCP 插件与 webSearch 提供方，经其公开 ToolRegistry 验证工具分发
import browser from '../../browser/index.ts';
// boundary-allow cross-plugin-impl: 被测对象是 L19 发布的 mcp.registry
import mcp from '../../mcp/index.ts';
import type { ToolContext } from '../../mcp/api.ts';

/**
 * `tests/tools_integration_tests.rs` 中 3 条工具注册表用例与
 * `tests/mod.rs::integration::run_all_core_tests` 的 TS 行为级移植。
 *
 * 直接安装 L19 真实 browser（提供 webSearch）与 mcp（提供 mcp.registry）插件；
 * `session.selected_search_engines=serpapi` 且不提供 key，使 web_search 在
 * provider 配置检查处确定性失败，不发起网络请求。Rust 这 4 条用例本身不关心
 * 搜索结果，只验证注册表调用可返回 / 构造成功。
 */
const hosts: TestHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
});

function settingsStore(values: Map<string, string>) {
  return {
    get: (key: string) => values.get(key) ?? null,
    save: (key: string, value: string) => { values.set(key, value); },
    saveSecret: async () => undefined,
    getSecret: async () => null,
    deleteSecret: async () => undefined,
    listByPrefix: () => [],
    deleteByPrefix: () => 0,
  };
}

async function setup(namespacePrefix?: string): Promise<TestHost> {
  const values = new Map<string, string>([['session.selected_search_engines', 'serpapi']]);
  if (namespacePrefix !== undefined) values.set('mcp.tools.namespace_prefix', namespacePrefix);
  const host = await createTestHost({
    plugins: [browser, mcp],
    provide: {
      settings: settingsStore(values),
      storage: {},
      log: { logger: () => undefined },
      featureFlags: { load: () => ({ isFeatureEnabled: () => false }) },
      secrets: {
        openStore: () => ({
          saveSecret: async () => undefined,
          getSecret: async () => null,
          deleteSecret: async () => undefined,
        }),
      },
      llm: {},
    },
  });
  hosts.push(host);
  return host;
}

function toolContext(): ToolContext {
  return {
    supports_tools: true,
    mcp_client: null,
    stream_event: null,
    stage: 'test',
    memory_enabled: null,
  };
}

it('test_tool_registry_basic_operations', async () => {
  const host = await setup();
  const invocation = await host.ctx.mcp.registry.callTool(
    'web_search', { query: 'test' }, toolContext(),
  );
  expect(invocation).toHaveLength(6);
  expect(typeof invocation[0]).toBe('boolean');
});

it('test_tool_registry_namespace_functionality', async () => {
  const host = await setup('mcp_');
  const registry = host.ctx.mcp.registry;

  expect(registry.stripMcpNamespace('mcp_web_search')).toBe('web_search');

  const invocation = await registry.callTool('mcp_web_search', { query: 't' }, toolContext());
  expect(invocation).toHaveLength(6);
  expect(typeof invocation[0]).toBe('boolean');
});

it('test_tool_timeout_handling', async () => {
  const host = await setup();
  const started = Date.now();
  const invocation = await host.ctx.mcp.registry.callTool(
    'web_search', { query: 'test query' }, toolContext(),
  );
  expect(invocation).toHaveLength(6);
  expect(Date.now() - started).toBeLessThan(20_000);
});

it('run_all_core_tests', async () => {
  const error = ErrorDetailsBuilder.api_key_missing('Test');
  expect(error.code).toBe('API_KEY_MISSING');

  const host = await setup();
  expect(host.ctx.mcp.registry).toBeDefined();
  const invocation = await host.ctx.mcp.registry.callTool(
    'web_search', { query: 'test' }, toolContext(),
  );
  expect(invocation).toHaveLength(6);
});
