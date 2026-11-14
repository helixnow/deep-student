// `mm_index_progress`：Rust 的 vfs_multimodal_index / vfs_multimodal_index_resource（handlers.rs:6105, 6447）
// 把 VfsMultimodalService 的 IndexProgressEvent（dstu-llm multimodal/types.rs:308，serde camelCase）原样转发给前端
// （src/features/learning-hub/views/IndexStatusView.tsx、IndexStatusMiniBar.tsx 监听）。
// 发送点与文案：multimodal_service.rs:446-468（嵌入进度转发）、:835-841（saving）、:1450-1592（by-source 的
// preparing / completed / failed|pending），嵌入进度文案来自 embedding_service.rs:273-345。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { testFiles } from './support/files.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import plugin from '../index.ts';
// boundary-allow cross-plugin-impl: real table-owner repositories exercised through the production service
import reposPlugin from '../../vfs-repos/index.ts';
import type { VfsIndexService, VfsLanceStore } from '../api.ts';
import type { MultimodalInput, VfsMultimodalPage } from '../src/multimodal.ts';
import type { VfsIndexProfile as OwnerProfile, VfsReposService } from '../../vfs-repos/api.ts';
import type { VfsIndexProfile } from '../repository/embedding-dim.ts';
import { MM_INDEX_PROGRESS_EVENT, VfsMultimodalService, type IndexProgressEvent, type MultimodalModelConfig } from '../src/multimodal-service.ts';
import { bindVfsTableOwners } from '../repository/owners.ts';
import { pathsServiceDouble } from './support/paths-service.ts';

type TestStorage = ReturnType<typeof createStorageService>;

let templateDir = '';
const roots: string[] = [];
const storages: TestStorage[] = [];
const hosts: TestHost[] = [];

beforeAll(async () => {
  templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-mm-progress-template-'));
  const storage = createStorageService({ baseDir: templateDir, dataLocalDir: path.join(templateDir, 'local') });
  try {
    const report = await storage.migrations.runAll();
    if (!report.success) throw new Error(report.error ?? 'vfs migration failed');
  } finally {
    storage.dispose();
  }
}, 180_000);

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.dispose();
  while (storages.length > 0) storages.pop()!.dispose();
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

async function harness() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-mm-progress-'));
  roots.push(base);
  fs.cpSync(templateDir, base, { recursive: true });
  const storage = createStorageService({ baseDir: base, dataLocalDir: path.join(base, 'local') });
  storages.push(storage);
  const host = await createTestHost({ plugins: [reposPlugin, plugin], provide: { files: testFiles(storage),  storage, paths: pathsServiceDouble() } });
  hosts.push(host);
  const db = storage.database('vfs');
  const repositories = host.ctx.get('vfsRepo') as VfsReposService;
  bindVfsTableOwners(db, repositories);
  return { host, db, blobsDir: path.join(base, 'vfs_blobs'), repositories };
}

function ownerProfile(profile: OwnerProfile): VfsIndexProfile {
  return {
    id: profile.id, model_fingerprint: profile.modelFingerprint, model_config_id: profile.modelConfigId,
    model_name: profile.modelName, dimension: profile.dimension, modality: profile.modality,
    embedding_protocol: profile.embeddingProtocol, schema_version: profile.schemaVersion,
    lance_table_name: profile.lanceTableName, active_generation: profile.activeGeneration, state: profile.state,
    ann_metric: profile.annMetric, ann_index_version: profile.annIndexVersion,
    created_at: profile.createdAt, updated_at: profile.updatedAt,
  };
}

function fakeStore(db: DatabaseHandle, repositories: VfsReposService): VfsLanceStore {
  let generation = 0;
  return {
    ensureModelProfileWithFingerprint(modality: string, dimension: number, modelConfigId: string, modelName: string | null | undefined, fingerprint: string): VfsIndexProfile {
      const registered = repositories.embeddingDims.registerWithModelFingerprint(db, dimension, modality, modelConfigId, modelName ?? null, fingerprint);
      const profile = repositories.embeddingDims.getProfileById(db, registered.activeProfileId!);
      return ownerProfile(profile!);
    },
    nextUnitGeneration: () => ++generation,
    writeChunks: async () => {},
    deleteByUnitExceptIds: async () => 0,
    deleteByResourceExceptDim: async () => 0,
    deleteByResource: async () => 0,
    discardUncommittedRows: async () => {},
  } as unknown as VfsLanceStore;
}

