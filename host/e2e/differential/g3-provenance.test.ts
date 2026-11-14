import { execFile } from 'node:child_process';
import { test, expect } from 'vitest';

test('G3 provenance: only runs that pin the B commit, Host receipt and A build receipt sha256 are counted', async () => {
  const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ['--test', '--test-reporter=tap', 'host/e2e/differential/g3-provenance.test.mjs'],
      { cwd: process.cwd(), timeout: 120_000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  expect(result.error, `${result.stdout}\n${result.stderr}`).toBeNull();
  expect(result.stdout).toContain('# pass 3');
  expect(result.stdout).toContain('# fail 0');
}, 130_000);
