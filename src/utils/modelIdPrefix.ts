/**
 * 模型 ID 前缀/类型共享工具
 *
 * 自定义网关常用「slug_型号名」的 ID 形态（如 embed-gateway_qwen3.8-max）。
 * 前缀描述的是网关而非模型本身，却会被裸子串启发式
 * （EMBEDDING_REGEX 的 `embed` 等）误当成模型能力信号——本模块提供统一的
 * 前缀剥离与嵌入/重排类型信号判定，供能力引擎与注册表匹配共用，
 * 避免两处规则漂移。
 */

/**
 * 嵌入模型信号（与 apiCapabilityEngine 的判定保持同一份正则）。
 * `^text-` 覆盖 text-embedding-* / text-embed-*；其余为裸子串。
 */
export const EMBEDDING_SIGNAL_REGEX =
  /(?:^text-|embed|bge-|e5-|llm2vec|retrieval|uae-|gte-|jina-clip|jina-embeddings|voyage-)/i;

/** 重排模型信号。含 `retrieval`（部分重排产品以此命名）。 */
export const RERANK_SIGNAL_REGEX = /(?:rerank|re-rank|re-ranker|re-ranking|retrieval|retriever)/i;

export type ModelKindSignal = 'embedding' | 'rerank';

/**
 * 剥离「网关 slug_」前缀，返回型号名本体。
 *
 * 规则（宁可不剥、不可误剥）：
 * 1. 先取最后一段 `/` 路径（OpenRouter/托管平台惯例）；
 * 2. 该段内以第一个 `_` 切分，前缀须形如网关 slug（含 `-`）；
 * 3. 剩余部分须形如型号名（含 `-` 或 `.`，且含字母）——排除
 *    `bce-embedding-base_v1`（剩余 v1 是版本号）与
 *    `bge-m3_20250815`（剩余是纯日期）这类「型号_版本」形态。
 *
 * 示例：
 * - `embed-gateway_qwen3.7-text-rerank` → `qwen3.7-text-rerank`
 * - `BAAI/bge-m3` → `bge-m3`（仅路径剥离）
 * - `bce-embedding-base_v1` → 原样（剩余部分无分隔符）
 * - `gte_Qwen2-7B-instruct` → 原样（前缀无 `-`）
 * - `Qwen3-Embedding-0.6B` → 原样（无 `_`）
 */
export function stripGatewayPrefix(modelId: string): string {
  if (!modelId) return '';
  const trimmed = modelId.trim();
  const slashIdx = trimmed.lastIndexOf('/');
  const segment = slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : trimmed;
  const underscoreIdx = segment.indexOf('_');
  if (underscoreIdx <= 0) return segment;
  const prefix = segment.slice(0, underscoreIdx);
  const rest = segment.slice(underscoreIdx + 1);
  if (!prefix.includes('-')) return segment;
  if (!/[-.]/.test(rest) || !/[a-z]/i.test(rest)) return segment;
  return rest;
}

/**
 * 判定模型 ID 的嵌入/重排类型信号。
 *
 * 只对**剥离网关前缀后的型号名**做正则判定（前缀描述网关，不代表模型能力，
 * 例如 embed-gateway_ 下的聊天模型）。返回 null 表示无类型信号（视为普通模型）。
 *
 * 重排优先于嵌入：一个模型不会同时是嵌入与重排（接口形态互斥：
 * /embeddings vs /rerank），而网关 slug 可能自带 `embed` 字样
 * （如 embed-gateway_qwen3.7-text-rerank 是重排而非嵌入）。
 */
export function detectModelKindSignal(modelId: string): ModelKindSignal | null {
  const name = stripGatewayPrefix(modelId);
  if (!name) return null;
  if (RERANK_SIGNAL_REGEX.test(name)) return 'rerank';
  if (EMBEDDING_SIGNAL_REGEX.test(name)) return 'embedding';
  return null;
}
