import { useEffect } from 'react';
import type { CurrentView } from '@/types/navigation';
import { autoSaveScrollPosition, autoRestoreScrollPosition } from '@/utils/viewStateManager';

/**
 * App 壳层：列表类视图切入时恢复滚动位置并自动保存。从 App.tsx 原样搬出。
 */
export function useViewScrollRestoration(currentView: CurrentView) {
  // 📜 自动保存和恢复列表页滚动位置（扩展到所有主要视图）
  useEffect(() => {
    const viewsWithScrollState: CurrentView[] = [
      'learning-hub',
      'settings',
      'skills-management',
      'task-dashboard',
      'template-management',
    ];
    
    if (!viewsWithScrollState.includes(currentView)) {
      return;
    }

    // 恢复滚动位置
    const timer = setTimeout(() => {
      autoRestoreScrollPosition(currentView);
    }, 100); // 等待 DOM 渲染

    // 自动保存滚动位置
    const cleanup = autoSaveScrollPosition(currentView);

    return () => {
      clearTimeout(timer);
      cleanup();
    };
  }, [currentView]);
}
