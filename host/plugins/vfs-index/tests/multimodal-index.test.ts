import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { testFiles } from './support/files.ts';

/** 生产由 `ctx.files.readBytes` 提供；测试直接走 Node 的测试夹具文件。 */
const readBytes = async (file: string): Promise<Uint8Array> => new Uint8Array(fs.readFileSync(file));
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import plugin from '../index.ts';
// boundary-allow cross-plugin-impl: real table-owner repositories exercised through the production service
import reposPlugin from '../../vfs-repos/index.ts';
import type { VfsLanceRow, VfsLanceStore } from '../api.ts';
import type { VfsMultimodalPage } from '../src/multimodal.ts';
import type { VfsIndexProfile as OwnerProfile } from '../../vfs-repos/api.ts';
import type { VfsIndexProfile } from '../repository/embedding-dim.ts';
import { VfsMultimodalService, type MultimodalModelConfig } from '../src/multimodal-service.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import { bindVfsTableOwners } from '../repository/owners.ts';
import { pathsServiceDouble } from './support/paths-service.ts';

type TestStorage = ReturnType<typeof createStorageService>;

interface Harness {
  host: TestHost;
  db: DatabaseHandle;
  base: string;
  storage: TestStorage;
  repositories: VfsReposService;
}

let templateDir = '';
const roots: string[] = [];
const storages: TestStorage[] = [];
const hosts: TestHost[] = [];

