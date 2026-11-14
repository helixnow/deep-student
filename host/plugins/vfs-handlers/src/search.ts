/**
 * vfs/handlers.rs search, Lance stats and multimodal commands
 * (handlers.rs:3133-3260、4935-5010、6081-6510).
 */
import type { Context } from '@deepseek-ai/cordis';
import { rustTrim } from '../../../platform/util/portable.ts';
import { CommandError } from '../../../kernel/api.ts';
import { VfsError } from '../../vfs/portable.ts';
import { VECTOR_UNAVAILABLE } from './index-admin.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type {
  CapabilitySnapshot,
  RetrievalService,
  UnifiedRetrievalRequest,
  UnifiedRetrievalResponse,
  VfsIndexService,
  VfsSearchResult,
} from '../../vfs-index/api.ts';
import type {
  VfsMultimodalIndexInput,
  VfsMultimodalSearchInput,
  VfsMultimodalSearchOutput,
  VfsRagSearchInput,
  VfsRagSearchOutput,
  VfsSearchParams,
} from '../../../../contracts/ipc/generated/L13-vfs-api.ts';

const MODALITY_TEXT = 'text';
const MODALITY_MULTIMODAL = 'multimodal';

export interface SearchDeps {
  readonly vectorAvailable: boolean;
  readonly conn: () => DatabaseHandle;
  readonly index: VfsIndexService;
  readonly retrieval?: RetrievalService;
  readonly log: Context['logger'];
}

function fail(error: unknown): never {
  if (error instanceof CommandError) throw error;
  if (error instanceof VfsError) throw new CommandError(error.toString());
  if (error instanceof Error) throw new CommandError(error.message);
  throw error;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** handlers.rs:3133-3152 */
export function search(deps: SearchDeps, params: VfsSearchParams): VfsSearchResult[] {
  deps.log.info('[VFS::handlers] vfs_search: query=%s, top_k=%d', params.query, params.topK ?? 10);
  try {
    if (rustTrim(params.query) === '') throw new Error('Query cannot be empty');
    return deps.index.search.searchFts(params.query, params.topK ?? 10);
  } catch (error) {
    return fail(error);
  }
}

/** handlers.rs:4935-4990 */
export async function ragSearch(deps: SearchDeps, input: VfsRagSearchInput): Promise<VfsRagSearchOutput> {
  deps.log.info("[VFS::handlers] vfs_rag_search: query='%s', folders=%s, types=%s, top_k=%d", input.query, input.folderIds ?? null, input.resourceTypes ?? null, input.topK ?? 10);
  try {
    const start = performance.now();
    if (rustTrim(input.query) === '') throw new Error('查询文本不能为空');
    const normalized = rustTrim(input.modality ?? 'text').toLowerCase();
    let modality: string;
    if (normalized === '' || normalized === 'text') modality = MODALITY_TEXT;
    else if (normalized === 'multimodal' || normalized === 'mm') modality = MODALITY_MULTIMODAL;
    else throw new Error("modality 仅支持 'text' 或 'multimodal'");

    const fullSearch = deps.index.fullSearch;
    if (fullSearch === undefined) throw new Error('vfs.index@1 未发布 fullSearch');
    const params = {
      query: input.query,
      folderIds: input.folderIds ?? null,
      resourceIds: null,
      resourceTypes: input.resourceTypes ?? null,
      modality,
      topK: input.topK ?? 10,
    };
    // `enableCrossDimension` is compatibility-only: both values use the unified planner.
    const results = await fullSearch.searchWithResourceInfo(
      input.query, params, input.enableReranking ?? true,
    );
    deps.log.info('[VFS::handlers] vfs_rag_search completed: %d results in %dms',
      results.length, Math.trunc(performance.now() - start));
    return { results, count: results.length, elapsedMs: Math.trunc(performance.now() - start) };
  } catch (error) {
    return fail(error);
  }
}

/** handlers.rs:4971-4988 */
export async function getLanceStats(deps: SearchDeps, modality: string | null): Promise<Array<[string, number]>> {
  try {
    return await deps.index.lance.getTableStats(modality ?? MODALITY_TEXT);
  } catch (error) {
    return fail(error);
  }
}

/** handlers.rs:4990-5010 */
export async function optimizeLance(deps: SearchDeps, modality: string | null): Promise<number> {
  deps.log.info('[VFS::handlers] vfs_optimize_lance');
  try {
    return await deps.index.lance.optimizeAll(modality ?? MODALITY_TEXT);
  } catch (error) {
    return fail(error);
  }
}

/** handlers.rs:6473-6490 */
export async function diagnoseLanceSchema(deps: SearchDeps, modality: string | null): Promise<unknown[]> {
  deps.log.info('[VFS::handlers] vfs_diagnose_lance_schema: modality=%s', modality);
  try {
    return await deps.index.lance.diagnoseTableSchema(modality ?? MODALITY_TEXT);
  } catch (error) {
    return fail(error);
  }
}

/** handlers.rs:6355-6370 */
export async function inspectRetrievalCapabilities(deps: SearchDeps): Promise<CapabilitySnapshot> {
  try {
    const retrieval = deps.retrieval;
    if (retrieval === undefined) throw new Error('retrieval 服务不可用');
    return await retrieval.inspectCapabilities();
  } catch (error) {
    return fail(error);
  }
}

type QueryMode = 'text' | 'image' | 'mixed';

interface ResolvedMultimodalQuery {
  text: string | null;
  image: string | null;
  mediaType: string;
  mode: QueryMode;
}

function normalizeMode(value: VfsMultimodalSearchInput['queryMode']): QueryMode | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    for (const mode of ['text', 'image', 'mixed'] as const) {
      if (mode in value) return mode;
    }
  }
  return null;
}

