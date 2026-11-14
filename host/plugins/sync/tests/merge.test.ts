import { expect, it } from 'vitest';
import { Hlc } from '../src/hlc.ts';
import {
  ManualResolutionRequiredError,
  applyMergeStrategy,
  createManifest,
  detectConflicts,
  mergeApplicationFailure,
  mergeApplicationSuccess,
  type ConflictRecord,
  type DatabaseSyncState,
  type SyncManifest,
} from '../src/merge.ts';
import { compareTimestamps } from '../src/lww.ts';

function createTestManifest(deviceId: string, databases: Array<[string, number, number, string]>): SyncManifest {
  const map: Record<string, DatabaseSyncState> = {};
  for (const [name, schemaVersion, dataVersion, checksum] of databases) {
    map[name] = { schema_version: schemaVersion, data_version: dataVersion, checksum, last_updated_at: null };
  }
  return {
    sync_transaction_id: 'test-tx',
    databases: map,
    status: 'Complete',
    created_at: '2024-01-01T00:00:00Z',
    device_id: deviceId,
    format_version: 4,
    published_max_seq: 0,
    cursors: {},
    superseded_by: null,
    snapshot_seen: {},
  };
}

function conflict(overrides: Partial<ConflictRecord>): ConflictRecord {
  return {
    database_name: 'chat_v2',
    table_name: 'messages',
    record_id: 'msg-1',
    local_version: 3,
    cloud_version: 4,
    local_updated_at: '2024-01-01T10:00:00Z',
    cloud_updated_at: '2024-01-01T11:00:00Z',
    local_data: { content: 'local' },
    cloud_data: { content: 'cloud' },
    ...overrides,
  };
}

it('test_compare_timestamps_hlc_fast_path', () => {
  const earlier = new Hlc(1_700_000_000_000n, 0).toString();
  const later = new Hlc(1_700_000_000_000n, 1).toString();

  expect(compareTimestamps(later, earlier)).toBe(1);
  expect(compareTimestamps(earlier, later)).toBe(-1);
  expect(compareTimestamps(earlier, earlier)).toBe(0);
});

it('test_compare_timestamps_mixed_hlc_and_iso', () => {
  const hlc = new Hlc(1_700_000_000_000n, 0).toString();
  expect(compareTimestamps(hlc, '2024-01-01T00:00:00Z')).toBe(-1);
});

it('test_detect_no_conflicts', () => {
  const local = createTestManifest('device-1', [['chat_v2', 1, 100, 'abc123']]);
  const cloud = createTestManifest('device-2', [['chat_v2', 1, 100, 'abc123']]);

  const result = detectConflicts(local, cloud);
  expect(result.has_conflicts).toBe(false);
  expect(result.database_conflicts).toEqual([]);
});

it('test_detect_schema_mismatch', () => {
  const local = createTestManifest('device-1', [['chat_v2', 1, 100, 'abc123']]);
  const cloud = createTestManifest('device-2', [['chat_v2', 2, 100, 'abc123']]);

  const result = detectConflicts(local, cloud);
  expect(result.has_conflicts).toBe(true);
  expect(result.needs_migration).toBe(true);
  expect(result.database_conflicts).toHaveLength(1);
  expect(result.database_conflicts[0]!.conflict_type).toBe('SchemaMismatch');
});

it('test_detect_data_conflict', () => {
  const local = createTestManifest('device-1', [['chat_v2', 1, 101, 'abc123']]);
  const cloud = createTestManifest('device-2', [['chat_v2', 1, 102, 'def456']]);

  const result = detectConflicts(local, cloud);
  expect(result.has_conflicts).toBe(true);
  expect(result.needs_migration).toBe(false);
  expect(result.database_conflicts).toHaveLength(1);
  expect(result.database_conflicts[0]!.conflict_type).toBe('DataConflict');
});

it('test_detect_local_only', () => {
  const local = createTestManifest('device-1', [['chat_v2', 1, 100, 'abc123'], ['mistakes', 1, 50, 'xyz789']]);
  const cloud = createTestManifest('device-2', [['chat_v2', 1, 100, 'abc123']]);

  const result = detectConflicts(local, cloud);
  expect(result.has_conflicts).toBe(true);
  expect(result.database_conflicts).toHaveLength(1);
  expect(result.database_conflicts[0]!.conflict_type).toBe('LocalOnly');
  expect(result.database_conflicts[0]!.database_name).toBe('mistakes');
});

