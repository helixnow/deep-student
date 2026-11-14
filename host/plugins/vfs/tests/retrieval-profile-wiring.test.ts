/** #27 under the official desktop profile, with no provided services: L12 publishes `retrievalCancellable`,
 * so the central tool runtime advertises and executes rag/unified/web search through the real L04 registry
 * and execution context (builtin_retrieval_executor.rs:836-928). The only fixture is a loopback SearXNG endpoint.
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { CapabilityAcl } from '../../../kernel/acl.ts';
import { loadStartupProfile, OFFICIAL_PROFILE_PATH } from '../../../kernel/profile.ts';
import { PluginAdmin } from '../../../kernel/plugin-admin.ts';
import { UserProfileStore } from '../../../kernel/profile-store.ts';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { BackendEventsSink, ChatV2Emitter, type BackendEvent, type ToolResultInfo } from '../../chat/api.ts';
import type { ToolRuntimeAuthorityOwner, ToolRuntimeTodoOwner } from '../../chat-pipeline/api.ts';
import type { FusedRetrievalHit, UnifiedRetrievalResponse } from '../../vfs-index/api.ts';
import type { ApiConfig } from '../../llm/api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import { localizedRetrievalFailure } from '../src/tools/retrieval-executor.ts';

const SESSION = 'sess-retrieval-profile';
const RETRIEVAL_TOOLS = ['builtin-rag_search', 'builtin-multimodal_search', 'builtin-unified_search', 'builtin-web_search'];
const searches: string[] = [];
const searxng = createServer((request, response) => {
  const query = new URL(request.url ?? '/', 'http://searxng.test').searchParams.get('q') ?? '';
  searches.push(query);
  if (query === 'denied') {
    response.writeHead(403, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'invalid api key' }));
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ results: [{ title: '特征值与特征向量', url: 'https://math.example.edu/eigen', content: '特征值满足 Av = λv。' }] }));
});
const unreachable = (): never => { throw new Error('authority/todo owners are outside the retrieval tool path'); };
const authority: ToolRuntimeAuthorityOwner = { getSessionAuthorityState: unreachable, createPendingPlan: unreachable,
  setSessionPlanState: unreachable, consumeSessionPlanBinding: unreachable };
const todo: ToolRuntimeTodoOwner = { getTodoList: unreachable, persistTodoList: unreachable };

let root = '';
let host: TestHost;
let noteResource = '';
let memoryNote = '';

beforeAll(async () => {
  searxng.listen(0, '127.0.0.1'); await once(searxng, 'listening');
  root = await mkdtemp(join(tmpdir(), 'dstu-retrieval-profile-'));
  vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
  vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
  vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
  vi.stubEnv('SEARXNG_ENDPOINT', `http://127.0.0.1:${(searxng.address() as AddressInfo).port}`);
  host = await createTestHost({ app: { dataDir: join(root, 'app'), platform: 'linux' }, acl: CapabilityAcl.fromDirectory('linux') });
  new PluginAdmin({ runtime: host.runtime, official: OFFICIAL_PROFILE_PATH,
    store: new UserProfileStore(join(host.app.dataDir, 'plugins/user.profile.json'), OFFICIAL_PROFILE_PATH) }).register();
  const loaded = await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH });
  expect(loaded.degraded).toEqual([]);
  host.ctx.chatSession.createSession({ id: SESSION, mode: 'chat', titleLocked: true, persistStatus: 'active',
    createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z' });
  noteResource = indexedNote('线性代数笔记', '特征值分解把矩阵写成 PDP⁻¹').resourceId;
  // A note under the memory root, without memory_write's fire-and-forget post-write indexing.
  const memoryRoot = await host.invoke('memory_get_or_create_root_folder', {}) as string;
  memoryNote = indexedNote('学习偏好', '讲特征值时偏好用图解').id;
  await host.invoke('dstu_folder_add_item', { folderId: memoryRoot, itemType: 'note', itemId: memoryNote });
}, 120_000);
function indexedNote(title: string, content: string) {
  const note = host.ctx.notes.repository.createNote({ title, content, tags: [] }, host.ctx.vfsDatabase.getConnSafe());
  expect(host.ctx.vfsUnitBuilder.syncResourceUnits({ resourceId: note.resourceId, resourceType: 'note', data: content })).toHaveLength(1);
  return note;
}
beforeEach(() => { host.events.length = 0; searches.length = 0; });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  await host?.dispose();
  searxng.close();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

type Runtime = ReturnType<TestHost['ctx']['chatPipeline']['bindToolRuntime']>;
type Init = Parameters<Runtime['execute']>[1];
const emitter = () => new ChatV2Emitter(new BackendEventsSink(host.ctx.backendEvents), SESSION, false);
function init(callId: string): Init {
  return { sessionId: SESSION, messageId: 'msg-retrieval-profile', blockId: `blk-${callId}`, emitter: emitter(), toolCallId: callId,
    canvasNoteId: null, ragTopK: null, ragEnableReranking: null, variantId: null, skillStateVersion: null, roundId: null,
    executionAllowedTools: null, skillPackageRoots: null, questionAuthoringConfig: null, shellGuardApproved: false,
    memoryEnabled: true, ragEnabled: true, webSearchEnabled: true, shellAuthorityAdmission: null, skillContents: null,
    skillEmbeddedTools: null, skillAdmissionErrors: null, cancellation: null,
    dispatcher: unreachable, admittedDispatcher: { dispatchWithAdmission: unreachable } as unknown as Init['admittedDispatcher'] };
}
function run(name: string, args: JsonValue): Promise<ToolResultInfo> {
  const runtime = host.ctx.chatPipeline.bindToolRuntime(authority, todo);
  return runtime.execute({ id: `call-${name}`, name, arguments: args }, init(`call-${name}`));
}
/** The registered planned executor under a real L04 execution context carrying `signal`. */
function plannedExecutor(signal: AbortSignal) {
  const executor = host.ctx.agentTools.toolExecutors().find(entry => entry.canHandle('builtin-rag_search'));
  const context = host.ctx.chatSession.createExecutionContext({ sessionId: SESSION, messageId: 'msg-retrieval-cancel',
    blockId: 'blk-retrieval-cancel', emitter: emitter(), services: host.ctx, window: null, toolRegistry: host.ctx.mcp.registry });
  const scoped = context.scopedWithCancellationToken(signal);
  return (name: string, args: JsonValue) =>
    executor!.execute!({ id: 'call-cancel', name, arguments: args }, scoped) as Promise<ToolResultInfo>;
}
const phases = () => (host.eventsNamed(`chat_v2_event_${SESSION}`) as BackendEvent[]).map(event => [event.type, event.phase]);
const detail = (result: ToolResultInfo) => (JSON.parse(result.error!) as { detail: string }).detail;
const sourceIds = (result: ToolResultInfo) => (result.output as { sources: { resourceId?: string; noteId?: string | null }[] }).sources;

