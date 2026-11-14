import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import { bindRealOwner } from './support/real-owner.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type {
  UnifiedRetrievalRequest, VfsLanceSearchResult, VfsLanceStore,
} from '../api.ts';
import { VfsUnifiedRetriever, resetProfileCircuitsForTest, type RetrievalRuntime } from '../src/retrieval-service.ts';
import { modelFingerprintForConfig, type RetrievalApiConfig } from '../src/unified-retriever.ts';
import { registerWithModel } from '../repository/embedding-dim.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { resolveRetrievalMountScope, scopedVectorResourceIds } from '../repository/retrieval.ts';

interface Harness {
  db: DatabaseHandle;
  base: string;
  blobsDir: string;
  storage: ReturnType<typeof createStorageService>;
}

const harnesses: Harness[] = [];
let templateDir = '';

beforeAll(async () => {
  templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-retrieval-template-'));
  const storage = createStorageService({
    baseDir: templateDir,
    dataLocalDir: path.join(templateDir, 'local'),
  });
  const report = await storage.migrations.runAll();
  if (!report.success) throw new Error('vfs migration failed');
  storage.dispose();
}, 180_000);

function freshDb(): Harness {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-retrieval-'));
  fs.cpSync(templateDir, base, { recursive: true });
  const storage = createStorageService({ baseDir: base, dataLocalDir: path.join(base, 'local') });
  const harness = {
    db: storage.database('vfs'),
    base,
    blobsDir: path.join(base, 'vfs_blobs'),
    storage,
  };
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
  resetProfileCircuitsForTest();
});

function textRequest(query: string, topK = 10): UnifiedRetrievalRequest {
  return {
    queryText: query,
    queryImageBase64: null,
    queryImageMediaType: null,
    queryModality: 'text',
    topK,
    folderIds: null,
    resourceIds: null,
    resourceTypes: null,
  };
}

function imageRequest(base64: string): UnifiedRetrievalRequest {
  return {
    queryText: null,
    queryImageBase64: base64,
    queryImageMediaType: 'image/png',
    queryModality: 'image',
    topK: 10,
    folderIds: null,
    resourceIds: null,
    resourceTypes: null,
  };
}

function insertLexicalUnit(db: DatabaseHandle): void {
  db.run(
    `INSERT INTO resources
       (id, hash, type, source_id, source_table, storage_mode, data, metadata_json,
        ref_count, created_at, updated_at, index_state)
     VALUES ('res_note_1', 'hash_note_1', 'note', 'note_1', 'notes', 'inline',
             'quantum error correction protects logical qubits', '{"title":"量子纠错"}', 0, 1, 1, 'pending')`,
  );
  db.run(
    `INSERT INTO vfs_index_units
       (id, resource_id, unit_index, text_content, text_source, text_required, text_state,
        created_at, updated_at)
     VALUES ('unit_note_1', 'res_note_1', 0, 'quantum error correction protects logical qubits',
             'native', 1, 'indexed', 1, 1)`,
  );
  db.run(
    `INSERT INTO vfs_index_segments
       (id, unit_id, segment_index, modality, embedding_dim, lance_row_id, content_text,
        created_at, updated_at)
     VALUES ('seg_lexical', 'unit_note_1', 0, 'text', 128, 'lexical-row',
             'quantum error correction protects logical qubits', 1, 1)`,
  );
}

function insertActiveProfile(db: DatabaseHandle, config: RetrievalApiConfig): string {
  const registered = registerWithModel(db, 128, 'text', config.id, config.model);
  const profileId = registered.active_profile_id!;
  db.run(
    `UPDATE vfs_index_profiles
     SET model_fingerprint = ?2, model_name = ?3
     WHERE id = ?1`,
    [profileId, modelFingerprintForConfig(config, 'text'), config.model],
  );
  db.run(
    `INSERT INTO vfs_index_units
       (id, resource_id, unit_index, text_content, text_source, text_required, text_state,
        text_profile_id, text_generation, created_at, updated_at)
     VALUES ('unit_vector', 'res_note_1', 1, 'vector ledger text', 'native', 1, 'indexed',
             ?1, 0, 1, 1)`,
    [profileId],
  );
  db.run(
    `INSERT INTO vfs_index_segments
       (id, unit_id, segment_index, modality, embedding_dim, lance_row_id, content_text,
        index_profile_id, generation, created_at, updated_at)
     VALUES ('seg_vector', 'unit_vector', 0, 'text', 128, 'vector-row',
             'vector ledger text', ?1, 0, 1, 1)`,
    [profileId],
  );
  return profileId;
}

