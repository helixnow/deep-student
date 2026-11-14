/**
 * Governance-triggered migrations (Slot C/D via `data_governance_get_migration_diagnostic_report`) log under
 * the Rust coordinator target `module_path!()` of dstu-storage/src/migration/coordinator.rs, not a
 * caller-supplied `backup` target.
 */
import { afterEach, expect, it } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import { MIGRATION_LOG_TARGET } from '../../../platform/storage/migration/coordinator.ts';
import { createMigrationWorker } from '../../../platform/storage/node.ts';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import { setStorageLogger } from '../../../platform/storage/logging.ts';
import { createBackupHost } from './helpers.ts';

let host: TestHost | undefined;
afterEach(async () => {
  try { await host?.dispose(); }
  finally { host = undefined; setStorageLogger(null); }
});

it('governance Slot C/D migrations log under dstu_storage::migration::coordinator', async () => {
  let storage!: StorageServiceImpl;
  const created = await createBackupHost({ storageFactory: dataDir => {
    storage = createStorageService({ baseDir: dataDir, dataLocalDir: dataDir });
    return storage;
  } });
  host = created.host;
  const current = host;
  current.ctx.effect(() => () => storage.dispose());
  const startup = createMigrationWorker({ baseDir: current.app.dataDir });
  try {
    const initial = await startup.runAll({ appDataDir: storage.locations.activeDir });
    expect(initial.success, initial.error ?? '').toBe(true);
  } finally { await startup.close(); }

  const logs: Array<{ name: string; text: string }> = [];
  setStorageLogger(target => {
    const logger = current.ctx.logger(target);
    return { target, info: logger.info.bind(logger), warn: logger.warn.bind(logger),
      error: logger.error.bind(logger), debug: logger.debug.bind(logger), trace: logger.debug.bind(logger) };
  });
  current.ctx.logger.exporter({ levels: { default: 3 }, export(message) {
    logs.push({ name: message.name, text: message.args.map(String).join(' ') });
  } });

  await current.invoke<string>('data_governance_get_migration_diagnostic_report');

  expect(MIGRATION_LOG_TARGET).toBe('dstu_storage::migration::coordinator');
  const coordinator = logs.filter(log => log.text.includes('[MigrationCoordinator]'));
  expect(coordinator.filter(log => log.text.includes('[MigrationCoordinator] 迁移完成'))).toHaveLength(2);
  expect([...new Set(coordinator.map(log => log.name))]).toEqual([MIGRATION_LOG_TARGET]);
  expect(logs.filter(log => log.name === 'backup' && /Migration/.test(log.text))).toEqual([]);
});
