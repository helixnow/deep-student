/**
 * Runtime orchestration from `crates/dstu-vfs/src/vfs/unified_retriever.rs`.
 *
 * The pure planning helpers live in `retrieval-planner.ts`; this module owns the
 * capability snapshot, route execution, image fallback and circuit breakers.
 * Native Lance transport and L02 LLM calls are injected (see `RetrievalRuntime`),
 * so tests can exercise both successful and failing routes without network/native
 * dependencies.
 */
import { rustTrim } from '../../../platform/util/portable.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type {
  CapabilitySnapshot, FusedRetrievalHit, IndexProfileCapability, QueryDerivationAttempt,
  QueryModality, RetrievalRouteFailure, RetrievalRouteResult, UnifiedRetrievalRequest,
  UnifiedRetrievalResponse, VfsLanceSearchResult, VfsLanceStore,
} from '../api.ts';
import { listActiveProfiles } from '../repository/embedding-dim.ts';
import { scopedVectorResourceIds } from '../repository/retrieval.ts';
import {
  executeFtsRoute, isMultimodalScopeHit, resolveRetrievalMountScope,
  validateRetrievalRequest, type RetrievalMountScope,
} from './unified-retriever.ts';
import {
  aggregateEmbeddingCapability, dedicatedOcrConfigIds, hasDedicatedOcrCapability,
  indexProfileCapability, isGeneralTextGenerationConfig, selectMultimodalObserver,
  validateRouteConfigFingerprint, type OcrEngineType, type OcrRuntimeCandidate,
  type RetrievalApiConfig,
} from './unified-retriever.ts';
import {
  ProfileCircuitBreaker, availableCapability, capabilityAvailable, fuseRouteResults,
  normalizeRouteFamilyWeights, planDerivedTextRoutes, planRetrieval,
} from './retrieval-planner.ts';
import { MultimodalInput, type MultimodalInput as MultimodalInputValue } from './multimodal.ts';
import type { LaneLogger } from './logger.ts';
import type { BlobConfine } from './blob-path.ts';

export const ROUTE_TIMEOUT_MS = 30_000;

/** Minimal L02 surface needed by unified retrieval. */
export interface RetrievalRuntime {
  getApiConfigs(): Promise<RetrievalApiConfig[]>;
  getStructuredOcrCandidates(): Promise<ReadonlyArray<readonly [RetrievalApiConfig, OcrEngineType]>>;
  getFreeTextOcrCandidates(): Promise<OcrRuntimeCandidate[]>;
  callEmbeddingApi(texts: string[], modelId: string): Promise<number[][]>;
  callMultimodalEmbeddingApi(inputs: MultimodalInputValue[], modelId: string): Promise<number[][]>;
  observeImage(configId: string, prompt: string, image: { mime: string; base64: string }): Promise<string>;
  ocrImage(image: { mime: string; base64: string }): Promise<string>;
}

export interface UnifiedRetrieverDeps {
  readonly db: SqlExecutor;
  readonly blobsDir: string;
  /** 真实路径包含判断（`ctx.files` 作用域）；缺省只做词法包含判断。 */
  readonly blobConfine?: BlobConfine;
  readonly lanceStore: VfsLanceStore | null;
  readonly runtime: RetrievalRuntime;
  readonly routeTimeoutMs?: number;
  readonly attachMediaTimeRanges?: (hits: FusedRetrievalHit[]) => void;
  /** Cordis logger (`ctx.logger('vfs-index')`); diagnostics only. */
  readonly logger?: LaneLogger;
}

