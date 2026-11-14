/**
 * `dstu-media/src/media/bilibili_transport/bridge_server.rs`: the loopback
 * HTTP + WebSocket server that pairs a browser userscript, runs the capability
 * probe, and forwards bounded requests through `BridgeHub`.
 *
 * Assets mirror `src-tauri/resources/bilibili/`; `tests/bilibili-bridge-server.test.ts`
 * checks the copies stay byte-identical while the Rust tree is present.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  BridgeHub, FRAME_LIMIT, parseBridgeControl, type BridgeChannel,
} from './bilibili-bridge-hub.ts';
import { BRIDGE_BASE, allowedOrigin } from './bilibili-bridge.ts';
import { isRecord, probeTask } from './bilibili-bridge-probe.ts';
import { BiliRequestError } from './bilibili-policy.ts';

export { decodeAccount } from './bilibili-bridge-probe.ts';

const SOCKET_LIMIT = 4;
const ASSET_ROOT = new URL('../assets/bilibili/', import.meta.url);

let pageCache: string | null = null;
let scriptCache: string | null = null;

function pairPage(): string {
  pageCache ??= readFileSync(new URL('pair.html', ASSET_ROOT), 'utf8');
  return pageCache;
}

function bridgeScript(): string {
  scriptCache ??= readFileSync(
    new URL('deepstudent-bili-bridge.user.js.txt', ASSET_ROOT), 'utf8');
  return scriptCache;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.length === 1 ? value[0]! : value.join(', ');
  return null;
}

function requestOrigin(req: IncomingMessage, port: number, require: boolean): boolean {
  const headers: Record<string, string> = {};
  for (const name of ['host', 'origin']) {
    const value = headerValue(req.headers[name]);
    if (value !== null) headers[name] = value;
  }
  return allowedOrigin(headers, port, require);
}

function hasQuery(url: string | undefined): boolean {
  return url !== undefined && url.includes('?');
}

function sendText(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'none'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    'content-length': Buffer.byteLength(body, 'utf8'),
  });
  res.end(body);
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  const body = Buffer.from(reason, 'utf8');
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n`
    + 'connection: close\r\n'
    + 'content-type: text/plain\r\n'
    + `content-length: ${body.length}\r\n\r\n`,
  );
  socket.end(body);
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>(resolve => server.close(() => resolve()));
}

type PeerMessage =
  | { type: 'text'; text: string }
  | { type: 'binary'; bytes: Uint8Array }
  | { type: 'ping'; bytes: Uint8Array };

/** Minimal RFC 6455 server peer: masked client frames in, unmasked server frames out. */
export class WebSocketPeer {
  private buffer: Buffer;
  private fragments: Buffer[] = [];
  private fragmentOpcode: number | null = null;
  private closed = false;
  private readonly queue: PeerMessage[] = [];
  private waiter: ((message: PeerMessage | null) => void) | null = null;
  private readonly socket: Duplex;

