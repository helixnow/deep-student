/**
 * `dstu-storage/src/database/mod.rs` 的 `save_secret` / `get_secret` / `delete_secret` 语义。
 *
 * 这些方法在 Host 架构中由 F4 的 settings store 实现（`host/platform/settings/index.ts`），
 * 存储层只提供 `settings` 表与 `SecureStore`。本文件用真实 F3 库句柄 + 真实 F4 实现验证
 * 敏感键的 fail-closed、旧明文迁移、补偿与删除顺序，测试名保持 Rust 原函数名。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSettingsStore } from '../../settings/index.ts';
import { createSecretsService } from '../../secrets/index.ts';
import type { Logger } from '../../log/api.ts';
import { resolveOsDirs } from '../../paths/index.ts';
import { createStorageService, type StorageService } from '../service.ts';

const silent: Logger = { target: 'storage-secrets', error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const secrets = createSecretsService({
  os: resolveOsDirs(process.platform === 'darwin' ? 'darwin' : 'linux', process.env),
  log: silent,
  keystore: null,
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Env {
  dir: string;
  storage: StorageService;
  secure: ReturnType<typeof secrets.openStore>;
  store: ReturnType<typeof createSettingsStore>;
}

function setup(blockSecureDir = false): Env {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f3-secrets-'));
  dirs.push(dir);
  if (blockSecureDir) fs.writeFileSync(path.join(dir, '.secure'), 'blocks secure directory creation');
  const storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
  const db = storage.database('mistakes');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
  const secure = secrets.openStore(dir);
  let tick = 0;
  const store = createSettingsStore({
    db: () => db,
    secureStore: () => secure,
    isSensitiveKey: secrets.isSensitiveKey,
    now: () => `2026-11-03T00:00:0${tick++}+00:00`,
  });
  return { dir, storage, secure, store };
}

describe('dstu-storage database secrets', () => {
  it('sensitive_secret_secure_write_failure_does_not_write_plaintext', async () => {
    const { store } = setup(true);
    const key = 'write-failure.api_key';

    await expect(store.saveSecret(key, 'must-not-reach-sqlite')).rejects.toThrow('拒绝以明文保存');
    expect(store.get(key)).toBeNull();

    store.save(key, 'pre-existing-legacy-value');
    await expect(store.getSecret(key)).rejects.toThrow('拒绝回退到数据库明文');
    expect(store.get(key)).toBe('pre-existing-legacy-value');
  });

  it('sensitive_secret_db_delete_failure_is_reported_and_secure_write_is_rolled_back', async () => {
    const { secure, store, storage } = setup();
    const key = 'delete-failure.api_key';
    store.save(key, 'legacy-plaintext');
    storage.database('mistakes').exec(
      `CREATE TRIGGER reject_legacy_secret_delete
       BEFORE DELETE ON settings
       WHEN OLD.key = 'delete-failure.api_key'
       BEGIN
         SELECT RAISE(FAIL, 'forced legacy delete failure');
       END;`,
    );

    await expect(store.saveSecret(key, 'new-secure-value')).rejects.toThrow('清理数据库中的旧明文失败');
    expect(store.get(key)).toBe('legacy-plaintext');
    expect(await secure.getSecret(key)).toBeNull();
  });

  it('sensitive_secret_success_removes_legacy_plaintext_row', async () => {
    const { store } = setup();
    const key = 'migration-success.api_key';
    store.save(key, 'legacy-plaintext');

    await store.saveSecret(key, 'encrypted-value');

    expect(store.get(key)).toBeNull();
    expect(await store.getSecret(key)).toBe('encrypted-value');
  });

  it('sensitive_secret_read_migrates_legacy_plaintext_row', async () => {
    const { store } = setup();
    const key = 'read-migration.api_key';
    store.save(key, 'legacy-plaintext');

    expect(await store.getSecret(key)).toBe('legacy-plaintext');
    expect(store.get(key)).toBeNull();
    expect(await store.getSecret(key)).toBe('legacy-plaintext');
  });

  it('sensitive_secret_delete_cleans_legacy_row_even_when_secure_store_fails', async () => {
    const { store } = setup(true);
    const key = 'delete-cleanup.api_key';
    store.save(key, 'legacy-plaintext');

    await expect(store.deleteSecret(key)).rejects.toThrow('数据库明文已清理');
    expect(store.get(key)).toBeNull();
  });
});
