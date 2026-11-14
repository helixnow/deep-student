/**
 * 迁移编排的端到端测试：三平台各自的源布局用构造文件模拟，写入侧用内存 Storage 模拟 preload。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyWebviewMigrationEntries,
  completeWebviewMigration,
  prepareWebviewMigration,
  webviewMigrationDone,
  WebviewMigrationError,
  type StorageLike,
  type WebviewMigrationOptions,
  type WriterProbe,
  type WriterProbeResult,
} from '../index.ts';
import { chromiumKey, chromiumString, encodeBatch, encodeLog, encodeTable, PRIORITY_ENTRIES, writeLevelDb, writeWebKitLocalStorage } from './fixtures.ts';

const ID = 'com.deepstudent.app';
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'w07-webview-migration-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function stoppedProbe(): WriterProbe & { calls: number } {
  const probe = { calls: 0, async check(): Promise<WriterProbeResult> { probe.calls += 1; return { state: 'stopped', evidence: 'test' }; } };
  return probe;
}

function options(platform: WebviewMigrationOptions['platform'], probe: WriterProbe = stoppedProbe()): WebviewMigrationOptions {
  const home = join(root, 'home');
  const dataLocal = platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : platform === 'win32' ? join(home, 'AppData', 'Local') : join(home, '.local', 'share');
  const appData = platform === 'win32' ? join(home, 'AppData', 'Roaming', ID) : join(dataLocal, ID);
  return { platform, homeDir: home, dataLocalDir: dataLocal, appDataDir: appData, identifier: ID, userDataDir: join(root, 'electron-user-data'), probe };
}

class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  constructor(initial: Record<string, string> = {}, private readonly quota = Number.POSITIVE_INFINITY) {
    for (const [key, value] of Object.entries(initial)) this.map.set(key, value);
  }
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void {
    if (value.length > this.quota) throw Object.assign(new Error('quota exceeded'), { name: 'QuotaExceededError' });
    this.map.set(key, value);
  }
}

function state(opts: WebviewMigrationOptions): { status: string; source: { kind: string; path: string } | null; result?: unknown } {
  return JSON.parse(readFileSync(join(opts.userDataDir, 'webview-migration', 'state.json'), 'utf8'));
}

async function migrate(opts: WebviewMigrationOptions, storage = new MemoryStorage()) {
  const prepared = await prepareWebviewMigration(opts);
  if (prepared.status === 'done') return { prepared, storage, report: null };
  const report = applyWebviewMigrationEntries(storage, prepared.entries);
  completeWebviewMigration(opts, report);
  return { prepared, storage, report };
}

function expectPriorityKeys(storage: MemoryStorage) {
  for (const [key, value] of PRIORITY_ENTRIES) expect(storage.getItem(key), key).toBe(value);
}

describe('Linux (WebKitGTK)', () => {
  it('migrates the measured legacy layout once and leaves the source untouched', async () => {
    const opts = options('linux');
    const source = join(opts.dataLocalDir, ID, 'localstorage', 'tauri_localhost_0.localstorage');
    writeWebKitLocalStorage(source, PRIORITY_ENTRIES, { wal: true });
    const before = readFileSync(source);
    const mtime = statSync(source).mtimeMs;

    const first = await migrate(opts);
    expect(first.prepared.status).toBe('pending');
    expectPriorityKeys(first.storage);
    expect(state(opts)).toMatchObject({ status: 'done', source: { kind: 'webkit-sqlite', path: source }, result: { written: PRIORITY_ENTRIES.length, kept: 0 } });
    expect(readFileSync(source).equals(before)).toBe(true);
    expect(statSync(source).mtimeMs).toBe(mtime);
    expect(webviewMigrationDone(opts.userDataDir)).toBe(true);

    expect((await prepareWebviewMigration(opts)).status).toBe('done');
  });

  it('finds the copy F3 startup recovery moved into recovery/incidents/*/legacy-root', async () => {
    const opts = options('linux');
    const incidents = join(opts.appDataDir, 'recovery', 'incidents');
    const older = join(incidents, 'startup-preflight-a', 'legacy-root', 'localstorage', 'tauri_localhost_0.localstorage');
    const newer = join(incidents, 'startup-preflight-b', 'legacy-root', 'localstorage', 'tauri_localhost_0.localstorage');
    writeWebKitLocalStorage(older, [['essay_draft_old', 'older incident']]);
    writeWebKitLocalStorage(newer, PRIORITY_ENTRIES);
    writeFileSync(join(incidents, 'startup-preflight-a', 'manifest.json'), JSON.stringify({ created_at: '2026-11-01T00:00:00Z' }));
    writeFileSync(join(incidents, 'startup-preflight-b', 'manifest.json'), JSON.stringify({ created_at: '2026-11-05T00:00:00Z' }));

    const { storage } = await migrate(opts);
    expectPriorityKeys(storage);
    expect(storage.getItem('essay_draft_old')).toBeNull();
    expect(state(opts).source).toMatchObject({ recoveredFrom: 'startup-preflight-b' });
  });

  it('orders incidents by directory mtime when a manifest is missing, corrupt or has no valid created_at', async () => {
    const opts = options('linux');
    const incidents = join(opts.appDataDir, 'recovery', 'incidents');
    const names = ['no-manifest', 'corrupt-manifest', 'null-manifest', 'bad-date'];
    for (const [index, name] of names.entries()) {
      writeWebKitLocalStorage(join(incidents, name, 'legacy-root', 'localstorage', 'tauri_localhost_0.localstorage'),
        name === 'corrupt-manifest' ? PRIORITY_ENTRIES : [[`essay_draft_${index}`, name]]);
    }
    writeFileSync(join(incidents, 'corrupt-manifest', 'manifest.json'), '{"created_at":');
    writeFileSync(join(incidents, 'null-manifest', 'manifest.json'), 'null');
    writeFileSync(join(incidents, 'bad-date', 'manifest.json'), JSON.stringify({ created_at: 'not a date' }));
    for (const [index, name] of names.entries()) {
      const at = new Date(Date.UTC(2026, 10, 1 + (name === 'corrupt-manifest' ? 9 : index)));
      utimesSync(join(incidents, name), at, at);
    }

    const { storage } = await migrate(opts);
    expectPriorityKeys(storage);
    expect(state(opts).source).toMatchObject({ recoveredFrom: 'corrupt-manifest' });
  });

  it('an unreadable or unknown state.json is treated as not migrated and logged, then snapshotted again', async () => {
    writeWebKitLocalStorage(join(options('linux').dataLocalDir, ID, 'localstorage', 'tauri_localhost_0.localstorage'), PRIORITY_ENTRIES);
    for (const content of ['{"version":1,', 'null', JSON.stringify({ version: 2, status: 'done' }), JSON.stringify({ version: 1, status: 'weird' })]) {
      const logs: string[] = [];
      const opts = { ...options('linux'), userDataDir: mkdtempSync(join(root, 'user-')), log: (message: string) => logs.push(message) };
      mkdirSync(join(opts.userDataDir, 'webview-migration'), { recursive: true });
      writeFileSync(join(opts.userDataDir, 'webview-migration', 'state.json'), content);

      expect(webviewMigrationDone(opts.userDataDir), content).toBe(false);
      const { prepared, storage } = await migrate(opts);
      expect(prepared.status, content).toBe('pending');
      expectPriorityKeys(storage);
      expect(logs.some((line) => line.includes('state.json 无法解析')), content).toBe(true);
      expect(state(opts).status).toBe('done');
    }
  });

  it('accepts the origin-partitioned layout when the origin file names tauri://localhost', async () => {
    const opts = options('linux');
    const storageRoot = join(opts.dataLocalDir, ID, 'storage');
    const app = join(storageRoot, 'SALTED', 'SALTED');
    writeWebKitLocalStorage(join(app, 'LocalStorage', 'localstorage.sqlite3'), PRIORITY_ENTRIES);
    writeFileSync(join(app, 'origin'), Buffer.concat([Buffer.from([5, 0, 0, 0, 1]), Buffer.from('tauri'), Buffer.from([9, 0, 0, 0, 1]), Buffer.from('localhost')]));
    const foreign = join(storageRoot, 'OTHER', 'OTHER');
    writeWebKitLocalStorage(join(foreign, 'LocalStorage', 'localstorage.sqlite3'), [['essay_draft_x', 'from https site']]);
    writeFileSync(join(foreign, 'origin'), Buffer.from('https example.com'));

    const { storage } = await migrate(opts);
    expectPriorityKeys(storage);
    expect(storage.getItem('essay_draft_x')).toBeNull();
  });
});

