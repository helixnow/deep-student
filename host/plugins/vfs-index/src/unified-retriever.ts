/**
 * Capability-aware unified VFS retrieval runtime.
 *
 * Ported from `crates/dstu-vfs/src/vfs/unified_retriever.rs`. This module owns
 * the pure capability/planning helpers plus the SQLite text-ledger route and
 * Lance-row post-processing; native Lance/LLM transports stay behind services.
 */
import { rustTrim } from '../../../platform/util/portable.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { containedBlobPathAsync, type BlobConfine } from './blob-path.ts';
import type {
  CapabilityState, FusedRetrievalHit, IndexProfileCapability, QueryModality, RetrievalHit,
  RetrievalRouteKind, UnifiedRetrievalRequest,
} from '../api.ts';
import {
  identityKey, profileUsable, unavailableCapability,
} from './retrieval-planner.ts';
import {
  defaultBm25Options, bm25Scores, tokenize, isCjkChar,
} from './lexical-bm25.ts';
import {
  embeddingProtocolForModality, MAX_DIMENSION, MIN_DIMENSION,
  modelFingerprintWithTransport, type VfsIndexProfile,
} from '../repository/embedding-dim.ts';
import {
  activeSegmentRowIds, blobRelativePath, getResource, lexicalCandidateRows,
  pageTextForUnit, resolveRetrievalMountScope, resourceFolderId, sourceDisplayTitle,
  type RetrievalMountScope,
} from '../repository/retrieval.ts';
export { resolveRetrievalMountScope, type RetrievalMountScope };

export const MAX_FTS_SCAN = 1000;
export const MAX_FTS_TERMS = 16;
export const MAX_FTS_TERM_CHARS = 64;
export const MAX_BM25_TERMS = 64;

export class RetrievalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RetrievalError';
    this.code = code;
  }
}

export function invalidArgument(param: string, reason: string): RetrievalError {
  return new RetrievalError('VFS_INVALID_ARGUMENT', `Invalid argument '${param}': ${reason}`);
}

export function other(message: string): RetrievalError {
  return new RetrievalError('VFS_INTERNAL', message);
}

// ------------------------------------------------------------------ config

/**
 * Runtime view of `ApiConfig` needed by retrieval planning. L02 owns the full
 * model; only these fields participate in capability/fingerprint decisions.
 */
export interface RetrievalApiConfig {
  readonly id: string;
  readonly model: string;
  readonly enabled: boolean;
  readonly isEmbedding: boolean;
  readonly isMultimodal: boolean;
  readonly isReranker?: boolean;
  readonly isImageGeneration?: boolean;
  readonly baseUrl?: string | null;
  readonly providerType?: string | null;
  readonly providerScope?: string | null;
  readonly apiProtocol?: string | null;
  readonly modelAdapter?: string | null;
}

export type OcrEngineType =
  | 'deepseek_ocr'
  | 'paddle_ocr_vl'
  | 'paddle_ocr_vl_v1'
  | 'glm4v_ocr'
  | 'generic_vlm'
  | 'system_ocr';

export type OcrRuntimeCandidate =
  | { readonly kind: 'remote'; readonly config: RetrievalApiConfig; readonly engineType: OcrEngineType }
  | { readonly kind: 'system_ocr' };

export function isDedicatedOcr(engine: OcrEngineType): boolean {
  return engine === 'deepseek_ocr' || engine === 'paddle_ocr_vl'
    || engine === 'paddle_ocr_vl_v1' || engine === 'system_ocr';
}

const glmVision = /glm-(?:4\.[5-9]|4\.\d{2,}|[5-9](?:\.\d+)?)v/i;

/** `OcrAdapterFactory::infer_engine_from_model`. */
export function inferEngineFromModel(model: string): OcrEngineType {
  const lower = model.toLowerCase();
  if (lower === 'system') return 'system_ocr';
  if (glmVision.test(model)) return 'glm4v_ocr';
  if (lower.includes('deepseek') && lower.includes('ocr')) return 'deepseek_ocr';
  if (lower.includes('paddleocr-vl-1') || lower.includes('paddleocr_vl_1')) return 'paddle_ocr_vl';
  if (lower.includes('paddle') || lower.includes('paddleocr')) return 'paddle_ocr_vl_v1';
  return 'generic_vlm';
}

