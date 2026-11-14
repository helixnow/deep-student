// G3 process lifecycle: a misbehaving A side (or recording worker) must never hang the
// pipeline, and a failed process must never be reported as a successful recording.
// Process fixtures: __fixtures__/misbehave.mjs. Linux-only cases (PID namespace wrapper)
// skip elsewhere; see G3-RECORDING-RUNBOOK.md §1 for running them on the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonLineProcess } from '../../../scripts/electron-migration/record/process.mjs';
import { MCP_MOUNT, NAMESPACE, NAMESPACE_INIT, acceptSummary, runWorker } from '../../../scripts/electron-migration/record/g3-worker.mjs';
import { runScenarioA } from '../../../scripts/electron-migration/record/g3-run-a.mjs';

const FIXTURE = fileURLToPath(new URL('./__fixtures__/misbehave.mjs', import.meta.url));
const NODE = process.execPath;
// Every case must settle far below this; the old code never settled at all.
const BOUND = 20_000;
const LIMITS = { timeoutMs: 5_000, killGraceMs: 500, closeGraceMs: 500 };

async function within(promise, ms, label) {
  let timer;
  const hang = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: did not settle within ${ms}ms (hang)`)), ms); });
  try { return await Promise.race([promise, hang]); } finally { clearTimeout(timer); }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const groupAlive = pgid => { try { process.kill(-pgid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const pidsOf = file => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []);
async function survivors(pids, ms = 3_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const left = pids.filter(alive);
    if (!left.length || Date.now() > deadline) return left;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
const reap = pids => { for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } };

async function workspace(t) {
  mkdirSync('/tmp/opencode', { recursive: true });
  const root = await mkdtemp('/tmp/opencode/w13-lifecycle-');
  const pidfile = join(root, 'pids');
  t.after(async () => { reap(pidsOf(pidfile)); await rm(root, { recursive: true, force: true }); });
  return { root, pidfile, logFile: join(root, 'worker.log') };
}

test('batch worker: exit 0 while a grandchild still holds stdout/stderr settles, reports the real exit, and is not ok', async t => {
  const { pidfile, logFile } = await workspace(t);
  const result = await within(runWorker(NODE, [FIXTURE, 'orphan-pipe', pidfile], { logFile, ...LIMITS }), BOUND, 'runWorker');
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdio, 'forced', 'stdout/stderr never reached EOF; the pipes were closed by the supervisor');
  assert.equal(result.ok, false);
  assert.deepEqual(await survivors(pidsOf(pidfile)), [], 'the pipe holder is in the worker process group and must be killed');
});

test('batch worker: never exits and ignores SIGTERM → timeout, SIGTERM then SIGKILL to the whole group', async t => {
  const { pidfile, logFile } = await workspace(t);
  const started = Date.now();
  const result = await within(runWorker(NODE, [FIXTURE, 'ignore-term-orphan', pidfile], { logFile, ...LIMITS }), BOUND, 'runWorker');
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.ok, false);
  assert.equal(result.signal, 'SIGKILL');
  assert.deepEqual(result.escalation.map(step => step.signal), ['SIGTERM', 'SIGKILL']);
  assert.ok(result.escalation.every(step => step.target === 'group'));
  assert.ok(Date.now() - started < LIMITS.timeoutMs + 4 * LIMITS.killGraceMs + 2_000);
  assert.deepEqual(await survivors(pidsOf(pidfile)), []);
  assert.equal(groupAlive(result.pid), false);
});

test('batch worker: a worker killed by a signal after writing summary.json is recorded as signaled and never admitted', async t => {
  const { root, pidfile, logFile } = await workspace(t);
  const summary = join(root, 'summary.json');
  const result = await within(runWorker(NODE, [FIXTURE, 'summary', pidfile, summary, 'sigkill'], { logFile, ...LIMITS }), BOUND, 'runWorker');
  assert.equal(result.code, null);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.outcome, 'signaled');
  assert.equal(result.ok, false);
  assert.equal(existsSync(summary), true);
  assert.equal(acceptSummary(summary, result), null, 'a summary left by a killed worker is not a recording');
});

test('batch worker: exit code and summary must agree before a shard is admitted', async t => {
  const { root, pidfile, logFile } = await workspace(t);
  const run = async (then, runnerError) => {
    const summary = join(root, `${then}-${runnerError ? 'err' : 'ok'}.json`);
    const args = [FIXTURE, 'summary', pidfile, summary, then, ...(runnerError ? ['runner-error'] : [])];
    return { summary, result: await within(runWorker(NODE, args, { logFile, ...LIMITS }), BOUND, 'runWorker') };
  };
  const clean = await run('exit0');
  const admitted = acceptSummary(clean.summary, clean.result);
  assert.equal(admitted.runnerCode, 0);
  assert.equal(admitted.worker.outcome, 'exited');
  assert.equal(admitted.worker.ok, true);
  // g3-run-a/b exit 1 exactly when some scenario is a runner-error; the recorded ones stay usable.
  const partial = await run('exit1', true);
  assert.equal(acceptSummary(partial.summary, partial.result).runnerCode, 1);
  // Exit 1 without any runner-error, or a crash code, means the summary cannot be trusted.
  for (const [then, runnerError] of [['exit1', false], ['exit3', true], ['exit0', true]]) {
    const odd = await run(then, runnerError);
    assert.equal(acceptSummary(odd.summary, odd.result), null, `${then} runnerError=${runnerError}`);
  }
});

test('batch worker: a stopped worker (batch SIGTERM) is escalated, waited for, and reported as stopped', async t => {
  const { pidfile, logFile } = await workspace(t);
  const children = new Set();
  const pending = runWorker(NODE, [FIXTURE, 'ignore-term-orphan', pidfile], { logFile, children, ...LIMITS, timeoutMs: 60_000 });
  while (pidsOf(pidfile).length < 2) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(children.size, 1);
  const [handle] = children;
  const stopped = await within(handle.stop('batch SIGTERM'), BOUND, 'stop');
  assert.equal(stopped.outcome, 'stopped');
  assert.equal(stopped.stopReason, 'batch SIGTERM');
  assert.deepEqual(stopped.escalation.map(step => step.signal), ['SIGTERM', 'SIGKILL']);
  assert.equal((await pending).outcome, 'stopped');
  assert.equal(children.size, 0);
  assert.deepEqual(await survivors(pidsOf(pidfile)), []);
});

test('batch worker: plain success keeps stdout for the caller and closes cleanly', async t => {
  const { pidfile, logFile } = await workspace(t);
  const result = await within(runWorker(NODE, [FIXTURE, 'exit', pidfile, '0'], { logFile, ...LIMITS }), BOUND, 'runWorker');
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'exited');
  assert.equal(result.stdio, 'closed');
  assert.equal(result.stdout, 'stdout line\n');
  assert.equal(readFileSync(logFile, 'utf8'), 'stdout line\nstderr line\n');
  const failed = await within(runWorker(NODE, [FIXTURE, 'exit', pidfile, '7'], { logFile, ...LIMITS }), BOUND, 'runWorker');
  assert.equal(failed.code, 7);
  assert.equal(failed.ok, false);
});

// --- A runner: the real runScenarioA with a fake "Tauri binary" -----------------------

const SCENARIO = { id: 'w13.lifecycle', seed: 'empty', steps: [{ cmd: 'get_app_version' }], capture: { events: false, db: [] }, normalize: [] };

async function fakeApp(root, mode, pidfile) {
  const binary = join(root, `fake-tauri-${mode}`);
  writeFileSync(binary, `#!/bin/sh\nexec "${NODE}" "${FIXTURE}" ${mode} "${pidfile}"\n`);
  chmodSync(binary, 0o755);
  return binary;
}
async function runFake(t, mode) {
  const { root, pidfile } = await workspace(t);
  const scenarioFile = join(root, 'scenario.json');
  writeFileSync(scenarioFile, JSON.stringify({ domain: 'w13', commands: ['get_app_version'], scenarios: [SCENARIO] }));
  const { createSeed } = await import('../data-compat/__fixtures__/scenario-seeds.ts');
  const catalog = join(root, 'catalog');
  createSeed('empty', catalog);
  const directory = join(root, 'take', 'run');
  mkdirSync(directory, { recursive: true });
  const receipt = { binary: await fakeApp(root, mode, pidfile), job: 'fixture', binarySha256: 'fixture' };
  const started = Date.now();
  const outcome = await within(runScenarioA(SCENARIO, { scenarioFile, catalog, directory, receipt, events: { names: [], patterns: [] },
    timeouts: { boot: 3_000, step: 1_000, killGrace: 500, closeGrace: 500 }, harnessPort: 0 }).then(value => ({ value }), error => ({ error })), BOUND, 'runScenarioA');
  return { ...outcome, pidfile, directory, elapsed: Date.now() - started };
}
const appReceipt = directory => JSON.parse(readFileSync(join(directory, 'app-process.json'), 'utf8'));