describe('macOS (WKWebView)', () => {
  it('migrates the legacy WebsiteData/LocalStorage file', async () => {
    const opts = options('darwin');
    writeWebKitLocalStorage(join(opts.homeDir, 'Library', 'WebKit', ID, 'WebsiteData', 'LocalStorage', 'tauri_localhost_0.localstorage'), PRIORITY_ENTRIES);
    expectPriorityKeys((await migrate(opts)).storage);
  });

  it('prefers the partitioned Default/<h>/<h> layout over a stale legacy file', async () => {
    const opts = options('darwin');
    const website = join(opts.homeDir, 'Library', 'WebKit', ID, 'WebsiteData');
    writeWebKitLocalStorage(join(website, 'LocalStorage', 'tauri_localhost_0.localstorage'), [['essay_draft_e1b2', 'stale legacy']]);
    const app = join(website, 'Default', 'H1', 'H1');
    writeWebKitLocalStorage(join(app, 'LocalStorage', 'localstorage.sqlite3'), PRIORITY_ENTRIES);
    writeFileSync(join(app, 'origin'), 'tauri localhost');
    expectPriorityKeys((await migrate(opts)).storage);
  });

  it('refuses to guess between two directories that both look like the app origin', async () => {
    const opts = options('darwin');
    const website = join(opts.homeDir, 'Library', 'WebKit', ID, 'WebsiteData', 'Default');
    for (const hash of ['H1', 'H2']) {
      writeWebKitLocalStorage(join(website, hash, hash, 'LocalStorage', 'localstorage.sqlite3'), [['k', hash]]);
      writeFileSync(join(website, hash, hash, 'origin'), 'tauri localhost');
    }
    await expect(prepareWebviewMigration(opts)).rejects.toMatchObject({ code: 'SOURCE_AMBIGUOUS' });
  });
});

