/**
 * 打包版忽略开发用启动环境变量（SEC-E02，`electron/shell/launch-env.ts`）。真实打包产物上的行为由
 * `electron/scripts/__tests__/packaged-smoke.mjs` 的 “SEC-E02” 一项验证。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEV_ONLY_ENV, dropDevOnlyEnv, PACKAGED_ISOLATION_ENV } from '../shell/launch-env.ts';
import { hostPathEnv } from '../shell/os-dirs.ts';
import { SAFE_MODE_ENV } from '../shell/safe-mode.ts';

const repoRoot = join(import.meta.dirname, '..', '..');

describe('dropDevOnlyEnv', () => {
  it('a packaged build deletes every development override and keeps data isolation and unrelated variables', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', DS_APP_DATA_DIR: '/iso/data', DS_ELECTRON_USER_DATA: '/iso/userdata' };
    for (const name of DEV_ONLY_ENV) env[name] = `/evil/${name}`;
    expect(dropDevOnlyEnv(env, true)).toEqual([...DEV_ONLY_ENV]);
    expect(env).toEqual({ PATH: '/usr/bin', DS_APP_DATA_DIR: '/iso/data', DS_ELECTRON_USER_DATA: '/iso/userdata' });
    expect(dropDevOnlyEnv({ DS_HOST_ENTRY: '' }, true)).toEqual(['DS_HOST_ENTRY']);
  });

  it('development runs keep everything', () => {
    const env: NodeJS.ProcessEnv = { DS_HOST_ENTRY: '/fixture/host.ts', DS_ELECTRON_DEV_URL: 'http://127.0.0.1:1/' };
    expect(dropDevOnlyEnv(env, false)).toEqual([]);
    expect(env).toEqual({ DS_HOST_ENTRY: '/fixture/host.ts', DS_ELECTRON_DEV_URL: 'http://127.0.0.1:1/' });
  });
});

const SKIP_DIRS = new Set(['node_modules', 'tests', '__tests__', '__fixtures__', 'fixtures', 'equivalence', 'e2e', '.build', 'scripts', 'wp280']);

/** 随包源码里按字面名读取的 `DS_*` 环境变量（`env.DS_X` / `env['DS_X']`）。 */
function shippedDsEnvReads(): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(file);
        continue;
      }
      if (!/\.(ts|mts|cts|mjs|cjs|js)$/.test(entry.name) || /\.test\.|\.d\.ts$|\.config\.cjs$/.test(entry.name)) continue;
      for (const match of readFileSync(file, 'utf8').matchAll(/\benv(?:\.(DS_[A-Z0-9_]+)|\[\s*['"](DS_[A-Z0-9_]+)['"]\s*\])/g)) {
        const name = (match[1] ?? match[2])!;
        if (!found.has(name)) found.set(name, relative(repoRoot, file));
      }
    }
  };
  walk(join(repoRoot, 'electron'));
  walk(join(repoRoot, 'host'));
  return found;
}

describe('launch environment inventory', () => {
  it('every DS_* variable read by shipped code is dropped, kept for data isolation, or overwritten by main before the Host forks', () => {
    // `start()` sets DS_SAFE_MODE for a safe-mode launch and deletes any inherited value otherwise (electron/main.ts).
    const writtenByMain = new Set([...Object.keys(hostPathEnv({} as never, 'id')), 'DS_MIGRATIONS_DIR', SAFE_MODE_ENV]);
    const classified = new Set<string>([...DEV_ONLY_ENV, ...PACKAGED_ISOLATION_ENV, ...writtenByMain]);
    const reads = shippedDsEnvReads();
    for (const name of ['DS_HOST_ENTRY', 'DS_HOST_PROFILE', 'DS_ELECTRON_DEV_URL', 'DS_APP_DATA_DIR', 'DS_MIGRATIONS_DIR']) expect(reads.has(name), name).toBe(true);
    expect([...reads].filter(([name]) => !classified.has(name)).map(([name, file]) => `${name} (${file})`)).toEqual([]);
    expect(DEV_ONLY_ENV.filter((name) => (PACKAGED_ISOLATION_ENV as readonly string[]).includes(name))).toEqual([]);
  });

  it('main drops the development variables before it reads any of them', () => {
    const main = readFileSync(join(repoRoot, 'electron', 'main.ts'), 'utf8');
    const body = main.slice(main.indexOf('\nimport ') === -1 ? 0 : main.lastIndexOf('\nimport '));
    const drop = body.indexOf('dropDevOnlyEnv(process.env, app.isPackaged)');
    expect(drop).toBeGreaterThan(0);
    const firstRead = body.search(/process\.env\.DS_|process\.env\[/);
    expect(firstRead).toBeGreaterThan(drop);
  });
});
