import { useMemo } from 'react';
import { useMediaQuery } from './useMediaQuery';
import { BREAKPOINTS } from '@/config/breakpoints';
export type Breakpoint = 'mobile' | 'tablet' | 'laptop' | 'desktop' | 'wide';

/**
 * 响应式断点Hook
 * 提供统一的屏幕尺寸检测能力
 * 
 * @example
 * const { isMobile, isTablet, currentBreakpoint } = useBreakpoint();
 * 
 * if (isMobile) {
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
      // ⚠️ A-6: 此 isMobile 为 <640px，与 useIsMobile()（<768px）同名异义！
      // 判断「是否切移动端布局」请用 isSmallScreen（<768，与 App shell 一致）
      isMobile: !isSm,          // < 640px
      isTablet: isSm && !isLg,  // 640px ~ 1024px
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
 * 简化版：只检测是否为移动端
 *
 * ⚠️ A-6: 此处为 <768px（= isSmallScreen），与 useBreakpoint().isMobile（<640px）
 * 同名异义。切移动端布局用本 hook 或 isSmallScreen，勿混用。
 */
export function useIsMobile(): boolean {
  return useMediaQuery(`(max-width: ${BREAKPOINTS.md - 1}px)`);
}

/**
 * 简化版：只检测是否为平板
 */
export function useIsTablet(): boolean {
  const isAboveMobile = useMediaQuery(`(min-width: ${BREAKPOINTS.md}px)`);
  const isBelowDesktop = useMediaQuery(`(max-width: ${BREAKPOINTS.xl - 1}px)`);
  return isAboveMobile && isBelowDesktop;
}

export default useBreakpoint;
