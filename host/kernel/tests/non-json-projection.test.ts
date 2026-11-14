/**
 * V08-10：生产环境（debug 关闭）不跑 `findNonJson`。命令结果、`CommandError` 值与事件载荷里的类实例、Map、Date、函数
 * 不再原样交给结构化克隆（函数会让 postMessage 抛 DataCloneError），而是按 `JSON.stringify` 投影成普通 JSON 并记告警；
 * 普通值、BigInt/rawJSON 路径与根上的字节不受影响。debug 下照旧拒绝。
 */
import { afterEach, expect, it } from 'vitest';
import type { LaneContract } from '../contract.ts';
import { CommandError } from '../error-model.ts';
import { createTestHost, definePlugin, type TestHost } from '../testing.ts';

const contract: LaneContract = {
  lane: 'F1-fixture', generator: 'hand-written V08-10 fixture', events: [], $defs: {},
  commands: [{
    name: 'fixture_non_plain', lane: 'F1-fixture', async: true, frontend: 'none',
    rust: { file: 'fixture.rs', line: 1, fn: 'fixture_non_plain' }, injected: [],
    args: [{ key: 'kind', rustName: 'kind', optional: false, schema: { type: 'string' } }],
    result: { 'x-rust': 'serde_json::Value' },
    error: { 'x-rust': 'serde_json::Value' },
  }],
};

class Point {
  constructor(readonly x: number, readonly y: number) {}
  norm(): number { return Math.hypot(this.x, this.y); }
}

class Decimal {
  constructor(readonly text: string) {}
  toJSON(): number { return Number(this.text); }
}

function nonPlain(): Record<string, unknown> {
  return {
    when: new Date(0),
    tags: new Set(['a']),
    map: new Map([['k', 1]]),
    point: new Point(3, 4),
    price: new Decimal('1.5'),
    url: new URL('https://example.com/a?b=1'),
    callback: () => 1,
    list: [new Date(1000), 'keep'],
    nested: { keep: 'x', skipped: undefined },
  };
}

const PROJECTED = {
  when: '1970-01-01T00:00:00.000Z',
  tags: {},
  map: {},
  point: { x: 3, y: 4 },
  price: 1.5,
  url: 'https://example.com/a?b=1',
  list: ['1970-01-01T00:00:01.000Z', 'keep'],
  nested: { keep: 'x' },
};

let host: TestHost | undefined;
afterEach(async () => {
  await host?.dispose();
  host = undefined;
});

async function boot(debug: boolean) {
  const warnings: string[] = [];
  host = await createTestHost({
    contracts: { only: [contract] },
    app: { debug },
    plugins: [definePlugin({
      meta: { id: 'fixture.non-plain', commands: ['fixture_non_plain'] },
      apply(ctx) {
        ctx.commands.register('fixture_non_plain', (args) => {
          switch (args.kind) {
            case 'result': return nonPlain();
            case 'error': throw new CommandError(nonPlain());
            case 'plain': return { a: [1, 'two', null], b: { c: true } };
            case 'bigint': return { n: 2n ** 64n, when: new Date(0), callback: () => 1 };
            case 'bytes': return new Uint8Array([1, 2, 3]);
            case 'cyclic': {
              const value: Record<string, unknown> = { point: new Point(1, 1) };
              value.self = value;
              return value;
            }
            default: return null;
          }
        });
      },
    })],
  });
  host.runtime.ctx.logger.exporter({ levels: { default: 4 }, export: (message) => { if (message.type === 'warn') warnings.push(String(message.args[0])); } });
  return { host, warnings };
}

it('V08-10 release: a non-JSON command result is projected like JSON.stringify, survives structuredClone, and warns once with its first path', async () => {
  const { host, warnings } = await boot(false);
  const value = await host.invoke('fixture_non_plain', { kind: 'result' });
  expect(value).toEqual(PROJECTED);
  expect(JSON.stringify(value)).toBe(JSON.stringify(nonPlain()));
  expect(() => structuredClone(value)).not.toThrow();
  let cloneError: unknown;
  try { structuredClone(nonPlain()); } catch (error) { cloneError = error; }
  expect((cloneError as Error | undefined)?.name).toBe('DataCloneError');
  expect(warnings).toEqual([
    '[dstu-host] command "fixture_non_plain" returned a value that is not plain JSON: $.when is an instance of Date; sent its JSON projection',
  ]);
});

it('V08-10 release: CommandError values take the same projection', async () => {
  const { host, warnings } = await boot(false);
  const rejected = await host.invoke('fixture_non_plain', { kind: 'error' }).catch((error: unknown) => error);
  expect(rejected).toEqual(PROJECTED);
  expect(warnings).toEqual([
    '[dstu-host] command "fixture_non_plain" rejected with a value that is not plain JSON: $.when is an instance of Date; sent its JSON projection',
  ]);
});

it('V08-10 release: plain values, the bigint/rawJSON path and root bytes are untouched and do not warn', async () => {
  const { host, warnings } = await boot(false);
  expect(await host.invoke('fixture_non_plain', { kind: 'plain' })).toEqual({ a: [1, 'two', null], b: { c: true } });
  // hasRawJson 路径本来就整值 JSON.stringify，形状已经是普通 JSON。
  expect(await host.invoke('fixture_non_plain', { kind: 'bigint' })).toEqual({ n: 18446744073709552000, when: '1970-01-01T00:00:00.000Z' });
  const bytes = await host.invoke('fixture_non_plain', { kind: 'bytes' });
  expect(bytes).toBeInstanceOf(Uint8Array);
  expect([...(bytes as Uint8Array)]).toEqual([1, 2, 3]);
  expect(warnings).toEqual([]);
});

it('V08-10 release: a cyclic non-plain value cannot be projected; it is sent as before and the warning says so', async () => {
  const { host, warnings } = await boot(false);
  const value = await host.invoke<Record<string, unknown>>('fixture_non_plain', { kind: 'cyclic' });
  expect(value.self).toBe(value);
  expect(value.point).toBeInstanceOf(Point);
  expect(warnings).toHaveLength(1);
  expect(warnings).toEqual([
    '[dstu-host] command "fixture_non_plain" returned a value that is not plain JSON: $.point is an instance of Point; JSON projection failed (Converting circular structure to JSON), sent as is',
  ]);
});

it('V08-10 release: event payloads are projected for the frontend while Host listeners keep the original value', async () => {
  const { host, warnings } = await boot(false);
  const heard: unknown[] = [];
  host.ctx.backendEvents.listen('fixture://non-plain', (payload) => heard.push(payload));
  const payload = nonPlain();
  host.ctx.backendEvents.emit('fixture://non-plain', payload);
  expect(host.eventsNamed('fixture://non-plain')).toEqual([PROJECTED]);
  expect(() => structuredClone(host.events.at(-1))).not.toThrow();
  expect(heard).toEqual([payload]);
  expect(heard[0]).toBe(payload);
  expect(warnings).toEqual([
    '[dstu-host] payload of event "fixture://non-plain" is not plain JSON: $.when is an instance of Date; sent its JSON projection',
  ]);
});

it('V08-10 debug: non-JSON results and payloads are still rejected, not projected', async () => {
  const { host, warnings } = await boot(true);
  await expect(host.invoke('fixture_non_plain', { kind: 'result' })).rejects.toMatch(/returned a value that violates its contract .*\$\.when is an instance of Date/);
  expect(() => host.ctx.backendEvents.emit('fixture://non-plain', nonPlain())).toThrow(/\$\.when is an instance of Date/);
  expect(host.eventsNamed('fixture://non-plain')).toEqual([]);
  expect(warnings).toEqual([]);
});
