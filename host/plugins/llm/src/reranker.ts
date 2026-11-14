/** Reranker owner: rag_extension.rs:302,499,744,1313 (WP-023/024). Usage belongs to F3. */
import { AppError } from '../../../platform/errors/api.ts';
import type { LlmUsageService } from '../../../platform/storage/api.ts';
import { decodeUtf8Strict, parseJsonDocument, type JsonNode } from '../../../platform/util/portable.ts';
import { toVLEmbeddingInput, type MultimodalInput, type VLRerankerResult } from '../../llm-providers/api.ts';
import type { ApiConfig, LLMManager, LlmReranker, RetrievedChunk } from '../api.ts';
import { appValue, asU64, errorResponseText, field } from './embedding_transport.ts';
import { logDebug, logError, logInfo } from './logging.ts';

interface RerankFlavor {
  readonly label: string;
  readonly logTag: string;
  readonly browserHeaders: boolean;
}
const TEXT: RerankFlavor = { label: '重排序', logTag: 'Reranker', browserHeaders: true };
const MULTIMODAL: RerankFlavor = { label: '多模态重排序', logTag: 'MultimodalReranker', browserHeaders: false };

function textCapable(config: ApiConfig): boolean {
  return config.enabled && config.isReranker && !config.isMultimodal && !config.isEmbedding;
}
function multimodalCapable(config: ApiConfig): boolean {
  return config.enabled && config.isReranker && config.isMultimodal && !config.isEmbedding;
}
function errorText(error: unknown): string {
  const source = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  return source instanceof Error ? source.message : String(source);
}

