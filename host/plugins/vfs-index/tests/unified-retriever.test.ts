import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import { bindRealOwner } from './support/real-owner.ts';
import type { DatabaseHandle, Row } from '../../../platform/storage/api.ts';
import type {
  CapabilityState, IndexProfileCapability, PlannedRetrievalRoute, RetrievalHit,
  UnifiedRetrievalRequest, VfsLanceSearchResult, VfsLanceStore,
} from '../api.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { blobConfine, createRetrievalService } from '../src/runtime-adapter.ts';
import { createNodeFiles } from '../../../platform/files/index.ts';
import {
  aggregateEmbeddingCapability, bm25QueryTerms, dedicatedOcrConfigIds, escapedLikePattern,
  executeFtsRoute, extractLexicalTerms, hasDedicatedOcrCapability, indexProfileCapability,
  isGeneralTextGenerationConfig, isMultimodalScopeHit, isProfileIndexCompatible,
  lanceRowsToHits, modelFingerprintForConfig, partitionImageFallbackGateRoutes, profileUsable,
  selectMultimodalObserver, validGenerationConfig, validateRetrievalRequest,
  validateRouteConfigFingerprint, type OcrEngineType, type RetrievalApiConfig,
} from '../src/unified-retriever.ts';
import {
  embeddingAvailable, fuseRouteResults, planRetrieval, unavailableCapability,
} from '../src/retrieval-planner.ts';
import {
  MAX_DIMENSION, registerWithModel, type VfsIndexProfile,
} from '../repository/embedding-dim.ts';

// ------------------------------------------------------------------ helpers

