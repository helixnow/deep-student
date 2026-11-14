// A/A2 pre-recording (A store) decoupled from B: g3-batch --mode a-store records only the Rust
// reference takes, --mode b-only records only B for one commit and compares against the
// admitted A/A2 traces of one or more A stores, referenced by sha256. Fake runners in a
// throwaway repository; the real batch, compare, provenance and report code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { makeSplitRepo, suiteText } from './__fixtures__/g3-batch-repo.mjs';
import { storeDefects } from '../../../scripts/electron-migration/record/g3-provenance.mjs';
import { scenarioDifference, scenarioEntries, storeScenarioInputs } from '../../../scripts/electron-migration/record/g3-inputs.mjs';
import { buildCompare } from '../../../scripts/electron-migration/record/g3-compare.mjs';

const BATCH = 'scripts/electron-migration/record/g3-batch.mjs';
const REPORT = 'scripts/electron-migration/record/g3-report.mjs';
const CHAT = 'host/plugins/chat/equivalence/chat.json';
const NOTES = 'host/plugins/notes/equivalence/notes.json';
const QBANK = 'host/plugins/qbank/equivalence/qbank.json';
const PINNED = { TZ: 'UTC', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
const HEX = /^[0-9a-f]{64}$/;
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
const statusOf = (report, command) => report.commands.find(row => row.command === command).status;

async function fixture(t, suites = { [CHAT]: ['chat.one.ok', 'chat.two.ok'], [NOTES]: ['notes.one.ok'] }) {
  mkdirSync('/tmp/opencode', { recursive: true });
  const root = await mkdtemp('/tmp/opencode/w13-split-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = await makeSplitRepo(root, suites);
  return { ...repo, store: join(root, 'store'), out: name => join(root, name) };
}
const batch = (repo, args) => spawnSync(process.execPath, [BATCH, ...args, '--shard-size', '1', '--kill-grace-s', '1'],
  { cwd: repo.root, env: repo.env, encoding: 'utf8' });
const aStore = (repo, extra = [], out = repo.store) => batch(repo, [repo.receipt, '--mode', 'a-store', '--out', out, '--sides', 'A,A2',
  '--workers-a', '3', '--workers-a2', '3', ...extra]);
const pins = stores => stores.flatMap(store => ['--a-store', store, '--a-store-sha256', sha(join(store, 'A-STORE.json'))]);
const bOnly = (repo, out, extra = [], stores = [repo.store]) => batch(repo, ['--mode', 'b-only', ...pins(stores), '--out', out, '--workers-b', '6', ...extra]);
const ok = run => assert.equal(run.status, 0, run.stdout + run.stderr);
function report(repo, out, extra = []) {
  rmSync(join(out, 'RUN-MANIFEST.json'), { force: true });
  for (const args of [['--write-manifest'], ['--out', join(out, 'report'), ...extra]]) {
    ok(spawnSync(process.execPath, [REPORT, '--runs', out, ...args], { cwd: repo.root, env: repo.env, encoding: 'utf8' }));
  }
  return json(join(out, 'report', 'g3-report.json'));
}
const unattributable = built => built.problems.filter(problem => problem.kind === 'unattributable-recording').map(problem => problem.message);

test('A store: records only A and A2 without a B commit; pins recorder commit, A build receipt sha256, environment and inputs; the worker cap counts only recorded sides', { timeout: 120_000 }, async t => {
  const repo = await fixture(t);
  const over = aStore(repo, ['--workers-a', '4']);
  assert.notEqual(over.status, 0);
  assert.match(over.stderr, /at most 6 workers across the recorded sides/);
  const withB = batch(repo, [repo.receipt, '--mode', 'a-store', '--out', repo.store, '--sides', 'A,B']);
  assert.notEqual(withB.status, 0);
  assert.match(withB.stderr, /a-store records only A\/A2/);
  assert.equal(existsSync(repo.store), false, 'a refused invocation writes nothing');

  ok(aStore(repo, ['--workers-b', '6']));
  const identity = json(join(repo.store, 'A-STORE.json'));
  assert.equal(identity.schema, 'g3-a-store/v1');
  assert.equal(identity.recorder.head, repo.head);
  assert.equal(identity.recorder.clean, true);
  assert.equal(identity.recorder.runtimeReceipt.sha256, sha(join(repo.store, 'recorder-receipt.json')));
  assert.equal(identity.a.buildReceipt.file, repo.receipt);
  assert.equal(identity.a.buildReceipt.sha256, sha(repo.receipt));
  assert.deepEqual(identity.environment, PINNED);
  for (const suite of [CHAT, NOTES]) assert.match(identity.inputs.suites[suite].digest, HEX);
  assert.match(identity.inputs.seeds.empty.sha256, HEX);
  assert.equal('b' in identity, false, 'no B commit in an A store');
  for (const name of ['RECORDING.json', 'host-receipt.json', 'B', 'compare', 'receipts/B']) assert.equal(existsSync(join(repo.store, name)), false, name);
  for (const side of ['A', 'A2']) {
    const receipts = readdirSync(join(repo.store, 'receipts', side)).map(name => json(join(repo.store, 'receipts', side, name)));
    assert.equal(receipts.length, 3, side);
    for (const receipt of receipts) {
      assert.equal(receipt.admitted, true);
      assert.deepEqual(receipt.recording, { file: join(repo.store, 'A-STORE.json'), sha256: sha(join(repo.store, 'A-STORE.json')) });
      assert.equal(receipt.traces[0].sha256, sha(receipt.traces[0].file));
      assert.deepEqual(json(receipt.summary.file).runs[0].env, PINNED, 'workers run under the pinned environment');
    }
  }
  const result = json(join(repo.store, 'batch-result.json'));
  assert.equal(result.mode, 'a-store');
  assert.equal(result.exitCode, 0);
  assert.equal(result.compared, 0);
  assert.deepEqual(storeDefects(repo.store).defects, []);

  const otherTz = aStore(repo, ['--tz', 'Asia/Shanghai']);
  assert.notEqual(otherTz.status, 0);
  assert.match(otherTz.stderr, /A store inputs changed; use a new output directory/);
});

test('B only: records only B against a pinned A store; two B commits reuse one store, each run pins its own commit and Host receipt', { timeout: 180_000 }, async t => {
  const repo = await fixture(t);
  ok(aStore(repo));
  const storeSha = sha(join(repo.store, 'A-STORE.json'));
  const storeBefore = Object.fromEntries(files(repo.store).map(file => [file, sha(file)]));
  const out1 = repo.out('out-b1');

  const tooMany = bOnly(repo, out1, ['--workers-b', '7']);
  assert.match(tooMany.stderr, /at most 6 workers across the recorded sides/);
  const sides = bOnly(repo, out1, ['--sides', 'A,B']);
  assert.match(sides.stderr, /b-only records only B/);
  const receiptArg = batch(repo, [repo.receipt, '--mode', 'b-only', ...pins([repo.store]), '--out', out1]);
  assert.match(receiptArg.stderr, /b-only takes the A build receipt from the A store/);
  const wrong = batch(repo, ['--mode', 'b-only', '--a-store', repo.store, '--a-store-sha256', '0'.repeat(64), '--out', out1]);
  assert.match(wrong.stderr, /A store .*A-STORE\.json sha256 [0-9a-f]{64}, expected 0{64}/);
  const unpinned = batch(repo, ['--mode', 'b-only', '--a-store', repo.store, '--out', out1]);
  assert.match(unpinned.stderr, /every --a-store needs its --a-store-sha256/);
  for (const refused of [tooMany, sides, receiptArg, wrong, unpinned]) assert.notEqual(refused.status, 0);
  assert.equal(existsSync(out1), false, 'refused invocations write nothing');

  ok(bOnly(repo, out1));
  const recording = json(join(out1, 'RECORDING.json'));
  assert.equal(recording.schema, 'g3-recording/v3');
  assert.equal(recording.b.head, repo.head);
  assert.equal(recording.b.clean, true);
  assert.equal(recording.b.hostReceipt.sha256, sha(join(out1, 'host-receipt.json')));
  assert.equal(recording.a.source, 'a-store');
  assert.equal(recording.a.buildReceipt.sha256, sha(repo.receipt));
  assert.deepEqual(recording.environment, PINNED);
  assert.match(recording.inputs.suites[CHAT].digest, HEX);
  assert.deepEqual(readdirSync(join(out1, 'receipts')), ['B']);
  for (const side of ['A', 'A2']) {
    assert.equal(existsSync(join(out1, side)), false);
    const refs = readdirSync(join(out1, 'a-refs', side)).map(name => json(join(out1, 'a-refs', side, name)));
    assert.equal(refs.length, 3, side);
    for (const ref of refs) {
      assert.equal(ref.schema, 'g3-a-ref/v1');
      assert.deepEqual(ref.store.identity, { file: join(repo.store, 'A-STORE.json'), sha256: storeSha });
      assert.ok(ref.receipt.file.startsWith(join(repo.store, 'receipts', side) + '/'), ref.receipt.file);
      assert.equal(ref.receipt.sha256, sha(ref.receipt.file));
    }
  }
  const result = json(join(out1, 'batch-result.json'));
  assert.equal(result.mode, 'b-only');
  assert.deepEqual([result.compared, result.equal, result.compareErrors], [3, 3, 0]);
  assert.deepEqual(result.aStore.suites, { matched: 2, partial: 0, stale: 0, missing: 0, awaiting: 0 });
  assert.equal(result.aStore.awaitingA, 0);
  assert.equal(json(join(out1, 'a-store-coverage.json')).suites[CHAT].stores[0].sha256, storeSha);

  const first = report(repo, out1);
  assert.equal(statusOf(first, 'get_app_version'), 'pass');
  assert.deepEqual(first.recording.defects, []);
  assert.equal(first.recording.bHead, repo.head);
  assert.deepEqual(first.recording.aStores.map(store => store.sha256), [storeSha]);
  assert.deepEqual(unattributable(first), []);
  const runs = first.commands.find(row => row.command === 'get_app_version').runs;
  assert.equal(runs.length, 3);
  for (const run of runs) {
    assert.ok(join(repo.root, run.evidence.A.file).startsWith(join(repo.store, 'A') + '/'), run.evidence.A.file);
    assert.ok(join(repo.root, run.evidence.A2.file).startsWith(join(repo.store, 'A2') + '/'), run.evidence.A2.file);
    assert.ok(join(repo.root, run.evidence.B.file).startsWith(join(out1, 'B') + '/'), run.evidence.B.file);
    assert.deepEqual(run.clock.offsets, [], 'recorded the same day');
  }
  assert.match(readFileSync(join(out1, 'report', 'g3-report.md'), 'utf8'), /A\/A2 取自 A 预录目录 1 个/);

  const head2 = repo.commit('a later B revision', { 'host/plugins/chat/NOTES.md': 'B changed\n' });
  const out2 = repo.out('out-b2');
  ok(bOnly(repo, out2));
  assert.equal(json(join(out2, 'RECORDING.json')).b.head, head2);
  const second = report(repo, out2);
  assert.equal(statusOf(second, 'get_app_version'), 'pass');
  assert.equal(second.recording.bHead, head2);
  assert.deepEqual(Object.fromEntries(files(repo.store).map(file => [file, sha(file)])), storeBefore, 'B runs only read the A store');

  const stale = bOnly(repo, out1);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /recording inputs changed; use a new output directory/);
});

test('B only: changed A store evidence or A build receipt is never counted', { timeout: 120_000 }, async t => {
  const repo = await fixture(t, { [CHAT]: ['chat.one.ok'] });
  ok(aStore(repo));
  const out = repo.out('out-b');
  ok(bOnly(repo, out));
  assert.equal(statusOf(report(repo, out), 'get_app_version'), 'pass');
  const [receiptName] = readdirSync(join(repo.store, 'receipts', 'A'));
  const [refName] = readdirSync(join(out, 'a-refs', 'A'));
  const cases = [
    ['A store receipt rewritten', join(repo.store, 'receipts', 'A', receiptName), value => { value.process.durationMs += 1; }, /^A trace not admitted: A store receipt changed/],
    ['A store identity rewritten', join(repo.store, 'A-STORE.json'), value => { value.recorder.dirty = ['x']; }, /^A trace not admitted: A store identity changed/],
    ['A store recorder runtime receipt rewritten', join(repo.store, 'recorder-receipt.json'), value => { value.node.version = 'v0.0.0'; }, /^A trace not admitted: A store defects: recorder-receipt-changed/],
    ['reference points at other bytes', join(out, 'a-refs', 'A', refName), value => { value.receipt.sha256 = 'c'.repeat(64); }, /^A trace not admitted: A store receipt changed/],
    ['A build receipt rewritten', repo.receipt, value => { value.binarySha256 = 'b'.repeat(64); }, /^recording receipt incomplete: a-build-receipt-changed/],
  ];
  for (const [label, file, mutate, expected] of cases) {
    const original = readFileSync(file);
    const value = JSON.parse(original);
    mutate(value);
    writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
    const built = report(repo, out);
    assert.notEqual(statusOf(built, 'get_app_version'), 'pass', label);
    assert.equal(unattributable(built).length, 1, label);
    assert.match(unattributable(built)[0], expected, label);
    writeFileSync(file, original);
  }
  assert.equal(statusOf(report(repo, out), 'get_app_version'), 'pass');
});

test('B only, per scenario: unchanged scenarios of a changed suite are still compared; a changed one is stale-a, a new one missing; a --scenario top-up store completes them and wins', { timeout: 240_000 }, async t => {
  const repo = await fixture(t);
  ok(aStore(repo));
  const base = json(join(repo.store, 'A-STORE.json'));
  const two = id => ({ id, seed: 'empty', steps: [{ cmd: 'get_app_version' }, { cmd: 'get_app_version' }], capture: { events: false, db: [] }, normalize: [] });
  const chat = JSON.parse(suiteText('chat', ['chat.one.ok', 'chat.two.ok']));
  chat.scenarios[1] = two('chat.two.ok');
  repo.commit('chat.two.ok changed; notes.two.ok and a qbank suite added', { [CHAT]: JSON.stringify(chat, null, 2),
    [NOTES]: suiteText('notes', ['notes.one.ok', 'notes.two.ok']), [QBANK]: suiteText('qbank', ['qbank.one.ok']) });
  const out = repo.out('out-b');
  ok(bOnly(repo, out));
  let result = json(join(out, 'batch-result.json'));
  assert.deepEqual(result.aStore.suites, { matched: 0, partial: 2, stale: 0, missing: 1, awaiting: 0 });
  assert.deepEqual([result.aStore.staleA, result.aStore.missingA, result.aStore.awaitingA], [1, 2, 0]);
  assert.deepEqual([result.compared, result.equal], [2, 2], 'chat.one.ok and notes.one.ok, from an older suite file');
  let coverage = json(join(out, 'a-store-coverage.json'));
  assert.equal(coverage.schema, 'g3-a-store-coverage/v2');
  assert.deepEqual(coverage.stores.map(store => store.scenarioInputs), ['recorded']);
  const prefix = sha(join(repo.store, 'A-STORE.json')).slice(0, 12);
  assert.deepEqual(coverage.staleA, [{ file: CHAT, id: 'chat.two.ok', store: prefix, reasons: ['scenario'] }]);
  assert.deepEqual(coverage.suites[NOTES].missing, ['notes.two.ok']);
  assert.deepEqual([coverage.suites[QBANK].status, coverage.suites[QBANK].missing], ['missing', ['qbank.one.ok']]);
  assert.deepEqual(coverage.topUp, [CHAT, NOTES, QBANK]);
  assert.deepEqual(coverage.topUpScenarios, [{ file: CHAT, id: 'chat.two.ok' }, { file: NOTES, id: 'notes.two.ok' }, { file: QBANK, id: 'qbank.one.ok' }]);
  assert.deepEqual(coverage.suites[CHAT].sources, { 'chat.one.ok': prefix });
  assert.deepEqual(readdirSync(join(out, 'compare')).sort(), ['host__plugins__chat__equivalence__chat', 'host__plugins__notes__equivalence__notes']);
  assert.deepEqual(readdirSync(join(out, 'compare', 'host__plugins__chat__equivalence__chat')), ['chat.one.ok.compare.json.gz'], 'stale-a is not compared');
  const chatOne = join(out, 'compare', 'host__plugins__chat__equivalence__chat', 'chat.one.ok.compare.json.gz');
  const artifact = JSON.parse(gunzipSync(readFileSync(chatOne)));
  assert.equal(artifact.splitRecording.aScenarioFile.sha256, base.inputs.suites[CHAT].sha256, 'A ran the suite file of the store commit');
  const altered = JSON.parse(readFileSync(join(repo.root, artifact.splitRecording.aScenarioFile.file), 'utf8'));
  altered.scenarios[0] = two('chat.one.ok');
  const alteredFile = join(out, 'altered-chat.json');
  writeFileSync(alteredFile, JSON.stringify(altered));
  await assert.rejects(buildCompare({ scenarioFile: join(repo.root, CHAT), scenarioId: 'chat.one.ok', root: repo.root, split: true,
    aTrace: join(repo.root, artifact.traces.A.file), bTrace: join(repo.root, artifact.traces.B.file), a2Trace: join(repo.root, artifact.traces.A2.file),
    approvalsFile: join(repo.root, 'fixtures/differential/g3/normalize-approvals.json'), aScenarioFile: alteredFile }), /differs between .* \(stale-a\)/);
  rmSync(alteredFile);
  let built = report(repo, out);
  assert.deepEqual(unattributable(built), []);
  assert.equal(built.commands.find(row => row.command === 'get_app_version').status, 'pass');

  // Stores without inputs.scenarios, or from before g3-inputs/v2 (only the pinned seeds, environment
  // and launch values): recomputed from their recording commit, the same per-scenario inputs.
  const { inputs: { scenarios: _scenarios, ...rest }, ...identity } = base;
  assert.deepEqual(storeScenarioInputs(repo.root, { ...identity, inputs: rest }), scenarioEntries(base.inputs));
  const v1 = { schema: 'g3-inputs/v1', environment: rest.environment, seeds: rest.seeds, launch: rest.launch, suites: rest.suites };
  assert.deepEqual(storeScenarioInputs(repo.root, { ...identity, inputs: v1 }, repo.store), scenarioEntries(base.inputs));
  const noReceipt = storeScenarioInputs(repo.root, { ...identity, inputs: v1 });
  for (const [file, items] of Object.entries(scenarioEntries(base.inputs))) {
    for (const [id, entry] of Object.entries(items)) assert.deepEqual(scenarioDifference(noReceipt[file][id], entry), ['runtime:node'], `${id}: without its recorder receipt the store's node is unknown`);
  }
  assert.equal(storeScenarioInputs(repo.root, { ...identity, inputs: rest, recorder: { ...identity.recorder, head: '0'.repeat(40) } }), null);

  const topUp = repo.out('store-topup');
  const scenarioArgs = coverage.topUpScenarios.flatMap(({ file, id }) => ['--file', file, '--scenario', id]);
  ok(aStore(repo, scenarioArgs, topUp));
  ok(bOnly(repo, out, [], [repo.store, topUp]));
  result = json(join(out, 'batch-result.json'));
  assert.deepEqual(result.aStore.suites, { matched: 3, partial: 0, stale: 0, missing: 0, awaiting: 0 });
  assert.deepEqual([result.compared, result.equal, result.aStore.staleA, result.aStore.missingA], [5, 5, 0, 0]);
  coverage = json(join(out, 'a-store-coverage.json'));
  const topUpPrefix = sha(join(topUp, 'A-STORE.json')).slice(0, 12);
  assert.deepEqual(coverage.suites[CHAT].sources, { 'chat.one.ok': prefix, 'chat.two.ok': topUpPrefix });
  built = report(repo, out);
  assert.deepEqual(unattributable(built), []);
  assert.equal(built.commands.find(row => row.command === 'get_app_version').runs.length, 5);
  const byStore = Object.fromEntries(built.recording.aStores.map(store => [store.dir, store.scenarios]));
  assert.deepEqual(byStore[topUp], [`${CHAT}#chat.two.ok`, `${NOTES}#notes.two.ok`, `${QBANK}#qbank.one.ok`]);
  assert.deepEqual(byStore[repo.store], [`${CHAT}#chat.one.ok`, `${NOTES}#notes.one.ok`]);
});

test('domains: --domain selects plugin domains in the given order; later batches reuse admitted shards; the report has a batch section', { timeout: 180_000 }, async t => {
  const repo = await fixture(t);
  ok(aStore(repo, ['--domain', 'chat']));
  assert.deepEqual(readdirSync(join(repo.store, 'receipts', 'A')).map(name => name.split('__')[2]), ['chat', 'chat']);
  assert.deepEqual(json(join(repo.store, 'batch-result.json')).selection, { domains: ['chat'], suites: [CHAT], shards: 2 });
  const chatReceipt = join(repo.store, 'receipts', 'A', readdirSync(join(repo.store, 'receipts', 'A'))[0]);
  const writtenAt = json(chatReceipt).writtenAt;
  ok(aStore(repo, ['--domain', 'notes,chat']));
  assert.deepEqual(json(join(repo.store, 'batch-result.json')).selection, { domains: ['notes', 'chat'], suites: [NOTES, CHAT], shards: 3 });
  assert.equal(json(chatReceipt).writtenAt, writtenAt, 'admitted shard reused');
  const unknown = aStore(repo, ['--domain', 'nope']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown domain: nope/);

  const out = repo.out('out-b');
  ok(bOnly(repo, out, ['--domain', 'notes']));
  assert.equal(json(join(out, 'batch-result.json')).compared, 1);
  const built = report(repo, out, ['--domain', 'notes']);
  assert.deepEqual(built.scope.domains, ['notes']);
  assert.deepEqual(built.scope.suites, [NOTES]);
  assert.deepEqual(built.scope.totals, { pass: 1, fail: 0, 'not-run': 0 });
  assert.match(readFileSync(join(out, 'report', 'g3-report.md'), 'utf8'), /## 本批范围（notes）/);
  assert.ok(statSync(join(out, 'report', 'g3-report.md')).size > 0);
});

test('--scenario records only the named scenarios, under a shard key of their own; an unknown id is refused before anything is written', { timeout: 120_000 }, async t => {
  const repo = await fixture(t, { [CHAT]: ['chat.one.ok', 'chat.two.ok', 'chat.three.ok'], [NOTES]: ['notes.one.ok'] });
  const absent = aStore(repo, ['--file', CHAT, '--scenario', 'notes.one.ok']);
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /--scenario not found as a valid scenario in --file: notes\.one\.ok/);
  assert.equal(existsSync(repo.store), false);

  ok(aStore(repo, ['--file', CHAT, '--scenario', 'chat.two.ok']));
  for (const side of ['A', 'A2']) {
    const receipts = readdirSync(join(repo.store, 'receipts', side)).map(name => json(join(repo.store, 'receipts', side, name)));
    assert.equal(receipts.length, 1, side);
    assert.match(receipts[0].shard, /^host__plugins__chat__equivalence__chat\/only-[0-9a-f]{12}-000$/);
    assert.deepEqual(receipts[0].ids, ['chat.two.ok']);
  }
  assert.deepEqual(readdirSync(join(repo.store, 'A', 'host__plugins__chat__equivalence__chat')).filter(name => !name.includes('.')).length, 1);
});
