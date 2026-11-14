/**
 * 卸载后语义（V09 P2-1）与桌面逐步对拍：同一段脚本分别跑在桌面 `StorageServiceImpl` / `StorageCordisService`（better-sqlite3）
 * 和移动端 `MobileStorageService`（Node 版 sqlite-wasm）上，每一步的返回值或错误形状（`StorageError` 的
 * code / sqliteCode / message / database）、收尾顺序和落库内容都必须相同。
 *
 * - 裸实例：`dispose()` 关连接后可再开库；`shutdown()` 是终态，之后会开连接的入口都抛 `TX_CLOSED`，维护屏障不开连接，照常可用。
 * - 插件卸载：`beforeShutdown` 的收尾在关库前执行（后登记先执行，失败不阻止关库），之后卸载前取走的引用一律 `TX_CLOSED`。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../host/kernel/testing.ts';
import type { StorageService } from '../../../host/platform/storage/api.ts';
import { createStorageService, StorageCordisService } from '../../../host/platform/storage/service.ts';
import mobileStorage, { MobileStorageService } from '../../../host/platform/storage-mobile/index.ts';
import { errorShape, nodeRuntime, nodeSqlite } from './support/sqlite-node.ts';

type Trace = [label: string, outcome: 'ok' | 'err', value: unknown][];
type Drain = () => void | Promise<void>;

interface BareStorage extends StorageService {
  dispose(): void;
  shutdown(): void;
}

interface UnloadSide {
  readonly storage: StorageService & { beforeShutdown(drain: Drain): void };
  unload(): Promise<void>;
  /** 卸载后用新的裸实例打开同一数据目录，读回 `drained` 表。 */
  readBack(): unknown;
}

const temps: string[] = [];
const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'w31-dispose-diff-'));
  temps.push(dir);
  return dir;
}

function step(trace: Trace, label: string, fn: () => unknown): void {
  try {
    trace.push([label, 'ok', fn()]);
  } catch (error) {
    trace.push([label, 'err', errorShape(error)]);
  }
}

async function stepAsync(trace: Trace, label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    trace.push([label, 'ok', await fn()]);
  } catch (error) {
    trace.push([label, 'err', errorShape(error)]);
  }
}

async function bareScript(storage: BareStorage, adHocPath: string, exists: (path: string) => boolean): Promise<Trace> {
  const t: Trace = [];
  const before = storage.database('chat_v2');
  step(t, 'write before dispose', () => before.exec('CREATE TABLE x (a)'));
  step(t, 'dispose', () => storage.dispose());
  step(t, 'a handle taken before dispose is closed', () => before.get('SELECT 1'));
  step(t, 'dispose keeps the instance usable: database() reopens the file', () => storage.database('chat_v2').pluck("SELECT COUNT(*) FROM sqlite_master WHERE name='x'"));
  step(t, 'a fresh handle after dispose', () => storage.database('chat_v2') !== before);
  await stepAsync(t, 'maintenance after dispose', async () => {
    const lease = await storage.enterMaintenance(['chat_v2']);
    lease.release();
    return lease.databases;
  });
  const lastHandle = storage.database('chat_v2');

  step(t, 'shutdown', () => storage.shutdown());
  step(t, 'shutdown again', () => storage.shutdown());
  step(t, 'dispose after shutdown', () => storage.dispose());
  step(t, 'a handle taken before shutdown is closed', () => lastHandle.get('SELECT 1'));
  step(t, 'database(chat_v2)', () => storage.database('chat_v2'));
  step(t, 'database(vfs)', () => storage.database('vfs'));
  step(t, 'openFile without label', () => storage.openFile(adHocPath));
  step(t, 'openFile with label', () => storage.openFile(adHocPath, { label: 'probe' }));
  step(t, 'openFile did not create the file', () => exists(adHocPath));
  step(t, 'openFile of a registered database file', () => storage.openFile(storage.pathOf('vfs'), { label: 'vfs-file' }));
  await stepAsync(t, 'migrations.runAll', () => storage.migrations.runAll());
  await stepAsync(t, 'migrations.migrateSingle', () => storage.migrations.migrateSingle('vfs'));
  step(t, 'migrations.needsMigration', () => storage.migrations.needsMigration('vfs'));
  step(t, 'migrations.currentVersion of an existing file', () => storage.migrations.currentVersion('chat_v2'));
  step(t, 'batchArchiveOldMistakes', () => storage.batchArchiveOldMistakes(30));
  step(t, 'batchCleanupOrphanedMessages', () => storage.batchCleanupOrphanedMessages());
  await stepAsync(t, 'maintenance opens no connection and still works', async () => {
    const lease = await storage.enterMaintenance(['vfs']);
    lease.release();
    return lease.databases;
  });
  return t;
}

