/**
 * Learning Hub 文件夹导航历史 Hook
 *
 * 管理文件夹导航的前进/后退历史栈，类似浏览器的导航历史。
 */

import { useRef, useCallback, useState, useEffect, useMemo } from 'react';

interface FolderHistoryEntry {
  /** 文件夹 ID，null 表示根目录 */
  folderId: string | null;
  /** 时间戳 */
  timestamp: number;
}

interface UseFolderNavigationHistoryOptions {
  /** 当前文件夹 ID */
  currentFolderId: string | null;
  /** 文件夹变更回调 */
  onFolderChange: (folderId: string | null) => void;
}

interface UseFolderNavigationHistoryReturn {
  /** 是否可以后退 */
  canGoBack: boolean;
  /** 是否可以前进 */
  canGoForward: boolean;
  /** 后退 */
  goBack: () => void;
  /** 前进 */
  goForward: () => void;
  /** 导航到文件夹（会记录历史） */
  navigateTo: (folderId: string | null) => void;
  /** 清空历史 */
  clear: () => void;
  /** 获取历史栈大小 */
  getHistorySize: () => number;
}

const MAX_HISTORY_LENGTH = 50;

/**
 * 文件夹导航历史 Hook
 */
/**
 * 规范化根目录 folderId
 * 统一 null/'root'/undefined 为 null，避免比较时的语义不一致
 */
const normalizeRootFolderId = (id: string | null | undefined): string | null => {
  if (id === 'root' || id === null || id === undefined) return null;
  return id;
};

export function useFolderNavigationHistory(
  options: UseFolderNavigationHistoryOptions
): UseFolderNavigationHistoryReturn {
  const { currentFolderId, onFolderChange } = options;

  // ★ 2026-01-15: 规范化后的 currentFolderId
  const normalizedCurrentFolderId = useMemo(
    () => normalizeRootFolderId(currentFolderId),
    [currentFolderId]
  );

  // 历史栈
  const historyRef = useRef<FolderHistoryEntry[]>([
    { folderId: null, timestamp: Date.now() }
  ]);

  // 当前索引
  const historyIndexRef = useRef<number>(0);

  // 标记：是否正在通过历史导航（避免重复 push）
  const navigatingRef = useRef<boolean>(false);

  // 防抖：避免短时间内重复点击
  const lastClickRef = useRef<{ action: 'back' | 'forward'; timestamp: number } | null>(null);

  // 强制重渲染以更新按钮禁用态
  const [, forceUpdate] = useState({});

  /**
   * 防抖检查
   */
  const shouldSkipClick = useCallback((action: 'back' | 'forward'): boolean => {
    const last = lastClickRef.current;
    if (!last || last.action !== action) return false;

    const now = Date.now();
    const DEBOUNCE_MS = 200;

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

    if (shouldSkipClick('back')) {
      return;
    }

    const newIndex = historyIndexRef.current - 1;
    const entry = historyRef.current[newIndex];

    if (!entry) return;

    historyIndexRef.current = newIndex;
    navigatingRef.current = true;
    lastClickRef.current = { action: 'back', timestamp: Date.now() };

    onFolderChange(entry.folderId);
    forceUpdate({});

    console.log('[FolderNavigation] 后退:', { folderId: entry.folderId, index: newIndex });
  }, [onFolderChange, shouldSkipClick]);

  /**
   * 前进
   */
  const goForward = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;

    if (shouldSkipClick('forward')) {
      return;
    }

    const newIndex = historyIndexRef.current + 1;
    const entry = historyRef.current[newIndex];

    if (!entry) return;

    historyIndexRef.current = newIndex;
    navigatingRef.current = true;
    lastClickRef.current = { action: 'forward', timestamp: Date.now() };

    onFolderChange(entry.folderId);
    forceUpdate({});

    console.log('[FolderNavigation] 前进:', { folderId: entry.folderId, index: newIndex });
  }, [onFolderChange, shouldSkipClick]);

  /**
   * 导航到文件夹（会记录历史）
   */
  const navigateTo = useCallback((folderId: string | null) => {
    // 避免重复推入相同文件夹（使用规范化比较）
    const current = historyRef.current[historyIndexRef.current];
    const normalizedFolderId = normalizeRootFolderId(folderId);
    const normalizedCurrentFolderId = normalizeRootFolderId(current?.folderId);
    if (normalizedCurrentFolderId === normalizedFolderId) {
      return;
    }

    const newEntry: FolderHistoryEntry = {
      folderId,
      timestamp: Date.now(),
    };

    // 剪裁未来分支并追加
    const trimmed = historyRef.current.slice(0, historyIndexRef.current + 1);
    let updated = [...trimmed, newEntry];

    // 限制历史栈长度
    if (updated.length > MAX_HISTORY_LENGTH) {
      updated = updated.slice(updated.length - MAX_HISTORY_LENGTH);
    }

    historyRef.current = updated;
    historyIndexRef.current = updated.length - 1;

    onFolderChange(folderId);
    forceUpdate({});

    console.log('[FolderNavigation] 导航:', { folderId, index: historyIndexRef.current });
  }, [onFolderChange]);

  /**
   * 清空历史
   */
  const clear = useCallback(() => {
    historyRef.current = [{ folderId: null, timestamp: Date.now() }];
    historyIndexRef.current = 0;
    navigatingRef.current = false;
    lastClickRef.current = null;
    forceUpdate({});
  }, []);

  /**
   * 获取历史栈大小
   */
  const getHistorySize = useCallback(() => {
    return historyRef.current.length;
  }, []);

  /**
   * 监听 currentFolderId 变化（外部变更时同步历史）
   * ★ 2026-01-15: 使用 normalizedCurrentFolderId 作为依赖，避免 null vs 'root' 触发不必要的更新
   */
  useEffect(() => {
    // 如果是通过历史导航触发的变更，跳过
    if (navigatingRef.current) {
      navigatingRef.current = false;
      return;
    }

    // 避免重复写入相同文件夹（使用规范化比较，避免 null vs 'root' 的循环）
    const current = historyRef.current[historyIndexRef.current];
    const normalizedCurrentEntry = normalizeRootFolderId(current?.folderId);
    if (normalizedCurrentEntry === normalizedCurrentFolderId) {
      return;
    }

    const newEntry: FolderHistoryEntry = {
      folderId: currentFolderId,
      timestamp: Date.now(),
    };

    const trimmed = historyRef.current.slice(0, historyIndexRef.current + 1);
    let updated = [...trimmed, newEntry];

    if (updated.length > MAX_HISTORY_LENGTH) {
      updated = updated.slice(updated.length - MAX_HISTORY_LENGTH);
    }

    historyRef.current = updated;
    historyIndexRef.current = updated.length - 1;

    forceUpdate({});
  }, [normalizedCurrentFolderId, currentFolderId]); // ★ 使用规范化后的值作为主要依赖

  const canGoBack = historyIndexRef.current > 0;
  const canGoForward = historyIndexRef.current < historyRef.current.length - 1;

  return {
    canGoBack,
    canGoForward,
    goBack,
    goForward,
    navigateTo,
    clear,
    getHistorySize,
  };
}
