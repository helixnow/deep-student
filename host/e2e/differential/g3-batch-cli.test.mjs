// g3-batch.mjs end to end in a throwaway repository with fake A/B runners: real worker
// supervision, worker receipts, shard admission/rejection, rerun and SIGTERM shutdown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SUITE, makeBatchRepo } from './__fixtures__/g3-batch-repo.mjs';

const BATCH = 'scripts/electron-migration/record/g3-batch.mjs';
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
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

async function fixture(t, ids) {
  mkdirSync('/tmp/opencode', { recursive: true });
  const root = await mkdtemp('/tmp/opencode/w13-batch-');
  const repo = makeBatchRepo(root, ids);
  const pidfile = join(root, 'pids');
  t.after(async () => {
    for (const pid of pidsOf(pidfile)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    await rm(root, { recursive: true, force: true });
  });
  return { ...repo, pidfile, out: join(root, 'out'), env: { ...repo.env, W13_PIDFILE: pidfile } };
}

function batch({ root, env, receipt, out }, extra = [], { onSpawn } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [BATCH, receipt, '--out', out, '--sides', 'A,B', '--record-only', '--shard-size', '1',
      '--workers-a', '1', '--workers-b', '1', '--kill-grace-s', '1', ...extra], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    onSpawn?.(child);
    child.on('close', (code, signal) => resolve({ code, signal, output }));
  });
}
const receiptOf = (out, side, index) => JSON.parse(readFileSync(join(out, 'receipts', side, `fixtures__w13__suite__${String(index).padStart(3, '0')}.json`), 'utf8'));

test('batch: clean, runner-error, crashed and hung shards get receipts with their real outcome; only clean exits are admitted', { timeout: 120_000 }, async t => {
  const repo = await fixture(t, ['w13.ok', 'w13.error', 'w13.crash', 'w13.hang']);
  const first = await batch(repo, ['--shard-timeout-min', '0.3']);
  assert.equal(first.code, 3, first.output);
  const result = JSON.parse(readFileSync(join(repo.out, 'batch-result.json'), 'utf8'));
  assert.equal(result.exitCode, 3);
  assert.deepEqual(result.rejectedShards, { A: 2, B: 2, A2: 0 });
  assert.deepEqual(result.workerOutcomes, { exited: 4, signaled: 2, timeout: 2 });

  for (const side of ['A', 'B']) {
    const ok = receiptOf(repo.out, side, 0);
    assert.equal(ok.schema, 'g3-worker/v1');
    assert.equal(ok.admitted, true);
    assert.deepEqual([ok.process.outcome, ok.process.code, ok.process.signal, ok.process.stdio], ['exited', 0, null, 'closed']);
    assert.equal(ok.traces.length, 1);
    assert.equal(ok.traces[0].sha256, sha(ok.traces[0].file));
    assert.equal(ok.summary.sha256, sha(ok.summary.file));
    assert.equal(ok.recording.sha256, sha(join(repo.out, 'RECORDING.json')));
    const summary = JSON.parse(readFileSync(ok.summary.file, 'utf8'));
    assert.equal(summary.runnerCode, 0);
    assert.equal(summary.worker.outcome, 'exited');

    const partial = receiptOf(repo.out, side, 1);
    assert.equal(partial.admitted, true, 'exit 1 with a runner-error is a usable partial summary');
    assert.equal(partial.process.code, 1);
    assert.deepEqual(partial.traces, []);

    const crash = receiptOf(repo.out, side, 2);
    assert.equal(crash.admitted, false);
    assert.deepEqual([crash.process.outcome, crash.process.signal], ['signaled', 'SIGKILL']);
    assert.ok(crash.rejectedTo && existsSync(join(crash.rejectedTo, 'summary.json')), 'rejected shard is kept aside for diagnosis');
    assert.equal(existsSync(join(repo.out, side, 'fixtures__w13__suite/002')), false);

    const hang = receiptOf(repo.out, side, 3);
    assert.equal(hang.admitted, false);
    assert.equal(hang.process.outcome, 'timeout');
    assert.deepEqual(hang.process.escalation.map(step => step.signal), ['SIGTERM', 'SIGKILL']);
    assert.match(readFileSync(hang.log, 'utf8'), /w13\.hang hanging/);
  }
  assert.deepEqual(await survivors(pidsOf(repo.pidfile)), [], 'hung workers and their helpers must all be gone');

  // Rerun on the same output: admitted shards are reused as-is, rejected ones run again.
  const before = receiptOf(repo.out, 'A', 0).writtenAt;
  const second = await batch(repo, ['--shard-timeout-min', '0.3']);
  assert.equal(second.code, 3, second.output);
  assert.equal(receiptOf(repo.out, 'A', 0).writtenAt, before);
  assert.equal(readdirSync(join(repo.out, 'A', 'fixtures__w13__suite')).filter(name => name.startsWith('002.rejected-')).length, 2);
  assert.deepEqual(await survivors(pidsOf(repo.pidfile)), []);
});

test('batch: SIGTERM stops a hung worker (SIGTERM → SIGKILL), waits for its receipt, then exits 143', { timeout: 60_000 }, async t => {
  const repo = await fixture(t, ['w13.hang']);
  let batchProcess;
  const finished = batch(repo, ['--shard-timeout-min', '10'], { onSpawn: child => { batchProcess = child; } });
  // Both sides' hung runners and helpers are up.
  while (pidsOf(repo.pidfile).length < 4) await new Promise(resolve => setTimeout(resolve, 50));
  const started = Date.now();
  batchProcess.kill('SIGTERM');
  const { code, output } = await finished;
  assert.equal(code, 143, output);
  assert.ok(Date.now() - started < 10_000, 'stop is bounded by the kill grace, not by the shard timeout');
  const result = JSON.parse(readFileSync(join(repo.out, 'batch-result.json'), 'utf8'));
  assert.equal(result.stopped, 'SIGTERM');
  assert.equal(result.exitCode, 143);
  for (const side of ['A', 'B']) {
    const hang = receiptOf(repo.out, side, 0);
    assert.equal(hang.process.outcome, 'stopped');
    assert.equal(hang.process.stopReason, 'batch SIGTERM');
    assert.equal(hang.admitted, false);
  }
  assert.deepEqual(await survivors(pidsOf(repo.pidfile)), []);
});
