import { mkdtempSync, type WriteStream } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MainToRenderer } from '../../electron/shell/bridge-messages.ts';
import { ShellRuntime } from '../../electron/shell/runtime.ts';
import type { WebSocketConnection } from '../server/ws.ts';
import { decodeMainMessage, encodeRendererMessage } from '../shared/wire.ts';

const observed = vi.hoisted(() => ({ streams: [] as WriteStream[], hostMessages: [] as Array<{ kind: string; id?: string }> }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    createWriteStream: (...args: Parameters<typeof fs.createWriteStream>) => {
      const stream = fs.createWriteStream(...args);
      observed.streams.push(stream);
      return stream;
    },
  };
});
// Keep the real gateway, ShellRuntime and file IO, without booting databases or background jobs.
vi.mock('../../host/kernel/connection.ts', () => ({
  serveHost: (transport: { onMessage: (fn: (msg: { kind: string }) => void) => void; send: (msg: unknown) => void }) => {
    transport.onMessage((msg) => {
      observed.hostMessages.push(msg);
      if (msg.kind === 'handshake') transport.send({ kind: 'ready' });
    });
    return { ready: Promise.resolve({}), shutdown: async () => undefined };
  },
}));

import { createWebHostGateway, type WebHostGateway } from '../server/gateway.ts';

class ResponseSink extends Writable {
  headersSent = false;
  statusCode = 0;
  body = '';
  writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this; }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.body += chunk.toString();
    callback();
  }
  response() { return this as unknown as ServerResponse; }
}

class TabSocket implements WebSocketConnection {
  open = true;
  readonly messages: MainToRenderer[] = [];
  private messageListener?: (data: string | Uint8Array) => void;
  private closeListener?: () => void;
  send(data: string | Uint8Array) { this.messages.push(decodeMainMessage(data)); }
  close() { this.open = false; this.closeListener?.(); }
  onMessage(listener: (data: string | Uint8Array) => void) { this.messageListener = listener; }
  onClose(listener: () => void) { this.closeListener = listener; }
  invoke(cmd: string, args: unknown, callback = 1) {
    this.messageListener?.(encodeRendererMessage({
      type: 'invoke', cmd, callback, error: callback + 1, headers: {},
      payload: { contentType: 'application/json', data: JSON.stringify(args) },
    }));
  }
  async result(callback = 1) {
    await vi.waitFor(() => expect(this.messages.some((msg) => msg.type === 'result' && (msg.callbackId === callback || msg.callbackId === callback + 1))).toBe(true));
    const result = this.messages.find((msg) => msg.type === 'result' && (msg.callbackId === callback || msg.callbackId === callback + 1));
    if (result?.type !== 'result' || result.body.kind !== 'json') throw new Error('missing JSON result');
    return { ok: result.callbackId === callback, value: JSON.parse(result.body.data) as unknown };
  }
}

