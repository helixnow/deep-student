/**
 * 作文批改 → 错题本：把批改标记里的「改写 / 错误」整理成改错题写入「作文错题」题目集。
 * 错误点从此可以练习、进复习计划、按错误类型计入掌握度（标签 = 错误类型），
 * 而不是只停留在一次性的批改文本里。
 */
import i18next from 'i18next';
import { invoke } from '@tauri-apps/api/core';
import { ensureNamedExam } from '@/utils/ensureNamedExam';
import { refreshTodayLearning } from '@/features/learning-today';
import {
  buildEssayMistakeDrafts,
  classifyEssayMistakeItems,
  type BuildEssayMistakeOptions,
  type ClassifiedEssayMistakeItem,
  type EssayMistakeCategory,
  type EssayMistakeDraft,
} from '../components/essay-grading/essayMistakeClassifier';

export {
  buildEssayMistakeDrafts,
  classifyEssayMistakeItems,
  type BuildEssayMistakeOptions,
  type ClassifiedEssayMistakeItem,
  type EssayMistakeCategory,
  type EssayMistakeDraft,
};

export interface SaveEssayMistakesResult {
  count: number;
  examId: string | null;
  examName: string;
  savedTitles: string[];
}

const LIST_PAGE_SIZE = 200;
const MAX_LIST_PAGES = 50;

const inFlightSaves = new Map<string, Promise<SaveEssayMistakesResult>>();

async function loadExistingQuestionContents(examId: string): Promise<Set<string>> {
  const existing = new Set<string>();
  for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
    const result = await invoke<{ questions?: Array<{ content?: unknown }>; has_more?: boolean } | null | undefined>(
      'qbank_list_questions',
      {
        request: {
          exam_id: examId,
          filters: {},
          page,
          page_size: LIST_PAGE_SIZE,
        },
      },
    );
    const questions = Array.isArray(result?.questions) ? result.questions : [];
    for (const q of questions) {
      if (typeof q?.content === 'string') {
        const normalized = q.content.trim();
        if (normalized) existing.add(normalized);
      }
    }
    if (!result?.has_more || questions.length < LIST_PAGE_SIZE) break;
  }
  return existing;
}

async function doSaveEssayMistakes(
  rawGrading: string,
  options: BuildEssayMistakeOptions = {},
): Promise<SaveEssayMistakesResult> {
  const includeSuggestions = options.includeSuggestions ?? true;
  const classified = classifyEssayMistakeItems(rawGrading);
  const items = includeSuggestions ? classified.all : classified.errors;
  const examName = i18next.t('essay_grading:mistakes.set_name', {
    defaultValue: '作文错题',
  }) as string;
  if (items.length === 0) {
    return { count: 0, examId: null, examName, savedTitles: [] };
  }
  const examId = await ensureNamedExam(examName, 'essayGrading.mistakeExamId');
  const existingContents = await loadExistingQuestionContents(examId);
  const newItems = items.filter((item) => !existingContents.has(item.draft.content.trim()));
  if (newItems.length === 0) {
    return { count: 0, examId, examName, savedTitles: [] };
  }

  const created = await invoke<Array<{ id?: string }> | null>('qbank_batch_create_questions', {
    paramsList: newItems.map((item) => ({
      exam_id: examId,
      content: item.draft.content,
      answer: item.draft.answer ?? null,
      explanation: item.draft.explanation ?? null,
      question_type: 'short_answer',
      tags: item.draft.tags,
      source_type: 'manual',
    })),
  });
  const questionIds = Array.isArray(created)
    ? created.map((item) => item?.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  if (questionIds.length > 0) {
    await invoke('qbank_batch_update_questions', {
      request: {
        question_ids: questionIds,
        params: { status: 'review' },
      },
    });
    await Promise.allSettled(
      questionIds.map((questionId) =>
        invoke('review_plan_create', { questionId, examId }),
      ),
    );
    void refreshTodayLearning();
  }
  return {
    count: newItems.length,
    examId,
    examName,
    savedTitles: newItems.map((item) => item.title).filter(Boolean),
  };
}

/** 写入「作文错题」题目集（去重 + 并发守卫），返回写入条数、题目集名称及条目摘要列表 */
export async function saveEssayMistakesWithDetails(
  rawGrading: string,
  options: BuildEssayMistakeOptions = {},
): Promise<SaveEssayMistakesResult> {
  const includeSuggestions = options.includeSuggestions ?? true;
  const cacheKey = `${includeSuggestions ? 'all' : 'err'}:${rawGrading}`;
  const pending = inFlightSaves.get(cacheKey);
  if (pending) return pending;
  const promise = doSaveEssayMistakes(rawGrading, { includeSuggestions }).finally(() => {
    if (inFlightSaves.get(cacheKey) === promise) {
      inFlightSaves.delete(cacheKey);
    }
  });
  inFlightSaves.set(cacheKey, promise);
  return promise;
}

/** 写入「作文错题」题目集（去重 + 并发守卫），同步置 status='review' 并加入 FSRS 复习队列；返回写入题数与题目集 id */
export async function saveEssayMistakes(rawGrading: string): Promise<{ count: number; examId: string | null }> {
  const result = await saveEssayMistakesWithDetails(rawGrading, { includeSuggestions: true });
  return { count: result.count, examId: result.examId };
}
