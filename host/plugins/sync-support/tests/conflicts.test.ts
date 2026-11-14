import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  ConflictPolicy,
  JsonValue,
  SyncChangeWithData,
  SyncHistoryPort,
} from '../api.ts';
import {
  canonicalizeConflictData as canonicalizeForCompare,
  computeDataHash,
  createResolver,
  ensureConflictTable,
  isClean,
  saveConflictRecord,
} from '../src/conflicts.ts';
import { canonicalizeForCompare as canonicalizeJson } from '../src/json.ts';
import { openTestDatabase, type TestDatabase } from './test-db.ts';

const SCHEMA = `
  CREATE TABLE items (
      id TEXT PRIMARY KEY,
      title TEXT,
      updated_at TEXT,
      device_id TEXT,
      deleted_at TEXT
  );
  CREATE TABLE __change_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      sync_version INTEGER DEFAULT 0
  );
`;

interface SnapshotCall {
  batchId: string;
  reason: string;
  table: string;
  id: string;
  data: JsonValue | null;
}

function setup(): {
  db: TestDatabase;
  snapshots: SnapshotCall[];
  history: SyncHistoryPort;
} {
  const db = openTestDatabase();
  db.exec(SCHEMA);
  const snapshots: SnapshotCall[] = [];
  const history: SyncHistoryPort = {
    newBatchId: () => 'batch-1',
    snapshotRecord: (_db, batchId, reason, table, id, current) => {
      snapshots.push({ batchId, reason, table, id, data: current });
      return true;
    },
  };
  return { db, snapshots, history };
}

function seedItem(
  db: TestDatabase,
  id: string,
  title: string,
  updatedAt: string,
  deviceId = 'device-local',
): void {
  db.run('INSERT INTO items(id,title,updated_at,device_id) VALUES(?1,?2,?3,?4)', [
    id, title, updatedAt, deviceId,
  ]);
}

function markUnsynced(db: TestDatabase, id: string): void {
  db.run(
    "INSERT INTO __change_log(table_name,record_id,operation,sync_version) VALUES('items',?1,'UPDATE',0)",
    [id],
  );
}

function change(
  id: string,
  data: JsonValue | null,
  operation: 'Insert' | 'Update' | 'Delete' = 'Update',
  changedAt = '2026-08-02T00:00:00Z',
  deviceHint: string | null = 'device-cloud',
): SyncChangeWithData {
  return {
    table_name: 'items',
    record_id: id,
    operation,
    data,
    changed_at: changedAt,
    change_log_id: null,
    database_name: 'vfs',
    suppress_change_log: true,
    source_device_id: deviceHint,
    source_seq: 1,
  };
}

function resolve(
  db: TestDatabase,
  policy: ConflictPolicy,
  history: SyncHistoryPort,
  input: SyncChangeWithData,
) {
  return createResolver(policy, history).resolveOne(db, input, 'id');
}

