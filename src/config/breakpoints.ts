/**
 * 统一断点配置（断点单一来源）
 *
 * 与 `tailwind.config.js` 的 `screens` 一一对应，并与 `useBreakpoint` hooks 共用同一组数值。
 * 注意：`xs`(480) 仅作为 Tailwind 工具类断点（大屏手机双列布局临界点）使用，JS 侧没有对应
 * 的 hook 判定——`isSmallScreen`/`useIsMobile` 以 `md`=768 为界切换移动壳。这里一并收录，
 * 确保两处断点表保持一致，避免“注释声称一致、实则缺项”的偏差。
 */

export const BREAKPOINTS = {
  xs: 480,   // 大屏手机（双列布局临界点）——仅 Tailwind `xs:` 工具类消费，无 JS hook
  sm: 640,   // 手机横屏/小平板
  md: 768,   // 平板竖屏（<768 切换移动端布局壳）
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
 *
 * ⚠️ 注意语义分裂：这里的 `mobile`（0–639，以 sm 为界）只是「屏幕尺寸档位」
 * 的描述性别名，与「是否切换移动端布局壳」不是一回事——切壳判断统一以
 * md=768 为界（useIsMobile / useBreakpoint().isSmallScreen / MOBILE_SHELL.breakpointMax）。
 * 勿用 SCREEN_SIZES.mobile 做切壳判断，否则 640–767 区间会与 App shell 分叉。
 */
export const SCREEN_SIZES = {
  mobile: { min: 0, max: BREAKPOINTS.sm - 1 },      // 0-639px
  tablet: { min: BREAKPOINTS.sm, max: BREAKPOINTS.lg - 1 }, // 640-1023px
  laptop: { min: BREAKPOINTS.lg, max: BREAKPOINTS['2xl'] - 1 }, // 1024-1535px
  desktop: { min: BREAKPOINTS.xl, max: Infinity },   // 1280px+
  wide: { min: BREAKPOINTS['2xl'], max: Infinity },  // 1536px+
} as const;

export type ScreenSize = keyof typeof SCREEN_SIZES;

