import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentToolExecutorRegistry } from '../../agent-skills/api.ts';
import type { ExecutionContext, ToolExecutor } from '../../chat/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import reviewPlugin from '../../review/index.ts';
import { addLocalDays, localDateString, pomodoroDailyStats } from '../repository/learning.ts';
import { setupMemoryHost, type MemoryHost } from './support.ts';
import {
  insertAnswerSubmission, insertChatMessage, insertChatSession, insertExamSheet, insertPomodoroRecord,
  insertQuestion,
} from './fixtures/learning-rows.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });

const TOOLS = ['learning_overview', 'pomodoro_today_stats', 'pomodoro_daily_stats'];
const RECORD_TOOLS = ['pomodoro_record_create', 'pomodoro_record_list', 'pomodoro_record_delete'];

async function setup(options: { withReview?: boolean; withPomodoros?: boolean } = {}) {
  const registry = new AgentToolExecutorRegistry();
  current = await setupMemoryHost({
    agentTools: { registerToolExecutors: executors => registry.register(executors) },
    ...(options.withReview === true ? { ownerPlugins: [reviewPlugin] } : {}),
  });
  if (options.withPomodoros === true) {
    // L11 PomodoroRepo read path over the same migrated rows (the memory host has no real vfs-repos).
    const db = current.db;
    (current.repos as { pomodoros?: unknown }).pomodoros = {
      getDailyStats: (conn: typeof db, days: number) => pomodoroDailyStats(conn, days),
      getTodayStats: (conn: typeof db) => {
        const today = pomodoroDailyStats(conn, 1)[0]!;
        return { completedCount: today.completedCount, totalFocusSeconds: today.focusSeconds,
          interruptedCount: today.interruptedCount, completedFocusSeconds: today.focusSeconds };
      },
    } satisfies Partial<VfsReposService['pomodoros']>;
  }
  const executor = registry.all().find(entry => entry.name() === 'LearningOverviewExecutor') as ToolExecutor;
  return { ...current, executor };
}

function context() {
  const recorded = { starts: 0, ends: [] as unknown[], errors: [] as string[], saved: [] as unknown[] };
  const ctx = {
    block_id: 'blk_lo', tool_call_id: 'call_lo', cancellation_token: null, chat_v2_db: null,
    isCancelled: () => false,
    emitToolCallStart: () => { recorded.starts += 1; },
    emitToolCallEnd: (result: unknown) => { recorded.ends.push(result); },
    emitToolCallError: (error: string) => { recorded.errors.push(error); },
    saveToolBlock: (result: unknown) => { recorded.saved.push(result); },
  } as unknown as ExecutionContext;
  return { ctx, recorded };
}

async function call(executor: ToolExecutor, name: string, args: unknown,
  chatDb: { getConnSafe(): unknown } | null = null) {
  const { ctx, recorded } = context();
  (ctx as { chat_v2_db: unknown }).chat_v2_db = chatDb;
  const result = await executor.execute({ id: 'call_lo', name, arguments: args }, ctx);
  return { result, recorded, output: result.output as Record<string, any> };
}

