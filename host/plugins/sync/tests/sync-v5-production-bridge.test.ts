import './local-runtime-fixture.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { PairingSettings } from '../src/device-pairing.ts';
import { SyncV5RuntimeCoordinator, DeduplicatedIntervalTree, pairAndBootstrapDeviceV5, storageWithV5Ranges } from '../src/v5-runtime-bridge.ts';
import { createDSPAIR2Pairing, decodeDSPAIR2Pairing } from '../src/dspair2.ts';
import { runSyncV5 } from '../src/run-sync.ts';
import type { SyncContext } from '../src/dependencies.ts';
import type { LocalSyncCommandPorts } from '../src/sync-command-needs.ts';
import type { EngineChange } from '../src/change-payload.ts';
import { Hlc } from '../src/hlc.ts';
import { readUnknownFieldsForRoundTrip } from '../src/unknown-fields.ts';
import { MemoryStorage } from '../../sync-providers/tests/memory_storage.ts'; // boundary-allow cross-plugin-impl: bridge integration tests use shared MemoryStorage fake
import { FtpStorage, FTP_RANGE_MAX_OBJECT_BYTES } from '../../sync-providers/src/ftp.ts'; // boundary-allow cross-plugin-impl: bridge integration tests exercise real FtpStorage adapter
import { spawnFakeFtp } from '../../sync-providers/tests/fake_ftp.ts'; // boundary-allow cross-plugin-impl: bridge integration tests run against local fake FTP server
import { decodeShardedIndex } from '../../sync-providers/api.ts';
import { openTestDatabase, type TestDatabase } from './test-db.ts';