/** handlers.rs:6140-6187 `VfsMultimodalSearchInput::resolved_query`. */
export function resolveMultimodalQuery(input: VfsMultimodalSearchInput): ResolvedMultimodalQuery {
  const text = rustTrim(input.queryText ?? input.query ?? '') || null;
  const image = rustTrim(input.queryImageBase64 ?? '') || null;
  const explicit = normalizeMode(input.queryMode);
  const mode: QueryMode = explicit ?? (text !== null && image !== null ? 'mixed' : image !== null ? 'image' : 'text');
  const mediaType = rustTrim(input.queryImageMediaType ?? '') === ''
    ? 'image/png'
    : rustTrim(input.queryImageMediaType!);

  if (mode === 'text') {
    if (text === null) throw new Error('text search requires queryText or query');
  } else if (mode === 'image') {
    if (image === null) throw new Error('image search requires queryImageBase64');
  } else if (text === null) {
    throw new Error('mixed search requires queryText or query');
  } else if (image === null) {
    throw new Error('mixed search requires queryImageBase64');
  }
  return { text: mode === 'image' ? null : text, image: mode === 'text' ? null : image, mediaType, mode };
}

async function runMultimodalSearch(
  deps: SearchDeps,
  input: VfsMultimodalSearchInput,
): Promise<UnifiedRetrievalResponse> {
  const resolved = resolveMultimodalQuery(input);
  const queryModality = resolved.text !== null && resolved.image !== null
    ? 'mixed'
    : resolved.image !== null ? 'image' : 'text';
  const request: UnifiedRetrievalRequest = {
    queryText: input.queryText ?? input.query ?? null,
    queryImageBase64: input.queryImageBase64 ?? null,
    queryImageMediaType: input.queryImageMediaType ?? null,
    queryModality,
    topK: input.topK ?? 10,
    folderIds: input.folderIds ?? null,
    resourceIds: input.resourceIds ?? null,
    resourceTypes: input.resourceTypes ?? null,
  };
  const retrieval = deps.retrieval;
  if (retrieval === undefined) throw new Error('retrieval 服务不可用');
  return retrieval.searchMultimodal(request);
}

/** handlers.rs:6296-6336 */
export async function multimodalSearch(
  deps: SearchDeps,
  input: VfsMultimodalSearchInput,
): Promise<VfsMultimodalSearchOutput[]> {
  try {
    const response = await runMultimodalSearch(deps, input);
    return response.result.hits.map(fused => ({
      embeddingId: fused.hit.embeddingId,
      resourceId: fused.hit.identity.resourceId,
      resourceType: fused.hit.resourceType ?? 'unknown',
      pageIndex: fused.hit.identity.pageIndex ?? fused.hit.identity.chunkIndex,
      textContent: fused.hit.text,
      blobHash: fused.hit.blobHash,
      score: Math.fround(fused.rrfScore),
      folderId: fused.hit.folderId,
      retrievalProvenance: fused.provenance,
    }));
  } catch (error) {
    return fail(error);
  }
}

/** handlers.rs:6338-6353 */
export async function multimodalSearchDetailed(
  deps: SearchDeps,
  input: VfsMultimodalSearchInput,
): Promise<UnifiedRetrievalResponse> {
  try {
    return await runMultimodalSearch(deps, input);
  } catch (error) {
    return fail(error);
  }
}

/** handlers.rs:6373-6394 */
export async function multimodalStats(deps: SearchDeps): Promise<Record<string, unknown>> {
  try {
    const stats = await deps.index.multimodal.getStats();
    return { totalRecords: stats.total_records, dimensions: stats.dimensions };
  } catch (error) {
    return fail(error);
  }
}

/** handlers.rs:6396-6418 */
export async function multimodalDelete(deps: SearchDeps, resourceId: string): Promise<null> {
  try {
    await deps.index.multimodal.deleteResourceIndex(resourceId);
    return null;
  } catch (error) {
    return fail(error);
  }
}

/** handlers.rs:6081-6140 */
export async function multimodalIndex(
  deps: SearchDeps,
  params: VfsMultimodalIndexInput,
): Promise<{ indexedPages: number; dimension: number; failedPages: number[] }> {
  try {
    if (!deps.vectorAvailable) throw new Error(VECTOR_UNAVAILABLE);
    const pages = params.pages.map(page => ({
      page_index: page.pageIndex,
      image_base64: page.imageBase64 ?? null,
      image_mime: page.imageMime ?? null,
      text_content: page.textContent ?? null,
      blob_hash: page.blobHash ?? null,
    }));
    const result = await deps.index.multimodal.indexResourcePages(
      params.resourceId, params.resourceType, params.folderId ?? null, pages,
    );
    return {
      indexedPages: result.indexed_pages,
      dimension: result.dimension,
      failedPages: result.failed_pages,
    };
  } catch (error) {
    return fail(error);
  }
}

/** handlers.rs:6420-6470 */
export async function multimodalIndexResource(
  deps: SearchDeps,
  sourceType: string,
  sourceId: string,
  folderId: string | null,
  forceRebuild: boolean,
): Promise<Record<string, unknown>> {
  try {
    if (!deps.vectorAvailable) throw new Error(VECTOR_UNAVAILABLE);
    if (forceRebuild) deps.log.info('[VFS::handlers] vfs_multimodal_index_resource: force_rebuild=true');
    const result = await deps.index.multimodal.indexResourceBySource(sourceType, sourceId, folderId);
    return {
      indexedPages: result.indexed_pages,
      dimension: result.dimension,
      failedPages: result.failed_pages,
    };
  } catch (error) {
    return fail(error);
  }
}

export type { VfsMultimodalSearchInput, VfsRagSearchInput, VfsSearchParams };
export { messageOf };
