import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(['scripts/plugins/generate-contracts.mjs', '--check']);
run(['scripts/plugins/check-boundaries.mjs']);
run(['node_modules/typescript/bin/tsc', '-p', 'tsconfig.plugins.json']);
run(['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.plugins.config.ts']);
