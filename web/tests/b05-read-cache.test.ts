// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { BridgeTransport } from '../../electron/preload/bridge.ts';
import type { InvokeMessage, MainToRenderer } from '../../electron/shell/bridge-messages.ts';

const bridge = vi.hoisted(() => ({ transport: null as BridgeTransport | null }));
vi.mock('../../electron/preload/bridge.ts', () => ({
  installTauriBridge: (transport: BridgeTransport) => { bridge.transport = transport; },
}));
import { bootstrapWebClient } from '../client/bootstrap.ts';

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  constructor(_url: string) { super(); FakeSocket.instances.push(this); }
  send(data: string) { this.sent.push(data); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  reply(callbackId: number, otherId: number, value: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
      type: 'result', callbackId, otherId, body: { kind: 'json', data: JSON.stringify(value) },
    }) }));
  }
}

function invoke(callback: number, cmd = 'get_api_configurations'): InvokeMessage {
  return { type: 'invoke', cmd, callback, error: callback + 1, headers: {},
    payload: { contentType: 'application/json', data: cmd === 'save_api_configurations' ? '{"configs":[]}' : '{}' } };
}

async function setup() {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  vi.stubGlobal('window', frame.contentWindow!);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }));
  const client = bootstrapWebClient();
  await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
  const socket = FakeSocket.instances[0]!;
  socket.open();
  await client.connected;
  const results: MainToRenderer[] = [];
  const transport = bridge.transport!;
  transport.subscribe((result) => results.push(result));
  return { socket, results, transport };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it.each([true, false])('invalidates a during-write snapshot before the write callback (success=%s)', async (success) => {
  const { socket, transport, results } = await setup();
  transport.subscribe((result) => {
    if (result.type === 'result' && result.otherId === (success ? 2 : 1)) transport.send(invoke(5));
  });
  transport.send(invoke(1, 'save_api_configurations'));
  // The async config save awaits key decryption/storage; another component can
  // read the old snapshot while it is pending, even though WS frames are ordered.
  transport.send(invoke(3));
  socket.reply(3, 4, ['old']);
  socket.reply(success ? 1 : 2, success ? 2 : 1, success ? null : 'save failed');
  expect(socket.sent).toHaveLength(3);
  socket.reply(5, 6, ['new']);
  await Promise.resolve();
  expect(results.at(-1)).toMatchObject({ callbackId: 5, body: { data: '["new"]' } });
});

it('does not join or cache a during-write read that finishes after the write acknowledgement', async () => {
  const { socket, transport, results } = await setup();
  transport.send(invoke(1, 'save_api_configurations'));
  transport.send(invoke(3));
  socket.reply(1, 2, null);
  transport.send(invoke(5));
  expect(socket.sent).toHaveLength(3);
  socket.reply(5, 6, ['new']);
  socket.reply(3, 4, ['old']);
  transport.send(invoke(7));
  await Promise.resolve();
  expect(socket.sent).toHaveLength(3);
  expect(results.at(-1)).toMatchObject({ callbackId: 7, body: { data: '["new"]' } });
});

it('coalesces 55 slow-RTT reads beyond TTL, delivers errors, and never caches failures', async () => {
  const { socket, transport, results } = await setup();
  for (let i = 1; i <= 109; i += 2) {
    transport.send(invoke(i));
    vi.advanceTimersByTime(100);
  }
  expect(socket.sent).toHaveLength(1);
  socket.reply(2, 1, 'unavailable');
  await Promise.resolve();
  expect(results).toHaveLength(55);
  expect(results.map((r) => r.type === 'result' ? r.callbackId : -1))
    .toEqual(expect.arrayContaining(Array.from({ length: 55 }, (_, i) => i * 2 + 2)));
  transport.send(invoke(111));
  expect(socket.sent).toHaveLength(2);
  socket.reply(111, 112, ['fresh']);
  transport.send(invoke(113));
  expect(results).toHaveLength(56); // Cache delivery must remain asynchronous.
  await Promise.resolve();
  expect(results.at(-1)).toMatchObject({ callbackId: 113, otherId: 114 });
  expect(socket.sent).toHaveLength(2);
  vi.advanceTimersByTime(2501);
  transport.send(invoke(115));
  expect(socket.sent).toHaveLength(3);
});

it('clears a still-fresh cache on disconnect and reads again after reconnect', async () => {
  const { socket, transport, results } = await setup();
  transport.send(invoke(5, 'save_api_configurations'));
  transport.send(invoke(1));
  socket.reply(1, 2, ['before disconnect']);
  socket.close();
  expect(results).toEqual(expect.arrayContaining([
    expect.objectContaining({ callbackId: 6, otherId: 5 }),
  ]));
  vi.advanceTimersByTime(600);
  const next = FakeSocket.instances[1]!;
  next.open();
  transport.send(invoke(3));
  expect(next.sent).toHaveLength(1);
});

it('invalidates on each overlapping write completion, not just the first', async () => {
  const { socket, transport } = await setup();
  transport.send(invoke(1, 'save_api_configurations'));
  transport.send(invoke(3, 'save_api_configurations'));
  socket.reply(1, 2, null);
  transport.send(invoke(5));
  socket.reply(5, 6, ['first write']);
  socket.reply(3, 4, null);
  transport.send(invoke(7));
  expect(socket.sent).toHaveLength(4);
});
