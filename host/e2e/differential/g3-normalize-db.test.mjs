import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { copyNormalizer } from './__fixtures__/normalizer.mjs';
import { tmpdir } from 'node:os';
import { buildCompare, DEFAULT_APPROVALS } from '../../../scripts/electron-migration/record/g3-compare.mjs';
import { loadApprovals } from '../../../scripts/electron-migration/record/g3-normalize.mjs';

// N-010 (__change_log sequence numbering + changed_at second tolerance), N-011 (generated
// "<prefix>_<nanoid>" ids without a digit), N-012 (tied rows paired by references, not by
// the sort position of their random key). Each positive case has negatives built from the
// same fixture with one real difference injected into B.

const sha = text => createHash('sha256').update(text).digest('hex');
const SLOT = 'app-data/com.deepstudent.differential/slots/slotA';
const VFS = `${SLOT}/databases/vfs.db`;
const SUITE = { scenarios: [{ id: 'db.rules', seed: 'empty', capture: { events: false, db: ['*'] }, normalize: [],
  steps: [{ cmd: 'upload_twice', args: {} }, { cmd: 'touch', args: {} }] }] };
const SUITE_TEXT = JSON.stringify(SUITE);
const BASE_RULES = [
  { id: 'N-001', decision: 'approved', columns: [] }, { id: 'N-002', decision: 'approved' },
  { id: 'N-003', decision: 'approved-with-conditions' }, { id: 'N-004', decision: 'approved' },
  { id: 'N-005', decision: 'approved-with-conditions' }, { id: 'N-006', decision: 'approved' }, { id: 'N-007', decision: 'approved' }];
const NEW_RULES = ['N-010', 'N-011', 'N-012'].map(id => ({ id, decision: 'approved' }));

const text = value => ({ storageClass: 'text', value });
const int = value => ({ storageClass: 'integer', value: String(value) });
const NULL = { storageClass: 'null', value: null };
const column = (name, cid, pk, type = 'TEXT') => ({ cid, name, type, notnull: 0, dflt_value: null, pk, hidden: 0 });
/** Rows in primary-key order, as snapshotDatabase captures them. */
function table(names, primaryKey, rows, types = {}) {
  const pk = values => primaryKey.map(name => values[name].storageClass === 'integer' ? values[name].value.padStart(20, '0') : values[name].value).join('\u0000');
  return { columns: names.map((name, i) => column(name, i, primaryKey.indexOf(name) + 1, types[name])), primaryKey,
    rows: [...rows].sort((x, y) => (pk(x) < pk(y) ? -1 : pk(x) > pk(y) ? 1 : 0)).map(values => ({ key: { kind: 'primary', values: Object.fromEntries(primaryKey.map(name => [name, values[name]])), occurrence: 0 }, values })) };
}
const database = tables => ({ metadata: { userVersion: 0, applicationId: 0 }, schema: [], tables });

const LOG = ['id', 'table_name', 'record_id', 'operation', 'changed_at', 'sync_version', 'field_deltas_json'];
/** One take of the workload: a folder, then two uploads (resource INSERT + UPDATE each). */
function take(t) {
  const log = t.log ?? [
    ['folders', t.folder, 'INSERT'], ['resources', t.r1, 'INSERT'], ['resources', t.r1, 'UPDATE'],
    ['resources', t.r2, 'INSERT'], ['resources', t.r2, 'UPDATE']];
  const logRows = log.map(([tableName, record, operation], i) => ({ id: int(i + 1), table_name: text(tableName), record_id: text(record),
    operation: text(operation), changed_at: t.seconds[i] === null ? NULL : text(t.seconds[i]), sync_version: int(0), field_deltas_json: NULL }));
  const tables = {
    __change_log: table(LOG, ['id'], logRows, { id: 'INTEGER', sync_version: 'INTEGER' }),
    folders: table(['id', 'title'], ['id'], [{ id: text(t.folder), title: text('inbox') }]),
    resources: table(['id', 'folder_id', 'name'], ['id'], [
      { id: text(t.r1), folder_id: text(t.folder), name: text(t.names?.[0] ?? 'a.txt') },
      { id: text(t.r2), folder_id: text(t.folder), name: text(t.names?.[1] ?? 'b.txt') }]),
  };
  if (t.units) {
    tables.vfs_index_units = table(['id', 'resource_id', 'state'], ['id'], [
      { id: text(t.units[0]), resource_id: text(t.r1), state: text('indexed') },
      { id: text(t.units[1]), resource_id: text(t.r2), state: text('indexed') }]);
  }
  if (t.parents) {
    // Two content-identical parents; only the children that reference them tell them apart.
    tables.a_parent = table(['id', 'kind'], ['id'], t.parents.map((id, i) => ({ id: text(id), kind: text(t.parentKinds?.[i] ?? 'x') })));
    tables.b_child = table(['id', 'parent_id', 'label'], ['id'], [
      { id: text(t.children[0]), parent_id: text(t.childParents?.[0] ?? t.parents[0]), label: text('first') },
      { id: text(t.children[1]), parent_id: text(t.childParents?.[1] ?? t.parents[1]), label: text('second') }]);
  }
  return { version: 0, databases: { [VFS]: database(tables) } };
}

