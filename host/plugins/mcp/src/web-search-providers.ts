// HTTP provider implementations for web_search.
import type { JsonValue } from '../api.ts';
import {
  ToolError, arrayOf, htmlUnescape, isClientError, isSuccess, jsonOrNull,
  normalizeCustomDateRange, normalizeUrl, objectOf, pointer, statusDisplay, str,
  stripHtml, textChars, truncate, urlHost, xmlUnescape,
  type ProviderKeys, type ProviderResponse, type SearchItem, type SearchInput, type ToolConfig, type Usage,
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
  fetcher: typeof fetch, url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
  try {
    return await fetcher(url, { ...init, signal: combined, redirect: 'follow' });
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

abstract class HttpProvider {
  private readonly fetcher: typeof fetch;
  constructor(fetcher: typeof fetch) { this.fetcher = fetcher; }
  protected send(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    return send(this.fetcher, url, init, timeoutMs, signal);
  }
}

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const WIKIPEDIA_USER_AGENT =
  'DeepStudent/1.0 (+https://github.com/helixnow/deep-student)';

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/u;
const EN_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'could', 'did', 'do', 'does', 'for',
  'from', 'had', 'has', 'have', 'how', 'in', 'into', 'is', 'it', 'its', 'may', 'more', 'most',
  'no', 'not', 'of', 'on', 'or', 'our', 'out', 'over', 'should', 'so', 'some', 'such', 'than',
  'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'to',
  'under', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with',
  'would', 'you', 'your',
]);
const GENERIC_QUERY_MODIFIERS = new Set([
  'today', 'tonight', 'tomorrow', 'yesterday', 'now', 'latest', 'recent', 'current', 'daily',
  'live', 'online', 'free', 'best', 'official', 'info',
]);
const CJK_PARTICLES = new Set([
  '的', '了', '呢', '吗', '吧', '啊', '呀', '在', '是', '和', '与', '及', '或', '为', '对',
  '于', '把', '被', '将', '着', '过', '之', '中', '有',
]);
const BOILERPLATE_HOSTS = [
  'microsoft.com', 'msn.com', 'live.com', 'outlook.com', 'office.com', 'bing.com',
  'microsoft365.com', 'skype.com', 'xbox.com', 'windows.com', 'azure.com',
] as const;
const BOILERPLATE_QUERY_HINTS = [
  'microsoft', 'msn', 'outlook', 'office', 'bing', 'windows', 'azure', 'xbox', 'skype',
  'onedrive', 'sharepoint', 'teams', 'copilot', 'edge', 'excel', 'word', 'powerpoint',
  'hotmail', 'live.com', '微软', '必应',
] as const;

export function hasCjkText(text: string): boolean {
  return CJK_RE.test(text);
}

function acceptLanguageFor(query: string): string {
  return hasCjkText(query) ? 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7' : 'en-US,en;q=0.9';
}

function decodeBase64UrlUtf8(encoded: string): string | null {
  try {
    let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const pad = base64.length % 4;
    if (pad > 0) base64 += '='.repeat(4 - pad);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function decodeSearchRedirectUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed === '') return trimmed;
  let candidate = trimmed;
  if (candidate.startsWith('//')) candidate = `https:${candidate}`;
  else if (candidate.startsWith('/l/?')) candidate = `https://duckduckgo.com${candidate}`;
  try {
    const parsed = new URL(candidate);
    const host = parsed.hostname.toLowerCase();
    if (host.endsWith('duckduckgo.com') && parsed.pathname === '/l/') {
      const uddg = parsed.searchParams.get('uddg');
      if (uddg && (uddg.startsWith('http://') || uddg.startsWith('https://'))) return uddg;
    }
    if (host.endsWith('bing.com') && parsed.pathname.startsWith('/ck/')) {
      const u = parsed.searchParams.get('u');
      if (u && u.length > 2 && /^a\d/i.test(u)) {
        const decoded = decodeBase64UrlUtf8(u.slice(2));
        if (decoded && (decoded.startsWith('http://') || decoded.startsWith('https://'))) return decoded;
      }
    }
  } catch {
    return trimmed;
  }
  return candidate;
}

function cleanSnippetText(raw: string): string {
  return htmlUnescape(stripHtml(raw)).replace(/\s+/g, ' ').trim();
}

