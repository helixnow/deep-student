/**
 * `AcademicSearchExecutor` — Rust `src-tauri/src/chat_v2/tools/academic_search_executor.rs`
 * (`arxiv_search`: arXiv Atom API with an OpenAlex fallback; `scholar_search`: OpenAlex).
 *
 * HTTP goes through the L02 `llmHttp` client, which carries the proxy environment and
 * redirect policy the Rust `reqwest::Client` gets by default. The endpoints are
 * fixed constants; only tests point them at a local server.
 */
import type { ExecutionContext, ToolCall, ToolConcurrency, ToolExecutor, ToolResultInfo, ToolSensitivity } from '../../chat/api.ts';
import { academicSearchCanHandle, academicSearchSensitivity, papersToSources, parseArxivAtom,
  reconstructAbstract } from './academic-search.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';
import type { VfsService } from '../../vfs/api.ts';
import { CitationLedger, type NumberingLedger } from './citation-ledger.ts';
import { stripToolNamespace } from './paper-save.ts';
import { argsObject, runResearchTool, toolErrorText, type ResearchToolLog } from './research-tool-runner.ts';

export const ARXIV_API_URL = 'https://export.arxiv.org/api/query';
export const OPENALEX_API_URL = 'https://api.openalex.org/works';
const OPENALEX_ARXIV_SOURCE_ID = 'S4306400194';
const ARXIV_FAST_TIMEOUT_MS = 8_000;
const OPENALEX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULTS = 10;
const ARXIV_MAX_RESULTS_LIMIT = 50;
const OPENALEX_MAX_RESULTS_LIMIT = 50;
const OPENALEX_SELECT_FIELDS = 'id,title,authorships,abstract_inverted_index,publication_year,cited_by_count,doi,open_access,primary_location,type,ids';
const UA = 'DeepStudent/1.0 (Academic Search; mailto:support@deepstudent.cn)';
const CITATION_GUIDE = '在被支撑句子后紧跟 sources 中给出的 [搜索-N]；编号在本次回复内跨搜索全局一致。 / Cite supported claims with the exact [搜索-N] tag supplied in sources; numbering is global across searches in this reply.';

/** `llmHttp.fetch` plus the reqwest per-request timeout override. */
export type AcademicFetch = (input: string, init?: RequestInit & { requestTimeoutMs?: number }) => Promise<Response>;