test('A runner: app ignores SIGTERM, never boots, and its helper holds the pipes → boot error, everything reaped', async t => {
  const { error, pidfile, directory } = await runFake(t, 'ignore-term-orphan');
  assert.match(String(error), /Tauri boot: no harness answer within 3000ms/);
  assert.deepEqual(await survivors(pidsOf(pidfile)), []);
  const app = appReceipt(directory);
  assert.equal(app.outcome, 'stopped');
  assert.deepEqual(app.escalation.map(step => step.signal), ['SIGTERM', 'SIGKILL']);
});

test('A runner: app exits 0 at once but a helper keeps stdout/stderr open → rejected promptly, helper reaped', async t => {
  const { error, pidfile, directory } = await runFake(t, 'orphan-pipe');
  assert.match(String(error), /Tauri exited before recorder completion: 0\/null/);
  assert.deepEqual(await survivors(pidsOf(pidfile)), []);
  const app = appReceipt(directory);
  assert.equal(app.code, 0);
  assert.equal(app.stdio, 'forced');
});

test('A runner: a helper that escapes the process group (setsid) cannot hang the run; the leak is recorded', async t => {
  const { error, pidfile, directory } = await runFake(t, 'setsid-pipe');
  assert.match(String(error), /Tauri exited before recorder completion/);
  const app = appReceipt(directory);
  assert.equal(app.stdio, 'forced');
  assert.equal(app.ok, false);
  // Outside a PID namespace nobody else will reap it; inside g3-batch the namespace teardown does.
  reap(pidsOf(pidfile));
});