describe('gateway temporary IO lifecycle', () => {
  let gateway: WebHostGateway | undefined;
  let root: string | undefined;
  const env = { ...process.env };

  afterEach(async () => {
    await gateway?.shutdown();
    gateway = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
    observed.streams.length = 0;
    observed.hostMessages.length = 0;
    process.env = { ...env };
  });

  async function start() {
    root = mkdtempSync(join(tmpdir(), 'b03-gateway-'));
    gateway = createWebHostGateway({ repoRoot: process.cwd(), appDataDir: root, localOrigin: 'http://localhost', log: () => undefined });
    await gateway.ready;
    return gateway;
  }

  it('does not retain one error listener per backpressured upload chunk', async () => {
    const gw = await start();
    const chunk = Buffer.alloc(256 * 1024, 7);
    const req = Readable.from(Array.from({ length: 24 }, () => chunk)) as unknown as IncomingMessage;
    const res = new ResponseSink();
    await gw.handleStageUpload('test.bin', req, res.response());
    expect(res.statusCode).toBe(200);
    const result = JSON.parse(res.body) as { path: string; size: number };
    expect(result.size).toBe(24 * chunk.length);
    expect((await readFile(result.path)).byteLength).toBe(result.size);
    // One persistent stream-error consumer is sufficient; drain/error waiters must remove each other.
    expect(observed.streams[0]!.listenerCount('error')).toBeLessThanOrEqual(1);
  });

  it('removes expired export files while preserving unexpired exports', async () => {
    const gw = await start();
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = new ResponseSink();
    await gw.handlePrepareSave('{"defaultPath":"first.txt"}', first.response());
    const expired = JSON.parse(first.body) as { path: string; exportId: string };
    await writeFile(expired.path, 'expired contents');
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    const second = new ResponseSink();
    await gw.handlePrepareSave('{"defaultPath":"second.txt"}', second.response());
    const fresh = JSON.parse(second.body) as { path: string };
    await writeFile(fresh.path, 'fresh contents');
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
    // Existing request-triggered GC must also remove the generated slot, not just its token.
    const download = new ResponseSink();
    await gw.handleDownloadExport(expired.exportId, download.response());
    expect(download.statusCode).toBe(404);
    await expect(readFile(expired.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(fresh.path, 'utf8')).toBe('fresh contents');
  });

  it('routes identical callback ids to their invoking tabs instead of overwriting ownership', async () => {
    const gw = await start();
    const first = new TabSocket();
    const second = new TabSocket();
    gw.attachWebSocket(first);
    gw.attachWebSocket(second);
    first.invoke('plugin:app|version', {});
    second.invoke('plugin:app|name', {});
    expect(await first.result()).toEqual({ ok: true, value: gw.config.version });
    expect(await second.result()).toEqual({ ok: true, value: gw.config.productName });
    expect(first.messages).toHaveLength(1);
    expect(second.messages).toHaveLength(1);
  });

  it('isolates resource ids and closes only the disconnected tab resources', async () => {
    const gw = await start();
    const add = vi.spyOn(ShellRuntime.prototype, 'addResource');
    const first = new TabSocket();
    const second = new TabSocket();
    gw.attachWebSocket(first);
    gw.attachWebSocket(second);
    const args = { clientConfig: { method: 'GET', url: 'data:text/plain,hello' } };
    first.invoke('plugin:http|fetch', args);
    const rid = (await first.result()).value;
    second.invoke('plugin:http|fetch', args, 3);
    expect((await second.result(3)).ok).toBe(true);
    const closeFirst = vi.spyOn(add.mock.calls[0]![1], 'close');
    const closeSecond = vi.spyOn(add.mock.calls[1]![1], 'close');
    second.invoke('plugin:http|fetch_send', { rid }, 5);
    expect(await second.result(5)).toEqual({ ok: false, value: `The resource id ${rid} is invalid.` });
    first.close();
    expect(closeFirst).toHaveBeenCalledOnce();
    expect(closeSecond).not.toHaveBeenCalled();
    second.close();
    expect(closeSecond).toHaveBeenCalledOnce();
  });

  it('abandons only pending Host requests belonging to the disconnected tab', async () => {
    const gw = await start();
    const first = new TabSocket();
    const second = new TabSocket();
    gw.attachWebSocket(first);
    gw.attachWebSocket(second);
    first.invoke('get_setting', { key: 'first' });
    second.invoke('get_setting', { key: 'second' }, 3);
    const invokes = observed.hostMessages.filter((msg) => msg.kind === 'invoke');
    expect(invokes).toHaveLength(2);
    first.close();
    expect(observed.hostMessages.filter((msg) => msg.kind === 'abandon')).toEqual([
      { kind: 'abandon', id: invokes[0]!.id, reason: 'window-closed' },
    ]);
    second.close();
    expect(observed.hostMessages.filter((msg) => msg.kind === 'abandon')).toHaveLength(2);
  });

  it('fans out streaming events only to subscribed tabs, and removes closed listeners', async () => {
    const gw = await start();
    const first = new TabSocket();
    const second = new TabSocket();
    const idle = new TabSocket();
    gw.attachWebSocket(first);
    gw.attachWebSocket(second);
    gw.attachWebSocket(idle);
    const args = { event: 'chat:stream', target: { kind: 'Any' }, handler: 77 };
    first.invoke('plugin:event|listen', args);
    second.invoke('plugin:event|listen', args);
    expect((await first.result()).ok).toBe(true);
    expect((await second.result()).ok).toBe(true);
    first.messages.length = 0;
    second.messages.length = 0;
    second.invoke('plugin:event|emit', { event: 'chat:stream', payload: { delta: 'a' } }, 3);
    expect((await second.result(3)).ok).toBe(true);
    expect(first.messages.filter((msg) => msg.type === 'emit-js')).toHaveLength(1);
    expect(second.messages.filter((msg) => msg.type === 'emit-js')).toHaveLength(1);
    expect(idle.messages).toHaveLength(0);
    first.close();
    second.messages.length = 0;
    second.invoke('plugin:event|emit', { event: 'chat:stream', payload: { delta: 'b' } }, 5);
    await second.result(5);
    expect(first.messages.filter((msg) => msg.type === 'emit-js')).toHaveLength(1);
    expect(second.messages.filter((msg) => msg.type === 'emit-js')).toHaveLength(1);
  });
});
