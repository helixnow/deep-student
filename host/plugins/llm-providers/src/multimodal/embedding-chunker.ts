/** Direct port of multimodal/embedding_chunker.rs, including f32 arithmetic. */
import type { PluginLogger } from '../../api.ts';
import { rustTrim, utf8ByteLength } from '../../../../platform/util/portable.ts';

export type ChunkAggregation = 'First' | 'MeanPooling' | 'KeepAll';
export interface ChunkResult { original_index: number; chunks: string[] }

export class EmbeddingTokenLimits {
  defaultLimit = 512;
  safetyMargin = Math.fround(0.9);
  _logger?: PluginLogger;
  _modelLimits: [string, number][] = [
    ['BAAI/bge-large-zh', 512], ['BAAI/bge-large-en', 512], ['netease-youdao/bce-embedding', 512],
    ['BAAI/bge-m3', 8192], ['Pro/BAAI/bge-m3', 8192], ['Qwen/Qwen3-Embedding', 32768],
    ['text-embedding-3', 8192], ['text-embedding-ada', 8192], ['voyage-3', 32000],
    ['voyage-code', 32000], ['voyage-multilingual', 32000], ['jina-embeddings', 8192], ['embed-', 512],
  ].map(([name, limit]) => [name as string, limit as number] as [string, number])
    .sort((a, b) => b[0].length - a[0].length);

  getLimit(modelName: string): number {
    const matched = this._modelLimits.find(([prefix]) => modelName.startsWith(prefix));
    if (matched !== undefined) {
      const effectiveLimit = Math.trunc(Math.fround(Math.fround(matched[1]) * Math.fround(this.safetyMargin)));
      this._logger?.debug(
        '[EmbeddingChunker] 模型 %s 匹配到限制 %d (安全值 %d)', modelName, matched[1], effectiveLimit,
      );
      return effectiveLimit;
    }
    const effectiveLimit = Math.trunc(Math.fround(Math.fround(this.defaultLimit) * Math.fround(this.safetyMargin)));
    this._logger?.warn(
      '[EmbeddingChunker] 模型 %s 未匹配到已知限制，使用默认值 %d (安全值 %d)',
      modelName, this.defaultLimit, effectiveLimit,
    );
    return effectiveLimit;
  }
  addLimit(modelPrefix: string, limit: number): void {
    this._modelLimits = this._modelLimits.filter(([prefix]) => prefix !== modelPrefix);
    this._modelLimits.push([modelPrefix, limit]);
    this._modelLimits.sort((a, b) => utf8ByteLength(b[0]) - utf8ByteLength(a[0]));
  }
  constructor(logger?: PluginLogger) { this._logger = logger; }
}

// Rust char::is_whitespace uses Unicode White_Space, not JS trim's BOM rule.
const whitespace = /^\p{White_Space}$/u;
function characterTokens(c: string): number {
  const n = c.codePointAt(0)!;
  if (whitespace.test(c)) return Math.fround(0.2);
  if ((n >= 0x21 && n <= 0x2f) || (n >= 0x3a && n <= 0x40)
    || (n >= 0x5b && n <= 0x60) || (n >= 0x7b && n <= 0x7e)
    || (n >= 0x3000 && n <= 0x303f) || (n >= 0xff00 && n <= 0xffef)
    || (n >= 0x2000 && n <= 0x206f)) return 1;
  return n < 128 ? Math.fround(0.3) : 1.5;
}

export class EmbeddingChunker {
  _maxTokens: number;
  _overlapTokens = 50;
  _aggregation: ChunkAggregation = 'MeanPooling';
  _logger?: PluginLogger;
  constructor(maxTokens: number, logger?: PluginLogger) { this._maxTokens = maxTokens; this._logger = logger; }
  withOverlap(overlap: number): this { this._overlapTokens = overlap; return this; }
  withAggregation(aggregation: ChunkAggregation): this { this._aggregation = aggregation; return this; }
  aggregation(): ChunkAggregation { return this._aggregation; }

