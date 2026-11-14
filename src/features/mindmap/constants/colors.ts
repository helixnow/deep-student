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

/** 节点文字颜色 - 快速选择（矿物墨水色，亮底对比度 >= 4.8:1，彻底消灭刺眼亮黄） */
export const QUICK_TEXT_COLORS = [
  '#a8433b', // 赤陶墨红 Terracotta Ink
  '#b0622b', // 赭石暖橙 Ochre Ink
  '#8a681d', // 古铜琥珀 Bronze Amber (contrast >= 4.9:1 on light card)
  '#2a6f5e', // 青瓷松绿 Celadon Pine
  '#2c5e8a', // 黛蓝矿石 Slate Indigo
  '#5e4b8b', // 烟紫矿石 Muted Amethyst
  '#944664', // 胭脂梅紫 Plum Rose
] as const;

/** 节点文字颜色 - 快速选择（暗色模式：温润矿物亮色，深底清晰可读） */
export const QUICK_TEXT_COLORS_DARK = [
  '#e08a82', // Soft Terracotta
  '#e4a372', // Soft Ochre
  '#d6ba6c', // Soft Amber
  '#68b5a0', // Soft Celadon
  '#74a9d4', // Soft Slate Blue
  '#a594cf', // Soft Amethyst
  '#d18ba4', // Soft Plum Rose
] as const;

/** 节点背景微染颜色 - 快速选择（亮色模式：浅赤陶、暖羊皮、云母米、青瓷绿、冰瓷蓝、烟紫雾、云母灰） */
export const QUICK_BG_COLORS = [
  '#f4e6e4', // 浅赤陶 Soft Terracotta
  '#f5eae0', // 暖羊皮 Warm Parchment
  '#f3efe2', // 云母暖米 Mica Ochre
  '#e6f0ec', // 青瓷绿 Celadon Mist
  '#e7eef4', // 冰瓷蓝 Porcelain Blue
  '#edebf4', // 烟紫雾 Amethyst Haze
  '#eaecef', // 云母灰 Mica Slate
] as const;

/** 暗色模式 - 节点背景微染颜色（低饱和深矿石微染） */
export const QUICK_BG_COLORS_DARK = [
  '#362423', // Dark Terracotta
  '#36291f', // Dark Parchment
  '#332e20', // Dark Ochre
  '#1d322c', // Dark Celadon
  '#1e2d3a', // Dark Porcelain
  '#2a2638', // Dark Amethyst
  '#25292e', // Dark Mica Slate
] as const;

/** 节点文字颜色 - 完整列表（样式面板 - 亮色模式） */
export const FULL_TEXT_COLORS = [
  'inherit',
  '#182220',
  '#2c3533',
  '#4a5855',
  '#6e7d79',
  ...QUICK_TEXT_COLORS,
] as const;

/** 节点背景颜色 - 完整列表（样式面板 - 亮色模式） */
export const FULL_BG_COLORS = [
  'transparent',
  '#ffffff',
  '#f7f9f8',
  '#eef2f0',
  ...QUICK_BG_COLORS,
] as const;

/** 节点文字颜色 - 完整列表（样式面板 - 暗色模式） */
export const FULL_TEXT_COLORS_DARK = [
  'inherit',
  '#f2f7f5',
  '#dce5e2',
  '#9bafa9',
  '#6e807b',
  ...QUICK_TEXT_COLORS_DARK,
] as const;

/** 节点背景颜色 - 完整列表（样式面板 - 暗色模式） */
export const FULL_BG_COLORS_DARK = [
  'transparent',
  '#19211f',
  '#212b28',
  '#2a3633',
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
  saturation: 35,
  lightness: 42,
  saturationStep: -5,
  lightnessStep: 5,
  minSaturation: 22,
  maxLightness: 64,
};

const DARK_BRANCH_CURVE: BranchCurve = {
  saturation: 38,
  lightness: 64,
  saturationStep: -5,
  lightnessStep: 4,
  minSaturation: 24,
  maxLightness: 78,
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
