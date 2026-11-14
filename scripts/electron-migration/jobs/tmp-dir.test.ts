import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasHiddenComponent, jobTmpDir, jobTmpRoot } from './tmp-dir.mjs';

// electron/file-ops.ts denyHiddenLocalPath（Rust deny_hidden_local_path）拒绝含隐藏段的路径；
// 作业的 TMPDIR 一旦落在 ~/.oc-jobs 下，os.tmpdir() 派生的测试夹具就会被产品代码拒绝。
describe('job TMPDIR', () => {
  it('server default ~/.oc-jobs maps to a sibling without hidden components', () => {
    const root = jobTmpRoot({ jobsDir: '/home/dsdev/.oc-jobs', env: {} });
    expect(root).toBe('/home/dsdev/oc-jobs-tmp');
    const dir = jobTmpDir('20261107010101-abcdef', { jobsDir: '/home/dsdev/.oc-jobs', env: {} });
    expect(dir).toBe('/home/dsdev/oc-jobs-tmp/20261107010101-abcdef');
    expect(hasHiddenComponent(dir)).toBe(false);
  });

  it('non-hidden jobs dir keeps a sibling "-tmp" root', () => {
    expect(jobTmpRoot({ jobsDir: '/srv/jobs', env: {} })).toBe('/srv/jobs-tmp');
  });

  it('falls back to the OS temp dir when the sibling would still be hidden', () => {
    const root = jobTmpRoot({ jobsDir: '/home/u/.cache/jobs', env: {}, osTmpdir: '/tmp', user: 'u' });
    expect(root).toBe('/tmp/oc-jobs-tmp-u');
    expect(hasHiddenComponent(root)).toBe(false);
  });

  it('OC_JOBS_TMP_DIR overrides the default and must itself be free of hidden components', () => {
    expect(jobTmpRoot({ jobsDir: '/home/dsdev/.oc-jobs', env: { OC_JOBS_TMP_DIR: '/data/jobs-tmp' } })).toBe('/data/jobs-tmp');
    expect(() => jobTmpRoot({ jobsDir: '/x', env: { OC_JOBS_TMP_DIR: '/home/dsdev/.tmp' } })).toThrow(/OC_JOBS_TMP_DIR/);
    expect(() => jobTmpRoot({ jobsDir: '/x', env: { OC_JOBS_TMP_DIR: 'relative/tmp' } })).toThrow(/absolute/);
  });

  it('throws instead of silently handing jobs a hidden TMPDIR', () => {
    expect(() => jobTmpRoot({ jobsDir: '/home/u/.cache/jobs', env: {}, osTmpdir: '/home/u/.tmp', user: 'u' })).toThrow(/OC_JOBS_TMP_DIR/);
  });

  it('job ids cannot escape the tmp root', () => {
    expect(() => jobTmpDir('../x', { jobsDir: '/srv/jobs', env: {} })).toThrow(/job id/);
    expect(() => jobTmpDir('.hidden', { jobsDir: '/srv/jobs', env: {} })).toThrow(/job id/);
  });

  it('hidden component rule matches the product rule (ignores "." and "..", splits on separators)', () => {
    expect(hasHiddenComponent('/home/dsdev/.oc-jobs/tmp/x')).toBe(true);
    expect(hasHiddenComponent('/a/./b/../c')).toBe(false);
    expect(hasHiddenComponent('/a/b.c/d')).toBe(false);
  });

  it('product hidden-path check rejects the old ~/.oc-jobs/tmp location and accepts the new one', async () => {
    const { denyHiddenLocalPath } = await import('../../../electron/file-ops.ts');
    const deps = { platform: process.platform === 'win32' ? 'windows' : 'linux', appDirs: async () => [] } as never;
    await expect(denyHiddenLocalPath('/home/dsdev/.oc-jobs/tmp/job/dstu-f2-out-x/a.txt', deps)).rejects.toThrow(/隐藏路径/);
    const fresh = jobTmpDir('job', { jobsDir: '/home/dsdev/.oc-jobs', env: {} });
    await expect(denyHiddenLocalPath(path.join(fresh, 'dstu-f2-out-x', 'a.txt'), deps)).resolves.toBeUndefined();
  });

  it('runner.mjs derives TMPDIR from jobTmpDir, not from the hidden jobs dir', () => {
    const runner = readFileSync(path.join(import.meta.dirname, 'runner.mjs'), 'utf8');
    expect(runner).not.toMatch(/path\.join\(JOBS,\s*'tmp'/);
    expect(runner).toMatch(/jobTmpDir\(job\.id/);
  });
});
