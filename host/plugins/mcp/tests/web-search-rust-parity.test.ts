import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api.ts';
import {
  buildInjectText, defaultToolConfig, doSearch, hostAllowed, hostAsFileName, isUrlWhitelisted, normalizeScore,
  resetProviderRuntime, type SearchInput, type ToolConfig,
} from '../src/web-search.ts';

const input = (query: string, extra: Partial<SearchInput> = {}): SearchInput => ({
  query, top_k: 3, engine: null, site: null, time_range: null, start: null, force_engine: null, ...extra,
});

describe('url::Url::host_str() has no port (web_search.rs:1269-1278, 1379-1384, 1464-1486)', () => {
  it('host_as_file_name returns the bare host', () => {
    expect(hostAsFileName('https://b.example:8443/a')).toBe('b.example');
    expect(hostAsFileName('http://[::1]:8080/x')).toBe('[::1]');
    expect(hostAsFileName('mailto:a@b.example')).toBe('unknown');
  });

  it('the CN whitelist matches a host that carries a port', () => {
    const cn = { enabled: true, use_default_list: true, custom_sites: null };
    expect(isUrlWhitelisted(cn, 'https://github.com:8443/x')).toBe(true);
    expect(isUrlWhitelisted(cn, 'https://evil.example:443/github.com')).toBe(false);
  });

  it('site whitelist and blacklist match a host that carries a port', () => {
    const white: ToolConfig = { ...defaultToolConfig(), site_whitelist: ['example.com'] };
    expect(hostAllowed(white, 'https://example.com:8080/a')).toBe(true);
    const black: ToolConfig = { ...defaultToolConfig(), site_blacklist: ['example.com'] };
    expect(hostAllowed(black, 'https://example.com:8080/a')).toBe(false);
    const cn: ToolConfig = { ...defaultToolConfig(), cn_whitelist: { enabled: true, use_default_list: true, custom_sites: null } };
    expect(hostAllowed(cn, 'https://gitee.com:8443/a')).toBe(true);
  });
});

describe('RagSourceInfo.score is f32: serde_json (arbitrary_precision) prints the shortest f32 decimal', () => {
  beforeEach(() => { resetProviderRuntime(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('normalize_score computes in f32 (web_search.rs:1386-1393)', () => {
    expect(normalizeScore(2, 3)).toBe(Math.fround(2 / 3));
    expect(normalizeScore(3, 3)).toBe(Math.fround(1 / 3));
    expect(normalizeScore(1, 3)).toBe(1);
    expect(normalizeScore(4, 3)).toBe(0);
  });

  it('rank-derived citation scores serialize like Rust for top_k = 3', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ results: [
      { url: 'https://a.example/1', title: 'A', content: 'a' },
      { url: 'https://b.example/2', title: 'B', content: 'b' },
      { url: 'https://c.example/3', title: 'C', content: 'c' },
    ] }));
    const config = defaultToolConfig();
    config.keys.searxng_endpoint = 'http://searxng.test';
    const result = await doSearch(config, input('rank scores', { engine: 'searxng' }));
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.citations!.map(citation => citation.score))).toBe('[1,0.6666667,0.33333334]');
  });

  it('DeepSeek rerank_score / 3 is narrowed to f32 (web_search.rs:3029-3032)', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ results: [
      { url: 'https://a.example/1', title: 'A', snippet: 'a', rerank_score: 2.1 },
      { url: 'https://b.example/2', title: 'B', snippet: 'b', rerank_score: 0.3 },
    ] }));
    const config = defaultToolConfig();
    config.keys.deepseek = 'sk-test';
    const result = await doSearch(config, input('deepseek scores', { engine: 'deepseek' }));
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.citations!.map(citation => citation.score))).toBe('[0.7,0.1]');
  });

  it('an untitled result is named after its bare host', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ results: [
      { url: 'https://ported.example:8443/x', title: '', content: 'p' },
      { url: 'https://nel.example/y', title: '\u0085', content: 'n' },
    ] }));
    const config = defaultToolConfig();
    config.keys.searxng_endpoint = 'http://searxng.test';
    const result = await doSearch(config, input('file names', { engine: 'searxng' }));
    // Rust `str::trim` strips U+0085 (White_Space); JS `String#trim` does not.
    expect(result.citations!.map(citation => citation.fileName)).toEqual(['ported.example', 'nel.example']);
  });
});

describe('build_inject_text trims with Rust str::trim (web_search.rs:1653, 1615)', () => {
  it('keeps U+FEFF, which Rust does not treat as whitespace, and strips U+0085', () => {
    const text = buildInjectText(defaultToolConfig(), {
      items: [{ title: '\uFEFFTitle\u0085', url: 'https://a.example/', snippet: 's', rank: 1, score_hint: null }],
      raw: {}, provider: 'searxng',
    });
    expect(text).toBe('【外部搜索结果】\n[1] \uFEFFTitle — s\nURL: https://a.example/\n\n');
  });
});

describe('mcp/api.ts publishes the web_search helpers browser duplicates', () => {
  it('exports normalizeUrl, hostAsFileName, normalizeScore, buildInjectText and isUrlWhitelisted', () => {
    expect(api.normalizeUrl('https://a.example/?x=1&utm_source=t')).toBe('https://a.example/?x=1');
    expect(api.hostAsFileName('https://a.example:81/')).toBe('a.example');
    expect(api.normalizeScore(2, 3)).toBe(Math.fround(2 / 3));
    expect(api.isUrlWhitelisted({ enabled: true, use_default_list: false, custom_sites: ['a.example'] }, 'https://a.example:81/')).toBe(true);
    expect(api.buildInjectText(defaultToolConfig(), { items: [], raw: {}, provider: 'aggregated' })).toBe('');
  });
});
