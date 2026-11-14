/**
 * 移动端布局配置常量
 *
 * 统一管理移动端布局相关的高度、动效时序和羽化间距，确保各组件之间的一致性
 * 使用方：UnifiedMobileHeader, InputBarUI, MobileSlidingLayout, useTextSelection 等
 */

/** 手机横屏紧凑顶栏高度（px） */
export const LANDSCAPE_HEADER_HEIGHT = 40;

/** 顶栏渐进模糊向外延伸的羽化尾迹高度（px） */
export const PROGRESSIVE_BLUR_TAIL_PX = 14;

/** 选词工具栏在滚动停止后的重算显现延迟（ms） */
export const SELECTION_SETTLE_DELAY_MS = 140;

/** 选词拖拽松手后避开原生放大镜的延迟定位时长（ms） */
export const SELECTION_RELEASE_DELAY_MS = 30;

export const MOBILE_LAYOUT = {
  /** 手机横屏紧凑顶栏高度（px） */
  LANDSCAPE_HEADER_HEIGHT,
  /** 顶栏渐进模糊向外延伸羽化尾迹（px） */
  PROGRESSIVE_BLUR_TAIL_PX,
  /** 滚动停稳重算选区延迟（ms） */
  SELECTION_SETTLE_DELAY_MS,
  /** 指针松手后延迟弹出时长（ms） */
  SELECTION_RELEASE_DELAY_MS,

  /** 移动端顶栏配置 */
  mobileHeader: {
    /** 标准高度 */
    height: 56,
    /** 手机横屏紧凑高度 */
    landscapeHeight: LANDSCAPE_HEADER_HEIGHT,
    /** 渐进模糊羽化尾迹高度 */
    progressiveBlurTailPx: PROGRESSIVE_BLUR_TAIL_PX,
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