function trace(side, t) {
  const empty = { version: 0, databases: { [VFS]: database({ __change_log: table(LOG, ['id'], [], { id: 'INTEGER', sync_version: 'INTEGER' }) }) } };
  const state = take(t);
  return { schema: 'wave0-v0-observation', side, scenario: 'db.rules', inputSha256: sha(SUITE_TEXT), eventScope: { kind: 'all' },
    before: { events: [], databases: empty },
    calls: [
      { command: 'upload_twice', argsRaw: '{}', outcome: { kind: 'result', raw: '{}' }, capture: { events: [], databases: state } },
      { command: 'touch', argsRaw: '{}', outcome: { kind: 'result', raw: '{}' }, capture: { events: [], databases: state } }],
    after: { events: [], databases: state }, finalDatabases: state };
}

// A1 spans three wall-clock seconds, A2 two, B one: the same writes, faster.
const A1 = { folder: 'fld_dIYaCTt0Ru', r1: 'res_mEyGzMDANT', r2: 'res_rttOjSyXRo',
  seconds: ['2026-11-06 14:53:08', '2026-11-06 14:53:08', '2026-11-06 14:53:08', '2026-11-06 14:53:10', '2026-11-06 14:53:11'] };
const A2 = { folder: 'fld_s3LT91LJcJ', r1: 'res_17LXWb18yd', r2: 'res_kbZ97z6sG0',
  seconds: ['2026-11-06 15:05:49', '2026-11-06 15:05:49', '2026-11-06 15:05:51', '2026-11-06 15:05:51', '2026-11-06 15:05:51'] };
const B = { folder: 'fld_34ymDVqHcS', r1: 'res__U_Tdnaabb', r2: 'res_Eun2rxp3dq',
  seconds: Array(5).fill('2026-11-06 14:58:07') };

const roots = [];
after(() => Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))));
async function setup(rules = [...BASE_RULES, ...NEW_RULES]) {
  const root = await mkdtemp(join(tmpdir(), 'w13-norm-db-'));
  roots.push(root);
  copyNormalizer(root);
  await writeFile(join(root, 'suite.json'), SUITE_TEXT);
  await writeFile(join(root, 'approvals.json'), JSON.stringify({ schema: 'g3-normalize-approvals/v1', rules }));
  let n = 0;
  return async ({ a1 = A1, a2 = A2, b = B }) => {
    const dir = join(root, String(n++));
    await mkdir(dir);
    const write = async (name, value) => { const file = join(dir, `${name}.json`); await writeFile(file, JSON.stringify(value)); return file; };
    return buildCompare({ scenarioFile: join(root, 'suite.json'), scenarioId: 'db.rules', root, approvalsFile: join(root, 'approvals.json'),
      aTrace: await write('A1', trace('A', a1)), bTrace: await write('B', trace('B', b)), a2Trace: await write('A2', trace('A', a2)) });
  };
}
const columnsOf = artifact => [...new Set(artifact.differences.flatMap(d => (d.sample ?? []).map(s => `${s.table}.${s.column ?? '<row>'}`)))].sort();

