/**
 * Scale regression tests for L12 `vfs-index` startup and background indexing paths
 * on large libraries (1,000+ notes/resources).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import storagePlugin from '../../../platform/storage/index.ts';
import secretsPlugin from '../../../platform/secrets/index.ts';
import settingsPlugin from '../../../platform/settings/index.ts';
import vectorPlugin from '../../../platform/vector/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { SettingsWithConn } from '../../../platform/settings/api.ts';
import type { LanceEngineService } from '../api.ts';
// boundary-allow cross-plugin-impl: real L11 owner performs startup recovery & requeue queries
import reposPlugin from '../../vfs-repos/index.ts';
import plugin from '../index.ts';
import { ChatLanceStore } from '../src/chat-embeddings.ts';
import { VfsIndexWorker } from '../src/index-worker.ts';
import { listPrepareCandidateStamps } from '../repository/index-content.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { testFiles } from './support/files.ts';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function seedNotes(vfs: SqlExecutor, count: number, indexState: 'pending' | 'indexed'): void {
  const now = Date.now();
  const iso = new Date(now).toISOString();
  vfs.exec('BEGIN IMMEDIATE');
  try {
    for (let i = 0; i < count; i += 1) {
      const resId = `res_scale_${i}`;
      const noteId = `note_scale_${i}`;
      vfs.run(
        `INSERT INTO resources
           (id, hash, type, source_id, source_table, storage_mode, data, ref_count, index_state, created_at, updated_at)
         VALUES (?1, ?2, 'note', ?3, 'notes', 'inline', ?4, 1, ?5, ?6, ?6)`,
        [resId, `hash_scale_${i}`, noteId, `# Note ${i}\n\nScale benchmark note body ${i}.`, indexState, now - i],
      );
      vfs.run(
        `INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at)
         VALUES (?1, ?2, ?3, '[]', 0, ?4, ?4)`,
        [noteId, resId, `Scale Note ${i}`, iso],
      );
    }
    vfs.exec('COMMIT');
  } catch (error) {
    vfs.exec('ROLLBACK');
    throw error;
  }
}

describe('vfs-index scale startup performance regressions (1,003+ notes)', () => {
  it('runStartupFinalizers stays fast on 1,003 notes and does not eagerly block HostReady', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-index-scale-boot-'));
    const host = await createTestHost({
      app: { dataDir: root },
      plugins: [
        secretsPlugin,
        [storagePlugin, { dataLocalDir: root }],
        settingsPlugin,
        reposPlugin,
        [plugin, { indexWorker: { enabled: false } }],
      ],
      provide: {
        files: testFiles({ locations: { baseDir: root } }),
        paths: {
          ...pathsServiceDouble(),
          appDataDir: root,
          os: { home: root, data: root, dataLocal: root, config: root, temp: root },
        },
        log: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
        storageStartupSync: { resetDefaultAfterLocalPurge() { throw new Error('clean test root'); } },
      },
    });
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    cleanup.push(() => host.dispose());
    await host.install(vectorPlugin);

    const vfs = host.ctx.storage.database('vfs');
    seedNotes(vfs, 1_003, 'indexed');

    const startedAt = performance.now();
    await host.ctx.storage.runStartupFinalizers();
    const elapsedMs = performance.now() - startedAt;

    expect(vfs.pluck("SELECT value FROM vfs_indexing_config WHERE key = 'migration.pdf_paged_units_v2'")).toBe('done');
    expect(elapsedMs).toBeLessThan(1_000);
  }, 60_000);

  it('listPrepareCandidateStamps avoids scanning all non-deleted resources via idx_resources_deleted', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-index-scale-eqp-'));
    const storage = createStorageService({ baseDir: root, dataLocalDir: root });
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    cleanup.push(() => storage.dispose());
    expect((await storage.migrations.runAll()).success).toBe(true);

    const vfs = storage.database('vfs');
    seedNotes(vfs, 1_003, 'indexed');
    // Insert 2 pending notes among 1,003 indexed notes.
    vfs.run("UPDATE resources SET index_state = 'pending' WHERE id IN ('res_scale_5', 'res_scale_999')");

    const plan = vfs.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN
       SELECT r.id,
              COALESCE(r.hash, '') || ':' || COALESCE(CAST(r.updated_at AS TEXT), '') AS stamp
       FROM resources r
       WHERE +r.deleted_at IS NULL
         AND (r.index_state = 'pending' OR r.index_state IS NULL)
         AND NOT EXISTS (SELECT 1 FROM vfs_index_units u WHERE u.resource_id = r.id)
       ORDER BY r.updated_at DESC
       LIMIT ?1`,
      [40],
    ).map((row) => row.detail);

    expect(plan.some((line) => line.includes('idx_resources_deleted'))).toBe(false);
    expect(plan.some((line) => line.includes('idx_resources_index'))).toBe(true);

    const candidates = listPrepareCandidateStamps(vfs, 10);
    expect(candidates.map((entry) => entry.id)).toEqual(['res_scale_5', 'res_scale_999']);
  }, 60_000);

  it('ChatLanceStore skips LanceDB connect when throttled and enumerates tables only once when unthrottled', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-index-lance-skip-'));
    const storage = createStorageService({ baseDir: root, dataLocalDir: root });
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    cleanup.push(() => storage.dispose());
    expect((await storage.migrations.runAll()).success).toBe(true);

    const db = storage.database('mistakes');
    let connectCalls = 0;
    let tableNamesCalls = 0;
    const engine = {
      async connect() {
        connectCalls += 1;
        return {
          async tableNames() {
            tableNamesCalls += 1;
            return ['chat_embeddings_v2_d64', 'kb_chunks_v2_d64'];
          },
          async openTable() {
            return { async optimize() {} };
          },
        };
      },
    } as unknown as LanceEngineService;
    const settings = {
      saveWithConn(conn: SqlExecutor, key: string, value: string) {
        conn.run('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)', [key, value, value]);
      },
    } as unknown as SettingsWithConn;

    const store = ChatLanceStore.create(db, engine, () => testFiles(storage), undefined, settings);
    expect(await store.optimizeChatTables(7, null, false)).toBe(1);
    // Single tableNames() scan for both chat_v2 and chat_legacy prefixes.
    expect(connectCalls).toBe(1);
    expect(tableNamesCalls).toBe(1);

    expect(await store.optimizeKbTables(7, null, false)).toBe(1);
    expect(tableNamesCalls).toBe(2);

    // Subsequent startup inside the 30 min throttle window must never touch LanceDB.
    let secondConnectCalls = 0;
    const secondEngine = {
      async connect() {
        secondConnectCalls += 1;
        throw new Error('should not connect to LanceDB while throttled');
      },
    } as unknown as LanceEngineService;
    const secondStore = ChatLanceStore.create(db, secondEngine, () => testFiles(storage), undefined, settings);
    expect(await secondStore.optimizeChatTables(7, null, false)).toBe(0);
    expect(await secondStore.optimizeKbTables(7, null, false)).toBe(0);
    expect(secondConnectCalls).toBe(0);
  }, 60_000);

  it('VfsIndexWorker respects initialDelayMs so startup hydration runs without immediate contention', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const worker = new VfsIndexWorker({
      getConfig: () => ({
        enabled: true, batchSize: 10, intervalSecs: 5, maxConcurrent: 2, retryDelaySecs: 60, maxRetries: 3,
      }),
      lanceEnabled: () => true,
      startupMaintenance: () => false,
      textEmbeddingConfigured: async () => false,
      reviveConfigBlocked: () => 0,
      processTextBatch: async () => [0, 0],
      prepareUnitsWithoutEmbedding: (limit) => { calls.push(`prepare:${limit}`); return 0; },
      drainLanceOrphanQueue: async () => { calls.push('drain'); return 0; },
      multimodalConfigured: async () => false,
      processMultimodalBatch: async () => [0, 0],
      maybeOptimizeAll: async () => { calls.push('optimize'); return 0; },
      initialDelayMs: 3_000,
      now: () => Date.now(),
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(['prepare:10', 'drain', 'optimize']);

    await worker.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('prepareUnitsWithoutEmbedding batches writes cleanly on 1,003 pending notes without blocking', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-index-scale-prepare-'));
    const host = await createTestHost({
      app: { dataDir: root },
      plugins: [
        secretsPlugin,
        [storagePlugin, { dataLocalDir: root }],
        settingsPlugin,
        reposPlugin,
        [plugin, { indexWorker: { enabled: false } }],
      ],
      provide: {
        files: testFiles({ locations: { baseDir: root } }),
        paths: {
          ...pathsServiceDouble(),
          appDataDir: root,
          os: { home: root, data: root, dataLocal: root, config: root, temp: root },
        },
        log: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
        storageStartupSync: { resetDefaultAfterLocalPurge() { throw new Error('clean test root'); } },
      },
    });
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    cleanup.push(() => host.dispose());

    const vfs = host.ctx.storage.database('vfs');
    seedNotes(vfs, 1_003, 'pending');

    const startedAt = performance.now();
    const prepared = host.ctx.vfsIndex.indexing.prepareUnitsWithoutEmbedding(25);
    const elapsedMs = performance.now() - startedAt;

    expect(prepared).toBeGreaterThan(0);
    expect(prepared).toBeLessThanOrEqual(25);
    expect(elapsedMs).toBeLessThan(500);
    expect(vfs.pluck<number>('SELECT COUNT(*) FROM vfs_index_units')).toBe(prepared);
  }, 60_000);
});
