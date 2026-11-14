import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestHost, definePlugin } from '../../../kernel/testing.ts';
import shell from '../../../../electron/index.ts';
import secrets from '../../secrets/index.ts';
import storage from '../index.ts';
import { syncStateDatabasePath } from '../node.ts';
import { DataSpaceManager } from '../data-space.ts';
import { DEFAULT_MIGRATIONS_DIR } from '../migration/definitions/index.ts';
let base: string;
let host: Awaited<ReturnType<typeof createTestHost>> | undefined;
beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-start-host-')); });
afterEach(async () => { await host?.dispose(); host = undefined; fs.rmSync(base, { recursive: true, force: true }); await setImmediate(); });
async function start(reset = () => {}, extraProvide: Record<string, unknown> = {}) {
  host = await createTestHost({ app: { dataDir: base }, plugins: [shell, secrets, [storage, { dataLocalDir: base }]],
    provide: { paths: { os: { home: base, data: base, dataLocal: base, config: base, temp: base } },
      log: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }, storageStartupSync: { resetDefaultAfterLocalPurge: reset }, ...extraProvide },
    shell: () => null });
  host.ctx.startupGate.markStartupReady();
  return host;
}
it('pending switch and purge complete before migrations.runAll opens the active databases', async () => {
  fs.mkdirSync(path.join(base, 'slots/slotB'), { recursive: true });
  fs.writeFileSync(path.join(base, 'slots/slotB/mistakes.db'), 'invalid-old-database');
  fs.writeFileSync(path.join(base, 'slots/state.json'), JSON.stringify({ active: 'slotA', pending: 'slotB' }));
  fs.writeFileSync(path.join(base, '.purge_on_next_start'), '1');
  let resetBeforeMigration = false;
  const h = await start(() => { resetBeforeMigration = !fs.existsSync(path.join(base, 'slots/slotB/mistakes.db')); });
  expect(resetBeforeMigration).toBe(true); expect(h.ctx.storage.locations.activeSlot).toBe('slotB');
  expect(h.ctx.storage.migrations.currentVersion('mistakes')).toBeGreaterThan(20260130);
  expect(fs.existsSync(path.join(base, '.purge_on_next_start'))).toBe(false);
  expect(await h.invoke('get_data_space_info')).toMatchObject({ active_slot: 'slotB', pending_slot: null });
  await expect(h.invoke('purge_active_data_dir_now')).rejects.toEqual({ error_type: 'Validation', message: '为保证数据库连接安全，移动端清空数据需要完整退出并重新打开应用，不能仅刷新页面', details: null });
});
it('recovery mode keeps business databases closed and exposes the recovery commands', async () => {
  fs.mkdirSync(path.join(base, 'slots/slotB'), { recursive: true });
  fs.writeFileSync(path.join(base, 'slots/slotB/cache.db'), 'unrelated'); fs.writeFileSync(path.join(base, 'unrelated.db'), 'legacy');
  const h = await start(); expect((await h.invoke('get_startup_recovery_status') as { recovery_required: boolean }).recovery_required).toBe(true);
  expect(() => h.ctx.storage.database('vfs')).toThrow('业务数据库保持关闭');
  expect(fs.existsSync(path.join(base, 'slots/slotA/mistakes.db'))).toBe(false);
  await expect(h.ctx.storage.migrations.runAll()).rejects.toThrow('业务数据库保持关闭');
  await expect(h.invoke('get_data_space_info')).rejects.toMatchObject({ error_type: 'Unknown', message: '数据空间管理器未初始化', details: null });
});
it('purge failure preserves the marker and prevents migration even after retry_preflight', async () => {
  fs.writeFileSync(path.join(base, '.purge_on_next_start'), '1');
  const h = await start(() => { throw new Error('reset failed'); });
  expect(fs.existsSync(path.join(base, '.purge_on_next_start'))).toBe(true);
  expect(await h.invoke('retry_startup_recovery_preflight')).toMatchObject({ recovery_required: true, incident: { failed_operation: 'startup_cleanup', retry_requires_restart: true } });
  expect(() => h.ctx.storage.database('vfs')).toThrow();
});
it('storage-independent storageStartupSync reset runs after purge and before storage/migrations', async () => {
  fs.mkdirSync(path.join(base, 'slots/slotA'), { recursive: true });
  fs.writeFileSync(path.join(base, 'slots/slotA/mistakes.db'), 'stale-database');
  fs.writeFileSync(path.join(base, '.purge_on_next_start'), '1');
  expect(syncStateDatabasePath(base)).toBe(path.join(base, 'deep-student', 'sync', 'sync_state.db'));

  const seen: { storagePublished: boolean; markerExists: boolean; activeFiles: string[] } = {
    storagePublished: true, markerExists: false, activeFiles: [],
  };
  const provider = definePlugin({
    meta: { id: 'test.sync-startup-provider', provides: ['storageStartupSync'] },
    apply(ctx) {
      ctx.provide('storageStartupSync', {
        resetDefaultAfterLocalPurge() {
          // 必须在 storage 发布前、purge 之后、清理标记仍在时执行（Rust lib.rs:1021）。
          seen.storagePublished = ctx.get('storage') !== undefined;
          seen.markerExists = fs.existsSync(path.join(base, '.purge_on_next_start'));
          seen.activeFiles = fs.readdirSync(path.join(base, 'slots/slotA'));
        },
      });
    },
  });
  host = await createTestHost({
    app: { dataDir: base },
    plugins: [secrets, provider, [storage, { dataLocalDir: base }]],
    provide: {
      paths: { os: { home: base, data: base, dataLocal: base, config: base, temp: base } },
      log: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
    },
    shell: () => null,
  });

  expect(seen.storagePublished).toBe(false);
  expect(seen.markerExists).toBe(true);
  expect(seen.activeFiles).not.toContain('mistakes.db');
  expect(fs.existsSync(path.join(base, '.purge_on_next_start'))).toBe(false);
  expect(host.ctx.storage.migrations.currentVersion('mistakes')).toBeGreaterThan(20260130);
  expect(host.ctx.storage.locations.activeSlot).toBe('slotA');
});

