import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { copyNormalizer } from './__fixtures__/normalizer.mjs';
import { tmpdir } from 'node:os';
import { buildCompare, DEFAULT_APPROVALS } from '../../../scripts/electron-migration/record/g3-compare.mjs';
import { loadApprovals, RULE_IDS } from '../../../scripts/electron-migration/record/g3-normalize.mjs';

// W13 r7 proposals N-016 (AEAD envelope bodies) and N-017 (placeholders named after a stable
// primary key), and the vfs.db __change_log.changed_at values of the ser-38 B smoke, all under the
// repository approvals file. Values are the smoke's own (g3-b-smoke-007c1af54c3e,
// review.essay.scripted.stream-success-round-persisted): vendor ids, apiKey envelopes, change-log seconds.

const sha = text => createHash('sha256').update(text).digest('hex');
const SLOT = 'app-data/com.deepstudent.differential/slots/slotA';
const MISTAKES = `${SLOT}/mistakes.db`, VFS = `${SLOT}/databases/vfs.db`;
const SUITE = { scenarios: [{ id: 'proposals', seed: 'empty', capture: { events: false, db: ['*'] }, normalize: [],
  steps: [{ cmd: 'save_api_configurations', args: {} }, { cmd: 'get_vendor_configs', args: {} }] }] };
const SUITE_TEXT = JSON.stringify(SUITE);
const REPOSITORY = JSON.parse(await readFile(DEFAULT_APPROVALS, 'utf8'));
/** The repository approvals with some decisions replaced (as if the main agent had approved them). */
const approvals = (decisions = {}) => ({ ...REPOSITORY, rules: REPOSITORY.rules.map(rule => (decisions[rule.id] ? { ...rule, decision: decisions[rule.id] } : rule)) });
const BOTH = { 'N-016': 'approved', 'N-017': 'approved' };
const PROPOSED = { 'N-016': 'proposed', 'N-017': 'proposed' };

const text = value => ({ storageClass: 'text', value });
const int = value => ({ storageClass: 'integer', value: String(value) });
const column = (name, cid, pk, type = 'TEXT') => ({ cid, name, type, notnull: 0, dflt_value: null, pk, hidden: 0 });
function table(names, primaryKey, rows, types = {}) {
  const pk = values => primaryKey.map(name => values[name].storageClass === 'integer' ? values[name].value.padStart(20, '0') : values[name].value).join('\u0000');
  return { columns: names.map((name, i) => column(name, i, primaryKey.indexOf(name) + 1, types[name])), primaryKey,
    rows: [...rows].sort((x, y) => (pk(x) < pk(y) ? -1 : pk(x) > pk(y) ? 1 : 0)).map(values => ({ key: { kind: 'primary', values: Object.fromEntries(primaryKey.map(name => [name, values[name]])), occurrence: 0 }, values })) };
}
const database = tables => ({ metadata: { userVersion: 0, applicationId: 0 }, schema: [], tables });
const envelope = ({ ciphertext, nonce, version = 2 }) => JSON.stringify({ ciphertext, nonce, version });

/** mistakes.db after save_api_configurations: settings (vendor + model JSON) and a stored secret. */
function mistakes(t, sealed) {
  const settings = [];
  if (t.lance) settings.push({ key: text('lance.optimize.last.chat'), value: text(t.lance[0]) }, { key: text('lance.optimize.last.kb'), value: text(t.lance[1]) });
  if (sealed) {
    if (!t.dropProfiles) settings.push({ key: text('model_profiles'), value: text(JSON.stringify([{ id: 'wp229-mock', vendorId: `vendor-${t.vendorRef ?? t.vendor}`, label: 'WP229 wp229-mock' }])) });
    settings.push({ key: text('vendor_configs'), value: text(JSON.stringify([{ id: `vendor-${t.vendor}`, name: 'WP229 wp229-mock',
      baseUrl: 'http://127.0.0.1:47110/s/review.essay.scripted.stream-success-round-persisted/v1', apiKey: t.apiKey ?? envelope(sealed.key) }])) });
  }
  return database({
    settings: table(['key', 'value'], ['key'], settings),
    api_secrets: table(['name', 'envelope'], ['name'], sealed ? [{ name: text('web_search'), envelope: text(envelope(sealed.secret)) }] : []),
    sessions: table(['id', 'title'], ['id'], sealed ? [{ id: text(t.session), title: text('essay') }] : []),
  });
}