describe('Windows (WebView2 LevelDB)', () => {
  function writeWebView2(opts: WebviewMigrationOptions) {
    const origin = 'http://tauri.localhost';
    const dir = join(opts.dataLocalDir, ID, 'EBWebView', 'Default', 'Local Storage', 'leveldb');
    const [essay, essayNew, receipt, desktop, pomodoro, ...rest] = PRIORITY_ENTRIES;
    writeLevelDb(dir, {
      manifest: 9,
      edits: [{ newFiles: [{ level: 1, number: 7, size: 0 }], logNumber: 8, nextFile: 10, lastSeq: 40 }],
      tables: {
        7: encodeTable([
          { key: Buffer.from('VERSION'), seq: 1n, value: Buffer.from('1') },
          { key: chromiumKey(origin, essay![0]), seq: 2n, value: chromiumString('older draft') },
          { key: chromiumKey(origin, receipt![0]), seq: 3n, value: chromiumString(receipt![1]) },
          { key: chromiumKey(origin, desktop![0]), seq: 4n, value: chromiumString(desktop![1]) },
          { key: chromiumKey(origin, 'deleted-later'), seq: 5n, value: chromiumString('x') },
          { key: chromiumKey('https://example.com', essay![0]), seq: 6n, value: chromiumString('other origin') },
        ], { compress: true, perBlock: 2 }),
      },
      logs: {
        8: encodeLog([
          encodeBatch(41n, [
            { put: chromiumKey(origin, essay![0]), value: chromiumString(essay![1]) },
            { put: chromiumKey(origin, essayNew![0]), value: chromiumString(essayNew![1]) },
            { put: chromiumKey(origin, pomodoro![0]), value: chromiumString(pomodoro![1]) },
            { del: chromiumKey(origin, 'deleted-later') },
          ]),
          encodeBatch(45n, rest.map(([key, value]) => ({ put: chromiumKey(origin, key), value: chromiumString(value) }))),
        ]),
      },
      extra: { LOCK: '', LOG: '' },
    });
    return dir;
  }

  it('reads the newest values for http://tauri.localhost from tables and the live log', async () => {
    const opts = options('win32');
    const dir = writeWebView2(opts);
    const { storage } = await migrate(opts);
    expectPriorityKeys(storage);
    expect(storage.getItem('deleted-later')).toBeNull();
    expect(storage.map.size).toBe(PRIORITY_ENTRIES.length);
    expect(state(opts).source).toMatchObject({ kind: 'chromium-leveldb', path: dir });
    expect(existsSync(join(opts.userDataDir, 'webview-migration', 'source', 'leveldb', 'LOCK'))).toBe(false);
  });
});