it('test_detect_cloud_only', () => {
  const local = createTestManifest('device-1', [['chat_v2', 1, 100, 'abc123']]);
  const cloud = createTestManifest('device-2', [['chat_v2', 1, 100, 'abc123'], ['llm_usage', 1, 200, 'qwe456']]);

  const result = detectConflicts(local, cloud);
  expect(result.has_conflicts).toBe(true);
  expect(result.database_conflicts).toHaveLength(1);
  expect(result.database_conflicts[0]!.conflict_type).toBe('CloudOnly');
  expect(result.database_conflicts[0]!.database_name).toBe('llm_usage');
});

it('test_apply_merge_strategy_keep_local', () => {
  const result = applyMergeStrategy('KeepLocal', [conflict({})]);
  expect(result.success).toBe(true);
  expect(result.kept_local).toBe(1);
  expect(result.used_cloud).toBe(0);
  expect(result.records_to_push).toEqual(['msg-1']);
  expect(result.records_to_pull).toEqual([]);
});

it('test_apply_merge_strategy_use_cloud', () => {
  const result = applyMergeStrategy('UseCloud', [conflict({})]);
  expect(result.success).toBe(true);
  expect(result.kept_local).toBe(0);
  expect(result.used_cloud).toBe(1);
  expect(result.records_to_push).toEqual([]);
  expect(result.records_to_pull).toEqual(['msg-1']);
});

it('test_apply_merge_strategy_keep_latest', () => {
  const result = applyMergeStrategy('KeepLatest', [
    conflict({}),
    conflict({
      record_id: 'msg-2',
      local_version: 5,
      cloud_version: 3,
      local_updated_at: '2024-01-01T12:00:00Z',
      cloud_updated_at: '2024-01-01T09:00:00Z',
      local_data: { content: 'local new' },
      cloud_data: { content: 'cloud old' },
    }),
  ]);

  expect(result.success).toBe(true);
  expect(result.kept_local).toBe(1);
  expect(result.used_cloud).toBe(1);
  expect(result.records_to_push).toEqual(['msg-2']);
  expect(result.records_to_pull).toEqual(['msg-1']);
});

it('regression_m3_keep_latest_uses_device_tiebreaker', () => {
  const result = applyMergeStrategy('KeepLatest', [conflict({
    local_updated_at: '2024-01-01T10:00:00Z',
    cloud_updated_at: '2024-01-01T10:00:00Z',
    local_data: { content: 'local', device_id: 'device-a' },
    cloud_data: { content: 'cloud', device_id: 'device-b' },
  })]);

  expect(result.success).toBe(true);
  expect(result.kept_local).toBe(0);
  expect(result.used_cloud).toBe(1);
  expect(result.records_to_push).toEqual([]);
  expect(result.records_to_pull).toEqual(['msg-1']);
});

it('test_apply_merge_strategy_manual_error', () => {
  let thrown: unknown;
  try {
    applyMergeStrategy('Manual', [conflict({})]);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ManualResolutionRequiredError);
  expect((thrown as ManualResolutionRequiredError).count).toBe(1);
});

it('test_merge_application_result', () => {
  const success = mergeApplicationSuccess(3, 2);
  expect(success.success).toBe(true);
  expect(success.kept_local).toBe(3);
  expect(success.used_cloud).toBe(2);

  const failure = mergeApplicationFailure(['error1']);
  expect(failure.success).toBe(false);
  expect(failure.errors).toEqual(['error1']);
});

it('test_create_manifest_defaults', () => {
  const manifest = createManifest('device-1', {
    chat_v2: { schema_version: 1, data_version: 100, checksum: 'abc123', last_updated_at: null },
  });
  expect(manifest.device_id).toBe('device-1');
  expect(manifest.format_version).toBe(4);
  expect(manifest.status).toBe('Complete');
  expect(manifest.sync_transaction_id).toMatch(/^[0-9a-f-]{36}$/u);
  expect(manifest.databases.chat_v2!.checksum).toBe('abc123');
});