test('JSONL oracle: close() settles even when the oracle leaves a grandchild holding stdout', async t => {
  const { pidfile } = await workspace(t);
  const oracle = new JsonLineProcess([NODE, FIXTURE, 'oracle-orphan', pidfile], { timeout: 5_000 });
  assert.deepEqual(await oracle.request({ fn: 'ping' }), { ok: true, value: 1n });
  await within(oracle.close(), BOUND, 'JsonLineProcess.close');
  assert.deepEqual(await survivors(pidsOf(pidfile)), []);
});

// --- Linux: the PID namespace wrapper itself ------------------------------------------

test('namespace init refuses to run unless it is PID 1 (its TERM trap signals every process it can see)', () => {
  const result = spawnSync('bash', ['-c', NAMESPACE_INIT, 'g3-worker', 'sh', '-c', 'echo payload-ran'], { encoding: 'utf8' });
  assert.equal(result.status, 98);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /namespace init is not pid 1/);
});

function linuxSkip() {
  if (process.platform !== 'linux') return 'PID namespaces are Linux-only';
  if (spawnSync('unshare', ['-rnpf', '--mount-proc', '--kill-child', 'true']).status !== 0) return 'unprivileged unshare -rnpf unavailable';
  if (spawnSync('sh', ['-c', 'command -v ip']).status !== 0) return 'iproute2 (ip) missing';
  return false;
}

