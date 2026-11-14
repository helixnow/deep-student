import './local-runtime-fixture.ts';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoordinatedDatabaseName, StorageService } from '../../../platform/storage/api.ts';
import type { PathsService } from '../../../platform/paths/api.ts';
import { exportSyncData, importSyncData, readSyncImportData, writeSyncExportData } from '../src/transfer-commands.ts';
import { createManifest } from '../src/merge.ts';
import { parseSyncChange, serializeSyncChange } from '../src/change-payload.ts';
import { sourceSeqForQuarantine } from '../repository/apply-quarantine.ts';
import { JsonFloat } from '../../../platform/util/lossless-json.ts';
import { openTestDatabase, type TestDatabase } from './test-db.ts';

const suite = describe;

const paths = {
  deviceId: async () => 'device-local',
} as unknown as PathsService;

interface Fixture {
  dir: string;
  db: TestDatabase;
  dbPath: string;
  storage: StorageService;
}

const fixtures: Fixture[] = [];

function createFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'sync-transfer-'));
  const dbPath = join(dir, 'vfs.db');
  const db = openTestDatabase(dbPath);
  db.exec(`
    CREATE TABLE __change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        changed_at TEXT NOT NULL DEFAULT (datetime('now')),
        sync_version INTEGER DEFAULT 0
    );
    CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        title TEXT,
        content TEXT,
        updated_at TEXT,
        device_id TEXT,
        local_version INTEGER DEFAULT 0,
        sync_version INTEGER DEFAULT 0,
        deleted_at TEXT
    );
  `);
  const storage = {
    pathOf: (name: CoordinatedDatabaseName) => (name === 'vfs' ? dbPath : join(dir, `${name}.db`)),
    openFile: () => db,
    close: () => undefined,
    locations: { activeDir: dir },
  } as unknown as StorageService;
  const fixture = { dir, db, dbPath, storage };
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

function importPayload(notes: Record<string, unknown>): string {
  return JSON.stringify({
    manifest: {
      sync_transaction_id: 'tx',
      databases: {},
      status: 'Complete',
      created_at: '2026-01-01T00:00:00+00:00',
      device_id: 'remote-device',
      format_version: 4,
      published_max_seq: 0,
      cursors: {},
      snapshot_seen: {},
    },
    pending_changes: [{
      table_name: 'notes',
      record_id: 'note-1',
      operation: 'Update',
      data: { id: 'note-1', title: 'imported', updated_at: '2026-01-02T00:00:00Z', ...notes },
      changed_at: '2026-01-02T00:00:00Z',
      database_name: 'vfs',
      suppress_change_log: true,
    }],
    exported_at: '2026-01-02T00:00:00+00:00',
  });
}

