import { execFile } from 'node:child_process';
import { test, expect } from 'vitest';

test('G3 waits: backup and MCP stdio matchers, strict keys, per-step anchor (tool test, not A)', async () => {
  const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ['--test', '--test-reporter=tap', 'host/e2e/differential/g3-wait.test.mjs'],
      { cwd: process.cwd(), timeout: 60_000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  expect(result.error, `${result.stdout}\n${result.stderr}`).toBeNull();
  expect(result.stdout).toContain('# pass 12');
  expect(result.stdout).toContain('# fail 0');
}, 70_000);
