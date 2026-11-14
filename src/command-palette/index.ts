/**
 * 命令面板模块导出入口
 */

// 组件
export { CommandPalette } from './CommandPalette';
export { CommandPaletteProvider, useCommandPalette, useCommandPaletteSafe } from './CommandPaletteProvider';
export { ShortcutSettings } from './components/ShortcutSettings';

// Registry
export { commandRegistry } from './registry/commandRegistry';

// 快捷键工具（统一版本）
export {
  normalizeShortcut,
  formatShortcut,
  buildShortcutString,
  SPECIAL_KEYS,
} from './registry/shortcutUtils';

// 历史/收藏/快捷键管理
export { commandHistory } from './registry/commandHistory';
export { commandFavorites } from './registry/commandFavorites';
export { shortcutManager } from './registry/shortcutManager';

// Hooks
export { useCommandEvents, createCommandEventDispatcher, COMMAND_EVENTS } from './hooks/useCommandEvents';
export type { CommandEventName } from './hooks/useCommandEvents';

// 类型
export type {
  Command,
  CommandCategory,
  CommandView,
  DependencyResolver,
  ICommandRegistry,
  CommandChangeListener,
} from './registry/types';

export type { CommandHistoryEntry } from './registry/commandHistory';
export type { ShortcutBinding, ShortcutConflict } from './registry/shortcutManager';

export { CATEGORY_CONFIG } from './registry/types';

// 功能 UI 插件贡献命令（内置命令由 src/ui-plugins/official/* 贡献）
export { contributeCommands } from './contribute';
