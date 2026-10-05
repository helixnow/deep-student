/**
 * 错题本的两种跳转：
 * - 从错题回到题目集里的这道题（两种壳都走 NAVIGATE_TO_VIEW + openResource 开题目集，
 *   再用题目集视图已监听的 QBANK_FOCUS_EVENT 定位；题目异步加载，带 ack 重试）
 * - 从别处打开「题目集 › 错题本」（同 openDueNotesReview：写视图偏好 → 请求快捷入口 → 开学习资源）
 */
import { useCallback, useState } from 'react';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { requestLearningHubQuickAccess } from '../navigation/quickAccessRequest';

export type ExamsFinderView = 'all' | 'mistakes';

const EXAMS_VIEW_STORAGE_KEY = 'learningHub.examsView';
export const EXAMS_VIEW_EVENT = 'learningHub:exams-view';

/** 题目集冷打开时题目还在加载，按这些时刻重发定位，收到 handled 即停 */
const FOCUS_RETRY_DELAYS_MS = [250, 600, 1200, 2000, 3200, 5000];

export function openQuestionInExam(examId: string, questionId: string): void {
  window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', {
    detail: { view: 'learning-hub', openResource: `/${examId}` },
  }));
  void import('@/features/workbench/agent/drivers/qbankDriver').then(({ QBANK_FOCUS_EVENT }) => {
    let handled = false;
    for (const delay of FOCUS_RETRY_DELAYS_MS) {
      window.setTimeout(() => {
        if (handled) return;
        window.dispatchEvent(new CustomEvent(QBANK_FOCUS_EVENT, {
          detail: {
            questionId,
            targetResourceId: examId,
            acknowledge: (result: { handled: boolean }) => {
              if (result.handled) handled = true;
            },
          },
        }));
      }, delay);
    }
  });
}

export function openMistakeBook(): void {
  try { localStorage.setItem(EXAMS_VIEW_STORAGE_KEY, 'mistakes'); } catch { /* 偏好写入失败不影响跳转 */ }
  // 已挂载的视图标签不会重读偏好：显式通知切到错题本
  window.dispatchEvent(new CustomEvent(EXAMS_VIEW_EVENT, { detail: { view: 'mistakes' } }));
  requestLearningHubQuickAccess('exams');
  if (workbenchBus.isEnabled()) workbenchBus.launch({ typeId: 'files', reason: 'api' });
  else window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', { detail: { view: 'learning-hub' } }));
}

/** 「题目集」入口下的视图（全部题目集 / 错题本），记住上次选择 */
export function useExamsView(): [ExamsFinderView, (view: ExamsFinderView) => void] {
  const [view, setView] = useState<ExamsFinderView>(() => {
    try {
      return localStorage.getItem(EXAMS_VIEW_STORAGE_KEY) === 'mistakes' ? 'mistakes' : 'all';
    } catch { return 'all'; }
  });
  const update = useCallback((next: ExamsFinderView) => {
    setView(next);
    try { localStorage.setItem(EXAMS_VIEW_STORAGE_KEY, next); } catch { /* 偏好写入失败不影响切换 */ }
  }, []);
  useEventRegistry([{
    target: 'window',
    type: EXAMS_VIEW_EVENT,
    listener: (event) => {
      const next = (event as CustomEvent<{ view?: string }>).detail?.view;
      if (next === 'all' || next === 'mistakes') update(next);
    },
  }], [update]);
  return [view, update];
}
