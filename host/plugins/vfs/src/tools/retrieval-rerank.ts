/** builtin_retrieval_executor.rs:1416-1700. L02 owns model configuration and API calls. */
import * as path from '../../../../platform/util/path.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { ApiConfig } from '../../../llm/api.ts';
import type { SourceInfo } from '../../../chat/api.ts';
import { toBase64 } from '../../../../platform/crypto/encoding.ts';
import { rustTrim } from '../../../../platform/util/portable.ts';
import { fs } from '../local-runtime.ts';
import { objectOf, stringOf } from './retrieval-sources.ts';

export interface RerankChunk {
  chunk: { id: string; document_id: string; chunk_index: number; text: string; metadata: Record<string, unknown> };
  score: number;
}
export interface RerankMultimodalInput { text?: string; image?: { data: string; media_type: string } }
export interface RetrievalRerankerPort {
  getRerankerModelConfig(): Promise<Pick<ApiConfig, 'id' | 'enabled' | 'isReranker' | 'isMultimodal'>>;
  getVlRerankerModelConfig(): Promise<Pick<ApiConfig, 'id' | 'enabled' | 'isReranker' | 'isMultimodal'>>;
  callRerankerApi(query: string, chunks: RerankChunk[], configId: string): Promise<RerankChunk[]>;
  callMultimodalRerankerApi(query: RerankMultimodalInput, docs: RerankMultimodalInput[]): Promise<Array<{ index: number; relevance_score: number }>>;
}
export interface RerankOutcome { sources: SourceInfo[]; applied: boolean; failure: string | null }
export const skippedRerank = (sources: SourceInfo[], topK: number): RerankOutcome => ({ sources: sources.slice(0, topK), applied: false, failure: null });
const fallback = (sources: SourceInfo[], topK: number, failure: string): RerankOutcome => ({ ...skippedRerank(sources, topK), failure });
const detail = (e: unknown) => e instanceof Error ? e.message : String(e);

export async function textRerankSources(query: string, candidates: SourceInfo[], topK: number, llm: RetrievalRerankerPort, log: Context['logger']): Promise<RerankOutcome> {
  if (candidates.length === 0) return skippedRerank(candidates, topK);
  let config;
  try { config = await llm.getRerankerModelConfig(); }
  catch { return skippedRerank(candidates, topK); }
  if (!config.enabled || !config.isReranker || config.isMultimodal) {
    log.warn('[hybrid-rag] Text reranker assignment has incompatible capabilities');
    return fallback(candidates, topK, 'text reranker assignment has incompatible capabilities');
  }
  const chunks: RerankChunk[] = candidates.map((source, index) => {
    const meta = objectOf(source.metadata), chunkIndex = meta.chunkIndex;
    return { chunk: { id: `rerank-source-${index}`, document_id: stringOf(meta.resourceId) ?? '',
      chunk_index: typeof chunkIndex === 'number' && Number.isInteger(chunkIndex) && chunkIndex >= 0 && chunkIndex < 2 ** 64 ? chunkIndex : index,
      text: source.snippet ?? '', metadata: {} }, score: source.score ?? 0 };
  });
  let results;
  try { results = await llm.callRerankerApi(query, chunks, config.id); }
  catch (error) {
    log.warn('[hybrid-rag] Text reranker failed, retaining RRF: %s', detail(error));
    return fallback(candidates, topK, `text reranker failed: ${detail(error)}`);
  }
  const reranked: SourceInfo[] = [];
  for (const result of results.slice(0, topK)) {
    if (!result.chunk.id.startsWith('rerank-source-')) continue;
    const suffix = result.chunk.id.slice('rerank-source-'.length);
    if (!/^\+?\d+$/.test(suffix)) continue;
    const index = Number(suffix), source = candidates[index];
    if (source) reranked.push({ ...structuredClone(source), score: Math.fround(result.score) });
  }
  return reranked.length === 0 ? fallback(candidates, topK, 'text reranker returned no usable results') : { sources: reranked, applied: true, failure: null };
}
const VL_BLOB_READ_CONCURRENCY = 8;

