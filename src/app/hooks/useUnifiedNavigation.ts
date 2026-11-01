import { useCallback, useEffect, useRef, useState } from 'react';
import type { CurrentView } from '@/types/navigation';
import { useNavigationHistory } from '@/hooks/useNavigationHistory';
import { useNavigationShortcuts } from '@/hooks/useNavigationShortcuts';
import {
  getGlobalLearningHubNavigation,
  subscribeLearningHubNavigation,
} from '@/features/learning-hub';
import { useWindowStore } from '@/features/workbench/core/windowStore';
import type { SetCurrentView } from '../navigation/viewRouting';

/**
 * App 壳层：统一前进 / 后退。页面级视图历史（useNavigationHistory）与 Learning Hub /
 * workbench files 窗口的 finder 内部历史合并为一组 canGoBack / canGoForward / goBack /
 * goForward，并挂上键鼠快捷键（useNavigationShortcuts）。从 App.tsx 原样搬出。
 */
export function useUnifiedNavigation(currentView: CurrentView, setCurrentView: SetCurrentView, workbenchActive: boolean) {
  // 🐛 BUG-1 修复: 追踪是否通过页面级 back/forward 抵达 Learning Hub
  // 当通过页面级导航抵达 LH 时，前进按钮应优先使用页面级前进（如有），
  // 避免 LH 内部残留的前进历史遮蔽页面级前进。
  const arrivedAtLHViaPageNavRef = useRef(false);
  const pageNavInProgressRef = useRef(false);

  // ⚙️ 视图历史：使用新的导航历史 Hook
  const navigationHistory = useNavigationHistory({
    currentView,
    onViewChange: (view, _params) => {
      // 🐛 BUG-1: 页面级导航（back/forward）抵达 LH 时设置标记
      if (pageNavInProgressRef.current && view === 'learning-hub') {
        arrivedAtLHViaPageNavRef.current = true;
      }
      setCurrentView(view);
    },
  });

  // 📁 Learning Hub 内部导航（使用全局订阅，因为 App.tsx 在 Provider 外部）
  const [learningHubNav, setLearningHubNav] = useState(() => getGlobalLearningHubNavigation());
  const isInLearningHub = currentView === 'learning-hub';

  // 订阅 Learning Hub 导航状态变化
  useEffect(() => {
    // 获取初始状态
    setLearningHubNav(getGlobalLearningHubNavigation());

    // 订阅状态变化
    const unsubscribe = subscribeLearningHubNavigation((state) => {
      setLearningHubNav(state);
    });

    return unsubscribe;
  }, []);

  // 🐛 BUG-1: 离开 Learning Hub 时清除页面级抵达标记
  useEffect(() => {
    if (!isInLearningHub) {
      arrivedAtLHViaPageNavRef.current = false;
    }
  }, [isInLearningHub]);

  // 统一的导航处理：Learning Hub / workbench files 的 finder 历史优先，否则使用页面级导航
  // 🐛 BUG-1: 通过页面级导航抵达 LH 时，前进优先使用页面级（如有），
  //   避免 LH 残留的内部前进历史遮蔽页面级前进目标。
  const focusedWbTypeId = useWindowStore((s) => {
    if (!workbenchActive) return null;
    const topId = s.focusStack[s.focusStack.length - 1];
    return topId ? (s.windows[topId]?.typeId ?? null) : null;
  });
  const isWorkbenchFilesFocused = workbenchActive && focusedWbTypeId === 'files';
  const finderCanBack = Boolean(learningHubNav?.canGoBack);
  const finderCanForward = Boolean(learningHubNav?.canGoForward);

  const unifiedCanGoBack =
    ((isInLearningHub || isWorkbenchFilesFocused) && finderCanBack)
    || (!isWorkbenchFilesFocused && navigationHistory.canGoBack);
  const unifiedCanGoForward = (() => {
    if (isInLearningHub) {
      // 通过页面级导航抵达 LH 且页面级有前进 → 页面级前进优先
      if (arrivedAtLHViaPageNavRef.current && navigationHistory.canGoForward) {
        return true;
      }
      // LH 内部有前进（用户主动 LH 后退产生的，或页面级前进已耗尽）
      if (finderCanForward) {
        return true;
      }
    }
    if (isWorkbenchFilesFocused) {
      return finderCanForward;
    }
    return navigationHistory.canGoForward;
  })();
  const unifiedGoBack = useCallback(() => {
    if (isInLearningHub && arrivedAtLHViaPageNavRef.current && navigationHistory.canGoBack) {
      pageNavInProgressRef.current = true;
      navigationHistory.goBack();
      pageNavInProgressRef.current = false;
      return;
    }
    if ((isInLearningHub || isWorkbenchFilesFocused) && learningHubNav?.canGoBack) {
      learningHubNav.goBack();
      // 🐛 BUG-1: 用户主动使用 LH 内部后退，清除页面级抵达标记
      if (isInLearningHub) {
        arrivedAtLHViaPageNavRef.current = false;
      }
      return;
    }
    // files 聚焦且 finder 已见底：勿用页面级 history 偷换视图
    if (isWorkbenchFilesFocused) {
      return;
    }
    pageNavInProgressRef.current = true;
    navigationHistory.goBack();
    pageNavInProgressRef.current = false;
  }, [isInLearningHub, isWorkbenchFilesFocused, learningHubNav, navigationHistory]);
  const unifiedGoForward = useCallback(() => {
    if (isInLearningHub) {
      // 🐛 BUG-1: 通过页面级导航抵达 LH 且页面级有前进 → 页面级前进优先
      if (arrivedAtLHViaPageNavRef.current && navigationHistory.canGoForward) {
        pageNavInProgressRef.current = true;
        navigationHistory.goForward();
        pageNavInProgressRef.current = false;
        return;
      }
      // LH 内部有前进（正常 LH 浏览，或页面级前进已耗尽）
      if (learningHubNav?.canGoForward) {
        learningHubNav.goForward();
        return;
      }
    }
    if (isWorkbenchFilesFocused) {
      if (learningHubNav?.canGoForward) {
        learningHubNav.goForward();
      }
      return;
    }
    navigationHistory.goForward();
  }, [isInLearningHub, isWorkbenchFilesFocused, learningHubNav, navigationHistory]);
  
  // ⌨️ 键盘和鼠标快捷键支持
  useNavigationShortcuts({
    onBack: unifiedGoBack,
    onForward: unifiedGoForward,
    canGoBack: unifiedCanGoBack,
    canGoForward: unifiedCanGoForward,
  });

  return {
    navigationHistory,
    unifiedCanGoBack,
    unifiedCanGoForward,
    unifiedGoBack,
    unifiedGoForward,
  };
}
