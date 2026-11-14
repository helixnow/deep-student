/**
 * Golden path ②: a model pointed at the local fake LLM; a streamed reply rendered in the chat window,
 * a mid-stream stop from the UI, and an Agent turn whose `attempt_completion` ends the tool loop.
 */
import { expect, test, type Locator } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from '../support/app.ts';
import { activeSlotDir, query } from '../support/db.ts';
import { collectHealth, describeFailures } from '../support/diagnostics.ts';
import { AGENT_RESULT, REPLY_TEXT, SLOW_CHUNKS, SMOKE_METADATA, startFakeLlm, type FakeLlm } from '../support/fake-llm.ts';
import { configureFakeModel, SMOKE_API_KEY } from '../support/llm-config.ts';
import { passFirstRun, waitForBridge } from '../support/onboarding.ts';

interface ChatBody { model?: string; stream?: boolean; tools?: Array<{ function?: { name?: string } }>; messages?: Array<{ content?: unknown }> }
const toolNames = (body: unknown) => ((body as ChatBody).tools ?? []).map((t) => t.function?.name ?? '');
const fragments = (text: string) => [...text.matchAll(/片段(\d+) /g)].map((m) => Number(m[1]));

test.describe.serial('② LLM config and streaming chat', () => {
  let app: LaunchedApp;
  let llm: FakeLlm;
  let input: Locator;
  let root = '';
  let sessionId = '';

  const chatDb = () => join(activeSlotDir(app.dataDir), 'chat_v2.db');

  test.beforeAll(async () => {
    llm = await startFakeLlm();
    app = await launchApp({ label: 'llm-chat' });
    root = app.root;
    await waitForBridge(app.page);
    await app.call('plugin:host|status', {}, 90_000);
    await passFirstRun(app.page);
    await configureFakeModel(app, llm.baseUrl);
    await app.page.getByTestId('wb-dock-item-chat').click();
    input = app.page.getByTestId('input-bar-v2-textarea').first();
    await expect(input).toBeVisible();
  });
  test.afterAll(async () => {
    await app?.close();
    await llm?.close();
  });

  test('a message streams the full reply into the chat window', async () => {
    const { page } = app;
    await app.mark('chat-send');
    await input.fill('你好，冒烟测试');
    await page.getByTestId('btn-send').first().click();
    await expect(page.getByText(REPLY_TEXT)).toBeVisible();
    await expect(page.getByTestId('btn-send').first()).toBeVisible();

    const [request] = llm.streamRequests();
    expect(llm.streamRequests()).toHaveLength(1);
    expect(request?.authorization).toBe(`Bearer ${SMOKE_API_KEY}`);
    expect((request?.body as ChatBody).model).toBe('fake-chat');
    expect(request?.finished).toBe(true);

    const send = app.wire().find((r) => r.kind === 'renderer-invoke' && r.message?.cmd === 'chat_v2_send_message');
    sessionId = (JSON.parse((send?.message?.payload as { data: string }).data) as { request: { sessionId: string } }).request.sessionId;
    expect(sessionId).toMatch(/^sess_/);
    expect(describeFailures(collectHealth(app, ['chat-send']))).toBe('');
  });

  test('the first turn generates the session title and tags and books round usage (W02 execution-runtime)', async () => {
    // Previously `owner capability unavailable`: no title/tags (session stayed untitled) and no usage rows.
    await expect.poll(() => query<{ title: string | null }>(chatDb(), `select title from chat_v2_sessions where id = '${sessionId}'`)[0]?.title,
      { message: 'session title was not generated from the metadata call' }).toBe(SMOKE_METADATA.title);
    const metadata = llm.metadataRequests();
    expect(metadata, 'exactly one session-metadata call for the first turn').toHaveLength(1);
    expect(JSON.stringify((metadata[0]?.body as ChatBody).messages)).toContain('你好，冒烟测试');
    const tags = query<{ tag: string; tag_type: string }>(chatDb(),
      `select tag, tag_type from chat_v2_session_tags where session_id = '${sessionId}' order by tag`);
    expect(tags.map((t) => t.tag).sort()).toEqual([...SMOKE_METADATA.tags].sort());
    expect(new Set(tags.map((t) => t.tag_type))).toEqual(new Set(['auto']));

    const usage = () => query<{ caller_type: string; model: string; total_tokens: number }>(join(activeSlotDir(app.dataDir), 'llm_usage.db'),
      `select caller_type, model, total_tokens from llm_usage_logs where session_id = '${sessionId}'`);
    await expect.poll(usage, { message: 'the streamed round was not written to the usage ledger' })
      .toEqual([{ caller_type: 'chat_v2', model: 'fake-chat', total_tokens: 15 }]);
    await expect(app.page.getByText(SMOKE_METADATA.title).first()).toBeVisible();
  });

  test('stop during a stream aborts the upstream request and keeps the partial reply', async () => {
    const { page } = app;
    await app.mark('chat-cancel');
    await input.fill('[slow] 请慢慢讲一个长故事');
    await page.getByTestId('btn-send').first().click();
    await expect(page.getByText(/片段5 /)).toBeVisible();
    await page.getByTestId('btn-stop').first().click();
    await expect(page.getByTestId('btn-send').first()).toBeVisible();

    const slow = llm.streamRequests().at(-1)!;
    await expect.poll(() => slow.aborted, { message: 'upstream SSE connection was not closed' }).toBe(true);
    // Chunks already emitted before the abort may still land; the stream must then settle for good.
    const lastFragment = async () => Math.max(...fragments(await page.locator('body').innerText()));
    let previous = -1;
    await expect.poll(async () => {
      const now = await lastFragment();
      const settled = now === previous;
      previous = now;
      return settled;
    }, { intervals: [1_500], timeout: 15_000, message: 'stream kept growing after stop' }).toBe(true);
    expect(slow.chunksSent).toBeLessThan(SLOW_CHUNKS);
    expect(await app.call('chat_v2_has_active_stream', { sessionId })).toBe(false);
    const persisted = query<{ content: string | null }>(chatDb(),
      `select b.content from chat_v2_blocks b join chat_v2_messages m on m.id = b.message_id
        where m.session_id = '${sessionId}' and m.role = 'assistant' order by m.timestamp desc limit 1`);
    // The UI stops rendering on click; chunks the Host emits before it processes chat_v2_cancel_stream are
    // still saved. Everything shown must be saved, plus at most the chunk(s) in flight.
    const saved = Math.max(...fragments(`${persisted[0]?.content ?? ''} `));
    test.info().annotations.push({ type: 'cancel-race', description: `shown up to 片段${previous}, saved up to 片段${saved}` });
    expect(saved, 'the saved partial reply lost text the user saw').toBeGreaterThanOrEqual(previous);
    expect(saved - previous, 'the saved partial reply kept growing well past the stop').toBeLessThanOrEqual(2);
    const stopCalls = app.wire().filter((r) => r.phase === 'chat-cancel' && r.kind === 'renderer-invoke' && r.message?.cmd === 'chat_v2_cancel_stream');
    expect(stopCalls).toHaveLength(1);
    expect(describeFailures(collectHealth(app, ['chat-cancel']))).toBe('');
  });

  test('Agent mode: attempt_completion ends the tool loop', async () => {
    // The desktop UI never sets schemaToolIds (every context type declares `tools: []`), so the Agent turn
    // replays the exact request the UI sent for the first message with schemaToolIds added.
    const send = app.wire().find((r) => r.kind === 'renderer-invoke' && r.message?.cmd === 'chat_v2_send_message');
    const ui = JSON.parse((send?.message?.payload as { data: string }).data) as { request: Record<string, unknown> & { options: Record<string, unknown> } };
    const { userMessageId: _u, assistantMessageId: _a, ...request } = ui.request;
    await app.mark('chat-agent');
    const before = llm.streamRequests().length;
    const messageId = await app.call<string>('chat_v2_send_message', {
      request: { ...request, content: '[agent] 完成这个任务并结束', options: { ...ui.request.options, schemaToolIds: ['attempt_completion'] } },
    }, 30_000);
    expect(messageId).toMatch(/^msg_/);
    await expect.poll(() => llm.streamRequests().length).toBeGreaterThan(before);
    await expect.poll(() => app.call('chat_v2_has_active_stream', { sessionId }), { timeout: 30_000 }).toBe(false);
    await app.page.waitForTimeout(2_000);

    const rounds = llm.streamRequests().slice(before);
    expect(rounds, 'the loop called the model again after attempt_completion').toHaveLength(1);
    expect(toolNames(rounds[0]?.body)).toContain('attempt_completion');
    const blocks = query<{ block_type: string; status: string; tool_name: string; tool_output_json: string }>(chatDb(),
      `select block_type, status, tool_name, tool_output_json from chat_v2_blocks where message_id = '${messageId}'`);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ block_type: 'mcp_tool', status: 'success', tool_name: 'attempt_completion' });
    expect(JSON.parse(blocks[0]!.tool_output_json)).toMatchObject({ completed: true, result: AGENT_RESULT, task_completed: true });
    expect(describeFailures(collectHealth(app, ['chat-agent']))).toBe('');
  });

  test('all three turns are persisted in chat_v2.db', () => {
    const rows = query<{ role: string; block_type: string; content: string | null }>(chatDb(),
      `select m.role, b.block_type, b.content from chat_v2_blocks b join chat_v2_messages m on m.id = b.message_id
        where m.session_id = '${sessionId}' order by m.timestamp, b.block_index`);
    expect(rows.map((r) => `${r.role}:${r.block_type}`)).toEqual([
      'user:content', 'assistant:content', 'user:content', 'assistant:content', 'user:content', 'assistant:mcp_tool',
    ]);
    expect(rows[1]?.content).toBe(REPLY_TEXT);
    expect(fragments(`${rows[3]?.content ?? ''} `).length).toBeGreaterThan(0);
  });

  test('a saved conversation can be loaded again (chat_v2_load_session)', async () => {
    // W10 (799355b9) projects chatParams to the Rust serde field set on save and load, so the debug Host's
    // result contract no longer rejects `modelIdPinnedByUser`.
    const outcome = await app.invoke('chat_v2_load_session', { sessionId });
    expect(outcome.kind, JSON.stringify(outcome)).toBe('result');
    const loaded = (outcome as { value: { session: { id: string; title?: string }; messages: unknown[] } }).value;
    expect(loaded.session).toMatchObject({ id: sessionId, title: SMOKE_METADATA.title });
    expect(loaded.messages).toHaveLength(6);
  });

  test('after a relaunch the conversation reopens from the chat window with its history', async () => {
    await app.close();
    app = await launchApp({ root });
    const { page } = app;
    await waitForBridge(page);
    await app.call('plugin:host|status', {}, 90_000);
    await app.mark('chat-relaunch');
    const skip = page.getByTestId('wb-empty-tour-skip');
    if (await skip.isVisible({ timeout: 5_000 }).catch(() => false)) await skip.click();
    await page.getByTestId('wb-dock-item-chat').click();
    await page.getByText(SMOKE_METADATA.title).first().click();
    await expect(page.getByText(REPLY_TEXT)).toBeVisible();
    await expect(page.getByText('会话加载失败')).toHaveCount(0);
    const loads = app.wire().filter((r) => r.phase === 'chat-relaunch' && r.kind === 'renderer-invoke' && r.message?.cmd === 'chat_v2_load_session');
    expect(loads.length, 'the chat window never loaded the saved session').toBeGreaterThan(0);
    expect(describeFailures(collectHealth(app, ['chat-relaunch']))).toBe('');
  });
});