describe('LearningOverviewExecutor', () => {
  it('registers under the roster name with the frontend tool set, low sensitivity and read-only', async () => {
    const schema = readFileSync('src/features/chat/skills/builtin-tools/learning-overview-tools.ts', 'utf8');
    expect([...schema.matchAll(/name: 'builtin-([a-z_]+)'/g)].map(m => m[1]).sort())
      .toEqual([...TOOLS, ...RECORD_TOOLS].sort());
    const { executor } = await setup();
    expect(executor).toBeDefined();
    for (const name of TOOLS) {
      expect(executor.canHandle(`builtin-${name}`)).toBe(true);
      expect(executor.sensitivityLevel!(name)).toBe('low');
      expect(executor.concurrencyClass!(name)).toBe('read_only');
    }
    expect(executor.canHandle('builtin-pomodoro_record_create')).toBe(true);
    expect(executor.sensitivityLevel!('pomodoro_record_create')).toBe('medium');
    expect(executor.concurrencyClass!('pomodoro_record_create')).toBe('serial');
    expect(executor.canHandle('builtin-pomodoro_record_list')).toBe(true);
    expect(executor.sensitivityLevel!('pomodoro_record_list')).toBe('low');
    expect(executor.concurrencyClass!('pomodoro_record_list')).toBe('read_only');
    expect(executor.canHandle('builtin-pomodoro_record_delete')).toBe(true);
    expect(executor.sensitivityLevel!('pomodoro_record_delete')).toBe('high');
    expect(executor.concurrencyClass!('pomodoro_record_delete')).toBe('serial');
    expect(executor.canHandle('builtin-learning_bogus')).toBe(false);
  });

  it('pomodoro_record_create/list/delete round-trip through the repository port', async () => {
    const { executor, repos } = await setup({ withPomodoros: true });
    const records = new Map<string, Record<string, unknown>>();
    (repos as { pomodoros?: unknown }).pomodoros = {
      getDailyStats: () => [],
      getTodayStats: () => ({ completedCount: 0, totalFocusSeconds: 0, interruptedCount: 0,
        completedFocusSeconds: 0 }),
      createRecord: (_conn: unknown, params: Record<string, unknown>) => {
        const record = {
          id: `pd_test_${records.size + 1}`,
          todoItemId: params.todoItemId as string | null,
          startTime: params.startTime as string,
          endTime: params.endTime as string,
          duration: params.duration as number,
          actualDuration: params.actualDuration as number,
          type: params.type as string,
          status: params.status as string,
          createdAt: '2026-01-01T10:25:00Z',
        };
        records.set(record.id, record);
        return record;
      },
      listRange: (_conn: unknown, startDate: string, endDate: string) => [...records.values()]
        .filter(record => {
          const day = String(record.startTime).slice(0, 10);
          return day >= startDate && day <= endDate;
        }),
      deleteRecord: (_conn: unknown, id: string) => {
        if (!records.delete(id)) throw new Error(`PomodoroRecord not found: ${id}`);
      },
    };
    const created = await call(executor, 'builtin-pomodoro_record_create', {
      duration: 1500, todo_id: 'todo_1', note: '复盘', started_at: '2026-01-01T10:00:00Z',
      completed_at: '2026-01-01T10:25:00Z',
    });
    expect(created.result.success).toBe(true);
    expect(created.output).toMatchObject({
      success: true,
      mode: 'countdown',
      note: '复盘',
      persisted: { record: true, mode: false, note: false },
      record: { duration: 1500, actualDuration: 1500, type: 'work', status: 'completed' },
    });
    const recordId = (created.output.record as { id: string }).id;

    const listed = await call(executor, 'builtin-pomodoro_record_list', {
      start_date: '2026-01-01', end_date: '2026-01-01', todo_id: 'todo_1',
    });
    expect(listed.output).toMatchObject({
      success: true, total: 1, limit: 20, has_more: false,
      range: { startDate: '2026-01-01', endDate: '2026-01-01' },
    });
    expect((listed.output.records as Array<{ id: string }>).map(record => record.id)).toEqual([recordId]);

    const deleted = await call(executor, 'builtin-pomodoro_record_delete', { id: recordId });
    expect(deleted.output).toMatchObject({ success: true, id: recordId });
    expect(records.size).toBe(0);
  });

  it('anchors a record to completed_at when started_at is omitted', async () => {
    const { executor, repos } = await setup();
    const captured: Record<string, unknown>[] = [];
    (repos as { pomodoros?: unknown }).pomodoros = {
      createRecord: (_conn: unknown, params: Record<string, unknown>) => {
        captured.push(params);
        return { id: 'pd_anchor', ...params, createdAt: '2026-01-01T10:10:00Z' };
      },
    };
    const created = await call(executor, 'builtin-pomodoro_record_create', {
      duration: 600, completed_at: '2026-01-01T10:10:00Z',
    });
    expect(created.result.success).toBe(true);
    expect(captured[0]).toMatchObject({
      startTime: '2026-01-01T10:00:00.000Z',
      endTime: '2026-01-01T10:10:00Z',
      duration: 600, actualDuration: 600,
    });
    expect(created.output.record).toMatchObject({ id: 'pd_anchor', actualDuration: 600 });
  });

  it('learning_overview aggregates real rows and reports unavailable sources as partial', async () => {
    const { executor, db, storage } = await setup({ withReview: true, withPomodoros: true });
    const chatDb = storage.database('chat_v2');
    const today = localDateString(new Date());
    insertChatSession(chatDb, 'sess_lo');
    insertChatMessage(chatDb, 'msg_lo', 'sess_lo');
    insertExamSheet(db, 'exam_lo', `${today}T08:00:00Z`);
    insertQuestion(db, 'q_lo_1', 'exam_lo', `${today}T08:00:00Z`);
    insertQuestion(db, 'q_lo_2', 'exam_lo', `${today}T08:00:00Z`);
    db.run("UPDATE questions SET status = 'mastered', attempt_count = 4, correct_count = 3 WHERE id = 'q_lo_1'");
    insertAnswerSubmission(db, 'sub_lo', 'q_lo_1', `${today}T09:00:00Z`);
    const now = new Date();
    insertPomodoroRecord(db, {
      id: 'pomo_lo', startTime: new Date(now.getTime() - 1_500_000).toISOString(), endTime: now.toISOString(),
      duration: 1500, actualDuration: 1400, type: 'work', status: 'completed', createdAt: now.toISOString(),
    });

    // Chat rows bucket by the UTC DATE(created_at) (as in Rust); yesterday..today covers both offsets.
    const yesterday = addLocalDays(today, -1);
    const { result, recorded, output } = await call(executor, 'builtin-learning_overview',
      { start_date: yesterday, end_date: today }, { getConnSafe: () => chatDb });
    expect(result.success).toBe(true);
    expect(output).toMatchObject({
      success: true,
      range: { startDate: yesterday, endDate: today, totalDays: 2 },
      focusTotals: { completedCount: 1, focusSeconds: 1400, interruptedCount: 0 },
      questionBank: {
        questionBanks: 1, totalQuestions: 2, mastered: 1, totalAttempts: 4, totalCorrect: 3,
        correctRate: 0.75, source: 'questions_table_read_only',
      },
      page: 1, page_size: 20, total: 2, has_more: false, truncated: false, partial: true,
      messageKey: 'chat.tools.learning.overview_ready',
    });
    expect(output.activityTotals).toMatchObject({ chatSessions: 1, chatMessages: 1, questionsAnswered: 1 });
    expect(output.daily.map((entry: { date: string }) => entry.date)).toEqual([yesterday, today]);
    expect(output.daily[1]).toMatchObject({ date: today, pomodoro: { completedCount: 1, focusSeconds: 1400 } });
    // L15 review is installed: FSRS stats and the mastery summary are real values.
    expect(output.fsrsReview).toMatchObject({ total: 0, due: 0 });
    expect(output.mastery).toMatchObject({ conceptCount: 0, todayPriorityReview: [] });
    // The memory host's vfsRepo has no reviewPlans repository and no media service is installed.
    const sources = (output.sourceErrors as Array<{ source: string; code: string }>).map(entry => entry.source);
    expect(sources).toContain('sm2_review');
    expect(sources).toContain('media');
    expect(sources).not.toContain('pomodoro');
    expect(sources).not.toContain('question_bank');
    expect(sources).not.toContain('fsrs');
    expect(output.sm2Review).toBeNull();
    expect(output.media).toBeNull();
    expect(output.message).toContain('部分数据源不可用');
    expect(recorded.starts).toBe(1);
    expect(recorded.ends).toEqual([{ result: output, durationMs: result.durationMs }]);
    expect(recorded.saved).toEqual([result]);
  });

  it('missing L15 providers keep the overview successful with per-source errors', async () => {
    const { executor } = await setup();
    const { result, output } = await call(executor, 'learning_overview', {});
    expect(result.success).toBe(true);
    const sources = (output.sourceErrors as Array<{ source: string; message: string }>);
    expect(sources.map(entry => entry.source)).toEqual(expect.arrayContaining([
      'learning_activity.chat_v2', 'pomodoro', 'sm2_review', 'fsrs', 'mastery', 'media',
    ]));
    expect(sources.find(entry => entry.source === 'fsrs')!.message)
      .toBe('Anki 数据库尚未初始化，FSRS 统计不可用 / The Anki database is not initialized, so FSRS statistics are unavailable.');
    expect(output.range.totalDays).toBe(7);
    expect(output.daily).toHaveLength(7);
  });

  it('argument errors are tool failures carrying the localized INVALID_ARGUMENT payload', async () => {
    const { executor } = await setup();
    const bad = await call(executor, 'learning_overview', { start_date: '2026-01-01' });
    expect(bad.result.success).toBe(false);
    expect(JSON.parse(bad.result.error!)).toMatchObject({ code: 'INVALID_ARGUMENT', field: 'date_range' });
    expect(bad.recorded.errors).toEqual([bad.result.error]);
    expect(bad.recorded.saved).toEqual([bad.result]);
    const extra = await call(executor, 'pomodoro_today_stats', { verbose: true });
    expect(JSON.parse(extra.result.error!)).toMatchObject({ code: 'INVALID_ARGUMENT', field: 'verbose' });
    const days = await call(executor, 'pomodoro_daily_stats', { days: 91 });
    expect(JSON.parse(days.result.error!)).toMatchObject({ code: 'INVALID_ARGUMENT', field: 'days' });
    const unknown = await call(executor, 'builtin-learning_bogus', {});
    expect(JSON.parse(unknown.result.error!)).toMatchObject({ code: 'UNKNOWN_TOOL', retryable: true });
  });

  it('pomodoro stats read the VFS repository; a missing repository is POMODORO_QUERY_FAILED', async () => {
    const missing = await setup();
    const failed = await call(missing.executor, 'pomodoro_daily_stats', {});
    expect(failed.result.success).toBe(false);
    expect(JSON.parse(failed.result.error!)).toMatchObject({
      code: 'POMODORO_QUERY_FAILED', retryable: true, messageKey: 'chat.tools.learning.query_failed',
    });
    await missing.dispose();
    current = undefined;

    const { executor, db } = await setup({ withPomodoros: true });
    const now = new Date();
    insertPomodoroRecord(db, {
      id: 'pomo_today', startTime: now.toISOString(), endTime: now.toISOString(), duration: 1500,
      actualDuration: 600, type: 'work', status: 'interrupted', createdAt: now.toISOString(),
    });
    const today = await call(executor, 'pomodoro_today_stats', {});
    expect(today.output).toMatchObject({
      success: true, date: localDateString(now),
      stats: { completedCount: 0, totalFocusSeconds: 600, interruptedCount: 1 },
      messageKey: 'chat.tools.learning.pomodoro_today_ready',
    });
    const daily = await call(executor, 'pomodoro_daily_stats', { days: 3, page_size: 2 });
    expect(daily.output).toMatchObject({
      success: true, days: 3, total: 3, page: 1, page_size: 2, has_more: true, truncated: true,
      totals: { completedCount: 0, focusSeconds: 600, interruptedCount: 1 },
    });
    expect(daily.output.daily).toHaveLength(2);
  });
});
