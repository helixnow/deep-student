/**
 * L02 (dstu-llm) pure helpers that `vlm_grounding_service.rs` calls but `host/plugins/llm/api.ts`
 * does not publish yet. Copied verbatim from the L02 implementation (same precedent as qbank's
 * DIFFICULTY_RUBRIC copy); replace with imports once L02 publishes them (BLOCKERS.md L18-B-VLM-1).
 */

/** `adapters/zhipu.rs ZhipuAdapter::supports_thinking_static` (= L02 `ZhipuAdapter.supportsThinkingStatic`). */
export function zhipuSupportsThinking(model: string): boolean {
  const lower = model.toLowerCase();
  if (lower.includes('-flash') || lower.includes('4.1v')) return false;
  return ['glm-4.5', 'glm-4.6', 'glm-4.7', 'glm4.5', 'glm4.6', 'glm4.7', 'glm-5', 'glm5']
    .some(fragment => lower.includes(fragment));
}

/** `llm_manager::sanitize_url_for_log` (= L02 `audit.ts sanitizeUrlForLog`): query 凭据只保留键名。 */
export function sanitizeUrlForLog(url: string): string {
  const question = url.indexOf('?');
  if (question < 0) return url;
  const sensitive = new Set(['key', 'api_key', 'apikey', 'api-key', 'token', 'access_token', 'secret']);
  const query = url.slice(question + 1).split('&').map(pair => {
    const equals = pair.indexOf('=');
    if (equals < 0) return pair;
    const key = pair.slice(0, equals);
    return sensitive.has(key.toLowerCase()) ? `${key}=[REDACTED]` : pair;
  }).join('&');
  return `${url.slice(0, question)}?${query}`;
}

/** `single_shot_stream::is_retryable_http_status`. */
export function isRetryableHttpStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  if (status === 501 || status === 505) return false;
  return status >= 500 && status <= 599;
}
