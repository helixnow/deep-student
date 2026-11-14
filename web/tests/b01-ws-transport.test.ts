import type { IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';
import { Duplex } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { acceptWebSocketUpgrade, type WebSocketOptions } from '../server/ws.ts';
import { decodeMainMessage, decodeRendererMessage, encodeMainMessage, encodeRendererMessage } from '../shared/wire.ts';

class SlowSocket extends Duplex {
  readonly writes: Buffer[] = [];
  blocked = false;
  pending: (() => void) | undefined;

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.writes.push(Buffer.from(chunk));
    if (this.blocked) this.pending = callback;
    else callback();
  }

  drainWrites(): void {
    this.blocked = false;
    const callback = this.pending;
    this.pending = undefined;
    callback?.();
  }
}

function connect(options: WebSocketOptions = {}) {
  const socket = new SlowSocket();
  const ws = acceptWebSocketUpgrade({ headers: {
    upgrade: 'websocket',
    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    'sec-websocket-version': '13',
  } } as IncomingMessage, socket, Buffer.alloc(0), { pingIntervalMs: 0, ...options });
  if (!ws) throw new Error('upgrade failed');
  return { socket, ws };
}

function clientBinary(payload: Buffer): Buffer {
  const frame = Buffer.alloc(14 + payload.length);
  frame[0] = 0x82;
  frame[1] = 0xff;
  frame.writeBigUInt64BE(BigInt(payload.length), 2);
  // A zero mask is a valid client mask and keeps byte comparisons straightforward.
  payload.copy(frame, 14);
  return frame;
}

