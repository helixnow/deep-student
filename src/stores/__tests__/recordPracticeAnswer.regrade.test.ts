/**
 * recordPracticeAnswer 改判回写（2026-08 R4，修 R1-07 §三）—— 测试源码
 *
 * ⚠️ 执行门禁：本文件为 0824 Wave2-E 第 4 轮「测试源码」产物，**第 8 轮才统一执行**。
 * 第 4 轮只写不跑（与 store 的 R4 差量修正、handleMarkCorrect 回写并行落地）。
 *
 * 契约（与后端 apply_submission_verdict_in_tx 的差值口径对齐）：
 * - 首答：completed/answered +1，correct 按判定 +0/+1（answered_question_ids 幂等）；
 * - 已答题再次上报（改判/重答）：completed / is_completed 不动，correct 按
 *   「旧判定 → 新判定」差量修正：null→true +1、false→true +1、true→false -1、
 *   其余 0；下限 0；同向重复上报为空操作；
 * - 旧会话兼容（"旧卡无 daily 字段"）：
 *   a) 只有 answered_question_ids 数组、无 answered_results 基线的旧版会话残留：
 *      方向不可知 → 保持首答锁 fail-closed，等后端全量重算收敛；
 *   b) 后端原始 payload（两个前端补充字段都没有）：首答正常计数并建立基线；
 * - applyAuthoritativeDailyProgress：submit/regrade 响应回带 daily_progress 时
 *   用后端权威值覆盖本地乐观计数（exam / 日期匹配才生效，跨零点旧会话不覆盖）。
 *
 * 基线测试（首答幂等、会话门禁、目标达成）在
 * tests/vitest/question-bank-practice-progress.test.ts，本文件只补 R4 增量语义。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { useQuestionBankStore } from '@/stores/questionBankStore';

function seedTimedSession(overrides: Record<string, unknown> = {}) {
  useQuestionBankStore.setState({
    timedSession: {
      id: 'timed-r4',
      exam_id: 'exam-1',
      duration_minutes: 30,
      question_count: 3,
      question_ids: ['q-1', 'q-2', 'q-3'],
      started_at: '2026-08-26T08:00:00.000Z',
      ended_at: null,
      answered_count: 0,
      correct_count: 0,
      is_timeout: false,
      is_submitted: false,
      paused_seconds: 0,
      is_paused: false,
      ...overrides,
    } as never,
  });
}

function seedDailyPractice(overrides: Record<string, unknown> = {}) {
  useQuestionBankStore.setState({
    dailyPractice: {
      date: '2026-08-26',
      exam_id: 'exam-1',
      question_ids: ['q-1', 'q-2', 'q-3'],
      daily_target: 2,
      completed_count: 0,
      correct_count: 0,
      source_distribution: { mistake_count: 1, new_count: 2, review_count: 0 },
      is_completed: false,
      ...overrides,
    } as never,
  });
}

const record = (examId: string, questionId: string, isCorrect: boolean | null) =>
  useQuestionBankStore.getState().recordPracticeAnswer(examId, questionId, isCorrect);

const daily = () => useQuestionBankStore.getState().dailyPractice!;
const timed = () => useQuestionBankStore.getState().timedSession!;

beforeEach(() => {
  useQuestionBankStore.setState({ timedSession: null, dailyPractice: null });
});

describe('recordPracticeAnswer 改判回写（R4 差量修正）', () => {
  it('daily：待判定(null)改判为对时回补 correct，completed 不重复计', () => {
    seedDailyPractice();

    // 主观题首答：is_correct=null → completed +1、correct +0
    record('exam-1', 'q-1', null);
    expect(daily()).toMatchObject({ completed_count: 1, correct_count: 0 });

    // 自评"我答对了"（handleMarkCorrect 路径再次上报）→ correct 回补，completed 不动
    record('exam-1', 'q-1', true);
    expect(daily()).toMatchObject({ completed_count: 1, correct_count: 1 });
    // 改判不制造达标：completed(1) < target(2)
    expect(daily().is_completed).toBe(false);
  });

  it('daily：改判全转移表（true→false 回收、false→true 回补、null→false 零变化），下限 0', () => {
    seedDailyPractice();

    record('exam-1', 'q-1', true);
    expect(daily()).toMatchObject({ completed_count: 1, correct_count: 1 });

    // true→false：-1
    record('exam-1', 'q-1', false);
    expect(daily()).toMatchObject({ completed_count: 1, correct_count: 0 });

    // false→true：+1
    record('exam-1', 'q-1', true);
    expect(daily()).toMatchObject({ completed_count: 1, correct_count: 1 });

    // 另一题 null→false：correct 不动
    record('exam-1', 'q-2', null);
    record('exam-1', 'q-2', false);
    expect(daily()).toMatchObject({ completed_count: 2, correct_count: 1 });

    // 再把唯一的对题改错：回收到 0，且绝不为负
    record('exam-1', 'q-1', false);
    expect(daily()).toMatchObject({ completed_count: 2, correct_count: 0 });
    record('exam-1', 'q-2', false);
    expect(daily().correct_count).toBe(0);
  });

  it('daily：同向重复上报是空操作（连点两次"我答对了"）', () => {
    seedDailyPractice();
    record('exam-1', 'q-1', true);
    const before = daily();

    record('exam-1', 'q-1', true);
    expect(daily()).toMatchObject({
      completed_count: before.completed_count,
      correct_count: before.correct_count,
      is_completed: before.is_completed,
    });
  });

  it('daily：改判不改变 is_completed（达标由题数决定，与判定无关）', () => {
    seedDailyPractice({ daily_target: 1 });
    record('exam-1', 'q-1', true);
    expect(daily().is_completed).toBe(true);

    // 达标后改判为错：correct 回收，但完成状态（题数维度）不回退
    record('exam-1', 'q-1', false);
    expect(daily()).toMatchObject({
      completed_count: 1,
      correct_count: 0,
      is_completed: true,
    });
  });

  it('timed：差量口径与 daily 一致（null→true 回补、true→false 回收，answered 不动）', () => {
    seedTimedSession();

    record('exam-1', 'q-1', null);
    expect(timed()).toMatchObject({ answered_count: 1, correct_count: 0 });

    record('exam-1', 'q-1', true);
    expect(timed()).toMatchObject({ answered_count: 1, correct_count: 1 });

    record('exam-1', 'q-1', false);
    expect(timed()).toMatchObject({ answered_count: 1, correct_count: 0 });

    // 下限 0：连续改错不越界
    record('exam-1', 'q-1', false);
    expect(timed().correct_count).toBe(0);
  });

  it('会话门禁在改判路径同样生效（非会话题目/其他题库的改判被忽略）', () => {
    seedDailyPractice();
    record('exam-1', 'q-1', true);

    record('exam-other', 'q-1', false);
    record('exam-1', 'q-not-in-session', false);
    expect(daily()).toMatchObject({ completed_count: 1, correct_count: 1 });
  });
});

describe('旧会话兼容（旧卡无 R4 daily 字段）', () => {
  it('旧会话只有 answered_question_ids、无 answered_results 基线：改判保持首答锁 fail-closed', () => {
    // 模拟 R4 之前持久化/交接的会话对象：有去重数组、没有判定基线
    seedDailyPractice({
      completed_count: 1,
      correct_count: 1,
      answered_question_ids: ['q-1'],
    });

    // 方向不可知：不加也不减，不崩溃，等后端 get_daily_practice 全量重算收敛
    expect(() => record('exam-1', 'q-1', false)).not.toThrow();
    expect(daily()).toMatchObject({ completed_count: 1, correct_count: 1 });

    // 旧会话内的新题首答仍正常计数
    record('exam-1', 'q-2', true);
    expect(daily()).toMatchObject({ completed_count: 2, correct_count: 2 });
  });

  it('后端原始 daily payload（无任何前端补充字段）：首答建立基线，随后可改判', () => {
    // 后端 DailyPracticeResult 不含 answered_question_ids / answered_results
    seedDailyPractice();
    expect(daily().answered_question_ids).toBeUndefined();

    record('exam-1', 'q-1', null);
    record('exam-1', 'q-1', true);
    expect(daily()).toMatchObject({ completed_count: 1, correct_count: 1 });
  });

  it('timed 旧会话（有数组无基线）同样保持首答锁', () => {
    seedTimedSession({
      answered_count: 1,
      correct_count: 1,
      answered_question_ids: ['q-1'],
    });

    expect(() => record('exam-1', 'q-1', false)).not.toThrow();
    expect(timed()).toMatchObject({ answered_count: 1, correct_count: 1 });
  });
});

describe('applyAuthoritativeDailyProgress 权威回写', () => {
  const apply = (examId: string, progress: Record<string, unknown>) =>
    useQuestionBankStore
      .getState()
      .applyAuthoritativeDailyProgress(examId, progress as never);

  it('同 exam 同日期：覆盖 completed/correct，is_completed 缺省时按 target 推导', () => {
    seedDailyPractice({ completed_count: 1, correct_count: 1 });

    expect(
      apply('exam-1', { date: '2026-08-26', completed_count: 2, correct_count: 1 }),
    ).toBe(true);
    expect(daily()).toMatchObject({
      completed_count: 2,
      correct_count: 1,
      is_completed: true, // 2 >= daily_target(2)
    });
  });

  it('后端显式 is_completed 优先于本地推导', () => {
    seedDailyPractice();
    expect(
      apply('exam-1', {
        date: '2026-08-26',
        completed_count: 5,
        correct_count: 5,
        is_completed: false,
      }),
    ).toBe(true);
    expect(daily().is_completed).toBe(false);
  });

  it('跨零点旧会话（日期不一致）：不覆盖并返回 false', () => {
    seedDailyPractice({ date: '2026-08-25', completed_count: 1, correct_count: 0 });

    expect(
      apply('exam-1', { date: '2026-08-26', completed_count: 9, correct_count: 9 }),
    ).toBe(false);
    expect(daily()).toMatchObject({ completed_count: 1, correct_count: 0 });
  });

  it('exam 不匹配或无 daily 会话：返回 false 且无副作用', () => {
    expect(
      apply('exam-1', { date: '2026-08-26', completed_count: 1, correct_count: 1 }),
    ).toBe(false);

    seedDailyPractice();
    expect(
      apply('exam-other', { date: '2026-08-26', completed_count: 1, correct_count: 1 }),
    ).toBe(false);
    expect(daily()).toMatchObject({ completed_count: 0, correct_count: 0 });
  });

  it('非法计数（负数/非整数）不覆盖', () => {
    seedDailyPractice({ completed_count: 1, correct_count: 1 });
    expect(
      apply('exam-1', { date: '2026-08-26', completed_count: -1, correct_count: 0 }),
    ).toBe(false);
    expect(
      apply('exam-1', { date: '2026-08-26', completed_count: 2, correct_count: 1.5 }),
    ).toBe(false);
    expect(daily()).toMatchObject({ completed_count: 1, correct_count: 1 });
  });
});
