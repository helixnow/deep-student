/**
 * 矿物色阶分支色板（Muted Mineral Tones）统一数据源
 *
 * 约定：
 * - 每套色板固定 7 色，顺序为 赤陶红 / 赭石橙 / 琥珀金 / 青瓷绿 / 黛石蓝 / 烟岚紫 / 梅染粉；
 * - 饱和度收敛在 22%~38% 的自然矿物颜料色域，告别刺眼荧光色；
 * - 亮色色板保证在浅色画布上有温润且清晰的对比度；
 * - 暗色色板保证在深色画布上柔和可读、不刺眼；
 * - 同一主题的亮暗变体各自引用对应色板。
 */

/** 默认亮色色板（Mineral 青瓷微染矿物色阶） */
export const DEFAULT_LIGHT_PALETTE = [
  '#B55A52', // 矿物赤陶 Red
  '#C27D48', // 暖赭石 Orange
  '#A6893E', // 古铜琥珀 Yellow/Amber
  '#2A6F5E', // 青瓷松绿 Green (Primary Celadon)
  '#3B6E8C', // 冰瓷黛蓝 Blue
  '#6A5D8E', // 烟岚藤紫 Purple
  '#A85D74', // 暮云梅粉 Pink
];

/**
 * 暗色安全色板 —— default-dark 与显式 dark 主题共用同一套，
 * 温润提亮的夜石矿物色阶。
 */
export const DARK_SAFE_PALETTE = [
  '#D4857D', // Red
  '#D99E6C', // Orange
  '#C9B168', // Amber
  '#5EA893', // Celadon Green
  '#6B9EBD', // Slate Blue
  '#9689BA', // Muted Amethyst
  '#C9879C', // Muted Rose
];

/** Stone 冷灰石韵亮色色板：低饱和冷调矿石色 */
export const MINIMAL_LIGHT_PALETTE = [
  '#A8524D', // Red
  '#B87343', // Orange
  '#9E8238', // Amber
  '#3E755B', // Green
  '#38688A', // Blue
  '#635688', // Purple
  '#9E546B', // Pink
];

/** Stone 冷灰石韵暗色色板：柔和冷灰浅矿石色 */
export const MINIMAL_DARK_PALETTE = [
  '#CC8580', // Red
  '#D49A70', // Orange
  '#C4AD6A', // Amber
  '#6DA68A', // Green
  '#6A9AB8', // Blue
  '#9185B5', // Purple
  '#C28298', // Pink
];

/** 矿彩微光亮色色板：温润微饱和矿物色阶 */
export const COLORFUL_LIGHT_PALETTE = [
  '#B85D56', // Red
  '#C47E4A', // Orange
  '#A88A40', // Amber
  '#2A6F5E', // Celadon Green
  '#3A6F8F', // Porcelain Blue
  '#6C5E91', // Amethyst
  '#AA5E76', // Rose
];

/** 矿彩微光暗色色板：亮色矿物色的深底提亮变体 */
export const COLORFUL_DARK_PALETTE = [
  '#D68880', // Red
  '#DBA06E', // Orange
  '#CCB36A', // Amber
  '#5EA893', // Celadon Green
  '#6CA0BF', // Porcelain Blue
  '#988BBC', // Amethyst
  '#CB899E', // Rose
];

/** Paper 日光亚麻亮色色板：书卷矿物颜料色（朱砂/赭石/秋香/松绿/黛蓝/藤紫/胭脂） */
export const PAPER_LIGHT_PALETTE = [
  '#AD4E46', // 朱砂 Red
  '#B8763C', // 赭石 Orange
  '#9E8036', // 秋香 Amber
  '#4A7859', // 松绿 Green
  '#3D6985', // 黛蓝 Blue
  '#6B5B8E', // 藤紫 Purple
  '#9E5870', // 胭脂 Pink
];

/** Paper 日光亚麻暗色色板：暖暗底上柔和可读的矿物色 */
export const PAPER_DARK_PALETTE = [
  '#D4877C', // 朱砂 Red
  '#D6A16E', // 赭石 Orange
  '#C7B26B', // 秋香 Amber
  '#7EB08E', // 松绿 Green
  '#7AA2BD', // 黛蓝 Blue
  '#9E90C2', // 藤紫 Purple
  '#C28A9E', // 胭脂 Pink
];
