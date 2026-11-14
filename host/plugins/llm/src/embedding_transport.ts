/** Text embedding owner: rag_extension.rs:1009–1309. Chunking belongs to L01; usage to F3. */
import { AppError, CommandError } from '../../../platform/errors/api.ts';
import type { LlmUsageService } from '../../../platform/storage/api.ts';
import { objectLastWins, parseJsonDocument, type JsonNode } from '../../../platform/util/portable.ts';
import { decodeUtf8Strict, rustTrim } from '../../../platform/util/portable.ts';
import { EmbeddingChunker, EmbeddingTokenLimits, batchChunkTexts, type PluginLogger } from '../../llm-providers/api.ts';
import type { ApiConfig, LLMManager, LlmEmbeddingModels, TextEmbeddingService } from '../api.ts';
import { keyCooldowns, keyFingerprint } from './routing.ts';
import { defaultFailoverPolicyExact, type FailoverPolicyExact } from './policy.ts';
import { parseRetryAfterSecs, tagEmbeddingFailure } from './rag_extension.ts';
import { logDebug, logError, logInfo, logWarn } from './logging.ts';
import { formatMessage, mimeCharset } from './printf.ts';

const chunkLogger: PluginLogger = {
  debug: (message, ...args) => logDebug(formatMessage(message, ...args)),
  info: (message, ...args) => logInfo(formatMessage(message, ...args)),
  warn: (message, ...args) => logWarn(formatMessage(message, ...args)),
  error: (message, ...args) => logError(formatMessage(message, ...args)),
};

export function field(node: JsonNode | undefined, name: string): JsonNode | undefined {
  return node?.kind === 'object' ? objectLastWins(node).get(name) : undefined;
}
/** serde_json Number::as_u64 with arbitrary_precision (float spelling is not an integer). */
export function asU64(node: JsonNode | undefined): bigint | null {
  if (node?.kind !== 'number') return null;
  const raw = node.value.raw === '-0' ? '0' : node.value.raw;
  if (!/^\d+$/.test(raw)) return null;
  const value = BigInt(raw);
  return value <= 0xffff_ffff_ffff_ffffn ? value : null;
}
export async function appValue<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) { if (error instanceof CommandError) throw error.value; throw error; }
}

/** reqwest 0.11 Response::text_with_charset: MIME charset, encoding label fallback, lossy decode. */
export async function errorResponseText(response: Response): Promise<string> {
  const charset = mimeCharset(response.headers.get('content-type') ?? '') ?? 'utf-8';
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(charset); }
  catch { decoder = new TextDecoder('utf-8'); } // boundary-allow empty-catch: Encoding::for_label(...).unwrap_or(UTF_8).
  return decoder.decode(await response.arrayBuffer());
}

