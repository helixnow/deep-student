/**
 * 只有 Host 半的社区插件：提供自己的搜索服务 `exampleWebSearch`（离线返回固定结果），配置由 `Config` 校验。
 *
 * 它与官方 `webSearch` 并存，不替换它：社区插件只能提供由自己 id 派生的服务名
 * （example.web-search → exampleWebSearch，host/kernel/plugin-id.ts 的 pluginServiceName；
 * 提供 `webSearch` 会以 SERVICE_NAME_INVALID 降级），也不能借用官方插件的 id（清单 id 写 `dstu.*` 是 ID_RESERVED；
 * profile 条目写官方 id 却指向本包是 ID_MISMATCH，见 __tests__/fixtures/override.profile.json）。
 * 服务形状沿用官方声明的 `WebSearchService`（host/plugins/mcp/api.ts），调用方可以按同一接口切换。
 */
import { definePlugin, Schema } from '../../../host/kernel/api.ts';
import type { SearchInput, SearchResult, WebSearchService } from '../../../host/plugins/mcp/api.ts';

export interface ExampleWebSearchConfig {
  label: string;
  site: string;
  maxResults: number;
}

/** profile 里 `config` 的 schema：装载时先校验并补默认值（host/kernel/plugin-config.ts），不合法则 CONFIG_INVALID。凭据类字段会被拒绝。 */
export const Config: Schema<Partial<ExampleWebSearchConfig>, ExampleWebSearchConfig> = Schema.object({
  label: Schema.string().default('example-web-search').description('写进 result.provider 与 usage.provider'),
  site: Schema.string().default('https://example.edu/search').description('结果链接指向的站点'),
  maxResults: Schema.natural().max(10).default(3).description('每次最多返回几条（还受 top_k 限制）'),
});

declare module '@deepseek-ai/cordis' {
  interface Context {
    exampleWebSearch: WebSearchService;
  }
}

export function search(input: SearchInput, config: ExampleWebSearchConfig): SearchResult {
  const count = Math.min(input.top_k, config.maxResults);
  const items = Array.from({ length: count }, (_, i) => ({
    title: `${input.query} (${i + 1})`,
    url: `${config.site}?q=${encodeURIComponent(input.query)}&rank=${i + 1}`,
    snippet: `Offline result from the ${config.label} example.`,
    rank: i + 1,
  }));
  return {
    name: 'web_search',
    ok: true,
    args: input,
    result: { provider: config.label, query: input.query, top_k: input.top_k, items },
    citations: items.map((item, i) => ({
      documentId: item.url,
      fileName: item.title,
      chunkText: `${item.title}\n${item.snippet}`,
      score: 1 / (i + 1),
      chunkIndex: i,
      sourceType: 'search',
    })),
    usage: { elapsed_ms: 0, retries: 0, provider_latency_ms: 0, provider: config.label },
  };
}

export default definePlugin<ExampleWebSearchConfig>({
  meta: {
    id: 'example.web-search',
    version: '1.0.0',
    platforms: ['desktop'],
    provides: ['exampleWebSearch'],
  },
  Config,
  apply(ctx, config) {
    ctx.provide('exampleWebSearch', {
      async doSearch(input) {
        return search(input, config);
      },
    });
  },
});
