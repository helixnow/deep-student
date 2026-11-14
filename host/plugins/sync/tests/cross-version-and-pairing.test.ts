import './local-runtime-fixture.ts';
import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTestDatabase } from './test-db.ts';
import { applyDownloadedChanges } from '../repository/apply.ts';
import { getRecordData } from '../repository/record-data.ts';
import { rehydrateUnknownFieldsIfColumnsExist } from '../src/unknown-fields.ts';
import { createPairingCode, applyPairingCode } from '../src/device-pairing.ts';
import { scanAssets, assetLocalPath } from '../src/asset-paths.ts';
import { isSyncedAssetKey } from '../src/asset-filenames.ts';
import { isPortableAssetEnabled, supportsMobilePlugin } from '../src/portable-assets.ts';
import { SYNCABLE_SETTING_KEYS, isSyncableSettingKey } from '../src/classification-data/settings.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import type { EngineChange } from '../src/change-payload.ts';
import sync from '../index.ts';
import { createTestHost } from './host-fixture.ts';
import { setLocalRuntime } from '../src/local-runtime.ts';
import { nodeLocalRuntime } from '../src/local-runtime.node.ts';

function settings(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const secrets = new Map<string, string>();
  const secret = (key: string) => key === 'api_configs' || key === 'cloud_storage_credentials' || key.endsWith('.api_key');
  for (const [key, value] of values) if (secret(key)) { secrets.set(key, value); values.delete(key); }
  const store: SettingsStore = {
    get: key => values.get(key) ?? null,
    save: (key, value) => { values.set(key, value); },
    delete: key => values.delete(key), deleteByPrefix: () => 0,
    listByPrefix: prefix => [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value, updatedAt: '2026-01-01T00:00:00Z' })),
    getSecret: async key => (secret(key) ? secrets : values).get(key) ?? null,
    saveSecret: vi.fn(async (key, value) => { (secret(key) ? secrets : values).set(key, value); }),
    deleteSecret: async key => secrets.delete(key),
  };
  return { store, values, secrets };
}

describe('cross-version schema projection', () => {
  it('vaults future fields and deltas, preserves them through old-device edits, and rehydrates after upgrade', () => {
    const db = openTestDatabase();
    try {
      db.exec('CREATE TABLE test_records(id TEXT PRIMARY KEY, content TEXT)');
      const change: EngineChange = { table_name: 'test_records', record_id: 'r1', operation: 'Insert', data: { id: 'r1', content: 'remote', future_col_v99: 'future', other_future: { nested: 'value' }, __sync_field_deltas: { future_col_v99: { add: ['a'] } } },
        changed_at: '2026-01-01T00:00:00Z', database_name: null, change_log_id: null, suppress_change_log: null, source_device_id: 'new-device', source_seq: null };
      const context = { deviceId: 'old-device', allowSyncTestFixtureTables: true };
      expect(applyDownloadedChanges(db, [change], context).failure_count).toBe(0);
      expect(db.get('SELECT * FROM test_records')).toEqual({ id: 'r1', content: 'remote' });
      expect(JSON.parse(String(db.pluck('SELECT fields_json FROM __sync_unknown_fields')))).toMatchObject({ future_col_v99: 'future', other_future: { nested: 'value' } });
      const next = { ...change, operation: 'Update' as const, data: { id: 'r1', content: 'next', future_col_v99: 'future2' } };
      expect(applyDownloadedChanges(db, [next], context).failure_count).toBe(0);
      db.run("UPDATE test_records SET content='local edit' WHERE id='r1'");
      expect(getRecordData(db, 'test_records', 'r1', 'id')).toMatchObject({ content: 'local edit', future_col_v99: 'future2', other_future: { nested: 'value' } });
      db.exec('ALTER TABLE test_records ADD COLUMN future_col_v99 TEXT');
      rehydrateUnknownFieldsIfColumnsExist(db, 'test_records');
      expect(db.pluck('SELECT future_col_v99 FROM test_records')).toBe('future2');
      expect(JSON.parse(String(db.pluck('SELECT fields_json FROM __sync_unknown_fields')))).not.toHaveProperty('future_col_v99');
      expect(getRecordData(db, 'test_records', 'r1', 'id')).toHaveProperty('other_future');
    } finally { db.raw.close(); }
  });
});

