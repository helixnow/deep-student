/**
 * Scale performance regression tests for L11 `vfs-repos` ensuring folder tree assembly,
 * resource listing, path-cache rebuilds, and startup sweeps avoid N+1 SQL storms on 1,000+ notes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { createTestHost } from '../../../kernel/testing.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import plugin from '../index.ts';
import { newFolder, newFolderItem } from '../repository/folders.ts';
import { notesServiceDouble } from './support/notes-service.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;

function createCountingConn(base: DatabaseHandle) {
  const queries: string[] = [];
  const conn = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'all' || prop === 'get' || prop === 'pluck' || prop === 'run' || prop === 'exec') {
        const fn = Reflect.get(target, prop, target) as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => {
          const first = args[0];
          const sql = typeof first === 'string'
            ? first
            : typeof first === 'object' && first !== null && 'sql' in first
              ? String((first as { sql: unknown }).sql)
              : String(prop);
          queries.push(sql.replace(/\s+/g, ' ').trim());
          return fn.apply(target, args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as SqlExecutor;
  return {
    conn,
    queries,
    reset: () => { queries.length = 0; },
  };
}

function seedScaleLibrary(noteCount: number, subfolderCount: number): { rootFolderId: string; folderIds: string[] } {
  const rootFolder = newFolder('Scale Root');
  host.ctx.vfsRepo.folders.createFolder(db, rootFolder);
  const folderIds: string[] = [rootFolder.id];
  for (let i = 0; i < subfolderCount; i += 1) {
    const parentId = i === 0 ? rootFolder.id : folderIds[i % Math.min(folderIds.length, 6)]!;
    const sub = newFolder(`Folder ${i}`, parentId);
    host.ctx.vfsRepo.folders.createFolder(db, sub);
    folderIds.push(sub.id);
  }

  const now = Date.now();
  const iso = new Date(now).toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let i = 0; i < noteCount; i += 1) {
      const noteId = `note_scale_${i}`;
      const resId = `res_scale_${i}`;
      const folderId = folderIds[i % folderIds.length]!;
      db.run(
        `INSERT INTO resources
           (id, hash, type, source_id, source_table, storage_mode, data, ref_count, index_state, created_at, updated_at)
         VALUES (?1, ?2, 'note', ?3, 'notes', 'inline', ?4, 1, 'indexed', ?5, ?5)`,
        [resId, `hash_scale_${i}`, noteId, `Body for note ${i}`, now - i],
      );
      db.run(
        `INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at)
         VALUES (?1, ?2, ?3, '[]', 0, ?4, ?4)`,
        [noteId, resId, `Note Title ${i}`, iso],
      );
      const item = newFolderItem(folderId, 'note', noteId);
      db.run(
        `INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at, cached_path)
         VALUES (?1, ?2, 'note', ?3, ?4, ?5, NULL)`,
        [item.id, folderId, noteId, i, now],
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { rootFolderId: rootFolder.id, folderIds };
}

beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-scale-perf-'));
  host = await createTestHost({
    plugins: [plugin],
    provide: {
      storage,
      paths: pathsServiceDouble(),
      notes: notesServiceDouble(() => storage.database('vfs')),
    },
  });
  db = storage.database('vfs');
}, 120_000);

afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);

describe('vfs-repos scale performance regressions (1,003 notes, 40+ folders)', { timeout: 120_000 }, () => {
  it('getFolderTreeAll and getAllResources avoid N+1 SQL storms across 1,003 notes', () => {
    const { rootFolderId } = seedScaleLibrary(1_003, 40);
    const spy = createCountingConn(db);

    const tree = host.ctx.vfsRepo.folders.getFolderTreeAll(spy.conn);
    expect(tree).toHaveLength(1);
    // Single folders query + single folder_items query (was 42+ queries + O(F^2)).
    expect(spy.queries.length).toBeLessThanOrEqual(3);

    spy.reset();
    const res = host.ctx.vfsRepo.folders.getAllResources(spy.conn, rootFolderId, true, true);
    expect(res.totalCount).toBe(1_003);
    expect(res.resources[0]).toMatchObject({
      itemType: 'note',
      itemId: 'note_scale_0',
      title: 'Note Title 0',
      resourceId: 'res_scale_0',
      content: 'Body for note 0',
    });
    // Batched lookups + memoized folder paths (was 4,000-5,000 queries for 1,003 notes!).
    expect(spy.queries.length).toBeLessThan(100);
  });

  it('PathCacheRepo.rebuildAll and MaintenanceRepo.updatePathCache avoid per-row DDL and N+1 reads', () => {
    const { rootFolderId } = seedScaleLibrary(1_003, 25);
    const spy = createCountingConn(db);

    const rebuilt = host.ctx.vfsRepo.pathCache.rebuildAll(spy.conn);
    expect(rebuilt).toBe(1_003 + 26);
    const ddlQueries = spy.queries.filter((q) => /^CREATE (TABLE|INDEX)/i.test(q));
    // ensureTableExists runs ONCE (3 DDL statements) instead of 3 * 1,029 times.
    expect(ddlQueries.length).toBe(3);
    const selectTitleQueries = spy.queries.filter((q) => /^SELECT .* FROM notes /i.test(q));
    // Chunked by 500 -> <= 3 queries instead of 1,003 per-item SELECTs.
    expect(selectTitleQueries.length).toBeLessThanOrEqual(4);

    spy.reset();
    const updated = host.ctx.vfsRepo.maintenance.updatePathCache(spy.conn, rootFolderId);
    expect(updated).toBe(1_003);
    const readQueries = spy.queries.filter((q) => !/^UPDATE folder_items/i.test(q) && !/^(BEGIN|COMMIT)/i.test(q));
    // Folder paths memoized + note titles batched in chunks of 500 (was 2,006+ read queries).
    expect(readQueries.length).toBeLessThan(50);
  });

  it('startup maintenance/sweep repositories short-circuit cleanly with zero redundant writes when empty', () => {
    seedScaleLibrary(1_003, 5);
    const spy = createCountingConn(db);

    // Zero multi-page PDFs -> requeuePagedPdfsOnce must not run UPDATE resources.
    expect(host.ctx.vfsRepo.indexStates.requeuePagedPdfsOnce(spy.conn)).toBe(0);
    expect(spy.queries.some((q) => /^UPDATE resources/i.test(q))).toBe(false);

    // Zero orphan resources or units -> zero DELETE/INSERT write queries.
    spy.reset();
    expect(host.ctx.vfsRepo.resources.cleanupOrphanNoteMindmapResources(spy.conn, 0)).toBe(0);
    expect(host.ctx.vfsRepo.resources.cleanupUnreferencedRetrievals(spy.conn, 0)).toBe(0);
    expect(host.ctx.vfsRepo.embeddingUnits.sweepOrphanIndexUnits(spy.conn)).toBe(0);
    expect(spy.queries.some((q) => /^(DELETE|INSERT|UPDATE)/i.test(q))).toBe(false);
  });
});
