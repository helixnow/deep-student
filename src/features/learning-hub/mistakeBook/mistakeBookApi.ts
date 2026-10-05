/**
 * 跨题目集错题本数据：qbank_list_mistakes（错题 = status review，与题目集内「错题本」同口径）。
 * 后端题目是 snake_case，这里转成界面通用的 Question。
 */
import { invoke } from '@tauri-apps/api/core';
import type {
  Difficulty,
  Question,
  QuestionOption,
  QuestionStatus,
  QuestionType,
} from '@/api/questionBankApi';

export type MistakeSort = 'recent' | 'errors';

export const MISTAKE_PAGE_SIZE = 50;

/** 批量重做一套最多多少题（同题目集练习交接的 1–100 题上限） */
export const MISTAKE_REDO_LIMIT = 100;

export interface MistakeItem {
  question: Question;
  examId: string;
  examName: string | null;
}

export interface MistakeExamCount {
  examId: string;
  examName: string | null;
  count: number;
}

export interface MistakePage {
  items: MistakeItem[];
  total: number;
  page: number;
  hasMore: boolean;
  /** 各题目集错题数（不受筛选影响） */
  exams: MistakeExamCount[];
}

interface RawMistake {
  id: string;
  exam_id: string;
  exam_name?: string | null;
  card_id?: string | null;
  question_label?: string | null;
  content: string;
  options?: QuestionOption[] | null;
  answer?: string | null;
  explanation?: string | null;
  question_type?: string | null;
  difficulty?: string | null;
  tags?: string[] | null;
  status?: string | null;
  user_answer?: string | null;
  is_correct?: boolean | null;
  attempt_count?: number | null;
  correct_count?: number | null;
  last_attempt_at?: string | null;
  source_ref?: string | null;
}

interface RawMistakePage {
  items?: RawMistake[];
  total?: number;
  page?: number;
  has_more?: boolean;
  exams?: Array<{ exam_id: string; exam_name?: string | null; count: number }>;
}

function toQuestion(raw: RawMistake): Question {
  return {
    id: raw.id,
    cardId: raw.card_id || raw.id,
    questionLabel: raw.question_label || '',
    content: raw.content,
    ocrText: raw.content,
    questionType: (raw.question_type || 'other') as QuestionType,
    options: raw.options ?? undefined,
    answer: raw.answer ?? undefined,
    explanation: raw.explanation ?? undefined,
    difficulty: (raw.difficulty ?? undefined) as Difficulty | undefined,
    tags: raw.tags ?? [],
    status: (raw.status ?? undefined) as QuestionStatus | undefined,
    userAnswer: raw.user_answer ?? undefined,
    isCorrect: raw.is_correct ?? undefined,
    attemptCount: raw.attempt_count ?? 0,
    correctCount: raw.correct_count ?? 0,
    lastAttemptAt: raw.last_attempt_at ?? undefined,
    sourceRef: raw.source_ref ?? null,
  };
}

export async function listMistakes(params: {
  examId?: string | null;
  search?: string;
  sort?: MistakeSort;
  page?: number;
  pageSize?: number;
}): Promise<MistakePage> {
  const result = await invoke<RawMistakePage>('qbank_list_mistakes', {
    request: {
      filters: {
        exam_id: params.examId || null,
        search: params.search?.trim() || null,
        sort: params.sort ?? 'recent',
      },
      page: params.page ?? 1,
      page_size: params.pageSize ?? MISTAKE_PAGE_SIZE,
    },
  });
  return {
    items: (result?.items ?? []).map((raw) => ({
      question: toQuestion(raw),
      examId: raw.exam_id,
      examName: raw.exam_name ?? null,
    })),
    total: result?.total ?? 0,
    page: result?.page ?? 1,
    hasMore: Boolean(result?.has_more),
    exams: (result?.exams ?? []).map((exam) => ({
      examId: exam.exam_id,
      examName: exam.exam_name ?? null,
      count: exam.count,
    })),
  };
}
