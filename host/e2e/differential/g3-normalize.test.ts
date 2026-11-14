import { execFile } from 'node:child_process';
import { test, expect } from 'vitest';

test('G3 normalize: C2 rules N-001…N-005 over synthetic A1/A2/B traces (tool test, not A)', async () => {
  const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ['--test', '--test-reporter=tap', 'host/e2e/differential/g3-normalize.test.mjs'],
      { cwd: process.cwd(), timeout: 60_000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  expect(result.error, `${result.stdout}\n${result.stderr}`).toBeNull();
  expect(result.stdout).toContain('pass 4');
  expect(result.stdout).toContain('fail 0');
}, 70_000);
