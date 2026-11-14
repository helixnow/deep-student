import { describe, expect, it, vi } from 'vitest';
import { defaultToolConfig, doSearch } from '../../mcp/api.ts';

const BING_RSS = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>Deep Student AI - Bing</title>
    <item>
      <title>Deep Student AI</title>
      <link>https://example.com/deep-student</link>
      <description>An AI learning workspace.</description>
    </item>
    <item>
      <title>Deep Student documentation</title>
      <link>https://example.com/docs</link>
      <description>Guides and reference.</description>
    </item>
    <item>
      <title>Deep Student release notes</title>
      <link>https://example.com/releases</link>
      <description>What changed.</description>
    </item>
  </channel>
</rss>`;

describe('tests/bing_rss_search.rs', () => {
  it('bing_rss_returns_search_citations_without_api_key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(BING_RSS, {
      status: 200,
      headers: { 'content-type': 'application/rss+xml' },
    })));
    try {
      const config = defaultToolConfig();
      config.timeout_ms = 10_000;
      const result = await doSearch(config, {
        query: 'Deep Student AI',
        top_k: 3,
        engine: 'bing_rss',
        site: null,
        time_range: null,
        start: null,
        force_engine: null,
      });
      expect(result.ok).toBe(true);
      const usage = result.usage as { provider?: string } | undefined;
      expect(usage?.provider).toBe('bing_rss');
      expect(result.citations?.length ?? 0).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
