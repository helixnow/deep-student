/**
 * 题目集演示的内存后端：题目、统计、判分、知识点、学习趋势。
 * 只 import type 与本包数据；判分用生产 gradeAnswerLocally（提交时动态加载）。
 */
import type { Question, QuestionBankStats, QuestionListResult, SubmitAnswerResult } from '@/stores/questionBankStore';
import type { DemoArgs } from '../../types';
import { emit } from '@tauri-apps/api/event';
import { tr } from '../../../lang';
import { DEMO_EXAM_SETS, buildSeedQuestions } from './data';

const questions = new Map<string, Question>(buildSeedQuestions().map((q) => [q.id, q]));
const submissions = new Map<string, { questionId: string; correct: boolean | null }>();
let seq = 0;

const desktopOnly = () => new Error(tr('这个功能请在桌面版中使用。', 'This feature is available in the desktop app.'));

function inExam(examId: string): Question[] {
  return [...questions.values()].filter((q) => q.exam_id === examId);
}

function stats(examId: string): QuestionBankStats {
  const all = inExam(examId);
  const attempts = all.reduce((s, q) => s + q.attempt_count, 0);
  const correct = all.reduce((s, q) => s + q.correct_count, 0);
  return {
    exam_id: examId,
    total_count: all.length,
    new_count: all.filter((q) => q.status === 'new').length,
    in_progress_count: all.filter((q) => q.status === 'in_progress').length,
    mastered_count: all.filter((q) => q.status === 'mastered').length,
    review_count: all.filter((q) => q.status === 'review').length,
    total_attempts: attempts,
    total_correct: correct,
    correct_rate: attempts ? correct / attempts : 0,
    updated_at: new Date().toISOString(),
  };
}

export function examNode(id: string) {
  const set = DEMO_EXAM_SETS.find((s) => s.id === id);
  if (!set) return null;
  return {
    id: set.id, path: `/${set.id}`, name: set.name, type: 'exam', sourceId: set.id, resourceId: `res_${set.id}`,
    createdAt: Date.parse(set.createdAt), updatedAt: Date.parse(set.updatedAt),
    metadata: { status: 'completed', isFavorite: false },
  };
}

interface Filters {
  status?: string[];
  difficulty?: string[];
  question_type?: string[];
  tags?: string[];
  search?: string;
  is_favorite?: boolean;
}

function matches(q: Question, f: Filters = {}): boolean {
  return (!f.status?.length || f.status.includes(q.status))
    && (!f.difficulty?.length || (q.difficulty != null && f.difficulty.includes(q.difficulty)))
    && (!f.question_type?.length || f.question_type.includes(q.question_type))
    && (!f.tags?.length || f.tags.some((t) => q.tags.includes(t)))
    && (f.is_favorite === undefined || f.is_favorite === null || q.is_favorite === f.is_favorite)
    && (!f.search || `${q.content}${q.answer ?? ''}${q.explanation ?? ''}`.toLowerCase().includes(f.search.toLowerCase()));
}

function knowledge(examId: string) {
  const byTag = new Map<string, Question[]>();
  for (const q of inExam(examId)) for (const tag of q.tags) byTag.set(tag, [...(byTag.get(tag) ?? []), q]);
  return [...byTag.entries()].map(([tag, list]) => {
    const attempts = list.reduce((s, q) => s + q.attempt_count, 0);
    const correct = list.reduce((s, q) => s + q.correct_count, 0);
    const mastered = list.filter((q) => q.status === 'mastered').length;
    return {
      tag, total: list.length, mastered,
      in_progress: list.filter((q) => q.status === 'in_progress').length,
      review: list.filter((q) => q.status === 'review').length,
      new_count: list.filter((q) => q.status === 'new').length,
      mastery_rate: Math.round((mastered / list.length) * 100),
      correct_rate: attempts ? Math.round((correct / attempts) * 100) : 0,
    };
  });
}

