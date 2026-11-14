// boundary-allow native-import: X3 seed 验收直接读真实 SQLite typeof/原值，并在隔离副本上执行 Rust CAS UPDATE 原 SQL；不写业务或用户数据库。
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDatabase, cleanup, DATABASES, tempDir } from './__fixtures__/fixtures.ts';
import { compareDatabaseStates, enumerateDatabases, snapshotDatabase, snapshotDirectory, type Cell, type DirectoryState } from './__fixtures__/database-state.ts';
import { copySeed, createSeed, resolveSeed, type SeedDirectory } from './__fixtures__/scenario-seeds.ts';

const NAME = 'l15-review-cas-tombstone-w0';
const SLOT = 'app-data/com.deepstudent.differential/slots/slotA';
const MISTAKES = `${SLOT}/mistakes.db`;
const DBS = [`${SLOT}/browser.db`, `${SLOT}/chat_v2.db`, `${SLOT}/databases/vfs.db`, `${SLOT}/llm_usage.db`, MISTAKES];
// Written out by hand (decimal strings, never via Number): 2^53, 2^53+1, 2^63-1024, 2^63-1023, i64::MAX-1, i64::MAX.
const VERSIONS = ['9007199254740992', '9007199254740993', '9223372036854774784', '9223372036854774785',
  '9223372036854775806', '9223372036854775807'];
// dstu-anki/src/fsrs_review_service.rs:2922-2938 (set_suspended_for_agent_scope), verbatim.
const SUSPEND_CAS = `UPDATE fsrs_card_states
                 SET suspended = ?1,
                     updated_at = ?2,
                     local_version = COALESCE(local_version, 0) + 1
                 WHERE id = ?3
                   AND anki_card_id = ?4
                   AND COALESCE(local_version, 0) = ?5
                   AND suspended = ?6
                   AND deleted_at IS NULL
                   AND EXISTS (
                       SELECT 1
                       FROM anki_cards ac
                       INNER JOIN document_tasks dt ON dt.id = ac.task_id
                       WHERE ac.id = fsrs_card_states.anki_card_id
                         AND ac.deleted_at IS NULL
                         AND dt.deleted_at IS NULL
                   )`;
const BUILD_TIME_COLUMNS = ['slots/slotA/databases/vfs.db#memory_config.updated_at',
  'slots/slotA/databases/vfs.db#vfs_indexing_config.updated_at', 'slots/slotA/mistakes.db#__change_log.changed_at'];

const text = (value: string): Cell => ({ storageClass: 'text', value });
const int = (value: string | number): Cell => ({ storageClass: 'integer', value: String(value) });
const real = (hex: string): Cell => ({ storageClass: 'real', value: hex });
const NULL: Cell = { storageClass: 'null', value: null };
const ROW_TIME = text('2026-07-13T00:00:00.000Z');

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
function files(directory: string, prefix = ''): string[] {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? [`${path}/`, ...files(directory, path)] : [path];
  }).sort();
}
const digest = (directory: string) => Object.fromEntries(files(directory).filter(f => !f.endsWith('/')).map(f => [f, sha256(join(directory, f))]));
function rowsOf(seed: SeedDirectory, table: string): Record<string, Record<string, Cell>> {
  return Object.fromEntries(snapshotDatabase(join(seed.directory, MISTAKES)).tables[table]!.rows.map(r => [String(r.values.id!.value), r.values]));
}

