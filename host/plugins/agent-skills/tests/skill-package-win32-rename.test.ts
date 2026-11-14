/** W07 handoff (RF-W07-windows-rename-retry): the skill commit and rollback renames go through the paths
 * `renameSyncWithRetry`, so on Windows a directory briefly held by an indexer or antivirus (EPERM) is moved once
 * the holder lets go instead of failing the install. The fs double fails the next rename into or out of a held
 * path once with EPERM; off Windows that error still surfaces on the first attempt, like Rust.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { StagedSkillDirectory } from '../src/skill-package.ts';

const held = vi.hoisted(() => ({ paths: new Set<string>(), refusals: 0 }));
// The shared Host setup imports the public barrel before this file's fs mock is installed.
vi.hoisted(() => vi.resetModules());

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const renameSync = (from: import('node:fs').PathLike, to: import('node:fs').PathLike): void => {
    for (const target of [String(from), String(to)]) {
      if (held.paths.delete(target)) {
        held.refusals += 1;
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${String(from)}' -> '${String(to)}'`), { code: 'EPERM', syscall: 'rename' });
      }
    }
    real.renameSync(from, to);
  };
  return { ...real, renameSync, default: { ...real, renameSync } };
});

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const tempDirs: string[] = [];
function liveSkill(name: string): string {
  const root = mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'ds-skills-win32-rename-'));
  tempDirs.push(root);
  const live = path.join(root, name);
  mkdirSync(live);
  writeFileSync(path.join(live, 'SKILL.md'), 'old');
  return live;
}
function simulateWin32(): void { Object.defineProperty(process, 'platform', { ...realPlatform, value: 'win32' }); }

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  held.paths.clear();
  held.refusals = 0;
});
afterAll(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });

describe('RF-W07-windows-rename-retry in the skill commit (skills.rs commit / rollback renames)', () => {
  it('under simulated win32 an overwrite commit and its rollback succeed when the live directory is briefly held', () => {
    const live = liveSkill('held-skill');
    simulateWin32();
    const staged = StagedSkillDirectory.create(live, true, false);
    staged.writeFile('SKILL.md', Buffer.from('new'));
    held.paths.add(live);
    const committed = staged._commitInner(false, null, null);
    expect(readFileSync(path.join(live, 'SKILL.md'), 'utf8')).toBe('new');

    held.paths.add(live);
    committed.rollback();
    expect(readFileSync(path.join(live, 'SKILL.md'), 'utf8')).toBe('old');
    expect(readdirSync(path.dirname(live))).toEqual(['held-skill']);
    expect(held.refusals).toBe(2);
  });

  it('posix control: the same EPERM is not retried off Windows and the live skill is left as it was', () => {
    const live = liveSkill('posix-held-skill');
    const staged = StagedSkillDirectory.create(live, true, false);
    staged.writeFile('SKILL.md', Buffer.from('new'));
    held.paths.add(live);
    expect(() => staged._commitInner(false, null, null)).toThrow(/^Failed to move existing skill .* to rollback backup: EPERM/);
    expect(held.refusals).toBe(1);
    expect(readFileSync(path.join(live, 'SKILL.md'), 'utf8')).toBe('old');
    staged.dispose();
  });
});