  static estimateTokens(text: string): number {
    let chinese = 0, ascii = 0, space = 0, punct = 0;
    for (const c of text) {
      if (whitespace.test(c)) space++;
      else {
        const weight = characterTokens(c);
        if (weight === 1) punct++;
        else if (weight === 1.5) chinese++;
        else ascii++;
      }
    }
    const f = Math.fround;
    const tokens = f(f(f(f(f(chinese) * 1.5) + f(f(ascii) * f(0.3))) + f(f(space) * f(0.2))) + f(punct));
    return Math.max(1, Math.ceil(tokens));
  }
  needsChunking(text: string): boolean { return EmbeddingChunker.estimateTokens(text) > this._maxTokens; }
  chunkText(text: string): string[] {
    const estimatedTokens = EmbeddingChunker.estimateTokens(text);
    if (!this.needsChunking(text)) return [text];
    this._logger?.info(
      '[EmbeddingChunker] 文本需要分块: %d tokens > %d 限制', estimatedTokens, this._maxTokens,
    );
    const chunks: string[] = [];
    let current = '', tokens = 0;
    for (const paragraph of text.split('\n\n')) {
      const para = rustTrim(paragraph);
      if (!para) continue;
      const count = EmbeddingChunker.estimateTokens(para);
      if (tokens + count > this._maxTokens) {
        if (current) { chunks.push(rustTrim(current)); current = ''; tokens = 0; }
        if (count > this._maxTokens) chunks.push(...this.chunkParagraph(para));
        else { current = para; tokens = count; }
      } else {
        if (current) current += '\n\n';
        current += para;
        tokens += count;
      }
    }
    if (current) chunks.push(rustTrim(current));
    chunks.forEach((chunk, idx) => {
      const tokensInChunk = EmbeddingChunker.estimateTokens(chunk);
      if (tokensInChunk > this._maxTokens) {
        this._logger?.warn(
          '[EmbeddingChunker] 块 %d 估算 %d tokens 超出限制 %d，可能触发 API 失败',
          idx, tokensInChunk, this._maxTokens,
        );
      }
    });
    if (this._overlapTokens > 0 && chunks.length > 1) {
      const tails = chunks.map(chunk => EmbeddingChunker.tailTextByTokens(chunk, this._overlapTokens));
      for (let i = 1; i < chunks.length; i++) {
        const budget = Math.max(0, this._maxTokens - EmbeddingChunker.estimateTokens(chunks[i]!) - 1);
        const overlap = Math.min(this._overlapTokens, budget);
        if (!overlap) continue;
        const tail = rustTrim(EmbeddingChunker.tailTextByTokens(tails[i - 1]!, overlap));
        if (tail) chunks[i] = `${tail} ${chunks[i]!}`;
      }
    }
    this._logger?.info(
      '[EmbeddingChunker] 分块完成: %d tokens -> %d 块 (overlap=%d)',
      estimatedTokens, chunks.length, this._overlapTokens,
    );
    return chunks;
  }
  chunkParagraph(para: string): string[] {
    const sentences: string[] = [];
    let current = '';
    for (const c of para) {
      current += c;
      if ('。！？.!?；;\n'.includes(c)) {
        if (rustTrim(current)) sentences.push(rustTrim(current));
        current = '';
      }
    }
    if (rustTrim(current)) sentences.push(rustTrim(current));
    if (!sentences.length) return this.hardChunk(para);
    const chunks: string[] = [];
    current = '';
    let tokens = 0;
    for (const sentence of sentences) {
      const count = EmbeddingChunker.estimateTokens(sentence);
      if (count > this._maxTokens) {
        if (current) { chunks.push(current); current = ''; tokens = 0; }
        chunks.push(...this.hardChunk(sentence));
        continue;
      }
      if (tokens + count > this._maxTokens) {
        if (current) chunks.push(current);
        current = sentence; tokens = count;
      } else {
        if (current) current += ' ';
        current += sentence; tokens += count;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }
  hardChunk(text: string): string[] {
    const chunks: string[] = [];
    let current = '', tokens = 0;
    for (const c of text) {
      const weight = characterTokens(c);
      const next = Math.fround(Math.fround(tokens) + weight);
      if (next > Math.fround(this._maxTokens)) {
        if (current) chunks.push(current);
        current = c; tokens = Math.ceil(weight);
      } else { current += c; tokens = Math.ceil(next); }
    }
    if (current) chunks.push(current);
    this._logger?.debug('[EmbeddingChunker] 硬切割: %d 字符 -> %d 块', [...text].length, chunks.length);
    return chunks;
  }
  static tailTextByTokens(text: string, targetTokens: number): string {
    if (targetTokens === 0 || text === '') return '';
    const chars = [...text];
    let tokens = 0, start = chars.length;
    for (let i = chars.length - 1; i >= 0; i--) {
      tokens = Math.fround(tokens + characterTokens(chars[i]!));
      start = i;
      if (tokens >= Math.fround(targetTokens)) break;
    }
    return chars.slice(start).join('');
  }
  static aggregateEmbeddings(embeddings: number[][], method: ChunkAggregation, logger?: PluginLogger): number[] {
    if (!embeddings.length) return [];
    if (embeddings.length === 1) return [...embeddings[0]!];
    if (method !== 'MeanPooling') {
      if (method === 'KeepAll') {
        logger?.warn('[EmbeddingChunker] aggregate_embeddings 不应在 KeepAll 模式下调用，返回第一个向量');
      }
      return [...embeddings[0]!];
    }
    const result = Array<number>(embeddings[0]!.length).fill(0);
    const f = Math.fround;
    for (const emb of embeddings) for (let i = 0; i < emb.length && i < result.length; i++) result[i] = f(result[i]! + f(emb[i]!));
    for (let i = 0; i < result.length; i++) result[i] = f(result[i]! / f(embeddings.length));
    let square = 0;
    for (const v of result) square = f(square + f(v * v));
    const norm = f(Math.sqrt(square));
    if (norm > 0) for (let i = 0; i < result.length; i++) result[i] = f(result[i]! / norm);
    return result;
  }
}
export function batchChunkTexts(texts: string[], chunker: EmbeddingChunker): ChunkResult[] {
  return texts.map((text, original_index) => ({ original_index, chunks: chunker.chunkText(text) }));
}
