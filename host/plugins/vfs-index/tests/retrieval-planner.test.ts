import { expect, it } from 'vitest';
import type { ActiveGenerationModel, CapabilitySnapshot, GenerationRoute, IndexProfileCapability, PlannedRetrievalRoute, QueryModality, RetrievalHit, RetrievalPlan, RetrievalRouteKind } from '../api.ts';
import { availableCapability, unavailableCapability, planGeneration, planRetrieval, fuseRouteResults, fuseRouteResultsPooled, applyMaxPerResource, applyMmrDiversity, identityKey, ProfileCircuitBreaker } from '../src/retrieval-planner.ts';

function snapshot(mask: number): CapabilitySnapshot {
  const state = (bit: number) => mask & (1 << bit) ? availableCapability() : unavailableCapability();
  return { textEmbedding: state(0), multimodalEmbedding: state(1), textModel: state(2), multimodalModel: state(3), ocr: state(4) };
}
function profile(id: string, modality: string, protocol: string): IndexProfileCapability {
  return { profileId: id, dimension: 1024, modality, embeddingProtocol: protocol, modelConfigId: `model-${id}`,
    runtimeModelFingerprint: `fingerprint-${id}`, configured: true, active: true, healthy: true,
    circuitOpen: false, protocolCompatible: true, indexCompatible: true, weight: 1 };
}
const profiles = () => [profile('te', 'text', 'text-embedding-v1'), profile('me', 'multimodal', 'multimodal-embedding-v1')];
function expectedGeneration(mask: number, active: ActiveGenerationModel | null, query: QueryModality): [GenerationRoute, boolean, boolean] {
  const tm = !!(mask & 4), mm = !!(mask & 8), ocr = !!(mask & 16), image = query !== 'text';
  if (active === 'multimodal') {
    if (mm) return ['multimodal_model_direct', image, false];
    if (tm && !image) return ['text_model_direct', false, false];
    if (tm && ocr) return ['ocr_then_text_model', false, true];
    if (tm) return ['text_model_without_image', false, false];
  } else if (active === 'text') {
    if (tm && !image) return ['text_model_direct', false, false];
    if (tm && mm) return ['multimodal_observation_then_text_model', true, false];
    if (tm && ocr) return ['ocr_then_text_model', false, true];
    if (tm) return ['text_model_without_image', false, false];
    if (mm) return ['multimodal_model_direct', image, false];
  } else {
    if (image && mm) return ['multimodal_model_direct', true, false];
    if (tm && !image) return ['text_model_direct', false, false];
    if (tm && ocr) return ['ocr_then_text_model', false, true];
    if (tm) return ['text_model_without_image', false, false];
    if (mm) return ['multimodal_model_direct', false, false];
  }
  return ['unavailable', false, false];
}
function hit(resource: string, chunk: number, page: number | null, score: number): RetrievalHit {
  return { identity: { resourceId: resource, chunkIndex: chunk, pageIndex: page },
    embeddingId: `${resource}-${chunk}-${page === null ? 'None' : `Some(${page})`}`, text: `text-${resource}-${chunk}`,
    title: null, resourceType: null, sourceId: null, folderId: null, blobHash: null, imageUrl: null,
    rawScore: score, metadata: null };
}
function route(id: string): PlannedRetrievalRoute {
  return { routeId: id, kind: 'text_embedding', profileId: id, modelConfigId: `model-${id}`,
    expectedModelFingerprint: `fingerprint-${id}`, dimension: 1024, modality: 'text', weight: 1, fetchLimit: 30 };
}
const result = (id: string, hits: RetrievalHit[], elapsedMs = 1) => ({ route: route(id), hits, elapsedMs });

