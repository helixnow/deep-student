/**
 * `src-tauri/src/data_governance/commands_backup.rs::tests` 中 5 条同步应用/库路由测试。
 *
 * D7 裁定多库应用归 L20：本文件经 `ctx.get('sync')` 按需消费 L20 已发布的
 * `applyDownloadedChangesToDatabases`，不硬 inject、不复制 `repository/apply-databases.ts`。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import { Connection } from '../../../platform/storage/connection.ts';
import { PROFILES } from '../../../platform/storage/profiles.ts';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import syncPlugin from '../../sync/index.ts';
import type { EngineChange, SyncService } from '../../sync/api.ts';

const hosts: TestHost[] = [];
const storages: StorageServiceImpl[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const storage of storages.splice(0)) storage.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface SyncEnv {
  host: TestHost;
  storage: StorageServiceImpl;
  sync: SyncService;
  activeDir: string;
}

async function setupSyncEnv(): Promise<SyncEnv> {
  const root = mkdtempSync(join(tmpdir(), 'l21-commands-backup-sync-'));
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  mkdirSync(storage.locations.activeDir, { recursive: true });
  storages.push(storage);
  roots.push(root);
  const host = await createTestHost({
    app: { dataDir: root },
    provide: {
      storage,
      paths: { deviceId: async () => 'local-device' },
      notes: {},
      backup: {},
      syncProvider: {},
      secrets: {},
      vfsDatabase: { isInMaintenanceMode: () => false },
      syncSupport: { state: { setCursor() {} } },
      nativeCompression: {},
      vfsRepo: {
        pomodoros: { recomputeCompletedPomodorosForSyncBatch: () => 0 },
      },
      mastery: {
        recomputeAllStatesWithConn: () => 0,
        syncAllLearnerProfiles: () => 0,
      },
    },
    plugins: [syncPlugin],
  });
  hosts.push(host);
  const sync = host.ctx.get('sync') as SyncService | undefined;
  if (sync === undefined) throw new Error('L20 sync service was not published');
  return { host, storage, sync, activeDir: storage.locations.activeDir };
}

function createDatabase(path: string, sql: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const conn = new Connection(path, { label: 'commands-backup-sync-fixture', profile: PROFILES.plain });
  try { conn.exec(sql); } finally { conn.close(); }
}

function query<T>(path: string, sql: string): T | undefined {
  const conn = new Connection(path, { label: 'commands-backup-sync-query', profile: PROFILES.plain, mustExist: true });
  try { return conn.pluck<T>(sql); } finally { conn.close(); }
}

const CHAT_V2_SCHEMA = `
CREATE TABLE chat_v2_sessions (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'chat',
  title TEXT,
  persist_status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  device_id TEXT,
  local_version INTEGER DEFAULT 0,
  sync_version INTEGER DEFAULT 0,
  deleted_at TEXT
);
CREATE TABLE __change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  sync_version INTEGER DEFAULT 0,
  field_deltas_json TEXT
);`;

function routingTestChange(databaseName: string): EngineChange {
  return {
    change_log_id: null,
    table_name: 'notes',
    record_id: 'note-routing',
    operation: 'Insert',
    changed_at: '2026-07-10T12:00:00Z',
    data: {
      id: 'note-routing',
      title: 'routing',
      updated_at: '2026-07-10T12:00:00Z',
    },
    database_name: databaseName,
    suppress_change_log: true,
    source_device_id: 'remote-device',
    source_seq: 1,
  };
}

it('open_sync_connection_sets_busy_timeout', async () => {
  const env = await setupSyncEnv();
  const path = env.storage.pathOf('vfs');
  createDatabase(path, `
    CREATE TABLE todo_items (
      id TEXT PRIMARY KEY, title TEXT, updated_at TEXT, deleted_at TEXT,
      local_version INTEGER DEFAULT 0
    );
    CREATE TABLE __change_log (
      id INTEGER PRIMARY KEY, table_name TEXT, record_id TEXT, operation TEXT,
      changed_at TEXT, sync_version INTEGER DEFAULT 0
    );`);

  const original = env.storage.openFile.bind(env.storage);
  const timeouts: number[] = [];
  env.storage.openFile = (filePath, options) => {
    const handle = original(filePath, options);
    timeouts.push(Number(handle.pluck('PRAGMA busy_timeout')));
    return handle;
  };

  const result = await env.sync.applyDownloadedChangesToDatabases([
    {
      database_name: 'vfs',
      table_name: 'todo_items',
      record_id: 'a',
      operation: 'Insert',
      data: { id: 'a', title: 'remote', updated_at: '2026-01-01T00:00:00Z' },
      changed_at: '2026-01-01T00:00:00Z',
      source_device_id: 'peer',
    },
  ], 'UseCloud');

  expect(result).toMatchObject({ total_success: 1, total_failed: 0, total_conflicts: 0 });
  expect(timeouts).toEqual([5000]);
  expect(query<string>(path, "SELECT title FROM todo_items WHERE id='a'")).toBe('remote');
});

it('missing_target_database_rejects_package_before_cursor_ack', async () => {
  const env = await setupSyncEnv();
  await expect(env.sync.applyDownloadedChangesToDatabases(
    [routingTestChange('vfs')],
    'KeepLatest',
  )).rejects.toThrow('目标数据库文件不存在');
});

it('unknown_target_database_rejects_package_before_cursor_ack', async () => {
  const env = await setupSyncEnv();
  await expect(env.sync.applyDownloadedChangesToDatabases(
    [routingTestChange('unknown_database')],
    'KeepLatest',
  )).rejects.toThrow('未知数据库名称');
});

it('keep_latest_local_newer_conflict_still_falls_into_conflict_table', async () => {
  const env = await setupSyncEnv();
  const path = env.storage.pathOf('chat_v2');
  createDatabase(path, CHAT_V2_SCHEMA);
  const conn = new Connection(path, { label: 'keep-latest-fixture', profile: PROFILES.plain });
  try {
    conn.exec(`
      INSERT INTO chat_v2_sessions
        (id, mode, title, persist_status, created_at, updated_at, device_id)
        VALUES ('sess_conflict', 'chat', 'local-newer', 'active',
                '2026-05-31T10:00:00Z', '2026-05-31T12:00:00Z', 'local-device');
      INSERT INTO __change_log
        (table_name, record_id, operation, changed_at, sync_version)
        VALUES ('chat_v2_sessions', 'sess_conflict', 'UPDATE', '2026-05-31T12:00:00Z', 0);
    `);
  } finally { conn.close(); }

  const cloudChange: EngineChange = {
    change_log_id: null,
    table_name: 'chat_v2_sessions',
    record_id: 'sess_conflict',
    operation: 'Update',
    changed_at: '2026-05-31T11:00:00Z',
    data: {
      id: 'sess_conflict',
      mode: 'chat',
      title: 'cloud-older',
      persist_status: 'active',
      created_at: '2026-05-31T10:00:00Z',
      updated_at: '2026-05-31T11:00:00Z',
      device_id: 'cloud-device',
      deleted_at: null,
    },
    database_name: 'chat_v2',
    suppress_change_log: null,
    source_device_id: null,
    source_seq: null,
  };

  const agg = await env.sync.applyDownloadedChangesToDatabases([cloudChange], 'KeepLatest');

  expect(agg.total_conflicts).toBeGreaterThanOrEqual(2);
  expect(query<string>(path, "SELECT title FROM chat_v2_sessions WHERE id='sess_conflict'"))
    .toBe('local-newer');
  const unresolved = Number(query<number>(
    path,
    'SELECT COUNT(*) FROM __sync_conflicts WHERE resolved_at IS NULL',
  ) ?? 0);
  expect(unresolved).toBe(agg.total_conflicts);
});

it('keep_local_preserves_existing_non_conflicting_local_record', async () => {
  const env = await setupSyncEnv();
  const path = env.storage.pathOf('chat_v2');
  createDatabase(path, CHAT_V2_SCHEMA);
  const conn = new Connection(path, { label: 'keep-local-fixture', profile: PROFILES.plain });
  try {
    conn.exec(`
      INSERT INTO chat_v2_sessions
        (id, mode, title, persist_status, created_at, updated_at, device_id)
        VALUES ('sess_keep_local', 'chat', 'local-existing', 'active',
                '2026-05-31T10:00:00Z', '2026-05-31T10:00:00Z', 'local-device');
      INSERT INTO __change_log
        (table_name, record_id, operation, changed_at, sync_version)
        VALUES ('chat_v2_sessions', 'sess_keep_local', 'INSERT', '2026-05-31T10:00:00Z', 123);
    `);
  } finally { conn.close(); }

  const cloudChange: EngineChange = {
    change_log_id: null,
    table_name: 'chat_v2_sessions',
    record_id: 'sess_keep_local',
    operation: 'Update',
    changed_at: '2026-05-31T12:00:00Z',
    data: {
      id: 'sess_keep_local',
      mode: 'chat',
      title: 'cloud-newer',
      persist_status: 'active',
      created_at: '2026-05-31T10:00:00Z',
      updated_at: '2026-05-31T12:00:00Z',
      device_id: 'cloud-device',
      deleted_at: null,
    },
    database_name: 'chat_v2',
    suppress_change_log: null,
    source_device_id: null,
    source_seq: null,
  };

  const agg = await env.sync.applyDownloadedChangesToDatabases([cloudChange], 'KeepLocal');

  expect(agg.total_success).toBe(0);
  expect(agg.total_conflicts).toBe(0);
  expect(query<string>(path, "SELECT title FROM chat_v2_sessions WHERE id='sess_keep_local'"))
    .toBe('local-existing');
});
