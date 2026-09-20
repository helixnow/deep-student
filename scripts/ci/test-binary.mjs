#!/usr/bin/env node
// Resolve the exact executable from Cargo JSON, never a glob of stale binaries.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function executableFromMessages(text, name) {
  const matches = text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((m) => m.reason === 'compiler-artifact' && m.profile?.test && m.target?.name === name && m.executable);
  assert.equal(matches.length, 1, `expected one test executable for ${name}`);
  return matches[0].executable;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [target, outputName] = process.argv.slice(2);
  assert.ok(target && /^[A-Z_]+$/.test(outputName || ''), 'usage: test-binary.mjs TARGET ENV_NAME');
  const result = spawnSync('cargo', ['test', '--locked', '--no-run', '--message-format=json-render-diagnostics', '--test', target], {
    cwd: 'src-tauri', encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
  const executable = executableFromMessages(result.stdout, target);
  appendFileSync(process.env.GITHUB_ENV, `${outputName}=${executable}\n`);
  console.log(`Prepared ${target}: ${executable}`);
}
