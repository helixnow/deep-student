import './local-runtime-fixture.ts';
import { afterEach, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { parseJsonLossless, stringifyJsonLossless } from '../../../platform/util/lossless-json.ts';
import type { EngineChange } from '../src/change-payload.ts';
import { parseSyncChange } from '../src/change-payload.ts';
import { readUnknownFields, readUnknownFieldsForRoundTrip, rehydrateUnknownFieldsIfColumnsExist, vaultUnknownFields, vaultUnknownFieldsWithVersion } from '../src/unknown-fields.ts';
import { collectForeignKeyViolationSet, validateNoNewFkViolations } from '../repository/apply-fk.ts';
import { Hlc, MAX_HLC_MILLIS } from '../src/hlc.ts';
import { parseRecordKeyValues } from '../repository/sqlite-values.ts';
import { appendDeferredOrphan, appendUnknownOp, applyRowWithColumnLifecycle, ensureV5SyncTables, partitionEntityCohesiveMicroBatches, recordOrphanRetryFailure, recordReceivedOp, selectDeterministicCanonicalId, transitionOpMaterializationState } from '../repository/v5-vaults.ts';
import { openTestDatabase, type TestDatabase } from './test-db.ts';

const opened: TestDatabase[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.raw.close(); });
const t = (n: number) => `${String(n).padStart(15, '0')}-00000`;
const v = (n: number, dev = 'a') => ({ hlc: t(n), dev });
function database(): TestDatabase {
  const db = openTestDatabase(); opened.push(db); ensureV5SyncTables(db);
  db.exec("CREATE TABLE records(id TEXT PRIMARY KEY, colA TEXT DEFAULT 'default', colB TEXT, updated_at TEXT, created_at TEXT, device_id TEXT)");
  return db;
}
function change(table: string, id: string, data: EngineChange['data'] = {}, operation: EngineChange['operation'] = 'Insert'): EngineChange {
  return { table_name: table, record_id: id, operation, data, changed_at: t(1), source_device_id: 'a' };
}
const identity = (seq: number | bigint = 1) => ({ source_device_id: 'a', incarnation_id: 'inc-1', source_seq: seq, op_ordinal: 0 });
const received = (seq: number | bigint = 1) => ({ ...identity(seq), op_hash: new Uint8Array(32).fill(1) });

describe('V5 lossless record keys and FK checks', () => {
  it('rejects millis outside the packed HLC range without changing legacy parsing', () => {
    for (const millis of [-1n, MAX_HLC_MILLIS + 1n]) expect(() => new Hlc(millis, 0).toU64()).toThrow(RangeError);
    expect(new Hlc(MAX_HLC_MILLIS, 65535).toU64()).toBe((1n << 64n) - 1n);
    expect(Hlc.parse(`${MAX_HLC_MILLIS + 1n}-0`)).not.toBeNull();
  });
  it('distinguishes adjacent FK rowids above the safe integer limit', () => {
    const db = database();
    db.exec('PRAGMA foreign_keys=OFF; CREATE TABLE parents(id INTEGER PRIMARY KEY); CREATE TABLE children(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parents(id)); INSERT INTO children VALUES(9007199254740992,1)');
    const baseline = collectForeignKeyViolationSet(db, ['children']);
    db.exec('INSERT INTO children VALUES(9007199254740993,1)');
    expect(collectForeignKeyViolationSet(db, ['children']).size).toBe(2);
    expect(() => validateNoNewFkViolations(db, baseline, ['children'])).toThrow('9007199254740993');
  });
  it('preserves bigint object and array composite keys, and existing string fallbacks', () => {
    expect(parseRecordKeyValues('records', '{"a":9223372036854775807,"b":"x"}', ['a', 'b'])).toEqual(['9223372036854775807', 'x']);
    expect(parseRecordKeyValues('records', '[9007199254740993,"x"]', ['a', 'b'])).toEqual(['9007199254740993', 'x']);
    expect(parseRecordKeyValues('records', 'a:b', ['a', 'b'])).toEqual(['a', 'b']);
    expect(parseRecordKeyValues('records', '9007199254740993', ['id'])).toEqual(['9007199254740993']);
  });
  it('skips missing tables but propagates I/O and corruption failures', () => {
    for (const message of ['disk I/O error', 'database disk image is malformed']) {
      const db = { all: () => { throw new Error(message); } } as unknown as SqlExecutor;
      expect(() => collectForeignKeyViolationSet(db, ['records'])).toThrow(`Database error: 检查外键失败 records: ${message}`);
    }
    const missing = { all: () => { throw new Error('no such table: absent'); } } as unknown as SqlExecutor;
    expect(collectForeignKeyViolationSet(missing, ['absent']).size).toBe(0);
  });
  it('reports actual SQLite FK violations rather than swallowing them', () => {
    const db = database();
    db.exec('PRAGMA foreign_keys=OFF; CREATE TABLE parents(id TEXT PRIMARY KEY); CREATE TABLE children(id TEXT PRIMARY KEY,parent_id TEXT REFERENCES parents(id)); INSERT INTO children VALUES(\'c\',\'p\'); PRAGMA foreign_keys=ON');
    expect(collectForeignKeyViolationSet(db, ['children']).size).toBe(1);
    expect(collectForeignKeyViolationSet(db, ['absent']).size).toBe(0);
  });
});

