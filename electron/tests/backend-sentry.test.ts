/**
 * 后端 Sentry（src-tauri/src/lib.rs:291-363、1322-1335，crash_logger.rs:40-61）：授权开关、启动读授权、DSN 来源，
 * 以及用真实 `@sentry/node`（假 DSN + 注入的 transport，或本机假的 Sentry 收件端）验证事件确实发出、关掉后不再发出、
 * 未授权时不初始化。
 */
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../host/kernel/testing.ts';
import {
  createBackendSentry,
  crashEvent,
  defaultSentryInit,
  installCrashCapture,
  isSentryDsn,
  type BackendSentryInitOptions,
  type SentryGuard,
  type SentryNodeSdk,
} from '../backend-sentry.ts';
import { APP_ROOT, appBuildInfo, sentryRelease } from '../build-info.ts';
import plugin from '../index.ts';

const require = createRequire(import.meta.url);
const Sentry = require('@sentry/node') as SentryNodeSdk & {
  createTransport(options: unknown, send: (request: { body: string | Uint8Array }) => Promise<{ statusCode: number }>): unknown;
};

const FAKE_DSN = 'https://public@o0.ingest.example.invalid/42';
const RELEASE = '0.11.0+20000.abcdef0123456789abcdef0123456789abcdef01';
const quiet = () => undefined;
const guards: SentryGuard[] = [];
afterEach(async () => {
  for (const guard of guards.splice(0)) await guard.close(0);
  expect(Sentry.getCurrentScope().getClient()).toBeUndefined();
});

interface Envelope { header: Record<string, unknown>; items: Array<{ type: string; payload: Record<string, unknown> }> }

function parseEnvelope(body: string | Uint8Array): Envelope {
  const lines = (typeof body === 'string' ? body : new TextDecoder().decode(body)).split('\n').filter((line) => line !== '');
  const items: Envelope['items'] = [];
  for (let i = 1; i + 1 < lines.length; i += 2) {
    items.push({ type: (JSON.parse(lines[i]!) as { type: string }).type, payload: JSON.parse(lines[i + 1]!) as Record<string, unknown> });
  }
  return { header: JSON.parse(lines[0]!) as Record<string, unknown>, items };
}

/** 假 DSN + 注入的 transport：记录 SDK 交给传输层的每个信封。 */
function recordingInit(overrides: Partial<BackendSentryInitOptions> = {}) {
  const envelopes: Envelope[] = [];
  const urls: string[] = [];
  const logs: Array<[string, string]> = [];
  const loads = { count: 0 };
  const init = defaultSentryInit({
    log: (level, message) => { logs.push([level, message]); },
    release: RELEASE,
    debug: false,
    bundledDsn: undefined,
    env: { SENTRY_DSN: FAKE_DSN },
    loadSdk: () => { loads.count += 1; return Sentry; },
    transport: (options: { url: string }) => Sentry.createTransport(options, async (request) => {
      urls.push(options.url);
      envelopes.push(parseEnvelope(request.body));
      return { statusCode: 200 };
    }),
    ...overrides,
  });
  const tracked = () => {
    const guard = init();
    if (guard) guards.push(guard);
    return guard;
  };
  return { init: tracked, envelopes, urls, logs, loads };
}

const events = (envelopes: Envelope[]) => envelopes.flatMap((envelope) => envelope.items.filter((item) => item.type === 'event').map((item) => item.payload));

function sentryWith(init: () => SentryGuard | null | Promise<SentryGuard | null>, saved: Array<[string, string]> = []) {
  return createBackendSentry({ settings: { save: (key, value) => { saved.push([key, value]); } }, log: quiet, init, platform: 'darwin', appRoot: '/app' });
}

const fakeGuard = (counters: { closed: number }): SentryGuard => ({ capture: () => undefined, close: () => { counters.closed += 1; } });

