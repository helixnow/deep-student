// g3-supervise.mjs (managed G3 run) end to end in a throwaway repository with fake A/B
// runners: preflight refusals, a complete smoke through compare/manifest/report, safe rerun,
// incomplete runs, SIGTERM and the total timeout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SUITE, makeBatchRepo } from './__fixtures__/g3-batch-repo.mjs';

const SUPERVISE = 'scripts/electron-migration/record/g3-supervise.mjs';
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const pidsOf = file => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []);
async function survivors(pids, ms = 3_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const left = pids.filter(alive);
    if (!left.length || Date.now() > deadline) return left;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
const json = file => JSON.parse(readFileSync(file, 'utf8'));

async function fixture(t, ids) {
  mkdirSync('/tmp/opencode', { recursive: true });
  const root = await mkdtemp('/tmp/opencode/w13-supervise-');
  const repo = makeBatchRepo(root, ids);
  const pidfile = join(root, 'pids');
  t.after(async () => {
    for (const pid of pidsOf(pidfile)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    await rm(root, { recursive: true, force: true });
  });
  return { ...repo, pidfile, out: join(root, 'out'), env: { ...repo.env, W13_PIDFILE: pidfile } };
}

function supervise(repo, extra = [], { onSpawn, out = repo.out, bCommit = repo.head, aReceipt = repo.receipt } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SUPERVISE, '--tree', repo.root, '--b-commit', bCommit, '--a-receipt', aReceipt, '--out', out,
      '--phase', 'smoke', '--file', SUITE, '--sides', 'A,B', '--kill-grace-s', '1', ...extra], { cwd: repo.root, env: repo.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    onSpawn?.(child);
    child.on('close', code => resolve({ code, stdout, stderr, line: (() => { try { return JSON.parse(stdout.trim().split('\n').at(-1)); } catch { return null; } })() }));
  });
}

test('supervisor preflight: wrong commit, pinned A receipt mismatch, failed A build, dirty tree, foreign --out → exit 2, nothing recorded', { timeout: 60_000 }, async t => {
  const repo = await fixture(t, ['w13.ok']);
  const failedBuild = join(repo.root, 'failed-build.receipt.json');
  writeFileSync(failedBuild, JSON.stringify({ schema: 'wp043-tauri-build', code: 101, binary: process.execPath, binarySha256: 'f'.repeat(64) }));
  for (const [name, extra, overrides] of [
    ['b-commit', [], { bCommit: '0'.repeat(40) }],
    ['a-receipt-sha256', ['--a-receipt-sha256', '1'.repeat(64)], {}],
    ['a-receipt', [], { aReceipt: failedBuild }],
  ]) {
    const out = join(repo.root, `out-${name}`);
    const run = await supervise(repo, extra, { out, ...overrides });
    assert.equal(run.code, 2, name);
    const result = json(join(out, 'SUPERVISOR-RESULT.json'));
    assert.equal(result.verdict, 'preflight-failed');
    assert.ok(result.reasons.some(reason => reason.startsWith(`${name}:`)), `${name}: ${result.reasons}`);
    assert.equal(existsSync(join(out, 'RECORDING.json')), false, `${name}: nothing recorded`);
  }

  const foreign = join(repo.root, 'out-foreign');
  mkdirSync(foreign);
  writeFileSync(join(foreign, 'someone-elses.txt'), 'x');
  const refused = await supervise(repo, [], { out: foreign });
  assert.equal(refused.code, 2);
  assert.deepEqual(readdirSync(foreign), ['someone-elses.txt'], 'a foreign directory is never written to');

  const dry = await supervise(repo, ['--dry-run'], { out: join(repo.root, 'out-dry') });
  assert.equal(dry.code, 0);
  assert.equal(dry.line.preflight.ok, true);
  assert.ok(dry.line.batch.includes('scripts/electron-migration/record/g3-batch.mjs'));
  assert.equal(existsSync(join(repo.root, 'out-dry')), false);

  writeFileSync(join(repo.root, SUITE), '{"scenarios":[]}');
  const dirty = await supervise(repo, [], { out: join(repo.root, 'out-dirty') });
  assert.equal(dirty.code, 2);
  assert.ok(json(join(repo.root, 'out-dirty', 'SUPERVISOR-RESULT.json')).reasons.some(reason => reason.startsWith('clean-tree:')));
  execFileSync('git', ['checkout', '--', SUITE], { cwd: repo.root });
});

