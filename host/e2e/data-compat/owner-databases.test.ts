import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createStorageService } from '../../platform/storage/service.ts';
import type { DatabaseHandle, SqlExecutor } from '../../platform/storage/api.ts';
import { initAuditTable, queryAuditLogsPaged } from '../../plugins/backup/repository/audit.ts';
import { SqliteSyncStateStore } from '../../plugins/sync-support/src/state.ts';
import { WorkspaceCoordinator } from '../../plugins/agent-workspace/src/workspace/coordinator.ts';
import {
  I64, JSON_TEXT, LARGE, buildOwnerDatabase, cleanup, ownerSchema, ownerSnapshot, rawOwnerDatabase, tempDir,
} from './__fixtures__/fixtures.ts';
import { INSTANCE_ID, OWNER_SEEDS, U64_MAX, UTC_OFFSET, WORKSPACE_ID, historicalSql } from './__fixtures__/owner-fixtures.ts';

// These are the production owners instantiated by backup/index.ts:196,
// sync-support/index.ts:51 and agent-workspace/index.ts:93. All I/O goes through F3.
// No core runAll(): none of these three schemas belongs to the refinery coordinator.
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) cleanup(dir); });
function fixture() {
  const base = tempDir();
  dirs.push(base);
  return { base, active: join(base, 'slots/slotA'), local: join(base, 'local') };
}
function checkDatabase(db: SqlExecutor, version: number) {
  expect(db.pluck('PRAGMA user_version')).toBe(version);
  expect(db.all("SELECT name FROM sqlite_master WHERE name = 'refinery_schema_history'")).toEqual([]);
  expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
  expect(db.pluck('PRAGMA integrity_check')).toBe('ok');
}

const expectedMessage = {
  id: 'message_old', workspaceId: WORKSPACE_ID, senderSessionId: 'creator_old', targetSessionId: null,
  messageType: 'broadcast', content: '旧消息📚\n第二行', status: 'pending', createdAt: UTC_OFFSET,
  metadata: { 中文: '升级📚', nil: null, n: LARGE, ok: true },
};

it('audit: original unversioned Rust schema remains readable and byte-value stable through owner init and reopen', () => {
  const { base, active, local } = fixture();
  const file = join(active, 'databases/audit.db');
  const tables = Object.keys(OWNER_SEEDS.audit);
  buildOwnerDatabase(file, historicalSql('audit'), OWNER_SEEDS.audit);
  const before = rawOwnerDatabase(file, tables);
  expect(before.schema.userVersion).toBe(0);
  for (let pass = 0; pass < 2; pass++) {
    const storage = createStorageService({ baseDir: base, dataLocalDir: local });
    try {
      expect(storage.pathOf('audit')).toBe(file);
      const db = storage.database('audit');
      initAuditTable(db);
      const result = queryAuditLogsPaged(db, {});
      expect(result.total).toBe(3);
      expect(result.logs).toHaveLength(3);
      expect(result.logs.find(row => row.id === 'audit_backup')).toEqual({
        id: 'audit_backup', timestamp: UTC_OFFSET,
        operation: { type: 'Backup', backup_type: 'Incremental', file_count: 4294967295, total_size: U64_MAX },
        target: '旧备份📚.zip', status: 'Completed', duration_ms: I64,
        details: { 中文: '升级📚', nil: null, n: LARGE, ok: true }, error_message: null,
      });
      expect(result.logs.find(row => row.id === 'audit_null')).toEqual({
        id: 'audit_null', timestamp: UTC_OFFSET, operation: { type: 'Restore', backup_path: '备份/旧📚.zip' },
        target: 'slotA', status: 'Failed', duration_ms: null, details: null, error_message: '历史错误📚',
      });
      expect(result.logs.find(row => row.id === 'audit_json_null')).toEqual({
        id: 'audit_json_null', timestamp: '2026-10-02T00:00:00+00:00',
        operation: { type: 'Sync', direction: 'Download', records_affected: 0 },
        target: 'vfs', status: 'Started', duration_ms: 0, details: null, error_message: null,
      });
      expect(queryAuditLogsPaged(db, { operation_type: 'Restore', status: 'Failed' })).toEqual({
        logs: [result.logs.find(row => row.id === 'audit_null')], total: 1,
      });
      expect(ownerSnapshot(db, tables)).toEqual(before.rows);
      expect(ownerSchema(db)).toEqual(before.schema);
      checkDatabase(db, 0);
      initAuditTable(db); // same-connection retry, then a genuinely new service on pass 2
      expect(ownerSnapshot(db, tables)).toEqual(before.rows);
      expect(ownerSchema(db)).toEqual(before.schema);
    } finally { storage.dispose(); }
  }
  expect(rawOwnerDatabase(file, tables)).toEqual(before);
});