describe('encrypted device pairing', () => {
  it('exposes encrypted pairing through the registered sync service', async () => {
    const configured = settings({ 'sync.include_skills': 'false' });
    const host = await createTestHost({ plugins: [sync], provide: {
      settings: configured.store, storage: {}, paths: { deviceId: async () => 'pairing-device' },
    } });
    try {
      const created = await host.ctx.sync.createPairingCode({
        pin: '123456', includeCloudConfig: false, includeLlmKeys: false, includeSyncPrefs: true,
      });
      configured.store.save('sync.include_skills', 'true');
      await host.ctx.sync.applyPairingCode({ pairingCode: created.pairingCode, pin: '123456' });
      expect(configured.store.get('sync.include_skills')).toBe('false');
    } finally { await host.dispose(); setLocalRuntime(nodeLocalRuntime); }
  });
  const data = {
    'cloud_storage.config.safe_v1': JSON.stringify({ provider: 'webdav', root: 'deep-student-sync', webdav: { endpoint: 'https://dav.example', username: 'alice' } }),
    cloud_storage_credentials: JSON.stringify({ webdavPassword: 'private-password', encryptionPassword: 'private-sync-pass' }),
    'cloud_sync.remote_path': '/student',
    api_configs: JSON.stringify([{ id: 'openai', apiKey: 'sk-private' }]),
    vendor_configs: JSON.stringify([{ id: 'builtin-deepseek' }]),
    'builtin-deepseek.api_key': 'private-builtin-key',
    'sync.include_skills': 'false', 'sync.include_plugins': 'true',
  };
  it('round-trips cloud SSOT + secure credentials, LLM configs/keys, and sync toggles', async () => {
    const source = settings(data), target = settings();
    const created = await createPairingCode(source.store, { pin: '123456', includeCloudConfig: true, includeLlmKeys: true, includeSyncPrefs: true });
    expect(created.pairingCode).toMatch(/^DSPAIR1:[A-Za-z0-9_-]+$/);
    expect(created.pairingCode).not.toContain('private');
    expect(created.summary).toEqual({ cloudProvider: 'webdav', llmProviders: 1, includeSkills: false, includePlugins: true });
    expect((await applyPairingCode(target.store, { pairingCode: created.pairingCode, pin: '123456' })).summary).toEqual(created.summary);
    for (const [key, value] of Object.entries(data)) expect(await target.store.getSecret(key)).toBe(value);
    expect(target.values.has('cloud_storage_credentials')).toBe(false);
    expect(target.values.has('api_configs')).toBe(false);
  });
  it('rejects wrong PIN, modified code, unsupported format, and invalid PIN without writes', async () => {
    const created = await createPairingCode(settings(data).store, { pin: '123456' });
    const target = settings();
    await expect(applyPairingCode(target.store, { pairingCode: created.pairingCode, pin: '654321' })).rejects.toThrow('PIN');
    await expect(applyPairingCode(target.store, { pairingCode: `${created.pairingCode.slice(0, -10)}AAAAAAAAAA`, pin: '123456' })).rejects.toThrow();
    await expect(applyPairingCode(target.store, { pairingCode: 'DSPAIR2:abc', pin: '123456' })).rejects.toThrow('格式');
    await expect(createPairingCode(settings().store, { pin: '123' })).rejects.toThrow('6 位');
    expect(target.store.saveSecret).not.toHaveBeenCalled();
    expect(target.values.size).toBe(0);
  });
  it('round-trips through asynchronous frontend-compatible settings operations', async () => {
    const source = settings(data), target = settings();
    const asyncStore = (store: SettingsStore) => ({
      get: async (key: string) => store.get(key),
      listByPrefix: async (prefix: string) => store.listByPrefix(prefix),
      save: async (key: string, value: string) => store.save(key, value),
      getSecret: store.getSecret,
      saveSecret: store.saveSecret,
    });
    const created = await createPairingCode(asyncStore(source.store), { pin: '123456', includeLlmKeys: true });
    await applyPairingCode(asyncStore(target.store), { pairingCode: created.pairingCode, pin: '123456' });
    for (const [key, value] of Object.entries(data)) expect(await target.store.getSecret(key)).toBe(value);
  });
  it('honors excluded categories and defaults missing sync toggles to enabled', async () => {
    const target = settings();
    const created = await createPairingCode(settings(data).store, { pin: '000001', includeCloudConfig: false, includeLlmKeys: false, includeSyncPrefs: true });
    await applyPairingCode(target.store, { pairingCode: created.pairingCode, pin: '000001' });
    expect([...target.values.keys()].sort()).toEqual(['sync.include_plugins', 'sync.include_skills']);
    expect((await createPairingCode(settings().store, { pin: '000001' })).summary).toMatchObject({ includeSkills: true, includePlugins: true });
  });
});

