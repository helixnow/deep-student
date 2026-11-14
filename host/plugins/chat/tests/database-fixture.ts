import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageServiceImpl } from '../../../platform/storage/service.ts';
import { MigrationCoordinator } from '../../../platform/storage/migration/coordinator.ts';

/**
 * Minimal VFS service for tests that do not exercise topic folders. Group
 * commands resolve the real VFS database in production; this doubles only the
 * required service shape so the chat plugin can load with `inject: ['vfs']`.
 */
export const vfsStub = {
  version: 1 as const,
  database: {
    getConnSafe(): never {
      throw new Error('vfsStub: topic folder access is not configured for this test');
    },
  },
};

export function databaseFixture() {
  const root = mkdtempSync(join(tmpdir(), 'chat-migration-'));
  const storage = new StorageServiceImpl({ baseDir: root, dataLocalDir: root });
  const coordinator = new MigrationCoordinator({ appDataDir: storage.locations.activeDir, auditDbPath: null });
  const report = coordinator.migrateSingle('chat_v2');
  if (!report.success) throw new Error(JSON.stringify(report));
  return {
    root, storage, coordinator, db: storage.database('chat_v2'),
    dispose() { storage.dispose(); rmSync(root, { recursive: true, force: true }); },
  };
}