it('all_32_capability_subsets_match_exact_generation_and_retrieval_matrix', () => {
  for (let mask = 0; mask < 32; mask++) {
    for (const query of ['text', 'image', 'mixed'] as const) {
      for (const active of [null, 'text', 'multimodal'] as const) {
        const plan = planGeneration(snapshot(mask), active, query);
        expect([plan.route, plan.sendsOriginalImages, plan.usesOcr]).toEqual(expectedGeneration(mask, active, query));
      }
      const plan = planRetrieval(snapshot(mask), query, profiles(), 10);
      const expected: RetrievalRouteKind[] = [];
      if (query !== 'image') {
        expected.push('full_text');
        if (mask & 1) expected.push('text_embedding');
        if (mask & 2) expected.push('multimodal_text');
      }
      if (query !== 'text' && (mask & 2)) expected.push('multimodal_image');
      expect(plan.routes.map(r => r.kind)).toEqual(expected);
      const fallback: string[] = [];
      if (query !== 'text' && (mask & 8)) fallback.push('multimodal_observation');
      if (query !== 'text' && (mask & 16)) fallback.push('ocr');
      expect(plan.imageFallbackChain.map(s => s.kind)).toEqual(fallback);
      expect(plan.imageFallbackUnavailableReason != null).toBe(query !== 'text' && !(mask & 8) && !(mask & 16));
    }
  }
});
it('active_mm_receives_original_image_and_never_uses_ocr', () => {
  const plan = planGeneration(snapshot(8 | 16), 'multimodal', 'image');
  expect(plan.route).toBe('multimodal_model_direct');
  expect(plan.sendsOriginalImages).toBe(true);
  expect(plan.usesOcr).toBe(false);
});
it('active_tm_prefers_mm_observation_then_ocr', () => {
  const plan = planGeneration(snapshot(4 | 8 | 16), 'text', 'image');
  expect(plan.route).toBe('multimodal_observation_then_text_model');
  expect(plan.usesOcr).toBe(false);
  const fallback = planGeneration(snapshot(4 | 16), 'text', 'image');
  expect(fallback.route).toBe('ocr_then_text_model');
  expect(fallback.usesOcr).toBe(true);
});
it('plan_retrieval_top_k_above_500_keeps_the_rust_clamp_panic', () => {
  expect(planRetrieval(snapshot(31), 'text', profiles(), 500).topK).toBe(500);
  expect(() => planRetrieval(snapshot(31), 'text', profiles(), 501))
    .toThrow(new RangeError('assertion failed: min <= max'));
});