it('missing storageStartupSync keeps the purge marker and blocks business databases', async () => {
  fs.writeFileSync(path.join(base, '.purge_on_next_start'), '1');
  host = await createTestHost({
    app: { dataDir: base },
    plugins: [shell, secrets, [storage, { dataLocalDir: base }]],
    provide: {
      paths: { os: { home: base, data: base, dataLocal: base, config: base, temp: base } },
      log: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
    },
    shell: () => null,
  });
  host.ctx.startupGate.markStartupReady();
  expect(fs.existsSync(path.join(base, '.purge_on_next_start'))).toBe(true);
  expect((await host.invoke('get_startup_recovery_status') as { recovery_required: boolean }).recovery_required).toBe(true);
  expect(() => host!.ctx.storage.database('vfs')).toThrow('业务数据库保持关闭');
});

it('legacy root data is migrated before a fresh migration can create a replacement database', async () => {
  const db = new Database(path.join(base, 'mistakes.db')); db.exec('CREATE TABLE user_marker (value TEXT); INSERT INTO user_marker VALUES (\'preserved\')'); db.close();
  const h = await start(); expect(fs.existsSync(path.join(base, 'mistakes.db'))).toBe(false);
  expect(h.ctx.storage.database('mistakes').pluck('SELECT value FROM user_marker')).toBe('preserved');
});
it('slot and marker commands retain their Rust IPC values', async () => {
  const h = await start();
  expect(await h.invoke('get_slot_directory', { slotName: 'D' })).toBe(path.join(base, 'slots/slotD'));
  await expect(h.invoke('get_slot_directory', { slotName: 'bad' })).rejects.toEqual({ error_type: 'Validation', message: '无效的插槽名称: bad', details: null });
  expect(await h.invoke('get_test_slot_info')).toMatchObject({ slot_c_exists: true, slot_d_exists: true, slot_c_file_count: 0, slot_d_file_count: 0 });
  expect(await h.invoke('clear_test_slots')).toBe('测试插槽 C 和 D 已清空');
  fs.writeFileSync(path.join(base, 'slots/slotB/data'), 'data');
  expect(await h.invoke('mark_data_space_pending_switch_to_inactive')).toBe('已标记下次重启切换到 slotB');
  expect(await h.invoke('purge_all_database_files')).toBe('已标记：下次启动将清空所有数据（备份保留），即将重启应用以完成清空。');
  expect(fs.existsSync(path.join(base, '.purge_on_next_start'))).toBe(true);
  expect(await h.invoke('restart_app')).toBeNull(); expect(h.shellRequests.at(-1)?.op).toBe('plugin:process|restart');
});
it('get_database_info reports active-slot paths and set_test_run_id echoes the run id', async () => {
  const h = await start();
  const production = path.join(base, 'slots/slotA/mistakes.db');
  const test = path.join(base, 'slots/slotA/test_mistakes.db');
  expect(await h.invoke('get_database_info')).toEqual({
    production_db_path: production,
    test_db_path: test,
    test_db_exists: false,
    production_db_exists: true,
    active_database: 'production',
  });
  fs.writeFileSync(test, '');
  expect(await h.invoke('get_database_info')).toMatchObject({ test_db_exists: true });
  expect(await h.invoke('set_test_run_id', { testRunId: 'run-1' })).toEqual({ success: true, test_run_id: 'run-1' });
});
it('test database commands switch the live handle, reset and seed the isolated file', async () => {
  const appState: { activeDatabase: 'production' | 'test' } = { activeDatabase: 'production' };
  const h = await start(() => {}, { appCommandState: appState });
  const production = path.join(base, 'slots/slotA/mistakes.db');
  const test = path.join(base, 'slots/slotA/test_mistakes.db');
  const mistakes = h.ctx.storage.database('mistakes');
  mistakes.run('CREATE TABLE switch_probe (value TEXT)');
  mistakes.run("INSERT INTO switch_probe (value) VALUES ('production')");

  expect(await h.invoke('switch_to_test_database')).toEqual({
    success: true, test_db_path: test, message: '已切换到测试数据库', active_database: 'test',
  });
  expect(appState.activeDatabase).toBe('test');
  expect(fs.existsSync(test)).toBe(true);
  expect(h.ctx.storage.database('mistakes')).toBe(mistakes);
  expect(mistakes.pluck("SELECT COUNT(1) FROM sqlite_master WHERE type = 'table' AND name = 'switch_probe'")).toBe(0);
  mistakes.run('CREATE TABLE switch_probe (value TEXT)');
  mistakes.run("INSERT INTO switch_probe (value) VALUES ('test')");

  expect(await h.invoke('reset_test_database')).toEqual({
    success: true, test_db_path: test, deleted_files: [test, `${test}-wal`, `${test}-shm`], message: '测试数据库已重置', active_database: 'test',
  });
  expect(mistakes.pluck("SELECT COUNT(1) FROM sqlite_master WHERE type = 'table' AND name = 'switch_probe'")).toBe(0);
  expect(await h.invoke('seed_test_database')).toEqual({
    success: true, mistakes_created: 0, messages_created: 0, errors: [], test_db_path: test,
  });

  expect(await h.invoke('switch_to_production_database')).toEqual({
    success: true, production_db_path: production, message: '已切换回生产数据库', active_database: 'production',
  });
  expect(appState.activeDatabase).toBe('production');
  expect(mistakes.pluck<number>("SELECT COUNT(1) FROM switch_probe WHERE value = 'production'")).toBe(1);
});

