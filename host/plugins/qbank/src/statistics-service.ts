/** Time-series, daily practice, timed/mock sessions and knowledge statistics. */
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type {
  ActivityHeatmapPoint, CheckInCalendar, DailyCheckIn, DailyPracticeResult, DifficultyStatItem,
  KnowledgePoint, KnowledgeStatsComparison, LearningTrendPoint, MockExamConfig, MockExamConfig__De, // boundary-allow test-double: Rust 领域词 MockExam（模拟考试），非测试替身
  MockExamScoreCard, MockExamSession, MockExamSession__De, Question, QuestionFilters,
  TimedPracticeSession, TypeStatItem,
} from '../api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { rfc3339FromMillis } from '../../../platform/storage/time.ts';
import { parseRfc3339 } from '../../../platform/time/index.ts';
import { QbankServiceError } from './question-service.ts';
import { difficultyFrom, questionTypeFrom } from './question-enums.ts';
import type { QbankLogger } from './ports.ts';
import type { QuestionRepository } from '../../vfs-repos/api.ts';
import { vfsFilters } from './question-repository-adapter.ts';
import { localDate, utcNow } from '../repository/questions.ts';
import * as stats from '../repository/statistics.ts';

export interface StatisticsServiceHost {
  readonly db: DatabaseHandle;
  readonly questions: QuestionRepository;
  readonly log?: QbankLogger;
}

function validation(message: string): never {
  throw new QbankServiceError(AppError.validation(message));
}
function withDatabase<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof QbankServiceError) throw error;
    throw new QbankServiceError(AppError.database(error instanceof Error ? error.message : String(error)));
  }
}
function parseDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return Math.floor(date.getTime() / 86_400_000);
}
function formatDate(epochDay: number): string {
  return new Date(epochDay * 86_400_000).toISOString().slice(0, 10);
}
function todayEpochDay(): number {
  const now = new Date();
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000);
}
function round(value: number): number {
  return Math.round(value);
}
function saturatingSub(left: number, right: number): number {
  return Math.max(0, left - right);
}

/** question_bank_service.rs:2062-2152 */
export function getActivityHeatmap(host: StatisticsServiceHost, examId: string | null,
  year: number): ActivityHeatmapPoint[] {
  return withDatabase(() => {
    if (year < 1970 || year > 9999) validation('年份无效');
    const start = `${String(year).padStart(4, '0')}-01-01`;
    const end = `${String(year).padStart(4, '0')}-12-31`;
    return stats.activityBetween(host.db, examId, start, end).map(row => {
      const count = row.count;
      const level = count === 0 ? 0 : count <= 3 ? 1 : count <= 6 ? 2 : count <= 10 ? 3 : 4;
      return { date: row.date, count, correct_count: row.correct_count, level };
    });
  });
}

/** question_bank_service.rs:2157-2244 */
export function getKnowledgeStats(host: StatisticsServiceHost, examId: string | null): KnowledgePoint[] {
  return withDatabase(() => stats.knowledgeRows(host.db, examId).map(row => ({
    tag: row.tag,
    total: row.total,
    mastered: row.mastered,
    in_progress: row.in_progress,
    review: row.review,
    new_count: row.new_count,
    mastery_rate: row.total > 0 ? round((row.mastered + row.in_progress * 0.5) / row.total * 100) : 0,
    correct_rate: row.total_attempts > 0 ? round(row.total_correct / row.total_attempts * 100) : 0,
  })));
}

export function getKnowledgeStatsWithComparison(host: StatisticsServiceHost,
  examId: string | null): KnowledgeStatsComparison {
  return { current: getKnowledgeStats(host, examId), previous: [] };
}

/** question_bank_service.rs:1925-2018 */
export function getLearningTrend(host: StatisticsServiceHost, examId: string | null,
  startDate: string, endDate: string): LearningTrendPoint[] {
  return withDatabase(() => {
    const start = parseDate(startDate);
    if (start === null) validation('开始日期格式无效，应为 YYYY-MM-DD');
    const end = parseDate(endDate);
    if (end === null) validation('结束日期格式无效，应为 YYYY-MM-DD');
    if (start > end) validation('开始日期不能晚于结束日期');
    if (end - start > 3700) validation('日期范围过大（最多支持约 10 年）');
    const byDate = new Map(stats.trendBetween(host.db, examId, startDate, endDate)
      .map(row => [row.date, row]));
    const result: LearningTrendPoint[] = [];
    for (let day = start; day <= end; day += 1) {
      const date = formatDate(day);
      const row = byDate.get(date);
      const attemptCount = row?.attempt_count ?? 0;
      const correctCount = row?.correct_count ?? 0;
      result.push({
        date, attempt_count: attemptCount, correct_count: correctCount,
        correct_rate: attemptCount > 0 ? round(correctCount / attemptCount * 100) : 0,
      });
    }
    return result;
  });
}

