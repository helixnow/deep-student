import { useSyncExternalStore } from 'react';
import { BREAKPOINTS, getMediaQuery } from '@/config/breakpoints';
import { useMediaQuery } from '@/hooks/useMediaQuery';

/** 与 Tailwind `sm` / `BREAKPOINTS.sm` 对齐：视口 < 640px 视为 compact */
export const GENERATIVE_UI_COMPACT_MAX_WIDTH = BREAKPOINTS.sm;

/** `(max-width: 639px)`，与 `getMediaQuery('sm', 'max')` 同源 */
export const GENERATIVE_UI_COMPACT_MEDIA_QUERY = getMediaQuery('sm', 'max');

/** 根节点 compact class：间距走 `generative-ui.css` 的 4/8/12 token */
export const GENERATIVE_UI_COMPACT_CLASS = 'generative-ui-compact';

export function isGenerativeUICompactViewport(
  width: number | undefined,
  mediaMatches: boolean,
): boolean {
  const widthCompact =
    typeof width === 'number' && Number.isFinite(width) && width < GENERATIVE_UI_COMPACT_MAX_WIDTH;
  return mediaMatches || widthCompact;
}

function subscribeViewportWidth(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('resize', onStoreChange);
  return () => window.removeEventListener('resize', onStoreChange);
}

function getViewportWidthSnapshot(): number {
  return typeof window === 'undefined' ? GENERATIVE_UI_COMPACT_MAX_WIDTH : window.innerWidth;
}

/**
 * 窄屏 compact：`window.innerWidth < sm` 或 `matchMedia(max-width: sm-1)` 任一为真。
 * 桌面端保持 false，不改写 v1.1 `sm:grid-cols-*` token。
 */
export function useGenerativeUICompact(): boolean {
  const mediaMatches = useMediaQuery(GENERATIVE_UI_COMPACT_MEDIA_QUERY);
  const width = useSyncExternalStore(
    subscribeViewportWidth,
    getViewportWidthSnapshot,
    () => GENERATIVE_UI_COMPACT_MAX_WIDTH,
  );
  return isGenerativeUICompactViewport(width, mediaMatches);
}