const rootIgnoresModes = process.getuid?.() === 0 || process.platform === 'win32';
it.skipIf(rootIgnoresModes)(
  'RF-W07-persistent-app-data-no-silent-relocation: test database commands fail on an unwritable active slot instead of relocating the file',
  async () => {
    const appState: { activeDatabase: 'production' | 'test' } = { activeDatabase: 'production' };
    const h = await start(() => {}, { appCommandState: appState });
    const slot = path.join(base, 'slots/slotA');
    const unusable = { error_type: 'FileSystem', message: expect.stringContaining(`持久数据目录不可用（目录不可写）: ${slot} (`) };
    fs.chmodSync(slot, 0o555);
    try {
      await expect(h.invoke('switch_to_test_database')).rejects.toMatchObject(unusable);
      await expect(h.invoke('reset_test_database')).rejects.toMatchObject(unusable);
      await expect(h.invoke('seed_test_database')).rejects.toMatchObject(unusable);
      expect(await h.invoke('get_database_info')).toMatchObject({ test_db_path: path.join(slot, 'test_mistakes.db'), test_db_exists: false });
    } finally {
      fs.chmodSync(slot, 0o755);
    }
    expect(appState.activeDatabase).toBe('production');
    expect(fs.existsSync(path.join(base, 'DeepStudent'))).toBe(false);
    expect(fs.existsSync(path.join(base, 'deep_student_data'))).toBe(false);
    expect(await h.invoke('switch_to_test_database')).toMatchObject({ test_db_path: path.join(slot, 'test_mistakes.db') });
  },
);

it('uses DS_MIGRATIONS_DIR when the profile does not set migrationsDir', async () => {
  const previous = process.env.DS_MIGRATIONS_DIR;
  // F2 sets this to the packaged `Resources/migrations`; an invalid value must fail
  // startup instead of silently reading the repository path.
  process.env.DS_MIGRATIONS_DIR = path.join(base, 'missing-migrations');
  try {
    await expect(start()).rejects.toThrow(/missing-migrations/);
  } finally {
    if (previous === undefined) delete process.env.DS_MIGRATIONS_DIR;
    else process.env.DS_MIGRATIONS_DIR = previous;
  }
});

it('official profile may omit storage config; explicit migrationsDir still wins over the environment', async () => {
  const previous = process.env.DS_MIGRATIONS_DIR;
  const boot = (config?: { migrationsDir: string; dataLocalDir: string }) => createTestHost({
    app: { dataDir: base },
    // The first install passes the actual bare plugin, as desktop.json does.
    plugins: config ? [secrets, [storage, config]] : [secrets, storage],
    provide: {
      paths: { os: { home: base, data: base, dataLocal: base, config: base, temp: base } },
      log: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
    },
  });
  try {
    process.env.DS_MIGRATIONS_DIR = DEFAULT_MIGRATIONS_DIR;
    host = await boot();
    expect(host.ctx.storage.migrations.currentVersion('mistakes')).toBeGreaterThan(20260130);
    expect(host.ctx.storage.locations.activeDir).toBe(path.join(base, 'slots/slotA'));
    await host.dispose(); host = undefined;
    process.env.DS_MIGRATIONS_DIR = path.join(base, 'missing-environment-migrations');
    host = await boot({ migrationsDir: DEFAULT_MIGRATIONS_DIR, dataLocalDir: base });
    expect(host.ctx.storage.migrations.currentVersion('mistakes')).toBeGreaterThan(20260130);
  } finally {
    if (previous === undefined) delete process.env.DS_MIGRATIONS_DIR;
    else process.env.DS_MIGRATIONS_DIR = previous;
  }
}, 60_000);
