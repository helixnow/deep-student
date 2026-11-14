import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import { bindRealOwner } from './support/real-owner.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { FusedRetrievalHit, UnifiedRetrievalRequest, UnifiedRetrievalResponse, VfsLanceStore } from '../api.ts';
import { VfsMultimodalService } from '../src/multimodal-service.ts';
import { MultimodalInput } from '../src/multimodal.ts';

interface Harness {
  db: DatabaseHandle;
  base: string;
  storage: ReturnType<typeof createStorageService>;
}

const harnesses: Harness[] = [];
let templateDir = '';

beforeAll(async () => {
  templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-mm-template-'));
  const storage = createStorageService({
    baseDir: templateDir,
    dataLocalDir: path.join(templateDir, 'local'),
  });
  const report = await storage.migrations.runAll();
  if (!report.success) throw new Error('vfs migration failed');
  storage.dispose();
}, 180_000);

function freshDb(): Harness {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-mm-'));
  fs.cpSync(templateDir, base, { recursive: true });
  const storage = createStorageService({ baseDir: base, dataLocalDir: path.join(base, 'local') });
  const harness = { db: storage.database('vfs'), base, storage };
  bindRealOwner(harness.db);
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop()!;
    harness.storage.dispose();
    fs.rmSync(harness.base, { recursive: true, force: true });
  }
});

function response(hits: FusedRetrievalHit[]): UnifiedRetrievalResponse {
  return {
    capabilitySnapshot: {} as UnifiedRetrievalResponse['capabilitySnapshot'],
    plan: {} as UnifiedRetrievalResponse['plan'],
    result: { hits, failures: [] },
    queryDerivations: [],
  };
}

function hit(overrides: Partial<FusedRetrievalHit['hit']> = {}, rrfScore = 0.02): FusedRetrievalHit {
  return {
    rrfScore,
    provenance: [],
    hit: {
      identity: { resourceId: 'res_1', chunkIndex: 2, pageIndex: 4 },
      embeddingId: 'emb_1',
      text: 'page text',
      title: 'Book',
      resourceType: 'textbook',
      sourceId: 'tb_1',
      folderId: 'folder_1',
      blobHash: null,
      imageUrl: null,
      rawScore: 0.8,
      metadata: { blob_hash: 'blob_meta', unit_id: 'unit_1' },
      ...overrides,
    },
  };
}

function backend(hits: FusedRetrievalHit[]): { requests: UnifiedRetrievalRequest[]; searchMultimodal: (r: UnifiedRetrievalRequest) => Promise<UnifiedRetrievalResponse> } {
  const requests: UnifiedRetrievalRequest[] = [];
  return {
    requests,
    async searchMultimodal(request) {
      requests.push(request);
      return response(hits);
    },
  };
}

function store(): { deleteCalls: string[]; value: VfsLanceStore } {
  const deleteCalls: string[] = [];
  return {
    deleteCalls,
    value: {
      async deleteByResource(modality: string, resourceId: string) {
        deleteCalls.push(`${modality}:${resourceId}`);
        return 1;
      },
    } as unknown as VfsLanceStore,
  };
}

