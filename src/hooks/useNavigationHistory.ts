import { useRef, useCallback, useState, useEffect, useMemo, startTransition } from 'react';
import type { CurrentView, NavigationHistoryEntry } from '../types/navigation';
import { SKIP_IN_HISTORY, MAX_HISTORY_LENGTH } from '../types/navigation';
import { debugLog } from '../debug-panel/debugMasterSwitch';
import i18n from '@/i18n';
import { showGlobalNotification } from '@/components/UnifiedNotification';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

interface UseNavigationHistoryOptions {
  /** 当前视图 */
  currentView: CurrentView;
  /** 视图变更回调 */
  onViewChange: (view: CurrentView, params?: Record<string, any>) => void;
  /** 当前视图参数（可选） */
  currentParams?: Record<string, any>;
}

interface UseNavigationHistoryReturn {
  /** 是否可以后退 */
  canGoBack: boolean;
  /** 是否可以前进 */
  canGoForward: boolean;
  /** 后退 */
  goBack: () => void;
  /** 前进 */
  goForward: () => void;
  /** 推入新的历史项（支持替换模式） */
  push: (view: CurrentView, params?: Record<string, any>, restore?: () => void | Promise<void>, replace?: boolean) => void;
  /** 清空历史 */
  clear: () => void;
  /** 获取历史栈大小 */
  getHistorySize: () => number;
}

/**
 * 导航历史管理 Hook
 * 支持参数化历史、状态恢复、中转页过滤、防抖优化
 */
