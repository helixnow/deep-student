import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
// boundary-allow cross-plugin-impl: L22 集成测试安装真实 L21 备份插件，命令经其唯一全局操作许可（BACKUP_GLOBAL_LIMITER 等价）
import backupPlugin from '../../backup/index.ts';
// boundary-allow cross-plugin-impl: L22 集成测试需安装真实 L20 同步插件，经命令表验证 resolve → list → rollback 链路
import sync from '../../sync/index.ts';
import type { EngineChange } from '../../sync/api.ts';
// boundary-allow cross-plugin-impl: L20 history 常量（Rust history::REASON_CONFLICT_RESOLVE）为生产实现的一部分
import { REASON_CONFLICT_RESOLVE } from '../../sync/src/history.ts';
// boundary-allow cross-plugin-impl: L20 host-fixture 提供真实 L11 vfsRepo 所有者与同步依赖服务
import { createTestHost } from '../../sync/tests/host-fixture.ts';

/**
 * `sync_r11_history.rs` 端到端命令链路的 TS 行为级移植：
 * KeepLocal 冲突守卫制造双侧冲突 → 冲突面板 resolve 命令执行前自动快照（reason=conflict_resolve）→
 * `data_governance_list_sync_snapshot_batches` 可见 → `data_governance_rollback_sync_snapshot_batch`
 * 恢复覆盖前的本地值，且回退结果仍进入待上传 change_log。
 *
 * 真实 F3 storage（数据空间 `databases/vfs.db`）、真实 L21 备份许可、真实 L20 命令与冲突守卫；
 * 业务表用已注册 RowSync 的 `resources`（同 Rust fixture `items` 形状与触发器）。
 */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function ensureSchema(db: DatabaseHandle): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resources (
        id TEXT PRIMARY KEY,
        content TEXT,
        updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS __change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('INSERT', 'UPDATE', 'DELETE')),
        changed_at TEXT NOT NULL DEFAULT (datetime('now')),
        sync_version INTEGER DEFAULT 0
    );
    CREATE TRIGGER IF NOT EXISTS trg_items_insert
    AFTER INSERT ON resources
    BEGIN
        INSERT INTO __change_log(table_name, record_id, operation)
        VALUES('resources', NEW.id, 'INSERT');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_items_update
    AFTER UPDATE ON resources
    BEGIN
        INSERT INTO __change_log(table_name, record_id, operation)
        VALUES('resources', NEW.id, 'UPDATE');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_items_delete
    AFTER DELETE ON resources
    BEGIN
        INSERT INTO __change_log(table_name, record_id, operation)
        VALUES('resources', OLD.id, 'DELETE');
    END;
  `);
}

/** Rust `seed_locally_edited_row`：插入基线 → 标记已同步 → 本地再编辑。 */
function seedLocallyEditedRow(db: DatabaseHandle, recordId: string, content: string, updatedAt: string): void {
  db.run("INSERT INTO resources(id, content, updated_at) VALUES(?1, 'base', ?2)", [recordId, updatedAt]);
  db.run('UPDATE __change_log SET sync_version = 1 WHERE sync_version = 0');
  db.run('UPDATE resources SET content = ?2 WHERE id = ?1', [recordId, content]);
}

function cloudUpdateChange(recordId: string, content: string, ts: string): EngineChange {
  return {
    table_name: 'resources',
    record_id: recordId,
    operation: 'Update',
    data: { id: recordId, content, updated_at: ts },
    changed_at: ts,
    change_log_id: null,
    database_name: 'vfs',
    suppress_change_log: true,
    source_device_id: 'device-cloud',
    source_seq: 1,
  } as EngineChange;
}

function recordContent(db: DatabaseHandle, recordId: string): string | undefined {
  return db.pluck<string>('SELECT content FROM resources WHERE id=?1', [recordId]);
}

function pendingChangeLogRows(db: DatabaseHandle, recordId: string): number {
  return Number(db.pluck<number>(
    `SELECT COUNT(*) FROM __change_log
     WHERE table_name='resources' AND record_id=?1 AND sync_version=0`,
    [recordId],
  ));
}

it('r11_resolve_command_snapshots_and_new_commands_browse_and_rollback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'l22-r11-history-'));
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const host = await createTestHost({
    app: { dataDir: root },
    plugins: [backupPlugin, sync],
    provide: {
      storage,
      backup: undefined,
      settings: { get: () => null },
      paths: { deviceId: async () => 'device-local', deviceIdFile: join(root, '.device_id'), legacyDeviceIdFiles: [] },
      // `resources` 没有 note_document_revisions 列，note hooks 在 hasVersionId 处提前返回。
      notes: {},
    },
  });
  // Rust `open_active_vfs_db`：Connection::open + busy_timeout(5s) + ensure_schema。
  const db = storage.openFile(storage.pathOf('vfs'), { profile: 'plain', createParentDirs: true });
  cleanups.push(async () => {
    storage.close(db);
    await host.dispose();
    storage.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  ensureSchema(db);

  const recordId = 'r11-e2e-rec';
  // KeepLocal 策略制造双侧冲突：本地行保留、local+cloud 两行入冲突表
  seedLocallyEditedRow(db, recordId, 'local-edit', '2026-07-10T13:00:00Z');
  const { conflict } = host.ctx.sync.applyDownloadedChangesWithConflictGuard(
    db,
    [cloudUpdateChange(recordId, 'cloud-candidate', '2026-07-10T14:00:00Z')],
    { deviceId: 'device-local' },
    { policy: 'KeepLocal', cloudDeviceId: 'device-cloud', localDeviceId: 'device-local' },
  );
  expect(conflict.conflicts_saved, '前提：双侧冲突已入表').toBeGreaterThanOrEqual(2);
  const expectedIds = db.all<{ id: number }>(
    `SELECT id FROM __sync_conflicts
     WHERE table_name='resources' AND record_id=?1 AND resolved_at IS NULL
     ORDER BY id ASC`,
    [recordId],
  ).map(row => Number(row.id));
  expect(expectedIds.length).toBeGreaterThan(0);

  // 冲突面板「采用云端」= 覆盖本地行的危险操作，执行前必须自动快照
  await host.invoke('data_governance_resolve_record_conflict', {
    databaseName: 'vfs',
    tableName: 'resources',
    recordId,
    resolution: 'keep_cloud',
    mergedDataJson: null,
    expectedConflictIds: expectedIds,
  });
  expect(recordContent(db, recordId), '前提：本地行已被云端候选覆盖').toBe('cloud-candidate');

  // 新命令一：快照批次列表必须包含 conflict_resolve 批次
  const batches = await host.invoke('data_governance_list_sync_snapshot_batches', { limit: null }) as Array<{
    database_name: string;
    batch_id: string;
    reason: string;
    record_count: number;
    rolled_back_at: string | null;
  }>;
  const resolveBatch = batches.find(batch =>
    batch.database_name === 'vfs' && batch.reason === REASON_CONFLICT_RESOLVE);
  expect(resolveBatch, '必须存在 conflict_resolve 快照批次').toBeDefined();
  expect(resolveBatch!.record_count).toBeGreaterThanOrEqual(1);
  expect(resolveBatch!.rolled_back_at).toBeNull();

  // 新命令二：单批回退恢复覆盖前的本地值
  const outcome = await host.invoke('data_governance_rollback_sync_snapshot_batch', {
    databaseName: 'vfs',
    batchId: resolveBatch!.batch_id,
  }) as { restored: number; undo_batch_id: string };
  expect(outcome.restored).toBe(1);
  expect(outcome.undo_batch_id).not.toBe('');

  expect(recordContent(db, recordId), '回退命令必须恢复覆盖前的本地值').toBe('local-edit');
  expect(pendingChangeLogRows(db, recordId), '回退结果必须进入待上传变更').toBeGreaterThan(0);
});
