import { useMediaQuery } from '@/hooks/useMediaQuery';

/** 与 CSS `@media (prefers-reduced-motion: reduce)` 同源 */
export const PREFERS_REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * 系统 prefers-reduced-motion。首帧走 matchMedia 快照（useMediaQuery），
 * 供根节点 `data-reduced-motion` 与流式指示 / 进度过渡降级。
 */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery(PREFERS_REDUCED_MOTION_QUERY);
}
