// g3-supervise.mjs for the decoupled pipeline: --mode a-store (A/A2 pre-recording, no B
// commit) and --mode b-only (one B commit against sha256-pinned A stores, all six workers on
// B), each with its own preflight, provenance check and terminal receipt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { makeSplitRepo, suiteText } from './__fixtures__/g3-batch-repo.mjs';

const SUPERVISE = 'scripts/electron-migration/record/g3-supervise.mjs';
const CHAT = 'host/plugins/chat/equivalence/chat.json';
const NOTES = 'host/plugins/notes/equivalence/notes.json';
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));

async function fixture(t) {
  mkdirSync('/tmp/opencode', { recursive: true });
  const root = await mkdtemp('/tmp/opencode/w13-supervise-split-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = await makeSplitRepo(root, { [CHAT]: ['chat.one.ok', 'chat.two.ok'], [NOTES]: ['notes.one.ok'] });
  return { ...repo, store: join(root, 'store'), out: name => join(root, name) };
}
function supervise(repo, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SUPERVISE, '--tree', repo.root, '--kill-grace-s', '1', '--shard-size', '1', ...args],
      { cwd: repo.root, env: repo.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr, line: (() => { try { return JSON.parse(stdout.trim().split('\n').at(-1)); } catch { return null; } })() }));
  });
}
const aStore = (repo, extra = []) => supervise(repo, ['--mode', 'a-store', '--commit', repo.head, '--a-receipt', repo.receipt, '--out', repo.store, '--phase', 'smoke', ...extra]);
const bOnly = (repo, out, extra = [], head = repo.head) => supervise(repo, ['--mode', 'b-only', '--b-commit', head, '--a-store', repo.store,
  '--a-store-sha256', sha(join(repo.store, 'A-STORE.json')), '--out', out, '--phase', 'full', ...extra]);
const names = result => result.preflight.checks.map(check => check.name);

test('supervisor A store: no B commit; A/A2 only; complete with store provenance and coverage, no report', { timeout: 120_000 }, async t => {
  const repo = await fixture(t);
  const dry = await aStore(repo, ['--dry-run']);
  assert.equal(dry.code, 0, dry.stdout + dry.stderr);
  assert.equal(dry.line.preflight.ok, true);
  assert.ok(names(dry.line).includes('commit') && !names(dry.line).includes('b-commit'));
  assert.ok(names(dry.line).includes('tool:xvfb-run'));
  assert.ok(dry.line.batch.includes('a-store') && !dry.line.batch.includes('B'));

  const run = await aStore(repo);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const result = json(join(repo.store, 'SUPERVISOR-RESULT.json'));
  assert.equal(result.verdict, 'complete');
  assert.equal(result.identity.mode, 'a-store');
  assert.equal(result.identity.commit, repo.head);
  assert.equal(result.phases.batch.result.mode, 'a-store');
  assert.deepEqual(result.phases.store.defects, []);
  assert.deepEqual(result.phases.store.coverage, { suites: 2, scenarios: 3, A: 3, A2: 3 });
  assert.equal(result.phases.report, undefined);
  assert.equal(existsSync(join(repo.store, 'RECORDING.json')), false);
});