class RangeStorage extends MemoryStorage {
  ranges: Array<{ key: string; offset: number; length: number }> = [];
  failHead = false;
  override async put(key: string, bytes: Uint8Array): Promise<void> {
    if (this.failHead && key.includes('/heads/')) { this.failHead = false; throw new Error('network interrupted'); }
    return super.put(key, bytes);
  }
  override async getRange(key: string, offset: number, length: number): Promise<Uint8Array> {
    this.ranges.push({ key, offset, length });
    const bytes = this.bytes(key);
    if (!bytes) throw new Error(`Missing range: ${key}`);
    return bytes.subarray(offset, offset + length);
  }
}
const opened: TestDatabase[] = [];
const directories: string[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.raw.close(); for (const path of directories.splice(0)) rmSync(path, { recursive: true }); });
function diskPath(name: string): string {
  const scratch = join(process.cwd(), '.oc-runs');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'bridge-test-')); directories.push(dir); return join(dir, name);
}
function close(db: TestDatabase): void { opened.splice(opened.indexOf(db), 1); db.raw.close(); }
function reopen(path: string): TestDatabase { const db = openTestDatabase(path); opened.push(db); return db; }
function database(version = 2, path = ':memory:'): TestDatabase {
  const db = reopen(path);
  for (const table of ['notes', 'chat_v2_sessions', 'mistakes', 'plugin_cards']) {
    db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,title TEXT DEFAULT 'default'${version === 2 ? ',future TEXT' : ''})`);
  }
  return db;
}
function setup() {
  const storage = new RangeStorage();
  const secrets = { kCid: randomBytes(32), masterKeys: new Map([[0, randomBytes(32)]]) };
  let time = 1000;
  function device(deviceId: string, version = 2) {
    const db = database(version);
    const options = { deviceId, repoId: 'repo', stateDb: db, databases: new Map([['vfs', db], ['chat_v2', db], ['mistakes', db]]), storage, secrets, now: () => time };
    return { db, options, sync: new SyncV5RuntimeCoordinator(options) };
  }
  return { storage, secrets, device, advance: (value: number) => { time = value; } };
}
function change(id = 'r', data: EngineChange['data'] = { title: 'hello' }, database_name = 'vfs', table_name = 'notes', operation: EngineChange['operation'] = 'Insert'): EngineChange {
  return { table_name, record_id: id, operation, data, database_name, changed_at: 'legacy timestamp replaced' };
}
function settings(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const store = {
    get: (key: string) => values.get(key) ?? null,
    getSecret: (key: string) => values.get(key) ?? null,
    save: (key: string, value: string) => { values.set(key, value); },
    saveSecret: (key: string, value: string) => { values.set(key, value); },
    listByPrefix: (prefix: string) => [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
  } as unknown as PairingSettings;
  return { values, store };
}
function productionContext(f: ReturnType<typeof setup>, db: TestDatabase, stateDb: TestDatabase, path: string): SyncContext {
  const databases = new Map([['vfs', db], ['sync_state', stateDb], ...['llm_usage', 'chat_v2', 'mistakes'].map(name => [name, reopen(`${path}.${name}`)] as const)]);
  const root = JSON.stringify({ repoId: 'repo', kCid: Buffer.from(f.secrets.kCid).toString('hex'),
    masterKeys: [...f.secrets.masterKeys].map(([epoch, key]) => [epoch, Buffer.from(key).toString('hex')]), contentEpoch: 0 });
  return {
    vfsDatabase: { isInMaintenanceMode: () => false },
    backup: { hydrateCloudConfig: vi.fn(), syncCommandPorts: () => ({ limiter: { tryAcquire: () => ({ release: vi.fn() }) }, saveSyncAudit: vi.fn(), loadHydratedCloudConfig: async () => ({ provider: 's3' }) }) },
    paths: { deviceId: async () => 'production' }, reflect: { get: () => settings({ 'cloud_sync.v5_root': root }).store },
    syncProvider: { createStorage: async () => f.storage, setCancelToken: vi.fn(), clearCancelToken: vi.fn(), isSyncCancelled: () => false },
    storage: { database: (name: string) => databases.get(name),
      pathOf: (name: string) => name === 'vfs' ? path : `${path}.${name}`, openFile: (file: string) => reopen(file), close },
    sync: { markSyncedWithTimestamp: (target: TestDatabase, ids: number[]) => { for (const id of ids) target.run('UPDATE __change_log SET sync_version=1 WHERE id=?', [id]); } },
    logger: () => ({ warn: vi.fn() }),
  } as unknown as SyncContext;
}
function localLogs(db: TestDatabase): void {
  db.exec(`CREATE TABLE __change_log(id INTEGER PRIMARY KEY,table_name TEXT,record_id TEXT,operation TEXT,changed_at TEXT,sync_version INTEGER);
    CREATE TRIGGER local_insert AFTER INSERT ON notes BEGIN
      INSERT INTO __change_log(table_name,record_id,operation,changed_at,sync_version) VALUES('notes',NEW.id,'INSERT','2026-01-01',0);
    END;
    CREATE TRIGGER local_update AFTER UPDATE ON notes BEGIN
      INSERT INTO __change_log(table_name,record_id,operation,changed_at,sync_version) VALUES('notes',NEW.id,'UPDATE','2026-01-01',0);
    END;`);
}
const productionPorts = { tombstones: {}, workspaceCoordinator: null } as LocalSyncCommandPorts;

describe('Sync V5 production SQLite/Host bridge', () => {
  it('commits identities before independent-file capture and retries partial capture without HistoryForkError', async () => {
    const f = setup(), target = f.device('B');
    const statePath = diskPath('state.db'), vfsPath = diskPath('vfs.db');
    let state = reopen(statePath), vfs = database(2, vfsPath);
    state.exec('CREATE TABLE __sync_v5_runtime_ops(repo TEXT NOT NULL,device TEXT NOT NULL,incarnation TEXT NOT NULL,seq TEXT NOT NULL,payload TEXT NOT NULL,published INTEGER NOT NULL,PRIMARY KEY(repo,device,incarnation,seq))');
    const options = () => ({ repoId: 'repo', deviceId: 'disk', stateDb: state, databases: new Map([['vfs', vfs]]), storage: f.storage, secrets: f.secrets, now: () => 1000 });
    let sender = new SyncV5RuntimeCoordinator(options());
    const inputs = [change('one'), change('two')].map((input, i) => ({ ...input, change_log_id: i + 1 }));
    state.exec(`CREATE TRIGGER reject_binding BEFORE INSERT ON __sync_v5_change_log_bindings_v2 WHEN NEW.change_log_id='2'
      BEGIN SELECT RAISE(ABORT,'enqueue rollback'); END;`);
    await expect(sender.publishChangesToV5Cloud(inputs)).rejects.toThrow('enqueue rollback');
    expect(state.pluck('SELECT seq FROM __sync_v5_runtime_state')).toBe('0');
    expect(vfs.pluck('SELECT count(*) FROM __sync_applied_ops')).toBe(0);
    state.exec('DROP TRIGGER reject_binding');
    state.exec(`CREATE TRIGGER reject_capture_marker BEFORE UPDATE OF local_captured ON __sync_v5_runtime_ops
      BEGIN SELECT RAISE(ABORT,'marker interrupted'); END;`);
    await expect(sender.publishChangesToV5Cloud(inputs)).rejects.toThrow('marker interrupted');
    const frozen = state.all('SELECT seq,payload FROM __sync_v5_runtime_ops ORDER BY seq');
    expect(vfs.pluck('SELECT count(*) FROM __sync_applied_ops')).toBe(1);
    expect(state.pluck('SELECT sum(local_captured) FROM __sync_v5_runtime_ops')).toBe(0);
    state.exec('DROP TRIGGER reject_capture_marker');
    vfs.exec(`CREATE TRIGGER reject_capture BEFORE INSERT ON __sync_applied_ops WHEN NEW.source_seq=2
      BEGIN SELECT RAISE(ABORT,'capture interrupted'); END;`);
    await expect(sender.publishChangesToV5Cloud(inputs)).rejects.toThrow('capture interrupted');
    expect(state.all('SELECT seq,payload FROM __sync_v5_runtime_ops ORDER BY seq')).toEqual(frozen);
    expect(frozen).toHaveLength(2);
    expect(state.all('SELECT local_captured FROM __sync_v5_runtime_ops ORDER BY seq')).toEqual([{ local_captured: 1 }, { local_captured: 0 }]);
    vfs.exec('DROP TRIGGER reject_capture');
    close(state); close(vfs); state = reopen(statePath); vfs = reopen(vfsPath);
    sender = new SyncV5RuntimeCoordinator(options());
    expect(await sender.publishChangesToV5Cloud(inputs)).toEqual({ published: 2 });
    expect(state.all('SELECT seq,payload FROM __sync_v5_runtime_ops ORDER BY seq')).toEqual(frozen);
    expect((await target.sync.pullAndApplyFromV5Cloud()).applied).toBe(2);
  });

  for (const production of [false, true]) it(`isolates mixed oversize changes without blocking successive normal edits (${production ? 'runSyncV5 both' : 'direct'})`, async () => {
    const f = setup(), b = f.device('B');
    const path = diskPath('mixed.db'), db = database(2, path), state = reopen(diskPath('state.db'));
    const sender = new SyncV5RuntimeCoordinator({ repoId: 'repo', deviceId: 'production', stateDb: state, databases: new Map([['vfs', db]]), storage: f.storage, secrets: f.secrets, maxPackPlaintextBytes: 1024 });
    if (production) localLogs(db);
    const ctx = productionContext(f, db, state, path);
    const big = 'x'.repeat(production ? 4 * 1024 * 1024 + 1 : 2048);
    if (production) {
      db.run("INSERT INTO notes(id,title) VALUES('normal1','first'),('big',?)", [big]);
      const result = await runSyncV5(ctx, productionPorts, 'both');
      expect(result.changes_uploaded).toBe(1); expect(result.skipped_changes).toBe(1);
    } else expect(await sender.publishChangesToV5Cloud([change('normal1', { title: 'first' }), change('big', { title: big })])).toEqual({ published: 1 });
    expect((await b.sync.pullAndApplyFromV5Cloud()).applied).toBe(1);
    expect(b.db.pluck("SELECT title FROM notes WHERE id='normal1'")).toBe('first');
    if (production) {
      db.run("INSERT INTO notes(id,title) VALUES('normal2','second')");
      const result = await runSyncV5(ctx, productionPorts, 'both');
      expect(result.changes_uploaded).toBe(1); expect(result.skipped_changes).toBe(0);
      expect(db.pluck('SELECT count(*) FROM __change_log WHERE sync_version=0')).toBe(0);
    } else expect(await sender.publishChangesToV5Cloud([change('big', { title: big }), change('normal2', { title: 'second' })])).toEqual({ published: 1 });
    expect((await b.sync.pullAndApplyFromV5Cloud()).applied).toBe(1);
    expect(b.db.pluck("SELECT title FROM notes WHERE id='normal2'")).toBe('second');
    expect(state.pluck('SELECT count(*) FROM __sync_v5_oversize_quarantine')).toBe(1);
    expect(state.pluck('SELECT count(*) FROM __sync_v5_runtime_ops')).toBe(2);
    expect(state.pluck('SELECT seq FROM __sync_v5_runtime_state')).toBe('2');
  });

  for (const production of [false, true]) it(`protects an edit during upload before applying an older remote concurrent version (${production ? 'runSyncV5 both' : 'direct'})`, async () => {
    const f = setup(), b = f.device('B');
    f.advance(2000);
    await b.sync.publishChangesToV5Cloud([change('r', { title: 'remote-v1.5' })]);
    f.advance(1000);
    const path = diskPath('editing.db'), db = database(2, path), state = reopen(diskPath('state.db'));
    localLogs(db); db.run("INSERT INTO notes(id,title) VALUES('r','local-v1')");
    let time = 1000;
    const clock = production ? vi.spyOn(Date, 'now').mockImplementation(() => time) : null;
    try {
      const sender = new SyncV5RuntimeCoordinator({ repoId: 'repo', deviceId: 'production', stateDb: state, databases: new Map([['vfs', db]]), storage: f.storage, secrets: f.secrets, now: () => time });
      const ctx = productionContext(f, db, state, path);
      const put = f.storage.put.bind(f.storage); let edited = false;
      f.storage.put = async (key, bytes) => {
        if (!edited && key.endsWith('.pack')) {
          edited = true; time = 3000;
          db.run("UPDATE notes SET title='local-v3' WHERE id='r'");
        }
        return put(key, bytes);
      };
      if (production) await runSyncV5(ctx, productionPorts, 'both');
      else {
        await sender.publishChangesToV5Cloud([{ ...change('r', { title: 'local-v1' }), change_log_id: 1 }]);
        db.run('UPDATE __change_log SET sync_version=1 WHERE id=1');
        await sender.pullAndApplyFromV5Cloud();
      }
      expect(edited).toBe(true);
      expect(db.pluck("SELECT title FROM notes WHERE id='r'")).toBe('local-v3');
      expect(state.pluck('SELECT count(*) FROM __sync_v5_runtime_ops WHERE published=0')).toBe(1);
      if (production) await runSyncV5(ctx, productionPorts, 'both');
      else await sender.publishChangesToV5Cloud([]);
      await b.sync.pullAndApplyFromV5Cloud();
      expect(b.db.pluck("SELECT title FROM notes WHERE id='r'")).toBe('local-v3');
    } finally { clock?.mockRestore(); }
  });

  it('rejects a 48-bit overflowing column HLC before opening a business transaction', async () => {
    const f = setup(), a = f.device('A'), b = f.device('B');
    f.storage.failHead = true;
    await expect(a.sync.publishChangesToV5Cloud([change()])).rejects.toThrow('network interrupted');
    const op = JSON.parse(a.db.pluck<string>('SELECT payload FROM __sync_v5_runtime_ops')!);
    op.versions.title.hlc = '999999999999999-00000';
    a.db.run('UPDATE __sync_v5_runtime_ops SET payload=?', [JSON.stringify(op)]);
    await a.sync.publishChangesToV5Cloud([]);
    const transaction = vi.spyOn(b.db, 'transaction');
    await expect(b.sync.pullAndApplyFromV5Cloud()).rejects.toThrow('Invalid remote V5 column HLC');
    expect(transaction).not.toHaveBeenCalled();
    expect(b.db.pluck('SELECT count(*) FROM notes')).toBe(0);
    expect(b.db.pluck('SELECT count(*) FROM __sync_row_meta')).toBe(0);
    expect(b.db.pluck('SELECT count(*) FROM __sync_applied_ops')).toBe(0);
  });

  it('never rewrites a captured local snapshot after an asynchronous upload; the next edit publishes intact', async () => {
    const f = setup(), a = f.device('A'), b = f.device('B');
    a.db.run("INSERT INTO notes(id,title,future) VALUES('r','v1','first')");
    const put = f.storage.put.bind(f.storage);
    let edited = false;
    f.storage.put = async (key, bytes) => {
      if (!edited && key.endsWith('.pack')) {
        edited = true;
        await Promise.resolve();
        a.db.run("UPDATE notes SET title='v2',future='second' WHERE id='r'");
      }
      return put(key, bytes);
    };
    await a.sync.publishChangesToV5Cloud([{ ...change('r', { title: 'v1', future: 'first' }), change_log_id: 1 }]);
    expect(a.db.get("SELECT title,future FROM notes WHERE id='r'")).toEqual({ title: 'v2', future: 'second' });
    await a.sync.publishChangesToV5Cloud([{ ...change('r', { title: 'v2', future: 'second' }, 'vfs', 'notes', 'Update'), change_log_id: 2 }]);
    expect((await b.sync.pullAndApplyFromV5Cloud()).applied).toBe(2);
    expect(b.db.get("SELECT title,future FROM notes WHERE id='r'")).toEqual({ title: 'v2', future: 'second' });
  });

  it('binds derived note dependencies by entity and reuses both source sequences after an upload failure', async () => {
    const f = setup(), a = f.device('A'), b = f.device('B');
    for (const d of [a, b]) d.db.exec('CREATE TABLE note_formats(id TEXT PRIMARY KEY,title TEXT)');
    const inputs = [change('note', { title: 'parent' }), change('format', { title: 'derived' }, 'vfs', 'note_formats')]
      .map(input => ({ ...input, change_log_id: 42 }));
    f.storage.failHead = true;
    await expect(a.sync.publishChangesToV5Cloud(inputs)).rejects.toThrow('network interrupted');
    const before = a.db.all('SELECT seq,payload FROM __sync_v5_runtime_ops ORDER BY seq');
    expect(before).toHaveLength(2);
    const restarted = new SyncV5RuntimeCoordinator(a.options);
    expect(await restarted.publishChangesToV5Cloud(inputs)).toEqual({ published: 2 });
    expect(a.db.all('SELECT seq,payload FROM __sync_v5_runtime_ops ORDER BY seq')).toEqual(before);
    expect(a.db.pluck('SELECT seq FROM __sync_v5_runtime_state')).toBe('2');
    expect((await b.sync.pullAndApplyFromV5Cloud()).applied).toBe(2);
    expect(b.db.pluck('SELECT title FROM notes')).toBe('parent');
    expect(b.db.pluck('SELECT title FROM note_formats')).toBe('derived');
  });

  for (const delayedParent of [false, true]) it(`converges cross-device foreign keys with ${delayedParent ? 'a missing parent head and durable replay' : 'child-first head enumeration'}`, async () => {
    const f = setup(), a = f.device('A'), b = f.device('B'), c = f.device('C');
    for (const d of [a, b, c]) d.db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE resources(id TEXT PRIMARY KEY,title TEXT);
      ALTER TABLE notes ADD COLUMN resource_id TEXT REFERENCES resources(id);`);
    b.db.run("INSERT INTO resources VALUES('parent','resource')");
    await b.sync.publishChangesToV5Cloud([change('parent', { title: 'resource' }, 'vfs', 'resources')]);
    await a.sync.pullAndApplyFromV5Cloud();
    a.db.run("INSERT INTO notes(id,title,resource_id) VALUES('child','note','parent')");
    await a.sync.publishChangesToV5Cloud([change('child', { title: 'note', resource_id: 'parent' })]);
    const list = f.storage.list.bind(f.storage);
    f.storage.list = async prefix => (await list(prefix)).sort((x, y) => x.key.localeCompare(y.key));
    const parentHead = f.storage.keys().find(key => key.includes('/heads/B_'))!;
    const bytes = f.storage.bytes(parentHead)!;
    if (delayedParent) {
      f.storage.files.delete(parentHead);
      expect((await c.sync.pullAndApplyFromV5Cloud()).applied).toBe(0);
      expect(c.db.pluck('SELECT count(*) FROM __sync_quarantine_records')).toBe(1);
      expect(c.db.pluck('SELECT count(*) FROM __sync_v5_runtime_receipts')).toBe(0);
      expect(c.db.pluck('SELECT materialization_state FROM __sync_applied_ops')).toBe('pending_fk');
      await f.storage.put(parentHead, bytes);
    }
    // Reconstructing the coordinator proves replay does not depend on an in-memory queue.
    const receiver = delayedParent ? new SyncV5RuntimeCoordinator(c.options) : c.sync;
    expect((await receiver.pullAndApplyFromV5Cloud()).applied).toBe(2);
    expect(c.db.get("SELECT n.title,r.title AS resource FROM notes n JOIN resources r ON n.resource_id=r.id"))
      .toEqual({ title: 'note', resource: 'resource' });
    expect(c.db.pluck('SELECT count(*) FROM __sync_quarantine_records')).toBe(0);
  });

  it('does not observe receipts before the SQLite acknowledgement transaction commits', async () => {
    const f = setup(), a = f.device('A'), b = f.device('B');
    await a.sync.publishChangesToV5Cloud([change()]);
    b.db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON __sync_v5_runtime_receipts BEGIN SELECT RAISE(ABORT,'receipt rollback'); END");
    await expect(b.sync.pullAndApplyFromV5Cloud()).rejects.toThrow('receipt rollback');
    expect(b.sync.intervals.has(`A@${a.sync.incarnationId}`, 1n)).toBe(false);
    expect(b.sync.versionVector.get(`A@${a.sync.incarnationId}`)).toBeUndefined();
    expect(b.db.pluck('SELECT count(*) FROM __sync_v5_runtime_receipts')).toBe(0);
    b.db.exec('DROP TRIGGER reject_receipt');
    expect((await b.sync.pullAndApplyFromV5Cloud()).applied).toBe(1);
    expect(b.sync.intervals.has(`A@${a.sync.incarnationId}`, 1n)).toBe(true);
  });

  it('persists failed index GC and retries it on an empty publication after restart', async () => {
    const f = setup(), a = f.device('A');
    const sender = new SyncV5RuntimeCoordinator({ ...a.options, supersededRetentionGenerations: 0 });
    const remove = f.storage.delete.bind(f.storage);
    f.storage.delete = async () => { throw new Error('DELETE unavailable'); };
    for (let i = 0; i < 10; i++) await sender.publishChangesToV5Cloud([change(String(i))]);
    const garbage = a.db.all<{ obj_key: string }>('SELECT obj_key FROM __sync_v5_pending_gc');
    expect(garbage.length).toBeGreaterThan(0);
    f.storage.delete = remove;
    const restarted = new SyncV5RuntimeCoordinator(a.options);
    expect(await restarted.publishChangesToV5Cloud([])).toEqual({ published: 0 });
    expect(a.db.pluck('SELECT count(*) FROM __sync_v5_pending_gc')).toBe(0);
    for (const row of garbage) expect(f.storage.keys()).not.toContain(row.obj_key);
  });

  it('does not observe local publication when its durable receipt transaction rolls back', async () => {
    const f = setup(), a = f.device('A'), b = f.device('B');
    a.db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON __sync_v5_runtime_receipts BEGIN SELECT RAISE(ABORT,'publication rollback'); END");
    await expect(a.sync.publishChangesToV5Cloud([change()])).rejects.toThrow('publication rollback');
    expect(a.db.pluck('SELECT published FROM __sync_v5_runtime_ops')).toBe(0);
    expect(a.sync.intervals.has(`A@${a.sync.incarnationId}`, 1n)).toBe(false);
    expect(a.sync.versionVector.get(`A@${a.sync.incarnationId}`)?.contiguousSeq).toBe(0n);
    a.db.exec('DROP TRIGGER reject_receipt');
    expect(await a.sync.publishChangesToV5Cloud([])).toEqual({ published: 1 });
    expect((await b.sync.pullAndApplyFromV5Cloud()).applied).toBe(1);
    expect(f.storage.keys().filter(key => key.endsWith('.pack'))).toHaveLength(1);
  });

  it('isolates a historical oversized outbox row without blocking a normal publication', async () => {
    const f = setup(), a = f.device('A'), b = f.device('B');
    f.storage.failHead = true;
    await expect(a.sync.publishChangesToV5Cloud([change('big', { title: 'x'.repeat(2048) })])).rejects.toThrow('network interrupted');
    const sender = new SyncV5RuntimeCoordinator({ ...a.options, maxPackPlaintextBytes: 1024 });
    expect(await sender.publishChangesToV5Cloud([change('small')])).toEqual({ published: 1 });
    expect(a.db.all('SELECT seq,published FROM __sync_v5_runtime_ops ORDER BY seq')).toEqual([
      { seq: '1', published: -1 }, { seq: '2', published: 1 },
    ]);
    expect((await b.sync.pullAndApplyFromV5Cloud()).applied).toBe(1);
    expect(b.db.pluck('SELECT title FROM notes')).toBe('hello');
  });

  it('does not poison the writable local clock with a remote year-2099 HLC', async () => {
    const f = setup(), a = f.device('A'), b = f.device('B');
    const receiver = new SyncV5RuntimeCoordinator({ ...b.options, now: () => 1000 });
    f.advance(Date.UTC(2099, 0, 1));
    await a.sync.publishChangesToV5Cloud([change()]);
    await receiver.pullAndApplyFromV5Cloud();
    expect(Hlc.parse(b.db.pluck<string>('SELECT hlc FROM __sync_v5_runtime_state')!)!.millis).toBe(1000n);
    await receiver.publishChangesToV5Cloud([change('local')]);
    expect(Hlc.parse(b.db.pluck<string>('SELECT hlc FROM __sync_v5_runtime_state')!)!.millis).toBe(1000n);
  });

  it('rejects malformed remote HLC before committing business data', async () => {
    const f = setup(), a = f.device('A'), b = f.device('B');
    f.storage.failHead = true;
    await expect(a.sync.publishChangesToV5Cloud([change()])).rejects.toThrow();
    const op = JSON.parse(a.db.pluck<string>('SELECT payload FROM __sync_v5_runtime_ops')!);
    op.change = JSON.stringify({ ...JSON.parse(op.change), changed_at: 'invalid' });
    a.db.run('UPDATE __sync_v5_runtime_ops SET payload=?', [JSON.stringify(op)]);
    await a.sync.publishChangesToV5Cloud([]);
    await expect(b.sync.pullAndApplyFromV5Cloud()).rejects.toThrow('Invalid remote V5 HLC');
    expect(b.db.pluck('SELECT count(*) FROM notes')).toBe(0);
    expect(b.db.pluck('SELECT count(*) FROM __sync_applied_ops')).toBe(0);
    expect(b.db.pluck('SELECT count(*) FROM __sync_v5_runtime_receipts')).toBe(0);
  });

  it('splits >48 KiB into bounded packs referenced by one delta and pulls every row over FTP', async () => {
    const ftp = await spawnFakeFtp();
    try {
      const storage = new FtpStorage({ host: ftp.host, port: ftp.port, useTls: false, username: 'local', password: 'local' }, 'bridge');
      const secrets = { kCid: randomBytes(32), masterKeys: new Map([[0, randomBytes(32)]]) };
      const source = database(2, diskPath('source.db')), target = database(2, diskPath('target.db'));
      const options = { repoId: 'multi', storage, secrets, maxPackPlaintextBytes: 16 * 1024 };
      const sender = new SyncV5RuntimeCoordinator({ ...options, deviceId: 'A', stateDb: source, databases: new Map([['vfs', source]]) });
      const receiver = new SyncV5RuntimeCoordinator({ ...options, deviceId: 'B', stateDb: target, databases: new Map([['vfs', target]]) });
      const changes = Array.from({ length: 12 }, (_, i) => change(`row-${i}`, { title: `${i}-${'数据'.repeat(900)}` }));
      expect(await sender.publishChangesToV5Cloud(changes)).toEqual({ published: 12 });
      const packs = (await storage.list('sync-v5/multi/packs/')).filter(info => info.key.endsWith('.pack'));
      expect(packs.length).toBeGreaterThan(3);
      for (const pack of packs) {
        expect(Number(pack.size)).toBeLessThanOrEqual(16 * 1024);
        expect(Number(pack.size)).toBeLessThan(FTP_RANGE_MAX_OBJECT_BYTES);
      }
      const indices = (await storage.list('sync-v5/multi/indices/')).filter(info => info.key.includes('/delta_'));
      expect(indices).toHaveLength(1);
      const unseal = sender as unknown as { unseal(bytes: Uint8Array): { binary: string } };
      const index = decodeShardedIndex(Buffer.from(unseal.unseal((await storage.get(indices[0]!.key))!).binary, 'base64'));
      expect([...index.packKeys].sort()).toEqual(packs.map(pack => pack.key).sort());
      expect(new Set(index.entries.map(entry => entry.packTableIndex)).size).toBe(packs.length);
      expect(index.entries).toHaveLength(12);
      expect(await receiver.pullAndApplyFromV5Cloud()).toEqual({ applied: 12, downloadedEntries: 12 });
      for (const input of changes) expect(target.pluck('SELECT title FROM notes WHERE id=?', [input.record_id])).toBe((input.data as { title: string }).title);
      expect(await receiver.pullAndApplyFromV5Cloud()).toEqual({ applied: 0, downloadedEntries: 0 });
    } finally { await ftp.server.close(); }
  });

  it('rejects an oversized atomic operation before uploading any pack', async () => {
    const f = setup(), a = f.device('A');
    const sender = new SyncV5RuntimeCoordinator({ ...a.options, maxPackPlaintextBytes: 1024 });
    await expect(sender.publishChangesToV5Cloud([change('big', { title: 'x'.repeat(2048) })])).rejects.toThrow('exceeds pack plaintext limit');
    expect(f.storage.keys().filter(key => key.endsWith('.pack') || key.includes('/heads/'))).toEqual([]);
    expect(a.db.pluck('SELECT count(*) FROM __sync_v5_runtime_ops')).toBe(0);
    expect(await sender.publishChangesToV5Cloud([change('small')])).toEqual({ published: 1 });
    const receiver = f.device('B');
    expect((await receiver.sync.pullAndApplyFromV5Cloud()).applied).toBe(1);
    expect(receiver.db.pluck("SELECT title FROM notes WHERE id='small'")).toBe('hello');
  });

  it('runs the production V5 entry through config, permit, collection, publication, download and audit', async () => {
    const f = setup(), a = f.device('A');
    await a.sync.publishChangesToV5Cloud([change('remote')]);
    const path = diskPath('production.db'), db = database(2, path);
    db.exec(`CREATE TABLE __change_log(id INTEGER PRIMARY KEY,table_name TEXT,record_id TEXT,operation TEXT,changed_at TEXT,sync_version INTEGER);
      INSERT INTO notes(id,title) VALUES('local','production');
      INSERT INTO __change_log VALUES(1,'notes','local','INSERT','2026-01-01',0);
      CREATE TRIGGER notes_insert AFTER INSERT ON notes BEGIN
        INSERT INTO __change_log(table_name,record_id,operation,changed_at,sync_version) VALUES('notes',NEW.id,'INSERT','2026-01-01',0);
      END;`);
    const release = vi.fn(), acquire = vi.fn(() => ({ release })), audit = vi.fn();
    const config = { provider: 's3' as const }, load = vi.fn(async () => config), createStorage = vi.fn(async () => f.storage);
    const root = JSON.stringify({ repoId: 'repo', kCid: Buffer.from(f.secrets.kCid).toString('hex'),
      masterKeys: [...f.secrets.masterKeys].map(([epoch, key]) => [epoch, Buffer.from(key).toString('hex')]), contentEpoch: 0 });
    const ctx = {
      vfsDatabase: { isInMaintenanceMode: () => false },
      backup: { hydrateCloudConfig: vi.fn(), syncCommandPorts: () => ({ limiter: { tryAcquire: acquire }, saveSyncAudit: audit, loadHydratedCloudConfig: load }) },
      paths: { deviceId: async () => 'production' }, reflect: { get: () => settings({ 'cloud_sync.v5_root': root }).store },
      syncProvider: { createStorage, setCancelToken: vi.fn(), clearCancelToken: vi.fn(), isSyncCancelled: () => false },
      storage: { database: () => db, pathOf: (name: string) => name === 'vfs' ? path : `${path}.${name}`,
        openFile: (file: string) => reopen(file), close },
      sync: { markSyncedWithTimestamp: (target: TestDatabase, ids: number[]) => { for (const id of ids) target.run('UPDATE __change_log SET sync_version=1 WHERE id=?', [id]); } },
      logger: () => ({ warn: vi.fn() }),
    } as unknown as SyncContext;
    const local = { tombstones: {}, workspaceCoordinator: null } as LocalSyncCommandPorts;
    f.storage.failHead = true;
    await expect(runSyncV5(ctx, local, 'both', null)).rejects.toThrow('network interrupted');
    expect(db.pluck('SELECT count(*) FROM __change_log WHERE sync_version=0')).toBe(1);
    expect(db.pluck('SELECT count(*) FROM __sync_v5_runtime_ops')).toBe(1);
    expect(db.pluck('SELECT seq FROM __sync_v5_runtime_state WHERE device=?', ['production'])).toBe('1');
    const result = await runSyncV5(ctx, local, 'both', null);
    expect(result.changes_uploaded).toBe(1); expect(result.changes_downloaded).toBe(1);
    expect(db.pluck('SELECT count(*) FROM __sync_v5_runtime_ops')).toBe(1);
    expect(db.pluck('SELECT seq FROM __sync_v5_runtime_state WHERE device=?', ['production'])).toBe('1');
    expect(db.all('SELECT id FROM notes ORDER BY id')).toEqual([{ id: 'local' }, { id: 'remote' }]);
    expect(db.pluck('SELECT count(*) FROM __change_log WHERE sync_version=0')).toBe(0);
    expect(load).toHaveBeenCalledTimes(2); expect(createStorage).toHaveBeenCalledWith(config);
    expect(release).toHaveBeenCalledTimes(2);
    expect(audit.mock.calls.map(([entry]) => entry.outcome.kind)).toEqual(['started', 'failed', 'started', 'complete']);
    const second = await runSyncV5(ctx, local, 'both', config);
    expect(second.changes_uploaded).toBe(0); expect(second.changes_downloaded).toBe(0);
    acquire.mockReturnValueOnce(null as never);
    await expect(runSyncV5(ctx, local, 'both', config)).rejects.toThrow('正在进行中');
    expect(createStorage).toHaveBeenCalledTimes(3);
    createStorage.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(runSyncV5(ctx, local, 'both', config)).rejects.toThrow('provider unavailable');
    expect(release).toHaveBeenCalledTimes(4);
    expect(audit.mock.calls.at(-1)?.[0].outcome.kind).toBe('failed');
  });

  it('preserves full-row offline edits to different known columns on both devices and a fresh bootstrap', async () => {
    const f = setup(), a = f.device('A'), b = f.device('B'), c = f.device('C');
    for (const device of [a, b, c]) device.db.exec('ALTER TABLE notes ADD COLUMN summary TEXT');
    a.db.run("INSERT INTO notes(id,title,summary) VALUES('r','initial','initial')");
    await a.sync.publishChangesToV5Cloud([change('r', { title: 'initial', summary: 'initial' })]);
    await b.sync.pullAndApplyFromV5Cloud();
    a.db.run("UPDATE notes SET title='A title'"); b.db.run("UPDATE notes SET summary='B summary'");
    f.advance(2000);
    await a.sync.publishChangesToV5Cloud([change('r', { title: 'A title', summary: 'initial' }, 'vfs', 'notes', 'Update')]);
    f.advance(3000);
    await b.sync.publishChangesToV5Cloud([change('r', { title: 'initial', summary: 'B summary' }, 'vfs', 'notes', 'Update')]);
    await a.sync.pullAndApplyFromV5Cloud(); await b.sync.pullAndApplyFromV5Cloud(); await c.sync.pullAndApplyFromV5Cloud();
    for (const device of [a, b, c]) {
      expect(device.db.get('SELECT title,summary FROM notes')).toEqual({ title: 'A title', summary: 'B summary' });
      expect(device.db.pluck('SELECT count(*) FROM __sync_v5_column_versions')).toBe(2);
    }
  });

  it('recovers disk outbox, HLC, column versions and receipts after closing every SQLite handle', async () => {
    const f = setup(), path = diskPath('persistent.db'), db = database(2, path);
    const options = { repoId: 'repo', deviceId: 'disk', stateDb: db, databases: new Map([['vfs', db]]), storage: f.storage, secrets: f.secrets };
    const first = new SyncV5RuntimeCoordinator(options);
    db.run("INSERT INTO notes(id,title) VALUES('r','hello')");
    f.storage.failHead = true;
    await expect(first.publishChangesToV5Cloud([change()])).rejects.toThrow('network interrupted');
    close(db);
    const restored = reopen(path);
    const runtime = new SyncV5RuntimeCoordinator({ ...options, stateDb: restored, databases: new Map([['vfs', restored]]) });
    expect(runtime.incarnationId).toBe(first.incarnationId);
    await runtime.publishChangesToV5Cloud([]);
    close(restored);
    // Separate Electron/Node process proves the database, not JS memory, owns recovery state.
    const counts = execFileSync(process.execPath, ['-e', `const D=require('better-sqlite3');const db=new D(process.argv[1]);console.log(JSON.stringify([db.prepare('SELECT count(*) n FROM notes').get().n,db.prepare('SELECT count(*) n FROM __sync_v5_column_versions').get().n,db.prepare('SELECT count(*) n FROM __sync_v5_runtime_receipts').get().n]));db.close()`, path],
      { cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
    expect(JSON.parse(counts.trim())).toEqual([1, 1, 1]);
    const again = reopen(path);
    const resumed = new SyncV5RuntimeCoordinator({ ...options, stateDb: again, databases: new Map([['vfs', again]]) });
    expect(await resumed.pullAndApplyFromV5Cloud()).toEqual({ applied: 0, downloadedEntries: 0 });
  });

  it('rereads a newer head when compaction deletes an index after the reader captured the old head', async () => {
    const f = setup(), a = f.device('A'), b = f.device('B');
    const writer = new SyncV5RuntimeCoordinator({ ...a.options, supersededRetentionGenerations: 0 });
    await writer.publishChangesToV5Cloud([change('0')]);
    const oldIndices = f.storage.keys().filter(key => key.endsWith('.dsix'));
    const originalGet = f.storage.get.bind(f.storage);
    let raced = false, reads = 0;
    f.storage.get = async key => {
      const bytes = await originalGet(key);
      if (key.includes('/heads/')) {
        reads++;
        if (!raced) {
          raced = true;
          for (let i = 1; i <= 9; i++) await writer.publishChangesToV5Cloud([change(String(i))]);
        }
      }
      return bytes;
    };
    expect((await b.sync.pullAndApplyFromV5Cloud()).applied).toBe(10);
    expect(reads).toBeGreaterThan(1);
    for (const key of oldIndices) expect(f.storage.keys()).not.toContain(key);
    expect(b.db.pluck('SELECT count(*) FROM notes')).toBe(10);
  });

  it('retains two compaction generations across writer restarts and keeps head metadata bounded', async () => {
    const f = setup(), a = f.device('A');
    await a.sync.publishChangesToV5Cloud([change('0')]);
    const initialIndices = f.storage.keys().filter(key => key.endsWith('.dsix'));
    for (let i = 1; i < 19; i++) {
      const writer = new SyncV5RuntimeCoordinator(a.options);
      await writer.publishChangesToV5Cloud([change(String(i))]);
    }
    for (const key of initialIndices) expect(f.storage.keys()).toContain(key);
    for (let i = 19; i < 37; i++) await a.sync.publishChangesToV5Cloud([change(String(i))]);
    for (const key of initialIndices) expect(f.storage.keys()).not.toContain(key);
    const head = f.storage.keys().find(key => key.includes('/heads/'))!;
    const unseal = a.sync as unknown as { unseal(bytes: Uint8Array): { refs?: unknown[] } };
    expect(unseal.unseal(f.storage.bytes(head)!).refs).toBeUndefined();
    const c = f.device('C');
    expect((await c.sync.pullAndApplyFromV5Cloud()).applied).toBe(37);
  });

  it('rejects a forged pairing anchor before receiving business data or saving keys', async () => {
    const f = setup(), a = f.device('A');
    await a.sync.publishChangesToV5Cloud([change()]);
    const offer = await a.sync.createPairingOfferV5({ sourceSettings: settings().store, anchor: await a.sync.pairingAnchorV5('b'.repeat(64)), cloudConfig: { provider: 's3' } });
    const decoded = decodeDSPAIR2Pairing(offer.packet, offer.secret);
    decoded.repoHeadAnchor.repoHeadSha256 = createHash('sha256').update('forged').digest('hex');
    const forged = createDSPAIR2Pairing(decoded);
    const db = database(2, diskPath('rejected.db')), target = settings();
    await expect(pairAndBootstrapDeviceV5({ ...forged, pin: offer.pin, targetSettings: target.store,
      target: { deviceId: 'C', stateDb: db, databases: new Map([['vfs', db]]) }, createStorage: async () => f.storage })).rejects.toThrow('anchor mismatch');
    expect(db.pluck('SELECT count(*) FROM notes')).toBe(0);
    expect(target.values.size).toBe(0);
  });

  it('preserves native range readers and supports legacy providers without native ranges', async () => {
    const native = new RangeStorage(); expect(storageWithV5Ranges(native)).toBe(native);
    const legacy = new MemoryStorage(); await legacy.put('pack', new Uint8Array([1, 2, 3, 4]));
    expect(await storageWithV5Ranges(legacy).getRange('pack', 1, 2)).toEqual(new Uint8Array([2, 3]));
  });

  it('keeps explicit per-column causal versions and never treats field metadata as a business column', async () => {
    const f = setup(), a = f.device('A'), b = f.device('B');
    await a.sync.publishChangesToV5Cloud([change()]);
    const version = a.db.one<{ col_hlc: string; col_dev: string }>('SELECT * FROM __sync_v5_column_versions');
    f.advance(9000);
    await a.sync.publishChangesToV5Cloud([change('r', { title: 'hello', __sync_field_deltas: { title: { hlc: version.col_hlc, dev: version.col_dev } } }, 'vfs', 'notes', 'Update')]);
    await b.sync.pullAndApplyFromV5Cloud();
    expect(b.db.one<{ col_hlc: string }>('SELECT * FROM __sync_v5_column_versions').col_hlc).toBe(version.col_hlc);
    expect(readUnknownFieldsForRoundTrip(b.db, 'notes', 'r').values).toEqual({});
  });

  it('bounds missing-index retries at three and does not acknowledge a damaged head', async () => {
    const f = setup(), a = f.device('A'), b = f.device('B');
    await a.sync.publishChangesToV5Cloud([change()]);
    const originalGet = f.storage.get.bind(f.storage);
    let headReads = 0;
    f.storage.get = async key => {
      if (key.includes('/heads/')) headReads++;
      if (key.endsWith('.dsix')) throw Object.assign(new Error('not found'), { value: { type: 'NotFound' } });
      return originalGet(key);
    };
    await expect(b.sync.pullAndApplyFromV5Cloud()).rejects.toThrow('Missing committed V5 index');
    expect(headReads).toBe(4);
    expect(b.db.pluck('SELECT count(*) FROM __sync_v5_runtime_receipts')).toBe(0);
  });

  it('applies each database route to its own SQLite connection', async () => {
    const f = setup(), a = f.device('A');
    const vfs = database(), chat = database(), mistakes = database();
    const b = new SyncV5RuntimeCoordinator({ ...a.options, deviceId: 'B', stateDb: vfs,
      databases: new Map([['vfs', vfs], ['chat_v2', chat], ['mistakes', mistakes]]) });
    await a.sync.publishChangesToV5Cloud([change('n'), change('c', { title: 'chat' }, 'chat_v2', 'chat_v2_sessions'),
      change('m', { title: 'mistake' }, 'mistakes', 'mistakes')]);
    expect((await b.pullAndApplyFromV5Cloud()).applied).toBe(3);
    expect(vfs.pluck('SELECT count(*) FROM notes')).toBe(1);
    expect(vfs.pluck('SELECT count(*) FROM chat_v2_sessions')).toBe(0);
    expect(chat.pluck('SELECT count(*) FROM chat_v2_sessions')).toBe(1);
    expect(chat.pluck('SELECT count(*) FROM mistakes')).toBe(0);
    expect(mistakes.pluck('SELECT count(*) FROM mistakes')).toBe(1);
    expect(mistakes.pluck('SELECT count(*) FROM notes')).toBe(0);
  });
  it('routes EngineChange batches across vfs, chat_v2, mistakes and third-party tables', async () => {
    const f = setup(), a = f.device('A'), b = f.device('B');
    await a.sync.publishChangesToV5Cloud([
      change('n', { title: '笔记' }), change('c', { title: '会话' }, 'chat_v2', 'chat_v2_sessions'),
      change('m', { title: '错题' }, 'mistakes', 'mistakes'), change('p', { title: '插件' }, 'vfs', 'plugin_cards'),
    ]);
    expect(await b.sync.pullAndApplyFromV5Cloud()).toEqual({ applied: 4, downloadedEntries: 4 });
    for (const table of ['notes', 'chat_v2_sessions', 'mistakes', 'plugin_cards']) expect(b.db.pluck(`SELECT count(*) FROM ${table}`)).toBe(1);
    expect(b.db.pluck('SELECT count(*) FROM __sync_applied_ops')).toBe(4);
  });

  it('converges v2 -> v1 known-column edit -> v2 without rewriting opaque register versions', async () => {
    const f = setup(), a = f.device('A'), b = f.device('B', 1), c = f.device('C');
    a.db.run('INSERT INTO notes(id,title,future) VALUES(?,?,?)', ['r', 'old', '新字段\u0000原文']);
    await a.sync.publishChangesToV5Cloud([change('r', { title: 'old', future: '新字段\u0000原文' })]);
    await b.sync.pullAndApplyFromV5Cloud();
    const before = readUnknownFieldsForRoundTrip(b.db, 'notes', 'r');
    expect(before.values.future).toBe('新字段\u0000原文');
    b.db.run("UPDATE notes SET title='edited by v1' WHERE id='r'");
    f.advance(2000);
    await b.sync.publishChangesToV5Cloud([change('r', { title: 'edited by v1' }, 'vfs', 'notes', 'Update')]);
    await a.sync.pullAndApplyFromV5Cloud(); await c.sync.pullAndApplyFromV5Cloud();
    const expected = { id: 'r', title: 'edited by v1', future: '新字段\u0000原文' };
    expect(a.db.get('SELECT * FROM notes')).toEqual(expected);
    expect(c.db.get('SELECT * FROM notes')).toEqual(expected);
    expect(readUnknownFieldsForRoundTrip(b.db, 'notes', 'r')).toEqual(before);
  });

  it('rehydrates v1 after ALTER TABLE with no repeat pack requests', async () => {
    const f = setup(), a = f.device('A'), b = f.device('B', 1);
    await a.sync.publishChangesToV5Cloud([change('r', { title: 'known', future: 'restored' })]);
    await b.sync.pullAndApplyFromV5Cloud();
    b.db.exec('ALTER TABLE notes ADD COLUMN future TEXT');
    f.storage.ranges = [];
    expect(await b.sync.pullAndApplyFromV5Cloud()).toEqual({ applied: 0, downloadedEntries: 0 });
    expect(b.db.get('SELECT title,future FROM notes')).toEqual({ title: 'known', future: 'restored' });
    expect(readUnknownFieldsForRoundTrip(b.db, 'notes', 'r').values).toEqual({});
    expect(f.storage.ranges).toEqual([]);
    const original = b.db.one<{ col_hlc: string }>("SELECT col_hlc FROM __sync_v5_column_versions WHERE col_name='future'");
    f.advance(9000);
    await b.sync.publishChangesToV5Cloud([change('r', { title: 'known', future: 'restored' }, 'vfs', 'notes', 'Update')]);
    expect(b.db.one<{ col_hlc: string }>("SELECT col_hlc FROM __sync_v5_column_versions WHERE col_name='future'")).toEqual(original);
  });

  it('quarantines unknown tables and replays after schema installation without redownloading', async () => {
    const f = setup(), a = f.device('A'), b = f.device('B');
    a.db.exec('CREATE TABLE future_table(id TEXT PRIMARY KEY,title TEXT)');
    await a.sync.publishChangesToV5Cloud([change('x', { title: 'not lost' }, 'vfs', 'future_table')]);
    await b.sync.pullAndApplyFromV5Cloud();
    expect(b.db.pluck('SELECT count(*) FROM __sync_quarantine_records')).toBe(1);
    expect(b.db.pluck('SELECT count(*) FROM __sync_unknown_op_log')).toBe(1);
    b.db.exec('CREATE TABLE future_table(id TEXT PRIMARY KEY,title TEXT)'); f.storage.ranges = [];
    await b.sync.pullAndApplyFromV5Cloud();
    expect(b.db.pluck('SELECT title FROM future_table')).toBe('not lost');
    expect(b.db.pluck('SELECT count(*) FROM __sync_quarantine_records')).toBe(0);
    expect(f.storage.ranges).toEqual([]);
  });

  it('maintains monotonic 48-bit HLC and durable per-incarnation sequences on restart/rollback', async () => {
    const f = setup(), a = f.device('A');
    await a.sync.publishChangesToV5Cloud([change('1'), change('2')]);
    f.advance(1);
    const restarted = new SyncV5RuntimeCoordinator(a.options);
    expect(restarted.incarnationId).toBe(a.sync.incarnationId);
    await restarted.publishChangesToV5Cloud([change('3')]);
    const ops = a.db.all<{ payload: string }>('SELECT payload FROM __sync_v5_runtime_ops ORDER BY seq').map(row => JSON.parse(row.payload));
    expect(ops.map(op => op.seq)).toEqual([1, 2, 3]);
    const clocks = ops.map(op => Hlc.parse(JSON.parse(op.change).changed_at)!);
    expect(clocks[1]!.toU64()).toBeGreaterThan(clocks[0]!.toU64());
    expect(clocks[2]!.toU64()).toBeGreaterThan(clocks[1]!.toU64());
    expect(clocks[2]!.millis).toBeLessThan(1n << 48n);
  });

  it('does not advance a sparse contiguous vector across missing source sequences', () => {
    const tree = new DeduplicatedIntervalTree();
    tree.add('A@i', 3n); tree.add('A@i', 1n);
    expect(tree.contiguous('A@i')).toBe(1n);
    expect(tree.has('A@i', 2n)).toBe(false);
    tree.add('A@i', 2n); tree.add('A@i', 2n);
    expect(tree.contiguous('A@i')).toBe(3n);
  });

  it('rolls 20 delta rounds into <=9 live indices plus retained generations and reads only missing entries', async () => {
    const f = setup(), a = f.device('A'), b = f.device('B');
    for (let i = 1; i <= 20; i++) {
      f.advance(i * 1000);
      await a.sync.publishChangesToV5Cloud([change(String(i), { title: `round ${i}` })]);
      f.storage.ranges = [];
      expect(await b.sync.pullAndApplyFromV5Cloud()).toEqual({ applied: 1, downloadedEntries: 1 });
      expect(f.storage.ranges.filter(range => range.offset !== 0)).toHaveLength(1);
      expect(f.storage.keys().filter(key => key.endsWith('.dsix')).length).toBeLessThanOrEqual(29);
    }
    expect(b.db.pluck('SELECT count(*) FROM notes')).toBe(20);
    const c = f.device('C');
    expect((await c.sync.pullAndApplyFromV5Cloud()).applied).toBe(20);
    expect(c.db.all('SELECT * FROM notes ORDER BY id')).toEqual(b.db.all('SELECT * FROM notes ORDER BY id'));
  });

  it('restores dedup receipts across coordinator restarts and performs zero pack requests', async () => {
    const f = setup(), a = f.device('A'), b = f.device('B');
    await a.sync.publishChangesToV5Cloud([change()]); await b.sync.pullAndApplyFromV5Cloud();
    f.storage.ranges = [];
    const restarted = new SyncV5RuntimeCoordinator(b.options);
    expect(await restarted.pullAndApplyFromV5Cloud()).toEqual({ applied: 0, downloadedEntries: 0 });
    expect(f.storage.ranges).toEqual([]);
    expect(restarted.versionVector.get(`A@${a.sync.incarnationId}`)?.contiguousSeq).toBe(1n);
  });

  it('authenticates every frame of a >64KiB row, rejects corruption and retries without acknowledgement', async () => {
    const f = setup(), a = f.device('A'), b = f.device('B');
    const text = '数据'.repeat(50_000);
    await a.sync.publishChangesToV5Cloud([change('large', { title: text })]);
    const key = f.storage.keys().find(key => key.endsWith('.pack'))!;
    const original = f.storage.bytes(key)!; const corrupt = original.slice(); corrupt[corrupt.length - 1]! ^= 1;
    await f.storage.put(key, corrupt);
    await expect(b.sync.pullAndApplyFromV5Cloud()).rejects.toThrow();
    expect(b.db.pluck('SELECT count(*) FROM notes')).toBe(0);
    expect(b.db.pluck('SELECT count(*) FROM __sync_v5_runtime_receipts')).toBe(0);
    await f.storage.put(key, original);
    expect((await b.sync.pullAndApplyFromV5Cloud()).applied).toBe(1);
    expect(b.db.pluck('SELECT title FROM notes')).toBe(text);
  });

  it('retries a failed cloud-head commit from durable outbox with unchanged operation identity', async () => {
    const f = setup(), a = f.device('A'), b = f.device('B');
    f.storage.failHead = true;
    await expect(a.sync.publishChangesToV5Cloud([change()])).rejects.toThrow('network interrupted');
    expect((await b.sync.pullAndApplyFromV5Cloud()).applied).toBe(0);
    const restarted = new SyncV5RuntimeCoordinator(a.options);
    expect(restarted.versionVector.get(`A@${a.sync.incarnationId}`)?.contiguousSeq).toBe(0n);
    expect(await restarted.publishChangesToV5Cloud([])).toEqual({ published: 1 });
    expect((await b.sync.pullAndApplyFromV5Cloud()).applied).toBe(1);
    expect(a.db.pluck('SELECT count(*) FROM __sync_v5_runtime_ops')).toBe(1);
    expect(f.storage.keys().filter(key => key.endsWith('.pack'))).toHaveLength(1);
  });

  it('preserves delete floors and opaque concurrent edits byte-for-byte in every head arrival order', async () => {
    const f = setup(), a = f.device('A'), d = f.device('D'), e = f.device('E');
    await a.sync.publishChangesToV5Cloud([change('r', { title: 'obsolete', future: 'obsolete' })]);
    await d.sync.pullAndApplyFromV5Cloud(); await e.sync.pullAndApplyFromV5Cloud();
    f.advance(2000); await d.sync.publishChangesToV5Cloud([change('r', null, 'vfs', 'notes', 'Delete')]);
    f.advance(3000); await e.sync.publishChangesToV5Cloud([change('r', { future: 'survives' }, 'vfs', 'notes', 'Update')]);
    const heads = f.storage.keys().filter(key => key.includes('/heads/'));
    const packets = new Map(heads.map(key => [key, f.storage.bytes(key)!]));
    const states: string[] = [];
    for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
      const target = f.device(`old${states.length}`, 1);
      for (const key of heads) f.storage.files.delete(key);
      for (const i of order) { await f.storage.put(heads[i]!, packets.get(heads[i]!)!); await target.sync.pullAndApplyFromV5Cloud(); }
      expect(target.db.get('SELECT * FROM notes')).toBeUndefined();
      const meta = target.db.one<{ floor_deleted_hlc: string; col_versions_json: string }>('SELECT * FROM __sync_row_meta');
      expect(Hlc.parse(meta.floor_deleted_hlc)!.millis).toBe(2000n);
      const opaque = readUnknownFieldsForRoundTrip(target.db, 'notes', 'r');
      expect(opaque.values).toEqual({ future: 'survives' });
      // Compare raw register bytes as well as values; receipt times are deliberately not state.
      states.push(JSON.stringify({ row: target.db.get('SELECT * FROM notes') ?? null, floor: meta.floor_deleted_hlc,
        versions: JSON.parse(meta.col_versions_json), opaque }));
    }
    for (const state of states) expect(state).toBe(states[0]);
  });

  it('pairs a disk SQLite receiver using only transported bytes and independently created storage', async () => {
    const f = setup(), a = f.device('A');
    await a.sync.publishChangesToV5Cloud([change('r', { title: 'bootstrap', future: 'v2' })]);
    const source = settings({ 'cloud_storage.config.safe_v1': '{"provider":"s3"}', cloud_storage_credentials: 'credentials',
      vendor_configs: '[{"id":"builtin-test"}]', 'builtin-test.api_key': 'test-only-ai-key' });
    const target = settings();
    const path = diskPath('receiver.db'), db = database(2, path);
    const anchor = await a.sync.pairingAnchorV5('b'.repeat(64));
    const offer = JSON.parse(JSON.stringify(await a.sync.createPairingOfferV5({ sourceSettings: source.store, anchor,
      cloudConfig: { provider: 's3', root: 'independent-root' } })));
    // Distinct provider instance, with no reference to sender storage or keys.
    const objects = f.storage.keys().map(key => [key, f.storage.bytes(key)!] as const);
    let created = 0;
    const result = await pairAndBootstrapDeviceV5({ ...offer, targetSettings: target.store,
      target: { deviceId: 'C', stateDb: db, databases: new Map([['vfs', db]]) },
      createStorage: async config => {
        expect(config.root).toBe('independent-root'); created++;
        const remote = new RangeStorage(); for (const [key, bytes] of objects) await remote.put(key, bytes.slice()); return remote;
      } });
    expect(created).toBe(1);
    expect(result.sync.applied).toBe(1);
    expect(target.values.get('cloud_storage.config.safe_v1')).toBe('{"provider":"s3"}');
    expect(target.values.get('builtin-test.api_key')).toBe('test-only-ai-key');
    expect(target.values.get('cloud_sync.v5_root')).toContain(Buffer.from(f.secrets.kCid).toString('hex'));
    expect(db.get('SELECT * FROM notes')).toEqual({ id: 'r', title: 'bootstrap', future: 'v2' });
    expect(result.coordinator.incarnationId).not.toBe(a.sync.incarnationId);
    expect(f.storage.keys().some(key => f.storage.text(key)?.includes('test-only-ai-key'))).toBe(false);
    close(db);
    const restored = reopen(path);
    expect(restored.pluck('SELECT title FROM notes')).toBe('bootstrap');
  });

  it('leaves no receipt when SQLite materialization fails and retries the same frame after repair', async () => {
    const f = setup(), a = f.device('A'), b = f.device('B');
    b.db.exec("CREATE TRIGGER reject_notes BEFORE INSERT ON notes BEGIN SELECT RAISE(ABORT,'disk simulation'); END");
    await a.sync.publishChangesToV5Cloud([change()]);
    await expect(b.sync.pullAndApplyFromV5Cloud()).rejects.toThrow('disk simulation');
    expect(b.db.pluck('SELECT count(*) FROM __sync_applied_ops')).toBe(0);
    expect(b.db.pluck('SELECT count(*) FROM __sync_v5_runtime_receipts')).toBe(0);
    b.db.exec('DROP TRIGGER reject_notes');
    expect((await b.sync.pullAndApplyFromV5Cloud()).applied).toBe(1);
  });

  it('rejects a corrupted committed DSIX before requesting any pack frames', async () => {
    const f = setup(), a = f.device('A'), b = f.device('B');
    await a.sync.publishChangesToV5Cloud([change()]);
    const index = f.storage.keys().find(key => key.endsWith('.dsix'))!;
    const bytes = f.storage.bytes(index)!;
    const envelope = JSON.parse(Buffer.from(bytes).toString('utf8'));
    const ciphertext = Buffer.from(envelope.bytes, 'base64'); ciphertext[ciphertext.length - 1]! ^= 1;
    envelope.bytes = ciphertext.toString('base64');
    await f.storage.put(index, Buffer.from(JSON.stringify(envelope)));
    f.storage.ranges = [];
    await expect(b.sync.pullAndApplyFromV5Cloud()).rejects.toThrow();
    expect(f.storage.ranges).toEqual([]);
    expect(b.db.pluck('SELECT count(*) FROM __sync_v5_runtime_receipts')).toBe(0);
  });
});
