import { execFile } from 'node:child_process';
import { test, expect } from 'vitest';

test('G3 process lifecycle: misbehaving A side / workers never hang the recorder and never count as success', async () => {
  const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ['--test', '--test-reporter=tap', 'host/e2e/differential/g3-lifecycle.test.mjs'],
      { cwd: process.cwd(), timeout: 120_000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  expect(result.error, `${result.stdout}\n${result.stderr}`).toBeNull();
  expect(result.stdout).toContain('# fail 0');
  // 11 portable cases; the 5 PID-namespace cases add to this on Linux and skip elsewhere.
  expect(Number(/^# pass (\d+)$/m.exec(result.stdout)?.[1])).toBeGreaterThanOrEqual(11);
}, 130_000);