test('N-010: identical change-log sequences are equal although B lands in fewer seconds', async () => {
  const before = await (await setup(BASE_RULES))({});
  assert.equal(before.equal, false, 'reproduces the pseudo-difference without N-010');
  assert.ok(columnsOf(before).includes('__change_log.changed_at'));
  const run = await setup();
  const artifact = await run({});
  assert.deepEqual(artifact.differences, []);
  const entry = artifact.normalization.find(item => item.table === '__change_log' && item.column === 'changed_at');
  assert.equal(entry.rule, 'N-010');
  const record = artifact.normalization.find(item => item.table === '__change_log' && item.column === 'record_id');
  // Placeholders are numbered by first appearance of (table_name, operation, record_id) in the sequence.
  assert.deepEqual(record.A.map(item => item.normalized.value), record.B.map(item => item.normalized.value));
  assert.match(record.A[0].normalized.value, /record_id@folders:INSERT#0>$/);
});

test('N-010 negatives: a different target, order, missing row, format or backwards clock still fails', async () => {
  const run = await setup();
  const wrongTarget = await run({ b: { ...B, log: [['folders', B.folder, 'INSERT'], ['resources', B.r1, 'INSERT'], ['resources', B.r2, 'UPDATE'],
    ['resources', B.r2, 'INSERT'], ['resources', B.r2, 'UPDATE']] } });
  assert.ok(columnsOf(wrongTarget).includes('__change_log.record_id'), 'UPDATE of the other resource');
  const reordered = await run({ b: { ...B, log: [['folders', B.folder, 'INSERT'], ['resources', B.r1, 'UPDATE'], ['resources', B.r1, 'INSERT'],
    ['resources', B.r2, 'INSERT'], ['resources', B.r2, 'UPDATE']] } });
  assert.ok(columnsOf(reordered).includes('__change_log.operation'), 'UPDATE before INSERT');
  const missing = await run({ b: { ...B, seconds: B.seconds.slice(0, 4), log: [['folders', B.folder, 'INSERT'], ['resources', B.r1, 'INSERT'],
    ['resources', B.r1, 'UPDATE'], ['resources', B.r2, 'INSERT']] } });
  assert.ok(columnsOf(missing).includes('__change_log.<row>'), 'one change-log row fewer');
  const format = await run({ b: { ...B, seconds: Array(5).fill('2026-11-06T14:58:07.123Z') } });
  assert.ok(columnsOf(format).includes('__change_log.changed_at'), 'RFC3339 instead of datetime(\'now\')');
  const backwards = await run({ b: { ...B, seconds: ['2026-11-06 14:58:07', '2026-11-06 14:58:07', '2026-11-06 14:58:06', '2026-11-06 14:58:07', '2026-11-06 14:58:07'] } });
  assert.ok(columnsOf(backwards).includes('__change_log.changed_at'), 'clock goes backwards along the sequence');
  const nullTime = await run({ b: { ...B, seconds: [...B.seconds.slice(0, 4), null] } });
  assert.equal(nullTime.equal, false, 'null changed_at is not a timestamp');
  const content = await run({ b: { ...B, names: ['a.txt', 'c.txt'] } });
  assert.ok(columnsOf(content).includes('resources.name'), 'non-random column is still compared');
});

test('N-010 is inert unless approved, and only for the exact __change_log columns', async () => {
  const run = await setup([...BASE_RULES, ...NEW_RULES.filter(rule => rule.id !== 'N-010')]);
  const artifact = await run({});
  assert.ok(columnsOf(artifact).includes('__change_log.changed_at'));
  assert.ok(!artifact.normalization.some(item => item.rule === 'N-010'));
});

// unit_<10>: a nanoid without any digit is not randomLike on its own (one in ~5.5 draws).
const UNITS = { A1: ['unit_KKU1eEzLLO', 'unit_lKyWrgmMj-'], A2: ['unit_0KR6xTCPgG', 'unit_jjeVwQwoK3'], B: ['unit_tporzd4eeI', 'unit_QwErTyUiOp'] };

test('N-011: generated <prefix>_<nanoid> ids without a digit get placeholders on both sides', async () => {
  const before = await (await setup([...BASE_RULES, ...NEW_RULES.filter(rule => rule.id !== 'N-011')]))({
    a1: { ...A1, units: UNITS.A1 }, a2: { ...A2, units: UNITS.A2 }, b: { ...B, units: UNITS.B } });
  assert.ok(columnsOf(before).includes('vfs_index_units.<row>'), 'reproduces the literal-vs-placeholder pseudo-difference');
  const artifact = await (await setup())({ a1: { ...A1, units: UNITS.A1 }, a2: { ...A2, units: UNITS.A2 }, b: { ...B, units: UNITS.B } });
  assert.deepEqual(artifact.differences, []);
  const entry = artifact.normalization.find(item => item.table === 'vfs_index_units' && item.column === 'id');
  assert.deepEqual(entry.generated, ['unit_*10']);
  assert.ok(entry.A.every(item => item.normalized.value.startsWith('<@')));
});

test('N-011 negatives: other length, stable constants, single-case words and broken references still fail', async () => {
  const run = await setup();
  const shorter = await run({ a1: { ...A1, units: UNITS.A1 }, a2: { ...A2, units: UNITS.A2 }, b: { ...B, units: ['unit_tporzd4eeI', 'unit_QwErTy'] } });
  assert.ok(columnsOf(shorter).includes('vfs_index_units.<row>'), 'B id of another length is not the same generator');
  const constant = await run({ a1: { ...A1, units: ['unit_KKU1eEzLLO', 'unit_defaultA'] }, a2: { ...A2, units: ['unit_0KR6xTCPgG', 'unit_defaultA'] },
    b: { ...B, units: ['unit_tporzd4eeI', 'unit_defaultB'] } });
  assert.ok(columnsOf(constant).includes('vfs_index_units.<row>'), 'A1=A2 constant is kept literally');
  const words = await run({ a1: { ...A1, units: ['unit_KKU1eEzLLO', 'unit_startedok'] }, a2: { ...A2, units: ['unit_0KR6xTCPgG', 'unit_stoppedok'] },
    b: { ...B, units: ['unit_tporzd4eeI', 'unit_abortedok'] } });
  assert.ok(words.normalizationSkipped.some(item => item.table === 'vfs_index_units' && item.column === 'id'), 'lowercase words are not nanoids');
  assert.equal(words.equal, false);
  const dangling = await run({ a1: { ...A1, units: UNITS.A1 }, a2: { ...A2, units: UNITS.A2 },
    b: { ...B, units: UNITS.B, r2: 'res_Eun2rxp3dq', log: [['folders', B.folder, 'INSERT'], ['resources', B.r1, 'INSERT'], ['resources', B.r1, 'UPDATE'],
      ['resources', 'res_Zz9Zz9Zz9Z', 'INSERT'], ['resources', 'res_Zz9Zz9Zz9Z', 'UPDATE']] } });
  assert.equal(dangling.equal, false, 'change log names a resource that does not exist');
});

// p1/p2 sort A1:(p1<p2) but B:(p2<p1); the children say which is which.
const TIE = {
  A1: { parents: ['n_0aaaaaaaa1', 'n_9zzzzzzzz9'], children: ['n_1bbbbbbbb1', 'n_2cccccccc2'] },
  A2: { parents: ['n_0dddddddd1', 'n_9eeeeeeee9'], children: ['n_1ffffffff1', 'n_2gggggggg2'] },
  B: { parents: ['n_9hhhhhhhh9', 'n_0iiiiiiii1'], children: ['n_1jjjjjjjj1', 'n_2kkkkkkkk2'] },
};

test('N-012: content-identical rows are paired through the rows that reference them', async () => {
  const before = await (await setup([...BASE_RULES, ...NEW_RULES.filter(rule => rule.id !== 'N-012')]))({
    a1: { ...A1, ...TIE.A1 }, a2: { ...A2, ...TIE.A2 }, b: { ...B, ...TIE.B } });
  assert.ok(columnsOf(before).includes('b_child.parent_id'), 'reproduces the sort-position pseudo-difference');
  const artifact = await (await setup())({ a1: { ...A1, ...TIE.A1 }, a2: { ...A2, ...TIE.A2 }, b: { ...B, ...TIE.B } });
  assert.deepEqual(artifact.differences, []);
});

test('N-012 negatives: a parent with other content, or a child pointing at the wrong parent, still fails', async () => {
  const run = await setup();
  const content = await run({ a1: { ...A1, ...TIE.A1 }, a2: { ...A2, ...TIE.A2 }, b: { ...B, ...TIE.B, parentKinds: ['x', 'y'] } });
  assert.ok(columnsOf(content).some(item => item.startsWith('a_parent.')));
  const both = await run({ a1: { ...A1, ...TIE.A1 }, a2: { ...A2, ...TIE.A2 }, b: { ...B, ...TIE.B, childParents: [TIE.B.parents[0], TIE.B.parents[0]] } });
  assert.equal(both.equal, false, 'both children reference one parent');
});

test('repository approvals register N-010…N-012 and keep N-008/N-009 unapproved', () => {
  const approved = [...loadApprovals(DEFAULT_APPROVALS).approved];
  for (const id of ['N-010', 'N-011', 'N-012', 'N-013']) assert.ok(approved.includes(id), id);
  assert.ok(!approved.includes('N-008') && !approved.includes('N-009'));
});
