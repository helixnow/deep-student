/**
 * scripts/compare-vitest-results.mjs 的行为契约（内存 vitest JSON 报告）。
 */
import { describe, expect, it } from 'vitest';

import {
  applyRenames,
  commonDir,
  compareRuns,
  detectRoot,
  groupMissingByFile,
  normalizeRun,
  parseRenames,
  relativize,
  // @ts-expect-error 脚本为无类型声明的 .mjs（与 CLI 共用同一实现）
} from '../../../scripts/compare-vitest-results.mjs';

type T = [string, string];
const report = (root: string, suites: Record<string, Array<T>>) => ({
  testResults: Object.entries(suites).map(([file, tests]) => ({
    name: `${root}/${file}`,
    status: tests.some(([, s]) => s === 'failed') ? 'failed' : 'passed',
    assertionResults: tests.map(([fullName, status]) => ({ fullName, status, title: fullName, ancestorTitles: [] })),
  })),
});

describe('path normalization', () => {
  it('finds the common dir and repo root across Windows and posix paths', () => {
    const files = ['C:\\w\\a\\src\\x.test.ts', 'C:/w/a/tests/vitest/y.test.ts'];
    expect(commonDir(files)).toBe('C:/w/a');
    expect(detectRoot(files, (p: string) => p === 'C:/w/a/package.json')).toBe('C:/w/a');
    // 根已不存在：退回到第一个 src/tests 段之前
    expect(detectRoot(['D:/gone/tests/vitest/a.test.ts', 'D:/gone/tests/vitest/b/c.test.ts'], () => false)).toBe('D:/gone');
  });

  it('relativizes with case-insensitive drive letters only', () => {
    expect(relativize('d:\\wt\\src\\a.test.ts', 'D:/wt')).toBe('src/a.test.ts');
    expect(relativize('D:/WT/src/a.test.ts', 'D:/wt')).toBe('D:/WT/src/a.test.ts');
    expect(relativize('./src/a.test.ts', null)).toBe('src/a.test.ts');
  });
});

describe('renames', () => {
  it('parses CLI pairs and JSON (object or array), supports directory prefixes', () => {
    const renames = parseRenames(['src/old/=src/new/'], [{ 'tests/a.test.ts': 'tests/b.test.ts' }, [{ from: 'x', to: 'y' }]]);
    expect(applyRenames('src/old/deep/a.test.ts', renames)).toBe('src/new/deep/a.test.ts');
    expect(applyRenames('tests/a.test.ts', renames)).toBe('tests/b.test.ts');
    expect(applyRenames('x', renames)).toBe('y');
    expect(applyRenames('src/other.test.ts', renames)).toBe('src/other.test.ts');
    expect(() => parseRenames(['nope'])).toThrow();
  });
});

describe('compareRuns', () => {
  const base = report('C:/wt/base', {
    'src/a.test.ts': [['A ok', 'passed'], ['A breaks', 'passed'], ['A skipped later', 'passed'], ['A dup', 'passed'], ['A dup', 'passed']],
    'src/old.test.ts': [['moved', 'passed']],
    'tests/known.test.ts': [['known fail', 'failed'], ['fixed later', 'failed'], ['was skipped', 'skipped']],
  });
  const current = report('D:/wt/cur', {
    'src/a.test.ts': [['A ok', 'passed'], ['A breaks', 'failed'], ['A skipped later', 'skipped'], ['A dup', 'passed'], ['A new', 'passed']],
    'src/new/old.test.ts': [['moved', 'passed']],
    'tests/known.test.ts': [['known fail', 'failed'], ['fixed later', 'passed'], ['was skipped', 'passed']],
  });

  it('detects failing, missing (incl. duplicate titles) and skipped regressions across worktrees', () => {
    const b = normalizeRun(base, { root: 'C:/wt/base', renames: parseRenames(['src/old.test.ts=src/new/old.test.ts']) });
    const c = normalizeRun(current, { root: 'D:/wt/cur' });
    const r = compareRuns(b, c);
    const ids = (list: Array<{ id: string }>) => list.map((t) => t.id);
    expect(ids(r.nowFailing)).toEqual(['src/a.test.ts\tA breaks']);
    expect(ids(r.nowSkipped)).toEqual(['src/a.test.ts\tA skipped later']);
    expect(ids(r.missing)).toEqual(['src/a.test.ts\tA dup\t#2']);
    expect(ids(r.newTests)).toEqual(['src/a.test.ts\tA new']);
    expect(ids(r.newlyPassing)).toEqual(['tests/known.test.ts\tfixed later', 'tests/known.test.ts\twas skipped']);
    expect(ids(r.stillFailing)).toEqual(['tests/known.test.ts\tknown fail']);
    expect(r.regressions).toBe(3);
  });

  it('reports a moved file as wholly missing when no rename is given', () => {
    const b = normalizeRun(base, { root: 'C:/wt/base' });
    const c = normalizeRun(current, { root: 'D:/wt/cur' });
    const r = compareRuns(b, c);
    expect(groupMissingByFile(r.missing, b)).toEqual([
      { file: 'src/a.test.ts', missing: 1, wholeFile: false },
      { file: 'src/old.test.ts', missing: 1, wholeFile: true },
    ]);
  });

  it('records suites that failed to load', () => {
    const run = normalizeRun(
      { testResults: [{ name: '/r/src/x.test.ts', status: 'failed', message: 'SyntaxError: boom\nstack', assertionResults: [] }] },
      { root: '/r' },
    );
    expect(run.brokenSuites).toEqual([{ file: 'src/x.test.ts', message: 'SyntaxError: boom' }]);
  });

  it('identical runs have no regressions', () => {
    const b = normalizeRun(base, { root: 'C:/wt/base' });
    expect(compareRuns(b, b).regressions).toBe(0);
  });
});
