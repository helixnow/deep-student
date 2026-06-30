/**
 * 移动端布局配置常量
 *
 * 统一管理移动端布局相关的高度和间距，确保各组件之间的一致性
 * 使用方：InputBarUI, MobileSlidingLayout 等
 */

export const MOBILE_LAYOUT = {
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

export default MOBILE_LAYOUT;
