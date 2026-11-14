import { execFile } from 'node:child_process';
import { test, expect } from 'vitest';

test('G3 A/A2 pre-recording and B-only recording: A store, sha256-pinned reuse by B commits, input coverage, domains (fake runners)', async () => {
  const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ['--test', '--test-reporter=tap', 'host/e2e/differential/g3-split.test.mjs'],
      { cwd: process.cwd(), timeout: 600_000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  expect(result.error, `${result.stdout}\n${result.stderr}`).toBeNull();
  expect(result.stdout).toContain('# pass 6');
  expect(result.stdout).toContain('# fail 0');
}, 610_000);