function trace(side, t) {
  const state = sealed => ({ version: 0, databases: { [MISTAKES]: mistakes(t, sealed) } });
  const saved = state({ key: t.key, secret: t.secret }), later = state({ key: t.laterKey ?? t.key, secret: t.secret });
  return { schema: 'wave0-v0-observation', side, scenario: 'proposals', inputSha256: sha(SUITE_TEXT), eventScope: { kind: 'all' },
    before: { events: [], databases: state(null) },
    calls: [
      { command: 'save_api_configurations', argsRaw: '{}', outcome: { kind: 'result', raw: 'null' }, capture: { events: [], databases: saved } },
      { command: 'get_vendor_configs', argsRaw: '{}', outcome: { kind: 'result', raw: JSON.stringify([{ id: `vendor-${t.vendor}`, apiKey: t.apiKey ?? envelope(t.laterKey ?? t.key) }]) },
        capture: { events: [], databases: later } }],
    after: { events: [], databases: later }, finalDatabases: later };
}

// A1/A2 also hold the two lance.optimize.last.* rows B does not write (the real startup difference that shifted #6.1 → #4.1).
const A1 = { vendor: '797caf0f-bdff-4c4d-b1a2-0d584aef666c', session: 'sess_8f3k2j1h0g', lance: ['2026-11-07T01:20:10.395227841+00:00', '2026-11-07T01:20:10.399109752+00:00'],
  key: { ciphertext: '1t36JBi0YXXP0Qf6mjTcUj7PXu1cTaKGC8jCONE8', nonce: 'fvsqyH0NLg62hVtt' }, secret: { ciphertext: 'kJ3q9Zr0bH1sT6Lw2Y+e8Q==', nonce: 'Aq1Wd2Xs3Ce4Rf5V' } };
const A2 = { vendor: '1b4facba-8268-4ae7-842f-a8e29fc9da09', session: 'sess_1q2w3e4r5t', lance: ['2026-11-07T01:20:12.101515000+00:00', '2026-11-07T01:20:12.104900310+00:00'],
  key: { ciphertext: 'y0xti2qnDbnFESi0hL/N1iV5+NOUxb0jKefCwlL4', nonce: 'QNoxHbXOiZF5kqAd' }, secret: { ciphertext: 'Pz8Yx7Wv6Ut5Sr4Qp3On2A==', nonce: 'Zx9Cv8Bn7Mm6Ll5K' } };
const B = { vendor: 'cbe02823-f6c7-4e57-a97a-141de8a350a0', session: 'sess_9o8i7u6y5t',
  key: { ciphertext: '8X/say0LRkH0upnw6p/tMv4FND6uLwuKoJLhH/YV', nonce: 'zy+Arsd2pRVQFP2n' }, secret: { ciphertext: 'Mn4Bv5Cx6Za7Sd8Fg9Hj0Q==', nonce: 'Qw1Er2Ty3Ui4Op5A' } };

