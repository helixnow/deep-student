/**
 * Test-only RFC 6455 client. `ws` is not a declared dependency of the workspace,
 * so the bridge tests drive the server with the same framing rules they verify.
 */
import { createHash, randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';

export type ClientMessage =
  | { type: 'text'; text: string }
  | { type: 'binary'; bytes: Uint8Array };

interface Handshake {
  status: number;
  accept: string | null;
  rest: Buffer;
}

function readHandshake(socket: Socket, key: string): Promise<Handshake> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      cleanup();
      const lines = buffer.subarray(0, end).toString('latin1').split('\r\n');
      const status = Number.parseInt(lines[0]?.split(' ')[1] ?? '', 10);
      let accept: string | null = null;
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0 && line.slice(0, colon).toLowerCase() === 'sec-websocket-accept') {
          accept = line.slice(colon + 1).trim();
        }
      }
      const expected = createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      if (status !== 101 || accept !== expected) {
        reject(new Error(`websocket handshake failed: status=${status}`));
        return;
      }
      resolve({ status, accept, rest: buffer.subarray(end + 4) });
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('websocket closed during handshake'));
    };
    function cleanup(): void {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    }
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

export class TestWebSocket {
  private readonly socket: Socket;
  private buffer: Buffer;
  private closed = false;
  private readonly queue: ClientMessage[] = [];
  private waiter: ((message: ClientMessage | null) => void) | null = null;

  private constructor(socket: Socket, rest: Buffer) {
    this.socket = socket;
    this.buffer = rest;
    socket.on('data', (chunk: Buffer) => this.feed(chunk));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
    if (rest.length > 0) queueMicrotask(() => this.feed(Buffer.alloc(0)));
  }

  static async connect(url: string, headers: Record<string, string>): Promise<TestWebSocket> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:') throw new Error(`unsupported websocket url: ${url}`);
    const key = randomBytes(16).toString('base64');
    const socket = connect(Number(parsed.port), parsed.hostname);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const request = [
      `GET ${parsed.pathname} HTTP/1.1`,
      `host: ${parsed.host}`,
      'upgrade: websocket',
      'connection: Upgrade',
      `sec-websocket-key: ${key}`,
      'sec-websocket-version: 13',
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      '',
      '',
    ].join('\r\n');
    socket.write(request);
    const handshake = await readHandshake(socket, key);
    return new TestWebSocket(socket, handshake.rest);
  }

  next(): Promise<ClientMessage | null> {
    const message = this.queue.shift();
    if (message !== undefined) return Promise.resolve(message);
    if (this.closed) return Promise.resolve(null);
    return new Promise(resolve => { this.waiter = resolve; });
  }

  sendText(text: string): void {
    this.write(0x1, Buffer.from(text, 'utf8'));
  }

  sendBinary(bytes: Uint8Array): void {
    this.write(0x2, Buffer.from(bytes));
  }

  close(): void {
    if (this.closed) return;
    this.write(0x8, Buffer.alloc(0));
    this.socket.end();
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.(null);
  }

  private deliver(message: ClientMessage): void {
    if (this.closed) return;
    const waiter = this.waiter;
    if (waiter !== null) {
      this.waiter = null;
      waiter(message);
      return;
    }
    this.queue.push(message);
  }

  private feed(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (this.parseFrame()) {
      // Keep consuming complete frames already buffered.
    }
  }

  private parseFrame(): boolean {
    if (this.buffer.length < 2) return false;
    const first = this.buffer[0]!;
    const second = this.buffer[1]!;
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (this.buffer.length < 4) return false;
      length = this.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (this.buffer.length < 10) return false;
      length = Number(this.buffer.readBigUInt64BE(2));
      offset = 10;
    }
    if (this.buffer.length < offset + length) return false;
    const payload = this.buffer.subarray(offset, offset + length);
    this.buffer = this.buffer.subarray(offset + length);
    if (opcode === 0x8) {
      this.finish();
      return false;
    }
    if (opcode === 0x9) {
      this.write(0xa, payload);
      return true;
    }
    if (opcode === 0xa) return true;
    if (!fin) throw new Error('fragmented server frame');
    this.deliver({
      type: opcode === 0x1 ? 'text' : 'binary',
      ...(opcode === 0x1
        ? { text: payload.toString('utf8') }
        : { bytes: new Uint8Array(payload) }),
    } as ClientMessage);
    return true;
  }

  private write(opcode: number, body: Buffer): void {
    if (this.closed || this.socket.destroyed) return;
    const mask = randomBytes(4);
    let header: Buffer;
    if (body.length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | body.length;
    } else if (body.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(body.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(body.length), 2);
    }
    const masked = Buffer.from(body);
    for (let index = 0; index < masked.length; index += 1) {
      masked[index] = masked[index]! ^ mask[index % 4]!;
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }
}
