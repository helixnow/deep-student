import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MainToRenderer, RendererToMain } from '../../electron/shell/bridge-messages.ts';
import { PACKAGES_LOCK_FILE, type PackagesLock } from '../../electron/shell/plugin-lock.ts';
import { HOST_PROTOCOL_VERSION, type HostToMain, type MainToHostMessage } from '../../host/kernel/protocol.ts';
import type { HostTransport } from '../../host/kernel/serve.ts';
import type { WebSocketConnection } from '../server/ws.ts';
import { decodeMainMessage, encodeRendererMessage } from '../shared/wire.ts';

interface FakeHostInstance {
  index: number;
  transport: HostTransport;
  listeners: Array<(message: unknown) => void>;
  invokes: Array<{ id: string; cmd: string; args: unknown }>;
  shellResults: Array<{ id: string; ok: boolean; value?: unknown; error?: string }>;
  shutdown: ReturnType<typeof vi.fn<() => Promise<void>>>;
  emitEvent(event: string, payload: unknown): void;
  sendShellRequest(id: string, op: string, args?: unknown): void;
}

const hostMock = vi.hoisted(() => ({
  instances: [] as FakeHostInstance[],
  manifest: [] as Array<{ id: string; file: string; version?: string }>,
  manifestV2: { version: 2, plugins: [] as Array<{ id: string; origin: string; file: string; version?: string }> },
  degraded: [] as unknown[],
}));

vi.mock('../../host/kernel/connection.ts', () => ({
  serveHost(transport: HostTransport) {
    const index = hostMock.instances.length;
    const listeners: Array<(message: unknown) => void> = [];
    const invokes: Array<{ id: string; cmd: string; args: unknown }> = [];
    const shellResults: Array<{ id: string; ok: boolean; value?: unknown; error?: string }> = [];
    const shutdown = vi.fn(async () => {});

    const instance: FakeHostInstance = {
      index,
      transport,
      listeners,
      invokes,
      shellResults,
      shutdown,
      emitEvent(event: string, payload: unknown) {
        transport.send({
          kind: 'event',
          event,
          target: { kind: 'Any' },
          payload,
        });
      },
      sendShellRequest(id: string, op: string, args: unknown = {}) {
        transport.send({
          kind: 'shell-request',
          id,
          op,
          args,
        });
      },
    };
    hostMock.instances.push(instance);

    const origOnMessage = transport.onMessage;
    origOnMessage((raw: unknown) => {
      const msg = raw as MainToHostMessage;
      if (msg.kind === 'handshake') {
        queueMicrotask(() => transport.send({ kind: 'ready', protocol: HOST_PROTOCOL_VERSION }));
        return;
      }
      if (msg.kind === 'invoke') {
        invokes.push({ id: msg.id, cmd: msg.cmd, args: msg.args });
        if (msg.cmd === 'plugin:ui|manifest') {
          const version = (msg.args as { version?: number } | null | undefined)?.version;
          transport.send({
            kind: 'result',
            id: msg.id,
            ok: true,
            value: version === 2 ? hostMock.manifestV2 : hostMock.manifest,
          });
          return;
        }
        if (msg.cmd === 'plugin:host|status') {
          transport.send({ kind: 'result', id: msg.id, ok: true, value: hostMock.degraded });
          return;
        }
        transport.send({ kind: 'result', id: msg.id, ok: true, value: null });
        return;
      }
      if (msg.kind === 'shell-result') {
        shellResults.push({
          id: msg.id,
          ok: msg.ok,
          value: msg.ok ? msg.value : undefined,
          error: msg.ok ? undefined : msg.error,
        });
      }
      for (const listener of listeners) listener(raw);
    });

    return {
      ready: Promise.resolve(true),
      shutdown,
    };
  },
}));

import { startWebServer, type RunningWebServer } from '../server/main.ts';

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function writeLockedPlugin(
  appDataDir: string,
  pluginId: string,
  relPath: string,
  source: string,
  overrideHash?: string,
): void {
  const pluginsRoot = join(appDataDir, 'plugins');
  const pluginDir = join(pluginsRoot, 'packages', pluginId);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, relPath), source, 'utf8');

  const lock: PackagesLock = {
    lockVersion: 1,
    plugins: {
      [pluginId]: {
        id: pluginId,
        version: '0.1.0',
        path: `packages/${pluginId}`,
        enabled: true,
        files: {
          [relPath.replace(/\\/g, '/')]: overrideHash ?? sha256(source),
        },
      },
    },
  };
  writeFileSync(join(pluginsRoot, PACKAGES_LOCK_FILE), JSON.stringify(lock, null, 2), 'utf8');
}