it('sync_state: prior six-table Rust schema adds event publication, preserves exact sequences and reopens idempotently', () => {
  const { base, active, local } = fixture();
  const file = join(local, 'deep-student/sync/sync_state.db');
  const tables = Object.keys(OWNER_SEEDS.sync_state);
  buildOwnerDatabase(file, historicalSql('sync-state'), OWNER_SEEDS.sync_state);
  const before = rawOwnerDatabase(file, tables);
  expect(before.schema.userVersion).toBe(0);
  let upgraded: ReturnType<typeof ownerSchema> | undefined;
  let eventRows: ReturnType<typeof ownerSnapshot> | undefined;
  for (let pass = 0; pass < 2; pass++) {
    const storage = createStorageService({ baseDir: base, dataLocalDir: local });
    try {
      expect(storage.pathOf('sync_state')).toBe(file);
      const db = storage.database('sync_state');
      expect(db.pluck("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='tombstone_event_publish'")).toBe(pass === 0 ? 0 : 1);
      const state = new SqliteSyncStateStore(db);
      expect(state.publishedMaxSeq(INSTANCE_ID, 'device_old')).toBe(I64);
      expect(state.nextUploadSeq(INSTANCE_ID, 'device_old', 0n)).toBe(I64 + 1n);
      expect(state.getCursor(INSTANCE_ID, 'uploader_old')).toBe(I64);
      expect(state.cursors(INSTANCE_ID)).toEqual(new Map([['uploader_old', I64]]));
      expect(state.getTombstoneWatermark(INSTANCE_ID, 'source_old', 'assets')).toBe(I64);
      expect(state.isLegacyProcessed(INSTANCE_ID, '旧目录/📚.json')).toBe(true);
      expect(state.isLegacyProcessed(INSTANCE_ID, 'missing')).toBe(false);
      expect(state.deviceRotationsForNew('device_new')).toEqual([['device_old', '旧设备迁移📚']]);
      state.bindInstance(INSTANCE_ID, 'webdav', 'https://example.com/中文'); // existing binding: no write
      expect(() => state.bindInstance(INSTANCE_ID, 'ftp', 'other')).toThrow('云同步实例绑定不匹配');
      expect(ownerSnapshot(db, tables)).toEqual(before.rows);
      if (pass === 0) {
        expect(db.all('SELECT * FROM tombstone_event_publish')).toEqual([]);
        const after = ownerSchema(db);
        expect(after.objects.filter(row => row.tbl_name !== 'tombstone_event_publish')).toEqual(before.schema.objects);
        expect(after.objects.filter(row => row.type === 'table').map(row => row.name).sort()).toEqual([...tables, 'tombstone_event_publish'].sort());
        upgraded = after;
        // Exercise the newly added table through its real owner, using the Rust recovery entry.
        expect(state.reserveTombstoneEventSeqWithExisting(INSTANCE_ID, 'device_old', 'assets', 'op_old', 0n, I64)).toBe(I64);
        eventRows = ownerSnapshot(db, ['tombstone_event_publish']);
      }
      expect(state.reserveTombstoneEventSeq(INSTANCE_ID, 'device_old', 'assets', 'op_old', I64 + 99n)).toBe(I64);
      expect(ownerSnapshot(db, ['tombstone_event_publish'])).toEqual(eventRows);
      expect(ownerSchema(db)).toEqual(upgraded);
      checkDatabase(db, 0);
      new SqliteSyncStateStore(db);
      expect(ownerSnapshot(db, tables)).toEqual(before.rows);
      expect(ownerSnapshot(db, ['tombstone_event_publish'])).toEqual(eventRows);
      expect(ownerSchema(db)).toEqual(upgraded);
    } finally { storage.dispose(); }
  }
  expect(rawOwnerDatabase(file, tables).rows).toEqual(before.rows);
  expect(existsSync(join(active, 'sync_state.db'))).toBe(false);
});

