import type React from 'react';
import { dstu } from '@/dstu';
import type { LearningHubSidebarProps } from '../types';

// ★ 快捷访问「收藏」徽标：接真数据（此前硬编码 0 是假徽标）。
// 挂载时查询一次，之后跟随 DSTU 资源变化事件（收藏切换会发 updated）防抖刷新。
// canvas 宿主不渲染快捷访问栏，跳过查询。
export function subscribeFavoriteCount({
  mode,
  sessionActive,
  isMountedRef,
  setFavoriteCount,
}: {
  mode: LearningHubSidebarProps['mode'];
  sessionActive: boolean | undefined;
  isMountedRef: React.MutableRefObject<boolean>;
  setFavoriteCount: React.Dispatch<React.SetStateAction<number | undefined>>;
}): (() => void) | undefined {
  if (mode === 'canvas' || sessionActive === false) return;

  let cancelled = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const fetchFavoriteCount = async () => {
    const result = await dstu.list('/', { isFavorite: true });
    if (cancelled || !isMountedRef.current) return;
    if (result.ok) {
      setFavoriteCount(result.value.length);
    }
  };

  void fetchFavoriteCount();

  const unwatch = dstu.watch('*', (event) => {
    if (
      event.type === 'created' ||
      event.type === 'updated' ||
      event.type === 'deleted' ||
      event.type === 'moved' ||
      event.type === 'restored' ||
      event.type === 'purged'
    ) {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void fetchFavoriteCount();
      }, 800);
    }
  });

  return () => {
    cancelled = true;
    unwatch();
    if (debounceTimer) clearTimeout(debounceTimer);
  };
}