describe('set_backend_sentry_enabled (lib.rs:330-363) and the startup restore (lib.rs:1322-1335)', () => {
  it('persists consent, initializes once and closes the guard on disable', async () => {
    const saved: Array<[string, string]> = [];
    let initialized = 0;
    const counters = { closed: 0 };
    const sentry = sentryWith(() => { initialized += 1; return fakeGuard(counters); }, saved);
    await expect(sentry.setEnabled(true)).resolves.toBe(true);
    await expect(sentry.setEnabled(true)).resolves.toBe(true);
    expect(initialized).toBe(1);
    await expect(sentry.setEnabled(false)).resolves.toBe(false);
    expect(counters.closed).toBe(1);
    expect(saved).toEqual([
      ['sentry_error_reporting_enabled', 'true'],
      ['sentry_error_reporting_enabled', 'true'],
      ['sentry_error_reporting_enabled', 'false'],
    ]);
  });

  it('a failed settings write is the Rust error text and leaves the reporting state untouched', async () => {
    let initialized = 0;
    const sentry = createBackendSentry({
      settings: { save: () => { throw new Error('database is locked'); } },
      log: quiet,
      init: () => { initialized += 1; return fakeGuard({ closed: 0 }); },
      platform: 'linux',
      appRoot: '/app',
    });
    await expect(sentry.setEnabled(true)).rejects.toMatchObject({ value: '保存错误报告授权失败: database is locked' });
    expect(initialized).toBe(0);
  });

  it('restore initializes from the saved consent at startup only when it is "true", without writing it back', async () => {
    for (const [stored, expected] of [['true', 1], ['false', 0], [null, 0], ['TRUE', 0]] as const) {
      const saved: Array<[string, string]> = [];
      let initialized = 0;
      const sentry = sentryWith(() => { initialized += 1; return fakeGuard({ closed: 0 }); }, saved);
      await expect(sentry.restore(() => stored)).resolves.toBe(expected === 1);
      expect(initialized).toBe(expected);
      expect(saved).toEqual([]);
    }
    const unreadable = sentryWith(() => { throw new Error('must not init'); });
    await expect(unreadable.restore(() => { throw new Error('database is locked'); })).resolves.toBe(false);
  });

  it('restore shares the consent lock: a later enable does not init twice, a disable issued meanwhile closes the restored guard', async () => {
    let initialized = 0;
    const counters = { closed: 0 };
    let release!: () => void;
    const sentry = sentryWith(async () => {
      initialized += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      return fakeGuard(counters);
    });
    const restored = sentry.restore(() => 'true');
    const disabled = sentry.setEnabled(false);
    await vi.waitFor(() => expect(initialized).toBe(1));
    release();
    await expect(restored).resolves.toBe(true);
    await expect(disabled).resolves.toBe(false);
    expect(counters.closed).toBe(1);
    initialized = 0;
    const again = sentryWith(() => { initialized += 1; return fakeGuard({ closed: 0 }); });
    await again.restore(() => 'true');
    await expect(again.setEnabled(true)).resolves.toBe(true);
    expect(initialized).toBe(1);
  });

  it('returns false when the DSN or SDK cannot initialize, matching the Rust warn branch', async () => {
    await expect(sentryWith(() => null).setEnabled(true)).resolves.toBe(false);
  });

  it('a close failure is logged and does not change the result (Rust drop cannot fail)', async () => {
    const logs: Array<[string, string]> = [];
    const sentry = createBackendSentry({
      settings: { save: () => undefined },
      log: (level, message) => { logs.push([level, message]); },
      init: () => ({ capture: () => undefined, close: () => { throw new Error('flush failed'); } }),
      platform: 'linux',
      appRoot: '/app',
    });
    await sentry.setEnabled(true);
    await expect(sentry.setEnabled(false)).resolves.toBe(false);
    expect(logs).toEqual([
      ['warn', '[Sentry] backend error reporting close failed: flush failed'],
      ['info', '[Sentry] backend error reporting disabled'],
    ]);
  });

  it('dispose closes an active client through the same lock, with a timeout inside the Host per-plugin dispose budget', async () => {
    const timeouts: number[] = [];
    const sentry = sentryWith(() => ({ capture: () => undefined, close: (timeoutMs) => { timeouts.push(timeoutMs); } }));
    await sentry.setEnabled(true);
    await sentry.dispose();
    await sentry.dispose();
    await sentry.setEnabled(true);
    await sentry.setEnabled(false);
    expect(timeouts).toEqual([1000, 2000]);
  });
});

