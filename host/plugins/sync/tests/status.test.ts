import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorageService } from '../../../platform/storage/service.ts';
import { getPendingBreakdown } from '../src/status.ts';
import { createTestHost } from './host-fixture.ts';
import sync from '../index.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sync-status-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
});
afterEach(() => {
  storage.dispose();
  rmSync(root, { recursive: true, force: true });
});

const defaultRowSyncTable: Record<'vfs' | 'chat_v2' | 'mistakes' | 'llm_usage', string> = {
  vfs: 'notes',
  chat_v2: 'chat_v2_messages',
  mistakes: 'mistakes',
  llm_usage: 'llm_usage_logs',
};

function changeLog(
  dbName: 'vfs' | 'chat_v2' | 'mistakes' | 'llm_usage',
  rows: Array<[string, number, string?]>,
): void {
  const db = storage.database(dbName);
  db.exec(`CREATE TABLE IF NOT EXISTS __change_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    changed_at TEXT NOT NULL DEFAULT (datetime('now')),
    sync_version INTEGER DEFAULT 0
  );`);
  for (const [changedAt, version, tableName] of rows) {
    db.run(
      'INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version) VALUES (?1, ?2, ?3, ?4, ?5)',
      [tableName ?? defaultRowSyncTable[dbName], `rec-${changedAt}-${tableName ?? 'default'}`, 'INSERT', changedAt, version],
    );
  }
}

async function hostWithPaths() {
  return createTestHost({
    plugins: [sync],
    provide: {
      storage,
      paths: { deviceId: async () => 'device-status-test' },
    },
  });
}

it('get_sync_status aggregates ordered databases and last sync time', async () => {
  changeLog('vfs', [['2024-01-01T00:00:00Z', 0], ['2024-01-02T00:00:00Z', 10]]);
  changeLog('chat_v2', [['2024-01-03T00:00:00Z', 0]]);
  changeLog('mistakes', [['2024-01-04T00:00:00Z', 20]]);
  const host = await hostWithPaths();
  try {
    expect(await host.invoke('data_governance_get_sync_status')).toEqual({
      partial: false,
      errors: [],
      has_pending_changes: true,
      total_pending_changes: 2,
      total_synced_changes: 2,
      databases: [
        {
          id: 'vfs', knowledge: 'known', error: null, has_change_log: true,
          pending_changes: 1, synced_changes: 1, last_sync_at: '2024-01-02T00:00:00Z',
        },
        {
          id: 'chat_v2', knowledge: 'known', error: null, has_change_log: true,
          pending_changes: 1, synced_changes: 0, last_sync_at: null,
        },
        {
          id: 'mistakes', knowledge: 'known', error: null, has_change_log: true,
          pending_changes: 0, synced_changes: 1, last_sync_at: '2024-01-04T00:00:00Z',
        },
      ],
      last_sync_at: '2024-01-04T00:00:00Z',
      device_id: 'device-status-test',
    });
  } finally {
    await host.dispose();
  }
});

it('get_sync_status omits absent database files and marks missing change log as known-empty', async () => {
  storage.database('vfs');
  storage.database('chat_v2').exec('CREATE TABLE notes (id TEXT PRIMARY KEY)');
  const host = await hostWithPaths();
  try {
    const result = await host.invoke<{
      partial: boolean;
      total_pending_changes: number;
      databases: Array<{ id: string; knowledge: string; has_change_log: boolean }>;
    }>('data_governance_get_sync_status');
    expect(result.partial).toBe(false);
    expect(result.total_pending_changes).toBe(0);
    expect(result.databases).toEqual([
      { id: 'vfs', knowledge: 'known', error: null, has_change_log: false, pending_changes: 0, synced_changes: 0, last_sync_at: null },
      { id: 'chat_v2', knowledge: 'known', error: null, has_change_log: false, pending_changes: 0, synced_changes: 0, last_sync_at: null },
    ]);
  } finally {
    await host.dispose();
  }
});

it('get_sync_status reports partial status when change log statistics fail', async () => {
  const db = storage.database('vfs');
  db.exec('CREATE TABLE __change_log (id INTEGER PRIMARY KEY, table_name TEXT)');
  const host = await hostWithPaths();
  try {
    const result = await host.invoke<{
      partial: boolean;
      errors: string[];
      total_pending_changes: number;
      databases: Array<{ id: string; knowledge: string; error: string | null; has_change_log: boolean }>;
    }>('data_governance_get_sync_status');
    expect(result.partial).toBe(true);
    expect(result.total_pending_changes).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^vfs: 读取变更日志统计失败: Database error: 查询/);
    expect(result.databases[0]).toMatchObject({ id: 'vfs', knowledge: 'unknown', has_change_log: true });
    expect(result.databases[0]!.error).toContain('Database error:');
  } finally {
    await host.dispose();
  }
});

it('get_sync_status and getPendingBreakdown exclude non-RowSync tables from pending counts', async () => {
  changeLog('vfs', [
    ['2024-01-01T00:00:00Z', 0, 'notes'],
    ['2024-01-01T00:01:00Z', 0, 'note_tags'],
    ['2024-01-01T00:02:00Z', 0, 'qbank_practice_drafts'],
  ]);
  changeLog('chat_v2', [
    ['2024-01-02T00:00:00Z', 0, 'chat_v2_session_state'],
  ]);
  changeLog('mistakes', [
    ['2024-01-03T00:00:00Z', 0, 'settings'],
    ['2024-01-03T00:01:00Z', 0, 'search_logs'],
  ]);
  changeLog('llm_usage', [
    ['2024-01-04T00:00:00Z', 0, 'llm_usage_daily'],
  ]);

  const host = await hostWithPaths();
  try {
    const status = await host.invoke<{
      has_pending_changes: boolean;
      total_pending_changes: number;
      databases: Array<{ id: string; pending_changes: number }>;
    }>('data_governance_get_sync_status');
    expect(status.has_pending_changes).toBe(true);
    expect(status.total_pending_changes).toBe(1);
    expect(status.databases.map(d => [d.id, d.pending_changes])).toEqual([
      ['vfs', 1],
      ['llm_usage', 0],
      ['chat_v2', 0],
      ['mistakes', 0],
    ]);

    const breakdown = getPendingBreakdown(storage);
    expect(breakdown.total_pending_changes).toBe(1);
    expect(breakdown.databases.find(d => d.id === 'vfs')).toEqual({
      id: 'vfs',
      pending_changes: 1,
      tables: [{ table_name: 'notes', count: 1 }],
    });
    expect(breakdown.databases.find(d => d.id === 'mistakes')?.pending_changes).toBe(0);
    expect(breakdown.databases.find(d => d.id === 'chat_v2')?.pending_changes).toBe(0);
    expect(breakdown.databases.find(d => d.id === 'llm_usage')?.pending_changes).toBe(0);
  } finally {
    await host.dispose();
  }
});