beforeAll(async () => {
  templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-mm-index-template-'));
  const storage = createStorageService({
    baseDir: templateDir,
    dataLocalDir: path.join(templateDir, 'local'),
  });
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

async function harness(): Promise<Harness> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-mm-index-'));
  roots.push(base);
  fs.cpSync(templateDir, base, { recursive: true });
  const storage = createStorageService({ baseDir: base, dataLocalDir: path.join(base, 'local') });
  storages.push(storage);
  const host = await createTestHost({
    plugins: [reposPlugin, plugin],
    provide: { files: testFiles(storage),  storage, paths: pathsServiceDouble() },
  });
  hosts.push(host);
  const db = storage.database('vfs');
  // The formal L11 provider installed in this host, bound to the same vfs handle.
  const repositories = host.ctx.get('vfsRepo') as VfsReposService;
  bindVfsTableOwners(db, repositories);
  return {
    host,
    db,
    base,
    storage,
    repositories,
  };
}

function ownerProfile(profile: OwnerProfile): VfsIndexProfile {
  return {
    id: profile.id,
    model_fingerprint: profile.modelFingerprint,
    model_config_id: profile.modelConfigId,
    model_name: profile.modelName,
    dimension: profile.dimension,
    modality: profile.modality,
    embedding_protocol: profile.embeddingProtocol,
    schema_version: profile.schemaVersion,
    lance_table_name: profile.lanceTableName,
    active_generation: profile.activeGeneration,
    state: profile.state,
    ann_metric: profile.annMetric,
    ann_index_version: profile.annIndexVersion,
    created_at: profile.createdAt,
    updated_at: profile.updatedAt,
  };
}

interface FakeStore {
  store: VfsLanceStore;
  writes: VfsLanceRow[];
  deleted: string[];
}

/**
 * Real owner repositories drive profile registration/segment bookkeeping; only
 * the Lance transport is in-memory so the test can inspect the exact rows the
 * service would append.
 */
function fakeStore(db: DatabaseHandle, repositories: VfsReposService): FakeStore {
  const writes: VfsLanceRow[] = [];
  const deleted: string[] = [];
  let generation = 0;
  const store = {
    ensureModelProfileWithFingerprint(
      modality: string,
      dimension: number,
      modelConfigId: string,
      modelName: string | null | undefined,
      expectedFingerprint: string,
    ): VfsIndexProfile {
      const registered = repositories.embeddingDims.registerWithModelFingerprint(
        db, dimension, modality, modelConfigId, modelName ?? null, expectedFingerprint,
      );
      if (registered.activeProfileId === null) throw new Error('profile was not activated');
      const profile = repositories.embeddingDims.getProfileById(db, registered.activeProfileId);
      if (profile === null) throw new Error('profile row missing');
      return ownerProfile(profile);
    },
    nextUnitGeneration(): number {
      generation += 1;
      return generation;
    },
    async writeChunks(_modality: string, rows: readonly VfsLanceRow[]): Promise<void> {
      writes.push(...rows);
    },
    async deleteByUnitExceptIds(
      _modality: string, resourceId: string, unitId: string,
    ): Promise<number> {
      deleted.push(`unit:${resourceId}:${unitId}`);
      return 0;
    },
    async deleteByResourceExceptDim(
      _modality: string, resourceId: string,
    ): Promise<number> {
      deleted.push(`dim:${resourceId}`);
      return 0;
    },
    async deleteByResource(_modality: string, resourceId: string): Promise<number> {
      deleted.push(`resource:${resourceId}`);
      return 0;
    },
    async discardUncommittedRows(): Promise<void> {},
  } as unknown as VfsLanceStore;
  return { store, writes, deleted };
}

function embeddingCapability(inputsSeen: string[][]): {
  isConfigured: () => Promise<boolean>;
  getModelConfig: () => Promise<MultimodalModelConfig>;
  embed: (inputs: readonly import('../src/multimodal.ts').MultimodalInput[], modelId: string) => Promise<number[][]>;
} {
  const config: MultimodalModelConfig = {
    id: 'vl-embed',
    model: 'vl-embed-model',
    baseUrl: 'https://example.invalid/v1',
    providerType: 'openai',
    providerScope: 'official',
    apiProtocol: 'openai_chat_completions',
    modelAdapter: 'openai',
  };
  return {
    isConfigured: async () => true,
    getModelConfig: async () => ({ ...config }),
    async embed(inputs) {
      inputsSeen.push(inputs.map((input) => input.image?.kind === 'base64'
        ? input.image.data : ''));
      return inputs.map((_input, index) => [0.1 + index, ...new Array<number>(63).fill(0.2)]);
    },
  };
}

function insertResource(db: DatabaseHandle, id: string, type: string): void {
  db.run(
    `INSERT INTO resources (id, hash, type, storage_mode, data, created_at, updated_at,
       mm_index_state)
     VALUES (?1, ?2, ?3, 'external', NULL, 1, 1, 'pending')`,
    [id, `hash_${id}`, type],
  );
}

function page(index: number, content: string): VfsMultimodalPage {
  return {
    page_index: index,
    image_base64: Buffer.from(content).toString('base64'),
    image_mime: 'image/png',
    text_content: null,
    blob_hash: null,
  };
}

describe('Rust multimodal_service.rs page indexing', () => {
  it('R12-08 index_resource_by_source casts exact preview usize to i32 before creating units', async () => {
    const { db, base, repositories } = await harness();
    insertResource(db, 'res_large_page', 'textbook');
    const blobsDir = path.join(base, 'vfs_blobs');
    const blob = repositories.blobs.storeBlob(db, blobsDir, Buffer.from('large preview page'), 'image/png');
    const raw = `{"pages":[{"pageIndex":9007199254740993,"blobHash":"${blob.hash}","width":1,"height":1,"mimeType":"image/png"}],"renderDpi":150,"totalPages":18446744073709551615,"renderedAt":"recorded"}`;
    db.run(`INSERT INTO files (id, resource_id, sha256, file_name, size, type, mime_type, created_at, updated_at, preview_json)
      VALUES ('file_large_page', 'res_large_page', 'sha_large', 'book.pdf', 20, 'textbook', 'application/pdf', 1, 1, ?1)`, [raw]);
    const fake = fakeStore(db, repositories);
    const service = new VfsMultimodalService({ readBytes, db, blobsDir, lanceStore: fake.store,
      backend: { searchMultimodal: async () => { throw new Error('not used'); } },
      embedding: embeddingCapability([]), repositories: () => repositories });
    expect(await service.indexResourceBySource('textbook', 'file_large_page', null))
      .toEqual({ indexed_pages: 1, dimension: 64, failed_pages: [] });
    expect(repositories.embeddingUnits.getByResource(db, 'res_large_page').map(unit => unit.unitIndex)).toEqual([1]);
    expect(fake.writes.map(row => row.chunk_index)).toEqual([1]);
  });
  it('indexes pages through owner repositories, Lance transport and the segment ledger', async () => {
    const { db, base, repositories } = await harness();
    insertResource(db, 'res_mm_page', 'textbook');
    const inputsSeen: string[][] = [];
    const fake = fakeStore(db, repositories);
    const service = new VfsMultimodalService({
      readBytes,
      db,
      blobsDir: path.join(base, 'vfs_blobs'),
      backend: { searchMultimodal: async () => { throw new Error('not used'); } },
      lanceStore: fake.store,
      embedding: embeddingCapability(inputsSeen),
      repositories: () => repositories,
    });

    const result = await service.indexResourcePages(
      'res_mm_page', 'textbook', 'folder_1',
      [page(0, 'first page image'), page(1, 'second page image')],
    );

    expect(result).toEqual({ indexed_pages: 2, dimension: 64, failed_pages: [] });
    // One ME call for the whole batch, with the stored bytes (not the data URL prefix).
    expect(inputsSeen).toHaveLength(1);
    expect(inputsSeen[0]).toEqual([
      Buffer.from('first page image').toString('base64'),
      Buffer.from('second page image').toString('base64'),
    ]);
    expect(fake.writes).toHaveLength(2);
    const profile = repositories.embeddingDims.getActiveProfile(db, 64, 'multimodal');
    expect(profile).not.toBeNull();
    expect(fake.writes.map((row) => row.chunk_index)).toEqual([0, 1]);
    for (const row of fake.writes) {
      expect(row.resource_id).toBe('res_mm_page');
      expect(row.resource_type).toBe('textbook');
      expect(row.folder_id).toBe('folder_1');
      expect(row.index_profile_id).toBe(profile!.id);
      expect(row.embedding).toHaveLength(64);
      expect(JSON.parse(String(row.metadata_json))).toMatchObject({
        blob_hash: expect.any(String),
        unit_id: row.unit_id,
        index_profile_id: profile!.id,
        generation: row.generation,
      });
    }
    // Cleanup is deferred until after the SQLite ledger switched.
    expect(fake.deleted).toEqual(expect.arrayContaining([
      'unit:res_mm_page:' + fake.writes[0]!.unit_id,
      'unit:res_mm_page:' + fake.writes[1]!.unit_id,
      'dim:res_mm_page',
    ]));

    const units = repositories.embeddingUnits.getByResource(db, 'res_mm_page');
    expect(units).toHaveLength(2);
    for (const unit of units) {
      expect(unit.mmState).toBe('indexed');
      expect(unit.mmEmbeddingDim).toBe(64);
      expect(repositories.embeddingSegments.getByUnitAndModality(
        db, unit.id, 'multimodal',
      )).toHaveLength(1);
    }
    expect(db.pluck<unknown>(
      "SELECT mm_index_state FROM resources WHERE id = 'res_mm_page'",
    )).toBe('indexed');
    expect(db.pluck<unknown>(
      "SELECT record_count FROM vfs_embedding_dims WHERE dimension = 64 AND modality = 'multimodal'",
    )).toBe(2);
  });

  it('skips embedding when every page already has one active segment and forceRebuild is false', async () => {
    const { db, base, repositories } = await harness();
    insertResource(db, 'res_mm_idempotent', 'textbook');
    const inputsSeen: string[][] = [];
    const fake = fakeStore(db, repositories);
    const service = new VfsMultimodalService({
      readBytes,
      db,
      blobsDir: path.join(base, 'vfs_blobs'),
      backend: { searchMultimodal: async () => { throw new Error('not used'); } },
      lanceStore: fake.store,
      embedding: embeddingCapability(inputsSeen),
      repositories: () => repositories,
    });
    const pages = [page(0, 'only page')];

    await service.indexResourcePages('res_mm_idempotent', 'textbook', null, pages, true);
    const writesAfterFirst = fake.writes.length;
    const inputsAfterFirst = inputsSeen.length;

    const second = await service.indexResourcePages(
      'res_mm_idempotent', 'textbook', null, pages, false,
    );

    expect(second).toEqual({ indexed_pages: 1, dimension: 64, failed_pages: [] });
    expect(inputsSeen).toHaveLength(inputsAfterFirst);
    expect(fake.writes).toHaveLength(writesAfterFirst);
    expect(db.pluck<unknown>(
      "SELECT mm_index_state FROM resources WHERE id = 'res_mm_idempotent'",
    )).toBe('indexed');
  });

  it('index_resource_by_source reads business preview pages and records mm state', async () => {
    const { db, base, repositories } = await harness();
    insertResource(db, 'res_tb_source', 'textbook');
    const blobsDir = path.join(base, 'vfs_blobs');
    const first = repositories.blobs.storeBlob(
      db, blobsDir, new Uint8Array(Buffer.from('preview one')), 'image/png',
    );
    const second = repositories.blobs.storeBlob(
      db, blobsDir, new Uint8Array(Buffer.from('preview two')), 'image/png',
    );
    const previewJson = JSON.stringify({
      pages: [
        { pageIndex: 0, blobHash: first.hash, width: 10, height: 10, mimeType: 'image/png' },
        { pageIndex: 1, blobHash: second.hash, width: 10, height: 10, mimeType: 'image/png' },
      ],
      renderDpi: 150,
      totalPages: 2,
      renderedAt: '2026-01-01T00:00:00.000Z',
    });
    db.run(
      `INSERT INTO files (id, resource_id, blob_hash, sha256, file_name, size, "type", mime_type,
         status, created_at, updated_at, preview_json, mm_index_state)
       VALUES ('file_tb_source', 'res_tb_source', ?1, 'sha', 'book.pdf', 20, 'textbook',
         'application/pdf', 'active', 1, 1, ?2, 'pending')`,
      [first.hash, previewJson],
    );
    const inputsSeen: string[][] = [];
    const fake = fakeStore(db, repositories);
    const service = new VfsMultimodalService({
      readBytes,
      db,
      blobsDir,
      backend: { searchMultimodal: async () => { throw new Error('not used'); } },
      lanceStore: fake.store,
      embedding: embeddingCapability(inputsSeen),
      repositories: () => repositories,
    });

    const result = await service.indexResourceBySource('textbook', 'file_tb_source', null);

    expect(result).toEqual({ indexed_pages: 2, dimension: 64, failed_pages: [] });
    expect(inputsSeen[0]).toEqual([
      Buffer.from('preview one').toString('base64'),
      Buffer.from('preview two').toString('base64'),
    ]);
    expect(db.pluck<unknown>(
      "SELECT mm_index_state FROM files WHERE id = 'file_tb_source'",
    )).toBe('indexed');
    const pagesJson = JSON.parse(String(db.pluck(
      "SELECT mm_indexed_pages_json FROM files WHERE id = 'file_tb_source'",
    ))) as Array<{ page_index: number; embedding_dim: number }>;
    expect(pagesJson.map((entry) => entry.page_index)).toEqual([0, 1]);
    expect(pagesJson.every((entry) => entry.embedding_dim === 64)).toBe(true);
    expect(db.pluck<unknown>(
      "SELECT mm_index_state FROM resources WHERE id = 'res_tb_source'",
    )).toBe('indexed');
  });
});
