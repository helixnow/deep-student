import './local-runtime-fixture.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import sync from '../index.ts';
import {
  applyPairingCode,
  createPairingCode,
  DEFAULT_PAIRING_TTL_MS,
  PAIRING_CODE_EXPIRED_CODE,
} from '../src/device-pairing.ts';
import { createTestHost } from './host-fixture.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { CloudStorageCredentials } from '../../../platform/secrets/api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { setLocalRuntime } from '../src/local-runtime.ts';
import { nodeLocalRuntime } from '../src/local-runtime.node.ts';

function memorySettings(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const secrets = new Map<string, string>();
  const isSecret = (key: string) =>
    key === 'api_configs' || key === 'cloud_storage_credentials' || key.endsWith('.api_key');
  for (const [k, v] of values) {
    if (isSecret(k)) {
      secrets.set(k, v);
      values.delete(k);
    }
  }
  const deleteSpy = vi.fn((key: string) => values.delete(key));
  const deleteSecretSpy = vi.fn(async (key: string) => secrets.delete(key));
  const store: SettingsStore = {
    get: (key) => values.get(key) ?? null,
    save: (key, value) => {
      values.set(key, value);
    },
    delete: deleteSpy,
    deleteByPrefix: () => 0,
    listByPrefix: (prefix) =>
      [...values]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => ({ key, value, updatedAt: '2026-01-01T00:00:00Z' })),
    getSecret: async (key) => (isSecret(key) ? secrets : values).get(key) ?? null,
    saveSecret: vi.fn(async (key, value) => {
      (isSecret(key) ? secrets : values).set(key, value);
    }),
    deleteSecret: deleteSecretSpy,
  };
  return { store, values, secrets, deleteSpy, deleteSecretSpy };
}

function memorySecretsService(initial: CloudStorageCredentials | null = null) {
  let stored: CloudStorageCredentials | null = initial ? { ...initial } : null;
  const openStore = () => ({
    getCloudCredentials: async () => (stored ? { ...stored } : null),
    saveCloudCredentials: async (creds: CloudStorageCredentials) => {
      stored = { ...creds };
    },
    deleteCloudCredentials: async () => {
      stored = null;
    },
  });
  return {
    service: { openStore },
    read: () => stored,
    set: (next: CloudStorageCredentials | null) => {
      stored = next ? { ...next } : null;
    },
  };
}

async function createLegacyDspair1WithoutExpiresAt(
  pin: string,
  settingsMap: Record<string, string>,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const payload = { version: 1, settings: settingsMap };
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      new TextEncoder().encode(JSON.stringify(payload)),
    ),
  );
  const bytes = new Uint8Array(28 + encrypted.length);
  bytes.set(salt);
  bytes.set(iv, 16);
  bytes.set(encrypted, 28);
  return `DSPAIR1:${btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')}`;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
  setLocalRuntime(nodeLocalRuntime);
});

