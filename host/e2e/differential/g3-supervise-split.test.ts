import { execFile } from 'node:child_process';
import { test, expect } from 'vitest';

test('G3 managed A-store and B-only runs (g3-supervise --mode): preflight, provenance, coverage, report scope (fake runners)', async () => {
  const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ['--test', '--test-reporter=tap', 'host/e2e/differential/g3-supervise-split.test.mjs'],
      { cwd: process.cwd(), timeout: 600_000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  expect(result.error, `${result.stdout}\n${result.stderr}`).toBeNull();
  expect(result.stdout).toContain('# pass 3');
  expect(result.stdout).toContain('# fail 0');
}, 610_000);
