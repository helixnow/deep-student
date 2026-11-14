// Port of dstu-vfs/src/vfs/retrieval_planner.rs. No runtime I/O belongs here.
import type {
  ActiveGenerationModel, CapabilityKind, CapabilitySnapshot, CapabilityState, FusedRetrievalHit,
  FusedRetrievalResult, GenerationPlan, IndexProfileCapability, PlannedRetrievalRoute,
  QueryDerivationProvenance, QueryModality, RetrievalHit, RetrievalIdentity, RetrievalPlan,
  RetrievalRouteFailure, RetrievalRouteKind, RetrievalRouteResult,
} from '../api.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';

export type ProfileCircuitDecision = { kind: 'allow' | 'allow_half_open_probe' | 'reject_half_open' }
  | { kind: 'reject_open'; retryAfterMs: number };
export class ProfileCircuitBreaker {
  private phase: 'closed' | 'open' | 'half_open' = 'closed';
  private openedAtMs = 0;
  private consecutiveFailures = 0;
  private failureThreshold: number;
  private cooldownMs: number;
  constructor(failureThreshold = 3, cooldownMs = 30_000) {
    this.failureThreshold = Math.max(1, failureThreshold);
    this.cooldownMs = cooldownMs;
  }
  decision(nowMs: number): ProfileCircuitDecision {
    if (this.phase === 'closed') return { kind: 'allow' };
    if (this.phase === 'half_open') return { kind: 'reject_half_open' };
    const elapsed = Math.max(0, nowMs - this.openedAtMs);
    if (elapsed >= this.cooldownMs) {
      this.phase = 'half_open';
      return { kind: 'allow_half_open_probe' };
    }
    return { kind: 'reject_open', retryAfterMs: this.cooldownMs - elapsed };
  }
  recordSuccess(): void { this.phase = 'closed'; this.consecutiveFailures = 0; }
  recordEmptySuccess(): void { if (this.phase === 'half_open') this.phase = 'closed'; }
  recordFailure(nowMs: number): void {
    if (this.phase === 'closed') {
      this.consecutiveFailures = Math.min(0xffff_ffff, this.consecutiveFailures + 1);
      if (this.consecutiveFailures < this.failureThreshold) return;
    } else this.consecutiveFailures = this.failureThreshold;
    this.phase = 'open';
    this.openedAtMs = nowMs;
  }
  rejectionReason(nowMs: number): string | null {
    if (this.phase === 'half_open') return 'profile circuit half-open probe already in flight';
    const elapsed = Math.max(0, nowMs - this.openedAtMs);
    return this.phase === 'open' && elapsed < this.cooldownMs
      ? `profile circuit open; retry after ${this.cooldownMs - elapsed}ms` : null;
  }
}

