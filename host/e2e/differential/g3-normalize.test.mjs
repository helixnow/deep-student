import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { copyNormalizer } from './__fixtures__/normalizer.mjs';
import { buildCompare, DEFAULT_APPROVALS } from '../../../scripts/electron-migration/record/g3-compare.mjs';
import { loadApprovals, randomLike } from '../../../scripts/electron-migration/record/g3-normalize.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const SLOT = 'app-data/com.deepstudent.differential/slots/slotA';
const HSTS = 'app-data/com.deepstudent.differential/hsts-storage.sqlite';
const SUITE = { scenarios: [{ id: 'note.roundtrip', seed: 'empty', capture: { events: true, db: ['*'] }, normalize: [],
  steps: [{ cmd: 'note_create', args: { title: 't' } }, { cmd: 'note_get', args: { id: '${0.id}' } }] }] };
const SUITE_TEXT = JSON.stringify(SUITE);
const APPROVALS = { schema: 'g3-normalize-approvals/v1', rules: [
  { id: 'N-001', decision: 'approved', columns: ['mistakes.db/settings/updated_at'] },
  { id: 'N-002', decision: 'approved' }, { id: 'N-003', decision: 'approved-with-conditions' },
  { id: 'N-004', decision: 'approved' }, { id: 'N-005', decision: 'approved-with-conditions' }] };

test('prefixed nanoid ids are random-like even without a digit', () => {
  assert.equal(randomLike('res_-UF_FFMtAa'), true);
  assert.equal(randomLike('fi_XsBZOjsPrF'), true);
  assert.equal(randomLike('note_export'), false);
});

const uuid = digit => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const TAKES = { A1: { id: uuid('1'), at: '2026-11-06T01:00:00.111Z', audit: uuid('a') },
  A2: { id: uuid('2'), at: '2026-11-06T02:00:00.222Z', audit: uuid('b') },
  B: { id: uuid('3'), at: '2026-11-06T03:00:00.333Z', audit: uuid('c') } };

const text = value => ({ storageClass: 'text', value });
const column = (name, cid, pk = 0) => ({ cid, name, type: 'TEXT', notnull: 0, dflt_value: null, pk, hidden: 0 });
function table(names, primaryKey, rows) {
  return { columns: names.map((name, i) => column(name, i, primaryKey.indexOf(name) + 1)), primaryKey,
    rows: rows.map((values, index) => ({ key: primaryKey.length
      ? { kind: 'primary', values: Object.fromEntries(primaryKey.map(name => [name, values[name]])), occurrence: 0 }
      : { kind: 'ordinal', index }, values })) };
}
const database = tables => ({ metadata: { userVersion: 0, applicationId: 0 }, schema: [], tables });

function state(take, created, options) {
  const settingsAt = options.settingsAt ?? text(take.at);
  const databases = {
    [`${SLOT}/databases/vfs.db`]: database({ notes: table(['id', 'title', 'created_at'], ['id'],
      created ? [{ id: text(take.id), title: text('t'), created_at: text(take.at) }] : []) }),
    [`${SLOT}/mistakes.db`]: database({ settings: table(['key', 'value', 'updated_at'], ['key'],
      [{ key: text('theme'), value: text('dark'), updated_at: settingsAt }]) }),
    [`${SLOT}/databases/audit.db`]: database({ __audit_log: table(
      ['id', 'operation_type', 'target', 'operation_data', 'status', 'error_message', 'details', 'timestamp', 'duration_ms'], ['id'],
      created ? [{ id: text(take.audit), operation_type: text(options.auditOp ?? 'create'), target: text('note'),
        operation_data: text('{}'), status: text('ok'), error_message: { storageClass: 'null', value: null },
        details: text('{}'), timestamp: text(take.at), duration_ms: { storageClass: 'integer', value: String(take.at.length) } }] : []) }),
  };
  if (options.hsts) databases[HSTS] = database({ sts: table(['host'], [], [{ host: text(take.at) }]) });
  return { version: 0, databases };
}

/** One side's trace; `options` bends B (or A2) to produce the case under test. */
function trace(side, take, options = {}) {
  const idJson = options.idAsNumber ? '12345678901' : JSON.stringify(take.id);
  const created = `{"id":${idJson},"createdAt":"${take.at}","status":"${options.status ?? 'ok'}"}`;
  const events = [{ event: 'note:created', payloadRaw: `{"id":${idJson}}` }];
  const after = state(take, true, options);
  return { schema: 'wave0-v0-observation', side, scenario: 'note.roundtrip', inputSha256: sha(SUITE_TEXT), eventScope: { kind: 'all' },
    before: { events: [], databases: state(take, false, options) },
    calls: [
      { command: 'note_create', argsRaw: '{"title":"t"}', outcome: { kind: 'result', raw: created }, capture: { events, databases: after } },
      { command: 'note_get', argsRaw: `{"id":${JSON.stringify(options.getId ?? take.id)}}`,
        outcome: { kind: 'result', raw: `{"id":${idJson},"title":"${options.title ?? 't'}"}` }, capture: { events, databases: after } },
    ],
    after: { events, databases: after }, finalDatabases: after };
}

