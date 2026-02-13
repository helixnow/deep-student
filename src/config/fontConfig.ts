/**
 * 全局字体配置
 * 统一管理字体预设，避免多处重复定义
 */

export const UI_FONT_STORAGE_KEY = 'ui.fontFamily';
export const DEFAULT_UI_FONT = 'system';
export const UI_FONT_SIZE_STORAGE_KEY = 'ui.fontScale';
export const DEFAULT_UI_FONT_SIZE = 1;
export const MIN_UI_FONT_SIZE = 0.85;
export const MAX_UI_FONT_SIZE = 1.3;

export const UI_FONT_SIZE_PRESETS = [
  { value: 0.85, label: '85%' },
  { value: 0.9, label: '90%' },
  { value: 1.0, label: '100%' },
  { value: 1.1, label: '110%' },
  { value: 1.2, label: '120%' },
  { value: 1.3, label: '130%' },
];

export interface FontPreset {
  value: string;
  family: string;
  labelKey: string;
}

export interface FontPresetGroup {
  groupKey: string;
  presets: FontPreset[];
}

/** 系统字体 */
const SYSTEM_FONTS: FontPreset[] = [
  {
    value: 'system',
    family: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    labelKey: 'settings:font.presets.system',
  },
];

/** 无衬线字体（黑体类） */
const SANS_SERIF_FONTS: FontPreset[] = [
  {
    value: 'pingfang',
    family: '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif',
    labelKey: 'settings:font.presets.pingfang',
  },
  {
    value: 'noto-sans',
    family: '"Noto Sans SC", "Source Han Sans SC", "PingFang SC", sans-serif',
    labelKey: 'settings:font.presets.noto_sans',
  },
  {
    value: 'harmonyos-sans',
    family: '"HarmonyOS Sans SC", "HarmonyOS Sans", "PingFang SC", "Microsoft YaHei", sans-serif',
    labelKey: 'settings:font.presets.harmonyos_sans',
  },
  {
    value: 'oppo-sans',
    family: '"OPPO Sans", "PingFang SC", "Microsoft YaHei", sans-serif',
    labelKey: 'settings:font.presets.oppo_sans',
  },
  {
    value: 'alibaba-puhuiti',
    family: '"Alibaba PuHuiTi", "PingFang SC", "Microsoft YaHei", sans-serif',
    labelKey: 'settings:font.presets.alibaba_puhuiti',
  },
];

/** 衬线字体（宋体类） */
const SERIF_FONTS: FontPreset[] = [
  {
    value: 'noto-serif',
    family: '"Noto Serif SC", "Source Han Serif SC", "Songti SC", serif',
    labelKey: 'settings:font.presets.noto_serif',
  },
  {
    value: 'songti',
    family: '"Songti SC", "SimSun", "FangSong", serif',
    labelKey: 'settings:font.presets.songti',
  },
];

/** 手写/艺术字体 */
const HANDWRITING_FONTS: FontPreset[] = [
  {
    value: 'lxgw-wenkai',
    family: '"LXGW WenKai", "KaiTi", "STKaiti", cursive',
    labelKey: 'settings:font.presets.lxgw_wenkai',
  },
  {
    value: 'kaiti',
    family: '"KaiTi", "STKaiti", "LXGW WenKai", cursive',
    labelKey: 'settings:font.presets.kaiti',
  },
];

/** 等宽字体 */
const MONOSPACE_FONTS: FontPreset[] = [
  {
    value: 'mono',
    family: '"JetBrains Mono", "Fira Code", "SF Mono", Consolas, monospace',
    labelKey: 'settings:font.presets.mono',
  },
  {
    value: 'cascadia-code',
    family: '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace',
    labelKey: 'settings:font.presets.cascadia_code',
  },
];

/** 英文字体（开源/免费） */
const ENGLISH_FONTS: FontPreset[] = [
  {
    value: 'inter',
    family: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    labelKey: 'settings:font.presets.inter',
  },
  {
    value: 'roboto',
    family: '"Roboto", "Helvetica Neue", Arial, sans-serif',
    labelKey: 'settings:font.presets.roboto',
  },
  {
    value: 'open-sans',
    family: '"Open Sans", "Helvetica Neue", Arial, sans-serif',
    labelKey: 'settings:font.presets.open_sans',
  },
  {
    value: 'lato',
    family: '"Lato", "Helvetica Neue", Arial, sans-serif',
    labelKey: 'settings:font.presets.lato',
  },
  {
    value: 'montserrat',
    family: '"Montserrat", "Helvetica Neue", Arial, sans-serif',
    labelKey: 'settings:font.presets.montserrat',
  },
  {
    value: 'poppins',
    family: '"Poppins", "Helvetica Neue", Arial, sans-serif',
    labelKey: 'settings:font.presets.poppins',
  },
  {
    value: 'ibm-plex-sans',
    family: '"IBM Plex Sans", "Helvetica Neue", Arial, sans-serif',
    labelKey: 'settings:font.presets.ibm_plex_sans',
  },
  {
    value: 'source-sans',
    family: '"Source Sans 3", "Source Sans Pro", "Helvetica Neue", Arial, sans-serif',
    labelKey: 'settings:font.presets.source_sans',
  },
];

/** 分组预设（用于 AppSelect groups 模式） */
export const UI_FONT_PRESET_GROUPS: FontPresetGroup[] = [
  { groupKey: 'settings:font.groups.system', presets: SYSTEM_FONTS },
  { groupKey: 'settings:font.groups.english', presets: ENGLISH_FONTS },
  { groupKey: 'settings:font.groups.sans_serif', presets: SANS_SERIF_FONTS },
  { groupKey: 'settings:font.groups.serif', presets: SERIF_FONTS },
  { groupKey: 'settings:font.groups.handwriting', presets: HANDWRITING_FONTS },
  { groupKey: 'settings:font.groups.monospace', presets: MONOSPACE_FONTS },
];

/** 扁平化预设列表（兼容旧代码） */
export const UI_FONT_PRESETS: FontPreset[] = [
  ...SYSTEM_FONTS,
  ...ENGLISH_FONTS,
  ...SANS_SERIF_FONTS,
  ...SERIF_FONTS,
  ...HANDWRITING_FONTS,
  ...MONOSPACE_FONTS,
];

// 字体 value 到 family 的映射（用于快速查找）
export const UI_FONT_FAMILY_MAP: Record<string, string> = Object.fromEntries(
  UI_FONT_PRESETS.map(p => [p.value, p.family])
);

/**
 * 根据字体 value 获取 font-family CSS 值
 */
export const getFontFamilyByValue = (value: string): string => {
  return UI_FONT_FAMILY_MAP[value] ?? UI_FONT_FAMILY_MAP[DEFAULT_UI_FONT];
};

/**
 * 应用字体到 CSS 变量
 */
export const applyFontToDocument = (fontValue: string): void => {
  const fontFamily = getFontFamilyByValue(fontValue);
  document.documentElement.style.setProperty('--font-family', fontFamily);
};

/**
 * 应用字号缩放到 CSS 变量
 */
export const applyFontSizeToDocument = (scale: number): void => {
  if (!Number.isFinite(scale)) return;
  document.documentElement.style.setProperty('--font-size-scale', scale.toString());
};

export const clampFontSize = (value: number): number => {
  if (!Number.isFinite(value)) return DEFAULT_UI_FONT_SIZE;
  return Math.min(MAX_UI_FONT_SIZE, Math.max(MIN_UI_FONT_SIZE, value));
};