describe('W3B-1 BUG-1/BUG-2: registered sync/pairing IPC commands & credential hygiene', () => {
  it('registers all 4 previously missing commands and exposes them in application-commands.toml ACL', async () => {
    const aclToml = readFileSync(
      resolve(process.cwd(), 'resources/app/permissions/application-commands.toml'),
      'utf-8',
    );
    const required = [
      'data_governance_pairing_get_cloud_credentials',
      'data_governance_pairing_save_cloud_credentials',
      'data_governance_get_pending_breakdown',
      'data_governance_get_conflict_previews',
    ];
    for (const cmd of required) {
      expect(aclToml).toContain(`"${cmd}"`);
      expect(sync.meta.commands).toContain(cmd);
    }

    const cfg = memorySettings({
      cloud_storage_credentials: JSON.stringify({ webdavPassword: 'stale-slot-password' }),
    });
    const memSecrets = memorySecretsService();
    const storageDir = mkdtempSync(join(tmpdir(), 'sync-pairing-ipc-'));
    const storage = createStorageService({
      baseDir: storageDir,
      dataLocalDir: storageDir,
    });
    cleanups.push(() => {
      storage.dispose();
      rmSync(storageDir, { recursive: true, force: true });
    });

    const fullHost = await createTestHost({
      plugins: [sync],
      provide: {
        settings: cfg.store,
        secrets: memSecrets.service,
        storage,
        paths: { deviceId: async () => 'test-device' },
      },
    });
    cleanups.push(() => fullHost.dispose());

    // 1. data_governance_pairing_get_cloud_credentials reads authoritative store (null), NEVER stale slotA secret
    await expect(
      fullHost.invoke('data_governance_pairing_get_cloud_credentials', {}),
    ).resolves.toBeNull();

    // 2. data_governance_pairing_save_cloud_credentials writes authoritative store & purges legacy slotA copy
    await expect(
      fullHost.invoke('data_governance_pairing_save_cloud_credentials', {
        credentials: {
          webdavPassword: 'fresh-dav-password',
          encryptionPassword: 'fresh-e2ee-password',
        },
      }),
    ).resolves.toBe(true);
    expect(memSecrets.read()).toEqual({
      webdavPassword: 'fresh-dav-password',
      encryptionPassword: 'fresh-e2ee-password',
    });
    expect(cfg.deleteSecretSpy).toHaveBeenCalledWith('cloud_storage_credentials');
    expect(cfg.secrets.has('cloud_storage_credentials')).toBe(false);

    const fetchedRaw = (await fullHost.invoke(
      'data_governance_pairing_get_cloud_credentials',
      {},
    )) as string;
    expect(JSON.parse(fetchedRaw)).toEqual({
      webdavPassword: 'fresh-dav-password',
      encryptionPassword: 'fresh-e2ee-password',
    });

    // Clearing via null deletes authoritative credentials so subsequent reads return null
    await expect(
      fullHost.invoke('data_governance_pairing_save_cloud_credentials', {
        credentials: null,
      }),
    ).resolves.toBe(true);
    await expect(
      fullHost.invoke('data_governance_pairing_get_cloud_credentials', {}),
    ).resolves.toBeNull();

    // 3. data_governance_get_pending_breakdown returns accurate per-table pending counts
    const vfsDb = storage.openFile(storage.pathOf('vfs'), { profile: 'plain' });
    try {
      vfsDb.exec(`
        CREATE TABLE __change_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          table_name TEXT NOT NULL,
          record_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          sync_version INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO __change_log (table_name, record_id, operation, sync_version) VALUES
          ('notes', 'n1', 'Insert', 0),
          ('notes', 'n2', 'Update', 0),
          ('resources', 'r1', 'Insert', 0),
          ('notes', 'n3', 'Update', 5);
        CREATE TABLE __sync_conflicts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          table_name TEXT NOT NULL,
          record_id TEXT NOT NULL,
          side TEXT NOT NULL,
          data_json TEXT NOT NULL,
          winning_device_id TEXT,
          losing_device_id TEXT,
          detected_at TEXT NOT NULL,
          resolved_at TEXT,
          resolution TEXT
        );
        CREATE TABLE notes (
          id TEXT PRIMARY KEY,
          title TEXT,
          resource_id TEXT
        );
        CREATE TABLE resources (
          id TEXT PRIMARY KEY,
          data TEXT,
          metadata_json TEXT
        );
        INSERT INTO resources (id, data, metadata_json) VALUES
          ('res-1', '# Physics Notes', '{"title":"Physics Doc"}'),
          ('res-2', 'Raw resource body', '{"name":"Geometry Sheet"}');
        INSERT INTO notes (id, title, resource_id) VALUES
          ('note-1', 'Physics Summary', 'res-1');
        INSERT INTO __sync_conflicts (table_name, record_id, side, data_json, detected_at) VALUES
          ('notes', 'note-1', 'local', '{"id":"note-1","title":"Physics Summary"}', '2026-06-01T10:00:00Z'),
          ('resources', 'res-2', 'local', '{"id":"res-2","data":"Raw resource body"}', '2026-06-01T10:01:00Z');
      `);
    } finally {
      storage.close(vfsDb);
    }

    const breakdown = await fullHost.invoke(
      'data_governance_get_pending_breakdown',
      {},
    );
    expect(breakdown).toEqual({
      total_pending_changes: 3,
      databases: [
        {
          id: 'vfs',
          pending_changes: 3,
          tables: [
            { table_name: 'notes', count: 2 },
            { table_name: 'resources', count: 1 },
          ],
        },
      ],
    });

    // 4. data_governance_get_conflict_previews enriches both vfs|notes and vfs|resources
    const previews = await fullHost.invoke(
      'data_governance_get_conflict_previews',
      { limit: 50, offset: 0 },
    );
    expect(previews).toEqual({
      'vfs|notes|note-1': {
        noteId: 'note-1',
        title: 'Physics Summary',
        content: '# Physics Notes',
        resourceId: 'res-1',
      },
      'vfs|resources|res-2': {
        resourceId: 'res-2',
        title: 'Geometry Sheet',
        content: 'Raw resource body',
      },
    });
  });

  it('SyncService.createPairingCode reads <appDataDir>/.secure/ instead of leaking stale slotA credentials', async () => {
    const cfg = memorySettings({
      'cloud_storage.config.safe_v1': JSON.stringify({
        provider: 'webdav',
        webdav: { endpoint: 'https://dav.example.test', username: 'alice' },
      }),
      cloud_storage_credentials: JSON.stringify({
        webdavPassword: 'stale-deleted-password',
        encryptionPassword: 'stale-disabled-e2ee',
      }),
    });
    const openStoreDirs: string[] = [];
    const memSecrets = memorySecretsService(null);
    const host = await createTestHost({
      plugins: [sync],
      provide: {
        settings: cfg.store,
        secrets: {
          openStore: (dir: string) => {
            openStoreDirs.push(dir);
            return memSecrets.service.openStore();
          },
        },
        storage: {},
        paths: { deviceId: async () => 'hygiene-device' },
      },
    });
    cleanups.push(() => host.dispose());

    // Authoritative <appDataDir>/.secure/ has no credentials -> QR code must NOT include stale slotA password.
    const created = await host.ctx.sync.createPairingCode({
      pin: '123456',
      includeCloudConfig: true,
      includeLlmKeys: false,
      includeSyncPrefs: false,
    });
    expect(openStoreDirs).toContain(host.app.dataDir);
    const target = memorySettings();
    await applyPairingCode(target.store, { pairingCode: created.pairingCode, pin: '123456' });
    expect(await target.store.getSecret('cloud_storage_credentials')).toBeNull();
  });
});