export function unavailableCapability(): CapabilityState {
  return { configured: false, healthy: false, circuitOpen: false, protocolCompatible: true, indexCompatible: true };
}
export function availableCapability(): CapabilityState {
  return { configured: true, healthy: true, circuitOpen: false, protocolCompatible: true, indexCompatible: true };
}
export function runtimeAvailable(state: CapabilityState): boolean {
  return state.configured && state.healthy && !state.circuitOpen && state.protocolCompatible;
}
export function embeddingAvailable(state: CapabilityState): boolean { return runtimeAvailable(state) && state.indexCompatible; }
export function capabilityAvailable(snapshot: CapabilitySnapshot, kind: CapabilityKind): boolean {
  switch (kind) {
    case 'text_embedding': return embeddingAvailable(snapshot.textEmbedding);
    case 'multimodal_embedding': return embeddingAvailable(snapshot.multimodalEmbedding);
    case 'text_model': return runtimeAvailable(snapshot.textModel);
    case 'multimodal_model': return runtimeAvailable(snapshot.multimodalModel);
    case 'ocr': return runtimeAvailable(snapshot.ocr);
  }
}
export function planGeneration(snapshot: CapabilitySnapshot, requestedActive: ActiveGenerationModel | null, query: QueryModality): GenerationPlan {
  const tm = capabilityAvailable(snapshot, 'text_model');
  const mm = capabilityAvailable(snapshot, 'multimodal_model');
  const ocr = capabilityAvailable(snapshot, 'ocr');
  const image = query !== 'text';
  const selected = requestedActive ?? (image && mm ? 'multimodal' : tm ? 'text' : mm ? 'multimodal' : null);
  if (selected === 'multimodal' && mm) return {
    route: 'multimodal_model_direct', activeModel: selected, fallbackFrom: null,
    sendsOriginalImages: image, usesOcr: false, degraded: false,
  };
  if (selected === 'multimodal' && tm) return {
    route: !image ? 'text_model_direct' : ocr ? 'ocr_then_text_model' : 'text_model_without_image',
    activeModel: 'text', fallbackFrom: 'multimodal', sendsOriginalImages: false, usesOcr: image && ocr, degraded: true,
  };
  if (selected === 'text' && tm) return {
    route: !image ? 'text_model_direct' : mm ? 'multimodal_observation_then_text_model' : ocr ? 'ocr_then_text_model' : 'text_model_without_image',
    activeModel: selected, fallbackFrom: null, sendsOriginalImages: image && mm,
    usesOcr: image && !mm && ocr, degraded: image && !mm,
  };
  if (selected === 'text' && mm) return {
    route: 'multimodal_model_direct', activeModel: 'multimodal', fallbackFrom: 'text',
    sendsOriginalImages: image, usesOcr: false, degraded: true,
  };
  return { route: 'unavailable', activeModel: null, fallbackFrom: selected, sendsOriginalImages: false, usesOcr: false, degraded: true };
}
export function profileUsable(p: IndexProfileCapability): boolean {
  return p.configured && p.active && p.healthy && !p.circuitOpen && p.protocolCompatible && p.indexCompatible
    && p.dimension > 0 && !!p.modelConfigId?.length && !!p.runtimeModelFingerprint?.length;
}
const routeKinds: RetrievalRouteKind[] = ['full_text', 'text_embedding', 'multimodal_text', 'multimodal_image'];
export function normalizeRouteFamilyWeights(routes: PlannedRetrievalRoute[]): void {
  for (const kind of routeKinds) {
    const total = routes.filter(r => r.kind === kind && Number.isFinite(r.weight) && r.weight > 0)
      .reduce((sum, r) => sum + r.weight, 0);
    if (total <= 0) continue;
    for (const r of routes) if (r.kind === kind) r.weight /= total;
  }
}
function profileRoute(p: IndexProfileCapability, kind: RetrievalRouteKind, fetchLimit: number): PlannedRetrievalRoute {
  return { routeId: `${kind.replaceAll('_', '')}:${p.profileId}`.replace(/[A-Z]/g, c => c.toLowerCase()), kind,
    profileId: p.profileId, modelConfigId: p.modelConfigId,
    ...(p.runtimeModelFingerprint != null ? { expectedModelFingerprint: p.runtimeModelFingerprint } : {}),
    dimension: p.dimension, modality: p.modality,
    weight: Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 1, fetchLimit };
}
export function planRetrieval(snapshot: CapabilitySnapshot, queryModality: QueryModality, profiles: readonly IndexProfileCapability[], topK: number): RetrievalPlan {
  topK = Math.max(1, topK);
  // Rust usize::clamp panics when its lower bound exceeds 500.
  if (topK > 500) throw new RangeError('assertion failed: min <= max');
  const fetchLimit = Math.min(500, Math.max(topK, topK * 3));
  const routes: PlannedRetrievalRoute[] = [];
  if (queryModality !== 'image') routes.push({ routeId: 'fts', kind: 'full_text', profileId: null,
    modelConfigId: null, dimension: null, modality: 'text', weight: 1, fetchLimit });
  for (const p of profiles.filter(profileUsable)) {
    if (p.modality === 'text' && p.embeddingProtocol === 'text-embedding-v1'
      && queryModality !== 'image' && capabilityAvailable(snapshot, 'text_embedding')) {
      routes.push(profileRoute(p, 'text_embedding', fetchLimit));
    } else if ((p.modality === 'multimodal' || p.modality === 'image')
      && p.embeddingProtocol === 'multimodal-embedding-v1' && capabilityAvailable(snapshot, 'multimodal_embedding')) {
      if (queryModality !== 'image') routes.push(profileRoute(p, 'multimodal_text', fetchLimit));
      if (queryModality !== 'text') routes.push(profileRoute(p, 'multimodal_image', fetchLimit));
    }
  }
  normalizeRouteFamilyWeights(routes);
  const plan: RetrievalPlan = { queryModality, topK, routes, imageFallbackChain: [] };
  if (queryModality !== 'text') {
    if (capabilityAvailable(snapshot, 'multimodal_model')) plan.imageFallbackChain.push({ kind: 'multimodal_observation', conditionalOnImageEmbeddingMiss: true });
    if (capabilityAvailable(snapshot, 'ocr')) plan.imageFallbackChain.push({ kind: 'ocr', conditionalOnImageEmbeddingMiss: true });
    if (!plan.imageFallbackChain.length) plan.imageFallbackUnavailableReason = 'no healthy multimodal observation model or OCR engine is available if image embedding misses';
  }
  return plan;
}
export function planDerivedTextRoutes(snapshot: CapabilitySnapshot, profiles: readonly IndexProfileCapability[], topK: number, provenance: QueryDerivationProvenance): PlannedRetrievalRoute[] {
  const suffix = provenance.kind === 'multimodal_observation' ? 'mm_observation' : 'ocr';
  const routes = planRetrieval(snapshot, 'text', profiles, topK).routes.filter(r => r.kind === 'full_text' || r.kind === 'text_embedding');
  for (const route of routes) { route.routeId = `derived_${suffix}:${route.routeId}`; route.queryDerivation = { ...provenance }; }
  normalizeRouteFamilyWeights(routes);
  return routes;
}
export function identityKey(identity: RetrievalIdentity): string {
  return JSON.stringify([identity.resourceId, identity.chunkIndex, identity.pageIndex]);
}
function richer(left: RetrievalHit, right: RetrievalHit): boolean {
  const image = (h: RetrievalHit) => Number(!!h.blobHash?.length || !!h.imageUrl?.length);
  return image(left) > image(right) || (image(left) === image(right) && Array.from(left.text).length > Array.from(right.text).length);
}
export function fuseRouteResultsPooled(results: readonly (RetrievalRouteResult | RetrievalRouteFailure)[]): FusedRetrievalResult {
  const fused = new Map<string, FusedRetrievalHit>();
  const failures: RetrievalRouteFailure[] = [];
  for (const result of results) {
    if (!('route' in result)) { failures.push(result); continue; }
    const route = result.route;
    const weight = Number.isFinite(route.weight) && route.weight > 0 ? route.weight : 1;
    result.hits.forEach((hit, offset) => {
      const rawRank = offset + 1, contribution = weight / (60 + rawRank);
      const provenance = { routeId: route.routeId, routeKind: route.kind, profileId: route.profileId,
        dimension: route.dimension, modality: route.modality, rawRank, rawScore: hit.rawScore,
        routeWeight: weight, rrfContribution: contribution,
        ...(route.queryDerivation != null ? { queryDerivation: structuredClone(route.queryDerivation) } : {}) };
      const key = identityKey(hit.identity), current = fused.get(key);
      if (current) {
        current.rrfScore += contribution;
        current.provenance.push(provenance);
        if (richer(hit, current.hit)) current.hit = structuredClone(hit);
      } else fused.set(key, { hit: structuredClone(hit), rrfScore: contribution, provenance: [provenance] });
    });
  }
  const hits = [...fused.values()];
  hits.sort((a, b) => {
    const l = a.hit.identity, r = b.hit.identity;
    return (b.rrfScore - a.rrfScore || 0) || compareUtf8(l.resourceId, r.resourceId)
      || l.chunkIndex - r.chunkIndex || (l.pageIndex === null ? (r.pageIndex === null ? 0 : -1) : r.pageIndex === null ? 1 : l.pageIndex - r.pageIndex);
  });
  const best = hits[0]?.rrfScore;
  if (best != null && Number.isFinite(best) && best > 0) {
    for (const hit of hits) hit.normalizedScore = Math.min(1, Math.max(0, hit.rrfScore / best));
  }
  return { hits, failures };
}
export function fuseRouteResults(results: readonly (RetrievalRouteResult | RetrievalRouteFailure)[], topK: number): FusedRetrievalResult {
  const result = fuseRouteResultsPooled(results);
  result.hits = result.hits.slice(0, topK);
  return result;
}
export function applyMaxPerResource(hits: FusedRetrievalHit[], maxPerResource: number): void {
  if (maxPerResource === 0) return;
  const counts = new Map<string, number>();
  const kept = hits.filter(h => {
    const id = h.hit.identity.resourceId, count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    return count <= maxPerResource;
  });
  hits.splice(0, hits.length, ...kept);
}
function textBigramJaccard(left: string, right: string): number {
  const bigrams = (s: string) => {
    const chars = Array.from(s).filter(c => !/\p{White_Space}/u.test(c)).slice(0, 160);
    return new Set(chars.slice(1).map((c, i) => chars[i]! + c));
  };
  const l = bigrams(left), r = bigrams(right);
  if (!l.size || !r.size) return 0;
  const intersection = [...l].filter(b => r.has(b)).length;
  return intersection / new Set([...l, ...r]).size;
}
function approximateHitSimilarity(left: FusedRetrievalHit, right: FusedRetrievalHit): number {
  if (identityKey(left.hit.identity) === identityKey(right.hit.identity)) return 1;
  if (left.hit.identity.resourceId === right.hit.identity.resourceId) return left.hit.identity.pageIndex === right.hit.identity.pageIndex ? .9 : .6;
  return textBigramJaccard(left.hit.text, right.hit.text);
}
export function applyMmrDiversity(candidates: readonly FusedRetrievalHit[], lambda: number, topK: number): FusedRetrievalHit[] {
  const pool = [...candidates];
  if (pool.length <= 1 || topK === 0) return pool.slice(0, topK);
  lambda = Math.min(1, Math.max(0, lambda));
  const selected: FusedRetrievalHit[] = [];
  while (selected.length < topK && pool.length) {
    let bestIndex = 0, bestScore = -Infinity;
    pool.forEach((candidate, index) => {
      const similarity = selected.reduce((max, chosen) => Math.max(max, approximateHitSimilarity(candidate, chosen)), 0);
      const score = lambda * (candidate.normalizedScore ?? candidate.rrfScore) - (1 - lambda) * similarity;
      if (score > bestScore) { bestScore = score; bestIndex = index; }
    });
    selected.push(pool.splice(bestIndex, 1)[0]!);
  }
  return selected;
}
