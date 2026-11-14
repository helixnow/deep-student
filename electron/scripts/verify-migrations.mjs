#!/usr/bin/env node
/**
 * 用法：`node electron/scripts/verify-migrations.mjs <Resources/migrations> [源目录]`。
 * 逻辑在 `electron/migrations-integrity.ts`（Node 24 直接剥离类型运行）。
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyMigrations } from '../migrations-integrity.ts';

const electronDir = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) {
  process.stderr.write('usage: node electron/scripts/verify-migrations.mjs <Resources/migrations> [source]\n');
  process.exit(2);
}
const source = resolve(process.argv[3] ?? join(electronDir, '..', 'resources/app', 'migrations'));
const problems = verifyMigrations(source, resolve(process.argv[2]));
if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`[migrations] ${problem}\n`);
  process.exit(1);
}
process.stdout.write('[migrations] byte-identical\n');
