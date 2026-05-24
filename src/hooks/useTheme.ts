/**
 * 主题管理 Hook
 *
 * 职责：只负责切换主题，不定义颜色值
 * - 颜色值由 CSS (shadcn-variables.css) 定义
 * - 文本由 i18n (locales) 定义
 * - 自选色号 (custom) 由运行时动态注入 CSS 变量
 */

import { useState, useEffect, useMemo, useCallback } from 'react';

export type ThemeMode = 'light' | 'dark' | 'auto';

/**
 * 调色板类型
 */
export type ThemePalette =
  | 'default'    // 极光蓝
  | 'purple'     // 薰衣紫
  | 'green'      // 森林绿
  | 'orange'     // 日落橙
  | 'pink'       // 玫瑰粉
  | 'teal'       // 青碧色
  | 'muted'      // 柔和色调
  | 'paper'      // 纸纹质感
  | 'custom';    // 自选色号

/** 预设调色板（不含 custom） */
export const PRESET_PALETTES: ThemePalette[] = [
  'default', 'purple', 'green', 'orange', 'pink', 'teal', 'muted', 'paper'
];

/** 所有调色板 */
export const ALL_PALETTES: ThemePalette[] = [...PRESET_PALETTES, 'custom'];

/** @deprecated 使用 ALL_PALETTES */
export const COLOR_PALETTES = ALL_PALETTES;

/** @deprecated 使用 ALL_PALETTES */
export const SPECIAL_PALETTES: ThemePalette[] = [];

/**
 * Accent 预览颜色（用于 UI 圆点显示）
 *
 * Phase 3.1：这些 hex 仅用于 AccentPicker 的圆点背景色，**不再**
 * 参与真实主题渲染。真实主题色由 shadcn-variables.css 里对应的
 * `[data-theme-palette="..."]` 规则块定义的 HSL 三元组决定。
 *
 * 保持这些 hex 与 CSS 变量视觉接近即可，不需要精确匹配；
 * 任何小偏差只影响设置页的圆点示例，不影响实际运行中的界面。
 */
export const PALETTE_PREVIEW_COLORS: Record<string, string> = {
  default: '#1e62b8',
  purple: '#5e33a3',
  green: '#2b7352',
  orange: '#9f5014',
  pink: '#9d2a59',
  teal: '#247078',
  muted: '#445a7e',
  paper: '#473c37',
};

// ============ 颜色工具函数 ============

