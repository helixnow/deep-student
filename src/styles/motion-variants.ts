/**
 * Notion 化动画配置 - 统一的 Framer Motion Variants
 *
 * 参考 deep-agent_new 的设计系统，提供统一的动画体验
 */

import type { Variants, Transition } from 'framer-motion';

// ============================================================================
// Spring 物理动画配置
// ============================================================================

/**
 * Spring 动画配置预设
 */
export const springConfig = {
  /** 默认弹簧配置：平衡的弹性和阻尼 */
  default: { type: 'spring' as const, stiffness: 400, damping: 30 },
  /** 柔和弹簧：较慢的动画，适合大面积元素 */
  gentle: { type: 'spring' as const, stiffness: 300, damping: 25 },
  /** 快速弹簧：响应灵敏，适合小元素交互 */
  snappy: { type: 'spring' as const, stiffness: 500, damping: 35 },
  /** 回弹效果：有明显的回弹，适合强调元素 */
  bouncy: { type: 'spring' as const, stiffness: 400, damping: 20 },
  /** 平滑过渡：无回弹，适合列表项 */
  smooth: { type: 'spring' as const, stiffness: 300, damping: 30 },
} as const;

/**
 * 时间配置预设
 */
export const durationConfig = {
  fast: 0.1,
  normal: 0.2,
  slow: 0.3,
  emphasis: 0.4,
} as const;

/**
 * 缓动曲线预设
 */
export const easingConfig = {
  easeOut: [0.4, 0, 0.2, 1] as [number, number, number, number],
  easeOutExpo: [0.16, 1, 0.3, 1] as [number, number, number, number],
  easeOutBack: [0.34, 1.3, 0.64, 1] as [number, number, number, number],
  spring: [0.34, 1.56, 0.64, 1] as [number, number, number, number],
} as const;

// ============================================================================
// 容器级联动画 Variants
// ============================================================================

/**
 * 容器级联动画 - 子元素依次进入
 */
export const containerVariants: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.06,
      delayChildren: 0.1,
    },
  },
};

/**
 * 快速容器级联 - 更密集的子元素动画
 */
export const containerFastVariants: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.03,
      delayChildren: 0.05,
    },
  },
};

/**
 * 网格容器变体 - 适合卡片网格布局
 */
export const gridContainerVariants: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.05,
      delayChildren: 0.08,
    },
  },
};

// ============================================================================
// 卡片/项目动画 Variants
// ============================================================================

/**
 * 卡片入场动画 - 从下方淡入
 */
export const cardVariants: Variants = {
  hidden: { opacity: 0, y: 20, scale: 0.95 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: springConfig.default,
  },
};

/**
 * 列表项入场动画 - 较小的位移
 */
export const itemVariants: Variants = {
  hidden: { opacity: 0, y: 8, scale: 0.98 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: springConfig.default,
  },
};

/**
 * 图表入场动画 - 缩放淡入
 */
export const chartVariants: Variants = {
  hidden: { opacity: 0, scale: 0.9 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: {
      ...springConfig.gentle,
      delay: 0.2,
    },
  },
};

/**
 * 统计卡片入场动画
 */
export const statCardVariants: Variants = {
  hidden: { opacity: 0, y: 16, scale: 0.96 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: springConfig.default,
  },
};

// ============================================================================
// 交互动画 Variants
// ============================================================================

/**
 * 悬停提升效果
 */
export const hoverLiftVariants: Variants = {
  initial: { y: 0 },
  hover: {
    y: -2,
    transition: { duration: 0.15 },
  },
};

/**
 * 悬停提升 + 阴影效果
 */
export const hoverElevateVariants: Variants = {
  initial: {
    y: 0,
    boxShadow: '0 1px 3px hsl(var(--foreground) / 0.05)',
  },
  hover: {
    y: -2,
    boxShadow: '0 8px 25px hsl(var(--foreground) / 0.1)',
    transition: { duration: 0.2 },
  },
};

/**
 * 按钮点击效果
 */
export const tapScaleVariants: Variants = {
  initial: { scale: 1 },
  tap: { scale: 0.98 },
};

/**
 * 图标旋转入场
 */
