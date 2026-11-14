/**
 * Agent tool calls end to end: the fake LLM answers with tool calls, the real Host tool loop runs the real
 * executors, results land in chat_v2.db / the domain stores, and the desktop windows render them. Every turn
 * is sent from the chat input; tools reach the model through progressive disclosure (`load_skills`), as in
 * the shipped frontend (`collectMcpToolSchemas` only ever offers `load_skills` plus loaded skills' tools).
 */
import { expect, test, type Locator } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp, type WireRow } from '../support/app.ts';
import { activeSlotDir, query } from '../support/db.ts';
import { collectHealth, describeFailures } from '../support/diagnostics.ts';
import { startFakeLlm, toolNamesOf, type FakeLlm, type RecordedRequest, type ScriptTurn, type ScriptedReply } from '../support/fake-llm.ts';
import { configureFakeModel } from '../support/llm-config.ts';
import { passFirstRun, waitForBridge } from '../support/onboarding.ts';
import { clickDock, openDockApp } from '../support/renderer.ts';

interface BlockRow {
  block_type: string; status: string; tool_name: string | null;
  tool_input_json: string | null; tool_output_json: string | null; content: string | null; error: string | null;
}
interface LoadSkillsResult { result: { loaded_skill_ids: string[]; available_skill_ids: string[] } }

const QBANK_NAME = 'SMOKE-QBANK';
const strip = (name: string) => name.replace(/^builtin[-_:]/, '');

