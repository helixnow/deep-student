/**
 * Practice handoff and learning statistics tools of qbank_executor.rs (lines 3619–4067).
 * Sessions are produced by `statistics-service.ts`; the agent only receives a replayable
 * handoff and never answers on the user's behalf.
 */
import { with_localized_message, type JsonValue } from '../../../../platform/errors/api.ts';
import { f64Atom } from '../../../../platform/serde-compat/index.ts';
import type { MockExamConfig__De, MockExamSession__De } from '../../api.ts'; // boundary-allow test-double: Rust 领域词 MockExam（模拟考试），非测试替身
import { listAttemptDocumentJson, listPaperDocumentJson, loadPaper } from '../../repository/practice.ts';
import { practiceAttempt } from '../../repository/practice-decode.ts';
import {
  boolean, f64, map, opt, req, string, struct, u32, vec,
} from '../../repository/serde-decode.ts';
import * as questions from '../question-service.ts';
import * as statistics from '../statistics-service.ts';
import * as practice from '../practice-service.ts';
import { loadAttempt, loadDraft } from '../../repository/practice.ts';
import {
  asI64, asStr, asU64, errorText, pageBounds, parseCountMap, parseIsoDate, parseStringArray, practiceHandoff,
  practiceWorkbenchAction, qbankFailure, readBool, readStrictU32, requiredNonEmptyString, type Args,
} from './qbank-tool-args.ts';
import type { QbankToolEnv } from './qbank-tool-env.ts';

const HANDOFF_STATE = {
  session_state: 'handoff_ready',
  handoff_persisted: true,
  handoff_durability: 'chat_tool_result',
  session_persisted: false,
  session_hydrated: false,
  requires_user_interaction: true,
  agentCanAnswer: false,
} as const;

function run<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) { throw new Error(errorText(error)); }
}

/** qbank_executor.rs:3619 `execute_start_timed_practice`. */
export function executeStartTimedPractice(env: QbankToolEnv): unknown {
  env.requireService();
  const examId = requiredNonEmptyString(env.args, 'session_id');
  const durationMinutes = readStrictU32(env.args, 'duration_minutes', 30, 1, 480);
  const questionCount = readStrictU32(env.args, 'question_count', 20, 1, 100);
  const session = run(() => statistics.startTimedPractice(env.deps.statisticsHost(), examId, durationMinutes, questionCount));
  const handoff = practiceHandoff(examId, 'timed', session);
  return with_localized_message({
    success: true, session: session as unknown as JsonValue, handoff: handoff as JsonValue, ...HANDOFF_STATE,
    workbenchAction: practiceWorkbenchAction(examId, handoff) as JsonValue,
  }, 'chat.tools.qbank.timed_practice_ready', { durationMinutes, questionCount },
  '已创建可重放的限时练习交接；执行 workbenchAction 后可在题库 UI 继续作答',
  'A replayable timed-practice handoff is ready. Execute workbenchAction to continue answering in the question bank UI.');
}

const EXAM_TYPE_KEYS = ['single_choice', 'multiple_choice', 'indefinite_choice', 'fill_blank', 'true_false',
  'matching', 'ordering', 'numeric', 'short_answer', 'essay', 'calculation', 'proof', 'other'];

