import { execFile } from 'node:child_process';
import { test, expect } from 'vitest';

test('G3 clock: recording dates and offsets from receipts; only exact recording-date shifts are environment differences', async () => {
  const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ['--test', '--test-reporter=tap', 'host/e2e/differential/g3-clock.test.mjs'],
      { cwd: process.cwd(), timeout: 60_000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  expect(result.error, `${result.stdout}\n${result.stderr}`).toBeNull();
  expect(result.stdout).toContain('# pass 2');
  expect(result.stdout).toContain('# fail 0');
}, 70_000);