test('supervisor smoke: complete run → compare, manifest seal, report with provenance; rerun reuses shards and keeps the old seal', { timeout: 120_000 }, async t => {
  const repo = await fixture(t, ['w13.ok']);
  const first = await supervise(repo);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  const result = json(join(repo.out, 'SUPERVISOR-RESULT.json'));
  assert.equal(result.schema, 'g3-supervisor-result/v1');
  assert.equal(result.verdict, 'complete');
  assert.deepEqual([result.phases.batch.process.outcome, result.phases.batch.process.code], ['exited', 0]);
  assert.equal(result.phases.batch.result.compared, 1);
  assert.equal(result.phases.batch.result.equal, 1);
  assert.deepEqual(result.phases.provenance.defects, []);
  assert.equal(result.phases.manifest.process.ok, true);
  assert.equal(result.phases.report.summary.totals.pass, 1);
  assert.equal(result.identity.bCommit, repo.head);
  const report = json(join(repo.out, 'report', 'g3-report.json'));
  assert.equal(report.commands.find(row => row.command === 'get_app_version').status, 'pass');
  assert.equal(report.recording.bHead, repo.head);
  assert.deepEqual(report.recording.defects, []);
  assert.equal(existsSync(join(repo.out, 'supervisor.lock')), false);

  const receiptAt = json(join(repo.out, 'receipts', 'A', 'fixtures__w13__suite__000.json')).writtenAt;
  const again = await supervise(repo, ['--workers-a', '1', '--shard-timeout-min', '5']);
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.equal(json(join(repo.out, 'receipts', 'A', 'fixtures__w13__suite__000.json')).writtenAt, receiptAt, 'admitted shard reused');
  assert.equal(readdirSync(repo.out).filter(name => name.startsWith('RUN-MANIFEST.superseded-')).length, 1);
  assert.equal(readFileSync(join(repo.out, 'supervisor-runs.jsonl'), 'utf8').trim().split('\n').length, 2);

  // Different intent on the same --out, or a live lock: refused without touching the result.
  const before = readFileSync(join(repo.out, 'SUPERVISOR-RESULT.json'), 'utf8');
  const otherIntent = await supervise(repo, ['--sides', 'A,B,A2']);
  assert.equal(otherIntent.code, 2);
  assert.match(JSON.stringify(otherIntent.line), /preflight-failed/);
  writeFileSync(join(repo.out, 'supervisor.lock'), JSON.stringify({ pid: process.pid, host: (await import('node:os')).hostname(), at: 'now' }));
  const locked = await supervise(repo);
  assert.equal(locked.code, 2);
  assert.match(JSON.stringify(locked.line.reasons), /another supervisor holds/);
  assert.equal(readFileSync(join(repo.out, 'SUPERVISOR-RESULT.json'), 'utf8'), before);
});

test('supervisor: a hung shard makes the run incomplete (exit 3) and names the rejected shards; nothing survives', { timeout: 120_000 }, async t => {
  const repo = await fixture(t, ['w13.ok', 'w13.hang']);
  const run = await supervise(repo, ['--shard-size', '1', '--shard-timeout-min', '0.3']);
  assert.equal(run.code, 3, run.stdout + run.stderr);
  const result = json(join(repo.out, 'SUPERVISOR-RESULT.json'));
  assert.equal(result.verdict, 'incomplete');
  assert.ok(result.reasons.some(reason => /rejected shards: A=1 B=1/.test(reason)), result.reasons.join('; '));
  assert.equal(result.phases.report.summary.totals.pass, 1, 'the clean shard is still reported');
  assert.deepEqual(await survivors(pidsOf(repo.pidfile)), []);
});