it('workspace: actual Rust user_version 1 upgrades to 2 through the coordinator, preserving all eight tables on reopen', () => {
  const { base, active, local } = fixture();
  const workspacesDir = join(active, 'workspaces');
  const file = join(workspacesDir, `ws_${WORKSPACE_ID}.db`);
  const tables = [...Object.keys(OWNER_SEEDS.workspace), 'sqlite_sequence'];
  buildOwnerDatabase(file, historicalSql('workspace-v1'), OWNER_SEEDS.workspace, 1);
  const before = rawOwnerDatabase(file, tables);
  expect(before.schema.userVersion).toBe(1);
  for (let pass = 0; pass < 2; pass++) {
    const storage = createStorageService({ baseDir: base, dataLocalDir: local });
    const coordinator = new WorkspaceCoordinator({ workspacesDir, io: {
      open: path => storage.openFile(path, { profile: 'workspace', mustExist: true }),
      close: db => storage.close(db as DatabaseHandle),
    } });
    try {
      expect(coordinator.getWorkspace(WORKSPACE_ID)).toEqual({
        id: WORKSPACE_ID, name: '旧工作区📚', status: 'active', creatorSessionId: 'creator_old',
        createdAt: UTC_OFFSET, updatedAt: UTC_OFFSET, metadata: { 中文: '升级📚', nil: null, n: LARGE, ok: true },
      });
      expect(coordinator.listAgents(WORKSPACE_ID)).toEqual([{
        sessionId: 'worker_old', workspaceId: WORKSPACE_ID, role: 'worker', skillId: null, status: 'idle',
        joinedAt: UTC_OFFSET, lastActiveAt: UTC_OFFSET, metadata: undefined,
      }]);
      expect(coordinator.listMessages(WORKSPACE_ID, 10)).toEqual([expectedMessage]);
      expect(coordinator.pendingInboxCount(WORKSPACE_ID, 'worker_old')).toBe(1);
      expect(coordinator.getDocument(WORKSPACE_ID, 'document_old')).toEqual({
        id: 'document_old', workspaceId: WORKSPACE_ID, docType: 'notes', title: '旧文档📚', content: '# 中文\n正文📚',
        version: 2147483647, updatedBy: 'worker_old', updatedAt: UTC_OFFSET,
      });
      expect(coordinator.getContext(WORKSPACE_ID, '上下文📚')).toEqual({
        workspaceId: WORKSPACE_ID, key: '上下文📚', value: { 中文: '升级📚', nil: null, n: LARGE, ok: true },
        updatedBy: 'creator_old', updatedAt: UTC_OFFSET,
      });
      expect(coordinator.getTaskManager(WORKSPACE_ID).getTask('task_old')).toEqual({
        id: 'task_old', workspaceId: WORKSPACE_ID, agentSessionId: 'worker_old', skillId: null,
        initialTask: '历史任务📚', status: 'pending', createdAt: UTC_OFFSET, startedAt: null, completedAt: null, resultSummary: null,
      });
      expect(coordinator.getSleepManager(WORKSPACE_ID).getSleep('sleep_old')).toEqual({
        id: 'sleep_old', workspaceId: WORKSPACE_ID, coordinatorSessionId: 'creator_old', awaitingAgents: ['worker_old'],
        wakeCondition: { type: 'result_message' }, status: 'awakened', timeoutAt: null, createdAt: UTC_OFFSET,
        awakenedAt: UTC_OFFSET, awakenedBy: 'worker_old', awakenMessage: null, messageId: 'message_old', blockId: null,
      });
      const db = storage.openFile(file, { profile: 'workspace', mustExist: true });
      expect(ownerSnapshot(db, tables)).toEqual(before.rows);
      expect(ownerSchema(db)).toEqual({ ...before.schema, userVersion: 2 });
      expect(db.pluck('SELECT metadata_json FROM workspace')).toBe(JSON_TEXT);
      checkDatabase(db, 2);
    } finally {
      coordinator.shutdownAllSleeps();
      storage.dispose();
    }
  }
  expect(rawOwnerDatabase(file, tables)).toEqual({ ...before, schema: { ...before.schema, userVersion: 2 } });
  expect(existsSync(join(active, 'workspace.db'))).toBe(false);
  expect(existsSync(join(active, 'superagent.db'))).toBe(false);
});

// X3-L05-02: keep the original failing peek assertion as a separate regression so
// the full-column/reopen evidence above executes even while L05 recovery is broken.
it('workspace: persisted unread inbox is restored into the owner queue when an old database is opened', () => {
  const { base, active, local } = fixture();
  const workspacesDir = join(active, 'workspaces');
  const file = join(workspacesDir, `ws_${WORKSPACE_ID}.db`);
  const tables = Object.keys(OWNER_SEEDS.workspace);
  buildOwnerDatabase(file, historicalSql('workspace-v1'), OWNER_SEEDS.workspace, 1);
  const before = rawOwnerDatabase(file, tables);
  const storage = createStorageService({ baseDir: base, dataLocalDir: local });
  const coordinator = new WorkspaceCoordinator({ workspacesDir, io: {
    open: path => storage.openFile(path, { profile: 'workspace', mustExist: true }),
    close: db => storage.close(db as DatabaseHandle),
  } });
  try {
    expect(coordinator.pendingInboxCount(WORKSPACE_ID, 'worker_old')).toBe(1);
    expect(rawOwnerDatabase(file, tables).rows).toEqual(before.rows);
    expect(coordinator.peekInbox(WORKSPACE_ID, 'worker_old')).toEqual([expectedMessage]);
    expect(coordinator.peekInbox(WORKSPACE_ID, 'worker_old')).toEqual([expectedMessage]);
    expect(coordinator.pendingInboxCount(WORKSPACE_ID, 'worker_old')).toBe(1);
    expect(rawOwnerDatabase(file, tables).rows).toEqual(before.rows);
  } finally {
    coordinator.shutdownAllSleeps();
    storage.dispose();
  }
});
