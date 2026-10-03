// 端点判定（官方宿主识别）。
//
// 目前只有 DeepSeek 需要区分官方与托管端点：官方 API 的 reasoning_effort 语义
// （none/low/high/max，默认 high）与托管宿主的历史 budget 方言不同。
// 其余供应商的官方识别在后端由 provider-protocol-registry.json 的 official 字段承载。

export interface EndpointProbeInput {
  model?: unknown;
  modelId?: unknown;
  providerType?: unknown;
  providerScope?: unknown;
  baseUrl?: unknown;
}

const normalize = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

/** 是否为 DeepSeek 官方端点（host 精确匹配 api.deepseek.com）。 */
export function isOfficialDeepSeekEndpoint(input: EndpointProbeInput): boolean {
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
  if (baseUrl) {
    try {
      return new URL(baseUrl).hostname === 'api.deepseek.com';
    } catch {
      return false;
    }
  }
  return normalize(input.providerType) === 'deepseek' || normalize(input.providerScope) === 'deepseek';
}
