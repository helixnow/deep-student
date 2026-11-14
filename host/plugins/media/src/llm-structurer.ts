/**
 * `dstu-vision/src/llm_structurer.rs`: reuse check for persisted batch results.
 *
 * A failed batch is stored with `BATCH_FAILED_SENTINEL` instead of `[]` so that
 * resume can tell "failed" from "succeeded with no questions"; only a non-empty
 * JSON array of values counts as reusable. The structuring command itself needs
 * L02 (`LLMManager`) and is not registered.
 */

export const BATCH_SIZE = 8;
export const BATCH_FAILED_SENTINEL = '__LLM_BATCH_FAILED__';

/**
 * 判断持久化的批次结果是否为"可复用的成功结果"
 * （非空、非失败哨兵、可解析为非空 JSON 数组）。
 */
export function parseReusableBatchResult(s: string): unknown[] | null {
  if (s === '' || s === BATCH_FAILED_SENTINEL) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(s); }
  catch { return null; }
  return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
}
