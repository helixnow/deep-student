import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkBranch, checkPatch } from './absorb-check.mjs';

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'absorb-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' }).trim();
  const write = (f, s) => (fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }), fs.writeFileSync(path.join(dir, f), s));
  git('init', '-q', '-b', 'main');
  write('host/a.ts', 'a1\n');
  write('host/b.ts', 'b1\n');
  write('host/c.ts', 'c1\n');
  write('docs/x.md', 'x1\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'ds-mig/L20-sync');
  write('host/a.ts', 'a2\n');
  write('host/b.ts', 'b2\n');
  write('host/c.ts', 'c2\n');
  write('docs/x.md', 'x2\n');
  write('host/new.ts', 'n\n');
  git('commit', '-qam', 'lane work');
  git('add', '-A');
  git('commit', '-qm', 'new file');
  git('checkout', '-q', 'main');
  write('host/a.ts', 'a2\n');
  write('host/new.ts', 'n\n');
  write('host/c.ts', 'c3\n');
  git('add', '-A');
  git('commit', '-qm', 'integration absorbed a.ts and new.ts, rewrote c.ts');
  return { dir, git };
}

test('per file: absorbed when main already has the change, open when it applies cleanly, diverged otherwise; docs counted apart', () => {
  const { dir, git } = repo();
  const before = git('status', '--porcelain');
  const r = checkBranch(dir, 'ds-mig/L20-sync', 'main');
  assert.equal(r.lane, 'L20-sync');
  assert.deepEqual(r.absorbed, ['host/a.ts', 'host/new.ts']);
  assert.deepEqual(r.open, ['docs/x.md', 'host/b.ts']);
  assert.deepEqual(r.diverged, ['host/c.ts']);
  assert.deepEqual(r.openCode, ['host/b.ts']);
  assert.equal(r.resettable, false);
  assert.equal(git('status', '--porcelain'), before, 'the real index and worktree are untouched');
});

test('a saved patch file (.transfer/inflight/*.patch) is judged the same way against a target ref', () => {
  const { dir, git } = repo();
  const patch = path.join(dir, '..', `${path.basename(dir)}-L20.patch`);
  fs.writeFileSync(patch, git('diff', '--binary', 'main~1', 'ds-mig/L20-sync') + '\n');
  const r = checkPatch(dir, patch, 'main');
  assert.equal(r.lane, `${path.basename(dir)}-L20`);
  assert.deepEqual(r.absorbed, ['host/a.ts', 'host/new.ts']);
  assert.deepEqual(r.openCode, ['host/b.ts']);
  assert.deepEqual(r.divergedCode, ['host/c.ts']);
});

test('a branch fully contained in main is resettable; a missing branch is reported, not thrown', () => {
  const { dir, git } = repo();
  git('branch', 'ds-mig/F2-done', 'main');
  assert.equal(checkBranch(dir, 'ds-mig/F2-done', 'main').resettable, true);
  const gone = checkBranch(dir, 'ds-mig/nope', 'main');
  assert.equal(gone.resettable, false);
  assert.match(gone.error, /nope/);
});