test('supervisor: SIGTERM stops the batch and its workers, records verdict stopped, releases the lock', { timeout: 60_000 }, async t => {
  const repo = await fixture(t, ['w13.hang']);
  let child;
  const finished = supervise(repo, ['--shard-timeout-min', '10'], { onSpawn: spawned => { child = spawned; } });
  while (pidsOf(repo.pidfile).length < 4) await new Promise(resolve => setTimeout(resolve, 50));
  const started = Date.now();
  child.kill('SIGTERM');
  const run = await finished;
  assert.equal(run.code, 143, run.stdout + run.stderr);
  assert.ok(Date.now() - started < 15_000);
  const result = json(join(repo.out, 'SUPERVISOR-RESULT.json'));
  assert.equal(result.verdict, 'stopped');
  assert.equal(result.phases.batch.result.stopped, 'SIGTERM');
  assert.equal(existsSync(join(repo.out, 'supervisor.lock')), false);
  assert.deepEqual(await survivors(pidsOf(repo.pidfile)), []);
});

test('supervisor retry flags reach g3-batch unchanged; a bad ISO time is refused; a tree whose g3-batch lacks a flag fails preflight', { timeout: 60_000 }, async t => {
  const repo = await fixture(t, ['w13.ok']);
  const dry = await supervise(repo, ['--dry-run', '--retry-errors', '--retry-errors-before', '2026-11-07T09:55:00+08:00', '--retry-infra-errors'],
    { out: join(repo.root, 'out-dry') });
  assert.equal(dry.code, 0, dry.stdout + dry.stderr);
  const { batch } = dry.line;
  assert.ok(batch.includes('--retry-errors') && batch.includes('--retry-infra-errors'));
  assert.equal(batch[batch.indexOf('--retry-errors-before') + 1], '2026-11-07T01:55:00.000Z');
  for (const flag of ['--retry-errors', '--retry-errors-before', '--retry-infra-errors']) {
    assert.equal(dry.line.preflight.checks.find(check => check.name === `batch-option:${flag}`)?.ok, true, flag);
  }
  const plain = await supervise(repo, ['--dry-run'], { out: join(repo.root, 'out-dry') });
  assert.ok(!plain.line.batch.some(arg => arg.startsWith('--retry')));

  const bad = await supervise(repo, ['--dry-run', '--retry-errors-before', 'yesterday'], { out: join(repo.root, 'out-dry') });
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /--retry-errors-before needs an ISO 8601 time/);

  const batchFile = 'scripts/electron-migration/record/g3-batch.mjs';
  const older = repo.commit('g3-batch before --retry-infra-errors', {
    [batchFile]: readFileSync(join(repo.root, batchFile), 'utf8').replaceAll("'retry-infra-errors'", "'retry-later'") });
  const refused = await supervise(repo, ['--dry-run', '--retry-infra-errors'], { out: join(repo.root, 'out-dry'), bCommit: older });
  assert.equal(refused.code, 2);
  assert.equal(refused.line.preflight.checks.find(check => check.name === 'batch-option:--retry-infra-errors').ok, false);
});