it('image_retrieval_never_routes_through_text_embedding_or_ocr', () => {
  expect(planRetrieval(snapshot(31), 'image', profiles(), 5).routes.map(r => r.kind)).toEqual(['multimodal_image']);
});
it('unhealthy_or_incompatible_capability_keeps_fts_alive', () => {
  const cap = snapshot(3);
  cap.textEmbedding.circuitOpen = true;
  cap.multimodalEmbedding.protocolCompatible = false;
  const plan = planRetrieval(cap, 'mixed', profiles(), 10);
  expect(plan.routes).toHaveLength(1);
  expect(plan.routes[0]!.kind).toBe('full_text');
});
it('rrf_does_not_merge_distinct_chunks_or_pages_of_same_resource', () => {
  expect(fuseRouteResults([result('te', [hit('resource', 0, 0, .9), hit('resource', 1, 0, .8), hit('resource', 0, 1, .7)])], 10).hits).toHaveLength(3);
});
it('time_range_does_not_split_fused_identity', () => {
  const ranged = { ...hit('res-media', 0, 2, 0).identity, timeRange: { startMs: 180_000, endMs: 270_000 } };
  expect(identityKey(ranged)).toBe(identityKey(hit('res-media', 0, 2, 0).identity));
  const set = new Set([identityKey(ranged)]);
  set.add(identityKey(hit('res-media', 0, 2, 0).identity));
  expect(set.size).toBe(1);
  expect(JSON.parse(JSON.stringify(ranged)).timeRange.startMs).toBe(180_000);
  expect(JSON.parse(JSON.stringify(hit('res', 0, null, 0).identity))).not.toHaveProperty('timeRange');
});
it('rrf_fuses_same_unit_without_comparing_raw_scores', () => {
  const fused = fuseRouteResults([result('te', [hit('shared', 0, 0, .01)]), result('me', [hit('shared', 0, 0, 999)])], 10);
  expect(fused.hits).toHaveLength(1);
  expect(fused.hits[0]!.provenance).toHaveLength(2);
  expect(fused.hits[0]!.provenance.map(p => p.rawScore)).toEqual([.01, 999]);
});
it('failed_route_does_not_discard_successful_routes', () => {
  const fused = fuseRouteResults([{ routeId: 'broken', profileId: 'broken-profile', dimension: 768, error: 'timeout', timedOut: true }, result('healthy', [hit('resource', 0, null, .5)], 2)], 10);
  expect(fused.hits).toHaveLength(1);
  expect(fused.failures).toHaveLength(1);
  expect(fused.failures[0]!.timedOut).toBe(true);
});
it('strict_protocol_prevents_text_api_from_impersonating_image_embedding', () => {
  expect(planRetrieval(snapshot(3), 'image', [profile('bad', 'multimodal', 'text-embedding-v1')], 10).routes).toEqual([]);
});
it('route_family_budget_is_stable_when_profiles_are_duplicated', () => {
  const single = planRetrieval(snapshot(3), 'text', [profile('te-a', 'text', 'text-embedding-v1'), profiles()[1]!], 10);
  const duplicated = planRetrieval(snapshot(3), 'text', [profile('te-a', 'text', 'text-embedding-v1'), profile('te-b', 'text', 'text-embedding-v1'), profiles()[1]!], 10);
  const weight = (plan: RetrievalPlan, kind: RetrievalRouteKind) => plan.routes.filter(r => r.kind === kind).reduce((a, r) => a + r.weight, 0);
  for (const kind of ['full_text', 'text_embedding', 'multimodal_text'] as const) {
    expect(Math.abs(weight(single, kind) - 1)).toBeLessThan(Number.EPSILON);
    expect(Math.abs(weight(duplicated, kind) - 1)).toBeLessThan(Number.EPSILON);
  }
  expect(duplicated.routes.filter(r => r.kind === 'text_embedding').map(r => r.weight)).toEqual([.5, .5]);
});
it('fusion_prefers_media_rich_representative_and_normalizes_scores', () => {
  const image = { ...hit('shared', 0, 0, .2), text: 'short', blobHash: 'blob' };
  const fused = fuseRouteResults([result('te', [hit('shared', 0, 0, .9), hit('other', 1, 0, .5)]), result('me', [image])], 10);
  expect(fused.hits.find(h => h.hit.identity.resourceId === 'shared')!.hit.blobHash).toBe('blob');
  expect(fused.hits[0]!.normalizedScore).toBe(1);
  expect(fused.hits.every(h => h.normalizedScore! > 0 && h.normalizedScore! <= 1)).toBe(true);
});
it('pooled_fusion_keeps_all_candidates_for_post_filter_backfill', () => {
  expect(fuseRouteResultsPooled([result('te', Array.from({ length: 7 }, (_, i) => hit('resource', i, 0, .5)))]).hits).toHaveLength(7);
});
it('max_per_resource_caps_hits_in_rank_order', () => {
  const hits = fuseRouteResultsPooled([result('te', [hit('a', 0, null, .9), hit('a', 1, null, .8), hit('a', 2, null, .7), hit('b', 0, null, .6)])]).hits;
  applyMaxPerResource(hits, 2);
  expect(hits).toHaveLength(3);
  expect(hits.filter(h => h.hit.identity.resourceId === 'a')).toHaveLength(2);
});
it('mmr_diversifies_across_resources', () => {
  const pool = () => fuseRouteResultsPooled([result('te', [hit('a', 0, 0, .9), hit('a', 1, 0, .8), hit('b', 0, 0, .7)])]).hits;
  const selected = applyMmrDiversity(pool(), .5, 2);
  expect(selected).toHaveLength(2);
  expect(selected.map(h => h.hit.identity.resourceId)).toEqual(['a', 'b']);
  expect(applyMmrDiversity(pool(), 1, 2).every(h => h.hit.identity.resourceId === 'a')).toBe(true);
});
it('empty_success_does_not_reset_failure_streak_but_closes_half_open_probe', () => {
  const breaker = new ProfileCircuitBreaker(3, 100);
  breaker.recordFailure(0); breaker.recordFailure(1); breaker.recordEmptySuccess(); breaker.recordFailure(2);
  expect(breaker.decision(3).kind).toBe('reject_open');
  expect(breaker.decision(103).kind).toBe('allow_half_open_probe');
  breaker.recordEmptySuccess();
  expect(breaker.decision(104).kind).toBe('allow');
  breaker.recordFailure(105);
  expect(breaker.decision(106).kind).toBe('reject_open');
});
it('profile_circuit_breaker_opens_cools_down_and_allows_one_probe', () => {
  const breaker = new ProfileCircuitBreaker(3, 100);
  breaker.recordFailure(0); breaker.recordFailure(1);
  expect(breaker.decision(2).kind).toBe('allow');
  breaker.recordFailure(2);
  expect(breaker.decision(50)).toEqual({ kind: 'reject_open', retryAfterMs: 52 });
  expect(breaker.decision(102).kind).toBe('allow_half_open_probe');
  expect(breaker.decision(102).kind).toBe('reject_half_open');
  breaker.recordFailure(103);
  expect(breaker.rejectionReason(150)).not.toBeNull();
  expect(breaker.decision(203).kind).toBe('allow_half_open_probe');
  breaker.recordSuccess();
  expect(breaker.decision(204).kind).toBe('allow');
  expect(breaker.rejectionReason(204)).toBeNull();
});
