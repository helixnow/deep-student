import { execFile } from 'node:child_process';
import { test, expect } from 'vitest';

test('G3 rust-fixes: approved selectors exempt exactly what they cover, proposed hits stay counted, report lists both by kind', async () => {
  const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ['--test', '--test-reporter=tap', 'host/e2e/differential/g3-rust-fixes.test.mjs'],
      { cwd: process.cwd(), timeout: 300_000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  expect(result.error, `${result.stdout}\n${result.stderr}`).toBeNull();
  expect(result.stdout).toContain('# pass 7');
  expect(result.stdout).toContain('# fail 0');
}, 310_000);
