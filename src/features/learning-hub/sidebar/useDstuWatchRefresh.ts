import { useEffect, useRef } from 'react';
import { dstu } from '@/dstu';
import type { FinderPath, FinderStoreApi } from '../stores/finderStore';
import type { LearningHubSidebarProps } from '../types';

export function useDstuWatchRefresh({
  sessionActive,
  currentPath,
  handleSilentRefresh,
  mode,
  finderStore,
}: {
  sessionActive: boolean | undefined;
  currentPath: FinderPath;
  handleSilentRefresh: () => Promise<void>;
  mode: LearningHubSidebarProps['mode'];
  finderStore: FinderStoreApi;
}) {
  // ★ 监听 DSTU 资源变化，自动刷新列表（带防抖，避免批量操作时频繁刷新）
  const watchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (sessionActive === false) {
      if (watchDebounceRef.current) {
        clearTimeout(watchDebounceRef.current);
        watchDebounceRef.current = null;
      }
      return;
    }
    if (currentPath.viewKind === 'indexStatus' || currentPath.viewKind === 'memory' || currentPath.viewKind === 'desktop') {
      return;
    }

    const unwatch = dstu.watch('*', (event) => {
      if (
        event.type === 'created' ||
        event.type === 'updated' ||
        event.type === 'deleted' ||
        event.type === 'moved' ||
        event.type === 'restored' ||
        event.type === 'purged'
      ) {
        // 防抖：300ms 内多次事件只触发一次刷新
        if (watchDebounceRef.current) {
          clearTimeout(watchDebounceRef.current);
        }
        watchDebounceRef.current = setTimeout(() => {
          watchDebounceRef.current = null;
          // R2-04：内联重命名进行中延迟 silent refresh（非永久跳过），避免丢 agent 变更
          const trySilentRefresh = () => {
            // canvas 宿主有独立列表；勿被全局 fullscreen 的 inlineEdit 卡住刷新
            if (mode !== 'canvas' && finderStore.getState().inlineEdit.editingId) {
              watchDebounceRef.current = setTimeout(() => {
                watchDebounceRef.current = null;
                trySilentRefresh();
              }, 400);
              return;
            }
            handleSilentRefresh();
          };
          trySilentRefresh();
        }, 300);
      }
    });

    return () => {
      unwatch();
      if (watchDebounceRef.current) {
        clearTimeout(watchDebounceRef.current);
        watchDebounceRef.current = null;
      }
    };
  }, [sessionActive, currentPath.viewKind, handleSilentRefresh, mode, finderStore]);
}
