import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../../../kernel/agent-api.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
// boundary-allow cross-plugin-impl: 测试宿主使用 L11/L12 的真实仓储与 unit builder，验证网页写入真实 VFS 状态
import { BlobRepo } from '../../vfs-repos/repository/blobs.ts';
// boundary-allow cross-plugin-impl: 测试宿主使用 L11/L12 的真实仓储与 unit builder，验证网页写入真实 VFS 状态
import { FileRepo } from '../../vfs-repos/repository/files.ts';
// boundary-allow cross-plugin-impl: 测试宿主使用 L11/L12 的真实仓储与 unit builder，验证网页写入真实 VFS 状态
import { FolderRepo } from '../../vfs-repos/repository/folders.ts';
// boundary-allow cross-plugin-impl: 测试宿主使用 L11/L12 的真实仓储与 unit builder，验证网页写入真实 VFS 状态
import { ResourceRepo } from '../../vfs-repos/repository/resources.ts';
// boundary-allow cross-plugin-impl: 测试宿主使用 L11/L12 的真实仓储与 unit builder，验证网页写入真实 VFS 状态
import { IndexUnitRepo } from '../../vfs-repos/repository/index-units.ts';
// boundary-allow cross-plugin-impl: 测试宿主使用 L11/L12 的真实仓储与 unit builder，验证网页写入真实 VFS 状态
import { IndexSegmentRepo } from '../../vfs-repos/repository/index-segments.ts';
// boundary-allow cross-plugin-impl: 测试宿主使用 L11/L12 的真实仓储与 unit builder，验证网页写入真实 VFS 状态
import { IndexStateRepo } from '../../vfs-repos/repository/embedding-repo.ts';
// boundary-allow cross-plugin-impl: 测试宿主使用 L11/L12 的真实仓储与 unit builder，验证网页写入真实 VFS 状态
import { MediaTranscriptRepo } from '../../vfs-repos/repository/media-transcripts.ts';
// boundary-allow cross-plugin-impl: 测试宿主使用 L11/L12 的真实仓储与 unit builder，验证网页写入真实 VFS 状态
import { VfsUnitIndexService } from '../../vfs-index/src/unit-sync-service.ts';
import { IndexWebpageToolExecutor } from '../src/index-webpage-executor.ts';
import { formatWebpageMarkdown } from '../src/index-webpage.ts';

type Storage = ReturnType<typeof createStorageService>;

const storages: Storage[] = [];
const directories: string[] = [];
let templateDir = '';

beforeAll(async () => {
  templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-index-template-'));
  const storage = createStorageService({
    baseDir: templateDir,
    dataLocalDir: path.join(templateDir, 'local'),
  });
  const report = await storage.migrations.runAll();
  if (!report.success) throw new Error('VFS migration failed');
  storage.dispose();
}, 180_000);

afterEach(() => {
  while (storages.length > 0) storages.pop()!.dispose();
  while (directories.length > 0) fs.rmSync(directories.pop()!, { recursive: true, force: true });
});

interface Harness {
  conn: DatabaseHandle;
  blobsDir: string;
  executor: IndexWebpageToolExecutor;
  events: Array<[string, unknown]>;
}

function harness(): Harness {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-index-'));
  fs.cpSync(templateDir, base, { recursive: true });
  const storage = createStorageService({ baseDir: base, dataLocalDir: path.join(base, 'local') });
  storages.push(storage);
  directories.push(base);
  const conn = storage.database('vfs');
  const blobsDir = path.join(storage.locations.activeDir, 'vfs_blobs');
  fs.mkdirSync(blobsDir, { recursive: true });
  const files = new FileRepo();
  const blobs = new BlobRepo();
  const folders = new FolderRepo();
  const resources = new ResourceRepo();
  const embeddingUnits = new IndexUnitRepo();
  const embeddingSegments = new IndexSegmentRepo();
  const indexStates = new IndexStateRepo();
  const mediaTranscripts = new MediaTranscriptRepo();
  const repos = {
    files, blobs, folders, resources, embeddingUnits, embeddingSegments, indexStates, mediaTranscripts,
  } as unknown as VfsReposService;
  const unitBuilder = new VfsUnitIndexService({
    database: conn,
    repositories: () => repos,
  });
  const events: Array<[string, unknown]> = [];
  const executor = new IndexWebpageToolExecutor({
    connection: () => conn,
    blobsDir: () => blobsDir,
    repos: () => repos,
    unitBuilder: () => unitBuilder,
    indexing: () => null,
    statusSummary: () => null,
  });
  return { conn, blobsDir, executor, events };
}