export function hasDedicatedOcrCapability(engineTypes: Iterable<OcrEngineType>): boolean {
  for (const engine of engineTypes) {
    if (isDedicatedOcr(engine)) return true;
  }
  return false;
}

export function dedicatedOcrConfigIds(candidates: readonly OcrRuntimeCandidate[]): Set<string> {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.kind === 'remote' && isDedicatedOcr(candidate.engineType)) {
      ids.add(candidate.config.id);
    }
  }
  return ids;
}

export function validGenerationConfig(config: RetrievalApiConfig): boolean {
  return config.enabled && !config.isEmbedding && !config.isReranker && !config.isImageGeneration;
}

export function isGeneralTextGenerationConfig(
  config: RetrievalApiConfig,
  dedicatedOcrConfigIds: ReadonlySet<string>,
): boolean {
  return validGenerationConfig(config)
    && !config.isMultimodal
    && !dedicatedOcrConfigIds.has(config.id);
}

/** `select_multimodal_observer`: observer only, never a dedicated OCR model. */
export function selectMultimodalObserver(
  configs: readonly RetrievalApiConfig[],
  prioritizedOcrConfigs: ReadonlyArray<readonly [RetrievalApiConfig, OcrEngineType]>,
  dedicatedOcrConfigIds: ReadonlySet<string>,
): RetrievalApiConfig | null {
  const priorityById = new Map<string, number>();
  prioritizedOcrConfigs.forEach(([config, engine], rank) => {
    if (!isDedicatedOcr(engine)) priorityById.set(config.id, rank);
  });
  const candidates = configs
    .filter((config) => validGenerationConfig(config)
      && config.isMultimodal
      && !dedicatedOcrConfigIds.has(config.id)
      && !isDedicatedOcr(inferEngineFromModel(config.model)))
    .slice();
  candidates.sort((left, right) => {
    const leftRank = priorityById.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = priorityById.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return candidates[0] ?? null;
}

// ------------------------------------------------------------------ request

function debugModality(modality: QueryModality): string {
  return modality === 'text' ? 'Text' : modality === 'image' ? 'Image' : 'Mixed';
}

/** `UnifiedRetrievalRequest::validate`. */
export function validateRetrievalRequest(request: UnifiedRetrievalRequest): void {
  const hasText = request.queryText !== null && rustTrim(request.queryText) !== '';
  const hasImage = request.queryImageBase64 !== null && rustTrim(request.queryImageBase64) !== '';
  const valid = request.queryModality === 'text'
    ? hasText
    : request.queryModality === 'image'
      ? hasImage
      : hasText && hasImage;
  if (valid) return;
  throw invalidArgument(
    'query',
    `query payload does not match ${debugModality(request.queryModality)} mode (text=${hasText}, image=${hasImage})`,
  );
}

/** `partition_image_fallback_gate_routes`: only ME image routes take the gate. */
export function partitionImageFallbackGateRoutes<T extends { kind: RetrievalRouteKind }>(
  routes: readonly T[],
): [T[], T[]] {
  const gated: T[] = [];
  const concurrent: T[] = [];
  for (const route of routes) {
    if (route.kind === 'multimodal_image') gated.push(route);
    else concurrent.push(route);
  }
  return [gated, concurrent];
}

export function isMultimodalScopeHit(hit: FusedRetrievalHit): boolean {
  const blobHash = hit.hit.blobHash;
  const imageUrl = hit.hit.imageUrl;
  return (blobHash !== null && blobHash !== '')
    || (imageUrl !== null && imageUrl !== '')
    || hit.provenance.some((provenance) => provenance.routeKind === 'multimodal_text'
      || provenance.routeKind === 'multimodal_image');
}

// ------------------------------------------------------------------ profiles

function protocolOrNull(modality: string): string | null {
  try {
    return embeddingProtocolForModality(modality);
  } catch {
    // Rust `embedding_protocol_for_modality(...).ok()`.
    return null;
  }
}

/** `embedding_dim_repo::model_fingerprint_for_config`; throws for unknown modality. */
export function modelFingerprintForConfig(config: RetrievalApiConfig, modality: string): string {
  const protocol = embeddingProtocolForModality(modality);
  return modelFingerprintWithTransport(config.id, config.model, protocol, {
    providerType: config.providerType ?? null,
    providerScope: config.providerScope ?? null,
    baseUrl: config.baseUrl ?? null,
    apiProtocol: config.apiProtocol ?? null,
    modelAdapter: config.modelAdapter ?? null,
  });
}

function runtimeFingerprintOrNull(config: RetrievalApiConfig, modality: string): string | null {
  try {
    return modelFingerprintForConfig(config, modality);
  } catch {
    // Rust `model_fingerprint_for_config(...).ok()`.
    return null;
  }
}

function profileFingerprintCompatible(
  profile: VfsIndexProfile,
  config: RetrievalApiConfig,
  protocolCompatible: boolean,
  dimensionCompatible: boolean,
  physicalIndexCompatible: boolean,
): boolean {
  const runtimeFingerprint = runtimeFingerprintOrNull(config, profile.modality);
  if (runtimeFingerprint !== null && runtimeFingerprint === profile.model_fingerprint) return true;
  const expectedLegacyFingerprint = `legacy:model-config:${config.id}`;
  return profile.model_fingerprint === expectedLegacyFingerprint
    && profile.model_config_id === config.id
    && protocolCompatible
    && dimensionCompatible
    && physicalIndexCompatible;
}

export function isProfileIndexCompatible(
  metric: string,
  version: number,
  schemaVersion: number,
): boolean {
  if (schemaVersion < 1) return false;
  if (metric === 'exact') return true;
  if (metric === 'cosine') return version >= 1;
  return false;
}

/** `index_profile_capability`. */
export function indexProfileCapability(
  profile: VfsIndexProfile,
  configuredModels: ReadonlyMap<string, RetrievalApiConfig>,
  circuitOpen: boolean,
): IndexProfileCapability {
  const expectedProtocol = protocolOrNull(profile.modality);
  const protocolCompatible = expectedProtocol === profile.embedding_protocol;
  const physicalIndexCompatible = isProfileIndexCompatible(
    profile.ann_metric,
    profile.ann_index_version,
    profile.schema_version,
  );
  const dimensionCompatible = profile.dimension >= MIN_DIMENSION && profile.dimension <= MAX_DIMENSION;
  const modelConfig = profile.model_config_id === null
    ? undefined
    : configuredModels.get(profile.model_config_id);
  const runtimeModelFingerprint = modelConfig === undefined
    ? null
    : runtimeFingerprintOrNull(modelConfig, profile.modality);
  const fingerprintCompatible = modelConfig !== undefined
    && profileFingerprintCompatible(
      profile,
      modelConfig,
      protocolCompatible,
      dimensionCompatible,
      physicalIndexCompatible,
    );
  const modelHealthy = modelConfig !== undefined
    && modelConfig.enabled
    && modelConfig.isEmbedding
    && !modelConfig.isReranker
    && (profile.modality === 'multimodal' || profile.modality === 'image'
      ? modelConfig.isMultimodal
      : !modelConfig.isMultimodal)
    && fingerprintCompatible;

  return {
    profileId: profile.id,
    dimension: Math.max(profile.dimension, 0),
    modality: profile.modality,
    embeddingProtocol: profile.embedding_protocol,
    modelConfigId: profile.model_config_id,
    runtimeModelFingerprint,
    configured: modelConfig !== undefined,
    active: ['active', 'building', 'queryable'].includes(profile.state),
    healthy: modelHealthy,
    circuitOpen,
    protocolCompatible,
    indexCompatible: physicalIndexCompatible && dimensionCompatible && fingerprintCompatible,
    weight: 1,
  };
}

function routeKindDebug(kind: RetrievalRouteKind): string {
  switch (kind) {
    case 'text_embedding': return 'TextEmbedding';
    case 'multimodal_text': return 'MultimodalText';
    case 'multimodal_image': return 'MultimodalImage';
    case 'full_text': return 'FullText';
  }
}

/** `validate_route_config_fingerprint`. */
export function validateRouteConfigFingerprint(
  route: { readonly routeId: string; readonly kind: RetrievalRouteKind; readonly modelConfigId: string | null;
    readonly expectedModelFingerprint?: string | null; readonly modality: string },
  configs: readonly RetrievalApiConfig[],
): void {
  const expected = route.expectedModelFingerprint;
  if (expected === undefined || expected === null || expected === '') {
    throw other(`vector route ${route.routeId} has no planned runtime model fingerprint`);
  }
  const modelConfigId = route.modelConfigId;
  if (modelConfigId === null) {
    throw other(`route ${route.routeId} has no model binding`);
  }
  const config = configs.find((entry) => entry.id === modelConfigId);
  if (config === undefined) {
    throw other(`stale vector route ${route.routeId}: model config ${modelConfigId} no longer exists`);
  }
  const routeProtocolValid = config.enabled
    && config.isEmbedding
    && !config.isReranker
    && (route.kind === 'text_embedding'
      ? !config.isMultimodal
      : route.kind === 'multimodal_text' || route.kind === 'multimodal_image'
        ? config.isMultimodal
        : false);
  if (!routeProtocolValid) {
    throw other(
      `stale vector route ${route.routeId}: model config ${modelConfigId} no longer supports ${routeKindDebug(route.kind)}`,
    );
  }
  const actual = modelFingerprintForConfig(config, route.modality);
  if (actual !== expected) {
    throw other(`stale vector route ${route.routeId}: model config ${modelConfigId} changed after planning`);
  }
}

/** `aggregate_embedding_capability`. */
export function aggregateEmbeddingCapability(
  profiles: readonly IndexProfileCapability[],
  modality: string,
): CapabilityState {
  const matching = profiles.filter((profile) => profile.modality === modality
    || (modality === 'multimodal' && profile.modality === 'image'));
  if (matching.length === 0) return unavailableCapability();
  const configured = matching.some((profile) => profile.configured && profile.active);
  const healthy = matching.some((profile) => profile.configured && profile.active && profile.healthy);
  const protocolCompatible = matching.some((profile) => profile.configured && profile.active
    && profile.healthy && profile.protocolCompatible);
  const viable = matching.filter((profile) => profile.configured
    && profile.active
    && profile.healthy
    && profile.protocolCompatible
    && profile.indexCompatible
    && profile.dimension > 0
    && profile.modelConfigId !== null
    && profile.modelConfigId !== '');
  const indexCompatible = viable.length > 0;
  const circuitOpen = viable.length > 0 && viable.every((profile) => profile.circuitOpen);
  const reason = circuitOpen
    ? 'all otherwise viable active profiles have open circuit breakers'
    : configured && healthy && protocolCompatible && indexCompatible
      ? null
      : 'no healthy protocol/index-compatible active profile';
  return { configured, healthy, circuitOpen, protocolCompatible, indexCompatible, reason };
}

// ------------------------------------------------------------------ lexical

/** Rust `char::is_alphanumeric` approximation; keeps `% _ \\ -` in terms. */
const edgeNonTerm = /^[^\p{L}\p{N}%_\\-]+|[^\p{L}\p{N}%_\\-]+$/gu;

function pushLexicalTerm(candidate: string, terms: string[], seen: Set<string>): void {
  const trimmed = rustTrim(candidate).replace(edgeNonTerm, '');
  const chars = [...trimmed];
  if (chars.length < 2) return;
  const bounded = chars.length > MAX_FTS_TERM_CHARS
    ? chars.slice(0, MAX_FTS_TERM_CHARS).join('')
    : trimmed;
  const key = bounded.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  terms.push(bounded);
}

/** Rust `str::lines`: split on `\n`, strip a trailing `\r`, drop final empty line. */
function rustLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

function lexicalKeywordPayload(line: string): string | null {
  const trimmed = rustTrim(line);
  const cjkIndex = trimmed.indexOf('：');
  const asciiIndex = trimmed.indexOf(':');
  const splitIndex = cjkIndex >= 0 ? cjkIndex : asciiIndex;
  if (splitIndex < 0) return null;
  const label = rustTrim(trimmed.slice(0, splitIndex)).replace(/[A-Z]/g, (character) => character.toLowerCase());
  if (![
    '关键词', '关键字', '检索关键词', '检索关键字',
    'keyword', 'keywords', 'search keywords',
  ].includes(label)) return null;
  return trimmed.slice(splitIndex + 1);
}

export function isCjk(character: string): boolean {
  const code = character.codePointAt(0);
  if (code === undefined) return false;
  return (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0xf900 && code <= 0xfaff);
}

/** Common question/function words: multi-character words before single characters. */
export const CJK_STOP_WORDS: readonly string[] = [
  '为什么', '是不是', '能不能', '有没有', '什么样', '怎么样', '怎么', '怎样', '如何',
  '什么', '多少', '哪些', '哪个', '哪里', '请问', '帮我', '告诉', '一下', '一次',
  '可以', '能够', '需要', '应该', '关于', '以及', '或者', '还是', '的', '地', '得',
  '了', '吗', '呢', '吧', '啊', '是', '和', '与', '及', '在', '把', '被', '对',
  '用', '我', '你', '他', '她', '它', '这', '那', '个', '能', '会', '要', '有',
  '就', '都', '也', '还',
];

function splitCjkSegments(candidate: string): string[] {
  let parts = [candidate];
  for (const stop of CJK_STOP_WORDS) {
    parts = parts.flatMap((part) => part.split(stop));
  }
  return parts
    .map(rustTrim)
    .filter((part) => [...part].length >= 2)
    .filter((part) => part !== candidate);
}

/** `extract_lexical_terms`: keyword lines first, then prose, segments, bigrams. */
export function extractLexicalTerms(query: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const remainingLines: string[] = [];

  for (const line of rustLines(query)) {
    const payload = lexicalKeywordPayload(line);
    if (payload !== null) {
      for (const candidate of payload.split(/[\s,，;；、|]/)) {
        pushLexicalTerm(candidate, terms, seen);
        if (terms.length === MAX_FTS_TERMS) return terms;
      }
    } else {
      remainingLines.push(line);
    }
  }

  const candidates = remainingLines.flatMap((line) => line.split(/[^\p{L}\p{N}]+/u));
  for (const candidate of candidates) {
    pushLexicalTerm(candidate, terms, seen);
    if (terms.length === MAX_FTS_TERMS) return terms;
  }

  const segments = candidates
    .filter((candidate) => [...candidate].some((character) => isCjk(character)))
    .flatMap((candidate) => splitCjkSegments(candidate));
  for (const segment of segments) {
    pushLexicalTerm(segment, terms, seen);
    if (terms.length === MAX_FTS_TERMS) return terms;
  }
  for (const segment of segments) {
    const chars = [...segment];
    if (chars.length < 3) continue;
    for (let index = 0; index + 2 <= chars.length; index += 1) {
      pushLexicalTerm(chars.slice(index, index + 2).join(''), terms, seen);
      if (terms.length === MAX_FTS_TERMS) return terms;
    }
  }
  return terms;
}

/** `bm25_query_terms`: shared tokenizer minus question/function-word noise. */
export function bm25QueryTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const token of tokenize(query)) {
    const single = [...token].length === 1;
    const allCjk = [...token].every((character) => isCjkChar(character));
    if (allCjk && CJK_STOP_WORDS.some((stop) => stop === token
      || (!single && stop.includes(token)))) {
      continue;
    }
    if (seen.has(token)) continue;
    seen.add(token);
    terms.push(token);
    if (terms.length === MAX_BM25_TERMS) break;
  }
  return terms;
}