/** question_bank_service.rs:2969-3200 */
export function getCheckInCalendar(host: StatisticsServiceHost, examId: string | null,
  year: number, month: number, dailyTarget: number | null): CheckInCalendar {
  return withDatabase(() => {
    if (month < 1 || month > 12) validation('月份必须在 1-12 之间');
    if (year < 1970 || year > 9999) validation('年份无效');
    const target = Math.max(1, dailyTarget ?? 10);
    const start = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
    const endExclusive = month === 12
      ? `${String(year + 1).padStart(4, '0')}-01-01`
      : `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-01`;
    const focus = stats.focusSecondsByLocalDate(host.db, start, endExclusive, host.log);
    const rows = stats.checkInRows(host.db, examId, start, endExclusive);
    const days: DailyCheckIn[] = rows.map(row => ({
      date: row.date, exam_id: examId, question_count: row.count, correct_count: row.correct_count,
      study_duration_seconds: focus.get(row.date) ?? 0, target_achieved: row.count >= target,
    }));
    const monthFocusSeconds = [...focus.values()].reduce((sum, seconds) => sum + seconds, 0);
    const monthTotalQuestions = days.reduce((sum, day) => sum + day.question_count, 0);
    return {
      exam_id: examId, year, month, days, streak_days: queryStreakDays(host, examId),
      month_check_in_days: days.length, month_total_questions: monthTotalQuestions,
      month_focus_seconds: Math.min(monthFocusSeconds, 0xffff_ffff),
    };
  });
}

function queryStreakDays(host: StatisticsServiceHost, examId: string | null): number {
  const today = todayEpochDay();
  const dates = stats.streakDates(host.db, examId, formatDate(today))
    .map(parseDate).filter((day): day is number => day !== null);
  if (dates.length === 0) return 0;
  const latest = dates[0]!;
  if (latest !== today && latest !== today - 1) return 0;
  let streak = 1;
  let previous = latest;
  for (const date of dates.slice(1)) {
    if (date >= previous) continue;
    if (previous - date === 1) {
      streak += 1;
      previous = date;
    } else {
      break;
    }
  }
  return streak;
}

/** question_bank_service.rs:2615-2760 */
export function getDailyPractice(host: StatisticsServiceHost, examId: string, count: number): DailyPracticeResult {
  return withDatabase(() => {
    if (count === 0) validation('每日一练题目数量必须大于 0');
    const today = localDate();
    const progress = host.questions.dailyProgressRows(host.db, examId, today);
    const answeredToday = progress.ids;
    const selected: string[] = [];
    const exclude = [...answeredToday];

    const mistakeFilters: QuestionFilters = { status: ['review'] };
    const mistakes = host.questions.randomQuestionIds(host.db, examId, vfsFilters(mistakeFilters), exclude, null,
      Math.max(1, Math.floor(count / 2)));
    selected.push(...mistakes);
    exclude.push(...mistakes);
    const mistakeCount = selected.length;

    if (selected.length < count) {
      const newFilters: QuestionFilters = { status: ['new'] };
      const found = host.questions.randomQuestionIds(host.db, examId, vfsFilters(newFilters), exclude, null, count - selected.length);
      selected.push(...found);
      exclude.push(...found);
    }
    const newCount = saturatingSub(selected.length, mistakeCount);

    if (selected.length < count) {
      const sevenDaysAgo = rfc3339FromMillis((Math.floor(Date.now() / 1000) - 7 * 86_400) * 1000);
      const masteredFilters: QuestionFilters = { status: ['mastered'] };
      const found = host.questions.randomQuestionIds(host.db, examId, vfsFilters(masteredFilters), exclude,
        sevenDaysAgo, count - selected.length);
      selected.push(...found);
      exclude.push(...found);
    }
    const reviewCount = saturatingSub(saturatingSub(selected.length, mistakeCount), newCount);

    if (selected.length < count) {
      const found = host.questions.randomQuestionIds(host.db, examId, vfsFilters({}), exclude, null, count - selected.length);
      selected.push(...found);
      exclude.push(...found);
    }
    if (selected.length < count && answeredToday.length > 0) {
      const found = host.questions.randomQuestionIds(host.db, examId, vfsFilters({}), selected, null, count - selected.length);
      selected.push(...found);
    }
    if (selected.length === 0) validation('题目集中没有题目');
    return {
      date: today, exam_id: examId, question_ids: selected, daily_target: count,
      completed_count: answeredToday.length, correct_count: progress.correct,
      source_distribution: { mistake_count: mistakeCount, new_count: newCount, review_count: reviewCount },
      is_completed: answeredToday.length >= count,
    };
  });
}

