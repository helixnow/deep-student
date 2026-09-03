import { useMediaQuery } from '@/hooks/useMediaQuery';

/** 与 CSS `@media (prefers-contrast: more)` 同源 */
export const PREFERS_CONTRAST_QUERY = '(prefers-contrast: more)';

/**
 * 系统 prefers-contrast。首帧走 matchMedia 快照（useMediaQuery），
 * 供根节点 `data-contrast` 与高对比边框。
 */
export function usePrefersContrast(): boolean {
  return useMediaQuery(PREFERS_CONTRAST_QUERY);
}