it('advertises every retrieval tool through split BuiltinRetrievalExecutor registrations', () => {
  const runtime = host.ctx.chatPipeline.bindToolRuntime(authority, todo);
  const registered = host.ctx.agentTools.toolExecutors().filter(entry => entry.name() === 'BuiltinRetrievalExecutor');
  expect(registered).toHaveLength(2);
  for (const tool of RETRIEVAL_TOOLS) {
    expect(runtime.advertisement!.advertises(tool)).toBe(true);
    expect(registered.filter(entry => entry.canHandle(tool))).toHaveLength(1);
  }
});

it('rag_search runs the real L12 lexical route without embeddings and excludes memory notes from knowledge sources', async () => {
  const result = await run('builtin-rag_search', { query: '特征值' });
  expect(result.success, result.error ?? '').toBe(true);
  expect(sourceIds(result)).toEqual([expect.objectContaining({ resourceId: noteResource, citationTag: '[知识库-1]',
    title: '线性代数笔记', source_type: 'text_search' })]);
  expect(result.output).toMatchObject({ success: true, source: 'rag_search', routeFailures: [],
    rerank: { requested: true, applied: false }, retrievalPlan: { routes: [{ routeId: 'fts', kind: 'full_text' }] },
    capabilitySnapshot: { textEmbedding: { configured: false } } });
  expect(phases()).toEqual([['rag', 'start'], ['rag', 'end']]);
});