describe('V5 original-version unknown-column envelopes', () => {
  it.each([4, 5, 6])('bootstraps before choosing vault winners at t%s', time => {
    const db = database();
    db.run('INSERT INTO records(id,colA,updated_at,device_id) VALUES(?,?,?,?)', ['r', 'local', t(5), 'a']);
    vaultUnknownFieldsWithVersion(db, 'records', 'r', { colA: { value: 'vault', ...v(time), seq: 9007199254740993n } });
    rehydrateUnknownFieldsIfColumnsExist(db, 'records');
    expect(db.pluck('SELECT colA FROM records')).toBe(time > 5 ? 'vault' : 'local');
    const versions = parseJsonLossless(String(db.pluck('SELECT col_versions_json FROM __sync_row_meta'))) as any;
    expect(versions.colA).toEqual(time > 5 ? { ...v(6), seq: 9007199254740993n } : v(5));
  });
  it('round-trips original versions, null tombstones and bigint seq without timestamp inflation', () => {
    const db = database();
    vaultUnknownFieldsWithVersion(db, 'records', 'r', { future: { value: 'A', ...v(1), seq: 9007199254740993n } });
    const old = readUnknownFieldsForRoundTrip(db, 'records', 'r');
    expect(old).toEqual({ values: { future: 'A' }, fieldDeltas: { future: { ...v(1), seq: 9007199254740993n } } });
    vaultUnknownFieldsWithVersion(db, 'records', 'r', { future: { value: null, ...v(2) } });
    // An old device editing tags at t3 sends future with its ORIGINAL t1.
    vaultUnknownFieldsWithVersion(db, 'records', 'r', { future: { value: old.values.future!, ...old.fieldDeltas.future! } });
    expect(readUnknownFields(db, 'records', 'r')).toEqual({ future: null });
    expect(parseJsonLossless(String(db.pluck('SELECT fields_json FROM __sync_unknown_fields')))).toEqual({ future: { value: null, ...v(2) } });
    vaultUnknownFieldsWithVersion(db, 'records', 's', { future: { value: 9223372036854775807n, ...v(1), seq: 9007199254740993n } });
    expect(String(db.pluck("SELECT fields_json FROM __sync_unknown_fields WHERE record_id='s'"))).toContain('9007199254740993');
  });
  it('uses device ties, rejects floor-equal/older values, and never lets legacy writes overwrite envelopes', () => {
    const db = database();
    vaultUnknownFieldsWithVersion(db, 'records', 'r', { future: { value: 'a', ...v(3) }, stale: { value: 'old', ...v(2, 'z') } }, t(2));
    vaultUnknownFieldsWithVersion(db, 'records', 'r', { future: { value: 'z', ...v(3, 'z') } });
    vaultUnknownFields(db, 'records', 'r', { future: 'revived', legacy: 1 });
    expect(readUnknownFields(db, 'records', 'r')).toEqual({ future: 'z', legacy: 1 });
    expect(readUnknownFieldsForRoundTrip(db, 'records', 'r').fieldDeltas.future).toEqual(v(3, 'z'));
  });
  it('preserves legacy deltas and rehydrates both legacy values and versioned null', () => {
    const db = database();
    db.run("INSERT INTO records(id) VALUES('r')");
    vaultUnknownFields(db, 'records', 'r', { legacy: 'old', __sync_field_deltas: { a: 1 } });
    vaultUnknownFields(db, 'records', 'r', { __sync_field_deltas: { b: 2 } });
    vaultUnknownFieldsWithVersion(db, 'records', 'r', { future: { value: null, ...v(2) } });
    db.exec('ALTER TABLE records ADD COLUMN legacy TEXT; ALTER TABLE records ADD COLUMN future TEXT');
    rehydrateUnknownFieldsIfColumnsExist(db, 'records');
    expect(db.get('SELECT legacy,future FROM records')).toEqual({ legacy: 'old', future: null });
    expect(readUnknownFields(db, 'records', 'r')).toEqual({ __sync_field_deltas: { a: 1, b: 2 } });
    expect(parseJsonLossless(String(db.pluck('SELECT col_versions_json FROM __sync_row_meta')))).toMatchObject({ future: v(2) });
  });
  it('retains fields when no row exists and respects newer local column versions after upgrade', () => {
    const db = database();
    vaultUnknownFieldsWithVersion(db, 'records', 'r', { colA: { value: 'old', ...v(1) } });
    rehydrateUnknownFieldsIfColumnsExist(db, 'records');
    expect(readUnknownFields(db, 'records', 'r')).toEqual({ colA: 'old' });
    applyRowWithColumnLifecycle(db, 'records', 'r', 'Insert', { colA: 'new' }, { colA: v(3) });
    rehydrateUnknownFieldsIfColumnsExist(db, 'records');
    expect(db.pluck('SELECT colA FROM records')).toBe('new');
  });
});

