import './local-runtime-fixture.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorageService } from '../../../platform/storage/service.ts';
import { getLastSyncedChangeAt } from '../repository/change-log.ts';
import { getPendingBreakdown, getSyncStatus } from '../src/status.ts';
import { retryRemote } from '../src/remote-retry.ts';
import { applyPairingCode, createPairingCode } from '../src/device-pairing.ts';
import { applyDownloadedChangesToDatabases } from '../repository/apply-databases.ts';
import { resolveRecordConflict } from '../src/conflict-commands.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import type { SyncLogger } from '../src/log.ts';
import { openTestDatabase, type TestDatabase } from './test-db.ts';

const noopLogger: SyncLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

const opened: TestDatabase[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.raw.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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
  const store: SettingsStore = {
    get: (k) => values.get(k) ?? null,
    save: (k, v) => { values.set(k, v); },
    delete: (k) => values.delete(k),
    deleteByPrefix: () => 0,
    listByPrefix: (prefix) =>
      [...values]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => ({ key, value, updatedAt: '2026-11-24T00:00:00Z' })),
    getSecret: async (k) => (isSecret(k) ? secrets : values).get(k) ?? null,
    saveSecret: async (k, v) => { (isSecret(k) ? secrets : values).set(k, v); },
    deleteSecret: async (k) => secrets.delete(k),
  };
  return { store, values, secrets };
}

