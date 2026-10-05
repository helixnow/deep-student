/**
 * 「今日待复习」各入口（对话首页、待办、总览、学习桌面简报）点进去的统一落点。
 *
 * 学习桌面模式下经典视图层不渲染，`NAVIGATE_TO_VIEW` 只会改一个看不见的视图状态，
 * 所以这里按模式分流：学习桌面走 workbenchBus 开窗，经典壳沿用视图导航事件。
 */
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { openDueMistakesReview } from './dueMistakesReview';
import { openDueNotesReview } from './todayLearning';

export type TodayReviewTarget = 'cards' | 'mistakes' | 'notes';

/** 闪卡落到「今日」页；正在复习就不打断，只把闪卡带到前面。 */
async function openFlashcardsToday(workbench: boolean): Promise<void> {
  const { useFsrsReviewStore } = await import('@/features/flashcards/store/fsrsReviewStore');
  const inSession = useFsrsReviewStore.getState().screen === 'session';
  if (workbench) {
    if (inSession) {
      workbenchBus.launch({ typeId: 'flashcards', reason: 'api' });
      return;
    }
    await workbenchBus.activateDetailed({
      typeId: 'flashcards',
      instanceKey: '',
      action: 'showScreen',
      payload: { screen: 'today' },
      fallbackLaunch: { typeId: 'flashcards', reason: 'api', payload: { screen: 'today' } },
    });
    return;
  }
  if (!inSession) useFsrsReviewStore.getState().setScreen('today');
  window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', { detail: { view: 'flashcards' } }));
}

export function openTodayReviewTarget(target: TodayReviewTarget): void {
  const workbench = workbenchBus.isEnabled();
  switch (target) {
    case 'cards':
      void openFlashcardsToday(workbench).catch(() => {
        if (workbench) workbenchBus.launch({ typeId: 'flashcards', reason: 'api' });
        else window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', { detail: { view: 'flashcards' } }));
      });
      return;
    case 'mistakes':
      openDueMistakesReview();
      return;
    case 'notes':
      openDueNotesReview(workbench ? () => { workbenchBus.launch({ typeId: 'files', reason: 'api' }); } : undefined);
  }
}
