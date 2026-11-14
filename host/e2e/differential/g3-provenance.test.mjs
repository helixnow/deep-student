// G3 evidence traceability: a compare counts only if its run records the B commit (clean
// tree), the Host runtime receipt and the A build receipt sha256, and each of its traces is
// listed in an admitted worker receipt. Anything missing → not counted, with a problem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { executeScenario } from '../../../scripts/electron-migration/record/scenario-v0.mjs';
import { stringifyExact } from '../../../scripts/electron-migration/record/json.mjs';
import { buildCompare } from '../../../scripts/electron-migration/record/g3-compare.mjs';
import { buildReport, renderMarkdown, scanScenarios } from '../../../scripts/electron-migration/record/g3-report.mjs';
import { APPROVALS, BATCH, createRunManifest } from '../../../scripts/electron-migration/record/g3-manifest.mjs';
import { NORMALIZER_FILES } from '../../../scripts/electron-migration/record/g3-normalize.mjs';
import { admittedTraces, recordingDefects } from '../../../scripts/electron-migration/record/g3-provenance.mjs';
import { sealRecording } from './__fixtures__/provenance.mjs';
import { makeBatchRepo } from './__fixtures__/g3-batch-repo.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const RUNS = 'fixtures/differential/g3/runs';
const SUITE = 'host/plugins/demo/equivalence/demo.json';
const SCENARIO = { id: 'demo.ok', seed: 'empty', steps: [{ cmd: 'cmd_ok', args: {} }], capture: { events: true, db: [] }, normalize: [] };
const EXPECTED = { count: 1, sha256: sha('cmd_ok\n') };

async function comparedRun(t) {
  mkdirSync('/tmp/opencode', { recursive: true });
  const root = await mkdtemp('/tmp/opencode/w13-provenance-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = (path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
  put('scripts/electron-migration/frontend-audit/wave0-inventory.json', JSON.stringify({ commit: 'synthetic', baseline: { flaggedApp: 1, added: [] },
    commands: [{ name: 'cmd_ok', kind: 'rust-contract', owner: { lane: 'L-demo' }, rust: { file: 'demo.rs', line: 1 } }] }));
  mkdirSync(join(root, 'electron'));
  for (const file of [APPROVALS, BATCH, ...NORMALIZER_FILES]) put(file, readFileSync(file));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: root });
  put(SUITE, JSON.stringify({ domain: 'demo', commands: ['cmd_ok'], scenarios: [SCENARIO] }));
  const traces = {};
  for (const side of ['A', 'B']) {
    const trace = await executeScenario(SCENARIO, {
      async invoke(command, raw) { return { kind: 'result', raw: `{"command":"${command}","args":${raw}}` }; },
      capture: () => ({ events: [], databases: { version: 0, databases: {} } }),
    });
    trace.inputSha256 = sha(readFileSync(join(root, SUITE)));
    trace.eventScope = { kind: 'all' };
    traces[side] = join(root, RUNS, SCENARIO.id, side, 'trace.json');
    put(join(RUNS, SCENARIO.id, side, 'trace.json'), stringifyExact(trace, 2));
  }
  const artifact = await buildCompare({ scenarioFile: join(root, SUITE), scenarioId: SCENARIO.id, aTrace: traces.A, bTrace: traces.B, root });
  assert.equal(artifact.equal, true);
  put(join(RUNS, 'compare', SCENARIO.id, `${SCENARIO.id}.compare.json`), stringifyExact(artifact, 2));
  const report = async () => {
    const manifest = createRunManifest(root, RUNS, scanScenarios(root).suites);
    writeFileSync(join(root, RUNS, 'RUN-MANIFEST.json'), JSON.stringify(manifest));
    const built = await buildReport({ root, runsDir: RUNS, expected: EXPECTED, blockers: 'none.json', excluded: 'none.json' });
    return { manifest, report: built, status: built.commands[0].status, problems: built.problems.filter(p => p.kind === 'unattributable-recording').map(p => p.message) };
  };
  return { root, report, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() };
}

test('report: a run without a recording receipt is never counted, even when A and B are equal', async t => {
  const { report } = await comparedRun(t);
  const { status, problems, manifest, report: built } = await report();
  assert.equal(status, 'no-scenario');
  assert.deepEqual(problems, ['recording receipt incomplete: recording-receipt-missing']);
  assert.equal(manifest.recordingRevision, 'not-established-by-this-manifest');
  assert.match(renderMarkdown(built), /录制回执：不完整（recording-receipt-missing），本目录的 compare 一律不计入/);
});

