import { describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '../api.ts';
import {
  CN_TRUSTED_SITES, buildInjectText, buildDeepseekQuery, createProvider, defaultToolConfig,
  doSearch, getStrategy, hasValidKeys, hostAllowed, isRetryable, mapDeepseekError, normalizeScore,
  normalizeUrl, parseBingRss, parseDeepseekResults, redactUrlSecrets, standardize, stripHtml,
  truncate, ToolError, type SearchItem, type SearchInput,} from '../src/web-search.ts';

function input(overrides: Partial<SearchInput> = {}): SearchInput {
  return {
    query: '', top_k: 5, engine: null, site: null, time_range: null, start: null, force_engine: null,
    ...overrides,
  };
}
function item(overrides: Partial<SearchItem> = {}): SearchItem {
  return { title: 'A', url: 'https://example.com/page', snippet: 'snippet', rank: 1, score_hint: null, ...overrides };
}

describe('dstu-mcp/src/tools/web_search.rs::tests', () => {
  it('t_normalize_score', () => {
    expect(Math.abs(normalizeScore(1, 5) - 1)).toBeLessThan(1e-6);
    expect(Math.abs(normalizeScore(5, 5) - 0.2)).toBeLessThan(1e-6);
    expect(normalizeScore(6, 5)).toBe(0);
  });
  it('t_redact_url_secrets', () => {
    const message = 'http error: error sending request for url (https://www.googleapis.com/customsearch/v1?key=AIzaSECRET&cx=abc&q=test)';
    const output = redactUrlSecrets(message);
    expect(output).not.toContain('AIzaSECRET');
    expect(output).toContain('key=[REDACTED]');
    expect(output).toContain('cx=abc');
    const serp = 'https://serpapi.com/search.json?api_key=sk123&q=x';
    const output2 = redactUrlSecrets(serp);
    expect(output2).not.toContain('sk123');
    expect(output2).toContain('api_key=[REDACTED]');
    const plain = 'config error: missing GOOGLE_API_KEY';
    expect(redactUrlSecrets(plain)).toBe(plain);
  });
  it('t_strip_html', () => {
    expect(stripHtml('<div>Hello <b>World</b></div>')).toBe('Hello World');
  });
  it('t_truncate', () => {
    const [short, cut] = truncate('abcdef', 3);
    expect(short).toBe('abc');
    expect(cut).toBe(true);
    const [same, cut2] = truncate('ab', 3);
    expect(same).toBe('ab');
    expect(cut2).toBe(false);
  });
  it('t_url_norm', () => {
    const output = normalizeUrl('https://a.com/?x=1&utm_source=tw');
    expect(output).toContain('x=1');
    expect(output).not.toContain('utm_source');
  });
  it('t_default_engine_is_keyless_bing_rss', () => {
    const config = defaultToolConfig();
    expect(config.default_engine).toBe('bing_rss');
    expect(hasValidKeys(config.keys, 'bing_rss')).toBe(true);
    expect(createProvider('bing_rss').name()).toBe('bing_rss');
  });
  it('t_parse_bing_rss', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <rss version="2.0"><channel>
        <item><title>Rust &amp; Tauri</title><link>https://example.com/a?x=1&amp;y=2</link><description>A &lt;b&gt;desktop&lt;/b&gt; result.</description></item>
        <item><title><![CDATA[Second result]]></title><link>https://example.org/b</link><description><![CDATA[Plain text]]></description></item>
      </channel></rss>`;
    const items = parseBingRss(xml);
    expect(items.length).toBe(2);
    expect(items[0]!.title).toBe('Rust & Tauri');
    expect(items[0]!.url).toBe('https://example.com/a?x=1&y=2');
    expect(items[0]!.snippet).toBe('A desktop result.');
    expect(items[1]!.title).toBe('Second result');
    expect(items[1]!.rank).toBe(2);
  });
  it('t_host_allowed_cn_whitelist', () => {
    const config = defaultToolConfig();
    config.cn_whitelist = { enabled: true, use_default_list: false, custom_sites: ['example.com'] };
    expect(hostAllowed(config, 'https://www.example.com/page')).toBe(true);
    expect(hostAllowed(config, 'https://othersite.org/page')).toBe(false);
  });
  it('t_deepseek_query_operators', () => {
    const search = input({ query: 'DeepSeek V4', site: 'github.com, huggingface.co', time_range: '7d' });
    const query = buildDeepseekQuery(search);
    expect(query.startsWith('DeepSeek V4 ')).toBe(true);
    expect(query).toContain('site:github.com OR site:huggingface.co');
    expect(query).toContain('after:');
    search.site = null;
    search.time_range = '2026-01-01 to 2026-06-01';
    const ranged = buildDeepseekQuery(search);
    expect(ranged).toContain('after:2026-01-01');
    expect(ranged).toContain('before:2026-06-01');
  });
  it('t_deepseek_parse_results', () => {
    const raw: JsonValue = {
      results: [
        { rerank_score: 2.4, title: 'A', url: 'https://a.com/1', snippet: '', summary: 'long summary' },
        { rerank_score: 6.0, title: 'B', url: 'https://b.com/2', snippet: 'short', summary: 'unused' },
        { title: 'no url', url: '', snippet: 'skip me' },
      ],
    };
    const items = parseDeepseekResults(raw);
    expect(items.length).toBe(2);
    expect(items[0]!.snippet).toBe('long summary');
    expect(Math.abs(items[0]!.score_hint! - 0.8)).toBeLessThan(1e-6);
    expect(items[1]!.snippet).toBe('short');
    expect(Math.abs(items[1]!.score_hint! - 1)).toBeLessThan(1e-6);
    expect(items[1]!.rank).toBe(2);
  });
  it('t_deepseek_error_mapping', () => {
    expect(mapDeepseekError(401, '').kind).toBe('config');
    const balance = mapDeepseekError(402, '{"error":{"message":"no balance"}}');
    expect(balance.kind).toBe('provider');
    expect(balance.toString()).toContain('no balance');
    expect(mapDeepseekError(429, '').toString())
      .toBe('provider error: deepseek http 429: 搜索限速（账号级 5 QPS）: ');
  });
  it('t_deepseek_keys_and_strategy', () => {
    const config = defaultToolConfig();
    expect(hasValidKeys(config.keys, 'deepseek')).toBe(false);
    config.keys.deepseek = 'sk-test';
    expect(hasValidKeys(config.keys, 'deepseek')).toBe(true);
    expect(createProvider('deepseek').name()).toBe('deepseek');
    const strategy = getStrategy(config.provider_strategies!, 'deepseek');
    expect(strategy.rate_limit_per_minute).toBe(60);
    expect(strategy.timeout_ms).toBe(10000);
  });
  it('t_deepseek_content_preferred_in_inject_text', () => {
    const config = defaultToolConfig();
    config.inject_snippet_max_chars = 180;
    const raw: JsonValue = {
      results: [
        {
          title: 'A', url: 'https://example.com/page?utm_source=feed',
          snippet: 'SHORT SNIPPET FOR CARD', content: 'FULL PAGE MARKDOWN BODY',
        },
        {
          title: 'B', url: 'https://example.org/no-content',
          snippet: 'FALLBACK SNIPPET', summary: 'FALLBACK SUMMARY',
        },
      ],
    };
    const items = [
      item({ title: 'A', url: normalizeUrl('https://example.com/page?utm_source=feed'), snippet: 'SHORT SNIPPET FOR CARD' }),
      item({ title: 'B', url: normalizeUrl('https://example.org/no-content'), snippet: 'FALLBACK SNIPPET', rank: 2 }),
    ];
    const text = buildInjectText(config, { items, raw, provider: 'deepseek' });
    expect(text).toContain('FULL PAGE MARKDOWN BODY');
    expect(text).not.toContain('SHORT SNIPPET FOR CARD');
    expect(text).toContain('FALLBACK SNIPPET');
    expect(text).toContain('[1] A — FULL PAGE MARKDOWN BODY');
    expect(text).toContain('URL: https://example.com/page');
  });
  it('t_deepseek_content_respects_snippet_budget', () => {
    const config = defaultToolConfig();
    config.inject_snippet_max_chars = 10;
    const text = buildInjectText(config, {
      items: [item({ url: 'https://example.com/page', snippet: 'snippet' })],
      raw: {
        results: [{ url: 'https://example.com/page', snippet: 'snippet', content: '0123456789ABCDEF' }],
      },
      provider: 'deepseek',
    });
    expect(text).toContain('0123456789');
    expect(text).not.toContain('ABCDEF');
    expect(text).not.toContain('— snippet');
  });
  it('t_non_deepseek_provider_ignores_content_field', () => {
    const config = defaultToolConfig();
    const text = buildInjectText(config, {
      items: [item({ snippet: 'provider snippet' })],
      raw: {
        results: [{ url: 'https://example.com/page', snippet: 'provider snippet', content: 'SHOULD NOT BE INJECTED' }],
      },
      provider: 'tavily',
    });
    expect(text).toContain('provider snippet');
    expect(text).not.toContain('SHOULD NOT BE INJECTED');
  });
  it('t_deepseek_content_survives_reranker_raw_wrapping', () => {
    const config = defaultToolConfig();
    const text = buildInjectText(config, {
      items: [item({ snippet: 'wrapped snippet' })],
      raw: {
        raw: { results: [{ url: 'https://example.com/page', snippet: 'wrapped snippet', content: 'WRAPPED CONTENT' }] },
        provider: 'deepseek',
      },
      provider: 'single',
    });
    expect(text).toContain('WRAPPED CONTENT');
    expect(text).not.toContain('wrapped snippet');
  });
  it('t_provider_402_is_not_retryable', () => {
    expect(isRetryable(mapDeepseekError(402, '{"error":{"message":"no balance"}}'))).toBe(false);
    expect(isRetryable(mapDeepseekError(429, ''))).toBe(true);
    expect(isRetryable(mapDeepseekError(401, ''))).toBe(false);
    const provider = (message: string) => new ToolError('provider', message);
    expect(isRetryable(provider('deepseek http 400: bad request'))).toBe(false);
    expect(isRetryable(provider('deepseek http 401: 鉴权失败'))).toBe(false);
    expect(isRetryable(provider('deepseek http 403: forbidden'))).toBe(false);
    expect(isRetryable(provider('deepseek http 404: not found'))).toBe(false);
    expect(isRetryable(provider('deepseek http 408: 请求超时'))).toBe(true);
    expect(isRetryable(provider('deepseek http 429: 搜索限速（账号级 5 QPS）'))).toBe(true);
    expect(isRetryable(provider('deepseek http 500: internal error'))).toBe(true);
    expect(isRetryable(provider('connection reset by peer'))).toBe(true);
    expect(isRetryable(new ToolError('config', 'missing key'))).toBe(false);
  });
});

describe('web_search extra contract checks', () => {
  it('keeps the Rust whitelist constant and standardization order', () => {
    expect(CN_TRUSTED_SITES).toContain('edu.cn');
    expect(CN_TRUSTED_SITES).toContain('postgresql.org');
    const items = standardize([
      item({ url: 'https://a.com/?utm_source=x', rank: 1 }),
      item({ url: 'https://a.com/', rank: 2 }),
      item({ url: 'https://b.com/', rank: 3 }),
    ], 2);
    expect(items.map(entry => entry.url)).toEqual(['https://a.com/', 'https://b.com/']);
    expect(items[0]!.score_hint).toBe(1);
    expect(items[1]!.score_hint).toBe(0);
  });
});

describe('dstu-mcp/src/tools/web_search.rs::do_search cancellation', () => {
  it('checks cancellation before issuing any provider request', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      await expect(doSearch(
        defaultToolConfig(), input({ query: 'cancelled', force_engine: 'bing_rss' }),
        undefined, controller.signal,
      )).rejects.toMatchObject({ name: 'AbortError' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('L19-V2-03 web_search runtime uses std::time::Instant semantics (web_search.rs:768-825)', () => {
  it('cache TTL is monotonic: a wall-clock jump does not expire a cached result', async () => {
    const fetchMock = vi.fn(async () => new Response(
      '<?xml version="1.0"?><rss><channel><item><title>T</title><link>https://example.com/mono</link><description>d</description></item></channel></rss>',
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const config = defaultToolConfig();
      const query = input({ query: `monotonic-cache-${Math.random()}`, top_k: 1, force_engine: 'bing_rss' });
      expect((await doSearch(config, query)).ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 10 * 60 * 60 * 1000);
      expect((await doSearch(config, query)).ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe('L19-V2-03 dropping a do_search future releases semaphore/rate-limiter waits (web_search.rs:654-668)', () => {
  const RSS = '<?xml version="1.0"?><rss><channel><item><title>T</title><link>https://example.com/c</link><description>d</description></item></channel></rss>';
  function strategyConfig(patch: Record<string, JsonValue>) {
    const config = defaultToolConfig();
    const strategies = config.provider_strategies!;
    config.provider_strategies = { ...strategies, bing_rss: { ...strategies.bing_rss, cache_enabled: false, ...patch } };
    config.provider_strategies_overridden = true;
    return config;
  }

  it('abort while queued on max_concurrent_requests rejects and does not leak the permit', async () => {
    let releaseFirst!: () => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { releaseFirst = () => resolve(new Response(RSS, { status: 200 })); }))
      .mockImplementation(async () => new Response(RSS, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const config = strategyConfig({ max_concurrent_requests: 1, rate_limit_per_minute: 0 });
      const first = doSearch(config, input({ query: 'sem-a', top_k: 1, force_engine: 'bing_rss' }));
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const controller = new AbortController();
      const queued = doSearch(config, input({ query: 'sem-b', top_k: 1, force_engine: 'bing_rss' }), () => undefined, controller.signal);
      controller.abort(new Error('dropped'));
      await expect(queued).rejects.toThrow('dropped');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      releaseFirst();
      expect((await first).ok).toBe(true);
      expect((await doSearch(config, input({ query: 'sem-c', top_k: 1, force_engine: 'bing_rss' }))).ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('abort while sleeping for a rate-limit slot rejects without waiting out the window', async () => {
    const fetchMock = vi.fn(async () => new Response(RSS, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const config = strategyConfig({ max_concurrent_requests: 0, rate_limit_per_minute: 1 });
      expect((await doSearch(config, input({ query: 'rate-a', top_k: 1, force_engine: 'bing_rss' }))).ok).toBe(true);
      const controller = new AbortController();
      const started = performance.now();
      const waiting = doSearch(config, input({ query: 'rate-b', top_k: 1, force_engine: 'bing_rss' }), () => undefined, controller.signal);
      setTimeout(() => controller.abort(new Error('dropped')), 20);
      await expect(waiting).rejects.toThrow('dropped');
      expect(performance.now() - started).toBeLessThan(5000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
