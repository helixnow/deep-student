// Download lifecycle against browser/service.rs: the native hooks and the hash
// thread hold only `Weak<BrowserService>` (:1270, :1497), and close_session (:521)
// leaves the download runtime untouched.
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v8 from 'node:v8';
import * as vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import type {
  BrowserSurfaceCreateOptions, BrowserSurfaceHost, SurfaceEventCallbacks,
} from '../api.ts';
import { BrowserRuntimeService } from '../src/browser-service.ts';
import type { JsonValue } from '../src/command-result.ts';
import type { BrowserDatabase } from '../src/database.ts';
import type { DownloadHashResult } from '../src/service.ts';
import { loadF3Flags } from './support/f3-feature-flags.ts';

interface HeldHash {
  path: string;
  warn: ((message: string) => void) | undefined;
  resolve(result: DownloadHashResult): void;
  promise: Promise<DownloadHashResult>;
}

const held = vi.hoisted(() => ({ enabled: false, calls: [] as HeldHash[] }));

vi.mock('../src/service.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/service.ts')>();
  return {
    ...actual,
    hashDownloadFileBounded(path: string, maxBytes: number, warn?: (message: string) => void) {
      if (!held.enabled) return actual.hashDownloadFileBounded(path, maxBytes, warn);
      let resolve!: (result: DownloadHashResult) => void;
      const promise = new Promise<DownloadHashResult>((settle) => { resolve = settle; });
      held.calls.push({ path, warn, resolve, promise });
      return promise;
    },
  };
});

class MinimalSurface implements BrowserSurfaceHost {
  present = false;
  hostMode(): string { return 'embedded'; }
  hasContentWindow(): boolean { return this.present; }
  async createContentWindow(_options: BrowserSurfaceCreateOptions): Promise<void> { this.present = true; }
  async destroyContentWindow(): Promise<boolean> { this.present = false; return true; }
  async navigate(): Promise<void> {}
  async goBack(): Promise<void> {}
  async goForward(): Promise<void> {}
  async reload(): Promise<void> {}
  async focusContentWindow(): Promise<void> {}
  async releaseContentFocus(): Promise<void> {}
  async mainViewportSize(): Promise<{ width: number; height: number }> { return { width: 1200, height: 800 }; }
  async setContentBounds(): Promise<void> {}
  async setContentOcclusions(): Promise<void> {}
  async setContentVisibility(): Promise<void> {}
  async snapshot(): Promise<JsonValue> { return { text: '' }; }
  async click(): Promise<JsonValue> { return { ok: true }; }
  async typeText(): Promise<JsonValue> { return { ok: true }; }
  async setInputFiles(): Promise<JsonValue> { return { ok: true }; }
  async scroll(): Promise<JsonValue> { return { ok: true }; }
  subscribe(_callbacks: SurfaceEventCallbacks): () => void { return () => undefined; }
}

const FILE_URL = 'https://example.com/file.txt';
const HELLO_SHA = createHash('sha256').update('hello').digest('hex');

function service(root: string, logs: string[]): BrowserRuntimeService {
  const values = new Map<string, string>([['desktop.workbenchBrowserEnabled', 'true']]);
  const settings = {
    get: (key: string) => values.get(key) ?? null,
    save: (key: string, value: string) => { values.set(key, value); },
    delete: (key: string) => values.delete(key),
    listByPrefix: () => [],
    deleteByPrefix: () => 0,
    getSecret: async () => null,
    saveSecret: async () => undefined,
    deleteSecret: async () => false,
  };
  const db = {
    ensureOpen(): void {},
    isOpen(): boolean { return false; },
    activeDir(): string { return root; },
    close(): void {},
    dispose(): void {},
  } as unknown as BrowserDatabase;
  return new BrowserRuntimeService({
    db,
    settings: settings as unknown as SettingsStore,
    surface: new MinimalSurface(),
    platform: 'darwin',
    featureFlags: { isEnabled: name => loadF3Flags(settings, true).isFeatureEnabled(name) },
    emit: () => undefined,
    log: (level, message) => { logs.push(`${level}: ${message}`); },
    artifactRoot: async () => root,
    now: () => new Date('2026-11-07T00:00:00.000Z'),
  });
}

async function agentDownload(target: BrowserRuntimeService, chatSessionId = 'chat-1') {
  const opened = await target.openSession({ url: 'https://1.1.1.1/', fromAgent: true, chatSessionId });
  const requested = await target.onDownloadRequested(opened.id, FILE_URL, 'file.txt');
  expect(requested.allow).toBe(true);
  await writeFile(requested.path!, 'hello');
  return { sessionId: opened.id, path: requested.path! };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}

const exposeGc = (): (() => void) => {
  v8.setFlagsFromString('--expose-gc');
  return vm.runInNewContext('gc') as () => void;
};

async function collected(ref: WeakRef<object>): Promise<boolean> {
  const gc = exposeGc();
  for (let i = 0; i < 20; i += 1) {
    await flush();
    gc();
    await flush();
    if (ref.deref() === undefined) return true;
  }
  return false;
}

