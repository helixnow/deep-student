import { useMemo } from 'react';
import { useMediaQuery } from './useMediaQuery';
import { BREAKPOINTS } from '@/config/breakpoints';
export type Breakpoint = 'mobile' | 'tablet' | 'laptop' | 'desktop' | 'wide';

/**
 * 响应式断点Hook
 * 提供统一的屏幕尺寸检测能力
 *
 * @example
 * const { isSmallScreen, isTablet, currentBreakpoint } = useBreakpoint();
 *
 * if (isSmallScreen) {
 *   return <MobileLayout />;
 * }
 */
export function useBreakpoint() {
  // 按照从小到大的顺序检测
  const isSm = useMediaQuery(`(min-width: ${BREAKPOINTS.sm}px)`);
  const isMd = useMediaQuery(`(min-width: ${BREAKPOINTS.md}px)`);
  const isLg = useMediaQuery(`(min-width: ${BREAKPOINTS.lg}px)`);
  const isXl = useMediaQuery(`(min-width: ${BREAKPOINTS.xl}px)`);
  const is2Xl = useMediaQuery(`(min-width: ${BREAKPOINTS['2xl']}px)`);

  const result = useMemo(() => {
    // 判断当前处于哪个断点范围
    let currentBreakpoint: Breakpoint = 'mobile';
    if (is2Xl) currentBreakpoint = 'wide';
    else if (isXl) currentBreakpoint = 'desktop';
    else if (isLg) currentBreakpoint = 'laptop';
    else if (isMd) currentBreakpoint = 'tablet';
    else if (isSm) currentBreakpoint = 'mobile';

    return {
      // 具体断点检测
      isSm,
      isMd,
      isLg,
      isXl,
      is2Xl,
      
      // 语义化别名
      // A-6 修复：移除曾经的 isMobile（<640）别名——与 useIsMobile()（<768）同名异义易误用。
      // 判断「是否切移动端布局」请用 isSmallScreen（<768，与 App shell 一致）
      // L-1 修复（2026-07）：isTablet 曾为 640~1024，与 useIsTablet()（768~1280）
      // 同名异义。现统一对齐 useIsTablet 的区间（改动时全仓库无外部消费方）。
      isTablet: isMd && !isXl,  // 768px ~ 1280px，与 useIsTablet() 精确一致
      isLaptop: isLg && !is2Xl, // 1024px ~ 1536px
      isDesktop: isXl,          // >= 1280px
      isWide: is2Xl,            // >= 1536px
      
      // 常用组合判断
      isSmallScreen: !isMd,     // < 768px，常用于切换移动端布局
      isMediumScreen: isMd && !isXl, // 768px ~ 1280px
      isLargeScreen: isXl,      // >= 1280px
      
      // 当前断点
      currentBreakpoint,
      
      // 获取当前宽度范围（估算）
      getApproximateWidth: (): number => {
        if (is2Xl) return 1600;
        if (isXl) return 1400;
        if (isLg) return 1100;
        if (isMd) return 900;
        if (isSm) return 700;
        return 400;
      },
    };
  }, [isSm, isMd, isLg, isXl, is2Xl]);

  return result;
}

/**
 * 简化版：只检测是否为移动端（<768px，与 isSmallScreen / App shell 同源）
 *
 * 实现为 isSmallScreen 同款查询的精确取反（!min-width:768），
 * 而非 max-width:767——后者在缩放产生的小数视口宽度（如 767.5px）下
 * 会与 isSmallScreen 判定不一致，导致布局分支错位。
 */
export function useIsMobile(): boolean {
  return !useMediaQuery(`(min-width: ${BREAKPOINTS.md}px)`);
}

/**
 * 简化版：只检测是否为平板（768px ≤ 宽度 < 1280px，边界与 useBreakpoint 精确互补）
 */
export function useIsTablet(): boolean {
  const isAboveMobile = useMediaQuery(`(min-width: ${BREAKPOINTS.md}px)`);
  const isDesktopUp = useMediaQuery(`(min-width: ${BREAKPOINTS.xl}px)`);
  return isAboveMobile && !isDesktopUp;
}

/**
 * 手机横屏媒体查询：矮 + 横，排除宽矮桌面窗口（> 960px）与平板横屏（> 500px）
 */
export const PHONE_LANDSCAPE_MEDIA_QUERY =
  '(orientation: landscape) and (max-height: 500px) and (max-width: 960px)';

/**
 * 纯函数：判定给定视口宽高是否处于手机横屏自适应区间
 * 与 PHONE_LANDSCAPE_MEDIA_QUERY 严格一致（width > height 且 height <= 500 且 width <= 960）
 */
export function isPhoneLandscapeViewport(width: number, height: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return false;
  }
  return width > height && height <= 500 && width <= 960;
}

/**
 * 检测当前视口是否处于手机横屏紧凑模式
 */
export function usePhoneLandscape(): boolean {
  return useMediaQuery(PHONE_LANDSCAPE_MEDIA_QUERY);
}

export default useBreakpoint;