/** question_bank_service.rs:2276-2328 */
export function startTimedPractice(host: StatisticsServiceHost, examId: string,
  durationMinutes: number, questionCount: number): TimedPracticeSession {
  return withDatabase(() => {
    if (questionCount === 0) validation('题目数量必须大于 0');
    if (durationMinutes === 0) validation('限时时长必须大于 0 分钟');
    const questionIds = host.questions.randomQuestionIds(host.db, examId, vfsFilters({}), [], null, questionCount);
    if (questionIds.length === 0) validation('题目集中没有题目');
    return {
      id: crypto.randomUUID(), exam_id: examId, duration_minutes: durationMinutes,
      question_count: questionIds.length, question_ids: questionIds, started_at: utcNow(),
      ended_at: null, answered_count: 0, correct_count: 0, is_timeout: false, is_submitted: false,
      paused_seconds: 0, is_paused: false,
    };
  });
}

function normalizeMockConfig(config: MockExamConfig__De): MockExamConfig { // boundary-allow test-double: Rust 领域词 MockExam（模拟考试），非测试替身
  return {
    duration_minutes: config.duration_minutes,
    type_distribution: config.type_distribution ?? {},
    difficulty_distribution: config.difficulty_distribution ?? {},
    total_count: config.total_count ?? null,
    shuffle: config.shuffle,
    include_mistakes: config.include_mistakes,
    tags: config.tags ?? null,
  };
}

/** question_bank_service.rs:2338-2460 */
export function generateMockExam(host: StatisticsServiceHost, examId: string, // boundary-allow test-double: Rust 领域词 MockExam（模拟考试），非测试替身
  rawConfig: MockExamConfig__De): MockExamSession {
  return withDatabase(() => {
    const config = normalizeMockConfig(rawConfig); // boundary-allow test-double: Rust 领域词 MockExam（模拟考试），非测试替身
    const baseFilters: QuestionFilters = {};
    if (config.tags !== null) baseFilters.tags = config.tags;
    if (!config.include_mistakes) baseFilters.status = ['new', 'in_progress', 'mastered'];
    const selected: string[] = [];
    for (const [type, count] of Object.entries(config.type_distribution)) {
      const ids = host.questions.randomQuestionIds(host.db, examId,
        vfsFilters({ ...baseFilters, question_type: [questionTypeFrom(type.toLowerCase())] as never }),
        selected, null, count);
      selected.push(...ids);
    }
    for (const [difficulty, count] of Object.entries(config.difficulty_distribution)) {
      const ids = host.questions.randomQuestionIds(host.db, examId,
        vfsFilters({ ...baseFilters, difficulty: [difficultyFrom(difficulty.toLowerCase())] as never }),
        selected, null, count);
      selected.push(...ids);
    }
    if (config.total_count !== null) {
      if (selected.length < config.total_count) {
        const fill = host.questions.randomQuestionIds(host.db, examId, vfsFilters(baseFilters), selected, null,
          config.total_count - selected.length);
        selected.push(...fill);
      } else if (selected.length > config.total_count) {
        shuffle(selected);
        selected.length = config.total_count;
      }
    }
    if (config.shuffle) shuffle(selected);
    if (selected.length === 0) validation('无法根据配置选出足够的题目');
    return {
      id: crypto.randomUUID(), exam_id: examId, config, question_ids: [...selected], started_at: utcNow(),
      ended_at: null, answers: {}, results: {}, is_submitted: false, score: null, correct_rate: null,
    };
  });
}

function shuffle<T>(values: T[]): void {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [values[index], values[other]] = [values[other]!, values[index]!];
  }
}

