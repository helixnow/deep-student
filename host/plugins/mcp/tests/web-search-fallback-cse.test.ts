import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_CSE_DEFAULT_ENDPOINT,
  applyDbOverrides,
  assessZeroKeySearchQuality,
  buildCacheKey,
  decodeSearchRedirectUrl,
  defaultProviderKeys,
  defaultToolConfig,
  doSearch,
  extractQueryTermGroups,
  googleCseEndpoint,
  parseBingHtml,
  parseDuckDuckGoHtml,
  parseMediaWikiSearch,
  resetProviderRuntime,
  toolConfigFromEnv,
  type SearchInput,
  type ToolConfig,
} from '../src/web-search.ts';

function searchInput(overrides: Partial<SearchInput> = {}): SearchInput {
  return {
    query: '',
    top_k: 5,
    engine: 'bing_rss',
    site: null,
    time_range: null,
    start: null,
    force_engine: null,
    ...overrides,
  };
}

function uncachedConfig(): ToolConfig {
  const config = defaultToolConfig();
  const strategies = config.provider_strategies!;
  config.provider_strategies = {
    ...strategies,
    bing_rss: { ...strategies.bing_rss, cache_enabled: false, max_retries: 1 },
    google_cse: { ...strategies.google_cse, cache_enabled: false, max_retries: 1 },
  };
  config.provider_strategies_overridden = true;
  config.retry = { max_attempts: 1, initial_delay_ms: 1 };
  return config;
}

function rssXml(items: Array<{ title: string; link: string; description: string }>): string {
  const body = items.map(item =>
    `<item><title>${item.title}</title><link>${item.link}</link><description>${item.description}</description></item>`,
  ).join('');
  return `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel>${body}</channel></rss>`;
}

