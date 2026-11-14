/**
 * V09 P2-1 的移动端一侧（桌面为 W07 `027ea23c`）：storage 插件卸载后，卸载前取走的 `ctx.storage` 引用不得静默重开连接。
 * 移动端每个库文件只允许一条连接（V06-06）；卸载后漏开的连接在插件重装后就是同一文件上的第二条连接，两边的写入会互相覆盖。
 * 合法的重开路径不受影响：插件重装得到新实例，裸实例 `dispose()` 后可复用；`shutdown()` 是终态；
 * `beforeShutdown` 登记的收尾在关库前执行（后登记先执行，失败只记 warn）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../host/kernel/testing.ts';
import type { StorageService } from '../../../host/platform/storage/api.ts';
import mobileStorage, { MobileStorageService } from '../../../host/platform/storage-mobile/index.ts';
import { nodeRuntime, nodeSqlite, type NodeRuntime } from './support/sqlite-node.ts';

const closed = expect.objectContaining({ name: 'StorageError', code: 'TX_CLOSED' });

let host: TestHost | undefined;
afterEach(async () => {
  await host?.dispose();
  host = undefined;
});

async function storageHost(runtime: NodeRuntime, warnings: string[] = []): Promise<TestHost> {
  host = await createTestHost({ provide: { sqliteRuntime: runtime } });
  host.ctx.logger.exporter({ levels: { default: 4 }, export: (message) => { if (message.type === 'warn') warnings.push(String(message.args[0])); } });
  await host.install(mobileStorage);
  return host;
}

describe('V09 P2-1 mobile storage unload', () => {
  it('a storage reference captured before unload rejects every entry that would open a connection, and opens nothing', async () => {
    const runtime = nodeRuntime(await nodeSqlite());
    const h = await storageHost(runtime);
    const captured: StorageService = h.ctx.storage;
    const vfs = captured.database('vfs');
    vfs.exec('CREATE TABLE IF NOT EXISTS probe (id INTEGER)');
    const shared = captured.openFile(captured.pathOf('chat_v2'), { label: 'chat-file' });
    const adHocFile = '/data/adhoc.db';

    await h.unload('dstu.platform.storage');
    const opened = runtime.opened.length;

    expect(() => vfs.get('SELECT 1')).toThrow(closed);
    expect(() => shared.get('SELECT 1')).toThrow(closed);
    expect(() => captured.database('vfs')).toThrow(closed);
    expect(() => captured.database('llm_usage')).toThrow(closed);
    expect(() => captured.openFile(adHocFile)).toThrow(closed);
    expect(() => captured.openFile(captured.pathOf('vfs'))).toThrow(closed);
    expect(runtime.exists(adHocFile)).toBe(false);
    await expect(captured.migrations.runAll()).rejects.toEqual(closed);
    await expect(captured.migrations.migrateSingle('vfs')).rejects.toEqual(closed);
    expect(() => captured.migrations.needsMigration('vfs')).toThrow(closed);
    expect(() => captured.migrations.currentVersion('vfs')).toThrow(closed);
    expect(() => captured.batchArchiveOldMistakes(30)).toThrow(closed);
    expect(() => captured.batchCleanupOrphanedMessages()).toThrow(closed);
    expect(runtime.opened.slice(opened)).toEqual([]);
  }, 60_000);

  it('reinstalling the storage plugin yields a fresh service that reopens the same files', async () => {
    const runtime = nodeRuntime(await nodeSqlite());
    const h = await storageHost(runtime);
    const first: StorageService = h.ctx.storage;
    first.database('vfs').exec('CREATE TABLE IF NOT EXISTS probe (id INTEGER); INSERT INTO probe VALUES (7)');

    await h.unload('dstu.platform.storage');
    expect(() => first.database('vfs')).toThrow(closed);
    await h.install(mobileStorage);

    const second: StorageService = h.ctx.storage;
    expect(second).not.toBe(first);
    expect(second.database('vfs').pluck('SELECT id FROM probe')).toBe(7);
    expect(() => first.database('vfs')).toThrow(closed);
  }, 60_000);

  it('beforeShutdown drains run (latest first) while connections are still open; a failing drain does not keep storage open', async () => {
    const runtime = nodeRuntime(await nodeSqlite());
    const warnings: string[] = [];
    const h = await storageHost(runtime, warnings);
    const captured = h.ctx.storage as MobileStorageService;
    captured.database('llm_usage').exec('CREATE TABLE drained (step TEXT)');
    const order: string[] = [];
    captured.beforeShutdown(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      captured.database('llm_usage').run("INSERT INTO drained VALUES ('first-registered')");
      order.push('first-registered');
    });
    captured.beforeShutdown(() => { order.push('failing'); throw new Error('drain boom'); });

    await h.unload('dstu.platform.storage');

    expect(order).toEqual(['failing', 'first-registered']);
    expect(warnings).toContain('storage 卸载前的收尾失败: drain boom');
    expect(() => captured.database('llm_usage')).toThrow(closed);
    const reopened = new MobileStorageService({ runtime, baseDir: h.app.dataDir });
    try { expect(reopened.database('llm_usage').pluck('SELECT step FROM drained')).toBe('first-registered'); }
    finally { reopened.shutdown(); }
  }, 60_000);

  it('shutdown() is terminal for a bare service; dispose() keeps the close-then-reopen contract', async () => {
    const runtime = nodeRuntime(await nodeSqlite());
    const reusable = new MobileStorageService({ runtime, baseDir: '/data' });
    const before = reusable.database('chat_v2');
    before.exec('CREATE TABLE x (a)');
    reusable.dispose();
    expect(() => before.get('SELECT 1')).toThrow(closed);
    const after = reusable.database('chat_v2');
    expect(after).not.toBe(before);
    expect(after.pluck("SELECT COUNT(*) FROM sqlite_master WHERE name='x'")).toBe(1);
    const lease = await reusable.enterMaintenance(['chat_v2']);
    lease.release();
    expect(reusable.database('chat_v2').pluck('SELECT 1')).toBe(1);

    reusable.shutdown();
    reusable.shutdown();
    reusable.dispose();
    const opened = runtime.opened.length;
    expect(() => reusable.database('chat_v2')).toThrow(closed);
    expect(() => reusable.openFile('/data/other.db')).toThrow(closed);
    expect(runtime.exists('/data/other.db')).toBe(false);
    await expect(reusable.migrations.runAll()).rejects.toEqual(closed);
    expect(runtime.opened.slice(opened)).toEqual([]);
  }, 60_000);
});
