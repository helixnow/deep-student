/**
 * `lib.rs::start_vfs_index_worker` end to end: an uploaded resource is indexed by
 * the resident loop with no manual `processPendingBatch` call, and plugin unload
 * leaves no sleep or batch behind.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createNodeFiles } from '../../../platform/files/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import vectorPlugin from '../../../platform/vector/index.ts';
// boundary-allow cross-plugin-impl: real L13 upload is the production entry that queues the resource
import vfsPlugin from '../../vfs/index.ts';
// boundary-allow cross-plugin-impl: real L10 notes plugin required by vfs
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: real L11 owner writes files/blobs/index state
import reposPlugin from '../../vfs-repos/index.ts';
import plugin from '../index.ts';
import { defaultIndexWorkerSleep, type IndexWorkerSleep } from '../src/index-worker.ts';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function trackedSleep(): { sleep: IndexWorkerSleep; pending: () => number; calls: () => number } {
  let pending = 0;
  let calls = 0;
  return {
    sleep: async (ms, signal) => {
      pending += 1;
      calls += 1;
      try { await defaultIndexWorkerSleep(Math.min(ms, 200), signal); }
      finally { pending -= 1; }
    },
    pending: () => pending,
    calls: () => calls,
  };
}

async function setup(options: {
  embeddingCalls: string[][]; sleep: IndexWorkerSleep; warnings?: string[]; provide?: Record<string, unknown>;
}): Promise<{
  host: TestHost; storage: ReturnType<typeof createStorageService>;
}> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-index-worker-'));
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  cleanup.push(() => storage.dispose());
  const report = await storage.migrations.runAll();
  expect(report.success, report.error ?? '').toBe(true);
  const model = { id: 'worker-embedding', model: 'worker-model', baseUrl: 'https://example.test/v1',
    providerType: null, providerScope: null, apiProtocol: null, modelAdapter: 'openai' };
  const host = await createTestHost({
    plugins: [pathsPlugin, notesPlugin, reposPlugin, vectorPlugin, [plugin, { indexWorker: { sleep: options.sleep } }],
      vfsPlugin],
    provide: {
      storage,
      files: createNodeFiles({ roots: [{ name: 'appData', path: root }, { name: 'temp', path: os.tmpdir() }] }),
      memoryConfig: { get: () => null, set: () => undefined },
      settings: { get: () => null },
      // L18 DocumentParser double: plain UTF-8 text only.
      docs: {
        isPlainTextCodeExtension: () => false,
        extractTextFromBytes: (_name: string, bytes: Uint8Array) => Buffer.from(bytes).toString('utf8'),
      },
      llmEmbeddingModels: { getEmbeddingModelConfig: async () => model },
      'embedding@1': {
        callEmbeddingApi: async (texts: string[]) => {
          options.embeddingCalls.push(texts);
          return texts.map(() => Array<number>(64).fill(0.25));
        },
      },
      ...options.provide,
    },
    app: { dataDir: root },
  });
  cleanup.push(() => host.dispose());
  host.ctx.logger.exporter({ levels: { default: 3 }, export(message) {
    if (message.type === 'warn') options.warnings?.push((message.args as unknown[]).map(String).join(' '));
  } });
  storage.database('vfs').run(
    "INSERT OR REPLACE INTO vfs_indexing_config (key, value, updated_at) VALUES ('indexing.interval_secs', '1', 0)",
  );
  return { host, storage };
}

it('an uploaded text file is indexed by the resident worker without manual calls; unload stops it', async () => {
  const embeddingCalls: string[][] = [];
  const tracked = trackedSleep();
  const { host, storage } = await setup({ embeddingCalls, sleep: tracked.sleep });
  const body = 'Photosynthesis converts light energy into chemical energy stored in glucose molecules. '.repeat(4);
  const uploaded = await host.invoke<{ file: { id: string }; indexStatus?: { queued: boolean } }>('vfs_upload_file', {
    params: { name: 'bio.txt', mimeType: 'text/plain', base64Content: Buffer.from(body).toString('base64') },
  });
  expect(uploaded.indexStatus?.queued).toBe(true);
  const db = storage.database('vfs');
  const resourceId = db.pluck<string>('SELECT resource_id FROM files WHERE id = ?1', [uploaded.file.id])!;
  expect(db.pluck('SELECT index_state FROM resources WHERE id = ?1', [resourceId])).toBe('pending');

  await storage.runStartupFinalizers();
  await vi.waitFor(() => {
    expect(db.pluck('SELECT index_state FROM resources WHERE id = ?1', [resourceId])).toBe('indexed');
  }, { timeout: 30_000, interval: 100 });
  expect(db.pluck('SELECT index_error FROM resources WHERE id = ?1', [resourceId])).toBeNull();
  expect(embeddingCalls.flat().join(' ')).toContain('Photosynthesis');

  await host.dispose();
  expect(tracked.pending()).toBe(0);
  const callsAfterDispose = tracked.calls();
  const embeddingsAfterDispose = embeddingCalls.length;
  await new Promise(resolve => setTimeout(resolve, 600));
  expect(tracked.calls()).toBe(callsAfterDispose);
  expect(embeddingCalls.length).toBe(embeddingsAfterDispose);
}, 90_000);

it.each([
  ['times out', async () => false,
    '[VfsIndexWorker] startup gate was not marked ready within 120 s; starting the worker anyway'],
  ['rejects', async () => { throw new Error('gate torn down'); },
    '[VfsIndexWorker] failed while waiting for startup gate: gate torn down; starting the worker anyway'],
])('the worker still starts when the startup gate %s (Rust starts it unconditionally, lib.rs:3535)',
  async (_case, waitStartupReady, warning) => {
    const embeddingCalls: string[][] = [];
    const warnings: string[] = [];
    const { host, storage } = await setup({
      embeddingCalls, sleep: trackedSleep().sleep, warnings, provide: { startupGate: { waitStartupReady } },
    });
    const body = 'Chlorophyll absorbs mostly blue and red wavelengths of visible light. '.repeat(4);
    const uploaded = await host.invoke<{ file: { id: string } }>('vfs_upload_file', {
      params: { name: 'leaf.txt', mimeType: 'text/plain', base64Content: Buffer.from(body).toString('base64') },
    });
    const db = storage.database('vfs');
    const resourceId = db.pluck<string>('SELECT resource_id FROM files WHERE id = ?1', [uploaded.file.id])!;
    await storage.runStartupFinalizers();
    await vi.waitFor(() => {
      expect(db.pluck('SELECT index_state FROM resources WHERE id = ?1', [resourceId])).toBe('indexed');
    }, { timeout: 30_000, interval: 100 });
    expect(warnings).toContain(warning);
  }, 90_000);

it('a storage maintenance barrier on vfs pauses the worker until release', async () => {
  const embeddingCalls: string[][] = [];
  const tracked = trackedSleep();
  const warnings: string[] = [];
  const { host, storage } = await setup({ embeddingCalls, sleep: tracked.sleep, warnings });
  const body = 'Mitochondria produce adenosine triphosphate through oxidative phosphorylation. '.repeat(4);
  const uploaded = await host.invoke<{ file: { id: string } }>('vfs_upload_file', {
    params: { name: 'cell.txt', mimeType: 'text/plain', base64Content: Buffer.from(body).toString('base64') },
  });
  const db = storage.database('vfs');
  const resourceId = db.pluck<string>('SELECT resource_id FROM files WHERE id = ?1', [uploaded.file.id])!;
  const lease = await storage.enterMaintenance(['vfs']);
  await storage.runStartupFinalizers();
  await new Promise(resolve => setTimeout(resolve, 1_500));
  expect(embeddingCalls).toEqual([]);
  // Only the one-shot requeue (Rust: warn and continue) touches the barred DB; no batch is attempted.
  expect(warnings.filter(line => line.includes('[VfsIndexWorker]'))).toEqual([
    '[VfsIndexWorker] Paged PDF requeue migration failed: Database error: Database vfs is in maintenance mode',
  ]);
  lease.release();
  await vi.waitFor(() => {
    expect(storage.database('vfs').pluck('SELECT index_state FROM resources WHERE id = ?1', [resourceId]))
      .toBe('indexed');
  }, { timeout: 30_000, interval: 100 });
  expect(embeddingCalls.flat().join(' ')).toContain('Mitochondria');
}, 90_000);

it('config indexWorker.enabled=false never starts the loop', async () => {
  const embeddingCalls: string[][] = [];
  const tracked = trackedSleep();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-index-worker-off-'));
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  cleanup.push(() => storage.dispose());
  expect((await storage.migrations.runAll()).success).toBe(true);
  const host = await createTestHost({
    plugins: [pathsPlugin, reposPlugin, vectorPlugin, [plugin, { indexWorker: { enabled: false, sleep: tracked.sleep } }]],
    provide: { storage, settings: { get: () => null } },
    app: { dataDir: root },
  });
  cleanup.push(() => host.dispose());
  await storage.runStartupFinalizers();
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(tracked.calls()).toBe(0);
  expect(embeddingCalls).toEqual([]);
}, 60_000);
