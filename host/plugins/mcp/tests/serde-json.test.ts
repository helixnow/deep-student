import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultToolConfig, doSearch, parseSerdeJson, parseSerdeJsonBytes } from '../api.ts';
import type { SearchInput } from '../src/web-search.ts';

const nested = (depth: number): string => `${'['.repeat(depth)}${']'.repeat(depth)}`;

describe('serde_json::from_str::<Value> rules missing from JSON.parse (X6-UD-0017/0018/0049/0050)', () => {
  it('rejects lone surrogate escapes and accepts a valid pair', () => {
    expect(parseSerdeJson('"\\ud83d\\ude00"')).toEqual({ ok: true, value: '\u{1f600}' });
    const leading = parseSerdeJson('"\\ud800"');
    expect(leading.ok).toBe(false);
    if (!leading.ok) expect(leading.message).toMatch(/^unexpected end of hex escape at line 1 column \d+$/u);
    const trailing = parseSerdeJson('"\\udc00"');
    expect(trailing.ok).toBe(false);
    if (!trailing.ok) expect(trailing.message).toMatch(/^lone leading surrogate in hex escape at line 1 column \d+$/u);
    const badPair = parseSerdeJson('"\\ud800\\u0041"');
    expect(badPair.ok).toBe(false);
    if (!badPair.ok) expect(badPair.message).toMatch(/^lone leading surrogate in hex escape /u);
    expect(parseSerdeJson('"\\\\ud800"')).toEqual({ ok: true, value: '\\ud800' });
  });

  it('allows 127 nested containers and rejects the 128th (remaining_depth 128)', () => {
    expect(parseSerdeJson(nested(127)).ok).toBe(true);
    const deep = parseSerdeJson(nested(128));
    expect(deep.ok).toBe(false);
    if (!deep.ok) expect(deep.message).toMatch(/^recursion limit exceeded /u);
    expect(parseSerdeJson(`{"a":"${'['.repeat(200)}"}`).ok).toBe(true);
  });

  it('from_slice rejects invalid UTF-8 and does not skip a BOM', () => {
    expect(parseSerdeJsonBytes(new Uint8Array([0x22, 0xff, 0x22]))).toEqual({ ok: false, message: 'invalid unicode code point' });
    expect(parseSerdeJsonBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d])).ok).toBe(false);
    expect(parseSerdeJsonBytes(new TextEncoder().encode('{"a":1}'))).toEqual({ ok: true, value: { a: 1 } });
  });
});

describe('web_search production entry uses serde_json input rules', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('web_search provider body with invalid UTF-8 fails like reqwest Response::json', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([0x7b, 0x22, 0x72, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const config = defaultToolConfig();
    config.keys.tavily = 'tvly-test';
    config.retry = { max_attempts: 1, initial_delay_ms: 0 };
    const input: SearchInput = {
      query: `serde-${Math.random()}`, top_k: 1, engine: null, site: null, time_range: null, start: null, force_engine: 'tavily',
    };
    const result = await doSearch(config, input);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.error)).toContain('error decoding response body: invalid unicode code point');
    expect(fetchMock).toHaveBeenCalled();
  });
});
