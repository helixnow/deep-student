import { Server as NetServer } from 'node:net';
import { expect, it, vi } from 'vitest';
import { BridgeServer } from '../src/bilibili-bridge-server.ts';
import {
  BridgeHub, type BridgeCancellation, type BridgeRequest,
} from '../src/bilibili-bridge-hub.ts';
import { BRIDGE_BASE } from '../src/bilibili-bridge.ts';
import { nextRequestId } from '../src/bilibili-session.ts';
import { TestWebSocket } from './support/websocket-client.ts';

const neverCancelled: BridgeCancellation = {
  isCancelled: false,
  whenCancelled: () => new Promise(() => {}),
};

function mediaRequest(): BridgeRequest {
  return {
    id: nextRequestId(),
    attemptId: 'attempt-1',
    kind: 'media',
    method: 'GET',
    url: new URL('https://a.bilivideo.com/v'),
    headers: {},
    body: new Uint8Array(0),
    maxBytes: 4,
    deadlineMs: Date.now() + 15_000,
    cancel: neverCancelled,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function waitFor<T>(read: () => T | null, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error('condition not reached');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

it('V09 P2-5: close() while start() is binding leaves no listening socket, and a later start() still works', async () => {
  const servers: NetServer[] = [];
  const original = NetServer.prototype.listen;
  const spy = vi.spyOn(NetServer.prototype, 'listen').mockImplementation(function (this: NetServer, ...args: unknown[]) {
    servers.push(this);
    return (original as (...rest: unknown[]) => NetServer).apply(this, args);
  });
  const server = new BridgeServer(new BridgeHub());
  try {
    const starting = server.start();
    await server.close();
    await expect(starting).rejects.toMatchObject({ name: 'BiliRequestError', message: '浏览器桥已关闭' });
    expect(servers).toHaveLength(1);
    expect(servers[0]!.listening).toBe(false);
    expect(await server.start()).toBeGreaterThan(0);
    expect(servers).toHaveLength(2);
    expect(servers[1]!.listening).toBe(true);
  } finally {
    spy.mockRestore();
    await server.close();
  }
  expect(servers[1]!.listening).toBe(false);
});

it('start() issued while close() is still pending binds a new server instead of joining the closed one', async () => {
  const servers: NetServer[] = [];
  const original = NetServer.prototype.listen;
  const spy = vi.spyOn(NetServer.prototype, 'listen').mockImplementation(function (this: NetServer, ...args: unknown[]) {
    servers.push(this);
    return (original as (...rest: unknown[]) => NetServer).apply(this, args);
  });
  const server = new BridgeServer(new BridgeHub());
  try {
    const first = server.start();
    const closing = server.close();
    const second = server.start();
    await expect(first).rejects.toMatchObject({ name: 'BiliRequestError', message: '浏览器桥已关闭' });
    const port = await second;
    await closing;
    expect(port).toBeGreaterThan(0);
    expect(servers).toHaveLength(2);
    expect(servers[0]!.listening).toBe(false);
    expect(servers[1]!.listening).toBe(true);
    expect(await server.start()).toBe(port);
  } finally {
    spy.mockRestore();
    await server.close();
  }
  expect(servers[1]!.listening).toBe(false);
});

it('actual_loopback_socket_checks_origin_pairs_probes_and_transfers_binary', async () => {
  const hub = new BridgeHub();
  const server = new BridgeServer(hub);
  const port = await server.start();
  const challenge = hub.startPairing(port);
  const socketUrl = `ws://127.0.0.1:${port}${BRIDGE_BASE}socket`;
  await expect(TestWebSocket.connect(socketUrl, { origin: 'https://evil.test' }))
    .rejects.toThrow(/403/);

  const socket = await TestWebSocket.connect(socketUrl, {
    origin: `http://127.0.0.1:${port}`,
  });
  socket.sendText(JSON.stringify({
    type: 'hello', protocol: 1, scriptVersion: '1.0.1', challenge,
  }));
  const id = await waitFor(() => hub.status().connectionId);
  expect(hub.status().parsing).toBe(false);
  hub.approve(id);

  const peer = (async () => {
    const jobs = new Map<number, { bytes: Buffer; sent: boolean }>();
    for (;;) {
      const message = await socket.next();
      if (message === null) return;
      if (message.type !== 'text') continue;
      let value: unknown;
      try { value = JSON.parse(message.text); } catch { return; }
      if (!isRecord(value)) return;
      if (value.type === 'ping') {
        socket.sendText(JSON.stringify({ type: 'pong' }));
        continue;
      }
      if (typeof value.id !== 'number') continue;
      const requestId = value.id;
      if (value.type === 'request') {
        const url = String(value.url);
        let status = 206;
        let bytes = Buffer.from('bili');
        const headers: Record<string, string> = {};
        if (url.endsWith('/nav')) {
          status = 200;
          bytes = Buffer.from('{"code":0,"data":{"isLogin":false}}');
        } else if (url.endsWith('/redirect')) {
          status = 301;
          bytes = Buffer.alloc(0);
          headers.location = `http://127.0.0.1:${port}${BRIDGE_BASE}probe/target`;
        } else if (url.endsWith('/credential')) {
          status = 200;
          bytes = Buffer.from('sent');
        } else if (url.endsWith('/anonymous')) {
          status = 200;
          bytes = Buffer.from('anon');
        } else if (url.endsWith('/oversize') || url.endsWith('/ignored-range')) {
          socket.sendText(JSON.stringify({
            type: 'error',
            id: requestId,
            code: url.endsWith('/oversize') ? 'response-too-large' : 'range-unsupported',
          }));
          continue;
        }
        headers['content-length'] = String(bytes.length);
        jobs.set(requestId, { bytes, sent: false });
        socket.sendText(JSON.stringify({
          type: 'response_head',
          id: requestId,
          status,
          headers,
          finalUrl: url,
        }));
        continue;
      }
      if (value.type === 'credit') {
        const job = jobs.get(requestId);
        if (job === undefined) continue;
        if (!job.sent && job.bytes.length > 0) {
          const frame = Buffer.alloc(12 + job.bytes.length);
          frame.writeBigUInt64BE(BigInt(requestId), 0);
          frame.writeUInt32BE(0, 8);
          job.bytes.copy(frame, 12);
          job.sent = true;
          socket.sendBinary(frame);
        } else {
          socket.sendText(JSON.stringify({ type: 'response_end', id: requestId }));
          jobs.delete(requestId);
        }
      }
    }
  })();

  try {
    await waitFor(() => hub.status().state === 'ready' ? true : null);
    expect(hub.status().media).toBe(true);
    const response = await hub.executeOn(id, mediaRequest(), false);
    expect(Buffer.from(response.body).toString()).toBe('bili');
    hub.revoke();
    socket.close();
    await peer;
  } finally {
    await server.close();
  }
});
