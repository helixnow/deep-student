/**
 * RFC 6455 帧编解码（`web/server/ws.ts`）与二进制 wire 编解码（`web/shared/wire.ts`）的边界测试。
 *
 * 覆盖真实浏览器/代理链路上会出现、但普通 WebSocket 客户端库会隐藏的形态：
 * 粘包（单次 `data` 含多帧）、半包（帧头/掩码/载荷跨 `data`）、16-bit 扩展长度、32 KiB 大帧、
 * 分片（`FIN=0` + `OPCODE_CONTINUATION`）、分片中穿插 PING、以及客户端未掩码帧必须 1002 关闭。
 */
import { Duplex } from 'node:stream';
import { constants as zlibConstants, deflateRawSync, inflateRawSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import type { IncomingMessage } from 'node:http';

import type { MainToRenderer, RendererToMain } from '../../electron/shell/bridge-messages.ts';
import { acceptWebSocketUpgrade, type WebSocketConnection, type WebSocketOptions } from '../server/ws.ts';
import { decodeMainMessage, decodeRendererMessage, encodeMainMessage, encodeRendererMessage } from '../shared/wire.ts';

// ============================================================================
// 帧构造 / 解析辅助
// ============================================================================

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

const MASK_KEY = [0x37, 0xfa, 0x21, 0x3d] as const;

interface ClientFrameOptions {
  rsv1?: boolean;
  fin?: boolean;
  masked?: boolean;
  /** `auto` 按载荷长度选 7/16/64-bit；`16` 强制 16-bit 扩展长度（即使 < 126）。 */
  lengthMode?: 'auto' | '16' | '64';
}

function buildClientFrame(opcode: number, payload: Uint8Array, options: ClientFrameOptions = {}): Buffer {
  const fin = options.fin ?? true;
  const masked = options.masked ?? true;
  const lengthMode = options.lengthMode ?? 'auto';
  const length = payload.byteLength;

  let headerLength = 2;
  let lengthCode: number;
  if (lengthMode === '64') {
    headerLength = 10;
    lengthCode = 127;
  } else if (lengthMode === '16' || length > 125) {
    headerLength = 4;
    lengthCode = 126;
  } else {
    lengthCode = length;
  }

  const maskLength = masked ? 4 : 0;
  const frame = Buffer.alloc(headerLength + maskLength + length);
  frame[0] = (fin ? 0x80 : 0x00) | (options.rsv1 ? 0x40 : 0) | (opcode & 0x0f);
  frame[1] = (masked ? 0x80 : 0x00) | lengthCode;
  if (lengthCode === 126) frame.writeUInt16BE(length, 2);
  else if (lengthCode === 127) frame.writeBigUInt64BE(BigInt(length), 2);

  let payloadOffset = headerLength;
  if (masked) {
    frame.set(MASK_KEY, headerLength);
    payloadOffset += 4;
    for (let i = 0; i < length; i++) frame[payloadOffset + i] = payload[i]! ^ MASK_KEY[i & 3]!;
  } else {
    frame.set(payload, payloadOffset);
  }
  return frame;
}

function buildClientCloseFrame(code: number, reason = ''): Buffer {
  const reasonBytes = Buffer.from(reason, 'utf8');
  const payload = Buffer.allocUnsafe(2 + reasonBytes.byteLength);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return buildClientFrame(OPCODE_CLOSE, payload);
}

interface ParsedServerFrame {
  rsv1: boolean;
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

function parseServerFrames(buffer: Buffer): ParsedServerFrame[] {
  const frames: ParsedServerFrame[] = [];
  let offset = 0;
  while (offset + 2 <= buffer.byteLength) {
    const b0 = buffer[offset]!;
    const b1 = buffer[offset + 1]!;
    let payloadLength = b1 & 0x7f;
    let headerLength = 2;
    if (payloadLength === 126) {
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      payloadLength = Number(buffer.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }
    const start = offset + headerLength;
    if (start + payloadLength > buffer.byteLength) break;
    frames.push({
      rsv1: (b0 & 0x40) !== 0,
      fin: (b0 & 0x80) !== 0,
      opcode: b0 & 0x0f,
      payload: buffer.subarray(start, start + payloadLength),
    });
    offset = start + payloadLength;
  }
  return frames;
}

/** 内存双工流：`push()` 模拟 TCP 到达的字节，`written` 收集服务端发出的字节。 */
class MemorySocket extends Duplex {
  readonly written: Buffer[] = [];

  override _read(): void {
    /* 由测试通过 push() 主动灌入数据 */
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.written.push(Buffer.from(chunk));
    callback();
  }
}

interface Harness {
  readonly socket: MemorySocket;
  readonly ws: WebSocketConnection;
  readonly messages: Array<string | Uint8Array>;
  readonly closes: number;
  feed(data: Buffer): Promise<void>;
  flush(): Promise<void>;
  serverFrames(): ParsedServerFrame[];
  writtenBuffer(): Buffer;
}

const UPGRADE_HEADERS: Record<string, string> = {
  upgrade: 'websocket',
  'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
  'sec-websocket-version': '13',
};

it('disconnects a stalled consumer instead of allowing an unbounded socket write queue', () => {
  class StalledSocket extends MemorySocket {
    override _write(chunk: Buffer): void { this.written.push(Buffer.from(chunk)); }
  }
  const socket = new StalledSocket();
  const ws = acceptWebSocketUpgrade({ headers: UPGRADE_HEADERS } as IncomingMessage, socket, Buffer.alloc(0), {
    pingIntervalMs: 0, maxPayloadBytes: 1024,
  })!;
  const closed = vi.fn();
  ws.onClose(closed);
  ws.send(new Uint8Array(1024));
  expect(ws.open).toBe(true);
  ws.send(new Uint8Array(1024));
  expect(ws.open).toBe(false);
  expect(socket.destroyed).toBe(true);
  expect(closed).toHaveBeenCalledTimes(1);
  ws.send('ignored');
  expect(closed).toHaveBeenCalledTimes(1);
});

function createHarness(head: Buffer = Buffer.alloc(0), maxPayloadBytes?: number, options: WebSocketOptions = {}): Harness {
  const socket = new MemorySocket();
  const req = { headers: {
    ...UPGRADE_HEADERS,
    ...(options.enableCompression ? { 'sec-websocket-extensions': 'permessage-deflate; client_max_window_bits' } : {}),
  } } as unknown as IncomingMessage;
  const ws = acceptWebSocketUpgrade(req, socket, head, { pingIntervalMs: 0, maxPayloadBytes, ...options });
  if (!ws) throw new Error('upgrade rejected unexpectedly');

  const messages: Array<string | Uint8Array> = [];
  const closes: number[] = [];
  ws.onMessage((data) => messages.push(data));
  ws.onClose(() => closes.push(1));

  const flush = () =>
    new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

  return {
    socket,
    ws,
    messages,
    get closes() {
      return closes.length;
    },
    async feed(data: Buffer) {
      // `push()` 只是把字节放进可读缓冲；挂上 'data' 监听的流要等一次 tick 才恢复流动。
      socket.push(data);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    },
    flush,
    writtenBuffer() {
      // 开头是本进程写出的 `HTTP/1.1 101 Switching Protocols` 响应头，帧数据在其后。
      const raw = Buffer.concat(socket.written);
      const headerEnd = raw.indexOf('\r\n\r\n');
      return headerEnd >= 0 ? raw.subarray(headerEnd + 4) : raw;
    },
    serverFrames() {
      return parseServerFrames(this.writtenBuffer());
    },
  };
}

function bytes(length: number, seed = 0): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + seed * 17 + 7) & 0xff;
  return out;
}

// ============================================================================
// ws.ts —— 帧解码边界
// ============================================================================

describe('web/server/ws.ts RFC 6455 frame codec', () => {
  it('splits sticky packets: two frames inside one data event yield two messages', async () => {
    const h = createHarness();
    const sticky = Buffer.concat([
      buildClientFrame(OPCODE_TEXT, Buffer.from('{"type":"hello"}', 'utf8')),
      buildClientFrame(OPCODE_TEXT, Buffer.from('{"type":"world"}', 'utf8')),
    ]);

    await h.feed(sticky);

    expect(h.messages).toEqual(['{"type":"hello"}', '{"type":"world"}']);
    expect(h.closes).toBe(0);
  });

  it('reassembles half packets: frame header, mask key and payload split across three data events', async () => {
    const h = createHarness();
    const frame = buildClientFrame(OPCODE_TEXT, Buffer.from('半包-跨事件到达的帧', 'utf8'));

    // 2 字节基础头 | 剩余 2 字节 16-bit 长度 + 4 字节掩码 | 载荷前半 | 载荷后半
    await h.feed(frame.subarray(0, 2));
    expect(h.messages).toHaveLength(0);
    await h.feed(frame.subarray(2, 8));
    expect(h.messages).toHaveLength(0);
    await h.feed(frame.subarray(8, 8 + 6));
    expect(h.messages).toHaveLength(0);
    await h.feed(frame.subarray(8 + 6));

    expect(h.messages).toEqual(['半包-跨事件到达的帧']);
  });

  it('decodes 16-bit extended length frames (126..65535 bytes)', async () => {
    const h = createHarness();
    const text = 'x'.repeat(60_000);
    await h.feed(buildClientFrame(OPCODE_TEXT, Buffer.from(text, 'utf8')));

    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]).toBe(text);
    expect(new TextEncoder().encode(h.messages[0] as string).byteLength).toBe(60_000);
  });

  it('round-trips a 32 KiB binary payload arriving as one frame', async () => {
    const h = createHarness();
    const payload = bytes(32 * 1024, 5);
    await h.feed(buildClientFrame(OPCODE_BINARY, payload));

    expect(h.messages).toHaveLength(1);
    expect(Buffer.from(h.messages[0] as Uint8Array).equals(Buffer.from(payload))).toBe(true);
  });

  it('reassembles fragmented messages (FIN=0 TEXT + CONTINUATION FIN=1) with a PING in between', async () => {
    const h = createHarness();
    const first = Buffer.from('{"type":"frag-', 'utf8');
    const second = Buffer.from('mented"}', 'utf8');

    await h.feed(buildClientFrame(OPCODE_TEXT, first, { fin: false }));
    expect(h.messages).toHaveLength(0);
    await h.feed(buildClientFrame(OPCODE_PING, Buffer.from('hb', 'utf8')));
    await h.feed(buildClientFrame(OPCODE_CONTINUATION, second, { fin: true }));

    expect(h.messages).toEqual(['{"type":"frag-mented"}']);
    await h.flush();

    const frames = h.serverFrames();
    const pong = frames.filter((f) => f.opcode === OPCODE_PONG);
    expect(pong).toHaveLength(1);
    expect(pong[0]!.payload.toString('utf8')).toBe('hb');
    expect(h.closes).toBe(0);
  });

  it('answers PING with an identical-payload PONG and keeps the connection open', async () => {
    const h = createHarness();
    const payload = Buffer.from('keepalive-中文', 'utf8');
    await h.feed(buildClientFrame(OPCODE_PING, payload));
    await h.flush();

    const pong = h.serverFrames().filter((f) => f.opcode === OPCODE_PONG);
    expect(pong).toHaveLength(1);
    expect(pong[0]!.payload.equals(payload)).toBe(true);
    expect(h.socket.destroyed).toBe(false);
  });

  it('rejects unmasked client frames with close code 1002 (Protocol error)', async () => {
    const h = createHarness();
    await h.feed(buildClientFrame(OPCODE_TEXT, Buffer.from('unmasked-frame'), { masked: false }));
    await h.flush();

    const close = h.serverFrames().find((f) => f.opcode === OPCODE_CLOSE);
    expect(close).toBeDefined();
    expect(close!.payload.byteLength).toBeGreaterThanOrEqual(2);
    expect(close!.payload.readUInt16BE(0)).toBe(1002);
    expect(h.messages).toHaveLength(0);
  });

  it('rejects a continuation frame without an open fragmented message with 1002', async () => {
    const h = createHarness();
    await h.feed(buildClientFrame(OPCODE_CONTINUATION, Buffer.from('orphan'), { fin: true }));
    await h.flush();

    const close = h.serverFrames().find((f) => f.opcode === OPCODE_CLOSE);
    expect(close).toBeDefined();
    expect(close!.payload.readUInt16BE(0)).toBe(1002);
  });

  it('echoes client CLOSE and reports a single close notification', async () => {
    const h = createHarness();
    await h.feed(buildClientCloseFrame(1000, 'bye'));
    await h.flush();

    const close = h.serverFrames().find((f) => f.opcode === OPCODE_CLOSE);
    expect(close).toBeDefined();
    expect(close!.payload.readUInt16BE(0)).toBe(1000);
    expect(h.closes).toBe(1);
  });

  it('parses frames handed over in the HTTP upgrade `head` buffer', async () => {
    const head = Buffer.from(buildClientFrame(OPCODE_TEXT, Buffer.from('{"type":"from-head"}', 'utf8')));
    const h = createHarness(head);
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        expect(h.messages).toEqual(['{"type":"from-head"}']);
        resolve();
      });
    });
  });

  it('enforces maxPayloadBytes with close code 1009', async () => {
    const h = createHarness(Buffer.alloc(0), 1024);
    await h.feed(buildClientFrame(OPCODE_BINARY, bytes(2048)));
    await h.flush();

    const close = h.serverFrames().find((f) => f.opcode === OPCODE_CLOSE);
    expect(close).toBeDefined();
    expect(close!.payload.readUInt16BE(0)).toBe(1009);
  });
});

