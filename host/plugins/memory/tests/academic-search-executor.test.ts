import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentToolExecutorRegistry } from '../../agent-skills/api.ts';
import type { ExecutionContext, ToolExecutor } from '../../chat/api.ts';
import { buildNumberedSources } from '../../vfs/api.ts';
import { CitationLedger } from '../src/citation-ledger.ts';
import { setupMemoryHost, type MemoryHost } from './support.ts';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

let current: MemoryHost | undefined;
let server: Server;
let base: string;
const handlers: Record<string, Handler> = {};
const received: Array<{ path: string; url: URL; userAgent: string | undefined }> = [];

beforeEach(async () => {
  received.length = 0;
  for (const key of Object.keys(handlers)) delete handlers[key];
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://local');
    received.push({ path: url.pathname, url, userAgent: request.headers['user-agent'] });
    const handler = handlers[url.pathname];
    if (handler === undefined) { response.writeHead(404); response.end('no route'); return; }
    handler(request, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await current?.dispose(); current = undefined;
  await new Promise<void>(resolve => server.close(() => resolve()));
});

const ORIGINS: Record<string, string> = {
  'https://export.arxiv.org/api/query': '/arxiv',
  'https://api.openalex.org/works': '/openalex',
};

/** The `llmHttp` service: records what the executor asks for and forwards production URLs to the local server. */
function recordingHttp() {
  const requests: Array<{ url: string; timeout: number | undefined; signal: boolean }> = [];
  return {
    requests,
    fetch: (input: string, init?: RequestInit & { requestTimeoutMs?: number }) => {
      requests.push({ url: input, timeout: init?.requestTimeoutMs, signal: init?.signal !== undefined });
      const target = new URL(input);
      const route = ORIGINS[`${target.origin}${target.pathname}`];
      if (route === undefined) return Promise.reject(new Error(`unexpected origin ${input}`));
      return globalThis.fetch(`${base}${route}${target.search}`, init);
    },
  };
}

async function setup(options: { http?: boolean; vfs?: boolean } = {}) {
  const registry = new AgentToolExecutorRegistry();
  const http = recordingHttp();
  const ledgers = new Map<string, CitationLedger>();
  current = await setupMemoryHost({
    agentTools: { registerToolExecutors: executors => registry.register(executors) },
    services: {
      ...(options.http === false ? {} : { llmHttp: http }),
      ...(options.vfs === false ? {} : { vfs: { buildNumberedSources } }),
      chatPipeline: {
        citationLedgerForReply: (sessionId: string, messageId: string, variantId?: string | null) => {
          const key = `${sessionId}|${messageId}|${variantId ?? ''}`;
          if (!ledgers.has(key)) ledgers.set(key, new CitationLedger());
          return ledgers.get(key)!;
        },
      },
    },
  });
  const executor = registry.all().find(entry => entry.name() === 'AcademicSearchExecutor') as ToolExecutor;
  return { ...current, executor, http };
}

async function call(executor: ToolExecutor, name: string, args: unknown, options: { messageId?: string; signal?: AbortSignal } = {}) {
  const events: string[] = [];
  const ctx = {
    session_id: 'sess_a', message_id: options.messageId ?? 'msg_a', block_id: 'blk_a', variant_id: null,
    cancellation_token: options.signal ?? null, isCancelled: () => options.signal?.aborted ?? false,
    emitToolCallStart: () => { events.push('start'); },
    emitToolCallEnd: () => { events.push('end'); },
    emitToolCallError: (error: string) => { events.push(`error:${error}`); },
    saveToolBlock: () => { events.push('save'); },
  } as unknown as ExecutionContext;
  const result = await executor.execute({ id: `call_${name}`, name: `builtin-${name}`, arguments: args }, ctx);
  return { result, events, output: result.output as Record<string, any> };
}

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.00001v2</id>
    <published>2024-01-02T00:00:00Z</published>
    <title>Quantum
 Error Correction</title>
    <summary>Surface codes &amp; more.</summary>
    <author><name>Alice</name></author>
    <author><name>Bob</name></author>
    <category term="quant-ph"/>
    <link title="pdf" href="https://arxiv.org/pdf/2401.00001v2"/>
  </entry>
</feed>`;

const OPENALEX = {
  meta: { count: 123 },
  results: [{
    id: 'https://openalex.org/W1', title: 'Attention Is All You Need',
    authorships: [{ author: { display_name: 'Ashish Vaswani' } }, { author: {} }],
    abstract_inverted_index: { need: [4], Attention: [0], is: [1], all: [2], you: [3] },
    publication_year: 2017, cited_by_count: 100000, doi: 'https://doi.org/10.1/x',
    open_access: { oa_url: 'https://arxiv.org/pdf/1706.03762' },
    primary_location: { source: { display_name: 'NeurIPS' } }, type: 'article',
    ids: { openalex: 'https://openalex.org/W1' },
  }],
};

function json(body: unknown, status = 200): Handler {
  return (_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
}

describe('AcademicSearchExecutor', () => {
  it('registers under the roster name; tool names agree with the frontend schema', async () => {
    const schema = readFileSync('src/features/chat/skills/builtin-tools/academic-search.ts', 'utf8');
    const names = [...schema.matchAll(/name: 'builtin-([a-z_]+)'/g)].map(match => match[1]!);
    const { executor } = await setup();
    expect(typeof executor.execute).toBe('function');
    expect(names.filter(name => executor.canHandle(`builtin-${name}`))).toEqual(['arxiv_search', 'scholar_search']);
    expect(executor.canHandle('mcp_arxiv_search')).toBe(true);
    expect(executor.canHandle('builtin-web_search')).toBe(false);
    for (const tool of ['arxiv_search', 'scholar_search']) {
      expect(executor.sensitivityLevel?.(`builtin-${tool}`)).toBe('low');
      expect(executor.concurrencyClass?.(`builtin-${tool}`)).toBe('read_only');
    }
  });

  it('arxiv_search queries the arXiv API with the Rust query string and numbers sources on the reply ledger', async () => {
    handlers['/arxiv'] = (_request, response) => { response.writeHead(200); response.end(ATOM); };
    handlers['/openalex'] = json(OPENALEX);
    const { executor, http } = await setup();
    const { result, events, output } = await call(executor, 'arxiv_search', {
      query: 'quantum codes', max_results: 99, categories: ['quant-ph', 'cs.ET', 7],
      date_from: '2024-01-01', date_to: '2024-12-31', sort_by: 'date',
    });
    expect(result.success).toBe(true);
    expect(events).toEqual(['start', 'end', 'save']);
    expect(http.requests).toEqual([{
      url: 'https://export.arxiv.org/api/query?search_query=%28quantum%20codes%29%2BAND%2B%28cat%3Aquant-ph%2BOR%2Bcat%3Acs.ET%29'
        + '%2BAND%2BsubmittedDate%3A%5B202401010000%2BTO%2B202412312359%5D&max_results=50&sortBy=submittedDate&sortOrder=descending',
      timeout: 8000, signal: false,
    }]);
    expect(received[0]!.userAgent).toBe('DeepStudent/1.0 (Academic Search; mailto:support@deepstudent.cn)');
    expect(output['source']).toBe('arxiv');
    expect(output['total_results']).toBe(1);
    expect(output['papers']).toEqual([{
      id: '2401.00001', title: 'Quantum  Error Correction', authors: ['Alice', 'Bob'], abstract: 'Surface codes & more.',
      categories: ['quant-ph'], published: '2024-01-02T00:00:00Z', pdfUrl: 'https://arxiv.org/pdf/2401.00001v2',
      arxivUrl: 'https://arxiv.org/abs/2401.00001',
    }]);
    expect(output['sources']).toHaveLength(1);
    expect(output['sources'][0]).toMatchObject({
      index: 1, citationTag: '[搜索-1]', typeIndex: 1, title: 'Quantum  Error Correction',
      url: 'https://arxiv.org/abs/2401.00001', snippet: 'Surface codes & more.',
    });
    expect(output['citationGuide']).toContain('[搜索-N]');

    // A second academic search in the same reply continues the shared numbering.
    const second = await call(executor, 'scholar_search', { query: 'transformers' });
    expect(second.output['sources'][0]).toMatchObject({ citationTag: '[搜索-2]', typeIndex: 2 });
    const otherReply = await call(executor, 'scholar_search', { query: 'transformers' }, { messageId: 'msg_b' });
    expect(otherReply.output['sources'][0]).toMatchObject({ citationTag: '[搜索-1]' });
  });

  it('arxiv_search falls back to OpenAlex with the arXiv source filter when the direct API fails', async () => {
    handlers['/arxiv'] = (_request, response) => { response.writeHead(503); response.end('busy'); };
    handlers['/openalex'] = json(OPENALEX);
    const { executor, http, warnings } = await setup();
    const { result, output } = await call(executor, 'arxiv_search', {
      query: 'attention', date_from: '2017-06-01', date_to: '2018-01-01',
    });
    expect(result.success).toBe(true);
    expect(warnings).toContain('[AcademicSearch] arXiv direct API failed (HTTP 503), falling back to OpenAlex');
    expect(http.requests.map(entry => entry.timeout)).toEqual([8000, 30000]);
    const fallback = received[1]!.url.searchParams;
    expect(fallback.get('filter')).toBe('primary_location.source.id:S4306400194,publication_year:2017-2018');
    expect(fallback.get('per-page')).toBe('10');
    expect(fallback.get('sort')).toBeNull();
    expect(output).toMatchObject({
      source: 'openalex_arxiv_fallback', total_results: 1,
      note: 'arXiv API 不可达，已通过 OpenAlex 搜索 arXiv 论文（分类过滤不可用）',
    });
    expect(output['papers'][0]).toEqual({
      id: 'https://openalex.org/W1', title: 'Attention Is All You Need', authors: ['Ashish Vaswani'],
      abstract: 'Attention is all you need', year: 2017, venue: 'NeurIPS', citationCount: 100000,
      pdfUrl: 'https://arxiv.org/pdf/1706.03762', doi: 'https://doi.org/10.1/x', type: 'article',
    });
    expect(output['sources'][0]).toMatchObject({ citationTag: '[搜索-1]', url: 'https://doi.org/10.1/x' });
  });

  it('scholar_search builds the OpenAlex filters, sort and form-encoded query like reqwest', async () => {
    handlers['/openalex'] = json(OPENALEX);
    const { executor, http } = await setup();
    const { result, output } = await call(executor, 'scholar_search', {
      query: 'graph neural*nets', max_results: 3, date_from: '2020-05-01', year_to: 2022,
      open_access_only: true, min_citation_count: 10, sort_by: 'citations',
    });
    expect(result.success).toBe(true);
    expect(http.requests).toEqual([{
      url: 'https://api.openalex.org/works?search=graph+neural*nets&per-page=3&select=id%2Ctitle%2Cauthorships%2Cabstract_inverted_index'
        + '%2Cpublication_year%2Ccited_by_count%2Cdoi%2Copen_access%2Cprimary_location%2Ctype%2Cids&mailto=support%40deepstudent.cn'
        + '&filter=publication_year%3A2020-2022%2Copen_access.is_oa%3Atrue%2Ccited_by_count%3A%3E9&sort=cited_by_count%3Adesc',
      timeout: 30000, signal: false,
    }]);
    expect(output).toMatchObject({ source: 'openalex', total_results: 123, returned_results: 1 });
  });

  it('failures are tool errors with the Rust messages', async () => {
    handlers['/openalex'] = json('x'.repeat(600), 429);
    const { executor } = await setup();
    const missing = await call(executor, 'scholar_search', { max_results: 3 });
    expect(missing.result.success).toBe(false);
    expect(missing.result.error).toBe("Missing required parameter 'query'");
    expect(missing.events).toEqual(['start', "error:Missing required parameter 'query'", 'save']);

    const limited = await call(executor, 'scholar_search', { query: 'x' });
    expect(limited.result.error).toBe(`OpenAlex API returned HTTP 429: ${'x'.repeat(500)}`);

    handlers['/openalex'] = json('{not json');
    const garbled = await call(executor, 'scholar_search', { query: 'x' });
    expect(garbled.result.error).toMatch(/^Failed to parse OpenAlex response: /);

    const unknown = await call(executor, 'paper_save', { query: 'x' });
    expect(unknown.result.error).toBe('Unknown academic search tool: paper_save');

    const aborted = new AbortController();
    aborted.abort();
    const cancelled = await call(executor, 'arxiv_search', { query: 'x' }, { signal: aborted.signal });
    expect(cancelled.result.error).toBe('arXiv search cancelled');
  });

  it('a cancellation while the arXiv request is in flight stops before the OpenAlex fallback', async () => {
    const controller = new AbortController();
    handlers['/arxiv'] = () => { controller.abort(); };
    const { executor, http } = await setup();
    const { result } = await call(executor, 'arxiv_search', { query: 'x' }, { signal: controller.signal });
    expect(result.error).toBe('arXiv search cancelled');
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]!.signal).toBe(true);
  });

  it('without an HTTP client the direct request fails and so does the fallback', async () => {
    const { executor } = await setup({ http: false });
    const { result } = await call(executor, 'arxiv_search', { query: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('OpenAlex API request failed: llmHttp service is not available');
  });

  it('numbers sources with the vfs service function and fails visibly when no vfs service is mounted', async () => {
    handlers['/openalex'] = json(OPENALEX);
    const { executor, host } = await setup();
    const numberSources = vi.spyOn(host.ctx.get('vfs')!, 'buildNumberedSources');
    const { output } = await call(executor, 'scholar_search', { query: 'transformers' });
    expect(numberSources).toHaveBeenCalledTimes(1);
    expect(output['sources'][0]).toMatchObject({ citationTag: '[搜索-1]' });
    await current!.dispose(); current = undefined;

    const bare = await setup({ vfs: false });
    const { result, events } = await call(bare.executor, 'scholar_search', { query: 'transformers' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('vfs service is not available');
    expect(events).toEqual(['start', 'error:vfs service is not available', 'save']);
  });
});