async function readBlobBytesAsync(filePath: string, signal?: AbortSignal | null): Promise<Uint8Array> {
  if (signal?.aborted) throw new Error('VL rerank cancelled');
  const handle = await fs.open(filePath, 'r');
  try {
    const stats = await handle.stat();
    const total = stats.size;
    if (total === 0) return new Uint8Array(0);
    const buffer = new Uint8Array(total);
    let offset = 0;
    while (offset < total) {
      if (signal?.aborted) throw new Error('VL rerank cancelled');
      const { bytesRead } = await handle.read(buffer, offset, total - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    return offset === total ? buffer : buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function runBounded<T>(items: readonly T[], limit: number, signal: AbortSignal | null | undefined,
  worker: (item: T, index: number) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  const workerCount = Math.min(limit, items.length);
  let cursor = 0;
  const runWorker = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted) throw new Error('VL rerank cancelled');
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
}

export async function vlRerankSources(queryText: string | null, queryImage: string | null, queryMime: string | null,
  candidates: SourceInfo[], topK: number, llm: RetrievalRerankerPort, ctx: Context,
  signal?: AbortSignal | null): Promise<RerankOutcome> {
  if (signal?.aborted) throw new Error('VL rerank cancelled');
  if (candidates.length === 0) return skippedRerank(candidates, topK);
  let config;
  try { config = await llm.getVlRerankerModelConfig(); }
  catch { return skippedRerank(candidates, topK); }
  if (!config.enabled || !config.isReranker || !config.isMultimodal) {
    ctx.logger.warn('[hybrid-rag] VL reranker assignment has incompatible capabilities');
    return fallback(candidates, topK, 'VL reranker assignment has incompatible capabilities');
  }
  const text = queryText !== null && rustTrim(queryText) !== '' ? queryText : null;
  const image = queryImage !== null && rustTrim(queryImage) !== '' ? queryImage : null;
  if (text === null && image === null) return skippedRerank(candidates, topK);
  const query: RerankMultimodalInput = { ...(text === null ? {} : { text }), ...(image === null ? {} : { image: { data: image, media_type: queryMime ?? 'image/png' } }) };
  const docs: RerankMultimodalInput[] = new Array(candidates.length);
  await runBounded(candidates, VL_BLOB_READ_CONCURRENCY, signal, async (source, index) => {
    const hash = stringOf(objectOf(source.metadata).blobHash), snippet = source.snippet ?? '';
    if (hash === null || hash === '') { docs[index] = { text: snippet }; return; }
    let loaded: { data: string; media_type: string } | null = null;
    try {
      // The chat-pipeline services context does not inject vfsDatabase; property access throws there.
      const database = ctx.get('vfsDatabase'), blobs = ctx.get('vfsRepo')?.blobs;
      const file = database === undefined || blobs === undefined ? null
        : blobs.getBlobPath(database.getConnSafe(), database.blobsDir(), hash);
      if (file !== null) {
        const bytes = await readBlobBytesAsync(file, signal);
        const data = toBase64(bytes), ext = path.extname(file).slice(1).toLowerCase();
        loaded = { data, media_type: ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png' };
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      // Rust chains .ok()? for lookup/read; the common fallback below logs once.
      loaded = null;
    }
    if (loaded === null) {
      ctx.logger.debug('[hybrid-rag] blob %s 加载失败，降级为纯文本', hash);
      docs[index] = { text: snippet };
      return;
    }
    docs[index] = { ...(snippet === '' ? {} : { text: snippet }), image: loaded };
  });
  if (signal?.aborted) throw new Error('VL rerank cancelled');
  let results;
  try { results = await llm.callMultimodalRerankerApi(query, docs); }
  catch (error) {
    ctx.logger.warn('[hybrid-rag] VL-Reranker 调用失败，降级为 RRF 排序: %s', detail(error));
    return fallback(candidates, topK, `VL reranker failed: ${detail(error)}`);
  }
  const reranked: SourceInfo[] = [];
  for (const result of results.slice(0, topK)) {
    const source = candidates[result.index];
    if (source) reranked.push({ ...structuredClone(source), score: Math.fround(result.relevance_score) });
  }
  ctx.logger.info('[hybrid-rag] VL-Reranker 精排完成: %d 候选 -> %d 结果', docs.length, reranked.length);
  return reranked.length === 0 ? fallback(candidates, topK, 'VL reranker returned no usable results') : { sources: reranked, applied: true, failure: null };
}