describe('B01 real transport regressions', () => {
  it('assembles a 4 MiB upload in 16 KiB TCP chunks with linear copy volume', () => {
    const { socket, ws } = connect();
    const payload = Buffer.alloc(4 * 1024 * 1024, 0x63);
    const frame = clientBinary(payload);
    const messages: Array<string | Uint8Array> = [];
    ws.onMessage((data) => messages.push(data));
    let copiedBytes = 0;
    const originalConcat = Buffer.concat;
    const originalCopy = Buffer.prototype.copy;
    const concat = vi.spyOn(Buffer, 'concat').mockImplementation((list, length) => {
      copiedBytes += length ?? list.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      return originalConcat(list, length);
    });
    const copy = vi.spyOn(Buffer.prototype, 'copy').mockImplementation(function (this: Buffer, target, targetStart, sourceStart, sourceEnd) {
      const count = originalCopy.call(this, target, targetStart, sourceStart, sourceEnd);
      copiedBytes += count;
      return count;
    });
    const started = performance.now();
    try {
      for (let offset = 0; offset < frame.length; offset += 16 * 1024) {
        socket.emit('data', frame.subarray(offset, offset + 16 * 1024));
      }
    } finally {
      concat.mockRestore();
      copy.mockRestore();
      socket.destroy();
    }
    console.info(`[B01 upload] payload=${payload.length} copied=${copiedBytes} elapsedMs=${(performance.now() - started).toFixed(2)}`);
    expect(messages).toHaveLength(1);
    expect(Buffer.from(messages[0] as Uint8Array).equals(payload)).toBe(true);
    expect(copiedBytes).toBeLessThan(payload.length * 4);
  });

  it('does not expire a slow download before its queued heartbeat can be written', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { socket, ws } = connect({ pingIntervalMs: 25_000 });
    try {
      socket.blocked = true;
      ws.send(new Uint8Array(4 * 1024 * 1024));
      ws.send('chat-delta-1');
      ws.send('chat-delta-2');
      const fast = connect();
      fast.ws.send('other-tab-delta');
      expect(fast.socket.writes[1]!.subarray(2).toString()).toBe('other-tab-delta');
      fast.socket.destroy();
      vi.advanceTimersByTime(125_000);
      // At 32 KiB/s a 4 MiB PDF takes 128s. A PING queued behind it has not
      // reached the peer, so absence of a PONG is not evidence of a dead tab.
      expect(ws.open).toBe(true);
      expect(socket.writes).toHaveLength(2); // HTTP upgrade + active binary write
      console.info(`[B01 slow download] virtualMs=125000 queuedBytes=${socket.writableLength}`);
      socket.drainWrites();
      expect(socket.writes.slice(2).map((frame) => frame[0]! & 0xf)).toEqual([1, 1]);
      expect(socket.writes[2]!.subarray(2).toString()).toBe('chat-delta-1');
      expect(socket.writes[3]!.subarray(2).toString()).toBe('chat-delta-2');
      vi.advanceTimersByTime(25_000);
      expect(socket.writes[4]![0]! & 0xf).toBe(9);
      socket.emit('data', Buffer.from([0x8a, 0x80, 0, 0, 0, 0]));
      vi.advanceTimersByTime(50_000);
      expect(ws.open).toBe(true);
      vi.advanceTimersByTime(25_000);
      expect(ws.open).toBe(false); // A genuinely silent peer still expires.
    } finally {
      socket.destroy();
      vi.useRealTimers();
    }
  });

  it('preserves sticky frame tails while growing and reusing the receive storage', () => {
    const { socket, ws } = connect();
    const payloads = [Buffer.alloc(71_000, 1), Buffer.alloc(29_000, 2), Buffer.alloc(130_000, 3)];
    const wire = Buffer.concat(payloads.map(clientBinary));
    const messages: Array<string | Uint8Array> = [];
    ws.onMessage((message) => messages.push(message));
    try {
      for (let offset = 0; offset < wire.length; offset += 3191) {
        socket.emit('data', wire.subarray(offset, offset + 3191));
      }
      expect(messages).toHaveLength(3);
      for (let i = 0; i < payloads.length; i++) {
        expect(Buffer.from(messages[i] as Uint8Array).equals(payloads[i]!)).toBe(true);
      }
    } finally {
      socket.destroy();
    }
  });

  it('keeps non-zero-offset binary wire views byte-exact without base64 expansion', () => {
    const backing = new Uint8Array(1024 * 1024 + 29).fill(0xe7);
    const payload = backing.subarray(11, backing.length - 18);
    payload[0] = 1;
    payload[payload.length - 1] = 2;
    const messages = [
      { type: 'result', callbackId: 1, otherId: 2, body: { kind: 'raw', data: payload } },
      { type: 'callback', id: 3, body: { kind: 'raw', data: payload } },
      { type: 'channel', id: 4, index: 5, body: { kind: 'raw', data: payload } },
    ] as const;
    for (const message of messages) {
      const encoded = encodeMainMessage(message) as Uint8Array;
      const envelope = Buffer.alloc(encoded.length + 23, 0xee);
      envelope.set(encoded, 7);
      const decoded = decodeMainMessage(envelope.subarray(7, 7 + encoded.length));
      expect(decoded.type).toBe(message.type);
      expect('body' in decoded && decoded.body?.kind).toBe('raw');
      const data = (decoded as { body: { data: Uint8Array } }).body.data;
      expect(Buffer.from(data).equals(Buffer.from(payload))).toBe(true);
      expect(encoded.length - payload.length).toBeLessThan(100);
    }
    const invoke = { type: 'invoke', cmd: '写入文件', callback: 7, error: 8,
      headers: { 'x-name': '资料.pdf' }, payload: { contentType: 'application/octet-stream', data: payload } } as const;
    const encoded = encodeRendererMessage(invoke) as Uint8Array;
    const envelope = new Uint8Array(encoded.length + 31);
    envelope.set(encoded, 13);
    const decoded = decodeRendererMessage(envelope.subarray(13, 13 + encoded.length)) as typeof invoke;
    expect(decoded.cmd).toBe(invoke.cmd);
    expect(decoded.headers).toEqual(invoke.headers);
    expect(Buffer.from(decoded.payload.data).equals(Buffer.from(payload))).toBe(true);
    expect(encoded.length - payload.length).toBeLessThan(200);
  });
});