function context(events: Array<[string, unknown]>): ExecutionContext {
  return {
    ids: { sessionId: 'session-1', messageId: 'message-1', blockId: 'block-1', toolCallId: 'call-1', round: 0 },
    host: {
      hasFrontend: () => true,
      emit: (event: string, payload: unknown) => { events.push([event, payload]); },
    },
    isCancelled: () => false,
  } as unknown as ExecutionContext;
}

function call(name: string, args: Record<string, unknown>) {
  return { id: 'call-1', name, arguments: args };
}

describe('IndexWebpageToolExecutor production execute', () => {
  it('persists webpage_save into the real VFS and deduplicates by content hash', async () => {
    const { conn, executor, events } = harness();
    const ctx = context(events);
    const args = {
      url: 'https://1.1.1.1/reference',
      title: 'Reference',
      content: 'Persisted webpage body',
      content_type: 'text/html',
    };
    const first = await executor.execute(call('builtin-webpage_save', args), ctx);
    expect(first.success).toBe(true);
    const output = first.output as Record<string, unknown>;
    expect(output.disposition).toBe('created');
    expect(output.unitsCreated as number).toBeGreaterThan(0);
    expect(output.fileId).toEqual(expect.any(String));
    expect(output.resourceId).toEqual(expect.any(String));

    const file = new FileRepo().getFile(conn, String(output.fileId))!;
    expect(file.extractedText).toBe(formatWebpageMarkdown(
      'Reference', 'https://1.1.1.1/reference', 'Persisted webpage body',
    ));
    expect(file.blobHash).toBeTruthy();
    const resource = new ResourceRepo().getResource(conn, String(output.resourceId))!;
    expect(resource.metadata?.source).toBe('https://1.1.1.1/reference');
    const state = new IndexStateRepo().getIndexState(conn, String(output.resourceId));
    expect(state?.state).toBe('pending');
    expect(events.some(([event]) => event === 'dstu:change')).toBe(true);
    expect(events.some(([event]) => event.startsWith('dstu:change:'))).toBe(true);

    const duplicate = await executor.execute(call('builtin-webpage_save', args), ctx);
    expect(duplicate.success).toBe(true);
    expect((duplicate.output as Record<string, unknown>).disposition).toBe('deduplicated');
    expect((duplicate.output as Record<string, unknown>).fileId).toBe(output.fileId);
    expect((duplicate.output as Record<string, unknown>).deduplicated).toBe(true);
  });

  it('restores a soft-deleted identical webpage with its blob intact', async () => {
    const { conn, executor, events } = harness();
    const ctx = context(events);
    const args = {
      url: 'https://1.1.1.1/restored',
      title: 'Restored',
      content: 'Restorable webpage body',
    };
    const first = await executor.execute(call('builtin-webpage_save', args), ctx);
    expect(first.success).toBe(true);
    const fileId = String((first.output as Record<string, unknown>).fileId);

    new FileRepo().deleteFile(conn, fileId);
    const restored = await executor.execute(call('builtin-webpage_save', args), ctx);
    expect(restored.success, String(restored.error)).toBe(true);
    expect((restored.output as Record<string, unknown>).disposition).toBe('restored');
    expect((restored.output as Record<string, unknown>).fileId).toBe(fileId);

    const file = new FileRepo().getFile(conn, fileId)!;
    expect(file.status).toBe('active');
    expect(file.blobHash).toBeTruthy();
    expect(new BlobRepo().blobExists(conn, file.blobHash!)).toBe(true);
  });

  it('returns the structured INCOMPLETE_WEB_FETCH error before any VFS write', async () => {
    const { executor, events } = harness();
    const result = await executor.execute(call('builtin-webpage_save', {
      url: 'https://1.1.1.1/reference',
      content: 'body <truncated>Content truncated.',
    }), context(events));
    expect(result.success).toBe(false);
    const error = JSON.parse(String(result.error)) as Record<string, unknown>;
    expect(error.code).toBe('INCOMPLETE_WEB_FETCH');
    expect(error.retryable).toBe(false);
  });

  it('rebuild_unit_test_boundary_stops_before_llm_lance_and_window_dependencies', async () => {
    const { executor, events } = harness();
    const result = await executor.execute(call('builtin-index_rebuild', {
      resource_id: 'res_missing',
    }), context(events));
    expect(result.success).toBe(false);
    const error = JSON.parse(String(result.error)) as Record<string, unknown>;
    expect(error.code).toBe('RESOURCE_NOT_FOUND');
    expect(error.retryable).toBe(false);
  });

  it('reports an unavailable status service during startup without inventing a second VFS summary', async () => {
    const { executor, events } = harness();
    const result = await executor.execute(call('builtin-index_status', {}), context(events));
    expect(result.success).toBe(false);
    const error = JSON.parse(String(result.error)) as Record<string, unknown>;
    expect(error.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(String(error.message)).toContain('get_status_summary');
  });
});
