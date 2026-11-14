import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gateChecks } from './gate-checks.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repoWithChange(file: string): { cwd: string; base: string } {
  const cwd = mkdtempSync(path.join(tmpdir(), 'w09-gate-checks-'));
  roots.push(cwd);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(path.join(cwd, 'README'), 'x');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  writeFileSync(path.join(cwd, file), 'export {};\n');
  git('add', '.');
  git('commit', '-qm', 'change');
  return { cwd, base };
}

describe('gateChecks frontend-invoke wiring', () => {
  it('runs the frontend invoke contract gate when contracts change (full and quick modes)', () => {
    const { cwd, base } = repoWithChange('contracts/ipc/F1-kernel.json');
    for (const quick of [false, true]) {
      const check = gateChecks(cwd, base, { quick }).find((c: { name: string }) => c.name === 'frontend-invoke');
      expect(check?.args).toEqual(['scripts/electron-migration/gate-checks/frontend-invoke.mjs', '--check']);
    }
  });

  it('is skipped when neither src/ nor contracts nor the gate itself changed', () => {
    const { cwd, base } = repoWithChange('host/plugins/x/index.ts');
    expect(gateChecks(cwd, base).map((c: { name: string }) => c.name)).not.toContain('frontend-invoke');
  });
});

describe('gateChecks agent-tool-coverage wiring', () => {
  it('runs the host coverage test when skill schemas, executors or the profile change', () => {
    for (const file of ['src/features/chat/skills/builtin-tools/x.ts', 'host/plugins/x/index.ts', 'host/kernel/profile.ts', 'host/profiles/desktop.json', 'host/e2e/coverage/agent-tool-coverage-baseline.json']) {
      const { cwd, base } = repoWithChange(file);
      for (const quick of [false, true]) {
        const check = gateChecks(cwd, base, { quick }).find((c: { name: string }) => c.name === 'agent-tool-coverage');
        expect(check?.args, `${file} quick=${quick}`).toEqual(['vitest', 'run', '-c', 'vitest.host.config.ts', 'host/e2e/coverage/']);
      }
    }
  });

  it('is skipped for unrelated frontend changes', () => {
    const { cwd, base } = repoWithChange('src/components/a.tsx');
    expect(gateChecks(cwd, base).map((c: { name: string }) => c.name)).not.toContain('agent-tool-coverage');
  });
});

describe('gateChecks event-emit wiring', () => {
  it('runs when listeners (src/) or emitters (host/, electron/) change, in full and quick modes', () => {
    for (const file of ['src/a.ts', 'host/plugins/x/index.ts', 'electron/main.ts', 'scripts/electron-migration/gate-checks/event-emit-baseline.json']) {
      const { cwd, base } = repoWithChange(file);
      for (const quick of [false, true]) {
        const check = gateChecks(cwd, base, { quick }).find((c: { name: string }) => c.name === 'event-emit');
        expect(check?.args, `${file} quick=${quick}`).toEqual(['scripts/electron-migration/gate-checks/event-emit.mjs', '--check']);
      }
    }
  });

  it('is skipped for unrelated changes', () => {
    const { cwd, base } = repoWithChange('migration/notes.md');
    expect(gateChecks(cwd, base).map((c: { name: string }) => c.name)).not.toContain('event-emit');
  });
});

describe('gateChecks import-cycles wiring', () => {
  it('runs on any host change (the api.ts closure reaches platform and kernel) or gate edit, in full and quick modes', () => {
    for (const file of ['host/plugins/x/index.ts', 'host/platform/storage/a.ts', 'host/kernel/runtime.ts', 'scripts/electron-migration/gate-checks/import-cycles-baseline.json']) {
      const { cwd, base } = repoWithChange(file);
      for (const quick of [false, true]) {
        const check = gateChecks(cwd, base, { quick }).find((c: { name: string }) => c.name === 'import-cycles');
        expect(check?.args, `${file} quick=${quick}`).toEqual(['scripts/electron-migration/gate-checks/import-cycles.mjs', '--check']);
      }
    }
  });

  it('is skipped for frontend-only changes', () => {
    const { cwd, base } = repoWithChange('src/a.ts');
    expect(gateChecks(cwd, base).map((c: { name: string }) => c.name)).not.toContain('import-cycles');
  });
});

describe('gateChecks plugin-manifest wiring', () => {
  it('runs when plugin packages, the contract, the app version or the gate change, in full and quick modes', () => {
    for (const file of ['host/plugins/x/package.json', 'src/ui-plugins/official/x/package.json', 'examples/plugins/x/package.json', 'contracts/plugin-manifest/v1.schema.json', 'package.json', 'scripts/electron-migration/gate-checks/plugin-manifest-baseline.json']) {
      const { cwd, base } = repoWithChange(file);
      for (const quick of [false, true]) {
        const check = gateChecks(cwd, base, { quick }).find((c: { name: string }) => c.name === 'plugin-manifest');
        expect(check?.args, `${file} quick=${quick}`).toEqual(['scripts/electron-migration/gate-checks/plugin-manifest.mjs', '--check']);
      }
    }
  });

  it('is skipped for unrelated changes', () => {
    for (const file of ['src/features/a.ts', 'electron/main.ts', 'examples/README.md', 'contracts/ipc/x.json']) {
      const { cwd, base } = repoWithChange(file);
      expect(gateChecks(cwd, base).map((c: { name: string }) => c.name), file).not.toContain('plugin-manifest');
    }
  });
});

