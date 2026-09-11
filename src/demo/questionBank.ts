import type { Question, QuestionBankStats, QuestionListResult, SubmitAnswerResult } from '@/stores/questionBankStore';
import type { ExamSheetSessionDetail } from '@/utils/types';
import { DEMO_QBANK_ID } from './fixtures';

const questions = new Map<string, Question>();
const submissions = new Map<string, { questionId: string; correct: boolean | null }>();
let questionSeq = 0;

export function getDemoQuestions(): Question[] {
  return [...questions.values()];
}

function stats(): QuestionBankStats {
  const all = getDemoQuestions();
  const attempts = all.reduce((sum, q) => sum + q.attempt_count, 0);
  const correct = all.reduce((sum, q) => sum + q.correct_count, 0);
  return {
    exam_id: DEMO_QBANK_ID, total_count: all.length,
    new_count: all.filter(q => q.status === 'new').length,
    in_progress_count: all.filter(q => q.status === 'in_progress').length,
    mastered_count: all.filter(q => q.status === 'mastered').length,
    review_count: all.filter(q => q.status === 'review').length,
    total_attempts: attempts, total_correct: correct,
    correct_rate: attempts ? correct / attempts : 0, updated_at: new Date().toISOString(),
  };
}

function requireQuestion(id: string): Question {
  const question = questions.get(id);
  if (!question) throw new Error('请先收录题目，再开始练习。');
  return question;
}

// This module is imported before IPC installation. Keep app dependencies type-only;
// the production grader is loaded only when a learner submits an answer.
export async function handleDemoQuestionBank(command: string, args: Record<string, any>): Promise<unknown> {
  switch (command) {
    case 'qbank_batch_create_questions': {
      const params = (args.paramsList ?? []) as Partial<Question>[];
      if (params.some(q => q.exam_id !== DEMO_QBANK_ID)) throw new Error('请选择当前示例题目集。');
      return params.map(p => {
        const now = new Date().toISOString();
        const question: Question = {
          ...p, id: `q_demo_${++questionSeq}`, exam_id: DEMO_QBANK_ID,
          content: p.content ?? '', question_type: p.question_type ?? 'single_choice',
          tags: p.tags ?? [], images: p.images ?? [], source_type: p.source_type ?? 'ai_generated',
          status: 'new', attempt_count: 0, correct_count: 0, is_favorite: false,
          created_at: now, updated_at: now,
        };
        questions.set(question.id, question);
        return question;
      });
    }
    case 'qbank_list_questions': {
      const { exam_id, page = 1, page_size = 100, filters = {} } = args.request;
      const all = getDemoQuestions().filter(q => q.exam_id === exam_id
        && (!filters.status?.length || filters.status.includes(q.status))
        && (!filters.difficulty?.length || filters.difficulty.includes(q.difficulty))
        && (!filters.question_type?.length || filters.question_type.includes(q.question_type))
        && (!filters.tags?.length || filters.tags.some((tag: string) => q.tags.includes(tag)))
        && (filters.is_favorite === undefined || q.is_favorite === filters.is_favorite)
        && (!filters.search || q.content.toLocaleLowerCase().includes(filters.search.toLocaleLowerCase())));
      return { questions: all.slice((page - 1) * page_size, page * page_size), total: all.length,
        page, page_size, has_more: page * page_size < all.length } satisfies QuestionListResult;
    }
    case 'qbank_get_question':
      return questions.get(args.questionId) ?? null;
    case 'qbank_get_stats':
    case 'qbank_refresh_stats':
      return stats();
    case 'get_exam_sheet_session_detail': {
      if (args.request.session_id !== DEMO_QBANK_ID) throw new Error('请选择当前示例题目集。');
      const detail: ExamSheetSessionDetail = {
        summary: { id: DEMO_QBANK_ID, exam_name: '数据并行训练', mistake_id: DEMO_QBANK_ID,
          status: 'completed', created_at: '2026-09-01T09:00:00Z', updated_at: stats().updated_at,
          metadata: { page_count: 0, card_count: questions.size } },
        preview: { session_id: DEMO_QBANK_ID, exam_name: '数据并行训练', pages: [] },
      };
      return { detail };
    }
    case 'qbank_submit_answer': {
      const request = args.request;
      const question = requireQuestion(request.question_id);
      const { gradeAnswerLocally } = await import('@/api/questionBankApi');
      const grade = gradeAnswerLocally(question, request.user_answer);
      const correct: boolean | null = request.is_correct_override ?? grade.isCorrect;
      const previous = request.regrade_submission_id ? submissions.get(request.regrade_submission_id) : undefined;
      if (request.regrade_submission_id && previous?.questionId !== question.id) {
        throw new Error('请在当前题目的作答记录中调整结果。');
      }
      const now = new Date().toISOString();
      const count = question.correct_count + Number(correct === true) - Number(previous?.correct === true);
      const updated: Question = {
        ...question, user_answer: request.user_answer, is_correct: correct ?? undefined,
        attempt_count: question.attempt_count + (previous ? 0 : 1), correct_count: count,
        status: correct === false ? 'review' : count >= 2 ? 'mastered' : 'in_progress',
        last_attempt_at: now, updated_at: now,
      };
      const submissionId = request.regrade_submission_id ?? `submission_demo_${submissions.size + 1}`;
      submissions.set(submissionId, { questionId: question.id, correct });
      questions.set(question.id, updated);
      return { is_correct: correct, correct_answer: question.answer, needs_manual_grading: correct === null,
        message: '', updated_question: updated, updated_stats: stats(), submission_id: submissionId } satisfies SubmitAnswerResult;
    }
    case 'qbank_toggle_favorite': {
      const question = requireQuestion(args.questionId);
      const updated = { ...question, is_favorite: !question.is_favorite, updated_at: new Date().toISOString() };
      questions.set(question.id, updated);
      return updated;
    }
    default:
      throw new Error('请使用示例题目的收录、作答与解析功能。');
  }
}