function dateKey(daysBack: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 近 N 天的做题量：固定伪随机形状，周末多一些 */
function activity(days: number) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const wave = (i * 7 + 3) % 11;
    const count = i % 9 === 4 ? 0 : 4 + wave + (i < 7 ? 3 : 0);
    const correct = Math.round(count * (0.58 + ((i * 13) % 7) / 30));
    out.push({ date: dateKey(i), count, correct_count: correct });
  }
  return out;
}

async function submit(req: any): Promise<SubmitAnswerResult> {
  const question = questions.get(req.question_id);
  if (!question) throw new Error(tr('题目不存在', 'Question not found'));
  const { gradeAnswerLocally } = await import('@/api/questionBankApi');
  const grade = gradeAnswerLocally(question, req.user_answer);
  const correct: boolean | null = req.is_correct_override ?? grade.isCorrect;
  const previous = req.regrade_submission_id ? submissions.get(req.regrade_submission_id) : undefined;
  const now = new Date().toISOString();
  const count = question.correct_count + Number(correct === true) - Number(previous?.correct === true);
  const updated: Question = {
    ...question, user_answer: req.user_answer, is_correct: correct ?? undefined,
    attempt_count: question.attempt_count + (previous ? 0 : 1), correct_count: count,
    status: correct === null ? question.status : correct === false ? 'review' : count >= 2 ? 'mastered' : 'in_progress',
    last_attempt_at: now, updated_at: now,
  };
  const submissionId = req.regrade_submission_id ?? `sub_demo_${++seq}`;
  submissions.set(submissionId, { questionId: question.id, correct });
  questions.set(question.id, updated);
  return { is_correct: correct, correct_answer: question.answer, needs_manual_grading: correct === null,
    message: '', updated_question: updated, updated_stats: stats(question.exam_id), submission_id: submissionId } satisfies SubmitAnswerResult;
}

// ---------------------------------------------------------------- 复习计划（SM-2）

interface Plan {
  id: string; question_id: string; exam_id: string; ease_factor: number; interval_days: number;
  repetitions: number; next_review_date: string; last_review_date: string | null;
  status: 'new' | 'learning' | 'reviewing' | 'graduated' | 'suspended';
  total_reviews: number; total_correct: number; consecutive_failures: number; is_difficult: boolean;
  created_at: string; updated_at: string;
}

const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => localDate(new Date());
function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localDate(d);
}

const plans = new Map<string, Plan>();
function makePlan(q: Question, dueInDays: number, extra: Partial<Plan> = {}): Plan {
  const plan: Plan = {
    id: `rp_${q.id}`, question_id: q.id, exam_id: q.exam_id, ease_factor: 2.5, interval_days: 1, repetitions: 0,
    next_review_date: addDays(dueInDays), last_review_date: dueInDays <= 0 ? addDays(dueInDays - 2) : null,
    status: 'learning', total_reviews: q.attempt_count, total_correct: q.correct_count,
    consecutive_failures: q.is_correct === false ? 1 : 0, is_difficult: q.attempt_count >= 2 && q.correct_count === 0,
    created_at: q.created_at, updated_at: q.updated_at, ...extra,
  };
  plans.set(plan.id, plan);
  return plan;
}
// 错题今天到期，学习中的题过几天，已掌握的毕业
for (const q of questions.values()) {
  if (q.status === 'review') makePlan(q, q.exam_id === 'exam_demo_calculus' && q.question_label === '7' ? -1 : 0);
  else if (q.status === 'in_progress') makePlan(q, 3, { status: 'reviewing', interval_days: 3, repetitions: 1 });
  else if (q.status === 'mastered') makePlan(q, 18, { status: 'graduated', interval_days: 18, repetitions: 3, ease_factor: 2.7 });
}

function planList(examId?: string | null, dueOnly = true): Plan[] {
  return [...plans.values()]
    .filter((p) => (!examId || p.exam_id === examId) && questions.has(p.question_id))
    .filter((p) => !dueOnly || (p.status !== 'suspended' && p.next_review_date <= today()))
    .sort((x, y) => x.next_review_date.localeCompare(y.next_review_date));
}

