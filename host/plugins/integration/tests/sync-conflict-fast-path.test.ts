import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, expect, it } from 'vitest';
import type { DatabaseHandle, SqlParams, StorageService, TransactionOptions } from '../../../platform/storage/api.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
// boundary-allow cross-plugin-impl: L22 集成测试安装真实 L21 备份插件，命令经其唯一全局操作许可（BACKUP_GLOBAL_LIMITER 等价）
import backupPlugin from '../../backup/index.ts';
// boundary-allow cross-plugin-impl: L22 集成测试需安装真实 L20 同步插件，经命令表验证事务内重读
import sync from '../../sync/index.ts';
import type { EngineChange } from '../../sync/api.ts';
// boundary-allow cross-plugin-impl: L20 host-fixture 提供真实 L11 vfsRepo 所有者与同步依赖服务
import { createTestHost } from '../../sync/tests/host-fixture.ts';

/**
 * `sync_r12_conflict_fast_path.rs` 两条行为级验收 + `sync_r10_protocol_locks.rs` P2-3。
 *
 * 真实 F3 storage（vfs.db 落在数据空间 `databases/vfs.db`，生产 `openFile(plain)` 即 busy_timeout=5000）、
 * 真实 L21 备份许可、真实 L20 命令表；冲突经 L20 `applyDownloadedChangesWithConflictGuard`
 * （Rust `apply_downloaded_changes_with_conflict_guard`）制造，不手写冲突行。
 * 业务表用已注册 RowSync 的 `resources`（同 Rust fixture `items(id, content, updated_at)` 形状；
 * TS 无 Rust debug 构建的 fixture 表放行）。
 */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const driverPath = createRequire(import.meta.url).resolve('better-sqlite3');