// ============================================================================
// ws.ts 服务端发送 —— 16-bit / 64-bit 长度头
// ============================================================================

const DEFLATE_TAIL = Buffer.from([0, 0, 255, 255]);
function compressMessage(text: string): Buffer {
  return deflateRawSync(Buffer.from(text), { finishFlush: zlibConstants.Z_SYNC_FLUSH }).subarray(0, -4);
}

describe('web/server/ws.ts RFC 7692 stateless permessage-deflate', () => {
  it('accepts compressed small/empty, BFINAL=0 and BFINAL=1, and uncompressed messages on one connection', async () => {
    const h = createHarness(Buffer.alloc(0), undefined, { enableCompression: true });
    expect(Buffer.concat(h.socket.written).toString()).toContain('client_no_context_takeover');
    await h.feed(Buffer.concat([
      buildClientFrame(OPCODE_TEXT, compressMessage('small'), { rsv1: true }),
      buildClientFrame(OPCODE_TEXT, Buffer.from([0]), { rsv1: true }),
      buildClientFrame(OPCODE_TEXT, Buffer.from('plain')),
      buildClientFrame(OPCODE_TEXT, deflateRawSync(Buffer.from('finished')), { rsv1: true }),
      buildClientFrame(OPCODE_TEXT, compressMessage('small'), { rsv1: true }),
    ]));
    expect(h.messages).toEqual(['small', '', 'plain', 'finished', 'small']);
    expect(h.ws.open).toBe(true);
    h.socket.destroy();
  });

  it('reassembles compressed fragments across TCP packets with an interleaved uncompressed PING', async () => {
    const h = createHarness(Buffer.alloc(0), undefined, { enableCompression: true });
    const text = '分片压缩消息'.repeat(500);
    const compressed = compressMessage(text);
    const first = buildClientFrame(OPCODE_TEXT, compressed.subarray(0, 7), { fin: false, rsv1: true });
    await h.feed(first.subarray(0, 3));
    await h.feed(first.subarray(3));
    await h.feed(buildClientFrame(OPCODE_PING, Buffer.from('alive')));
    await h.feed(buildClientFrame(OPCODE_CONTINUATION, compressed.subarray(7, 11), { fin: false }));
    await h.feed(buildClientFrame(OPCODE_CONTINUATION, compressed.subarray(11)));
    expect(h.messages).toEqual([text]);
    expect(h.serverFrames().find((f) => f.opcode === OPCODE_PONG)).toMatchObject({ rsv1: false, payload: Buffer.from('alive') });
    h.socket.destroy();
  });

  it('sends independent sync-flushed large text frames, plain small frames and plain binary frames', () => {
    const h = createHarness(Buffer.alloc(0), undefined, { enableCompression: true });
    const text = 'browser response '.repeat(500);
    h.ws.send(text);
    h.ws.send('ack');
    h.ws.send(Buffer.from([1, 2, 3]));
    h.ws.send(text);
    const frames = h.serverFrames();
    expect(frames.map((f) => f.rsv1)).toEqual([true, false, false, true]);
    for (const frame of [frames[0]!, frames[3]!]) {
      // Z_FINISH rejects a sync-flushed (BFINAL=0) stream; this catches accidental BFINAL=1 output.
      expect(() => inflateRawSync(Buffer.concat([frame.payload, DEFLATE_TAIL]))).toThrow();
      expect(inflateRawSync(Buffer.concat([frame.payload, DEFLATE_TAIL]), {
        finishFlush: zlibConstants.Z_SYNC_FLUSH,
      }).toString()).toBe(text);
    }
    expect(frames[0]!.payload).toEqual(frames[3]!.payload);
    h.socket.destroy();
  });

  it.each([
    ['unnegotiated data', false, OPCODE_TEXT],
    ['continuation', true, OPCODE_CONTINUATION],
    ['control', true, OPCODE_PING],
  ])('rejects RSV1 on %s with 1002', async (_name, enableCompression, opcode) => {
    const h = createHarness(Buffer.alloc(0), undefined, { enableCompression });
    await h.feed(buildClientFrame(opcode, Buffer.from([0]), { rsv1: true }));
    expect(h.serverFrames().find((f) => f.opcode === OPCODE_CLOSE)!.payload.readUInt16BE()).toBe(1002);
    expect(h.messages).toEqual([]);
  });

  it('bounds inflated output, including fragmented compressed messages', async () => {
    const h = createHarness(Buffer.alloc(0), 100, { enableCompression: true });
    const compressed = compressMessage('x'.repeat(10_000));
    await h.feed(buildClientFrame(OPCODE_TEXT, compressed.subarray(0, 5), { rsv1: true, fin: false }));
    await h.feed(buildClientFrame(OPCODE_CONTINUATION, compressed.subarray(5)));
    expect(h.serverFrames().find((f) => f.opcode === OPCODE_CLOSE)!.payload.readUInt16BE()).toBe(1009);
    expect(h.messages).toEqual([]);
  });

  it('rejects malformed deflate with 1007', async () => {
    const h = createHarness(Buffer.alloc(0), undefined, { enableCompression: true });
    await h.feed(buildClientFrame(OPCODE_TEXT, Buffer.from([0xff, 0xff]), { rsv1: true }));
    expect(h.serverFrames().find((f) => f.opcode === OPCODE_CLOSE)!.payload.readUInt16BE()).toBe(1007);
  });

  it('sends heartbeat PINGs, accepts a PONG and expires a silent peer', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const h = createHarness(Buffer.alloc(0), undefined, { pingIntervalMs: 25_000, enableCompression: true });
    try {
      vi.advanceTimersByTime(25_000);
      expect(h.serverFrames()[0]).toMatchObject({ opcode: OPCODE_PING, rsv1: false });
      await h.feed(buildClientFrame(OPCODE_PONG, Buffer.alloc(0)));
      vi.advanceTimersByTime(50_000);
      expect(h.ws.open).toBe(true);
      vi.advanceTimersByTime(25_000);
      expect(h.ws.open).toBe(false);
      expect(h.socket.destroyed).toBe(true);
    } finally {
      h.socket.destroy();
      vi.useRealTimers();
    }
  });
});

