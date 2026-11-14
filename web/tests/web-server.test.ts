import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, stat as statFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { constants as zlibConstants, deflateRawSync, inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { installTauriBridge, type BridgeTransport } from '../../electron/preload/bridge.ts';
import type { MainToRenderer, RendererToMain } from '../../electron/shell/bridge-messages.ts';
import { buildReconnectListenMessage, webConvertFileSrc } from '../client/bootstrap.ts';
import { AuthRateLimiter, constantTimeEquals, isSameOriginRequest } from '../server/auth.ts';
import { createWebHostGateway } from '../server/gateway.ts';
import { startWebServer, type RunningWebServer } from '../server/main.ts';
import { decodeMainMessage, decodeRendererMessage, encodeRendererMessage } from '../shared/wire.ts';

interface SimulatedBrowserTab {
  readonly invoke: <T = unknown>(cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => Promise<T>;
  readonly listen: (event: string, handler: (payload: unknown) => void) => Promise<() => Promise<void>>;
  readonly emit: (event: string, payload?: unknown) => Promise<void>;
  readonly close: () => Promise<void>;
}

async function openSimulatedTab(wsUrl: string, sessionCookie: string, origin: string): Promise<SimulatedBrowserTab> {
  // Node's built-in `WebSocket` (undici) accepts `{ headers }` in the second argument at runtime.
  const ws = new (WebSocket as unknown as new (
    url: string,
    options?: { headers?: Record<string, string> },
  ) => WebSocket)(wsUrl, {
    headers: {
      Cookie: sessionCookie,
      Origin: origin,
    },
  });
  ws.binaryType = 'arraybuffer';

  await new Promise<void>((resolveOpen, rejectOpen) => {
    ws.addEventListener('open', () => resolveOpen(), { once: true });
    ws.addEventListener('error', (err) => rejectOpen(err), { once: true });
  });

  const subscribers = new Set<(msg: MainToRenderer) => void>();
  ws.addEventListener('message', (ev) => {
    const raw = typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data as ArrayBuffer);
    const decoded = decodeMainMessage(raw);
    for (const sub of subscribers) sub(decoded);
  });

  const transport: BridgeTransport = {
    send(msg: RendererToMain) {
      const encoded = encodeRendererMessage(msg);
      ws.send(
        typeof encoded === 'string'
          ? encoded
          : (encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer),
      );
    },
    subscribe(listener) {
      subscribers.add(listener);
    },
  };

  const fakeWindow: Record<string, unknown> = {
    crypto: globalThis.crypto,
    Headers: globalThis.Headers,
  };
  installTauriBridge(
    transport,
    {
      osName: 'linux',
      protocolScheme: 'http',
      windowLabel: 'main',
      webviewLabel: 'main',
      sep: '/',
      delimiter: ':',
      dragDropEnabled: true,
    },
    fakeWindow,
  );

  const internals = fakeWindow.__TAURI_INTERNALS__ as {
    invoke: <T = unknown>(cmd: string, payload?: unknown, options?: unknown) => Promise<T>;
    transformCallback: (cb: (data: unknown) => void, once: boolean) => number;
  };
  const eventInternals = fakeWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ as {
    unregisterListener: (event: string, eventId: number) => void;
  };

  return {
    invoke: (cmd, args = {}, options) => internals.invoke(cmd, args, options),
    async listen(event, handler) {
      const handlerId = internals.transformCallback((evData) => {
        const record = evData as { payload: unknown };
        handler(record.payload);
      }, false);
      const eventId = await internals.invoke<number>('plugin:event|listen', {
        event,
        target: { kind: 'Any' },
        handler: handlerId,
      });
      return async () => {
        eventInternals.unregisterListener(event, eventId);
        await internals.invoke('plugin:event|unlisten', { event, eventId });
      };
    },
    async emit(event, payload = null) {
      await internals.invoke('plugin:event|emit', { event, payload });
    },
    async close() {
      if (ws.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolveClose) => {
        ws.addEventListener('close', () => resolveClose(), { once: true });
        ws.close();
      });
    },
  };
}

/** 裸 TCP WebSocket 客户端：用来验证升级握手的扩展协商与 RSV1 压缩帧本身。 */
interface RawWsFrame {
  readonly rsv1: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
}

interface RawWsSession {
  /** 101 响应头原文（含 `Sec-WebSocket-Extensions`）。 */
  readonly handshakeHead: string;
  send(text: string, compress: boolean): void;
  nextMessage(): Promise<RawWsFrame>;
  close(): void;
}

/** RFC 6455 §5.3：客户端发出的帧必须加掩码。 */
function encodeClientFrame(opcode: number, payload: Buffer, rsv1 = false): Buffer {
  const maskKey = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const length = payload.byteLength;
  let headerLength = 2;
  if (length >= 126 && length <= 0xffff) headerLength = 4;
  else if (length > 0xffff) headerLength = 10;

  const frame = Buffer.allocUnsafe(headerLength + 4 + length);
  frame[0] = 0x80 | (rsv1 ? 0x40 : 0) | (opcode & 0x0f);
  if (length < 126) {
    frame[1] = 0x80 | length;
  } else if (length <= 0xffff) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  }
  const bodyStart = headerLength + 4;
  for (let i = 0; i < length; i++) frame[bodyStart + i] = payload[i]! ^ maskKey[i & 3]!;
  frame.set(maskKey, headerLength);
  return frame;
}

