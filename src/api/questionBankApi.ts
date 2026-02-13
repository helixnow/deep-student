import { invoke } from '@tauri-apps/api/core';
import type { ExamSheetSessionDetail } from '@/utils/tauriApi';
import i18n from '@/i18n';

export type QuestionStatus = 'new' | 'in_progress' | 'mastered' | 'review';
export type Difficulty = 'easy' | 'medium' | 'hard' | 'very_hard';
export type QuestionType = 
  | 'single_choice' 
  | 'multiple_choice'
  | 'indefinite_choice'
  | 'fill_blank' 
  | 'short_answer' 
  | 'essay' 
  | 'calculation' 
  | 'proof' 
  | 'other';

export type PracticeMode = 'sequential' | 'random' | 'review_first' | 'by_tag' | 'timed' | 'mock_exam' | 'daily' | 'paper';

export interface QuestionOption {
  key: string;
  content: string;
}

export interface QuestionImage {
  id: string;
  name: string;
  mime: string;
  hash: string;
}

export interface Question {
  id: string;
  cardId?: string;
  questionLabel: string;
  content: string;
  ocrText?: string;
  questionType: QuestionType;
  options?: QuestionOption[];
  answer?: string;
  explanation?: string;
  difficulty?: Difficulty;
  tags?: string[];
  status?: QuestionStatus;
  userAnswer?: string;
  isCorrect?: boolean;
  userNote?: string;
  attemptCount?: number;
  correctCount?: number;
  lastAttemptAt?: string;
  isFavorite?: boolean;
  images?: QuestionImage[];
  // AI 评判缓存
  ai_feedback?: string;
  ai_score?: number;
  ai_graded_at?: string;
}

export interface QuestionBankStats {
  total: number;
  mastered: number;
  review: number;
  inProgress: number;
  newCount: number;
  correctRate: number;
}

export interface SubmitResult {
  /** 是否正确。主观题（需手动批改）时为 null，避免误判为"错误"。 */
  isCorrect: boolean | null;
  correctAnswer?: string;
  explanation?: string;
  message?: string;
  needsManualGrading?: boolean;
  /** 多选题部分正确：得分比例 0-1 */
  partialScore?: number;
  /** 多选题：漏选的选项 */
  missedOptions?: string[];
  /** 多选题：错选的选项 */
  wrongOptions?: string[];
  /** 本次作答记录 ID（用于关联 AI 评判） */
  submissionId?: string;
}

function mapQuestionType(rawType?: string): QuestionType {
  const t = rawType?.toLowerCase() || '';
  if (t.includes('single') || t.includes('单选')) return 'single_choice';
  if (t.includes('multiple') || t.includes('多选')) return 'multiple_choice';
  if (t.includes('fill') || t.includes('填空')) return 'fill_blank';
  if (t.includes('short') || t.includes('简答')) return 'short_answer';
  if (t.includes('essay') || t.includes('论述')) return 'essay';
  if (t.includes('calc') || t.includes('计算')) return 'calculation';
  if (t.includes('proof') || t.includes('证明')) return 'proof';
  return 'other';
}

function mapStatus(rawStatus?: string): QuestionStatus {
  const s = rawStatus?.toLowerCase() || '';
  if (s === 'mastered' || s === '已掌握') return 'mastered';
  if (s === 'review' || s === '需复习') return 'review';
  if (s === 'in_progress' || s === '学习中') return 'in_progress';
  return 'new';
}

function mapDifficulty(rawDiff?: string): Difficulty | undefined {
  const d = rawDiff?.toLowerCase() || '';
  if (d === 'easy' || d === '简单') return 'easy';
  if (d === 'medium' || d === '中等') return 'medium';
  if (d === 'hard' || d === '困难') return 'hard';
  if (d === 'very_hard' || d === '极难') return 'very_hard';
  return undefined;
}

/**
 * @deprecated 仅供 OCR 预览上下文使用。
 * 此函数从 preview.pages[].cards[] 提取题目，与 Store 层从 qbank_list_questions 获取的数据是
 * 两个不同的数据源（preview cards vs questions 表）。在 ExamContentView 等正式答题场景中，
 * 始终使用 Store 数据（useQuestionBankSession），不要使用此函数。
 */
export function extractQuestionsFromSession(detail: ExamSheetSessionDetail): Question[] {
  const questions: Question[] = [];
  
  for (const page of detail.preview.pages) {
    for (const card of page.cards) {
      const options: QuestionOption[] | undefined = card.options?.map(opt => ({
        key: opt.key || '',
        content: opt.content || '',
      }));

      questions.push({
        id: card.card_id,
        cardId: card.card_id,
        questionLabel: card.question_label || `Q${questions.length + 1}`,
        content: card.ocr_text || '',
        ocrText: card.ocr_text,
        questionType: mapQuestionType(card.question_type),
        options,
        answer: card.answer,
        explanation: card.explanation,
        difficulty: mapDifficulty(card.difficulty),
        tags: card.tags || [],
        status: mapStatus(card.status),
        userAnswer: card.user_answer,
        isCorrect: card.is_correct,
        userNote: card.user_note,
        attemptCount: card.attempt_count || 0,
        correctCount: card.correct_count || 0,
        lastAttemptAt: card.last_attempt_at,
        isFavorite: (card as { is_favorite?: boolean }).is_favorite ?? false,
        images: (card as { images?: QuestionImage[] }).images || [],
      });
    }
  }

  return questions;
}