describe('W3B-1 BUG-5: DSPAIR1 TTL expiry & backward compatibility', () => {
  it('stamps default 15-minute expiresAt, allows apply before expiry, and rejects expired codes without writes', async () => {
    const source = memorySettings({ 'sync.include_skills': 'false' });
    const issuedAt = 1_750_000_000_000;
    const created = await createPairingCode(source.store, {
      pin: '246810',
      includeCloudConfig: false,
      includeLlmKeys: false,
      includeSyncPrefs: true,
      now: issuedAt,
    });
    expect(created.expiresAt).toBe(issuedAt + DEFAULT_PAIRING_TTL_MS);

    // Valid right before expiry
    const validTarget = memorySettings();
    const applied = await applyPairingCode(validTarget.store, {
      pairingCode: created.pairingCode,
      pin: '246810',
      now: issuedAt + DEFAULT_PAIRING_TTL_MS - 1,
    });
    expect(applied.expiresAt).toBe(issuedAt + DEFAULT_PAIRING_TTL_MS);
    expect(validTarget.store.get('sync.include_skills')).toBe('false');

    // Rejected at or after expiry with stable E_PAIRING_CODE_EXPIRED and zero writes
    const expiredTarget = memorySettings();
    let caught: (Error & { code?: string }) | null = null;
    try {
      await applyPairingCode(expiredTarget.store, {
        pairingCode: created.pairingCode,
        pin: '246810',
        now: issuedAt + DEFAULT_PAIRING_TTL_MS,
      });
    } catch (error) {
      caught = error as Error & { code?: string };
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.code).toBe(PAIRING_CODE_EXPIRED_CODE);
    expect(caught?.message).toContain(PAIRING_CODE_EXPIRED_CODE);
    expect(expiredTarget.store.saveSecret).not.toHaveBeenCalled();
    expect(expiredTarget.values.size).toBe(0);
  });

  it('gracefully accepts legacy DSPAIR1 payloads that omit expiresAt', async () => {
    const legacyCode = await createLegacyDspair1WithoutExpiresAt('135790', {
      'sync.include_skills': 'false',
      'sync.include_plugins': 'true',
    });
    const target = memorySettings();
    const result = await applyPairingCode(target.store, {
      pairingCode: legacyCode,
      pin: '135790',
      now: Date.now() + 365 * 24 * 60 * 60 * 1000,
    });
    expect(result.expiresAt).toBeUndefined();
    expect(result.summary).toMatchObject({ includeSkills: false, includePlugins: true });
    expect(target.store.get('sync.include_skills')).toBe('false');
  });

  it('rejects non-positive ttlMs on creation', async () => {
    await expect(
      createPairingCode(memorySettings().store, { pin: '123456', ttlMs: 0 }),
    ).rejects.toThrow();
    await expect(
      createPairingCode(memorySettings().store, { pin: '123456', ttlMs: -5_000 }),
    ).rejects.toThrow();
  });
});
