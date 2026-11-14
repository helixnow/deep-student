import { execFile } from 'node:child_process';
import { test, expect } from 'vitest';

test('G3 batch CLI: worker receipts, shard admission/rejection, rerun and SIGTERM shutdown (fake runners)', async () => {
  const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ['--test', '--test-reporter=tap', 'host/e2e/differential/g3-batch-cli.test.mjs'],
      { cwd: process.cwd(), timeout: 180_000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  expect(result.error, `${result.stdout}\n${result.stderr}`).toBeNull();
  expect(result.stdout).toContain('# pass 2');
  expect(result.stdout).toContain('# fail 0');
}, 190_000);