export function createTextEmbeddingService(manager: LLMManager, models: LlmEmbeddingModels,
  fetcher: typeof fetch, usage: () => Pick<LlmUsageService, 'recordLlmUsageExt'>,
  failoverPolicy: () => Promise<FailoverPolicyExact>): TextEmbeddingService {
  async function raw(texts: string[], config: ApiConfig): Promise<number[][]> {
    const apiKey = await appValue(() => manager.decryptApiKey(config.apiKey));
    const vendor = config.vendorId !== null && rustTrim(config.vendorId) !== '' ? config.vendorId : config.baseUrl;
    const cooldownKey = keyFingerprint(vendor, apiKey);
    if (keyCooldowns().isCooling(cooldownKey)) {
      logWarn(`[Embedding] Key for model ${config.model} is cooling down; failing fast`);
      throw tagEmbeddingFailure(AppError.llm('嵌入 API 密钥处于限速/鉴权冷却期，请稍后重试'), 429, null);
    }
    if (config.modelAdapter === 'anthropic' || config.modelAdapter === 'claude') {
      throw AppError.configuration('Claude模型不支持嵌入API');
    }
    // Resolve the owner before HTTP: a custom Host must not silently omit usage.
    const recorder = usage();
    const body = { model: config.model, input: texts, encoding_format: 'float' };
    const url = `${config.baseUrl.replace(/\/+$/, '')}/embeddings`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json',
      'Accept-Encoding': 'identity', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    };
    let base: URL | null;
    try { base = new URL(config.baseUrl); }
    catch { base = null; } // boundary-allow empty-catch: Rust `if let Ok(parsed_url)` omits origin/referer on URL failure.
    if (base && ['http:', 'https:'].includes(base.protocol) && base.hostname !== '') {
      headers.Origin = `${base.protocol}//${base.hostname}`;
      headers.Referer = `${base.protocol}//${base.hostname}/`;
    }
    let response: Response;
    try { response = await fetcher(url, { method: 'POST', headers, body: JSON.stringify(body) }); }
    catch (error) {
      const source = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      throw tagEmbeddingFailure(AppError.network(`嵌入API请求失败: error sending request for url (${url}): ${source instanceof Error ? source.message : String(source)}`), null, null);
    }
    if (!response.ok) {
      const status = response.status;
      const retryAfter = parseRetryAfterSecs(response.headers);
      let errorText: string;
      try { errorText = await errorResponseText(response); }
      catch { errorText = ''; } // boundary-allow empty-catch: Rust response.text().await.unwrap_or_default().
      logError(`[Embedding] API error ${status}: ${errorText}`);
      const message = status === 401 ? 'API 密钥无效或已过期，请检查设置'
        : status === 403 ? 'API 访问被拒绝，请检查账户权限'
          : status === 429 ? '请求过于频繁，请稍后重试'
            : status >= 500 && status <= 599 ? '嵌入服务暂时不可用，请稍后重试' : '嵌入请求失败，请重试';
      if ([401, 403, 429].includes(status)) {
        let policy;
        try { policy = await failoverPolicy(); }
        catch { policy = defaultFailoverPolicyExact(); } // boundary-allow empty-catch: Rust unwrap_or_default for failed policy read.
        const seconds = retryAfter ?? policy.keyCooldownSecs;
        const duration = seconds < 1 ? 1 : seconds > 3600 ? 3600 : Number(seconds);
        keyCooldowns().setFor(cooldownKey, duration * 1000);
        logWarn(`[Embedding] HTTP ${status} for model ${config.model}; key cooled down for ${duration}s (retry_after=${retryAfter === null ? 'None' : `Some(${retryAfter})`})`);
      }
      throw tagEmbeddingFailure(AppError.llm(message), status, retryAfter);
    }
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await response.arrayBuffer()); }
    catch (error) {
      const source = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      throw AppError.llm(`解析嵌入API响应失败: request or response body error: ${source instanceof Error ? source.message : String(source)}`);
    }
    let json: JsonNode;
    try { json = parseJsonDocument(decodeUtf8Strict(bytes)); }
    catch (error) { throw AppError.llm(`解析嵌入API响应失败: error decoding response body: ${error instanceof Error ? error.message : String(error)}`); }
    const data = field(json, 'data');
    if (data?.kind !== 'array') throw AppError.llm('嵌入API响应格式无效：缺少data字段');
    const embeddings = data.items.map(item => {
      const vector = field(item, 'embedding');
      if (vector?.kind !== 'array') throw AppError.llm('嵌入API响应格式无效：缺少embedding字段');
      return vector.items.map(value => {
        if (value.kind !== 'number') throw AppError.llm('嵌入向量包含无效数值');
        const number = Number(value.value.raw === '-0' ? '0' : value.value.raw);
        if (!Number.isFinite(number)) throw AppError.llm('嵌入向量包含无效数值');
        return Math.fround(number);
      });
    });
    if (embeddings.length !== texts.length) throw AppError.llm('嵌入向量数量与输入文本数量不匹配');
    const usageNode = field(json, 'usage');
    const measured = asU64(field(usageNode, 'prompt_tokens') ?? field(usageNode, 'total_tokens'));
    recorder.recordLlmUsageExt({ callerType: 'embedding', model: config.model,
      promptTokens: Number(BigInt.asUintN(32, measured ?? 0n)), completionTokens: 0,
      reasoningTokens: null, cachedTokens: null, sessionId: null, durationMs: null, success: true,
      errorMessage: null, adapter: 'openai_embeddings', tokenSource: measured === null ? 'heuristic' : 'api' });
    logInfo(`嵌入API调用成功，返回 ${embeddings.length} 个向量`);
    return embeddings;
  }

  async function callEmbeddingApi(texts: string[], modelConfigId: string): Promise<number[][]> {
    if (texts.length === 0) return [];
    const configs = await appValue(() => manager.getApiConfigs());
    const config = configs.find(c => c.id === modelConfigId);
    if (!config) throw AppError.configuration('找不到嵌入模型配置');
    if (!config.enabled || !config.isEmbedding || config.isMultimodal || config.isReranker) {
      throw AppError.configuration('指定模型不支持文本嵌入协议或已禁用');
    }
    const maxTokens = new EmbeddingTokenLimits(chunkLogger).getLimit(config.model);
    const chunker = new EmbeddingChunker(maxTokens, chunkLogger);
    if (!texts.some(text => chunker.needsChunking(text))) {
      logDebug(`调用嵌入API，文本数量: ${texts.length}`);
      return raw(texts, config);
    }
    logInfo(`嵌入分块：检测到长文本，启用分块处理 (模型限制: ${maxTokens} tokens)`);
    const chunks = batchChunkTexts(texts, chunker);
    const allChunks = chunks.flatMap(result => result.chunks);
    logInfo(`嵌入分块：${texts.length} 个文本分为 ${allChunks.length} 个块`);
    logDebug(`调用嵌入API，文本数量: ${allChunks.length} (分块后)`);
    const vectors = await raw(allChunks, config);
    let index = 0;
    const result = chunks.map(chunk => {
      const count = chunk.chunks.length;
      const vector = count === 0 ? Array<number>(vectors[0]?.length ?? 1024).fill(0)
        : count === 1 ? [...vectors[index]!]
          : EmbeddingChunker.aggregateEmbeddings(vectors.slice(index, index + count), 'MeanPooling', chunkLogger);
      index += count;
      return vector;
    });
    logInfo(`嵌入分块：聚合完成，返回 ${result.length} 个向量`);
    return result;
  }
  return { callEmbeddingApi, async generateEmbedding(text) {
    const config = await appValue(() => models.getEmbeddingModelConfig());
    const embeddings = await callEmbeddingApi([text], config.id);
    const first = embeddings[0];
    if (first === undefined) throw AppError.llm('No embedding returned');
    return first;
  } };
}