function planStats(examId?: string | null) {
  const all = planList(examId, false);
  const reviews = all.reduce((s, p) => s + p.total_reviews, 0);
  const correct = all.reduce((s, p) => s + p.total_correct, 0);
  const count = (st: Plan['status']) => all.filter((p) => p.status === st).length;
  return {
    exam_id: examId ?? null, total_plans: all.length, new_count: count('new'), learning_count: count('learning'),
    reviewing_count: count('reviewing'), graduated_count: count('graduated'), suspended_count: count('suspended'),
    due_today: planList(examId).length, overdue_count: all.filter((p) => p.next_review_date < today()).length,
    difficult_count: all.filter((p) => p.is_difficult).length, total_reviews: reviews, total_correct: correct,
    avg_correct_rate: reviews ? correct / reviews : 0,
    avg_ease_factor: all.length ? all.reduce((s, p) => s + p.ease_factor, 0) / all.length : 2.5,
    updated_at: new Date().toISOString(),
  };
}

function processReview(planId: string, quality: number, userAnswer: string | null, timeSpent: number | null) {
  const plan = plans.get(planId);
  if (!plan) throw new Error(tr('复习计划不存在', 'Review plan not found'));
  const passed = quality >= 3;
  const before = { ...plan };
  const reps = passed ? plan.repetitions + 1 : 0;
  const interval = !passed ? 1 : reps === 1 ? 1 : reps === 2 ? 6 : Math.round(plan.interval_days * plan.ease_factor);
  const ease = Math.max(1.3, plan.ease_factor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
  const next: Plan = {
    ...plan, repetitions: reps, interval_days: interval, ease_factor: ease, next_review_date: addDays(interval),
    last_review_date: today(), status: reps >= 3 && interval >= 21 ? 'graduated' : passed ? 'reviewing' : 'learning',
    total_reviews: plan.total_reviews + 1, total_correct: plan.total_correct + Number(passed),
    consecutive_failures: passed ? 0 : plan.consecutive_failures + 1, updated_at: new Date().toISOString(),
  };
  plans.set(planId, next);
  return {
    plan: next, passed, new_interval: interval, next_review_date: next.next_review_date,
    history: {
      id: `rh_${++seq}`, plan_id: planId, question_id: plan.question_id, quality, passed,
      ease_factor_before: before.ease_factor, ease_factor_after: ease, interval_before: before.interval_days,
      interval_after: interval, repetitions_before: before.repetitions, repetitions_after: reps,
      reviewed_at: new Date().toISOString(), user_answer: userAnswer, time_spent_seconds: timeSpent,
    },
  };
}

const dueResult = (list: Plan[], limit = 1000, offset = 0) =>
  ({ plans: list.slice(offset, offset + limit), total: list.length, has_more: offset + limit < list.length });

// ---------------------------------------------------------------- 练习模式

function pick(examId: string, count: number, prefer?: (q: Question) => number): Question[] {
  const list = inExam(examId);
  const sorted = prefer ? [...list].sort((x, y) => prefer(y) - prefer(x)) : list;
  return sorted.slice(0, Math.max(1, Math.min(count || list.length, list.length)));
}

function dailyPractice(examId: string, count: number) {
  const ids = pick(examId, count || 10, (q) => (q.status === 'review' ? 3 : q.status === 'new' ? 2 : 1)).map((q) => q.id);
  const chosen = ids.map((id) => questions.get(id)!);
  return {
    date: today(), exam_id: examId, question_ids: ids, daily_target: count || 10, completed_count: 0, correct_count: 0,
    source_distribution: {
      mistake_count: chosen.filter((q) => q.status === 'review').length,
      new_count: chosen.filter((q) => q.status === 'new').length,
      review_count: chosen.filter((q) => q.status !== 'review' && q.status !== 'new').length,
    },
    is_completed: false,
  };
}

function checkInCalendar(examId: string | null, year: number, month: number, target = 10) {
  const now = new Date();
  const days = [];
  const last = new Date(year, month, 0).getDate();
  for (let d = 1; d <= last; d++) {
    const date = new Date(year, month - 1, d);
    if (date > now) break;
    const back = Math.round((now.getTime() - date.getTime()) / 86_400_000);
    const n = back % 9 === 4 ? 0 : 4 + ((back * 7 + 3) % 11);
    if (!n) continue;
    days.push({ date: `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`, exam_id: examId ?? undefined,
      question_count: n, correct_count: Math.round(n * 0.7), study_duration_seconds: n * 95, target_achieved: n >= target });
  }
  let streak = 0;
  for (let back = 0; back < 60; back++) { if (back % 9 === 4) break; streak++; }
  return { exam_id: examId, year, month, days, streak_days: streak, month_check_in_days: days.length,
    month_total_questions: days.reduce((s, d) => s + d.question_count, 0), month_focus_seconds: 6 * 3600 + 1500 };
}

function mockScoreCard(session: any) {
  const ids: string[] = session.question_ids ?? [];
  const results: Record<string, boolean> = {};
  const typeStats: Record<string, { total: number; correct: number; rate: number }> = {};
  const diffStats: Record<string, { total: number; correct: number; rate: number }> = {};
  let correct = 0; let answered = 0;
  for (const id of ids) {
    const q = questions.get(id);
    if (!q) continue;
    const ans = session.answers?.[id];
    const ok = Boolean(ans) && q.answer != null
      && String(ans).replace(/\s|,/g, '').toUpperCase() === q.answer.replace(/\s|,/g, '').toUpperCase();
    if (ans) answered++;
    if (ok) correct++;
    results[id] = ok;
    for (const [bucket, key] of [[typeStats, q.question_type], [diffStats, q.difficulty ?? 'medium']] as const) {
      const item = bucket[key] ?? { total: 0, correct: 0, rate: 0 };
      item.total++; item.correct += Number(ok); item.rate = item.correct / item.total;
      bucket[key] = item;
    }
  }
  const started = Date.parse(session.started_at ?? new Date().toISOString());
  return {
    session_id: session.id, exam_id: session.exam_id, total_count: ids.length, answered_count: answered,
    correct_count: correct, wrong_count: answered - correct, unanswered_count: ids.length - answered,
    correct_rate: ids.length ? correct / ids.length : 0, time_spent_seconds: Math.max(1, Math.round((Date.now() - started) / 1000)),
    type_stats: typeStats, difficulty_stats: diffStats, wrong_question_ids: ids.filter((id) => !results[id]),
    comment: correct / Math.max(1, ids.length) >= 0.8 ? tr('掌握扎实，继续保持。', 'Solid work — keep it up.')
      : tr('极限计算还有薄弱点，建议回到错题再练一轮。', 'Some weak spots remain — review your mistakes once more.'),
    completed_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- 错题本（跨题目集）

function listMistakes(filters: any = {}, page = 1, pageSize = 50) {
  const all = [...questions.values()].filter((q) => q.status === 'review');
  const exams = DEMO_EXAM_SETS.map((s) => ({ exam_id: s.id, exam_name: s.name, count: all.filter((q) => q.exam_id === s.id).length }))
    .filter((e) => e.count > 0);
  let list = all.filter((q) => (!filters.exam_id || q.exam_id === filters.exam_id) && matches(q, { search: filters.search ?? undefined }));
  list = filters.sort === 'errors'
    ? list.sort((x, y) => (y.attempt_count - y.correct_count) - (x.attempt_count - x.correct_count))
    : list.sort((x, y) => (y.last_attempt_at ?? '').localeCompare(x.last_attempt_at ?? ''));
  const name = (id: string) => DEMO_EXAM_SETS.find((s) => s.id === id)?.name ?? null;
  return {
    items: list.slice((page - 1) * pageSize, page * pageSize).map((q) => ({ ...q, exam_name: name(q.exam_id) })),
    total: list.length, page, has_more: page * pageSize < list.length, exams,
  };
}

// ---------------------------------------------------------------- AI 评判 / 解析（剧本流式）

const TYPE_HINT: Record<string, string> = {
  single_choice: '先排除明显不成立的选项，再对剩下的做验证。',
  multiple_choice: '多选题逐项判断，每个选项都要找到依据，宁缺毋滥。',
  true_false: '判断题找反例最快：一个反例就能否定全称命题。',
  fill_blank: '填空题注意化简到最简形式。',
  numeric: '求最值要同时比较驻点和区间端点。',
  calculation: '隐函数求导时 $y$ 是 $x$ 的函数，对含 $y$ 的项别忘了乘 $y\'$。',
};

function stripMath(text: string): string {
  return text.replace(/[$\\{}\s]|dfrac|frac/g, '').replace(/[，。,.]/g, '').toLowerCase();
}

function scriptFor(q: Question, mode: string): { text: string; verdict?: string; score?: number } {
  const points = q.tags.length ? q.tags.join('、') : tr('本章基础', 'core concepts');
  if (mode === 'grade') {
    const user = stripMath(q.user_answer ?? '');
    const ref = stripMath(q.answer ?? '');
    const hit = ref.length > 0 && (user.includes(ref) || (ref.length > 8 && ref.slice(0, 8).split('').filter((c) => user.includes(c)).length >= 6));
    const verdict = hit ? 'correct' : user.length > 6 ? 'partial' : 'incorrect';
    const score = verdict === 'correct' ? 95 : verdict === 'partial' ? 62 : 15;
    const head = verdict === 'correct'
      ? tr('**结论正确。** 你的答案与参考答案一致，写法不同但意思相同。', '**Correct.** Your answer matches the reference.')
      : verdict === 'partial'
        ? tr('**部分正确。** 思路方向对，但关键结论没有写完整。', '**Partially correct.** The approach is right but the key conclusion is incomplete.')
        : tr('**答案不正确。** 和参考答案出入较大。', '**Incorrect.** The answer differs from the reference.');
    return {
      verdict, score,
      text: `${head}\n\n${tr('**参考答案**', '**Reference**')}：${q.answer ?? ''}\n\n${tr('**点评**', '**Comments**')}：${q.explanation ?? ''}\n\n<score value="${score}"/>`,
    };
  }
  return {
    text: [
      `**${tr('考点分析', 'What this tests')}**`,
      tr(`本题考查 **${points}**。`, `This question tests **${points}**.`),
      `**${tr('解题思路', 'Approach')}**`,
      q.explanation ?? '',
      `**${tr('易错提醒', 'Common pitfall')}**`,
      TYPE_HINT[q.question_type] ?? tr('先写出定义，再一步步推导。', 'Start from the definition and derive step by step.'),
      q.answer ? `\n${tr('**答案**', '**Answer**')}：${q.question_type === 'true_false' ? (q.answer === 'true' ? tr('正确', 'True') : tr('错误', 'False')) : q.answer}` : '',
    ].join('\n\n'),
  };
}

function streamGrading(req: any): null {
  const q = questions.get(req.question_id);
  const channel = `qbank_grading_stream_${req.stream_session_id}`;
  if (!q) {
    setTimeout(() => void emit(channel, { type: 'error', message: tr('题目不存在', 'Question not found') }), 50);
    return null;
  }
  const { text, verdict, score } = scriptFor(q, req.mode);
  let pos = 0;
  const tick = () => {
    pos = Math.min(text.length, pos + 3 + Math.floor(Math.random() * 5));
    const accumulated = text.slice(0, pos);
    void emit(channel, { type: 'data', chunk: accumulated.slice(-6), accumulated });
    if (pos < text.length) setTimeout(tick, 28);
    else {
      if (req.mode === 'grade') {
        questions.set(q.id, { ...q, ai_feedback: text, ai_score: score, ai_graded_at: new Date().toISOString() });
      }
      setTimeout(() => void emit(channel, { type: 'complete', submission_id: req.submission_id, verdict, score, feedback: text }), 60);
    }
  };
  setTimeout(tick, 350);
  return null;
}

export function handleQuestionBank(cmd: string, args: DemoArgs): unknown {
  const a = args as Record<string, any>;
  switch (cmd) {
    case 'dstu_list': {
      const typeFilter = a.options?.typeFilter;
      if (typeFilter && typeFilter !== 'exam') return [];
      return DEMO_EXAM_SETS.map((s) => examNode(s.id));
    }
    case 'dstu_get':
      return examNode(String(a.path ?? '').replace(/^\//, '').split('/').pop() ?? '');
    case 'get_exam_sheet_session_detail': {
      const id = a.request?.session_id;
      const set = DEMO_EXAM_SETS.find((s) => s.id === id);
      if (!set) return null;
      return {
        detail: {
          summary: { id, exam_name: set.name, mistake_id: id, status: 'completed', created_at: set.createdAt,
            updated_at: set.updatedAt, metadata: { page_count: 0, card_count: inExam(id).length } },
          preview: { session_id: id, exam_name: set.name, pages: [] },
        },
      };
    }
    case 'qbank_list_questions': {
      const { exam_id, page = 1, page_size = 100, filters = {} } = a.request ?? {};
      const all = inExam(exam_id).filter((q) => matches(q, filters));
      return { questions: all.slice((page - 1) * page_size, page * page_size), total: all.length,
        page, page_size, has_more: page * page_size < all.length } satisfies QuestionListResult;
    }
    case 'qbank_search_questions': {
      const { exam_id, keyword = '', page = 1, page_size = 50, filters } = a.request ?? {};
      const all = inExam(exam_id).filter((q) => matches(q, { ...(filters?.base ?? {}), search: keyword }));
      return { results: all.slice((page - 1) * page_size, page * page_size).map((question) => ({ question, relevance_score: -1 })),
        total: all.length, page, page_size, has_more: page * page_size < all.length, search_time_ms: 2 };
    }
    case 'qbank_rebuild_fts_index':
      return questions.size;
    case 'qbank_get_question':
      return questions.get(a.questionId) ?? null;
    case 'qbank_get_stats':
    case 'qbank_refresh_stats':
      return stats(a.examId ?? a.exam_id);
    case 'qbank_submit_answer':
      return submit(a.request);
    case 'qbank_toggle_favorite': {
      const q = questions.get(a.questionId);
      if (!q) return null;
      const updated = { ...q, is_favorite: !q.is_favorite, updated_at: new Date().toISOString() };
      questions.set(q.id, updated);
      return updated;
    }
    case 'qbank_update_question': {
      const q = questions.get(a.questionId ?? a.request?.question_id);
      if (!q) return null;
      const patch = a.params ?? a.request?.params ?? a.updates ?? {};
      const updated = { ...q, ...patch, updated_at: new Date().toISOString() };
      questions.set(q.id, updated);
      return updated;
    }
    case 'qbank_batch_update_questions': {
      const ids: string[] = a.questionIds ?? [];
      const patch = a.params ?? {};
      for (const id of ids) {
        const q = questions.get(id);
        if (q) questions.set(id, { ...q, ...patch, updated_at: new Date().toISOString() });
      }
      return { success_count: ids.length, failed_count: 0, errors: [] };
    }
    case 'qbank_delete_question':
      questions.delete(a.questionId);
      return null;
    case 'qbank_batch_delete_questions': {
      const ids: string[] = a.questionIds ?? [];
      ids.forEach((id) => questions.delete(id));
      return { success_count: ids.length, failed_count: 0, errors: [] };
    }
    case 'qbank_reset_questions_progress': {
      const ids: string[] = a.questionIds ?? [];
      for (const id of ids) {
        const q = questions.get(id);
        if (q) questions.set(id, { ...q, status: 'new', attempt_count: 0, correct_count: 0, user_answer: undefined, is_correct: undefined });
      }
      return { success_count: ids.length, failed_count: 0, errors: [] };
    }
    case 'qbank_get_learning_trend': {
      const days = 30;
      return activity(days).map((d) => ({ date: d.date, attempt_count: d.count, correct_count: d.correct_count,
        correct_rate: d.count ? Math.round((d.correct_count / d.count) * 100) : 0 }));
    }
    case 'qbank_get_activity_heatmap':
      return activity(120).map((d) => ({ ...d, level: d.count === 0 ? 0 : Math.min(4, Math.ceil(d.count / 4)) }));
    case 'qbank_get_knowledge_stats_with_comparison': {
      const current = knowledge(a.examId ?? a.exam_id);
      const previous = current.map((k) => ({ ...k, mastered: Math.max(0, k.mastered - 1),
        mastery_rate: Math.max(0, k.mastery_rate - 15), correct_rate: Math.max(0, k.correct_rate - 10) }));
      return { current, previous };
    }
    // 复习计划
    case 'review_plan_get_stats':
    case 'review_plan_refresh_stats':
      return planStats(a.examId);
    case 'review_plan_get_due':
      return dueResult(planList(a.examId));
    case 'review_plan_get_due_with_filter': {
      const f = a.filter ?? {};
      let list = planList(f.exam_id);
      if (f.difficult_only) list = list.filter((p) => p.is_difficult);
      if (f.status?.length) list = list.filter((p) => f.status.includes(p.status));
      return dueResult(list, f.limit ?? 1000, f.offset ?? 0);
    }
    case 'review_plan_list_by_exam':
      return dueResult(planList(a.examId, false), a.limit ?? 1000, a.offset ?? 0);
    case 'review_plan_create':
    case 'review_plan_get_or_create': {
      const existing = plans.get(`rp_${a.questionId}`);
      const q = questions.get(a.questionId);
      return existing ?? (q ? makePlan(q, 1, { status: 'new', last_review_date: null }) : null);
    }
    case 'review_plan_get_by_question':
      return plans.get(`rp_${a.questionId}`) ?? null;
    case 'review_plan_batch_create':
    case 'review_plan_create_for_exam': {
      const ids: string[] = a.questionIds ?? inExam(a.examId).map((q) => q.id);
      const created: Plan[] = [];
      let skipped = 0;
      for (const id of ids) {
        const q = questions.get(id);
        if (!q || plans.has(`rp_${id}`)) { skipped++; continue; }
        created.push(makePlan(q, 1, { status: 'new', last_review_date: null }));
      }
      return { created: created.length, skipped, failed: 0, plans: created };
    }
    case 'review_plan_delete':
      plans.delete(a.planId);
      return null;
    case 'review_plan_suspend':
    case 'review_plan_resume': {
      const plan = plans.get(a.planId);
      if (!plan) return null;
      const next = { ...plan, status: cmd === 'review_plan_suspend' ? 'suspended' as const : 'reviewing' as const };
      plans.set(plan.id, next);
      return next;
    }
    case 'review_plan_process':
      return processReview(a.planId, a.quality, a.userAnswer ?? null, a.timeSpentSeconds ?? null);
    case 'review_plan_get_history':
      return [];
    case 'review_plan_get_calendar_data':
      return activity(120).map((d) => ({ date: d.date, count: Math.round(d.count / 2), passed: Math.round(d.correct_count / 2),
        failed: Math.max(0, Math.round(d.count / 2) - Math.round(d.correct_count / 2)) }));
    // 练习模式
    case 'qbank_get_daily_practice':
      return dailyPractice(a.request.exam_id, a.request.count);
    case 'qbank_get_check_in_calendar':
      return checkInCalendar(a.request.exam_id ?? null, a.request.year, a.request.month, a.request.daily_target);
    case 'qbank_start_timed_practice': {
      const { exam_id, duration_minutes, question_count } = a.request;
      const ids = pick(exam_id, question_count).map((q) => q.id);
      return { id: `timed_${++seq}`, exam_id, duration_minutes, question_count: ids.length, question_ids: ids,
        started_at: new Date().toISOString(), answered_count: 0, correct_count: 0, is_timeout: false,
        is_submitted: false, paused_seconds: 0, is_paused: false };
    }
    case 'qbank_generate_mock_exam': {
      const { exam_id, config } = a.request;
      const total = config?.total_count || Object.values(config?.type_distribution ?? {}).reduce((s: number, n: any) => s + Number(n), 0) || 10;
      let list = pick(exam_id, total, config?.include_mistakes ? (q) => Number(q.status === 'review') : undefined);
      if (config?.shuffle) list = [...list].sort((x, y) => x.id.localeCompare(y.id) * (x.id.length % 2 ? 1 : -1));
      return { id: `mock_${++seq}`, exam_id, config, question_ids: list.map((q) => q.id), started_at: new Date().toISOString(),
        answers: {}, results: {}, is_submitted: false };
    }
    case 'qbank_submit_mock_exam':
      return mockScoreCard(a.request.session);
    case 'qbank_generate_paper': {
      const { exam_id, config } = a.request;
      const wanted = Object.entries(config?.type_selection ?? {}) as Array<[string, number]>;
      const list = wanted.length
        ? wanted.flatMap(([type, n]) => inExam(exam_id).filter((q) => q.question_type === type).slice(0, Number(n)))
        : inExam(exam_id);
      return { id: `paper_${++seq}`, title: config?.title || tr('高等数学 · 极限与导数 自测卷', 'Calculus self-test'),
        exam_id, questions: list, total_score: list.length * 5, config, created_at: new Date().toISOString() };
    }
    case 'qbank_ai_grade':
      return streamGrading(a.request);
    case 'qbank_cancel_grading':
      return null;
    case 'qbank_get_source_images':
      return [];
    case 'qbank_create_question': {
      const p = a.params ?? {};
      const now = new Date().toISOString();
      const examQs = inExam(p.exam_id);
      const q = {
        ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== null)),
        id: `q_new_${++seq}`, exam_id: p.exam_id, content: p.content ?? '', question_type: p.question_type ?? 'other',
        question_label: String(examQs.length + 1), tags: p.tags ?? [], images: p.images ?? [], source_type: 'manual',
        status: 'new', attempt_count: 0, correct_count: 0, is_favorite: false, created_at: now, updated_at: now,
      } as Question;
      questions.set(q.id, q);
      return q;
    }
    case 'qbank_reset_progress':
      for (const q of inExam(a.examId)) {
        questions.set(q.id, { ...q, status: 'new', attempt_count: 0, correct_count: 0, user_answer: undefined, is_correct: undefined });
      }
      return stats(a.examId);
    case 'qbank_get_history': {
      const q = questions.get(a.questionId);
      if (!q) return [];
      const out = [{ id: `h_${q.id}_0`, question_id: q.id, field_name: 'created', change_type: 'create', created_at: q.created_at }];
      if (q.last_attempt_at) {
        out.unshift({ id: `h_${q.id}_1`, question_id: q.id, field_name: 'user_answer', new_value: q.user_answer,
          change_type: 'answer', created_at: q.last_attempt_at } as typeof out[number]);
      }
      return out;
    }
    // AI 出题面板的模型下拉：留空即跟随设置
    case 'get_api_configurations':
      return [];
    case 'qbank_list_generation_tasks':
      return [];
    case 'qbank_get_generation_task':
    case 'qbank_cancel_generation_task':
      return null;
    case 'qbank_ai_generate_questions':
    case 'qbank_crop_source_image':
      throw desktopOnly();
    case 'qbank_list_mistakes':
      return listMistakes(a.request?.filters, a.request?.page, a.request?.page_size);
    case 'get_csv_preview':
    case 'import_questions_csv':
    case 'export_questions_csv':
    case 'save_text_to_file':
      throw desktopOnly();
    default:
      return undefined;
  }
}
