import { afterEach, describe, expect, it } from 'vitest';
import { MessageChannel } from 'node:worker_threads';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import review from '../../plugins/review/index.ts';
import { serveHost } from '../connection.ts';
import { messagePortTransport } from '../transports.ts';
import { CapabilityAcl } from '../acl.ts';
import { ContractSet } from '../contracts.ts';
import { definePlugin } from '../api.ts';
import type { InvokeRequest, InvokeResponse } from '../protocol.ts';
import type { LaneContract } from '../contract.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function boot(debug = true, extra?: LaneContract) {
  const dir = mkdtempSync(join(tmpdir(), 'wp133-'));
  const profile = join(dir, 'empty.json');
  writeFileSync(profile, '{"plugins":[]}');
  const { port1, port2 } = new MessageChannel();
  const calls: unknown[][] = [];
  const pending = new Map<string, (response: InvokeResponse) => void>();
  port2.on('message', (message) => {
    if (message.kind === 'result') { pending.get(message.id)?.(message); pending.delete(message.id); }
  });
  const session = serveHost(messagePortTransport(port1), {
    profile,
    contracts: () => extra ? ContractSet.fromDirectory().with([{ file: 'WP133.json', contract: extra }]) : ContractSet.fromDirectory(),
    acl: () => extra ? new CapabilityAcl([{ identifier: 'wp133', webviews: ['main'], permissions: ['allow-test'] }],
      [{ identifier: 'allow-test', allow: ['insight_list', ...extra.commands.map(c => c.name)], deny: [] }], 'linux') : CapabilityAcl.fromDirectory('linux'),
    onRuntime(runtime) {
      // Only external dependencies are inputs. The installed review plugin, its
      // registration, defaults, error mapping and the whole kernel are production.
      runtime.ctx.provide('storage', {});
      runtime.ctx.provide('insight', { listInsights: (...args: unknown[]) => { calls.push(args); return []; } });
    },
  });
  cleanup.push(async () => { await session.shutdown(); port2.close(); rmSync(dir, { recursive: true, force: true }); });
  port2.postMessage({ kind: 'handshake', protocol: 1, appDataDir: dir, appVersion: 'test', platform: 'linux', debug });
  const runtime = await session.ready;
  expect(runtime).not.toBeNull();
  await runtime!.install(review);
  let id = 0;
  const invoke = (argsJson?: string, extra: Partial<InvokeRequest> = {}) => new Promise<InvokeResponse>(resolve => {
    const key = String(++id);
    pending.set(key, resolve);
    port2.postMessage({ kind: 'invoke', id: key, cmd: 'insight_list', args: { offset: 17 },
      source: { window: 'main', webview: 'main' }, ...(argsJson === undefined ? {} : { argsJson }), ...extra });
  });
  return { calls, invoke, runtime: runtime! };
}

