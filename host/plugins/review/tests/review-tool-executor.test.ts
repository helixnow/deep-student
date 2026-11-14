import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { AgentToolExecutor } from '../../agent-skills/api.ts';
import type { ExecutionContext, ToolExecutor, ToolResultInfo } from '../../chat/api.ts';
import type { Question } from '../../vfs-repos/api.ts';
import review from '../index.ts';
import {
  REVIEW_TOOL_NAMES, ReviewToolExecutor, afterSuccessfulMutation, parseReviewStatusFilter,
  requiredPlanId, validateReviewDate,
} from '../src/review-tool-executor.ts';
import { silentToolLog } from '../src/tool-execution.ts';
import { appError } from '../src/errors.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { createReviewPlanStore } from './vfs-repo-double.ts';

type Storage = ReturnType<typeof createStorageService>;
type Db = ReturnType<Storage['database']>;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function vfsFixture(): { storage: Storage; db: Db } {
  const root = mkdtempSync(join(tmpdir(), 'review-tool-tests-'));
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const db = storage.database('vfs');
  const dir = 'resources/app/migrations/vfs';
  for (const file of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(dir, file), 'utf8'));
  }
  cleanups.push(() => { storage.dispose(); rmSync(root, { recursive: true, force: true }); });
  return { storage, db };
}

function insertExam(db: Db, id: string): void {
  db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at)
    VALUES (?1, 'Exam', 'completed', ?2, '{}', '{"pages":[]}', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')`,
  [id, `tmp_${id}`]);
}

function insertQuestion(db: Db, id: string, examId: string, cardId: string, content: string): void {
  db.run(`INSERT INTO questions (id, exam_id, card_id, question_label, content, question_type, tags, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, 'single_choice', '["函数"]', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')`,
  [id, examId, cardId, `第${id}题`, content]);
}

function questionRow(db: Db, where: string, params: string[]): Question | null {
  const row = db.get<{ id: string; exam_id: string; card_id: string | null; question_label: string | null;
    content: string; question_type: string; tags: string }>(
    `SELECT id, exam_id, card_id, question_label, content, question_type, tags FROM questions WHERE ${where}`, params);
  if (row === undefined) return null;
  return { ...row, tags: JSON.parse(row.tags) as string[] } as unknown as Question;
}

/** vfsRepo double whose question reads carry the preview columns used by `plan_to_json`. */
function reviewStore(db: Db) {
  const base = createReviewPlanStore();
  return {
    ...base,
    questions: { ...base.questions, getQuestion: (_conn: unknown, id: string) => questionRow(db, 'id = ?1', [id]) },
  };
}

interface Recorded { starts: unknown[]; ends: unknown[]; errors: string[]; saved: ToolResultInfo[] }

function executionContext(windowed = true): { ctx: ExecutionContext; recorded: Recorded } {
  const recorded: Recorded = { starts: [], ends: [], errors: [], saved: [] };
  const ctx = {
    session_id: 'sess_1', message_id: 'msg_1', block_id: 'blk_1', tool_call_id: 'call_1',
    tryWindow: () => (windowed ? { window: 'main', webview: 'main' } : null),
    runId: () => 'call_1',
    emitToolCallStart: (name: string, input: unknown, id: string | null) => { recorded.starts.push({ name, input, id }); },
    emitToolCallEnd: (result: unknown) => { recorded.ends.push(result); },
    emitToolCallError: (error: string) => { recorded.errors.push(error); },
    saveToolBlock: (result: ToolResultInfo) => { recorded.saved.push(result); },
  } as unknown as ExecutionContext;
  return { ctx, recorded };
}

async function installReview(withVfs = true) {
  const { storage, db } = vfsFixture();
  const registered: AgentToolExecutor[] = [];
  const host = await createTestHost({
    plugins: [review],
    provide: {
      storage,
      ...(withVfs ? { vfsRepo: reviewStore(db) } : {}),
      qbank: { getQuestionByCardId: (examId: string, cardId: string) =>
        questionRow(db, 'exam_id = ?1 AND card_id = ?2', [examId, cardId]) },
      agentTools: { registerToolExecutors: (executors: readonly AgentToolExecutor[]) => {
        registered.push(...executors);
        return { dispose: () => undefined };
      } },
    },
  });
  cleanups.push(() => host.dispose());
  const executor = registered.find(entry => entry.name() === 'ReviewToolExecutor') as ToolExecutor | undefined;
  if (executor === undefined) throw new Error('ReviewToolExecutor was not registered');
  return { host, db, executor };
}