async function setup() {
  const root = await mkdtemp('/tmp/opencode/x7-norm-');
  // buildCompare hashes the normalizer relative to `root` for the evidence artifact;
  // mirror the repository path inside the temp tree.
  copyNormalizer(root);
  await writeFile(join(root, 'suite.json'), SUITE_TEXT);
  await writeFile(join(root, 'approvals.json'), JSON.stringify(APPROVALS));
  let n = 0;
  return async ({ a1 = {}, a2 = {}, b = {}, withA2 = true }) => {
    const dir = join(root, String(n++));
    await mkdir(dir);
    const write = async (name, value) => { const file = join(dir, `${name}.json`); await writeFile(file, JSON.stringify(value)); return file; };
    return buildCompare({ scenarioFile: join(root, 'suite.json'), scenarioId: 'note.roundtrip', root, approvalsFile: join(root, 'approvals.json'),
      aTrace: await write('A1', trace('A', TAKES.A1, { hsts: true, ...a1 })),
      bTrace: await write('B', trace('B', TAKES.B, b)),
      a2Trace: withA2 ? await write('A2', trace('A', TAKES.A2, { hsts: true, ...a2 })) : null });
  };
}

test('G3 normalize: approved rules make random ids/timestamps equal, with every substitution listed', async () => {
  const run = await setup();
  const artifact = await run({});
  assert.deepEqual(artifact.differences, []);
  assert.equal(artifact.equal, true);
  assert.equal(artifact.normalized, true);
  assert.equal(artifact.traces.A2.sha256.length, 64);
  assert.deepEqual(artifact.excludedFiles, [{ file: HSTS, rule: 'N-004', sides: ['A'] }]);
  const id = artifact.normalization.find(entry => entry.site === 's0:result' && entry.pointer === '/id');
  assert.equal(id.rule, 'N-003');
  assert.deepEqual([id.A1, id.A2, id.A, id.B], [TAKES.A1.id, TAKES.A2.id, TAKES.A1.id, TAKES.B.id]);
  assert.equal(id.placeholderA, id.placeholderB);
  // The reference in step 1 args reuses the placeholder from step 0 (one bijection per side).
  const ref = artifact.normalization.find(entry => entry.site === 's1:args' && entry.pointer === '/id');
  assert.equal(ref.rule, 'N-005');
  assert.equal(ref.placeholderA, id.placeholderA);
  const noteId = artifact.normalization.find(entry => entry.table === 'notes' && entry.column === 'id');
  assert.equal(noteId.rule, 'N-005');
  assert.equal(noteId.A[0].normalized.value, id.placeholderA);
  assert.equal(noteId.B[0].normalized.value, id.placeholderB);
  const settings = artifact.normalization.find(entry => entry.table === 'settings');
  assert.deepEqual([settings.rule, settings.column, settings.A[0].normalized.value], ['N-001', 'updated_at', '<ts>']);
  assert.ok(artifact.normalization.some(entry => entry.rule === 'N-002' && entry.multiset));
  assert.equal(artifact.approvals.sha256, sha(JSON.stringify(APPROVALS)));
});

test('G3 normalize: broken reference, JSON type change, B-only and non-random differences stay failures', async () => {
  const run = await setup();
  const broken = await run({ b: { getId: uuid('4') } });
  assert.equal(broken.equal, false);
  assert.ok(broken.differences.some(item => item.kind === 'args' && item.step === 1), 'B references an id it never created');
  const typed = await run({ b: { idAsNumber: true } });
  assert.ok(typed.differences.some(item => item.kind === 'outcome' && item.step === 0), 'string id in A, number in B');
  const bOnly = await run({ b: { title: 'x' } });
  assert.ok(bOnly.differences.some(item => item.kind === 'outcome' && item.step === 1));
  assert.ok(!bOnly.normalization.some(entry => entry.pointer === '/title'), 'A1=A2 path is never normalized');
  const word = await run({ a2: { status: 'done' }, b: { status: 'done' } });
  assert.ok(word.normalizationSkipped.some(item => item.pointer === '/status'), 'status word is not a random id');
  assert.ok(word.differences.some(item => item.kind === 'outcome' && item.step === 0));
  const audit = await run({ b: { auditOp: 'delete' } });
  assert.ok(audit.differences.some(item => item.kind === 'database'), 'audit multiset compares the projected columns');
  const storage = await run({ b: { settingsAt: { storageClass: 'integer', value: '1730854800000' } } });
  assert.ok(storage.differences.some(item => item.kind === 'database'), 'N-001 keeps storageClass');
});

test('G3 normalize: without A2 nothing is normalized; repository approvals snapshot carries every approved rule', async () => {
  const run = await setup();
  const raw = await run({ withA2: false });
  assert.equal(raw.normalized, false);
  assert.deepEqual(raw.normalization, []);
  assert.equal(raw.equal, false);
  assert.deepEqual([...loadApprovals(DEFAULT_APPROVALS).approved], ['N-001', 'N-002', 'N-003', 'N-004', 'N-005', 'N-006', 'N-007', 'N-010', 'N-011', 'N-012', 'N-013', 'N-014', 'N-015', 'N-016', 'N-017']);
});