describe('WP-133 MessagePort → serveHost → real insight_list handler', () => {
  it.each([true, false])('keeps adjacent i64, boundaries, null/default and legacy objects (debug=%s)', async debug => {
    const { calls, invoke } = await boot(debug);
    for (const token of ['9007199254740993', '9007199254740992', '9223372036854775807', '-9223372036854775808']) {
      expect(await invoke(`{"offset":${token},"limit":1,"status":null}`)).toMatchObject({ ok: true, value: [] });
      expect(calls.at(-1)).toEqual([null, 1, BigInt(token)]);
    }
    for (const text of ['{}', '{"limit":null,"offset":null}', 'null', '[]']) {
      expect(await invoke(text)).toMatchObject({ ok: true, value: [] });
      expect(calls.at(-1)).toEqual([null, 100, 0]);
    }
    expect(await invoke('{"offset":5,"offset":6}')).toMatchObject({ ok: true });
    expect(calls.at(-1)).toEqual([null, 100, 6]);
    expect(await invoke(undefined, { args: { limit: 2, offset: 3 } })).toMatchObject({ ok: true });
    expect(calls.at(-1)).toEqual([null, 2, 3]);
    expect(calls).toHaveLength(10);
  });

  it('rejects numeric tokens before handler entry and preserves parameter error order', async () => {
    const { calls, invoke } = await boot();
    for (const token of ['9223372036854775808', '-9223372036854775809', '1.0', '1e0', '1e400']) {
      expect(await invoke(`{"offset":${token}}`)).toMatchObject({ ok: false,
        error: 'invalid args `offset` for command `insight_list`: invalid number' });
    }
    expect(await invoke('{"offset":"9007199254740993"}')).toMatchObject({ ok: false,
      error: 'invalid args `offset` for command `insight_list`: invalid type: string "9007199254740993", expected i64' });
    expect(await invoke('{"offset":false,"limit":"bad","status":42}')).toMatchObject({ ok: false,
      error: 'invalid args `status` for command `insight_list`: invalid type: number, expected a string' });
    expect(await invoke('{"offset":false,"limit":"bad"}')).toMatchObject({ ok: false,
      error: 'invalid args `limit` for command `insight_list`: invalid type: string "bad", expected i64' });
    expect(calls).toEqual([]);
  });

  it('settles malformed source, never fills from args, and retains ACL/not-found/bytes precedence', async () => {
    const { calls, invoke } = await boot();
    expect(await invoke('{"offset":')).toMatchObject({ ok: false,
      error: '[dstu-host] invalid argsJson: EOF while parsing a value at line 1 column 10' });
    // Deliberately malformed wire field: structured clone has no TS type guard.
    expect(await invoke(undefined, { argsJson: 42 as never })).toMatchObject({ ok: false,
      error: '[dstu-host] invalid argsJson: expected a string' });
    expect(await invoke('{"status":false} trailing')).toMatchObject({ ok: false,
      error: '[dstu-host] invalid argsJson: trailing characters at line 1 column 18' });
    expect(await invoke('{', { cmd: 'wp133_missing' })).toMatchObject({ ok: false,
      error: 'wp133_missing not allowed. Command not found' });
    expect(await invoke('{', { source: { window: 'main', webview: 'browser-content' } })).toMatchObject({ ok: false,
      error: expect.stringContaining('insight_list not allowed on window') });
    expect(await invoke('{', { args: new Uint8Array([1, 2]) })).toMatchObject({ ok: false,
      error: 'invalid args `status` for command `insight_list`: command insight_list expected a value for key status but the IPC call used a bytes payload' });
    expect(calls).toEqual([]);
    expect(await invoke('{"offset":7}')).toMatchObject({ ok: true });
    expect(calls).toEqual([[null, 100, 7]]);
  });
});

const nestedContract: LaneContract = {
  lane: 'F1-fixture', generator: 'hand-written transport fixture', events: [],
  $defs: {
    Item: { type: 'object', 'x-rust': 'Item', required: ['signed', 'unsigned', 'wide', 'value'], additionalProperties: false,
      properties: { signed: { type: 'integer', 'x-int': 'i64' }, unsigned: { type: 'integer', 'x-int': 'u64', minimum: 0 },
        wide: { type: 'integer', 'x-int': 'i128' }, value: { 'x-rust': 'serde_json::Value' } } },
  },
  commands: [{
    name: 'fixture_exact', lane: 'F1-fixture', async: true, frontend: 'none',
    rust: { file: 'fixture.rs', line: 1, fn: 'fixture_exact' }, injected: [{ kind: 'request' }],
    args: [{ key: 'items', rustName: 'items', optional: false, schema: { type: 'array', items: { $ref: '#/$defs/Item' } } },
      { key: 'map', rustName: 'map', optional: true, schema: { anyOf: [{ type: 'object', additionalProperties: { type: 'integer', 'x-int': 'u128' } }, { type: 'null' }] } }],
    result: { 'x-rust': 'serde_json::Value' },
  }, {
    name: 'fixture_exact_bytes', lane: 'F1-fixture', async: true, frontend: 'none',
    rust: { file: 'fixture.rs', line: 2, fn: 'fixture_exact_bytes' }, injected: [{ kind: 'request' }], args: [],
    result: { 'x-binary': true },
  }],
};