describe('Stage 5 R2-C host sync regressions', () => {
  it('converts epoch sync_version to UTC ISO in getLastSyncedChangeAt and computes getPendingBreakdown per table offline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-r2c-status-'));
    dirs.push(dir);
    const storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
    try {
      const vfs = storage.database('vfs');
      vfs.exec(`CREATE TABLE __change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        changed_at TEXT NOT NULL DEFAULT (datetime('now')),
        sync_version INTEGER DEFAULT 0
      );`);
      vfs.run(
        `INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version) VALUES
          ('notes', 'n1', 'INSERT', '2024-11-24 10:00:00', 1732443600),
          ('notes', 'n2', 'UPDATE', '2024-11-24 10:05:00', 0),
          ('resources', 'r2', 'UPDATE', '2024-11-24 10:05:00', 0)`,
      );

      expect(getLastSyncedChangeAt(vfs)).toBe(new Date(1732443600 * 1000).toISOString());

      const status = await getSyncStatus(
        storage,
        { deviceId: async () => 'dev-1' } as never,
        noopLogger,
        '2026-11-24T12:00:00.000Z',
      );
      expect(status.last_sync_at).toBe('2026-11-24T12:00:00.000Z');
      expect(status.total_pending_changes).toBe(2);
      expect(status.total_synced_changes).toBe(1);

      const breakdown = getPendingBreakdown(storage);
      expect(breakdown.total_pending_changes).toBe(2);
      expect(breakdown.databases).toEqual([
        {
          id: 'vfs',
          pending_changes: 2,
          tables: [
            { table_name: 'notes', count: 1 },
            { table_name: 'resources', count: 1 },
          ],
        },
      ]);
    } finally {
      storage.dispose();
    }
  });

  it('accepts DSPAIR1 codes with whitespace/newlines, padded/unpadded base64url, and pinned trimming', async () => {
    const source = memorySettings({
      'cloud_storage.config.safe_v1': JSON.stringify({
        provider: 'webdav',
        root: 'sync',
        webdav: { endpoint: 'https://dav.example.com/dav', username: 'alice' },
      }),
      cloud_storage_credentials: JSON.stringify({ webdavPassword: 'dav-secret-password' }),
    });
    const created = await createPairingCode(source.store, {
      pin: ' 482910 ',
      includeCloudConfig: true,
      includeLlmKeys: false,
      includeSyncPrefs: true,
    });
    const rawBody = created.pairingCode.slice('DSPAIR1:'.length).replace(/-/g, '+').replace(/_/g, '/');
    const padded = rawBody.padEnd(rawBody.length + ((4 - (rawBody.length % 4)) % 4), '=');
    const wrapped = `  DSPAIR1:\n${padded.slice(0, 12)}\u200B \n ${padded.slice(12)}  `;

    const target = memorySettings();
    const applied = await applyPairingCode(target.store, {
      pairingCode: wrapped,
      pin: ' 482910\n',
    });
    expect(applied.summary.cloudProvider).toBe('webdav');
    expect(JSON.parse((await target.store.getSecret('cloud_storage_credentials'))!)).toEqual({
      webdavPassword: 'dav-secret-password',
    });
  });

  it('retryRemote fails fast on inner retried/HTTP 503/401/403 errors without outer loop oscillation', async () => {
    const action = vi.fn(async () => {
      throw new Error('WebDAV PROPFIND failed (retried 3 times): HTTP 503 Service Unavailable');
    });
    await expect(retryRemote('fetch', 3, action, noopLogger)).rejects.toThrow('HTTP 503');
    expect(action).toHaveBeenCalledTimes(1);

    const authAction = vi.fn(async () => {
      throw new Error('WebDAV GET failed: HTTP 401 Unauthorized');
    });
    await expect(retryRemote('auth', 3, authAction, noopLogger)).rejects.toThrow('HTTP 401');
    expect(authAction).toHaveBeenCalledTimes(1);
  });

  it('defers conflicting local row overwrites until user resolution and supports lease-guarded conflict resolve', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-r2c-conflict-'));
    dirs.push(dir);
    const storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
    try {
      const vfs = storage.database('vfs');
      vfs.exec(`
        CREATE TABLE resources (id TEXT PRIMARY KEY, type TEXT, data TEXT, mime_type TEXT, updated_at TEXT);
        CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT, resource_id TEXT, updated_at TEXT, deleted_at TEXT);
        CREATE TABLE note_editor_leases (token TEXT PRIMARY KEY, operation_id TEXT, owner_id TEXT, phase TEXT, expires_at INTEGER);
        CREATE TABLE note_editor_lease_notes (note_id TEXT NOT NULL, token TEXT NOT NULL);
        CREATE TABLE note_editor_write_grants (token TEXT PRIMARY KEY);
        CREATE TABLE __change_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          table_name TEXT NOT NULL,
          record_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          changed_at TEXT NOT NULL DEFAULT (datetime('now')),
          sync_version INTEGER DEFAULT 0
        );
        CREATE TABLE __sync_conflicts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          table_name TEXT NOT NULL,
          record_id TEXT NOT NULL,
          side TEXT NOT NULL,
          data_json TEXT NOT NULL,
          winning_device_id TEXT,
          losing_device_id TEXT,
          detected_at TEXT NOT NULL DEFAULT (datetime('now')),
          resolved_at TEXT,
          resolution TEXT
        );
        INSERT INTO resources VALUES ('res-1', 'markdown', 'Local Draft Body', 'text/markdown', '2026-11-24T10:00:00Z');
        INSERT INTO notes VALUES ('note-1', 'Local Note', 'res-1', '2026-11-24T10:00:00Z', NULL);
        INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version)
          VALUES ('notes', 'note-1', 'UPDATE', '2026-11-24T10:00:00Z', 0);
        INSERT INTO note_editor_leases VALUES ('l1', 'op1', 'editor-1', 'ready', 9999999999);
        INSERT INTO note_editor_lease_notes VALUES ('note-1', 'l1');
      `);

      const deferred: string[] = [];
      const result = await applyDownloadedChangesToDatabases(
        storage,
        [
          {
            database_name: 'vfs',
            table_name: 'notes',
            record_id: 'note-1',
            operation: 'Update',
            data: { id: 'note-1', title: 'Cloud Newer Note', resource_id: 'res-1', updated_at: '2026-11-24T12:00:00Z' },
            changed_at: '2026-11-24T12:00:00Z',
            source_device_id: 'dev-a',
            source_seq: 1,
          },
        ],
        'KeepLatest',
        'dev-b',
        { recomputeAllStatesWithConn: () => 0, syncAllLearnerProfiles: () => 0 },
        noopLogger,
        {
          deferConflictingOverwrite: true,
          onDeferredConflict: (key: string) => {
            deferred.push(key);
          },
        },
      );

      expect(deferred).toHaveLength(1);
      expect(deferred[0]).toContain('notes\u001fnote-1');
      expect(result.total_conflicts).toBeGreaterThanOrEqual(1);
      // Local User B title MUST NOT be overwritten before explicit user resolution
      expect(vfs.get<{ title: string }>('SELECT title FROM notes WHERE id = ?', ['note-1'])?.title).toBe('Local Note');
      expect(vfs.all('SELECT side FROM __sync_conflicts WHERE record_id = ? ORDER BY side', ['note-1'])).toHaveLength(2);

      // User resolves via keep_cloud cleanly even while note_editor_lease_notes exists
      const conflictIds = vfs
        .all<{ id: number | bigint }>('SELECT id FROM __sync_conflicts WHERE record_id = ?', ['note-1'])
        .map((r) => Number(r.id));
      resolveRecordConflict(storage, 'vfs', 'notes', 'note-1', 'keep_cloud', null, conflictIds);
      expect(vfs.get<{ title: string }>('SELECT title FROM notes WHERE id = ?', ['note-1'])?.title).toBe('Cloud Newer Note');
    } finally {
      storage.dispose();
    }
  });
});