test('report: a sealed run counts; every missing or changed provenance item un-counts it', async t => {
  const { root, report, head } = await comparedRun(t);
  const sealed = sealRecording(root, RUNS);
  const ok = await report();
  assert.equal(ok.status, 'pass');
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.manifest.recordingRevision, head);
  assert.equal(ok.report.recording.bHead, head);
  assert.equal(ok.report.recording.bClean, true);
  assert.equal(ok.report.recording.workerReceipts.count, 2);
  assert.match(renderMarkdown(ok.report), new RegExp(`B 端提交 \`${head}\`（工作树干净）`));

  // The seal covers the recording files: changing them after sealing cannot yield a report.
  const recordingBytes = readFileSync(sealed.recordingFile);
  writeFileSync(sealed.recordingFile, recordingBytes.toString().replace('"clean": true', '"clean": false'));
  await assert.rejects(buildReport({ root, runsDir: RUNS, expected: EXPECTED, blockers: 'none.json', excluded: 'none.json' }), /RUN-MANIFEST mismatch: recording/);
  writeFileSync(sealed.recordingFile, recordingBytes);

  const receiptsDir = join(root, RUNS, 'receipts');
  const receiptFile = side => join(receiptsDir, side, readdirSync(join(receiptsDir, side))[0]);
  const json = file => JSON.parse(readFileSync(file, 'utf8'));
  const cases = [
    ['B tree not clean', sealed.recordingFile, recording => { recording.b.clean = false; }, /b-tree-not-clean/],
    ['B head missing', sealed.recordingFile, recording => { delete recording.b.head; }, /b-head/],
    ['A receipt sha256 missing', sealed.recordingFile, recording => { delete recording.a.buildReceipt.sha256; }, /a-build-receipt-sha256/],
    ['Host receipt changed', sealed.hostFile, host => { host.node.version = 'v0.0.0'; }, /b-host-receipt-changed/],
    ['A build receipt changed', sealed.aReceipt, receipt => { receipt.binarySha256 = 'b'.repeat(64); }, /a-build-receipt-changed/],
    ['B worker timed out', receiptFile('B'), receipt => { receipt.process.outcome = 'timeout'; }, /^B trace has no admitted worker receipt$/],
    ['B worker not admitted', receiptFile('B'), receipt => { receipt.admitted = false; }, /^B trace has no admitted worker receipt$/],
    ['A trace not the recorded one', receiptFile('A'), receipt => { receipt.traces[0].sha256 = 'c'.repeat(64); }, /^A trace differs from its worker receipt$/],
  ];
  for (const [label, file, mutate, expected] of cases) {
    const original = readFileSync(file);
    const value = json(file);
    mutate(value);
    writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
    const { status, problems } = await report();
    assert.notEqual(status, 'pass', label);
    assert.equal(problems.length, 1, label);
    assert.match(problems[0], expected, label);
    writeFileSync(file, original);
  }
  for (const [label, remove, expected] of [
    ['A build receipt deleted', sealed.aReceipt, /a-build-receipt-missing/],
    ['B worker receipt deleted', receiptFile('B'), /^B trace has no admitted worker receipt$/],
  ]) {
    const original = readFileSync(remove);
    rmSync(remove);
    const { status, problems } = await report();
    assert.notEqual(status, 'pass', label);
    assert.match(problems[0], expected, label);
    writeFileSync(remove, original);
  }
  assert.equal((await report()).status, 'pass');
});

test('g3-batch: RECORDING.json v2 pins B commit + clean tree, Host receipt and A receipt sha256; reruns may change flags, not inputs', { timeout: 60_000 }, async t => {
  mkdirSync('/tmp/opencode', { recursive: true });
  const root = await mkdtemp('/tmp/opencode/w13-recording-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = makeBatchRepo(root, ['w13.ok']);
  const out = join(root, 'out');
  const batch = (...extra) => spawnSync(process.execPath, ['scripts/electron-migration/record/g3-batch.mjs', repo.receipt, '--out', out, '--sides', 'A,B',
    '--record-only', '--kill-grace-s', '1', ...extra], { cwd: root, env: repo.env, encoding: 'utf8' });
  const first = batch();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const recording = JSON.parse(readFileSync(join(out, 'RECORDING.json'), 'utf8'));
  assert.equal(recording.schema, 'g3-recording/v2');
  assert.equal(recording.b.head, repo.head);
  assert.equal(recording.b.clean, true);
  assert.equal(recording.b.hostReceipt.sha256, sha(readFileSync(join(out, 'host-receipt.json'))));
  const host = JSON.parse(readFileSync(join(out, 'host-receipt.json'), 'utf8'));
  assert.equal(host.head, repo.head);
  assert.equal(host.node.execPath, process.execPath);
  assert.equal(host.node.sha256, sha(readFileSync(process.execPath)));
  assert.equal(recording.a.buildReceipt.file, repo.receipt);
  assert.equal(recording.a.buildReceipt.sha256, sha(readFileSync(repo.receipt)));
  assert.equal(recording.a.buildReceipt.binarySha256, 'f'.repeat(64));
  assert.equal(recording.runner.files['scripts/electron-migration/record/g3-batch.mjs'], sha(readFileSync(join(root, 'scripts/electron-migration/record/g3-batch.mjs'))));
  assert.match(recording.runner.isolation.init, /\[ "\$\$" = 1 \]/);
  assert.equal('cli' in recording, false, 'operational flags are not recording identity');
  assert.deepEqual(recordingDefects(root, out).defects, []);
  assert.equal(Object.keys(admittedTraces(root, out).traces).length, 2);

  const second = batch('--workers-a', '2', '--shard-timeout-min', '5');
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(readFileSync(join(out, 'invocations.jsonl'), 'utf8').trim().split('\n').length, 2);

  writeFileSync(repo.receipt, JSON.stringify({ schema: 'wp043-tauri-build', job: 'other-build', code: 0, binarySha256: 'e'.repeat(64) }));
  const changed = batch();
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /recording inputs changed; use a new output directory/);

  writeFileSync(join(root, 'fixtures/w13/suite.json'), '{"scenarios":[]}');
  const dirty = batch('--out', join(root, 'out-dirty'));
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /freeze and commit the recording tree first/);
  assert.equal(existsSync(join(root, 'out-dirty', 'RECORDING.json')), false);
});
