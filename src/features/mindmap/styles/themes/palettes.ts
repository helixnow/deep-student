/**
 * 彩虹分支色板（palette）统一数据源
 *
 * 约定：
 * - 每套色板固定 7 色，顺序为 红 / 橙 / 黄 / 绿 / 蓝 / 紫 / 粉；
 * - 亮色色板保证在浅色画布（--mm-bg 接近白）上有足够对比度；
 * - 暗色色板保证在深色画布上有足够对比度（整体更亮、避免深紫等低对比色）；
 * - 同一主题的亮暗变体各自引用对应色板，palette 是唯一允许亮暗"换色值"的字段
 *   （结构性颜色走 token，identity 色见各主题文件注释）。
 *
 * 主画布当前尚未开启彩虹分支（palette 存在即自动开启的开关由画布侧控制），
 * 这里只负责数据质量。
 */

/** 默认亮色色板（default 亮色使用，历史沿用值，勿随意改动避免视觉回归） */
export const DEFAULT_LIGHT_PALETTE = [
  '#E05252', // Red
  '#E69038', // Orange
  '#EBCB4B', // Yellow
  '#5BB98C', // Green
  '#2EAADC', // Blue (Primary)
  '#6C63FF', // Purple
  '#F2668B', // Pink
];

/**
 * 暗色安全色板 —— default-dark 与显式 dark 主题共用同一套，
 * 消除两者彩虹色不一致的问题。
 */
export const DARK_SAFE_PALETTE = [
  '#FF6B6B', // Red
  '#FFA94D', // Orange
  '#FFD43B', // Yellow
  '#51CF66', // Green
  '#4DABF7', // Blue
  '#9775FA', // Purple
  '#F783AC', // Pink
];

/** 极简主题亮色色板：低饱和深色调，白底上依旧清晰但不喧宾夺主 */
export const MINIMAL_LIGHT_PALETTE = [
  '#C92A2A', // Red
  '#D9480F', // Orange
  '#E67700', // Yellow (amber，纯黄在白底对比不足)
  '#2B8A3E', // Green
  '#1971C2', // Blue
  '#6741D9', // Purple
  '#C2255C', // Pink
];

/** 极简主题暗色色板：柔和浅色调，深底上不刺眼 */
export const MINIMAL_DARK_PALETTE = [
  '#FFA8A8', // Red
  '#FFC078', // Orange
  '#FFE066', // Yellow
  '#8CE99A', // Green
  '#74C0FC', // Blue
  '#B197FC', // Purple
  '#FAA2C1', // Pink
];

/** 彩色主题亮色色板（历史沿用值） */
export const COLORFUL_LIGHT_PALETTE = [
  '#F56565', // Red
  '#ED8936', // Orange
  '#ECC94B', // Yellow
  '#48BB78', // Green
  '#4299E1', // Blue
  '#9F7AEA', // Purple
  '#ED64A6', // Pink
];

/** 彩色主题暗色色板：亮色色板的提亮变体，保证深底对比度 */
export const COLORFUL_DARK_PALETTE = [
  '#FC8181', // Red
  '#F6AD55', // Orange
  '#F6E05E', // Yellow
  '#68D391', // Green
  '#63B3ED', // Blue
  '#B794F4', // Purple
  '#F687B3', // Pink
];

/** 纸墨主题亮色色板：矿物颜料色（朱砂/赭石/秋香/松绿/黛蓝/藤紫/胭脂） */
export const PAPER_LIGHT_PALETTE = [
  '#B4443C', // 朱砂 Red
  '#C07A2E', // 赭石 Orange
  '#A9862F', // 秋香 Yellow
  '#4E7E5B', // 松绿 Green
  '#3F6E8C', // 黛蓝 Blue
  '#705E9C', // 藤紫 Purple
  '#A85C77', // 胭脂 Pink
];

/** 纸墨主题暗色色板：亮色矿物色的提亮低饱和变体，暖暗底上柔和可读 */
export const PAPER_DARK_PALETTE = [
  '#E08A7A', // 朱砂 Red
  '#E0A96A', // 赭石 Orange
  '#D6C06B', // 秋香 Yellow
  '#8FBF9A', // 松绿 Green
  '#85AFC9', // 黛蓝 Blue
  '#A899CF', // 藤紫 Purple
  '#CE93A8', // 胭脂 Pink
];