export function escapedLikePattern(term: string): string {
  return `%${term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
}

function canonicalResourceType(raw: string): string {
  const lowered = raw.toLowerCase();
  if (lowered === 'insightcard') return 'insight_card';
  if ([
    'note', 'textbook', 'exam', 'translation', 'essay', 'image', 'file', 'retrieval',
    'mindmap', 'insight_card',
  ].includes(lowered)) return lowered;
  return 'file';
}

interface ResourceMetadataView {
  title: string | null;
  name: string | null;
}

function parseResourceMetadata(json: string | null): ResourceMetadataView | null {
  if (json === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    // Rust `serde_json::from_str(...).ok()`.
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ['name', 'title'] as const) {
    const field = record[key];
    if (field !== undefined && field !== null && typeof field !== 'string') return null;
  }
  return {
    title: typeof record['title'] === 'string' ? record['title'] : null,
    name: typeof record['name'] === 'string' ? record['name'] : null,
  };
}

function displayTitle(metadata: ResourceMetadataView | null): string | null {
  const title = metadata?.title ?? metadata?.name ?? null;
  return title !== null && rustTrim(title) !== '' ? title : null;
}

function parseJsonValue(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json);
  } catch {
    // Rust `serde_json::from_str(...).ok()`.
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function totalCompare(left: number, right: number): number {
  if (Number.isNaN(left) || Number.isNaN(right)) {
    if (Number.isNaN(left) && Number.isNaN(right)) return 0;
    return Number.isNaN(left) ? 1 : -1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * `VfsUnifiedRetriever::execute_fts_route`: SQLite text-ledger retrieval, BM25
 * rerank of the bounded candidate window, then identity dedupe.
 */
export async function executeFtsRoute(
  db: SqlExecutor,
  query: string,
  request: UnifiedRetrievalRequest,
  fetchLimit: number,
  blobsDir: string,
  confine?: BlobConfine,
  mountScope?: RetrievalMountScope | null,
): Promise<RetrievalHit[]> {
  const terms = extractLexicalTerms(query);
  if (terms.length === 0 || fetchLimit === 0) return [];
  const resolvedScope = mountScope !== undefined
    ? mountScope
    : resolveRetrievalMountScope(db, request.folderIds);
  const patterns = terms.map(escapedLikePattern);
  const rows = lexicalCandidateRows(db, {
    query,
    patterns,
    resourceIds: request.resourceIds,
    resourceTypes: request.resourceTypes,
    folderIds: resolvedScope !== null ? resolvedScope.effectiveFolderIds : request.folderIds,
    mountedResourceIds: resolvedScope !== null ? resolvedScope.mountedResourceIds : null,
    fetchLimit,
  });

  const bm25Terms = bm25QueryTerms(query);
  const scores = bm25Scores(bm25Terms, rows.map((row) => row.contentText), defaultBm25Options());
  const ranked = scores.map((score, index) => ({ index, score }));
  ranked.sort((left, right) => rows[left.index]!.exactRank - rows[right.index]!.exactRank
    || totalCompare(right.score, left.score)
    || left.index - right.index);

  const hits: RetrievalHit[] = [];
  const seen = new Set<string>();
  for (const { index, score } of ranked) {
    const row = rows[index]!;
    const resourceMetadata = parseResourceMetadata(row.resourceMetadataJson);
    const title = displayTitle(resourceMetadata)
      ?? (row.sourceId === null ? null : sourceDisplayTitle(db, row.sourceId));
    const metadata = parseJsonValue(row.metadataJson);
    // RUST-FIX(RF-W04-blob-relative-path-escape): Rust joins the synced relative_path unchecked.
    const imageUrl = row.blobRelativePath === null
      ? null
      : await containedBlobPathAsync(blobsDir, row.blobRelativePath, confine);
    const identity = {
      resourceId: row.resourceId,
      chunkIndex: row.chunkIndex,
      pageIndex: row.unitIndex,
      timeRange: null,
    };
    const key = identityKey(identity);
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({
      identity,
      embeddingId: row.embeddingId,
      text: row.contentText,
      title,
      resourceType: canonicalResourceType(row.resourceTypeRaw),
      sourceId: row.sourceId,
      folderId: row.folderId,
      blobHash: row.imageBlobHash,
      imageUrl,
      rawScore: score > 0 ? score : null,
      metadata,
    });
    if (hits.length >= fetchLimit) break;
  }
  return hits;
}

// ------------------------------------------------------------------ lance rows

function blobPathOrNull(db: SqlExecutor, hash: string): string | null {
  try {
    return blobRelativePath(db, hash);
  } catch {
    // Rust `VfsBlobRepo::get_blob_path(...).ok().flatten()`.
    return null;
  }
}

/** `VfsUnifiedRetriever::lance_rows_to_hits`. */
export async function lanceRowsToHits(
  db: SqlExecutor,
  rows: readonly import('../api.ts').VfsLanceSearchResult[],
  route: { readonly routeId: string; readonly profileId: string | null; readonly dimension: number | null },
  request: UnifiedRetrievalRequest,
  blobsDir: string,
  confine?: BlobConfine,
  mountScope?: RetrievalMountScope | null,
): Promise<RetrievalHit[]> {
  if (rows.length === 0) return [];
  if (route.profileId === null) throw other(`route ${route.routeId} has no profile`);
  if (route.dimension === null) throw other(`route ${route.routeId} has no embedding dimension`);
  const activeIds = activeSegmentRowIds(
    db,
    rows.map((row) => row.embedding_id),
    route.profileId,
    route.dimension,
  );
  const resolvedScope = mountScope !== undefined
    ? mountScope
    : resolveRetrievalMountScope(db, request.folderIds);
  const folderFilter = resolvedScope !== null
    ? new Set(resolvedScope.effectiveFolderIds)
    : request.folderIds === null
      ? null
      : new Set(request.folderIds);
  const mountedResourceSet =
    resolvedScope !== null && resolvedScope.mountedResourceIds.length > 0
      ? new Set(resolvedScope.mountedResourceIds)
      : null;
  const typeFilter = request.resourceTypes === null ? null : new Set(request.resourceTypes);
  const hits: RetrievalHit[] = [];
  for (const row of rows) {
    if (!activeIds.has(row.embedding_id)) continue;
    const resource = getResource(db, row.resource_id);
    if (resource === undefined) continue;
    const resourceType = canonicalResourceType(resource.resourceType);
    if (typeFilter !== null && !typeFilter.has(resourceType)) continue;
    const canonicalFolder = resourceFolderId(db, row.resource_id, resource.sourceId);
    if (
      folderFilter !== null
      && !(canonicalFolder !== null && folderFilter.has(canonicalFolder))
      && !(mountedResourceSet !== null && mountedResourceSet.has(row.resource_id))
    ) {
      continue;
    }
    const metadata = parseJsonValue(row.metadata_json);
    const metadataRecord = asRecord(metadata);
    const pageValue = metadataRecord?.['page_index'];
    const pageIndex = row.page_index ?? (
      typeof pageValue === 'number' && Number.isInteger(pageValue)
        && pageValue >= -2147483648 && pageValue <= 2147483647
        ? pageValue
        : null
    );
    const blobValue = metadataRecord?.['blob_hash'];
    const blobHash = typeof blobValue === 'string' ? blobValue : null;
    const relativePath = blobHash === null ? null : blobPathOrNull(db, blobHash);
    // RUST-FIX(RF-W04-blob-relative-path-escape): Rust `get_blob_path` joins the synced relative_path unchecked.
    const imageUrl = relativePath === null ? null : await containedBlobPathAsync(blobsDir, relativePath, confine);
    const sourceId = row.source_id !== null
      && row.source_id !== row.resource_id
      && !row.source_id.startsWith('res_')
      ? row.source_id
      : resource.sourceId ?? row.source_id;
    const resourceMetadata = parseResourceMetadata(resource.metadataJson);
    const title = displayTitle(resourceMetadata)
      ?? (sourceId === null ? null : sourceDisplayTitle(db, sourceId));
    const text = rustTrim(row.text) === ''
      ? (pageIndex === null ? row.text : pageTextForUnit(db, row.resource_id, pageIndex) ?? row.text)
      : row.text;
    hits.push({
      identity: {
        resourceId: row.resource_id,
        chunkIndex: row.chunk_index,
        pageIndex,
        timeRange: null,
      },
      embeddingId: row.embedding_id,
      text,
      title,
      resourceType,
      sourceId,
      folderId: canonicalFolder,
      blobHash,
      imageUrl,
      rawScore: row.score,
      metadata,
    });
  }
  return hits;
}

// Keep `profileUsable` re-exported for callers that build capabilities directly.
export { profileUsable };
