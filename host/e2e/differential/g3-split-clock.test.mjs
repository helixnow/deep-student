import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { copyNormalizer } from './__fixtures__/normalizer.mjs';
import { tmpdir } from 'node:os';
import { buildCompare } from '../../../scripts/electron-migration/record/g3-compare.mjs';

// N-014 (split recording: A/A2 from an A store, B recorded later) and N-015 (get_app_version
// build number and commit). Synthetic traces shaped like the ser-38 B smoke of 2026-11-07:
// A1 and A2 ran together and wrote the same second, B ran six minutes later.

const sha = text => createHash('sha256').update(text).digest('hex');
const VFS = 'app-data/com.deepstudent.differential/slots/slotA/databases/vfs.db';
const SUITE = { scenarios: [{ id: 'clock.rules', seed: 'empty', capture: { events: false, db: ['*'] }, normalize: [],
  steps: [{ cmd: 'create_note', args: {} }, { cmd: 'get_app_version', args: {} }] }] };
const SUITE_TEXT = JSON.stringify(SUITE);
const BASE_RULES = [
  { id: 'N-001', decision: 'approved', columns: [] }, { id: 'N-002', decision: 'approved' },
  { id: 'N-003', decision: 'approved-with-conditions' }, { id: 'N-004', decision: 'approved' },
  { id: 'N-005', decision: 'approved-with-conditions' }, { id: 'N-006', decision: 'approved' }, { id: 'N-007', decision: 'approved' },
  ...['N-010', 'N-011', 'N-012'].map(id => ({ id, decision: 'approved' }))];
const N014 = { id: 'N-014', decision: 'approved' }, N015 = { id: 'N-015', decision: 'approved' };

const text = value => ({ storageClass: 'text', value });
const int = value => ({ storageClass: 'integer', value: String(value) });
const column = (name, cid, pk, type = 'TEXT') => ({ cid, name, type, notnull: 0, dflt_value: null, pk, hidden: 0 });
const table = (names, primaryKey, rows, types = {}) => ({ columns: names.map((name, i) => column(name, i, primaryKey.indexOf(name) + 1, types[name])), primaryKey,
  rows: rows.map(values => ({ key: { kind: 'primary', values: Object.fromEntries(primaryKey.map(name => [name, values[name]])), occurrence: 0 }, values })) });
const database = tables => ({ metadata: { userVersion: 0, applicationId: 0 }, schema: [], tables });

const LOG = ['id', 'table_name', 'record_id', 'operation', 'changed_at'];
/** One take: a seeded note (historical seeded_at) and a created one; change log; JSON outcome with createdAt. */
function trace(side, t, recording = null) {
  const notes = table(['id', 'title', 'seeded_at', 'created_at', 'updated_ms'], ['id'], [
    { id: text('n0'), title: text('seed'), seeded_at: text(t.seeded ?? '2024-01-01 08:00:00'), created_at: text(t.seeded ?? '2024-01-01 08:00:00'), updated_ms: int(t.seedMs ?? 1704096000000) },
    { id: text('n1'), title: text('first'), seeded_at: text('2024-01-01 08:00:00'), created_at: text(t.created[0]), updated_ms: int(t.ms[0]) },
    { id: text('n2'), title: text('second'), seeded_at: text('2024-01-01 08:00:00'), created_at: text(t.created[1]), updated_ms: int(t.ms[1]) }], { updated_ms: 'INTEGER' });
  const log = table(LOG, ['id'], t.changed.map((at, i) => ({ id: int(i + 1), table_name: text('notes'), record_id: text(`n${i + 1}`),
    operation: text('INSERT'), changed_at: text(at) })), { id: 'INTEGER' });
  const state = { version: 0, databases: { [VFS]: database({ __change_log: log, notes }) } };
  const empty = { version: 0, databases: { [VFS]: database({ __change_log: table(LOG, ['id'], [], { id: 'INTEGER' }), notes: table(['id', 'title', 'seeded_at', 'created_at', 'updated_ms'], ['id'], [], { updated_ms: 'INTEGER' }) }) } };
  return { schema: 'wave0-v0-observation', side, scenario: 'clock.rules', inputSha256: sha(SUITE_TEXT), eventScope: { kind: 'all' },
    ...(recording ? { recording } : {}),
    before: { events: [], databases: empty },
    calls: [
      { command: 'create_note', argsRaw: '{}', outcome: { kind: 'result', raw: JSON.stringify({ id: 'n1', createdAt: t.iso }) }, capture: { events: [], databases: state } },
      { command: 'get_app_version', argsRaw: '{}', outcome: { kind: 'result', raw: JSON.stringify(t.version ?? '0.11.0 (Build 26056, ec19ff0f)') }, capture: { events: [], databases: state } }],
    after: { events: [], databases: state }, finalDatabases: state };
}