test.describe.serial('⑥ agent tool calls', () => {
  let app: LaunchedApp;
  let llm: FakeLlm;
  let input: Locator;
  let examId = '';
  let availableSkills: string[] = [];

  const chatDb = () => join(activeSlotDir(app.dataDir), 'chat_v2.db');
  const vfsDb = () => join(activeSlotDir(app.dataDir), 'databases', 'vfs.db');

  /** Bring the chat window to the front: a maximised window on top leaves the chat input rendered but covered. */
  async function openChat() {
    const focusedInput = app.page.locator('[data-wb-window][data-focused="true"]').getByTestId('input-bar-v2-textarea');
    if (!(await focusedInput.isVisible())) await clickDock(app.page, 'wb-dock-item-chat');
    await expect(focusedInput).toBeVisible();
  }

  const openApp = (id: string) => openDockApp(app.page, id);

  /** Send `prompt` from the chat input with `script` playing the model; resolves once the turn settled. */
  async function runTurn(phase: string, prompt: string, script: (turn: ScriptTurn) => ScriptedReply | undefined,
    during?: () => Promise<void>) {
    await app.mark(phase);
    // Rounds are the streaming requests; the post-turn session-metadata call is not part of the tool loop.
    const before = llm.streamRequests().length;
    llm.script = script;
    await openChat();
    await input.fill(prompt);
    await app.page.getByTestId('btn-send').first().click();
    await expect.poll(() => llm.streamRequests().length).toBeGreaterThan(before);
    await during?.();
    await expect(app.page.getByTestId('btn-send').first()).toBeVisible({ timeout: 60_000 });
    await app.page.waitForTimeout(1_000);
    llm.script = null;
    const rounds = llm.streamRequests().slice(before);
    test.info().annotations.push({ type: `${phase}-rounds`, description: rounds.map((r) => toolNamesOf(r.body).length).join(',') });
    return { rounds, blocks: lastAssistantBlocks() };
  }

  function lastAssistantBlocks(): BlockRow[] {
    return query<BlockRow>(chatDb(),
      `select b.block_type, b.status, b.tool_name, b.tool_input_json, b.tool_output_json, b.content, b.error
         from chat_v2_blocks b where b.message_id = (
           select id from chat_v2_messages where role = 'assistant' order by timestamp desc limit 1)
        order by b.block_index`);
  }

  const toolBlocks = (blocks: BlockRow[]) => blocks.filter((b) => b.tool_name !== null)
    .map((b) => `${strip(b.tool_name!)}:${b.status}`);
  const output = <T>(blocks: BlockRow[], tool: string): T =>
    JSON.parse(blocks.find((b) => b.tool_name !== null && strip(b.tool_name) === tool)?.tool_output_json ?? 'null') as T;
  const finalText = (blocks: BlockRow[]) => blocks.filter((b) => b.block_type === 'content').map((b) => b.content ?? '').join('');
  const emitted = (phase: string, event: string): WireRow[] => app.wire().filter((r) => r.phase === phase
    && r.kind === 'renderer-result' && r.message?.type === 'emit-js' && r.message?.event === event);

  test.beforeAll(async () => {
    llm = await startFakeLlm();
    app = await launchApp({ label: 'agent-tools' });
    await waitForBridge(app.page);
    await app.call('plugin:host|status', {}, 90_000);
    await passFirstRun(app.page);
    await configureFakeModel(app, llm.baseUrl);
    input = app.page.getByTestId('input-bar-v2-textarea').first();
    await openChat();
  });
  test.afterAll(async () => {
    if (app && llm) {
      writeFileSync(join(app.root, 'llm-requests.json'),
        `${JSON.stringify(llm.chatRequests().map((r) => ({ tools: toolNamesOf(r.body), body: r.body })), null, 2)}\n`);
    }
    await app?.close();
    await llm?.close();
  });

  test('qbank: load_skills → qbank_create_question ×2 → qbank_list_questions (W03 QBankExecutor)', async () => {
    const exam = await app.call<{ id: string }>('dstu_create', { path: '/', options: { type: 'exam', name: QBANK_NAME } });
    examId = exam.id;
    const { rounds, blocks } = await runTurn('agent-qbank', '帮我往冒烟题库里加两道题', (turn) => {
      if (!turn.called('load_skills')) return { toolCalls: [{ tool: 'load_skills', arguments: { skills: ['qbank-tools', 'review-planning'] } }] };
      if (!turn.called('qbank_create_question')) {
        return { toolCalls: [
          { tool: 'qbank_create_question', arguments: { session_id: examId, content: 'SMOKE-Q1 1+1=?', answer: '2', question_type: 'short_answer' } },
          { tool: 'qbank_create_question', arguments: { session_id: examId, content: 'SMOKE-Q2 地球是圆的', answer: 'true', question_type: 'true_false' } },
        ] };
      }
      if (!turn.called('qbank_list_questions')) return { toolCalls: [{ tool: 'qbank_list_questions', arguments: { session_id: examId } }] };
      const listed = turn.called('qbank_list_questions')?.result as { total?: number } | undefined;
      return { text: `SMOKE-QBANK-DONE total=${listed?.total}` };
    });

    expect(toolNamesOf(rounds[0]?.body), 'a fresh chat turn offers only the load_skills meta-tool').toEqual(['builtin-load_skills']);
    expect(rounds.map((r) => toolNamesOf(r.body).some((n) => strip(n) === 'qbank_create_question'))).toEqual([false, true, true, true]);
    expect(toolBlocks(blocks)).toEqual(['load_skills:success', 'qbank_create_question:success', 'qbank_create_question:success', 'qbank_list_questions:success']);
    expect(finalText(blocks)).toBe('SMOKE-QBANK-DONE total=2');
    availableSkills = output<LoadSkillsResult>(blocks, 'load_skills').result.available_skill_ids;

    const stored = query<{ content: string; exam_id: string }>(vfsDb(), `select content, exam_id from questions where exam_id = '${examId}' and deleted_at is null order by content`);
    expect(stored.map((q) => q.content)).toEqual(['SMOKE-Q1 1+1=?', 'SMOKE-Q2 地球是圆的']);
    expect(emitted('agent-qbank', 'qbank://changed').filter((r) => (r.message?.ids as unknown[] | undefined)?.length), 'qbank://changed never reached a renderer listener').toHaveLength(2);
    await expect(app.page.getByText('SMOKE-QBANK-DONE total=2')).toBeVisible();
    await app.page.screenshot({ path: join(app.root, 'agent-qbank.png') });
    expect(describeFailures(collectHealth(app, ['agent-qbank']))).toBe('');
  });

  test('review: review_plan_generate broadcasts review://changed and the open review plan refreshes itself (W03)', async () => {
    const { page } = app;
    await app.mark('review-open');
    await openApp('exam');
    await page.getByRole('option', { name: QBANK_NAME }).click();
    await page.locator('[data-exam-tab]', { hasText: '做题' }).click();
    await page.locator('[data-exam-tab]', { hasText: '更多' }).click();
    await page.getByRole('menuitem', { name: '复习计划' }).click();
    const planView = page.getByRole('heading', { name: '复习计划', level: 2 });
    await expect(planView).toBeVisible();
    await expect(page.getByText('还没有复习计划')).toBeVisible();

    const { blocks } = await runTurn('agent-review', '把这个题库加入间隔复习', (turn) => {
      if (!turn.called('review_plan_generate')) return { toolCalls: [{ tool: 'review_plan_generate', arguments: { exam_id: examId } }] };
      if (!turn.called('review_get_due')) return { toolCalls: [{ tool: 'review_get_due', arguments: { exam_id: examId } }] };
      return { text: 'SMOKE-REVIEW-DONE' };
    });
    expect(toolBlocks(blocks)).toEqual(['review_plan_generate:success', 'review_get_due:success']);
    const plans = query<{ status: string }>(vfsDb(), `select status from review_plans where exam_id = '${examId}'`);
    expect(plans).toHaveLength(2);

    const changed = emitted('agent-review', 'review://changed');
    expect(changed.length, 'review://changed was not broadcast to the renderer').toBeGreaterThan(0);
    expect(changed.every((r) => ((r.message?.ids as unknown[] | undefined)?.length ?? 0) > 0), 'review://changed reached no listener').toBe(true);
    const refreshAfterEvent = app.wire().filter((r) => r.phase === 'agent-review' && r.kind === 'renderer-invoke'
      && r.time > changed[0]!.time && ['review_plan_get_due', 'review_plan_get_due_with_filter', 'review_plan_refresh_stats'].includes(String(r.message?.cmd)));
    expect(refreshAfterEvent.map((r) => r.message?.cmd), 'ReviewPlanView did not reload after review://changed').toEqual(
      expect.arrayContaining(['review_plan_get_due', 'review_plan_refresh_stats']));

    await openApp('exam');
    await expect(planView).toBeVisible();
    await expect(page.getByText('还没有复习计划'), 'the open review plan still shows the empty state').toBeHidden();
    await page.screenshot({ path: join(app.root, 'agent-review-plan.png') });
    expect(describeFailures(collectHealth(app, ['review-open', 'agent-review']))).toBe('');
  });

  test('todo_init + ask_user: the question card is answered in the chat window and the answer returns to the model (W02)', async () => {
    const { page } = app;
    const { rounds, blocks } = await runTurn('agent-ask', '先列个计划，再问我喜欢什么颜色', (turn) => {
      if (!turn.called('load_skills')) return { toolCalls: [{ tool: 'load_skills', arguments: { skills: ['todo-tools', 'ask-user'] } }] };
      if (!turn.called('todo_init')) {
        return { toolCalls: [{ tool: 'todo_init', arguments: { title: 'SMOKE-TODO', steps: [{ description: '询问颜色' }, { description: '总结' }] } }] };
      }
      if (!turn.called('ask_user')) {
        return { toolCalls: [{ tool: 'ask_user', arguments: { question: 'SMOKE-ASK 你喜欢哪个颜色？', options: ['红色', '蓝色'], allowCustom: false } }] };
      }
      return { text: `SMOKE-ASK-DONE ${JSON.stringify(turn.called('ask_user')?.result)}` };
    }, async () => {
      await expect(page.getByText('SMOKE-ASK 你喜欢哪个颜色？')).toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: /蓝色/ }).click();
      await page.getByRole('button', { name: '提交', exact: true }).click();
    });
    expect(toolBlocks(blocks)).toEqual(['load_skills:success', 'todo_init:success', 'ask_user:success']);
    const answered = app.wire().filter((r) => r.phase === 'agent-ask' && r.kind === 'renderer-invoke' && r.message?.cmd === 'chat_v2_ask_user_respond');
    expect(answered).toHaveLength(1);
    const lastRound = rounds.at(-1)!.body as { messages: Array<{ role: string; content: unknown }> };
    const toolMessages = lastRound.messages.filter((m) => m.role === 'tool').map((m) => JSON.stringify(m.content));
    expect(toolMessages.some((m) => m.includes('蓝色')), 'the answer never reached the model').toBe(true);
    expect(finalText(blocks)).toContain('蓝色');
    await expect(page.getByText('SMOKE-TODO').first()).toBeVisible();
    await page.screenshot({ path: join(app.root, 'agent-ask.png') });
    expect(describeFailures(collectHealth(app, ['agent-ask']))).toBe('');
  });

  test('docx_create → docx_read_structured round-trips a generated Word file through learning resources (W04)', async () => {
    let resourceId = '';
    const { blocks } = await runTurn('agent-docx', '生成一个冒烟 Word 文档再读回来', (turn) => {
      if (!turn.called('load_skills')) return { toolCalls: [{ tool: 'load_skills', arguments: { skills: ['docx-tools'] } }] };
      if (!turn.called('docx_create')) {
        return { toolCalls: [{ tool: 'docx_create', arguments: { file_name: 'smoke.docx', spec: { title: 'SMOKE-DOCX', blocks: [
          { type: 'heading', level: 1, text: 'SMOKE-DOCX-HEADING' }, { type: 'paragraph', text: 'SMOKE-DOCX-BODY 你好' },
        ] } } }] };
      }
      if (!turn.called('docx_read_structured')) {
        resourceId = String((turn.called('docx_create')?.result as { file_id?: string } | undefined)?.file_id ?? '');
        return { toolCalls: [{ tool: 'docx_read_structured', arguments: { resource_id: resourceId } }] };
      }
      return { text: 'SMOKE-DOCX-DONE' };
    });
    test.info().annotations.push({ type: 'docx_create-output', description: JSON.stringify(output(blocks, 'docx_create')).slice(0, 800) });
    expect(toolBlocks(blocks)).toEqual(['load_skills:success', 'docx_create:success', 'docx_read_structured:success']);
    expect(resourceId).not.toBe('');
    expect(JSON.stringify(output(blocks, 'docx_read_structured'))).toContain('SMOKE-DOCX-BODY 你好');
    await expect(app.page.getByText('SMOKE-DOCX-DONE')).toBeVisible();
    expect(describeFailures(collectHealth(app, ['agent-docx']))).toBe('');
  });

  test('docx_create with output_target=workspace writes the file into the configured read-write workspace (W02 writeBytes)', async () => {
    const workspace = join(app.root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    // Settings › 工具权限 sets the workspace through this command (useToolPermissions.tsx).
    await app.call('chat_v2_set_workspace_root', { path: workspace, label: 'smoke-ws', access: 'read_write' });
    const relativePath = 'reports/smoke-ws.docx';
    const { blocks } = await runTurn('agent-docx-ws', '生成一个 Word 文档写进工作区', (turn) => {
      if (!turn.called('load_skills')) return { toolCalls: [{ tool: 'load_skills', arguments: { skills: ['docx-tools'] } }] };
      if (!turn.called('docx_create')) {
        return { toolCalls: [{ tool: 'docx_create', arguments: {
          file_name: 'smoke-ws.docx', output_target: 'workspace', root_id: 'workspace', relative_path: relativePath,
          spec: { title: 'SMOKE-WS', blocks: [{ type: 'paragraph', text: 'SMOKE-WS-BODY' }] },
        } }] };
      }
      return { text: 'SMOKE-DOCX-WS-DONE' };
    });
    const out = output<{ output_target?: string; relative_path?: string; sha256?: string; mutation_receipt?: { op?: string } }>(blocks, 'docx_create');
    test.info().annotations.push({ type: 'docx-ws-output', description: JSON.stringify(out ?? blocks.at(-1)).slice(0, 800) });
    expect(toolBlocks(blocks)).toEqual(['load_skills:success', 'docx_create:success']);
    expect(out?.output_target).toBe('workspace');
    expect(out?.relative_path).toBe(relativePath);
    expect(out?.mutation_receipt?.op).toBe('created');
    const file = join(workspace, relativePath);
    expect(existsSync(file), 'the docx is on disk inside the workspace').toBe(true);
    const bytes = readFileSync(file);
    expect(bytes.subarray(0, 2).toString('latin1'), 'an OOXML zip').toBe('PK');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(out?.sha256);
    await expect(app.page.getByText('SMOKE-DOCX-WS-DONE')).toBeVisible();
    expect(describeFailures(collectHealth(app, ['agent-docx-ws']))).toBe('');
  });

  interface SendOptions { skillEmbeddedTools: Record<string, Array<{ name: string }>>; skillContents: Record<string, string> }
  function sendOptionsOf(phase: string): SendOptions {
    const send = app.wire().find((r) => r.phase === phase && r.kind === 'renderer-invoke' && r.message?.cmd === 'chat_v2_send_message');
    return (JSON.parse((send?.message?.payload as { data: string }).data) as { request: { options: SendOptions } }).request.options;
  }

  async function newSession() {
    await openChat();
    await app.page.getByText('新会话', { exact: true }).first().click();
    await expect(input).toHaveValue('');
  }

  test('tools without an executable executor are never offered; a hallucinated call fails cleanly', async () => {
    expect(availableSkills.length).toBeGreaterThan(20);
    const { skillEmbeddedTools: embedded, skillContents } = sendOptionsOf('agent-qbank');
    // Loaded skills' instructions stay in the turn, and all of them together (~146k tokens) exceed the chat
    // context limit, so skills are loaded in fresh sessions in bins of ~40k characters of instructions; within
    // a turn, six skills per load_skills call keep each result under the 30k result budget (see next test).
    const bins: string[][] = [];
    for (const id of [...availableSkills].sort((a, b) => (skillContents[b]?.length ?? 0) - (skillContents[a]?.length ?? 0))) {
      const size = (skills: string[]) => skills.reduce((n, s) => n + (skillContents[s]?.length ?? 0), 0);
      const bin = bins.find((b) => size(b) + (skillContents[id]?.length ?? 0) <= 40_000);
      if (bin) bin.push(id); else bins.push([id]);
    }
    const offered = new Set<string>();
    for (const [index, bin] of bins.entries()) {
      await newSession();
      const { rounds, blocks } = await runTurn(`agent-offer-${index}`, `加载技能组 ${index}`, (turn) => {
        if (!turn.called('load_skills')) {
          const calls = [];
          for (let i = 0; i < bin.length; i += 6) calls.push({ tool: 'load_skills', arguments: { skills: bin.slice(i, i + 6) } });
          return { toolCalls: calls };
        }
        return { text: `SMOKE-OFFER-DONE-${index}` };
      });
      expect(rounds.length, `skill bin ${index} (${bin.join(',')}) did not reach a second round`).toBeGreaterThan(1);
      expect(toolBlocks(blocks).filter((b) => b.startsWith('load_skills:')).every((b) => b === 'load_skills:success')).toBe(true);
      expect(finalText(blocks)).toBe(`SMOKE-OFFER-DONE-${index}`);
      for (const name of toolNamesOf(rounds[1]?.body)) offered.add(name);
    }
    const loaded = [...new Set(['builtin-load_skills', ...availableSkills.flatMap((id) => (embedded[id] ?? []).map((t) => t.name))])];
    expect([...offered].filter((name) => !loaded.includes(name)), 'offered tools that no loaded skill declares').toEqual([]);
    const withheld = loaded.filter((name) => !offered.has(name)).sort();
    expect(withheld.length, 'no withheld tool left to probe a hallucinated call with').toBeGreaterThan(0);

    // A model that calls a withheld tool anyway (it was never offered) must get a clean tool error.
    const probe = withheld[0]!;
    const owner = availableSkills.find((id) => (embedded[id] ?? []).some((t) => t.name === probe))!;
    await newSession();
    const { blocks: hallucinated } = await runTurn('agent-hallucinate', `调用未下发的工具 ${probe}`, (turn) => {
      if (!turn.called('load_skills')) return { toolCalls: [{ tool: 'load_skills', arguments: { skills: [owner] } }] };
      if (!turn.called(strip(probe))) return { toolCalls: [{ tool: probe, arguments: {}, unoffered: true }] };
      return { text: 'SMOKE-HALLUCINATE-DONE' };
    });
    test.info().annotations.push({ type: 'hallucinated-probe', description: `${probe} (skill ${owner})` });
    expect(toolBlocks(hallucinated).at(-1), 'a call to a withheld tool must fail as a tool error').toBe(`${strip(probe)}:error`);
    const logged = [...new Set([...app.mainLog().matchAll(/Withheld \d+ tool schema\(s\) without an executable executor: (\[.*\])/g)]
      .flatMap((m) => JSON.parse(m[1]!) as string[]))].sort();
    writeFileSync(join(app.root, 'withheld-tools.json'), `${JSON.stringify({ bins, loaded: loaded.length, offered: offered.size, withheld }, null, 2)}\n`);
    test.info().annotations.push({ type: 'withheld', description: `${withheld.length}/${loaded.length} in ${bins.length} sessions: ${withheld.map(strip).join(' ')}` });
    expect(loaded.length).toBeGreaterThan(100);
    expect(logged, 'tools missing from the requests are exactly the ones the Host withheld for lack of an executor').toEqual(withheld);
    expect(withheld.filter((name) => strip(name).startsWith('qbank_')), 'W03: every qbank tool has a Host executor').toEqual([]);
  });

  let loadAll: { rounds: RecordedRequest[] } | null = null;

  test('one load_skills call whose result exceeds the 30k budget still discloses its tools', async () => {
    // Regression guard for RF-W02-loaded-skill-ids-truncation (Rust tool_loop.rs:2016 read `loaded_skill_ids`
    // from the budgeted output): the model and the stored block still see the field-less preview, while the
    // tool round discloses the loaded skills' tools from the pre-budget result.
    // Only loading (nearly) every skill makes the result exceed 30k as a list of short strings.
    await newSession();
    const logStart = app.mainLog().length;
    const { rounds, blocks } = await runTurn('agent-load-all', '一次加载全部技能', (turn) => {
      if (!turn.called('load_skills')) return { toolCalls: [{ tool: 'load_skills', arguments: { skills: availableSkills } }] };
      return { text: 'SMOKE-LOAD-ALL-DONE' };
    });
    loadAll = { rounds };
    const stored = blocks.find((b) => b.tool_name !== null)?.tool_output_json ?? '';
    test.info().annotations.push({ type: 'load-all-output', description: stored.slice(0, 200) });
    expect(toolBlocks(blocks)[0]).toBe('load_skills:success');
    expect(stored, 'precondition: the load_skills result was budgeted into a preview').toContain('"preview"');
    expect(stored).not.toContain('"loaded_skill_ids"');
    expect(toolNamesOf(rounds[0]?.body)).toEqual(['builtin-load_skills']);
    const disclosed = [...app.mainLog().slice(logStart)
      .matchAll(/Progressive disclosure: added (\d+) tools from skills (\[[^\]]*\])/g)]
      .map((m) => ({ added: Number(m[1]), skills: JSON.parse(m[2]!) as string[] }));
    test.info().annotations.push({ type: 'load-all-disclosed', description: disclosed.map((d) => `${d.added} tools / ${d.skills.length} skills`).join('; ') });
    expect(disclosed.map((d) => [...d.skills].sort()), 'the tool round disclosed every loaded skill').toEqual([[...availableSkills].sort()]);
    const { skillEmbeddedTools: embedded } = sendOptionsOf('agent-load-all');
    const declared = new Set(availableSkills.flatMap((id) => (embedded[id] ?? []).map((t) => t.name)));
    expect(disclosed[0]!.added, 'every tool the loaded skills declare was added to the tool round').toBeGreaterThanOrEqual(declared.size);
  });

  test('the request after an over-budget load_skills offers the disclosed tools', async () => {
    // Regression guard for #25 (RF-W09-stale-model-cache-context-budget, Tauri same): the send budgets against the model
    // it uses (configured 1M window), not a model cache loaded before that model was configured (100k fallback,
    // contextLimit 83808), which made the Host refuse the 341-tool round before it reached the model.
    expect(loadAll, 'the previous test ran the load-all turn').not.toBeNull();
    const rounds = loadAll!.rounds;
    expect(toolNamesOf(rounds[1]?.body).length, 'no tool from the loaded skills was offered').toBeGreaterThan(1);
    expect(toolNamesOf(rounds[1]?.body).some((n) => strip(n) === 'qbank_create_question'), 'qbank-tools was among the loaded skills').toBe(true);
  });

  test('every frozen qbank command is routed by the running Host after the apply() split (W03)', async () => {
    // The frozen set lives in W03's surface test; probing with `{}` only has to reach a handler.
    const source = readFileSync(join(repoRoot, 'host/plugins/qbank/tests/plugin-surface.test.ts'), 'utf8');
    const commands = [...(/const COMMANDS = \[([\s\S]*?)\];/.exec(source)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(commands).toHaveLength(88);
    await app.mark('qbank-surface');
    const unrouted: string[] = [];
    for (const cmd of commands) {
      const error = await app.call(cmd, {}, 5_000).then(() => null, (e: unknown) => String(e instanceof Error ? e.message : e));
      if (error !== null && /Command not found/.test(error)) unrouted.push(`${cmd}: ${error.slice(0, 120)}`);
    }
    expect(unrouted).toEqual([]);
    expect(await app.call<Array<{ id: string }>>('plugin:host|status').then((s) => s.filter((p) => p.id.includes('qbank')))).toEqual([]);
  });
});
