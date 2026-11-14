import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentToolExecutorRegistry } from '../../agent-skills/api.ts';
import type { ExecutionContext, ToolExecutor } from '../../chat/api.ts';
import { buildNumberedSources } from '../../vfs/api.ts';
import { insertInsightCardFixture } from '../repository/insight-cards.ts';
import { CitationLedger } from '../src/citation-ledger.ts';
import { setupMemoryHost, type MemoryHost } from './support.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });

async function setup(options: { memoryDecision?: (prompt: string) => string; vfs?: boolean } = {}) {
  const registry = new AgentToolExecutorRegistry();
  const ledgers = new Map<string, CitationLedger>();
  current = await setupMemoryHost({
    agentTools: { registerToolExecutors: executors => registry.register(executors) },
    ...(options.memoryDecision === undefined ? {} : { memoryDecision: options.memoryDecision }),
    services: {
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
  const executor = registry.all().find(entry => entry.name() === 'InsightRecallExecutor') as ToolExecutor;
  return { ...current, executor };
}

function sampleCard(db: MemoryHost['db'], id: string, title: string, situation: string): void {
  insertInsightCardFixture(db, {
    id, title, situation, stuckPoint: '展开不现实', turningPoint: `${id} 转折`, rule: `${id} 规则`,
    validityConditions: `${id} 条件`, createdAt: '2026-07-10T00:00:00+00:00',
  });
}

function context(messageId: string, sessionId = 'sess_ir') {
  const events: Array<{ kind: string; type: string; payload: unknown }> = [];
  const generic: string[] = [];
  const ctx = {
    session_id: sessionId, message_id: messageId, block_id: `blk_${messageId}`, variant_id: null,
    cancellation_token: null, isCancelled: () => false,
    emitter: {
      emitStart: (type: string, _m: string, _b: string | null, payload: unknown) => { events.push({ kind: 'start', type, payload }); },
      emitEnd: (type: string, _b: string, payload: unknown) => { events.push({ kind: 'end', type, payload }); },
      emitError: (type: string, _b: string, payload: unknown) => { events.push({ kind: 'error', type, payload }); },
    },
    emitToolCallStart: () => { generic.push('start'); },
    emitToolCallEnd: () => { generic.push('end'); },
    emitToolCallError: () => { generic.push('error'); },
    saveToolBlock: () => { generic.push('save'); },
  } as unknown as ExecutionContext;
  return { ctx, events, generic };
}

async function call(executor: ToolExecutor, args: unknown, messageId = 'msg_1', sessionId = 'sess_ir') {
  const { ctx, events, generic } = context(messageId, sessionId);
  const result = await executor.execute({ id: `call_${messageId}`, name: 'builtin-insight_recall', arguments: args }, ctx);
  return { result, events, generic, output: result.output as Record<string, any> };
}

function eventRows(db: MemoryHost['db']) {
  return db.all<{ id: string; insight_id: string | null; event_type: string; help_level: string; payload_json: string | null }>(
    'SELECT id, insight_id, event_type, help_level, payload_json FROM insight_events ORDER BY rowid');
}

function stats(db: MemoryHost['db'], id: string) {
  return db.get<{ shown_count: number; recall_count: number; last_recalled_at: string | null }>(
    'SELECT shown_count, recall_count, last_recalled_at FROM insights WHERE id = ?1', [id])!;
}

describe('InsightRecallExecutor', () => {
  it('registers under the roster name; tool name agrees with the frontend schema', async () => {
    const schema = readFileSync('src/features/chat/skills/builtin-tools/insight-recall.ts', 'utf8');
    expect([...schema.matchAll(/name: 'builtin-([a-z_]+)'/g)].map(m => m[1])).toEqual(['insight_recall']);
    const { executor } = await setup();
    expect(executor.canHandle('builtin-insight_recall')).toBe(true);
    expect(executor.canHandle('insight_recall')).toBe(true);
    expect(executor.canHandle('builtin-insight_list')).toBe(false);
    expect(executor.sensitivityLevel!('insight_recall')).toBe('low');
    expect(executor.concurrencyClass!('insight_recall')).toBe('serial');
  });

  it('query mode discloses existence only, emits its own block events and records the ledger idempotently', async () => {
    const { executor, db } = await setup();
    sampleCard(db, 'ic_sub', '导数结构识别 → 换元', '求 ∫ x(x²+1)³ dx 被积函数次数太高');
    const first = await call(executor, { query: '被积函数次数太高' });
    expect(first.result.success).toBe(true);
    expect(first.output.count).toBe(1);
    expect(first.output.sources[0]).toMatchObject({
      index: 1, citationTag: '[灵感-1]', typeIndex: 1, title: '[灵感] 导数结构识别 → 换元',
      snippet: null, url: null, source_type: 'insight',
    });
    expect(typeof first.output.sources[0].score).toBe('number');
    expect(first.output.sources[0]).not.toHaveProperty('rule');
    expect(first.events.map(event => `${event.kind}:${event.type}`)).toEqual(['start:insight_recall', 'end:insight_recall']);
    expect(first.events[0]!.payload).toEqual({ query: '被积函数次数太高', insightId: null, source: 'builtin-insight_recall' });
    expect(first.events[1]!.payload).toEqual(first.output);
    expect(first.generic).toEqual([]);
    expect(eventRows(db)).toEqual([{ id: 'iev_sess_ir_msg_1_ic_sub_shown_existence', insight_id: 'ic_sub',
      event_type: 'shown_existence', help_level: 'existence', payload_json: null }]);
    expect(stats(db, 'ic_sub').shown_count).toBe(1);

    // Retry of the same reply: same ledger number, no new event, counter unchanged.
    const retry = await call(executor, { query: '被积函数次数太高' });
    expect(retry.output.sources[0].citationTag).toBe('[灵感-1]');
    expect(eventRows(db)).toHaveLength(1);
    expect(stats(db, 'ic_sub').shown_count).toBe(1);
  });

  it('no match records silence_no_match with a NULL insight id and the query payload', async () => {
    const { executor, db } = await setup();
    const { output } = await call(executor, { query: '完全无关的量子引力' });
    expect(output).toEqual({ sources: [], count: 0, silence: 'no_match' });
    expect(eventRows(db)).toEqual([{ id: 'iev_sess_ir_msg_1_none_silence_no_match', insight_id: null,
      event_type: 'silence_no_match', help_level: 'none', payload_json: '{"query":"完全无关的量子引力"}' }]);
  });

  it('escalation climbs one level per call; hint and above bump recall_count and last_recalled_at', async () => {
    const { executor, db } = await setup();
    sampleCard(db, 'ic_esc', '换元识别', '求 ∫ x(x²+1)³ dx 被积函数次数太高');
    await call(executor, { query: '被积函数次数太高' }, 'msg_1');

    const prompt = await call(executor, { insight_id: 'ic_esc', requested_level: 'full' }, 'msg_2');
    expect(prompt.output).toMatchObject({ count: 1, escalatedTo: 'recall_prompt' });
    expect(prompt.output.sources[0]).toMatchObject({ snippet: '求 ∫ x(x²+1)³ dx 被积函数次数太高', citationTag: '[灵感-1]' });
    expect(stats(db, 'ic_esc')).toMatchObject({ recall_count: 0, last_recalled_at: null });

    const hint = await call(executor, { insightId: 'ic_esc', requestedLevel: 'full' }, 'msg_3');
    expect(hint.output.escalatedTo).toBe('hint');
    expect(stats(db, 'ic_esc').recall_count).toBe(1);
    expect(stats(db, 'ic_esc').last_recalled_at).not.toBeNull();

    const direct = await call(executor, { insight_id: 'ic_esc', requested_level: 'direct_answer' }, 'msg_4');
    expect(direct.output.escalatedTo).toBe('direct_answer');
    expect(eventRows(db).map(row => `${row.event_type}/${row.help_level}`)).toEqual([
      'shown_existence/existence', 'recall_attempt/recall_prompt', 'shown_hint/hint', 'direct_answer/direct_answer',
    ]);
    expect(stats(db, 'ic_esc').recall_count).toBe(2);
    // Replaying the direct-answer reply hits the deterministic event id: no new row, no double count.
    await call(executor, { insight_id: 'ic_esc', requested_level: 'direct_answer' }, 'msg_4');
    expect(eventRows(db)).toHaveLength(4);
    expect(stats(db, 'ic_esc').recall_count).toBe(2);
  });

  it('a disabled policy silences both modes with the Rust payloads', async () => {
    const { executor, db, storage } = await setup();
    const main = storage.database('mistakes');
    main.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    main.run("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('insight.recall.enabled', 'false', 'now')");
    sampleCard(db, 'ic_off', '换元识别', '被积函数次数太高');
    const recall = await call(executor, { query: '被积函数次数太高' });
    expect(recall.output).toEqual({ sources: [], count: 0 });
    const escalate = await call(executor, { insight_id: 'ic_off' }, 'msg_2');
    expect(escalate.output).toEqual({ sources: [], count: 0, silence: 'UserDisabled' });
    expect(eventRows(db).map(row => row.event_type)).toEqual(['silence_user_disabled', 'silence_user_disabled']);
  });

  it('LLM rewrite retries an empty long query once and the adversarial filter can reject every candidate', async () => {
    const prompts: string[] = [];
    const { executor, db } = await setup({
      memoryDecision: prompt => {
        prompts.push(prompt);
        if (prompt.startsWith('你是检索查询改写器')) return '"被积函数次数太高"';
        return '1 REJECT';
      },
    });
    sampleCard(db, 'ic_llm', '换元识别', '被积函数次数太高');
    const { output } = await call(executor, { query: '我在做一道积分题目但是不知道怎么下手呢' });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('1. 标题：换元识别；情境：被积函数次数太高；规则：ic_llm 规则');
    expect(output).toEqual({ sources: [], count: 0, silence: 'no_match' });
  });

  it('error paths are tool failures reported through insight_recall error events', async () => {
    const { executor } = await setup();
    const missing = await call(executor, {});
    expect(missing.result).toMatchObject({ success: false, error: 'insight_recall 需要 query 或 insight_id 参数' });
    expect(missing.events.map(event => event.kind)).toEqual(['start', 'error']);
    expect(missing.events[1]!.payload).toBe('insight_recall 需要 query 或 insight_id 参数');
    const unknown = await call(executor, { insight_id: 'ic_nope' });
    expect(unknown.result).toMatchObject({ success: false, error: '灵感卡不存在: ic_nope' });
    expect(missing.generic).toEqual([]);
  });

  it('without a vfs service both modes fail before writing any ledger event', async () => {
    const { executor, db } = await setup({ vfs: false });
    sampleCard(db, 'ic_novfs', '换元识别', '被积函数次数太高');
    const recall = await call(executor, { query: '被积函数次数太高' });
    expect(recall.result).toMatchObject({ success: false, error: 'vfs service is not available' });
    expect(recall.events.map(event => `${event.kind}:${event.type}`)).toEqual(['start:insight_recall', 'error:insight_recall']);
    const escalate = await call(executor, { insight_id: 'ic_novfs' }, 'msg_2');
    expect(escalate.result).toMatchObject({ success: false, error: 'vfs service is not available' });
    expect(eventRows(db)).toEqual([]);
    expect(stats(db, 'ic_novfs')).toMatchObject({ shown_count: 0, recall_count: 0, last_recalled_at: null });
  });
});