function textRequest(query: string, topK: number): UnifiedRetrievalRequest {
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

function apiConfig(overrides: Partial<RetrievalApiConfig> & { id: string; model: string }): RetrievalApiConfig {
  return {
    enabled: true,
    isEmbedding: true,
    isMultimodal: false,
    isReranker: false,
    isImageGeneration: false,
    baseUrl: '',
    providerType: null,
    providerScope: null,
    apiProtocol: null,
    modelAdapter: null,
    ...overrides,
  };
}

function makeProfile(
  id: string,
  modelFingerprint: string,
  overrides: Partial<VfsIndexProfile> = {},
): VfsIndexProfile {
  return {
    id,
    model_fingerprint: modelFingerprint,
    model_config_id: null,
    model_name: null,
    dimension: 1024,
    modality: 'text',
    embedding_protocol: 'text-embedding-v1',
    schema_version: 1,
    lance_table_name: `profile_${id}`,
    active_generation: 1,
    state: 'active',
    ann_metric: 'cosine',
    ann_index_version: 1,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

function legacyTextProfile(id: string, configId: string, modelName: string | null): VfsIndexProfile {
  return makeProfile(id, `legacy:model-config:${configId}`, {
    model_config_id: configId,
    model_name: modelName,
    active_generation: 0,
  });
}

function capability(
  overrides: Partial<IndexProfileCapability> = {},
): IndexProfileCapability {
  return {
    profileId: 'profile',
    dimension: 1024,
    modality: 'text',
    embeddingProtocol: 'text-embedding-v1',
    modelConfigId: 'model',
    runtimeModelFingerprint: 'fingerprint-model',
    configured: true,
    active: true,
    healthy: true,
    circuitOpen: false,
    protocolCompatible: true,
    indexCompatible: true,
    weight: 1,
    ...overrides,
  };
}

function makeRoute(
  routeId: string,
  kind: PlannedRetrievalRoute['kind'],
  overrides: Partial<PlannedRetrievalRoute> = {},
): PlannedRetrievalRoute {
  return {
    routeId,
    kind,
    profileId: routeId,
    modelConfigId: `model-${routeId}`,
    expectedModelFingerprint: `fingerprint-${routeId}`,
    dimension: 1024,
    modality: 'text',
    weight: 1,
    fetchLimit: 10,
    ...overrides,
  };
}

function snapshotWith(textEmbedding: CapabilityState) {
  return {
    textEmbedding,
    multimodalEmbedding: unavailableCapability(),
    textModel: unavailableCapability(),
    multimodalModel: unavailableCapability(),
    ocr: unavailableCapability(),
  };
}

// ------------------------------------------------------------------ pure tests

describe('Rust vfs/unified_retriever.rs tests', () => {
  it('request_validation_matches_declared_modality', () => {
    expect(() => validateRetrievalRequest(textRequest('query', 10))).not.toThrow();
    expect(() => validateRetrievalRequest({
      ...textRequest('text', 10),
      queryModality: 'mixed',
    })).toThrow(/query payload does not match Mixed mode \(text=true, image=false\)/);
  });

  it('image_fallback_gate_waits_only_for_multimodal_image_routes', () => {
    const [gated, concurrent] = partitionImageFallbackGateRoutes([
      makeRoute('me-image-a', 'multimodal_image'),
      makeRoute('te', 'text_embedding'),
      makeRoute('me-text', 'multimodal_text'),
      makeRoute('fts', 'full_text'),
      makeRoute('me-image-b', 'multimodal_image'),
    ]);
    expect(gated.map((route) => route.routeId)).toEqual(['me-image-a', 'me-image-b']);
    expect(concurrent.map((route) => route.routeId)).toEqual(['te', 'me-text', 'fts']);
  });

  it('generic_multimodal_model_is_observer_but_not_ocr_capability', () => {
    expect(hasDedicatedOcrCapability(['generic_vlm', 'glm4v_ocr'])).toBe(false);
    expect(hasDedicatedOcrCapability(['system_ocr', 'deepseek_ocr'])).toBe(true);

    const generic = apiConfig({
      id: 'generic-mm',
      model: 'Qwen/Qwen2.5-VL-7B-Instruct',
      enabled: true,
      isEmbedding: false,
      isMultimodal: true,
    });
    expect(selectMultimodalObserver(
      [generic],
      [[generic, 'generic_vlm']],
      new Set(),
    )?.id).toBe('generic-mm');
  });

  it('dedicated_ocr_only_does_not_advertise_text_or_multimodal_model', () => {
    const dedicated = apiConfig({
      id: 'dedicated-ocr',
      model: 'deepseek-ai/DeepSeek-OCR',
      enabled: true,
      isEmbedding: false,
      isMultimodal: true,
    });
    const candidates = [{
      kind: 'remote' as const,
      config: dedicated,
      engineType: 'deepseek_ocr' as OcrEngineType,
    }];
    const dedicatedIds = dedicatedOcrConfigIds(candidates);
    const prioritized: Array<readonly [RetrievalApiConfig, OcrEngineType]> = [
      [dedicated, 'deepseek_ocr'],
    ];

    expect(hasDedicatedOcrCapability(candidates.map((candidate) => candidate.engineType))).toBe(true);
    expect(dedicatedIds.has(dedicated.id)).toBe(true);
    expect(selectMultimodalObserver([dedicated], prioritized, dedicatedIds)).toBeNull();

    const textShapedOcr = { ...dedicated, isMultimodal: false };
    expect(validGenerationConfig(textShapedOcr)).toBe(true);
    expect(isGeneralTextGenerationConfig(textShapedOcr, dedicatedIds)).toBe(false);
  });

  it('capability_aggregation_exposes_index_mismatch', () => {
    const state = aggregateEmbeddingCapability([
      capability({ indexCompatible: false }),
    ], 'text');
    expect(state.configured).toBe(true);
    expect(state.healthy).toBe(true);
    expect(state.indexCompatible).toBe(false);
    expect(embeddingAvailable(state)).toBe(false);
  });

  it('runtime_fingerprint_mismatch_isolated_to_its_profile', () => {
    const config = apiConfig({
      id: 'embedding-config',
      model: 'embedding-model',
      baseUrl: 'https://embedding.example/v1',
    });
    const fingerprint = modelFingerprintForConfig(config, 'text');
    const models = new Map([[config.id, config]]);
    const healthy = indexProfileCapability(
      makeProfile('healthy', fingerprint, { model_config_id: config.id, model_name: config.model }),
      models,
      false,
    );
    const mismatched = indexProfileCapability(
      makeProfile('mismatched', 'sha256:stale-runtime-binding', {
        model_config_id: config.id,
        model_name: config.model,
      }),
      models,
      false,
    );

    expect(profileUsable(healthy) && healthy.healthy && healthy.indexCompatible).toBe(true);
    expect(mismatched.healthy).toBe(false);
    expect(mismatched.indexCompatible).toBe(false);
    expect(profileUsable(mismatched)).toBe(false);

    const profiles = [healthy, mismatched];
    const snapshot = snapshotWith(aggregateEmbeddingCapability(profiles, 'text'));
    const plan = planRetrieval(snapshot, 'text', profiles, 10);
    expect(plan.routes.some((route) => route.routeId === 'fts')).toBe(true);
    expect(plan.routes
      .filter((route) => route.kind === 'text_embedding')
      .map((route) => route.profileId)).toEqual(['healthy']);
  });

  it('planned_routes_reject_same_id_model_or_transport_changes_independently', () => {
    const config = (id: string, model: string, baseUrl: string): RetrievalApiConfig => apiConfig({
      id,
      model,
      baseUrl,
    });
    const original = config('reused-config-id', 'embedding-space-v1', 'https://embedding-a.example/v1');
    const stable = config('stable-config-id', 'stable-space', 'https://embedding-b.example/v1');
    const models = new Map([[original.id, original], [stable.id, stable]]);
    const profile = (id: string, bound: RetrievalApiConfig): VfsIndexProfile => makeProfile(
      id,
      modelFingerprintForConfig(bound, 'text'),
      { model_config_id: bound.id, model_name: bound.model },
    );
    const profiles = [
      indexProfileCapability(profile('changing', original), models, false),
      indexProfileCapability(profile('stable', stable), models, false),
    ];
    const snapshot = snapshotWith(aggregateEmbeddingCapability(profiles, 'text'));
    const plan = planRetrieval(snapshot, 'text', profiles, 10);
    const changingRoute = plan.routes.find((route) => route.profileId === 'changing')!;
    const stableRoute = plan.routes.find((route) => route.profileId === 'stable')!;

    const changedModel = config('reused-config-id', 'embedding-space-v2', 'https://embedding-a.example/v1');
    const modelChange = [changedModel, stable];
    expect(() => validateRouteConfigFingerprint(changingRoute, modelChange))
      .toThrow(/changed after planning/);
    expect(() => validateRouteConfigFingerprint(stableRoute, modelChange)).not.toThrow();

    const changedTransport = config(
      'reused-config-id',
      'embedding-space-v1',
      'https://embedding-a-alt.example/v1',
    );
    const transportChange = [changedTransport, stable];
    expect(() => validateRouteConfigFingerprint(changingRoute, transportChange)).toThrow();
    expect(() => validateRouteConfigFingerprint(stableRoute, transportChange)).not.toThrow();
  });

  it('matching_bound_legacy_profile_remains_queryable', () => {
    const config = apiConfig({
      id: 'legacy-config',
      model: 'BAAI/bge-m3',
      baseUrl: 'https://embedding.example/v1',
    });
    const models = new Map([[config.id, config]]);
    const bound = indexProfileCapability(
      legacyTextProfile('legacy-ready', config.id, 'SiliconFlow - BAAI/bge-m3'),
      models,
      false,
    );
    expect(bound.healthy).toBe(true);
    expect(bound.indexCompatible).toBe(true);
    expect(profileUsable(bound)).toBe(true);

    const fallbackConfig = apiConfig({
      id: 'same-id-and-model',
      model: 'same-id-and-model',
      baseUrl: 'https://embedding.example/v1',
    });
    const fallbackModels = new Map([[fallbackConfig.id, fallbackConfig]]);
    expect(profileUsable(indexProfileCapability(
      legacyTextProfile('legacy-fallback', fallbackConfig.id, null),
      fallbackModels,
      false,
    ))).toBe(true);
  });

  it('bound_legacy_profile_with_changed_model_name_remains_queryable', () => {
    const config = apiConfig({
      id: 'legacy-config',
      model: 'new-model',
      baseUrl: 'https://embedding.example/v1',
    });
    const models = new Map([[config.id, config]]);
    const profile = indexProfileCapability(
      legacyTextProfile('legacy-queryable', config.id, 'old-display-name'),
      models,
      false,
    );
    expect(profile.healthy).toBe(true);
    expect(profile.indexCompatible).toBe(true);
    expect(profileUsable(profile)).toBe(true);

    const profiles = [profile];
    const snapshot = snapshotWith(aggregateEmbeddingCapability(profiles, 'text'));
    const plan = planRetrieval(snapshot, 'text', profiles, 10);
    expect(plan.routes.some((route) => route.kind === 'text_embedding'
      && route.profileId === 'legacy-queryable'
      && route.modelConfigId === config.id)).toBe(true);
  });

  it('unbound_or_differently_bound_legacy_profiles_are_isolated', () => {
    const config = apiConfig({
      id: 'legacy-config',
      model: 'current-model',
      baseUrl: 'https://embedding.example/v1',
    });
    const models = new Map([[config.id, config]]);

    const unboundProfile = legacyTextProfile('legacy-unbound', config.id, 'old-model');
    unboundProfile.model_fingerprint = 'legacy:unbound:text:1024';
    const unbound = indexProfileCapability(unboundProfile, models, false);
    expect(unbound.healthy).toBe(false);
    expect(unbound.indexCompatible).toBe(false);
    expect(profileUsable(unbound)).toBe(false);

    const differentlyBoundProfile = legacyTextProfile('legacy-other-config', config.id, 'old-model');
    differentlyBoundProfile.model_fingerprint = 'legacy:model-config:other-config';
    const differentlyBound = indexProfileCapability(differentlyBoundProfile, models, false);
    expect(differentlyBound.healthy).toBe(false);
    expect(differentlyBound.indexCompatible).toBe(false);
    expect(profileUsable(differentlyBound)).toBe(false);
  });

  it('bound_legacy_profile_still_requires_protocol_dimension_and_index_compatibility', () => {
    const config = apiConfig({
      id: 'legacy-config',
      model: 'current-model',
      baseUrl: 'https://embedding.example/v1',
    });
    const models = new Map([[config.id, config]]);

    const invalidProtocol = legacyTextProfile('legacy-invalid-protocol', config.id, null);
    invalidProtocol.embedding_protocol = 'multimodal-embedding-v1';
    expect(profileUsable(indexProfileCapability(invalidProtocol, models, false))).toBe(false);

    const invalidDimension = legacyTextProfile('legacy-invalid-dimension', config.id, null);
    invalidDimension.dimension = MAX_DIMENSION + 1;
    expect(profileUsable(indexProfileCapability(invalidDimension, models, false))).toBe(false);

    const invalidIndex = legacyTextProfile('legacy-invalid-index', config.id, null);
    invalidIndex.ann_metric = 'legacy_l2';
    invalidIndex.ann_index_version = 0;
    expect(profileUsable(indexProfileCapability(invalidIndex, models, false))).toBe(false);
  });

  it('tiny_exact_profile_is_index_compatible', () => {
    expect(isProfileIndexCompatible('exact', 0, 1)).toBe(true);
    expect(isProfileIndexCompatible('exact', 1, 1)).toBe(true);
    expect(isProfileIndexCompatible('cosine', 1, 1)).toBe(true);
    expect(isProfileIndexCompatible('legacy_l2', 0, 1)).toBe(false);
    expect(isProfileIndexCompatible('exact', 0, 0)).toBe(false);
  });

  it('lexical_terms_split_chinese_questions', () => {
    const terms = extractLexicalTerms('中值定理怎么证明不等式');
    expect(terms[0]).toBe('中值定理怎么证明不等式');
    expect(terms).toContain('中值定理');
    expect(terms).toContain('证明不等式');
    expect(terms).toContain('不等');
    expect(terms).not.toContain('怎么');

    const mixed = extractLexicalTerms('AllReduce 是怎么同步梯度的');
    expect(mixed[0]).toBe('AllReduce');
    expect(mixed).toContain('同步梯度');
    expect(mixed.length).toBeLessThanOrEqual(16);
  });

  it('bm25_query_terms_drop_question_words', () => {
    const terms = bm25QueryTerms('傅里叶变换有哪些性质');
    expect(terms).toContain('变换');
    expect(terms).toContain('性质');
    expect(terms).not.toContain('哪些');
    expect(terms).not.toContain('有');
  });

  it('multimodal_scope_drops_plain_text_hits_without_media_or_me_provenance', () => {
    const route = (kind: PlannedRetrievalRoute['kind'], id: string) => makeRoute(id, kind, {
      profileId: id,
      modelConfigId: `model-${id}`,
      expectedModelFingerprint: `fingerprint-${id}`,
      modality: 'text',
      queryDerivation: { kind: 'multimodal_observation', modelConfigId: 'observer' },
    });
    const hit: RetrievalHit = {
      identity: { resourceId: 'text-only', chunkIndex: 0, pageIndex: null, timeRange: null },
      embeddingId: 'text-only-row',
      text: 'plain text result',
      title: null,
      resourceType: 'note',
      sourceId: null,
      folderId: null,
      blobHash: null,
      imageUrl: null,
      rawScore: null,
      metadata: null,
    };
    const plain = fuseRouteResults([{
      route: route('text_embedding', 'te'),
      hits: [structuredClone(hit)],
      elapsedMs: 1,
    }], 10);
    expect(isMultimodalScopeHit(plain.hits[0]!)).toBe(false);

    const mediaHit = structuredClone(hit);
    mediaHit.blobHash = 'blob';
    const media = fuseRouteResults([{
      route: route('text_embedding', 'te'),
      hits: [mediaHit],
      elapsedMs: 1,
    }], 10);
    expect(isMultimodalScopeHit(media.hits[0]!)).toBe(true);

    const multimodal = fuseRouteResults([{
      route: route('multimodal_text', 'me'),
      hits: [structuredClone(hit)],
      elapsedMs: 1,
    }], 10);
    expect(isMultimodalScopeHit(multimodal.hits[0]!)).toBe(true);
  });
});

// ------------------------------------------------------------------ database tests

interface Harness {
  db: DatabaseHandle;
  base: string;
  blobsDir: string;
  storage: ReturnType<typeof createStorageService>;
}

/** `ctx.files` 作用域的真实路径判断（生产由 `dstu.platform.files` 提供）。 */
function confineFor(harness: Harness, blobsDir = harness.blobsDir) {
  const files = createNodeFiles({ roots: [{ name: 'appData', path: harness.base }] });
  return blobConfine(() => files, blobsDir);
}

const harnesses: Harness[] = [];
let templateDir = '';

beforeAll(async () => {
  templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-retriever-template-'));
  const storage = createStorageService({
    baseDir: templateDir,
    dataLocalDir: path.join(templateDir, 'local'),
  });
  const report = await storage.migrations.runAll();
  if (!report.success) throw new Error('vfs migration failed');
  storage.dispose();
}, 180_000);

function freshDb(): Harness {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-retriever-'));
  fs.cpSync(templateDir, base, { recursive: true });
  const storage = createStorageService({ baseDir: base, dataLocalDir: path.join(base, 'local') });
  const harness: Harness = {
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
});

function insertLexicalUnit(
  db: DatabaseHandle,
  sourceId: string,
  text: string,
  unitIndex = 0,
): { resourceId: string; unitId: string } {
  const resourceId = `res_${sourceId}`;
  const unitId = `unit_${sourceId}_${unitIndex}`;
  db.run(
    `INSERT INTO resources
       (id, hash, type, source_id, source_table, storage_mode, data, metadata_json,
        ref_count, created_at, updated_at, index_state)
     VALUES (?1, ?2, 'note', ?3, 'notes', 'inline', ?4, ?5, 0, 1, 1, 'pending')`,
    [resourceId, `hash_${sourceId}_${unitIndex}`, sourceId, text, JSON.stringify({ title: sourceId })],
  );
  insertUnitForResource(db, resourceId, unitId, text, unitIndex);
  return { resourceId, unitId };
}

function insertUnitForResource(
  db: DatabaseHandle,
  resourceId: string,
  unitId: string,
  text: string,
  unitIndex: number,
): void {
  db.run(
    `INSERT INTO vfs_index_units
       (id, resource_id, unit_index, text_content, text_source, text_required, text_state,
        created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'native', 1, 'indexed', 1, 1)`,
    [unitId, resourceId, unitIndex, text],
  );
}

function insertSegment(
  db: DatabaseHandle,
  unitId: string,
  options: {
    lanceRowId: string;
    contentText: string;
    generation?: number;
    profileId?: string | null;
    dimension?: number;
  },
): void {
  db.run(
    `INSERT INTO vfs_index_segments
       (id, unit_id, segment_index, modality, embedding_dim, lance_row_id, content_text,
        index_profile_id, generation, created_at, updated_at)
     VALUES (?1, ?2, 0, 'text', ?3, ?4, ?5, ?6, ?7, 1, 1)`,
    [
      `seg_${options.lanceRowId}`,
      unitId,
      options.dimension ?? 128,
      options.lanceRowId,
      options.contentText,
      options.profileId ?? null,
      options.generation ?? 0,
    ],
  );
}

function insertSegmentFromUnit(db: DatabaseHandle, unitId: string, contentText: string): void {
  insertSegment(db, unitId, {
    lanceRowId: `lexical_${unitId}`,
    contentText,
    generation: 0,
    profileId: null,
    dimension: 128,
  });
}

describe('Rust vfs/unified_retriever.rs SQLite route tests', () => {
  it('lexical_route_finds_unit_text_without_embedding_segment', async () => {
    const { db, blobsDir } = freshDb();
    const created = insertLexicalUnit(db, 'note_lexical_only', 'unit only lexical content');
    const request = textRequest('lexical content', 10);
    const hits = await executeFtsRoute(db, 'lexical content', request, 10, blobsDir);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.identity.resourceId).toBe(created.resourceId);
    expect(hits[0]!.embeddingId.startsWith('unit:')).toBe(true);
  });

  it('lexical_scope_is_applied_before_candidate_limit', async () => {
    const { db, blobsDir } = freshDb();
    for (let index = 0; index < 31; index += 1) {
      const resource = insertLexicalUnit(db, `outside_${index}`, `outside ${index} needle`);
      db.run('UPDATE vfs_index_units SET text_content = \'needle\' WHERE resource_id = ?1', [
        resource.resourceId,
      ]);
    }
    db.run(`INSERT INTO folders (id, title, created_at, updated_at)
            VALUES ('scope_old', 'Old', 1, 1), ('scope_current', 'Current', 2, 2)`);
    const targets: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const source = `inside_${index}`;
      const resource = insertLexicalUnit(db, source, `inside ${index} needle`);
      db.run("UPDATE resources SET type = 'image' WHERE id = ?1", [resource.resourceId]);
      db.run(
        `INSERT INTO folder_items (id, folder_id, item_type, item_id, created_at)
         VALUES (?1, 'scope_old', 'image', ?2, 1), (?3, 'scope_current', 'image', ?4, 2)`,
        [`old_${index}`, resource.resourceId, `current_${index}`, source],
      );
      targets.push(resource.resourceId);
    }
    const units = db.all<Row>('SELECT id, text_content FROM vfs_index_units');
    for (const unit of units) {
      insertSegmentFromUnit(db, String(unit['id']), String(unit['text_content']));
    }

    for (const kind of ['resource', 'type', 'folder', 'combined'] as const) {
      const request = textRequest('needle', 3);
      if (kind === 'resource' || kind === 'combined') request.resourceIds = [...targets];
      if (kind === 'type' || kind === 'combined') request.resourceTypes = ['image'];
      if (kind === 'folder' || kind === 'combined') request.folderIds = ['scope_current'];
      const hits = await executeFtsRoute(db, 'needle', request, 3, blobsDir);
      expect(hits, `scope: ${kind}`).toHaveLength(3);
      expect(hits.every((hit) => targets.includes(hit.identity.resourceId))).toBe(true);
      expect(hits.every((hit) => hit.folderId === 'scope_current')).toBe(true);
      expect(hits.every((hit) => hit.title?.startsWith('inside_') ?? false)).toBe(true);
    }

    const staleScope = textRequest('needle', 3);
    staleScope.folderIds = ['scope_old'];
    expect(await executeFtsRoute(db, 'needle', staleScope, 3, blobsDir)).toEqual([]);

    const emptyScope = textRequest('needle', 3);
    emptyScope.resourceIds = [];
    expect(await executeFtsRoute(db, 'needle', emptyScope, 3, blobsDir)).toEqual([]);
  });

  it('lexical_type_scope_preserves_legacy_aliases_and_unknown_fallback', async () => {
    const { db, blobsDir } = freshDb();
    const cases: Array<[number, string, string]> = [
      [0, 'InsightCard', 'insight_card'],
      [1, 'IMAGE', 'image'],
      [2, 'unknown', 'file'],
    ];
    for (const [index, rawType, canonical] of cases) {
      const resource = insertLexicalUnit(db, `type_${index}`, `needle ${index}`);
      db.run('UPDATE resources SET type = ?1 WHERE id = ?2', [rawType, resource.resourceId]);
      const request = textRequest('needle', 3);
      request.resourceTypes = [canonical];
      const hits = await executeFtsRoute(db, 'needle', request, 3, blobsDir);
      expect(hits).toHaveLength(1);
      expect(hits[0]!.identity.resourceId).toBe(resource.resourceId);
      expect(hits[0]!.resourceType).toBe(canonical);
    }
  });

  it('lexical_route_uses_keywords_from_long_multimodal_observation', async () => {
    const { db, blobsDir } = freshDb();
    const target = insertLexicalUnit(
      db,
      'note_mm_keywords',
      '量子纠缠实验使用纠错码保护逻辑量子比特',
    );
    insertLexicalUnit(db, 'note_mm_distractor', '普通课堂板书与课程安排');
    const query = '画面是一张复杂的实验装置照片，包含大量与知识库原文不同的视觉描述，整段描述不会逐字出现在任何记录中。\n关键词：量子纠缠 纠错码';
    const request = textRequest(query, 10);
    const hits = await executeFtsRoute(db, query, request, 10, blobsDir);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.identity.resourceId).toBe(target.resourceId);
  });

  it('lexical_route_ranks_more_term_matches_first_deterministically', async () => {
    const { db, blobsDir } = freshDb();
    const twoTerms = insertLexicalUnit(
      db,
      'note_two_terms',
      'distributed consensus preserves causal ordering',
    );
    const oneTerm = insertLexicalUnit(
      db,
      'note_one_term',
      'distributed workers process independent jobs',
    );
    const query = 'Keywords: distributed consensus';
    const request = textRequest(query, 10);
    const hits = await executeFtsRoute(db, query, request, 10, blobsDir);
    expect(hits).toHaveLength(2);
    expect(hits[0]!.identity.resourceId).toBe(twoTerms.resourceId);
    expect(hits[1]!.identity.resourceId).toBe(oneTerm.resourceId);
  });

  it('lexical_route_reranks_equal_term_matches_with_bm25', async () => {
    const { db, blobsDir } = freshDb();
    const focused = insertLexicalUnit(
      db,
      'note_bm25_focused',
      '傅里叶变换的性质：线性性质、时移性质、频移性质，傅里叶变换把卷积变成乘积。',
    );
    const diluted = insertLexicalUnit(
      db,
      'note_bm25_diluted',
      `课程目录：傅里叶变换、性质。${'本章其余内容讨论采样定理与滤波器设计。'.repeat(20)}`,
    );
    const query = '傅里叶变换有哪些性质';
    const request = textRequest(query, 10);
    const hits = await executeFtsRoute(db, query, request, 10, blobsDir);
    expect(hits.map((hit) => hit.identity.resourceId))
      .toEqual([focused.resourceId, diluted.resourceId]);
    expect(hits[0]!.rawScore!).toBeGreaterThan(hits[1]!.rawScore!);

    const again = await executeFtsRoute(db, query, request, 10, blobsDir);
    expect(again.map((hit) => hit.rawScore)).toEqual(hits.map((hit) => hit.rawScore));
  });

  it('lexical_route_escapes_percent_and_underscore_keywords', async () => {
    expect(escapedLikePattern('100%_ready')).toBe('%100\\%\\_ready%');
    const { db, blobsDir } = freshDb();
    const literal = insertLexicalUnit(
      db,
      'note_literal_wildcards',
      'release marker 100%_ready is literal',
    );
    insertLexicalUnit(
      db,
      'note_wildcard_decoy',
      'release marker 100Xalmostready is different',
    );
    const query = '关键词：100%_ready';
    const request = textRequest(query, 10);
    const hits = await executeFtsRoute(db, query, request, 10, blobsDir);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.identity.resourceId).toBe(literal.resourceId);
  });

  it('vector_hits_require_active_ledger_and_use_canonical_folder', async () => {
    const { db, blobsDir } = freshDb();
    const sourceId = 'note_active_ledger';
    const resourceId = 'res_note_active_ledger';
    db.run(
      `INSERT INTO resources
         (id, hash, type, source_id, source_table, storage_mode, data, metadata_json,
          ref_count, created_at, updated_at, index_state)
       VALUES (?1, ?2, 'note', ?3, 'notes', 'inline', 'active ledger text', ?4, 0, 1, 1, 'pending')`,
      [resourceId, 'hash_active_ledger', sourceId, JSON.stringify({ title: 'Active ledger' })],
    );
    insertUnitForResource(db, resourceId, 'unit-active', 'active ledger text', 0);
    insertUnitForResource(db, resourceId, 'unit-active-generation-four', 'second active ledger text', 1);

    const registered = registerWithModel(db, 128, 'text', 'model-text', 'Text embedding');
    const profileId = registered.active_profile_id!;
    db.run(
      'UPDATE vfs_index_units SET text_profile_id = ?2, text_generation = 1 WHERE id = ?1',
      ['unit-active', profileId],
    );
    insertSegment(db, 'unit-active', {
      lanceRowId: 'active-row',
      contentText: 'active ledger text',
      generation: 1,
      profileId,
      dimension: 128,
    });
    db.run(
      'UPDATE vfs_index_units SET text_profile_id = ?2, text_generation = 4 WHERE id = ?1',
      ['unit-active-generation-four', profileId],
    );
    insertSegment(db, 'unit-active-generation-four', {
      lanceRowId: 'active-row-generation-four',
      contentText: 'second active ledger text',
      generation: 4,
      profileId,
      dimension: 128,
    });
    db.run(
      "INSERT INTO folders (id, title, created_at, updated_at) VALUES ('fld_canonical', 'Canonical', 1, 1)",
    );
    db.run(
      `INSERT INTO folder_items (id, folder_id, item_type, item_id, created_at)
       VALUES ('fi_canonical', 'fld_canonical', 'note', ?1, 1)`,
      [sourceId],
    );

    const row = (
      embeddingId: string,
      rowUnitId: string,
      generation: number,
      page: number,
    ): VfsLanceSearchResult => ({
      embedding_id: embeddingId,
      resource_id: resourceId,
      unit_id: rowUnitId,
      resource_type: 'note',
      folder_id: 'fld_stale_lance_value',
      chunk_index: 0,
      text: 'active ledger text',
      score: 0.9,
      metadata_json: null,
      index_profile_id: profileId,
      generation,
      page_index: page,
      source_id: sourceId,
    });
    const route = {
      routeId: 'text-profile',
      kind: 'text_embedding' as const,
      profileId,
      modelConfigId: 'model-text',
      expectedModelFingerprint: 'fingerprint-model-text',
      dimension: 128,
      modality: 'text',
      weight: 1,
      fetchLimit: 30,
    };
    const request = textRequest('active', 10);
    request.folderIds = ['fld_canonical'];
    const hits = await lanceRowsToHits(db, [
      row('active-row', 'unit-active', 1, 0),
      row('active-row-generation-four', 'unit-active-generation-four', 4, 1),
      row('staged-or-orphan-row', 'unit-active', 1, 0),
    ], route, request, blobsDir);
    expect(hits).toHaveLength(2);
    expect(hits[0]!.embeddingId).toBe('active-row');
    expect(hits.every((hit) => hit.folderId === 'fld_canonical')).toBe(true);
  });
});

