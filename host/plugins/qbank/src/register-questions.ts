import type {
  CreateQuestionParams, QuestionFilters, QuestionSearchFilters, UpdateQuestionParams,
} from '../api.ts';
import type { MistakeListFilters } from '../repository/questions.ts';
import * as questions from './question-service.ts';
import { serviceCall, type QbankPluginDeps } from './plugin-deps.ts';

interface ListQuestionsRequest { exam_id: string; filters?: QuestionFilters | null; page?: number; page_size?: number }
interface ListMistakesRequest { filters?: MistakeListFilters; page?: number; page_size?: number }
interface SearchQuestionsRequest {
  keyword: string; exam_id?: string | null; filters?: QuestionSearchFilters | null; page?: number; page_size?: number;
}
interface UpdateQuestionRequest { question_id: string; params: UpdateQuestionParams; record_history?: boolean }
interface BatchUpdateQuestionsRequest { question_ids: string[]; params: UpdateQuestionParams }
interface SubmitAnswerRequest {
  question_id: string; user_answer: string; is_correct_override?: boolean | null;
  client_request_id?: string | null; regrade_submission_id?: string | null;
}

/** Question CRUD, answer submission, stats and progress commands. */
export function registerQuestions(deps: QbankPluginDeps): void {
  const { ctx, qbank, log } = deps;
  ctx.commands.register<{ request: ListQuestionsRequest }>('qbank_list_questions', ({ request }) => serviceCall(() =>
    qbank.listQuestions(request.exam_id, request.filters ?? {}, request.page ?? 1, request.page_size ?? 50)));
  ctx.commands.register<{ request: ListMistakesRequest }>('qbank_list_mistakes', ({ request }) => serviceCall(() =>
    qbank.listMistakes(request.filters ?? {}, request.page ?? 1, request.page_size ?? 50)));
  ctx.commands.register<{ request: SearchQuestionsRequest }>('qbank_search_questions', ({ request }) => serviceCall(() =>
    qbank.searchQuestions(request.keyword, request.exam_id ?? null, request.filters ?? {},
      request.page ?? 1, request.page_size ?? 50)));
  ctx.commands.register('qbank_rebuild_fts_index', () => serviceCall(() => qbank.rebuildFtsIndex()));
  ctx.commands.register<{ questionId: string }>('qbank_get_question', ({ questionId }) =>
    serviceCall(() => qbank.getQuestion(questionId)));
  ctx.commands.register<{ examId: string; cardId: string }>('qbank_get_question_by_card_id', ({ examId, cardId }) =>
    serviceCall(() => qbank.getQuestionByCardId(examId, cardId)));
  ctx.commands.register<{ params: CreateQuestionParams }>('qbank_create_question', ({ params }) =>
    serviceCall(() => qbank.createQuestion(params)));
  ctx.commands.register<{ paramsList: CreateQuestionParams[] }>('qbank_batch_create_questions', ({ paramsList }) =>
    serviceCall(() => qbank.batchCreateQuestions(paramsList)));
  ctx.commands.register<{ request: UpdateQuestionRequest }>('qbank_update_question', ({ request }) =>
    serviceCall(() => qbank.updateQuestion(request.question_id, request.params, request.record_history ?? false)));
  ctx.commands.register<{ request: BatchUpdateQuestionsRequest }>('qbank_batch_update_questions', ({ request }) =>
    serviceCall(() => qbank.batchUpdateQuestions(request.question_ids, request.params)));
  ctx.commands.register<{ questionId: string }>('qbank_delete_question', ({ questionId }) =>
    serviceCall(() => { qbank.deleteQuestion(questionId); return null; }));
  ctx.commands.register<{ questionIds: string[] }>('qbank_batch_delete_questions', ({ questionIds }) =>
    serviceCall(() => qbank.batchDeleteQuestions(questionIds)));
  ctx.commands.register<{ request: SubmitAnswerRequest }>('qbank_submit_answer', ({ request }) => serviceCall(() => {
    const submissionId = request.regrade_submission_id?.trim();
    if (submissionId && request.is_correct_override != null) {
      return qbank.regradeSubmission(request.question_id, submissionId, request.is_correct_override);
    }
    if (request.is_correct_override != null) {
      log.warn(`[qbank_submit_answer] Received is_correct_override for question_id=${request.question_id}`);
    }
    return qbank.submitAnswer(request.question_id, request.user_answer,
      request.is_correct_override ?? null, request.client_request_id ?? null);
  }));
  ctx.commands.register<{ questionId: string }>('qbank_toggle_favorite', ({ questionId }) =>
    serviceCall(() => qbank.toggleFavorite(questionId)));
  ctx.commands.register<{ examId: string }>('qbank_get_stats', ({ examId }) =>
    serviceCall(() => qbank.getStats(examId)));
  ctx.commands.register<{ examId: string }>('qbank_count_by_type', ({ examId }) =>
    serviceCall(() => qbank.countByType(examId)));
  ctx.commands.register<{ examId: string }>('qbank_refresh_stats', ({ examId }) =>
    serviceCall(() => qbank.refreshStats(examId)));
  ctx.commands.register<{ questionId: string; limit: number | null }>('qbank_get_history', ({ questionId, limit }) =>
    serviceCall(() => qbank.getHistory(questionId, limit)));
  ctx.commands.register<{ questionId: string; limit: number | null }>('qbank_get_submissions', ({ questionId, limit }) =>
    serviceCall(() => qbank.getSubmissions(questionId, limit ?? 20)));
  ctx.commands.register<{ examId: string }>('qbank_reset_progress', ({ examId }) =>
    serviceCall(() => qbank.resetProgress(examId)));
  ctx.commands.register<{ questionIds: string[] }>('qbank_reset_questions_progress', ({ questionIds }) =>
    serviceCall(() => qbank.resetQuestionsProgress(questionIds)));
  ctx.commands.register<{ questionId: string; imageId: string }>('qbank_remove_question_image',
    ({ questionId, imageId }) => serviceCall(() => {
      questions.removeQuestionImage(deps.questionHost(), questionId, imageId);
      return null;
    }));
}