describe('DSN and options (init_backend_sentry_client, lib.rs:293-323)', () => {
  it('accepts only Sentry-shaped DSNs like sentry-types Dsn::from_str', () => {
    expect(isSentryDsn('https://public@o1.ingest.sentry.io/42')).toBe(true);
    expect(isSentryDsn('http://key:secret@localhost:9000/project/7')).toBe(true);
    expect(isSentryDsn('https://public@o1.ingest.sentry.io/42/')).toBe(true);
    expect(isSentryDsn('ftp://public@example.com/42')).toBe(false);
    expect(isSentryDsn('https://example.com/42')).toBe(false);
    expect(isSentryDsn('https://public@example.com/')).toBe(false);
    expect(isSentryDsn('https://public@example.com')).toBe(false);
    expect(isSentryDsn('not a url')).toBe(false);
  });

  it('missing or invalid DSNs warn with the Rust texts and never load the SDK', () => {
    for (const [env, bundledDsn, text] of [
      [{}, undefined, '[Sentry] user consent is enabled, but backend DSN is not configured'],
      [{ SENTRY_DSN: '' }, undefined, '[Sentry] user consent is enabled, but backend DSN is not configured'],
      [{ SENTRY_DSN: '   ' }, undefined, '[Sentry] user consent is enabled, but backend DSN is not configured'],
      [{}, '', '[Sentry] user consent is enabled, but backend DSN is not configured'],
      [{ SENTRY_DSN: 'https://example.com/42' }, undefined, '[Sentry] backend DSN is invalid; error reporting remains disabled'],
      [{}, 'https://example.com/42', '[Sentry] backend DSN is invalid; error reporting remains disabled'],
    ] as const) {
      const { init, logs, loads } = recordingInit({ env, bundledDsn });
      expect(init()).toBeNull();
      expect(logs).toEqual([['warn', text]]);
      expect(loads.count).toBe(0);
    }
  });

  it('a runtime SENTRY_DSN, even an empty one, takes precedence over the DSN embedded at build time (env::var(..).ok().or_else(option_env!))', async () => {
    const embedded = recordingInit({ env: {}, bundledDsn: FAKE_DSN });
    expect(embedded.init()).not.toBeNull();
    expect(embedded.logs).toEqual([['info', '[Sentry] backend error reporting enabled by user consent']]);
    for (const guard of guards.splice(0)) await guard.close(0);

    const masked = recordingInit({ env: { SENTRY_DSN: '' }, bundledDsn: FAKE_DSN });
    expect(masked.init()).toBeNull();
    expect(masked.logs).toEqual([['warn', '[Sentry] user consent is enabled, but backend DSN is not configured']]);
  });

  it('an SDK that fails to load or initialize leaves reporting off with a warning instead of failing the consent toggle', () => {
    const missing = recordingInit({ loadSdk: () => { throw new Error("Cannot find module '@sentry/node'"); } });
    expect(missing.init()).toBeNull();
    expect(missing.logs).toEqual([['warn', "[Sentry] backend SDK initialization failed; error reporting remains disabled: Cannot find module '@sentry/node'"]]);
  });

  it('a DSN that Dsn::from_str accepts but the JS SDK cannot parse counts as invalid instead of a client that silently drops events', () => {
    const odd = 'https://pub-key@o0.ingest.example.invalid/42';
    expect(isSentryDsn(odd)).toBe(true);
    const { init, logs } = recordingInit({ env: { SENTRY_DSN: odd } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(init()).toBeNull();
    } finally {
      spy.mockRestore();
    }
    expect(logs).toEqual([['warn', '[Sentry] backend DSN is invalid; error reporting remains disabled']]);
    expect(Sentry.getCurrentScope().getClient()).toBeUndefined();
  });
});

describe('real @sentry/node with an injected transport', () => {
  it('RF-W06-backend-sentry-rust-no-transport: with consent and a valid DSN the crash event reaches the transport (Rust built sentry without a transport and panicked here)', async () => {
    const { init, envelopes, urls } = recordingInit({ debug: true });
    const sentry = sentryWith(init);
    await expect(sentry.setEnabled(true)).resolves.toBe(true);
    const error = new TypeError("Cannot read properties of undefined (reading 'id')");
    error.stack = `TypeError: ${error.message}\n    at loadCard (/app/host/plugins/qbank/src/cards.ts:42:7)\n    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)`;
    sentry.captureCrash(error, 'uncaughtException');
    await vi.waitFor(() => expect(events(envelopes)).toHaveLength(1));
    const [event] = events(envelopes);
    expect(event).toMatchObject({
      level: 'fatal',
      message: "uncaught exception at host/plugins/qbank/src/cards.ts:42:7:\nTypeError: Cannot read properties of undefined (reading 'id')",
      fingerprint: ['host-uncaught-exception', 'host/plugins/qbank/src/cards.ts:42'],
      release: RELEASE,
      environment: 'development',
      platform: 'node',
    });
    // send_default_pii: false 且没有 ContextIntegration：不带主机名、用户、请求。
    expect(event).not.toHaveProperty('server_name');
    expect(event).not.toHaveProperty('user');
    expect(event).not.toHaveProperty('request');
    expect((event!.sdk as { integrations: string[] }).integrations).toEqual([]);
    expect(urls).toHaveLength(1);
    const endpoint = new URL(urls[0]!);
    expect(`${endpoint.origin}${endpoint.pathname}`).toBe('https://o0.ingest.example.invalid/api/42/envelope/');
    expect(endpoint.searchParams.get('sentry_key')).toBe('public');
  });

  it('turning consent off stops reporting and unbinds the client; turning it on again reports through a new client', async () => {
    const { init, envelopes } = recordingInit();
    const sentry = sentryWith(init);
    await sentry.setEnabled(true);
    sentry.captureCrash(new Error('first'), 'unhandledRejection');
    await vi.waitFor(() => expect(events(envelopes)).toHaveLength(1));
    await expect(sentry.setEnabled(false)).resolves.toBe(false);
    expect(Sentry.getCurrentScope().getClient()).toBeUndefined();
    sentry.captureCrash(new Error('while off'), 'uncaughtException');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events(envelopes)).toHaveLength(1);
    await expect(sentry.setEnabled(true)).resolves.toBe(true);
    sentry.captureCrash('third', 'unhandledRejection');
    await vi.waitFor(() => expect(events(envelopes)).toHaveLength(2));
    const [first, third] = events(envelopes);
    expect(first!.fingerprint).toEqual(['host-unhandled-rejection', expect.stringMatching(/backend-sentry\.test\.ts:\d+$/)]);
    expect(first!.message).toMatch(/^unhandled rejection at \S+backend-sentry\.test\.ts:\d+:\d+:\nError: first$/);
    expect(third).toMatchObject({ message: 'unhandled rejection:\nthird', fingerprint: ['host-unhandled-rejection', 'unknown'] });
  });

  it('without consent the SDK is never loaded and crashes are not reported', async () => {
    const { init, envelopes, loads } = recordingInit();
    const sentry = sentryWith(init);
    await expect(sentry.restore(() => 'false')).resolves.toBe(false);
    await expect(sentry.restore(() => null)).resolves.toBe(false);
    sentry.captureCrash(new Error('boom'), 'uncaughtException');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(loads.count).toBe(0);
    expect(envelopes).toEqual([]);
    expect(Sentry.getCurrentScope().getClient()).toBeUndefined();
  });

  it('only events are sent: no session, client report or trace envelopes (Rust: auto_session_tracking off, no default integrations)', async () => {
    const { init, envelopes } = recordingInit();
    const sentry = sentryWith(init);
    await sentry.restore(() => 'true');
    sentry.captureCrash(new Error('one'), 'uncaughtException');
    sentry.captureCrash(new Error('two'), 'uncaughtException');
    await vi.waitFor(() => expect(events(envelopes)).toHaveLength(2));
    await sentry.setEnabled(false);
    expect(envelopes.flatMap((envelope) => envelope.items.map((item) => item.type))).toEqual(['event', 'event']);
  });
});

