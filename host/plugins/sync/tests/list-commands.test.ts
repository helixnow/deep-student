import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createTestHost } from './host-fixture.ts';
import sync from '../index.ts';
import { clearSyncCancelSlot, installSyncCancelSlot } from '../src/cancellation.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sync-list-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
});
afterEach(() => {
  storage.dispose();
  rmSync(root, { recursive: true, force: true });
});

function quarantineDb(name: 'vfs' | 'chat_v2' | 'mistakes' | 'llm_usage'): DatabaseHandle {
  const db = storage.database(name);
  db.exec(`CREATE TABLE __sync_quarantine (
    id INTEGER PRIMARY KEY,
    source_device_id TEXT NOT NULL,
    source_seq INTEGER NOT NULL,
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    payload_json TEXT,
    error TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    first_seen TEXT NOT NULL,
    last_attempt TEXT NOT NULL
  );`);
  return db;
}

function quarantine(db: DatabaseHandle, id: number, recordId: string, lastAttempt: string, payload: string | null = null): void {
  db.run(
    `INSERT INTO __sync_quarantine
     (id, source_device_id, source_seq, table_name, record_id, operation, payload_json, error, attempts, first_seen, last_attempt)
     VALUES (?1, 'dev-src', ?2, 'messages', ?3, 'UPDATE', ?4, 'apply failed', 2, '2024-01-01T00:00:00Z', ?5)`,
    [id, id * 10, recordId, payload, lastAttempt],
  );
}

function conflictsDb(name: 'vfs' | 'chat_v2' | 'mistakes' | 'llm_usage'): DatabaseHandle {
  const db = storage.database(name);
  db.exec(`CREATE TABLE __sync_conflicts (
    id INTEGER PRIMARY KEY,
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    side TEXT NOT NULL,
    data_json TEXT NOT NULL,
    winning_device_id TEXT,
    losing_device_id TEXT,
    detected_at TEXT NOT NULL,
    resolved_at TEXT,
    resolution TEXT
  );`);
  return db;
}

function conflict(db: DatabaseHandle, id: number, tableName: string, recordId: string, side: string, detectedAt: string, resolvedAt: string | null = null): void {
  db.run(
    `INSERT INTO __sync_conflicts
     (id, table_name, record_id, side, data_json, winning_device_id, losing_device_id, detected_at, resolved_at, resolution)
     VALUES (?1, ?2, ?3, ?4, '{"content":"x"}', 'dev-a', 'dev-b', ?5, ?6, NULL)`,
    [id, tableName, recordId, side, detectedAt, resolvedAt],
  );
}

async function host() {
  return createTestHost({ plugins: [sync], provide: { storage, paths: { deviceId: async () => 'd' } } });
}

it('list_quarantine_sorts_by_last_attempt_and_paginates_across_databases', async () => {
  const vfs = quarantineDb('vfs');
  quarantine(vfs, 1, 'm1', '2024-01-01T00:00:00Z', '{"a":1}');
  quarantine(vfs, 2, 'm2', '2024-01-03T00:00:00Z');
  const chat = quarantineDb('chat_v2');
  quarantine(chat, 3, 'm3', '2024-01-02T00:00:00Z');
  const mistakes = storage.database('mistakes');
  mistakes.exec('CREATE TABLE notes (id TEXT PRIMARY KEY)');

  const instance = await host();
  try {
    const all = await instance.invoke<Array<{ id: number; database_name: string; payload_json: string | null }>>(
      'data_governance_list_quarantine',
    );
    expect(all.map(row => [row.id, row.database_name])).toEqual([[2, 'vfs'], [3, 'chat_v2'], [1, 'vfs']]);
    expect(all[2]!.payload_json).toBe('{"a":1}');

    const page = await instance.invoke<Array<{ id: number }>>('data_governance_list_quarantine', { limit: 1, offset: 1 });
    expect(page.map(row => row.id)).toEqual([3]);
    expect(await instance.invoke('data_governance_list_quarantine', { limit: 0 })).toEqual([]);
  } finally {
    await instance.dispose();
  }
});

it('list_record_conflicts_paginates_by_group_and_keeps_all_rows_of_selected_group', async () => {
  const vfs = conflictsDb('vfs');
  conflict(vfs, 1, 'notes', 'a', 'local', '2024-01-01T00:00:00Z');
  conflict(vfs, 2, 'notes', 'a', 'cloud', '2024-01-01T00:00:00Z');
  conflict(vfs, 3, 'notes', 'b', 'cloud', '2024-01-02T00:00:00Z');
  conflict(vfs, 4, 'notes', 'c', 'local', '2024-01-03T00:00:00Z');
  conflict(vfs, 5, 'notes', 'c', 'cloud', '2024-01-03T00:00:00Z', '2024-01-04T00:00:00Z');
  const chat = conflictsDb('chat_v2');
  conflict(chat, 6, 'messages', 'm', 'local', '2024-01-04T00:00:00Z');

  const instance = await host();
  try {
    const all = await instance.invoke<Array<{ id: number; database_name: string }>>('data_governance_list_record_conflicts');
    expect(all.map(row => row.id)).toEqual([6, 4, 3, 2, 1]);

    const secondGroup = await instance.invoke<Array<{ id: number; record_id: string }>>(
      'data_governance_list_record_conflicts', { limit: 1, offset: 1 },
    );
    expect(secondGroup.map(row => row.id)).toEqual([4]);
    expect(secondGroup.map(row => row.record_id)).toEqual(['c']);

    const firstGroup = await instance.invoke<Array<{ id: number }>>(
      'data_governance_list_record_conflicts', { limit: 1, offset: 0 },
    );
    expect(firstGroup.map(row => row.id)).toEqual([6]);
  } finally {
    await instance.dispose();
  }
});

it('resolve_conflicts_rejects_any_batch_payload_with_the_retired_message', async () => {
  const instance = await host();
  try {
    await expect(instance.invoke('data_governance_resolve_conflicts', { strategy: 'keep_local', cloudManifestJson: '' }))
      .rejects.toBe('批量清单级冲突接口已停用，因为它只生成记录 ID、不会提交数据库或云端变更。请使用 data_governance_list_record_conflicts 和 data_governance_resolve_record_conflict 逐条裁决。');
    await expect(instance.invoke('data_governance_resolve_conflicts', { strategy: '', cloudManifestJson: '{}' }))
      .rejects.toBe('批量清单级冲突接口已停用，因为它只生成记录 ID、不会提交数据库或云端变更。请使用 data_governance_list_record_conflicts 和 data_governance_resolve_record_conflict 逐条裁决。');
    await expect(instance.invoke('data_governance_resolve_conflicts', { strategy: '', cloudManifestJson: '' }))
      .rejects.toBe('未知的合并策略: 。可选值: keep_local, use_cloud, keep_latest, manual');
  } finally {
    await instance.dispose();
  }
});

it('cancel_sync_reports_false_without_an_active_sync_and_aborts_installed_token', async () => {
  const instance = await host();
  try {
    expect(await instance.invoke('data_governance_cancel_sync')).toBe(false);

    const controller = new AbortController();
    installSyncCancelSlot(controller);
    try {
      expect(await instance.invoke('data_governance_cancel_sync')).toBe(true);
      expect(controller.signal.aborted).toBe(true);
    } finally {
      clearSyncCancelSlot(controller);
    }
    expect(await instance.invoke('data_governance_cancel_sync')).toBe(false);
  } finally {
    await instance.dispose();
  }
});
