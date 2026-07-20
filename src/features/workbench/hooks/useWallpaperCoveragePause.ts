/**
 * 壁纸流动层让路：桌面被大面积遮挡或页面隐藏时挂 data-wb-wallpaper-covered，
 * CSS 暂停 .wb-wallpaper-flow（拖拽另有 data-wb-dragging）。
 */
import { useEffect } from 'react';
import { useWindowStore } from '../core/windowStore';
import { getSortedWindows } from '../core/windowListCache';
import { computeDesktopCoveredRatio } from '../core/occlusion';
import type { Size, WorkbenchWindow } from '../core/types';

const ATTR = 'data-wb-wallpaper-covered';

/** 可见浮动窗覆盖桌面面积超过此比例即视为「基本被遮」，流动壁纸可停 */
const FLOATING_COVERAGE_PAUSE_RATIO = 0.72;

/**
 * 多窗矩形并集覆盖桌面 ≥ 此比例即视为「几乎全遮」，流动壁纸可停。
 * 单窗 0.72 近似的残余是贴边 L 条带；并集路径的残余（窗缝）可能落在
 * 桌面中央，光斑冻结更易被察觉，故取近全遮阈值。不取 1.0：窗口 18px
 * 圆角与亚像素取整会在角落漏光，纯矩形并集覆盖到不了 1。
 */
const UNION_COVERAGE_PAUSE_RATIO = 0.98;

/** 与 scheduler 对齐的交互式 resize 防抖（desktopSize 逐帧变化时禁止逐帧算并集） */
const DESKTOP_SIZE_SYNC_DEBOUNCE_MS = 160;

/** 纯判定（导出供单测）：窗口集合是否把桌面遮到「流动壁纸可停」 */
export function isDesktopCoveredByWindows(
  wins: WorkbenchWindow[],
  desktopSize: Size,
): boolean {
  // 强遮挡（快速路径）：最大化 / 左右满铺
  if (
    wins.some(
      (w) =>
        !w.minimized &&
        (w.displayMode === 'maximized' ||
          (w.displayMode === 'tiled-left' &&
            wins.some((o) => !o.minimized && o.displayMode === 'tiled-right' && o.id !== w.id))),
    )
  ) {
    return true;
  }
  // 弱遮挡（快速路径）：大浮动窗覆盖大部分桌面时流动壁纸几乎不可见，白耗合成帧。
  // 用「最大单窗面积 / 桌面面积」近似（既有语义保持不变）。
  const { w: dw, h: dh } = desktopSize;
  const desktopArea = dw * dh;
  if (desktopArea <= 0) return false;
  let maxArea = 0;
  for (const win of wins) {
    if (win.minimized) continue;
    const area = win.frame.w * win.frame.h;
    if (area > maxArea) maxArea = area;
  }
  if (maxArea / desktopArea >= FLOATING_COVERAGE_PAUSE_RATIO) return true;
  // 并集遮挡：多窗拼满桌面（各窗单独不足 0.72）时壁纸同样整屏白耗合成。
  // 复用 occlusion 的矩形减法求精确覆盖比例；仅在窗口几何/z 序提交时调用。
  return computeDesktopCoveredRatio(wins, desktopSize) >= UNION_COVERAGE_PAUSE_RATIO;
}

function syncAttr(): void {
  if (typeof document === 'undefined') return;
  const state = useWindowStore.getState();
  const covered =
    document.visibilityState === 'hidden' ||
    isDesktopCoveredByWindows(getSortedWindows(state.windows), state.desktopSize);
  if (covered) document.documentElement.setAttribute(ATTR, '');
  else document.documentElement.removeAttribute(ATTR);
}

/** 挂在 Desktop：订阅窗口集合 / 桌面尺寸变化 + visibilitychange */
export function useWallpaperCoveragePause(): void {
  useEffect(() => {
    syncAttr();

    // 一帧合并：窗口几何/z 序只在手势提交时写 store，rAF 把同帧多次
    // set（如关窗 + 焦点重排）合并成一次并集计算，绝不逐帧算；
    // 拖拽中间态由 data-wb-dragging 暂停壁纸，无需在此计算。
    let rafId: ReturnType<typeof requestAnimationFrame> | 0 = 0;
    const scheduleSync = () => {
      if (rafId) return;
      if (typeof requestAnimationFrame === 'function') {
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          syncAttr();
        });
      } else {
        syncAttr();
      }
    };
    // 交互式 resize 期间 desktopSize 逐帧更新 → 拖尾防抖（与 scheduler 一致）
    let resizeTimer: ReturnType<typeof setTimeout> | 0 = 0;
    const unsub = useWindowStore.subscribe((state, prev) => {
      if (state.windows !== prev.windows) {
        scheduleSync();
        return;
      }
      if (state.desktopSize !== prev.desktopSize) {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          resizeTimer = 0;
          scheduleSync();
        }, DESKTOP_SIZE_SYNC_DEBOUNCE_MS);
      }
    });
    const onVis = () => syncAttr();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      unsub();
      if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
      if (resizeTimer) clearTimeout(resizeTimer);
      document.removeEventListener('visibilitychange', onVis);
      document.documentElement.removeAttribute(ATTR);
    };
  }, []);
}