describe('V5 receipt, materialization and immutable vault logs', () => {
  it.each(['pending_schema', 'pending_fk', 'deferred_skew'] as const)('replays %s without a second Merkle receipt', state => {
    const db = database(); const op = received(9007199254740993n);
    expect(recordReceivedOp(db, op, state)).toEqual({ isNew: true, shouldMaterialize: true, materializationState: state });
    expect(recordReceivedOp(db, op).isNew).toBe(false);
    expect(recordReceivedOp(db, op).shouldMaterialize).toBe(true);
    db.transaction(tx => {
      applyRowWithColumnLifecycle(tx, 'records', 'r', 'Insert', { colA: 'replayed' }, { colA: v(1) });
      expect(transitionOpMaterializationState(tx, op, 'materialized')).toBe(true);
    });
    expect(recordReceivedOp(db, op).shouldMaterialize).toBe(false);
    expect(transitionOpMaterializationState(db, op, 'pending_fk')).toBe(false);
    expect(db.pluck('SELECT count(*) FROM __sync_applied_ops')).toBe(1);
  });
  it('detects history forks, separates incarnations, validates signed 64-bit sequences', () => {
    const db = database(); recordReceivedOp(db, received());
    expect(() => recordReceivedOp(db, { ...received(), op_hash: new Uint8Array(32).fill(2) })).toThrow('HistoryForkError');
    expect(recordReceivedOp(db, { ...received(), incarnation_id: 'inc-2' }).isNew).toBe(true);
    expect(() => recordReceivedOp(db, received(1n << 63n))).toThrow('64');
    expect(() => recordReceivedOp(db, received(Number.MAX_SAFE_INTEGER + 1))).toThrow('安全整数');
  });
  it('rolls back materialization status along with failed business writes', () => {
    const db = database(); const op = received(); recordReceivedOp(db, op, 'pending_fk');
    expect(() => db.transaction(tx => {
      transitionOpMaterializationState(tx, op, 'materialized');
      tx.run('INSERT INTO nonexistent VALUES(1)');
    })).toThrow();
    expect(recordReceivedOp(db, op).materializationState).toBe('pending_fk');
  });
  it('appends Insert -> Update -> Delete independently and retains dead letters after 16 failures', () => {
    const db = database();
    for (const [i, operation] of (['Insert', 'Update', 'Delete'] as const).entries()) {
      const c = change('future_table', 'same-row', { amount: 9007199254740993n }, operation);
      expect(appendUnknownOp(db, identity(i + 1), c, 99)).toBe(true);
      expect(appendUnknownOp(db, identity(i + 1), c, 99)).toBe(false);
      expect(appendDeferredOrphan(db, identity(i + 1), c, 'parents', 'p')).toBe(true);
      expect(appendDeferredOrphan(db, identity(i + 1), c)).toBe(false);
    }
    expect(db.all('SELECT operation FROM __sync_unknown_op_log ORDER BY op_seq').map(row => row.operation)).toEqual(['Insert', 'Update', 'Delete']);
    const payload = String(db.pluck('SELECT change_payload_json FROM __sync_deferred_orphans ORDER BY orphan_seq LIMIT 1'));
    expect(parseSyncChange(payload).data).toEqual({ amount: 9007199254740993n });
    for (let i = 0; i < 15; i++) recordOrphanRetryFailure(db, identity(), 'missing parent');
    expect(db.get('SELECT retry_count,status FROM __sync_deferred_orphans WHERE source_seq=1')).toEqual({ retry_count: 15, status: 'pending' });
    recordOrphanRetryFailure(db, identity(), 'missing parent'); recordOrphanRetryFailure(db, identity(), 'again');
    expect(db.get('SELECT retry_count,status FROM __sync_deferred_orphans WHERE source_seq=1')).toEqual({ retry_count: 16, status: 'dead_letter' });
    expect(db.pluck('SELECT count(*) FROM __sync_deferred_orphans')).toBe(3);
  });
  it('creates all tables idempotently, including compressed Merkle ranges', () => {
    const db = database(); ensureV5SyncTables(db);
    db.run('INSERT INTO __sync_applied_ranges VALUES(?1,?2,?3,?4,?5,?6)', ['a', 'i', 0n, 9223372036854775807n, new Uint8Array(32), 'checkpoint']);
    expect(db.pluck('SELECT count(*) FROM __sync_applied_ranges')).toBe(1);
  });
  it('replays a vaulted unknown table after schema upgrade and a deferred child after its parent arrives', () => {
    const db = database();
    const unknownOp = received(1);
    const unknownChange = change('future_table', 'f', { title: 'from future' });
    recordReceivedOp(db, unknownOp, 'pending_schema'); appendUnknownOp(db, unknownOp, unknownChange, 99);
    db.exec('CREATE TABLE future_table(id TEXT PRIMARY KEY,title TEXT)');
    db.transaction(tx => {
      expect(recordReceivedOp(tx, unknownOp).shouldMaterialize).toBe(true);
      applyRowWithColumnLifecycle(tx, 'future_table', 'f', 'Insert', { title: 'from future' }, { title: v(1) });
      transitionOpMaterializationState(tx, unknownOp, 'materialized');
    });
    expect(db.pluck('SELECT title FROM future_table')).toBe('from future');
    db.exec('PRAGMA foreign_keys=ON; CREATE TABLE parents(id TEXT PRIMARY KEY); CREATE TABLE children(id TEXT PRIMARY KEY,parent_id TEXT REFERENCES parents(id),title TEXT)');
    const childOp = received(2);
    const childChange = change('children', 'c', { parent_id: 'p', title: 'child' });
    recordReceivedOp(db, childOp, 'pending_fk'); appendDeferredOrphan(db, childOp, childChange, 'parents', 'p');
    expect(() => applyRowWithColumnLifecycle(db, 'children', 'c', 'Insert', { parent_id: 'p', title: 'child' }, { parent_id: v(1), title: v(1) })).toThrow('FOREIGN KEY');
    db.run("INSERT INTO parents VALUES('p')");
    db.transaction(tx => {
      expect(recordReceivedOp(tx, childOp).shouldMaterialize).toBe(true);
      applyRowWithColumnLifecycle(tx, 'children', 'c', 'Insert', { parent_id: 'p', title: 'child' }, { parent_id: v(1), title: v(1) });
      transitionOpMaterializationState(tx, childOp, 'materialized');
    });
    expect(db.get('SELECT parent_id,title FROM children')).toEqual({ parent_id: 'p', title: 'child' });
    expect(db.pluck('SELECT count(*) FROM __sync_applied_ops')).toBe(2);
    expect(db.all('SELECT materialization_state FROM __sync_applied_ops').map(row => row.materialization_state)).toEqual(['materialized', 'materialized']);
  });
});