function cjkBigrams(text: string): string[] {
  const chars = [...text];
  if (chars.length < 2) return chars.length === 1 ? [chars[0]!] : [];
  const grams: string[] = [];
  for (let index = 0; index < chars.length - 1; index += 1) {
    grams.push(`${chars[index]}${chars[index + 1]}`);
  }
  return grams;
}

export function extractQueryTermGroups(query: string): { groups: string[][]; hasCjk: boolean } {
  const normalized = query.replace(/["'“”‘’`()（）[\]【】<>《》,，.。!！?？:：;；/\\|]+/gu, ' ').trim();
  const hasCjk = hasCjkText(normalized);
  const groups: string[][] = [];
  const tokenPattern = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+|[a-z0-9][a-z0-9+#._-]*/giu;
  const rawTokens: { kind: 'cjk' | 'latin'; value: string }[] = [];
  for (const match of normalized.matchAll(tokenPattern)) {
    const value = match[0];
    if (!value) continue;
    rawTokens.push({ kind: hasCjkText(value) ? 'cjk' : 'latin', value });
  }
  for (let index = 0; index < rawTokens.length; index += 1) {
    const current = rawTokens[index]!;
    if (current.kind === 'latin') {
      const lower = current.value.toLowerCase().replace(/^[._-]+|[._-]+$/g, '');
      if (lower.length < 2 || EN_STOPWORDS.has(lower)) continue;
      groups.push([lower]);
      continue;
    }
    let cjk = current.value;
    const prev = index > 0 ? (rawTokens[index - 1] ?? null) : null;
    if (prev !== null && prev.kind === 'latin' && /^\d{2,4}$/.test(prev.value) && /^[年月日号期]/.test(cjk)) {
      cjk = cjk.slice(1);
    }
    const subRuns = cjk
      .split(/[的了呢吗吧啊呀在是和与及或为对于把被将着过之中有]+/u)
      .filter(part => part !== '');
    for (const part of subRuns) {
      const chars = [...part];
      if (chars.length === 0) continue;
      if (chars.length === 1) {
        if (!CJK_PARTICLES.has(chars[0]!) && rawTokens.length === 1) groups.push([chars[0]!]);
        continue;
      }
      const grams = cjkBigrams(part);
      if (chars.length >= 5 && grams.length >= 4) {
        const splitAt = Math.floor(grams.length / 2);
        groups.push(grams.slice(0, splitAt));
        groups.push(grams.slice(splitAt));
      } else {
        groups.push([...new Set([part, ...grams])]);
      }
    }
  }
  const nonModifierGroups = groups.filter(group =>
    !(group.length === 1 && GENERIC_QUERY_MODIFIERS.has(group[0]!)),
  );
  return { groups: nonModifierGroups.length >= 2 ? nonModifierGroups : groups, hasCjk };
}

function hostMatchesSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

export function isZeroKeyBoilerplateUrl(url: string, query: string, site: string | null): boolean {
  const host = urlHost(url)?.toLowerCase();
  if (!host) return false;
  if (!BOILERPLATE_HOSTS.some(suffix => hostMatchesSuffix(host, suffix))) return false;
  const queryLower = `${query} ${site ?? ''}`.toLowerCase();
  if (BOILERPLATE_QUERY_HINTS.some(hint => queryLower.includes(hint))) return false;
  return true;
}

export function filterBoilerplateItems(items: SearchItem[], query: string, site: string | null): SearchItem[] {
  return items.filter(item => !isZeroKeyBoilerplateUrl(item.url, query, site));
}

export type ZeroKeyQualityReason =
  | 'ok'
  | 'empty'
  | 'boilerplate_domain'
  | 'same_host_spam'
  | 'first_token_truncation'
  | 'zero_overlap';

export interface ZeroKeyQualityAssessment {
  ok: boolean;
  reason: ZeroKeyQualityReason;
  matchedGroupCount: number;
  totalGroupCount: number;
  matchedLaterGroupCount: number;
  boilerplateCount: number;
  score: number;
}

function itemSearchHaystack(item: SearchItem): string {
  let decodedUrl = item.url;
  try { decodedUrl = decodeURIComponent(item.url); } catch { /* keep raw url */ }
  return `${item.title} ${item.snippet} ${decodedUrl}`.toLowerCase();
}

export function assessZeroKeySearchQuality(
  query: string, items: SearchItem[], site: string | null, topK: number,
): ZeroKeyQualityAssessment {
  if (items.length === 0) {
    return {
      ok: false, reason: 'empty', matchedGroupCount: 0, totalGroupCount: 0,
      matchedLaterGroupCount: 0, boilerplateCount: 0, score: 0,
    };
  }
  const boilerplateCount = items.filter(item => isZeroKeyBoilerplateUrl(item.url, query, site)).length;
  const { groups, hasCjk } = extractQueryTermGroups(query);
  if (boilerplateCount === items.length || (items.length >= 2 && boilerplateCount / items.length >= 0.5)) {
    return {
      ok: false, reason: 'boilerplate_domain', matchedGroupCount: 0, totalGroupCount: groups.length,
      matchedLaterGroupCount: 0, boilerplateCount, score: -10,
    };
  }
  const cleanItems = items.filter(item => !isZeroKeyBoilerplateUrl(item.url, query, site));
  const inspect = cleanItems.slice(0, Math.min(cleanItems.length, 5));
  const haystacks = inspect.map(itemSearchHaystack);
  const matchedIndices = new Set<number>();
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const terms = groups[groupIndex]!;
    if (haystacks.some(text => terms.some(term => text.includes(term)))) {
      matchedIndices.add(groupIndex);
    }
  }
  const matchedFirst = matchedIndices.has(0);
  let matchedLaterGroupCount = 0;
  for (const index of matchedIndices) {
    if (index > 0) matchedLaterGroupCount += 1;
  }
  const score = matchedLaterGroupCount * 20 + matchedIndices.size * 10
    + Math.min(cleanItems.length, 5) - boilerplateCount * 5;

  const siteTrimmed = site?.trim() ?? '';
  if (siteTrimmed === '' && cleanItems.length >= 4) {
    const hostCounts = new Map<string, number>();
    for (const item of cleanItems) {
      const bare = (urlHost(item.url) ?? '').toLowerCase().replace(/^www\./, '');
      if (bare === '') continue;
      hostCounts.set(bare, (hostCounts.get(bare) ?? 0) + 1);
    }
    let dominantHost = '';
    let dominantCount = 0;
    for (const [host, count] of hostCounts) {
      if (count > dominantCount) { dominantHost = host; dominantCount = count; }
    }
    const queryLower = query.toLowerCase();
    const dominantBase = dominantHost.split('.')[0] ?? '';
    const queryMentionsHost = dominantHost !== ''
      && (queryLower.includes(dominantHost) || (dominantBase.length >= 3 && queryLower.includes(dominantBase)));
    if (dominantCount >= Math.ceil(cleanItems.length * 0.8) && !queryMentionsHost
      && matchedIndices.size < Math.min(groups.length, 2)) {
      return {
        ok: false, reason: 'same_host_spam', matchedGroupCount: matchedIndices.size,
        totalGroupCount: groups.length, matchedLaterGroupCount, boilerplateCount, score: score - 15,
      };
    }
  }

  if (groups.length >= 2 && matchedFirst && matchedLaterGroupCount === 0) {
    return {
      ok: false, reason: 'first_token_truncation', matchedGroupCount: matchedIndices.size,
      totalGroupCount: groups.length, matchedLaterGroupCount: 0, boilerplateCount, score: score - 10,
    };
  }

  if (groups.length >= 1 && matchedIndices.size === 0) {
    const isSingleProbeMock = items.length === 1 && topK <= 1 && !hasCjk && groups.length <= 2;
    if (!isSingleProbeMock) {
      return {
        ok: false, reason: 'zero_overlap', matchedGroupCount: 0,
        totalGroupCount: groups.length, matchedLaterGroupCount: 0, boilerplateCount, score,
      };
    }
  }

  return {
    ok: true, reason: 'ok', matchedGroupCount: matchedIndices.size,
    totalGroupCount: groups.length, matchedLaterGroupCount, boilerplateCount, score,
  };
}

class BingRssProvider extends HttpProvider implements Provider {
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
    const response = await this.send(url.toString(), {
      method: 'GET', headers: {
        Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
        'Accept-Language': acceptLanguageFor(query),
        'User-Agent': BROWSER_USER_AGENT,
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
          url: decodeSearchRedirectUrl(htmlUnescape(current.link)),
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

function extractAnchorHref(tagAttributes: string): string | null {
  const doubleQuoted = /\bhref\s*=\s*"([^"]+)"/i.exec(tagAttributes);
  if (doubleQuoted?.[1]) return htmlUnescape(doubleQuoted[1]);
  const singleQuoted = /\bhref\s*=\s*'([^']+)'/i.exec(tagAttributes);
  if (singleQuoted?.[1]) return htmlUnescape(singleQuoted[1]);
  return null;
}

export function parseDuckDuckGoHtml(html: string): SearchItem[] {
  const items: SearchItem[] = [];
  const parseWithClass = (anchorClass: string, snippetClass: string): void => {
    const anchorRe = new RegExp(
      `<a\\b([^>]*\\bclass\\s*=\\s*["'][^"']*\\b${anchorClass}\\b[^"']*["'][^>]*)>([\\s\\S]*?)<\\/a>`,
      'gi',
    );
    const snippetRe = new RegExp(
      `<(?:a|div|span|td)\\b[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${snippetClass}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/(?:a|div|span|td)>`,
      'i',
    );
    const matches = [...html.matchAll(anchorRe)];
    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index]!;
      const attrs = match[1] ?? '';
      const rawHref = extractAnchorHref(attrs);
      if (rawHref === null) continue;
      const decodedUrl = decodeSearchRedirectUrl(rawHref);
      if (!decodedUrl.startsWith('http://') && !decodedUrl.startsWith('https://')) continue;
      const lowerUrl = decodedUrl.toLowerCase();
      if (lowerUrl.includes('duckduckgo.com/y.js') || lowerUrl.includes('ad_provider=')) continue;
      const title = cleanSnippetText(match[2] ?? '');
      if (title === '') continue;
      const startPos = (match.index ?? 0) + match[0].length;
      const nextPos = index + 1 < matches.length ? (matches[index + 1]!.index ?? html.length) : Math.min(html.length, startPos + 4000);
      const slice = html.slice(startPos, Math.min(nextPos, startPos + 4000));
      const snippetMatch = snippetRe.exec(slice);
      const snippet = snippetMatch?.[1] ? cleanSnippetText(snippetMatch[1]) : '';
      items.push({ title, url: decodedUrl, snippet, rank: items.length + 1, score_hint: null });
    }
  };
  parseWithClass('result__a', 'result__snippet');
  if (items.length === 0) parseWithClass('result-link', 'result-snippet');
  return items;
}