// Every column after the current migrations; FsrsImportedSchedule::new_card values (:957-970), deck_default, fsrs-rs-6.6, 0.9.
function stateRow(card: string, localVersion: Cell): Record<string, Cell> {
  return { id: text(`fsrs-state-${card}`), anki_card_id: text(card), deck_id: text('deck_default'), state: int(0),
    stability: NULL, difficulty: NULL, elapsed_days: real('0000000000000000'), scheduled_days: real('0000000000000000'),
    reps: int(0), lapses: int(0), due_ms: int('1783900800000'), last_review_ms: NULL, suspended: int(0),
    fsrs_params_version: text('fsrs-rs-6.6'), desired_retention: real('3feccccccccccccd'),
    created_at: text('2026-07-13T00:00:00+00:00'), updated_at: text('2026-07-13T00:00:00+00:00'),
    device_id: NULL, local_version: localVersion, deleted_at: NULL, leech: int(0), buried_until_ms: NULL, learning_step: int(0) };
}
function cardRow(card: string, task: string, doc: string, order: number, deletedAt: Cell): Record<string, Cell> {
  return { id: text(card), task_id: text(task), front: text(`front-${card}`), back: text(`back-${card}`),
    tags_json: text('[]'), images_json: text('[]'), is_error_card: int(0), error_content: NULL, card_order_in_task: int(order),
    created_at: ROW_TIME, updated_at: ROW_TIME, extra_fields_json: text('{}'), template_id: NULL,
    source_type: text('document'), source_id: text(doc), text: NULL, device_id: NULL, local_version: int(0), deleted_at: deletedAt,
    anki_note_id: NULL, export_status: NULL, last_exported_at: NULL, content_hash: NULL };
}
function taskRow(task: string, doc: string, owner: string, status: string, updatedAt: Cell, deletedAt: Cell): Record<string, Cell> {
  return { id: text(task), document_id: text(doc), original_document_name: text('test.md'), segment_index: int(0),
    content_segment: text('segment'), status: text(status), created_at: ROW_TIME, updated_at: updatedAt, error_message: NULL,
    anki_generation_options_json: text('{}'), device_id: NULL, local_version: int(0), deleted_at: deletedAt, source_session_id: text(owner) };
}

let root: string, catalog: string, source: SeedDirectory, copies: SeedDirectory[];
let sourceDigest: Record<string, string>, sourceState: DirectoryState;
beforeAll(() => {
  root = tempDir();
  catalog = join(root, 'catalog');
  source = createSeed(NAME, catalog);
  sourceDigest = digest(source.directory);
  sourceState = snapshotDirectory(source.directory);
  copies = ['A1', 'A2', 'B'].map(side => copySeed(NAME, catalog, join(root, 'run', side)));
}, 120_000);
afterAll(() => { if (root) cleanup(root); });