async function call(executor: ToolExecutor, name: string, args: unknown, windowed = true) {
  const { ctx, recorded } = executionContext(windowed);
  const result = await executor.execute({ id: 'call_1', name, arguments: args }, ctx);
  return { result, recorded };
}

function frontendToolNames(): string[] {
  const source = readFileSync('src/features/chat/skills/builtin-tools/review-planning.ts', 'utf8');
  const embedded = source.slice(source.indexOf('embeddedTools'));
  return [...embedded.matchAll(/name: 'builtin-([a-z_]+)'/g)].map(match => match[1]!);
}

describe('ReviewToolExecutor definition', () => {
  it('handles exactly the published tool set, which is the frontend schema set', () => {
    expect([...REVIEW_TOOL_NAMES]).toEqual(['review_get_due', 'review_schedule', 'review_plan_generate',
      'review_submit', 'review_stats', 'review_suspend', 'review_resume', 'review_delete']);
    expect([...REVIEW_TOOL_NAMES].sort()).toEqual(frontendToolNames().sort());
    const executor = new ReviewToolExecutor({
      service: () => null, getQuestion: () => null, questionBank: () => null, emit: () => undefined, log: silentToolLog,
    });
    for (const name of REVIEW_TOOL_NAMES) {
      expect(executor.canHandle(name)).toBe(true);
      expect(executor.canHandle(`builtin-${name}`)).toBe(true);
    }
    expect(executor.canHandle('review_plan_delete')).toBe(false);
    expect(executor.canHandle('qbank_list')).toBe(false);
  });

  it('classifies sensitivity like review_executor.rs', () => {
    const executor = new ReviewToolExecutor({
      service: () => null, getQuestion: () => null, questionBank: () => null, emit: () => undefined, log: silentToolLog,
    });
    expect(Object.fromEntries(REVIEW_TOOL_NAMES.map(name => [name, executor.sensitivityLevel(name)]))).toEqual({
      review_get_due: 'low', review_schedule: 'medium', review_plan_generate: 'medium', review_submit: 'medium',
      review_stats: 'low', review_suspend: 'medium', review_resume: 'medium', review_delete: 'high',
    });
    expect(executor.sensitivityLevel('builtin-review_delete')).toBe('high');
  });

  it('ports the Rust argument helpers', () => {
    expect(() => validateReviewDate('2026-07-08', 'until_date')).not.toThrow();
    for (const bad of ['2026-7-8', 'not-a-date', '2026-13-40', '2026-02-30']) {
      expect(() => validateReviewDate(bad, 'until_date')).toThrow(`参数 'until_date' 日期格式无效: ${bad}（应为 YYYY-MM-DD）`);
    }
    expect(parseReviewStatusFilter({ status: ['new', 'reviewing', 'unknown_status', 'Learning'] }))
      .toEqual(['new', 'reviewing', 'new', 'new']);
    expect(parseReviewStatusFilter({ status: '["graduated", "suspended"]' })).toEqual(['graduated', 'suspended']);
    expect(parseReviewStatusFilter({})).toBeNull();
    expect(() => requiredPlanId({})).toThrow('Missing required parameter: plan_id (from review_get_due)');
    expect(() => requiredPlanId({ plan_id: '  ' })).toThrow('Missing required parameter: plan_id');
    expect(requiredPlanId({ planId: ' rp_123 ' })).toBe('rp_123');
  });

  it('emits the change payload only after a successful mutation', () => {
    const emitted: unknown[] = [];
    for (const action of ['suspend', 'resume', 'delete']) {
      afterSuccessfulMutation(() => ({ success: true }), action, 'rp_event', 'call_event', payload => emitted.push(payload));
      expect(() => afterSuccessfulMutation(() => { throw new Error('mutation failed'); }, action, 'rp_event',
        'call_event', payload => emitted.push(payload))).toThrow('mutation failed');
    }
    expect(emitted).toEqual(['suspend', 'resume', 'delete'].map(action => ({
      source: 'agent', action, operation: `review_${action}`, planId: 'rp_event', plan_id: 'rp_event',
      entityIds: ['rp_event'], runId: 'call_event',
    })));
  });
});