export const iconSpinVariants: Variants = {
  hidden: { scale: 0, rotate: -180 },
  visible: {
    scale: 1,
    rotate: 0,
    transition: {
      ...springConfig.bouncy,
      delay: 0.1,
    },
  },
};

/**
 * 数值缩放入场
 */
export const numberScaleVariants: Variants = {
  hidden: { opacity: 0, scale: 0.5 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: {
      ...springConfig.default,
      delay: 0.2,
    },
  },
};

// ============================================================================
// 页面/面板切换动画 Variants
// ============================================================================

/**
 * 页面淡入淡出
 */
export const pageVariants: Variants = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -20 },
};

/**
 * 页面过渡配置
 */
export const pageTransition: Transition = {
  duration: 0.3,
  ease: easingConfig.easeOut,
};

/**
 * 弹窗入场动画（缩放 + 淡入）
 */
export const modalVariants: Variants = {
  hidden: { opacity: 0, scale: 0.95, y: -8 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: springConfig.snappy,
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    y: -8,
    transition: { duration: 0.15 },
  },
};

/**
 * 下拉菜单入场动画
 */
export const dropdownVariants: Variants = {
  hidden: { opacity: 0, scale: 0.96, y: -4 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {
      duration: 0.12,
      ease: easingConfig.spring,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.96,
    y: -4,
    transition: { duration: 0.1 },
  },
};

/**
 * 从底部弹出的菜单
 */
export const dropdownBottomVariants: Variants = {
  hidden: { opacity: 0, scale: 0.96, y: 4 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {
      duration: 0.12,
      ease: easingConfig.spring,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.96,
    y: 4,
    transition: { duration: 0.1 },
  },
};

// ============================================================================
// 滚动到底部按钮动画
// ============================================================================

/**
 * 滚动到底部按钮动画
 */
export const scrollToBottomVariants: Variants = {
  hidden: { opacity: 0, y: 20, scale: 0.8 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: springConfig.snappy,
  },
  exit: {
    opacity: 0,
    y: 20,
    scale: 0.8,
    transition: { duration: 0.15 },
  },
};

// ============================================================================
// 聊天气泡动画
// ============================================================================

/**
 * 聊天气泡入场动画
 */
export const bubbleVariants: Variants = {
  initial: { opacity: 0, y: 8, scale: 0.98 },
  animate: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: springConfig.default,
  },
  hover: {
    y: -1,
    transition: springConfig.snappy,
  },
};

/**
 * 操作按钮级联动画（自定义 delay 基于索引）
 */
export const actionButtonVariants: Variants = {
  initial: { opacity: 0, x: 8, scale: 0.9 },
  animate: {
    opacity: 1,
    x: 0,
    scale: 1,
    transition: springConfig.snappy,
  },
  exit: {
    opacity: 0,
    x: 8,
    scale: 0.9,
    transition: { duration: 0.1 },
  },
};

/**
 * 创建带索引延迟的动画 transition
 */
export function createStaggeredTransition(index: number, baseDelay = 0.03): Transition {
  return {
    ...springConfig.snappy,
    delay: index * baseDelay,
  };
}

// ============================================================================
// 日期分隔线动画
// ============================================================================

/**
 * 日期分隔线容器动画
 */
export const dateSeparatorVariants: Variants = {
  initial: { opacity: 0, scaleX: 0.5 },
  animate: {
    opacity: 1,
    scaleX: 1,
    transition: {
      ...springConfig.default,
      opacity: { duration: 0.2 },
    },
  },
};

/**
 * 日期分隔线 - 线条动画
 */
export const separatorLineVariants: Variants = {
  initial: { scaleX: 0 },
  animate: {
    scaleX: 1,
    transition: { delay: 0.1, duration: 0.3, ease: easingConfig.easeOut },
  },
};

/**
 * 日期分隔线 - 文字动画
 */
export const separatorTextVariants: Variants = {
  initial: { opacity: 0, y: 4 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { delay: 0.15, duration: 0.2 },
  },
};

// ============================================================================
// 提及弹窗动画
// ============================================================================

/**
 * 提及弹窗容器动画
 */
export const mentionPopoverVariants: Variants = {
  initial: { opacity: 0, y: 4, scale: 0.95 },
  animate: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: springConfig.snappy,
  },
  exit: {
    opacity: 0,
    y: 4,
    scale: 0.95,
    transition: { duration: 0.1 },
  },
};