const CONFIG: MultimodalModelConfig = {
  id: 'vl-embed', model: 'vl-embed-model', baseUrl: 'https://example.invalid/v1', providerType: 'openai',
  providerScope: 'official', apiProtocol: 'openai_chat_completions', modelAdapter: 'openai',
};

function embedding(fail?: string) {
  return {
    isConfigured: async () => true,
    getModelConfig: async () => ({ ...CONFIG }),
    async embed(inputs: readonly MultimodalInput[]) {
      if (fail) throw new Error(fail);
      return inputs.map(() => new Array<number>(64).fill(0.25));
    },
  };
}

/** 生产由 `ctx.files.readBytes` 提供；测试直接走 Node 的测试夹具文件。 */
const readBytes = async (file: string): Promise<Uint8Array> => new Uint8Array(fs.readFileSync(file));

function service(db: DatabaseHandle, blobsDir: string, repositories: VfsReposService, events: IndexProgressEvent[] | undefined, fail?: string) {
  return new VfsMultimodalService({
    readBytes, db, blobsDir, lanceStore: fakeStore(db, repositories),
    backend: { searchMultimodal: async () => { throw new Error('not used'); } },
    embedding: embedding(fail), repositories: () => repositories,
    ...(events ? { events: { emit: (channel: string, payload: unknown) => { expect(channel).toBe(MM_INDEX_PROGRESS_EVENT); events.push(payload as IndexProgressEvent); } } } : {}),
  });
}

function insertResource(db: DatabaseHandle, id: string, type: string): void {
  db.run(`INSERT INTO resources (id, hash, type, storage_mode, data, created_at, updated_at, mm_index_state)
    VALUES (?1, ?2, ?3, 'external', NULL, 1, 1, 'pending')`, [id, `hash_${id}`, type]);
}

function inlinePage(index: number): VfsMultimodalPage {
  return { page_index: index, image_base64: Buffer.from(`page ${index}`).toString('base64'), image_mime: 'image/png', text_content: null, blob_hash: null };
}

function insertPreviewFile(db: DatabaseHandle, blobsDir: string, repositories: VfsReposService, fileId: string, resourceId: string, pageCount: number): void {
  insertResource(db, resourceId, 'textbook');
  const pages = Array.from({ length: pageCount }, (_, i) => {
    const blob = repositories.blobs.storeBlob(db, blobsDir, new Uint8Array(Buffer.from(`preview ${i}`)), 'image/png');
    return { pageIndex: i, blobHash: blob.hash, width: 10, height: 10, mimeType: 'image/png' };
  });
  const previewJson = JSON.stringify({ pages, renderDpi: 150, totalPages: pageCount, renderedAt: '2026-01-01T00:00:00.000Z' });
  db.run(`INSERT INTO files (id, resource_id, sha256, file_name, size, "type", mime_type, status, created_at, updated_at, preview_json, mm_index_state)
    VALUES (?1, ?2, 'sha', 'book.pdf', 20, 'textbook', 'application/pdf', 'active', 1, 1, ?3, 'pending')`, [fileId, resourceId, previewJson]);
}

/** IndexProgressEvent::new(..).with_phase(..).with_progress(..) */
const ev = (sourceType: string, sourceId: string, totalPages: number, phase: string, message: string, currentPage: number, indexedPages: number, skippedPages: number): IndexProgressEvent => ({
  sourceType, sourceId, phase, currentPage, totalPages, indexedPages, skippedPages,
  progressPercent: totalPages > 0 ? Math.trunc((currentPage / totalPages) * 100) : 0, message,
});

