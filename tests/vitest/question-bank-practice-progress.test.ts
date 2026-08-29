/**
 * 练习会话进度回写（2026-08 修复回归）：
 * - recordPracticeAnswer 是 timedSession / dailyPractice 全局会话对象的唯一
 *   真实写入方（真实答题走 useQuestionBankSession，之前这两个对象恒为 0 进度）。
 * - 会话内每题 answered/completed 只计首答；correct 按最近判定差量修正
 *   （改判/重答可减）；跨题目集 / 非会话题目是空操作。
 * - 每日目标按题目集持久化（localStorage），重开恢复。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import {
  getPracticeSessionKey,
  useQuestionBankStore,
  type PracticeSessionOwner,
} from '@/stores/questionBankStore';
import {
  normalizeDailyTarget,
  readStoredDailyTarget,
  writeStoredDailyTarget,
} from '@/components/practice/DailyPracticeMode';

const startedAt = '2026-08-24T08:00:00.000Z';

describe('questionBankStore practice-session ownership', () => {
  const leftOwner: PracticeSessionOwner = {
    examId: 'exam-shared',
    viewInstanceId: 'view-left',
  };
  const rightOwner: PracticeSessionOwner = {
    examId: 'exam-shared',
    viewInstanceId: 'view-right',
  };

  beforeEach(() => {
    useQuestionBankStore.setState({ practiceSessions: {} });
  });

  it('isolates answers between two kept-alive instances of the same exam', () => {
    const store = useQuestionBankStore.getState();
    store.ensurePracticeSession(leftOwner, ['q-1', 'q-2']);
    store.ensurePracticeSession(rightOwner, ['q-1', 'q-2']);

    expect(store.recordPracticeSessionAnswer(leftOwner, 'q-1', true)).toMatchObject({
      streakCount: 1,
      totalCorrectCount: 1,
      answeredIds: ['q-1'],
    });

    const leftKey = getPracticeSessionKey(leftOwner)!;
    const rightKey = getPracticeSessionKey(rightOwner)!;
    expect(useQuestionBankStore.getState().practiceSessions[rightKey]).toMatchObject({
      streakCount: 0,
      totalCorrectCount: 0,
      answeredIds: [],
    });

    store.recordPracticeSessionAnswer(rightOwner, 'q-2', false);
    expect(useQuestionBankStore.getState().practiceSessions[leftKey]).toMatchObject({
      streakCount: 1,
      totalCorrectCount: 1,
      answeredIds: ['q-1'],
    });
    expect(useQuestionBankStore.getState().practiceSessions[rightKey].answeredIds).toEqual(['q-2']);
  });

  it('fails closed for missing ownership and questions outside the owned exam', () => {
    const store = useQuestionBankStore.getState();
    store.ensurePracticeSession(leftOwner, ['q-left']);
    const before = useQuestionBankStore.getState().practiceSessions;

    expect(store.recordPracticeSessionAnswer(rightOwner, 'q-left', true)).toBeNull();
    expect(store.recordPracticeSessionAnswer(leftOwner, 'q-right', true)).toBeNull();
    expect(useQuestionBankStore.getState().practiceSessions).toBe(before);
  });
});

function seedTimedSession(overrides: Record<string, unknown> = {}) {
  useQuestionBankStore.setState({
    timedSession: {
      id: 'timed-1',
      exam_id: 'exam-1',
      duration_minutes: 30,
      question_count: 2,
      question_ids: ['q-1', 'q-2'],
      started_at: startedAt,
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
      date: '2026-08-24',
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

describe('questionBankStore.recordPracticeAnswer', () => {
  beforeEach(() => {
    useQuestionBankStore.setState({ timedSession: null, dailyPractice: null });
  });

  it('increments timed session progress once per question (answered first-wins; correct tracks latest verdict)', () => {
    seedTimedSession();
    const record = useQuestionBankStore.getState().recordPracticeAnswer;

    record('exam-1', 'q-1', true);
    let timed = useQuestionBankStore.getState().timedSession!;
    expect(timed.answered_count).toBe(1);
    expect(timed.correct_count).toBe(1);

    // 同判定重复上报是空操作（answered / correct 都不累计）
    record('exam-1', 'q-1', true);
    timed = useQuestionBankStore.getState().timedSession!;
    expect(timed.answered_count).toBe(1);
    expect(timed.correct_count).toBe(1);

    // 改判/重答：answered 仍只计首答；correct 按 true→false 差量回收
    record('exam-1', 'q-1', false);
    timed = useQuestionBankStore.getState().timedSession!;
    expect(timed.answered_count).toBe(1);
    expect(timed.correct_count).toBe(0);

    // 待人工批改（isCorrect=null）计入已答但不计正确
    record('exam-1', 'q-2', null);
    timed = useQuestionBankStore.getState().timedSession!;
    expect(timed.answered_count).toBe(2);
    expect(timed.correct_count).toBe(0);
  });

  it('ignores answers outside the session (other exam, non-member question, finished session)', () => {
    seedTimedSession();
    const record = useQuestionBankStore.getState().recordPracticeAnswer;

    record('exam-other', 'q-1', true);
    record('exam-1', 'q-not-in-session', true);
    expect(useQuestionBankStore.getState().timedSession!.answered_count).toBe(0);

    seedTimedSession({ is_submitted: true });
    record('exam-1', 'q-1', true);
    expect(useQuestionBankStore.getState().timedSession!.answered_count).toBe(0);
  });

  it('tracks daily practice completion against the user target', () => {
    seedDailyPractice();
    const record = useQuestionBankStore.getState().recordPracticeAnswer;

    record('exam-1', 'q-1', true);
    let daily = useQuestionBankStore.getState().dailyPractice!;
    expect(daily.completed_count).toBe(1);
    expect(daily.correct_count).toBe(1);
    expect(daily.is_completed).toBe(false);

    record('exam-1', 'q-2', false);
    daily = useQuestionBankStore.getState().dailyPractice!;
    expect(daily.completed_count).toBe(2);
    expect(daily.correct_count).toBe(1);
    expect(daily.is_completed).toBe(true);

    // 达标后继续做题仍如实累计
    record('exam-1', 'q-3', true);
    daily = useQuestionBankStore.getState().dailyPractice!;
    expect(daily.completed_count).toBe(3);
    expect(daily.correct_count).toBe(2);
  });

  it('updates both timed and daily sessions when the question belongs to both', () => {
    seedTimedSession();
    seedDailyPractice();
    useQuestionBankStore.getState().recordPracticeAnswer('exam-1', 'q-1', true);

    expect(useQuestionBankStore.getState().timedSession!.answered_count).toBe(1);
    expect(useQuestionBankStore.getState().dailyPractice!.completed_count).toBe(1);
  });
});

describe('daily target persistence helpers', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('normalizes targets into the 5..=50 range', () => {
    expect(normalizeDailyTarget(Number.NaN)).toBe(10);
    expect(normalizeDailyTarget(0)).toBe(5);
    expect(normalizeDailyTarget(23.6)).toBe(24);
    expect(normalizeDailyTarget(999)).toBe(50);
  });

  it('round-trips the target per exam and falls back to the default', () => {
    expect(readStoredDailyTarget('exam-a')).toBe(10);

    writeStoredDailyTarget('exam-a', 25);
    writeStoredDailyTarget('exam-b', 5);
    expect(readStoredDailyTarget('exam-a')).toBe(25);
    expect(readStoredDailyTarget('exam-b')).toBe(5);

    // 脏数据（手改 localStorage）按归一化口径修复
    localStorage.setItem('qbank:dailyTarget:exam-a', 'not-a-number');
    expect(readStoredDailyTarget('exam-a')).toBe(10);
    localStorage.setItem('qbank:dailyTarget:exam-a', '999');
    expect(readStoredDailyTarget('exam-a')).toBe(50);
  });
});