/**
 * 提及选项动画
 */
export const mentionOptionVariants: Variants = {
  initial: { opacity: 0, x: -4 },
  animate: {
    opacity: 1,
    x: 0,
    transition: springConfig.smooth,
  },
};

// ============================================================================
// Tooltip 动画
// ============================================================================

/**
 * Tooltip 动画
 */
export const tooltipVariants: Variants = {
  initial: { opacity: 0, scale: 0.95 },
  animate: {
    opacity: 1,
    scale: 1,
    transition: { duration: 0.15 },
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    transition: { duration: 0.1 },
  },
};

// ============================================================================
// 徽章动画
// ============================================================================

/**
 * 未读徽章数字动画
 */
export const badgeCountVariants: Variants = {
  initial: { y: -8, opacity: 0 },
  animate: { y: 0, opacity: 1 },
  exit: { y: 8, opacity: 0 },
};

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 创建带有自定义延迟的入场动画
 */
export function createDelayedEntrance(delay: number): Variants {
  return {
    hidden: { opacity: 0, y: 8 },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        ...springConfig.default,
        delay,
      },
    },
  };
}

/**
 * 创建索引化的级联动画 transition
 */
export function createIndexedTransition(
  index: number,
  config: {
    baseDelay?: number;
    staggerDelay?: number;
    spring?: typeof springConfig.default;
  } = {}
): Transition {
  const { baseDelay = 0, staggerDelay = 0.03, spring = springConfig.default } = config;
  return {
    ...spring,
    delay: baseDelay + index * staggerDelay,
  };
}

// ============================================================================
// 全屏面板/视图切换动画
// ============================================================================

/**
 * 全屏面板入场动画 - 从右侧滑入覆盖
 * 适用于会话浏览等全屏视图
 */
export const fullscreenPanelVariants: Variants = {
  initial: { 
    x: '100%',
    opacity: 0,
  },
  animate: {
    x: 0,
    opacity: 1,
    transition: {
      x: { type: 'spring', stiffness: 300, damping: 30 },
      opacity: { duration: 0.2 },
    },
  },
  exit: {
    x: '100%',
    opacity: 0,
    transition: {
      x: { type: 'spring', stiffness: 400, damping: 40 },
      opacity: { duration: 0.15 },
    },
  },
};

/**
 * 主内容区在全屏面板进入时的动画
 * 轻微向左偏移 + 缩小，营造层叠感
 */
export const mainContentVariants: Variants = {
  normal: {
    scale: 1,
    x: 0,
    opacity: 1,
    transition: springConfig.gentle,
  },
  pushed: {
    scale: 0.96,
    x: -20,
    opacity: 0.5,
    transition: springConfig.gentle,
  },
};

// ============================================================================
// 导出默认配置
// ============================================================================

export default {
  spring: springConfig,
  duration: durationConfig,
  easing: easingConfig,
  container: containerVariants,
  containerFast: containerFastVariants,
  gridContainer: gridContainerVariants,
  card: cardVariants,
  item: itemVariants,
  chart: chartVariants,
  statCard: statCardVariants,
  hoverLift: hoverLiftVariants,
  hoverElevate: hoverElevateVariants,
  tapScale: tapScaleVariants,
  iconSpin: iconSpinVariants,
  numberScale: numberScaleVariants,
  page: pageVariants,
  pageTransition,
  modal: modalVariants,
  dropdown: dropdownVariants,
  dropdownBottom: dropdownBottomVariants,
  scrollToBottom: scrollToBottomVariants,
  bubble: bubbleVariants,
  actionButton: actionButtonVariants,
  dateSeparator: dateSeparatorVariants,
  separatorLine: separatorLineVariants,
  separatorText: separatorTextVariants,
  mentionPopover: mentionPopoverVariants,
  mentionOption: mentionOptionVariants,
  tooltip: tooltipVariants,
  badgeCount: badgeCountVariants,
  fullscreenPanel: fullscreenPanelVariants,
  mainContent: mainContentVariants,
};
