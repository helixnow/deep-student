import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { ExecutionContext } from '../../../kernel/agent-api.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import skillsPlugin from '../../agent-skills/index.ts';
import notesPlugin from '../../notes/index.ts';
import vfsPlugin from '../../vfs/index.ts';
import reposPlugin from '../../vfs-repos/index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import browserPlugin from '../index.ts';
import { IndexWebpageToolExecutor } from '../src/index-webpage-executor.ts';
import { formatWebpageMarkdown } from '../src/index-webpage.ts';
import { f3FeatureFlags } from './support/f3-feature-flags.ts';

type Storage = ReturnType<typeof createStorageService>;
let templateDir = '';
const roots: string[] = [];
const storages: Storage[] = [];
const hosts: TestHost[] = [];

beforeAll(async () => {
  templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-status-template-'));
  const storage = createStorageService({ baseDir: templateDir, dataLocalDir: path.join(templateDir, 'local') });
  try {
    const report = await storage.migrations.runAll();
    if (!report.success) throw new Error(report.error ?? 'VFS migration failed');
  } finally { storage.dispose(); }
}, 180_000);

afterAll(() => { if (templateDir) fs.rmSync(templateDir, { recursive: true, force: true }); });

afterEach(async () => {
  while (hosts.length) await hosts.pop()!.dispose();
  while (storages.length) storages.pop()!.dispose();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

async function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-status-'));
  roots.push(root);
  fs.cpSync(templateDir, root, { recursive: true });
  const storage = createStorageService({ baseDir: root, dataLocalDir: path.join(root, 'local') });
  storages.push(storage);
  const values = new Map<string, string>();
  const settings = {
    get: (key: string) => values.get(key) ?? null,
    save: (key: string, value: string) => { values.set(key, value); },
    delete: (key: string) => values.delete(key),
    listByPrefix: () => [], deleteByPrefix: () => 0,
    getSecret: async () => null, saveSecret: async () => undefined, deleteSecret: async () => false,
  };
  const host = await createTestHost({
    plugins: [pathsPlugin, reposPlugin, notesPlugin, indexPlugin, vfsPlugin, skillsPlugin, browserPlugin],
    provide: { storage, settings, featureFlags: f3FeatureFlags, log: { logger: () => undefined } },
    app: { dataDir: root, version: '0.11.0' },
  });
  hosts.push(host);
  const executor = host.ctx.agentTools.toolExecutors().find(item => item.name() === 'IndexWebpageToolExecutor');
  if (!(executor instanceof IndexWebpageToolExecutor)) throw new Error('browser plugin did not register IndexWebpageToolExecutor');
  return { host, storage, executor };
}

function context(host: TestHost, isCancelled = () => false): ExecutionContext {
  return {
    ids: { sessionId: 'session-1', messageId: 'message-1', blockId: 'block-1', toolCallId: 'call-1', round: 0 },
    host: { hasFrontend: () => true, emit: (event: string, payload: unknown) => { host.ctx.backendEvents.emit(event, payload); } },
    isCancelled,
  } as unknown as ExecutionContext;
}

function execute(executor: IndexWebpageToolExecutor, host: TestHost, name: string, args: Record<string, unknown>, ctx = context(host)) {
  return executor.execute({ id: 'call-1', name, arguments: args }, ctx);
}

describe('IndexWebpageToolExecutor via browser registration + published L12/L11 services', () => {
  it('webpage_persistence_status_and_rebuild_preflight_use_real_vfs_state', async () => {
    const { host, storage, executor } = await harness();
    const url = 'https://example.com/reference';
    const args = { url, title: 'Reference', content: 'Persisted webpage body', content_type: 'text/html' };
    const saved = await execute(executor, host, 'builtin-webpage_save', args);
    expect(saved.success, String(saved.error)).toBe(true);
    const output = saved.output as Record<string, unknown>;
    expect(output.disposition).toBe('created'); // Rust :1335 Created
    expect(output.unitsCreated).toBeGreaterThan(0); // :1336
    const conn = storage.database('vfs');
    const file = host.ctx.vfsRepo.files.getFile(conn, String(output.fileId))!;
    expect(file.extractedText).toBe(formatWebpageMarkdown('Reference', url, args.content)); // :1340
    expect(file.blobHash).toBeTruthy(); // :1341
    const resource = host.ctx.vfsRepo.resources.getResource(conn, String(output.resourceId))!;
    expect(resource.metadata?.source).toBe(url); // :1346-1352
    expect(host.ctx.vfsRepo.indexStates.getIndexState(conn, resource.id)?.state).toBe('pending'); // :1356

    const status = await execute(executor, host, 'builtin-index_status', {});
    expect(status.success, String(status.error)).toBe(true);
    const summary = (status.output as Record<string, unknown>).summary as { totalUnits: number };
    expect(summary.totalUnits).toBeGreaterThanOrEqual(Number(output.unitsCreated)); // :1360
    expect(summary).toEqual(host.ctx.vfsIndex.getStatusSummary!());
    expect(status.output).toMatchObject({ scope: 'all', units: [], page: 1, pageSize: 20, totalUnits: 0, hasMore: false });

    // Exercise the real target lookup, then cancel before embeddings/Lance/window work.
    let cancellationChecks = 0;
    const preflight = await execute(executor, host, 'builtin-index_rebuild', { resource_id: resource.id },
      context(host, () => ++cancellationChecks === 2));
    expect(preflight.success).toBe(false);
    expect(JSON.parse(String(preflight.error))).toMatchObject({
      // Rust tool_error localizes CANCELLED through tool_error_zh_message (:1187).
      code: 'CANCELLED', message: '操作已在写入前取消。 / Index rebuild was cancelled after target validation, before any index mutation.',
    }); // :1361-1362 ensure_rebuild_target succeeds, before downstream dependencies

    const duplicate = await execute(executor, host, 'builtin-webpage_save', args);
    expect(duplicate.success, String(duplicate.error)).toBe(true);
    expect(duplicate.output).toMatchObject({ disposition: 'deduplicated' }); // :1366 Existing
    expect((duplicate.output as Record<string, unknown>).fileId).toBe(output.fileId); // :1367

    const perResource = await execute(executor, host, 'builtin-index_status', { resource_id: resource.id });
    expect(perResource.success, String(perResource.error)).toBe(true);
    expect(perResource.output).toMatchObject({ summary, resourceId: resource.id, totalUnits: output.unitsCreated });
  });

  it('maps a real summary read failure to INDEX_STATUS_FAILED before resource lookup (Rust :78-81)', async () => {
    const { host, storage, executor } = await harness();
    // Close the real owner connection rather than replacing getStatusSummary with a throwing fake.
    storage.dispose();
    const result = await execute(executor, host, 'builtin-index_status', { resource_id: 'res_missing' });
    expect(result.success).toBe(false);
    expect(JSON.parse(String(result.error))).toMatchObject({ code: 'INDEX_STATUS_FAILED', retryable: true });
  });
});
