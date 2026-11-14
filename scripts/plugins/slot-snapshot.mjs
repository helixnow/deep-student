#!/usr/bin/env node
/**
 * FE-A1 layer 1 — full UI-kernel slot snapshot (plans/FRONTEND-PLUGINIZATION.md §2.8).
 *
 *   node scripts/plugins/slot-snapshot.mjs            # = --check
 *   node scripts/plugins/slot-snapshot.mjs --update   # rewrite tests/visual/__golden__/slots/*.json
 *
 * Installs every official UI plugin into a headless kernel (the production installer) and compares
 * all slots × 16 scenarios with the goldens, plus the production assembly (createAppUiKernel with the
 * chat plugin module loaded: late official plugins and the chat block/event/mode registries).
 * Owner changes and new entries listed in tests/visual/__golden__/slots/owner-moves.json are accepted;
 * anything else fails. The work is done by src/ui-plugins/testing/slot-snapshot{,.app}.test.ts,
 * which also run in plain vitest.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const unknown = args.filter((arg) => !['--check', '--update'].includes(arg));
if (unknown.length || (args.includes('--check') && args.includes('--update'))) {
  console.error('usage: node scripts/plugins/slot-snapshot.mjs [--check | --update]');
  process.exit(2);
}
const mode = args.includes('--update') ? 'update' : 'check';
const result = spawnSync(process.execPath, [
  'node_modules/vitest/vitest.mjs', 'run', '-c', 'vitest.config.ts',
  'src/ui-plugins/testing/slot-snapshot.test.ts', 'src/ui-plugins/testing/slot-snapshot.app.test.ts', '--maxWorkers=2', '--silent=false',
], { cwd: root, stdio: 'inherit', env: { ...process.env, DS_SLOT_SNAPSHOT: mode } });
if (result.error) throw result.error;
const status = result.status ?? 1;
console.log(`[slot-snapshot] ${mode} ${status === 0 ? 'passed' : 'FAILED'}`);
process.exit(status);
