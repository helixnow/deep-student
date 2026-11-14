import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILD_BASELINE, TEST_BUILD_NUMBER, baselineAvailable, testBuildNumberEnv } from './test-build-number.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'w09-build-number-'));
  roots.push(dir);
  return dir;
};

describe('test build number fallback', () => {
  it('baseline constant stays in sync with electron/build-info.ts', () => {
    const source = readFileSync(path.join(import.meta.dirname, '../../../electron/build-info.ts'), 'utf8');
    expect(source).toContain(`const baseline = '${BUILD_BASELINE}'`);
  });

  it('snapshot without git history gets the test default', () => {
    const root = temp();
    expect(baselineAvailable(root)).toBe(false);
    expect(testBuildNumberEnv(root, { env: {} })).toEqual({ DEEP_STUDENT_BUILD_NUMBER: TEST_BUILD_NUMBER });
  });

  it('shallow history that lacks the baseline commit gets the test default', () => {
    const root = temp();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-q');
    writeFileSync(path.join(root, 'a.txt'), 'a');
    git('add', 'a.txt');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'snapshot');
    expect(baselineAvailable(root)).toBe(false);
    expect(testBuildNumberEnv(root, { env: {} })).toEqual({ DEEP_STUDENT_BUILD_NUMBER: TEST_BUILD_NUMBER });
  });

  it('explicit override, bundled version.json, or a reachable baseline keep production semantics', () => {
    const root = temp();
    expect(testBuildNumberEnv(root, { env: { DEEP_STUDENT_BUILD_NUMBER: '15000' } })).toEqual({});
    expect(testBuildNumberEnv(root, { env: {}, hasBaseline: () => true })).toEqual({});
    mkdirSync(path.join(root, 'electron', '.build'), { recursive: true });
    writeFileSync(path.join(root, 'electron', '.build', 'version.json'), '{}');
    expect(testBuildNumberEnv(root, { env: {}, hasBaseline: () => false })).toEqual({});
  });

  it('default is a valid build number under build.rs rules', () => {
    const n = Number(TEST_BUILD_NUMBER);
    expect(Number.isInteger(n) && n > 14638 && n <= 2_100_000_000).toBe(true);
  });
});
