import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  CheckpointEngine,
  captureCheckpoint,
  createShadowWorktree,
  diffCheckpoints,
  diffWorkingTreeFromCheckpoint,
  isGitWorkingTree,
  removeShadowWorktree,
  revertToCheckpoint,
} from '../src/checkpoints.ts';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return fs.realpathSync.native(dir);
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    },
    encoding: 'utf8',
  });
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

describe('In-Place Checkpoint Engine (Git + Non-Git)', () => {
  it('captures dirty + untracked Git working trees via GIT_INDEX_FILE without touching .git/index or HEAD, diffs accurately, reverts cleanly, and protects post-turn human edits', async () => {
    const repoDir = await makeTempDir('dstu-ckpt-git-');
    runGit(repoDir, ['init']);

    // Committed baseline
    await fsp.mkdir(path.join(repoDir, 'src'), { recursive: true });
    await fsp.writeFile(path.join(repoDir, 'src/app.ts'), 'export const v = 1;\nexport const keep = true;\n');
    await fsp.writeFile(path.join(repoDir, 'src/staged.ts'), 'export const staged = "v1";\n');
    await fsp.writeFile(path.join(repoDir, 'src/remove-me.ts'), 'export const obsolete = true;\n');
    runGit(repoDir, ['add', '.']);
    runGit(repoDir, ['commit', '-m', 'initial commit']);

    // Stage one change in real `.git/index`, plus dirty unstaged edit + pre-existing untracked file
    await fsp.writeFile(path.join(repoDir, 'src/staged.ts'), 'export const staged = "v2-staged";\n');
    runGit(repoDir, ['add', 'src/staged.ts']);
    await fsp.writeFile(path.join(repoDir, 'src/app.ts'), 'export const v = 2; // dirty unstaged before agent\nexport const keep = true;\n');
    await fsp.writeFile(path.join(repoDir, 'notes-untracked.md'), '# Pre-existing untracked draft\n');

    const indexPath = path.join(repoDir, '.git/index');
    const indexHashBefore = sha256File(indexPath);
    const headBefore = runGit(repoDir, ['rev-parse', 'HEAD']).trim();
    const statusBefore = runGit(repoDir, ['status', '--porcelain']);
    const stashBefore = runGit(repoDir, ['stash', 'list']);

    expect(await isGitWorkingTree(repoDir)).toBe(true);

    // 1. Capture `before` checkpoint
    const beforeCp = await captureCheckpoint({
      rootPath: repoDir,
      chatSessionId: 'session:alpha/01',
      threadId: 'thread-codex-1',
      agentId: 'codex',
      turnSeq: 1,
      kind: 'before',
    });

    expect(beforeCp.backend).toBe('git');
    expect(beforeCp.ref).toBe('refs/dstu-checkpoints/session_alpha_01/1-before');
    expect(sha256File(indexPath)).toBe(indexHashBefore);
    expect(runGit(repoDir, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(runGit(repoDir, ['status', '--porcelain'])).toBe(statusBefore);
    expect(runGit(repoDir, ['stash', 'list'])).toBe(stashBefore);

    // Verify commit metadata stored in hidden ref
    const rawMeta = runGit(repoDir, ['log', '-1', '--format=%B', beforeCp.ref]).trim();
    const parsedMeta = JSON.parse(rawMeta) as Record<string, unknown>;
    expect(parsedMeta).toMatchObject({
      checkpointId: beforeCp.checkpointId,
      chatSessionId: 'session:alpha/01',
      threadId: 'thread-codex-1',
      agentId: 'codex',
      turnSeq: 1,
      kind: 'before',
    });

    // 2. Simulate coding agent turn (modifies dirty file, creates nested untracked file, deletes file)
    await fsp.writeFile(
      path.join(repoDir, 'src/app.ts'),
      'export const v = 3; // edited by codex\nexport const keep = true;\nexport const addedLine = 42;\n',
    );
    await fsp.mkdir(path.join(repoDir, 'src/generated'), { recursive: true });
    await fsp.writeFile(path.join(repoDir, 'src/generated/helper.ts'), 'export function helper() { return "ok"; }\n');
    await fsp.unlink(path.join(repoDir, 'src/remove-me.ts'));

    const liveDiff = await diffWorkingTreeFromCheckpoint(repoDir, beforeCp.ref);
    expect(liveDiff.files.map((f) => ({ path: f.path, status: f.status }))).toEqual([
      { path: 'src/app.ts', status: 'modified' },
      { path: 'src/generated/helper.ts', status: 'added' },
      { path: 'src/remove-me.ts', status: 'deleted' },
    ]);
    expect(liveDiff.totalAdditions).toBeGreaterThanOrEqual(3);
    expect(liveDiff.totalDeletions).toBeGreaterThanOrEqual(2);

    // Capture `after` checkpoint and confirm `.git/index` is still untouched
    const afterCp = await captureCheckpoint({
      rootPath: repoDir,
      chatSessionId: 'session:alpha/01',
      threadId: 'thread-codex-1',
      agentId: 'codex',
      turnSeq: 1,
      kind: 'after',
    });
    expect(sha256File(indexPath)).toBe(indexHashBefore);

    const turnDiff = await diffCheckpoints(repoDir, beforeCp.ref, afterCp.ref);
    expect(turnDiff.attributedAgentId).toBe('codex');
    expect(turnDiff.files).toHaveLength(3);
    for (const fileEntry of turnDiff.files) {
      expect(fileEntry.attributedAgentId).toBe('codex');
      expect(fileEntry.patch).toContain(fileEntry.path);
    }

    // 3. Simulate post-turn HUMAN edits!
    // Human manually tweaks `src/app.ts` AND creates a brand-new `human-todo.md`
    const humanAppContent = 'export const v = 999; // human manual override after turn!\nexport const keep = true;\n';
    await fsp.writeFile(path.join(repoDir, 'src/app.ts'), humanAppContent);
    await fsp.writeFile(path.join(repoDir, 'human-notes.md'), 'Keep my post-turn notes!\n');

    const safeRevert = await revertToCheckpoint(repoDir, beforeCp, {
      postTurnHashes: afterCp.fileHashes,
    });

    expect(safeRevert.complete).toBe(false);
    expect(safeRevert.skippedUserModifiedPaths).toEqual(['human-notes.md', 'src/app.ts']);
    expect(safeRevert.deletedPaths).toEqual(['src/generated/helper.ts']);
    expect(safeRevert.revertedPaths).toEqual(['src/remove-me.ts']);

    // Human edits survived untouched!
    expect(await fsp.readFile(path.join(repoDir, 'src/app.ts'), 'utf8')).toBe(humanAppContent);
    expect(await fsp.readFile(path.join(repoDir, 'human-notes.md'), 'utf8')).toBe('Keep my post-turn notes!\n');
    // Agent's untracked file & its empty directory were removed, and deleted file restored!
    expect(fs.existsSync(path.join(repoDir, 'src/generated/helper.ts'))).toBe(false);
    expect(fs.existsSync(path.join(repoDir, 'src/generated'))).toBe(false);
    expect(await fsp.readFile(path.join(repoDir, 'src/remove-me.ts'), 'utf8')).toBe('export const obsolete = true;\n');
    // Pre-existing untracked file & `.git/index` are still untouched!
    expect(await fsp.readFile(path.join(repoDir, 'notes-untracked.md'), 'utf8')).toBe('# Pre-existing untracked draft\n');
    expect(sha256File(indexPath)).toBe(indexHashBefore);

    // 4. Force overwrite when explicitly requested (`forceOverwriteUserEdits: true`)
    const forcedRevert = await revertToCheckpoint(repoDir, beforeCp, {
      postTurnHashes: afterCp.fileHashes,
      forceOverwriteUserEdits: true,
    });
    expect(forcedRevert.complete).toBe(true);
    expect(forcedRevert.skippedUserModifiedPaths).toEqual([]);
    expect(await fsp.readFile(path.join(repoDir, 'src/app.ts'), 'utf8')).toBe(
      'export const v = 2; // dirty unstaged before agent\nexport const keep = true;\n',
    );
    expect(fs.existsSync(path.join(repoDir, 'human-notes.md'))).toBe(false);
    // Verify `.git/index` was never touched by `revertToCheckpoint` before `git status` refreshes stat-cache
    expect(sha256File(indexPath)).toBe(indexHashBefore);
    expect(runGit(repoDir, ['--no-optional-locks', 'status', '--porcelain'])).toBe(statusBefore);
    expect(sha256File(indexPath)).toBe(indexHashBefore);
  });

  it('supports fresh git init repositories with unborn HEAD plus opt-in shadow worktrees', async () => {
    const repoDir = await makeTempDir('dstu-ckpt-unborn-');
    runGit(repoDir, ['init']);
    await fsp.writeFile(path.join(repoDir, 'hello.txt'), 'uncommitted initial file\n');

    const cp = await captureCheckpoint({
      rootPath: repoDir,
      chatSessionId: 'sess-unborn',
      agentId: 'claude',
      turnSeq: 1,
      kind: 'before',
    });
    expect(cp.backend).toBe('git');
    expect(cp.commitSha).toMatch(/^[0-9a-f]{40}$/);

    // Opt-in race mode shadow worktree includes dirty/untracked state without creating branches
    const shadow = await createShadowWorktree(repoDir, 'race-claude');
    expect(shadow.kind).toBe('git-worktree');
    expect(await fsp.readFile(path.join(shadow.worktreePath, 'hello.txt'), 'utf8')).toBe('uncommitted initial file\n');
    await fsp.writeFile(path.join(shadow.worktreePath, 'hello.txt'), 'shadow isolated edit\n');
    // Primary workspace unaffected
    expect(await fsp.readFile(path.join(repoDir, 'hello.txt'), 'utf8')).toBe('uncommitted initial file\n');

    await removeShadowWorktree(repoDir, shadow);
    expect(fs.existsSync(shadow.worktreePath)).toBe(false);
  });

  it('falls back seamlessly to SHA-256 content-addressed snapshots for non-Git directories while ignoring node_modules/dist/target/.DS_Store and protecting human edits', async () => {
    const plainDir = await makeTempDir('dstu-ckpt-nongit-');
    const storageDir = await makeTempDir('dstu-ckpt-store-');
    const engine = new CheckpointEngine({ storageDir });

    expect(await isGitWorkingTree(plainDir)).toBe(false);

    await fsp.mkdir(path.join(plainDir, 'src'), { recursive: true });
    await fsp.mkdir(path.join(plainDir, 'node_modules/pkg'), { recursive: true });
    await fsp.mkdir(path.join(plainDir, 'dist'), { recursive: true });
    await fsp.writeFile(path.join(plainDir, 'src/calc.ts'), 'export const add = (a: number, b: number) => a + b;\n');
    await fsp.writeFile(path.join(plainDir, 'src/old-name.ts'), 'export const constantValue = 12345;\n');
    await fsp.writeFile(path.join(plainDir, 'node_modules/pkg/index.js'), 'module.exports = 1;\n');
    await fsp.writeFile(path.join(plainDir, 'dist/bundle.js'), 'bundled();\n');
    await fsp.writeFile(path.join(plainDir, '.DS_Store'), 'macos-meta');

    const beforeCp = await engine.capture({
      rootPath: plainDir,
      chatSessionId: 'student-hw',
      threadId: 't-1',
      agentId: 'claude',
      turnSeq: 1,
      kind: 'before',
    });

    expect(beforeCp.backend).toBe('filesystem');
    expect(Object.keys(beforeCp.fileHashes).sort()).toEqual(['src/calc.ts', 'src/old-name.ts']);

    // Agent modifies `src/calc.ts`, renames `src/old-name.ts` -> `src/new-name.ts`, and adds `src/sub.ts`
    await fsp.writeFile(
      path.join(plainDir, 'src/calc.ts'),
      'export const add = (a: number, b: number) => a + b;\nexport const mul = (a: number, b: number) => a * b;\n',
    );
    await fsp.rename(path.join(plainDir, 'src/old-name.ts'), path.join(plainDir, 'src/new-name.ts'));
    await fsp.writeFile(path.join(plainDir, 'src/sub.ts'), 'export const sub = (a: number, b: number) => a - b;\n');
    // Ignored dir mutation should never pollute diffs or revert
    await fsp.writeFile(path.join(plainDir, 'dist/bundle.js'), 'rebuilt();\n');

    const afterCp = await engine.capture({
      rootPath: plainDir,
      chatSessionId: 'student-hw',
      threadId: 't-1',
      agentId: 'claude',
      turnSeq: 1,
      kind: 'after',
    });

    const diff = await engine.diff(plainDir, beforeCp.ref, afterCp.ref);
    expect(diff.backend).toBe('filesystem');
    expect(diff.attributedAgentId).toBe('claude');
    expect(diff.files.map((f) => ({ path: f.path, oldPath: f.oldPath, status: f.status }))).toEqual([
      { path: 'src/calc.ts', oldPath: undefined, status: 'modified' },
      { path: 'src/new-name.ts', oldPath: 'src/old-name.ts', status: 'renamed' },
      { path: 'src/sub.ts', oldPath: undefined, status: 'added' },
    ]);
    expect(diff.totalAdditions).toBe(2);
    expect(diff.totalDeletions).toBe(0);

    // Human edits `src/sub.ts` after the turn
    await fsp.writeFile(path.join(plainDir, 'src/sub.ts'), '// student customized this file\n');

    const revertRes = await engine.revert(plainDir, beforeCp.ref, {
      postTurnHashes: afterCp.fileHashes,
    });
    expect(revertRes.complete).toBe(false);
    expect(revertRes.skippedUserModifiedPaths).toEqual(['src/sub.ts']);
    expect(await fsp.readFile(path.join(plainDir, 'src/calc.ts'), 'utf8')).toBe(
      'export const add = (a: number, b: number) => a + b;\n',
    );
    expect(await fsp.readFile(path.join(plainDir, 'src/old-name.ts'), 'utf8')).toBe(
      'export const constantValue = 12345;\n',
    );
    expect(fs.existsSync(path.join(plainDir, 'src/new-name.ts'))).toBe(false);
    expect(await fsp.readFile(path.join(plainDir, 'src/sub.ts'), 'utf8')).toBe('// student customized this file\n');
    expect(await fsp.readFile(path.join(plainDir, 'dist/bundle.js'), 'utf8')).toBe('rebuilt();\n');
  });
});