test('namespace wrapper: the first program is not PID 1 (Xvfb only signals a parent whose pid > 1)', { skip: linuxSkip() }, async t => {
  const { logFile } = await workspace(t);
  const result = await within(runWorker(NAMESPACE[0], [...NAMESPACE.slice(1), NODE, FIXTURE, 'print-pid'], { logFile, ...LIMITS }), BOUND, 'runWorker');
  assert.equal(result.ok, true, readFileSync(logFile, 'utf8'));
  assert.ok(Number(result.stdout.trim()) > 1, `first program ran as pid ${result.stdout.trim()}`);
});

test('namespace wrapper: the xvfb-run readiness handshake (wait for SIGUSR1 from a smart child) completes', { skip: linuxSkip() }, async t => {
  const { logFile } = await workspace(t);
  const handshake = `trap : USR1; (trap '' USR1; exec "${NODE}" "${FIXTURE}" smart-child) & child=$!; wait; kill $child; echo handshake-ok`;
  const result = await within(runWorker(NAMESPACE[0], [...NAMESPACE.slice(1), 'sh', '-c', handshake], { logFile, ...LIMITS, timeoutMs: 10_000 }), BOUND, 'runWorker');
  assert.equal(result.outcome, 'exited', readFileSync(logFile, 'utf8'));
  assert.equal(result.stdout.trim(), 'handshake-ok');
});

test('namespace wrapper: a hung payload that ignores SIGTERM is torn down with its whole namespace', { skip: linuxSkip() }, async t => {
  const { logFile } = await workspace(t);
  const result = await within(runWorker(NAMESPACE[0], [...NAMESPACE.slice(1), NODE, FIXTURE, 'ignore-term-orphan'], { logFile, ...LIMITS, timeoutMs: 2_000 }), BOUND, 'runWorker');
  assert.equal(result.outcome, 'timeout');
  assert.equal(groupAlive(result.pid), false, 'outer unshare process group must be empty');
});

test('namespace wrapper: each worker gets its own private MCP directory at the fixed path', { skip: linuxSkip() }, async t => {
  const { logFile } = await workspace(t);
  const probe = token => `[ "$G3_MCP_DIR" = ${MCP_MOUNT} ] || { echo "G3_MCP_DIR=$G3_MCP_DIR"; exit 3; }; `
    + `[ -z "$(ls -A "$G3_MCP_DIR")" ] || { echo "not empty: $(ls -A "$G3_MCP_DIR")"; exit 4; }; `
    + `echo ${token} > "$G3_MCP_DIR/owner"; sleep 0.5; cat "$G3_MCP_DIR/owner"`;
  const results = await within(Promise.all(['one', 'two'].map(token => runWorker(NAMESPACE[0], [...NAMESPACE.slice(1), 'sh', '-c', probe(token)],
    { logFile: `${logFile}.${token}`, ...LIMITS, timeoutMs: 10_000 }))), BOUND, 'runWorker');
  for (const [index, token] of ['one', 'two'].entries()) {
    assert.equal(results[index].ok, true, readFileSync(`${logFile}.${token}`, 'utf8'));
    assert.equal(results[index].stdout.trim(), token, 'the other worker never wrote here');
  }
  assert.equal(existsSync(join(MCP_MOUNT, 'owner')), false, 'nothing reaches the host path');
});

test('namespace wrapper: real xvfb-run -a under the wrapper starts and exits (server check)', {
  skip: linuxSkip() || (spawnSync('sh', ['-c', 'command -v xvfb-run']).status !== 0 && 'xvfb-run not installed'),
}, async t => {
  const { logFile } = await workspace(t);
  const result = await within(runWorker(NAMESPACE[0], [...NAMESPACE.slice(1), 'xvfb-run', '-a', 'sh', '-c', 'echo display=$DISPLAY'],
    { logFile, ...LIMITS, timeoutMs: 30_000 }), 40_000, 'runWorker');
  assert.equal(result.ok, true, readFileSync(logFile, 'utf8'));
  assert.match(result.stdout, /^display=:\d+$/m);
});
