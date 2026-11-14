import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpError, type HttpService } from '../../../platform/http/api.ts';
import { createHttpService } from '../../../platform/http/index.ts';
import { isSafeRemoteUrl } from '../../../platform/net-policy/node.ts';
import { AgentToolExecutorRegistry } from '../../agent-skills/api.ts';
import type { ExecutionContext, ToolExecutor } from '../../chat/api.ts';
import type { PaperFileInput, PaperLibraryPort, PaperUnitInput } from '../api.ts';
import { setupMemoryHost, type MemoryHost } from './support.ts';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

let current: MemoryHost | undefined;
let server: Server;
let port: number;
const handlers: Record<string, Handler> = {};

beforeEach(async () => {
  for (const key of Object.keys(handlers)) delete handlers[key];
  server = createServer((request, response) => {
    const handler = handlers[new URL(request.url ?? '/', 'http://local').pathname];
    if (handler === undefined) { response.writeHead(404); response.end('missing'); return; }
    handler(request, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  await current?.dispose(); current = undefined;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

const ORIGINS: Record<string, string> = {
  'https://arxiv.org': '/arxiv-main',
  'https://export.arxiv.org': '/arxiv-export',
  'https://api.unpaywall.org': '/unpaywall',
};

/**
 * Mounted as both `llmHttp` and `http`, so `requests` keeps the cross-service call order.
 * `https://papers.test` stands in for a public PDF host and is served by the local test server.
 */
function recordingHttp() {
  const requests: Array<{ url: string; timeout: number | undefined; userAgent: string | null;
    destination: string | undefined; redirect: string | undefined }> = [];
  return {
    requests,
    fetch: (input: string, init?: RequestInit & { requestTimeoutMs?: number; timeoutMs?: number; destination?: string }) => {
      requests.push({ url: input, timeout: init?.requestTimeoutMs ?? init?.timeoutMs,
        userAgent: new Headers(init?.headers).get('user-agent'), destination: init?.destination, redirect: init?.redirect });
      const target = new URL(input);
      if (target.hostname === 'papers.test') return globalThis.fetch(`http://127.0.0.1:${port}${target.pathname}`, init);
      const route = ORIGINS[target.origin];
      if (route === undefined) return Promise.reject(new Error(`unexpected origin ${input}`));
      return globalThis.fetch(`http://127.0.0.1:${port}${route}${target.pathname}${target.search}`, init);
    },
  };
}

/** In-memory VFS owner: content-addressed blobs and files keyed by sha256. */
function memoryLibrary(options: { previewFails?: boolean; pipeline?: boolean } = {}) {
  const files = new Map<string, { id: string; status: string }>();
  const blobs: string[] = [];
  const created: PaperFileInput[] = [];
  const units: PaperUnitInput[] = [];
  const pipelines: string[] = [];
  const library: PaperLibraryPort = {
    getFileBySha256: sha256 => files.get(sha256) ?? null,
    storeBlob: bytes => {
      const hash = createHash('sha256').update(bytes).digest('hex');
      blobs.push(hash);
      return hash;
    },
    renderPreview: async () => {
      if (options.previewFails === true) throw new Error('pdfium unavailable');
      return { previewJson: '{"pages":3}', extractedText: 'paper text', pageCount: 3 };
    },
    createFile: input => {
      created.push(input);
      const id = `file_${created.length}`;
      files.set(input.sha256, { id, status: 'active' });
      return { id, resourceId: `res_${created.length}`, pageCount: input.pageCount,
        extractedText: input.extractedText, previewJson: input.previewJson };
    },
    syncResourceUnits: input => { units.push(input); return 2; },
    ...(options.pipeline === false ? {} : { startPipeline: async (fileId: string) => { pipelines.push(fileId); } }),
  };
  return { library, files, blobs, created, units, pipelines };
}

async function setup(options: { library?: ReturnType<typeof memoryLibrary> | null;
  publicHttp?: Pick<HttpService, 'fetch'> } = {}) {
  const registry = new AgentToolExecutorRegistry();
  const http = recordingHttp();
  const store = options.library === undefined ? memoryLibrary() : options.library;
  current = await setupMemoryHost({
    agentTools: { registerToolExecutors: executors => registry.register(executors) },
    services: { llmHttp: http, http: options.publicHttp ?? http,
      ...(store === null ? {} : { paperLibrary: store.library }) },
  });
  const executor = registry.all().find(entry => entry.name() === 'PaperSaveExecutor') as ToolExecutor;
  return { ...current, executor, http };
}

async function call(executor: ToolExecutor, name: string, args: unknown, signal: AbortSignal | null = null) {
  const events: string[] = [];
  const chunks: string[] = [];
  const ctx = {
    session_id: 'sess_p', message_id: 'msg_p', block_id: 'blk_p', variant_id: null,
    cancellation_token: signal, isCancelled: () => signal?.aborted ?? false,
    emitter: { emitChunk: (type: string, blockId: string, chunk: string, variantId: string | null) => {
      expect([type, blockId, variantId]).toEqual(['tool_call', 'blk_p', null]);
      chunks.push(chunk);
    } },
    emitToolCallStart: () => { events.push('start'); },
    emitToolCallEnd: () => { events.push('end'); },
    emitToolCallError: (error: string) => { events.push(`error:${error}`); },
    saveToolBlock: () => { events.push('save'); },
  } as unknown as ExecutionContext;
  const result = await executor.execute({ id: `call_${name}`, name: `builtin-${name}`, arguments: args }, ctx);
  const snapshots = chunks.map(chunk => {
    expect(chunk.endsWith('\n')).toBe(true);
    return JSON.parse(chunk) as { papers: Array<Record<string, any>> };
  });
  return { result, events, snapshots, output: result.output as Record<string, any> };
}

function pdf(size: number): Buffer {
  const bytes = Buffer.alloc(size, 0x20);
  bytes.write('%PDF-1.7\n', 0, 'latin1');
  return bytes;
}

function serve(bytes: Buffer, status = 200): Handler {
  return (_request, response) => {
    response.writeHead(status, { 'content-type': 'application/pdf', 'content-length': String(bytes.length) });
    response.end(bytes);
  };
}

function localized(error: string | null | undefined) {
  return JSON.parse(error ?? 'null') as Record<string, any>;
}

describe('PaperSaveExecutor', () => {
  it('registers under the roster name; tool names agree with the frontend schema', async () => {
    const schema = readFileSync('src/features/chat/skills/builtin-tools/academic-search.ts', 'utf8');
    const names = [...schema.matchAll(/name: 'builtin-([a-z_]+)'/g)].map(match => match[1]!);
    const { executor } = await setup();
    expect(names.filter(name => executor.canHandle(`builtin-${name}`))).toEqual(['paper_save', 'cite_format']);
    expect(executor.canHandle('builtin-arxiv_search')).toBe(false);
    expect(executor.sensitivityLevel?.('builtin-paper_save')).toBe('medium');
    expect(executor.sensitivityLevel?.('builtin-cite_format')).toBe('low');
    expect(executor.sensitivityLevel?.('builtin-other')).toBe('medium');
    expect(executor.concurrencyClass?.('builtin-paper_save')).toBe('serial');
  });

  it('falls back from arXiv to the export mirror, streams NDJSON progress and saves through the VFS owner', async () => {
    const bytes = pdf(600 * 1024);
    handlers['/arxiv-export/pdf/2401.00001'] = serve(bytes);
    const store = memoryLibrary();
    const { executor, http, infos } = await setup({ library: store });
    const { result, events, snapshots, output } = await call(executor, 'paper_save', {
      papers: [{ title: 'Quantum: Codes', arxiv_id: ' arXiv:2401.00001' }], folder_id: 'fld_1',
    });
    expect(result.success).toBe(true);
    expect(events).toEqual(['start', 'end', 'save']);
    expect(http.requests.map(request => [request.url, request.timeout])).toEqual([
      ['https://arxiv.org/pdf/2401.00001', 60000], ['https://export.arxiv.org/pdf/2401.00001', 60000],
    ]);
    expect(http.requests[0]!.userAgent).toBe('DeepStudent/1.0 (Academic Paper Save; mailto:support@deepstudent.app)');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    expect(store.created).toEqual([{
      sha256, fileName: 'Quantum_ Codes.pdf', sizeBytes: bytes.length, blobHash: sha256, folderId: 'fld_1',
      previewJson: '{"pages":3}', extractedText: 'paper text', pageCount: 3,
    }]);
    expect(store.units).toEqual([{ resourceId: 'res_1', blobHash: sha256, pageCount: 3, extractedText: 'paper text', previewJson: '{"pages":3}' }]);
    expect(store.pipelines).toEqual(['file_1']);
    expect(infos).toContain('[PaperSave] Indexed 2 units for file file_1');
    expect(output).toEqual({
      total: 1, success_count: 1, failed_count: 0,
      results: [{
        success: true, deduplicated: false, file_id: 'file_1', title: 'Quantum: Codes', file_name: 'Quantum_ Codes.pdf',
        size_bytes: bytes.length, page_count: 3, has_text: true, messageKey: 'chat.tools.paper_save.saved',
        messageParams: { pageCount: 3, fileId: 'file_1' },
        messageFallback: { 'zh-CN': '论文已保存到资料库（3页，文件ID: file_1）', 'en-US': 'The paper was saved to the library (3 pages, file ID: file_1).' },
        message: '论文已保存到资料库（3页，文件ID: file_1） / The paper was saved to the library (3 pages, file ID: file_1).',
        index: 0,
      }],
    });
    const stages = snapshots.map(snapshot => snapshot.papers[0]!['s']);
    expect(stages.slice(0, 4)).toEqual(['resolving', 'resolving', 'downloading', 'downloading']);
    expect(stages.slice(-5)).toEqual(['deduplicating', 'storing', 'processing', 'indexing', 'done']);
    // One throttled tick past 512 KiB before the final 100 % snapshot; percent is capped below 100.
    const ticks = snapshots.map(snapshot => snapshot.papers[0]!).filter(item => item['dl'] !== undefined && item['pct'] < 100);
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toMatchObject({ s: 'downloading', total: bytes.length, src: 'arXiv Export' });
    expect(ticks[0]!['dl']).toBeGreaterThanOrEqual(512 * 1024);
    expect(ticks[0]!['pct']).toBe(Math.floor(ticks[0]!['dl'] / bytes.length * 100));
    expect(snapshots.at(-1)!.papers[0]).toEqual({
      i: 0, t: 'Quantum: Codes', s: 'done', pct: 100, dl: bytes.length, total: bytes.length, fid: 'file_1',
      src: 'arXiv Export', srcs: [
        { label: 'arXiv', url: 'https://arxiv.org/pdf/2401.00001' },
        { label: 'arXiv Export', url: 'https://export.arxiv.org/pdf/2401.00001' },
      ],
    });
  });

  it('deduplicates by sha256 and resolves DOIs through Unpaywall oa_locations', async () => {
    const bytes = pdf(64);
    handlers['/same.pdf'] = serve(bytes);
    handlers['/unpaywall/v2/10.1/x'] = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ best_oa_location: { url_for_pdf: '' },
        oa_locations: [{ url_for_pdf: null }, { url_for_pdf: `https://papers.test/same.pdf` }] }));
    };
    const store = memoryLibrary();
    const { executor, http } = await setup({ library: store });
    await call(executor, 'paper_save', { papers: [{ title: 'First', url: `https://papers.test/same.pdf` }] });
    const again = await call(executor, 'paper_save', { papers: [{ title: 'Again', doi: 'https://doi.org/10.1/x' }] });
    expect(http.requests.slice(1).map(request => [request.url, request.timeout])).toEqual([
      ['https://api.unpaywall.org/v2/10.1/x?email=support@deepstudent.app', 15000],
      [`https://papers.test/same.pdf`, 60000],
    ]);
    expect(store.blobs).toHaveLength(1);
    expect(again.output['results'][0]).toMatchObject({
      success: true, deduplicated: true, file_id: 'file_1', title: 'Again',
      messageKey: 'chat.tools.paper_save.already_exists', messageParams: { fileId: 'file_1' }, index: 0,
    });
    expect(again.snapshots.at(-1)!.papers[0]).toMatchObject({ s: 'done', dedup: true, fid: 'file_1', src: 'Unpaywall' });
  });

  it('RF-W03-paper-save-public-destination: PDF downloads go through ctx.http as public destinations; a blocked target fails only that source', async () => {
    const bytes = pdf(64);
    handlers['/same.pdf'] = serve(bytes);
    handlers['/unpaywall/v2/10.1/x'] = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ oa_locations: [{ url_for_pdf: `https://papers.test/same.pdf` }] }));
    };
    const { executor, http } = await setup();
    await call(executor, 'paper_save', { papers: [{ title: 'Doi', doi: '10.1/x' }] });
    expect(http.requests.map(request => [request.url, request.destination, request.redirect])).toEqual([
      ['https://api.unpaywall.org/v2/10.1/x?email=support@deepstudent.app', undefined, undefined],
      ['https://papers.test/same.pdf', 'public', 'manual'],
    ]);
    await current!.dispose(); current = undefined;

    const blocked: string[] = [];
    const guarded = await setup({ publicHttp: { fetch: async (input, init) => {
      blocked.push(`${String(input)} ${init?.destination}`);
      throw new HttpError('BlockedDestination', String(input), `destination is not public: ${String(input)}`);
    } } });
    const { output } = await call(guarded.executor, 'paper_save', { papers: [{ title: 'Intranet', url: 'https://10.0.0.5/a.pdf' }] });
    expect(blocked).toEqual(['https://10.0.0.5/a.pdf public']);
    expect(output['results']).toEqual([{ index: 0, success: false, title: 'Intranet',
      error: 'All 1 sources failed. Last error: [Direct] PDF download failed: destination is not public: https://10.0.0.5/a.pdf' }]);
  });

  it('RF-W03-paper-save-public-destination: local addresses (Rust allowed http://localhost) are refused without sending a request', async () => {
    const { executor, http } = await setup();
    // Rust's `http://localhost` exemption let a model-supplied URL reach local services such as Ollama.
    const plain = await call(executor, 'paper_save', { papers: [{ title: 'Ollama', url: 'http://localhost:11434/api/tags' }] });
    expect(plain.output['results']).toEqual([{ index: 0, success: false, title: 'Ollama',
      error: 'All 1 sources failed. Last error: [Direct] Only HTTPS URLs are allowed: http://localhost:11434/api/tags' }]);
    const local = ['https://localhost/a.pdf', 'https://LOCALHOST./a.pdf', 'https://api.localhost:8443/a.pdf',
      'https://127.0.0.1/a.pdf', 'https://127.1:11434/a.pdf', 'https://0x7f000001/a.pdf', 'https://[::1]/a.pdf',
      'https://[0:0:0:0:0:0:0:1]/a.pdf', 'https://[::ffff:127.0.0.1]/a.pdf'];
    for (const url of local) {
      const { output } = await call(executor, 'paper_save', { papers: [{ title: 'Local', url }] });
      expect(output['results']).toEqual([{ index: 0, success: false, title: 'Local',
        error: `All 1 sources failed. Last error: [Direct] Local addresses are not allowed: ${url}` }]);
    }
    expect(http.requests).toEqual([]);
  });

  it('RF-W03-paper-save-public-destination: redirects are followed hop by hop as public GETs; a hop to a local address is refused before it is requested', async () => {
    const bytes = pdf(64);
    let localHits = 0;
    handlers['/moved.pdf'] = serve(bytes);
    handlers['/hop'] = (_request, response) => { response.writeHead(302, { location: '/moved.pdf' }); response.end(); };
    handlers['/to-local'] = (_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${port}/ollama` });
      response.end();
    };
    handlers['/ollama'] = (_request, response) => { localHits += 1; response.end('{"models":[]}'); };
    handlers['/loop'] = (_request, response) => { response.writeHead(301, { location: '/loop' }); response.end(); };
    const store = memoryLibrary();
    const { executor, http } = await setup({ library: store });

    const moved = await call(executor, 'paper_save', { papers: [{ title: 'Moved', url: 'https://papers.test/hop' }] });
    expect(moved.output).toMatchObject({ success_count: 1, failed_count: 0 });
    expect(store.created[0]!.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(http.requests.map(request => [request.url, request.destination, request.redirect, request.timeout])).toEqual([
      ['https://papers.test/hop', 'public', 'manual', 60000],
      ['https://papers.test/moved.pdf', 'public', 'manual', expect.any(Number)],
    ]);
    expect(http.requests[1]!.timeout).toBeLessThanOrEqual(60000);
    expect(http.requests[1]!.userAgent).toBe('DeepStudent/1.0 (Academic Paper Save; mailto:support@deepstudent.app)');

    http.requests.length = 0;
    const local = await call(executor, 'paper_save', { papers: [{ title: 'To local', url: 'https://papers.test/to-local' }] });
    expect(local.output['results']).toEqual([{ index: 0, success: false, title: 'To local',
      error: `All 1 sources failed. Last error: [Direct] PDF download failed: redirect to a local address is not allowed: http://127.0.0.1:${port}/ollama` }]);
    expect(http.requests.map(request => request.url)).toEqual(['https://papers.test/to-local']);
    expect(localHits).toBe(0);

    http.requests.length = 0;
    const loop = await call(executor, 'paper_save', { papers: [{ title: 'Loop', url: 'https://papers.test/loop' }] });
    expect(loop.output['results']).toEqual([{ index: 0, success: false, title: 'Loop',
      error: 'All 1 sources failed. Last error: [Direct] PDF download failed: too many redirects' }]);
    expect(http.requests).toHaveLength(10);
  });

  it('RF-W03-paper-save-public-destination: through the real ctx.http policy with allowLoopback false, names resolving to loopback are refused on every hop', async () => {
    const sent: string[] = [];
    const addresses: Record<string, string> = { 'papers.test': '93.184.216.34', 'rebind.test': '127.0.0.1' };
    const publicHttp = createHttpService({
      transport: async (url, init) => {
        sent.push(`${init.redirect} ${url}`);
        if (url === 'https://papers.test/to-loopback') {
          return new Response(null, { status: 307, headers: { location: 'https://127.0.0.1:11434/x.pdf' } });
        }
        if (url === 'https://papers.test/to-intranet') {
          return new Response(null, { status: 302, headers: { location: 'https://10.0.0.5/x.pdf' } });
        }
        if (url === 'https://papers.test/to-rebind') {
          return new Response(null, { status: 302, headers: { location: 'https://rebind.test/x.pdf' } });
        }
        return new Response(new Uint8Array(pdf(32)), { status: 200, headers: { 'content-type': 'application/pdf' } });
      },
      // net-policy admits loopback for `public` (Rust is_safe_remote_url), so a name resolving to 127.0.0.1 passes it.
      isPublicUrl: url => new URL(url).hostname in addresses ? Promise.resolve(true) : isSafeRemoteUrl(url),
      resolveHost: async host => {
        const address = addresses[host];
        if (address === undefined) throw new Error(`unexpected lookup ${host}`);
        return [{ address }];
      },
    });
    expect(await publicHttp.isPublicUrl('https://127.0.0.1:11434/x.pdf')).toBe(true);
    const { executor } = await setup({ publicHttp });
    const { output } = await call(executor, 'paper_save', { papers: [
      { title: 'Loopback', url: 'https://papers.test/to-loopback' },
      { title: 'Intranet', url: 'https://papers.test/to-intranet' },
      { title: 'Rebind', url: 'https://rebind.test/a.pdf' },
      { title: 'To rebind', url: 'https://papers.test/to-rebind' },
      { title: 'Public', url: 'https://papers.test/ok.pdf' },
    ] });
    expect(output['results']).toEqual([
      { index: 0, success: false, title: 'Loopback',
        error: 'All 1 sources failed. Last error: [Direct] PDF download failed: redirect to a local address is not allowed: https://127.0.0.1:11434/x.pdf' },
      { index: 1, success: false, title: 'Intranet',
        error: 'All 1 sources failed. Last error: [Direct] PDF download failed: destination is not a public address (private, link-local, metadata or unresolvable)' },
      { index: 2, success: false, title: 'Rebind',
        error: 'All 1 sources failed. Last error: [Direct] PDF download failed: destination resolves to a non-public address 127.0.0.1' },
      { index: 3, success: false, title: 'To rebind',
        error: 'All 1 sources failed. Last error: [Direct] PDF download failed: destination resolves to a non-public address 127.0.0.1' },
      expect.objectContaining({ index: 4, success: true, title: 'Public' }),
    ]);
    expect(sent).toEqual(['manual https://papers.test/to-loopback', 'manual https://papers.test/to-intranet',
      'manual https://papers.test/to-rebind', 'manual https://papers.test/ok.pdf']);
  });

  it('a failing preview still saves with null pages; per-paper failures are reported without failing the batch', async () => {
    handlers['/ok.pdf'] = serve(pdf(32));
    handlers['/html'] = serve(Buffer.from('<html>login</html>'));
    const store = memoryLibrary({ previewFails: true, pipeline: false });
    const { executor, warnings } = await setup({ library: store });
    const { result, output, snapshots } = await call(executor, 'paper_save', [
      { title: 'Preview less', url: `https://papers.test/ok.pdf` },
      { title: 'Paywalled', url: `https://papers.test/html` },
      { title: 'Plain http', url: 'http://example.org/a.pdf' },
      { title: 'Nothing' },
    ]);
    expect(result.success).toBe(true);
    expect(warnings).toContain("[PaperSave] PDF preview failed for 'Preview less': pdfium unavailable");
    expect(store.created[0]).toMatchObject({ folderId: null, pageCount: null, previewJson: null, extractedText: null });
    expect(output['success_count']).toBe(1);
    expect(output['failed_count']).toBe(3);
    expect(output['results'][0]).toMatchObject({ page_count: null, has_text: false, messageParams: { pageCount: 0, fileId: 'file_1' } });
    expect(output['results'].slice(1)).toEqual([
      { index: 1, success: false, title: 'Paywalled',
        error: 'All 1 sources failed. Last error: [Direct] Downloaded file is not a valid PDF (missing %PDF header)' },
      { index: 2, success: false, title: 'Plain http',
        error: 'All 1 sources failed. Last error: [Direct] Only HTTPS URLs are allowed: http://example.org/a.pdf' },
      { index: 3, success: false, title: 'Nothing', error: 'No URL, arXiv ID, or DOI provided. At least one is required.' },
    ]);
    expect(snapshots.at(-1)!.papers.map(paper => paper['s'])).toEqual(['done', 'error', 'error', 'error']);
    expect(snapshots.at(-1)!.papers[3]).toEqual({ i: 3, t: 'Nothing', s: 'error', pct: 0,
      err: 'No URL, arXiv ID, or DOI provided. At least one is required.' });
  });

  it('accepts the Rust argument shapes: bare array, double-encoded papers, singular paper, whole-string arguments', async () => {
    handlers['/a.pdf'] = serve(pdf(16));
    const { executor } = await setup();
    const paper = { title: 'A', url: `https://papers.test/a.pdf` };
    for (const args of [[paper], { papers: JSON.stringify([paper]) }, { papers: paper }, { paper: [paper] },
      { paper: JSON.stringify(paper) }, paper, JSON.stringify({ papers: [paper] })]) {
      const { result, output } = await call(executor, 'paper_save', args);
      expect(result.success).toBe(true);
      expect(output).toMatchObject({ total: 1, success_count: 1 });
    }
  });

  it('tool-level failures are localized PAPER_OPERATION_FAILED errors with the Rust detail', async () => {
    const { executor } = await setup();
    const cases: Array<[unknown, string]> = [
      [{ papers: [] }, "'papers' array is empty"],
      [{ papers: Array.from({ length: 6 }, (_, i) => ({ title: `p${i}` })) }, 'Batch size 6 exceeds limit 5. Please split into multiple calls.'],
      [{ folder_id: 'x', query: 'y' }, `Missing required parameter 'papers' (array). Got arguments type=object, keys=["folder_id", "query"]`],
      [{ _truncation_error: true, papers: [] }, 'Tool call arguments were truncated by LLM max_tokens limit. Please retry with a shorter prompt.'],
      ['{"x":1}', `After double-decode, still missing 'papers' (array). Parsed keys: Some(["x"])`],
      ['not json', 'Failed to parse arguments string: '],
    ];
    for (const [args, detail] of cases) {
      const { result, events } = await call(executor, 'paper_save', args);
      expect(result.success).toBe(false);
      const error = localized(result.error);
      expect(error).toMatchObject({ code: 'PAPER_OPERATION_FAILED', messageKey: 'chat.tools.paper.error', retryable: false });
      expect(error['detail'].startsWith(detail)).toBe(true);
      expect(events).toEqual(['start', `error:${result.error}`, 'save']);
    }
    const noVfs = await setup({ library: null });
    const missing = await call(noVfs.executor, 'paper_save', { papers: [{ title: 'x' }] });
    expect(localized(missing.result.error)['detail']).toBe('VFS database not available');
  });

  it('cancellation mid-download fails the current paper and stops the batch', async () => {
    const controller = new AbortController();
    handlers['/slow.pdf'] = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/pdf', 'content-length': '1000000' });
      response.write(pdf(100));
      controller.abort();
    };
    const { executor } = await setup();
    const { output } = await call(executor, 'paper_save', { papers: [
      { title: 'Slow', url: `https://papers.test/slow.pdf` }, { title: 'Next', url: `https://papers.test/slow.pdf` },
    ] }, controller.signal);
    expect(output['results']).toEqual([
      { index: 0, success: false, title: 'Slow', error: 'All 1 sources failed. Last error: [Direct] Download cancelled' },
      { index: 1, success: false, error: 'cancelled' },
    ]);
  });

  it('cite_format formats each paper and rejects unknown formats', async () => {
    const { executor } = await setup();
    const papers = [{ title: 'Attention Is All You Need', authors: ['Ashish Vaswani', 'Noam Shazeer'], year: 2017,
      venue: 'NeurIPS', doi: '10.1/x' }];
    const bibtex = await call(executor, 'cite_format', { papers });
    expect(bibtex.result.success).toBe(true);
    expect(bibtex.output).toMatchObject({ format: 'bibtex', count: 1 });
    expect(bibtex.output['citations'][0]['title']).toBe('Attention Is All You Need');
    expect(bibtex.output['citations'][0]['citation']).toMatch(/^@article\{/);
    const apa = await call(executor, 'cite_format', { papers, format: 'apa' });
    expect(apa.output['citations'][0]['citation']).toContain('(2017)');

    const unsupported = await call(executor, 'cite_format', { papers, format: 'mla' });
    expect(localized(unsupported.result.error)['detail']).toBe("Unsupported format: 'mla'. Use 'bibtex', 'gbt7714', or 'apa'.");
    const missing = await call(executor, 'cite_format', { format: 'apa' });
    expect(localized(missing.result.error)['detail']).toBe("Missing required parameter 'papers' (array)");
  });
});
