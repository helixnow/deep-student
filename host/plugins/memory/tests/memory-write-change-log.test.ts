/**
 * G3 `memory.batch_move.basic` step 0 through the real owners: the synchronous
 * `memory_write` path must leave the same nine `__change_log` rows, in the same
 * order, as Rust (A). Rows after that come from the two fire-and-forget tasks
 * (`trigger_immediate_index`, `spawn_post_write_maintenance`), which Rust runs on
 * separate tokio tasks with no ordering between them.
 */
import { rmSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
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

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

const quiet = { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined, trace: () => undefined };

it('memory_write leaves the Rust change-log rows for root folder, target folder and note creation', async () => {
  const { dir, storage } = await createMigratedMemoryStorage('memory-write-change-log-');
  const settings = createSettingsService({
    db: () => storage.database('mistakes'), secureStore: () => null, secrets: { isSensitiveKey: () => false },
  });
  let host: TestHost | undefined;
  cleanup = async () => { await host?.dispose(); storage.dispose(); rmSync(dir, { recursive: true, force: true }); };
  host = await createTestHost({
    plugins: [pathsPlugin, vfsReposPlugin, notesPlugin, vfsIndexPlugin, vfsPlugin, mediaPlugin, vfsHandlersPlugin, memoryPlugin],
    provide: { storage, settings, log: { logger: (target: string) => ({ target, ...quiet }), write: () => undefined } },
    app: { dataDir: dir },
  });
  const db = storage.database('vfs');
  const written = await host.invoke('memory_write', { folderPath: '偏好', title: 'm1', content: '用户喜欢跑步' }) as MemoryWriteOutput;

  const rows = db.all<{ table_name: string; operation: string; record_id: string }>(
    'SELECT table_name, operation, record_id FROM __change_log ORDER BY id LIMIT 9');
  const folders = db.all<{ id: string; parent_id: string | null; title: string }>(
    'SELECT id, parent_id, title FROM folders ORDER BY rowid LIMIT 2');
  const resourceId = written.resourceId;
  expect(folders.map(folder => folder.title)).toEqual(['记忆', '偏好']);
  expect(folders[1]!.parent_id).toBe(folders[0]!.id);
  expect(rows.map(row => [row.operation, row.table_name, row.record_id])).toEqual([
    ['INSERT', 'folders', folders[0]!.id],
    ['INSERT', 'folders', folders[1]!.id],
    ['INSERT', 'resources', resourceId],
    ['INSERT', 'notes', written.noteId],
    ['UPDATE', 'resources', resourceId],
    ['INSERT', 'note_document_formats', written.noteId],
    ['INSERT', 'note_document_revisions', expect.stringMatching(/^nrev_/)],
    ['INSERT', 'folder_items', expect.stringMatching(/^fi_/)],
    ['UPDATE', 'resources', resourceId],
  ]);
  expect(db.pluck<string>('SELECT folder_id FROM folder_items WHERE item_id = ?1', [written.noteId])).toBe(folders[1]!.id);
});