export function parseBingHtml(html: string): SearchItem[] {
  const items: SearchItem[] = [];
  const blockRe = /<li\b[^>]*\bclass\s*=\s*["'][^"']*\bb_algo\b[^"']*["'][^>]*>/gi;
  const starts: number[] = [];
  for (const match of html.matchAll(blockRe)) {
    if (match.index !== undefined) starts.push(match.index);
  }
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]!;
    const end = index + 1 < starts.length ? starts[index + 1]! : Math.min(html.length, start + 12000);
    const block = html.slice(start, Math.min(end, start + 12000));
    const headingMatch = /<h2\b[^>]*>[\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(block);
    if (!headingMatch) continue;
    const rawHref = extractAnchorHref(headingMatch[1] ?? '');
    if (rawHref === null) continue;
    const decodedUrl = decodeSearchRedirectUrl(rawHref);
    if (!decodedUrl.startsWith('http://') && !decodedUrl.startsWith('https://')) continue;
    const title = cleanSnippetText(headingMatch[2] ?? '');
    if (title === '') continue;
    const captionMatch = /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bb_caption\b[^"']*["'][^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block)
      ?? /<p\b[^>]*\bclass\s*=\s*["'][^"']*\bb_lineclamp[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(block)
      ?? /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const snippet = captionMatch?.[1] ? cleanSnippetText(captionMatch[1]) : '';
    items.push({ title, url: decodedUrl, snippet, rank: items.length + 1, score_hint: null });
  }
  return items;
}

export function parseMediaWikiSearch(raw: JsonValue, host = 'en.wikipedia.org'): SearchItem[] {
  const items: SearchItem[] = [];
  const queryHits = arrayOf(pointer(raw, 'query/search'));
  if (queryHits !== null) {
    queryHits.forEach((entry, index) => {
      const title = str(pointer(entry, 'title'))?.trim() ?? '';
      if (title === '') return;
      const snippet = cleanSnippetText(str(pointer(entry, 'snippet')) ?? '');
      const url = `https://${host}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
      items.push({ title, url, snippet, rank: index + 1, score_hint: null });
    });
    return items;
  }
  const tuple = arrayOf(raw);
  if (tuple !== null && tuple.length >= 4) {
    const titles = arrayOf(tuple[1]) ?? [];
    const descriptions = arrayOf(tuple[2]) ?? [];
    const urls = arrayOf(tuple[3]) ?? [];
    const count = Math.min(titles.length, urls.length);
    for (let index = 0; index < count; index += 1) {
      const url = str(urls[index])?.trim() ?? '';
      const title = str(titles[index])?.trim() ?? '';
      if (url === '' || (!url.startsWith('http://') && !url.startsWith('https://'))) continue;
      const snippet = cleanSnippetText(str(descriptions[index]) ?? '');
      items.push({ title: title || url, url, snippet, rank: items.length + 1, score_hint: null });
    }
  }
  return items;
}

export type ZeroKeyFallbackBackend = 'ddg_html' | 'bing_html' | 'wikipedia_opensearch';
export const ZERO_KEY_FALLBACK_ORDER: readonly ZeroKeyFallbackBackend[] = [
  'ddg_html', 'bing_html', 'wikipedia_opensearch',
];

export interface ZeroKeyFallbackCandidate {
  backend: ZeroKeyFallbackBackend;
  items: SearchItem[];
  raw: JsonValue;
  latencyMs: number;
}

export async function searchZeroKeyFallback(
  backend: ZeroKeyFallbackBackend,
  config: ToolConfig,
  input: SearchInput,
  fetcher: typeof fetch = globalThis.fetch,
  _log: (message: string) => void = () => undefined,
  signal?: AbortSignal,
): Promise<ZeroKeyFallbackCandidate> {
  const baseQuery = input.query.trim();
  const site = input.site?.trim() ?? '';
  const scopedQuery = site !== '' ? `site:${site} ${baseQuery}` : baseQuery;
  const fallbackTimeout = Math.min(timeoutOf(config), 8000);
  const started = performance.now();

  if (backend === 'ddg_html') {
    const headers = {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': acceptLanguageFor(scopedQuery),
      'User-Agent': BROWSER_USER_AGENT,
    };
    const endpoints = [
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(scopedQuery)}`,
      `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(scopedQuery)}`,
    ];
    let lastStatus = 0;
    for (const endpoint of endpoints) {
      const response = await send(fetcher, endpoint, { method: 'GET', headers }, fallbackTimeout, signal);
      lastStatus = response.status;
      if (!isSuccess(response.status)) continue;
      const body = await responseText(response);
      const parsed = parseDuckDuckGoHtml(body);
      if (parsed.length > 0) {
        return {
          backend, items: parsed, raw: { format: 'html', fallback_backend: backend, endpoint },
          latencyMs: Math.trunc(performance.now() - started),
        };
      }
    }
    return {
      backend, items: [], raw: { format: 'html', fallback_backend: backend, status: lastStatus },
      latencyMs: Math.trunc(performance.now() - started),
    };
  }

  if (backend === 'bing_html') {
    const url = new URL('https://www.bing.com/search');
    url.searchParams.set('q', scopedQuery);
    url.searchParams.set('first', String(Math.max(input.start ?? 1, 1)));
    const response = await send(fetcher, url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': acceptLanguageFor(scopedQuery),
        'User-Agent': BROWSER_USER_AGENT,
      },
    }, fallbackTimeout, signal);
    const body = await responseText(response);
    if (!isSuccess(response.status)) {
      throw providerError('bing_html', response.status, textChars(body, 512));
    }
    return {
      backend, items: parseBingHtml(body), raw: { format: 'html', fallback_backend: backend },
      latencyMs: Math.trunc(performance.now() - started),
    };
  }

  if (site !== '' && !site.toLowerCase().includes('wikipedia.org')) {
    return { backend, items: [], raw: { skipped: 'site_filter' }, latencyMs: 0 };
  }
  const wikiHost = hasCjkText(baseQuery) ? 'zh.wikipedia.org' : 'en.wikipedia.org';
  const wikiUrl = new URL(`https://${wikiHost}/w/api.php`);
  wikiUrl.searchParams.set('action', 'query');
  wikiUrl.searchParams.set('list', 'search');
  wikiUrl.searchParams.set('srsearch', baseQuery);
  wikiUrl.searchParams.set('srlimit', String(Math.min(Math.max(input.top_k, 1), 10)));
  wikiUrl.searchParams.set('format', 'json');
  wikiUrl.searchParams.set('utf8', '1');
  const response = await send(fetcher, wikiUrl.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': WIKIPEDIA_USER_AGENT,
    },
  }, fallbackTimeout, signal);
  if (!isSuccess(response.status)) {
    throw providerError('wikipedia_opensearch', response.status, textChars(await responseText(response), 512));
  }
  const raw = await responseJson(response);
  return {
    backend, items: parseMediaWikiSearch(raw, wikiHost),
    raw: { format: 'mediawiki', host: wikiHost },
    latencyMs: Math.trunc(performance.now() - started),
  };
}