// A1 and A2 recorded together (same second everywhere); B six minutes later.
const A = { created: ['2026-11-07 01:20:16', '2026-11-07 01:20:16'], changed: ['2026-11-07 01:20:16', '2026-11-07 01:20:16'],
  ms: [Date.parse('2026-11-07T01:20:16.100Z'), Date.parse('2026-11-07T01:20:16.400Z')], iso: '2026-11-07T01:20:16.900Z' };
const B = { created: ['2026-11-07 01:26:26', '2026-11-07 01:26:26'], changed: ['2026-11-07 01:26:26', '2026-11-07 01:26:27'],
  ms: [Date.parse('2026-11-07T01:26:26.300Z'), Date.parse('2026-11-07T01:26:26.350Z')], iso: '2026-11-07T01:26:26.500Z', version: '0.11.0 (Build 26651, 007c1af5)' };
const A_WINDOW = { from: Date.parse('2026-11-07T01:19:40Z'), to: Date.parse('2026-11-07T01:20:30Z') };
const B_RECORDING = { workerStartedAt: '2026-11-07T01:26:00.000Z', startedAt: '2026-11-07T01:26:10.000Z', endedAt: '2026-11-07T01:26:40.000Z' };

async function setup(t, rules = [...BASE_RULES, N014, N015]) {
  const root = await mkdtemp(join(tmpdir(), 'w13-split-clock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  copyNormalizer(root);
  await writeFile(join(root, 'suite.json'), SUITE_TEXT);
  await writeFile(join(root, 'approvals.json'), JSON.stringify({ schema: 'g3-normalize-approvals/v1', rules }));
  let n = 0;
  return async ({ a1 = A, a2 = a1, b = B, split = true, aWindow = A_WINDOW, aRecording = null, bRecording = B_RECORDING } = {}) => {
    const dir = join(root, String(n++));
    await mkdir(dir);
    const write = async (name, value) => { const file = join(dir, `${name}.json`); await writeFile(file, JSON.stringify(value)); return file; };
    return buildCompare({ scenarioFile: join(root, 'suite.json'), scenarioId: 'clock.rules', root, approvalsFile: join(root, 'approvals.json'),
      aTrace: await write('A1', trace('A', a1, aRecording)), a2Trace: await write('A2', trace('A', a2, aRecording)), bTrace: await write('B', trace('B', b, bRecording)),
      split, aWindow });
  };
}
const kinds = artifact => artifact.differences.map(d => `${d.step}:${d.kind}`);
const cells = artifact => [...new Set(artifact.differences.flatMap(d => (d.sample ?? []).filter(s => s.table).map(s => `${s.table}.${s.column ?? '<row>'}`)))].sort();
const clockEntries = artifact => artifact.normalization.filter(entry => entry.rule === 'N-014');

test('N-014: same-second A values inside the A window no longer differ from later B values (DB text, epoch ms, JSON ISO)', async t => {
  const run = await setup(t);
  const without = await run({ split: false });
  assert.equal(without.equal, false, 'reproduces the ser-38 pseudo-difference');
  assert.deepEqual(cells(without), ['__change_log.changed_at', 'notes.created_at', 'notes.updated_ms']);
  assert.ok(without.differences.some(d => d.kind === 'outcome' && d.step === 0));

  const artifact = await run();
  assert.deepEqual(artifact.differences, [], JSON.stringify(artifact.differences, null, 1));
  assert.deepEqual(artifact.splitRecording.A, { from: '2026-11-07T01:19:40.000Z', to: '2026-11-07T01:20:30.000Z' });
  assert.deepEqual(artifact.splitRecording.B, { from: '2026-11-07T01:26:00.000Z', to: '2026-11-07T01:26:40.000Z' }, 'B window from its worker start');
  const [a, b, order] = clockEntries(artifact);
  assert.equal(a.side, 'A'); assert.equal(b.side, 'B');
  assert.ok(a.replaced > 0 && a.replaced === b.replaced);
  assert.ok(a.samples.some(sample => sample.normalized === '<tw:YYYY-MM-DD hh:mm:ss>'));
  // The JSON createdAt (ms) and changed_at (s) of the same moment are compared at whole seconds: no inversion.
  assert.ok(order.order.shared > 0);
  assert.equal(order.order.inversions, 0);

  const recorded = await run({ aWindow: null, aRecording: { workerStartedAt: '2026-11-07T01:19:40Z', startedAt: '2026-11-07T01:19:50Z', endedAt: '2026-11-07T01:20:30Z' } });
  assert.deepEqual(recorded.differences, [], 'the A trace\'s own recording window works the same as --a-window');
});

test('N-014: values outside each side\'s window (seed history) are still compared verbatim', async t => {
  const run = await setup(t);
  const history = await run({ b: { ...B, seeded: '2024-01-02 08:00:00', seedMs: 1704182400000 } });
  assert.deepEqual(cells(history), ['notes.created_at', 'notes.seeded_at', 'notes.updated_ms']);
  const seeded = history.differences.flatMap(d => d.sample ?? []).find(s => s.column === 'seeded_at');
  assert.equal(seeded.before.value, '2024-01-01 08:00:00');
  assert.equal(seeded.after.value, '2024-01-02 08:00:00');
  // A constant on B that happens to sit in A's window is not a clock reading of B: still a difference.
  const constant = await run({ b: { ...B, created: ['2026-11-07 01:20:16', B.created[1]] } });
  assert.deepEqual(cells(constant), ['notes.created_at']);
});

test('N-014: two timestamps of one scenario in the opposite order on B are reported', async t => {
  const run = await setup(t);
  // A: n1 before n2 by 300 ms (epoch ms); B: n2 before n1.
  const swapped = await run({ b: { ...B, ms: [B.ms[1] + 50, B.ms[0]] } });
  assert.equal(swapped.equal, false);
  const order = swapped.differences.filter(d => d.kind === 'timestamp-order');
  assert.ok(order.length >= 1, JSON.stringify(swapped.differences));
  assert.equal(order[0].rule, 'N-014');
  assert.equal(order[0].step, 0, 'attributed to the step whose capture first shows the pair');
  assert.equal(order[0].command, 'create_note');
  assert.ok(order[0].sample.some(pair => /updated_ms/.test(pair.first) && /updated_ms/.test(pair.second)));
  // Equal on one side (same second) is not an order: B spreading A's single second over two is fine.
  assert.equal(clockEntries(await run()).at(-1).order.inversions, 0);
});

test('N-014: where A1 and A2 differ the existing rules decide, as without N-014; combined recording is untouched', async t => {
  const run = await setup(t);
  const plain = await setup(t, [...BASE_RULES, N015]);
  // A2 one second later in changed_at: N-010 owns the column; B going backwards stays a difference.
  const a2 = { ...A, changed: ['2026-11-07 01:20:17', '2026-11-07 01:20:17'] };
  const backwards = { ...B, changed: ['2026-11-07 01:26:27', '2026-11-07 01:26:26'] };
  const withRule = await run({ a2, b: backwards }), withoutRule = await plain({ a2, b: backwards });
  assert.ok(cells(withoutRule).includes('__change_log.changed_at'));
  assert.ok(cells(withRule).includes('__change_log.changed_at'), 'N-014 does not hide an N-010 failure');
  const changedAt = artifact => artifact.differences.flatMap(d => (d.sample ?? []).filter(s => s.column === 'changed_at'));
  assert.deepEqual(changedAt(withRule), changedAt(withoutRule));
  for (const entry of clockEntries(withRule).filter(item => item.side)) assert.ok(entry.samples.every(sample => !sample.location.includes('changed_at')));

  // Not split (combined recording), overlapping windows, or no window: N-014 does nothing.
  const combined = await run({ split: false });
  assert.equal(clockEntries(combined).length, 0);
  const overlap = await run({ aWindow: { from: Date.parse('2026-11-07T01:19:40Z'), to: Date.parse('2026-11-07T01:26:05Z') } });
  assert.deepEqual(overlap.normalizationSkipped.filter(item => item.rule === 'N-014').map(item => item.reason), ['A and B recording windows overlap']);
  assert.deepEqual(kinds(overlap), kinds(combined));
  const missing = await run({ bRecording: null });
  assert.deepEqual(missing.normalizationSkipped.filter(item => item.rule === 'N-014').map(item => item.reason), ['no recording window for B']);
  // Proposed (not approved): nothing changes.
  const proposed = await (await setup(t, [...BASE_RULES, { id: 'N-014', decision: 'proposed' }, N015]))();
  assert.deepEqual(kinds(proposed), kinds(combined));
});

test('N-015: get_app_version keeps its version; only the build number and commit are masked', async t => {
  const run = await setup(t);
  const versionDiffs = artifact => artifact.differences.filter(d => d.command === 'get_app_version' && d.kind === 'outcome');
  const masked = await run();
  assert.deepEqual(versionDiffs(masked), []);
  assert.deepEqual(masked.normalization.filter(entry => entry.rule === 'N-015').map(entry => [entry.side, entry.normalized]),
    [['A', '0.11.0 (Build <build>, <commit>)'], ['B', '0.11.0 (Build <build>, <commit>)']]);
  assert.equal(versionDiffs(await run({ b: { ...B, version: '0.12.0 (Build 26651, 007c1af5)' } })).length, 1, 'version change still reported');
  assert.equal(versionDiffs(await run({ b: { ...B, version: '0.11.0' } })).length, 1, 'format change still reported');
  const off = await (await setup(t, [...BASE_RULES, N014]))();
  assert.equal(versionDiffs(off).length, 1, 'inactive until approved');
});
