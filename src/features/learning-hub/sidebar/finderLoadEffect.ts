import type React from 'react';
import { pageLifecycleTracker } from '@/debug-panel/hooks/usePageLifecycle';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import type { FinderPath, FinderStoreApi } from '../stores/finderStore';
import type { LearningHubSidebarProps } from '../types';

export interface FinderLoadEffectContext {
  mode: LearningHubSidebarProps['mode'];
  sessionActive: boolean | undefined;
  searchQuery: string;
  debouncedSearchQuery: string;
  currentPath: Pick<FinderPath, 'viewKind' | 'folderId' | 'typeFilter'>;
  lastLoadSignatureRef: React.MutableRefObject<string | null>;
  currentPathDisplay: string;
  finderRefresh: (opts?: { silent?: boolean }) => Promise<void>;
  isMountedRef: React.MutableRefObject<boolean>;
  finderStore: FinderStoreApi;
}

// Load items when path changes
// ★ 使用 debouncedSearchQuery 触发搜索，避免快速输入导致频繁 API 调用
// ★ LH-HOST：sessionActive===false 时跳过（非活跃宿主不抢刷新）
// ★ 2026-07-21：同路径因窗口焦点恢复（sessionActive false→true）时走静默刷新；
//   store 侧若列表等价会跳过 items 写入，避免关闭预览后整表闪烁重绘。
export function runFinderLoadEffect({
  mode,
  sessionActive,
  searchQuery,
  debouncedSearchQuery,
  currentPath,
  lastLoadSignatureRef,
  currentPathDisplay,
  finderRefresh,
  isMountedRef,
  finderStore,
}: FinderLoadEffectContext): (() => void) | undefined {
  if (mode === 'canvas' || sessionActive === false) return;

  let isCancelled = false;

  const loadData = async () => {
    if (searchQuery.trim() && debouncedSearchQuery !== searchQuery) {
      return;
    }

    const signature = [
      currentPath.viewKind,
      currentPath.folderId ?? '',
      currentPath.typeFilter ?? '',
      debouncedSearchQuery,
    ].join('\0');
    const silent = lastLoadSignatureRef.current === signature;

    const start = Date.now();
    pageLifecycleTracker.log(
      'learning-hub-sidebar',
      'LearningHubSidebar',
      'data_load',
      `path: ${currentPathDisplay}${silent ? ' (silent)' : ''}`,
    );

    try {
      await finderRefresh(silent ? { silent: true } : undefined);
      if (!isCancelled && isMountedRef.current) {
        lastLoadSignatureRef.current = signature;
        pageLifecycleTracker.log(
          'learning-hub-sidebar',
          'LearningHubSidebar',
          'data_ready',
          `${finderStore.getState().items.length} items`,
          { duration: Date.now() - start }
        );
      }
    } catch (err) {
      if (!isCancelled && isMountedRef.current) {
        debugLog.error('Unexpected error loading items:', err);
      }
    }
  };

  void loadData();
  return () => {
    isCancelled = true;
  };
}
