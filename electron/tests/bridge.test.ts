import { describe, expect, it } from 'vitest';
import { installTauriBridge, type BridgeTransport } from '../preload/bridge.ts';
import type { BridgeInit, MainToRenderer, RendererToMain } from '../shell/bridge-messages.ts';

function setup(osName: BridgeInit['osName'] = 'macos') {
  const sent: RendererToMain[] = [];
  let deliver: (m: MainToRenderer) => void = () => {};
  const transport: BridgeTransport = {
    send: (m) => sent.push(m),
    subscribe: (l) => {
      deliver = l;
    },
  };
  const win: Record<string, unknown> = { crypto: globalThis.crypto, Headers: globalThis.Headers };
  installTauriBridge(
    transport,
    { osName, windowLabel: 'main', webviewLabel: 'main', protocolScheme: 'http', sep: '/', delimiter: ':', dragDropEnabled: true },
    win,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = win.__TAURI_INTERNALS__ as any;
  return { sent, deliver: (m: MainToRenderer) => deliver(m), win, internals };
}

const json = (v: unknown) => ({ kind: 'json' as const, data: JSON.stringify(v) });

describe('Tauri bridge (main world)', () => {
  it('detection globals and metadata match Tauri init scripts', () => {
    const { win, internals } = setup();
    expect(win.isTauri).toBe(true);
    expect(internals.metadata).toEqual({ currentWindow: { label: 'main' }, currentWebview: { label: 'main' } });
    expect(internals.plugins.path).toEqual({ sep: '/', delimiter: ':' });
    expect(typeof (win.__TAURI_EVENT_PLUGIN_INTERNALS__ as { unregisterListener: unknown }).unregisterListener).toBe('function');
  });

  it('convertFileSrc uses asset://localhost on macOS/Linux and http://asset.localhost on Windows', () => {
    expect(setup('macos').internals.convertFileSrc('/a b/c.png')).toBe('asset://localhost/%2Fa%20b%2Fc.png');
    expect(setup('linux').internals.convertFileSrc('/x', 'pdfstream')).toBe('pdfstream://localhost/%2Fx');
    expect(setup('windows').internals.convertFileSrc('C:\\x.pdf', 'filestream')).toBe('http://filestream.localhost/C%3A%5Cx.pdf');
  });

  it('invoke serializes like process-ipc-message-fn and resolves/rejects via callbacks', async () => {
    const { sent, deliver, internals } = setup();
    const channelLike = { __TAURI_TO_IPC_KEY__: () => '__CHANNEL__:7' };
    const p = internals.invoke('cmd', { a: new Uint8Array([1, 2]), m: new Map([['k', 1]]), c: channelLike, u: undefined });
    const msg = sent[0];
    expect(msg?.type).toBe('invoke');
    if (msg?.type !== 'invoke') throw new Error('unreachable');
    expect(msg.payload).toEqual({ contentType: 'application/json', data: '{"a":[1,2],"m":{"k":1},"c":"__CHANNEL__:7"}' });
    deliver({ type: 'result', callbackId: msg.callback, otherId: msg.error, body: json({ ok: 1 }) });
    await expect(p).resolves.toEqual({ ok: 1 });
    // 成功后两个回调都被注销
    expect(internals.callbacks.has(msg.callback)).toBe(false);
    expect(internals.callbacks.has(msg.error)).toBe(false);

    const q = internals.invoke('nonexistent');
    const m2 = sent[1];
    if (m2?.type !== 'invoke') throw new Error('unreachable');
    deliver({ type: 'result', callbackId: m2.error, otherId: m2.callback, body: json('nonexistent not allowed. Command not found') });
    await expect(q).rejects.toBe('nonexistent not allowed. Command not found');
  });

  it('raw payloads and raw responses (ArrayBuffer) and headers', async () => {
    const { sent, deliver, internals } = setup();
    const p = internals.invoke('plugin:fs|write_file', new Uint8Array([9, 8]), { headers: { path: 'x', Options: '{}' } });
    const msg = sent[0];
    if (msg?.type !== 'invoke') throw new Error('unreachable');
    expect(msg.payload.contentType).toBe('application/octet-stream');
    expect(Array.from(msg.payload.data as Uint8Array)).toEqual([9, 8]);
    expect(msg.headers).toEqual({ path: 'x', options: '{}' });
    deliver({ type: 'result', callbackId: msg.callback, otherId: msg.error, body: { kind: 'raw', data: new Uint8Array([5, 6, 7]) } });
    const buf = (await p) as ArrayBuffer;
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(buf))).toEqual([5, 6, 7]);
  });

  it('event listeners: listen-js registration, emit-js delivery by id, unregisterListener', () => {
    const { deliver, internals, win } = setup();
    const got: unknown[] = [];
    const handlerId = internals.transformCallback((e: unknown) => got.push(e));
    deliver({ type: 'listen-js', event: 'evt', eventId: 3, target: { kind: 'Any' }, handlerId });
    deliver({ type: 'emit-js', event: 'evt', payload: '{"x":1}', ids: [3, 99] });
    expect(got).toEqual([{ event: 'evt', payload: { x: 1 }, id: 3 }]);
    (win.__TAURI_EVENT_PLUGIN_INTERNALS__ as { unregisterListener(e: string, id: number): void }).unregisterListener('evt', 3);
    expect(internals.callbacks.has(handlerId)).toBe(false);
  });

  it('channel messages carry { message, index } and end marker', () => {
    const { deliver, internals } = setup();
    const got: unknown[] = [];
    const id = internals.transformCallback((m: unknown) => got.push(m));
    deliver({ type: 'channel', id, index: 0, body: json({ a: 1 }) });
    deliver({ type: 'channel', id, index: 1 });
    expect(got).toEqual([{ message: { a: 1 }, index: 0 }, { end: true, index: 1 }]);
  });

  it('once callbacks unregister themselves', () => {
    const { internals } = setup();
    const id = internals.transformCallback(() => 1, true);
    internals.runCallback(id, null);
    expect(internals.callbacks.has(id)).toBe(false);
  });
});