export function calculateStats(questions: Question[]): QuestionBankStats {
  const stats: QuestionBankStats = {
    total: questions.length,
    mastered: 0,
    review: 0,
    inProgress: 0,
    newCount: 0,
    correctRate: 0,
  };

  let totalAttempts = 0;
  let totalCorrect = 0;

  for (const q of questions) {
    switch (q.status) {
      case 'mastered': stats.mastered++; break;
      case 'review': stats.review++; break;
      case 'in_progress': stats.inProgress++; break;
      default: stats.newCount++;
    }
    totalAttempts += q.attemptCount ?? 0;
    totalCorrect += q.correctCount ?? 0;
  }

  if (totalAttempts > 0) {
    stats.correctRate = totalCorrect / totalAttempts;
  }

  return stats;
}

/**
 * @deprecated 此函数调用旧的 update_exam_sheet_cards API，不经过 QuestionBankService 的答题判定 + 统计刷新逻辑。
 * 答题数据不会进入 submissions 表、不触发状态转换、不更新统计。
 * 请使用 useQuestionBankSession 的 submitAnswer（走 Store → qbank_submit_answer）代替。
 */
export async function submitAnswer(
  sessionId: string,
  cardId: string,
  userAnswer: string,
  questionType?: QuestionType
): Promise<SubmitResult> {
  const response = await invoke<{ detail: ExamSheetSessionDetail }>('update_exam_sheet_cards', {
    request: {
      session_id: sessionId,
      cards: [{
        card_id: cardId,
        user_answer: userAnswer,
      }],
    },
  });

  const card = response.detail.preview.pages
    .flatMap(p => p.cards)
    .find(c => c.card_id === cardId);

  if (!card) {
    return { isCorrect: false, message: i18n.t('practice:editor.questionNotFound', 'Question not found') };
  }

  const isSubjective = questionType && ['essay', 'short_answer', 'calculation', 'proof'].includes(questionType);
  
  if (isSubjective) {
    return {
      isCorrect: false,
      correctAnswer: card.answer,
      message: i18n.t('practice:editor.subjectiveSubmitted', 'Subjective question submitted') + '. ' + i18n.t('practice:editor.judgeSelf', 'Please judge against the reference answer'),
      needsManualGrading: true,
    };
  }

  const isCorrect = card.is_correct ?? checkAnswerCorrectness(userAnswer, card.answer, questionType);

  return {
    isCorrect,
    correctAnswer: card.answer,
    message: isCorrect ? i18n.t('practice:editor.answerCorrect', 'Correct!') : i18n.t('practice:editor.answerWrongDetail', 'Incorrect, please check the correct answer.'),
  };
}

function checkAnswerCorrectness(userAnswer: string, correctAnswer?: string, questionType?: QuestionType): boolean {
  if (!correctAnswer) return false;
  
  const normalizeAnswer = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '');
  
  if (questionType === 'multiple_choice') {
    const userChoices = normalizeAnswer(userAnswer).split('').sort().join('');
    const correctChoices = normalizeAnswer(correctAnswer).split('').sort().join('');
    return userChoices === correctChoices;
  }
  
  return normalizeAnswer(userAnswer) === normalizeAnswer(correctAnswer);
}

export function getNextQuestionIndex(
  questions: Question[],
  currentIndex: number,
  mode: PracticeMode,
  tag?: string
): number {
  if (questions.length === 0) return 0;

  switch (mode) {
    case 'random':
      return Math.floor(Math.random() * questions.length);
    case 'review_first': {
      const reviewIdx = questions.findIndex(q => q.status === 'review');
      if (reviewIdx >= 0) return reviewIdx;
      const newIdx = questions.findIndex(q => q.status === 'new');
      if (newIdx >= 0) return newIdx;
      const progressIdx = questions.findIndex(q => q.status === 'in_progress');
      if (progressIdx >= 0) return progressIdx;
      return Math.min(currentIndex + 1, questions.length - 1);
    }
    case 'by_tag': {
      if (!tag) return Math.min(currentIndex + 1, questions.length - 1);
      const tagIdx = questions.findIndex((q, i) =>
        i > currentIndex && q.tags?.includes(tag) && q.status !== 'mastered'
      );
      if (tagIdx >= 0) return tagIdx;
      const fromStartIdx = questions.findIndex(q =>
        q.tags?.includes(tag) && q.status !== 'mastered'
      );
      return fromStartIdx >= 0 ? fromStartIdx : Math.min(currentIndex + 1, questions.length - 1);
    }
    default:
      return Math.min(currentIndex + 1, questions.length - 1);
  }
}
