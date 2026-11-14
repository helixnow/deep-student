import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import * as schema from './fixtures/migrated-schema.ts';

it('reuses a closed migrated schema across isolated module evaluations without sharing writable databases', async () => {
  const first = schema.prepareMemoryTestSchema();
  // A distinct module evaluation models Vitest's per-file isolation. Do not reset
  // application modules or owner Slots to make host lifecycle tests pass.
  const independent = await vi.importActual<typeof schema>(
    './fixtures/migrated-schema.ts?independent-schema-module');
  expect(independent.prepareMemoryTestSchema).not.toBe(schema.prepareMemoryTestSchema);
  expect(independent.prepareMemoryTestSchema()).toBe(first);
  const template = await first;
  expect(template.report.success).toBe(true);
  // The configured forks pool replaces its process per file. Prove that another
  // process can reuse the completed seed, not just this module's Promise cache.
  const moduleUrl = new URL('./fixtures/migrated-schema.ts', import.meta.url).href;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    `const schema = await import(${JSON.stringify(moduleUrl)});
     const template = await schema.prepareMemoryTestSchema();
     process.stdout.write(JSON.stringify({ dir: template.dir, success: template.report.success }));`]);
  expect(JSON.parse(stdout)).toEqual({ dir: template.dir, success: true });

  const left = await schema.createMigratedMemoryStorage('memory-cache-left-');
  const right = await independent.createMigratedMemoryStorage('memory-cache-right-');
  try {
    expect(left.dir).not.toBe(right.dir);
    for (const database of ['vfs', 'chat_v2', 'mistakes', 'llm_usage'] as const) {
      expect(left.storage.migrations.currentVersion(database)).toBeGreaterThan(0);
      expect(right.storage.migrations.currentVersion(database))
        .toBe(left.storage.migrations.currentVersion(database));
    }
    left.storage.database('vfs').run(
      "UPDATE memory_config SET value='left-only' WHERE key='memory_root_folder_id'");
    expect(right.storage.database('vfs').pluck<string>(
      "SELECT value FROM memory_config WHERE key='memory_root_folder_id'")).toBe('');
  } finally {
    left.storage.dispose();
    right.storage.dispose();
    fs.rmSync(left.dir, { recursive: true, force: true });
    fs.rmSync(right.dir, { recursive: true, force: true });
  }
});