describe('Rust vfs/multimodal_service.rs service orchestration', () => {
  it('search_input_full_maps_unified_hits_and_normalizes_rrf', async () => {
    const { db } = freshDb();
    const fake = backend([hit({}, 0.04), hit({ embeddingId: 'emb_2', identity: { resourceId: 'res_2', chunkIndex: 0, pageIndex: null } }, 0.02)]);
    const service = new VfsMultimodalService({ db, backend: fake, lanceStore: store().value });
    const results = await service.searchInputFull(MultimodalInput.text('query'), 10, ['f'], ['r'], ['textbook']);
    expect(fake.requests[0]).toMatchObject({
      queryText: 'query', queryModality: 'text', topK: 10,
      folderIds: ['f'], resourceIds: ['r'], resourceTypes: ['textbook'],
    });
    expect(results.map((result) => result.score)).toEqual([1, 0.5]);
    expect(results[0]).toMatchObject({
      embedding_id: 'emb_1', resource_id: 'res_1', unit_id: 'unit_1',
      page_index: 4, blob_hash: 'blob_meta', folder_id: 'folder_1',
    });
    expect(results[1]!.page_index).toBe(0);
  });

  it('search_full_rejects_url_only_images', async () => {
    const { db } = freshDb();
    const service = new VfsMultimodalService({ db, backend: backend([]), lanceStore: store().value });
    await expect(service.searchInputFull(MultimodalInput.imageUrl('https://example/x.png'), 5))
      .rejects.toThrow('URL-only image queries are unsupported');
  });

  it('delete_resource_index_clears_mm_segments_and_disables_units', async () => {
    const { db } = freshDb();
    db.run(
      `INSERT INTO resources (id, hash, type, storage_mode, data, created_at, updated_at)
       VALUES ('res_mm', 'h', 'textbook', 'external', NULL, 1, 1)`,
    );
    db.run(
      `INSERT INTO vfs_index_units
         (id, resource_id, unit_index, mm_required, mm_state, created_at, updated_at)
       VALUES ('unit_mm', 'res_mm', 0, 1, 'indexed', 1, 1)`,
    );
    db.run(
      `INSERT INTO vfs_index_segments
         (id, unit_id, segment_index, modality, embedding_dim, lance_row_id, created_at, updated_at)
       VALUES ('seg_mm', 'unit_mm', 0, 'multimodal', 768, 'row_mm', 1, 1)`,
    );
    const fakeStore = store();
    const service = new VfsMultimodalService({ db, backend: backend([]), lanceStore: fakeStore.value });
    await service.deleteResourceIndex('res_mm');
    expect(fakeStore.deleteCalls).toEqual(['multimodal:res_mm']);
    expect(db.pluck<unknown>("SELECT COUNT(*) FROM vfs_index_segments WHERE id = 'seg_mm'")).toBe(0);
    const unit = db.get<{ mm_state: string; mm_required: number }>(
      "SELECT mm_state, mm_required FROM vfs_index_units WHERE id = 'unit_mm'",
    )!;
    expect(unit.mm_state).toBe('disabled');
    expect(unit.mm_required).toBe(0);
    expect(db.pluck<unknown>("SELECT mm_index_state FROM resources WHERE id = 'res_mm'")).toBe('disabled');
    expect(db.pluck<unknown>("SELECT COUNT(*) FROM __lance_orphan_queue WHERE lance_row_id = 'row_mm'")).toBe(1);
  });

  it('get_stats_sums_multimodal_dimension_counts', async () => {
    const { db } = freshDb();
    db.run(
      `INSERT INTO vfs_embedding_dims
         (dimension, modality, lance_table_name, record_count, created_at, last_used_at)
       VALUES (768, 'multimodal', 'vfs_emb_multimodal_768', 3, 1, 1),
              (1024, 'multimodal', 'vfs_emb_multimodal_1024', 2, 1, 1)`,
    );
    const service = new VfsMultimodalService({ db, backend: backend([]), lanceStore: store().value });
    expect(await service.getStats()).toEqual({ total_records: 5, dimensions: [768, 1024] });
  });

  it('is_configured_requires_the_l02_multimodal_embedding_capability', async () => {
    const { db } = freshDb();
    const service = new VfsMultimodalService({ db, backend: backend([]), lanceStore: store().value });
    expect(await service.isConfigured()).toBe(false);
    const configured = new VfsMultimodalService({
      db,
      backend: backend([]),
      lanceStore: store().value,
      embedding: {
        isConfigured: async () => true,
        getModelConfig: async () => ({
          id: 'vl-embed', model: 'vl-embed-model', baseUrl: 'https://example.invalid/v1',
          modelAdapter: 'openai',
        }),
        embed: async () => [],
      },
    });
    expect(await configured.isConfigured()).toBe(true);
  });
});