describe('web/server/ws.ts server-side framing', () => {
  it('uses the 7-bit length for <126 byte frames and 16-bit for larger ones', async () => {
    const h = createHarness();

    h.ws.send('short');
    await h.flush();
    expect(h.writtenBuffer()[1]).toBe(5);

    h.ws.send(new Uint8Array(300));
    await h.flush();
    const frames = h.serverFrames();
    expect(frames).toHaveLength(2);
    expect(frames[1]!.opcode).toBe(OPCODE_BINARY);
    expect(frames[1]!.payload.byteLength).toBe(300);
  });

  it('uses the 64-bit length for payloads above 65535 bytes', async () => {
    const h = createHarness();
    h.ws.send(new Uint8Array(70_000));
    await h.flush();

    const raw = h.writtenBuffer();
    expect(raw[1]! & 0x7f).toBe(127);
    expect(Number(raw.readBigUInt64BE(2))).toBe(70_000);
    expect(raw.byteLength).toBe(10 + 70_000);
  });
});

// ============================================================================
// wire.ts —— 二进制 IPC 帧
// ============================================================================

describe('web/shared/wire.ts binary IPC frames', () => {
  it('round-trips a 32 KiB octet-stream invoke with 4-byte big-endian header length', async () => {
    const data = bytes(32 * 1024, 3);
    const message: RendererToMain = {
      type: 'invoke',
      cmd: 'write_file_bytes',
      callback: 11,
      error: 12,
      headers: { 'x-test': '中文' },
      payload: { contentType: 'application/octet-stream', data },
    };

    const encoded = encodeRendererMessage(message);
    expect(encoded).toBeInstanceOf(Uint8Array);
    const frame = encoded as Uint8Array;
    const headerLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false);
    expect(headerLength).toBeGreaterThan(0);
    expect(headerLength).toBeLessThan(frame.byteLength);
    const header = JSON.parse(new TextDecoder().decode(frame.subarray(4, 4 + headerLength))) as Record<string, unknown>;
    expect(header).toMatchObject({ wire: 'invoke-raw', cmd: 'write_file_bytes', callback: 11, error: 12 });

    const decoded = decodeRendererMessage(frame) as {
      type: string;
      cmd: string;
      callback: number;
      payload: { contentType: string; data: Uint8Array };
    };
    expect(decoded.type).toBe('invoke');
    expect(decoded.cmd).toBe('write_file_bytes');
    expect(decoded.callback).toBe(11);
    expect(decoded.payload.contentType).toBe('application/octet-stream');
    expect(decoded.payload.data.byteLength).toBe(32 * 1024);
    expect(Buffer.from(decoded.payload.data).equals(Buffer.from(data))).toBe(true);
  });

  it('keeps JSON messages on text frames', async () => {
    const encoded = encodeRendererMessage({ type: 'drag-drop', phase: 'enter', paths: [] } as RendererToMain);
    expect(typeof encoded).toBe('string');
  });

  it('round-trips raw main-side result / callback / channel bodies', async () => {
    const body = bytes(65_536 + 13, 9);

    const result: MainToRenderer = { type: 'result', callbackId: 1, otherId: 2, body: { kind: 'raw', data: body } };
    const decodedResult = decodeMainMessage(encodeMainMessage(result) as Uint8Array);
    expect(decodedResult.type).toBe('result');
    if (decodedResult.type === 'result') {
      expect(decodedResult.body.kind).toBe('raw');
      expect(Buffer.from((decodedResult.body as { data: Uint8Array }).data).equals(Buffer.from(body))).toBe(true);
    }

    const channel: MainToRenderer = { type: 'channel', id: 7, index: 3, body: { kind: 'raw', data: body } };
    const decodedChannel = decodeMainMessage(encodeMainMessage(channel) as Uint8Array);
    expect(decodedChannel).toMatchObject({ type: 'channel', id: 7, index: 3 });
  });

  it('rejects truncated and non-object binary frames', async () => {
    expect(() => decodeRendererMessage(new Uint8Array([0, 0, 0]))).toThrow(/shorter than 4-byte header length/);

    const tooLong = new Uint8Array(8);
    new DataView(tooLong.buffer).setUint32(0, 99, false);
    expect(() => decodeRendererMessage(tooLong)).toThrow(/exceeds frame size/);

    const notObjectHeader = new TextEncoder().encode('[1,2]');
    const notObject = new Uint8Array(4 + notObjectHeader.byteLength);
    new DataView(notObject.buffer).setUint32(0, notObjectHeader.byteLength, false);
    notObject.set(notObjectHeader, 4);
    expect(() => decodeRendererMessage(notObject)).toThrow(/must be a JSON object/);
  });

  it('decodes a 32 KiB wire frame delivered as a fragmented binary WebSocket message', async () => {
    const data = bytes(32 * 1024, 12);
    const frame = encodeRendererMessage({
      type: 'invoke',
      cmd: 'write_file_bytes',
      callback: 21,
      error: 22,
      headers: {},
      payload: { contentType: 'application/octet-stream', data },
    }) as Uint8Array;

    const h = createHarness();
    const cut = 300;
    await h.feed(buildClientFrame(OPCODE_BINARY, frame.subarray(0, cut), { fin: false }));
    await h.feed(buildClientFrame(OPCODE_CONTINUATION, frame.subarray(cut), { fin: true }));

    expect(h.messages).toHaveLength(1);
    const decoded = decodeRendererMessage(h.messages[0]!) as {
      cmd: string;
      payload: { data: Uint8Array };
    };
    expect(decoded.cmd).toBe('write_file_bytes');
    expect(Buffer.from(decoded.payload.data).equals(Buffer.from(data))).toBe(true);
  });
});
