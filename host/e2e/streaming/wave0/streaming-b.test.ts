import { execFile } from 'node:child_process';
import { test, expect } from 'vitest';

// Both suites run the real B Host through g3-run-b.mjs, whose LLM service binds the fixed G3 port
// (g3-wait.mjs LLM_PORT, baked into the scenarios' baseUrl). They share this file so they run one after the other.

test('WAVE0 streaming suite on a real B Host (thinking, empty, 5xx retry, 4xx, cancel during retry, tool round 2, tool round 2 error)', async () => {
  const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ['--test', '--test-reporter=tap', 'host/e2e/streaming/wave0/streaming-b.test.mjs'],
      { cwd: process.cwd(), timeout: 300_000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  expect(result.error, `${result.stdout}\n${result.stderr}`).toBeNull();
  expect(result.stdout).toContain('pass 7');
  expect(result.stdout).toContain('fail 0');
}, 310_000);

test('WAVE0 LLM service routes on a real B Host (embeddings, w0.directive, audio transcriptions)', async () => {
  const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ['--test', '--test-reporter=tap', 'host/e2e/streaming/wave0/llm-routes-b.test.mjs'],
      { cwd: process.cwd(), timeout: 300_000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  expect(result.error, `${result.stdout}\n${result.stderr}`).toBeNull();
  expect(result.stdout).toContain('pass 3');
  expect(result.stdout).toContain('fail 0');
}, 310_000);