it('validates recursive typed integers before handler; Value positions are plain JSON (V08-01), exactPayload() keeps tokens', async () => {
  const { runtime, invoke } = await boot(true, nestedContract);
  const seen: { args: any; payload: unknown; exact: unknown }[] = [];
  await runtime.install(definePlugin({ meta: { id: 'fixture.exact', commands: ['fixture_exact', 'fixture_exact_bytes'] }, apply(ctx) {
    ctx.commands.register('fixture_exact', (args, call) => { seen.push({ args, payload: call.payload, exact: call.exactPayload!() }); return args; });
    ctx.commands.register('fixture_exact_bytes', (_args, call) => call.payload);
  } }));
  const text = '{"items":[{"signed":9007199254740993,"unsigned":18446744073709551615,"wide":-170141183460469231731687303715884105728,"value":{"nested":[9007199254740993,1.0,1e400],"rawJSON":"123"}}],"map":{"max":340282366920938463463374607431768211455},"extra":9007199254740993}';
  const response = await invoke(text, { cmd: 'fixture_exact', args: {} });
  expect(response).toMatchObject({ ok: true });
  expect(seen).toHaveLength(1);
  expect(seen[0]!.args.items[0]).toMatchObject({ signed: 9007199254740993n, unsigned: 18446744073709551615n,
    wide: -170141183460469231731687303715884105728n });
  expect(seen[0]!.args.map).toEqual({ max: 340282366920938463463374607431768211455n });
  expect(JSON.stringify(seen[0]!.exact)).toBe(text.replace('1e400', '1e+400'));
  expect(seen[0]!.payload).toEqual(JSON.parse(text));
  expect(seen[0]!.args.items[0].value).toEqual({ nested: [9007199254740992, 1, Infinity], rawJSON: '123' });
  if (!response.ok) throw new Error(String(response.error));
  // 1e400 不是前端 JSON.stringify 能产生的文本（Infinity 会被写成 null），plain 视图里它就是 Infinity。
  expect(response.json).toBe(text.replace('"nested":[9007199254740993,1.0,1e400]', '"nested":[9007199254740992,1,null]').replace(',"extra":9007199254740993', ''));
  expect((response.value as any).items[0].value.nested).toEqual([9007199254740992, 1, null]);
  for (const invalid of [text.replace('18446744073709551615', '18446744073709551616'),
    text.replace('-170141183460469231731687303715884105728', '-170141183460469231731687303715884105729')]) {
    expect(await invoke(invalid, { cmd: 'fixture_exact' })).toMatchObject({ ok: false,
      error: 'invalid args `items` for command `fixture_exact`: invalid number' });
  }
  expect(await invoke(text.replace('"signed":9007199254740993', '"signed":null'), { cmd: 'fixture_exact' })).toMatchObject({ ok: false,
    error: 'invalid args `items` for command `fixture_exact`: invalid type: null, expected i64' });
  expect(await invoke('{}', { cmd: 'fixture_exact' })).toMatchObject({ ok: false,
    error: 'invalid args `items` for command `fixture_exact`: command fixture_exact missing required key items' });
  expect(seen).toHaveLength(1);
  expect(await invoke('{', { cmd: 'fixture_exact_bytes', args: new Uint8Array([0, 255, 1]) })).toMatchObject({ ok: true, value: new Uint8Array([0, 255, 1]) });
});

it('retains AJV tuple/union/bounds checks around exact numeric leaves', async () => {
  const contract: LaneContract = { ...nestedContract, commands: [{ ...nestedContract.commands[0]!, args: [{
    key: 'input', rustName: 'input', optional: false, schema: {
      type: 'object', required: ['tuple', 'choice', 'bounded', 'float'], additionalProperties: false,
      properties: {
        tuple: { type: 'array', prefixItems: [{ type: 'integer', 'x-int': 'u64' }, { type: 'boolean' }], minItems: 2, maxItems: 2, items: false },
        choice: { oneOf: [
          { type: 'object', required: ['kind', 'value'], properties: { kind: { const: 'Big' }, value: { type: 'integer', 'x-int': 'i64' } } },
          { type: 'object', required: ['kind', 'value'], properties: { kind: { const: 'Text' }, value: { type: 'string' } } },
        ] },
        bounded: { type: 'integer', 'x-int': 'u64', minimum: 1, maximum: 9007199254740992 },
        float: { type: 'number', 'x-float': 'f64' },
      },
    },
  }], result: { type: 'null' } }] };
  const { invoke, runtime } = await boot(true, contract);
  const seen: unknown[] = [];
  await runtime.install(definePlugin({ meta: { id: 'fixture.exact-shapes', commands: ['fixture_exact'] }, apply(ctx) {
    ctx.commands.register('fixture_exact', args => { seen.push(args); return null; });
  } }));
  const text = '{"input":{"tuple":[18446744073709551615,true],"choice":{"kind":"Big","value":9007199254740993},"bounded":9007199254740992,"float":1.25}}';
  expect(await invoke(text, { cmd: 'fixture_exact' })).toMatchObject({ ok: true, value: null });
  expect(seen).toEqual([{ input: { tuple: [18446744073709551615n, true], choice: { kind: 'Big', value: 9007199254740993n }, bounded: 9007199254740992n, float: 1.25 } }]);
  for (const invalid of [text.replace('"bounded":9007199254740992', '"bounded":9007199254740993'),
    text.replace('"bounded":9007199254740992', '"bounded":0'), text.replace(',true]', ',42]'),
    text.replace(',true]', ',true,false]'), text.replace('"Big"', '"Other"'),
    text.replace('18446744073709551615', '18446744073709551616')]) {
    expect(await invoke(invalid, { cmd: 'fixture_exact' })).toMatchObject({ ok: false, error: expect.stringContaining('invalid args `input`') });
  }
  expect(seen).toHaveLength(1);
});