class MemoryWsConnection implements WebSocketConnection {
  open = true;
  readonly sent: MainToRenderer[] = [];
  private readonly messageListeners: Array<(data: string | Uint8Array) => void> = [];
  private readonly closeListeners: Array<() => void> = [];

  send(data: string | Uint8Array): void {
    if (!this.open) return;
    this.sent.push(decodeMainMessage(data) as MainToRenderer);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    for (const listener of this.closeListeners) listener();
  }

  onMessage(listener: (data: string | Uint8Array) => void): void {
    this.messageListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  receive(msg: RendererToMain): void {
    const encoded = encodeRendererMessage(msg);
    for (const listener of this.messageListeners) listener(encoded);
  }
}

async function waitFor<T>(predicate: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = predicate();
    if (found !== undefined) return found;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

describe('WebUI ds-plugin protocol & plugin:process|restart', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    hostMock.instances.length = 0;
    hostMock.manifest = [];
    hostMock.manifestV2 = { version: 2, plugins: [] };
    hostMock.degraded = [];
    vi.restoreAllMocks();
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  async function bootServer(token = 'test-web-token'): Promise<{
    server: RunningWebServer;
    appDataDir: string;
    origin: string;
    cookie: string;
  }> {
    const tempRoot = mkdtempSync(join(tmpdir(), 'dstu-ds-plugin-test-'));
    const appDataDir = join(tempRoot, 'appdata');
    const distDir = join(tempRoot, 'dist');
    mkdirSync(appDataDir, { recursive: true });
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><html></html>', 'utf8');

    const server = await startWebServer({
      repoRoot: resolve('.'),
      appDataDir,
      distDir,
      host: '127.0.0.1',
      port: 0,
      prod: true,
      token,
      log: () => undefined,
    });
    cleanups.push(async () => {
      await server.close();
      rmSync(tempRoot, { recursive: true, force: true });
    });

    const origin = `http://127.0.0.1:${server.port}`;
    const authRes = await fetch(`${origin}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
    const setCookie = authRes.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    const cookie = setCookie!.split(';')[0]!;
    return { server, appDataDir, origin, cookie };
  }

  it('serves verified ds-plugin modules over /api/protocol/ds-plugin and enforces lock + traversal checks', async () => {
    const { appDataDir, origin, cookie } = await bootServer();
    const host = hostMock.instances[0]!;
    const pluginId = 'workshop.plugin-demo';
    const moduleCode = 'export function mount() { return "hello-webui"; }\n';
    const uiEntryPath = join(appDataDir, 'plugins', 'packages', pluginId, 'ui.js');
    writeLockedPlugin(appDataDir, pluginId, 'ui.js', moduleCode);

    // Unauthorized request without cookie must be rejected
    const unauth = await fetch(`${origin}/api/protocol/ds-plugin/${pluginId}/ui.js?reload=1`);
    expect(unauth.status).toBe(401);

    // Before host registers UI manifest entry, serving must fail with 404
    const beforeManifest = await fetch(`${origin}/api/protocol/ds-plugin/${pluginId}/ui.js?reload=1`, {
      headers: { Cookie: cookie },
    });
    expect(beforeManifest.status).toBe(404);

    // Register via host://ui-manifest
    host.emitEvent('host://ui-manifest', [{ id: pluginId, file: uiEntryPath, version: '0.1.0' }]);

    const okRes = await fetch(`${origin}/api/protocol/ds-plugin/${pluginId}/ui.js?reload=1`, {
      headers: { Cookie: cookie },
    });
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get('content-type')).toContain('text/javascript');
    expect(okRes.headers.get('cache-control')).toBe('no-store');
    expect(await okRes.text()).toBe(moduleCode);

    const headRes = await fetch(`${origin}/api/protocol/ds-plugin/${pluginId}/ui.js?reload=1`, {
      method: 'HEAD',
      headers: { Cookie: cookie },
    });
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get('content-length')).toBe(String(Buffer.byteLength(moduleCode, 'utf8')));
    expect(await headRes.text()).toBe('');

    // Encoded traversal must stay 403 (parseProtocolRequest preserves raw encoding for ds-plugin)
    const traversal = await fetch(`${origin}/api/protocol/ds-plugin/${pluginId}/..%2f..%2fsecret.js`, {
      headers: { Cookie: cookie },
    });
    expect(traversal.status).toBe(403);

    // Tampered file hash vs plugins.lock.json must fail with 403
    writeFileSync(join(appDataDir, 'plugins', 'packages', pluginId, 'ui.js'), 'export const tampered = true;', 'utf8');
    const tampered = await fetch(`${origin}/api/protocol/ds-plugin/${pluginId}/ui.js?reload=2`, {
      headers: { Cookie: cookie },
    });
    expect(tampered.status).toBe(403);

    // Restore valid hash and verify host://ui-manifest-v2 updates community entries & filters official entries
    writeLockedPlugin(appDataDir, pluginId, 'ui.js', moduleCode);
    host.emitEvent('host://ui-manifest-v2', {
      version: 2,
      plugins: [
        { id: 'official.ui', origin: 'official', file: join(appDataDir, 'official', 'official.js') },
        { id: pluginId, origin: 'community', file: uiEntryPath, version: '0.1.0' },
      ],
    });

    const v2Community = await fetch(`${origin}/api/protocol/ds-plugin/${pluginId}/ui.js?reload=3`, {
      headers: { Cookie: cookie },
    });
    expect(v2Community.status).toBe(200);
    const v2Official = await fetch(`${origin}/api/protocol/ds-plugin/official.ui/official.js`, {
      headers: { Cookie: cookie },
    });
    expect(v2Official.status).toBe(404);

    // Malformed manifest event invalidates the registry
    host.emitEvent('host://ui-manifest', 'invalid-payload');
    const invalidated = await fetch(`${origin}/api/protocol/ds-plugin/${pluginId}/ui.js`, {
      headers: { Cookie: cookie },
    });
    expect(invalidated.status).toBe(404);
  });

  it('handles plugin:process|restart in WebUI without exiting the process and broadcasts reload events', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const { server } = await bootServer();
    const firstHost = hostMock.instances[0]!;
    hostMock.manifestV2 = {
      version: 2,
      plugins: [{ id: 'workshop.plugin-reloaded', origin: 'community', file: 'ui.js', version: '0.2.0' }],
    };
    hostMock.degraded = [{ id: 'some.degraded', reason: 'test' }];

    const ws = new MemoryWsConnection();
    server.gateway.attachWebSocket(ws);

    // Subscribe tab to all reload/manifest events
    const eventsToWatch = ['host://ui-manifest', 'host://ui-manifest-v2', 'host://plugins-degraded', 'host://webui-reload'];
    let cb = 10;
    let handlerId = 100;
    for (const eventName of eventsToWatch) {
      ws.receive({
        type: 'invoke',
        cmd: 'plugin:event|listen',
        callback: cb,
        error: cb + 1,
        headers: {},
        payload: {
          contentType: 'application/json',
          data: JSON.stringify({ event: eventName, target: { kind: 'Any' }, handler: handlerId++ }),
        },
      });
      cb += 2;
    }

    // Trigger plugin:process|restart from client
    ws.receive({
      type: 'invoke',
      cmd: 'plugin:process|restart',
      callback: 500,
      error: 501,
      headers: {},
      payload: { contentType: 'application/json', data: '{}' },
    });

    const restartReply = await waitFor(() =>
      ws.sent.find((m) => m.type === 'result' && m.callbackId === 500 || m.type === 'result' && m.otherId === 500),
    );
    expect(restartReply).toMatchObject({
      type: 'result',
      callbackId: 500,
      body: { kind: 'json' },
    });

    // Wait for scheduled restartHost() (150ms debounce) to spin up second Host instance
    const secondHost = await waitFor(() => hostMock.instances[1]);
    expect(firstHost.shutdown).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();

    await waitFor(() =>
      secondHost.invokes.some((i) => i.cmd === 'plugin:ui|manifest') &&
      secondHost.invokes.some((i) => i.cmd === 'plugin:host|status')
        ? true
        : undefined,
    );

    const emittedEvents = await waitFor(() => {
      const names = ws.sent
        .filter((m): m is Extract<MainToRenderer, { type: 'listen-js' }> => m.type === 'listen-js')
        .map((m) => m.event);
      return eventsToWatch.every((e) => names.includes(e)) ? names : undefined;
    });
    expect(emittedEvents).toEqual(expect.arrayContaining(eventsToWatch));

    // Also verify Host-initiated process:restart shell-request succeeds without unknown shell op
    secondHost.sendShellRequest('shell-restart-1', 'process:restart');
    const shellResult = await waitFor(() => secondHost.shellResults.find((r) => r.id === 'shell-restart-1'));
    expect(shellResult).toEqual({ id: 'shell-restart-1', ok: true, value: null, error: undefined });
    await waitFor(() => hostMock.instances[2]);
    expect(secondHost.shutdown).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
