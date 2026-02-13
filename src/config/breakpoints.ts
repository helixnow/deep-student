/**
 * 统一断点配置
 * 与Tailwind配置和useBreakpoint hooks保持一致
 */

export const BREAKPOINTS = {
  sm: 640,   // 手机横屏/小平板
  md: 768,   // 平板竖屏
  lg: 1024,  // 平板横屏/小笔记本
  xl: 1280,  // 笔记本
  '2xl': 1536, // 大屏幕
} as const;

export type BreakpointKey = keyof typeof BREAKPOINTS;

/**
 * 获取媒体查询字符串
 */
export const getMediaQuery = (breakpoint: BreakpointKey, type: 'min' | 'max' = 'max'): string => {
  const value = BREAKPOINTS[breakpoint];
  if (type === 'max') {
    return `(max-width: ${value - 1}px)`;
  }
  return `(min-width: ${value}px)`;
};

/**
 * 语义化的屏幕尺寸别名
 */
export const SCREEN_SIZES = {
  mobile: { min: 0, max: BREAKPOINTS.sm - 1 },      // 0-639px
  tablet: { min: BREAKPOINTS.sm, max: BREAKPOINTS.lg - 1 }, // 640-1023px
  laptop: { min: BREAKPOINTS.lg, max: BREAKPOINTS['2xl'] - 1 }, // 1024-1535px
  desktop: { min: BREAKPOINTS.xl, max: Infinity },   // 1280px+
  wide: { min: BREAKPOINTS['2xl'], max: Infinity },  // 1536px+
} as const;

export type ScreenSize = keyof typeof SCREEN_SIZES;