export function createLlmReranker(manager: LLMManager, fetcher: typeof fetch,
  usage: () => Pick<LlmUsageService, 'recordLlmUsageExt'>): LlmReranker {
  async function assigned(pick: 'reranker_model_config_id' | 'vl_reranker_model_config_id', missing: string,
    notFound: string, mismatch: string, capable: (config: ApiConfig) => boolean): Promise<ApiConfig> {
    const id = (await appValue(() => manager.getModelAssignments()))[pick];
    if (id === null || id === undefined) throw AppError.configuration(missing);
    const config = (await appValue(() => manager.getApiConfigs())).find(c => c.id === id);
    if (!config) throw AppError.configuration(notFound);
    if (!capable(config)) throw AppError.configuration(mismatch);
    return config;
  }
  const getRerankerModelConfig = () => assigned('reranker_model_config_id', '未配置重排序模型',
    '找不到重排序模型配置', '文本重排序配置已禁用或能力协议不匹配', textCapable);
  const getVlRerankerModelConfig = () => assigned('vl_reranker_model_config_id', '未配置多模态重排序模型 (VL-Reranker)',
    '找不到多模态重排序模型配置', '多模态重排序配置已禁用或能力协议不匹配', multimodalCapable);

  /** POST `{base}/rerank` and return the parsed `(index, relevance_score)` pairs plus the response document. */
  async function post(flavor: RerankFlavor, config: ApiConfig, apiKey: string, body: unknown):
    Promise<{ json: JsonNode; results: { index: bigint; score: number }[] }> {
    const url = `${config.baseUrl.replace(/\/+$/, '')}/rerank`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json',
      'Accept-Encoding': 'identity',
    };
    if (flavor.browserHeaders) {
      headers['Accept-Language'] = 'zh-CN,zh;q=0.9,en;q=0.8';
      headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
    }
    let base: URL | null;
    try { base = new URL(config.baseUrl); }
    catch { base = null; } // boundary-allow empty-catch: Rust `if let Ok(parsed_url)` omits origin/referer on URL failure.
    if (base && ['http:', 'https:'].includes(base.protocol) && base.hostname !== '') {
      headers.Origin = `${base.protocol}//${base.hostname}`;
      if (flavor.browserHeaders) headers.Referer = `${base.protocol}//${base.hostname}/`;
    }
    let response: Response;
    try { response = await fetcher(url, { method: 'POST', headers, body: JSON.stringify(body) }); }
    catch (error) {
      throw AppError.network(`${flavor.label}API请求失败: error sending request for url (${url}): ${errorText(error)}`);
    }
    if (!response.ok) {
      const status = response.status;
      let detail: string;
      try { detail = await errorResponseText(response); }
      catch { detail = ''; } // boundary-allow empty-catch: Rust response.text().await.unwrap_or_default().
      logError(`[${flavor.logTag}] API error ${status}: ${detail}`);
      throw AppError.llm(status === 401 ? 'API 密钥无效或已过期，请检查设置'
        : status === 403 ? 'API 访问被拒绝，请检查账户权限'
          : status === 429 ? '请求过于频繁，请稍后重试'
            : status >= 500 && status <= 599 ? '重排序服务暂时不可用，请稍后重试' : '重排序请求失败，请重试');
    }
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await response.arrayBuffer()); }
    catch (error) { throw AppError.llm(`解析${flavor.label}API响应失败: request or response body error: ${errorText(error)}`); }
    let json: JsonNode;
    try { json = parseJsonDocument(decodeUtf8Strict(bytes)); }
    catch (error) { throw AppError.llm(`解析${flavor.label}API响应失败: error decoding response body: ${errorText(error)}`); }
    const results = field(json, 'results');
    if (results?.kind !== 'array') throw AppError.llm(`${flavor.label}API响应格式无效：缺少results字段`);
    return { json, results: results.items.map(item => {
      const index = asU64(field(item, 'index'));
      if (index === null) throw AppError.llm('重排序结果缺少index字段');
      const score = field(item, 'relevance_score');
      if (score?.kind !== 'number') throw AppError.llm('重排序结果缺少relevance_score字段');
      return { index, score: Math.fround(Number(score.value.raw)) };
    }) };
  }

  async function callRerankerApi(query: string, chunks: RetrievedChunk[], modelConfigId: string): Promise<RetrievedChunk[]> {
    logDebug(`调用重排序API，候选文档数量: ${chunks.length}`);
    const config = (await appValue(() => manager.getApiConfigs())).find(c => c.id === modelConfigId);
    if (!config) throw AppError.configuration('找不到重排序模型配置');
    if (!textCapable(config)) throw AppError.configuration('指定模型不支持文本重排序协议或已禁用');
    const apiKey = await appValue(() => manager.decryptApiKey(config.apiKey));
    const recorder = usage();
    const { json, results } = await post(TEXT, config, apiKey, {
      model: config.model, query, documents: chunks.map(c => c.chunk.text), top_k: chunks.length, return_documents: true,
    });
    const reranked = results.filter(r => r.index < BigInt(chunks.length))
      .map(r => ({ ...structuredClone(chunks[Number(r.index)]!), score: r.score }));
    const usageNode = field(json, 'usage') ?? field(json, 'meta');
    const measured = asU64(field(field(usageNode, 'billed_units'), 'search_units') ?? field(usageNode, 'tokens'));
    recorder.recordLlmUsageExt({ callerType: 'reranker', model: config.model,
      promptTokens: Number(BigInt.asUintN(32, measured ?? 0n)), completionTokens: 0,
      reasoningTokens: null, cachedTokens: null, sessionId: null, durationMs: null, success: true,
      errorMessage: null, adapter: 'rerank', tokenSource: measured === null ? 'heuristic' : 'api' });
    logInfo(`重排序API调用成功，返回 ${reranked.length} 个重排序结果`);
    return reranked;
  }

  async function callMultimodalRerankerApi(query: MultimodalInput, documents: readonly MultimodalInput[]): Promise<VLRerankerResult[]> {
    if (documents.length === 0) return [];
    logDebug(`调用多模态重排序API，候选文档数量: ${documents.length}`);
    const config = await getVlRerankerModelConfig();
    const apiKey = await appValue(() => manager.decryptApiKey(config.apiKey));
    const { results } = await post(MULTIMODAL, config, apiKey, {
      model: config.model, query: toVLEmbeddingInput(query), documents: documents.map(toVLEmbeddingInput),
      top_k: documents.length, return_documents: false,
    });
    const ranked = results.map(r => ({ index: Number(r.index), relevance_score: r.score }))
      .sort((a, b) => (b.relevance_score > a.relevance_score ? 1 : b.relevance_score < a.relevance_score ? -1 : 0));
    logInfo(`多模态重排序API调用成功，返回 ${ranked.length} 个重排序结果`);
    return ranked;
  }

  return {
    getRerankerModelConfig, getVlRerankerModelConfig, callRerankerApi, callMultimodalRerankerApi,
    isMultimodalRerankingConfigured: () => getVlRerankerModelConfig().then(() => true, () => false),
  };
}
