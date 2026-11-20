/**
 * 「今日待复习」各入口（对话首页、待办、总览、学习桌面简报）点进去的统一落点。
 *
 * 学习桌面模式下经典视图层不渲染，`NAVIGATE_TO_VIEW` 只会改一个看不见的视图状态，
 * 所以这里按模式分流：学习桌面走 workbenchBus 开窗，经典壳沿用视图导航事件。
 */
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { openDueMistakesReview } from './dueMistakesReview';
import { openDueNotesReview } from './todayLearning';

export type TodayReviewTarget = 'cards' | 'mistakes' | 'notes' | 'todos';

/** 经典壳跳待办「今日」视图时的偏好信标（由 TodoContentView 在挂载或视图切换时消费） */
export const TODO_PENDING_SMART_VIEW_KEY = 'todo.pendingSmartView';

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
  dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'flashcards' });
}

/** 待办落到「今日」智能视图：工作台激活 showView(today)，经典壳写信标并切 todo 视图。 */
async function openTodosToday(workbench: boolean): Promise<void> {
  if (workbench) {
    await workbenchBus.activateDetailed({
      typeId: 'todo',
      instanceKey: '',
      action: 'showView',
      payload: { view: 'today' },
      fallbackLaunch: { typeId: 'todo', reason: 'api' },
    });
    return;
  }
  try { localStorage.setItem(TODO_PENDING_SMART_VIEW_KEY, 'today'); } catch { /* 偏好写入失败不影响跳转 */ }
  dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'todo' });
}

/** 打开资源库（新用户引导「先导入一份资料」用） */
export function openResourceLibrary(): void {
  if (workbenchBus.isEnabled()) workbenchBus.launch({ typeId: 'files', reason: 'api' });
  else dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'learning-hub' });
}

export function openTodayReviewTarget(target: TodayReviewTarget): void {
  const workbench = workbenchBus.isEnabled();
  switch (target) {
    case 'cards':
      void openFlashcardsToday(workbench).catch(() => {
        if (workbench) workbenchBus.launch({ typeId: 'flashcards', reason: 'api' });
        else dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'flashcards' });
      });
      return;
    case 'mistakes':
      openDueMistakesReview();
      return;
    case 'notes':
      openDueNotesReview(workbench ? () => { workbenchBus.launch({ typeId: 'files', reason: 'api' }); } : undefined);
      return;
    case 'todos':
      void openTodosToday(workbench).catch(() => {
        if (workbench) workbenchBus.launch({ typeId: 'todo', reason: 'api' });
        else dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'todo' });
      });
  }
}