async function setup(t, decisions = {}, file = approvals(decisions)) {
  const root = await mkdtemp(join(tmpdir(), 'w13-proposals-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  copyNormalizer(root);
  await writeFile(join(root, 'suite.json'), SUITE_TEXT);
  await writeFile(join(root, 'approvals.json'), JSON.stringify(file));
  let n = 0;
  return async ({ a1 = A1, a2 = A2, b = B } = {}) => {
    const dir = join(root, String(n++));
    await mkdir(dir);
    const write = async (name, value) => { const file = join(dir, `${name}.json`); await writeFile(file, JSON.stringify(value)); return file; };
    return buildCompare({ scenarioFile: join(root, 'suite.json'), scenarioId: 'proposals', root, approvalsFile: join(root, 'approvals.json'),
      aTrace: await write('A1', trace('A', a1)), a2Trace: await write('A2', trace('A', a2)), bTrace: await write('B', trace('B', b)) });
  };
}
/** "table.column@key" (column "<row>" for whole rows) of every DB difference, plus "step:outcome". */
const found = artifact => [...new Set(artifact.differences.flatMap(d => d.kind === 'outcome' ? [`${d.step}:outcome`]
  : (d.sample ?? []).filter(s => s.table).map(s => `${s.table}.${s.column ?? '<row>'}@${Object.values(s.key?.values ?? {}).map(cell => cell.value).join(',')}`)))].sort();
const LANCE = ['settings.<row>@lance.optimize.last.chat', 'settings.<row>@lance.optimize.last.kb'];
const settingsValue = (artifact, key) => artifact.differences.flatMap(d => d.sample ?? []).find(s => s.table === 'settings' && s.column === 'value' && s.key.values.key.value === key);

test('N-016 + N-017: the save_api_configurations rows of the ser-38 smoke are equal; only the A-only lance rows remain', async t => {
  const proposed = await (await setup(t, PROPOSED))();
  assert.deepEqual(found(proposed), ['1:outcome', 'api_secrets.envelope@web_search', ...LANCE, 'settings.value@model_profiles', 'settings.value@vendor_configs'],
    'reproduces the smoke (proposed rules are inert)');

  // N-016 alone: envelopes are placeholders, but A's two extra rows still shift the rank names
  // (vendor id first named in model_profiles: #2 on A, #0 on B; the envelope in vendor_configs: #3 / #1).
  const sealedOnly = await (await setup(t, { ...PROPOSED, 'N-016': 'approved' }))();
  assert.deepEqual(found(sealedOnly), ['1:outcome', ...LANCE, 'settings.value@model_profiles', 'settings.value@vendor_configs']);
  const shifted = settingsValue(sealedOnly, 'vendor_configs');
  assert.match(shifted.before.value, /"id":"vendor-<@u1:mistakes\.db\/settings\/value#2\.1>".*value#3\.3~b64\*40>.*value#3\.5~b64\*16>/);
  assert.match(shifted.after.value, /"id":"vendor-<@u1:mistakes\.db\/settings\/value#0\.1>".*value#1\.3~b64\*40>.*value#1\.5~b64\*16>/);
  assert.equal(shifted.before.value.replaceAll('value#2.', 'value#0.').replaceAll('value#3.', 'value#1.'), shifted.after.value, 'only the rank differs');

  // N-017 alone: names agree, the ciphertext and nonce stay literal.
  const keyedOnly = await (await setup(t, { ...PROPOSED, 'N-017': 'approved' }))();
  assert.deepEqual(found(keyedOnly), ['1:outcome', 'api_secrets.envelope@web_search', ...LANCE, 'settings.value@vendor_configs']);
  assert.ok(settingsValue(keyedOnly, 'vendor_configs').before.value.includes(A1.key.ciphertext));

  const artifact = await (await setup(t, BOTH))();
  assert.deepEqual(found(artifact), LANCE, JSON.stringify(artifact.differences, null, 1));
  const entries = rule => artifact.normalization.filter(entry => entry.rule === rule);
  assert.deepEqual(entries('N-017').map(entry => [entry.side, entry.table, entry.primaryKey]).sort(),
    [['A', 'api_secrets', ['name']], ['A', 'settings', ['key']], ['B', 'api_secrets', ['name']], ['B', 'settings', ['key']]]);
  const sealed = entries('N-016');
  assert.deepEqual([...new Set(sealed.map(entry => `${entry.side}:${entry.table ?? entry.site}${entry.pointer ?? '.' + entry.column}`))].sort(),
    ['A:api_secrets.envelope', 'A:s1:result/0/apiKey', 'A:settings.value', 'B:api_secrets.envelope', 'B:s1:result/0/apiKey', 'B:settings.value']);
  const settingsA = sealed.find(entry => entry.side === 'A' && entry.table === 'settings');
  assert.deepEqual(settingsA.samples.slice(0, 2), [
    { value: A1.key.ciphertext, placeholder: "<@u1:mistakes.db/settings[key='vendor_configs']/value.3~b64*40>" },
    { value: A1.key.nonce, placeholder: "<@u1:mistakes.db/settings[key='vendor_configs']/value.5~b64*16>" }]);
  // The vendor id is first seen in model_profiles (key order), and vendor_configs reuses that name.
  const record = artifact.normalization.find(entry => entry.table === 'settings' && entry.column === 'value');
  const configs = record.B.find(item => item.value.includes('"id":"vendor-'));
  assert.match(configs.normalized.value, /"id":"vendor-<@u1:mistakes\.db\/settings\[key='model_profiles'\]\/value\.1>"/);
  // The command outcome refers to the stored envelope: same placeholders as the DB cell.
  const outcome = artifact.normalization.find(entry => entry.site === 's1:result' && entry.pointer === '/0/apiKey');
  assert.ok(outcome.placeholderB.includes("settings[key='vendor_configs']/value.3~b64*40>"));
});

test('N-016 negatives: length, version, key order, plaintext, re-encryption and A-stable envelopes are still compared', async t => {
  const run = await setup(t, BOTH);
  const vendor = artifact => found(artifact).filter(item => !LANCE.includes(item));
  const longer = await run({ b: { ...B, key: { ...B.key, ciphertext: `${B.key.ciphertext}AbCd` } } });
  assert.deepEqual(vendor(longer), ['1:outcome', 'settings.value@vendor_configs'], 'plaintext of another length');
  const nonce = await run({ b: { ...B, key: { ...B.key, nonce: 'zy+Arsd2pRVQFP2nAbCdEfGh' } } });
  assert.deepEqual(vendor(nonce), ['1:outcome', 'settings.value@vendor_configs'], 'another nonce size');
  const version = await run({ b: { ...B, key: { ...B.key, version: 3 } } });
  assert.deepEqual(vendor(version), ['1:outcome', 'settings.value@vendor_configs'], 'envelope version');
  const plaintext = await run({ b: { ...B, apiKey: 'sk-wp229-mock-key' } });
  assert.deepEqual(vendor(plaintext), ['1:outcome', 'settings.value@vendor_configs'], 'B stores the key unencrypted');
  const reordered = await run({ b: { ...B, apiKey: JSON.stringify({ nonce: B.key.nonce, ciphertext: B.key.ciphertext, version: 2 }) } });
  assert.deepEqual(vendor(reordered), ['1:outcome', 'settings.value@vendor_configs'], 'other key order is another format');
  // B encrypts again on the read while A keeps the stored envelope: the placeholder changes on B only.
  const again = await run({ b: { ...B, laterKey: { ciphertext: 'Qm9vT2tBbm90aGVyQ2lwaGVydGV4dDEyMzQ1Njc4', nonce: 'TjBuY2UyMDI2MTEw' } } });
  assert.equal(again.equal, false);
  assert.ok(again.differences.some(d => d.step === 1 && d.kind === 'database'), JSON.stringify(found(again)));
  assert.ok(!again.differences.some(d => d.step === 0 && d.kind === 'database' && d.sample.some(s => s.table !== 'settings' || s.column === 'value')),
    'the first capture still agrees');
  // A1 and A2 hold the same envelope (seeded): never a placeholder, B must match it byte for byte.
  const seeded = await run({ a2: { ...A2, key: A1.key, secret: A1.secret } });
  assert.deepEqual(vendor(seeded), ['1:outcome', 'api_secrets.envelope@web_search', 'settings.value@vendor_configs']);
});

test('N-017 negatives: a wrong reference or a missing row still fails; random primary keys keep rank names', async t => {
  const run = await setup(t, BOTH);
  const vendor = artifact => found(artifact).filter(item => !LANCE.includes(item));
  // B's model points at another vendor: B's real vendor id gets a name of its own in vendor_configs (and the outcome).
  const wrong = await run({ b: { ...B, vendorRef: '00000000-1111-4222-8333-444444444444' } });
  assert.deepEqual(vendor(wrong), ['1:outcome', 'settings.value@vendor_configs'], 'model points at another vendor');
  const missing = await run({ b: { ...B, dropProfiles: true } });
  assert.ok(vendor(missing).includes('settings.<row>@model_profiles'));
  const artifact = await run();
  const sessions = artifact.normalization.find(entry => entry.table === 'sessions' && entry.column === 'id');
  assert.deepEqual(sessions.B.map(item => item.normalized.value), ['<@u1:mistakes.db/sessions/id#0>']);
  assert.ok(!artifact.normalization.some(entry => entry.rule === 'N-017' && entry.table === 'sessions'));
});

test('repository approvals: N-016 and N-017 are registered as approved, with evidence and tests; as proposed they change nothing', async t => {
  assert.ok(RULE_IDS.includes('N-016') && RULE_IDS.includes('N-017'));
  const approved = loadApprovals(DEFAULT_APPROVALS).approved;
  for (const id of ['N-016', 'N-017']) {
    const rule = REPOSITORY.rules.find(item => item.id === id);
    assert.equal(rule.decision, 'approved', id);
    assert.ok(approved.has(id), id);
    for (const field of ['scope', 'rule', 'evidence', 'tests', 'proposedBy', 'approvedBy']) assert.ok(rule[field], `${id}.${field}`);
  }
  const without = { ...REPOSITORY, rules: REPOSITORY.rules.filter(rule => !['N-016', 'N-017'].includes(rule.id)) };
  const proposed = await (await setup(t, PROPOSED))();
  const plain = await (await setup(t, {}, without))();
  assert.deepEqual(proposed.differences, plain.differences);
  assert.deepEqual(proposed.normalization, plain.normalization);
  assert.ok(!proposed.normalization.some(entry => ['N-016', 'N-017'].includes(entry.rule)));
});

// ---- vfs.db __change_log.changed_at (ser-38 smoke): N-010 + N-014, no new rule ----
const LOG = ['id', 'table_name', 'record_id', 'operation', 'changed_at'];
const SMOKE = {
  A: ['2026-11-07 01:20:14', ...Array(4).fill('2026-11-07 01:20:16'), ...Array(3).fill('2026-11-07 01:20:18')],
  B: ['2026-11-07 01:26:25', ...Array(4).fill('2026-11-07 01:26:26'), ...Array(3).fill('2026-11-07 01:26:29')],
};
const CLOCK_SUITE = { scenarios: [{ id: 'smoke.change-log', seed: 'empty', capture: { events: false, db: ['*'] }, normalize: [], steps: [{ cmd: 'essay_grading_stream', args: {} }] }] };
function changeLog(side, seconds, records, recording = null) {
  const log = table(LOG, ['id'], seconds.map((at, i) => ({ id: int(i + 1), table_name: text(i < 1 ? 'folders' : 'resources'), record_id: text(records[Math.min(i, records.length - 1)]),
    operation: text(i < 1 || i % 2 ? 'INSERT' : 'UPDATE'), changed_at: text(at) })), { id: 'INTEGER' });
  const state = { version: 0, databases: { [VFS]: database({ __change_log: log }) } };
  const empty = { version: 0, databases: { [VFS]: database({ __change_log: table(LOG, ['id'], [], { id: 'INTEGER' }) }) } };
  const text_ = JSON.stringify(CLOCK_SUITE);
  return { schema: 'wave0-v0-observation', side, scenario: 'smoke.change-log', inputSha256: sha(text_), eventScope: { kind: 'all' }, ...(recording ? { recording } : {}),
    before: { events: [], databases: empty },
    calls: [{ command: 'essay_grading_stream', argsRaw: '{}', outcome: { kind: 'result', raw: 'null' }, capture: { events: [], databases: state } }],
    after: { events: [], databases: state }, finalDatabases: state };
}
const RECORDS = { A1: ['fld_dIYaCTt0Ru', 'res_mEyGzMDANT'], A2: ['fld_s3LT91LJcJ', 'res_17LXWb18yd'], B: ['fld_34ymDVqHcS', 'res__U_Tdnaabb'] };

test('vfs.db __change_log.changed_at of the ser-38 smoke: equal under the repository approvals when split; same-second A in combined mode is not covered', async t => {
  const root = await mkdtemp(join(tmpdir(), 'w13-smoke-changelog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  copyNormalizer(root);
  await writeFile(join(root, 'suite.json'), JSON.stringify(CLOCK_SUITE));
  await copyFile(DEFAULT_APPROVALS, join(root, 'approvals.json'));
  let n = 0;
  const run = async ({ a = SMOKE.A, b = SMOKE.B, split = true } = {}) => {
    const dir = join(root, String(n++));
    await mkdir(dir);
    const write = async (name, value) => { const file = join(dir, `${name}.json`); await writeFile(file, JSON.stringify(value)); return file; };
    return buildCompare({ scenarioFile: join(root, 'suite.json'), scenarioId: 'smoke.change-log', root, approvalsFile: join(root, 'approvals.json'),
      aTrace: await write('A1', changeLog('A', a, RECORDS.A1)), a2Trace: await write('A2', changeLog('A', a, RECORDS.A2)),
      bTrace: await write('B', changeLog('B', b, RECORDS.B, { workerStartedAt: '2026-11-07T01:26:00.000Z', startedAt: '2026-11-07T01:26:10.000Z', endedAt: '2026-11-07T01:26:40.000Z' })),
      split, aWindow: { from: Date.parse('2026-11-07T01:19:40Z'), to: Date.parse('2026-11-07T01:20:30Z') } });
  };
  const changedAt = artifact => artifact.differences.flatMap(d => (d.sample ?? []).filter(s => s.table === '__change_log' && s.column === 'changed_at'));

  const split = await run();
  assert.deepEqual(split.differences, [], JSON.stringify(split.differences, null, 1));
  assert.ok(split.normalization.some(entry => entry.rule === 'N-014' && entry.side === 'B' && entry.replaced > 0));
  // A1 = A2 (recorded together): N-010 does not own changed_at, N-014 does; record ids are N-005 in sequence order.
  assert.ok(!split.normalization.some(entry => entry.column === 'changed_at'));
  assert.equal(split.normalization.find(entry => entry.table === '__change_log' && entry.column === 'record_id')?.rule, 'N-005');

  // B's write order inverted against A (id 6 earlier than id 5): reported, not hidden.
  const inverted = await run({ b: [...SMOKE.B.slice(0, 5), '2026-11-07 01:26:24', ...SMOKE.B.slice(6)] });
  assert.ok(inverted.differences.some(d => d.kind === 'timestamp-order' && d.rule === 'N-014'), JSON.stringify(inverted.differences, null, 1));

  // Combined recording, A1 = A2 in the same seconds and B one second later: no approved rule covers it (no evidence yet).
  const combined = await run({ split: false, b: SMOKE.A.map(at => at.replace(/:(\d\d)$/, (_, s) => `:${String(Number(s) + 1).padStart(2, '0')}`)) });
  assert.equal(changedAt(combined).length > 0, true);
});
