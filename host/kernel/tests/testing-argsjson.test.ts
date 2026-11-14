/**
 * V08-02：TestHost.invoke 对 JSON 安全的参数默认像 Electron main 一样带 `argsJson`，插件测试走生产解码路径；
 * 非 JSON 参数（字节、bigint、undefined 值、Date…）退回对象路径；`invokeRaw` / `{ exactJson: false }` 显式走旧路径。
 */
import { afterEach, expect, it } from 'vitest';
import { createTestHost, definePlugin, type TestHost } from '../testing.ts';
import type { LaneContract } from '../contract.ts';

const contract: LaneContract = {
  lane: 'F1-fixture', generator: 'hand-written V08-02 fixture', events: [], $defs: {},
  commands: [{
    name: 'fixture_test_host_path', lane: 'F1-fixture', async: true, frontend: 'none',
    rust: { file: 'fixture.rs', line: 1, fn: 'fixture_test_host_path' }, injected: [{ kind: 'request' }],
    args: [
      { key: 'count', rustName: 'count', optional: true, schema: { anyOf: [{ type: 'integer', 'x-int': 'u64', minimum: 0 }, { type: 'null' }] } },
      { key: 'value', rustName: 'value', optional: true, schema: { 'x-rust': 'serde_json::Value' } },
    ],
    result: { type: 'boolean' },
  }],
};

let host: TestHost | undefined;
afterEach(async () => {
  await host?.dispose();
  host = undefined;
});

async function boot() {
  const exact: boolean[] = [];
  host = await createTestHost({
    contracts: { only: [contract] },
    plugins: [definePlugin({
      meta: { id: 'fixture.test-host-path', commands: ['fixture_test_host_path'] },
      apply(ctx) {
        ctx.commands.register('fixture_test_host_path', (_args, call) => {
          // 只有带 argsJson 的调用，exactPayload() 才会把 0.5 保留成 rawJSON 原子。
          const seen = (call.exactPayload!() as { value?: { ratio?: unknown } }).value?.ratio;
          exact.push(typeof seen === 'object' && seen !== null);
          return true;
        });
      },
    })],
  });
  return { host, exact };
}

const INVALID_NUMBER = 'invalid args `count` for command `fixture_test_host_path`: invalid number';

it('V08-02: host.invoke sends JSON-safe args as argsJson, so typed integer errors are the production serde texts', async () => {
  const { host, exact } = await boot();
  await expect(host.invoke('fixture_test_host_path', { count: 1.5 })).rejects.toBe(INVALID_NUMBER);
  await expect(host.invoke('fixture_test_host_path', { count: 1e21 })).rejects.toBe(INVALID_NUMBER);
  await expect(host.invoke('fixture_test_host_path', { count: 7, value: { ratio: 0.5 } })).resolves.toBe(true);
  expect(exact).toEqual([true]);
});

it('V08-02: non-JSON args fall back to the object path instead of throwing', async () => {
  const { host, exact } = await boot();
  const settle = (promise: Promise<unknown>) => promise.then(value => ({ value }), (error: unknown) => ({ error }));
  const big = { count: 7n, value: { ratio: 0.5 } };
  expect(await settle(host.invoke('fixture_test_host_path', big))).toEqual(await settle(host.invokeRaw('fixture_test_host_path', big)));
  await expect(host.invoke('fixture_test_host_path', { count: 7, value: { ratio: 0.5, gone: undefined } })).resolves.toBe(true);
  await expect(host.invoke('fixture_test_host_path', { count: 7, value: { ratio: 0.5, at: new Date(0) } })).resolves.toBe(true);
  expect(exact).toEqual([false, false]);
});

it('V08-02: invokeRaw and { exactJson: false } keep the legacy object path', async () => {
  const { host, exact } = await boot();
  await expect(host.invokeRaw('fixture_test_host_path', { count: 1.5 })).rejects.not.toBe(INVALID_NUMBER);
  await expect(host.invoke('fixture_test_host_path', { count: 7, value: { ratio: 0.5 } }, undefined, { exactJson: false })).resolves.toBe(true);
  await expect(host.invokeRaw('fixture_test_host_path', { count: 7, value: { ratio: 0.5 } })).resolves.toBe(true);
  expect(exact).toEqual([false, false]);
});