/** qbank_executor.rs:3662 `execute_generate_mock_exam`. */
export function executeGenerateMockExam(env: QbankToolEnv): unknown { // boundary-allow test-double: Rust 领域词 MockExam（模拟考试），非测试替身
  env.requireService();
  const examId = requiredNonEmptyString(env.args, 'session_id');
  const config = env.args.config;
  const source: Args = Object.hasOwn(env.args, 'config')
    ? (config !== null && typeof config === 'object' && !Array.isArray(config) ? config as Args : {})
    : env.args;
  const durationMinutes = readStrictU32(source, 'duration_minutes', 60, 1, 480);
  const totalCount = readStrictU32(source, 'total_count', 20, 1, 100);
  const typeDistribution = parseCountMap(source.type_distribution, 'type_distribution', EXAM_TYPE_KEYS, 100);
  const difficultyDistribution = parseCountMap(source.difficulty_distribution, 'difficulty_distribution',
    ['easy', 'medium', 'hard', 'very_hard'], 100);
  const tags = Object.hasOwn(source, 'tags') ? parseStringArray(source.tags, 'tags', 20, 100) : null;
  const mockConfig: MockExamConfig__De = { // boundary-allow test-double: Rust 领域词 MockExam（模拟考试），非测试替身
    duration_minutes: durationMinutes, type_distribution: typeDistribution,
    difficulty_distribution: difficultyDistribution, total_count: totalCount,
    shuffle: readBool(source, 'shuffle', true), include_mistakes: readBool(source, 'include_mistakes', true), tags,
  };
  const session = run(() => statistics.generateMockExam(env.deps.statisticsHost(), examId, mockConfig)); // boundary-allow test-double: Rust 领域词 MockExam（模拟考试），非测试替身
  const handoff = practiceHandoff(examId, 'mock_exam', session);
  return with_localized_message({
    success: true, session: session as unknown as JsonValue, handoff: handoff as JsonValue, ...HANDOFF_STATE,
    workbenchAction: practiceWorkbenchAction(examId, handoff) as JsonValue,
  }, 'chat.tools.qbank.mock_exam_ready', { durationMinutes, questionCount: totalCount },
  '已创建可重放的模拟考交接；执行 workbenchAction 后必须由用户在题库 UI 作答',
  'A replayable mock-exam handoff is ready. Execute workbenchAction, then the user must answer in the question bank UI.');
}

/** question_bank_service.rs:3323 / 3356 (`MockExamConfig`, `MockExamSession`). */
const mockConfigDecoder = struct<MockExamConfig__De>('MockExamConfig', { // boundary-allow test-double: Rust 领域词 MockExam（模拟考试），非测试替身
  duration_minutes: req(u32), type_distribution: req(map(u32)), difficulty_distribution: req(map(u32)),
  total_count: opt(u32), shuffle: req(boolean), include_mistakes: req(boolean), tags: opt(vec(string)),
});
const mockSessionDecoder = struct<MockExamSession__De>('MockExamSession', { // boundary-allow test-double: Rust 领域词 MockExam（模拟考试），非测试替身
  id: req(string), exam_id: req(string), config: req(mockConfigDecoder), question_ids: req(vec(string)),
  started_at: req(string), ended_at: opt(string), answers: req(map(string)), results: req(map(boolean)),
  is_submitted: req(boolean), score: opt(f64), correct_rate: opt(f64),
});

function sameKeys(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const a = Object.keys(left), b = new Set(Object.keys(right));
  return a.length === b.size && a.every(key => b.has(key));
}

