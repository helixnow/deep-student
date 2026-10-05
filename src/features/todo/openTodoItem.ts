/**
 * 打开待办并选中某一条（到点提醒点通知直达等入口共用）。
 *
 * 学习桌面下经典视图层不渲染：开 / 聚焦待办窗口并发 focusItem（窗口没开会先打开）；
 * 经典壳 / 手机切到待办页。那条待办不在当前视图时，store.focusItem 会切到它所在清单。
 */
import { workbenchBus } from '@/features/workbench/core/workbenchBus';

export async function openTodoItem(itemId: string): Promise<void> {
  if (workbenchBus.isEnabled()) {
    await workbenchBus.activateDetailed({
      typeId: 'todo',
      instanceKey: '',
      action: 'focusItem',
      payload: { itemId },
      fallbackLaunch: { typeId: 'todo', reason: 'api' },
    });
    return;
  }
  window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', { detail: { view: 'todo' } }));
  try {
    const { useTodoTrashView } = await import('./components/TodoTrashDialog');
    useTodoTrashView.getState().close();
  } catch {
    // 回收站视图是界面增强；加载失败不影响选中
  }
  const { useTodoStore } = await import('./stores/useTodoStore');
  await useTodoStore.getState().focusItem(itemId);
}
