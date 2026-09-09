/**
 * AI 出题草稿 → CreateQuestionParams 映射（2026-09-09 抽出）
 *
 * 面板（AiQuestionGenerationPanel）与对话块（qbankQuestionsBlock）共用。
 */

import type { QuestionOption } from '@/api/questionBankApi';
import type { GeneratedQuestionDraft } from '@/types/qbankGeneration';

/**
 * 把 AI 草稿映射为后端 CreateQuestionParams（snake_case 契约）。
 * 选择题 answer 归一为大写 key 串；判断题归一为小写 true/false。
 */
export function buildCreateParams(draft: GeneratedQuestionDraft, examId: string) {
  let answer = draft.answer?.trim() ?? null;
  if (
    answer &&
    (draft.question_type === 'single_choice' ||
      draft.question_type === 'multiple_choice' ||
      draft.question_type === 'indefinite_choice')
  ) {
    answer = answer.toUpperCase();
  }
  if (answer && draft.question_type === 'true_false') {
    answer = answer.toLowerCase();
  }

  const options: QuestionOption[] | null =
    draft.options && draft.options.length > 0
      ? draft.options.map((opt) => ({ key: opt.key.trim(), content: opt.content }))
      : null;

  return {
    exam_id: examId,
    content: draft.content,
    question_type: draft.question_type,
    options,
    answer,
    structured_data: null,
    explanation: draft.explanation?.trim() || null,
    difficulty: draft.difficulty ?? null,
    tags: draft.tags && draft.tags.length > 0 ? draft.tags : null,
    question_label: null,
    card_id: null,
    source_type: 'ai_generated',
    source_ref: null,
    images: null,
    parent_id: null,
  };
}