export interface AcademicSearchExecutorDeps {
  /** `null` ⇔ no HTTP client service is mounted. */
  http(): { fetch: AcademicFetch } | null;
  /** `ctx.get('vfs').buildNumberedSources` (Rust `build_numbered_sources`); `null` ⇔ no vfs service is mounted. */
  numberSources(): VfsService['buildNumberedSources'] | null;
  ledgerForReply(sessionId: string, messageId: string, variantId: string | null): NumberingLedger | null;
  log: ResearchToolLog;
  endpoints?: { arxiv: string; openalex: string };
  now?: () => Date;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** serde_json `as_u64`. */
function asU64(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** `urlencoding::encode`: everything except RFC 3986 unreserved characters. */
function urlencode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function utcStamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}2359`;
}

/** `chars().take(4)` on strings, decimal on unsigned integers. */
function yearArg(value: unknown): string | null {
  if (typeof value === 'string') return Array.from(value).slice(0, 4).join('');
  const number = asU64(value);
  return number === null ? null : String(number);
}

function yearFilters(yearFrom: string | null, yearTo: string | null): string[] {
  if (yearFrom !== null) {
    return [yearTo !== null ? `publication_year:${yearFrom}-${yearTo}` : `from_publication_date:${yearFrom}-01-01`];
  }
  return yearTo !== null ? [`to_publication_date:${yearTo}-12-31`] : [];
}

/** Rust `convert_openalex_work`. */
export function convertOpenAlexWork(work: unknown): Json {
  const record = isRecord(work) ? work : {};
  const authorships = Array.isArray(record['authorships']) ? record['authorships'] : [];
  const authors = authorships.flatMap(entry => {
    const author = isRecord(entry) && isRecord(entry['author']) ? entry['author'] : null;
    const name = author === null ? null : str(author['display_name']);
    return name === null ? [] : [name];
  });
  const inverted = record['abstract_inverted_index'];
  const openAccess = isRecord(record['open_access']) ? record['open_access'] : null;
  const location = isRecord(record['primary_location']) ? record['primary_location'] : null;
  const source = location !== null && isRecord(location['source']) ? location['source'] : null;
  const ids = isRecord(record['ids']) ? record['ids'] : null;
  return {
    id: (ids === null ? null : str(ids['openalex'])) ?? '',
    title: str(record['title']) ?? '',
    authors,
    abstract: isRecord(inverted) ? reconstructAbstract(inverted) : '',
    year: asU64(record['publication_year']),
    venue: (source === null ? null : str(source['display_name'])) ?? '',
    citationCount: asU64(record['cited_by_count']) ?? 0,
    pdfUrl: (openAccess === null ? null : str(openAccess['oa_url'])) ?? '',
    doi: str(record['doi']) ?? '',
    type: str(record['type']) ?? '',
  };
}

class Cancelled extends Error {}

export class AcademicSearchExecutor implements ToolExecutor {
  private readonly deps: AcademicSearchExecutorDeps;

  constructor(deps: AcademicSearchExecutorDeps) {
    this.deps = deps;
  }

  name(): string { return 'AcademicSearchExecutor'; }
  canHandle(toolName: string): boolean { return academicSearchCanHandle(toolName); }
  sensitivityLevel(): ToolSensitivity { return academicSearchSensitivity(); }
  /** Both tools are read-only external queries (parallel + auto retry). */
  concurrencyClass(): ToolConcurrency { return 'read_only'; }

  execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    const tool = stripToolNamespace(call.name);
    this.deps.log.debug(`[AcademicSearch] Executing: ${tool} (full: ${call.name})`);
    return runResearchTool(call, ctx, async () => {
      let output: Json;
      if (tool === 'arxiv_search') output = await this.arxivSearch(argsObject(call), ctx);
      else if (tool === 'scholar_search') output = await this.scholarSearch(argsObject(call), ctx);
      else throw new Error(`Unknown academic search tool: ${tool}`);
      if (Array.isArray(output['papers'])) {
        const numberSources = this.deps.numberSources();
        if (numberSources === null) throw new Error('vfs service is not available');
        const sources = papersToSources(output['papers'], str(output['source']) ?? 'unknown');
        const ledger = this.deps.ledgerForReply(ctx.session_id, ctx.message_id, ctx.variant_id ?? null)
          ?? new CitationLedger();
        output['sources'] = numberSources(sources, ledger);
        output['citationGuide'] = CITATION_GUIDE;
      }
      return output;
    }, { log: this.deps.log, executorName: 'AcademicSearch', saveBlock: true });
  }

  private endpoints() {
    return this.deps.endpoints ?? { arxiv: ARXIV_API_URL, openalex: OPENALEX_API_URL };
  }

  private async get(url: string, timeoutMs: number, ctx: ExecutionContext): Promise<Response> {
    const http = this.deps.http();
    if (http === null) throw new Error('llmHttp service is not available');
    const signal = ctx.cancellation_token;
    if (signal === null) {
      return http.fetch(url, { headers: { 'user-agent': UA }, requestTimeoutMs: timeoutMs });
    }
    if (signal.aborted) throw new Cancelled();
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Cancelled());
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([
        http.fetch(url, { headers: { 'user-agent': UA }, requestTimeoutMs: timeoutMs, signal }), cancelled,
      ]);
    } catch (error) {
      if (signal.aborted) throw new Cancelled();
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort!);
    }
  }

  private async arxivSearch(args: Json, ctx: ExecutionContext): Promise<Json> {
    if (ctx.isCancelled()) throw new Error('arXiv search cancelled');
    const query = str(args['query']);
    if (query === null) throw new Error("Missing required parameter 'query'");
    const maxResults = Math.min(asU64(args['max_results']) ?? DEFAULT_MAX_RESULTS, ARXIV_MAX_RESULTS_LIMIT);
    const dateFrom = str(args['date_from']);
    const dateTo = str(args['date_to']);
    const categories = Array.isArray(args['categories'])
      ? (args['categories'] as unknown[]).filter((value): value is string => typeof value === 'string') : [];
    const sortBy = str(args['sort_by']) ?? 'relevance';
    this.deps.log.debug(`[AcademicSearch] arXiv search: query='${query}', max=${maxResults}, categories=${JSON.stringify(categories)}, sort=${sortBy}`);

    try {
      const papers = await this.arxivDirect(query, maxResults, dateFrom, dateTo, categories, sortBy, ctx);
      this.deps.log.info(`[AcademicSearch] arXiv direct API: ${papers.length} results for '${query}'`);
      return { source: 'arxiv', total_results: papers.length, papers };
    } catch (error) {
      const text = error instanceof Cancelled ? 'cancelled' : toolErrorText(error);
      this.deps.log.warn(`[AcademicSearch] arXiv direct API failed (${text}), falling back to OpenAlex`);
    }

    if (ctx.isCancelled() || ctx.cancellation_token?.aborted === true) throw new Error('arXiv search cancelled');
    this.deps.log.info('[AcademicSearch] Using OpenAlex fallback for arXiv search');
    const filters = [`primary_location.source.id:${OPENALEX_ARXIV_SOURCE_ID}`,
      ...yearFilters(dateFrom?.split('-')[0] ?? null, dateTo?.split('-')[0] ?? null)];
    const result = await this.openAlexSearch(query, maxResults, filters, sortBy, ctx);
    const papers = Array.isArray(result['papers']) ? result['papers'] : [];
    return {
      source: 'openalex_arxiv_fallback',
      total_results: papers.length,
      papers,
      note: 'arXiv API 不可达，已通过 OpenAlex 搜索 arXiv 论文（分类过滤不可用）',
    };
  }

  private async arxivDirect(query: string, maxResults: number, dateFrom: string | null, dateTo: string | null,
    categories: readonly string[], sortBy: string, ctx: ExecutionContext): Promise<unknown[]> {
    const parts: string[] = [];
    if (query.trim() !== '') parts.push(`(${query})`);
    if (categories.length > 0) parts.push(`(${categories.map(category => `cat:${category}`).join('+OR+')})`);
    if (dateFrom !== null || dateTo !== null) {
      const start = dateFrom !== null ? dateFrom.replaceAll('-', '') : '199107010000';
      const end = dateTo !== null ? `${dateTo.replaceAll('-', '')}2359` : utcStamp(this.deps.now?.() ?? new Date());
      parts.push(`submittedDate:[${utf8ByteLength(start) === 8 ? `${start}0000` : start}+TO+${end}]`);
    }
    if (parts.length === 0) throw new Error('No search criteria');
    const sortParam = sortBy === 'date' ? 'submittedDate' : 'relevance';
    const url = `${this.endpoints().arxiv}?search_query=${urlencode(parts.join('+AND+'))}&max_results=${maxResults}&sortBy=${sortParam}&sortOrder=descending`;
    this.deps.log.debug(`[AcademicSearch] arXiv direct URL: ${url}`);

    let response: Response;
    try {
      response = await this.get(url, ARXIV_FAST_TIMEOUT_MS, ctx);
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      throw new Error(`arXiv request failed: ${toolErrorText(error)}`);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    let xml: string;
    try { xml = await response.text(); }
    catch (error) { throw new Error(`read body failed: ${toolErrorText(error)}`); }
    return parseArxivAtom(xml);
  }

  private async scholarSearch(args: Json, ctx: ExecutionContext): Promise<Json> {
    if (ctx.isCancelled()) throw new Error('Scholar search cancelled');
    const query = str(args['query']);
    if (query === null) throw new Error("Missing required parameter 'query'");
    const maxResults = Math.min(asU64(args['max_results']) ?? DEFAULT_MAX_RESULTS, OPENALEX_MAX_RESULTS_LIMIT);
    // year_from/year_to are canonical; date_from/date_to tolerate arxiv_search argument names.
    const pick = (primary: string, alias: string) => args[primary] !== undefined ? args[primary] : args[alias];
    const yearFrom = yearArg(pick('year_from', 'date_from'));
    const yearTo = yearArg(pick('year_to', 'date_to'));
    const openAccessOnly = args['open_access_only'] === true;
    const minCitationCount = asU64(args['min_citation_count']);
    const sortBy = str(args['sort_by']) ?? 'relevance';
    this.deps.log.debug(`[AcademicSearch] Scholar search (OpenAlex): query='${query}', max=${maxResults}, year=${yearFrom ?? 'None'}-${yearTo ?? 'None'}`);

    const filters = yearFilters(yearFrom, yearTo);
    if (openAccessOnly) filters.push('open_access.is_oa:true');
    // OpenAlex has no >=, so >N-1 stands in for >=N on integer fields.
    if (minCitationCount !== null && minCitationCount > 0) filters.push(`cited_by_count:>${minCitationCount - 1}`);
    return this.openAlexSearch(query, maxResults, filters, sortBy, ctx);
  }

  private async openAlexSearch(query: string, maxResults: number, filters: readonly string[], sortBy: string,
    ctx: ExecutionContext): Promise<Json> {
    if (ctx.isCancelled()) throw new Error('OpenAlex search cancelled');
    const params = new URLSearchParams([
      ['search', query], ['per-page', String(maxResults)], ['select', OPENALEX_SELECT_FIELDS],
      ['mailto', 'support@deepstudent.cn'],
    ]);
    if (filters.length > 0) params.append('filter', filters.join(','));
    if (sortBy === 'date') params.append('sort', 'publication_date:desc');
    else if (sortBy === 'citations') params.append('sort', 'cited_by_count:desc');
    const url = `${this.endpoints().openalex}?${params.toString()}`;
    this.deps.log.debug(`[AcademicSearch] OpenAlex URL: ${url}`);

    let response: Response;
    try {
      response = await this.get(url, OPENALEX_TIMEOUT_MS, ctx);
    } catch (error) {
      if (error instanceof Cancelled) throw new Error('OpenAlex search cancelled');
      throw new Error(`OpenAlex API request failed: ${toolErrorText(error)}`);
    }
    if (!response.ok) {
      let body = '';
      try { body = await response.text(); }
      catch (error) { this.deps.log.debug(`[AcademicSearch] OpenAlex error body unreadable: ${toolErrorText(error)}`); }
      throw new Error(`OpenAlex API returned HTTP ${response.status}: ${Array.from(body).slice(0, 500).join('')}`);
    }
    let body: unknown;
    try { body = JSON.parse(await response.text()); }
    catch (error) { throw new Error(`Failed to parse OpenAlex response: ${toolErrorText(error)}`); }

    const record = isRecord(body) ? body : {};
    const rawPapers = Array.isArray(record['results']) ? record['results'] : [];
    const meta = isRecord(record['meta']) ? record['meta'] : null;
    const total = (meta === null ? null : asU64(meta['count'])) ?? rawPapers.length;
    const papers = rawPapers.map(convertOpenAlexWork);
    this.deps.log.info(`[AcademicSearch] OpenAlex search: ${papers.length} results (total ${total}) for '${query}'`);
    return { source: 'openalex', total_results: total, returned_results: papers.length, papers };
  }
}