describe('V5 row lifecycle and per-column registers', () => {
  it('unknown-only survivors never retain empty physical rows in any arrival order', () => {
    const states: unknown[] = [];
    for (const order of [[0, 1, 2], [0, 2, 1], [1, 2, 0], [2, 1, 0], [2, 0, 1], [1, 0, 2]]) {
      const db = database();
      const ops = [
        () => applyRowWithColumnLifecycle(db, 'records', 'r', 'Insert', { colA: 'old' }, { colA: v(1) }),
        () => applyRowWithColumnLifecycle(db, 'records', 'r', 'Update', { future: { nested: null } }, { future: { ...v(3), seq: 9007199254740993n } }),
        () => applyRowWithColumnLifecycle(db, 'records', 'r', 'Delete', {}, {}, v(2)),
      ];
      for (const i of order) ops[i]!();
      expect(db.get('SELECT * FROM records')).toBeUndefined();
      states.push({ meta: db.get('SELECT * FROM __sync_row_meta'), vault: readUnknownFieldsForRoundTrip(db, 'records', 'r') });
      applyRowWithColumnLifecycle(db, 'records', 'r', 'Update', { colB: 'fresh' }, { colB: v(4) });
      expect(db.get('SELECT colA,colB FROM records')).toEqual({ colA: 'default', colB: 'fresh' });
    }
    for (const state of states) expect(state).toEqual(states[0]);
  });
  it('Delete t2 blocks Update t1 and Reinsert t3 cannot revive old columns or unknowns', () => {
    const db = database();
    applyRowWithColumnLifecycle(db, 'records', 'r', 'Insert', { colA: 'old', future: 'old future' }, { colA: v(1), future: v(1) });
    applyRowWithColumnLifecycle(db, 'records', 'r', 'Delete', {}, {}, v(2));
    expect(db.get('SELECT * FROM records')).toBeUndefined();
    expect(readUnknownFields(db, 'records', 'r')).toEqual({});
    expect(applyRowWithColumnLifecycle(db, 'records', 'r', 'Update', { colA: 'late' }, { colA: v(1) })).toBe(false);
    applyRowWithColumnLifecycle(db, 'records', 'r', 'Insert', { colB: 'new', colA: 'zombie', future: 'zombie' }, { colB: v(3), colA: v(1), future: v(1) });
    expect(db.get('SELECT colA,colB FROM records')).toEqual({ colA: 'default', colB: 'new' });
    expect(readUnknownFields(db, 'records', 'r')).toEqual({});
    expect(db.pluck('SELECT floor_deleted_hlc FROM __sync_row_meta')).toBe(t(2));
  });
  it('retains newer concurrent columns, resets stale columns to defaults, and converges in both orders', () => {
    const states: unknown[] = [];
    for (const deleteFirst of [true, false]) {
      const db = database();
      applyRowWithColumnLifecycle(db, 'records', 'r', 'Insert', { colA: 'old', colB: 'old' }, { colA: v(1), colB: v(1) });
      const del = () => applyRowWithColumnLifecycle(db, 'records', 'r', 'Delete', {}, {}, v(2));
      const update = () => applyRowWithColumnLifecycle(db, 'records', 'r', 'Update', { colB: 'new', future: null }, { colB: v(3), future: v(3) });
      if (deleteFirst) { del(); update(); } else { update(); del(); }
      states.push({ row: db.get('SELECT * FROM records'), meta: db.get('SELECT * FROM __sync_row_meta'), unknown: readUnknownFieldsForRoundTrip(db, 'records', 'r') });
    }
    expect(states[0]).toEqual(states[1]);
  });
  it('bootstraps existing non-null columns from updated_at and device_id deterministically', () => {
    const db = database();
    db.run('INSERT INTO records(id,colA,updated_at,device_id) VALUES(?1,?2,?3,?4)', ['r', 'local', t(5), 'b']);
    applyRowWithColumnLifecycle(db, 'records', 'r', 'Update', { colA: 'older', colB: 'independent' }, { colA: v(4), colB: v(1) });
    expect(db.get('SELECT colA,colB FROM records')).toEqual({ colA: 'local', colB: 'independent' });
    const meta = parseJsonLossless(String(db.pluck('SELECT col_versions_json FROM __sync_row_meta')));
    expect(meta).toMatchObject({ colA: v(5, 'b'), device_id: v(5, 'b') });
    applyRowWithColumnLifecycle(db, 'records', 'r', 'Update', { colA: null }, { colA: v(5, 'z') });
    expect(db.pluck('SELECT colA FROM records')).toBeNull();
  });
  it('bootstraps from created_at or zero when updated_at is absent, without inventing wall-clock versions', () => {
    const db = database();
    db.run('INSERT INTO records(id,colA,created_at) VALUES(?1,?2,?3)', ['r', 'local', t(4)]);
    applyRowWithColumnLifecycle(db, 'records', 'r', 'Update', { colA: 'older' }, { colA: v(3) });
    expect(db.pluck('SELECT colA FROM records')).toBe('local');
    db.run("INSERT INTO records(id,colA) VALUES('s','unversioned')");
    applyRowWithColumnLifecycle(db, 'records', 's', 'Update', { colA: 'remote' }, { colA: v(1) });
    expect(db.pluck("SELECT colA FROM records WHERE id='s'")).toBe('remote');
  });
  it('rejects equal floor versions, compares device ties, and keeps the floor monotonic', () => {
    const db = database();
    applyRowWithColumnLifecycle(db, 'records', 'r', 'Delete', {}, {}, v(2, 'b'));
    applyRowWithColumnLifecycle(db, 'records', 'r', 'Update', { colA: 'equal' }, { colA: v(2, 'b') });
    expect(db.get('SELECT * FROM records')).toBeUndefined();
    applyRowWithColumnLifecycle(db, 'records', 'r', 'Insert', { colA: 'wins' }, { colA: v(2, 'z') });
    applyRowWithColumnLifecycle(db, 'records', 'r', 'Delete', {}, {}, v(1));
    expect(db.pluck('SELECT colA FROM records')).toBe('wins');
    expect(db.pluck('SELECT floor_deleted_dev FROM __sync_row_meta')).toBe('b');
    vaultUnknownFieldsWithVersion(db, 'records', 'r', { stale: { value: 'bad', ...v(1) }, fresh: { value: 'ok', ...v(3) } });
    expect(readUnknownFields(db, 'records', 'r')).toEqual({ fresh: 'ok' });
  });
  it('applies bigint composite keys and rolls back partial row/meta writes on conversion failure', () => {
    const db = database();
    db.exec('CREATE TABLE composite(a INTEGER,b TEXT,colA TEXT,PRIMARY KEY(a,b))');
    applyRowWithColumnLifecycle(db, 'composite', '[9007199254740993,"b"]', 'Insert', { colA: 'exact' }, { colA: v(1) });
    expect(db.pluck('SELECT CAST(a AS TEXT) FROM composite')).toBe('9007199254740993');
    expect(() => applyRowWithColumnLifecycle(db, 'records', 'r', 'Insert', { colA: 1n << 64n }, { colA: v(1) })).toThrow('SQLite');
    expect(db.pluck("SELECT count(*) FROM __sync_row_meta WHERE table_name='records'")).toBe(0);
  });
});