describe('portable asset and preference classification', () => {
  it('maps canonical skill keys to .skills and plugin lock to the root, without allowing database paths', () => {
    expect(isSyncedAssetKey('app_data/skills/example/SKILL.md')).toBe(true);
    expect(assetLocalPath('/active', '/app', 'app_data/skills/example/SKILL.md')).toBe('/app/.skills/example/SKILL.md');
    expect(assetLocalPath('/active', '/app', 'app_data/plugins/demo/manifest.json')).toBe('/app/plugins/demo/manifest.json');
    expect(assetLocalPath('/active', '/app', 'app_data/plugins/plugins-lock.json')).toBe('/app/plugins-lock.json');
    expect(assetLocalPath('/active', '/app', 'app_data/databases/vfs.db')).toBeNull();
    expect(assetLocalPath('/active', '/app', 'app_data/skills/../../settings')).toBeNull();
  });
  it('scans skill packages and plugins, respects opt-outs, excludes native binaries and local trust', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sync-portable-'));
    try {
      for (const file of ['.skills/demo/SKILL.md', '.skills/demo/package.json', 'plugins/demo/manifest.json', 'plugins/demo/index.js', 'plugins/demo/native.node', 'plugins/community-consent.json', 'plugins-lock.json']) {
        mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), '{}');
      }
      const [files] = await scanAssets(root, root);
      expect([...files.keys()]).toEqual(expect.arrayContaining(['app_data/skills/demo/SKILL.md', 'app_data/skills/demo/package.json', 'app_data/plugins/demo/index.js', 'app_data/plugins/plugins-lock.json']));
      expect([...files.keys()].some(key => key.endsWith('.node') || key.includes('community-consent'))).toBe(false);
      expect((await scanAssets(root, root, { includeSkills: false, includePlugins: false }))[0].size).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('requires explicit mobile support and skips native plugins / local consent', () => {
    expect(supportsMobilePlugin({ platforms: ['desktop'] })).toBe(false);
    expect(supportsMobilePlugin({ platforms: ['mobile'], native: true })).toBe(false);
    expect(supportsMobilePlugin({ platforms: ['desktop', 'mobile'] })).toBe(true);
    expect(isPortableAssetEnabled('app_data/plugins/a/index.js', { includePlugins: false })).toBe(false);
    expect(isPortableAssetEnabled('app_data/skills/a/SKILL.md', { includeSkills: false })).toBe(false);
    expect(isPortableAssetEnabled('app_data/plugins/user.profile.json')).toBe(false);
    for (const key of SYNCABLE_SETTING_KEYS) expect(isSyncableSettingKey(key)).toBe(true);
    expect(isSyncableSettingKey('api_configs')).toBe(false);
    expect(isSyncableSettingKey('unknown.future.preference')).toBe(false);
  });
});