it('unified_search adds the memory route to the knowledge results', async () => {
  const result = await run('builtin-unified_search', { query: '特征值' });
  expect(result.success, result.error ?? '').toBe(true);
  expect(sourceIds(result)).toEqual([
    expect.objectContaining({ resourceId: noteResource, citationTag: '[知识库-1]' }),
    expect.objectContaining({ noteId: memoryNote, citationTag: '[记忆-1]', source_type: 'memory' }),
  ]);
  expect(result.output).toMatchObject({ source: 'unified_search', routeFailures: [] });
  expect(phases()).toEqual([['rag', 'start'], ['rag', 'end']]);
});

it('an answer citing the unified_search [记忆-N] source marks that memory note used (persistence.rs:252,1606)', async () => {
  const result = await run('builtin-unified_search', { query: '特征值' });
  expect(result.success, result.error ?? '').toBe(true);
  const cited = host.ctx.chatPipeline.extractCitedMemoryNoteIds('讲解时用图解 [记忆-1]，定义见 [知识库-1]。', [result]);
  expect(cited).toEqual([memoryNote]);
  expect(host.ctx.chatPipeline.extractCitedMemoryNoteIds('定义见 [知识库-1]。', [result])).toEqual([]);
  host.ctx.memory.recordUsed(cited);
  const tags = JSON.parse(host.ctx.vfsDatabase.getConnSafe()
    .get<{ tags: string }>('SELECT tags FROM notes WHERE id = ?', [memoryNote])!.tags) as string[];
  expect(tags).toContain('_used:1');
});

it('web_search runs L19 against the configured SearXNG endpoint', async () => {
  const result = await run('builtin-web_search', { query: '特征值', engine: 'searxng' });
  expect(result.success, result.error ?? '').toBe(true);
  expect(searches).toEqual(['特征值']);
  expect(result.output).toMatchObject({ success: true, count: 1, sources: [{ index: 1, citationTag: '[搜索-1]',
    title: '特征值与特征向量', url: 'https://math.example.edu/eigen',
    snippet: '特征值与特征向量 — 特征值满足 Av = λv。\nhttps://math.example.edu/eigen', source_type: 'web_search' }] });
  expect(phases()).toEqual([['web_search', 'start'], ['web_search', 'end']]);
});

it('a rejected retrieval request returns the Rust localized failure after the rag start event', async () => {
  const result = await run('builtin-rag_search', {});
  expect(result.success).toBe(false);
  expect(result.error).toBe(localizedRetrievalFailure("Invalid argument 'query': query payload does not match Text mode (text=false, image=false)"));
  expect(phases()).toEqual([['rag', 'start'], ['rag', 'error']]);
});

it('a provider rejection emits the web_search error event and returns that message as the localized failure', async () => {
  const result = await run('builtin-web_search', { query: 'denied', engine: 'searxng' });
  expect(result.success).toBe(false);
  expect(searches).toEqual(['denied']);
  const events = host.eventsNamed(`chat_v2_event_${SESSION}`) as (BackendEvent & { error?: string })[];
  expect(phases()).toEqual([['web_search', 'start'], ['web_search', 'error']]);
  expect(events[1]!.error).toContain('searxng http 403');
  expect(result.error).toBe(localizedRetrievalFailure(events[1]!.error!));
});

it('cancellation before start runs no retrieval and returns the Rust message', async () => {
  const search = vi.spyOn(host.ctx.retrieval, 'search');
  const controller = new AbortController();
  controller.abort();
  const result = await plannedExecutor(controller.signal)('builtin-unified_search', { query: '特征值' });
  expect(detail(result)).toBe('Unified retrieval cancelled before start');
  expect(search).not.toHaveBeenCalled();
  expect(phases()).toEqual([]);
});

