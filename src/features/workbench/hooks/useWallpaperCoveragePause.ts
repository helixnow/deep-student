/**
 * 壁纸流动层让路：最大化/全遮挡或页面隐藏时挂 data-wb-wallpaper-covered，
 * CSS 暂停 .wb-wallpaper-flow（拖拽另有 data-wb-dragging）。
 */
import { useEffect } from 'react';
import { useWindowStore } from '../core/windowStore';
import { getSortedWindows } from '../core/windowListCache';

const ATTR = 'data-wb-wallpaper-covered';

function isDesktopCovered(): boolean {
  const wins = getSortedWindows(useWindowStore.getState().windows);
  return wins.some(
    (w) =>
      !w.minimized &&
      (w.displayMode === 'maximized' ||
        (w.displayMode === 'tiled-left' &&
          wins.some((o) => !o.minimized && o.displayMode === 'tiled-right' && o.id !== w.id))),
  );
}

function syncAttr(): void {
  if (typeof document === 'undefined') return;
  const covered =
    document.visibilityState === 'hidden' || isDesktopCovered();
  if (covered) document.documentElement.setAttribute(ATTR, '');
  else document.documentElement.removeAttribute(ATTR);
}

/** 挂在 Desktop：订阅窗口集合变化 + visibilitychange */
export function useWallpaperCoveragePause(): void {
  useEffect(() => {
    syncAttr();
    const unsub = useWindowStore.subscribe((state, prev) => {
      if (state.windows === prev.windows) return;
      syncAttr();
    });
    const onVis = () => syncAttr();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      unsub();
      document.removeEventListener('visibilitychange', onVis);
      document.documentElement.removeAttribute(ATTR);
    };
  }, []);
}
