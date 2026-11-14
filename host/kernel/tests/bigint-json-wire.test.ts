import { afterEach, expect, it } from 'vitest';
import { MessageChannel } from 'node:worker_threads';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CommandError, definePlugin } from '../api.ts';
import { serveHost } from '../connection.ts';
import { messagePortTransport } from '../transports.ts';
import { ContractSet } from '../contracts.ts';
import type { LaneContract } from '../contract.ts';
import type { BackendEvent, HostToMain, InvokeResponse } from '../protocol.ts';

const contract: LaneContract = {
  lane: 'F1-fixture', generator: 'hand-written transport fixture', $defs: {}, events: [],
  commands: ['fixture_bigint', 'fixture_bytes'].map(name => ({
    name, lane: 'F1-fixture', rust: { file: 'fixture.rs', line: 1, fn: name },
    async: true, args: [], injected: [], frontend: 'none',
    result: name === 'fixture_bytes' ? { 'x-binary': true } : { 'x-rust': 'serde_json::Value' },
    error: { 'x-rust': 'serde_json::Value' },
  })),
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function boot(debug: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'wp143-'));
  const profile = join(dir, 'empty.json');
  writeFileSync(profile, '{"plugins":[]}');
  const { port1, port2 } = new MessageChannel();
  const events: BackendEvent[] = [];
  const internal: unknown[] = [];
  const pending = new Map<string, (response: InvokeResponse) => void>();
  port2.on('message', (message: HostToMain) => {
    if (message.kind === 'event') events.push(message);
    if (message.kind === 'result') { pending.get(message.id)?.(message); pending.delete(message.id); }
  });
  const session = serveHost(messagePortTransport(port1), {
    profile, contracts: () => new ContractSet([{ file: 'WP143.json', contract }]),
  });
  cleanup.push(async () => { await session.shutdown(); port2.close(); rmSync(dir, { recursive: true, force: true }); });
  port2.postMessage({ kind: 'handshake', protocol: 1, appDataDir: dir, appVersion: 'test', platform: 'linux', debug });
  const runtime = await session.ready;
  if (!runtime) throw new Error('Host did not become ready');
  let output: unknown;
  let reject = false;
  await runtime.install(definePlugin({
    meta: { id: 'fixture.bigint-wire', commands: ['fixture_bigint', 'fixture_bytes'] },
    apply(ctx) {
      ctx.backendEvents.listen('wp143-value', value => internal.push(value));
      ctx.commands.register('fixture_bigint', () => {
        ctx.backendEvents.emit('wp143-value', output);
        ctx.backendEvents.emitTo({ kind: 'Window', label: 'main' }, 'wp143-value', output);
        if (reject) throw new CommandError(output);
        return output;
      });
      ctx.commands.register('fixture_bytes', () => output);
    },
  }));
  let sequence = 0;
  const invoke = (value: unknown, error = false, cmd = 'fixture_bigint') => {
    output = value;
    reject = error;
    const id = String(++sequence);
    return new Promise<InvokeResponse>(resolve => {
      pending.set(id, resolve);
      port2.postMessage({ kind: 'invoke', id, cmd, args: {}, source: { window: 'main', webview: 'main' } });
    });
  };
  return { invoke, events, internal };
}

// serde_json 1.0.149 ser.rs:108-151,1600-1661 writes integers with itoa,
// not through f64; Tauri ipc/mod.rs:181-186 and event/mod.rs:125-131 use it.
const tokens = ['9007199254740992', '9007199254740993', '-9223372036854775808', '9223372036854775807', '0'];
const integers = Object.freeze(tokens.map(token => BigInt(token)));
const arrayJson = '[9007199254740992,9007199254740993,-9223372036854775808,9223372036854775807,0]';
const record = Object.freeze({ nested: Object.freeze({ integers }), absent: undefined, label: 'i64' });
const cases = [
  ...tokens.map((json, index) => ({ value: integers[index], json })),
  { value: integers, json: arrayJson },
  { value: record, json: `{"nested":{"integers":${arrayJson}},"label":"i64"}` },
];

it.each([true, false])('WP-143 bigint-only result/error/events retain integer tokens over MessagePort (debug=%s)', async debug => {
  const { invoke, events, internal } = await boot(debug);
  for (const reject of [false, true]) {
    const responses: InvokeResponse[] = [];
    for (const { value, json } of cases) {
      const response = await invoke(value, reject);
      responses.push(response);
      expect(response).toEqual({ kind: 'result', id: expect.any(String), ok: !reject,
        [reject ? 'error' : 'value']: JSON.parse(json), json });
      expect(events.splice(0)).toEqual([
        { kind: 'event', event: 'wp143-value', payload: JSON.parse(json), payloadJson: json, target: { kind: 'Any' } },
        { kind: 'event', event: 'wp143-value', payload: JSON.parse(json), payloadJson: json, target: { kind: 'Window', label: 'main' } },
      ]);
      expect(internal.splice(0)).toEqual([value, value]);
    }
    // These two real responses have identical frontend projections but distinct
    // original JSON, which is the recorder's evidence (not two empty returns).
    const first = responses[0]!;
    const second = responses[1]!;
    expect(first.ok ? first.value : first.error).toBe(9007199254740992);
    expect(second.ok ? second.value : second.error).toBe(9007199254740992);
    expect(first.json).toBe('9007199254740992');
    expect(second.json).toBe('9007199254740993');
  }
  expect(record.nested.integers).toBe(integers);
  expect(integers).toEqual([9007199254740992n, 9007199254740993n, -9223372036854775808n, 9223372036854775807n, 0n]);
});

it.each([true, false])('WP-143 ordinary objects and bytes keep their existing wire shapes (debug=%s)', async debug => {
  const { invoke, events } = await boot(debug);
  const ordinary = { rawJSON: '9007199254740993', nested: [42, null, true], label: 'ordinary' };
  for (const reject of [false, true]) {
    expect(await invoke(ordinary, reject)).toEqual({ kind: 'result', id: expect.any(String), ok: !reject,
      [reject ? 'error' : 'value']: ordinary });
    expect(events.splice(0)).toEqual([
      { kind: 'event', event: 'wp143-value', payload: ordinary, target: { kind: 'Any' } },
      { kind: 'event', event: 'wp143-value', payload: ordinary, target: { kind: 'Window', label: 'main' } },
    ]);
  }
  for (const bytes of [new Uint8Array([0, 255, 17]), new Uint8Array([0, 255, 17]).buffer]) {
    expect(await invoke(bytes, false, 'fixture_bytes')).toEqual({ kind: 'result', id: expect.any(String), ok: true, value: bytes });
  }
  expect(events).toEqual([]);
});
