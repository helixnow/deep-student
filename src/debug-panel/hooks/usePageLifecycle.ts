/**
 * usePageLifecycle - 页面生命周期监控 Hook
 * 
 * 在页面组件中使用此 Hook 可自动追踪挂载/卸载/显示/隐藏状态。
 * 
 * @example
 * ```tsx
 * const MyPage = () => {
 *   usePageLifecycle('my-page', 'MyPage', isVisible);
 *   // ...
 * };
 * ```
 */

import { useEffect, useRef } from 'react';
import { pageLifecycleTracker, type PageLifecycleEvent } from '../services/pageLifecycleTracker';

interface UsePageLifecycleOptions {
  /** 是否捕获调用栈（用于调试，默认 false） */
  captureStack?: boolean;
  /** 是否跳过初始 show 事件（避免挂载时重复日志，默认 true） */
  skipInitialShow?: boolean;
}

/**
 * 页面生命周期监控 Hook
 * 
 * @param pageId - 页面唯一标识（如 'learning-hub', 'chat-v2'）
 * @param pageName - 页面显示名称（如 '学习资源', '聊天'）
 * @param isVisible - 页面当前是否可见（通常通过 currentView === 'xxx' 判断）
 * @param options - 可选配置
 */
export function usePageLifecycle(
  pageId: string,
  pageName: string,
  isVisible: boolean,
  options?: UsePageLifecycleOptions
): {
  log: (event: PageLifecycleEvent, detail?: string, duration?: number) => void;
} {
  const { captureStack = false, skipInitialShow = true } = options || {};
  const mountedRef = useRef(false);
  const wasVisibleRef = useRef(isVisible);
  const initialShowSkippedRef = useRef(false);

  // 挂载/卸载追踪
  useEffect(() => {
    pageLifecycleTracker.log(pageId, pageName, 'mount', undefined, { captureStack });
    mountedRef.current = true;
    
    return () => {
      pageLifecycleTracker.log(pageId, pageName, 'unmount', undefined, { captureStack });
      mountedRef.current = false;
    };
  }, [pageId, pageName, captureStack]);

  // 显示/隐藏追踪
  useEffect(() => {
    if (!mountedRef.current) return;
    
    // 跳过初始 show（因为挂载时已经记录了 mount）
    if (skipInitialShow && !initialShowSkippedRef.current && isVisible) {
      initialShowSkippedRef.current = true;
      wasVisibleRef.current = isVisible;
      return;
    }
    
    if (isVisible !== wasVisibleRef.current) {
      wasVisibleRef.current = isVisible;
      pageLifecycleTracker.log(
        pageId, 
        pageName, 
        isVisible ? 'show' : 'hide',
        undefined,
        { captureStack }
      );
    }
  }, [pageId, pageName, isVisible, captureStack, skipInitialShow]);

  // 提供手动记录日志的方法
  const log = (event: PageLifecycleEvent, detail?: string, duration?: number) => {
    pageLifecycleTracker.log(pageId, pageName, event, detail, { duration, captureStack });
  };

  return { log };
}

/**
 * 简化版：仅追踪挂载/卸载，用于没有 isVisible 的场景
 */
export function usePageMount(pageId: string, pageName: string) {
  useEffect(() => {
    pageLifecycleTracker.log(pageId, pageName, 'mount');
    return () => {
      pageLifecycleTracker.log(pageId, pageName, 'unmount');
    };
  }, [pageId, pageName]);
}

export { pageLifecycleTracker };
