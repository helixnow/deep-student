import { execFile } from 'node:child_process';
import { test, expect } from 'vitest';

test('g3-a-stale: stale A takes and their reasons between two commits, a commit and the working tree, or an A store and a tree', async () => {
  const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ['--test', '--test-reporter=tap', 'host/e2e/differential/g3-a-stale.test.mjs'],
      { cwd: process.cwd(), timeout: 240_000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  expect(result.error, `${result.stdout}\n${result.stderr}`).toBeNull();
  expect(result.stdout).toContain('# pass 2');
  expect(result.stdout).toContain('# fail 0');
}, 250_000);