describe('ReviewToolExecutor through the review plugin', () => {
  it('registers through agentTools and runs the schedule → due → submit loop with review://changed', async () => {
    const { host, db, executor } = await installReview();
    insertExam(db, 'exam_1');
    insertQuestion(db, 'q_1', 'exam_1', 'card_1', '函数 f(x)=x² 的导数是多少？');
    insertQuestion(db, 'q_2', 'exam_1', 'card_2', '第二题');

    const scheduled = await call(executor, 'builtin-review_schedule',
      { exam_id: 'exam_1', question_ids: ['q_2'], card_ids: ['card_1', 'card_missing'] });
    expect(scheduled.result.success).toBe(true);
    const scheduleOutput = scheduled.result.output as Record<string, unknown>;
    expect(scheduleOutput).toMatchObject({
      success: true, exam_id: 'exam_1', created: 2, skipped: 0, failed: 0,
      unresolved_card_ids: ['card_missing'],
      message: '已为 2 道题目创建复习计划（0 道已有计划跳过，0 道失败）',
    });
    expect((scheduleOutput.plans_preview as unknown[]).map(item => (item as { question_id: string }).question_id))
      .toEqual(['q_1', 'q_2']);
    expect(scheduled.recorded.starts).toEqual([{ name: 'builtin-review_schedule',
      input: { exam_id: 'exam_1', question_ids: ['q_2'], card_ids: ['card_1', 'card_missing'] }, id: 'call_1' }]);
    expect(scheduled.recorded.ends).toHaveLength(1);
    expect(scheduled.recorded.saved[0]).toMatchObject({ toolCallId: 'call_1', blockId: 'blk_1', success: true });
    expect(host.eventsNamed('review://changed')).toEqual([{ action: 'schedule', examId: 'exam_1', runId: 'call_1' }]);

    const due = await call(executor, 'review_get_due', { exam_id: 'exam_1', limit: 500 });
    const dueOutput = due.result.output as { total: number; limit: number; offset: number;
      due_reviews: { plan_id: string; question_id: string; updatedAt: string; question?: Record<string, unknown> }[] };
    expect(dueOutput.total).toBe(2);
    expect(dueOutput.limit).toBe(100);
    expect(dueOutput.offset).toBe(0);
    const first = dueOutput.due_reviews.find(item => item.question_id === 'q_1')!;
    expect(first.question).toEqual({
      card_id: 'card_1', label: '第q_1题', content_preview: '函数 f(x)=x² 的导数是多少？',
      question_type: 'single_choice', tags: ['函数'],
    });

    host.events.length = 0;
    const submitted = await call(executor, 'review_submit',
      { plan_id: first.plan_id, quality: 5, expected_updated_at: first.updatedAt, user_answer: "2x" });
    expect(submitted.result.success).toBe(true);
    expect(submitted.result.output).toMatchObject({
      success: true, plan_id: first.plan_id, question_id: 'q_1', passed: true, new_interval_days: 1,
      status: 'learning', repetitions: 1,
    });
    expect(host.eventsNamed('review://changed')).toEqual([{ action: 'submit', planId: first.plan_id, runId: 'call_1' }]);

    host.events.length = 0;
    const stale = await call(executor, 'review_submit',
      { plan_id: first.plan_id, quality: 4, expected_updated_at: first.updatedAt });
    expect(stale.result.success).toBe(false);
    const conflict = JSON.parse(stale.result.error!) as Record<string, unknown>;
    expect(conflict).toMatchObject({
      code: 'REVIEW_CONFLICT', action: 'submit', plan_id: first.plan_id, expected_updated_at: first.updatedAt,
      retryable: false, messageKey: 'chat.tools.review.conflict',
    });
    expect((conflict.current as { repetitions: number }).repetitions).toBe(1);
    expect(stale.recorded.errors).toEqual([stale.result.error]);
    expect(host.eventsNamed('review://changed')).toEqual([]);

    const stats = await call(executor, 'review_stats', { exam_id: 'exam_1', include_calendar: true });
    expect(stats.result.output).toMatchObject({ exam_id: 'exam_1', total_plans: 2, total_reviews: 1 });
    expect(Array.isArray((stats.result.output as { calendar: unknown[] }).calendar)).toBe(true);
  });

  it('suspends, resumes and deletes with OCC revisions and one event per success', async () => {
    const { host, db, executor } = await installReview();
    insertExam(db, 'exam_m');
    insertQuestion(db, 'q_m', 'exam_m', 'card_m', '题');
    const generated = await call(executor, 'review_plan_generate', { exam_id: 'exam_m' });
    expect(generated.result.output).toMatchObject({ success: true, created: 1, skipped: 0, failed: 0,
      stats: { total_plans: 1 } });
    expect(host.eventsNamed('review://changed')).toEqual([{ action: 'plan_generate', examId: 'exam_m', runId: 'call_1' }]);
    const plan = db.get<{ id: string; updated_at: string }>('SELECT id, updated_at FROM review_plans')!;

    host.events.length = 0;
    const suspended = await call(executor, 'review_suspend', { plan_id: plan.id, expected_updated_at: plan.updated_at });
    const suspendedPlan = (suspended.result.output as { plan: { status: string; updatedAt: string } }).plan;
    expect(suspended.result.output).toMatchObject({ success: true, message_key: 'review.plan_suspended', reversible: true });
    expect(suspendedPlan.status).toBe('suspended');
    const resumed = await call(executor, 'review_resume', { planId: plan.id, expectedUpdatedAt: suspendedPlan.updatedAt });
    const resumedPlan = (resumed.result.output as { plan: { status: string; updatedAt: string } }).plan;
    expect(resumedPlan.status).toBe('new');
    const deleted = await call(executor, 'review_delete', { plan_id: plan.id, expected_updated_at: resumedPlan.updatedAt });
    expect(deleted.result.output).toMatchObject({ success: true, deleted: true, plan_id: plan.id, question_id: 'q_m',
      exam_id: 'exam_m', previous_status: 'new', reversible: false });
    expect(host.eventsNamed('review://changed')).toEqual(['suspend', 'resume', 'delete'].map(action => ({
      source: 'agent', action, operation: `review_${action}`, planId: plan.id, plan_id: plan.id,
      entityIds: [plan.id], runId: 'call_1',
    })));
    expect(db.pluck('SELECT COUNT(*) FROM review_plans')).toBe(0);
  });

  // Rust `*_if_unchanged` wraps the repo conflict in anyhow `with_context`, so its
  // `mutation_error` only sees "Failed to suspend review plan: …" and returns the
  // generic "复习计划suspend失败: …" text: the REVIEW_CONFLICT branch written for
  // exactly these three tools is unreachable there.
  it('RF-W03-review-conflict-context-chain: stale suspend/resume/delete keep the structured REVIEW_CONFLICT payload', async () => {
    const { host, db, executor } = await installReview();
    insertExam(db, 'exam_c');
    insertQuestion(db, 'q_c', 'exam_c', 'card_c', '题');
    await call(executor, 'review_plan_generate', { exam_id: 'exam_c' });
    const plan = db.get<{ id: string; updated_at: string }>('SELECT id, updated_at FROM review_plans')!;
    host.events.length = 0;

    for (const action of ['suspend', 'resume', 'delete']) {
      const { result, recorded } = await call(executor, `review_${action}`, { plan_id: plan.id, expected_updated_at: 'stale' });
      expect(result.success).toBe(false);
      const conflict = JSON.parse(result.error!) as Record<string, unknown>;
      expect(conflict).toMatchObject({
        code: 'REVIEW_CONFLICT', action, plan_id: plan.id, expected_updated_at: 'stale', retryable: false,
        messageKey: 'chat.tools.review.conflict', messageParams: { action, plan_id: plan.id },
      });
      expect(conflict.current).toMatchObject({ plan_id: plan.id, status: 'new', updatedAt: plan.updated_at });
      expect(recorded.errors).toEqual([result.error]);
    }
    expect(db.pluck('SELECT COUNT(*) FROM review_plans')).toBe(1);
    expect(host.eventsNamed('review://changed')).toEqual([]);
  });

  it('reports Rust error strings and never emits after a failed mutation', async () => {
    const { host, db, executor } = await installReview();
    insertExam(db, 'exam_e');
    insertQuestion(db, 'q_e', 'exam_e', 'card_e', '题');
    await call(executor, 'review_plan_generate', { exam_id: 'exam_e' });
    const plan = db.get<{ id: string }>('SELECT id FROM review_plans')!;
    host.events.length = 0;

    const cases: [string, unknown, string][] = [
      ['review_schedule', {}, "Missing 'exam_id' parameter（题目集 ID，即 qbank 工具返回的 session_id）"],
      ['review_schedule', { exam_id: 'exam_e' }, '必须提供 question_ids 或 card_ids 至少一项。若想为整个题目集生成计划，请改用 review_plan_generate。'],
      ['review_schedule', { exam_id: 'exam_e', card_ids: ['nope'] }, '所有 card_ids 都无法解析为题目: ["nope"]（请确认 exam_id 与 card_id 是否匹配）'],
      ['review_submit', { quality: 6, expected_updated_at: 'x' }, 'quality 必须在 0-5 之间（当前: 6）。0=完全不记得, 3=勉强正确, 5=完美回忆'],
      ['review_submit', { quality: 3 }, 'Missing required parameter: expected_updated_at (use updatedAt from review_get_due)'],
      ['review_submit', { quality: 3, expected_updated_at: 'x', question_id: 'q_none' }, '题目 q_none 尚无复习计划，请先用 review_schedule 创建'],
      ['review_get_due', { until_date: '2026-7-1' }, "参数 'until_date' 日期格式无效: 2026-7-1（应为 YYYY-MM-DD）"],
      ['review_suspend', { plan_id: plan.id }, 'Missing required parameter: expected_updated_at (use updatedAt from review_get_due)'],
      ['review_delete', { plan_id: 'rp_missing', expected_updated_at: 'x' }, 'Review plan not found: rp_missing'],
      ['review_unknown', {}, 'Unknown review tool: review_unknown'],
    ];
    for (const [name, args, error] of cases) {
      const { result, recorded } = await call(executor, name, args);
      expect({ name, success: result.success, error: result.error, output: result.output })
        .toEqual({ name, success: false, error, output: null });
      expect(recorded.errors).toEqual([error]);
      expect(recorded.saved[0]?.success).toBe(false);
    }
    expect(host.eventsNamed('review://changed')).toEqual([]);
  });

  it('fails closed without VFS and skips notifications without a window', async () => {
    const missing = await installReview(false);
    const unavailable = await call(missing.executor, 'review_stats', {});
    expect(unavailable.result).toMatchObject({ success: false, error: 'VFS database not available' });

    const { host, db, executor } = await installReview();
    insertExam(db, 'exam_w');
    insertQuestion(db, 'q_w', 'exam_w', 'card_w', '题');
    const headless = await call(executor, 'review_plan_generate', { exam_id: 'exam_w' }, false);
    expect(headless.result.success).toBe(true);
    expect(host.eventsNamed('review://changed')).toEqual([]);
  });
});

// review_executor.rs:272,545 `format!("…失败: {}", e)`：e 是 AppError，Display 只输出 message（models.rs:1038-1042，V08-04）。
describe('ReviewToolExecutor service failure text', () => {
  it('formats a thrown AppError with its message only, like Rust Display', async () => {
    const executor = new ReviewToolExecutor({
      service: () => ({
        getReviewStats: () => { throw appError('Database', 'no such table: review_plans'); },
        getDueReviewsWithFilter: () => { throw AppError.not_found('exam missing'); },
      }) as never,
      getQuestion: () => null, questionBank: () => null, emit: () => undefined, log: silentToolLog,
    });
    const stats = await call(executor, 'review_stats', {});
    expect(stats.result).toMatchObject({ success: false, error: '获取复习统计失败: no such table: review_plans' });
    const due = await call(executor, 'review_get_due', {});
    expect(due.result).toMatchObject({ success: false, error: '查询到期复习失败: exam missing' });
  });
});