test('supervisor B only: the A store must be pinned by sha256; six B workers; complete through compare, manifest and report; domain batches share one directory', { timeout: 180_000 }, async t => {
  const repo = await fixture(t);
  assert.equal((await aStore(repo)).code, 0);
  const out = repo.out('out-b');

  const unpinned = await supervise(repo, ['--mode', 'b-only', '--b-commit', repo.head, '--a-store', repo.store, '--out', out]);
  assert.notEqual(unpinned.code, 0);
  assert.match(unpinned.stderr, /every --a-store needs its --a-store-sha256/);
  const wrong = await supervise(repo, ['--mode', 'b-only', '--b-commit', repo.head, '--a-store', repo.store, '--a-store-sha256', '0'.repeat(64), '--out', out]);
  assert.equal(wrong.code, 2);
  const refused = json(join(out, 'SUPERVISOR-RESULT.json'));
  assert.equal(refused.verdict, 'preflight-failed');
  assert.ok(refused.reasons.some(reason => reason.startsWith(`a-store-sha256:${repo.store}:`)), refused.reasons.join('; '));
  assert.equal(existsSync(join(out, 'RECORDING.json')), false);

  const dry = await bOnly(repo, repo.out('out-dry'), ['--dry-run']);
  assert.equal(dry.code, 0, dry.stdout + dry.stderr);
  for (const name of [`a-store:${repo.store}`, `a-store-sha256:${repo.store}`, `a-store-defects:${repo.store}`, 'a-store-build', 'a-store-environment']) {
    assert.ok(names(dry.line).includes(name), name);
  }
  assert.ok(!names(dry.line).includes('tool:xvfb-run'), 'B needs no X server');
  const approvals = dry.line.preflight.checks.find(check => check.name === 'approvals');
  assert.equal(approvals.ok, true);
  assert.equal(approvals.detail.sha256, createHash('sha256').update(readFileSync(join(repo.root, 'fixtures/differential/g3/normalize-approvals.json'))).digest('hex'),
    'the recording tree\'s own approvals, not a pinned value');

  const chat = await bOnly(repo, out, ['--domain', 'chat']);
  assert.equal(chat.code, 0, chat.stdout + chat.stderr);
  let result = json(join(out, 'SUPERVISOR-RESULT.json'));
  assert.equal(result.verdict, 'complete');
  assert.equal(result.identity.mode, 'b-only');
  assert.equal(result.ops.workers.b, 6);
  assert.equal(result.phases.batch.result.compared, 2);
  assert.deepEqual(result.phases.provenance.defects, []);
  assert.equal(result.phases.report.summary.totals.pass, 1);
  let report = json(join(out, 'report', 'g3-report.json'));
  assert.deepEqual(report.scope.domains, ['chat']);
  assert.equal(report.recording.aStores[0].sha256, sha(join(repo.store, 'A-STORE.json')));

  const notes = await bOnly(repo, out, ['--domain', 'notes']);
  assert.equal(notes.code, 0, notes.stdout + notes.stderr);
  result = json(join(out, 'SUPERVISOR-RESULT.json'));
  assert.equal(result.phases.batch.result.compared, 3, 'chat compares reused, notes added');
  report = json(join(out, 'report', 'g3-report.json'));
  assert.deepEqual(report.scope.domains, ['notes']);
  assert.equal(readFileSync(join(out, 'supervisor-runs.jsonl'), 'utf8').trim().split('\n').length, 2);
});

test('supervisor B only: a scenario without matching A/A2 makes the run incomplete and names the top-up', { timeout: 180_000 }, async t => {
  const repo = await fixture(t);
  assert.equal((await aStore(repo)).code, 0);
  const head = repo.commit('notes changed', { [NOTES]: suiteText('notes', ['notes.one.ok', 'notes.two.ok']) });
  const out = repo.out('out-b');
  const run = await bOnly(repo, out, [], head);
  assert.equal(run.code, 3, run.stdout + run.stderr);
  const result = json(join(out, 'SUPERVISOR-RESULT.json'));
  assert.equal(result.verdict, 'incomplete');
  assert.ok(result.reasons.some(reason => /A\/A2 unavailable: 0 stale-a scenario\(s\), 1 missing, 0 awaiting A \(0 stale suite\(s\), 0 missing;/.test(reason)), result.reasons.join('; '));
  assert.equal(result.phases.report.summary.totals.pass, 1, 'matched scenarios are still reported');

  const topUp = repo.out('store-topup');
  const recorded = await supervise(repo, ['--mode', 'a-store', '--commit', head, '--a-receipt', repo.receipt, '--out', topUp, '--phase', 'smoke',
    '--top-up-from', join(out, 'a-store-coverage.json')]);
  assert.equal(recorded.code, 0, recorded.stdout + recorded.stderr);
  const receipts = side => readdirSync(join(topUp, 'receipts', side)).map(name => json(join(topUp, 'receipts', side, name)));
  assert.deepEqual(receipts('A').flatMap(receipt => receipt.traces.map(trace => trace.id)), ['notes.two.ok'], 'only the listed scenario');
  const both = await bOnly(repo, out, ['--a-store', topUp, '--a-store-sha256', sha(join(topUp, 'A-STORE.json'))], head);
  assert.equal(both.code, 0, both.stdout + both.stderr);
  assert.equal(json(join(out, 'SUPERVISOR-RESULT.json')).phases.batch.result.compared, 4);
  assert.deepEqual(json(join(out, 'a-store-coverage.json')).suites[NOTES].sources,
    { 'notes.one.ok': sha(join(repo.store, 'A-STORE.json')).slice(0, 12), 'notes.two.ok': sha(join(topUp, 'A-STORE.json')).slice(0, 12) });
});
