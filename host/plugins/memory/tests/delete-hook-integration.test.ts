import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createSettingsService } from '../../../platform/settings/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import vfsPlugin from '../../vfs/index.ts';
import vfsReposPlugin from '../../vfs-repos/index.ts';
import notesPlugin from '../../notes/index.ts';
import vfsIndexPlugin from '../../vfs-index/index.ts';
import mediaPlugin from '../../media/index.ts';
import vfsHandlersPlugin from '../../vfs-handlers/index.ts';
import memoryPlugin from '../index.ts';
import type { MemoryWriteOutput } from '../api.ts';
import { createMigratedMemoryStorage } from './fixtures/migrated-schema.ts';

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

describe('memory note-delete hook through real vfsHooks', () => {
  it('vfs_delete_note runs the registered memory continuation and audit', async () => {
    const { dir, storage, report } = await createMigratedMemoryStorage('memory-delete-hook-');
    cleanup = () => { storage.dispose(); rmSync(dir, { recursive: true, force: true }); };
    expect(report.success).toBe(true);
    const settings = createSettingsService({
      db: () => storage.database('mistakes'),
      secureStore: () => null,
      secrets: { isSensitiveKey: () => false },
    });
    let host: TestHost | undefined;
    try {
      host = await createTestHost({
        plugins: [pathsPlugin, vfsReposPlugin, notesPlugin, vfsIndexPlugin, vfsPlugin,
          mediaPlugin, vfsHandlersPlugin, memoryPlugin],
        provide: {
          storage, settings,
          log: {
            logger: (target: string) => ({
              target, error: () => undefined, warn: () => undefined, info: () => undefined,
              debug: () => undefined, trace: () => undefined,
            }),
            write: () => undefined,
          },
        },
        app: { dataDir: dir },
      });
      const db = storage.database('vfs');
      const written = await host.invoke('memory_write', {
        title: 'VFS hook note', content: 'deleted through vfs_delete_note',
      }) as MemoryWriteOutput;

      await host.invoke('vfs_delete_note', { id: written.noteId });

      expect(db.pluck<string>(
        'SELECT deleted_at FROM notes WHERE id = ?1', [written.noteId])).toBeTruthy();
      const audit = db.get<{ operation: string; reason: string; source: string }>(
        `SELECT operation, reason, source FROM memory_audit_log
         WHERE note_id = ?1 AND operation = 'delete' ORDER BY id DESC LIMIT 1`, [written.noteId]);
      expect(audit).toMatchObject({
        operation: 'delete',
        source: 'handler',
        reason: 'user_ui: 用户经 VFS/DSTU UI 删除记忆笔记 (vfs_delete_note)',
      });
    } finally {
      await host?.dispose();
    }
  });
});