function debugQuestionType(type: Question['question_type']): string {
  const names: Record<Question['question_type'], string> = {
    single_choice: 'SingleChoice', multiple_choice: 'MultipleChoice', indefinite_choice: 'IndefiniteChoice',
    fill_blank: 'FillBlank', short_answer: 'ShortAnswer', essay: 'Essay', calculation: 'Calculation',
    proof: 'Proof', true_false: 'TrueFalse', matching: 'Matching', ordering: 'Ordering',
    numeric: 'Numeric', other: 'Other',
  };
  return names[type];
}
function debugDifficulty(difficulty: NonNullable<Question['difficulty']>): string {
  return { easy: 'Easy', medium: 'Medium', hard: 'Hard', very_hard: 'VeryHard' }[difficulty];
}

/** question_bank_service.rs:2463-2600 */
export function submitMockExam(host: StatisticsServiceHost, rawSession: MockExamSession__De): MockExamScoreCard { // boundary-allow test-double: Rust 领域词 MockExam（模拟考试），非测试替身
  return withDatabase(() => {
    const session = { ...rawSession, config: normalizeMockConfig(rawSession.config) }; // boundary-allow test-double: Rust 领域词 MockExam（模拟考试），非测试替身
    const totalCount = session.question_ids.length;
    const answeredCount = Object.keys(session.answers).length;
    const correctCount = Object.values(session.results).filter(Boolean).length;
    const wrongCount = saturatingSub(answeredCount, correctCount);
    const unansweredCount = saturatingSub(totalCount, answeredCount);
    const correctRate = totalCount > 0 ? round(correctCount / totalCount * 100) : 0;
    const started = parseRfc3339(session.started_at);
    if (started === null) validation('Invalid started_at');
    const startedAt = Math.floor(started.millis / 1000);
    const endedAt = (() => {
      if (session.ended_at == null) {
        host.log?.warn('[QuestionBankService] ended_at is None, using epoch fallback');
        return 0;
      }
      const ended = parseRfc3339(session.ended_at);
      if (ended === null) {
        host.log?.warn(`[QuestionBankService] Failed to parse ended_at '${session.ended_at}': invalid RFC3339, using epoch fallback`);
        return 0;
      }
      return Math.floor(ended.millis / 1000);
    })();
    const timeSpentSeconds = saturatingSub(endedAt, startedAt);
    const questionMap = new Map(host.questions.getQuestionsByIds(host.db, session.question_ids)
      .map(question => [question.id, question]));
    const typeStats: Record<string, TypeStatItem> = {};
    const difficultyStats: Record<string, DifficultyStatItem> = {};
    const wrongQuestionIds: string[] = [];
    for (const questionId of session.question_ids) {
      const question = questionMap.get(questionId);
      if (question === undefined) continue;
      const isCorrect = session.results[questionId] ?? false;
      const typeKey = debugQuestionType(question.question_type);
      const type = typeStats[typeKey] ?? { total: 0, correct: 0, rate: 0 };
      type.total += 1;
      if (isCorrect) type.correct += 1;
      else if (Object.prototype.hasOwnProperty.call(session.answers, questionId)) wrongQuestionIds.push(questionId);
      typeStats[typeKey] = type;
      if (question.difficulty !== null) {
        const difficultyKey = debugDifficulty(question.difficulty);
        const difficulty = difficultyStats[difficultyKey] ?? { total: 0, correct: 0, rate: 0 };
        difficulty.total += 1;
        if (isCorrect) difficulty.correct += 1;
        difficultyStats[difficultyKey] = difficulty;
      }
    }
    for (const item of Object.values(typeStats)) {
      item.rate = item.total > 0 ? round(item.correct / item.total * 100) : 0;
    }
    for (const item of Object.values(difficultyStats)) {
      item.rate = item.total > 0 ? round(item.correct / item.total * 100) : 0;
    }
    const comment = correctRate >= 90 ? '优秀！继续保持！' : correctRate >= 80 ? '良好，再接再厉！'
      : correctRate >= 60 ? '及格，仍需努力。' : '需要加强练习，建议复习错题。';
    return {
      session_id: session.id, exam_id: session.exam_id, total_count: totalCount,
      answered_count: answeredCount, correct_count: correctCount, wrong_count: wrongCount,
      unanswered_count: unansweredCount, correct_rate: correctRate, time_spent_seconds: timeSpentSeconds,
      type_stats: typeStats, difficulty_stats: difficultyStats, wrong_question_ids: wrongQuestionIds,
      comment, completed_at: utcNow(),
    };
  });
}