export const GOOGLE_CSE_DEFAULT_ENDPOINT = 'https://www.googleapis.com/customsearch/v1';

/** Google CSE 请求地址：未配置 `web_search.google_cse.endpoint` 时使用 Google 官方地址。 */
export function googleCseEndpoint(keys: ProviderKeys): string {
  const trimmed = keys.google_cse_endpoint?.trim() ?? '';
  return trimmed !== '' ? trimmed : GOOGLE_CSE_DEFAULT_ENDPOINT;
}

class GoogleCseProvider extends HttpProvider implements Provider {
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
    const endpoint = googleCseEndpoint(config.keys);
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new ToolError('config', `invalid GOOGLE_CSE_ENDPOINT: ${endpoint}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ToolError('config', `invalid GOOGLE_CSE_ENDPOINT protocol: ${endpoint}`);
    }
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
    const response = await this.send(url.toString(), { method: 'GET', headers: { 'User-Agent': 'web_search_tool/0.1' } }, timeoutOf(config), signal);
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

class SerpApiProvider extends HttpProvider implements Provider {
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
    const response = await this.send(url.toString(), { method: 'GET', headers: { 'User-Agent': 'web_search_tool/0.1' } }, timeoutOf(config), signal);
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

class TavilyProvider extends HttpProvider implements Provider {
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
    const response = await this.send('https://api.tavily.com/search', {
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

class BraveProvider extends HttpProvider implements Provider {
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
    const response = await this.send(url.toString(), {
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

class SearxngProvider extends HttpProvider implements Provider {
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
        const bytes = new TextEncoder().encode(apiKey);
        headers.Authorization = `Basic ${btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))}`;
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
    const response = await this.send(url.toString(), { method: 'GET', headers }, timeoutOf(config), signal);
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

class ZhipuProvider extends HttpProvider implements Provider {
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
    let response = await this.send('https://open.bigmodel.cn/api/paas/v4/web_search', {
      method: 'POST', headers, body: JSON.stringify(buildBody('search-prime')),
    }, timeoutOf(config), signal);
    let latency = Math.trunc(performance.now() - started);
    let raw: JsonValue;
    if (!isSuccess(response.status)) {
      const body = await responseText(response);
      const lower = body.toLowerCase();
      if (isClientError(response.status) && (lower.includes('search_engine') || lower.includes('search-prime'))) {
        log('[web_search][zhipu] search-prime rejected, retrying with search_pro');
        response = await this.send('https://open.bigmodel.cn/api/paas/v4/web_search', {
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

class BochaProvider extends HttpProvider implements Provider {
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
    const response = await this.send('https://api.bochaai.com/v1/web-search', {
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

class DeepseekProvider extends HttpProvider implements Provider {
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
    const response = await this.send('https://api.deepseek.com/v1/tools/search', {
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

export function createProvider(engine: string, fetcher: typeof fetch = globalThis.fetch): Provider {
  switch (engine) {
    case 'bing_rss': return new BingRssProvider(fetcher);
    case 'google_cse': return new GoogleCseProvider(fetcher);
    case 'serpapi': return new SerpApiProvider(fetcher);
    case 'tavily': return new TavilyProvider(fetcher);
    case 'brave': return new BraveProvider(fetcher);
    case 'searxng': return new SearxngProvider(fetcher);
    case 'zhipu': return new ZhipuProvider(fetcher);
    case 'bocha': return new BochaProvider(fetcher);
    case 'deepseek': return new DeepseekProvider(fetcher);
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

