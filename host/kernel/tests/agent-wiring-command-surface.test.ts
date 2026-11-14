/**
 * `src/agent_wiring/tests/command_surface_tests.rs::removed_cardforge_callback_stays_off_command_surfaces`.
 *
 * The Rust test locked four Rust sources against the removed CardAgent callback. quality.md §5
 * requires a Rust source lock to move to the TS implementation, so this test checks the three
 * command surfaces the Host actually owns: the IPC contract set, the app ACL (fed by the same
 * permission table), and every production TS source under `host/`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { CapabilityAcl } from '../acl.ts';
import { ContractSet } from '../contracts.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const REMOVED_COMMAND = ['chat_v2_anki', '_cards_result'].join('');

function productionSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'tests' || entry.name === '__fixtures__' || entry.name === 'node_modules') continue;
      files.push(...productionSources(path));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(path);
    }
  }
  return files;
}

it('removed_cardforge_callback_stays_off_command_surfaces', () => {
  const contracts = ContractSet.fromDirectory();
  expect(contracts.commands.has(REMOVED_COMMAND)).toBe(false);

  const acl = CapabilityAcl.fromDirectory('darwin');
  expect(acl.denial(REMOVED_COMMAND, { window: 'main', webview: 'main' }, true)).not.toBeNull();

  const offenders = productionSources(join(ROOT, 'host'))
    .filter(file => readFileSync(file, 'utf8').includes(REMOVED_COMMAND))
    .map(file => file.slice(ROOT.length));
  expect(offenders).toEqual([]);
});