/** qbank_executor.rs:3745 `execute_submit_mock_exam`. */
export function executeSubmitMockExam(env: QbankToolEnv): unknown { // boundary-allow test-double: Rust 领域词 MockExam（模拟考试），非测试替身
  if (asStr(env.args.submission_source) !== 'qbank_ui') {
    throw qbankFailure('QBANK_UI_RESULTS_REQUIRED', '模拟考交卷只接受 qbank_ui 产生的作答结果',
      '让用户先在题库 UI 完成作答；Agent 不得代填 answers/results');
  }
  if (!Object.hasOwn(env.args, 'session')) {
    throw qbankFailure('INVALID_ARGS', '缺少 UI 返回的 session', '从题库 UI 取得完整模拟考会话后重试');
  }
  let session: MockExamSession__De; // boundary-allow test-double: Rust 领域词 MockExam（模拟考试），非测试替身
  try { session = mockSessionDecoder(env.args.session, ''); }
  catch (error) {
    throw qbankFailure('INVALID_ARGS', `session 格式无效: ${errorText(error)}`, '必须原样传入题库 UI 产生的完整模拟考会话');
  }
  if (!session.is_submitted || session.ended_at == null || Object.keys(session.answers).length === 0) {
    throw qbankFailure('QBANK_UI_RESULTS_REQUIRED', '模拟考尚无已提交且已结束的用户作答', '让用户在题库 UI 作答并交卷后重试');
  }
  if (!sameKeys(session.answers, session.results)) {
    throw qbankFailure('QBANK_INVALID_UI_RESULTS', 'session.answers 与 session.results 的题目集合不一致', '重新从题库 UI 读取完整交卷结果');
  }
  const questionIds = new Set(session.question_ids);
  if (Object.keys(session.answers).some(id => !questionIds.has(id))) {
    throw qbankFailure('QBANK_INVALID_UI_RESULTS', '作答结果包含不属于本次模拟考的题目', '重新从题库 UI 读取完整交卷结果');
  }
  const service = env.requireService();
  for (const questionId of session.question_ids) {
    const question = run(() => questions.getQuestion(service, questionId));
    if (question === null) {
      throw qbankFailure('QBANK_QUESTION_NOT_FOUND', `模拟考题目不存在: ${questionId}`, '重新生成模拟考后再作答');
    }
    if (question.exam_id !== session.exam_id) {
      throw qbankFailure('QBANK_INVALID_UI_RESULTS', `题目 ${questionId} 不属于会话题目集`, '重新从题库 UI 读取完整交卷结果');
    }
  }
  const scoreCard = run(() => statistics.submitMockExam(env.deps.statisticsHost(), session)); // boundary-allow test-double: Rust 领域词 MockExam（模拟考试），非测试替身
  const rates = (items: Record<string, { rate: number }>) => Object.fromEntries(
    Object.entries(items).map(([key, item]) => [key, { ...item, rate: f64Atom(item.rate) }]));
  const scoreCardWire = { ...scoreCard, correct_rate: f64Atom(scoreCard.correct_rate),
    type_stats: rates(scoreCard.type_stats), difficulty_stats: rates(scoreCard.difficulty_stats) };
  return with_localized_message({
    success: true, score_card: scoreCardWire as unknown as JsonValue, submission_source: 'qbank_ui', persisted: false,
    requires_user_interaction: false, agentCanAnswer: false,
  }, 'chat.tools.qbank.mock_exam_scored', { persisted: false },
  '已汇总用户在题库 UI 中产生的交卷结果；本服务当前不持久化模拟考会话',
  "The score card was calculated from the user's question bank UI submission. This service does not currently persist mock-exam sessions.");
}

/** qbank_executor.rs:3841 `execute_get_daily_practice`. */
export function executeGetDailyPractice(env: QbankToolEnv): unknown {
  env.requireService();
  const examId = requiredNonEmptyString(env.args, 'session_id');
  const count = readStrictU32(env.args, 'count', 10, 1, 50);
  const result = run(() => statistics.getDailyPractice(env.deps.statisticsHost(), examId, count));
  const handoff = practiceHandoff(examId, 'daily', result);
  return { success: true, practice: result, handoff, ...HANDOFF_STATE,
    workbenchAction: practiceWorkbenchAction(examId, handoff) };
}

function requiredYear(args: Args): number {
  const year = asI64(args.year);
  if (year === null || year < 1970 || year > 9999) {
    throw qbankFailure('INVALID_ARGS', 'year 必须是 1970..=9999 的整数', '修正年份后重试');
  }
  return year;
}

