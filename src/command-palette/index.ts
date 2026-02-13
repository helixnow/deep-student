/**
 * 命令面板模块导出入口
 */

// 组件
export { CommandPalette } from './CommandPalette';
export { CommandPaletteProvider, useCommandPalette } from './CommandPaletteProvider';
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
  DependencyResolver,
  ICommandRegistry,
  CommandChangeListener,
} from './registry/types';

export type { CommandHistoryEntry } from './registry/commandHistory';
export type { ShortcutBinding, ShortcutConflict } from './registry/shortcutManager';

export { CATEGORY_CONFIG } from './registry/types';

// 内置命令注册（在 App 初始化时调用）
export { registerBuiltinCommands } from './registry/builtinCommands';
