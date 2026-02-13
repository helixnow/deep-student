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

// 快捷键
export type { ShortcutAction } from './shortcuts';
export {
  SHORTCUTS,
  OUTLINE_SHORTCUTS,
  MINDMAP_SHORTCUTS,
} from './shortcuts';

// 颜色预设
export {
  QUICK_TEXT_COLORS,
  QUICK_BG_COLORS,
  FULL_TEXT_COLORS,
  FULL_BG_COLORS,
} from './colors';

// 主题
export {
  DARK_THEME,
  LIGHT_THEME,
  MINIMAL_THEME,
  MINIMAL_DARK_THEME,
  BUILTIN_THEMES,
  getTheme,
  getThemeForMode,
} from './themes';