async function unloadScript(side: UnloadSide): Promise<Trace> {
  const t: Trace = [];
  const { storage } = side;
  const order: string[] = [];
  const vfs = storage.database('vfs');
  step(t, 'setup', () => storage.database('llm_usage').exec('CREATE TABLE drained (step TEXT)'));
  storage.beforeShutdown(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    step(t, 'first-registered drain writes while connections are open', () => storage.database('llm_usage').run("INSERT INTO drained VALUES ('first-registered')"));
    order.push('first-registered');
  });
  storage.beforeShutdown(() => {
    order.push('failing');
    throw new Error('drain boom');
  });

  await stepAsync(t, 'unload', () => side.unload());
  step(t, 'drain order', () => order);
  step(t, 'a handle taken before unload is closed', () => vfs.get('SELECT 1'));
  step(t, 'database(llm_usage)', () => storage.database('llm_usage'));
  step(t, 'openFile', () => storage.openFile(storage.pathOf('vfs'), { label: 'after-unload' }));
  await stepAsync(t, 'migrations.runAll', () => storage.migrations.runAll());
  step(t, 'the drain write reached the file', () => side.readBack());
  return t;
}

async function desktopUnload(): Promise<UnloadSide> {
  const base = tempDir();
  const ctx = new Context();
  (ctx as unknown as { app: unknown }).app = { dataDir: base, version: 't', platform: 'darwin', debug: true };
  const fork = ctx.plugin({ name: 'w31-desktop-storage', apply: (c: Context) => { new StorageCordisService(c, { dataLocalDir: base }); } });
  await fork;
  return {
    storage: ctx.storage as StorageService & Pick<StorageCordisService, 'beforeShutdown'>,
    unload: async () => { await fork.dispose(); },
    readBack: () => {
      const reopened = createStorageService({ baseDir: base, dataLocalDir: base });
      try { return reopened.database('llm_usage').pluck('SELECT step FROM drained'); }
      finally { reopened.shutdown(); }
    },
  };
}

async function mobileUnload(): Promise<UnloadSide> {
  const runtime = nodeRuntime(await nodeSqlite());
  const host = await createTestHost({ provide: { sqliteRuntime: runtime } });
  hosts.push(host);
  await host.install(mobileStorage);
  return {
    storage: host.ctx.storage as MobileStorageService,
    unload: () => host.unload('dstu.platform.storage'),
    readBack: () => {
      const reopened = new MobileStorageService({ runtime, baseDir: host.app.dataDir });
      try { return reopened.database('llm_usage').pluck('SELECT step FROM drained'); }
      finally { reopened.shutdown(); }
    },
  };
}

describe('storage after dispose / shutdown / unload: mobile matches desktop step by step', () => {
  it('bare instance: dispose() reopens, shutdown() is terminal', async () => {
    const base = tempDir();
    const desktop = await bareScript(createStorageService({ baseDir: base, dataLocalDir: base }), join(base, 'adhoc.db'), existsSync);
    const runtime = nodeRuntime(await nodeSqlite());
    const mobile = await bareScript(new MobileStorageService({ runtime, baseDir: '/data' }), '/data/adhoc.db', path => runtime.exists(path));

    expect(mobile).toEqual(desktop);
    expect(desktop.find(([label]) => label === 'database(chat_v2)')).toEqual(['database(chat_v2)', 'err', {
      storageError: true, code: 'TX_CLOSED', sqliteCode: undefined, phase: undefined, database: 'chat_v2', message: 'Storage service is disposed',
    }]);
  }, 60_000);

  it('plugin unload: drains run before the connections close, then every captured entry is closed', async () => {
    const desktop = await unloadScript(await desktopUnload());
    const mobile = await unloadScript(await mobileUnload());

    expect(mobile).toEqual(desktop);
    expect(desktop.find(([label]) => label === 'drain order')).toEqual(['drain order', 'ok', ['failing', 'first-registered']]);
    expect(desktop.at(-1)).toEqual(['the drain write reached the file', 'ok', 'first-registered']);
  }, 60_000);
});
