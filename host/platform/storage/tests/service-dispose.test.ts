/**
 * V09 P2-1：storage 服务卸载后，`database()` / `openFile()` 等入口不得静默重开新连接；
 * 合法的重开路径（插件重装得到新实例、裸实例 `dispose()` 后复用、维护屏障与 `switchToPath`）不受影响。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import secrets from '../../secrets/index.ts';
import type { StorageService } from '../api.ts';
import storage from '../index.ts';
import { createStorageService, StorageCordisService } from '../service.ts';

const closed = expect.objectContaining({ name: 'StorageError', code: 'TX_CLOSED' });

let base: string;
let host: Awaited<ReturnType<typeof createTestHost>> | undefined;
beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-svc-dispose-')); });
afterEach(async () => {
  await host?.dispose();
  host = undefined;
  fs.rmSync(base, { recursive: true, force: true });
  await setImmediate();
});

async function storageHost() {
  const local = path.join(base, 'local');
  return createTestHost({
    app: { dataDir: path.join(base, 'app') },
    plugins: [secrets, storage],
    provide: {
      paths: { os: { home: base, data: local, dataLocal: local, config: local, temp: base } },
      log: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
      storageStartupSync: { resetDefaultAfterLocalPurge() {} },
    },
    shell: () => null,
  });
}

describe('V09 P2-1 storage dispose', () => {
  it('a storage reference captured before unload rejects database/openFile/migrations afterwards instead of reopening', async () => {
    host = await storageHost();
    const captured: StorageService = host.ctx.storage;
    const vfs = captured.database('vfs');
    vfs.exec('CREATE TABLE IF NOT EXISTS probe (id INTEGER)');
    const adHocFile = path.join(base, 'adhoc.db');

    await host.unload('dstu.platform.storage');

    expect(() => vfs.get('SELECT 1')).toThrow(closed);
    expect(() => captured.database('vfs')).toThrow(closed);
    expect(() => captured.database('llm_usage')).toThrow(closed);
    expect(() => captured.openFile(adHocFile)).toThrow(closed);
    expect(fs.existsSync(adHocFile)).toBe(false);
    await expect(captured.migrations.runAll()).rejects.toEqual(closed);
    expect(() => captured.migrations.needsMigration('vfs')).toThrow(closed);
    expect(() => captured.migrations.currentVersion('vfs')).toThrow(closed);
  });

  it('reinstalling the storage plugin yields a fresh service that reopens the same files', async () => {
    host = await storageHost();
    const first: StorageService = host.ctx.storage;
    first.database('vfs').exec('CREATE TABLE IF NOT EXISTS probe (id INTEGER); INSERT INTO probe VALUES (7)');

    await host.unload('dstu.platform.storage');
    await host.install(storage);

    const second: StorageService = host.ctx.storage;
    expect(second).not.toBe(first);
    expect(second.database('vfs').pluck('SELECT id FROM probe')).toBe(7);
    expect(() => first.database('vfs')).toThrow(closed);
  });

  it('beforeShutdown drains run (latest first) while connections are still open; a failing drain does not keep storage open', async () => {
    const ctx = new Context();
    (ctx as unknown as { app: unknown }).app = { dataDir: base, version: 't', platform: 'darwin', debug: true };
    let svc!: StorageCordisService;
    const fork = ctx.plugin({ name: 'storage-drain-probe', apply: (c: Context) => { svc = new StorageCordisService(c, { dataLocalDir: base }); } });
    await fork;
    const captured: StorageService = ctx.storage;
    captured.database('llm_usage').exec('CREATE TABLE drained (step TEXT)');
    const order: string[] = [];
    svc.beforeShutdown(async () => {
      await setImmediate();
      captured.database('llm_usage').run("INSERT INTO drained VALUES ('first-registered')");
      order.push('first-registered');
    });
    svc.beforeShutdown(() => { order.push('failing'); throw new Error('drain boom'); });

    await fork.dispose();

    expect(order).toEqual(['failing', 'first-registered']);
    expect(() => captured.database('llm_usage')).toThrow(closed);
    const reopened = createStorageService({ baseDir: base, dataLocalDir: base });
    try { expect(reopened.database('llm_usage').pluck('SELECT step FROM drained')).toBe('first-registered'); }
    finally { reopened.shutdown(); }
  });

  it('shutdown() is terminal for a bare service; dispose() keeps the close-then-reopen contract', async () => {
    const dataLocalDir = path.join(base, 'local');
    const reusable = createStorageService({ baseDir: base, dataLocalDir });
    const before = reusable.database('chat_v2');
    before.exec('CREATE TABLE x (a)');
    reusable.dispose();
    expect(() => before.get('SELECT 1')).toThrow(closed);
    const after = reusable.database('chat_v2');
    expect(after).not.toBe(before);
    expect(after.pluck("SELECT COUNT(*) FROM sqlite_master WHERE name='x'")).toBe(1);
    const lease = await reusable.enterMaintenance(['chat_v2']);
    lease.release();
    reusable.switchToPath('chat_v2', path.join(base, 'switched.db'));
    expect(reusable.database('chat_v2').path).toBe(path.join(base, 'switched.db'));

    reusable.shutdown();
    reusable.shutdown();
    reusable.dispose();
    expect(() => reusable.database('chat_v2')).toThrow(closed);
    expect(() => reusable.switchToPath('vfs', path.join(base, 'other.db'))).toThrow(closed);
    expect(fs.existsSync(path.join(base, 'other.db'))).toBe(false);
    expect(() => reusable.coordinator()).toThrow(closed);
  });
});
