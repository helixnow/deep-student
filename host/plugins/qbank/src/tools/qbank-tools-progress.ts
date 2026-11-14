/**
 * Answering and learning-progress tools of qbank_executor.rs (lines 2807–3038, 3421–3617, 4231–4382).
 * Business logic stays in `question-service.ts`; the legacy `preview_json` fallback mirrors Rust.
 */
import { with_localized_message, type JsonValue } from '../../../../platform/errors/api.ts';
import { utf8ByteLength } from '../../../../platform/util/portable.ts';
import type { Question } from '../../api.ts';
import { utcNow } from '../../repository/questions.ts';
import * as questions from '../question-service.ts';
import {
  asBool, asStr, cardIdOf, errorText, qbankFailure, readBool, requiredStr,
} from './qbank-tool-args.ts';
import type { QbankToolEnv } from './qbank-tool-env.ts';
import {
  checkPreviewAnswerCorrectness, loadPreview, previewCards, writePreviewIfUnchanged,
} from './qbank-tool-preview.ts';
import { listAllQuestions } from './qbank-tools-questions.ts';

function answerMessage(needsManual: boolean, isCorrect: boolean | null, fallback: boolean): [string, string, string] {
  if (needsManual) {
    return fallback
      ? ['chat.tools.qbank.answer_needs_manual_grading', '主观题已提交，请参考答案自行判断。',
        'The subjective answer was submitted; compare it with the reference answer manually.']
      : ['chat.tools.qbank.answer_needs_manual_grading', '需要手动批改', 'This answer requires manual grading.'];
  }
  if (isCorrect === true) return ['chat.tools.qbank.answer_correct', '回答正确！', 'The answer is correct.'];
  return fallback
    ? ['chat.tools.qbank.answer_incorrect', '回答错误，请查看正确答案。', 'The answer is incorrect; review the correct answer.']
    : ['chat.tools.qbank.answer_incorrect', '回答错误', 'The answer is incorrect.'];
}

/** qbank_executor.rs:2807 `execute_submit_answer`. */
export function executeSubmitAnswer(env: QbankToolEnv): Promise<unknown> {
  return env.lock.run(() => {
    const { args } = env;
    const sessionId = requiredStr(args, 'session_id');
    const cardId = requiredStr(args, 'card_id');
    const raw = args.user_answer;
    let userAnswer: string;
    if (typeof raw === 'string') userAnswer = raw;
    else if (raw !== null && raw !== undefined && (typeof raw === 'object' || typeof raw === 'number' || typeof raw === 'boolean')) {
      userAnswer = JSON.stringify(raw);
    } else throw new Error("Missing 'user_answer' parameter");
    if (utf8ByteLength(userAnswer) > 50000) throw new Error('答案内容过长（上限 50000 字符）');
    const isCorrectOverride = asBool(args.is_correct);
    const service = env.service();
    if (service !== null) {
      let question: Question | null = null;
      try { question = questions.getQuestionByCardId(service, sessionId, cardId); } catch { question = null; }
      if (question !== null) {
        let result;
        try { result = questions.submitAnswer(service, question.id, userAnswer, isCorrectOverride, null); }
        catch (error) {
          env.deps.log.warn(`[QBankExecutor] QuestionBankService submit_answer failed: ${errorText(error)}`);
          throw new Error(errorText(error));
        }
        env.emitChanged('submit_answer', [cardIdOf(question)]);
        const [key, zh, en] = answerMessage(result.needs_manual_grading, result.is_correct, false);
        return with_localized_message({
          is_correct: result.is_correct, correct_answer: result.correct_answer,
          needs_manual_grading: result.needs_manual_grading, submission_id: result.submission_id,
          source: 'questions_table',
        }, key, { isCorrect: result.is_correct, needsManualGrading: result.needs_manual_grading }, zh, en);
      }
    }
    const { document, updatedAt } = loadPreview(env, sessionId);
    const card = previewCards(document).find(item => item.card_id === cardId);
    if (card === undefined) throw new Error('Question not found');
    card.user_answer = userAnswer;
    card.attempt_count += 1;
    card.last_attempt_at = utcNow();
    const subjective = card.question_type === 'essay' || card.question_type === 'short_answer'
      || card.question_type === 'calculation' || card.question_type === 'proof';
    let isCorrect: boolean | null;
    let needsManualGrading = false;
    if (subjective && isCorrectOverride === null) {
      needsManualGrading = true;
      isCorrect = null;
      card.status = 'in_progress';
      delete card.is_correct;
    } else {
      const correct = isCorrectOverride ?? (card.answer === undefined ? false
        : checkPreviewAnswerCorrectness(userAnswer, card.answer, card.question_type));
      isCorrect = correct;
      card.is_correct = correct;
      if (correct) {
        card.correct_count += 1;
        card.status = card.correct_count >= 2 ? 'mastered' : 'in_progress';
      } else {
        card.status = 'review';
      }
    }
    const correctAnswer = card.answer ?? '';
    writePreviewIfUnchanged(env, sessionId, document, updatedAt, '题目集在读取后已被并发修改，本次作答未写入',
      '重新读取题目集最新状态后再提交作答；不要凭旧状态重试');
    env.emitChanged('submit_answer', [cardId]);
    const [key, zh, en] = answerMessage(needsManualGrading, isCorrect, true);
    return with_localized_message({
      is_correct: isCorrect, correct_answer: correctAnswer, needs_manual_grading: needsManualGrading,
      source: 'preview_json', degraded: true,
    }, key, { isCorrect, needsManualGrading }, zh, en);
  });
}

const NO_MATCH = ['chat.tools.qbank.no_matching_questions', '没有符合条件的题目', 'No questions match the requested filters.'] as const;
const NO_MORE = ['chat.tools.qbank.no_more_questions', '没有更多题目', 'There are no more questions.'] as const;

