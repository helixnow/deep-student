import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LATEST_FULLTEST, expandReportArgs, loadVitestReports, mergeVitestReports, repoRelativeTestPath } from './vitest-report.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'w09-vitest-report-'));
  roots.push(dir);
  return dir;
};
const known = new Set(['host/plugins/notes/tests/a.test.ts', 'electron/tests/file-ops.test.ts']);
const exists = (rel: string) => known.has(rel);
const report = (names: string[], extra: Record<string, unknown> = {}) => ({
  ...extra,
  testResults: names.map((name) => ({ name, assertionResults: [{ title: 't', fullName: `${name} t`, status: 'passed' }] })),
});

describe('vitest reports for the ledger', () => {
  it('maps raw reporter paths from another machine/worktree onto this repo', () => {
    const root = '/Users/me/repo';
    expect(repoRelativeTestPath('/home/dsdev/wt/L10/host/plugins/notes/tests/a.test.ts', root, exists)).toBe('host/plugins/notes/tests/a.test.ts');
    expect(repoRelativeTestPath('/Users/me/repo/electron/tests/file-ops.test.ts', root, exists)).toBe('electron/tests/file-ops.test.ts');
    expect(repoRelativeTestPath('host/plugins/notes/tests/a.test.ts', root, exists)).toBe('host/plugins/notes/tests/a.test.ts');
    // Unknown file (deleted locally): fall back to the repo-relative anchor instead of an absolute path.
    expect(repoRelativeTestPath('/srv/x/host/plugins/gone/tests/b.test.ts', root, exists)).toBe('host/plugins/gone/tests/b.test.ts');
  });

  it('merges shards; a later report for the same file replaces (not adds to) the earlier one', () => {
    const merged = mergeVitestReports([
      { path: 's1.json', report: report(['/home/dsdev/wt/X/host/plugins/notes/tests/a.test.ts']) },
      { path: 's2.json', report: { testResults: [{ name: 'host/plugins/notes/tests/a.test.ts', assertionResults: [{ title: 't', fullName: 'f', status: 'failed' }] }] } },
      { path: 'latest.json', report: report(['electron/tests/file-ops.test.ts'], { head: 'abc123', at: '2026-11-06T13:11:03.680Z' }) },
    ], '/Users/me/repo', exists);
    expect([...merged.results.keys()]).toEqual(['host/plugins/notes/tests/a.test.ts', 'electron/tests/file-ops.test.ts']);
    expect(merged.results.get('host/plugins/notes/tests/a.test.ts')).toEqual([{ title: 't', fullName: 'f', status: 'failed' }]);
    expect(merged.overridden).toEqual(['host/plugins/notes/tests/a.test.ts']);
    expect(merged.provenance.map((p) => [p.path, p.head, p.at, p.files, p.tests])).toEqual([
      ['s1.json', null, null, 1, 1], ['s2.json', null, null, 1, 1], ['latest.json', 'abc123', '2026-11-06T13:11:03.680Z', 1, 1],
    ]);
  });

  it('rejects non-vitest JSON loudly', () => {
    expect(() => mergeVitestReports([{ path: 'x.json', report: { commands: {} } }], '/r', exists)).toThrow(/not a vitest JSON report/);
  });

  it('expands "latest" and directories of shard reports', () => {
    const root = temp();
    expect(() => expandReportArgs(['latest'], root)).toThrow(/fulltest/);
    mkdirSync(path.dirname(path.join(root, LATEST_FULLTEST)), { recursive: true });
    writeFileSync(path.join(root, LATEST_FULLTEST), JSON.stringify(report([])));
    expect(expandReportArgs(['latest'], root)).toEqual([path.join(root, LATEST_FULLTEST)]);
    const shards = path.join(root, 'shards');
    mkdirSync(shards);
    writeFileSync(path.join(shards, 'shard-2.json'), JSON.stringify(report([])));
    writeFileSync(path.join(shards, 'shard-1.json'), JSON.stringify(report([])));
    writeFileSync(path.join(shards, 'notes.txt'), '');
    expect(expandReportArgs([shards], root).map((f) => path.basename(f))).toEqual(['shard-1.json', 'shard-2.json']);
  });

  it('reads the checked-in server fulltest sample with provenance', () => {
    const repo = path.resolve(import.meta.dirname, '../../..');
    const sample = path.join(repo, 'host/platform/native/wp280/fulltest-latest.original.json');
    const raw = JSON.parse(readFileSync(sample, 'utf8')) as { head: string; at: string; testResults: unknown[]; numTotalTests: number };
    const merged = loadVitestReports([sample], repo);
    expect(merged.provenance).toEqual([{ path: sample, head: raw.head, at: raw.at, files: raw.testResults.length, tests: raw.numTotalTests }]);
    expect(merged.results.size).toBe(raw.testResults.length);
  });
});
