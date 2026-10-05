/**
 * 跨题目集的「到期错题复习」：首页 / 待办 / 学习桌面里点「错题复习 N」直接开始复习，
 * 不必先去资源库逐个题目集找「更多 › 复习计划」。
 *
 * 复用 SM-2 复习会话（reviewPlanStore + ReviewSession）；会话 examId 用固定键标记为跨题目集，
 * 各题目集窗口里的复习面板据此识别「不是本题目集的会话」而不去接管。
 */
import { invoke } from '@tauri-apps/api/core';
import type { ReviewItemWithQuestion, ReviewPlan, ReviewSessionQuestion } from '@/stores/reviewPlanStore';

export const DUE_MISTAKES_SESSION_KEY = '__due_mistakes__';

const QUESTION_FETCH_BATCH = 8;

let open = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of Array.from(listeners)) fn();
}

export function isDueMistakesReviewOpen(): boolean {
  return open;
}

export function subscribeDueMistakesReview(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function openDueMistakesReview(): void {
  if (open) return;
  open = true;
  notify();
}

export function closeDueMistakesReview(): void {
  if (!open) return;
  open = false;
  notify();
}

export interface DueMistakeItems {
  items: ReviewItemWithQuestion[];
  /** 计划还在、题目已被删除的条数（跳过，不进队列） */
  missing: number;
}

/** 今天到期（含逾期）的全部错题复习计划，按后端顺序配上题目内容。 */
export async function loadDueMistakeItems(): Promise<DueMistakeItems> {
  const result = await invoke<{ plans?: ReviewPlan[] }>('review_plan_get_due', { examId: null, untilDate: null });
  const plans = result?.plans ?? [];
  const items: ReviewItemWithQuestion[] = [];
  for (let start = 0; start < plans.length; start += QUESTION_FETCH_BATCH) {
    const batch = plans.slice(start, start + QUESTION_FETCH_BATCH);
    const questions = await Promise.all(
      batch.map((plan) =>
        invoke<ReviewSessionQuestion | null>('qbank_get_question', { questionId: plan.question_id }).catch(() => null),
      ),
    );
    questions.forEach((question, offset) => {
      if (question) items.push({ plan: batch[offset], question });
    });
  }
  return { items, missing: plans.length - items.length };
}