describe('V5 canonical IDs and root-entity-closure batches', () => {
  it('chooses min(createdHlc, deviceId, id) independently of arrival order', () => {
    const candidates = [{ id: 'z', createdHlc: t(1), deviceId: 'a' }, { id: 'a', createdHlc: t(2), deviceId: 'a' },
      { id: 'b', createdHlc: t(1), deviceId: 'a' }, { id: 'a', createdHlc: t(1), deviceId: 'b' }];
    for (const a of candidates) for (const b of candidates) {
      expect(selectDeterministicCanonicalId(a, b)).toBe(selectDeterministicCanonicalId(b, a));
    }
    expect(candidates.reduce((a, b) => selectDeterministicCanonicalId(a, b) === a.id ? a : b).id).toBe('b');
  });
  it('never splits note/resource/format/revision/learning/folder closure, even across interleaved changes', () => {
    const note = change('notes', 'n', { resource_id: 'r' });
    const unrelated = change('resources', 'unrelated');
    const closure = [note, change('resources', 'r'), change('note_document_formats', 'n', { note_id: 'n' }),
      change('note_document_revisions', 'rev', { note_id: 'n' }), change('note_learning_relations', 'rel', { note_id: 'n' }),
      change('folder_items', 'item', { item_type: 'note', item_id: 'n' })];
    const batches = partitionEntityCohesiveMicroBatches([closure[0]!, unrelated, ...closure.slice(1)], 2);
    expect(batches).toEqual([closure, [unrelated]]);
  });
  it('connects question/mistake resources and cards, session rows, and original transaction groups', () => {
    const question = [change('questions', 'q', { mistake_id: 'm', resource_id: 'r' }), change('mistakes', 'm'),
      change('resources', 'r'), change('anki_cards', 'a', { question_id: 'q' })];
    const session = [change('chat_v2_sessions', 's'), change('chat_v2_messages', 'msg', { session_id: 's' }),
      change('chat_v2_blocks', 'block', { message_id: 'msg' })];
    const tx = [change('custom_a', '1', { origin_tx_id: 'tx1' }), change('custom_b', '2', { origin_tx_id: 'tx1' })];
    expect(partitionEntityCohesiveMicroBatches([...question, ...session, ...tx], 2)).toEqual([question, session, tx]);
  });
  it('handles deletes, database scoping, empty input and ordinary target-sized packing', () => {
    const del = change('notes', 'n', null, 'Delete');
    const fmt = change('note_document_formats', 'n', { note_id: 'n' });
    const other = { ...fmt, database_name: 'other' };
    expect(partitionEntityCohesiveMicroBatches([del, other, fmt], 1)).toEqual([[del, fmt], [other]]);
    expect(partitionEntityCohesiveMicroBatches([del, change('note_document_formats', 'n', null, 'Delete')], 1).map(batch => batch.length)).toEqual([2]);
    const review = change('review_sessions', 's', null, 'Delete');
    const membership = change('review_session_mistakes', '{"session_id":"s","mistake_id":"m"}', null, 'Delete');
    expect(partitionEntityCohesiveMicroBatches([review, membership], 1).map(batch => batch.length)).toEqual([2]);
    expect(partitionEntityCohesiveMicroBatches([], 2)).toEqual([]);
    const flat = Array.from({ length: 5 }, (_, i) => change('custom', String(i)));
    expect(partitionEntityCohesiveMicroBatches(flat, 2).map(batch => batch.length)).toEqual([2, 2, 1]);
    expect(() => partitionEntityCohesiveMicroBatches(flat, 0)).toThrow('正整数');
    expect(stringifyJsonLossless(partitionEntityCohesiveMicroBatches(flat, 2).flat().map(c => c.record_id))).toBe('["0","1","2","3","4"]');
  });
});
