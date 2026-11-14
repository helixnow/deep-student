// HTTP provider implementations for web_search.
import type { JsonValue } from '../api.ts';
import {
  ToolError, arrayOf, htmlUnescape, isClientError, isSuccess, jsonOrNull,
  normalizeCustomDateRange, normalizeUrl, objectOf, pointer, statusDisplay, str,
  stripHtml, textChars, truncate, xmlUnescape,
  type ProviderResponse, type SearchItem, type SearchInput, type ToolConfig, type Usage,
} from './web-search-core.ts';
import { parseSerdeJsonBytes } from './serde-json.ts';

// =============================
// Provider plumbing
// =============================

const DEFAULT_TIMEOUT_MS = 15000;
function timeoutOf(config: ToolConfig): number { return config.timeout_ms ?? DEFAULT_TIMEOUT_MS; }

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

async function send(
  url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
  try {
    return await fetch(url, { ...init, signal: combined, redirect: 'follow' });
  } catch (error) {
    if (signal?.aborted === true) throw abortReason(signal);
    const message = error instanceof Error ? error.message : String(error);
    if (timeout.aborted || (error instanceof Error && (error.name === 'TimeoutError' || /aborted due to timeout/i.test(message)))) {
      throw new ToolError('http', `error sending request for url (${url}): operation timed out`);
    }
    throw new ToolError('http', `error sending request for url (${url}): ${message}`);
  }
}
async function responseText(response: Response): Promise<string> {
  try { return await response.text(); }
  catch (error) {
    throw new ToolError('http', `error decoding response body: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function responseJson(response: Response): Promise<JsonValue> {
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await response.arrayBuffer()); }
  catch (error) {
    throw new ToolError('http', `error decoding response body: ${error instanceof Error ? error.message : String(error)}`);
  }
  const decoded = parseSerdeJsonBytes(bytes);
  if (decoded.ok === false) throw new ToolError('http', `error decoding response body: ${decoded.message}`);
  return decoded.value;
}
function errorMessageFrom(value: JsonValue | null, keys: string[]): string | null {
  if (value === null) return null;
  for (const key of keys) {
    const found = str(pointer(value, key));
    if (found !== null) return found;
  }
  return null;
}
function itemsFrom(value: JsonValue | null, arrayPath: string, fields: { title: string[]; url: string[]; snippet: string[] }): SearchItem[] {
  const array = value === null ? null : arrayOf(pointer(value, arrayPath));
  if (array === null) return [];
  const items: SearchItem[] = [];
  array.forEach((entry, index) => {
    const pick = (keys: string[]) => {
      for (const key of keys) { const found = str(pointer(entry, key)); if (found !== null) return found; }
      return '';
    };
    const url = pick(fields.url);
    if (url !== '') items.push({ title: pick(fields.title), url, snippet: pick(fields.snippet), rank: index + 1, score_hint: null });
  });
  return items;
}
function providerError(name: string, status: number, body: string, message: string | null = null): ToolError {
  return new ToolError('provider', `${name} http ${statusDisplay(status)}: ${message ?? body}`);
}
function jsonErrorMessage(body: string): string | null {
  const parsed = jsonOrNull(body);
  return parsed === null ? null : errorMessageFrom(parsed, ['error/message', 'error', 'message']);
}

export interface ProviderResult { response: ProviderResponse; usage: Usage }
export interface Provider {
  name(): string;
  search(
    config: ToolConfig, input: SearchInput, log: (message: string) => void, signal?: AbortSignal,
  ): Promise<ProviderResult>;
}

class BingRssProvider implements Provider {
  name(): string { return 'bing_rss'; }
  async search(
    config: ToolConfig, input: SearchInput, _log?: (message: string) => void, signal?: AbortSignal,
  ): Promise<ProviderResult> {
    let query = input.query.trim();
    const site = input.site?.trim();
    if (site) query = `site:${site} ${query}`;
    const url = new URL('https://www.bing.com/search');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'rss');
    url.searchParams.set('first', String(Math.max(input.start ?? 1, 1)));
    const started = performance.now();
    const response = await send(url.toString(), {
      method: 'GET', headers: {
        Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
        'User-Agent': 'Mozilla/5.0 (compatible; DeepStudent/1.0; +https://github.com/helixnow/deep-student)',
      },
    }, timeoutOf(config), signal);
    const latency = Math.trunc(performance.now() - started);
    const body = await responseText(response);
    if (!isSuccess(response.status)) throw providerError('bing_rss', response.status, textChars(body, 512));
    const items = parseBingRss(body);
    if (items.length === 0 && !body.includes('<rss')) throw new ToolError('provider', 'bing_rss parse error: response was not RSS');
    return {
      response: { items, raw: { format: 'rss' }, provider: 'bing_rss' },
      usage: { elapsed_ms: latency, provider_latency_ms: latency, provider: 'bing_rss' },
    };
  }
}

export function parseBingRss(xml: string): SearchItem[] {
  interface Draft { title: string; link: string; description: string }
  const items: SearchItem[] = [];
  let current: Draft | null = null;
  let currentTag = '';
  let index = 0;
  const pushText = (raw: string) => {
    if (current === null) return;
    if (currentTag === 'title') current.title += raw;
    else if (currentTag === 'link') current.link += raw;
    else if (currentTag === 'description') current.description += raw;
  };
  while (index < xml.length) {
    const open = xml.indexOf('<', index);
    const text = open < 0 ? xml.slice(index) : xml.slice(index, open);
    if (text !== '') pushText(xmlUnescape(text).trim());
    if (open < 0) break;
    if (xml.startsWith('<!--', open)) {
      const end = xml.indexOf('-->', open + 4);
      if (end < 0) throw new ToolError('provider', `bing_rss parse error at byte ${open}: unexpected EOF`);
      index = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', open)) {
      const end = xml.indexOf(']]>', open + 9);
      if (end < 0) throw new ToolError('provider', `bing_rss parse error at byte ${open}: unexpected EOF`);
      const raw = xml.slice(open + 9, end);
      pushText(raw.trim());
      index = end + 3;
      continue;
    }
    if (xml.startsWith('<?', open) || xml.startsWith('<!', open)) {
      const end = xml.indexOf('>', open + 2);
      if (end < 0) throw new ToolError('provider', `bing_rss parse error at byte ${open}: unexpected EOF`);
      index = end + 1;
      continue;
    }
    const close = xml.indexOf('>', open + 1);
    if (close < 0) throw new ToolError('provider', `bing_rss parse error at byte ${open}: unexpected EOF`);
    const rawTag = xml.slice(open + 1, close);
    index = close + 1;
    const closing = rawTag.startsWith('/');
    const selfClosing = rawTag.endsWith('/');
    const tag = (closing ? rawTag.slice(1) : rawTag).replace(/\/$/, '').split(/\s/, 1)[0]!.toLowerCase();
    if (!closing && !selfClosing) {
      if (tag === 'item') current = { title: '', link: '', description: '' };
      else if ((tag === 'title' || tag === 'link' || tag === 'description') && current !== null) currentTag = tag;
      continue;
    }
    if (selfClosing) continue;
    if (tag === 'item' && closing) {
      if (current !== null && current.link !== '') {
        items.push({
          title: htmlUnescape(stripHtml(current.title)),
          url: htmlUnescape(current.link),
          snippet: htmlUnescape(stripHtml(current.description)),
          rank: items.length + 1, score_hint: null,
        });
      }
      current = null;
    }
    currentTag = '';
  }
  return items;
}

class GoogleCseProvider implements Provider {
  name(): string { return 'google_cse'; }
  async search(
    config: ToolConfig, input: SearchInput, log: (message: string) => void, signal?: AbortSignal,
  ): Promise<ProviderResult> {
    if (input.top_k === 0) log('[web_search][google_cse] top_k is 0, defaulting to 1');
    const requestedTopK = Math.max(input.top_k, 1);
    if (requestedTopK > 10) log(`[web_search][google_cse] top_k ${requestedTopK} exceeds API limit, capping to 10`);
    const topK = Math.min(requestedTopK, 10);
    const key = config.keys.google_cse;
    if (key === null) throw new ToolError('config', 'missing GOOGLE_API_KEY');
    const cx = config.keys.google_cse_cx;
    if (cx === null) throw new ToolError('config', 'missing GOOGLE_CSE_CX');
    let query = input.query;
    const site = input.site?.trim();
    if (site) query = `site:${site} ${query}`;
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', key);
    url.searchParams.set('cx', cx);
    url.searchParams.set('q', query);
    url.searchParams.set('num', String(topK));
    url.searchParams.set('start', String(Math.max(input.start ?? 1, 1)));
    const dateRestrict = input.time_range === '1d' || input.time_range === '24h' ? 'd1'
      : input.time_range === '7d' ? 'd7' : input.time_range === '30d' ? 'd30'
        : input.time_range === '365d' || input.time_range === '1y' || input.time_range === '12m' ? 'y1' : null;
    if (dateRestrict !== null) url.searchParams.set('dateRestrict', dateRestrict);
    const started = performance.now();
    const response = await send(url.toString(), { method: 'GET', headers: { 'User-Agent': 'web_search_tool/0.1' } }, timeoutOf(config), signal);
    const latency = Math.trunc(performance.now() - started);
    if (!isSuccess(response.status)) {
      const body = await responseText(response);
      const parsed = jsonOrNull(body);
      if (parsed !== null) {
        const message = errorMessageFrom(parsed, ['error/message', 'message']);
        const code = pointer(parsed, 'error/code');
        throw providerError('google_cse', response.status, body, `${typeof code === 'number' ? code : ''} ${message ?? body}`);
      }
      throw providerError('google_cse', response.status, textChars(body, 512));
    }
    const raw = await responseJson(response);
    return {
      response: { items: itemsFrom(raw, 'items', { title: ['title'], url: ['link'], snippet: ['snippet'] }), raw, provider: 'google_cse' },
      usage: { elapsed_ms: latency, provider_latency_ms: latency, provider: 'google_cse' },
    };
  }
}

class SerpApiProvider implements Provider {
  name(): string { return 'serpapi'; }
  async search(
    config: ToolConfig, input: SearchInput, log: (message: string) => void, signal?: AbortSignal,
  ): Promise<ProviderResult> {
    const key = config.keys.serpapi;
    if (key === null) throw new ToolError('config', 'missing SERPAPI_KEY');
    let query = input.query;
    const site = input.site?.trim();
    if (site) query = `site:${site} ${query}`;
    const requestedTopK = Math.max(input.top_k, 1);
    if (requestedTopK > 100) log(`[web_search][serpapi] top_k ${requestedTopK} exceeds API limit, capping to 100`);
    const topK = Math.min(requestedTopK, 100);
    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('api_key', key);
    url.searchParams.set('engine', 'google');
    url.searchParams.set('q', query);
    url.searchParams.set('num', String(topK));
    url.searchParams.set('start', String(Math.max(input.start ?? 1, 1)));
    if (input.time_range !== null) {
      const range = input.time_range.trim().toLowerCase();
      const digits = (value: string) => value !== '' && /^[0-9]+$/.test(value);
      let asQdr: string | null = range === '1d' || range === '24h' ? 'd'
        : range === '1y' || range === '12m' ? 'y' : ['d', 'w', 'm', 'y'].includes(range) ? range : null;
      if (asQdr === null) {
        if (range.startsWith('d') && digits(range.slice(1))) asQdr = `d${range.slice(1)}`;
        else if (range.endsWith('d') && digits(range.slice(0, -1))) asQdr = `d${range.slice(0, -1)}`;
      }
      if (asQdr !== null) url.searchParams.set('as_qdr', asQdr);
    }
    const started = performance.now();
    const response = await send(url.toString(), { method: 'GET', headers: { 'User-Agent': 'web_search_tool/0.1' } }, timeoutOf(config), signal);
    const latency = Math.trunc(performance.now() - started);
    if (!isSuccess(response.status)) {
      const body = await responseText(response);
      const parsed = jsonOrNull(body);
      if (parsed !== null) throw providerError('serpapi', response.status, body, errorMessageFrom(parsed, ['error', 'message']) ?? body);
      throw providerError('serpapi', response.status, textChars(body, 512));
    }
    const raw = await responseJson(response);
    return {
      response: { items: itemsFrom(raw, 'organic_results', { title: ['title'], url: ['link'], snippet: ['snippet'] }), raw, provider: 'serpapi' },
      usage: { elapsed_ms: latency, provider_latency_ms: latency, provider: 'serpapi' },
    };
  }
}

class TavilyProvider implements Provider {
  name(): string { return 'tavily'; }
  async search(
    config: ToolConfig, input: SearchInput, log: (message: string) => void, signal?: AbortSignal,
  ): Promise<ProviderResult> {
    const key = config.keys.tavily;
    if (key === null) throw new ToolError('config', 'missing TAVILY_API_KEY');
    let query = input.query;
    const site = input.site?.trim();
    if (site) query = `site:${site} ${query}`;
    const requestedTopK = Math.max(input.top_k, 1);
    if (requestedTopK > 20) log(`[web_search][tavily] top_k ${requestedTopK} exceeds API limit, capping to 20`);
    const topK = Math.min(requestedTopK, 20);
    const depthInput = config.tavily_search_depth;
    const depthTrimmed = depthInput?.trim() ?? '';
    if (depthInput !== null && depthTrimmed !== '' && depthTrimmed.toLowerCase() !== 'basic'
      && depthTrimmed.toLowerCase() !== 'advanced') {
      log(`[web_search][tavily] unsupported search_depth '${depthTrimmed}', defaulting to basic`);
    }
    const depth = depthTrimmed.toLowerCase() === 'advanced' ? 'advanced' : 'basic';
    const body: Record<string, JsonValue> = { query, search_depth: depth, max_results: topK };
    const ranges: Record<string, string> = { '1d': 'day', '24h': 'day', '7d': 'week', '30d': 'month', '365d': 'year', '1y': 'year', '12m': 'year', day: 'day', week: 'week', month: 'month', year: 'year' };
    const range = input.time_range?.trim().toLowerCase();
    if (range !== undefined && ranges[range] !== undefined) body.time_range = ranges[range]!;
    const started = performance.now();
    const response = await send('https://api.tavily.com/search', {
      method: 'POST', headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'User-Agent': 'web_search_tool/0.1',
      },
      body: JSON.stringify(body),
    }, timeoutOf(config), signal);
    const latency = Math.trunc(performance.now() - started);
    if (!isSuccess(response.status)) {
      const text = await responseText(response);
      const parsed = jsonOrNull(text);
      if (parsed !== null) throw providerError('tavily', response.status, text, errorMessageFrom(parsed, ['error', 'message']) ?? text);
      throw providerError('tavily', response.status, textChars(text, 512));
    }
    const raw = await responseJson(response);
    return {
      response: { items: itemsFrom(raw, 'results', { title: ['title'], url: ['url'], snippet: ['content'] }), raw, provider: 'tavily' },
      usage: { elapsed_ms: latency, provider_latency_ms: latency, provider: 'tavily' },
    };
  }
}

class BraveProvider implements Provider {
  name(): string { return 'brave'; }
  async search(
    config: ToolConfig, input: SearchInput, log: (message: string) => void, signal?: AbortSignal,
  ): Promise<ProviderResult> {
    const key = config.keys.brave;
    if (key === null) throw new ToolError('config', 'missing BRAVE_API_KEY');
    let query = input.query;
    const site = input.site?.trim();
    if (site) query = `site:${site} ${query}`;
    const requestedTopK = Math.max(input.top_k, 1);
    if (requestedTopK > 20) log(`[web_search][brave] top_k ${requestedTopK} exceeds API limit, capping to 20`);
    const topK = Math.min(requestedTopK, 20);
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(topK));
    if (input.time_range !== null) {
      const range = input.time_range.trim();
      const lower = range.toLowerCase();
      const mapped: Record<string, string> = {
        '1d': 'pd', '24h': 'pd', day: 'pd', '7d': 'pw', week: 'pw', '30d': 'pm', month: 'pm',
        '365d': 'py', '1y': 'py', '12m': 'py', year: 'py', pd: 'pd', pw: 'pw', pm: 'pm', py: 'py',
      };
      const freshness = mapped[lower] ?? normalizeCustomDateRange(range);
      if (freshness !== null) url.searchParams.set('freshness', freshness);
    }
    if (input.start !== null) url.searchParams.set('offset', String(Math.max(input.start - 1, 0)));
    const started = performance.now();
    const response = await send(url.toString(), {
      method: 'GET', headers: {
        Accept: 'application/json', 'X-Subscription-Token': key, 'User-Agent': 'web_search_tool/0.1',
      },
    }, timeoutOf(config), signal);
    const latency = Math.trunc(performance.now() - started);
    if (!isSuccess(response.status)) {
      const body = await responseText(response);
      const parsed = jsonOrNull(body);
      if (parsed !== null) throw providerError('brave', response.status, body, errorMessageFrom(parsed, ['error', 'message']) ?? body);
      throw providerError('brave', response.status, textChars(body, 512));
    }
    const raw = await responseJson(response);
    const more = pointer(raw, 'query/more_results_available');
    if (typeof more === 'boolean') {
      const obj = objectOf(raw);
      if (obj !== null) obj.more_results_available = more;
    }
    return {
      response: { items: itemsFrom(raw, 'web/results', { title: ['title'], url: ['url'], snippet: ['description'] }), raw, provider: 'brave' },
      usage: { elapsed_ms: latency, provider_latency_ms: latency, provider: 'brave' },
    };
  }
}

class SearxngProvider implements Provider {
  name(): string { return 'searxng'; }
  async search(
    config: ToolConfig, input: SearchInput, _log?: (message: string) => void, signal?: AbortSignal,
  ): Promise<ProviderResult> {
    const endpoint = config.keys.searxng_endpoint;
    if (endpoint === null) throw new ToolError('config', 'missing SEARXNG_ENDPOINT');
    let query = input.query;
    const site = input.site?.trim();
    if (site) query = `site:${site} ${query}`;
    const url = new URL(`${endpoint.replace(/\/+$/, '')}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('categories', 'general');
    url.searchParams.set('language', 'all');
    url.searchParams.set('safesearch', '0');
    const headers: Record<string, string> = { 'User-Agent': 'web_search_tool/0.1' };
    const apiKey = config.keys.searxng;
    if (apiKey !== null) {
      const separator = apiKey.indexOf(':');
      if (separator >= 0) {
        headers.Authorization = `Basic ${Buffer.from(`${apiKey.slice(0, separator)}:${apiKey.slice(separator + 1)}`).toString('base64')}`;
      } else {
        url.searchParams.set('apikey', apiKey);
        headers.Authorization = `Bearer ${apiKey}`;
        headers['X-API-Key'] = apiKey;
      }
    }
    const ranges: Record<string, string> = { '1d': 'day', '24h': 'day', day: 'day', '7d': 'week', week: 'week', '30d': 'month', month: 'month', '365d': 'year', '1y': 'year', '12m': 'year', year: 'year' };
    const range = input.time_range?.trim().toLowerCase();
    if (range !== undefined && ranges[range] !== undefined) url.searchParams.set('time_range', ranges[range]!);
    const started = performance.now();
    const response = await send(url.toString(), { method: 'GET', headers }, timeoutOf(config), signal);
    const latency = Math.trunc(performance.now() - started);
    if (!isSuccess(response.status)) {
      const body = await responseText(response);
      const parsed = jsonOrNull(body);
      if (parsed !== null) throw providerError('searxng', response.status, body, errorMessageFrom(parsed, ['error', 'message']) ?? body);
      throw providerError('searxng', response.status, textChars(body, 512));
    }
    const raw = await responseJson(response);
    return {
      response: { items: itemsFrom(raw, 'results', { title: ['title'], url: ['url'], snippet: ['content'] }), raw, provider: 'searxng' },
      usage: { elapsed_ms: latency, provider_latency_ms: latency, provider: 'searxng' },
    };
  }
}

class ZhipuProvider implements Provider {
  name(): string { return 'zhipu'; }
  async search(
    config: ToolConfig, input: SearchInput, log: (message: string) => void, signal?: AbortSignal,
  ): Promise<ProviderResult> {
    const requestedTopK = Math.max(input.top_k, 1);
    if (requestedTopK > 50) log(`[web_search][zhipu] top_k ${requestedTopK} exceeds API limit, capping to 50`);
    const topK = Math.min(requestedTopK, 50);
    const apiKey = config.keys.zhipu;
    if (apiKey === null) throw new ToolError('config', 'missing ZHIPU_API_KEY (智谱API密钥未配置)');
    const buildBody = (engine: string): Record<string, JsonValue> => {
      const body: Record<string, JsonValue> = { search_engine: engine, search_query: input.query, count: topK, content_size: 'high' };
      if (input.time_range !== null) {
        const range = input.time_range.trim().toLowerCase();
        body.search_recency_filter = range === '1d' || range === '24h' ? 'oneDay'
          : range === '7d' ? 'oneWeek' : range === '30d' ? 'oneMonth'
            : range === '365d' || range === '1y' || range === '12m' ? 'oneYear' : 'noLimit';
      }
      const site = input.site?.trim();
      if (site) body.search_domain_filter = site;
      return body;
    };
    const errorFrom = (status: number, text: string): ToolError => {
      const parsed = jsonOrNull(text);
      if (parsed !== null) return providerError('zhipu', status, text, errorMessageFrom(parsed, ['error/message', 'message']) ?? '');
      return providerError('zhipu', status, textChars(text, 512));
    };
    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': 'deep-student/1.0' };
    const started = performance.now();
    let response = await send('https://open.bigmodel.cn/api/paas/v4/web_search', {
      method: 'POST', headers, body: JSON.stringify(buildBody('search-prime')),
    }, timeoutOf(config), signal);
    let latency = Math.trunc(performance.now() - started);
    let raw: JsonValue;
    if (!isSuccess(response.status)) {
      const body = await responseText(response);
      const lower = body.toLowerCase();
      if (isClientError(response.status) && (lower.includes('search_engine') || lower.includes('search-prime'))) {
        log('[web_search][zhipu] search-prime rejected, retrying with search_pro');
        response = await send('https://open.bigmodel.cn/api/paas/v4/web_search', {
          method: 'POST', headers, body: JSON.stringify(buildBody('search_pro')),
        }, timeoutOf(config), signal);
        if (!isSuccess(response.status)) throw errorFrom(response.status, await responseText(response));
        latency = Math.trunc(performance.now() - started);
        raw = await responseJson(response);
      } else {
        throw errorFrom(response.status, body);
      }
    } else {
      raw = await responseJson(response);
    }
    return {
      response: { items: itemsFrom(raw, 'search_result', { title: ['title'], url: ['link'], snippet: ['content'] }), raw, provider: 'zhipu' },
      usage: { elapsed_ms: latency, provider_latency_ms: latency, provider: 'zhipu' },
    };
  }
}

class BochaProvider implements Provider {
  name(): string { return 'bocha'; }
  async search(
    config: ToolConfig, input: SearchInput, log: (message: string) => void, signal?: AbortSignal,
  ): Promise<ProviderResult> {
    const requestedTopK = Math.max(input.top_k, 1);
    if (requestedTopK > 50) log(`[web_search][bocha] top_k ${requestedTopK} exceeds API limit, capping to 50`);
    const topK = Math.min(requestedTopK, 50);
    const apiKey = config.keys.bocha;
    if (apiKey === null) throw new ToolError('config', 'missing BOCHA_API_KEY (博查API密钥未配置)');
    const body: Record<string, JsonValue> = { query: input.query, count: topK, summary: false };
    if (input.time_range !== null) {
      const range = input.time_range;
      body.freshness = range === '1d' || range === '24h' ? 'oneDay'
        : range === '7d' ? 'oneWeek' : range === '30d' ? 'oneMonth'
          : range === '365d' || range === '1y' || range === '12m' ? 'oneYear' : 'noLimit';
    }
    const started = performance.now();
    const response = await send('https://api.bochaai.com/v1/web-search', {
      method: 'POST', headers: {
        Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': 'deep-student/1.0',
      },
      body: JSON.stringify(body),
    }, timeoutOf(config), signal);
    const latency = Math.trunc(performance.now() - started);
    if (!isSuccess(response.status)) {
      const text = await responseText(response);
      const parsed = jsonOrNull(text);
      if (parsed !== null) throw providerError('bocha', response.status, text, errorMessageFrom(parsed, ['error/message', 'message']) ?? '');
      throw providerError('bocha', response.status, textChars(text, 512));
    }
    const raw = await responseJson(response);
    const array = arrayOf(pointer(raw, 'data/webPages/value')) ?? arrayOf(pointer(raw, 'webPages/value'));
    const items: SearchItem[] = [];
    array?.forEach((entry, index) => {
      const firstString = (...keys: string[]) => {
        for (const key of keys) { const value = str(pointer(entry, key)); if (value !== null) return value; }
        return '';
      };
      const url = firstString('url', 'link');
      if (url !== '') items.push({
        title: firstString('name', 'title'), url, snippet: firstString('snippet', 'summary'),
        rank: index + 1, score_hint: null,
      });
    });
    return {
      response: { items, raw, provider: 'bocha' },
      usage: { elapsed_ms: latency, provider_latency_ms: latency, provider: 'bocha' },
    };
  }
}

export function deepseekSiteClause(site: string): string {
  return site.split(',').map(part => part.trim()).filter(part => part !== '').map(part => `site:${part}`).join(' OR ');
}
function dateDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}
export function deepseekTimeClause(range: string | null): string[] {
  if (range === null) return [];
  const trimmed = range.trim();
  if (trimmed === '') return [];
  switch (trimmed.toLowerCase()) {
    case '1d': case '24h': return [`after:${dateDaysAgo(1)}`];
    case '7d': return [`after:${dateDaysAgo(7)}`];
    case '30d': return [`after:${dateDaysAgo(30)}`];
    case '365d': case '1y': case '12m': return [`after:${dateDaysAgo(365)}`];
    default: {
      const custom = normalizeCustomDateRange(trimmed);
      if (custom === null) return [];
      const separator = custom.indexOf('to');
      return [`after:${custom.slice(0, separator)}`, `before:${custom.slice(separator + 2)}`];
    }
  }
}
export function buildDeepseekQuery(input: SearchInput): string {
  const parts = [input.query.trim()];
  if (input.site !== null) {
    const clause = deepseekSiteClause(input.site);
    if (clause !== '') parts.push(clause);
  }
  parts.push(...deepseekTimeClause(input.time_range));
  return parts.join(' ').trim();
}
export function mapDeepseekError(status: number, body: string): ToolError {
  const parsed = jsonOrNull(body);
  const message = parsed === null ? textChars(body, 300) : (str(pointer(parsed, 'error/message')) ?? textChars(body, 300));
  switch (status) {
    case 401: return new ToolError('config', 'DeepSeek API Key 无效或已失效（请检查 web_search.api_key.deepseek）');
    case 402: return new ToolError('provider', `deepseek http 402: 账户余额不足，搜索按成功请求计费: ${message}`);
    case 403: return new ToolError('provider', `deepseek http 403: 请求被安全策略拒绝: ${message}`);
    case 429: return new ToolError('provider', `deepseek http 429: 搜索限速（账号级 5 QPS）: ${message}`);
    default: return new ToolError('provider', `deepseek http ${statusDisplay(status)}: ${message}`);
  }
}
export function parseDeepseekResults(raw: JsonValue): SearchItem[] {
  const results = arrayOf(pointer(raw, 'results'));
  if (results === null) return [];
  const items: SearchItem[] = [];
  results.forEach((entry, index) => {
    const urlValue = str(pointer(entry, 'url'));
    if (urlValue === null) return;
    const url = urlValue.trim();
    if (url === '') return;
    const snippetValue = str(pointer(entry, 'snippet'));
    const snippet = snippetValue !== null && snippetValue.trim() !== '' ? snippetValue : (str(pointer(entry, 'summary')) ?? '');
    const score = pointer(entry, 'rerank_score');
    const scoreHint = typeof score === 'number' ? Math.fround(Math.min(Math.max(score / 3, 0), 1)) : null;
    items.push({ title: str(pointer(entry, 'title')) ?? '', url, snippet, rank: index + 1, score_hint: scoreHint });
  });
  return items;
}

