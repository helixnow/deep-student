/**
 * 快捷键工具函数（统一版本）
 *
 * 本模块是所有快捷键解析、格式化、标准化的唯一来源。
 * shortcutManager / commandRegistry / CommandPaletteProvider / ShortcutSettings
 * 均应从此处导入，禁止各自重复实现。
 */

import { isMacOS } from '@/utils/platform';

// ==================== 常量 ====================

/**
 * 特殊功能键列表（无需修饰键即可作为快捷键）
 * 注意：不包含 escape/enter/tab，这些键通常用于 UI 交互
 */
export const SPECIAL_KEYS = new Set([
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
  'delete', 'backspace',
  'home', 'end', 'pageup', 'pagedown',
  'insert', 'pause',
]);

// ==================== 标准化 ====================

/**
 * 标准化快捷键格式
 * 将快捷键转为统一的小写、排序格式，用于比较和存储。
 *
 * 例：`"Mod+Shift+K"` → `"k+mod+shift"`
 */
export function normalizeShortcut(shortcut: string): string {
  return shortcut
    .toLowerCase()
    .replace(/\s+/g, '')
    .split('+')
    .sort()
    .join('+');
}

// ==================== 格式化 ====================

/**
 * 格式化快捷键为用户可读的显示格式
 *
 * macOS: `mod+shift+k` → `⌘⇧K`
 * Others: `mod+shift+k` → `Ctrl+Shift+K`
 */
export function formatShortcut(shortcut: string): string {
  const isMac = isMacOS();
  return shortcut
    .replace(/mod/gi, isMac ? '⌘' : 'Ctrl')
    .replace(/shift/gi, isMac ? '⇧' : 'Shift')
    .replace(/alt/gi, isMac ? '⌥' : 'Alt')
    .replace(/\+/g, isMac ? '' : '+')
    .replace(/\b([a-z])\b/gi, (match) => match.toUpperCase());
}

// ==================== 事件解析 ====================

/**
 * 标准化 `KeyboardEvent.key` 值
 */
function normalizeEventKey(key: string): string {
  const lower = key.toLowerCase();
  switch (lower) {
    case ' ': return 'space';
    case 'arrowup': return 'up';
    case 'arrowdown': return 'down';
    case 'arrowleft': return 'left';
    case 'arrowright': return 'right';
    default: return lower;
  }
}

/**
 * 从键盘事件构建快捷键字符串
 *
 * 返回 `null` 表示该事件不应被视为快捷键（纯字符输入、单独按下修饰键等）。
 */
export function buildShortcutString(e: KeyboardEvent): string | null {
  const parts: string[] = [];

  if (e.metaKey || e.ctrlKey) parts.push('mod');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');

  // 忽略单独的修饰键
  if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) {
    return null;
  }

  const key = normalizeEventKey(e.key);
  parts.push(key);

  // 有修饰键，或者是特殊功能键时返回快捷键字符串
  if (parts.length > 1 || SPECIAL_KEYS.has(key)) {
    return parts.join('+');
  }

  return null;
}
