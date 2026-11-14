// g3-a-stale: which scenarios' A takes a change invalidates, between two commits, a commit and the
// working tree, or an A store and a tree. Throwaway recording tree (the real record/ code, fake
// runners, the real seed generator); the A store is recorded by the real g3-batch --mode a-store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { makeSplitRepo } from './__fixtures__/g3-batch-repo.mjs';

const RECORD = 'scripts/electron-migration/record';
const STALE = `${RECORD}/g3-a-stale.mjs`;
const RUN_A = `${RECORD}/g3-run-a.mjs`;
const CHAT = 'host/plugins/chat/equivalence/chat.json';
const NOTES = 'host/plugins/notes/equivalence/notes.json';
const ALL = [[CHAT, 'chat.one.ok'], [CHAT, 'chat.two.ok'], [NOTES, 'notes.one.ok']];

async function fixture(t) {
  mkdirSync('/tmp/opencode', { recursive: true });
  const root = await mkdtemp('/tmp/opencode/w13-stale-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = await makeSplitRepo(join(root, 'repo'), { [CHAT]: ['chat.one.ok', 'chat.two.ok'], [NOTES]: ['notes.one.ok'] });
  const scratch = join(root, 'tmp');
  mkdirSync(scratch);
  const text = file => readFileSync(join(repo.root, file), 'utf8');
  const run = args => spawnSync(process.execPath, [STALE, ...args], { cwd: repo.root, env: { ...repo.env, TMPDIR: scratch }, encoding: 'utf8' });
  const stale = args => {
    const result = run([...args, '--json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(readdirSync(scratch), [], 'extracted trees and seed catalogs are removed');
    return JSON.parse(result.stdout);
  };
  return { ...repo, root: repo.root, text, run, stale };
}
const ids = items => items.map(item => [item.file, item.id]);

test('commits: B-side, compare and report edits leave every A take; an A runner edit invalidates all; a scenario edit only its own; the working tree counts uncommitted edits', { timeout: 120_000 }, async t => {
  const repo = await fixture(t);
  const base = repo.head;
  const bSide = repo.commit('B side, compare and report edits', {
    [`${RECORD}/g3-run-b.mjs`]: `${repo.text(`${RECORD}/g3-run-b.mjs`)}\nprocess.env.W13_B_EDIT ??= '1';\n`,
    [`${RECORD}/g3-compare.mjs`]: `${repo.text(`${RECORD}/g3-compare.mjs`)}\nexport const w13CompareEdit = 1;\n`,
    [`${RECORD}/g3-report.mjs`]: `${repo.text(`${RECORD}/g3-report.mjs`)}\n// w13 report edit\n`,
  });
  const unchanged = repo.stale(['--from', base, '--to', bSide]);
  assert.deepEqual({ from: unchanged.from, to: unchanged.to }, { from: { kind: 'commit', rev: base, commit: base }, to: { kind: 'commit', rev: bSide, commit: bSide } });
  assert.deepEqual([unchanged.scenarios, unchanged.unaffected, unchanged.stale, unchanged.missing, unchanged.removed], [3, 3, [], [], []]);
  assert.equal(unchanged.seeds, true);

  const aSide = repo.commit('A runner edit', { [RUN_A]: `${repo.text(RUN_A)}\nprocess.env.W13_A_EDIT ??= '1';\n` });
  const runner = repo.stale(['--from', bSide, '--to', aSide]);
  assert.deepEqual(ids(runner.stale), ALL);
  for (const item of runner.stale) assert.deepEqual(item.reasons, [`code:${RUN_A}`]);
  assert.deepEqual(runner.reasons, { [`code:${RUN_A}`]: 3 });

  const suite = JSON.parse(repo.text(CHAT));
  suite.scenarios[1].steps.push({ cmd: 'get_app_version' });
  suite.scenarios.push({ ...suite.scenarios[0], id: 'chat.three.ok' });
  const edited = repo.commit('one scenario edited, one added', { [CHAT]: JSON.stringify(suite, null, 2) });
  const scenario = repo.stale(['--from', aSide, '--to', edited]);
  assert.deepEqual(scenario.stale, [{ file: CHAT, id: 'chat.two.ok', reasons: ['scenario'] }]);
  assert.deepEqual(scenario.missing, [{ file: CHAT, id: 'chat.three.ok' }]);
  assert.equal(scenario.unaffected, 2);

  const selected = repo.stale(['--from', base, '--to', edited, '--domain', 'notes']);
  assert.deepEqual(ids(selected.stale), [[NOTES, 'notes.one.ok']], '--domain reports only that domain');
  assert.equal(repo.stale(['--from', base, '--to', edited, '--file', NOTES, '--no-seeds']).seeds, false);

  // Without --to: the working tree, uncommitted edits included.
  const notes = JSON.parse(repo.text(NOTES));
  notes.scenarios[0].steps.push({ cmd: 'get_app_version' });
  writeFileSync(join(repo.root, NOTES), JSON.stringify(notes, null, 2));
  const worktree = repo.run(['--from', edited]);
  assert.equal(worktree.status, 0, worktree.stderr);
  assert.match(worktree.stdout, new RegExp(`^to: {3}working tree at ${edited} with 1 modified tracked file\\(s\\)$`, 'm'));
  assert.match(worktree.stdout, /^valid scenarios: 4; A takes unaffected: 3; stale: 1; no A inputs at from: 0; removed since: 0$/m);
  assert.match(worktree.stdout, new RegExp(`^  ${NOTES}\\tnotes\\.one\\.ok\\tscenario$`, 'm'));

  const unknown = repo.run(['--from', 'no-such-rev']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /not a commit: no-such-rev/);
  const domain = repo.run(['--from', base, '--domain', 'nope']);
  assert.notEqual(domain.status, 0);
  assert.match(domain.stderr, /unknown domain: nope/);
});

test('A store: its recorded inputs against a later tree; its environment unless --tz/--locale say otherwise; the report selects an A top-up of this clean commit', { timeout: 120_000 }, async t => {
  const repo = await fixture(t);
  const store = join(repo.root, 'store');
  const recorded = spawnSync(process.execPath, [`${RECORD}/g3-batch.mjs`, repo.receipt, '--mode', 'a-store', '--out', store, '--sides', 'A,A2',
    '--workers-a', '3', '--workers-a2', '3', '--shard-size', '1', '--kill-grace-s', '1'], { cwd: repo.root, env: repo.env, encoding: 'utf8' });
  assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);

  const later = repo.commit('B side edit', { [`${RECORD}/g3-run-b.mjs`]: `${repo.text(`${RECORD}/g3-run-b.mjs`)}\n// w13 b edit\n` });
  const reused = repo.stale(['--from', store, '--to', later]);
  assert.equal(reused.from.kind, 'a-store');
  assert.equal(reused.from.recorderHead, repo.head);
  assert.equal(reused.from.scenarioInputs, 'recorded');
  assert.deepEqual(reused.from.defects, []);
  assert.deepEqual(reused.environment, { TZ: 'UTC', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
  assert.deepEqual([reused.unaffected, reused.stale], [3, []]);

  const runner = repo.commit('A runner edit', { [RUN_A]: `${repo.text(RUN_A)}\nprocess.env.W13_A_EDIT ??= '1';\n` });
  assert.deepEqual(repo.stale(['--from', store, '--to', runner]).stale.map(item => item.reasons), [[`code:${RUN_A}`], [`code:${RUN_A}`], [`code:${RUN_A}`]]);

  // The clean working tree's report selects an A top-up of this commit; another commit's is refused.
  const report = repo.stale(['--from', store]);
  assert.deepEqual(report.topUpScenarios, ALL.map(([file, id]) => ({ file, id })));
  const reportFile = join(repo.root, '..', 'a-stale.json');
  writeFileSync(reportFile, JSON.stringify(report));
  const supervise = commit => spawnSync(process.execPath, [`${RECORD}/g3-supervise.mjs`, '--mode', 'a-store', '--tree', repo.root, '--commit', commit,
    '--a-receipt', repo.receipt, '--out', join(repo.root, '..', 'topup'), '--phase', 'full', '--top-up-from', reportFile, '--dry-run'], { cwd: repo.root, env: repo.env, encoding: 'utf8' });
  const planned = supervise(runner);
  assert.ok(planned.stdout.trim(), planned.stderr);
  const batch = JSON.parse(planned.stdout).batch;
  const values = flag => batch.flatMap((item, index) => (item === flag ? [batch[index + 1]] : []));
  assert.deepEqual(values('--file'), [CHAT, NOTES]);
  assert.deepEqual(values('--scenario'), ['chat.one.ok', 'chat.two.ok', 'notes.one.ok']);
  const refused = supervise(later);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, new RegExp(`that g3-a-stale report is not of the clean working tree at ${later}`));

  // A report made with --to <commit> selects the same top-up of that commit; another commit's is refused.
  writeFileSync(reportFile, JSON.stringify(repo.stale(['--from', store, '--to', runner])));
  const viaTo = supervise(runner);
  assert.ok(viaTo.stdout.trim(), viaTo.stderr);
  assert.deepEqual(JSON.parse(viaTo.stdout).batch, batch);
  const otherTo = supervise(later);
  assert.notEqual(otherTo.status, 0);
  assert.match(otherTo.stderr, new RegExp(`that g3-a-stale report is not of the clean working tree at ${later} nor --to it`));

  const berlin = repo.stale(['--from', store, '--to', later, '--tz', 'Europe/Berlin']);
  assert.deepEqual(berlin.environment, { TZ: 'Europe/Berlin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
  for (const item of berlin.stale) assert.ok(item.reasons.includes('environment'), `${item.id}: ${item.reasons}`);
  assert.equal(berlin.stale.length, 3);
});
