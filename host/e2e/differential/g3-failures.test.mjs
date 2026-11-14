// g3-failures.mjs: runner errors caused by the host refusing threads/processes (EAGAIN) are
// infrastructure, everything else is a scenario runner error. Signatures from the ser-38
// A-store batch 1 incident (INTEGRATION-NOTES 10:00).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyRunnerError, classifySummary, scanRunnerErrors } from '../../../scripts/electron-migration/record/g3-failures.mjs';

const INFRASTRUCTURE = [
  ['tokio worker', "thread 'main' panicked at /cargo/tokio-1.40.0/src/runtime/blocking/pool.rs:: OS can't spawn worker thread: Resource temporarily unavailable (os error 11)", 'os-error-11'],
  ['scheduled-thread-pool unwrap', 'called `Result::unwrap()` on an `Err` value: Os { code: 11, kind: WouldBlock, message: "Resource temporarily unavailable" }', 'os-error-11'],
  ['GLib gmain', "(deep-student:41): GLib-ERROR **: 09:41:02.118: creating thread 'gmain': Error creating thread: Resource temporarily unavailable", 'resource-temporarily-unavailable'],
  ['WebKit web process', 'Failed to spawn a new child process: Failed to fork (Resource temporarily unavailable)', 'resource-temporarily-unavailable'],
  ['node spawn', 'Error: spawn xvfb-run EAGAIN', 'eagain'],
  ['pthread', 'runtime/cgo: pthread_create failed: Resource temporarily unavailable', 'resource-temporarily-unavailable'],
  ['std thread builder', "thread 'tokio-runtime-worker' panicked: failed to spawn thread", 'thread-spawn'],
];
const SCENARIO = [
  ['A defect', 'Error: no such table: chat_v2_blocks'],
  ['timeout code 110', 'Connection timed out (os error 110)'],
  ['other errno', 'Error: spawn /missing ENOENT; EACCES: permission denied'],
  ['harness timeout alone', 'Error: harness ready timed out after 120000 ms'],
  ['WouldBlock of another code', 'Os { code: 110, kind: WouldBlock }'],
];

test('every EAGAIN / thread-creation signature of the ser-38 incident is infrastructure, in the reason or the take log', async t => {
  for (const [name, line, id] of INFRASTRUCTURE) {
    const result = classifyRunnerError({ reason: `Error: runner failed\n${line}` });
    assert.equal(result.class, 'infrastructure', name);
    assert.equal(result.signature.source, 'reason', name);
    assert.equal(result.signature.id, id, name);
  }
  const root = await mkdtemp(join(tmpdir(), 'w13-failures-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = join(root, 'app.stderr.log');
  writeFileSync(log, `${'webkit noise\n'.repeat(1000)}${INFRASTRUCTURE[0][1]}\n`);
  const fromLog = classifyRunnerError({ reason: SCENARIO[3][1], logs: [log] });
  assert.equal(fromLog.class, 'infrastructure');
  assert.equal(fromLog.signature.source, log);
});

test('other runner errors stay scenario runner errors (no errno look-alikes, no bare timeouts)', () => {
  for (const [name, line] of SCENARIO) assert.deepEqual(classifyRunnerError({ reason: line }), { class: 'scenario', signature: null }, name);
  assert.deepEqual(classifyRunnerError({ reason: 'x', logs: ['/nonexistent/app.stderr.log'] }), { class: 'scenario', signature: null });
});

test('summaries: each take reads its own log; only current admitted shards count, renamed-aside ones are history', async t => {
  const root = await mkdtemp(join(tmpdir(), 'w13-failures-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shard = (side, name, runs, admitted = true) => {
    const directory = join(root, side, 'fixtures__x', name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'summary.json'), JSON.stringify({ runs, ...(admitted ? { runnerCode: 1, worker: { outcome: 'exited', stdio: 'closed' } } : {}) }));
    return directory;
  };
  const takeLog = (directory, id, take, text) => {
    mkdirSync(join(directory, id, take, 'run'), { recursive: true });
    writeFileSync(join(directory, id, take, 'run', take === 'B' ? 'host.stderr.log' : 'app.stderr.log'), text);
  };
  const a = shard('A', '000', [{ id: 's.one', side: 'A1', status: 'runner-error', reason: 'Error: Tauri exited (signal SIGTRAP)' },
    { id: 's.two', side: 'A1', status: 'runner-error', reason: 'Error: step 0 timed out' }, { id: 's.three', side: 'A1', status: 'recorded' }]);
  takeLog(a, 's.one', 'A1', INFRASTRUCTURE[2][1]);
  takeLog(a, 's.two', 'A2', INFRASTRUCTURE[0][1]); // another take's log never classifies this one
  const b = shard('B', '000', [{ id: 's.one', status: 'runner-error', reason: 'Error: host exited' }]);
  takeLog(b, 's.one', 'B', 'Error: spawn node EAGAIN\n');
  shard('A', '000.superseded-1', [{ id: 's.one', side: 'A1', status: 'runner-error', reason: INFRASTRUCTURE[0][1] }]);
  shard('A', '001', [{ id: 's.four', side: 'A1', status: 'runner-error', reason: INFRASTRUCTURE[0][1] }], false);

  assert.deepEqual(classifySummary(a, { runs: [{ id: 's.two', side: 'A1', status: 'runner-error', reason: 'x' }] }).map(item => item.class), ['scenario']);
  const scan = scanRunnerErrors(root, ['A', 'B', 'A2']);
  assert.deepEqual(scan.counts, { A: { infrastructure: 1, scenario: 1 }, B: { infrastructure: 1, scenario: 0 }, A2: { infrastructure: 0, scenario: 0 } });
  assert.deepEqual(scan.signatures, { 'resource-temporarily-unavailable': 1, eagain: 1 });
  assert.deepEqual(scan.infrastructure.map(item => [item.shard, item.id, item.side]), [['A/fixtures__x/000', 's.one', 'A1'], ['B/fixtures__x/000', 's.one', 'B']]);
});
