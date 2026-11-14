import { execFile } from 'node:child_process';
import { test, expect } from 'vitest';

// The JSONL/native-sqlite checks run in an ordinary Node process, matching the
// recorder runtime. Keep the node:test assertions intact and expose their failure
// exit code to the repository's *.test.ts Vitest collection gate.
test('differential recorder: exact JSON, production adapters, SQLite, kernel replay and evidence gates', async () => {
  const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, [
      '--test', '--test-reporter=tap', 'host/e2e/differential/framework.test.mjs',
    ], { cwd: process.cwd(), timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr });
    });
  });
  expect(result.error, `${result.stdout}\n${result.stderr}`).toBeNull();
  expect(result.stdout).toContain('pass 12');
  expect(result.stdout).toContain('fail 0');
}, 40_000);