describe('crash events (crash_logger.rs panic hook)', () => {
  const at = (frame: string) => Object.assign(new Error('x'), { stack: `Error: x\n    at ${frame}` });

  it('use the first stack frame, relative to the app root so the fingerprint does not depend on where the app is installed', () => {
    for (const [root, frame, file] of [
      ['/Applications/Deep Student.app/Contents/Resources/app.asar', 'fn (/Applications/Deep Student.app/Contents/Resources/app.asar/host/kernel/x.ts:3:9)', 'host/kernel/x.ts'],
      ['/opt/ds', 'file:///opt/ds/electron/index.ts:10:2', 'electron/index.ts'],
      ['/opt/ds', 'node:internal/process/task_queues:105:5', 'node:internal/process/task_queues'],
    ] as const) {
      const event = crashEvent(at(frame), 'uncaughtException', { platform: 'linux', appRoot: root });
      expect(event.fingerprint[1]).toBe(`${file}:${/:(\d+):\d+\)?$/.exec(frame)![1]}`);
    }
    const windows = crashEvent(at('fn (C:\\Users\\alice\\AppData\\Local\\Programs\\deep-student\\resources\\app.asar\\host\\kernel\\x.ts:3:9)'), 'uncaughtException', {
      platform: 'win32', appRoot: 'C:\\Users\\alice\\AppData\\Local\\Programs\\deep-student\\resources\\app.asar',
    });
    if (process.platform === 'win32') expect(windows.fingerprint[1]).toBe('host/kernel/x.ts:3');
    else expect(windows.fingerprint[1]).toBe('C:\\Users\\<REDACTED>\\AppData\\Local\\Programs\\deep-student\\resources\\app.asar\\host\\kernel\\x.ts:3');
  });

  it('scrub user directories and credentials like scrub_pii, in the message and the fingerprint', () => {
    const error = Object.assign(new Error("ENOENT: no such file or directory, open '/Users/alice/notes/a.md' (Bearer abcdefgh12345678)"), {
      stack: 'Error\n    at read (/home/alice/plugins/community/x.js:1:2)',
    });
    const event = crashEvent(error, 'unhandledRejection', { platform: 'darwin', appRoot: '/Applications/Deep Student.app/Contents/Resources/app.asar' });
    expect(event.message).not.toMatch(/alice|abcdefgh12345678/);
    expect(event.message).toContain('/<REDACTED>/notes/a.md');
    expect(event.fingerprint).toEqual(['host-unhandled-rejection', '/<REDACTED>/plugins/community/x.js:1']);
  });

  it('values without a stack get an "unknown" location; unprintable values do not throw', () => {
    expect(crashEvent('plain', 'unhandledRejection', { platform: 'linux', appRoot: '/app' })).toEqual({
      message: 'unhandled rejection:\nplain', level: 'fatal', fingerprint: ['host-unhandled-rejection', 'unknown'],
    });
    expect(crashEvent(Object.create(null), 'uncaughtException', { platform: 'linux', appRoot: '/app' }).message).toBe('uncaught exception:\n[object Object]');
  });

  it('installCrashCapture routes uncaught exceptions and unhandled rejections and removes both listeners', () => {
    const proc = new EventEmitter();
    const seen: Array<[unknown, string]> = [];
    const uninstall = installCrashCapture({ captureCrash: (error, origin) => { seen.push([error, origin]); } }, proc);
    proc.emit('uncaughtExceptionMonitor', 'a', 'uncaughtException');
    proc.emit('unhandledRejection', 'b', Promise.resolve());
    expect(seen).toEqual([['a', 'uncaughtException'], ['b', 'unhandledRejection']]);
    uninstall();
    expect(proc.listenerCount('uncaughtExceptionMonitor') + proc.listenerCount('unhandledRejection')).toBe(0);
  });

  it('a failure while building or sending the event never escapes into the crash path and is logged', async () => {
    const logs: Array<[string, string]> = [];
    const sentry = createBackendSentry({
      settings: { save: () => undefined },
      log: (level, message) => { logs.push([level, message]); },
      init: () => ({ capture: () => { throw new Error('transport exploded'); }, close: () => undefined }),
      platform: 'darwin',
      appRoot: '/app',
    });
    await sentry.setEnabled(true);
    expect(() => sentry.captureCrash(new Error('boom'), 'uncaughtException')).not.toThrow();
    expect(logs).toEqual([['warn', '[Sentry] backend crash report failed: transport exploded']]);
  });
});

