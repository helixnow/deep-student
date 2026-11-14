import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import qbank from '../index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import { fakeMasteryService } from './support/mastery.ts';
import type {
  ActivityHeatmapPoint, CheckInCalendar, CreateQuestionParams, DailyPracticeResult, KnowledgePoint,
  KnowledgeStatsComparison, LearningTrendPoint, MockExamScoreCard, MockExamSession, Question,
  SubmitAnswerResult, TimedPracticeSession,
} from '../api.ts';

const NOW = '2026-01-01T00:00:00+00:00';

async function fixture() {
  const { storage, base } = await createMigratedStorage('qbank-statistics-');
  const host = await createTestHost({
    plugins: [qbank, vfsRepos],
    provide: {
      storage,
      paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32'
        : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }),
      ...fakeMasteryService(),
    },
  });
  const db = storage.database('vfs');
  db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at)
    VALUES ('exam_1', '题目集一', 'completed', 't1', '{}', '{}', ?1, ?1)`, [NOW]);
  return {
    host, db, storage,
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

function params(content: string, overrides: Partial<CreateQuestionParams> = {}): CreateQuestionParams {
  return {
    exam_id: 'exam_1', content, answer: 'A',
    options: [{ key: 'A', content: '正确' }, { key: 'B', content: '错误' }],
    question_type: 'single_choice', difficulty: 'easy', tags: ['算术'], source_type: 'manual',
    ...overrides,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function createQuestions(f: Fixture, count: number, overrides: Partial<CreateQuestionParams> = {}): Promise<Question[]> {
  const questions: Question[] = [];
  for (let index = 0; index < count; index += 1) {
    questions.push(await f.host.invoke('qbank_create_question', {
      params: params(`question ${index}?`, overrides),
    }) as Question);
  }
  return questions;
}

async function submit(f: Fixture, questionId: string, answer: string, override: boolean,
  clientRequestId: string): Promise<SubmitAnswerResult> {
  return f.host.invoke('qbank_submit_answer', {
    request: { question_id: questionId, user_answer: answer, is_correct_override: override,
      client_request_id: clientRequestId },
  }) as Promise<SubmitAnswerResult>;
}

function localDate(offsetDays = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localNoonIso(offsetDays = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0).toISOString();
}

describe('question_bank_service.rs statistics', () => {
  it('test_compute_streak_days', async () => {
    const f = await fixture();
    try {
      const [question] = await createQuestions(f, 1);
      const submissions: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        const result = await submit(f, question!.id, 'A', true, `streak-${index}`);
        submissions.push(result.submission_id);
        f.db.run('UPDATE answer_submissions SET submitted_at = ?1 WHERE id = ?2',
          [localNoonIso(-index), result.submission_id]);
      }
      const calendar = async () => f.host.invoke('qbank_get_check_in_calendar', {
        request: { exam_id: 'exam_1', year: new Date().getFullYear(), month: new Date().getMonth() + 1 },
      }) as Promise<CheckInCalendar>;

      expect((await calendar()).streak_days).toBe(4);

      // 中间断档只算到断档处：把「前天」挪到「四天前」。
      f.db.run('UPDATE answer_submissions SET submitted_at = ?1 WHERE id = ?2',
        [localNoonIso(-4), submissions[2]!]);
      expect((await calendar()).streak_days).toBe(2);

      // 重复日期（防御）不应重复计数。
      for (const submissionId of submissions) {
        f.db.run('UPDATE answer_submissions SET submitted_at = ?1 WHERE id = ?2',
          [localNoonIso(0), submissionId]);
      }
      expect((await calendar()).streak_days).toBe(1);

      // 最近一次打卡在前天：已中断。
      for (const submissionId of submissions) {
        f.db.run('UPDATE answer_submissions SET submitted_at = ?1 WHERE id = ?2',
          [localNoonIso(-2), submissionId]);
      }
      expect((await calendar()).streak_days).toBe(0);

      // 空历史。
      expect((await f.host.invoke('qbank_get_check_in_calendar', {
        request: { exam_id: 'empty_exam', year: new Date().getFullYear(), month: new Date().getMonth() + 1 },
      }) as CheckInCalendar).streak_days).toBe(0);
    } finally { await f.dispose(); }
  });

  it('daily_practice_progress_reflects_todays_submissions', async () => {
    const f = await fixture();
    try {
      const questions = await createQuestions(f, 8, { question_type: 'fill_blank', answer: '2', options: null });
      await submit(f, questions[0]!.id, '2', true, 'dp-1');
      await submit(f, questions[1]!.id, 'x', false, 'dp-2');

      const daily = await f.host.invoke('qbank_get_daily_practice', {
        request: { exam_id: 'exam_1', count: 5 },
      }) as DailyPracticeResult;
      expect(daily.completed_count).toBe(2);
      expect(daily.correct_count).toBe(1);
      expect(daily.is_completed).toBe(false);
      expect(daily.daily_target).toBe(5);
      expect(daily.question_ids).toHaveLength(5);
      expect(daily.question_ids).not.toContain(questions[0]!.id);
      expect(daily.question_ids).not.toContain(questions[1]!.id);
      expect(daily.source_distribution.new_count).toBe(5);

      await expect(f.host.invoke('qbank_get_daily_practice', {
        request: { exam_id: 'exam_1', count: 0 },
      })).rejects.toMatchObject({ error_type: 'Validation', message: '每日一练题目数量必须大于 0' });
    } finally { await f.dispose(); }
  });

  it('daily_practice_marks_completed_and_supports_another_round', async () => {
    const f = await fixture();
    try {
      const questions = await createQuestions(f, 3, { question_type: 'fill_blank', answer: '2', options: null });
      for (const [index, question] of questions.entries()) {
        await submit(f, question.id, '2', true, `dc-${index}`);
      }
      const daily = await f.host.invoke('qbank_get_daily_practice', {
        request: { exam_id: 'exam_1', count: 2 },
      }) as DailyPracticeResult;
      expect(daily.completed_count).toBe(3);
      expect(daily.correct_count).toBe(3);
      expect(daily.is_completed).toBe(true);
      expect(daily.question_ids.length).toBeGreaterThan(0);
    } finally { await f.dispose(); }
  });

  it('check_in_calendar_target_follows_user_goal', async () => {
    const f = await fixture();
    try {
      const questions = await createQuestions(f, 2, { question_type: 'fill_blank', answer: '2', options: null });
      await submit(f, questions[0]!.id, '2', true, 'cal-1');
      const now = new Date();
      const request = { exam_id: 'exam_1', year: now.getFullYear(), month: now.getMonth() + 1 };
      const lowTarget = await f.host.invoke('qbank_get_check_in_calendar', {
        request: { ...request, daily_target: 1 },
      }) as CheckInCalendar;
      const todayRow = lowTarget.days.find(day => day.date === localDate());
      expect(todayRow).toBeDefined();
      expect(todayRow!.target_achieved).toBe(true);
      expect(todayRow!.question_count).toBe(1);

      const defaultTarget = await f.host.invoke('qbank_get_check_in_calendar', { request }) as CheckInCalendar;
      const defaultRow = defaultTarget.days.find(day => day.date === localDate());
      expect(defaultRow!.target_achieved).toBe(false);
      expect(defaultTarget.month_check_in_days).toBe(1);
      expect(defaultTarget.month_total_questions).toBe(1);

      await expect(f.host.invoke('qbank_get_check_in_calendar', {
        request: { ...request, month: 13 },
      })).rejects.toMatchObject({ error_type: 'Validation', message: '月份必须在 1-12 之间' });
    } finally { await f.dispose(); }
  });

  it('activity_heatmap_and_learning_trend_aggregate_submissions', async () => {
    const f = await fixture();
    try {
      const questions = await createQuestions(f, 2);
      await submit(f, questions[0]!.id, 'A', true, 'heat-1');
      await submit(f, questions[1]!.id, 'B', false, 'heat-2');
      const today = localDate();
      const year = new Date().getFullYear();
      const heatmap = await f.host.invoke('qbank_get_activity_heatmap', {
        request: { exam_id: 'exam_1', year },
      }) as ActivityHeatmapPoint[];
      expect(heatmap).toEqual([{ date: today, count: 2, correct_count: 1, level: 1 }]);

      const trend = await f.host.invoke('qbank_get_learning_trend', {
        request: { exam_id: 'exam_1', start_date: today, end_date: today },
      }) as LearningTrendPoint[];
      expect(trend).toEqual([{ date: today, attempt_count: 2, correct_count: 1, correct_rate: 50 }]);

      await expect(f.host.invoke('qbank_get_learning_trend', {
        request: { exam_id: 'exam_1', start_date: today, end_date: localDate(-1) },
      })).rejects.toMatchObject({ error_type: 'Validation', message: '开始日期不能晚于结束日期' });
      await expect(f.host.invoke('qbank_get_activity_heatmap', {
        request: { exam_id: 'exam_1', year: 1969 },
      })).rejects.toMatchObject({ error_type: 'Validation', message: '年份无效' });
    } finally { await f.dispose(); }
  });

  it('knowledge_stats_and_comparison_group_tags', async () => {
    const f = await fixture();
    try {
      const questions = await createQuestions(f, 2);
      await submit(f, questions[0]!.id, 'A', true, 'kp-1');
      const stats = await f.host.invoke('qbank_get_knowledge_stats', {
        request: { exam_id: 'exam_1' },
      }) as KnowledgePoint[];
      expect(stats).toEqual([{
        tag: '算术', total: 2, mastered: 0, in_progress: 1, review: 0, new_count: 1,
        mastery_rate: 25, correct_rate: 100,
      }]);
      const comparison = await f.host.invoke('qbank_get_knowledge_stats_with_comparison', {
        request: { exam_id: 'exam_1' },
      }) as KnowledgeStatsComparison;
      expect(comparison.current).toEqual(stats);
      expect(comparison.previous).toEqual([]);
    } finally { await f.dispose(); }
  });

  it('timed_practice_and_mock_exam_score_card_match_rust_wire_shape', async () => {
    const f = await fixture();
    try {
      const questions = await createQuestions(f, 3);
      const timed = await f.host.invoke('qbank_start_timed_practice', {
        request: { exam_id: 'exam_1', duration_minutes: 30, question_count: 2 },
      }) as TimedPracticeSession;
      expect(timed).toMatchObject({
        exam_id: 'exam_1', duration_minutes: 30, question_count: 2, answered_count: 0,
        correct_count: 0, is_timeout: false, is_submitted: false, paused_seconds: 0, is_paused: false,
      });
      expect(timed.question_ids).toHaveLength(2);
      expect(timed.started_at).toMatch(/\+00:00$/);
      await expect(f.host.invoke('qbank_start_timed_practice', {
        request: { exam_id: 'exam_1', duration_minutes: 0, question_count: 2 },
      })).rejects.toMatchObject({ error_type: 'Validation', message: '限时时长必须大于 0 分钟' });

      const mock = await f.host.invoke('qbank_generate_mock_exam', {
        request: {
          exam_id: 'exam_1',
          config: { duration_minutes: 20, type_distribution: { single_choice: 3 },
            difficulty_distribution: { easy: 3 }, total_count: 3, shuffle: false,
            include_mistakes: false, tags: null },
        },
      }) as MockExamSession;
      expect(mock.question_ids).toHaveLength(3);
      expect(new Set(mock.question_ids).size).toBe(3);
      expect(mock).toMatchObject({ exam_id: 'exam_1', is_submitted: false, answers: {}, results: {},
        score: null, correct_rate: null });
      expect(mock.config).toMatchObject({ duration_minutes: 20, total_count: 3, include_mistakes: false });

      const started = Date.parse(mock.started_at);
      const session = {
        ...mock,
        ended_at: new Date(started + 60_000).toISOString().replace('Z', '+00:00'),
        answers: { [mock.question_ids[0]!]: 'A', [mock.question_ids[1]!]: 'B' },
        results: { [mock.question_ids[0]!]: true, [mock.question_ids[1]!]: false },
      };
      const card = await f.host.invoke('qbank_submit_mock_exam', { request: { session } }) as MockExamScoreCard;
      expect(card).toMatchObject({
        session_id: mock.id, exam_id: 'exam_1', total_count: 3, answered_count: 2, correct_count: 1,
        wrong_count: 1, unanswered_count: 1, correct_rate: 33, time_spent_seconds: 60,
        wrong_question_ids: [mock.question_ids[1]!], comment: '需要加强练习，建议复习错题。',
      });
      expect(card.type_stats.SingleChoice).toEqual({ total: 3, correct: 1, rate: 33 });
      expect(card.difficulty_stats.Easy).toEqual({ total: 3, correct: 1, rate: 33 });
      expect(card.completed_at).toMatch(/\+00:00$/);
      expect(questions).toHaveLength(3);
    } finally { await f.dispose(); }
  });
});