  constructor(socket: Duplex, head: Buffer) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => this.feed(chunk));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
    if (head.length > 0) this.feed(head);
  }

  next(): Promise<PeerMessage | null> {
    const message = this.queue.shift();
    if (message !== undefined) return Promise.resolve(message);
    if (this.closed) return Promise.resolve(null);
    return new Promise(resolve => { this.waiter = resolve; });
  }

  sendText(text: string): void {
    this.write(0x1, Buffer.from(text, 'utf8'));
  }

  sendPong(bytes: Uint8Array): void {
    this.write(0xa, bytes);
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
    this.fragments = [];
    this.fragmentOpcode = null;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.(null);
  }

  private deliver(message: PeerMessage): void {
    if (this.closed) return;
    const waiter = this.waiter;
    if (waiter !== null) {
      this.waiter = null;
      waiter(message);
      return;
    }
    this.queue.push(message);
  }

  private protocolClose(): void {
    if (this.closed) return;
    this.write(0x8, Buffer.from([0x03, 0xea]));
    this.socket.end();
    this.finish();
  }

  private write(opcode: number, payload: Uint8Array): void {
    if (this.closed || this.socket.destroyed) return;
    const body = Buffer.from(payload);
    let frame: Buffer;
    if (body.length < 126) {
      frame = Buffer.alloc(2);
      frame[0] = 0x80 | opcode;
      frame[1] = body.length;
    } else if (body.length <= 0xffff) {
      frame = Buffer.alloc(4);
      frame[0] = 0x80 | opcode;
      frame[1] = 126;
      frame.writeUInt16BE(body.length, 2);
    } else {
      frame = Buffer.alloc(10);
      frame[0] = 0x80 | opcode;
      frame[1] = 127;
      frame.writeBigUInt64BE(BigInt(body.length), 2);
    }
    try {
      this.socket.write(Buffer.concat([frame, body]));
    } catch {
      this.finish();
    }
  }

  private feed(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    try {
      while (this.parseFrame()) {
        // Keep consuming complete frames already buffered.
      }
    } catch {
      this.protocolClose();
    }
  }

  private parseFrame(): boolean {
    if (this.buffer.length < 2) return false;
    const first = this.buffer[0]!;
    const second = this.buffer[1]!;
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (this.buffer.length < 4) return false;
      length = this.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (this.buffer.length < 10) return false;
      const wide = this.buffer.readBigUInt64BE(2);
      if (wide > BigInt(FRAME_LIMIT)) {
        this.protocolClose();
        return false;
      }
      length = Number(wide);
      offset = 10;
    }
    if (!masked || length > FRAME_LIMIT) {
      this.protocolClose();
      return false;
    }
    if (this.buffer.length < offset + 4 + length) return false;
    const mask = this.buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = payload[index]! ^ mask[index % 4]!;
    }
    this.buffer = this.buffer.subarray(offset + length);
    this.handleFrame(fin, opcode, payload);
    return true;
  }

  private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode === 0x8) {
      this.write(0x8, payload);
      this.socket.end();
      this.finish();
      return;
    }
    if (opcode === 0x9) {
      if (!fin || payload.length > 125) {
        this.protocolClose();
        return;
      }
      this.deliver({ type: 'ping', bytes: payload });
      return;
    }
    if (opcode === 0xa) {
      // Rust `connection` treats a protocol Pong as an unknown message and closes.
      this.socket.end();
      this.finish();
      return;
    }
    if (opcode === 0x0) {
      if (this.fragmentOpcode === null) {
        this.protocolClose();
        return;
      }
      this.fragments.push(payload);
      if (this.fragments.reduce((total, part) => total + part.length, 0) > FRAME_LIMIT) {
        this.protocolClose();
        return;
      }
      if (!fin) return;
      const complete = Buffer.concat(this.fragments);
      const initial = this.fragmentOpcode;
      this.fragments = [];
      this.fragmentOpcode = null;
      this.deliverMessage(initial, complete);
      return;
    }
    if (opcode === 0x1 || opcode === 0x2) {
      if (this.fragmentOpcode !== null) {
        this.protocolClose();
        return;
      }
      if (!fin) {
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        return;
      }
      this.deliverMessage(opcode, payload);
      return;
    }
    this.protocolClose();
  }

  private deliverMessage(opcode: number, payload: Buffer): void {
    if (payload.length > FRAME_LIMIT) {
      this.protocolClose();
      return;
    }
    if (opcode === 0x1) {
      this.deliver({ type: 'text', text: payload.toString('utf8') });
    } else {
      this.deliver({ type: 'binary', bytes: payload });
    }
  }
}

export class BridgeServer {
  readonly hub: BridgeHub;
  private server: Server | null = null;
  private port: number | null = null;
  private starting: Promise<number> | null = null;
  /** Bumped by `close()`; a `listen()` that started under an older generation discards its server. */
  private generation = 0;
  private sockets = 0;
  private readonly peers = new Set<WebSocketPeer>();

  constructor(hub: BridgeHub) {
    this.hub = hub;
  }