beforeEach(() => {
  resetProviderRuntime();
  vi.stubEnv('GOOGLE_CSE_ENDPOINT', '');
  delete process.env.GOOGLE_CSE_ENDPOINT;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('G23 zero-key search quality assessment & parsers', () => {
  it('extracts multi-token English and CJK term groups', () => {
    const en = extractQueryTermGroups('"Tokyo" weather in Japan today');
    expect(en.hasCjk).toBe(false);
    expect(en.groups).toEqual([['tokyo'], ['weather'], ['japan']]);

    const zh = extractQueryTermGroups('2027年考研政治大纲');
    expect(zh.hasCjk).toBe(true);
    expect(zh.groups[0]).toEqual(['2027']);
    expect(zh.groups.length).toBeGreaterThanOrEqual(2);
    expect(zh.groups.slice(1).flat()).toContain('考研');
    expect(zh.groups.slice(1).flat()).toContain('政治');
    expect(zh.groups.slice(1).flat()).toContain('大纲');
  });

  it('detects first-token truncation for English and CJK queries', () => {
    const truncatedWeather = assessZeroKeySearchQuality('weather in Tokyo today', [
      { title: 'Seattle Weather Forecast', url: 'https://weather.example.com/seattle', snippet: 'Local weather radar', rank: 1, score_hint: null },
      { title: 'National Weather Service', url: 'https://weather.gov/', snippet: 'US weather alerts', rank: 2, score_hint: null },
    ], null, 5);
    expect(truncatedWeather.ok).toBe(false);
    expect(truncatedWeather.reason).toBe('first_token_truncation');

    const truncatedCjk = assessZeroKeySearchQuality('2027年考研政治大纲', [
      { title: '2027年_百度百科', url: 'https://baike.baidu.com/item/2027', snippet: '2027年是公历平年', rank: 1, score_hint: null },
      { title: '2027年日历表', url: 'https://calendar.example.cn/2027', snippet: '2027全年节假日安排', rank: 2, score_hint: null },
    ], null, 5);
    expect(truncatedCjk.ok).toBe(false);
    expect(truncatedCjk.reason).toBe('first_token_truncation');
  });

  it('detects Microsoft/Outlook boilerplate spam unless explicitly queried', () => {
    const boilerplate = assessZeroKeySearchQuality('2027年考研政治大纲', [
      { title: 'Outlook – free personal email', url: 'https://outlook.live.com/owa/', snippet: 'Sign in', rank: 1, score_hint: null },
      { title: 'Microsoft 365', url: 'https://www.microsoft.com/en-us/microsoft-365', snippet: 'Productivity', rank: 2, score_hint: null },
    ], null, 5);
    expect(boilerplate.ok).toBe(false);
    expect(boilerplate.reason).toBe('boilerplate_domain');

    const explicitQuery = assessZeroKeySearchQuality('Microsoft Outlook sign in help', [
      { title: 'Sign in to Microsoft Outlook', url: 'https://support.microsoft.com/outlook-sign-in', snippet: 'Help for Outlook sign in', rank: 1, score_hint: null },
    ], null, 5);
    expect(explicitQuery.ok).toBe(true);
  });

  it('unwraps DDG uddg redirects and Bing base64url ck/a redirects', () => {
    expect(decodeSearchRedirectUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fweather.jp%2Ftokyo&rut=abc'))
      .toBe('https://weather.jp/tokyo');
    const b64 = Buffer.from('https://kaoyan.eol.cn/2027-zhengzhi', 'utf8').toString('base64url');
    expect(decodeSearchRedirectUrl(`https://www.bing.com/ck/a?u=a1${b64}&ntb=1`))
      .toBe('https://kaoyan.eol.cn/2027-zhengzhi');
  });

  it('parses DuckDuckGo HTML, DuckDuckGo Lite, Bing HTML SERP, and MediaWiki responses', () => {
    const ddgHtml = `
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ftimeanddate.com%2Fweather%2Fjapan%2Ftokyo">Tokyo Weather Today</a>
        <a class="result__snippet">Current weather in Tokyo: 18°C, sunny.</a>
      </div>`;
    expect(parseDuckDuckGoHtml(ddgHtml)).toEqual([
      { title: 'Tokyo Weather Today', url: 'https://timeanddate.com/weather/japan/tokyo', snippet: 'Current weather in Tokyo: 18°C, sunny.', rank: 1, score_hint: null },
    ]);

    const ddgLite = `
      <table><tr><td><a href="/l/?uddg=https%3A%2F%2Fkaoyan.cn%2F2027" class="result-link">2027考研政治大纲解析</a></td></tr>
      <tr><td class="result-snippet">2027年考研政治大纲变化汇总</td></tr></table>`;
    expect(parseDuckDuckGoHtml(ddgLite)).toEqual([
      { title: '2027考研政治大纲解析', url: 'https://kaoyan.cn/2027', snippet: '2027年考研政治大纲变化汇总', rank: 1, score_hint: null },
    ]);

    const encodedUrl = Buffer.from('https://edu.example.cn/2027-syllabus', 'utf8').toString('base64url');
    const bingHtml = `
      <ol id="b_results">
        <li class="b_algo">
          <h2><a href="https://www.bing.com/ck/a?u=a1${encodedUrl}">2027年考研政治大纲官方要点</a></h2>
          <div class="b_caption"><p>2027考研政治考试大纲核心变动说明</p></div>
        </li>
      </ol>`;
    expect(parseBingHtml(bingHtml)).toEqual([
      { title: '2027年考研政治大纲官方要点', url: 'https://edu.example.cn/2027-syllabus', snippet: '2027考研政治考试大纲核心变动说明', rank: 1, score_hint: null },
    ]);

    const wikiItems = parseMediaWikiSearch({
      query: { search: [{ title: '考研政治', snippet: '全国硕士研究生招生考试<span class="searchmatch">思想政治</span>理论' }] },
    }, 'zh.wikipedia.org');
    expect(wikiItems).toEqual([
      {
        title: '考研政治',
        url: 'https://zh.wikipedia.org/wiki/%E8%80%83%E7%A0%94%E6%94%BF%E6%B2%BB',
        snippet: '全国硕士研究生招生考试思想政治理论',
        rank: 1,
        score_hint: null,
      },
    ]);
  });
});

describe('G23 zero-key automatic fallback orchestration in doSearch', () => {
  it('falls back to DuckDuckGo HTML when Bing RSS truncates multi-token query "weather in Tokyo today"', async () => {
    const visited: string[] = [];
    const fetcher = vi.fn(async (inputUrl: string | URL) => {
      const url = String(inputUrl);
      visited.push(url);
      if (url.includes('bing.com/search') && url.includes('format=rss')) {
        return new Response(rssXml([
          { title: 'Seattle Weather Today', link: 'https://www.weather.com/seattle', description: 'Local Seattle weather forecast' },
          { title: 'Weather Radar', link: 'https://www.accuweather.com/us', description: 'US weather map' },
        ]), { status: 200 });
      }
      if (url.startsWith('https://html.duckduckgo.com/html/')) {
        return new Response(`
          <div class="result">
            <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ftimeanddate.com%2Fweather%2Fjapan%2Ftokyo%3Futm_source%3Dddg">Tokyo Weather Today - timeanddate</a>
            <a class="result__snippet">Current weather in Tokyo today: 20°C clear skies.</a>
          </div>
          <div class="result">
            <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ftimeanddate.com%2Fweather%2Fjapan%2Ftokyo">Duplicate Tokyo Weather</a>
            <a class="result__snippet">Duplicate link should be deduplicated.</a>
          </div>`, { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    const result = await doSearch(uncachedConfig(), searchInput({ query: 'weather in Tokyo today', top_k: 5 }), undefined, undefined, fetcher as unknown as typeof fetch);
    expect(result.ok).toBe(true);
    expect(visited.some(url => url.includes('format=rss'))).toBe(true);
    expect(visited.some(url => url.startsWith('https://html.duckduckgo.com/html/'))).toBe(true);
    expect(result.result).toMatchObject({
      provider: 'bing_rss',
      fallback_provider: 'ddg_html',
      fallback_reason: 'first_token_truncation',
    });
    expect(result.citations).toHaveLength(1);
    expect(result.citations![0]!.documentId).toBe('https://timeanddate.com/weather/japan/tokyo');
    expect(result.citations![0]!.fileName).toContain('Tokyo Weather Today');
  });

  it('falls back to Bing HTML SERP when Bing RSS truncates CJK "2027年考研政治大纲" and DDG is blocked', async () => {
    const encodedTarget = Buffer.from('https://kaoyan.example.edu.cn/2027/zhengzhi-dagang', 'utf8').toString('base64url');
    const fetcher = vi.fn(async (inputUrl: string | URL) => {
      const url = String(inputUrl);
      if (url.includes('bing.com/search') && url.includes('format=rss')) {
        return new Response(rssXml([
          { title: '2027年_百度百科', link: 'https://baike.baidu.com/item/2027', description: '2027年公历平年' },
          { title: '2027日历', link: 'https://rili.example.cn/2027', description: '2027农历对照表' },
        ]), { status: 200 });
      }
      if (url.includes('duckduckgo.com')) {
        return new Response('<html>challenge</html>', { status: 202 });
      }
      if (url.includes('bing.com/search') && !url.includes('format=rss')) {
        return new Response(`
          <ol id="b_results">
            <li class="b_algo">
              <h2><a href="https://www.bing.com/ck/a?u=a1${encodedTarget}">2027年考研政治大纲最新解读</a></h2>
              <div class="b_caption"><p>2027考研政治考试大纲核心考点变化汇总</p></div>
            </li>
          </ol>`, { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    const result = await doSearch(uncachedConfig(), searchInput({ query: '2027年考研政治大纲', top_k: 5 }), undefined, undefined, fetcher as unknown as typeof fetch);
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      provider: 'bing_rss',
      fallback_provider: 'bing_html',
      fallback_reason: 'first_token_truncation',
    });
    expect(result.citations).toHaveLength(1);
    expect(result.citations![0]!.documentId).toBe('https://kaoyan.example.edu.cn/2027/zhengzhi-dagang');
    expect(result.inject_text).toContain('2027年考研政治大纲最新解读');
  });

  it('returns structured degraded warning instead of Microsoft/Outlook spam when all zero-key backends are blocked', async () => {
    const fetcher = vi.fn(async (inputUrl: string | URL) => {
      const url = String(inputUrl);
      if (url.includes('bing.com/search') && url.includes('format=rss')) {
        return new Response(rssXml([
          { title: 'Outlook – free personal email', link: 'https://outlook.live.com/mail', description: 'Sign in to Outlook' },
          { title: 'Microsoft Account', link: 'https://account.microsoft.com/', description: 'Manage account' },
          { title: 'MSN Homepage', link: 'https://www.msn.com/', description: 'News' },
        ]), { status: 200 });
      }
      if (url.includes('wikipedia.org')) {
        return Response.json({ query: { search: [] } });
      }
      return new Response('<html>blocked</html>', { status: 200 });
    });

    const result = await doSearch(uncachedConfig(), searchInput({ query: '2027年考研政治大纲', top_k: 10 }), undefined, undefined, fetcher as unknown as typeof fetch);
    expect(result.ok).toBe(true);
    expect(result.citations).toEqual([]);
    expect(result.result).toMatchObject({
      provider: 'bing_rss',
      degraded: true,
      degraded_reason: 'boilerplate_domain',
    });
    expect(result.usage).toMatchObject({ provider: 'bing_rss', degraded: true });
    expect(result.inject_text).toContain('【外部搜索降级提示】');
    expect(result.inject_text).not.toContain('outlook.live.com');
  });

  it('rescues non-RSS Bing response via MediaWiki fallback', async () => {
    const fetcher = vi.fn(async (inputUrl: string | URL) => {
      const url = String(inputUrl);
      if (url.includes('bing.com/search') && url.includes('format=rss')) {
        return new Response('<html><body>captcha</body></html>', { status: 200 });
      }
      if (url.includes('duckduckgo.com') || url.includes('bing.com/search')) {
        return new Response('<html><body>no results</body></html>', { status: 200 });
      }
      if (url.startsWith('https://en.wikipedia.org/w/api.php')) {
        return Response.json({
          query: {
            search: [
              { title: 'Quantum entanglement', snippet: 'Quantum entanglement is a physical phenomenon in quantum mechanics.' },
            ],
          },
        });
      }
      return new Response('', { status: 404 });
    });

    const result = await doSearch(uncachedConfig(), searchInput({ query: 'quantum entanglement phenomenon', top_k: 3 }), undefined, undefined, fetcher as unknown as typeof fetch);
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      provider: 'bing_rss',
      fallback_provider: 'wikipedia_opensearch',
      fallback_reason: 'provider_error',
    });
    expect(result.citations).toHaveLength(1);
    expect(result.citations![0]!.documentId).toBe('https://en.wikipedia.org/wiki/Quantum_entanglement');
  });
});

describe('PR #524 configurable Google CSE endpoint', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
  });

  it('resolves default vs custom endpoint and applies DB/env overrides', () => {
    const keys = defaultProviderKeys();
    expect(googleCseEndpoint(keys)).toBe(GOOGLE_CSE_DEFAULT_ENDPOINT);

    keys.google_cse_endpoint = '   ';
    expect(googleCseEndpoint(keys)).toBe(GOOGLE_CSE_DEFAULT_ENDPOINT);

    keys.google_cse_endpoint = '  https://cse.example.com/customsearch/v1  ';
    expect(googleCseEndpoint(keys)).toBe('https://cse.example.com/customsearch/v1');

    const dbConfig = defaultToolConfig();
    applyDbOverrides(dbConfig, {
      getSetting: () => null,
      getSecret: key => key === 'web_search.google_cse.endpoint' ? 'https://proxy.example.org/cse/v1' : null,
    });
    expect(googleCseEndpoint(dbConfig.keys)).toBe('https://proxy.example.org/cse/v1');

    vi.stubEnv('GOOGLE_CSE_ENDPOINT', 'https://env.example.org/customsearch/v1');
    const envConfig = toolConfigFromEnv();
    expect(googleCseEndpoint(envConfig.keys)).toBe('https://env.example.org/customsearch/v1');
  });

  it('sends Google CSE requests to the configured custom endpoint over real HTTP', async () => {
    const received: URL[] = [];
    const server = createServer((req, res) => {
      received.push(new URL(req.url ?? '/', 'http://127.0.0.1'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        items: [
          { title: 'Custom CSE Hit', link: 'https://example.org/hit-1', snippet: 'Returned from custom endpoint' },
        ],
      }));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('failed to bind test server');

    const config = uncachedConfig();
    config.keys.google_cse = 'test-api-key';
    config.keys.google_cse_cx = 'test-cx-id';
    config.keys.google_cse_endpoint = `http://127.0.0.1:${address.port}/customsearch/v1`;

    const result = await doSearch(config, searchInput({
      query: 'test search query',
      top_k: 5,
      engine: 'google_cse',
      time_range: '7d',
    }));

    expect(result.ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]!.pathname).toBe('/customsearch/v1');
    expect(received[0]!.searchParams.get('key')).toBe('test-api-key');
    expect(received[0]!.searchParams.get('cx')).toBe('test-cx-id');
    expect(received[0]!.searchParams.get('q')).toBe('test search query');
    expect(received[0]!.searchParams.get('dateRestrict')).toBe('d7');
    expect(result.result).toMatchObject({ provider: 'google_cse' });
    expect(result.citations).toHaveLength(1);
    expect(result.citations![0]!.documentId).toBe('https://example.org/hit-1');
  });

  it('rejects malformed custom endpoint URLs as config error and differentiates cache keys', async () => {
    const config = uncachedConfig();
    config.keys.google_cse = 'test-api-key';
    config.keys.google_cse_cx = 'test-cx-id';
    config.keys.google_cse_endpoint = 'not-a-valid-url';

    const invalid = await doSearch(config, searchInput({ query: 'hello', engine: 'google_cse' }));
    expect(invalid.ok).toBe(false);
    expect(String((invalid.error as { message?: string })?.message ?? '')).toContain('invalid GOOGLE_CSE_ENDPOINT');

    const c1 = defaultToolConfig();
    c1.keys.google_cse_endpoint = 'https://a.example.com/cse';
    const c2 = defaultToolConfig();
    c2.keys.google_cse_endpoint = 'https://b.example.com/cse';
    expect(buildCacheKey(searchInput({ query: 'q' }), 'google_cse', c1, null))
      .not.toBe(buildCacheKey(searchInput({ query: 'q' }), 'google_cse', c2, null));
  });
});
