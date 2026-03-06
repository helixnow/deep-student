/**
 * Learning Hub 导航上下文
 *
 * 用于在 Topbar 和 LearningHubPage 之间共享文件夹导航状态。
 * 
 * ★ 文档28 Prompt 8: 集成真实路径导航系统
 */

import React, { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react';
import type { RealPathBreadcrumbItem } from './hooks/useFolderNavigation';
import { useFinderStore } from './stores/finderStore';

// ============================================================================
// 📱 全局导航 Ref（解决 App.tsx 无法访问 Context 的问题）
// ============================================================================

/**
 * 全局导航状态，用于在 Provider 外部（App.tsx）访问导航状态
 * 这是必要的，因为 App.tsx 渲染 Provider，所以它本身不在 Provider 内部
 */
interface GlobalNavigationState {
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
}

const globalNavigationRef: { current: GlobalNavigationState | null } = { current: null };

/**
 * 获取全局导航状态（供 App.tsx 使用）
 */
export function getGlobalLearningHubNavigation(): GlobalNavigationState | null {
  return globalNavigationRef.current;
}

/**
 * 导航状态变化事件名
 */
export const LEARNING_HUB_NAV_STATE_CHANGED = 'learningHubNavStateChanged';

/**
 * 订阅导航状态变化（供 App.tsx 使用）
 * @param callback 状态变化回调
 * @returns 取消订阅函数
 */
export function subscribeLearningHubNavigation(
  callback: (state: GlobalNavigationState | null) => void
): () => void {
  const handler = (evt: Event) => {
    const customEvt = evt as CustomEvent<GlobalNavigationState>;
    callback(customEvt.detail);
  };
  window.addEventListener(LEARNING_HUB_NAV_STATE_CHANGED, handler);
  return () => window.removeEventListener(LEARNING_HUB_NAV_STATE_CHANGED, handler);
}

interface LearningHubNavigationContextValue {
  /** 当前文件夹 ID */
  currentFolderId: string | null;
  /** 当前文件夹路径 */
  currentFolderPath: string;
  /** 面包屑列表（真实路径版） */
  breadcrumbs: RealPathBreadcrumbItem[];
  /** 设置当前文件夹 ID（不记录历史） */
  setCurrentFolderId: (folderId: string | null) => void;
  /** 导航到文件夹（记录历史） */
  navigateTo: (folderId: string | null) => void;
  /** 导航到面包屑位置 */
  navigateToBreadcrumb: (index: number) => void;
  /** 是否可以后退 */
  canGoBack: boolean;
  /** 是否可以前进 */
  canGoForward: boolean;
  /** 后退 */
  goBack: () => void;
  /** 前进 */
  goForward: () => void;
  /** 是否在 Learning Hub 页面 */
  isInLearningHub: boolean;
  /** 设置是否在 Learning Hub 页面 */
  setIsInLearningHub: (value: boolean) => void;
  /** 是否正在加载导航 */
  isNavigationLoading: boolean;
  /** 📱 是否有应用打开（用于移动端返回逻辑） */
  hasOpenApp: boolean;
  /** 📱 设置应用打开状态 */
  setHasOpenApp: (value: boolean) => void;
  /** 📱 关闭应用的回调 */
  closeAppCallback: (() => void) | null;
  /** 📱 注册关闭应用的回调 */
  registerCloseAppCallback: (callback: (() => void) | null) => void;
}

const LearningHubNavigationContext = createContext<LearningHubNavigationContextValue | null>(null);

export const LearningHubNavigationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isInLearningHub, setIsInLearningHub] = useState(false);

  // 📱 应用打开状态（用于移动端返回逻辑）
  const [hasOpenApp, setHasOpenApp] = useState(false);
  const [closeAppCallback, setCloseAppCallback] = useState<(() => void) | null>(null);

  // 注册关闭应用的回调
  const registerCloseAppCallback = useCallback((callback: (() => void) | null) => {
    setCloseAppCallback(() => callback);
  }, []);

  const {
    historyIndex,
    history,
    goBack: finderGoBack,
    goForward: finderGoForward,
    currentPath,
    enterFolder,
    jumpToBreadcrumb,
    setCurrentPathWithoutHistory,
  } = useFinderStore();

  const breadcrumbs = useMemo<RealPathBreadcrumbItem[]>(
    () => currentPath.breadcrumbs.map((crumb) => ({
      folderId: crumb.id,
      name: crumb.name,
      fullPath: crumb.dstuPath,
    })),
    [currentPath.breadcrumbs]
  );
  const currentFolderPath = breadcrumbs[breadcrumbs.length - 1]?.fullPath || '/';

  // 从 finderStore 的历史栈计算 canGoBack/canGoForward
  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < history.length - 1;

  // goBack/goForward 直接使用 finderStore 的方法
  const goBack = useCallback(() => {
    finderGoBack();
  }, [finderGoBack]);

  const goForward = useCallback(() => {
    finderGoForward();
  }, [finderGoForward]);

  const navigateTo = useCallback((folderId: string | null) => {
    if (folderId) {
      void enterFolder(folderId);
      return;
    }
    jumpToBreadcrumb(-1);
  }, [enterFolder, jumpToBreadcrumb]);

  const navigateToBreadcrumb = useCallback((index: number) => {
    jumpToBreadcrumb(index);
  }, [jumpToBreadcrumb]);

  const setCurrentFolderId = useCallback((folderId: string | null) => {
    void setCurrentPathWithoutHistory(folderId);
  }, [setCurrentPathWithoutHistory]);

  // 📱 增强版 canGoBack：有应用打开时也返回 true
  const enhancedCanGoBack = hasOpenApp || canGoBack;

  // 📱 增强版 goBack：优先关闭应用
  const enhancedGoBack = useCallback(() => {
    if (hasOpenApp && closeAppCallback) {
      closeAppCallback();
    } else {
      goBack();
    }
  }, [hasOpenApp, closeAppCallback, goBack]);

  // 📱 同步导航状态到全局 ref（供 App.tsx 使用）
  useEffect(() => {
    const state: GlobalNavigationState = {
      canGoBack: enhancedCanGoBack,
      canGoForward,
      goBack: enhancedGoBack,
      goForward,
    };
    globalNavigationRef.current = state;

    // 触发自定义事件通知 App.tsx
    window.dispatchEvent(new CustomEvent(LEARNING_HUB_NAV_STATE_CHANGED, { detail: state }));
  }, [enhancedCanGoBack, canGoForward, enhancedGoBack, goForward]);

  const value = useMemo<LearningHubNavigationContextValue>(() => ({
    currentFolderId: currentPath.folderId,
    currentFolderPath,
    breadcrumbs,
    setCurrentFolderId,
    navigateTo,
    navigateToBreadcrumb,
    canGoBack: enhancedCanGoBack,
    canGoForward,
    goBack: enhancedGoBack,
    goForward,
    isInLearningHub,
    setIsInLearningHub,
    isNavigationLoading: false,
    hasOpenApp,
    setHasOpenApp,
    closeAppCallback,
    registerCloseAppCallback,
  }), [
    currentPath.folderId,
    currentFolderPath,
    breadcrumbs,
    setCurrentFolderId,
    navigateTo,
    navigateToBreadcrumb,
    enhancedCanGoBack,
    canGoForward,
    enhancedGoBack,
    goForward,
    isInLearningHub,
    hasOpenApp,
    closeAppCallback,
    registerCloseAppCallback,
  ]);

  return (
    <LearningHubNavigationContext.Provider value={value}>
      {children}
    </LearningHubNavigationContext.Provider>
  );
};

export const useLearningHubNavigation = (): LearningHubNavigationContextValue => {
  const context = useContext(LearningHubNavigationContext);
  if (!context) {
    throw new Error('useLearningHubNavigation must be used within a LearningHubNavigationProvider');
  }
  return context;
};

/**
 * 安全版本：如果不在 Provider 内则返回默认值
 */
export const useLearningHubNavigationSafe = (): LearningHubNavigationContextValue | null => {
  return useContext(LearningHubNavigationContext);
};

export default LearningHubNavigationContext;