describe('RF-W04-blob-relative-path-escape: synced blobs.relative_path cannot point hit images outside vfs_blobs', () => {
  const SYMLINKS = process.platform !== 'win32';
  const HASHES = ['hash_parent', 'hash_absolute', 'hash_inside', ...(SYMLINKS ? ['hash_symlink', 'hash_dir_symlink'] : [])];

  /** One contained blob next to `../`, absolute, last-component symlink and directory symlink rows. */
  function blobFixture(harness: Harness, blobsDir = harness.blobsDir): { inside: string } {
    const outside = path.join(harness.base, 'outside.txt');
    fs.writeFileSync(outside, 'secret');
    fs.mkdirSync(path.join(blobsDir, 'ab'), { recursive: true });
    const inside = path.join(blobsDir, 'ab', 'page.png');
    fs.writeFileSync(inside, 'png');
    const blobs: Array<[string, string]> = [
      ['hash_parent', '../outside.txt'],
      ['hash_absolute', outside],
      ['hash_inside', 'ab/page.png'],
    ];
    if (SYMLINKS) {
      fs.symlinkSync(outside, path.join(blobsDir, 'ab', 'link.png'));
      blobs.push(['hash_symlink', 'ab/link.png']);
      const outsideDir = path.join(harness.base, 'outside-dir');
      fs.mkdirSync(outsideDir);
      fs.writeFileSync(path.join(outsideDir, 'x.bin'), 'secret');
      fs.symlinkSync(outsideDir, path.join(blobsDir, 'ln'), 'dir');
      blobs.push(['hash_dir_symlink', 'ln/x.bin']);
    }
    for (const [hash, relativePath] of blobs) {
      harness.db.run(
        `INSERT INTO blobs (hash, relative_path, size, mime_type, ref_count, created_at)
         VALUES (?1, ?2, 6, 'image/png', 1, 1)`,
        [hash, relativePath],
      );
    }
    return { inside };
  }

  function lexicalUnits(harness: Harness): void {
    for (const hash of HASHES) {
      const { unitId } = insertLexicalUnit(harness.db, `note_${hash}`, `escape probe ${hash}`);
      harness.db.run('UPDATE vfs_index_units SET image_blob_hash = ?2 WHERE id = ?1', [unitId, hash]);
    }
  }

  function expectOnlyInsideImage(hits: readonly RetrievalHit[], inside: string): void {
    const byHash = new Map(hits.map((hit) => [hit.blobHash, hit]));
    expect([...byHash.keys()].sort()).toEqual([...HASHES].sort());
    expect(byHash.get('hash_inside')!.imageUrl).toBe(inside);
    for (const hash of HASHES.filter((value) => value !== 'hash_inside')) {
      expect(byHash.get(hash)!.imageUrl, hash).toBeNull();
    }
  }

  it('RF-W04-blob-relative-path-escape: lexical route drops escaping image paths and keeps the hit', async () => {
    const harness = freshDb();
    const { inside } = blobFixture(harness);
    lexicalUnits(harness);
    const hits = await executeFtsRoute(
      harness.db, 'escape probe', textRequest('escape probe', 10), 10, harness.blobsDir, confineFor(harness));
    expectOnlyInsideImage(hits, inside);
  });

  it.skipIf(!SYMLINKS)('RF-W04-blob-relative-path-escape: without realpath only the lexical checks run, so both symlink rows keep their paths', async () => {
    const harness = freshDb();
    blobFixture(harness);
    lexicalUnits(harness);
    const hits = await executeFtsRoute(harness.db, 'escape probe', textRequest('escape probe', 10), 10, harness.blobsDir);
    const byHash = new Map(hits.map((hit) => [hit.blobHash, hit]));
    expect(byHash.get('hash_parent')!.imageUrl).toBeNull();
    expect(byHash.get('hash_absolute')!.imageUrl).toBeNull();
    expect(byHash.get('hash_symlink')!.imageUrl).toBe(path.join(harness.blobsDir, 'ab', 'link.png'));
    expect(byHash.get('hash_dir_symlink')!.imageUrl).toBe(path.join(harness.blobsDir, 'ln', 'x.bin'));
  });

  it('RF-W04-blob-relative-path-escape: the retrieval service vfs-index provides resolves symbolic links on the lexical route', async () => {
    const harness = freshDb();
    const { inside } = blobFixture(harness, path.join(harness.storage.locations.activeDir, 'vfs_blobs'));
    lexicalUnits(harness);
    const host = await createTestHost({
      plugins: [[plugin, { indexWorker: { enabled: false } }]],
      provide: { storage: harness.storage, files: createNodeFiles({ roots: [{ name: 'appData', path: harness.base }] }) },
    });
    try {
      const response = await host.ctx.retrieval.search(textRequest('escape probe', 10));
      expect(response.plan.routes.map((route) => route.kind)).toEqual(['full_text']);
      expect(response.result.failures).toEqual([]);
      expectOnlyInsideImage(response.result.hits.map((fused) => fused.hit), inside);
    } finally {
      await host.dispose();
    }
  });

  function vectorRows(harness: Harness, profileId: string): VfsLanceSearchResult[] {
    const rows: VfsLanceSearchResult[] = [];
    for (const hash of HASHES) {
      const { resourceId, unitId } = insertLexicalUnit(harness.db, `note_${hash}`, `vector probe ${hash}`);
      harness.db.run(
        'UPDATE vfs_index_units SET text_profile_id = ?2, text_generation = 1 WHERE id = ?1',
        [unitId, profileId],
      );
      insertSegment(harness.db, unitId, {
        lanceRowId: `row_${hash}`,
        contentText: `vector probe ${hash}`,
        generation: 1,
        profileId,
        dimension: 128,
      });
      rows.push({
        embedding_id: `row_${hash}`,
        resource_id: resourceId,
        unit_id: unitId,
        resource_type: 'note',
        folder_id: null,
        chunk_index: 0,
        text: `vector probe ${hash}`,
        score: 0.5,
        metadata_json: JSON.stringify({ blob_hash: hash }),
        index_profile_id: profileId,
        generation: 1,
        page_index: 0,
        source_id: null,
      });
    }
    return rows;
  }

  it('RF-W04-blob-relative-path-escape: vector route drops escaping image paths and keeps the hit', async () => {
    const harness = freshDb();
    const { inside } = blobFixture(harness);
    const registered = registerWithModel(harness.db, 128, 'text', 'model-text', 'Text embedding');
    const profileId = registered.active_profile_id!;
    const rows = vectorRows(harness, profileId);
    const route = {
      routeId: 'text-profile',
      kind: 'text_embedding' as const,
      profileId,
      modelConfigId: 'model-text',
      expectedModelFingerprint: 'fingerprint-model-text',
      dimension: 128,
      modality: 'text',
      weight: 1,
      fetchLimit: 30,
    };
    const hits = await lanceRowsToHits(
      harness.db, rows, route, textRequest('vector probe', 10), harness.blobsDir, confineFor(harness));
    expectOnlyInsideImage(hits, inside);
  });

  it('RF-W04-blob-relative-path-escape: createRetrievalService, the factory vfs-index/index.ts uses, resolves symbolic links on the vector route', async () => {
    const harness = freshDb();
    const { inside } = blobFixture(harness, path.join(harness.storage.locations.activeDir, 'vfs_blobs'));
    const embedding = apiConfig({ id: 'escape-embedding', model: 'escape-model', baseUrl: 'https://embedding.example/v1' });
    const profileId = registerWithModel(harness.db, 128, 'text', embedding.id, embedding.model).active_profile_id!;
    harness.db.run('UPDATE vfs_index_profiles SET model_fingerprint = ?2 WHERE id = ?1',
      [profileId, modelFingerprintForConfig(embedding, 'text')]);
    const rows = vectorRows(harness, profileId);
    const lanceStore = {
      vectorSearchProfileFull: async () => rows,
      ensureProfileReady: async () => undefined,
    } as unknown as VfsLanceStore;
    const host = await createTestHost({
      provide: {
        files: createNodeFiles({ roots: [{ name: 'appData', path: harness.base }] }),
        llm: { getApiConfigs: async () => [embedding] },
        'embedding@1': { callEmbeddingApi: async (texts: string[]) => texts.map(() => Array<number>(128).fill(0.25)) },
      },
    });
    try {
      const retrieval = createRetrievalService(host.ctx, harness.storage, lanceStore);
      // No unit text contains this query, so every hit comes from the vector route.
      const response = await retrieval.search(textRequest('unmatched', 10));
      expect(response.plan.routes.map((route) => route.kind).sort()).toEqual(['full_text', 'text_embedding']);
      expect(response.result.failures).toEqual([]);
      const hits = response.result.hits.map((fused) => fused.hit);
      expect(response.result.hits.every((fused) => fused.provenance.every((entry) => entry.routeKind === 'text_embedding'))).toBe(true);
      expectOnlyInsideImage(hits, inside);
    } finally {
      await host.dispose();
    }
  });
});