describe('mm_index_progress (Rust vfs_multimodal_index*)', () => {
  it('page indexing relays per-chunk embedding progress (8-page read batches) and a final saving event', async () => {
    const { db, blobsDir, repositories } = await harness();
    insertResource(db, 'res_pages', 'textbook');
    const events: IndexProgressEvent[] = [];
    const result = await service(db, blobsDir, repositories, events)
      .indexResourcePages('res_pages', 'textbook', null, Array.from({ length: 10 }, (_, i) => inlinePage(i)));
    expect(result.indexed_pages).toBe(10);
    const e = (...a: [string, string, number, number]) => ev('textbook', 'res_pages', 10, a[0], a[1], a[2], a[3], 0);
    expect(events).toEqual([
      e('embedding', '开始多模态嵌入: 0/8', 0, 0),
      e('embedding', '多模态嵌入进度: 8/8', 8, 8),
      e('embedding', '多模态嵌入完成: 8/8', 8, 8),
      e('embedding', '开始多模态嵌入: 0/2', 8, 8),
      e('embedding', '多模态嵌入进度: 2/2', 10, 10),
      e('embedding', '多模态嵌入完成: 2/2', 10, 10),
      e('saving', '正在保存索引...', 10, 10),
    ]);
  });

  it('by-source indexing wraps the page events with preparing/completed keyed by the source id', async () => {
    const { db, blobsDir, repositories } = await harness();
    insertPreviewFile(db, blobsDir, repositories, 'file_ok', 'res_ok', 2);
    const events: IndexProgressEvent[] = [];
    await service(db, blobsDir, repositories, events).indexResourceBySource('textbook', 'file_ok', null);
    // Inner page events carry the VFS resource id (index_resource_pages_with_options(&resource_id, source_type, ..)).
    const inner = (phase: string, message: string, current: number, indexed: number) => ev('textbook', 'res_ok', 2, phase, message, current, indexed, 0);
    expect(events).toEqual([
      ev('textbook', 'file_ok', 2, 'preparing', '准备多模态索引...', 0, 0, 0),
      inner('embedding', '开始多模态嵌入: 0/2', 0, 0),
      inner('embedding', '多模态嵌入进度: 2/2', 2, 2),
      inner('embedding', '多模态嵌入完成: 2/2', 2, 2),
      inner('saving', '正在保存索引...', 2, 2),
      ev('textbook', 'file_ok', 2, 'completed', '索引完成: 2 页', 2, 2, 0),
    ]);
  });

  it('by-source with no indexable pages reports preparing then completed "无可索引内容"', async () => {
    const { db, blobsDir, repositories } = await harness();
    insertPreviewFile(db, blobsDir, repositories, 'file_empty', 'res_empty', 0);
    const events: IndexProgressEvent[] = [];
    await service(db, blobsDir, repositories, events).indexResourceBySource('textbook', 'file_empty', null);
    expect(events).toEqual([
      ev('textbook', 'file_empty', 0, 'preparing', '准备多模态索引...', 0, 0, 0),
      ev('textbook', 'file_empty', 0, 'completed', '无可索引内容', 0, 0, 0),
    ]);
  });

  it('by-source failure reports phase failed with the error text after the business state update', async () => {
    const { db, blobsDir, repositories } = await harness();
    insertPreviewFile(db, blobsDir, repositories, 'file_bad', 'res_bad', 1);
    const events: IndexProgressEvent[] = [];
    await expect(service(db, blobsDir, repositories, events, 'boom').indexResourceBySource('textbook', 'file_bad', null))
      .rejects.toThrow('多模态嵌入生成失败: boom');
    expect(events).toEqual([
      ev('textbook', 'file_bad', 1, 'preparing', '准备多模态索引...', 0, 0, 0),
      ev('textbook', 'res_bad', 1, 'embedding', '开始多模态嵌入: 0/1', 0, 0, 0),
      ev('textbook', 'file_bad', 1, 'failed', '多模态嵌入生成失败: boom', 0, 0, 0),
    ]);
    expect(db.pluck<unknown>("SELECT mm_index_state FROM files WHERE id = 'file_bad'")).toBe('failed');
  });

  it('without an event sink nothing is emitted (batch path parity with Rust progress_tx = None)', async () => {
    const { db, blobsDir, repositories } = await harness();
    insertResource(db, 'res_quiet', 'textbook');
    await expect(service(db, blobsDir, repositories, undefined).indexResourcePages('res_quiet', 'textbook', null, [inlinePage(0)]))
      .resolves.toMatchObject({ indexed_pages: 1 });
  });

  it('the installed plugin emits mm_index_progress through backend events', async () => {
    const { host, db, blobsDir, repositories } = await harness();
    insertPreviewFile(db, blobsDir, repositories, 'file_plugin', 'res_plugin', 1);
    const vfsIndex = host.ctx.get('vfsIndex') as VfsIndexService;
    // No L02 multimodal model in this host: Rust also emits preparing, then failed with the is_configured message.
    await expect(vfsIndex.multimodal.indexResourceBySource('textbook', 'file_plugin', null)).rejects.toThrow('还没有启用多模态索引');
    const emitted = host.eventsNamed(MM_INDEX_PROGRESS_EVENT) as IndexProgressEvent[];
    expect(emitted.map((e) => [e.phase, e.sourceId])).toEqual([['preparing', 'file_plugin'], ['failed', 'file_plugin']]);
    expect(emitted[1]!.message).toMatch(/^还没有启用多模态索引/);
  });
});
