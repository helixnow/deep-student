/**
 * 常量聚合导出
 */

// 布局常量
export {
  DEFAULT_LAYOUT_CONFIG,
  COMPACT_LAYOUT_CONFIG,
  SPACIOUS_LAYOUT_CONFIG,
  REACTFLOW_CONFIG,
  ROOT_NODE_STYLE,
  parsePadding,
  calculateBaseNodeHeight,
} from './layout';

// 深度间距收敛（层距/兄弟距随深度收紧，config.depthGapScaling 控制）
export {
  DEFAULT_DEPTH_GAP_SCALING,
  depthGapScale,
  getDepthHorizontalGap,
  getDepthVerticalGap,
  type DepthGapScaling,
  type DepthGapScalingConfig,
} from './layout';

// 快捷键
export type { ShortcutAction } from './shortcuts';
export {
  SHORTCUTS,
  OUTLINE_SHORTCUTS,
  MINDMAP_SHORTCUTS,
} from './shortcuts';

// 颜色预设（新代码请用暗色感知函数 getQuick*/getFull*，数组常量为兼容保留）
export {
  QUICK_TEXT_COLORS,
  QUICK_TEXT_COLORS_DARK,
  QUICK_BG_COLORS,
  QUICK_BG_COLORS_DARK,
  FULL_TEXT_COLORS,
  FULL_TEXT_COLORS_DARK,
  FULL_BG_COLORS,
  FULL_BG_COLORS_DARK,
  getQuickBgColors,
  getQuickTextColors,
  getFullBgColors,
  getFullTextColors,
  BRANCH_HUES,
  getBranchColor,
} from './colors';

// 主题：旧 Theme 常量体系（constants/themes.ts）已删除。
// 样式主题的唯一数据源是 styles/themes/*（IStyleTheme + StyleRegistry），
// 通过 features/mindmap/styles 导出。

