/**
 * Server side of RFC 6455 for the WAVE0 MCP service's `/ws/<script>` endpoint: the opening
 * handshake answer and a frame codec. The handshake never echoes `Sec-WebSocket-Extensions`
 * or `Sec-WebSocket-Protocol`, so neither client (tokio-tungstenite on A, undici on B) may
 * compress or pick a subprotocol (§9.1, §4.1).
 *
 * Plain Node TS (type-stripping safe).
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Larger client messages are a protocol error here; the fixture's JSON-RPC texts are tiny. */
const MAX_MESSAGE_BYTES = 1 << 20;

export const OPCODES = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const;

export interface Frame {
  fin: boolean;
  opcode: number;
  masked: boolean;
  payload: Buffer;
}

/** `Sec-WebSocket-Accept` for a client key (§4.2.2 item 5.4). */
export function acceptKey(key: string): string {
  return createHash('sha1').update(`${key}${GUID}`).digest('base64');
}

/** Why the upgrade request is not a valid version-13 opening handshake, or null. */
export function handshakeProblem(request: IncomingMessage): string | null {
  if (request.method !== 'GET') return `method ${request.method ?? ''}`;
  if (String(request.headers.upgrade ?? '').toLowerCase() !== 'websocket') return 'upgrade header is not websocket';
  if (request.headers['sec-websocket-version'] !== '13') return `sec-websocket-version ${String(request.headers['sec-websocket-version'] ?? '')}`;
  const key = request.headers['sec-websocket-key'];
  if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) return 'sec-websocket-key is not 16 base64 bytes';
  return null;
}

export function handshakeResponse(key: string): string {
  return `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`;
}

/** An unmasked server frame with FIN set. */
export function encodeFrame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const length = payload.length;
  let head: Buffer;
  if (length < 126) head = Buffer.from([0x80 | opcode, length]);
  else if (length < 0x10000) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([head, payload]);
}

/** Close frame body: status code, then an optional UTF-8 reason (§5.5.1). */
export function closePayload(code: number, reason = ''): Buffer {
  const body = Buffer.alloc(2 + Buffer.byteLength(reason));
  body.writeUInt16BE(code, 0);
  body.write(reason, 2);
  return body;
}

/** Incremental frame decoder: feed socket chunks, get complete frames (masks removed). Throws on oversize frames. */
export function createFrameDecoder(): (chunk: Buffer) => Frame[] {
  let buffer: Buffer = Buffer.alloc(0);
  return chunk => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    const frames: Frame[] = [];
    for (;;) {
      if (buffer.length < 2) break;
      const first = buffer[0] ?? 0;
      const second = buffer[1] ?? 0;
      let offset = 2;
      let length = second & 0x7f;
      if (length === 126) {
        if (buffer.length < 4) break;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) break;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE_BYTES)) throw new Error(`frame of ${big} bytes exceeds ${MAX_MESSAGE_BYTES}`);
        length = Number(big);
        offset = 10;
      }
      if (length > MAX_MESSAGE_BYTES) throw new Error(`frame of ${length} bytes exceeds ${MAX_MESSAGE_BYTES}`);
      const masked = (second & 0x80) !== 0;
      const start = offset + (masked ? 4 : 0);
      if (buffer.length < start + length) break;
      const payload = Buffer.from(buffer.subarray(start, start + length));
      if (masked) {
        const mask = buffer.subarray(offset, start);
        for (let index = 0; index < payload.length; index++) payload[index] = (payload[index] ?? 0) ^ (mask[index & 3] ?? 0);
      }
      frames.push({ fin: (first & 0x80) !== 0, opcode: first & 0x0f, masked, payload });
      buffer = buffer.subarray(start + length);
    }
    return frames;
  };
}

/**
 * Joins data frames into messages (§5.4). Returns the finished message's opcode and bytes, null
 * while a fragmented message is incomplete, or throws on a continuation without a start, a new
 * data frame inside a fragmented message, or an oversize message.
 */
export function createMessageAssembler(): (frame: Frame) => { opcode: number; payload: Buffer } | null {
  let opcode: number | null = null;
  let parts: Buffer[] = [];
  let size = 0;
  return frame => {
    if (frame.opcode === OPCODES.continuation) {
      if (opcode === null) throw new Error('continuation frame without a started message');
    } else {
      if (opcode !== null) throw new Error('data frame inside a fragmented message');
      opcode = frame.opcode;
      parts = [];
      size = 0;
    }
    parts.push(frame.payload);
    size += frame.payload.length;
    if (size > MAX_MESSAGE_BYTES) throw new Error(`message exceeds ${MAX_MESSAGE_BYTES} bytes`);
    if (!frame.fin) return null;
    const done = { opcode, payload: Buffer.concat(parts) };
    opcode = null;
    parts = [];
    size = 0;
    return done;
  };
}