export class RetrievalRuntimeError extends Error {
  readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = 'RetrievalRuntimeError';
    this.code = 'VFS_INTERNAL';
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------- circuits

const PROFILE_CIRCUITS = new Map<string, ProfileCircuitBreaker>();

function circuitNowMs(): number {
  return Math.floor(performance.now());
}

export function profileCircuitRejection(profileId: string): string | null {
  return PROFILE_CIRCUITS.get(profileId)?.rejectionReason(circuitNowMs()) ?? null;
}

function acquireProfileCircuit(profileId: string): void {
  const breaker = PROFILE_CIRCUITS.get(profileId) ?? new ProfileCircuitBreaker();
  PROFILE_CIRCUITS.set(profileId, breaker);
  const decision = breaker.decision(circuitNowMs());
  if (decision.kind === 'reject_open') {
    throw new Error(`profile circuit open; route skipped; retry after ${decision.retryAfterMs}ms`);
  }
  if (decision.kind === 'reject_half_open') {
    throw new Error('profile circuit half-open probe already in flight; route skipped');
  }
}

function recordProfileCircuitSuccess(profileId: string): void {
  const breaker = PROFILE_CIRCUITS.get(profileId) ?? new ProfileCircuitBreaker();
  PROFILE_CIRCUITS.set(profileId, breaker);
  breaker.recordSuccess();
}

function recordProfileCircuitFailure(profileId: string): void {
  const breaker = PROFILE_CIRCUITS.get(profileId) ?? new ProfileCircuitBreaker();
  PROFILE_CIRCUITS.set(profileId, breaker);
  breaker.recordFailure(circuitNowMs());
}

/** Test helper mirroring the process-global Rust registry. */
export function resetProfileCircuitsForTest(): void {
  PROFILE_CIRCUITS.clear();
}

// ---------------------------------------------------------------- helpers

function capability(reason: string | null): import('../api.ts').CapabilityState {
  return reason === null
    ? availableCapability()
    : { ...availableCapability(), configured: false, healthy: false, reason };
}

function circuitOpenRouteFailures(
  profiles: readonly IndexProfileCapability[],
  queryModality: QueryModality,
  multimodalOnly: boolean,
): RetrievalRouteFailure[] {
  const failures: RetrievalRouteFailure[] = [];
  for (const profile of profiles) {
    if (!(profile.circuitOpen && profile.configured && profile.active && profile.healthy
      && profile.protocolCompatible && profile.indexCompatible && profile.dimension > 0
      && typeof profile.modelConfigId === 'string' && profile.modelConfigId.length > 0)) continue;
    const kinds: Array<'text_embedding' | 'multimodal_text' | 'multimodal_image'> = [];
    if (!multimodalOnly && profile.modality === 'text'
      && profile.embeddingProtocol === 'text-embedding-v1' && queryModality !== 'image') {
      kinds.push('text_embedding');
    } else if ((profile.modality === 'multimodal' || profile.modality === 'image')
      && profile.embeddingProtocol === 'multimodal-embedding-v1') {
      if (queryModality !== 'image') kinds.push('multimodal_text');
      if (queryModality !== 'text') kinds.push('multimodal_image');
    }
    const reason = profileCircuitRejection(profile.profileId)
      ?? 'profile circuit open; route skipped';
    for (const kind of kinds) {
      failures.push({
        routeId: `${kind.replaceAll('_', '')}:${profile.profileId}`.toLowerCase(),
        profileId: profile.profileId,
        dimension: profile.dimension,
        error: reason,
        timedOut: false,
      });
    }
  }
  return failures;
}

function requiredModelId(route: { routeId: string; modelConfigId: string | null }): string {
  if (route.modelConfigId === null || route.modelConfigId === '') {
    throw new RetrievalRuntimeError(`route ${route.routeId} has no model binding`);
  }
  return route.modelConfigId;
}

function requiredProfileId(route: { routeId: string; profileId: string | null }): string {
  if (route.profileId === null || route.profileId === '') {
    throw new RetrievalRuntimeError(`route ${route.routeId} has no profile`);
  }
  return route.profileId;
}

function requiredQueryText(request: UnifiedRetrievalRequest): string {
  const text = rustTrim(request.queryText ?? '');
  if (text === '') {
    throw new RetrievalRuntimeError("Invalid argument 'queryText': text retrieval route requires query text");
  }
  return text;
}

function validateDimension(route: { routeId: string; profileId: string | null; dimension: number | null }, embedding: readonly number[]): void {
  if (route.dimension !== embedding.length) {
    throw new RetrievalRuntimeError(
      `profile ${JSON.stringify(route.profileId)} index mismatch: expected dimension ${JSON.stringify(route.dimension)}, model returned ${embedding.length}`,
    );
  }
}

function imageEmbeddingHasCandidateCoverage(
  results: readonly (RetrievalRouteResult | RetrievalRouteFailure)[],
): boolean {
  return results.some((result) => !('error' in result)
    && result.route.kind === 'multimodal_image' && result.hits.length > 0);
}

function combineTextAndImageQuery(originalText: string | null, imageText: string): string {
  const original = rustTrim(originalText ?? '');
  return original === '' ? rustTrim(imageText) : `${original}\n\n[image semantics]\n${rustTrim(imageText)}`;
}

function imageObservationPrompt(originalText: string | null): string {
  const context = rustTrim(originalText ?? '');
  const suffix = context === '' ? '' : `\n用户同时提供的文本查询：${context}`;
  return `请直接观察原图，为知识库检索生成忠实、紧凑的文本查询。保留可见文字、主体、场景、结构、图表关系和关键属性；不要回答问题，不要臆测。最后另起一行给出 3 到 12 个用空格分隔的检索关键词。${suffix}`;
}

interface ImagePayload { mime: string; base64: string }

function imagePayloadFromRequest(request: UnifiedRetrievalRequest): ImagePayload {
  const raw = rustTrim(request.queryImageBase64 ?? '');
  if (raw === '') {
    throw new RetrievalRuntimeError("Invalid argument 'queryImageBase64': image query fallback requires original image bytes");
  }
  let mimeFromDataUrl: string | null = null;
  let base64 = raw;
  if (raw.startsWith('data:')) {
    const comma = raw.indexOf(',');
    if (comma < 0) {
      throw new RetrievalRuntimeError("Invalid argument 'queryImageBase64': invalid image data URL");
    }
    const metadata = raw.slice(5, comma);
    if (!metadata.endsWith(';base64')) {
      throw new RetrievalRuntimeError("Invalid argument 'queryImageBase64': image data URL must use base64 encoding");
    }
    mimeFromDataUrl = metadata.slice(0, -';base64'.length);
    base64 = raw.slice(comma + 1);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    throw new RetrievalRuntimeError("Invalid argument 'queryImageBase64': invalid image base64");
  }
  const mediaType = rustTrim(request.queryImageMediaType ?? '');
  return {
    mime: mediaType !== '' ? mediaType : mimeFromDataUrl ?? 'image/png',
    base64,
  };
}

function queryDerivationFailure(
  provenance: { kind: 'multimodal_observation' | 'ocr'; modelConfigId?: string | null },
  error: string,
  timedOut: boolean,
): RetrievalRouteFailure {
  const stage = provenance.kind === 'multimodal_observation' ? 'mm_observation' : 'ocr';
  const producer = provenance.modelConfigId ?? 'engine_chain';
  return {
    routeId: `query_derivation:${stage}:${producer}`,
    profileId: null,
    dimension: null,
    error,
    timedOut,
    queryDerivation: { ...provenance },
  };
}

function derivedCircuitOpenFailures(
  profiles: readonly IndexProfileCapability[],
  provenance: { kind: 'multimodal_observation' | 'ocr'; modelConfigId?: string | null },
): RetrievalRouteFailure[] {
  const suffix = provenance.kind === 'multimodal_observation' ? 'mm_observation' : 'ocr';
  return circuitOpenRouteFailures(profiles, 'text', false)
    .filter((failure) => failure.profileId !== null && profiles.some((profile) => profile.profileId === failure.profileId
      && profile.modality === 'text' && profile.embeddingProtocol === 'text-embedding-v1'))
    .map((failure) => ({
      ...failure,
      routeId: `derived_${suffix}:${failure.routeId}`,
      queryDerivation: { ...provenance },
    }));
}

function applyPlanRouteWeights(
  results: readonly (RetrievalRouteResult | RetrievalRouteFailure)[],
  routes: readonly { routeId: string; weight: number }[],
): (RetrievalRouteResult | RetrievalRouteFailure)[] {
  const weights = new Map(routes.map((route) => [route.routeId, route.weight]));
  return results.map((result) => {
    if ('error' in result) return result;
    const weight = weights.get(result.route.routeId);
    return weight === undefined ? result : { ...result, route: { ...result.route, weight } };
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new RetrievalRuntimeError(timeoutMessage));
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ---------------------------------------------------------------- service

export class VfsUnifiedRetriever {
  private readonly db: SqlExecutor;
  private readonly blobsDir: string;
  private readonly blobConfine: BlobConfine | undefined;
  private readonly lanceStore: VfsLanceStore | null;
  private readonly runtime: RetrievalRuntime;
  private readonly routeTimeoutMs: number;
  private readonly attachMediaTimeRanges: UnifiedRetrieverDeps['attachMediaTimeRanges'];
  private readonly logger: LaneLogger | undefined;

  constructor(deps: UnifiedRetrieverDeps) {
    this.db = deps.db;
    this.blobsDir = deps.blobsDir;
    this.blobConfine = deps.blobConfine;
    this.lanceStore = deps.lanceStore;
    this.runtime = deps.runtime;
    this.routeTimeoutMs = deps.routeTimeoutMs ?? ROUTE_TIMEOUT_MS;
    this.attachMediaTimeRanges = deps.attachMediaTimeRanges;
    this.logger = deps.logger;
  }

  async search(request: UnifiedRetrievalRequest): Promise<UnifiedRetrievalResponse> {
    return this.searchWithScope(request, false);
  }

  async searchMultimodal(request: UnifiedRetrievalRequest): Promise<UnifiedRetrievalResponse> {
    return this.searchWithScope(request, true);
  }

  async retrieve(request: UnifiedRetrievalRequest): Promise<UnifiedRetrievalResponse> {
    return this.search(request);
  }

  async inspectCapabilities(): Promise<CapabilitySnapshot> {
    const { snapshot } = await this.capabilitySnapshotInner(false);
    return snapshot;
  }

  private async searchWithScope(
    request: UnifiedRetrievalRequest,
    multimodalOnly: boolean,
  ): Promise<UnifiedRetrievalResponse> {
    validateRetrievalRequest(request);
    const mountScope =
      request.folderIds !== null && request.folderIds.length > 0
        ? resolveRetrievalMountScope(this.db, request.folderIds)
        : null;
    const { snapshot, profiles, observerConfigId } = await this.capabilitySnapshotInner(true);
    const skippedCircuitFailures = circuitOpenRouteFailures(profiles, request.queryModality, multimodalOnly);
    const plan = planRetrieval(snapshot, request.queryModality, profiles, request.topK);
    if (multimodalOnly) {
      plan.routes = plan.routes.filter((route) => route.kind === 'multimodal_text' || route.kind === 'multimodal_image');
    }

    let routeResults: (RetrievalRouteResult | RetrievalRouteFailure)[];
    let pendingNonImage: { routes: typeof plan.routes; promise: Promise<(RetrievalRouteResult | RetrievalRouteFailure)[]> } | null = null;

    if (request.queryModality !== 'text') {
      const imageRoutes = plan.routes.filter((route) => route.kind === 'multimodal_image');
      const nonImageRoutes = plan.routes.filter((route) => route.kind !== 'multimodal_image');
      const promise = nonImageRoutes.length > 0 ? this.executeRoutes(request, nonImageRoutes, mountScope) : null;
      pendingNonImage = promise === null ? null : { routes: nonImageRoutes, promise };
      routeResults = await this.executeRoutes(request, imageRoutes, mountScope);
    } else {
      routeResults = await this.executeRoutes(request, plan.routes, mountScope);
    }

    const needsImageFallback = request.queryModality !== 'text'
      && !imageEmbeddingHasCandidateCoverage(routeResults);
    let queryDerivations: QueryDerivationAttempt[] = [];

    if (needsImageFallback) {
      const derived = await this.deriveImageQuery(request, plan.imageFallbackChain, observerConfigId);
      routeResults.push(...derived.failures);
      queryDerivations = derived.attempts;
      if (derived.derived !== null) {
        const { text: imageText, provenance } = derived.derived;
        const derivedRequest: UnifiedRetrievalRequest = {
          ...request,
          queryText: combineTextAndImageQuery(request.queryText, imageText),
          queryModality: 'text',
          queryImageBase64: null,
          queryImageMediaType: null,
        };
        const derivedRoutes = planDerivedTextRoutes(snapshot, profiles, plan.topK, provenance);
        skippedCircuitFailures.push(...derivedCircuitOpenFailures(profiles, provenance));
        plan.routes.push(...derivedRoutes);
        routeResults.push(...await this.executeRoutes(derivedRequest, derivedRoutes, mountScope));
      } else if (queryDerivations.length === 0) {
        routeResults.push({
          routeId: 'query_derivation:image_semantics_unavailable',
          profileId: null,
          dimension: null,
          error: plan.imageFallbackUnavailableReason
            ?? 'image embedding produced no candidates and no image-to-text fallback succeeded',
          timedOut: false,
        });
      }
    }

    if (pendingNonImage !== null) {
      try {
        routeResults.push(...await pendingNonImage.promise);
      } catch (error) {
        const text = `route batch task failed: ${messageOf(error)}`;
        routeResults.push(...pendingNonImage.routes.map((route) => ({
          routeId: route.routeId,
          profileId: route.profileId,
          dimension: route.dimension,
          error: text,
          timedOut: false,
          ...(route.queryDerivation !== undefined ? { queryDerivation: route.queryDerivation } : {}),
        })));
      }
    }

    normalizeRouteFamilyWeights(plan.routes);
    routeResults = applyPlanRouteWeights(routeResults, plan.routes);
    const result = fuseRouteResults(routeResults, plan.topK);
    if (multimodalOnly) result.hits = result.hits.filter(isMultimodalScopeHit);
    this.attachMediaTimeRanges?.(result.hits);
    result.failures = [...skippedCircuitFailures, ...result.failures];
    return { capabilitySnapshot: snapshot, plan, result, queryDerivations };
  }

  private async executeRoutes(
    request: UnifiedRetrievalRequest,
    routes: readonly import('../api.ts').PlannedRetrievalRoute[],
    mountScope: RetrievalMountScope | null,
  ): Promise<(RetrievalRouteResult | RetrievalRouteFailure)[]> {
    return Promise.all(routes.map(async (route): Promise<RetrievalRouteResult | RetrievalRouteFailure> => {
      if (route.profileId !== null) {
        try {
          acquireProfileCircuit(route.profileId);
        } catch (error) {
          return {
            routeId: route.routeId,
            profileId: route.profileId,
            dimension: route.dimension,
            error: messageOf(error),
            timedOut: false,
            ...(route.queryDerivation !== undefined ? { queryDerivation: route.queryDerivation } : {}),
          };
        }
      }
      const started = performance.now();
      let outcome: RetrievalRouteResult | RetrievalRouteFailure;
      try {
        const hits = await withTimeout(
          this.executeRoute(request, route, mountScope),
          this.routeTimeoutMs,
          `route timed out after ${Math.floor(this.routeTimeoutMs / 1000)}s`,
        );
        outcome = { route: { ...route }, hits, elapsedMs: Math.floor(performance.now() - started) };
      } catch (error) {
        const timedOut = messageOf(error).startsWith('route timed out after ');
        outcome = {
          routeId: route.routeId,
          profileId: route.profileId,
          dimension: route.dimension,
          error: messageOf(error),
          timedOut,
          ...(route.queryDerivation !== undefined ? { queryDerivation: route.queryDerivation } : {}),
        };
      }
      if (route.profileId !== null) {
        if ('error' in outcome) recordProfileCircuitFailure(route.profileId);
        else recordProfileCircuitSuccess(route.profileId);
      }
      return outcome;
    }));
  }

  private async executeRoute(
    request: UnifiedRetrievalRequest,
    route: import('../api.ts').PlannedRetrievalRoute,
    mountScope: RetrievalMountScope | null,
  ): Promise<import('../api.ts').RetrievalHit[]> {
    const lance = this.lanceStore;
    const vectorResourceIds = route.kind === 'full_text' ? null
      : scopedVectorResourceIds(this.db, mountScope, request.resourceIds);
    if (vectorResourceIds?.length === 0 && route.kind !== 'full_text') return [];
    switch (route.kind) {
      case 'full_text': {
        const query = rustTrim(request.queryText ?? '');
        return query === ''
          ? []
          : await executeFtsRoute(this.db, query, request, route.fetchLimit, this.blobsDir, this.blobConfine, mountScope);
      }
      case 'text_embedding': {
        if (lance === null) throw new RetrievalRuntimeError('Lance vector store is not available');
        const modelId = requiredModelId(route);
        const query = requiredQueryText(request);
        const vectors = await this.runtime.callEmbeddingApi([query], modelId);
        const embedding = vectors[0];
        if (embedding === undefined) throw new RetrievalRuntimeError('文本嵌入 API 返回空结果');
        validateDimension(route, embedding);
        await this.validateRuntimeFingerprint(route);
        const rows = await lance.vectorSearchProfileFull(
          requiredProfileId(route), embedding, route.fetchLimit, null,
          vectorResourceIds, request.resourceTypes, mountScope?.mountedResourceIds ?? null,
        );
        return await this.rowsToHits(rows, route, request, mountScope);
      }
      case 'multimodal_text': {
        if (lance === null) throw new RetrievalRuntimeError('Lance vector store is not available');
        const vectors = await this.runtime.callMultimodalEmbeddingApi(
          [MultimodalInput.text(requiredQueryText(request))], requiredModelId(route),
        );
        const embedding = vectors[0];
        if (embedding === undefined) throw new RetrievalRuntimeError('多模态文本嵌入 API 返回空结果');
        validateDimension(route, embedding);
        await this.validateRuntimeFingerprint(route);
        const rows = await lance.vectorSearchProfileFull(
          requiredProfileId(route), embedding, route.fetchLimit, null,
          vectorResourceIds, request.resourceTypes, mountScope?.mountedResourceIds ?? null,
        );
        return await this.rowsToHits(rows, route, request, mountScope);
      }
      case 'multimodal_image': {
        if (lance === null) throw new RetrievalRuntimeError('Lance vector store is not available');
        const raw = rustTrim(request.queryImageBase64 ?? '');
        if (raw === '') {
          throw new RetrievalRuntimeError("Invalid argument 'queryImageBase64': multimodal image route requires original image bytes");
        }
        const mediaType = rustTrim(request.queryImageMediaType ?? '');
        const vectors = await this.runtime.callMultimodalEmbeddingApi(
          [MultimodalInput.imageBase64(raw, mediaType === '' ? 'image/png' : mediaType)],
          requiredModelId(route),
        );
        const embedding = vectors[0];
        if (embedding === undefined) throw new RetrievalRuntimeError('多模态图片嵌入 API 返回空结果');
        validateDimension(route, embedding);
        await this.validateRuntimeFingerprint(route);
        const rows = await lance.vectorSearchProfileFull(
          requiredProfileId(route), embedding, route.fetchLimit, null,
          vectorResourceIds, request.resourceTypes, mountScope?.mountedResourceIds ?? null,
        );
        return await this.rowsToHits(rows, route, request, mountScope);
      }
    }
  }

  private rowsToHits(
    rows: readonly VfsLanceSearchResult[],
    route: import('../api.ts').PlannedRetrievalRoute,
    request: UnifiedRetrievalRequest,
    mountScope: RetrievalMountScope | null,
  ): Promise<import('../api.ts').RetrievalHit[]> {
    return requireLanceRowsToHits(this.db, rows, route, request, this.blobsDir, this.blobConfine, mountScope);
  }

  private async validateRuntimeFingerprint(route: import('../api.ts').PlannedRetrievalRoute): Promise<void> {
    const configs = await this.runtime.getApiConfigs();
    validateRouteConfigFingerprint(route, configs);
  }

  private async capabilitySnapshotInner(
    repairProfiles: boolean,
  ): Promise<{ snapshot: CapabilitySnapshot; profiles: IndexProfileCapability[]; observerConfigId: string | null }> {
    if (repairProfiles && this.lanceStore !== null) {
      const initial = listActiveProfiles(this.db, null);
      await Promise.all(initial.map(async (profile) => {
        try {
          await withTimeout(
            this.lanceStore!.ensureProfileReady(profile.id),
            this.routeTimeoutMs,
            `profile readiness repair timed out for ${profile.id}`,
          );
        } catch (repairError) {
          this.logger?.warn(`[VfsUnifiedRetriever] Readiness repair failed: ${messageOf(repairError)}`);
        }
      }));
    }
    const activeProfiles = listActiveProfiles(this.db, null);
    let configs: RetrievalApiConfig[] = [];
    try {
      configs = await this.runtime.getApiConfigs();
    } catch {
      configs = [];
    }
    const configuredModels = new Map(configs.map((config) => [config.id, config]));
    let structured: ReadonlyArray<readonly [RetrievalApiConfig, OcrEngineType]> = [];
    try {
      structured = await this.runtime.getStructuredOcrCandidates();
    } catch {
      structured = [];
    }
    let freeText: OcrRuntimeCandidate[] = [];
    try {
      freeText = await this.runtime.getFreeTextOcrCandidates();
    } catch {
      freeText = [];
    }
    const dedicatedIds = dedicatedOcrConfigIds(freeText);
    const dedicatedAvailable = hasDedicatedOcrCapability(freeText.map((candidate) => (
      candidate.kind === 'remote' ? candidate.engineType : 'system_ocr'
    )));
    const observer = selectMultimodalObserver(configs, structured, dedicatedIds);
    const profiles = activeProfiles.map((profile) => indexProfileCapability(
      profile, configuredModels, profileCircuitRejection(profile.id) !== null,
    ));
    const textEmbedding = aggregateEmbeddingCapability(profiles, 'text');
    const multimodalEmbedding = aggregateEmbeddingCapability(profiles, 'multimodal');
    const textModel = configs.some((config) => isGeneralTextGenerationConfig(config, dedicatedIds))
      ? availableCapability()
      : capability('no enabled pure-text generation model');
    const multimodalModel = observer !== null
      ? availableCapability()
      : capability('no enabled general-purpose multimodal generation model');
    const ocr = dedicatedAvailable ? availableCapability() : capability('no enabled OCR engine');
    return {
      snapshot: { textEmbedding, multimodalEmbedding, textModel, multimodalModel, ocr },
      profiles,
      observerConfigId: observer?.id ?? null,
    };
  }

  private async deriveImageQuery(
    request: UnifiedRetrievalRequest,
    stages: readonly import('../api.ts').PlannedQueryDerivation[],
    observerConfigId: string | null,
  ): Promise<{
    derived: { text: string; provenance: import('../api.ts').QueryDerivationProvenance } | null;
    failures: RetrievalRouteFailure[];
    attempts: QueryDerivationAttempt[];
  }> {
    const failures: RetrievalRouteFailure[] = [];
    const attempts: QueryDerivationAttempt[] = [];
    for (const stage of stages) {
      if (stage.kind === 'multimodal_observation') {
        if (observerConfigId === null) continue;
        const provenance = { kind: 'multimodal_observation' as const, modelConfigId: observerConfigId };
        const started = performance.now();
        try {
          const payload = imagePayloadFromRequest(request);
          const prompt = imageObservationPrompt(request.queryText);
          const output = (await withTimeout(
            this.runtime.observeImage(observerConfigId, prompt, payload),
            this.routeTimeoutMs,
            `multimodal query observation timed out after ${Math.floor(this.routeTimeoutMs / 1000)}s`,
          ));
          const elapsedMs = Math.floor(performance.now() - started);
          if (output !== '') {
            attempts.push({ provenance, succeeded: true, derivedQuery: output, elapsedMs });
            return { derived: { text: output, provenance }, failures, attempts };
          }
          const error = 'multimodal observation returned an empty query';
          failures.push(queryDerivationFailure(provenance, error, false));
          attempts.push({ provenance, succeeded: false, error, elapsedMs });
        } catch (error) {
          const text = messageOf(error);
          const timedOut = text.startsWith('multimodal query observation timed out after ');
          failures.push(queryDerivationFailure(provenance, text, timedOut));
          attempts.push({ provenance, succeeded: false, error: text, elapsedMs: Math.floor(performance.now() - started) });
        }
      } else {
        const provenance = { kind: 'ocr' as const };
        const started = performance.now();
        try {
          const payload = imagePayloadFromRequest(request);
          const output = (await withTimeout(
            this.runtime.ocrImage(payload),
            this.routeTimeoutMs,
            `OCR query derivation timed out after ${Math.floor(this.routeTimeoutMs / 1000)}s`,
          ));
          const elapsedMs = Math.floor(performance.now() - started);
          if (output !== '') {
            attempts.push({ provenance, succeeded: true, derivedQuery: output, elapsedMs });
            return { derived: { text: output, provenance }, failures, attempts };
          }
          const error = 'OCR returned no visible text; non-text image semantics remain unavailable';
          failures.push(queryDerivationFailure(provenance, error, false));
          attempts.push({ provenance, succeeded: false, error, elapsedMs });
        } catch (error) {
          const text = messageOf(error);
          const timedOut = text.startsWith('OCR query derivation timed out after ');
          failures.push(queryDerivationFailure(provenance, text, timedOut));
          attempts.push({ provenance, succeeded: false, error: text, elapsedMs: Math.floor(performance.now() - started) });
        }
      }
    }
    return { derived: null, failures, attempts };
  }
}

// Imported lazily to avoid a cycle: unified-retriever imports planner, not this module.
import { lanceRowsToHits as requireLanceRowsToHits } from './unified-retriever.ts';

export type { FusedRetrievalHit };
