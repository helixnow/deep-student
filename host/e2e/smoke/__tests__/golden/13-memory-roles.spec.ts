/**
 * Memory owner roles reached from chat on the real Host. The fake LLM plays the chat model and, through
 * `complete`, the memory decision role (`llmRawPrompt.callMemoryDecisionRawPrompt`, model2 fallback); a fake
 * embedding model lets the vfs-index worker index memories so similarity search has hits.
 *
 * - W03 r7: the decision role resolves from `llmRawPrompt` (was `llm`, where it is not published), so
 *   `memory_write_smart` with a similar memory and `insight_recall` reach the decision model instead of failing
 *   with "L02 service does not expose callMemoryDecisionRawPrompt" / silently skipping the model.
 * - W02 r6: chat turns no longer log the memory capabilities as unavailable; `record_used` marks memories the
 *   answer cites as `[记忆-N]` (Rust persistence.rs:252). The memory owner's own `record_used` is reached by
 *   `memory_read`.
 * - Rust refreshes the category summaries after every memory write while there are at most 5 memories
 *   (`service.rs:744-763`, `category_manager.rs:85-200`), through the same decision role.
 */
import { expect, test, type Locator } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from '../support/app.ts';
import { activeSlotDir, query } from '../support/db.ts';
import { collectHealth, describeFailures } from '../support/diagnostics.ts';
import { promptText, startFakeLlm, toolNamesOf, type FakeLlm, type ScriptTurn, type ScriptedReply } from '../support/fake-llm.ts';
import { configureFakeEmbedding, configureFakeModel } from '../support/llm-config.ts';
import { passFirstRun, waitForBridge } from '../support/onboarding.ts';
import { clickDock } from '../support/renderer.ts';

interface BlockRow { block_type: string; status: string; tool_name: string | null; tool_output_json: string | null; content: string | null }

const FOLDER = '偏好';
const FACT_TITLE = 'SMOKE-MEM 颜色偏好';
const FACT_A = '用户最喜欢的颜色是蓝色';
const FACT_B = '用户最喜欢的颜色是蓝色和绿色';
const CATEGORY_SUMMARY = '- SMOKE-CATEGORY 用户最喜欢蓝色';
const INSIGHT_TITLE = 'SMOKEINSIGHT 长难句先找主干';
const INSIGHT_KEYWORD = 'SMOKEINSIGHT';
const UNMATCHED_QUERY = '我又卡在这道英语阅读的句子分析上了怎么办';

/** Prompt heads of the decision-role calls (memory llm_decision.rs, category_manager.rs:219, insight recall.rs). */
const DECISION_HEAD = '你是一个记忆管理助手。';
const CATEGORY_HEAD = '你是一个用户画像聚合器。';
const REWRITE_HEAD = '你是检索查询改写器。';
const VET_HEAD = '你是严格的审查员。';
/** Post-turn auto-extraction (memory/src/auto-extractor.ts); turns that did not write a fact memory reach it. */
const EXTRACT_HEAD = '你是一个用户记忆提取器。';

const strip = (name: string) => name.replace(/^builtin[-_:]/, '');
const offered = (turn: ScriptTurn, tool: string) => turn.toolNames.some((n) => strip(n) === tool);
const tagsOf = (raw: string | null | undefined): string[] => (raw ? JSON.parse(raw) as string[] : []);
const usedCount = (tags: readonly string[]) => Number(tags.find((t) => t.startsWith('_used:'))?.slice('_used:'.length) ?? 0);