  async start(): Promise<number> {
    if (this.port !== null) return this.port;
    this.starting ??= this.listen();
    const starting = this.starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  async close(): Promise<void> {
    this.generation += 1;
    const starting = this.starting;
    // A start() issued while this close() is pending must bind afresh, not join the doomed listen().
    this.starting = null;
    const server = this.server;
    this.server = null;
    this.port = null;
    for (const peer of this.peers) peer.close();
    this.peers.clear();
    if (starting !== null) await starting.catch(() => undefined);
    if (server === null) return;
    await closeServer(server);
  }

  private async listen(): Promise<number> {
    const generation = this.generation;
    const server = createServer((request, response) => {
      void this.serve(request, response).catch(() => {
        if (!response.headersSent) sendText(response, 500, 'text/plain', 'Internal Error');
        else response.destroy();
      });
    });
    server.on('upgrade', (request, socket, head) => this.upgrade(request, socket, head));
    const port = await new Promise<number>((resolve, reject) => {
      const onError = (): void => {
        server.off('listening', onListening);
        reject(new BiliRequestError('bridge-server', '无法启动本地浏览器桥'));
      };
      const onListening = (): void => {
        server.off('error', onError);
        const address = server.address();
        if (typeof address === 'object' && address !== null) resolve(address.port);
        else {
          server.close();
          reject(new BiliRequestError('bridge-server', '无法读取浏览器桥端口'));
        }
      };
      server.once('error', onError);
      server.listen(0, '127.0.0.1', onListening);
    });
    if (generation !== this.generation) {
      await closeServer(server);
      throw new BiliRequestError('bridge-server', '浏览器桥已关闭');
    }
    server.on('error', () => this.hub.disconnect(null));
    this.server = server;
    this.port = port;
    return port;
  }

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const port = this.port;
    if (port === null) {
      sendText(response, 503, 'text/plain', 'Unavailable');
      return;
    }
    if (!requestOrigin(request, port, false) || hasQuery(request.url)
      || request.method !== 'GET') {
      sendText(response, 403, 'text/plain', 'Forbidden');
      return;
    }
    const path = request.url ?? '';
    if (path === BRIDGE_BASE) {
      sendText(response, 200, 'text/html; charset=utf-8', pairPage());
      return;
    }
    if (path === `${BRIDGE_BASE}deepstudent-bili-bridge.user.js`) {
      sendText(response, 200, 'text/javascript; charset=utf-8', bridgeScript());
      return;
    }
    if (path.startsWith(`${BRIDGE_BASE}probe/`)) {
      const id = this.hub.status().connectionId;
      if (id === null || !this.hub.approved(id)) {
        sendText(response, 403, 'text/plain', 'Not paired');
        return;
      }
      await this.probeResponse(request, response, port);
      return;
    }
    sendText(response, 403, 'text/plain', 'Forbidden');
  }

