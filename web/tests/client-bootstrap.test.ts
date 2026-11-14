// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { BridgeTransport } from '../../electron/preload/bridge.ts';
import type { InvokeMessage, MainToRenderer } from '../../electron/shell/bridge-messages.ts';

const bridge = vi.hoisted(() => ({ transport: null as BridgeTransport | null }));
vi.mock('../../electron/preload/bridge.ts', () => ({
  installTauriBridge: (transport: BridgeTransport) => { bridge.transport = transport; },
}));

import { bootstrapWebClient } from '../client/bootstrap.ts';
import { decodeRendererMessage, encodeMainMessage } from '../shared/wire.ts';

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static readonly instances: FakeSocket[] = [];
  readyState = 0;
  sent: Array<string | ArrayBuffer> = [];
  constructor(_url: string) { super(); FakeSocket.instances.push(this); }
  send(data: string | ArrayBuffer) { this.sent.push(data); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  message(message: MainToRenderer) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
  reply(callbackId: number, otherId: number, value: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
      type: 'result', callbackId, otherId, body: { kind: 'json', data: JSON.stringify(value) },
    }) }));
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

function read(callback: number, error: number, key: string): InvokeMessage {
  return { type: 'invoke', cmd: 'get_setting', callback, error, headers: {},
    payload: { contentType: 'application/json', data: JSON.stringify({ key }) } };
}

