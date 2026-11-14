/** V10-P1-2: skills.rs:1556 `sync_directory` is a no-op off unix. On Windows libuv opens a directory handle,
 * but FlushFileBuffers on it fails with EPERM, so a directory fsync there aborts every skill commit.
 * The fs double reproduces that failure whenever `process.platform` reads win32.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { StagedSkillDirectory } from '../src/skill-package.ts';

const calls = vi.hoisted(() => ({ directoryOpens: 0, directorySyncs: 0 }));
// The shared Host setup imports the public barrel before this file's fs mock is installed.
vi.hoisted(() => vi.resetModules());

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const directories = new Set<number>();
  return {
    ...real,
    openSync: (...args: Parameters<typeof real.openSync>) => {
      const fd = real.openSync(...args);
      if (real.fstatSync(fd).isDirectory()) { calls.directoryOpens += 1; directories.add(fd); }
      return fd;
    },
    fsyncSync: (fd: number) => {
      if (directories.has(fd)) {
        calls.directorySyncs += 1;
        if (process.platform === 'win32') {
          throw Object.assign(new Error('EPERM: operation not permitted, fsync'), { code: 'EPERM', syscall: 'fsync' });
        }
      }
      real.fsyncSync(fd);
    },
    closeSync: (fd: number) => { directories.delete(fd); real.closeSync(fd); },
  };
});

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const tempDirs: string[] = [];
function liveSkill(name: string): string {
  const root = mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'ds-skills-win32-'));
  tempDirs.push(root);
  const live = path.join(root, name);
  mkdirSync(live);
  writeFileSync(path.join(live, 'SKILL.md'), 'old');
  return live;
}
function simulateWin32(): void { Object.defineProperty(process, 'platform', { ...realPlatform, value: 'win32' }); }

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  calls.directoryOpens = 0;
  calls.directorySyncs = 0;
});
afterAll(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });

describe('skills.rs:1556 sync_directory off unix', () => {
  it('posix control: commit fsyncs the staged tree and the skills base directory', () => {
    const live = liveSkill('posix-skill');
    const staged = StagedSkillDirectory.create(live, true, false);
    staged.writeFile('docs/guide.md', Buffer.from('guide'));
    staged.writeFile('SKILL.md', Buffer.from('new'));
    staged.commit().finalize();
    expect(readFileSync(path.join(live, 'SKILL.md'), 'utf8')).toBe('new');
    expect(calls.directoryOpens).toBeGreaterThan(0);
    expect(calls.directorySyncs).toBe(calls.directoryOpens);
  });

  it('under simulated win32 no directory is opened or fsynced', () => {
    const live = liveSkill('win32-no-dir-fsync');
    const staged = StagedSkillDirectory.create(live, true, false);
    staged.writeFile('docs/guide.md', Buffer.from('guide'));
    staged.writeFile('SKILL.md', Buffer.from('new'));
    simulateWin32();
    try { staged.commit().finalize(); }
    finally { Object.defineProperty(process, 'platform', realPlatform); }
    expect(calls.directoryOpens).toBe(0);
    expect(calls.directorySyncs).toBe(0);
  });

  it('under simulated win32 _commitInner publishes, rolls back and finalizes', () => {
    const live = liveSkill('win32-commit');
    writeFileSync(path.join(live, 'old-only.md'), 'keep on rollback');
    simulateWin32();

    const first = StagedSkillDirectory.create(live, true, false);
    first.writeFile('SKILL.md', Buffer.from('new'));
    first.writeFile('AGENT_INSTALLED.json', Buffer.from('{}'));
    const committed = first._commitInner(false, null, null);
    expect(readFileSync(path.join(live, 'SKILL.md'), 'utf8')).toBe('new');
    committed.rollback();
    expect(readFileSync(path.join(live, 'SKILL.md'), 'utf8')).toBe('old');
    expect(readdirSync(live).sort()).toEqual(['SKILL.md', 'old-only.md']);

    const second = StagedSkillDirectory.create(live, true, true);
    second.writeFile('SKILL.md', Buffer.from('final'));
    second._commitInner(false, null, null).finalize();
    expect(readFileSync(path.join(live, 'SKILL.md'), 'utf8')).toBe('final');
    expect(readdirSync(path.dirname(live))).toEqual(['win32-commit']);
    expect(calls.directorySyncs).toBe(0);
  });
});