it.each([
  ['builtin-rag_search', 'search', 'Unified retrieval cancelled during execution'],
  ['builtin-multimodal_search', 'searchMultimodal', 'Multimodal retrieval cancelled during execution'],
] as const)('cancelling %s mid-retrieval returns the Rust message and discards the late result', async (tool, method, message) => {
  const late = await host.ctx.retrieval.search({ queryText: '特征值', queryImageBase64: null, queryImageMediaType: null,
    queryModality: 'text', topK: 10, folderIds: null, resourceIds: null, resourceTypes: null });
  let finish!: (response: UnifiedRetrievalResponse) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(host.ctx.retrieval, method).mockImplementation(() => { entered(); return new Promise(resolve => { finish = resolve; }); });
  const controller = new AbortController();
  const pending = plannedExecutor(controller.signal)(tool, { query: '特征值' });
  await started;
  controller.abort();
  const result = await pending;
  expect(result.success).toBe(false);
  expect(detail(result)).toBe(message);
  finish(late);
  await new Promise(resolve => setImmediate(resolve));
  expect(phases()).toEqual([['rag', 'start'], ['rag', 'error']]);
});

it('multimodal_search hands the stored page image to the VL reranker from the chat-pipeline services context', async () => {
  const database = host.ctx.vfsDatabase;
  const page = Buffer.from('page-0-png-bytes');
  const blob = host.ctx.vfsRepo.blobs.storeBlob(database.getConnSafe(), database.blobsDir(), page, 'image/png', 'png');
  const base = await host.ctx.retrieval.search({ queryText: '特征值', queryImageBase64: null, queryImageMediaType: null,
    queryModality: 'text', topK: 10, folderIds: null, resourceIds: null, resourceTypes: null });
  const hit: FusedRetrievalHit = { rrfScore: 0.5, provenance: [], hit: { identity: { resourceId: 'tb_page_res', chunkIndex: 0, pageIndex: 0 },
    embeddingId: 'emb-page-0', text: '第 1 页：特征值', title: '线性代数讲义', resourceType: 'textbook', sourceId: null,
    folderId: null, blobHash: blob.hash, imageUrl: null, rawScore: 0.8, metadata: null } };
  vi.spyOn(host.ctx.retrieval, 'searchMultimodal').mockResolvedValue({ ...base, result: { hits: [hit], failures: [] } });
  vi.spyOn(host.ctx.llmReranker, 'getVlRerankerModelConfig')
    .mockResolvedValue({ id: 'vl-reranker', enabled: true, isReranker: true, isMultimodal: true } as ApiConfig);
  const rerank = vi.spyOn(host.ctx.llmReranker, 'callMultimodalRerankerApi').mockResolvedValue([{ index: 0, relevance_score: 0.9 }]);
  const result = await run('builtin-multimodal_search', { query: '特征值' });
  expect(result.success, result.error ?? '').toBe(true);
  expect(rerank.mock.calls.map(([, docs]) => docs)).toEqual([
    [{ text: '第 1 页：特征值', image: { data: page.toString('base64'), media_type: 'image/png' } }]]);
  expect(result.output).toMatchObject({ rerank: { requested: true, applied: true }, routeFailures: [] });
});

it('without the memory owner the planned tools are withheld while web_search still runs', async () => {
  await host.runtime.unload('dstu.memory');
  const runtime = host.ctx.chatPipeline.bindToolRuntime(authority, todo);
  expect(RETRIEVAL_TOOLS.filter(tool => runtime.advertisement!.advertises(tool))).toEqual(['builtin-web_search']);
  expect(host.ctx.agentTools.toolExecutors().filter(entry => entry.name() === 'BuiltinRetrievalExecutor')).toHaveLength(1);
  const result = await run('builtin-web_search', { query: '特征值', engine: 'searxng' });
  expect(result.success, result.error ?? '').toBe(true);
  expect(phases()).toEqual([['web_search', 'start'], ['web_search', 'end']]);
});
