import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import * as p from './lib/progress.mjs';

const H = 3_600_000;
const NOW = Date.parse('2026-11-06T18:00:00Z');

test('commit classification: product beats docs; checkpoints are flagged, not hidden', () => {
  assert.deepEqual(p.classifyCommit({ subject: 'x', files: ['host/plugins/vfs/a.ts', 'docs/a.md'] }), { kind: 'product', checkpoint: false });
  assert.equal(p.classifyCommit({ files: ['host/plugins/vfs/TESTMAP.md', 'migration/SPEC-L13.md'] }).kind, 'doc');
  assert.equal(p.classifyCommit({ files: ['scripts/electron-migration/coord.mjs'] }).kind, 'orch');
  assert.equal(p.classifyCommit({ subject: 'checkpoint: 自动检查点', files: ['host/a.ts'] }).checkpoint, true);
});

test('lane verdicts separate producing, documentation-only, and step burning without commits', () => {
  const doc = { subject: 'docs', files: ['host/plugins/x/SPEC.md'] };
  assert.equal(p.classifyLane({ lane: 'L13-vfs-api', commits: [{ files: ['host/a.ts'] }, doc] }).verdict, 'producing');
  assert.equal(p.classifyLane({ lane: 'L13-vfs-api', commits: [doc, doc] }).verdict, 'doc-spin');
  assert.equal(p.classifyLane({ lane: 'R3-review-vfs', commits: [doc, doc] }).verdict, 'quiet', 'review lanes produce documents by design');
  assert.equal(p.classifyLane({ lane: 'L12-vfs-index', commits: [], steps: 120, alive: true }).verdict, 'idle-spin');
  assert.equal(p.classifyLane({ lane: 'L12-vfs-index', commits: [], steps: 10 }).verdict, 'quiet');
});

test('reconcile flags a metric that is not counted rather than not done (cmdA 99.8% / cmdB 0 for 47h)', () => {
  const ledger = [
    { t: '2026-11-04T04:43:00Z', cmdA: 92, cmdB: 7.7, testA: 70, testB: 1, head: 'aaa' },
    { t: '2026-11-04T18:22:00Z', cmdA: 99.8, cmdB: 0, testA: 89, testB: 89, head: 'bbb' },
    { t: '2026-11-06T17:57:00Z', cmdA: 99.8, cmdB: 0, testA: 89.8, testB: 89.2, head: 'd2523a02c', testsHead: 'd2523a02c', fulltestOk: false },
  ];
  const ids = p.reconcile({ ledger, fulltest: { head: '5f806c95eb', at: '2026-11-06T13:11:00Z', complete: true, rawFailures: [] }, mainHead: 'd2523a02c62a', nowMs: NOW }).map((a) => a.id);
  assert.ok(ids.includes('metric-uncounted:cmdB'));
  assert.ok(ids.includes('testB-on-red'));
  assert.ok(ids.includes('ledger-head-mismatch'));
  assert.ok(ids.includes('fulltest-stale'));
  assert.ok(!ids.includes('metric-uncounted:testB'));
  assert.deepEqual(p.reconcile({ ledger: [{ t: '2026-11-06T17:00:00Z', cmdA: 50, cmdB: 0, testA: 40, testB: 30, head: 'abc' }], mainHead: 'abc', nowMs: NOW }), [], 'young project with A < 95 is not flagged');
});

test('zero-merge streak counts only the trailing empty integration rounds', () => {
  const log = ['x 自动集成：合入 2（a,b）；未合入 0（）', 'x 自动集成：合入 0（）；未合入 3（c）', 'x 自动集成：合入 0（）；未合入 4（c）'].join('\n');
  assert.deepEqual(p.zeroMergeStreak(log), { streak: 2, rounds: 3 });
});

test('collector credits a lane for its own pending and integrated commits, not main commits merged into it, and counts recent steps', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-test-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  g('init', '-q', '-b', 'main');
  const commit = (file, msg) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), `${msg}\n`);
    g('add', '-A');
    g('commit', '-q', '-m', msg);
  };
  commit('README.md', 'init');
  g('checkout', '-q', '-b', 'ds-mig/L01-llm-providers');
  commit('host/plugins/llm/TESTMAP.md', 'map');
  commit('migration/SPEC-L01.md', 'spec');
  g('checkout', '-q', 'main');
  commit('host/plugins/other/a.ts', 'someone else code');
  g('checkout', '-q', 'ds-mig/L01-llm-providers');
  g('merge', '-q', '--no-edit', 'main');
  const runs = path.join(dir, '.oc-runs');
  fs.mkdirSync(runs);
  const step = (ms) => JSON.stringify({ type: 'step_start', timestamp: ms, part: {} });
  fs.writeFileSync(path.join(runs, 'L01-llm-providers.jsonl'), `${[step(Date.now() - 5 * H), ...Array.from({ length: 45 }, (_, i) => step(Date.now() - i * 1000))].join('\n')}\n`);
  const sessions = { L01: undefined, 'L01-llm-providers': { branch: 'ds-mig/L01-llm-providers' }, 'C1-app': { coordinator: true, lanes: ['L01-llm-providers'] } };
  delete sessions.L01;
  const r = p.collectProgress({ runs, sessions, git: (...a) => g(...a), minutes: 120 });
  assert.equal(r.rows.length, 1, 'coordinators are not rated as executors');
  const row = r.rows[0];
  assert.equal(row.product, 0, 'the main commit merged into the branch is not credited to the lane');
  assert.equal(row.doc, 2);
  assert.equal(row.steps, 45, 'steps outside the window are not counted');
  assert.equal(row.verdict, 'doc-spin');
  assert.match(p.formatProgress(r), /L01-llm-providers \| 只改文档 \| 0 \| 2/);
  // Integration merges the lane into main with --no-ff (integrate-parallel label), then the lane fast-forwards to main:
  // the lane's code commit leaves its first-parent line but stays credited to the lane.
  commit('host/plugins/llm/provider.ts', 'port provider');
  g('checkout', '-q', 'main');
  g('merge', '-q', '--no-ff', '-m', 'merge ds-mig/L01-llm-providers', 'ds-mig/L01-llm-providers');
  g('checkout', '-q', 'ds-mig/L01-llm-providers');
  g('merge', '-q', '--no-edit', 'main');
  const after = p.collectProgress({ runs, sessions, git: (...a) => g(...a), minutes: 120 }).rows[0];
  assert.deepEqual([after.product, after.doc, after.verdict], [1, 2, 'producing']);
});
