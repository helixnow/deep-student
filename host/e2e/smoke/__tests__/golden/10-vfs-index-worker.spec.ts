/**
 * vfs-index resident worker (W04, Rust `VfsIndexWorker` / `vfs/index_worker.rs`): nothing but the worker's
 * own loop drives the index queue. A text file is imported from the Files app (新建 › 导入资料…, the
 * native open dialog answered in the main process), then:
 *
 * 1. with no embedding model configured the worker still prepares index units for the pending resource
 *    (`prepare_units_without_embedding`) and never calls an embedding endpoint;
 * 2. once a (fake) embedding model is assigned, the next ticks index the resource: the embeddings endpoint
 *    is called with the imported text and `resources.index_state` reaches `indexed` with segments written;
 * 3. once a (fake) reranker is assigned, `vfs_rag_search` and the chat `unified_search` tool send the hits to
 *    `/rerank` and return the reranker's scores in its order.
 *
 * No indexing command is invoked by the test; the default interval is 5s.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from '../support/app.ts';
import { activeSlotDir, query } from '../support/db.ts';
import { collectHealth, describeFailures } from '../support/diagnostics.ts';
import { answerNextOpenDialog } from '../support/dialogs.ts';
import { rerankScore, startFakeLlm, type FakeLlm } from '../support/fake-llm.ts';
import { configureFakeModel, SMOKE_API_KEY, SMOKE_VENDOR_ID } from '../support/llm-config.ts';
import { passFirstRun, waitForBridge } from '../support/onboarding.ts';
import { openDockApp } from '../support/renderer.ts';

const FILE_NAME = 'smoke-index.txt';
const MARKER = 'SMOKE-INDEX-光合作用';
const BODY = `${MARKER}\n叶绿体利用光能把二氧化碳和水合成有机物，并释放氧气。\n`;
const EMBED_PROFILE_ID = 'smoke-embed';
const RERANK_PROFILE_ID = 'smoke-rerank';

interface ResourceRow { id: string; index_state: string | null; index_error: string | null }

const focused = (page: Page) => page.locator('[data-wb-window][data-focused="true"]');

test.describe.serial('⑩ vfs-index resident worker', () => {
  let app: LaunchedApp;
  let llm: FakeLlm;
  let resourceId = '';
  const vfsDb = () => join(activeSlotDir(app.dataDir), 'databases', 'vfs.db');
  const resource = () => query<ResourceRow>(vfsDb(), `select id, index_state, index_error from resources where id = '${resourceId}'`)[0];
  const units = () => query<{ n: number }>(vfsDb(), `select count(*) as n from vfs_index_units where resource_id = '${resourceId}'`)[0]!.n;

  test.beforeAll(async () => {
    llm = await startFakeLlm();
    app = await launchApp({ label: 'vfs-index' });
    await waitForBridge(app.page);
    await app.call('plugin:host|status', {}, 90_000);
    await passFirstRun(app.page);
    await configureFakeModel(app, llm.baseUrl);
  });
  test.afterAll(async () => {
    await app?.close();
    await llm?.close();
  });

  test('an imported file gets index units without an embedding model (no embedding call)', async () => {
    const { page } = app;
    const dir = join(app.root, 'import');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, FILE_NAME);
    writeFileSync(file, BODY);

    await app.mark('index-import');
    await openDockApp(page, 'files');
    await answerNextOpenDialog(app, [file]);
    await focused(page).getByRole('button', { name: /^新建$/ }).first().click();
    await page.getByRole('menuitem', { name: '导入资料…' }).click();
    await expect(focused(page).getByText(FILE_NAME.replace(/\.txt$/, '')).first()).toBeVisible({ timeout: 30_000 });

    await expect.poll(() => query<{ id: string }>(vfsDb(), `select id from resources where data like '%${MARKER}%' and deleted_at is null`).map((r) => r.id),
      { message: 'import did not create a resource holding the file text' }).toHaveLength(1);
    resourceId = query<{ id: string }>(vfsDb(), `select id from resources where data like '%${MARKER}%' and deleted_at is null`)[0]!.id;

    await expect.poll(units, { timeout: 30_000, message: 'worker never prepared index units for the pending resource' }).toBeGreaterThan(0);
    expect(resource()?.index_state ?? 'pending').not.toBe('indexed');
    expect(llm.embeddingRequests(), 'no embedding model is configured yet').toEqual([]);
    expect(describeFailures(collectHealth(app, ['index-import']))).toBe('');
  });

  test('after an embedding model is assigned the worker indexes the resource', async () => {
    await app.mark('index-embed');
    const profiles = await app.call<Array<{ id: string }>>('get_model_profiles');
    await app.call('save_model_profiles', {
      profiles: [...profiles.filter((p) => p.id !== EMBED_PROFILE_ID), {
        id: EMBED_PROFILE_ID, vendorId: SMOKE_VENDOR_ID, label: 'Smoke Fake Embedding', model: 'fake-embed', modelAdapter: 'general',
        enabled: true, isMultimodal: false, isReasoning: false, isEmbedding: true, isReranker: false, supportsTools: false,
      }],
    });
    const assignments = await app.call<Record<string, unknown>>('get_model_assignments');
    await app.call('save_model_assignments', { assignments: { ...assignments, embedding_model_config_id: EMBED_PROFILE_ID } });

    await expect.poll(() => resource()?.index_state, { timeout: 60_000, message: 'worker never indexed the resource' }).toBe('indexed');
    expect(resource()?.index_error ?? null).toBeNull();
    const requests = llm.embeddingRequests();
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => (r.body as { model?: string }).model === 'fake-embed')).toBe(true);
    expect(JSON.stringify(requests.map((r) => (r.body as { input?: unknown }).input))).toContain(MARKER);
    const segments = query<{ n: number }>(vfsDb(),
      `select count(*) as n from vfs_index_segments s join vfs_index_units u on u.id = s.unit_id where u.resource_id = '${resourceId}' and s.modality = 'text'`)[0]!.n;
    expect(segments).toBeGreaterThan(0);
    expect(describeFailures(collectHealth(app, ['index-embed']))).toBe('');
  });

  /** The one `/rerank` request made since `before` carried the marker hits; returns the reranker's scores, best first. */
  function expectRerankRequest(before: number): number[] {
    const requests = llm.rerankRequests().slice(before);
    expect(requests.length, 'the rerank endpoint was called once').toBe(1);
    const body = requests[0]!.body as { model?: string; query?: string; documents?: string[] };
    expect(body.model).toBe('fake-rerank');
    expect(body.query).toBe(MARKER);
    expect(JSON.stringify(body.documents)).toContain(MARKER);
    expect(requests[0]!.authorization).toBe(`Bearer ${SMOKE_API_KEY}`);
    const count = body.documents!.length;
    return body.documents!.map((_, i) => Math.fround(rerankScore(i, count))).sort((a, b) => b - a);
  }

  test('with a reranker assigned, vfs_rag_search reranks through the llm rerank service on the request flag alone (W05, RF-W04-rag-search-rerank-flag)', async () => {
    await app.mark('rag-rerank');
    const profiles = await app.call<Array<{ id: string }>>('get_model_profiles');
    await app.call('save_model_profiles', {
      profiles: [...profiles.filter((p) => p.id !== RERANK_PROFILE_ID), {
        id: RERANK_PROFILE_ID, vendorId: SMOKE_VENDOR_ID, label: 'Smoke Fake Reranker', model: 'fake-rerank', modelAdapter: 'general',
        enabled: true, isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: true, supportsTools: false,
      }],
    });
    const assignments = await app.call<Record<string, unknown>>('get_model_assignments');
    await app.call('save_model_assignments', { assignments: { ...assignments, reranker_model_config_id: RERANK_PROFILE_ID } });
    // RF-W04-rag-search-rerank-flag (#26): the request's enableReranking decides alone. The stored `search.enable_reranking`
    // that Rust indexing.rs:5221/5249 also required stays at the migration's 'false' (no UI writes it).
    expect(await app.call('vfs_get_indexing_config', { key: 'search.enable_reranking' })).toBe('false');
    const unranked = llm.rerankRequests().length;
    await app.call('vfs_rag_search', { input: { query: MARKER, topK: 5, enableReranking: false } });
    expect(llm.rerankRequests().length, 'enableReranking: false makes no rerank request').toBe(unranked);

    const before = llm.rerankRequests().length;
    const out = await app.call<{ results: Array<{ resourceId: string; score: number }> }>(
      'vfs_rag_search', { input: { query: MARKER, topK: 5, enableReranking: true } });
    test.info().annotations.push({ type: 'rag-rerank', description: JSON.stringify(out.results.map((r) => [r.resourceId, r.score])) });
    const expected = expectRerankRequest(before);
    expect(out.results.map((r) => r.resourceId)).toContain(resourceId);
    expect(out.results.map((r) => r.score), 'scores are the reranker\'s, in its order').toEqual(expected.slice(0, out.results.length));
    expect(describeFailures(collectHealth(app, ['rag-rerank']))).toBe('');
  });

  test('the chat unified_search tool reranks the hits it finds', async () => {
    // The model sees build_numbered_sources (Rust builtin_retrieval_executor.rs:1082-1107): resourceId is flat on each source.
    type SearchOutput = { rerank?: { requested: boolean; applied: boolean }; sources?: Array<{ score: number; resourceId?: string }> };
    let searched: (SearchOutput & { result?: SearchOutput }) | undefined;
    const before = llm.rerankRequests().length;
    llm.script = (turn) => {
      if (!turn.called('load_skills')) return { toolCalls: [{ tool: 'load_skills', arguments: { skills: ['knowledge-retrieval'] } }] };
      if (!turn.called('unified_search')) return { toolCalls: [{ tool: 'unified_search', arguments: { query: MARKER, top_k: 5 } }] };
      searched = turn.called('unified_search')!.result as typeof searched;
      return { text: 'SMOKE-RERANK-DONE' };
    };
    await app.mark('chat-rerank');
    await openDockApp(app.page, 'chat');
    await focused(app.page).getByTestId('input-bar-v2-textarea').fill('在资料库里检索光合作用');
    await focused(app.page).getByTestId('btn-send').click();
    await expect(app.page.getByText(/SMOKE-RERANK-DONE|FAKE-LLM-TOOL-NOT-OFFERED/)).toBeVisible({ timeout: 60_000 });
    llm.script = null;
    const out: SearchOutput | undefined = searched?.result ?? searched;
    test.info().annotations.push({ type: 'chat-rerank', description: JSON.stringify({ rerank: out?.rerank, sources: out?.sources?.map((s) => [s.resourceId, s.score]) }) });
    expect(out?.rerank).toEqual({ requested: true, applied: true });
    const expected = expectRerankRequest(before);
    const sources = out?.sources ?? [];
    expect(sources.map((s) => s.resourceId)).toContain(resourceId);
    expect(sources.map((s) => s.score)).toEqual(expected.slice(0, sources.length));
  });
});