describe('gateChecks ui-boundaries (FE-A4) wiring', () => {
  it('runs on any frontend change or gate edit, in full and quick modes', () => {
    for (const file of ['src/a.ts', 'scripts/electron-migration/gate-checks/ui-boundaries-baseline.json']) {
      const { cwd, base } = repoWithChange(file);
      for (const quick of [false, true]) {
        const check = gateChecks(cwd, base, { quick }).find((c: { name: string }) => c.name === 'ui-boundaries');
        expect(check?.args, `${file} quick=${quick}`).toEqual(['scripts/electron-migration/gate-checks/ui-boundaries.mjs', '--check']);
      }
    }
  });

  it('is skipped for host-only changes', () => {
    const { cwd, base } = repoWithChange('host/plugins/x/index.ts');
    expect(gateChecks(cwd, base).map((c: { name: string }) => c.name)).not.toContain('ui-boundaries');
  });
});

describe('gateChecks hardcoded-copy (§8 D5) wiring', () => {
  it('runs on any frontend change or gate edit, in full and quick modes', () => {
    for (const file of ['src/a.tsx', 'scripts/electron-migration/gate-checks/hardcoded-copy-baseline.json']) {
      const { cwd, base } = repoWithChange(file);
      for (const quick of [false, true]) {
        const check = gateChecks(cwd, base, { quick }).find((c: { name: string }) => c.name === 'hardcoded-copy');
        expect(check?.args, `${file} quick=${quick}`).toEqual(['scripts/electron-migration/gate-checks/hardcoded-copy.mjs', '--check']);
      }
    }
  });

  it('is skipped for host-only changes', () => {
    const { cwd, base } = repoWithChange('host/plugins/x/index.ts');
    expect(gateChecks(cwd, base).map((c: { name: string }) => c.name)).not.toContain('hardcoded-copy');
  });
});

describe('gateChecks portability (W14 scanner) wiring', () => {
  const withScanner = (file: string, extra: string[] = []) => {
    const { cwd, base } = repoWithChange(file);
    for (const f of extra) {
      mkdirSync(path.dirname(path.join(cwd, f)), { recursive: true });
      writeFileSync(path.join(cwd, f), '{}\n');
    }
    return { cwd, base };
  };
  const names = (cwd: string, base: string, quick = false) => gateChecks(cwd, base, { quick }).filter((c: { name: string }) => c.name.startsWith('portability'));

  const wrapper = (base: string, scanner = 'scripts/portability/scan.mjs', profile = 'host/profiles/mobile.json') =>
    ['scripts/electron-migration/gate-checks/portability.mjs', '--base', base, '--scanner', scanner, '--profile', profile];

  it('runs the base-relative --check + mobile profile wrapper on any host change (closures reach platform/kernel)', () => {
    for (const file of ['host/plugins/x/index.ts', 'host/profiles/mobile.json', 'host/platform/util/zip.ts', 'host/kernel/runtime.ts', 'scripts/portability/lib/portability.mjs', 'scripts/electron-migration/gate-checks/portability.mjs']) {
      const { cwd, base } = withScanner(file, ['scripts/portability/scan.mjs', 'host/profiles/mobile.json']);
      for (const quick of [false, true]) {
        expect(names(cwd, base, quick).map((c: { args: string[] }) => c.args), `${file} quick=${quick}`).toEqual([wrapper(base)]);
      }
    }
  });

  it('scanner and profile paths are configurable; a missing scanner is skipped', () => {
    const { cwd, base } = withScanner('host/plugins/x/index.ts', ['tools/scan.mjs', 'profiles/m.json']);
    expect(names(cwd, base)).toEqual([]);
    process.env.DSTU_PORTABILITY_SCANNER = 'tools/scan.mjs';
    process.env.DSTU_PORTABILITY_PROFILE = 'profiles/m.json';
    try {
      expect(names(cwd, base).map((c: { args: string[] }) => c.args)).toEqual([wrapper(base, 'tools/scan.mjs', 'profiles/m.json')]);
    } finally {
      delete process.env.DSTU_PORTABILITY_SCANNER;
      delete process.env.DSTU_PORTABILITY_PROFILE;
    }
  });

  it('is skipped for frontend-only changes', () => {
    const { cwd, base } = withScanner('src/a.ts', ['scripts/portability/scan.mjs', 'host/profiles/mobile.json']);
    expect(names(cwd, base)).toEqual([]);
  });
});