describe('browser download lifecycle (service.rs Weak<BrowserService> + close_session)', () => {
  const roots: string[] = [];

  afterEach(async () => {
    held.enabled = false;
    held.calls.length = 0;
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'browser-download-lifecycle-'));
    roots.push(root);
    return root;
  }

  it('a held hash finishes the observation and routes its worker warning while the service is alive', async () => {
    held.enabled = true;
    const logs: string[] = [];
    const target = service(await tempRoot(), logs);
    const { sessionId, path } = await agentDownload(target);

    target.onDownloadFinished(FILE_URL, path, true);
    expect(held.calls.map(call => call.path)).toEqual([path]);
    expect(target.listDownloads(sessionId)[0]?.state).toBe('processing');

    const [call] = held.calls;
    call!.warn?.('[browser] download hash worker unavailable; hashing inline: probe');
    expect(logs).toContain('warn: [browser] download hash worker unavailable; hashing inline: probe');
    call!.resolve({ ok: true, sha256: HELLO_SHA, size: 5 });
    await call!.promise;
    await flush();
    expect(target.listDownloads(sessionId)[0]).toMatchObject({
      state: 'completed', sha256: HELLO_SHA, sizeBytes: 5, finishedAt: '2026-11-07T00:00:00+00:00',
    });
  });

  it('in-flight hash work does not retain the service; once collected, its result and warnings are dropped', async () => {
    held.enabled = true;
    const logs: string[] = [];
    const root = await tempRoot();
    const started = async (): Promise<{ ref: WeakRef<BrowserRuntimeService>; call: HeldHash }> => {
      const target = service(root, logs);
      const { sessionId, path } = await agentDownload(target);
      target.onDownloadFinished(FILE_URL, path, true);
      expect(target.listDownloads(sessionId)[0]?.state).toBe('processing');
      expect(held.calls).toHaveLength(1);
      return { ref: new WeakRef(target), call: held.calls[0]! };
    };
    const { ref, call } = await started();
    let settled = false;
    void call.promise.then(() => { settled = true; });

    expect(await collected(ref)).toBe(true);
    expect(settled).toBe(false);

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => { rejections.push(reason); };
    process.on('unhandledRejection', onRejection);
    try {
      const before = [...logs];
      call.warn?.('[browser] download hash worker unavailable; hashing inline: after gc');
      call.resolve({ ok: true, sha256: HELLO_SHA, size: 5 });
      await call.promise;
      await flush();
      expect(settled).toBe(true);
      expect(logs).toEqual(before);
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('closing the session mid-download leaves the runtime to finish it, as close_session never touches downloads', async () => {
    const logs: string[] = [];
    const target = service(await tempRoot(), logs);
    const first = await agentDownload(target);
    const second = await target.onDownloadRequested(first.sessionId, 'https://example.com/second.bin', 'second.bin');
    expect(second.allow).toBe(true);

    await target.closeSession();
    expect(await target.onDownloadRequested(first.sessionId, FILE_URL, 'again.txt'))
      .toEqual({ allow: false, path: null });

    target.onDownloadFinished(FILE_URL, first.path, true);
    target.onDownloadFinished('https://example.com/second.bin', second.path, false);
    await vi.waitFor(() => expect(target.listDownloads(first.sessionId)[0]?.state).toBe('completed'));
    expect(target.listDownloads(first.sessionId).map(item => [item.url, item.state, item.sha256, item.error])).toEqual([
      [FILE_URL, 'completed', HELLO_SHA, null],
      ['https://example.com/second.bin', 'failed', null, 'native download reported failure'],
    ]);
    expect(target.listTaskDownloads('chat-1')).toHaveLength(2);
  });

  it('reservations hold the task budget until the native result or hash settles; completed bytes stay counted', async () => {
    held.enabled = true;
    const target = service(await tempRoot(), []);
    const opened = await target.openSession({ url: 'https://1.1.1.1/', fromAgent: true, chatSessionId: 'chat-b' });
    const request = (name: string) => target.onDownloadRequested(opened.id, `https://example.com/${name}`, name);
    const granted: { allow: boolean; path: string | null }[] = [];
    for (const name of ['a', 'b', 'c', 'd']) granted.push(await request(name));
    expect(granted.every(item => item.allow)).toBe(true);
    expect(await request('e')).toEqual({ allow: false, path: null });

    target.onDownloadFinished('https://example.com/a', granted[0]!.path, false);
    const replacement = await request('e');
    expect(replacement.allow).toBe(true);

    target.onDownloadFinished('https://example.com/b', granted[1]!.path, true);
    expect(await request('f')).toEqual({ allow: false, path: null });
    const [call] = held.calls;
    call!.resolve({ ok: true, sha256: HELLO_SHA, size: 5 });
    await call!.promise;
    await flush();
    expect(target.listDownloads(opened.id).find(item => item.url === 'https://example.com/b')?.state).toBe('completed');
    expect(await request('f')).toEqual({ allow: false, path: null });

    target.onDownloadFinished('https://example.com/c', granted[2]!.path, false);
    expect((await request('g')).allow).toBe(true);
  });
});