export function useNavigationHistory(options: UseNavigationHistoryOptions): UseNavigationHistoryReturn {
  const { currentView, onViewChange, currentParams } = options;

  // 历史栈 - 初始视图设为 'chat-v2'，避免首次后退落到空页面
  const historyRef = useRef<NavigationHistoryEntry[]>([
    { view: 'chat-v2', timestamp: Date.now() }
  ]);
  
  // 当前索引
  const historyIndexRef = useRef<number>(0);
  
  // 标记：是否正在通过历史导航（避免重复 push）
  const navigatingRef = useRef<boolean>(false);
  
  // 防抖：避免短时间内重复点击同一个按钮
  const lastClickRef = useRef<{ action: 'back' | 'forward'; timestamp: number } | null>(null);
  
  // 强制重渲染以更新按钮禁用态
  const [, forceUpdate] = useState({});

  // 避免重复 push：视图参数深比较（适用于小型对象）
  const areParamsEqual = useCallback((a?: Record<string, any>, b?: Record<string, any>) => {
    if (a === b) return true;
    if (!a && !b) return true;
    if (!a || !b) return false;
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }, []);

  /**
   * 防抖检查：避免短时间内重复点击同一个导航按钮
   */
  const shouldSkipClick = useCallback((action: 'back' | 'forward'): boolean => {
    const last = lastClickRef.current;
    if (!last || last.action !== action) return false;
    
    const now = Date.now();
    const DEBOUNCE_MS = 200; // 降低到200ms，更灵敏
    
    if (now - last.timestamp < DEBOUNCE_MS) {
      return true;
    }
    
    return false;
  }, []);

  /**
   * 后退
   */
  const goBack = useCallback(() => {
    if (historyIndexRef.current <= 0) return;
    
    // 防抖：避免重复点击
    if (shouldSkipClick('back')) {
      console.log('[NavigationHistory] 跳过防抖期内的重复后退点击');
      return;
    }
    
    const newIndex = historyIndexRef.current - 1;
    const entry = historyRef.current[newIndex];
    
    if (!entry) return;
    
    historyIndexRef.current = newIndex;
    navigatingRef.current = true;
    lastClickRef.current = { action: 'back', timestamp: Date.now() };
    
    // 恢复状态
    if (entry.restore) {
      try {
        const result = entry.restore();
        if (result instanceof Promise) {
          result.catch(err => {
            debugLog.error('[NavigationHistory] State restore failed:', err);
            showGlobalNotification('warning', i18n.t('common:navigation.restoreFailed', 'Page state could not be restored'));
          });
        }
      } catch (err: unknown) {
        debugLog.error('[NavigationHistory] State restore failed:', err);
        showGlobalNotification('warning', i18n.t('common:navigation.restoreFailed', 'Page state could not be restored'));
      }
    }
    
    // 触发视图变更（onViewChange → setCurrentView → startTransition 内的 push 会处理状态更新）
    onViewChange(entry.view, entry.params);
    
    console.log('[NavigationHistory] 后退:', { view: entry.view, index: newIndex, total: historyRef.current.length });
  }, [onViewChange, shouldSkipClick]);

  /**
   * 前进
   */
  const goForward = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    
    // 防抖：避免重复点击
    if (shouldSkipClick('forward')) {
      console.log('[NavigationHistory] 跳过防抖期内的重复前进点击');
      return;
    }
    
    const newIndex = historyIndexRef.current + 1;
    const entry = historyRef.current[newIndex];
    
    if (!entry) return;
    
    historyIndexRef.current = newIndex;
    navigatingRef.current = true;
    lastClickRef.current = { action: 'forward', timestamp: Date.now() };
    
    // 恢复状态
    if (entry.restore) {
      try {
        const result = entry.restore();
        if (result instanceof Promise) {
          result.catch(err => {
            debugLog.error('[NavigationHistory] State restore failed:', err);
            showGlobalNotification('warning', i18n.t('common:navigation.restoreFailed', 'Page state could not be restored'));
          });
        }
      } catch (err: unknown) {
        debugLog.error('[NavigationHistory] State restore failed:', err);
        showGlobalNotification('warning', i18n.t('common:navigation.restoreFailed', 'Page state could not be restored'));
      }
    }
    
    // 触发视图变更（onViewChange → setCurrentView → startTransition 内的 push 会处理状态更新）
    onViewChange(entry.view, entry.params);
    
    console.log('[NavigationHistory] 前进:', { view: entry.view, index: newIndex, total: historyRef.current.length });
  }, [onViewChange, shouldSkipClick]);

  /**
   * 推入新的历史项
   * @param view 视图
   * @param params 参数
   * @param restore 状态恢复函数
   * @param replace 是否替换当前项（用于中转页）
   */
  const push = useCallback((
    view: CurrentView,
    params?: Record<string, any>,
    restore?: () => void | Promise<void>,
    replace: boolean = false
  ) => {
    // 跳过中转视图
    if (SKIP_IN_HISTORY.has(view)) {
      console.log('[NavigationHistory] 跳过中转视图:', view);
      return;
    }
    
    // 避免重复写入相同视图（视图+参数均相同时跳过）
    const current = historyRef.current[historyIndexRef.current];
    if (current && current.view === view && areParamsEqual(current.params as any, params as any) && !replace) {
      return;
    }
    
    const newEntry: NavigationHistoryEntry = {
      view,
      params,
      restore,
      timestamp: Date.now(),
    };
    
    if (replace && historyIndexRef.current >= 0) {
      // 替换模式：替换当前项
      historyRef.current[historyIndexRef.current] = newEntry;
      console.log('[NavigationHistory] 替换当前项:', { view, index: historyIndexRef.current });
    } else {
      // 正常模式：剪裁未来分支并追加
      const trimmed = historyRef.current.slice(0, historyIndexRef.current + 1);
      let updated = [...trimmed, newEntry];
      
      // 限制历史栈长度
      if (updated.length > MAX_HISTORY_LENGTH) {
        updated = updated.slice(updated.length - MAX_HISTORY_LENGTH);
      }
      
      historyRef.current = updated;
      historyIndexRef.current = updated.length - 1;
      
      console.log('[NavigationHistory] 推入新项:', { view, index: historyIndexRef.current, total: updated.length });
    }
    
    forceUpdate({});
  }, []);

  /**
   * 清空历史
   */
  const clear = useCallback(() => {
    historyRef.current = [{ view: 'chat-v2', timestamp: Date.now() }];
    historyIndexRef.current = 0;
    navigatingRef.current = false;
    lastClickRef.current = null;
    forceUpdate({});
    console.log('[NavigationHistory] 清空历史');
  }, []);

  /**
   * 获取历史栈大小
   */
  const getHistorySize = useCallback(() => {
    return historyRef.current.length;
  }, []);

  /**
   * 监听 currentView 变化，自动 push
   */
  useEffect(() => {
    // 如果是通过历史导航触发的变更，跳过
    if (navigatingRef.current) {
      navigatingRef.current = false;
      return;
    }
    
    // 跳过中转视图
    if (SKIP_IN_HISTORY.has(currentView)) {
      console.log('[NavigationHistory] 跳过中转视图:', currentView);
      return;
    }
    
    // 避免重复写入相同视图（视图+参数均相同时跳过）
    const current = historyRef.current[historyIndexRef.current];
    if (current && current.view === currentView && areParamsEqual(current.params as any, currentParams as any)) {
      return;
    }
    
    const newEntry: NavigationHistoryEntry = {
      view: currentView,
      params: currentParams,
      restore: undefined,
      timestamp: Date.now(),
    };
    
    // 正常模式：剪裁未来分支并追加
    const trimmed = historyRef.current.slice(0, historyIndexRef.current + 1);
    let updated = [...trimmed, newEntry];
    
    // 限制历史栈长度
    if (updated.length > MAX_HISTORY_LENGTH) {
      updated = updated.slice(updated.length - MAX_HISTORY_LENGTH);
    }
    
    historyRef.current = updated;
    historyIndexRef.current = updated.length - 1;
    
    console.log('[NavigationHistory] 推入新项:', { view: currentView, index: historyIndexRef.current, total: updated.length });
    
    // 🚀 低优先级重渲染：更新 canGoBack/canGoForward，不阻塞视图切换的 transition 渲染
    startTransition(() => forceUpdate({}));
  }, [currentView, currentParams, areParamsEqual]); // ✅ 移除 push 依赖

  // ✅ 使用状态变量确保响应式
  const canGoBack = historyIndexRef.current > 0;
  const canGoForward = historyIndexRef.current < historyRef.current.length - 1;

  return useMemo(() => ({
    canGoBack,
    canGoForward,
    goBack,
    goForward,
    push,
    clear,
    getHistorySize,
  }), [canGoBack, canGoForward, goBack, goForward, push, clear, getHistorySize]);
}

