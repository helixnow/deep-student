import { execFile } from 'node:child_process';
import { test, expect } from 'vitest';

test('g3-slice: slicing rules; every function the A process runs is on its slice; the seed generator leaves the process as it was', async () => {
  const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ['--test', '--test-reporter=tap', 'host/e2e/differential/g3-slice.test.mjs'],
      { cwd: process.cwd(), timeout: 240_000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  expect(result.error, `${result.stdout}\n${result.stderr}`).toBeNull();
  expect(result.stdout).toContain('# pass 9');
  expect(result.stdout).toContain('# fail 0');
}, 250_000);
