// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
  sent: InvokeMessage[] = [];
  onSend?: (message: InvokeMessage) => void;
  constructor(_url: string) { super(); FakeSocket.instances.push(this); }
  send(data: string) {
    const message = JSON.parse(data) as InvokeMessage;
    this.sent.push(message);
    this.onSend?.(message);
  }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  message(message: MainToRenderer) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
  registered(handlerId: number, eventId: number) {
    this.message({ type: 'listen-js', event: 'progress', target: { kind: 'Any' }, handlerId, eventId });
  }
  result(callbackId: number, otherId: number, value: unknown) {
    this.message({ type: 'result', callbackId, otherId,
      body: { kind: 'json', data: JSON.stringify(value) } });
  }
}

function invoke(callback: number, cmd: string, args: unknown = {}): InvokeMessage {
  return { type: 'invoke', callback, error: callback + 1, cmd, headers: {},
    payload: { contentType: 'application/json', data: JSON.stringify(args) } };
}
function listen(callback: number, handler: number) {
  bridge.transport!.send(invoke(callback, 'plugin:event|listen', {
    event: 'progress', target: { kind: 'Any' }, handler,
  }));
}

let frame: HTMLIFrameElement;
let results: MainToRenderer[];
beforeEach(async () => {
  frame = document.createElement('iframe');
  document.body.appendChild(frame);
  vi.stubGlobal('window', frame.contentWindow!);
  vi.stubGlobal('document', frame.contentDocument!);
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  FakeSocket.instances = [];
  bootstrapWebClient();
  results = [];
  bridge.transport!.subscribe((message) => results.push(message));
  await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  frame.remove();
});

it('rejects interrupted listen/unlisten promises and does not replay an unacknowledged listener', () => {
  const first = FakeSocket.instances[0]!;
  first.open();
  listen(10, 100);
  first.registered(100, 50); // Registration arrived but invoke acknowledgement is still in flight.
  bridge.transport!.send(invoke(12, 'plugin:event|unlisten', { event: 'progress', eventId: 999 }));
  listen(14, 101); // Another registration has not reached listen-js yet.
  first.close();
  expect(results).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'result', callbackId: 11, otherId: 10 }),
    expect.objectContaining({ type: 'result', callbackId: 13, otherId: 12 }),
    expect.objectContaining({ type: 'result', callbackId: 15, otherId: 14 }),
  ]));
  vi.advanceTimersByTime(600);
  const second = FakeSocket.instances[1]!;
  second.open();
  expect(second.sent).toHaveLength(0);
});

it('keeps queued listen callback mapping when a reconnect handshake fails', () => {
  const first = FakeSocket.instances[0]!;
  first.open();
  listen(20, 100);
  first.registered(100, 100);
  first.result(20, 21, 100);
  first.close();
  listen(22, 101); // New component mounts while offline.
  vi.advanceTimersByTime(600);
  FakeSocket.instances[1]!.close(); // Fails before queued frames are sent.
  vi.advanceTimersByTime(1100);
  const third = FakeSocket.instances[2]!;
  third.open();
  third.registered(100, 0); // Restarted server reuses IDs.
  third.registered(101, 1);
  const assigned = results.at(-1) as Extract<MainToRenderer, { type: 'listen-js' }>;
  expect(assigned.eventId).not.toBe(1);
  third.result(22, 23, 1);
  expect(results.at(-1)).toMatchObject({ type: 'result', callbackId: 22,
    body: { kind: 'json', data: JSON.stringify(assigned.eventId) } });
});

it('restores progress listeners before flushing commands queued while disconnected', () => {
  const first = FakeSocket.instances[0]!;
  first.open();
  listen(30, 100);
  first.registered(100, 50);
  first.result(30, 31, 50);
  first.close();
  bridge.transport!.send(invoke(32, 'start_task'));
  vi.advanceTimersByTime(600);
  const second = FakeSocket.instances[1]!;
  let subscribed = false;
  second.onSend = (message) => {
    if (message.cmd === 'plugin:event|listen') {
      subscribed = true;
      second.registered(100, 60);
    } else if (message.cmd === 'start_task') {
      second.message({ type: 'emit-js', event: 'progress', payload: '"started"', ids: subscribed ? [60] : [] });
    }
  };
  second.open();
  expect(second.sent.map((message) => message.cmd)).toEqual(['plugin:event|listen', 'start_task']);
  expect(results.at(-1)).toMatchObject({ type: 'emit-js', ids: [50] });
});

it('removes the blocking offline overlay when connection recovery requires login', async () => {
  vi.mocked(fetch).mockResolvedValue({ status: 401 } as Response);
  const first = FakeSocket.instances[0]!;
  first.dispatchEvent(new Event('error'));
  expect(document.getElementById('ds-webui-offline-overlay')).not.toBeNull();
  first.close();
  vi.advanceTimersByTime(600);
  FakeSocket.instances[1]!.close();
  await vi.waitFor(() => expect(document.getElementById('ds-web-token-form')).not.toBeNull());
  expect(document.getElementById('ds-webui-offline-overlay')).toBeNull();
  // While the login form is pending, further backoff ticks must not open another
  // socket (a 401 upgrade storm behind the form) nor stack a second login form.
  vi.advanceTimersByTime(1100);
  expect(FakeSocket.instances).toHaveLength(2);
  await Promise.resolve();
  expect(document.querySelectorAll('#ds-web-token-form')).toHaveLength(1);
  expect(document.getElementById('ds-webui-offline-overlay')).toBeNull();
});

it('pauses background reconnect and auth probes while navigator.onLine is false, then resumes on online or manual retry', () => {
  const first = FakeSocket.instances[0]!;
  first.open();
  vi.mocked(fetch).mockClear();

  let online = false;
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
  first.close();

  // Advance 30 seconds while offline: no background WebSocket storm and no /api/health probes.
  vi.advanceTimersByTime(30_000);
  expect(FakeSocket.instances).toHaveLength(1);
  expect(fetch).not.toHaveBeenCalled();
  const pill = document.getElementById('ds-webui-connection-pill');
  expect(pill?.textContent).toContain('网络已断开');

  // Manual retry works even while navigator.onLine still reports false.
  pill?.querySelector('button')?.click();
  expect(FakeSocket.instances).toHaveLength(2);
  FakeSocket.instances[1]!.close();
  vi.advanceTimersByTime(30_000);
  expect(FakeSocket.instances).toHaveLength(2);
  expect(fetch).not.toHaveBeenCalled();

  // Restoring connectivity immediately reconnects without waiting for a backoff timer.
  online = true;
  window.dispatchEvent(new Event('online'));
  expect(FakeSocket.instances).toHaveLength(3);
  FakeSocket.instances[2]!.open();
});