test('supervisor: EAGAIN runner errors are infrastructure, counted apart from scenario runner errors; --retry-infra-errors reruns only them; --retry-errors-before retries each failure once', { timeout: 180_000 }, async t => {
  const repo = await fixture(t, ['w13.ok', 'w13.eagain', 'w13.error']);
  repo.env.W13_EAGAIN_ONCE = join(repo.root, 'eagain-once');
  const receipt = (side, index) => json(join(repo.out, 'receipts', side, `fixtures__w13__suite__00${index}.json`)).writtenAt;
  const shards = ['--shard-size', '1'];

  const first = await supervise(repo, shards);
  assert.equal(first.code, 3, first.stdout + first.stderr);
  let result = json(join(repo.out, 'SUPERVISOR-RESULT.json'));
  assert.equal(result.verdict, 'incomplete');
  assert.ok(result.reasons.some(reason => /^infrastructure runner errors .*os-error-11.*: A=1 B=1 .*--retry-infra-errors; scenario runner errors A=1 B=1/.test(reason)), result.reasons.join('; '));
  assert.deepEqual(result.phases.failures.counts, { A: { infrastructure: 1, scenario: 1 }, B: { infrastructure: 1, scenario: 1 } });
  assert.deepEqual(result.phases.failures.signatures, { 'os-error-11': 2 });
  assert.deepEqual(result.phases.failures.infrastructure.map(item => [item.shard, item.id, item.signature.source.endsWith('.stderr.log')]),
    [['A/fixtures__w13__suite/001', 'w13.eagain', true], ['B/fixtures__w13__suite/001', 'w13.eagain', true]]);
  assert.deepEqual(result.phases.batch.result.runnerErrors, { A: 2, B: 2, A2: 0 });
  assert.deepEqual(result.phases.batch.result.runnerErrorClasses, { A: { infrastructure: 1, scenario: 1 }, B: { infrastructure: 1, scenario: 1 }, A2: { infrastructure: 0, scenario: 0 } });
  const report = json(join(repo.out, 'report', 'g3-report.json'));
  assert.deepEqual(report.runnerErrors, { counts: result.phases.failures.counts, signatures: { 'os-error-11': 2 }, infrastructure: 2 });
  assert.match(readFileSync(join(repo.out, 'report', 'g3-report.md'), 'utf8'), /基础设施失败（EAGAIN、线程\/进程创建被拒）A=1 B=1（签名 os-error-11×2）/);
  const errorShard = receipt('A', 2), eagainShard = receipt('A', 1);

  const retried = await supervise(repo, [...shards, '--retry-infra-errors']);
  assert.equal(retried.code, 0, retried.stdout + retried.stderr);
  result = json(join(repo.out, 'SUPERVISOR-RESULT.json'));
  assert.equal(result.verdict, 'complete');
  assert.deepEqual(result.phases.failures.counts, { A: { infrastructure: 0, scenario: 1 }, B: { infrastructure: 0, scenario: 1 } });
  assert.notEqual(receipt('A', 1), eagainShard, 'the EAGAIN shard reran');
  assert.equal(receipt('A', 2), errorShard, 'a scenario runner error is not an infrastructure retry');
  assert.equal(result.phases.batch.result.compared, 2);

  const retryAt = new Date().toISOString();
  assert.equal((await supervise(repo, [...shards, '--retry-errors-before', retryAt])).code, 0);
  const once = receipt('A', 2);
  assert.notEqual(once, errorShard, 'errored before the cut-off: retried');
  assert.equal((await supervise(repo, [...shards, '--retry-errors-before', retryAt])).code, 0);
  assert.equal(receipt('A', 2), once, 'the retry wrote a newer summary: not retried again');
});

test('supervisor: --total-timeout-min stops an overlong batch → failed (exit 4)', { timeout: 60_000 }, async t => {
  const repo = await fixture(t, ['w13.hang']);
  const run = await supervise(repo, ['--shard-timeout-min', '10', '--total-timeout-min', '0.1', '--no-report']);
  assert.equal(run.code, 4, run.stdout + run.stderr);
  const result = json(join(repo.out, 'SUPERVISOR-RESULT.json'));
  assert.equal(result.verdict, 'failed');
  assert.equal(result.phases.batch.process.outcome, 'timeout');
  assert.ok(result.reasons.some(reason => /exceeded --total-timeout-min 0.1/.test(reason)));
  assert.deepEqual(await survivors(pidsOf(repo.pidfile)), []);
});