describe('state machine and failure modes', () => {
  function linuxSource(opts: WebviewMigrationOptions, entries = PRIORITY_ENTRIES) {
    const source = join(opts.dataLocalDir, ID, 'localstorage', 'tauri_localhost_0.localstorage');
    writeWebKitLocalStorage(source, entries);
    return source;
  }

  it('marks a new user done without creating a snapshot', async () => {
    const opts = options('linux');
    expect((await prepareWebviewMigration(opts)).status).toBe('done');
    expect(state(opts)).toMatchObject({ status: 'done', source: null });
    expect(existsSync(join(opts.userDataDir, 'webview-migration', 'source'))).toBe(false);
  });

  it('keeps values the Electron side already has (target wins) and replays idempotently after a crash', async () => {
    const opts = options('linux');
    linuxSource(opts);
    const storage = new MemoryStorage({ i18nextLng: 'en-US' });

    const prepared = await prepareWebviewMigration(opts);
    if (prepared.status !== 'pending') throw new Error('expected pending');
    const partial = applyWebviewMigrationEntries(storage, prepared.entries.slice(0, 3));
    expect(partial.written).toBe(3);
    // Crash before completeWebviewMigration: next launch replays the remaining keys from the snapshot.
    expect(state(opts).status).toBe('snapshotted');

    const replay = await prepareWebviewMigration(opts);
    if (replay.status !== 'pending') throw new Error('expected pending');
    const report = applyWebviewMigrationEntries(storage, replay.entries);
    const alreadyThere = new Set(['i18nextLng', ...prepared.entries.slice(0, 3).map(([key]) => key)]);
    expect(report).toEqual({
      written: PRIORITY_ENTRIES.length - 4,
      kept: 4,
      keptKeys: replay.entries.map(([key]) => key).filter((key) => alreadyThere.has(key)),
      failed: [],
    });
    completeWebviewMigration(opts, report);
    expect(storage.getItem('i18nextLng')).toBe('en-US');
    expect(storage.getItem('essay_draft_e1b2')).toBe(PRIORITY_ENTRIES[0]![1]);
  });

  it('reuses the snapshot instead of re-reading a source that changed between launches', async () => {
    const opts = options('linux');
    const source = linuxSource(opts);
    expect((await prepareWebviewMigration(opts)).status).toBe('pending');
    rmSync(source);
    writeWebKitLocalStorage(source, [['essay_draft_e1b2', 'written after the snapshot']]);
    const { storage } = await migrate(opts);
    expectPriorityKeys(storage);
  });

  it('does not snapshot while the old writer is running and tells the user to quit it', async () => {
    const opts = options('linux', { check: async () => ({ state: 'running', detail: 'pid 42 holds the database' }) });
    linuxSource(opts);
    const error = await prepareWebviewMigration(opts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebviewMigrationError);
    expect(error).toMatchObject({ code: 'WRITER_RUNNING' });
    expect((error as WebviewMigrationError).userMessage).toMatch(/完全退出旧版/);
    expect(existsSync(join(opts.userDataDir, 'webview-migration', 'source'))).toBe(false);
    expect(state(opts).status).toBe('snapshotting');
  });

  it('fails closed when the writer state cannot be verified, including after the copy', async () => {
    const unverified = options('linux', { check: async () => ({ state: 'unknown', detail: 'lsof unavailable' }) });
    linuxSource(unverified);
    await expect(prepareWebviewMigration(unverified)).rejects.toMatchObject({ code: 'WRITER_UNVERIFIED' });

    let calls = 0;
    const late = options('linux', { check: async () => (++calls === 1 ? { state: 'stopped', evidence: '' } : { state: 'running', detail: 'reopened' }) });
    await expect(prepareWebviewMigration(late)).rejects.toMatchObject({ code: 'WRITER_RUNNING' });
    expect(existsSync(join(late.userDataDir, 'webview-migration', 'source'))).toBe(false);
  });

  it('discards the snapshot when the source changes inside the verification window', async () => {
    const opts = options('linux');
    const source = linuxSource(opts);
    const touching: WriterProbe = {
      async check() {
        utimesSync(source, new Date(), new Date(Date.now() + 60_000));
        return { state: 'stopped', evidence: '' };
      },
    };
    await expect(prepareWebviewMigration({ ...opts, probe: touching })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(existsSync(join(opts.userDataDir, 'webview-migration', 'source'))).toBe(false);

    const appearing: WriterProbe = {
      async check() {
        if (!existsSync(`${source}-wal`)) writeFileSync(`${source}-wal`, Buffer.alloc(0));
        return { state: 'stopped', evidence: '' };
      },
    };
    rmSync(`${source}-wal`, { force: true });
    await expect(prepareWebviewMigration({ ...opts, probe: appearing })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });

    expect((await prepareWebviewMigration(opts)).status).toBe('pending');
  });

  it('reports corrupt snapshots without marking anything done', async () => {
    const opts = options('linux');
    const source = join(opts.dataLocalDir, ID, 'localstorage', 'tauri_localhost_0.localstorage');
    mkdirSync(join(source, '..'), { recursive: true });
    writeFileSync(source, Buffer.alloc(8192, 0x41));
    await expect(prepareWebviewMigration(opts)).rejects.toMatchObject({ code: 'SOURCE_UNREADABLE' });
    expect(state(opts).status).toBe('snapshotting');
  });

  it('does not mark done when a key fails to write; the next launch retries', async () => {
    const opts = options('linux');
    linuxSource(opts);
    const prepared = await prepareWebviewMigration(opts);
    if (prepared.status !== 'pending') throw new Error('expected pending');
    const report = applyWebviewMigrationEntries(new MemoryStorage({}, 10_000), prepared.entries);
    expect(report.failed.map((item) => item.key)).toEqual(['huge']);
    expect(() => completeWebviewMigration(opts, report)).toThrow(WebviewMigrationError);
    expect(state(opts).status).toBe('snapshotted');
    expect(webviewMigrationDone(opts.userDataDir)).toBe(false);
  });

  it('refuses to complete without a snapshot', () => {
    const opts = options('linux');
    expect(() => completeWebviewMigration(opts, { written: 0, kept: 0, keptKeys: [], failed: [] })).toThrow(/NOT_SNAPSHOTTED/);
  });
});