function config(overrides: Partial<RetrievalApiConfig> = {}): RetrievalApiConfig {
  return {
    id: 'embedding-config',
    model: 'bge-m3',
    enabled: true,
    isEmbedding: true,
    isMultimodal: false,
    isReranker: false,
    isImageGeneration: false,
    baseUrl: 'https://embedding.example/v1',
    providerType: null,
    providerScope: null,
    apiProtocol: null,
    modelAdapter: null,
    ...overrides,
  };
}

function runtime(overrides: Partial<RetrievalRuntime> = {}): RetrievalRuntime {
  return {
    getApiConfigs: async () => [],
    getStructuredOcrCandidates: async () => [],
    getFreeTextOcrCandidates: async () => [],
    callEmbeddingApi: async () => { throw new Error('embedding API must not be called'); },
    callMultimodalEmbeddingApi: async () => { throw new Error('multimodal embedding API must not be called'); },
    observeImage: async () => { throw new Error('observer must not be called'); },
    ocrImage: async () => { throw new Error('OCR must not be called'); },
    ...overrides,
  };
}

function lanceRows(row: Partial<VfsLanceSearchResult> = {}): VfsLanceStore {
  return {
    vectorSearchProfileFull: async () => [{
      embedding_id: 'vector-row',
      resource_id: 'res_note_1',
      unit_id: 'unit_vector',
      resource_type: 'note',
      folder_id: null,
      chunk_index: 0,
      text: 'vector ledger text',
      score: 0.91,
      metadata_json: null,
      index_profile_id: 'profile',
      generation: 0,
      page_index: null,
      source_id: 'note_1',
      ...row,
    }],
    ftsSearchProfileFull: async () => [],
    ensureProfileReady: async () => undefined,
  } as unknown as VfsLanceStore;
}