describe('dstu.shell plugin wiring through the Host (real @sentry/node HTTP transport, local fake ingest)', () => {
  const hostProcess: EventEmitter = process;
  let server: Server | null = null;
  afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => { if (server) server.close(() => resolve()); else resolve(); });
    server = null;
  });

  it('restores consent at startup, reports Host crashes, stops after consent is withdrawn and unhooks on dispose', async () => {
    const received: Array<{ url: string; envelope: Envelope }> = [];
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push({ url: request.url ?? '', envelope: parseEnvelope(Buffer.concat(chunks)) });
        response.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    vi.stubEnv('SENTRY_DSN', `http://public@127.0.0.1:${port}/42`);
    vi.stubEnv('SENTRY_ENVIRONMENT', 'wiring-test');
    vi.stubEnv('http_proxy', '');
    vi.stubEnv('https_proxy', '');
    const store = new Map([['sentry_error_reporting_enabled', 'true']]);
    const listeners = () => process.listenerCount('uncaughtExceptionMonitor') + process.listenerCount('unhandledRejection');
    const before = listeners();
    const host = await createTestHost({
      plugins: [plugin],
      app: { platform: 'linux' },
      provide: { settings: { get: (key: string) => store.get(key) ?? null, save: (key: string, value: string) => { store.set(key, value); } } },
      shell: () => null,
    });
    try {
      expect(listeners()).toBe(before + 2);
      await vi.waitFor(() => expect(Sentry.getCurrentScope().getClient()).toBeDefined(), { timeout: 10_000 });
      const crash = new RangeError('Invalid array length');
      crash.stack = `RangeError: Invalid array length\n    at grow (${join(APP_ROOT, 'host', 'plugins', 'notes', 'src', 'tree.ts')}:88:13)`;
      hostProcess.emit('uncaughtExceptionMonitor', crash, 'uncaughtException');
      await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 10_000 });
      expect(received[0]!.url).toMatch(/^\/api\/42\/envelope\//);
      expect(events(received.map((entry) => entry.envelope))).toEqual([expect.objectContaining({
        level: 'fatal',
        message: 'uncaught exception at host/plugins/notes/src/tree.ts:88:13:\nRangeError: Invalid array length',
        fingerprint: ['host-uncaught-exception', 'host/plugins/notes/src/tree.ts:88'],
        release: sentryRelease(appBuildInfo()),
        environment: 'wiring-test',
      })]);

      await expect(host.invoke('set_backend_sentry_enabled', { enabled: false })).resolves.toBe(false);
      expect(store.get('sentry_error_reporting_enabled')).toBe('false');
      hostProcess.emit('uncaughtExceptionMonitor', new Error('after consent was withdrawn'), 'uncaughtException');
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(received).toHaveLength(1);
    } finally {
      await host.dispose();
    }
    expect(listeners()).toBe(before);
    expect(Sentry.getCurrentScope().getClient()).toBeUndefined();
  });

  it('with consent stored as anything but "true" the plugin never initializes the SDK', async () => {
    vi.stubEnv('SENTRY_DSN', FAKE_DSN);
    const reads: string[] = [];
    const host = await createTestHost({
      plugins: [plugin],
      app: { platform: 'linux' },
      provide: { settings: { get: (key: string) => { reads.push(key); return 'false'; }, save: () => undefined } },
      shell: () => null,
    });
    try {
      await vi.waitFor(() => expect(reads).toEqual(['sentry_error_reporting_enabled']));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(Sentry.getCurrentScope().getClient()).toBeUndefined();
    } finally {
      await host.dispose();
    }
  });
});