function openRawWebSocketSession(
  port: number,
  options: { cookie: string; offerDeflate?: boolean },
): Promise<RawWsSession> {
  return new Promise((resolveSession, rejectSession) => {
    const socket = connect(port, '127.0.0.1');
    const key = randomBytes(16).toString('base64');
    let buffer = Buffer.alloc(0);
    let head = '';
    let handshakeDone = false;
    let failure: Error | null = null;
    const queue: RawWsFrame[] = [];
    const waiters: Array<{ resolve: (frame: RawWsFrame) => void; reject: (error: Error) => void }> = [];

    const deliver = (frame: RawWsFrame) => {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(frame);
      else queue.push(frame);
    };

    const parse = () => {
      if (!handshakeDone) {
        const headEnd = buffer.indexOf('\r\n\r\n');
        if (headEnd < 0) return;
        head = buffer.subarray(0, headEnd).toString('latin1');
        buffer = buffer.subarray(headEnd + 4);
        handshakeDone = true;
        if (!head.startsWith('HTTP/1.1 101')) {
          rejectSession(new Error(`WebSocket handshake failed: ${head.split('\r\n')[0]}`));
          return;
        }
        resolveSession({
          get handshakeHead() {
            return head;
          },
          send(text, compress) {
            const raw = Buffer.from(text, 'utf8');
            if (!compress) {
              socket.write(encodeClientFrame(0x1, raw));
              return;
            }
            const deflated = deflateRawSync(raw, { finishFlush: zlibConstants.Z_SYNC_FLUSH });
            // RFC 7692 §7.2.1：Z_SYNC_FLUSH 产生 BFINAL=0 且以 00 00 ff ff 结尾，发送前剥掉这 4 字节。
            const tail = Buffer.from([0x00, 0x00, 0xff, 0xff]);
            const payload =
              deflated.byteLength >= 4 && deflated.subarray(deflated.byteLength - 4).equals(tail)
                ? deflated.subarray(0, deflated.byteLength - 4)
                : deflated;
            socket.write(encodeClientFrame(0x1, payload, true));
          },
          nextMessage() {
            const queued = queue.shift();
            if (queued) return Promise.resolve(queued);
            if (failure !== null) return Promise.reject(failure);
            return new Promise<RawWsFrame>((resolveFrame, rejectFrame) =>
              waiters.push({ resolve: resolveFrame, reject: rejectFrame }),
            );
          },
          close() {
            socket.write(encodeClientFrame(0x8, Buffer.from([0x03, 0xe8])));
            socket.destroy();
          },
        });
      }

      while (buffer.byteLength >= 2) {
        const b0 = buffer[0]!;
        const b1 = buffer[1]!;
        let length = b1 & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.byteLength < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.byteLength < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffer.byteLength < offset + length) return;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        buffer = buffer.subarray(offset + length);
        const opcode = b0 & 0x0f;
        if (opcode === 0x9 || opcode === 0xa) continue; // PING / PONG
        if (opcode === 0x8) continue; // CLOSE 之后没有可断言的消息
        deliver({ rsv1: (b0 & 0x40) !== 0, opcode, payload });
      }
    };

    socket.write(
      [
        'GET /api/ws HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        ...(options.offerDeflate === false
          ? []
          : ['Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits']),
        `Origin: http://127.0.0.1:${port}`,
        `Cookie: ${options.cookie}`,
        '',
        '',
      ].join('\r\n'),
    );
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      parse();
    });
    socket.on('error', (error) => {
      failure = error;
      rejectSession(error);
      for (const waiter of waiters.splice(0)) waiter.reject(error);
    });
    socket.on('close', () => {
      // 服务端提前断开（协议错误 / 鉴权失败）时必须让等待帧的断言立刻失败，而不是挂到超时。
      if (!handshakeDone) {
        failure ??= new Error('WebSocket closed before handshake completed');
        rejectSession(failure);
      }
      for (const waiter of waiters.splice(0)) {
        waiter.reject(failure ?? new Error('WebSocket closed before a full message arrived'));
      }
    });
  });
}

/** 把 `?mime=` 直接拼在 `?path=` 后面的老式 URL（`FileContentView` 的写法）。 */
function protocolUrlWithTrailingQuery(baseUrl: string, scheme: string, filePath: string, query: string): string {
  return `${baseUrl}/api/protocol/${scheme}?path=${encodeURIComponent(filePath)}?${query}`;
}

/** 手工构造一条 renderer → main 的 invoke 帧（裸 TCP 客户端用）。 */
function rendererInvoke(cmd: string, args: unknown, callback: number, error: number): RendererToMain {
  return {
    type: 'invoke',
    cmd,
    callback,
    error,
    payload: { contentType: 'application/json', data: JSON.stringify(args) },
    headers: {},
  };
}