it('settles/coalesces invokes and preserves subscription identity across reconnects and unmounts', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }));
  try {
    const client = bootstrapWebClient();
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const socket = FakeSocket.instances[0]!;
    const transport = bridge.transport!;
    const results: MainToRenderer[] = [];
    transport.subscribe((result) => results.push(result));
    socket.open();
    await client.connected;

    transport.send(read(1, 2, 'success'));
    transport.send(read(3, 4, 'success'));
    expect(socket.sent).toHaveLength(1);
    socket.reply(1, 2, 'value');
    await Promise.resolve();
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ callbackId: 1 }), expect.objectContaining({ callbackId: 3 }),
    ]));
    transport.send(read(5, 6, 'success'));
    await Promise.resolve();
    expect(socket.sent).toHaveLength(1);
    expect(results.at(-1)).toMatchObject({ callbackId: 5 });

    transport.send(read(7, 8, 'error'));
    transport.send(read(9, 10, 'error'));
    socket.reply(8, 7, 'read failed');
    await Promise.resolve();
    expect(results.at(-1)).toMatchObject({ callbackId: 10, otherId: 9 });
    transport.send(read(11, 12, 'error'));
    expect(socket.sent).toHaveLength(3); // Errors are never cached.

    transport.send(read(13, 14, 'disconnect'));
    transport.send(read(15, 16, 'disconnect'));
    socket.close();
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ callbackId: 12 }), expect.objectContaining({ callbackId: 14 }),
      expect.objectContaining({ callbackId: 16 }),
    ]));
    vi.advanceTimersByTime(600);
    expect(FakeSocket.instances).toHaveLength(2);
    const reconnected = FakeSocket.instances[1]!;
    reconnected.open();
    transport.send(read(17, 18, 'success'));
    expect(reconnected.sent).toHaveLength(1); // Disconnect invalidates the old read cache.
    transport.send(read(19, 20, 'generation'));
    transport.send({ ...read(21, 22, 'generation'), cmd: 'set_setting' });
    transport.send(read(23, 24, 'generation'));
    expect(reconnected.sent).toHaveLength(4); // A post-write read never coalesces into the old generation.
    reconnected.reply(23, 24, 'new value');
    reconnected.reply(19, 20, 'old value');
    transport.send(read(25, 26, 'generation'));
    await Promise.resolve();
    expect(results.at(-1)).toMatchObject({ callbackId: 25, body: { kind: 'json', data: '"new value"' } });

    // A read that races a write must not remain cached once the write completes.
    reconnected.reply(21, 22, null);
    transport.send(read(27, 28, 'generation'));
    expect(reconnected.sent).toHaveLength(5);

    const listenMsg = (callback: number, handler: number, event = 'test-event'): InvokeMessage => ({
      ...read(callback, callback + 1, ''), cmd: 'plugin:event|listen', payload: {
        contentType: 'application/json', data: JSON.stringify({ event, target: { kind: 'Any' }, handler }),
      },
    });
    const unlistenMsg = (callback: number, eventId: number, event = 'test-event'): InvokeMessage => ({
      ...read(callback, callback + 1, ''), cmd: 'plugin:event|unlisten', payload: {
        contentType: 'application/json', data: JSON.stringify({ event, eventId }),
      },
    });
    const serverMessage = (target: FakeSocket, message: MainToRenderer) => {
      target.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
    };

    transport.send(listenMsg(29, 200));
    serverMessage(reconnected, {
      type: 'listen-js', event: 'test-event', eventId: 100, target: { kind: 'Any' }, handlerId: 200,
    });
    reconnected.reply(29, 30, 100);
    transport.send(listenMsg(31, 501)); // An unacknowledged listen must reject on disconnect too.
    reconnected.close();
    expect(results).toContainEqual(expect.objectContaining({ callbackId: 32 }));
    vi.advanceTimersByTime(600);
    const third = FakeSocket.instances[2]!;
    third.open();
    expect(third.sent).toHaveLength(1);
    serverMessage(third, {
      type: 'listen-js', event: 'test-event', eventId: 101, target: { kind: 'Any' }, handlerId: 200,
    });
    expect(results.at(-1)).toMatchObject({ type: 'listen-js', eventId: 100 });
    serverMessage(third, { type: 'emit-js', event: 'test-event', payload: 'null', ids: [101] });
    expect(results.at(-1)).toMatchObject({ type: 'emit-js', ids: [100] });

    transport.send(unlistenMsg(33, 100));
    expect(JSON.parse(JSON.parse(third.sent.at(-1)! as string).payload.data)).toMatchObject({ eventId: 101 });
    third.reply(33, 34, null);
    third.close();
    vi.advanceTimersByTime(600);
    const fourth = FakeSocket.instances[3]!;
    fourth.open();
    expect(fourth.sent).toHaveLength(0); // An unmounted listener must not be resurrected.

    serverMessage(fourth, {
      type: 'listen-js', event: 'late-unmount', eventId: 102, target: { kind: 'Any' }, handlerId: 201,
    });
    fourth.close();
    vi.advanceTimersByTime(600);
    const fifth = FakeSocket.instances[4]!;
    fifth.open();
    transport.send(unlistenMsg(35, 102, 'late-unmount'));
    expect(fifth.sent).toHaveLength(1); // Do not send an obsolete ID while replay is pending.
    expect(results.at(-1)).toMatchObject({ type: 'result', callbackId: 35 });
    serverMessage(fifth, {
      type: 'listen-js', event: 'late-unmount', eventId: 103, target: { kind: 'Any' }, handlerId: 201,
    });
    const cleanup = JSON.parse(fifth.sent.at(-1)! as string);
    expect(cleanup.cmd).toBe('plugin:event|unlisten');
    expect(JSON.parse(cleanup.payload.data)).toMatchObject({ eventId: 103 });

    const bytes = new Uint8Array([99, 0, 128, 255, 99]).subarray(1, 4);
    transport.send({ ...read(37, 38, ''), cmd: 'plugin:fs|write_file', payload: {
      contentType: 'application/octet-stream', data: bytes,
    } });
    expect(fifth.sent.at(-1)).toBeInstanceOf(ArrayBuffer);
    expect(decodeRendererMessage(new Uint8Array(fifth.sent.at(-1)! as ArrayBuffer))).toMatchObject({
      payload: { contentType: 'application/octet-stream', data: new Uint8Array([0, 128, 255]) },
    });
    const response = encodeMainMessage({ type: 'result', callbackId: 37, otherId: 38,
      body: { kind: 'raw', data: bytes } });
    expect(response).toBeInstanceOf(Uint8Array);
    fifth.dispatchEvent(new MessageEvent('message', { data: (response as Uint8Array).buffer }));
    expect(results.at(-1)).toMatchObject({ type: 'result', callbackId: 37,
      body: { kind: 'raw', data: new Uint8Array([0, 128, 255]) } });

    // A restarted server resets its event counter. Its new IDs must not collide
    // with IDs already captured by the renderer's unlisten closures.
    const listen = (callback: number, handler: number) => transport.send(listenMsg(callback, handler, 'same-event'));
    listen(40, 300);
    serverMessage(fifth, { type: 'listen-js', event: 'same-event', target: { kind: 'Any' },
      eventId: 104, handlerId: 300 });
    fifth.reply(40, 41, 104);
    const oldClientId = JSON.parse((results.at(-1)! as Extract<MainToRenderer, { type: 'result' }>).body.data as string);
    fifth.close();
    vi.advanceTimersByTime(600);
    const restarted = FakeSocket.instances[5]!;
    restarted.open();
    serverMessage(restarted, { type: 'listen-js', event: 'same-event', target: { kind: 'Any' },
      eventId: 0, handlerId: 300 });
    expect(results.at(-1)).toMatchObject({ type: 'listen-js', eventId: oldClientId });
    listen(42, 301);
    serverMessage(restarted, { type: 'listen-js', event: 'same-event', target: { kind: 'Any' },
      eventId: oldClientId, handlerId: 301 });
    const newClientId = (results.at(-1)! as Extract<MainToRenderer, { type: 'listen-js' }>).eventId;
    expect(newClientId).not.toBe(oldClientId);
    restarted.reply(42, 43, oldClientId);
    expect(results.at(-1)).toMatchObject({ type: 'result', callbackId: 42,
      body: { kind: 'json', data: JSON.stringify(newClientId) } });
    serverMessage(restarted, { type: 'emit-js', event: 'same-event', payload: 'null', ids: [0, oldClientId] });
    expect(results.at(-1)).toMatchObject({ type: 'emit-js', ids: [oldClientId, newClientId] });
    for (const [clientId, serverId] of [[oldClientId, 0], [newClientId, oldClientId]]) {
      transport.send(unlistenMsg(44, clientId, 'same-event'));
      expect(JSON.parse(JSON.parse(restarted.sent.at(-1)! as string).payload.data)).toMatchObject({ eventId: serverId });
    }
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