describe('Rust vfs/unified_retriever.rs runtime service', () => {
  it.each([
    [' \t量子纠错\n', ' \t量子纠错\n'],
    ['\u0085 \t', 'note_1'],
    ['\uFEFF', '\uFEFF'],
  ])('X6-UD-0090 enrich_and_filter_results preserves metadata title %j', async (title, expected) => {
    const { db, storage } = freshDb();
    insertLexicalUnit(db);
    db.run('UPDATE resources SET metadata_json = ?1 WHERE id = ?2',
      [JSON.stringify({ title }), 'res_note_1']);
    const host = await createTestHost({ plugins: [plugin], provide: { storage } });
    try {
      const search = host.ctx.vfsIndex.fullSearch!;
      for (const entry of ['searchWithResourceInfo', 'searchCrossDimensionWithResourceInfo'] as const) {
        const results = await search[entry]('quantum', { query: 'quantum', modality: 'text', topK: 10 }, false);
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({ resourceId: 'res_note_1', resourceTitle: expected });
      }
    } finally {
      await host.dispose();
    }
  });
  it('circuit_now_ms follows Instant cooldown despite wall-clock jumps', async () => {
    const { db, blobsDir } = freshDb();
    const embeddingConfig = config({ id: 'monotonic-config' });
    insertActiveProfile(db, embeddingConfig);
    const retriever = new VfsUnifiedRetriever({
      db, blobsDir, lanceStore: lanceRows(),
      runtime: runtime({
        getApiConfigs: async () => [embeddingConfig],
        callEmbeddingApi: async () => [new Array<number>(64).fill(0.25)],
      }),
    });
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const wall = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      for (let attempt = 0; attempt < 3; attempt++) await retriever.search(textRequest('ledger'));
      expect((await retriever.inspectCapabilities()).textEmbedding.circuitOpen).toBe(true);
      wall.mockReturnValue(86400000);
      expect((await retriever.inspectCapabilities()).textEmbedding.circuitOpen).toBe(true);
      wall.mockReturnValue(0);
      clock.mockReturnValue(31000);
      expect((await retriever.inspectCapabilities()).textEmbedding.circuitOpen).toBe(false);
    } finally { clock.mockRestore(); wall.mockRestore(); }
  });
  it('search_executes_fts_without_embedding_or_lance', async () => {
    const { db, blobsDir } = freshDb();
    insertLexicalUnit(db);
    const retriever = new VfsUnifiedRetriever({
      db,
      blobsDir,
      lanceStore: null,
      runtime: runtime(),
    });
    const response = await retriever.search(textRequest('quantum error correction'));
    expect(response.plan.routes.map((route) => route.kind)).toEqual(['full_text']);
    expect(response.result.hits).toHaveLength(1);
    expect(response.result.hits[0]!.hit.identity.resourceId).toBe('res_note_1');
    expect(response.result.failures).toEqual([]);
  });

  it('search_executes_text_embedding_route_after_validating_fingerprint_and_dimension', async () => {
    const { db, blobsDir } = freshDb();
    insertLexicalUnit(db);
    const embeddingConfig = config();
    insertActiveProfile(db, embeddingConfig);
    const retriever = new VfsUnifiedRetriever({
      db,
      blobsDir,
      lanceStore: lanceRows(),
      runtime: runtime({
        getApiConfigs: async () => [embeddingConfig],
        callEmbeddingApi: async () => [new Array<number>(128).fill(0.25)],
      }),
    });
    const response = await retriever.search(textRequest('vector ledger'));
    const vectorHits = response.result.hits.filter((hit) => hit.provenance.some((p) => p.routeKind === 'text_embedding'));
    expect(vectorHits).toHaveLength(1);
    expect(vectorHits[0]!.hit.embeddingId).toBe('vector-row');
    expect(response.result.failures).toEqual([]);
  });

  it('search_reports_dimension_mismatch_and_opens_the_profile_circuit', async () => {
    const { db, blobsDir } = freshDb();
    insertLexicalUnit(db);
    const embeddingConfig = config();
    const profileId = insertActiveProfile(db, embeddingConfig);
    const retriever = new VfsUnifiedRetriever({
      db,
      blobsDir,
      lanceStore: lanceRows(),
      runtime: runtime({
        getApiConfigs: async () => [embeddingConfig],
        callEmbeddingApi: async () => [new Array<number>(64).fill(0.25)],
      }),
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await retriever.search(textRequest('vector ledger'));
      expect(response.result.failures.some((failure) => failure.routeId.includes(profileId)
        && failure.error.includes('index mismatch'))).toBe(true);
    }
    const snapshot = await retriever.inspectCapabilities();
    expect(snapshot.textEmbedding.circuitOpen).toBe(true);
  });

  it('search_uses_multimodal_observation_as_image_fallback', async () => {
    const { db, blobsDir } = freshDb();
    insertLexicalUnit(db);
    const observer = config({
      id: 'observer-config',
      model: 'Qwen/Qwen2.5-VL-7B-Instruct',
      isEmbedding: false,
      isMultimodal: true,
    });
    let observed = false;
    const retriever = new VfsUnifiedRetriever({
      db,
      blobsDir,
      lanceStore: null,
      runtime: runtime({
        getApiConfigs: async () => [observer],
        getStructuredOcrCandidates: async () => [[observer, 'generic_vlm']],
        observeImage: async () => {
          observed = true;
          return 'quantum error correction';
        },
      }),
    });
    const response = await retriever.search(imageRequest('aGVsbG8='));
    expect(observed).toBe(true);
    expect(response.queryDerivations).toHaveLength(1);
    expect(response.queryDerivations[0]!.succeeded).toBe(true);
    expect(response.result.hits).toHaveLength(1);
    expect(response.result.hits[0]!.hit.identity.resourceId).toBe('res_note_1');
  });

  it('search_reports_image_semantics_unavailable_when_no_fallback_engine_exists', async () => {
    const { db, blobsDir } = freshDb();
    insertLexicalUnit(db);
    const retriever = new VfsUnifiedRetriever({
      db,
      blobsDir,
      lanceStore: null,
      runtime: runtime(),
    });
    const response = await retriever.search(imageRequest('aGVsbG8='));
    expect(response.queryDerivations).toEqual([]);
    expect(response.result.failures.some((failure) => failure.routeId === 'query_derivation:image_semantics_unavailable')).toBe(true);
  });

  it('search_multimodal_keeps_only_multimodal_scope_hits', async () => {
    const { db, blobsDir } = freshDb();
    insertLexicalUnit(db);
    const retriever = new VfsUnifiedRetriever({
      db,
      blobsDir,
      lanceStore: null,
      runtime: runtime(),
    });
    const response = await retriever.searchMultimodal(textRequest('quantum error correction'));
    expect(response.plan.routes).toEqual([]);
    expect(response.result.hits).toEqual([]);
  });

  it('search_includes_zero_copy_mounted_resources_across_vector_and_lexical_routes', async () => {
    const { db, blobsDir } = freshDb();
    insertLexicalUnit(db);
    const embeddingConfig = config();
    const profileId = insertActiveProfile(db, embeddingConfig);
    db.run(
      `INSERT INTO folders (id, parent_id, title, sort_order, is_expanded, is_favorite, created_at, updated_at, local_version)
       VALUES ('fld_math', NULL, '数学', 0, 1, 0, 1, 1, 1),
              ('fld_physics', NULL, '物理', 1, 1, 0, 1, 1, 1)`,
    );
    db.run(
      `INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at)
       VALUES ('fi_note_1', 'fld_math', 'note', 'note_1', 0, 1)`,
    );

    const observedMountedArgs: Array<readonly string[] | null | undefined> = [];
    const observedResourceArgs: Array<readonly string[] | null | undefined> = [];
    const retriever = new VfsUnifiedRetriever({
      db,
      blobsDir,
      lanceStore: {
        vectorSearchProfileFull: async (
          _pid: string,
          _emb: readonly number[],
          _topK: number,
          _folders: readonly string[] | null | undefined,
          _resIds: readonly string[] | null | undefined,
          _resTypes: readonly string[] | null | undefined,
          mountedResourceIds?: readonly string[] | null,
        ) => {
          observedMountedArgs.push(mountedResourceIds);
          observedResourceArgs.push(_resIds);
          return [{
            embedding_id: 'vector-row',
            resource_id: 'res_note_1',
            unit_id: 'unit_vector',
            resource_type: 'note',
            folder_id: 'fld_math',
            chunk_index: 0,
            text: 'vector ledger text',
            score: 0.94,
            metadata_json: null,
            index_profile_id: profileId,
            generation: 0,
            page_index: null,
            source_id: 'note_1',
          }];
        },
        ftsSearchProfileFull: async () => [],
        ensureProfileReady: async () => undefined,
      } as unknown as VfsLanceStore,
      runtime: runtime({
        getApiConfigs: async () => [embeddingConfig],
        callEmbeddingApi: async () => [new Array<number>(128).fill(0.1)],
      }),
    });

    // Unmounted: scoped to fld_physics filters out res_note_1 (canonically in fld_math)
    const beforeMount = await retriever.search({
      ...textRequest('vector ledger'),
      folderIds: ['fld_physics'],
    });
    expect(beforeMount.result.hits).toEqual([]);

    // Mount note_1 into fld_physics
    db.run(
      `INSERT INTO vfs_space_mounts (id, space_id, target_folder_id, item_type, item_id, local_version, created_at, updated_at)
       VALUES ('mnt_1', 'grp_physics', 'fld_physics', 'note', 'note_1', 1, datetime('now'), datetime('now'))`,
    );

    const afterMount = await retriever.search({
      ...textRequest('vector ledger'),
      folderIds: ['fld_physics'],
    });
    expect([...new Set(afterMount.result.hits.map((h) => h.hit.identity.resourceId))]).toEqual(['res_note_1']);
    expect(observedMountedArgs.at(-1)).toEqual(['res_note_1']);
    expect(observedResourceArgs.at(-1)).toEqual(['res_note_1']);
  });

  it('expands live canonical and mounted grandchildren in the read-only fallback and scopes ANN candidates before top-K', () => {
    const { db } = freshDb();
    insertLexicalUnit(db);
    db.exec(`INSERT INTO folders (id, parent_id, title, created_at, updated_at) VALUES
      ('fld_root', NULL, 'Root', 1, 1), ('fld_child', 'fld_root', 'Child', 1, 1),
      ('fld_grand', 'fld_child', 'Grand', 1, 1), ('fld_shared', NULL, 'Shared', 1, 1),
      ('fld_shared_child', 'fld_shared', 'Shared child', 1, 1),
      ('fld_shared_grand', 'fld_shared_child', 'Shared grand', 1, 1),
      ('fld_dead', 'fld_root', 'Dead', 1, 1);
      UPDATE folders SET deleted_at = 1 WHERE id = 'fld_dead';
      INSERT INTO folder_items (id, folder_id, item_type, item_id, created_at)
      VALUES ('fi_scope', 'fld_shared_grand', 'note', 'note_1', 1);
      INSERT INTO vfs_space_mounts (id, space_id, target_folder_id, item_type, item_id)
      VALUES ('mnt_nested', 'space_root', 'fld_root', 'folder', 'fld_shared');`);
    // A different executor identity exercises the fallback without an injected repository owner.
    const readOnly = new Proxy(db, { get(target, property) {
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const scope = resolveRetrievalMountScope(readOnly, ['fld_root', 'fld_child'])!;
    expect(new Set(scope.effectiveFolderIds)).toEqual(new Set([
      'fld_root', 'fld_child', 'fld_grand', 'fld_shared', 'fld_shared_child', 'fld_shared_grand',
    ]));
    expect(scopedVectorResourceIds(db, scope, null)).toEqual(['res_note_1']);
    expect(scopedVectorResourceIds(db, scope, ['res_other'])).toEqual([]);
    expect(resolveRetrievalMountScope(readOnly, ['fld_dead'])?.effectiveFolderIds).toEqual([]);
  });
});
