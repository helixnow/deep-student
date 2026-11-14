/**
 * Rust startup maintenance owned by L12:
 * - `lib.rs:3293-3320` `start_vfs_index_worker` (only when Lance is compiled in and
 *   `VfsLanceStore` initialised, `lib.rs:3534-3536`) runs
 *   `VfsIndexStateRepo::requeue_paged_pdfs_once` and only warns on failure.
 * - `lib.rs:1646-1656` spawns a task that sleeps 6 s, then `LanceVectorStore::new`
 *   (base RAG schema in mistakes.db) and `optimize_chat_tables(Some(7), None, false)` /
 *   `optimize_kb_tables(Some(7), None, false)`, swallowing every error. Without Lance the
 *   stub optimizers return `Ok(0)` without side effects (`lance_vector_store.rs:3041-3062`).
 */
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import storagePlugin from '../../../platform/storage/index.ts';
import secretsPlugin from '../../../platform/secrets/index.ts';
import settingsPlugin from '../../../platform/settings/index.ts';
import vectorPlugin from '../../../platform/vector/index.ts';
// boundary-allow cross-plugin-impl: real L11 owner performs the requeue transaction
import reposPlugin from '../../vfs-repos/index.ts';
import plugin from '../index.ts';
import type { LanceEngineService } from '../api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { SettingsWithConn } from '../../../platform/settings/api.ts';
import { ChatLanceStore } from '../src/chat-embeddings.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { testFiles } from './support/files.ts';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function host(withVector: boolean) {
  const root = fs.mkdtempSync('/tmp/opencode/vfs-startup-maint-');
  const instance = await createTestHost({
    app: { dataDir: root },
    // The resident index worker has its own tests; keep this host to the 6 s task.
    plugins: [secretsPlugin, [storagePlugin, { dataLocalDir: root }], settingsPlugin, reposPlugin,
      [plugin, { indexWorker: { enabled: false } }]],
    provide: {
      files: testFiles({ locations: { baseDir: root } }),
      paths: { ...pathsServiceDouble(), appDataDir: root,
        os: { home: root, data: root, dataLocal: root, config: root, temp: root } },
      log: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
      storageStartupSync: { resetDefaultAfterLocalPurge() { throw new Error('clean test root has no purge marker'); } },
    },
  });
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  cleanup.push(() => instance.dispose());
  if (withVector) {
    await instance.install(vectorPlugin);
    expect(instance.ctx.get('vector')).toBeDefined();
  }
  const vfs = instance.ctx.storage.database('vfs');
  vfs.run(`INSERT INTO resources (id, hash, type, storage_mode, data, created_at, updated_at, index_state)
           VALUES ('res_paged', 'h', 'file', 'external', NULL, 1, 1, 'indexed')`);
  vfs.run(`INSERT INTO files (id, resource_id, blob_hash, sha256, file_name, size, "type", mime_type,
             status, created_at, updated_at, page_count)
           VALUES ('file_paged', 'res_paged', NULL, 'sha', 'paged.pdf', 12, 'file', 'application/pdf',
             'active', 1, 1, 3)`);
  const mistakes = instance.ctx.storage.database('mistakes');
  return {
    instance,
    flag: () => vfs.pluck<unknown>(
      "SELECT value FROM vfs_indexing_config WHERE key = 'migration.pdf_paged_units_v2'") ?? null,
    indexState: () => vfs.pluck<unknown>("SELECT index_state FROM resources WHERE id = 'res_paged'"),
    ragTables: () => mistakes.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('rag_documents', 'rag_document_chunks') ORDER BY name",
    ).map(row => row.name),
    optimizeKeys: () => mistakes.all<{ key: string }>(
      "SELECT key FROM settings WHERE key LIKE 'lance.optimize.last.%' ORDER BY key",
    ).map(row => row.key),
  };
}

