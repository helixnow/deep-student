import { nanoid } from 'nanoid';
import { toRfc3339 } from '../../../platform/time/index.ts';
import { CommandError } from '../../../kernel/api.ts';
import { invalidState } from './lance-types.ts';
import type { ChunkWithEmbedding, EmbeddingPipelineStore, EmbeddingProgressCallback, EmbeddingResult, EmbeddingRuntime, IndexChunksResult, TextChunk, VfsLanceRow } from '../api.ts';

export const MODALITY_TEXT = 'text';
function message(error: unknown): string {
  // L02 exposes AppError through CommandError; Rust Display prints only message.
  const value: unknown = error instanceof CommandError ? error.value : error;
  return typeof value === 'object' && value !== null && 'message' in value && typeof value.message === 'string'
    ? value.message : String(value);
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw new Error('Embedding generation cancelled');
}

function sleepWithSignal(ms: number, signal?: AbortSignal | null): Promise<void> {
  throwIfAborted(signal);
  if (signal === null || signal === undefined) {
    return new Promise<void>(resolve => { setTimeout(resolve, ms); });
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('Embedding generation cancelled'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class VfsEmbeddingService {
  private runtime: EmbeddingRuntime;
  private batchSize: number;
  private readonly logger: import('./logger.ts').LaneLogger | undefined;
  constructor(
    runtime: EmbeddingRuntime,
    batchSize = 16,
    logger?: import('./logger.ts').LaneLogger,
  ) {
    this.runtime = runtime;
    this.batchSize = Math.max(1, batchSize);
    this.logger = logger;
  }
  async getEmbeddingModelId(): Promise<string> {
    try { return (await this.runtime.getEmbeddingModelConfig()).id; }
    catch (e) { throw new Error(`获取嵌入模型配置失败: ${message(e)}`); }
  }
  async getEmbeddingModelInfo(): Promise<[string, string, string]> {
    let config;
    try { config = await this.runtime.getEmbeddingModelConfig(); }
    catch (e) { throw new Error(`获取嵌入模型配置失败: ${message(e)}`); }
    return [config.id, config.model, this.runtime.modelFingerprintForConfig(config, MODALITY_TEXT)];
  }
  async ensureModelAssignmentUnchanged(id: string, model: string, fingerprint: string): Promise<void> {
    let config;
    try { config = await this.runtime.getEmbeddingModelConfig(); }
    catch (e) { throw new Error(`重新读取嵌入模型配置失败: ${message(e)}`); }
    const currentFingerprint = this.runtime.modelFingerprintForConfig(config, MODALITY_TEXT);
    if (config.id !== id || config.model !== model || currentFingerprint !== fingerprint) {
      throw invalidState(`Text embedding assignment changed while the batch was running: ${id}/${model} -> ${config.id}/${config.model}`);
    }
  }
  async generateEmbedding(text: string, signal?: AbortSignal | null): Promise<number[]> {
    throwIfAborted(signal);
    const id = await this.getEmbeddingModelId();
    throwIfAborted(signal);
    let vectors;
    try { vectors = await this.runtime.callEmbeddingApi([text], id); }
    catch (e) {
      throwIfAborted(signal);
      throw new Error(`生成嵌入向量失败: ${message(e)}`);
    }
    if (!vectors.length) throw new Error('嵌入 API 返回空结果');
    return vectors[0]!.map(Math.fround);
  }
  private async generateBatchWithRetry(
    texts: string[], modelId: string, start: number, end: number, total: number, signal?: AbortSignal | null,
  ): Promise<number[][]> {
    for (let attempt = 1; ; attempt++) {
      throwIfAborted(signal);
      try { return (await this.runtime.callEmbeddingApi(texts, modelId)).map(v => v.map(Math.fround)); }
      catch (e) {
        throwIfAborted(signal);
        if (attempt >= 3) throw new Error(`嵌入生成失败 (批次 ${start + 1}-${end}/${total}): ${message(e)} (已重试 3 次)`);
        const backoffMs = 400 * 2 ** (attempt - 1);
        this.logger?.warn(
          `[VfsEmbeddingService] Batch ${start + 1}-${end} failed, retrying in ${backoffMs}ms (attempt ${attempt}/3): ${message(e)}`,
        );
        await sleepWithSignal(backoffMs, signal);
      }
    }
  }
  async generateEmbeddingsBatch(texts: string[], signal?: AbortSignal | null): Promise<number[][]> {
    if (!texts.length) return [];
    throwIfAborted(signal);
    const id = await this.getEmbeddingModelId(), result: number[][] = [];
    for (let start = 0; start < texts.length; start += this.batchSize) {
      throwIfAborted(signal);
      const end = Math.min(start + this.batchSize, texts.length), batch = texts.slice(start, end);
      const vectors = await this.generateBatchWithRetry(batch, id, start, end, texts.length, signal);
      if (vectors.length !== batch.length) throw new Error(`嵌入数量不匹配: expected ${batch.length}, got ${vectors.length}`);
      result.push(...vectors);
    }
    return result;
  }
  async generateEmbeddingsForChunks(
    chunks: TextChunk[], progress: EmbeddingProgressCallback | null = null, signal?: AbortSignal | null,
  ): Promise<EmbeddingResult> {
    if (!chunks.length) return { chunks: [], embedding_dim: 0, model_config_id: '', model_name: '', model_fingerprint: '', modality: MODALITY_TEXT };
    throwIfAborted(signal);
    const [id, model, fingerprint] = await this.getEmbeddingModelInfo(), result: ChunkWithEmbedding[] = [];
    let dim = 0;
    for (let start = 0; start < chunks.length; start += this.batchSize) {
      throwIfAborted(signal);
      const end = Math.min(start + this.batchSize, chunks.length), batch = chunks.slice(start, end);
      const vectors = await this.generateBatchWithRetry(batch.map(c => c.text), id, start, end, chunks.length, signal);
      if (vectors.length !== batch.length) throw new Error(`嵌入数量不匹配: expected ${batch.length}, got ${vectors.length}`);
      if (dim === 0 && vectors.length) dim = vectors[0]!.length;
      vectors.forEach((v, i) => { if (dim > 0 && v.length !== dim) throw new Error(`嵌入维度不一致: 期望 ${dim}, 第 ${start + i} 个向量为 ${v.length}`); });
      batch.forEach((chunk, i) => result.push({ chunk: { ...chunk }, embedding: vectors[i]! }));
      progress?.(end, chunks.length);
    }
    return { chunks: result, embedding_dim: dim, model_config_id: id, model_name: model, model_fingerprint: fingerprint, modality: MODALITY_TEXT };
  }
}
export function chunksToLanceRows(chunks: readonly ChunkWithEmbedding[], resourceId: string, unitId: string,
  resourceType: string, folderId: string | null, profileId: string, generation: number | bigint): VfsLanceRow[] {
  const now = toRfc3339();
  return chunks.map(({ chunk, embedding }) => ({
    embedding_id: `emb_${nanoid(10)}`, resource_id: resourceId, unit_id: unitId, resource_type: resourceType,
    folder_id: folderId, chunk_index: chunk.index, text: chunk.text,
    metadata_json: chunk.page_index !== null || chunk.source_id !== null
      ? JSON.stringify({ page_index: chunk.page_index, source_id: chunk.source_id }) : null,
    created_at: now, index_profile_id: profileId, generation, embedding: embedding.map(Math.fround),
  }));
}
export class VfsEmbeddingPipeline {
  private embeddings: VfsEmbeddingService;
  private store: EmbeddingPipelineStore;
  constructor(
    runtime: EmbeddingRuntime,
    store: EmbeddingPipelineStore,
    logger?: import('./logger.ts').LaneLogger,
  ) {
    this.embeddings = new VfsEmbeddingService(runtime, 16, logger);
    this.store = store;
  }
  embeddingService(): VfsEmbeddingService { return this.embeddings; }
  async indexChunks(resourceId: string, unitId: string, resourceType: string, folderId: string | null,
    chunks: TextChunk[], modality: string, progress: EmbeddingProgressCallback | null = null,
    signal?: AbortSignal | null): Promise<IndexChunksResult> {
    const empty = (): IndexChunksResult => ({ count: 0, dim: 0, embedding_ids: [], model_config_id: null, index_profile_id: null, generation: null });
    if (!chunks.length) return empty();
    throwIfAborted(signal);
    if (modality !== MODALITY_TEXT) throw new Error('VFS 只支持文本模态，多模态内容请使用 crate::multimodal 模块');
    const result = await this.embeddings.generateEmbeddingsForChunks(chunks, progress, signal);
    if (!result.chunks.length) return empty();
    throwIfAborted(signal);
    await this.embeddings.ensureModelAssignmentUnchanged(result.model_config_id, result.model_name, result.model_fingerprint);
    const profile = this.store.ensureModelProfileWithFingerprint(modality, result.embedding_dim, result.model_config_id, result.model_name, result.model_fingerprint);
    const generation = this.store.nextUnitGeneration(unitId, modality);
    const rows = chunksToLanceRows(result.chunks, resourceId, unitId, resourceType, folderId, profile.id, generation);
    const ids = rows.map(r => r.embedding_id);
    await this.embeddings.ensureModelAssignmentUnchanged(result.model_config_id, result.model_name, result.model_fingerprint);
    throwIfAborted(signal);
    await this.store.writeChunks(modality, rows);
    return { count: result.chunks.length, dim: result.embedding_dim, embedding_ids: ids,
      model_config_id: result.model_config_id, index_profile_id: profile.id, generation };
  }
  deleteResourceIndex(resourceId: string): Promise<number> { return this.store.deleteByResource(MODALITY_TEXT, resourceId); }
  async reindexChunks(resourceId: string, unitId: string, resourceType: string, folderId: string | null,
    chunks: TextChunk[], modality: string, progress: EmbeddingProgressCallback | null = null,
    signal?: AbortSignal | null): Promise<IndexChunksResult> {
    throwIfAborted(signal);
    await this.deleteResourceIndex(resourceId);
    return this.indexChunks(resourceId, unitId, resourceType, folderId, chunks, modality, progress, signal);
  }
}