class DeepseekProvider implements Provider {
  name(): string { return 'deepseek'; }
  async search(
    config: ToolConfig, input: SearchInput, log: (message: string) => void, signal?: AbortSignal,
  ): Promise<ProviderResult> {
    const requestedTopK = Math.max(input.top_k, 1);
    if (requestedTopK > 50) log(`[web_search][deepseek] top_k ${requestedTopK} exceeds API limit, capping to 50`);
    const topK = Math.min(requestedTopK, 50);
    const apiKey = config.keys.deepseek;
    if (apiKey === null) throw new ToolError('config', 'missing DEEPSEEK_SEARCH_API_KEY (DeepSeek 搜索密钥未配置)');
    let query = buildDeepseekQuery(input);
    if ([...query].length > 128) query = [...query].slice(0, 128).join('');
    const body: Record<string, JsonValue> = { query, count: topK };
    if (config.deepseek_need_content === true) body.need_content = true;
    const started = performance.now();
    const response = await send('https://api.deepseek.com/v1/tools/search', {
      method: 'POST', headers: {
        Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': 'deep-student/1.0',
      },
      body: JSON.stringify(body),
    }, timeoutOf(config), signal);
    if (!isSuccess(response.status)) throw mapDeepseekError(response.status, await responseText(response));
    const latency = Math.trunc(performance.now() - started);
    const raw = await responseJson(response);
    return {
      response: { items: parseDeepseekResults(raw), raw, provider: 'deepseek' },
      usage: { elapsed_ms: latency, provider_latency_ms: latency, provider: 'deepseek' },
    };
  }
}

export function createProvider(engine: string): Provider {
  switch (engine) {
    case 'bing_rss': return new BingRssProvider();
    case 'google_cse': return new GoogleCseProvider();
    case 'serpapi': return new SerpApiProvider();
    case 'tavily': return new TavilyProvider();
    case 'brave': return new BraveProvider();
    case 'searxng': return new SearxngProvider();
    case 'zhipu': return new ZhipuProvider();
    case 'bocha': return new BochaProvider();
    case 'deepseek': return new DeepseekProvider();
    default: throw new ToolError('config', `unknown engine: ${engine}`);
  }
}

export function isRetryable(error: ToolError): boolean {
  if (error.kind === 'config') return false;
  if (error.kind === 'http') {
    if (error.status === null) return true;
    return error.status === 429 || (error.status >= 500 && error.status <= 599);
  }
  const lower = error.message.toLowerCase();
  if (lower.includes('api key') || lower.includes('unauthorized') || lower.includes('invalid key')
    || lower.includes('http 400') || lower.includes('http 401') || lower.includes('http 402')
    || lower.includes('http 403') || lower.includes('http 404')) return false;
  return true;
}