async function fixture(wrap?: (storage: StorageService) => StorageService) {
  const root = mkdtempSync(join(tmpdir(), 'l22-r12-conflict-fast-'));
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const host = await createTestHost({
    app: { dataDir: root },
    plugins: [backupPlugin, sync],
    provide: {
      storage: wrap ? wrap(storage) : storage,
      backup: undefined,
      settings: { get: () => null },
      paths: { deviceId: async () => 'device-local', deviceIdFile: join(root, '.device_id'), legacyDeviceIdFiles: [] },
      notes: {},
    },
  });
  const vfsPath = storage.pathOf('vfs');
  // Rust `open_active_vfs_db`：Connection::open + busy_timeout(5s) + ensure_schema。
  const db = storage.openFile(vfsPath, { profile: 'plain', createParentDirs: true });
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
  `);
  cleanups.push(async () => {
    storage.close(db);
    await host.dispose();
    storage.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  return { host, db, vfsPath };
}

type Host = Awaited<ReturnType<typeof fixture>>['host'];

function staleDeleteChange(recordId: string, sourceSeq: number): EngineChange {
  return {
    table_name: 'resources',
    record_id: recordId,
    operation: 'Delete',
    data: null,
    // 早于本地 updated_at（13:00Z）→ 输掉 LWW 门
    changed_at: '2026-07-10T12:00:00Z',
    change_log_id: null,
    database_name: 'vfs',
    suppress_change_log: true,
    source_device_id: 'device-slow',
    source_seq: sourceSeq,
  } as EngineChange;
}

function unresolvedConflictRows(db: DatabaseHandle, recordId: string) {
  return db.all<{ id: number; side: string; data_json: string }>(
    `SELECT id, side, data_json FROM __sync_conflicts
     WHERE table_name='resources' AND record_id=?1 AND resolved_at IS NULL
     ORDER BY id ASC`,
    [recordId],
  );
}

function recordContent(db: DatabaseHandle, recordId: string): string | undefined {
  return db.pluck<string>('SELECT content FROM resources WHERE id=?1', [recordId]);
}

/** Rust `seed_one_sided_delete_conflict`：经真实冲突守卫产出恰好一行 side='cloud' / data_json='null'。 */
function seedOneSidedDeleteConflict(host: Host, db: DatabaseHandle, recordId: string, sourceSeq: number): number[] {
  db.run(
    "INSERT INTO resources(id, content, updated_at) VALUES(?1, 'kept-local', '2026-07-10T13:00:00Z')",
    [recordId],
  );
  const { apply } = host.ctx.sync.applyDownloadedChangesWithConflictGuard(
    db,
    [staleDeleteChange(recordId, sourceSeq)],
    { deviceId: 'device-local' },
    { policy: 'KeepLatest', cloudDeviceId: 'device-slow', localDeviceId: 'device-local' },
  );
  expect(apply.success_count, '较旧 DELETE 不得生效').toBe(0);
  expect(apply.failure_count, 'LWW 拒绝不是失败').toBe(0);

  const rows = unresolvedConflictRows(db, recordId);
  expect(rows.length, `前提校验：应恰好产出一行单侧冲突，实际 ${JSON.stringify(rows)}`).toBe(1);
  expect(rows[0]!.side).toBe('cloud');
  expect(rows[0]!.data_json).toBe('null');
  return [Number(rows[0]!.id)];
}

function resolveKeepLocal(host: Host, recordId: string, expectedConflictIds: number[]) {
  return host.invoke('data_governance_resolve_record_conflict', {
    databaseName: 'vfs',
    tableName: 'resources',
    recordId,
    resolution: 'keep_local',
    mergedDataJson: null,
    expectedConflictIds,
  });
}

// 验收面 1：业务行未变 → 快速路径照常标 resolved（重读不得误伤正常解决）
it('r12_fast_path_matching_state_still_marks_resolved', async () => {
  const { host, db } = await fixture();
  const recordId = 'r12-fast-match-rec';
  const expectedIds = seedOneSidedDeleteConflict(host, db, recordId, 1201);

  // 业务行未变时快速路径必须照常成功（事务内重读不得误伤）
  await resolveKeepLocal(host, recordId, expectedIds);

  expect(unresolvedConflictRows(db, recordId), '解决后不得残留未解决冲突行').toEqual([]);
  const resolvedRows = Number(db.pluck<number>(
    `SELECT COUNT(*) FROM __sync_conflicts
     WHERE table_name='resources' AND record_id=?1
       AND resolved_at IS NOT NULL AND resolution='keep_local'`,
    [recordId],
  ));
  expect(resolvedRows, "冲突行应被标记 resolution='keep_local'").toBeGreaterThanOrEqual(1);
  expect(recordContent(db, recordId), 'keep_local 后本地行必须原样保留').toBe('kept-local');
});

/**
 * 验收面 2：Rust 写线程先 `BEGIN IMMEDIATE` 改业务行、1.5s 后提交。这里用 worker 线程上的
 * 独立 SQLite 连接复现：命令的事务外快照读到旧值（RESERVED 不阻塞 SHARED 读），
 * 命令的 `BEGIN IMMEDIATE` 在 busy_timeout（5s）内等到写线程提交后，事务内重读必须拒绝。
 */
it('r12_fast_path_concurrent_local_edit_is_rejected_in_transaction', async () => {
  const { host, db, vfsPath } = await fixture();
  const recordId = 'r12-fast-race-rec';
  const expectedIds = seedOneSidedDeleteConflict(host, db, recordId, 1202);

  const signal = new Int32Array(new SharedArrayBuffer(4));
  // content 是语义字段，updated_at 会被 records_semantically_equal_for_sync 剥离，故必须改 content。
  const writer = new Worker(`
    const { workerData } = require('node:worker_threads');
    const Database = require(workerData.driver);
    const conn = new Database(workerData.path, { timeout: 5000 });
    conn.exec('BEGIN IMMEDIATE;');
    conn.prepare("UPDATE resources SET content='edited-during-confirm', updated_at='2026-07-10T14:00:00Z' WHERE id=?").run(workerData.recordId);
    const signal = new Int32Array(workerData.signal);
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    conn.exec('COMMIT;');
    conn.close();
  `, { eval: true, workerData: { driver: driverPath, path: vfsPath, recordId, signal: signal.buffer } });
  const writerExit = new Promise<number>((resolve, reject) => {
    writer.once('error', reject);
    writer.once('exit', resolve);
  });
  expect(Atomics.wait(signal, 0, 0, 10_000), '写线程应先持有写锁').not.toBe('timed-out');

  // 写锁被持有期间调用命令。
  const result = await resolveKeepLocal(host, recordId, expectedIds).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  expect(await writerExit).toBe(0);

  expect(result.ok, '窗口内业务行已变，快速路径必须拒绝而非按旧快照标 resolved').toBe(false);
  if (!result.ok) {
    expect(String(result.error), `拒绝文案应指向刷新重确认，实际: ${String(result.error)}`)
      .toContain('本地记录在冲突确认期间已变化');
  }

  expect(unresolvedConflictRows(db, recordId).length, '被拒绝的决策不得改动冲突行——必须保持未解决（徽章不释放）').toBe(1);
  const resolvedRows = Number(db.pluck<number>(
    `SELECT COUNT(*) FROM __sync_conflicts
     WHERE table_name='resources' AND record_id=?1 AND resolved_at IS NOT NULL`,
    [recordId],
  ));
  expect(resolvedRows, '不得有任何冲突行被误标 resolved').toBe(0);
  expect(recordContent(db, recordId), '窗口内的本地编辑必须原样保留，不得被回滚或覆盖').toBe('edited-during-confirm');
});

type Trace = { phase: 'outside' | 'tx'; sql: string };

/** 记录生产命令在 vfs 句柄上真实执行的语句与事务方式（不改变被测行为）。 */
function tracingStorage(trace: Trace[], behaviors: Array<TransactionOptions | undefined>) {
  return (storage: StorageService): StorageService => {
    const originals = new WeakMap<object, DatabaseHandle>();
    const record = (phase: Trace['phase'], target: object) => new Proxy(target, {
      get(inner, property, receiver) {
        const value = Reflect.get(inner, property, receiver) as unknown;
        if (typeof value !== 'function') return value;
        if (['get', 'one', 'pluck', 'all', 'iterate', 'run'].includes(String(property))) {
          return (query: string | { sql: string }, params?: SqlParams) => {
            trace.push({ phase, sql: typeof query === 'string' ? query : query.sql });
            return (value as (q: unknown, p?: SqlParams) => unknown).call(inner, query, params);
          };
        }
        if (property === 'transaction' && phase === 'outside') {
          return (fn: (tx: unknown) => unknown, options?: TransactionOptions) => {
            behaviors.push(options);
            return (value as (f: (tx: unknown) => unknown, o?: TransactionOptions) => unknown)
              .call(inner, (tx: unknown) => fn(record('tx', tx as object)), options);
          };
        }
        return (value as (...args: unknown[]) => unknown).bind(inner);
      },
    });
    return new Proxy(storage, {
      get(inner, property, receiver) {
        if (property === 'openFile') {
          return (...args: Parameters<StorageService['openFile']>) => {
            const handle = inner.openFile(...args);
            const wrapped = record('outside', handle) as DatabaseHandle;
            originals.set(wrapped, handle);
            return wrapped;
          };
        }
        if (property === 'close') {
          return (handle: DatabaseHandle) => inner.close(originals.get(handle) ?? handle);
        }
        const value = Reflect.get(inner, property, receiver) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(inner) : value;
      },
    });
  };
}

it('p2_3_resolve_fast_path_business_row_recheck_now_in_transaction_source_lock', async () => {
  // Rust 原测试是 commands_sync.rs 的源码结构锁；TS 对应生产实现 conflict-commands.ts 的同一结构。
  const source = readFileSync(new URL('../../sync/src/conflict-commands.ts', import.meta.url), 'utf8');

  const snapshotRead = source.indexOf('currentLocalSnapshot = getRecordData(');
  const fastPathStart = source.indexOf('if (desiredState(currentLocalSnapshot)) {');
  const helperStart = source.indexOf('function markResolvedWithoutWrite(');
  const helperEnd = source.indexOf('function jsonEquals(', helperStart);
  expect(snapshotRead).toBeGreaterThanOrEqual(0);
  expect(fastPathStart).toBeGreaterThan(snapshotRead);
  expect(helperStart).toBeGreaterThan(fastPathStart);
  expect(helperEnd).toBeGreaterThan(helperStart);
  // 快速路径内联调用事务化标记助手。
  expect(source.slice(fastPathStart, helperStart)).toContain('markResolvedWithoutWrite(');
  const fastPath = source.slice(helperStart, helperEnd);
  expect(fastPath.length).toBeGreaterThan(0);

  expect(fastPath).toContain('db.transaction');
  expect(fastPath).toContain("behavior: 'immediate'");
  // 事务内仍重验冲突 generation（对应 __sync_conflicts 重验，防线不得删除）。
  expect(fastPath).toContain('unresolvedConflictIds(tx');

  const reread = fastPath.indexOf('getRecordData(tx,');
  const mark = fastPath.indexOf('markConflictResolved(tx,');
  expect(reread).toBeGreaterThanOrEqual(0);
  expect(mark).toBeGreaterThan(reread);
  expect(fastPath).toContain('本地记录在冲突确认期间已变化，请刷新后重新确认');

  // 同一结构在运行时的证据：经命令表执行快速路径，观察生产代码实际发出的语句顺序。
  const trace: Trace[] = [];
  const behaviors: Array<TransactionOptions | undefined> = [];
  const { host, db } = await fixture(tracingStorage(trace, behaviors));
  const recordId = 'p2-3-trace-rec';
  const expectedIds = seedOneSidedDeleteConflict(host, db, recordId, 1203);
  trace.length = 0;
  behaviors.length = 0;

  await resolveKeepLocal(host, recordId, expectedIds);

  const businessRead = (entry: Trace) => /\bFROM\s+"?resources"?/i.test(entry.sql) && /^\s*SELECT/i.test(entry.sql);
  const generationRead = (entry: Trace) => /^\s*SELECT\s+id\s+FROM\s+__sync_conflicts/i.test(entry.sql);
  const markResolved = (entry: Trace) => /^\s*UPDATE\s+__sync_conflicts\s+SET\s+resolved_at/i.test(entry.sql);
  const firstTx = trace.findIndex(entry => entry.phase === 'tx');
  // 事务外快照读仍在快速路径之前（用于计算决策输入）。
  expect(trace.slice(0, firstTx).some(businessRead)).toBe(true);
  // 快速路径只开一个事务，且是 BEGIN IMMEDIATE。
  expect(behaviors).toEqual([{ behavior: 'immediate' }]);
  const txTrace = trace.slice(firstTx).filter(entry => entry.phase === 'tx');
  const generation = txTrace.findIndex(generationRead);
  const rereadAt = txTrace.findIndex(businessRead);
  const markAt = txTrace.findIndex(markResolved);
  expect(generation, '事务内应仍重验冲突 generation').toBeGreaterThanOrEqual(0);
  expect(rereadAt, '快速路径事务内的业务行重读被移除').toBeGreaterThanOrEqual(0);
  expect(markAt, '快速路径应仍以 UPDATE __sync_conflicts 标记 resolved').toBeGreaterThan(rereadAt);
  expect(trace.slice(0, firstTx).some(markResolved), '不得在事务外标记 resolved').toBe(false);
  expect(recordContent(db, recordId)).toBe('kept-local');
});