  private async probeResponse(
    request: IncomingMessage,
    response: ServerResponse,
    port: number,
  ): Promise<void> {
    const path = request.url ?? '';
    if (path.endsWith('/redirect')) {
      response.writeHead(302, {
        location: `http://127.0.0.1:${port}${BRIDGE_BASE}probe/target`,
      });
      response.end();
      return;
    }
    if (path.endsWith('/ignored-range')) {
      response.writeHead(200, { 'content-length': '1000000000' });
      response.end();
      return;
    }
    if (path.endsWith('/seed')) {
      response.writeHead(200, {
        'set-cookie': 'ds_bili_probe=1; Path=/deepstudent-bili-bridge/v1/probe/; SameSite=Strict; HttpOnly',
        'content-length': '4',
      });
      response.end('seed');
      return;
    }
    if (path.endsWith('/anonymous')) {
      const anonymous = headerValue(request.headers.cookie) === null;
      response.writeHead(200, { 'content-length': '4' });
      response.end(anonymous ? 'anon' : 'leak');
      return;
    }
    if (path.endsWith('/credential')) {
      const cookie = headerValue(request.headers.cookie) ?? '';
      response.writeHead(200, { 'content-length': '4' });
      response.end(cookie.includes('ds_bili_probe=1') ? 'sent' : 'none');
      return;
    }
    if (path.endsWith('/headers')) {
      const correct = headerValue(request.headers.range) === 'bytes=0-3'
        && headerValue(request.headers.referer) === 'https://www.bilibili.com/';
      response.writeHead(206, {
        'content-length': '4',
        'content-range': 'bytes 0-3/4',
      });
      response.end(correct ? 'bili' : 'fail');
      return;
    }
    if (path.endsWith('/oversize')) {
      response.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-range': 'bytes 0-524287/524288',
      });
      for (let index = 0; index < 128; index += 1) {
        if (response.destroyed) return;
        response.write(Buffer.alloc(4096));
        await new Promise(resolve => setTimeout(resolve, 3));
      }
      response.end();
      return;
    }
    response.writeHead(206, {
      'content-length': '4',
      'content-range': 'bytes 0-3/4',
    });
    response.end('bili');
  }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const port = this.port;
    const path = request.url ?? '';
    if (port === null || !requestOrigin(request, port, true) || hasQuery(request.url)
      || request.method !== 'GET' || path !== `${BRIDGE_BASE}socket`) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    const upgrade = headerValue(request.headers.upgrade);
    if (upgrade === null || upgrade.toLowerCase() !== 'websocket'
      || headerValue(request.headers['sec-websocket-version']) !== '13') {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    const key = headerValue(request.headers['sec-websocket-key']);
    if (key === null) {
      rejectUpgrade(socket, 400, 'Invalid handshake');
      return;
    }
    if (this.sockets >= SOCKET_LIMIT) {
      rejectUpgrade(socket, 429, 'Busy');
      return;
    }
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'upgrade: websocket\r\n'
      + 'connection: Upgrade\r\n'
      + `sec-websocket-accept: ${accept}\r\n\r\n`,
    );
    this.sockets += 1;
    const peer = new WebSocketPeer(socket, head);
    this.peers.add(peer);
    void this.connection(peer, port).finally(() => {
      this.peers.delete(peer);
      this.sockets -= 1;
    });
  }

  private async connection(peer: WebSocketPeer, port: number): Promise<void> {
    let id: string | null = null;
    let ping: NodeJS.Timeout | null = null;
    let lastSeen = Date.now();
    const abort = new AbortController();
    try {
      const hello = await this.withTimeout(peer.next(), 5_000);
      if (hello === null || hello.type !== 'text') {
        throw new BiliRequestError('bridge-auth', '浏览器桥握手失败');
      }
      let value: unknown;
      try {
        value = JSON.parse(hello.text);
      } catch {
        throw new BiliRequestError('bridge-auth', '浏览器桥握手失败');
      }
      if (!isRecord(value) || value.type !== 'hello' || value.protocol !== 1
        || value.scriptVersion !== '1.0.1') {
        throw new BiliRequestError('bridge-version', '浏览器桥版本不兼容');
      }
      const channel: BridgeChannel = {
        send: text => peer.sendText(text),
        close: () => peer.close(),
      };
      id = typeof value.resumeToken === 'string'
        ? this.hub.reconnect(value.resumeToken, channel)
        : this.hub.authenticate(
          typeof value.challenge === 'string' ? value.challenge : '',
          port,
          '1.0.1',
          channel,
        );
      void probeTask(this.hub, id, peer, port, abort.signal);
      ping = setInterval(() => {
        if (Date.now() - lastSeen > 15_000
          || this.hub.status().connectionId !== id) {
          peer.close();
          return;
        }
        peer.sendText(JSON.stringify({ type: 'ping' }));
      }, 5_000);
      for (;;) {
        const message = await peer.next();
        if (message === null) break;
        lastSeen = Date.now();
        if (message.type === 'text') {
          let control: unknown;
          try {
            control = JSON.parse(message.text);
          } catch {
            break;
          }
          if (isRecord(control) && control.type === 'pong') {
            this.hub.heartbeat();
            continue;
          }
          const parsed = isRecord(control)
            ? parseBridgeControl(control)
            : null;
          if (parsed === null) break;
          this.hub.deliver(id, parsed.id, parsed.reply);
          continue;
        }
        if (message.type === 'binary') {
          if (message.bytes.length < 12 || message.bytes.length > FRAME_LIMIT) break;
          const frame = Buffer.from(message.bytes);
          const requestId = Number(frame.readBigUInt64BE(0));
          const sequence = frame.readUInt32BE(8);
          this.hub.deliver(id, requestId, {
            type: 'chunk',
            sequence,
            bytes: message.bytes.subarray(12),
          });
          continue;
        }
        peer.sendPong(message.bytes);
      }
    // boundary-allow empty-catch: 握手失败或协议错误时 Rust 忽略连接任务错误并关闭套接字，不登记失败状态
    } catch {
    } finally {
      if (ping !== null) clearInterval(ping);
      abort.abort();
      if (id !== null) this.hub.disconnect(id);
      peer.close();
    }
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