/** qbank_executor.rs:3878 `execute_get_check_in_calendar`. */
export function executeGetCheckInCalendar(env: QbankToolEnv): unknown {
  env.requireService();
  const year = requiredYear(env.args);
  const month = readStrictU32(env.args, 'month', 1, 1, 12);
  let dailyTarget: number | null = null;
  const rawTarget = env.args.daily_target;
  if (rawTarget !== undefined && rawTarget !== null) {
    const target = asU64(rawTarget);
    if (target === null || target < 1 || target > 50) {
      throw qbankFailure('INVALID_ARGS', 'daily_target 必须是 1..=50 的整数', '修正每日目标后重试');
    }
    dailyTarget = target;
  }
  const calendar = run(() => statistics.getCheckInCalendar(env.deps.statisticsHost(), asStr(env.args.session_id),
    year, month, dailyTarget));
  const { page, pageSize, start, end } = pageBounds(env.args, calendar.days.length);
  return {
    session_id: calendar.exam_id, year: calendar.year, month: calendar.month, days: calendar.days.slice(start, end),
    streak_days: calendar.streak_days, month_check_in_days: calendar.month_check_in_days,
    month_total_questions: calendar.month_total_questions, total: calendar.days.length, page, page_size: pageSize,
    has_more: end < calendar.days.length, truncated: end < calendar.days.length,
  };
}

/** qbank_executor.rs:3936 `execute_get_learning_trend`. */
export function executeGetLearningTrend(env: QbankToolEnv): unknown {
  env.requireService();
  const startDate = parseIsoDate(env.args, 'start_date');
  const endDate = parseIsoDate(env.args, 'end_date');
  if (endDate.epochDay < startDate.epochDay || endDate.epochDay - startDate.epochDay > 366) {
    throw qbankFailure('INVALID_ARGS', '日期范围必须正序且不超过 367 天', '缩短日期范围后重试');
  }
  const points = run(() => statistics.getLearningTrend(env.deps.statisticsHost(), asStr(env.args.session_id),
    startDate.text, endDate.text));
  const { page, pageSize, start, end } = pageBounds(env.args, points.length);
  return { points: points.slice(start, end).map(point => ({ ...point, correct_rate: f64Atom(point.correct_rate) })),
    total: points.length, page, page_size: pageSize, has_more: end < points.length, truncated: end < points.length };
}

/** qbank_executor.rs:3969 `execute_get_activity_heatmap`. */
export function executeGetActivityHeatmap(env: QbankToolEnv): unknown {
  env.requireService();
  const year = requiredYear(env.args);
  const points = run(() => statistics.getActivityHeatmap(env.deps.statisticsHost(), asStr(env.args.session_id), year));
  const { page, pageSize, start, end } = pageBounds(env.args, points.length);
  return { year, points: points.slice(start, end), total: points.length, page, page_size: pageSize,
    has_more: end < points.length, truncated: end < points.length };
}

/** qbank_executor.rs:4005 `execute_get_knowledge_stats`. */
export function executeGetKnowledgeStats(env: QbankToolEnv): unknown {
  env.requireService();
  const points = run(() => statistics.getKnowledgeStats(env.deps.statisticsHost(), asStr(env.args.session_id)));
  const { page, pageSize, start, end } = pageBounds(env.args, points.length);
  return {
    knowledge_points: points.slice(start, end).map(point => ({
      ...point, mastery_rate: f64Atom(point.mastery_rate), correct_rate: f64Atom(point.correct_rate) })),
    total: points.length, page, page_size: pageSize, has_more: end < points.length, truncated: end < points.length,
  };
}

