/**
 * useFilesViewTransition — 资源库列表/网格切换过渡（O17）
 *
 * 只读订阅 finderStore.viewMode；切换时在宿主视口上打 data 属性触发
 * CSS 动画（仅 opacity）。不改 legacy finder 组件。
 *
 * reduced-motion / minimal 材质档由 FilesAppWindow.css 降级为无动画。
 */
import { useEffect, useRef } from 'react';
import { useFinderStore, type ViewMode } from '@/features/learning-hub/stores/finderStore';

const ATTR = 'data-wb-files-view-transition';
const CLEAR_MS = 180;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function isMinimalMaterial(): boolean {
  try {
    return document.documentElement.getAttribute('data-wb-material') === 'minimal';
  } catch {
    return false;
  }
}

/**
 * @param viewportRef 列表/网格内容宿主（打过渡 data 属性）
 * @param enabled 缺省 true；窗口休眠时可关
 */
export function useFilesViewTransition(
  viewportRef: { readonly current: HTMLElement | null },
  enabled = true,
): void {
  const viewMode = useFinderStore((s) => s.viewMode);
  const prevModeRef = useRef<ViewMode | null>(null);
  const clearTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const el = viewportRef.current;
    if (!el) return;

    const prev = prevModeRef.current;
    prevModeRef.current = viewMode;
    if (prev === null || prev === viewMode) return;
    if (prefersReducedMotion() || isMinimalMaterial()) return;

    if (clearTimerRef.current !== null) {
      window.clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }

    // grid↔list：只做极轻的透明度过渡，避免内容产生缩放/呼吸感。
    el.removeAttribute(ATTR);
    // 强制重启动画（同属性再设时部分引擎不重播）
    void el.offsetWidth;
    el.setAttribute(ATTR, 'fade');

    clearTimerRef.current = window.setTimeout(() => {
      clearTimerRef.current = null;
      el.removeAttribute(ATTR);
    }, CLEAR_MS);

    return () => {
      if (clearTimerRef.current !== null) {
        window.clearTimeout(clearTimerRef.current);
        clearTimerRef.current = null;
      }
      el.removeAttribute(ATTR);
    };
  }, [enabled, viewMode, viewportRef]);
}
