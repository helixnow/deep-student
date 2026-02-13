/**
 * 思维导图颜色预设常量
 *
 * 所有需要颜色选择的地方（右键菜单、大纲视图、样式面板）统一引用此文件，
 * 确保颜色一致性。
 */

/** 节点文字颜色 - 快速选择（右键菜单 / 大纲菜单） */
export const QUICK_TEXT_COLORS = [
  '#ef4444', // Red
  '#f97316', // Orange
  '#eab308', // Yellow
  '#22c55e', // Green
  '#3b82f6', // Blue
  '#a855f7', // Purple
  '#ec4899', // Pink
] as const;

/** 节点背景高亮颜色 - 快速选择（右键菜单 / 大纲菜单） */
export const QUICK_BG_COLORS = [
  '#fecaca', // Red
  '#fed7aa', // Orange
  '#fef08a', // Yellow
  '#bbf7d0', // Green
  '#bfdbfe', // Blue
  '#e9d5ff', // Purple
  '#fbcfe8', // Pink
] as const;

/** 节点文字颜色 - 完整列表（样式面板 - 亮色模式） */
export const FULL_TEXT_COLORS = [
  'inherit',
  '#000000',
  '#37352f',
  '#4a5568',
  '#718096',
  ...QUICK_TEXT_COLORS,
] as const;

/** 节点背景颜色 - 完整列表（样式面板 - 亮色模式） */
export const FULL_BG_COLORS = [
  'transparent',
  '#ffffff',
  '#f8f9fa',
  '#e9ecef',
  ...QUICK_BG_COLORS,
] as const;

/** 暗色模式 - 节点背景高亮颜色（深色调变体） */
export const QUICK_BG_COLORS_DARK = [
  '#991b1b', // Red-900
  '#9a3412', // Orange-900
  '#854d0e', // Yellow-900
  '#166534', // Green-900
  '#1e3a5f', // Blue-900
  '#581c87', // Purple-900
  '#831843', // Pink-900
] as const;

/** 节点文字颜色 - 完整列表（样式面板 - 暗色模式） */
export const FULL_TEXT_COLORS_DARK = [
  'inherit',
  '#ffffff',
  '#e0e0e0',
  '#a0aec0',
  '#718096',
  ...QUICK_TEXT_COLORS,
] as const;

/** 节点背景颜色 - 完整列表（样式面板 - 暗色模式） */
export const FULL_BG_COLORS_DARK = [
  'transparent',
  '#2d2d2d',
  '#363636',
  '#404040',
  ...QUICK_BG_COLORS_DARK,
] as const;