suite('sync transfer commands', () => {
  it('preserves full-width change metadata and uses the Rust i64 quarantine fallback', () => {
    const change = parseSyncChange('{"table_name":"notes","record_id":"n1","operation":"Update","data":null,"changed_at":"2026-01-01T00:00:00Z","change_log_id":9007199254740993,"source_seq":18446744073709551615}');
    expect(change.source_seq).toBe(18446744073709551615n);
    expect(change.change_log_id).toBe(9007199254740993n);
    expect(serializeSyncChange(change)).toContain('"source_seq":18446744073709551615');
    expect(sourceSeqForQuarantine(change)).toBe(9007199254740993n);
    expect(sourceSeqForQuarantine({ ...change, source_seq: 9007199254740995n })).toBe(9007199254740995n);
    expect(sourceSeqForQuarantine({ ...change, change_log_id: null })).toBe(0);
    expect(() => parseSyncChange(serializeSyncChange(change).replace('18446744073709551615', '18446744073709551616'))).toThrow();
  });
  it('manual_sync_json_buffered_roundtrip_preserves_record_data', () => {
    const fixture = createFixture();
    const path = join(fixture.dir, 'sync.json');
    const record = { id: 'record-1', content: '多语言正文\n'.repeat(4096),
      exact: 9007199254740993n, real: new JsonFloat(1), unicode: '👩‍💻\\"\n'.repeat(4096) };
    const data = {
      manifest: createManifest('test-device', {}),
      pending_changes: [{
        table_name: 'messages', record_id: 'record-1', operation: 'Update' as const,
        data: record, changed_at: '2026-09-27T00:00:00Z', change_log_id: 1,
        database_name: 'chat_v2', suppress_change_log: null, source_device_id: null, source_seq: null,
      }],
      exported_at: '2026-09-27T00:00:00Z',
    };
    writeSyncExportData(path, data);
    const restored = readSyncImportData(path);
    expect(restored.manifest.device_id).toBe(data.manifest.device_id);
    expect(restored.exported_at).toBe(data.exported_at);
    expect(restored.pending_changes).toHaveLength(1);
    expect(restored.pending_changes[0]!.data).toEqual(record);
    expect(restored.pending_changes[0]!.database_name).toBe('chat_v2');
    const written = readFileSync(path, 'utf8');
    expect(written).toContain('"exact": 9007199254740993');
    expect(written).toContain('"real": 1.0');
  });

  it('manual_sync_json_retains_read_parse_and_write_error_categories', () => {
    const fixture = createFixture();
    const path = join(fixture.dir, 'sync.json');
    expect(() => readSyncImportData(path)).toThrow(/^读取文件失败:/);
    writeFileSync(path, '{broken');
    expect(() => readSyncImportData(path)).toThrow(/^解析导入数据失败:/);
    expect(() => writeSyncExportData(fixture.dir, {
      manifest: createManifest('test-device', {}), pending_changes: [], exported_at: '2026-09-27T00:00:00Z',
    })).toThrow(/^写入文件失败:/);
  });
  it('export_sync_data_writes_pending_changes_with_full_record_data', async () => {
    const fixture = createFixture();
    fixture.db.run(
      "INSERT INTO notes (id, title, content) VALUES ('note-1', 'hello', 'body')",
    );
    fixture.db.run(
      "INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version) VALUES ('notes', 'note-1', 'UPDATE', '2026-01-01T00:00:00Z', 0)",
    );
    const output = join(fixture.dir, 'export', 'sync_data.json');

    const response = await exportSyncData(fixture.storage, paths, output);

    expect(response.success).toBe(true);
    expect(response.output_path).toBe(output);
    expect(response.pending_changes_count).toBe(1);
    expect(existsSync(output)).toBe(true);
    const parsed = JSON.parse(readFileSync(output, 'utf8')) as {
      pending_changes: Array<{ table_name: string; database_name: string; data: { title: string } }>;
      exported_at: string;
    };
    expect(parsed.pending_changes[0]?.table_name).toBe('notes');
    expect(parsed.pending_changes[0]?.database_name).toBe('vfs');
    expect(parsed.pending_changes[0]?.data.title).toBe('hello');
    expect(parsed.exported_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it('export_sync_data_defaults_to_active_directory', async () => {
    const fixture = createFixture();
    const response = await exportSyncData(fixture.storage, paths, null);
    expect(response.output_path).toBe(join(fixture.dir, 'sync_export.json'));
    expect(existsSync(response.output_path)).toBe(true);
  });

  it('export_sync_data_rejects_virtual_uri', async () => {
    const fixture = createFixture();
    await expect(exportSyncData(fixture.storage, paths, 'content://docs/sync.json'))
      .rejects.toThrow(/不支持虚拟路径/);
  });

  it('import_sync_data_applies_changes_with_full_record_data', async () => {
    const fixture = createFixture();
    const input = join(fixture.dir, 'import.json');
    writeFileSync(input, importPayload({}), 'utf8');

    const response = await importSyncData(fixture.storage, paths, input, 'keep_latest');

    expect(response.success).toBe(true);
    expect(response.imported_changes).toBe(1);
    expect(response.error_message).toBeNull();
    expect(fixture.db.pluck<string>('SELECT title FROM notes WHERE id = ?1', ['note-1'])).toBe('imported');
  });

  it('import_sync_data_rejects_invalid_strategy', async () => {
    const fixture = createFixture();
    const input = join(fixture.dir, 'import.json');
    writeFileSync(input, importPayload({}), 'utf8');
    await expect(importSyncData(fixture.storage, paths, input, 'nope'))
      .rejects.toThrow('无效的合并策略: nope。可选值: keep_local, use_cloud, keep_latest, manual');
  });

  it('import_sync_data_reports_missing_file_and_malformed_json', async () => {
    const fixture = createFixture();
    await expect(importSyncData(fixture.storage, paths, join(fixture.dir, 'missing.json'), null))
      .rejects.toThrow(/读取文件失败/);
    const broken = join(fixture.dir, 'broken.json');
    writeFileSync(broken, '{"manifest":', 'utf8');
    await expect(importSyncData(fixture.storage, paths, broken, null))
      .rejects.toThrow(/解析导入数据失败/);
  });

  it('import_sync_data_keep_local_skips_cloud_when_no_unsynced_local_change', async () => {
    const fixture = createFixture();
    fixture.db.run(
      "INSERT INTO notes (id, title, updated_at) VALUES ('note-1', 'local', '2026-02-01T00:00:00Z')",
    );
    const input = join(fixture.dir, 'import.json');
    writeFileSync(input, importPayload({}), 'utf8');

    const response = await importSyncData(fixture.storage, paths, input, 'keep_local');

    expect(response.success).toBe(true);
    expect(response.imported_changes).toBe(0);
    expect(fixture.db.pluck<string>('SELECT title FROM notes WHERE id = ?1', ['note-1'])).toBe('local');
  });

  it('import_sync_data_preserves_integer_above_2^53', async () => {
    const fixture = createFixture();
    const input = join(fixture.dir, 'import.json');
    const payload = importPayload({ local_version_marker: 'BIG' })
      .replace('"local_version_marker":"BIG"', '"local_version":9007199254740993');
    writeFileSync(input, payload, 'utf8');
    await importSyncData(fixture.storage, paths, input, 'keep_latest');
    expect(fixture.db.pluck<string>('SELECT CAST(local_version AS TEXT) FROM notes WHERE id = ?1', ['note-1']))
      .toBe('9007199254740993');
  });
});
