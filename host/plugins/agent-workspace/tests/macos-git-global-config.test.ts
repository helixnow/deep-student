import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MacOsSandboxBackend, gitGlobalConfigReadRules, sandboxPolicy } from '../src/tools/shell-sandbox.ts';

const temps: string[] = [];
function fakeHome(): string {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 's01-git-home-')));
  temps.push(home);
  return home;
}
afterEach(() => { vi.unstubAllEnvs(); for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('RF-S01-macos-git-global-config-denied', () => {
  it('RF-S01-macos-git-global-config-denied: only existing global git config files become read literals', () => {
    const home = fakeHome();
    expect(gitGlobalConfigReadRules(home, undefined)).toEqual([]);
    fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = S01\n');
    fs.mkdirSync(path.join(home, '.config', 'git'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'git', 'config'), '');
    fs.mkdirSync(path.join(home, '.config', 'git', 'credentials'));
    expect(gitGlobalConfigReadRules(home, path.join(home, '.config'))).toEqual([
      `(allow file-read* (literal "${path.join(home, '.gitconfig')}"))`,
      `(allow file-read* (literal "${path.join(home, '.config', 'git', 'config')}"))`,
    ]);
    expect(gitGlobalConfigReadRules(home, 'relative/xdg')).toHaveLength(2);
    expect(gitGlobalConfigReadRules('', undefined)).toEqual([]);
  });

  it.skipIf(process.platform !== 'darwin')(
    'RF-S01-macos-git-global-config-denied: git reads the global config under the Git profile; general shell stays denied',
    () => {
      const home = fakeHome();
      vi.stubEnv('HOME', home);
      fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = S01 Global\n');
      fs.writeFileSync(path.join(home, 'secret.txt'), 'secret');
      fs.mkdirSync(path.join(home, '.config'));
      const work = path.join(home, 'work');
      fs.mkdirSync(work);
      const developerDir = spawnSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8' }).stdout.trim();
      const policy = sandboxPolicy({ readable_roots: developerDir === '' ? [] : [developerDir], writable_roots: [work],
        protected_read_roots: [path.join(home, '.config')] });
      const backend = new MacOsSandboxBackend(home);
      const execute = (git: boolean, command: string) => {
        const spec = git ? backend.commandForGit(command, work, policy) : backend.command(command, work, policy);
        try {
          return spawnSync(spec.program, spec.args, { cwd: spec.cwd, encoding: 'utf8',
            env: { PATH: '/usr/bin:/bin', HOME: home } });
        } finally { backend.cleanupCommandResources(spec); }
      };
      // Rust (and the general shell profile) deny the read; git turns that EPERM into a fatal error.
      const rust = execute(false, 'git config --global --get user.name');
      expect(rust.status).not.toBe(0);
      expect(rust.stderr).toContain(`fatal: unable to access '${path.join(home, '.gitconfig')}': Operation not permitted`);
      const fixed = execute(true, 'git config --global --get user.name');
      expect(fixed.stderr).not.toContain('fatal');
      expect(fixed.stdout).toBe('S01 Global\n');
      expect(execute(true, 'cat "$HOME/secret.txt"').status).not.toBe(0);
    });
});
