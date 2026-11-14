/**
 * storage 插件的 `dirs::data_local_dir()` 取自 `ctx.paths.os.dataLocal`（外壳设置 `DS_APP_DATA_DIR`
 * 时已隔离），不再按进程 `$HOME` / `$XDG_DATA_HOME` / `%LOCALAPPDATA%` 自行推导；
 * 打开 `sync_state` 不得在"真实用户目录"下建任何文件。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import secrets from '../../secrets/index.ts';
import storage from '../index.ts';

let base: string;
let host: Awaited<ReturnType<typeof createTestHost>> | undefined;
beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-data-local-isolation-')); });
afterEach(async () => {
  await host?.dispose();
  host = undefined;
  vi.unstubAllEnvs();
  fs.rmSync(base, { recursive: true, force: true });
  await setImmediate();
});

it('storage resolves sync_state under ctx.paths.os.dataLocal and never under process $HOME / XDG / LOCALAPPDATA', async () => {
  const realHome = path.join(base, 'real-home');
  fs.mkdirSync(realHome, { recursive: true });
  vi.stubEnv('HOME', realHome);
  vi.stubEnv('USERPROFILE', realHome);
  vi.stubEnv('XDG_DATA_HOME', path.join(realHome, '.local', 'share'));
  vi.stubEnv('LOCALAPPDATA', path.join(realHome, 'AppData', 'Local'));
  const isolatedLocal = path.join(base, 'isolated', 'data-local');
  const appData = path.join(base, 'app');

  host = await createTestHost({
    app: { dataDir: appData },
    plugins: [secrets, storage],
    provide: {
      paths: { os: { home: path.join(base, 'isolated'), data: isolatedLocal, dataLocal: isolatedLocal, config: isolatedLocal, temp: base } },
      log: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
      storageStartupSync: { resetDefaultAfterLocalPurge() {} },
    },
    shell: () => null,
  });
  const syncState = path.join(isolatedLocal, 'deep-student', 'sync', 'sync_state.db');
  expect(host.ctx.storage.locations.dataLocalDir).toBe(isolatedLocal);
  expect(host.ctx.storage.pathOf('sync_state')).toBe(syncState);
  host.ctx.storage.database('sync_state').exec('CREATE TABLE IF NOT EXISTS probe (id INTEGER)');
  expect(fs.existsSync(syncState)).toBe(true);
  expect(fs.readdirSync(realHome)).toEqual([]);
});