describe('L12 startup maintenance follows lib.rs worker start and the 6 s Lance task', () => {
  it('with Lance: requeues paged PDFs once at startup, then base schema + chat/kb optimize after 6 s', async () => {
    const fixture = await host(true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await fixture.instance.ctx.storage.runStartupFinalizers();

    expect(fixture.flag()).toBe('done');
    expect(fixture.indexState()).toBe('pending');
    // Neither LanceVectorStore::new nor optimize runs before ready (WP-264 timing).
    expect(fixture.ragTables()).toEqual([]);
    expect(fixture.optimizeKeys()).toEqual([]);

    await vi.advanceTimersByTimeAsync(5_999);
    expect(fixture.ragTables()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await vi.waitFor(() => {
      expect(fixture.optimizeKeys()).toEqual(['lance.optimize.last.chat', 'lance.optimize.last.kb']);
    }, { timeout: 30_000 });
    expect(fixture.ragTables()).toEqual(['rag_document_chunks', 'rag_documents']);
  }, 60_000);

  it('without Lance: no requeue migration; after 6 s only the base schema, no optimize side effects', async () => {
    const fixture = await host(false);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await fixture.instance.ctx.storage.runStartupFinalizers();

    expect(fixture.flag()).toBeNull();
    expect(fixture.indexState()).toBe('indexed');
    expect(fixture.ragTables()).toEqual([]);

    await vi.advanceTimersByTimeAsync(6_000);
    vi.useRealTimers();
    await vi.waitFor(() => {
      expect(fixture.ragTables()).toEqual(['rag_document_chunks', 'rag_documents']);
    }, { timeout: 10_000 });
    expect(fixture.optimizeKeys()).toEqual([]);
    expect(fixture.flag()).toBeNull();
  }, 60_000);

  it('dispose before the 6 s delay cancels the maintenance task', async () => {
    const fixture = await host(false);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await fixture.instance.ctx.storage.runStartupFinalizers();
    expect(vi.getTimerCount()).toBe(1);
    await fixture.instance.dispose();
    expect(vi.getTimerCount()).toBe(0);
  }, 60_000);
});

describe('LanceVectorStore::optimize_kb_tables (lance_vector_store.rs:972-1000)', () => {
  function fakeEngine(names: string[]) {
    const calls: Array<[string, string, unknown]> = [];
    const engine = {
      async connect() {
        return {
          async tableNames() { return names; },
          async openTable(name: string) {
            if (!names.includes(name)) return null;
            return {
              async optimize(action: string, options?: unknown) { calls.push([name, action, options]); },
            };
          },
        };
      },
    } as unknown as LanceEngineService;
    return { engine, calls };
  }

  it('optimizes only kb_chunks_v2_d* tables in dim order with a separate 30 min kb throttle key', async () => {
    const root = fs.mkdtempSync('/tmp/opencode/vfs-kb-optimize-');
    const storage = createStorageService({ baseDir: root, dataLocalDir: root });
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    cleanup.push(() => storage.dispose());
    await storage.migrations.runAll();
    const db = storage.database('mistakes');
    const { engine, calls } = fakeEngine([
      'kb_chunks_v2_d768', 'kb_chunks_v2_d4', 'kb_chunks_d8', 'kb_chunks_v2_dx', 'chat_embeddings_v2_d4',
    ]);
    const settings = {
      saveWithConn(conn: SqlExecutor, key: string, value: string) {
        conn.run('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)', [key, value, value]);
      },
    } as unknown as SettingsWithConn;
    const store = ChatLanceStore.create(db, engine, () => testFiles(storage), undefined, settings);

    expect(await store.optimizeKbTables(7, null, false)).toBe(2);
    expect(calls).toEqual([
      ['kb_chunks_v2_d4', 'compact', undefined],
      ['kb_chunks_v2_d4', 'prune', { olderThanDays: 7, deleteUnverified: false }],
      ['kb_chunks_v2_d4', 'index', undefined],
      ['kb_chunks_v2_d768', 'compact', undefined],
      ['kb_chunks_v2_d768', 'prune', { olderThanDays: 7, deleteUnverified: false }],
      ['kb_chunks_v2_d768', 'index', undefined],
    ]);
    expect(db.pluck<string>("SELECT key FROM settings WHERE key LIKE 'lance.optimize.last.%'"))
      .toBe('lance.optimize.last.kb');

    calls.length = 0;
    expect(await store.optimizeKbTables(7, null, false)).toBe(0);
    expect(calls).toEqual([]);
    // The kb throttle does not gate chat (independent scope key).
    expect(await store.optimizeChatTables(7, null, false)).toBe(1);
    expect(calls.map(([name]) => name)).toEqual(['chat_embeddings_v2_d4', 'chat_embeddings_v2_d4', 'chat_embeddings_v2_d4']);
    calls.length = 0;
    expect(await store.optimizeKbTables(null, null, true)).toBe(2);
    expect(calls.map(([name, action]) => `${name}:${action}`)).toEqual(['kb_chunks_v2_d4:all', 'kb_chunks_v2_d768:all']);
  });
});