function hexToHsl(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return [217, 91, 40];
  let r = parseInt(result[1], 16) / 255;
  let g = parseInt(result[2], 16) / 255;
  let b = parseInt(result[3], 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

function clampPercent(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 仅生成 accent 相关的 CSS 变量（不动中性色 / 背景 / 边框 / 文本）。
 *
 * 设计约束（Phase 3.1）：
 * - 自选色必须只影响 --primary / --primary-foreground / --ring 以及派生的 --brand-primary / --primary-color。
 * - 禁止改写 --background / --card / --muted / --border / --input / --foreground 等中性 token。
 * - --primary-foreground 在浅/深模式各自固定一个高对比度前景色，避免低对比度组合。
 */
function generateCustomThemeVars(hex: string, isDark: boolean): Record<string, string> {
  const [h, s, l] = hexToHsl(hex);
  const hue = h;
  const primaryS = clampPercent(s, 48, 76);

  if (isDark) {
    // 暗色模式下把主色亮度抬高，保证在深底上可读
    const primaryL = clampPercent(l + 18, 66, 74);
    return {
      '--primary': `${hue} ${primaryS}% ${primaryL}%`,
      '--primary-foreground': '220 30% 10%',
      '--ring': `${hue} ${Math.max(38, primaryS - 8)}% ${Math.max(60, primaryL - 6)}%`,
      '--brand-primary': `var(--primary)`,
      '--brand-primary-dark': `${hue} ${primaryS}% ${Math.min(primaryL + 10, 84)}%`,
      '--primary-color': 'hsl(var(--primary))',
    };
  }

  // 浅色模式下保留原有的降亮度策略
  const primaryL = clampPercent(l - 6, 32, 42);
  return {
    '--primary': `${hue} ${primaryS}% ${primaryL}%`,
    '--primary-foreground': '0 0% 100%',
    '--ring': `${hue} ${Math.max(38, primaryS - 8)}% ${Math.min(primaryL + 6, 50)}%`,
    '--brand-primary': `var(--primary)`,
    '--brand-primary-dark': `${hue} ${primaryS}% ${Math.max(primaryL - 12, 20)}%`,
    '--primary-color': 'hsl(var(--primary))',
  };
}

const CUSTOM_THEME_VARS = [
  '--primary', '--primary-foreground', '--ring',
  '--brand-primary', '--brand-primary-dark', '--primary-color',
];

function applyCustomThemeVars(hex: string, isDark: boolean) {
  const root = document.documentElement;
  const vars = generateCustomThemeVars(hex, isDark);
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value);
  }
}

function clearCustomThemeVars() {
  const root = document.documentElement;
  for (const key of CUSTOM_THEME_VARS) {
    root.style.removeProperty(key);
  }
}

// ============ 内部实现 ============

interface ThemeState {
  mode: ThemeMode;
  isSystemDark: boolean;
  palette: ThemePalette;
  customColor: string;
}

const STORAGE_KEYS = {
  mode: 'dstu-theme-mode',
  palette: 'dstu-theme-palette',
  customColor: 'dstu-theme-custom-color',
} as const;

const LEGACY_STORAGE_KEYS = {
  mode: 'aimm-theme-mode',
  palette: 'aimm-theme-palette',
} as const;

const DEFAULT_CUSTOM_COLOR = '#6366f1';

/** 迁移旧版存储键 */
const migrateLegacyStorageKeys = () => {
  try {
    const oldMode = localStorage.getItem(LEGACY_STORAGE_KEYS.mode);
    if (oldMode && !localStorage.getItem(STORAGE_KEYS.mode)) {
      localStorage.setItem(STORAGE_KEYS.mode, oldMode);
      localStorage.removeItem(LEGACY_STORAGE_KEYS.mode);
    }
    const oldPalette = localStorage.getItem(LEGACY_STORAGE_KEYS.palette);
    if (oldPalette && !localStorage.getItem(STORAGE_KEYS.palette)) {
      localStorage.setItem(STORAGE_KEYS.palette, oldPalette);
      localStorage.removeItem(LEGACY_STORAGE_KEYS.palette);
    }
  } catch {
    // 静默失败
  }
};

const isValidPalette = (value: unknown): value is ThemePalette =>
  ALL_PALETTES.includes(value as ThemePalette);

const DARK_CLASS = 'dark';

/**
 * 应用主题到 DOM
 * 只设置属性和类名，颜色由 CSS 规则匹配
 * custom 调色板额外注入动态 CSS 变量
 */
const applyThemeToDom = (isDark: boolean, palette: ThemePalette, customColor?: string) => {
  const root = document.documentElement;

  root.setAttribute('data-theme', isDark ? 'dark' : 'light');
  root.setAttribute('data-theme-palette', palette);
  root.dataset.themePalette = palette;

  root.classList.toggle(DARK_CLASS, isDark);

  document.body.classList.remove('light-theme', 'dark-theme');
  document.body.classList.add(isDark ? 'dark-theme' : 'light-theme');

  root.style.colorScheme = isDark ? 'dark' : 'light';

  if (palette === 'custom' && customColor) {
    applyCustomThemeVars(customColor, isDark);
  } else {
    clearCustomThemeVars();
  }
};

export const useTheme = () => {
  const [themeState, setThemeState] = useState<ThemeState>(() => {
    migrateLegacyStorageKeys();

    const savedMode = (localStorage.getItem(STORAGE_KEYS.mode) as ThemeMode) || 'auto';
    let storedPalette = localStorage.getItem(STORAGE_KEYS.palette);

    // 兼容旧版：colorsafe/accessible 统一迁移到 muted
    if (storedPalette === 'colorsafe' || storedPalette === 'accessible') {
      storedPalette = 'muted';
    }

    const savedPalette = isValidPalette(storedPalette) ? storedPalette : 'default';
    const savedCustomColor = localStorage.getItem(STORAGE_KEYS.customColor) || DEFAULT_CUSTOM_COLOR;
    const isSystemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

    const initialIsDark = savedMode === 'dark' ? true
      : savedMode === 'light' ? false
      : isSystemDark;

    applyThemeToDom(initialIsDark, savedPalette, savedCustomColor);

    return { mode: savedMode, isSystemDark, palette: savedPalette, customColor: savedCustomColor };
  });

  const resolvedIsDark = useMemo(() => {
    if (themeState.mode === 'dark') return true;
    if (themeState.mode === 'light') return false;
    return themeState.isSystemDark;
  }, [themeState]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      setThemeState(prev => ({ ...prev, isSystemDark: e.matches }));
    };

    mediaQuery.addEventListener?.('change', handler) ?? mediaQuery.addListener?.(handler);
    return () => {
      mediaQuery.removeEventListener?.('change', handler) ?? mediaQuery.removeListener?.(handler);
    };
  }, []);

  useEffect(() => {
    const handleThemeModeChanged = (event: Event) => {
      const mode = (event as CustomEvent<{ mode?: ThemeMode }>).detail?.mode;
      if (mode !== 'light' && mode !== 'dark' && mode !== 'auto') return;
      setThemeState(prev => ({ ...prev, mode }));
    };

    window.addEventListener('dstu-theme-mode-changed', handleThemeModeChanged as EventListener);
    return () => {
      window.removeEventListener('dstu-theme-mode-changed', handleThemeModeChanged as EventListener);
    };
  }, []);

  useEffect(() => {
    applyThemeToDom(resolvedIsDark, themeState.palette, themeState.customColor);
  }, [resolvedIsDark, themeState.palette, themeState.customColor]);

  const setThemeMode = useCallback((mode: ThemeMode) => {
    setThemeState(prev => {
      const newIsDark = mode === 'dark' ? true : mode === 'light' ? false : prev.isSystemDark;
      applyThemeToDom(newIsDark, prev.palette, prev.customColor);
      return { ...prev, mode };
    });
    try { localStorage.setItem(STORAGE_KEYS.mode, mode); } catch {}
  }, []);

  const setThemePalette = useCallback((palette: ThemePalette) => {
    setThemeState(prev => {
      const isDark = prev.mode === 'dark' ? true : prev.mode === 'light' ? false : prev.isSystemDark;
      applyThemeToDom(isDark, palette, prev.customColor);
      return { ...prev, palette };
    });
    try { localStorage.setItem(STORAGE_KEYS.palette, palette); } catch {}
  }, []);

  const setCustomColor = useCallback((color: string) => {
    setThemeState(prev => {
      const isDark = prev.mode === 'dark' ? true : prev.mode === 'light' ? false : prev.isSystemDark;
      const newState = { ...prev, customColor: color, palette: 'custom' as ThemePalette };
      applyThemeToDom(isDark, 'custom', color);
      return newState;
    });
    try {
      localStorage.setItem(STORAGE_KEYS.customColor, color);
      localStorage.setItem(STORAGE_KEYS.palette, 'custom');
    } catch {}
  }, []);

  const toggleDarkMode = useCallback(() => {
    setThemeMode(resolvedIsDark ? 'light' : 'dark');
  }, [resolvedIsDark, setThemeMode]);

  return {
    mode: themeState.mode,
    isDarkMode: resolvedIsDark,
    isSystemDark: themeState.isSystemDark,
    palette: themeState.palette,
    customColor: themeState.customColor,
    setThemeMode,
    setThemePalette,
    setCustomColor,
    toggleDarkMode,
  };
};

export default useTheme;
