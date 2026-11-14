/**
 * `webMessagePortTransport`：浏览器 / Web Worker 的 `MessagePort`（EventTarget 形状，消息在 `event.data`）。
 * Node 的全局 `MessageChannel` 同样是 EventTarget，这里用它代替浏览器端口。
 */
import { describe, expect, it } from 'vitest';
import { webMessagePortTransport } from '../transports.ts';
import { HOST_PROTOCOL_VERSION } from '../protocol.ts';

describe('webMessagePortTransport', () => {
  it('delivers event.data to the listener and posts outbound messages on the port', async () => {
    const { port1, port2 } = new MessageChannel();
    const transport = webMessagePortTransport(port1);
    const received: unknown[] = [];
    transport.onMessage(message => received.push(message));

    const outbound: unknown[] = [];
    port2.addEventListener('message', event => outbound.push((event as MessageEvent).data));
    port2.start();

    port2.postMessage({ kind: 'shutdown' });
    transport.send({ kind: 'ready', protocol: HOST_PROTOCOL_VERSION });

    await expect.poll(() => received).toEqual([{ kind: 'shutdown' }]);
    await expect.poll(() => outbound).toEqual([{ kind: 'ready', protocol: HOST_PROTOCOL_VERSION }]);
    transport.close();
    port2.close();
  });

  it('stops sending after close and closes the port once', () => {
    const calls: string[] = [];
    const port = {
      postMessage: () => calls.push('post'),
      addEventListener: () => undefined,
      start: () => calls.push('start'),
      close: () => calls.push('close'),
    };
    const transport = webMessagePortTransport(port);
    transport.close();
    transport.close();
    transport.send({ kind: 'ready', protocol: HOST_PROTOCOL_VERSION });
    expect(calls).toEqual(['close']);
  });

  it('reports the port close event as a transport close', () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const port = {
      postMessage: () => undefined,
      addEventListener: (type: string, listener: (event: unknown) => void) => { listeners.set(type, listener); },
      start: () => undefined,
      close: () => undefined,
    };
    const transport = webMessagePortTransport(port);
    let closed = 0;
    transport.onClose(() => { closed++; });
    listeners.get('close')!({});
    transport.send({ kind: 'ready', protocol: HOST_PROTOCOL_VERSION });
    expect(closed).toBe(1);
  });
});
