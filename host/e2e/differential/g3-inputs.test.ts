import { execFile } from 'node:child_process';
import { test, expect } from 'vitest';

test('G3 inputs v2: seeds (build clock masked), sidecars, the A process code slice per service set, launch, runtime and environment per scenario', async () => {
  const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ['--test', '--test-reporter=tap', 'host/e2e/differential/g3-inputs.test.mjs'],
      { cwd: process.cwd(), timeout: 240_000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  // fulltest keeps assertion messages, but truncates the inspected Error object. Keep
  // execFile's killed/signal/code alongside TAP so a timeout is not mistaken for a hash failure.
  expect(result.error, JSON.stringify({ error: result.error, message: result.error?.message,
    stdout: result.stdout, stderr: result.stderr }, null, 2)).toBeNull();
  expect(result.stdout).toContain('# pass 10');
  expect(result.stdout).toContain('# fail 0');
}, 250_000);
