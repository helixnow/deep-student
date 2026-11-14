import { execFile } from 'node:child_process';
import { test, expect } from 'vitest';

test('WAVE0 v0 preparation, exact references and real SQLite capture (recorder-only, not A)', async () => {
  const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ['--test', '--test-reporter=tap', 'host/e2e/differential/scenario-v0.test.mjs'],
      { cwd: process.cwd(), timeout: 30_000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  expect(result.error, `${result.stdout}\n${result.stderr}`).toBeNull();
  expect(result.stdout).toContain('pass 9');
  expect(result.stdout).toContain('fail 0');
}, 40_000);