/** qbank_executor.rs:4025 `execute_practice_records` (`qbank_list_papers` / `qbank_get_paper` / `qbank_list_practices`). */
export function executePracticeRecords(env: QbankToolEnv): unknown {
  const { db } = env.vfs();
  if (env.toolName === 'qbank_get_paper') {
    const id = requiredNonEmptyString(env.args, 'paper_id');
    const paper = run(() => loadPaper(db, id));
    if (paper === null) throw new Error('Paper not found');
    return {
      paper_id: paper.id, session_id: paper.exam_id, title: paper.title, question_count: paper.questions.length,
      question_ids: paper.questions.map(question => question.id), created_at: paper.created_at, persisted: true,
      view: 'papers', grading_mode: 'on_submit',
    };
  }
  const scope = requiredNonEmptyString(env.args, 'session_id');
  const papers = env.toolName === 'qbank_list_papers';
  const rows = run(() => (papers ? listPaperDocumentJson(db, scope) : listAttemptDocumentJson(db, scope)));
  const records = rows.map(raw => {
    const value = run(() => JSON.parse(raw) as Record<string, unknown>);
    const record: Record<string, unknown> = {
      id: value.id ?? null, title: value.title ?? null, created_at: value.created_at ?? null,
      question_count: Array.isArray(value.questions) ? value.questions.length : 0,
    };
    if (!papers) {
      const attempt = run(() => practiceAttempt(value, ''));
      record.status = attempt.status;
      record.score_summary = {
        answered_count: Object.keys(attempt.answers).length,
        correct_count: attempt.results.filter(result => result.is_correct === true).length,
        wrong_count: attempt.results.filter(result => result.is_correct === false).length,
        pending_count: attempt.results.filter(result => result.status === 'pending' || result.status === 'failed').length,
      };
    }
    return record;
  });
  const { page, pageSize, start, end } = pageBounds(env.args, records.length);
  return { items: records.slice(start, end), total: records.length, page, page_size: pageSize, has_more: end < records.length };
}

/**
 * BG-4 `qbank_update_paper`: renames a saved paper or moves it in/out of the
 * paper list. The persisted `GeneratedPaper` document has no description or
 * time-limit fields, so only `title` (and the soft-delete flag) are accepted.
 */
export async function executeUpdatePaper(env: QbankToolEnv): Promise<unknown> {
  const paperId = requiredNonEmptyString(env.args, 'paper_id');
  const title = requiredNonEmptyString(env.args, 'title');
  const deleted = readBool(env.args, 'deleted', false);
  const host = await env.deps.practiceHost();
  try {
    practice.updatePaper(host, paperId, title, deleted);
  } catch (error) {
    throw qbankFailure('QBANK_PAPER_UPDATE_FAILED', `更新试卷失败: ${errorText(error)}`,
      '先用 qbank_list_papers 确认试卷 ID 后重试');
  }
  env.emitChanged(deleted ? 'delete_paper' : 'update_paper', [paperId]);
  return {
    success: true,
    paper_id: paperId,
    title,
    deleted,
    message: deleted ? `已将试卷「${title}」移入删除状态` : `已将试卷重命名为「${title}」`,
  };
}

/**
 * BG-4 `qbank_delete_practice`: deletes a practice draft or submitted attempt.
 * When `submitted` is omitted the record kind is detected from the VFS tables.
 */
export async function executeDeletePractice(env: QbankToolEnv): Promise<unknown> {
  const practiceId = requiredNonEmptyString(env.args, 'practice_id');
  const { db } = env.vfs();
  const host = await env.deps.practiceHost();
  let submitted: boolean;
  const explicitSubmitted = env.args.submitted;
  if (typeof explicitSubmitted === 'boolean') {
    submitted = explicitSubmitted;
  } else {
    const draft = run(() => loadDraft(db, practiceId));
    if (draft !== null) {
      submitted = false;
    } else if (run(() => loadAttempt(db, practiceId)) !== null) {
      submitted = true;
    } else {
      throw qbankFailure('QBANK_PRACTICE_NOT_FOUND', `练习记录不存在: ${practiceId}`,
        '先用 qbank_list_practices 确认练习 ID 后重试');
    }
  }
  try {
    practice.deletePractice(host, practiceId, submitted);
  } catch (error) {
    throw qbankFailure('QBANK_PRACTICE_DELETE_FAILED', `删除练习记录失败: ${errorText(error)}`,
      '确认练习记录 ID 与状态后重试');
  }
  env.emitChanged('delete_practice', [practiceId]);
  return {
    success: true,
    practice_id: practiceId,
    submitted,
    message: submitted ? '已删除已交卷练习记录' : '已删除练习草稿',
  };
}
