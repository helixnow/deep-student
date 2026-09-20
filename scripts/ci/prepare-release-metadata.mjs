#!/usr/bin/env node
// Explicit maintainer command, never run implicitly by a release build.
// Run after npm ci and after the release PR has updated all application versions.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyMetadata } from './release-contracts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function run(command, args, cwd = root, stdout = 'inherit') {
  const result = spawnSync(command, args, { cwd, stdio: ['ignore', stdout, 'inherit'] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal || result.status}); no files were committed`);
}
try {
  run('cargo', ['metadata', '--format-version', '1'], path.join(root, 'src-tauri'), 'ignore');
  run(process.execPath, [path.join(root, 'scripts/generate-third-party-notices.mjs')]);
  run(process.execPath, [path.join(root, 'scripts/check-license-compliance.mjs')]);
  verifyMetadata(root);
  console.log('Release metadata prepared. Review Cargo.lock and legal/THIRD_PARTY_NOTICES.txt, then commit them with the release PR. No commit/push/tag was performed.');
} catch (error) {
  console.error(`[release:prepare] ${error.message}`);
  process.exitCode = 1;
}