function notFound([key, zh, en]: readonly [string, string, string]): unknown {
  return with_localized_message({ found: false }, key, {}, zh, en);
}

function pickNext<T>(items: readonly T[], mode: string, tag: string | null, currentCardId: string | null,
  status: (item: T) => string, tags: (item: T) => readonly string[], cardId: (item: T) => string): T | undefined {
  switch (mode) {
    case 'random': return items[Math.floor(Math.random() * items.length)];
    case 'review_first':
      return items.find(item => status(item) === 'review') ?? items.find(item => status(item) === 'new')
        ?? items.find(item => status(item) === 'in_progress');
    case 'by_tag':
      return tag === null ? items[0] : items.find(item => tags(item).includes(tag) && status(item) !== 'mastered');
    default: {
      if (currentCardId === null) return items[0];
      const index = items.findIndex(item => cardId(item) === currentCardId);
      return index === -1 ? items[0] : items[index + 1];
    }
  }
}

/** qbank_executor.rs:3421 `execute_get_next_question`. */
export function executeGetNextQuestion(env: QbankToolEnv): unknown {
  const { args } = env;
  const sessionId = requiredStr(args, 'session_id');
  const mode = asStr(args.mode) ?? 'sequential';
  const tag = asStr(args.tag);
  const currentCardId = asStr(args.current_card_id);
  const reviewOnly = readBool(args, 'review_only', false);
  const service = env.service();
  if (service !== null) {
    let all = listAllQuestions(env, service, sessionId);
    if (reviewOnly) all = all.filter(question => question.status === 'review');
    if (all.length === 0) return notFound(NO_MATCH);
    const next = pickNext(all, mode, tag, currentCardId, question => question.status, question => question.tags, cardIdOf);
    if (next === undefined) return notFound(NO_MORE);
    return {
      card_id: cardIdOf(next), label: next.question_label, content: next.content, question_type: next.question_type,
      difficulty: next.difficulty, status: next.status, tags: next.tags, images: next.images, source: 'questions_table',
    };
  }
  const { document } = loadPreview(env, sessionId);
  let cards = previewCards(document);
  if (reviewOnly) cards = cards.filter(card => card.status === 'review');
  if (cards.length === 0) return notFound(NO_MATCH);
  const next = pickNext(cards, mode, tag, currentCardId, card => card.status, card => card.tags, card => card.card_id);
  if (next === undefined) return notFound(NO_MORE);
  return {
    card_id: next.card_id, label: next.question_label, content: next.ocr_text, question_type: next.question_type ?? null,
    difficulty: next.difficulty ?? null, status: next.status, tags: next.tags, source: 'preview_json', degraded: true,
  };
}

function progressReset(count: number, extra: Record<string, JsonValue>): unknown {
  return with_localized_message({ success: true, reset_count: count, ...extra }, 'chat.tools.qbank.progress_reset',
    { count }, `已重置 ${count} 道题目的学习进度`, `Reset learning progress for ${count} questions.`);
}

/** qbank_executor.rs:4231 `execute_reset_progress`. */
export function executeResetProgress(env: QbankToolEnv): Promise<unknown> {
  return env.lock.run(() => {
    const { args } = env;
    const sessionId = requiredStr(args, 'session_id');
    const cardIds = Array.isArray(args.card_ids)
      ? args.card_ids.filter((id): id is string => typeof id === 'string') : null;
    const service = env.service();
    if (service !== null) {
      if (cardIds !== null) {
        const questionIds: string[] = [];
        const foundCardIds: string[] = [];
        const missingCardIds: string[] = [];
        for (const cardId of cardIds) {
          let question: Question | null;
          try { question = questions.getQuestionByCardId(service, sessionId, cardId); }
          catch (error) { throw new Error(`Failed to resolve card_id ${cardId}: ${errorText(error)}`); }
          if (question === null) missingCardIds.push(cardId);
          else {
            questionIds.push(question.id);
            foundCardIds.push(cardId);
          }
        }
        if (questionIds.length === 0) {
          throw qbankFailure('QBANK_QUESTION_NOT_FOUND', `card_ids 均不存在于题目集 ${sessionId}`,
            '先用 qbank_list_questions 确认有效的 card_id 后重试');
        }
        let result;
        try { result = questions.resetQuestionsProgress(service, questionIds); }
        catch (error) { throw new Error(`Failed to reset progress: ${errorText(error)}`); }
        env.emitChanged('reset_progress', foundCardIds);
        return progressReset(result.success_count, { missing_card_ids: missingCardIds, source: 'questions_table' });
      }
      let stats;
      try { stats = questions.resetProgress(service, sessionId); }
      catch (error) { throw new Error(`Failed to reset progress: ${errorText(error)}`); }
      env.emitChanged('reset_progress', [sessionId]);
      return progressReset(stats.total_count, { source: 'questions_table' });
    }
    const { document, updatedAt } = loadPreview(env, sessionId);
    let resetCount = 0;
    for (const card of previewCards(document)) {
      if (cardIds !== null && !cardIds.includes(card.card_id)) continue;
      card.status = 'new';
      delete card.user_answer;
      delete card.is_correct;
      card.attempt_count = 0;
      card.correct_count = 0;
      delete card.last_attempt_at;
      resetCount += 1;
    }
    writePreviewIfUnchanged(env, sessionId, document, updatedAt, '题目集在读取后已被并发修改，进度重置未写入',
      '重新读取题目集最新状态后再重置进度；不要凭旧状态重试');
    env.emitChanged('reset_progress', cardIds ?? [sessionId]);
    return progressReset(resetCount, { source: 'preview_json', degraded: true });
  });
}
