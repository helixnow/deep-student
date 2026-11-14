/**
 * V08-01：生产路径（Electron main 总带 argsJson）下，`serde_json::Value` / `{}` / `true` 位置与 `CallContext.payload`
 * 解成普通 JSON（与 `JSON.parse` 相同），处理器可以 `structuredClone`、`Number()`、展开；带类型的整数位置仍按 token
 * 解码并保留 serde 的报错文本；需要 token 的处理器显式调 `call.exactPayload()`。
 */
import { afterEach, expect, it } from 'vitest';
import { createTestHost, definePlugin, type TestHost } from '../testing.ts';
import type { LaneContract } from '../contract.ts';
import type { CallContext } from '../api.ts';
import type { InvokeOutcome } from '../commands.ts';

const contract: LaneContract = {
  lane: 'F1-fixture', generator: 'hand-written V08-01 fixture', events: [], $defs: {},
  commands: [{
    name: 'fixture_value_args', lane: 'F1-fixture', async: true, frontend: 'none',
    rust: { file: 'fixture.rs', line: 1, fn: 'fixture_value_args' }, injected: [],
    args: [
      { key: 'schema', rustName: 'schema', optional: false, schema: { 'x-rust': 'serde_json::Value' } },
      { key: 'loose', rustName: 'loose', optional: true, schema: { type: 'array', items: true } },
      { key: 'count', rustName: 'count', optional: true, schema: { anyOf: [{ type: 'integer', 'x-int': 'u64', minimum: 0 }, { type: 'null' }] } },
    ],
    result: { 'x-rust': 'serde_json::Value' },
  }],
};

let host: TestHost | undefined;
afterEach(async () => {
  await host?.dispose();
  host = undefined;
});

async function boot() {
  const seen: { args: Record<string, unknown>; call: CallContext; cloned?: unknown; cloneError?: string }[] = [];
  host = await createTestHost({
    contracts: { only: [contract] },
    plugins: [definePlugin({
      meta: { id: 'fixture.value-args', commands: ['fixture_value_args'] },
      apply(ctx) {
        ctx.commands.register('fixture_value_args', (args, call) => {
          const entry: (typeof seen)[number] = { args, call };
          try { entry.cloned = structuredClone({ args, payload: call.payload }); } catch (error) { entry.cloneError = String(error); }
          seen.push(entry);
          return args.schema;
        });
      },
    })],
  });
  let id = 0;
  const invokeJson = (argsJson: string): Promise<InvokeOutcome> => host!.runtime.dispatchInvoke({
    id: `v08-${++id}`, cmd: 'fixture_value_args', args: {}, argsJson, source: { window: 'main', webview: 'main' },
  });
  return { seen, invokeJson };
}

const TEXT = '{"schema":{"type":"object","properties":{"threshold":{"type":"number","default":0.5},"id":{"default":9007199254740993}}},'
  + '"loose":[1e21,-2.5e-7,12.5],"count":18446744073709551615}';

it('V08-01: Value / true positions and payload arrive as plain JSON numbers; structuredClone does not throw', async () => {
  const { seen, invokeJson } = await boot();
  const outcome = await invokeJson(TEXT);
  expect(outcome).toMatchObject({ kind: 'ok' });
  expect(seen).toHaveLength(1);
  const [{ args, call, cloneError }] = seen as [(typeof seen)[number]];
  expect(cloneError).toBeUndefined();
  const parsed = JSON.parse(TEXT);
  expect(args.schema).toEqual(parsed.schema);
  expect((args.schema as any).properties.threshold.default).toBe(0.5);
  expect((args.schema as any).properties.id.default).toBe(9007199254740992);
  expect(args.loose).toEqual([1e21, -2.5e-7, 12.5]);
  expect(Number((args.schema as any).properties.threshold.default) * 2).toBe(1);
  expect({ ...(args.schema as any).properties.threshold }).toEqual({ type: 'number', default: 0.5 });
  expect(call.payload).toEqual({ ...parsed, count: 18446744073709552000 });
  expect(() => structuredClone(call.payload)).not.toThrow();
});

it('V08-01: typed integer positions still decode by token (bigint) and keep the serde error texts', async () => {
  const { seen, invokeJson } = await boot();
  await invokeJson(TEXT);
  expect(seen[0]!.args.count).toBe(18446744073709551615n);
  // arbitrary_precision：u64 是对数字 token 做 `str::parse::<u64>`，溢出、指数、负号、小数都是 `invalid number`。
  for (const [token, error] of [
    ['18446744073709551616', 'invalid number'],
    ['1e+21', 'invalid number'],
    ['-1', 'invalid number'],
    ['0.5', 'invalid number'],
    ['"7"', 'invalid type: string "7", expected u64'],
  ] as const) {
    const outcome = await invokeJson(TEXT.replace('18446744073709551615', token));
    expect(outcome, token).toEqual({ kind: 'err', error: `invalid args \`count\` for command \`fixture_value_args\`: ${error}` });
  }
  expect(seen).toHaveLength(1);
});

it('V08-01: call.exactPayload() is the explicit opt-in to token-preserving atoms', async () => {
  const { seen, invokeJson } = await boot();
  const text = TEXT.replace('"loose":[1e21,', '"loose":[1.0,1e400,');
  await invokeJson(text);
  const exact = seen[0]!.call.exactPayload!();
  expect(seen[0]!.call.exactPayload!()).toBe(exact);
  expect(JSON.stringify(exact)).toBe(text.replace('1e400', '1e+400'));
  expect(JSON.stringify(seen[0]!.args.loose)).toBe('[1,null,-2.5e-7,12.5]');
});

it('V08-01: re-serializing the plain view reproduces any JSON.stringify-produced argument text', async () => {
  const { seen, invokeJson } = await boot();
  const values = [0.1, 0.5, 1 / 3, 1e21, 1e-7, -0.000001, 2 ** 53 + 2, Number.MAX_VALUE, Number.MIN_VALUE, 123456789.125];
  const text = JSON.stringify({ schema: { values }, loose: values });
  await invokeJson(text);
  expect(JSON.stringify({ schema: seen[0]!.args.schema, loose: seen[0]!.args.loose })).toBe(text);
});