describe('WP-116 l15-review-cas-tombstone-w0 seed', () => {
  it('builds once with SQL-constructed provenance; A1/A2/B are byte copies in distinct directories', () => {
    expect(resolveSeed(NAME, catalog)).toEqual(source);
    expect(source).toMatchObject({ name: NAME, provenance: 'sql-constructed' });
    expect(readdirSync(source.directory).sort()).toEqual(['app-data', 'local-data']);
    expect(readdirSync(source.dataLocalDir)).toEqual([]);
    expect(enumerateDatabases(source.directory)).toEqual(DBS);
    for (const copy of copies) {
      expect(copy).toMatchObject({ name: NAME, provenance: 'sql-constructed', dataDir: join(copy.directory, 'app-data'),
        dataLocalDir: join(copy.directory, 'local-data') });
      expect(files(copy.directory)).toEqual(files(source.directory));
      expect(digest(copy.directory)).toEqual(sourceDigest);
    }
    expect(new Set(copies.map(c => c.dataDir)).size).toBe(3);
  });

  it('stores each reviewVersion as an exact INTEGER local_version on a live card/task', () => {
    for (const seed of [source, ...copies]) {
      const states = rowsOf(seed, 'fsrs_card_states'), cards = rowsOf(seed, 'anki_cards'), tasks = rowsOf(seed, 'document_tasks');
      for (const v of VERSIONS) {
        expect(states[`fsrs-state-card-rv-${v}`], v).toEqual(stateRow(`card-rv-${v}`, int(v)));
        expect(cards[`card-rv-${v}`], v).toEqual(cardRow(`card-rv-${v}`, 'task-review-cas', 'doc-review-cas', 0, NULL));
      }
      expect(tasks['task-review-cas']).toEqual(taskRow('task-review-cas', 'doc-review-cas', 'session-review-cas', 'Completed', ROW_TIME, NULL));
      // Pairs that collapse to one IEEE double stay distinct SQLite integers.
      expect(Number(VERSIONS[0])).toBe(Number(VERSIONS[1]));
      expect(Number(VERSIONS[2])).toBe(Number(VERSIONS[3]));
      expect(Number(VERSIONS[4])).toBe(Number(VERSIONS[5]));
      expect(new Set(VERSIONS.map(v => states[`fsrs-state-card-rv-${v}`]!.local_version!.value)).size).toBe(6);
    }
  });

  it('keeps the Rust card/task tombstones as deleted_at rows with live child state and Processing task', () => {
    for (const seed of [source, ...copies]) {
      const states = rowsOf(seed, 'fsrs_card_states'), cards = rowsOf(seed, 'anki_cards'), tasks = rowsOf(seed, 'document_tasks');
      expect(Object.keys(cards).sort()).toEqual(['card-live-child', ...VERSIONS.map(v => `card-rv-${v}`), 'card-still-live', 'card-tombstone'].sort());
      expect(Object.keys(states).sort()).toEqual(['fsrs-state-card-live-child', ...VERSIONS.map(v => `fsrs-state-card-rv-${v}`), 'fsrs-state-card-tombstone'].sort());
      // :7179-7189 soft delete card; sibling and the tombstone's own state untouched.
      expect(cards['card-tombstone']).toEqual(cardRow('card-tombstone', 'task-card-tombstone', 'doc-card-tombstone', 99, text('2026-07-14T01:00:00Z')));
      expect(cards['card-still-live']).toEqual(cardRow('card-still-live', 'task-card-tombstone', 'doc-card-tombstone', 0, NULL));
      expect(states['fsrs-state-card-tombstone']).toEqual(stateRow('card-tombstone', int(0)));
      expect(tasks['task-card-tombstone']).toEqual(taskRow('task-card-tombstone', 'doc-card-tombstone', 'session-owner', 'Completed', ROW_TIME, NULL));
      // :7366-7376 soft delete task; child card and its state stay live rows.
      expect(tasks['task-tombstone']).toEqual(taskRow('task-tombstone', 'doc-task-tombstone', 'session-owner', 'Processing',
        text('2000-01-01T00:00:00Z'), text('2026-07-14T02:00:00Z')));
      expect(cards['card-live-child']).toEqual(cardRow('card-live-child', 'task-tombstone', 'doc-task-tombstone', 0, NULL));
      expect(states['fsrs-state-card-live-child']).toEqual(stateRow('card-live-child', int(0)));
      expect(Object.keys(rowsOf(seed, 'fsrs_review_logs'))).toEqual([]);
    }
  });

  it('differs from a pristine migration replay only by the inserted rows and their trigger change_log; no DELETE', () => {
    const pristine = join(root, 'pristine');
    for (const db of DATABASES) buildDatabase(join(pristine, 'slots/slotA'), db, false, {});
    const reference = snapshotDirectory(pristine);
    const seeded: DirectoryState = { version: 0, databases: Object.fromEntries(Object.entries(sourceState.databases)
      .map(([file, state]) => [file.replace(/^app-data\/com\.deepstudent\.differential\//, ''), state])) };
    const all = compareDatabaseStates(reference, seeded);
    const buildTime = all.filter(d => d.kind === 'value' && BUILD_TIME_COLUMNS.includes(`${d.db}#${d.table}.${d.column}`));
    for (const d of buildTime) expect((d.after as Cell).storageClass).toBe((d.before as Cell).storageClass);
    const differences = all.filter(d => !buildTime.includes(d));
    const count = (table: string) => differences.filter(d => d.table === table).length;
    expect(differences.every(d => d.db === 'slots/slotA/mistakes.db')).toBe(true);
    expect(differences.filter(d => d.table !== 'sqlite_sequence').every(d => d.kind === 'row' && d.before === null)).toBe(true);
    expect([count('document_tasks'), count('anki_cards'), count('fsrs_card_states'), count('__change_log')]).toEqual([3, 9, 8, 31]);
    expect(differences.length).toBe(3 + 9 + 8 + 31 + count('sqlite_sequence'));

    const before = reference.databases['slots/slotA/mistakes.db']!.tables.sqlite_sequence!.rows.find(r => r.values.name!.value === '__change_log');
    const after = seeded.databases['slots/slotA/mistakes.db']!.tables.sqlite_sequence!.rows.find(r => r.values.name!.value === '__change_log')!;
    expect(BigInt(after.values.seq!.value!) - BigInt(before?.values.seq!.value ?? 0)).toBe(31n);

    const log = differences.filter(d => d.table === '__change_log')
      .map(d => d.after as Record<string, Cell>)
      .sort((a, b) => Number(BigInt(a.id!.value!) - BigInt(b.id!.value!)))
      .map(v => [v.table_name!.value, v.record_id!.value, v.operation!.value, v.sync_version!.value, v.field_deltas_json!.value]);
    const entry = (table: string, id: string, op: string) => [table, id, op, '0', null];
    expect(log).toEqual([
      entry('document_tasks', 'task-review-cas', 'INSERT'),
      ...VERSIONS.map(v => entry('anki_cards', `card-rv-${v}`, 'INSERT')),
      entry('document_tasks', 'task-review-cas', 'UPDATE'),
      ...VERSIONS.flatMap(v => [entry('fsrs_card_states', `fsrs-state-card-rv-${v}`, 'INSERT'),
        entry('fsrs_card_states', `fsrs-state-card-rv-${v}`, 'UPDATE')]),
      entry('document_tasks', 'task-card-tombstone', 'INSERT'),
      entry('anki_cards', 'card-tombstone', 'INSERT'),
      entry('anki_cards', 'card-still-live', 'INSERT'),
      entry('document_tasks', 'task-card-tombstone', 'UPDATE'),
      entry('fsrs_card_states', 'fsrs-state-card-tombstone', 'INSERT'),
      entry('anki_cards', 'card-tombstone', 'UPDATE'),
      entry('document_tasks', 'task-tombstone', 'INSERT'),
      entry('anki_cards', 'card-live-child', 'INSERT'),
      entry('document_tasks', 'task-tombstone', 'UPDATE'),
      entry('fsrs_card_states', 'fsrs-state-card-live-child', 'INSERT'),
      entry('document_tasks', 'task-tombstone', 'UPDATE'),
    ]);
    expect(log.some(row => row[2] === 'DELETE')).toBe(false);
  });

  it('Rust suspend CAS SQL on a scratch copy: BigInt equality, tombstone guards; source and A1/A2/B unchanged', () => {
    const scratch = copySeed(NAME, catalog, join(root, 'scratch'));
    const conn = new Database(join(scratch.directory, MISTAKES));
    try {
      const statement = conn.prepare(SUSPEND_CAS);
      const suspend = (card: string, expected: bigint) => statement.run({ 1: 1, 2: '2026-07-15T00:00:00+00:00',
        3: `fsrs-state-${card}`, 4: card, 5: expected, 6: 0 }).changes;
      const version = (card: string) => conn.prepare('SELECT local_version AS v, typeof(local_version) AS t FROM fsrs_card_states WHERE anki_card_id = ?')
        .safeIntegers().get(card);
      // Stale neighbours (including Number-equal ones) never match.
      expect(suspend('card-rv-9007199254740993', 9007199254740992n)).toBe(0);
      expect(suspend('card-rv-9223372036854774784', 9223372036854774785n)).toBe(0);
      expect(suspend('card-rv-9223372036854775807', 9223372036854775806n)).toBe(0);
      expect(version('card-rv-9007199254740993')).toEqual({ v: 9007199254740993n, t: 'integer' });
      expect(suspend('card-rv-9007199254740993', 9007199254740993n)).toBe(1);
      expect(version('card-rv-9007199254740993')).toEqual({ v: 9007199254740994n, t: 'integer' });
      expect(suspend('card-rv-9223372036854774784', 9223372036854774784n)).toBe(1);
      expect(version('card-rv-9223372036854774784')).toEqual({ v: 9223372036854774785n, t: 'integer' });
      // SQLite integer overflow: i64::MAX + 1 is stored as REAL 2^63 (a raw SQL fact, not a business CAS verdict).
      expect(suspend('card-rv-9223372036854775807', 9223372036854775807n)).toBe(1);
      expect(version('card-rv-9223372036854775807')).toEqual({ v: 9223372036854775808, t: 'real' });
      // Tombstoned card / live child of tombstoned task are filtered by deleted_at, not missing.
      expect(suspend('card-tombstone', 0n)).toBe(0);
      expect(suspend('card-live-child', 0n)).toBe(0);
      expect(conn.prepare("SELECT count(*) AS n FROM fsrs_card_states WHERE anki_card_id IN ('card-tombstone','card-live-child') AND suspended = 0").get())
        .toEqual({ n: 2 });
    } finally { conn.close(); }
    expect(digest(source.directory)).toEqual(sourceDigest);
    expect(compareDatabaseStates(sourceState, snapshotDirectory(source.directory))).toEqual([]);
    for (const copy of copies) expect(digest(copy.directory)).toEqual(sourceDigest);
  });
});