test.describe.serial('⑬ memory decision role and usage signals', () => {
  let app: LaunchedApp;
  let llm: FakeLlm;
  let input: Locator;
  let noteId = '';
  let decisionReply: string | null = null;

  const vfsDb = () => join(activeSlotDir(app.dataDir), 'databases', 'vfs.db');
  const chatDb = () => join(activeSlotDir(app.dataDir), 'chat_v2.db');
  const noteTags = () => tagsOf(query<{ tags: string | null }>(vfsDb(), `select tags from notes where id = '${noteId}'`)[0]?.tags);

  async function openChat() {
    const focusedInput = app.page.locator('[data-wb-window][data-focused="true"]').getByTestId('input-bar-v2-textarea');
    if (!(await focusedInput.isVisible())) await clickDock(app.page, 'wb-dock-item-chat');
    await expect(focusedInput).toBeVisible();
  }

  function lastAssistantBlocks(): BlockRow[] {
    return query<BlockRow>(chatDb(),
      `select b.block_type, b.status, b.tool_name, b.tool_output_json, b.content
         from chat_v2_blocks b where b.message_id = (
           select id from chat_v2_messages where role = 'assistant' order by timestamp desc limit 1)
        order by b.block_index`);
  }
  const toolBlocks = (blocks: BlockRow[]) => blocks.filter((b) => b.tool_name !== null).map((b) => `${strip(b.tool_name!)}:${b.status}`);
  const output = <T>(blocks: BlockRow[], tool: string): T =>
    JSON.parse(blocks.find((b) => b.tool_name !== null && strip(b.tool_name) === tool)?.tool_output_json ?? 'null') as T;
  const finalText = (blocks: BlockRow[]) => blocks.filter((b) => b.block_type === 'content').map((b) => b.content ?? '').join('');

  /** One chat turn: load `skill` when `tool` is not offered yet, then let `script` drive the rest. */
  async function runTurn(phase: string, prompt: string, skill: string, tool: string,
    script: (turn: ScriptTurn) => ScriptedReply | undefined) {
    await app.mark(phase);
    const before = llm.streamRequests().length;
    llm.script = (turn) => (!offered(turn, tool) && !turn.called('load_skills')
      ? { toolCalls: [{ tool: 'load_skills', arguments: { skills: [skill] } }] }
      : script(turn));
    await openChat();
    await input.fill(prompt);
    await app.page.getByTestId('btn-send').first().click();
    await expect.poll(() => llm.streamRequests().length).toBeGreaterThan(before);
    await expect(app.page.getByTestId('btn-send').first()).toBeVisible({ timeout: 60_000 });
    await app.page.waitForTimeout(1_000);
    llm.script = null;
    const rounds = llm.streamRequests().slice(before);
    test.info().annotations.push({ type: `${phase}-rounds`, description: rounds.map((r) => toolNamesOf(r.body).length).join(',') });
    return lastAssistantBlocks();
  }

  test.beforeAll(async () => {
    llm = await startFakeLlm();
    llm.complete = (prompt) => {
      if (prompt.includes(DECISION_HEAD)) return decisionReply ?? undefined;
      if (prompt.includes(CATEGORY_HEAD)) return CATEGORY_SUMMARY;
      if (prompt.includes(REWRITE_HEAD)) return INSIGHT_KEYWORD;
      if (prompt.includes(VET_HEAD)) return '1 KEEP';
      if (prompt.includes(EXTRACT_HEAD)) return JSON.stringify({ facts: [], activities: [] });
      return undefined;
    };
    app = await launchApp({ label: 'memory-roles' });
    await waitForBridge(app.page);
    await app.call('plugin:host|status', {}, 90_000);
    await passFirstRun(app.page);
    await configureFakeModel(app, llm.baseUrl);
    await configureFakeEmbedding(app);
    input = app.page.getByTestId('input-bar-v2-textarea').first();
    await openChat();
  });
  test.afterAll(async () => {
    await app?.close();
    await llm?.close();
  });

  test('memory_write stores a fact and the turn reports no memory capability as unavailable (W02 r6)', async () => {
    const blocks = await runTurn('mem-write', '记住我最喜欢蓝色', 'vfs-memory', 'memory_write', (turn) => {
      if (!turn.called('memory_write')) return { toolCalls: [{ tool: 'memory_write', arguments: { folder: FOLDER, title: FACT_TITLE, content: FACT_A } }] };
      return { text: 'SMOKE-MEM-WRITE-DONE' };
    });
    expect(toolBlocks(blocks)).toEqual(['load_skills:success', 'memory_write:success']);
    noteId = output<{ note_id?: string }>(blocks, 'memory_write')?.note_id ?? '';
    expect(noteId).not.toBe('');
    expect(finalText(blocks)).toBe('SMOKE-MEM-WRITE-DONE');
    expect(query<{ title: string }>(vfsDb(), `select title from notes where id = '${noteId}' and deleted_at is null`)).toEqual([{ title: FACT_TITLE }]);
    const log = app.mainLog();
    expect(log.match(/owner capability unavailable: memory[^\n]*/g) ?? [], 'chat-pipeline found every memory capability').toEqual([]);
    expect(describeFailures(collectHealth(app, ['mem-write']))).toBe('');
  });

  test('after the write the category summary is refreshed through the memory decision model', async () => {
    // #31 (W03, migration-only): runPostWriteMaintenance (host/plugins/memory/src/service.ts:528-549) skips the
    // category refresh, the log→profile promotion pass and semantic dedup as "L02 LLM completion API is not
    // published"; Rust runs all three through call_memory_decision_raw_prompt, which W03 r7 now resolves.
    test.fail();
    test.info().annotations.push({ type: 'post-write-skips', description: (app.mainLog().match(/\[Memory\] Post-write [^\n]*skipped[^\n]*/g) ?? []).join(' | ') });
    await expect.poll(() => llm.completions(CATEGORY_HEAD).length, { message: 'no category summary request reached the decision model' }).toBeGreaterThan(0);
    expect(promptText(llm.completions(CATEGORY_HEAD)[0]!.body)).toContain(FACT_A);
    await expect.poll(() => query<{ tags: string | null }>(vfsDb(), `select tags from notes where title like '\\_\\_cat\\_%' escape '\\' and deleted_at is null`)
      .some((row) => tagsOf(row.tags).includes(`_member:${noteId}`)), { message: 'no category note lists the memory as a member' }).toBe(true);
  });

  test('the next turn injects the category summary and stamps its member memories _last_injected (#32)', async () => {
    // #32 is fixed (W02 cc51bee4: loadUserProfile, chat-pipeline/src/execution-capabilities.ts:257-287, marks the
    // members of every injected category, Rust prompt.rs:236). It is only observable on a category note, which
    // #31 above never creates.
    test.fail();
    await app.mark('mem-profile');
    const before = llm.streamRequests().length;
    llm.script = () => ({ text: 'SMOKE-MEM-PROFILE-DONE' });
    await openChat();
    await input.fill('今天先复习什么好？');
    await app.page.getByTestId('btn-send').first().click();
    await expect.poll(() => llm.streamRequests().length).toBeGreaterThan(before);
    await expect(app.page.getByTestId('btn-send').first()).toBeVisible({ timeout: 60_000 });
    llm.script = null;
    expect(promptText(llm.streamRequests()[before]!.body), 'the category summary is in the turn\'s prompt').toContain(CATEGORY_SUMMARY);
    await expect.poll(() => noteTags().some((t) => t.startsWith('_last_injected:')),
      { message: 'the injected category\'s member memory was not stamped _last_injected' }).toBe(true);
  });

  test('memory_write_smart with a similar memory applies the decision model\'s UPDATE (W03 r7)', async () => {
    await expect.poll(async () => (await app.call<Array<{ noteId: string }>>('memory_search', { query: FACT_A, topK: 5 })).map((r) => r.noteId),
      { timeout: 60_000, message: 'the written memory never became searchable' }).toContain(noteId);
    decisionReply = JSON.stringify({ event: 'UPDATE', target_note_id: noteId, confidence: 0.95, reason: 'SMOKE-DECISION' });
    const decisionsBefore = llm.completions(DECISION_HEAD).length;
    const blocks = await runTurn('mem-smart', '我也喜欢绿色，记一下', 'vfs-memory', 'memory_write_smart', (turn) => {
      if (!turn.called('memory_write_smart')) {
        return { toolCalls: [{ tool: 'memory_write_smart', arguments: { folder: FOLDER, title: FACT_TITLE, content: FACT_B, memory_type: 'fact' } }] };
      }
      return { text: 'SMOKE-MEM-SMART-DONE' };
    });
    decisionReply = null;
    const out = output<{ event?: string; note_id?: string; reason?: string; downgraded?: boolean }>(blocks, 'memory_write_smart');
    test.info().annotations.push({ type: 'write-smart-output', description: JSON.stringify(out) });
    expect(toolBlocks(blocks).at(-1)).toBe('memory_write_smart:success');
    const decisions = llm.completions(DECISION_HEAD).slice(decisionsBefore);
    expect(decisions.length, 'one decision request with the similar memory').toBe(1);
    expect(promptText(decisions[0]!.body)).toContain(`[ID: ${noteId}]`);
    expect(out).toMatchObject({ event: 'UPDATE', note_id: noteId, downgraded: false });
    expect((await app.call<{ content_md: string }>('notes_get', { id: noteId })).content_md.trim()).toBe(FACT_B);
    expect(app.mainLog()).not.toContain('does not expose callMemoryDecisionRawPrompt');
    expect(describeFailures(collectHealth(app, ['mem-smart']))).toBe('');
  });

  test('memory_read marks the memory used through the memory owner (record_used)', async () => {
    const before = usedCount(noteTags());
    const blocks = await runTurn('mem-read', '读一下那条颜色记忆', 'vfs-memory', 'memory_read', (turn) => {
      if (!turn.called('memory_read')) return { toolCalls: [{ tool: 'memory_read', arguments: { note_id: noteId } }] };
      return { text: 'SMOKE-MEM-READ-DONE' };
    });
    expect(toolBlocks(blocks).at(-1)).toBe('memory_read:success');
    expect(output<{ found?: boolean; content?: string }>(blocks, 'memory_read')).toMatchObject({ found: true, content: FACT_B });
    await expect.poll(() => usedCount(noteTags()), { message: '_used was not incremented' }).toBe(before + 1);
    expect(noteTags().some((t) => t.startsWith('_last_hit:'))).toBe(true);
    expect(describeFailures(collectHealth(app, ['mem-read']))).toBe('');
  });

  test('an answer citing a unified_search memory hit as [记忆-N] marks that memory used (W02 r6 record_used)', async () => {
    // The UPDATE above bound the note to a new resource. Only the index worker picks it up: like Rust's tool path
    // (memory_executor.rs:1173-1175), memory_write_smart runs no immediate index, unlike memory_write.
    await expect.poll(() => query<{ index_state: string }>(vfsDb(),
      `select r.index_state from notes n join resources r on r.id = n.resource_id where n.id = '${noteId}'`)[0]?.index_state,
    { timeout: 60_000, message: 'the updated memory was never re-indexed' }).toBe('indexed');
    const before = usedCount(noteTags());
    let tag = '';
    const blocks = await runTurn('mem-cite', '根据我的记忆，我喜欢什么颜色？', 'knowledge-retrieval', 'unified_search', (turn) => {
      if (!turn.called('unified_search')) return { toolCalls: [{ tool: 'unified_search', arguments: { query: '最喜欢的颜色', top_k: 5 } }] };
      type Sources = { sources?: Array<{ citationTag?: string; noteId?: string | null }> };
      const result = turn.called('unified_search')!.result as (Sources & { result?: Sources }) | undefined;
      tag = (result?.result ?? result)?.sources?.find((s) => s.noteId === noteId)?.citationTag ?? '';
      return { text: `你喜欢蓝色和绿色 ${tag}` };
    });
    test.info().annotations.push({ type: 'cite', description: JSON.stringify({ tools: toolBlocks(blocks), tag, text: finalText(blocks) }) });
    expect(toolBlocks(blocks).at(-1)).toBe('unified_search:success');
    expect(tag, 'unified_search returned the memory as a [记忆-N] source').toMatch(/^\[记忆-\d+\]$/);
    await expect.poll(() => usedCount(noteTags()), { message: 'the cited memory was not marked _used' }).toBe(before + 1);
  });

  test('insight_recall rewrites an unmatched query and vets the hit through the decision model (W03 r7)', async () => {
    await app.call('insight_create_draft', { input: {
      title: INSIGHT_TITLE, situation: `${INSIGHT_KEYWORD} 阅读时句子太长看不懂`, stuck_point: '修饰成分太多', turning_point: '先划出主谓宾',
      rule: `${INSIGHT_KEYWORD} 长难句先找主干再看修饰`, validity_conditions: '', ownership: 'self_reported',
      evidence: [{ kind: 'manual', quote_snapshot: `${INSIGHT_KEYWORD} 手动记录` }],
    } });
    const rewritesBefore = llm.completions(REWRITE_HEAD).length;
    const vetsBefore = llm.completions(VET_HEAD).length;
    const blocks = await runTurn('mem-insight', UNMATCHED_QUERY, 'insight-recall', 'insight_recall', (turn) => {
      if (!turn.called('insight_recall')) return { toolCalls: [{ tool: 'insight_recall', arguments: { query: UNMATCHED_QUERY } }] };
      return { text: 'SMOKE-INSIGHT-DONE' };
    });
    test.info().annotations.push({ type: 'insight-recall-output', description: JSON.stringify(output(blocks, 'insight_recall')).slice(0, 800) });
    expect(toolBlocks(blocks).at(-1)).toBe('insight_recall:success');
    const rewrites = llm.completions(REWRITE_HEAD).slice(rewritesBefore);
    expect(rewrites.length, 'no FTS hit for the original query, so the decision model rewrites it once').toBe(1);
    expect(promptText(rewrites[0]!.body)).toContain(UNMATCHED_QUERY);
    const vets = llm.completions(VET_HEAD).slice(vetsBefore);
    expect(vets.length, 'the rewritten query found the card and the decision model vetted it').toBe(1);
    expect(promptText(vets[0]!.body)).toContain(INSIGHT_TITLE);
    expect(app.mainLog()).not.toContain('[InsightRecall] LLM 改写失败');
    expect(describeFailures(collectHealth(app, ['mem-insight']))).toBe('');
  });
});