describe('conflict resolver (conflict_resolver.rs)', () => {
  it('ensure_conflict_table_is_idempotent_and_adds_data_hash_upgrade_path', () => {
    const db = openTestDatabase();
    ensureConflictTable(db);
    ensureConflictTable(db);
    const columns = db.all<{ name: string }>("PRAGMA table_info('__sync_conflicts')").map(row => row.name);
    expect(columns).toContain('data_hash');
    const indexes = db.all<{ name: string }>("PRAGMA index_list('__sync_conflicts')").map(row => row.name);
    expect(indexes).toContain('idx__sync_conflicts_unresolved');
    expect(indexes).toContain('idx__sync_conflicts_record');
    expect(indexes).toContain('idx__sync_conflicts_dedup');
  });

  it('save_conflict_record_deduplicates_unresolved_and_allows_after_resolution', () => {
    const { db } = setup();
    const record = {
      table_name: 'items',
      record_id: 'item-1',
      side: 'local' as const,
      data: { id: 'item-1', title: 'local', updated_at: '2026-08-01T00:00:00Z' },
      winning_device_id: null,
      losing_device_id: 'device-cloud',
    };
    expect(saveConflictRecord(db, record)).toBe(true);
    expect(saveConflictRecord(db, record)).toBe(false);
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM __sync_conflicts'))).toBe(1);

    db.run("UPDATE __sync_conflicts SET resolved_at='2026-08-03T00:00:00Z'");
    expect(saveConflictRecord(db, record)).toBe(true);
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM __sync_conflicts'))).toBe(2);
  });

  it('compute_data_hash_is_stable_across_key_order_and_ignores_sync_metadata', () => {
    const left = { title: 'x', nested: { b: 1, a: 2 }, sync_version: 3 };
    const right = { nested: { a: 2, b: 1 }, title: 'x' };
    expect(computeDataHash(left)).toBe(computeDataHash(right));
    expect(computeDataHash(left)).toHaveLength(32);
    const canonical = JSON.stringify(canonicalizeJson(left));
    expect(computeDataHash(left)).toBe(
      createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32),
    );
    expect(canonicalizeForCompare(left)).toEqual(canonicalizeJson(left));
  });

  it('keep_cloud_snapshots_local_before_overwrite_and_returns_cloud_winner', () => {
    const { db, snapshots, history } = setup();
    seedItem(db, 'item-1', 'local', '2026-08-01T00:00:00Z');
    markUnsynced(db, 'item-1');

    const outcome = resolve(db, 'keep_cloud', history, change('item-1', {
      id: 'item-1', title: 'cloud', updated_at: '2026-08-02T00:00:00Z',
    }));
    expect(outcome).not.toBeNull();
    expect(outcome!.winner).toBe('cloud');
    expect(outcome!.loser).toBe('local');
    expect(outcome!.winner_data).toMatchObject({ title: 'cloud' });
    expect(outcome!.loser_data).toMatchObject({ title: 'local' });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      batchId: 'batch-1', reason: 'policy_override', table: 'items', id: 'item-1',
    });
    expect(snapshots[0]!.data).toMatchObject({ title: 'local' });
  });

  it('keep_local_returns_local_winner_without_snapshot', () => {
    const { db, snapshots, history } = setup();
    seedItem(db, 'item-1', 'local', '2026-08-01T00:00:00Z');
    markUnsynced(db, 'item-1');

    const outcome = resolve(db, 'keep_local', history, change('item-1', {
      id: 'item-1', title: 'cloud', updated_at: '2026-08-02T00:00:00Z',
    }));
    expect(outcome!.winner).toBe('local');
    expect(outcome!.loser).toBe('cloud');
    expect(snapshots).toHaveLength(0);
  });

  it('keep_latest_compares_updated_at_and_snapshots_only_when_cloud_wins', () => {
    const { db, snapshots, history } = setup();
    seedItem(db, 'item-1', 'local', '2026-08-02T00:00:00Z');
    markUnsynced(db, 'item-1');

    const localWins = resolve(db, 'keep_latest', history, change('item-1', {
      id: 'item-1', title: 'cloud', updated_at: '2026-08-01T00:00:00Z',
    }, 'Update', '2026-08-01T00:00:00Z'));
    expect(localWins!.winner).toBe('local');
    expect(snapshots).toHaveLength(0);

    const newer = resolve(db, 'keep_latest', history, change('item-1', {
      id: 'item-1', title: 'cloud-new', updated_at: '2026-08-03T00:00:00Z',
    }, 'Update', '2026-08-03T00:00:00Z'));
    expect(newer!.winner).toBe('cloud');
    expect(snapshots).toHaveLength(1);
  });

  it('delete_conflict_uses_null_cloud_value_and_policy', () => {
    const { db, snapshots, history } = setup();
    seedItem(db, 'item-1', 'local', '2026-08-01T00:00:00Z');
    markUnsynced(db, 'item-1');

    const keepLocal = resolve(db, 'keep_local', history, change('item-1', null, 'Delete'));
    expect(keepLocal).toEqual({
      winner: 'local',
      loser: 'cloud',
      winner_data: expect.objectContaining({ title: 'local' }),
      loser_data: null,
    });
    expect(snapshots).toHaveLength(0);

    const keepCloud = resolve(db, 'keep_cloud', history, change('item-1', null, 'Delete'));
    expect(keepCloud!.winner).toBe('cloud');
    expect(keepCloud!.winner_data).toBeNull();
    expect(snapshots).toHaveLength(1);

    const latest = resolve(db, 'keep_latest', history, change(
      'item-1', null, 'Delete', '2026-08-03T00:00:00Z',
    ));
    expect(latest!.winner).toBe('cloud');
  });

  it('no_conflict_when_local_is_unchanged_missing_or_semantically_equal', () => {
    const { db, snapshots, history } = setup();
    seedItem(db, 'item-1', 'local', '2026-08-01T00:00:00Z');

    // 本地无未同步变更。
    expect(resolve(db, 'keep_cloud', history, change('item-1', {
      id: 'item-1', title: 'cloud', updated_at: '2026-08-02T00:00:00Z',
    }))).toBeNull();

    markUnsynced(db, 'item-1');
    // 云端只带自己关心的字段：本地额外字段不参与比较。
    expect(resolve(db, 'keep_cloud', history, change('item-1', {
      title: 'local',
    }))).toBeNull();
    // 记录在本地不存在。
    expect(resolve(db, 'keep_cloud', history, change('missing', {
      id: 'missing', title: 'cloud', updated_at: '2026-08-02T00:00:00Z',
    }))).toBeNull();
    // 无数据（legacy v1）。
    expect(resolve(db, 'keep_cloud', history, change('item-1', null, 'Update'))).toBeNull();
    expect(snapshots).toHaveLength(0);
  });

  it('snapshot_failure_fails_closed_before_overwrite', () => {
    const { db, history } = setup();
    seedItem(db, 'item-1', 'local', '2026-08-01T00:00:00Z');
    markUnsynced(db, 'item-1');
    const failing: SyncHistoryPort = {
      newBatchId: history.newBatchId,
      snapshotRecord: () => false,
    };
    expect(() => resolve(db, 'keep_cloud', failing, change('item-1', {
      id: 'item-1', title: 'cloud', updated_at: '2026-08-02T00:00:00Z',
    }))).toThrow(/冲突快照失败/);
  });

  it('is_clean_only_requires_zero_rejected', () => {
    expect(isClean({ applied: 1, rejected: 0, conflicts_saved: 0, conflicts_by_table: {} })).toBe(true);
    expect(isClean({ applied: 0, rejected: 1, conflicts_saved: 2, conflicts_by_table: { items: 2 } })).toBe(false);
  });
});
