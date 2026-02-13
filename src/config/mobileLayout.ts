/**
 * 移动端布局配置常量
 *
 * 统一管理移动端布局相关的高度和间距，确保各组件之间的一致性
 * 使用方：BottomTabBar, InputBarUI, MobileSlidingLayout 等
 */

export const MOBILE_LAYOUT = {
  /** 底部导航栏配置 */
  bottomTabBar: {
    /** 显示标签时的高度 */
    heightWithLabels: 56,
    /** 不显示标签时的高度 */
    heightWithoutLabels: 48,
    /** 默认高度（使用显示标签的高度） */
    defaultHeight: 56,
  },

  /** 移动端顶栏配置 */
  mobileHeader: {
    /** 标准高度 */
    height: 56,
  },

  /** 输入栏配置 */
  inputBar: {
    /** 首帧占位高度 */
    placeholderHeight: 112,
    /** ResizeObserver 高度变化阈值 */
    heightChangeThreshold: 4,
  },
} as const;

/** 获取底部导航栏高度（根据是否显示标签） */
export function getBottomTabBarHeight(showLabels: boolean = true): number {
  return showLabels
    ? MOBILE_LAYOUT.bottomTabBar.heightWithLabels
    : MOBILE_LAYOUT.bottomTabBar.heightWithoutLabels;
}

export default MOBILE_LAYOUT;
