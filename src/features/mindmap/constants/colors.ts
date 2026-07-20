/**
 * 思维导图颜色预设常量
 *
 * 所有需要颜色选择的地方（右键菜单、大纲视图、样式面板）统一引用此文件，
 * 确保颜色一致性。
 *
 * 消费契约（W06 视觉体系）：
 * - 选色板一律通过 getQuickXxx / getFullXxx 函数按暗色模式取用，
 *   `isDark` 建议来自 `styles/useMindMapTheme.ts` 的 `useMindMapDarkMode()`；
 * - 彩虹分支色通过 `getBranchColor(branchIndex, depth, isDark)` 计算，
 *   与主题 identity palette（styles/themes/palettes.ts）互不混用；
 * - 旧的数组常量导出保留兼容，新代码请使用函数版本。
 */

/** 节点文字颜色 - 快速选择（右键菜单 / 大纲菜单，亮色模式） */
export const QUICK_TEXT_COLORS = [
  '#ef4444', // Red
  '#f97316', // Orange
  '#eab308', // Yellow
  '#22c55e', // Green
  '#3b82f6', // Blue
  '#a855f7', // Purple
  '#ec4899', // Pink
] as const;

/** 节点文字颜色 - 快速选择（暗色模式：提亮一档，深底可读） */
export const QUICK_TEXT_COLORS_DARK = [
  '#f87171', // Red
  '#fb923c', // Orange
  '#facc15', // Yellow
  '#4ade80', // Green
  '#60a5fa', // Blue
  '#c084fc', // Purple
  '#f472b6', // Pink
] as const;

/** 节点背景高亮颜色 - 快速选择（右键菜单 / 大纲菜单，亮色模式） */
export const QUICK_BG_COLORS = [
  '#fecaca', // Red
  '#fed7aa', // Orange
  '#fef08a', // Yellow
  '#bbf7d0', // Green
  '#bfdbfe', // Blue
  '#e9d5ff', // Purple
  '#fbcfe8', // Pink
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

/** 节点文字颜色 - 完整列表（样式面板 - 暗色模式） */
export const FULL_TEXT_COLORS_DARK = [
  'inherit',
  '#ffffff',
  '#e0e0e0',
  '#a0aec0',
  '#718096',
  ...QUICK_TEXT_COLORS_DARK,
] as const;

/** 节点背景颜色 - 完整列表（样式面板 - 暗色模式） */
export const FULL_BG_COLORS_DARK = [
  'transparent',
  '#2d2d2d',
  '#363636',
  '#404040',
  ...QUICK_BG_COLORS_DARK,
] as const;

// ============================================================================
// 暗色感知选色板（消费方唯一入口，B-06 修复）
// ============================================================================

/** 快速背景高亮色板（右键菜单 / 大纲菜单 / 移动端工具条） */
export function getQuickBgColors(isDark: boolean): readonly string[] {
  return isDark ? QUICK_BG_COLORS_DARK : QUICK_BG_COLORS;
}

/** 快速文字色板（右键菜单 / 大纲菜单 / 移动端工具条） */
export function getQuickTextColors(isDark: boolean): readonly string[] {
  return isDark ? QUICK_TEXT_COLORS_DARK : QUICK_TEXT_COLORS;
}

/** 完整背景色板（样式面板） */
export function getFullBgColors(isDark: boolean): readonly string[] {
  return isDark ? FULL_BG_COLORS_DARK : FULL_BG_COLORS;
}

/** 完整文字色板（样式面板） */
export function getFullTextColors(isDark: boolean): readonly string[] {
  return isDark ? FULL_TEXT_COLORS_DARK : FULL_TEXT_COLORS;
}

// ============================================================================
// 彩虹分支 2.0（C-13 基建）
// ============================================================================

/**
 * 一级分支色相环（hsl hue，红/橙/黄/绿/蓝/紫/粉 7 档），
 * 与 QUICK_* 色板、主题 palette 的色序语义一致（单一色相源）。
 */
export const BRANCH_HUES = [4, 25, 45, 150, 212, 265, 330] as const;

/** 每套曲线：depth 0 为一级分支本身，子级逐层降饱和 / 调明度 */
interface BranchCurve {
  saturation: number;
  lightness: number;
  saturationStep: number;
  lightnessStep: number;
  minSaturation: number;
  maxLightness: number;
}

const LIGHT_BRANCH_CURVE: BranchCurve = {
  saturation: 62,
  lightness: 44,
  saturationStep: -9,
  lightnessStep: 6,
  minSaturation: 26,
  maxLightness: 68,
};

const DARK_BRANCH_CURVE: BranchCurve = {
  saturation: 68,
  lightness: 64,
  saturationStep: -9,
  lightnessStep: 4,
  minSaturation: 30,
  maxLightness: 80,
};

/**
 * 彩虹分支取色。
 *
 * @param branchIndex 一级分支的序号（根节点的第 N 个直接子节点，任意非负整数，按 7 色循环）
 * @param depth       相对一级分支的深度：一级分支自身为 0，其子节点为 1，依此类推；
 *                    深度越大饱和度越低（亮色同时提亮、暗色轻微提亮），保持同分支族的色相识别
 * @param isDark      当前是否暗色模式（建议来自 useMindMapDarkMode()）
 * @returns           `hsl(H S% L%)` 字符串，可直接用于 SVG stroke / borderColor / color
 */
export function getBranchColor(branchIndex: number, depth: number, isDark: boolean): string {
  const hue = BRANCH_HUES[((branchIndex % BRANCH_HUES.length) + BRANCH_HUES.length) % BRANCH_HUES.length];
  const curve = isDark ? DARK_BRANCH_CURVE : LIGHT_BRANCH_CURVE;
  const level = Math.max(0, depth);

  const saturation = Math.max(curve.minSaturation, curve.saturation + curve.saturationStep * level);
  const lightness = Math.min(curve.maxLightness, curve.lightness + curve.lightnessStep * level);

  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}