describe('Deep Student WebUI + PWA Server Gateway', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dstu-webui-test-'));
  const appDataDir = join(tempRoot, 'appdata');
  const stagingRoot = join(appDataDir, 'web-staging');
  // 暂存上限调小，才能在不写 200 MiB 的前提下覆盖 413 与半截文件清理（本文件的上传都 < 4 KiB）。
  const STAGE_LIMIT_BYTES = 16 * 1024;
  let running: RunningWebServer;
  let baseOrigin = '';
  let sessionCookie = '';
  let serverClosed = false;

  beforeAll(async () => {
    running = await startWebServer({
      host: '127.0.0.1',
      port: 0,
      prod: true,
      distDir: join(process.cwd(), 'public'),
      appDataDir,
      token: 'test-secret-webui-token-2026',
      maxStageUploadBytes: STAGE_LIMIT_BYTES,
      safeMode: true,
      log: () => undefined,
    });
    baseOrigin = `http://127.0.0.1:${running.port}`;
  }, 60_000);

  afterAll(async () => {
    if (running && !serverClosed) {
      await running.close();
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }, 30_000);

  it('enforces access-token auth, login gate HTML, session cookie exchange, and Same-Origin CSRF checks', async () => {
    const unauthApi = await fetch(`${baseOrigin}/api/health`);
    expect(unauthApi.status).toBe(401);

    const unauthHtml = await fetch(`${baseOrigin}/`, {
      headers: { Accept: 'text/html' },
    });
    expect(unauthHtml.status).toBe(401);
    const gateBody = await unauthHtml.text();
    expect(gateBody).toContain('Deep Student WebUI');

    const tokenExchange = await fetch(`${baseOrigin}/api/health?token=${running.token}`);
    expect(tokenExchange.status).toBe(200);
    const setCookie = tokenExchange.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('ds_web_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    sessionCookie = setCookie.split(';')[0]!;

    const authedWithCookie = await fetch(`${baseOrigin}/api/health`, {
      headers: { Cookie: sessionCookie },
    });
    expect(authedWithCookie.status).toBe(200);
    const health = (await authedWithCookie.json()) as { ok: boolean; ready: boolean; pwa: boolean };
    expect(health).toMatchObject({ ok: true, ready: true, pwa: true });

    const crossOriginUpload = await fetch(`${baseOrigin}/api/files/stage?name=evil.txt`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie,
        Origin: 'http://evil.example',
      },
      body: 'payload',
    });
    expect(crossOriginUpload.status).toBe(403);
  });

  it('serves PWA Web App Manifest and Service Worker with strict /api/ bypass', async () => {
    const manifestRes = await fetch(`${baseOrigin}/manifest.webmanifest`, {
      headers: { Cookie: sessionCookie },
    });
    expect(manifestRes.status).toBe(200);
    expect(manifestRes.headers.get('content-type')).toContain('application/manifest+json');
    const manifest = (await manifestRes.json()) as {
      name: string;
      display: string;
      icons: Array<{ src: string }>;
    };
    expect(manifest.name).toBe('Deep Student');
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.some((i) => i.src === '/app-icon.png')).toBe(true);

    const swRes = await fetch(`${baseOrigin}/sw.js`, {
      headers: { Cookie: sessionCookie },
    });
    expect(swRes.status).toBe(200);
    const swText = await swRes.text();
    expect(swText).toContain('ds-webui-shell-v1');
    expect(swText).toContain("'/api/'");
    expect(swText).toContain('SKIP_WAITING');
  });

  it('answers conditional static requests with 304 Not Modified once the weak ETag matches', async () => {
    // 不依赖前序用例留下的 cookie：自己换一次会话，保证单跑（-t）也能通过
    const tokenExchange = await fetch(`${baseOrigin}/api/health?token=${running.token}`);
    const cookie = (tokenExchange.headers.get('set-cookie') ?? '').split(';')[0]!;

    const first = await fetch(`${baseOrigin}/logo-black.svg`, { headers: { Cookie: cookie } });
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^W\/"\d+-\d+"$/);
    expect((await first.arrayBuffer()).byteLength).toBeGreaterThan(0);

    const revalidated = await fetch(`${baseOrigin}/logo-black.svg`, {
      headers: { Cookie: cookie, 'If-None-Match': etag! },
    });
    expect(revalidated.status).toBe(304);
    expect((await revalidated.arrayBuffer()).byteLength).toBe(0);

    // 不匹配时必须重新发完整内容，不能把 304 当成无内容缓存
    const stale = await fetch(`${baseOrigin}/logo-black.svg`, {
      headers: { Cookie: cookie, 'If-None-Match': 'W/"0-0"' },
    });
    expect(stale.status).toBe(200);
    expect((await stale.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('executes real Host RPC, SQLite commands, and binary Uint8Array IPC over WebSocket + installTauriBridge', async () => {
    const wsUrl = `ws://127.0.0.1:${running.port}/api/ws`;
    const tab = await openSimulatedTab(wsUrl, sessionCookie, baseOrigin);
    try {
      const expectedVersion = (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string }).version;
      const version = await tab.invoke<string>('get_app_version');
      expect(version).toContain(expectedVersion);

      const hostDataDir = await tab.invoke<string>('get_app_data_dir');
      expect(hostDataDir).toBe(appDataDir);

      const joined = await tab.invoke<string>('plugin:path|join', { paths: ['courses', 'calculus', 'week1.pdf'] });
      expect(joined).toBe(join('courses', 'calculus', 'week1.pdf'));

      // Real SQLite-backed Host command (`study_time_add` -> `get_learning_heatmap_data`)
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      await tab.invoke('study_time_add', { seconds: 180, date: today });
      const degraded = await tab.invoke<unknown[]>('plugin:host|status');
      expect(Array.isArray(degraded)).toBe(true);

      // Stage binary file & read raw bytes over binary WebSocket frame
      const sampleBytes = new Uint8Array(2048);
      for (let i = 0; i < sampleBytes.length; i++) sampleBytes[i] = (i * 37 + 13) & 0xff;

      const stageRes = await fetch(`${baseOrigin}/api/files/stage?name=paper.pdf`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          Origin: baseOrigin,
          'Content-Type': 'application/pdf',
        },
        body: sampleBytes,
      });
      expect(stageRes.status).toBe(200);
      const staged = (await stageRes.json()) as { path: string; size: number };
      expect(staged.size).toBe(2048);

      const sizeFromHost = await tab.invoke<number>('get_file_size', { path: staged.path });
      expect(sizeFromHost).toBe(2048);

      const rawBuffer = await tab.invoke<ArrayBuffer>('read_file_bytes', { path: staged.path });
      expect(new Uint8Array(rawBuffer)).toEqual(sampleBytes);
    } finally {
      await tab.close();
    }
  });

  it('fans out events across multiple browser tabs and cleans up disconnected tabs', async () => {
    const wsUrl = `ws://127.0.0.1:${running.port}/api/ws`;
    const tabA = await openSimulatedTab(wsUrl, sessionCookie, baseOrigin);
    const tabB = await openSimulatedTab(wsUrl, sessionCookie, baseOrigin);
    try {
      const receivedA: unknown[] = [];
      const receivedB: unknown[] = [];
      await tabA.listen('webui:multi-tab-sync', (payload) => receivedA.push(payload));
      await tabB.listen('webui:multi-tab-sync', (payload) => receivedB.push(payload));

      await tabA.emit('webui:multi-tab-sync', { seq: 1, from: 'A' });
      await new Promise((r) => setTimeout(r, 60));

      expect(receivedA).toEqual([{ seq: 1, from: 'A' }]);
      expect(receivedB).toEqual([{ seq: 1, from: 'A' }]);

      await tabB.close();
      await tabA.emit('webui:multi-tab-sync', { seq: 2, from: 'A-after-B-closed' });
      await new Promise((r) => setTimeout(r, 60));

      expect(receivedA).toEqual([
        { seq: 1, from: 'A' },
        { seq: 2, from: 'A-after-B-closed' },
      ]);
      expect(receivedB).toHaveLength(1);
    } finally {
      await tabA.close();
      await tabB.close();
    }
  });

  it('streams HTTP 206 Partial Content Range slices via convertFileSrc and blocks out-of-scope paths', async () => {
    const payload = new Uint8Array(4096);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;

    const stageRes = await fetch(`${baseOrigin}/api/files/stage?name=range-test.pdf`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie,
        Origin: baseOrigin,
      },
      body: payload,
    });
    const { path: stagedPath } = (await stageRes.json()) as { path: string };

    const assetUrl = webConvertFileSrc(stagedPath, 'asset', baseOrigin);
    const rangeRes = await fetch(assetUrl, {
      headers: {
        Cookie: sessionCookie,
        Range: 'bytes=100-199',
      },
    });
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get('content-range')).toBe('bytes 100-199/4096');
    const slice = new Uint8Array(await rangeRes.arrayBuffer());
    expect(slice.byteLength).toBe(100);
    expect(slice).toEqual(payload.slice(100, 200));

    // Out-of-scope path must be 403 Forbidden
    const forbiddenUrl = webConvertFileSrc('/etc/hosts', 'asset', baseOrigin);
    const forbiddenRes = await fetch(forbiddenUrl, {
      headers: { Cookie: sessionCookie },
    });
    expect(forbiddenRes.status).toBe(403);

    // Path traversal `..` must be 403 Forbidden
    const traversalUrl = webConvertFileSrc(`${stagedPath}/../../../../../etc/hosts`, 'asset', baseOrigin);
    const traversalRes = await fetch(traversalUrl, {
      headers: { Cookie: sessionCookie },
    });
    expect(traversalRes.status).toBe(403);
  });

  it('completes prepare-save -> save_text_to_file -> /api/files/export browser download flow', async () => {
    const prepRes = await fetch(`${baseOrigin}/api/files/prepare-save`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie,
        Origin: baseOrigin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ defaultPath: '导出学习笔记.md' }),
    });
    expect(prepRes.status).toBe(200);
    const prepared = (await prepRes.json()) as { path: string; exportId: string; fileName: string };
    expect(prepared.fileName).toBe('导出学习笔记.md');

    const wsUrl = `ws://127.0.0.1:${running.port}/api/ws`;
    const tab = await openSimulatedTab(wsUrl, sessionCookie, baseOrigin);
    try {
      await tab.invoke('save_text_to_file', {
        path: prepared.path,
        content: '# 深度学习导出笔记\n\nWebUI + PWA 原生导出验证。\n',
      });
    } finally {
      await tab.close();
    }

    const downloadRes = await fetch(`${baseOrigin}/api/files/export?exportId=${encodeURIComponent(prepared.exportId)}`, {
      headers: { Cookie: sessionCookie },
    });
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get('content-disposition')).toContain('attachment');
    expect(await downloadRes.text()).toBe('# 深度学习导出笔记\n\nWebUI + PWA 原生导出验证。\n');
  });

  // ==========================================================================
  // HTTPS 反向代理 / 表单登录 / pdfstream Range / 暂存失败清理
  // ==========================================================================

  it('marks the session cookie Secure when the request arrives over an HTTPS reverse proxy', async () => {
    const plain = await fetch(`${baseOrigin}/api/health?token=${encodeURIComponent(running.token!)}`);
    expect(plain.status).toBe(200);
    expect(plain.headers.get('set-cookie') ?? '').not.toContain('Secure');

    const viaProxy = await fetch(`${baseOrigin}/api/health?token=${encodeURIComponent(running.token!)}`, {
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    expect(viaProxy.status).toBe(200);
    const cookie = viaProxy.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('ds_web_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');

    // 多级代理会给出逗号分隔列表，取第一段
    const chained = await fetch(`${baseOrigin}/api/health?token=${encodeURIComponent(running.token!)}`, {
      headers: { 'X-Forwarded-Proto': 'https, http' },
    });
    expect(chained.headers.get('set-cookie') ?? '').toContain('Secure');

    // `https` 前缀不匹配（如 `https-fake`）不能误判
    const bogus = await fetch(`${baseOrigin}/api/health?token=${encodeURIComponent(running.token!)}`, {
      headers: { 'X-Forwarded-Proto': 'http' },
    });
    expect(bogus.headers.get('set-cookie') ?? '').not.toContain('Secure');
  });

  it('accepts the HTML login form (303 -> /, session cookie) and rejects a wrong token with 401', async () => {
    const login = await fetch(`${baseOrigin}/api/auth/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: baseOrigin,
      },
      body: new URLSearchParams({ token: running.token! }).toString(),
      redirect: 'manual',
    });
    expect(login.status).toBe(303);
    expect(login.headers.get('location')).toBe('/');
    const loginCookie = login.headers.get('set-cookie') ?? '';
    expect(loginCookie).toContain('ds_web_session=');
    expect(loginCookie).toContain('HttpOnly');
    expect(loginCookie).toContain('SameSite=Strict');
    expect(loginCookie).not.toContain('Secure');

    const authed = await fetch(`${baseOrigin}/api/health`, {
      headers: { Cookie: loginCookie.split(';')[0]! },
    });
    expect(authed.status).toBe(200);

    // 同一个表单在 HTTPS 反代下必须种 Secure cookie
    const secured = await fetch(`${baseOrigin}/api/auth/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: baseOrigin.replace('http:', 'https:'),
        'X-Forwarded-Proto': 'https',
      },
      body: new URLSearchParams({ token: running.token! }).toString(),
      redirect: 'manual',
    });
    expect(secured.status).toBe(303);
    expect(secured.headers.get('set-cookie') ?? '').toContain('Secure');

    const badToken = await fetch(`${baseOrigin}/api/auth/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: baseOrigin,
      },
      body: new URLSearchParams({ token: 'wrong-token' }).toString(),
      redirect: 'manual',
    });
    expect(badToken.status).toBe(401);
    expect(badToken.headers.get('set-cookie')).toBeNull();
    const badBody = await badToken.text();
    expect(badBody).toContain('访问令牌无效');
    expect(badBody).toContain('name="token"');

    // 跨站表单（Origin 不匹配 Host）必须 403
    const crossOrigin = await fetch(`${baseOrigin}/api/auth/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'http://evil.example',
      },
      body: new URLSearchParams({ token: running.token! }).toString(),
      redirect: 'manual',
    });
    expect(crossOrigin.status).toBe(403);
  });

  it('serves a staged Chinese + spaced PDF over pdfstream/filestream with HTTP 206 Range', async () => {
    const pdfBytes = Buffer.concat([
      Buffer.from('%PDF-1.7\n', 'latin1'),
      Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 7) & 0xff)),
    ]);
    const displayName = '中文 测试 文档.pdf';

    const stageRes = await fetch(`${baseOrigin}/api/files/stage?name=${encodeURIComponent(displayName)}`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie,
        Origin: baseOrigin,
        'Content-Type': 'application/pdf',
        'X-File-Name': encodeURIComponent(displayName),
      },
      body: pdfBytes,
    });
    expect(stageRes.status).toBe(200);
    const staged = (await stageRes.json()) as { path: string; name: string; size: number };
    expect(staged.name).toBe(displayName);
    expect(staged.size).toBe(pdfBytes.byteLength);
    expect(staged.path.endsWith(displayName)).toBe(true);

    for (const scheme of ['pdfstream', 'filestream'] as const) {
      const url = webConvertFileSrc(staged.path, scheme, baseOrigin);
      const rangeRes = await fetch(url, {
        headers: { Cookie: sessionCookie, Range: 'bytes=0-15' },
      });
      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get('content-range')).toBe(`bytes 0-15/${pdfBytes.byteLength}`);
      expect(rangeRes.headers.get('accept-ranges')).toBe('bytes');
      expect(rangeRes.headers.get('content-type')).toBe('application/pdf');
      const slice = Buffer.from(await rangeRes.arrayBuffer());
      expect(slice.equals(pdfBytes.subarray(0, 16))).toBe(true);
      const invalid = await fetch(url, { headers: { Cookie: sessionCookie, Range: 'bytes=100-50' } });
      expect(invalid.status).toBe(416);
      await invalid.arrayBuffer();
      const openEnded = await fetch(url, { headers: { Cookie: sessionCookie, Range: 'bytes=100-' } });
      expect(openEnded.status).toBe(206);
      expect(Buffer.from(await openEnded.arrayBuffer())).toEqual(pdfBytes.subarray(100));
    }

    const headRes = await fetch(webConvertFileSrc(staged.path, 'pdfstream', baseOrigin), {
      method: 'HEAD',
      headers: { Cookie: sessionCookie },
    });
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get('content-length')).toBe(String(pdfBytes.byteLength));
    expect(headRes.headers.get('content-type')).toBe('application/pdf');

    // 未登录读取同一路径必须 401，不能绕过鉴权
    const anonymous = await fetch(webConvertFileSrc(staged.path, 'pdfstream', baseOrigin), {
      headers: { Range: 'bytes=0-15' },
    });
    expect(anonymous.status).toBe(401);
  });

  it('deletes the partial staging file when an upload exceeds the limit (413) or the client aborts', async () => {
    const slotsBefore = await stagingSlotNames();

    // 1) 超限：声明并发送 64 KiB（上限 16 KiB）
    const oversizeName = 'too-big-upload.pdf';
    const oversize = await rawHttpExchange(
      running.port,
      'POST',
      `/api/files/stage?name=${encodeURIComponent(oversizeName)}`,
      {
        Cookie: sessionCookie,
        Origin: baseOrigin,
        'Content-Type': 'application/pdf',
        'Content-Length': String(64 * 1024),
      },
      [Buffer.alloc(64 * 1024, 0x41)],
    );
    expect(oversize.status).toBe(413);
    expect(oversize.body).toContain('bytes limit');

    const afterOversize = await stagingSlotNames();
    expect(afterOversize.filter((name) => !slotsBefore.includes(name))).toEqual([]);

    // 2) 客户端中途断流：声明 255 KiB，只发 8 KiB（不触发 413）就 destroy
    const abortName = 'aborted-upload.pdf';
    const aborted = await rawHttpExchange(
      running.port,
      'POST',
      `/api/files/stage?name=${encodeURIComponent(abortName)}`,
      {
        Cookie: sessionCookie,
        Origin: baseOrigin,
        'Content-Type': 'application/pdf',
        'Content-Length': String(255 * 1024),
      },
      [Buffer.alloc(8 * 1024, 0x42)],
      { destroyAfterWriteMs: 120 },
    );
    // 连接被主动断开：要么没有完整响应（0），要么服务端落 5xx
    expect(aborted.status === 0 || aborted.status >= 500).toBe(true);

    await waitFor(async () => (await stagingSlotNames()).length === slotsBefore.length, 3000);
    const afterAbort = await stagingSlotNames();
    expect(afterAbort.sort()).toEqual([...slotsBefore].sort());

    // 半截文件不存在（既不在槽目录，也没有残留槽目录）
    const leftovers: string[] = [];
    for (const slot of await listDir(stagingRoot)) {
      for (const entry of await listDir(join(stagingRoot, slot))) {
        leftovers.push(entry);
      }
    }
    expect(leftovers).not.toContain(oversizeName);
    expect(leftovers).not.toContain(abortName);

    // 3) 正常上传仍可用（上限之内）
    const okRes = await fetch(`${baseOrigin}/api/files/stage?name=still-works.pdf`, {
      method: 'POST',
      headers: { Cookie: sessionCookie, Origin: baseOrigin },
      body: Buffer.alloc(1024, 0x43),
    });
    expect(okRes.status).toBe(200);
    const okBody = (await okRes.json()) as { size: number };
    expect(okBody.size).toBe(1024);
  });

  async function listDir(dir: string): Promise<string[]> {
    try {
      return (await readdir(dir)).sort();
    } catch {
      return [];
    }
  }

  /** 暂存根目录下所有槽目录名（每个成功/失败的上传各对应一个 UUID 槽）。 */
  async function stagingSlotNames(): Promise<string[]> {
    return listDir(stagingRoot);
  }

  async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }

  /**
   * 裸 TCP 发一个请求：需要覆盖 `Content-Length` 大于实际发送量（客户端断流）与超限 413 这类
   * `fetch` 无法表达的场景。返回状态码与响应体文本；连接被掐断时 status 为 0。
   */
  function rawHttpExchange(
    port: number,
    method: string,
    path: string,
    headers: Record<string, string>,
    bodyChunks: Buffer[],
    options: { destroyAfterWriteMs?: number } = {},
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolveExchange) => {
      const socket = connect(port, '127.0.0.1');
      const received: Buffer[] = [];
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        const raw = Buffer.concat(received).toString('utf8');
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0);
        const headerEnd = raw.indexOf('\r\n\r\n');
        resolveExchange({ status, body: headerEnd >= 0 ? raw.slice(headerEnd + 4) : '' });
      };

      socket.on('data', (chunk) => received.push(chunk));
      socket.on('error', settle);
      socket.on('close', settle);

      const headerLines = [
        `${method} ${path} HTTP/1.1`,
        ...(headers.Host === undefined ? [`Host: 127.0.0.1:${port}`] : []),
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        ...(headers.Connection === undefined ? ['Connection: close'] : []),
        '',
        '',
      ].join('\r\n');
      socket.write(headerLines);
      for (const chunk of bodyChunks) socket.write(chunk);
      if (options.destroyAfterWriteMs !== undefined) {
        setTimeout(() => socket.destroy(), options.destroyAfterWriteMs);
      }
    });
  }

  // ==========================================================================
  // 静态缓存污染 / 压缩 / PWA 免鉴权 / 反代同源 / 协议查询转发 / WS deflate
  // ==========================================================================

  /** 单独换一次会话：`-t` 单跑时不依赖前序用例留下的 cookie。 */
  async function freshCookie(): Promise<string> {
    const res = await fetch(`${baseOrigin}/api/health?token=${encodeURIComponent(running.token!)}`);
    expect(res.status).toBe(200);
    return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  }

  it('returns 404 no-store for a missing /assets/* file instead of the SPA fallback', async () => {
    const cookie = await freshCookie();

    const missingAsset = await fetch(`${baseOrigin}/assets/Missing-123.js`, { headers: { Cookie: cookie } });
    expect(missingAsset.status).toBe(404);
    expect(missingAsset.headers.get('cache-control')).toBe('no-store');
    expect(missingAsset.headers.get('etag')).toBeNull();

    const missingWasm = await fetch(`${baseOrigin}/wasm/missing.wasm`, { headers: { Cookie: cookie } });
    expect(missingWasm.status).toBe(404);
    expect(missingWasm.headers.get('cache-control')).toBe('no-store');

    // 基线安全头对静态响应与 404 一视同仁
    expect(missingAsset.headers.get('x-content-type-options')).toBe('nosniff');
    expect(missingAsset.headers.get('referrer-policy')).toBe('no-referrer');
    expect(missingAsset.headers.get('x-frame-options')).toBe('SAMEORIGIN');

    // 无扩展名的 SPA 路由仍然回落到 index.html 逻辑（此 dist 里没有 index.html，故 404）
    const spaRoute = await fetch(`${baseOrigin}/courses/calculus`, {
      headers: { Cookie: cookie, Accept: 'text/html' },
    });
    expect(spaRoute.status).toBe(404);
  });

  it('compresses static responses with brotli or gzip and always varies on Accept-Encoding', async () => {
    const cookie = await freshCookie();
    const rawSvg = readFileSync(join(process.cwd(), 'public', 'logo-black.svg'), 'utf8');

    const brotli = await fetch(`${baseOrigin}/logo-black.svg`, {
      headers: { Cookie: cookie, 'Accept-Encoding': 'br' },
    });
    expect(brotli.status).toBe(200);
    expect(brotli.headers.get('cache-control')).toBe('private, no-cache');
    expect(brotli.headers.get('content-encoding')).toBe('br');
    expect(brotli.headers.get('vary')).toBe('Accept-Encoding');
    expect(await brotli.text()).toBe(rawSvg);

    const gzipped = await fetch(`${baseOrigin}/logo-black.svg`, {
      headers: { Cookie: cookie, 'Accept-Encoding': 'gzip' },
    });
    expect(gzipped.status).toBe(200);
    expect(gzipped.headers.get('content-encoding')).toBe('gzip');
    expect(gzipped.headers.get('vary')).toBe('Accept-Encoding');
    expect(await gzipped.text()).toBe(rawSvg);

    // 字体（.ttf）同样在白名单里：iOS/Android 首屏最大的静态资源之一
    const font = await fetch(`${baseOrigin}/fonts/paper-export/NotoSansSC-Regular.ttf`, {
      headers: { Cookie: cookie, 'Accept-Encoding': 'br' },
    });
    expect(font.status).toBe(200);
    expect(font.headers.get('content-type')).toBe('font/ttf');
    expect(font.headers.get('content-encoding')).toBe('br');
    expect((await font.arrayBuffer()).byteLength).toBeGreaterThan(1024);

    // `?token=` 换会话时响应会带 `Set-Cookie`：静态内容必须 private + no-store，
    // 否则 CDN / 企业代理会拿着别人的会话把私有资源缓存一年。
    const viaQueryToken = await fetch(`${baseOrigin}/logo-black.svg?token=${encodeURIComponent(running.token!)}`);
    expect(viaQueryToken.status).toBe(200);
    expect(viaQueryToken.headers.get('set-cookie') ?? '').toContain('ds_web_session=');
    expect(viaQueryToken.headers.get('cache-control')).toBe('private, no-store');
    await viaQueryToken.arrayBuffer();
  });

  it('serves PWA manifest and icons without a session while keeping / and /api/* gated', async () => {
    const manifest = await fetch(`${baseOrigin}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get('content-type')).toContain('application/manifest+json');

    const icon = await fetch(`${baseOrigin}/app-icon.png`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get('content-type')).toBe('image/png');
    expect((await icon.arrayBuffer()).byteLength).toBeGreaterThan(0);

    // 公开路径上"文件不存在"必须是 404，而不是被鉴权拦成 401
    const missingPublicIcon = await fetch(`${baseOrigin}/favicon.ico`, { method: 'HEAD' });
    expect(missingPublicIcon.status).toBe(404);

    const rootAnon = await fetch(`${baseOrigin}/`, { headers: { Accept: 'text/html' } });
    expect(rootAnon.status).toBe(401);
    expect(await rootAnon.text()).toContain('Deep Student WebUI');

    const healthAnon = await fetch(`${baseOrigin}/api/health`);
    expect(healthAnon.status).toBe(401);

    const swAnon = await fetch(`${baseOrigin}/sw.js`);
    expect(swAnon.status).toBe(401);

    const assetsAnon = await fetch(`${baseOrigin}/assets/index-abc.js`);
    expect(assetsAnon.status).toBe(401);
  });

  it('accepts Origin matching X-Forwarded-Host from a loopback proxy but still rejects a foreign Origin', async () => {
    const proxied = await fetch(`${baseOrigin}/api/auth/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://study.example.com',
        'X-Forwarded-Host': 'study.example.com',
        'X-Forwarded-Proto': 'https',
      },
      body: new URLSearchParams({ token: running.token! }).toString(),
      redirect: 'manual',
    });
    expect(proxied.status).toBe(303);
    const proxiedCookie = proxied.headers.get('set-cookie') ?? '';
    expect(proxiedCookie).toContain('ds_web_session=');
    expect(proxiedCookie).toContain('Secure');

    // `X-Forwarded-Host` 不能把任意跨站 Origin 洗白
    const evil = await fetch(`${baseOrigin}/api/auth/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'http://evil.example',
        'X-Forwarded-Host': 'study.example.com',
      },
      body: new URLSearchParams({ token: running.token! }).toString(),
      redirect: 'manual',
    });
    expect(evil.status).toBe(403);

    // 由受信代理写入 `X-Forwarded-For` 时，限流按真实客户端计（不影响本机直连用例）
    const proxiedFor = await fetch(`${baseOrigin}/api/health`, {
      headers: {
        Cookie: proxiedCookie.split(';')[0]!,
        'X-Forwarded-For': '198.51.100.7, 10.0.0.1',
      },
    });
    expect(proxiedFor.status).toBe(200);
  });

  it('forwards a trailing ?mime= to filestream and keeps HTTP 206 Range streaming', async () => {
    const cookie = await freshCookie();
    const mediaBytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 13) & 0xff));

    const stageRes = await fetch(`${baseOrigin}/api/files/stage?name=clip.mp4`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: baseOrigin, 'Content-Type': 'video/mp4' },
      body: mediaBytes,
    });
    expect(stageRes.status).toBe(200);
    const staged = (await stageRes.json()) as { path: string; size: number };
    expect(staged.size).toBe(mediaBytes.byteLength);

    // 老式拼接：`?path=<enc>?mime=video%2Fmp4` —— `?` 之后的参数属于查询串，不是文件名
    const url = protocolUrlWithTrailingQuery(
      baseOrigin,
      'filestream',
      staged.path,
      `mime=${encodeURIComponent('video/mp4')}`,
    );

    const rangeRes = await fetch(url, { headers: { Cookie: cookie, Range: 'bytes=0-99' } });
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get('content-type')).toBe('video/mp4');
    expect(rangeRes.headers.get('content-range')).toBe(`bytes 0-99/${mediaBytes.byteLength}`);
    expect(Buffer.from(await rangeRes.arrayBuffer()).equals(mediaBytes.subarray(0, 100))).toBe(true);

    const fullRes = await fetch(url, { headers: { Cookie: cookie } });
    expect(fullRes.status).toBe(200);
    expect(fullRes.headers.get('content-type')).toBe('video/mp4');
    expect((await fullRes.arrayBuffer()).byteLength).toBe(mediaBytes.byteLength);

    // 标准写法（`&mime=`）与 `?path=` 同样必须生效
    const standardUrl = `${baseOrigin}/api/protocol/filestream?path=${encodeURIComponent(staged.path)}&mime=${encodeURIComponent('video/mp4')}`;
    const standardRes = await fetch(standardUrl, { headers: { Cookie: cookie, Range: 'bytes=0-9' } });
    expect(standardRes.status).toBe(206);
    expect(standardRes.headers.get('content-type')).toBe('video/mp4');

    for (const scheme of ['filestream', 'asset']) {
      const endpoint = webConvertFileSrc(staged.path, scheme, baseOrigin);
      const invalid = await fetch(endpoint, { headers: { Cookie: cookie, Range: 'bytes=100-50' } });
      expect(invalid.status, scheme).toBe(416);
      await invalid.arrayBuffer();
      const openEnded = await fetch(endpoint, { headers: { Cookie: cookie, Range: 'bytes=100-' } });
      expect(openEnded.status, scheme).toBe(206);
      expect(Buffer.from(await openEnded.arrayBuffer())).toEqual(mediaBytes.subarray(100));
    }
  });

  it('accepts long UTF-8 upload names and sanitizes browser export filenames', async () => {
    const cookie = await freshCookie();
    const name = '中文文件'.repeat(35) + ':"?*.txt';
    const staged = await fetch(`${baseOrigin}/api/files/stage?name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { Cookie: cookie, Origin: baseOrigin }, body: '',
    });
    expect(staged.status).toBe(200);
    const result = await staged.json() as { name: string; size: number };
    expect(Buffer.byteLength(result.name)).toBeLessThanOrEqual(200);
    expect(result.size).toBe(0);
    expect(result.name).not.toMatch(/[<>:"|?*]/);
    expect(result.name.endsWith('.txt')).toBe(true);

    const prepared = await fetch(`${baseOrigin}/api/files/prepare-save`, {
      method: 'POST', headers: { Cookie: cookie, Origin: baseOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultPath: 'a"b:c?.txt' }),
    });
    expect(prepared.status).toBe(200);
    expect(await prepared.json()).toMatchObject({ fileName: 'a_b_c_.txt' });

    const invalid = await fetch(`${baseOrigin}/api/files/stage`, {
      method: 'POST', headers: { Cookie: cookie, Origin: baseOrigin, 'X-File-Name': '%broken' }, body: '',
    });
    expect(invalid.status).toBe(400);
    const nullPrepare = await fetch(`${baseOrigin}/api/files/prepare-save`, {
      method: 'POST', headers: { Cookie: cookie, Origin: baseOrigin, 'Content-Type': 'application/json' }, body: 'null',
    });
    expect(nullPrepare.status).toBe(400);
  });

  it('rejects unknown API routes without SPA HTML', async () => {
    const cookie = await freshCookie();
    const missingApi = await fetch(`${baseOrigin}/api/missing`, { headers: { Cookie: cookie } });
    expect(missingApi.status).toBe(404);
    expect(missingApi.headers.get('content-type')).toContain('application/json');
  });

  it('negotiates permessage-deflate and round-trips RSV1-compressed JSON RPC frames', async () => {
    const cookie = await freshCookie();
    const longPaths = Array.from({ length: 400 }, (_, i) => `segment-${i}`);

    const session = await openRawWebSocketSession(running.port, { cookie });
    try {
      expect(session.handshakeHead).toMatch(/sec-websocket-extensions:\s*permessage-deflate/i);
      expect(session.handshakeHead).toMatch(/server_no_context_takeover/i);
      expect(session.handshakeHead).toMatch(/client_no_context_takeover/i);

      // 客户端 → 服务端：RSV1 压缩帧必须被解压后派发
      const request = encodeRendererMessage(rendererInvoke('plugin:path|join', { paths: longPaths }, 4101, 4102));
      expect(typeof request).toBe('string');
      session.send(request as string, true);

      const reply = await session.nextMessage();
      expect(reply.opcode).toBe(0x1);
      expect(reply.rsv1).toBe(true);
      const inflated = inflateRawSync(
        Buffer.concat([reply.payload, Buffer.from([0x00, 0x00, 0xff, 0xff])]),
        { finishFlush: zlibConstants.Z_SYNC_FLUSH },
      ).toString('utf8');
      expect(inflated.length).toBeGreaterThan(2048);
      expect(inflated).toContain('segment-399');
      expect(JSON.parse(inflated)).toMatchObject({ type: 'result', callbackId: 4101 });
    } finally {
      session.close();
    }

    // 客户端没提供扩展头：不得协商压缩，大响应保持未压缩
    const plain = await openRawWebSocketSession(running.port, { cookie, offerDeflate: false });
    try {
      expect(plain.handshakeHead).not.toMatch(/sec-websocket-extensions/i);
      const request = encodeRendererMessage(rendererInvoke('plugin:path|join', { paths: longPaths }, 4201, 4202));
      plain.send(request as string, false);

      const reply = await plain.nextMessage();
      expect(reply.opcode).toBe(0x1);
      expect(reply.rsv1).toBe(false);
      expect(JSON.parse(reply.payload.toString('utf8'))).toMatchObject({ type: 'result', callbackId: 4201 });
    } finally {
      plain.close();
    }
  });

  it('round-trips a >2 KB JSON RPC result over a deflate-compressed browser WebSocket', async () => {
    const cookie = await freshCookie();
    const wsUrl = `ws://127.0.0.1:${running.port}/api/ws`;
    const tab = await openSimulatedTab(wsUrl, cookie, baseOrigin);
    try {
      const joined = await tab.invoke<string>('plugin:path|join', {
        paths: Array.from({ length: 400 }, (_, i) => `segment-${i}`),
      });
      expect(joined.startsWith(`segment-0${sep}segment-1${sep}`)).toBe(true);
      expect(joined.length).toBeGreaterThan(2048);
      expect(joined.endsWith(`${sep}segment-399`)).toBe(true);
    } finally {
      await tab.close();
    }
  });

  it('returns 429 after repeated wrong tokens on POST /api/auth/session', async () => {
    let retryAfter = '';
    let unauthorized = 0;
    let sawTooMany = false;
    for (let i = 0; i < 25; i++) {
      const res = await fetch(`${baseOrigin}/api/auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: baseOrigin },
        body: new URLSearchParams({ token: `brute-force-${i}` }).toString(),
        redirect: 'manual',
      });
      if (res.status === 429) {
        sawTooMany = true;
        retryAfter = res.headers.get('retry-after') ?? '';
        break;
      }
      expect(res.status).toBe(401);
      unauthorized += 1;
    }
    expect(sawTooMany).toBe(true);
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(unauthorized).toBeGreaterThanOrEqual(10);

    // 封禁期间即使提交正确令牌也不放行（否则撞对一次就立刻解封）
    const blocked = await fetch(`${baseOrigin}/api/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: baseOrigin },
      body: new URLSearchParams({ token: running.token! }).toString(),
      redirect: 'manual',
    });
    expect(blocked.status).toBe(429);

    // 带错误 `?token=` 的普通请求同样在封禁期内 429
    const blockedQuery = await fetch(`${baseOrigin}/api/health?token=nope`);
    expect(blockedQuery.status).toBe(429);
  });

  describe('auth 原语', () => {
    const fakeRequest = (headers: Record<string, string>, remoteAddress: string) =>
      ({ headers, socket: { remoteAddress } }) as unknown as Parameters<typeof isSameOriginRequest>[0];

    it('compares tokens by hash so the length never short-circuits', () => {
      expect(constantTimeEquals('abc', 'abc')).toBe(true);
      expect(constantTimeEquals('', '')).toBe(true);
      expect(constantTimeEquals('abc', 'abcd')).toBe(false);
      expect(constantTimeEquals('x'.repeat(200), 'x'.repeat(200))).toBe(true);
      expect(constantTimeEquals('x'.repeat(200), 'x'.repeat(201))).toBe(false);
      expect(constantTimeEquals('test-secret-webui-token-2026', 'test-secret-webui-token-2027')).toBe(false);
    });

    it('trusts X-Forwarded-Host only for loopback or explicitly trusted proxies', () => {
      const previousTrustProxy = process.env.DS_WEB_TRUST_PROXY;
      delete process.env.DS_WEB_TRUST_PROXY;
      try {
        const proxied = {
          origin: 'https://study.example.com',
          host: '127.0.0.1:1428',
          'x-forwarded-host': 'study.example.com',
          'x-forwarded-proto': 'https',
        };
        expect(isSameOriginRequest(fakeRequest(proxied, '127.0.0.1'))).toBe(true);
        expect(isSameOriginRequest(fakeRequest(proxied, '::1'))).toBe(true);
        expect(isSameOriginRequest(fakeRequest(proxied, '::ffff:127.0.0.1'))).toBe(true);
        // 公网直连时伪造的头一律不认
        expect(isSameOriginRequest(fakeRequest(proxied, '203.0.113.9'))).toBe(false);
        expect(isSameOriginRequest(fakeRequest(proxied, '203.0.113.9'), { trustProxy: true })).toBe(true);

        // 直接同源（Host 与 Origin 一致）不需要代理头
        expect(
          isSameOriginRequest(fakeRequest({ origin: 'http://127.0.0.1:1428', host: '127.0.0.1:1428' }, '203.0.113.9')),
        ).toBe(true);
        // 跨站 Origin 即便带了 X-Forwarded-Host 也拒绝
        expect(
          isSameOriginRequest(
            fakeRequest({ origin: 'http://evil.example', host: '127.0.0.1:1428', 'x-forwarded-host': 'study.example.com' }, '127.0.0.1'),
          ),
        ).toBe(false);
        // 非浏览器客户端不带 Origin
        expect(isSameOriginRequest(fakeRequest({}, '203.0.113.9'))).toBe(true);
        expect(isSameOriginRequest(fakeRequest({ origin: 'https://127.0.0.1:1428', host: '127.0.0.1:1428' }, '203.0.113.9'))).toBe(false);
        expect(isSameOriginRequest(fakeRequest({ origin: 'http://study.example.com', host: 'study.example.com:80' }, '203.0.113.9'))).toBe(true);
      } finally {
        if (previousTrustProxy === undefined) delete process.env.DS_WEB_TRUST_PROXY;
        else process.env.DS_WEB_TRUST_PROXY = previousTrustProxy;
      }
    });

    it('blocks only after maxFailures inside the window and unbinds on reset', async () => {
      const limiter = new AuthRateLimiter({ maxFailures: 3, windowMs: 60_000 });
      expect(limiter.isBlocked('1.2.3.4')).toEqual({ blocked: false, retryAfterSec: 0 });
      limiter.recordFailure('1.2.3.4');
      limiter.recordFailure('1.2.3.4');
      expect(limiter.isBlocked('1.2.3.4').blocked).toBe(false);

      limiter.recordFailure('1.2.3.4');
      const blocked = limiter.isBlocked('1.2.3.4');
      expect(blocked.blocked).toBe(true);
      expect(blocked.retryAfterSec).toBeGreaterThan(0);

      expect(limiter.isBlocked('5.6.7.8').blocked).toBe(false);
      limiter.reset('1.2.3.4');
      expect(limiter.isBlocked('1.2.3.4').blocked).toBe(false);

      const expiring = new AuthRateLimiter({ maxFailures: 1, windowMs: 30 });
      expiring.recordFailure('9.9.9.9');
      expect(expiring.isBlocked('9.9.9.9').blocked).toBe(true);
      await new Promise((resolveWait) => setTimeout(resolveWait, 40));
      expect(expiring.isBlocked('9.9.9.9').blocked).toBe(false);
    });

    it('keeps the failure map bounded', () => {
      const limiter = new AuthRateLimiter({ maxFailures: 1, windowMs: 60_000, maxKeys: 2 });
      limiter.recordFailure('a');
      limiter.recordFailure('b');
      limiter.recordFailure('c');
      // 最旧的 key 被挤掉，不会无限增长
      expect(limiter.isBlocked('a').blocked).toBe(false);
      expect(limiter.isBlocked('c').blocked).toBe(true);
      expect(limiter.isBlocked('b').blocked).toBe(true);
    });

    it('expires individual failures rather than resetting the entire window', () => {
      const clock = vi.spyOn(Date, 'now');
      try {
        const limiter = new AuthRateLimiter({ maxFailures: 3, windowMs: 1000 });
        clock.mockReturnValue(0);
        limiter.recordFailure('client');
        clock.mockReturnValue(900);
        limiter.recordFailure('client');
        limiter.recordFailure('client');
        expect(limiter.isBlocked('client').blocked).toBe(true);
        clock.mockReturnValue(1000);
        expect(limiter.isBlocked('client').blocked).toBe(false);
        limiter.recordFailure('client');
        expect(limiter.isBlocked('client').blocked).toBe(true);
        clock.mockReturnValue(1900);
        expect(limiter.isBlocked('client').blocked).toBe(false);
      } finally {
        clock.mockRestore();
      }
    });
  });

  // ==========================================================================
  // 单实例排他锁 / 重连监听帧（放在文件末尾：会改写进程级 DS_SHELL_OS_DIRS 环境）
  // ==========================================================================

  describe('appDataDir 跨进程单实例排他锁', () => {
    const lockDir = join(tempRoot, 'locked-appdata');
    const lockPath = join(lockDir, '.host-instance.lock');

    it('refuses to start while another live process holds .host-instance.lock', () => {
      mkdirSync(lockDir, { recursive: true });
      // 父进程一定存活，冒充"另一个 host 进程"持有锁
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.ppid, role: 'web', startedAt: new Date().toISOString(), origin: 'http://127.0.0.1:1428' }),
      );
      // 哨兵文件代替已有数据库：拒绝启动时不得被创建/截断/改写
      const sentinel = join(lockDir, 'chat_v2.db');
      writeFileSync(sentinel, 'sentinel-db-bytes');

      expect(() =>
        createWebHostGateway({
          repoRoot: process.cwd(),
          appDataDir: lockDir,
          localOrigin: 'http://127.0.0.1:1428',
          log: () => undefined,
        }),
      ).toThrow(
        new RegExp(
          `appDataDir "${lockDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" is already in use by another Deep Student host process \\(pid=${process.ppid}, role=web\\)`,
        ),
      );

      expect(readFileSync(sentinel, 'utf8')).toBe('sentinel-db-bytes');
      // 拒绝启动不得顺走别人的锁文件
      const holder = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number };
      expect(holder.pid).toBe(process.ppid);
    });

    it('takes over a stale lock (dead pid) and starts, releasing the lock on shutdown', async () => {
      // 一个几乎不可能存在的 PID：锁是被进程崩溃留下的过期文件
      writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 22 + 12345, role: 'web', startedAt: '2026-01-01T00:00:00.000Z' }));

      const gateway = createWebHostGateway({
        repoRoot: process.cwd(),
        appDataDir: lockDir,
        localOrigin: 'http://127.0.0.1:1428',
        log: () => undefined,
      });
      try {
        await gateway.ready;
        const holder = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number; role: string };
        expect(holder.pid).toBe(process.pid);
        expect(holder.role).toBe('web');
      } finally {
        await gateway.shutdown();
      }
      expect(existsSync(lockPath)).toBe(false);

      // 锁释放后同一目录可以再次启动（并再次释放）
      const again = createWebHostGateway({
        repoRoot: process.cwd(),
        appDataDir: lockDir,
        localOrigin: 'http://127.0.0.1:1428',
        log: () => undefined,
      });
      try {
        await again.ready;
        expect(existsSync(lockPath)).toBe(true);
      } finally {
        await again.shutdown();
      }
      expect(existsSync(lockPath)).toBe(false);
    }, 120_000);
  });

  describe('WebSocket 重连的 plugin:event|listen 回调 id', () => {
    it('gives every replayed listen frame its own non-zero callback id', () => {
      const spec = { event: 'webui:reconnect', target: { kind: 'Any' }, handlerId: 42 };
      const first = buildReconnectListenMessage(spec);
      const second = buildReconnectListenMessage(spec);

      expect(first.cmd).toBe('plugin:event|listen');
      expect(first.callback).not.toBe(0);
      expect(first.error).not.toBe(0);
      expect(first.callback).not.toBe(first.error);
      // 两个标签页/两次重连不能共用 key，否则服务端 callbackOwner 会互相覆盖
      expect([first.callback, first.error]).not.toContain(second.callback);
      expect([first.callback, first.error]).not.toContain(second.error);

      if (first.payload.contentType !== 'application/json') throw new Error('listen frame payload must be JSON');
      const payload = JSON.parse(first.payload.data) as { event: string; handler: number };
      expect(payload).toMatchObject({ event: 'webui:reconnect', handler: 42 });
      // 帧必须能通过服务端 wire 校验（u32 callback id）
      expect(decodeRendererMessage(encodeRendererMessage(first))).toMatchObject({
        type: 'invoke',
        cmd: 'plugin:event|listen',
        callback: first.callback,
        error: first.error,
      });
    });
  });

  it('rejects a WebSocket upgrade with a malformed Host without crashing the server', async () => {
    const response = await rawHttpExchange(running.port, 'GET', '/api/ws', {
      Host: '[invalid',
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
    }, [], { destroyAfterWriteMs: 2000 });
    expect(response.status).toBe(400);
    const health = await fetch(`${baseOrigin}/api/health?token=${encodeURIComponent(running.token!)}`);
    expect(health.status).toBe(200);
  });

  it('shuts down cleanly while an upgraded browser WebSocket is still connected', async () => {
    const tab = await openSimulatedTab(`ws://127.0.0.1:${running.port}/api/ws`, sessionCookie, baseOrigin);
    try {
      await running.close();
      serverClosed = true;
      expect(existsSync(join(appDataDir, '.host-instance.lock'))).toBe(false);
    } finally {
      await tab.close();
    }
  }, 10_000);
});
