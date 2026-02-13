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
 * 调色板预览色（用于 UI 显示）
 * 颜色主题：精确匹配 CSS --primary 值
 * 特殊主题：代表调色板整体"感觉"
 * custom 的预览色在运行时由 customColor 决定
 */
export const PALETTE_PREVIEW_COLORS: Record<string, string> = {
  default: '#0952c6',   // hsl(217, 91%, 40%)
  purple: '#8b5cf6',    // hsl(262, 83%, 58%)
  green: '#1a9a4a',     // hsl(142, 71%, 35%)
  orange: '#f97316',    // hsl(24, 95%, 50%)
  pink: '#e72478',      // hsl(340, 82%, 52%)
  teal: '#1b9898',      // hsl(180, 70%, 35%)
  muted: '#6078b8',     // hsl(220, 25%, 50%)
  paper: '#c9a96e',     // hsl(36, 40%, 70%) 暖金代表纸质感
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

function generateCustomThemeVars(hex: string, isDark: boolean): Record<string, string> {
  const [h, s, l] = hexToHsl(hex);
  const hue = h;

  if (isDark) {
    const primaryL = Math.max(50, Math.min(l + 15, 70));
    const primaryS = Math.max(50, s);
    return {
      '--titlebar-background': `${hue} 5% 22%`,
      '--nav-background': `${hue} 5% 11%`,
      '--background': `${hue} 5% 14%`,
      '--foreground': `${hue} 5% 82%`,
      '--card': `${hue} 5% 17%`,
      '--card-foreground': `${hue} 5% 82%`,
      '--popover': `${hue} 5% 18%`,
      '--popover-foreground': `${hue} 5% 82%`,
      '--secondary': `${hue} 5% 20%`,
      '--secondary-foreground': `${hue} 5% 82%`,
      '--muted': `${hue} 5% 20%`,
      '--muted-foreground': `${hue} 5% 55%`,
      '--accent': `${hue} 5% 23%`,
      '--accent-foreground': `${hue} 5% 82%`,
      '--destructive': '0 55% 45%',
      '--destructive-foreground': '0 0% 100%',
      '--border': `${hue} 5% 23%`,
      '--input': `${hue} 5% 20%`,
      '--primary': `${hue} ${primaryS}% ${primaryL}%`,
      '--primary-foreground': '0 0% 100%',
      '--ring': `${hue} ${primaryS}% ${primaryL}%`,
      '--success': '152 55% 42%',
      '--success-foreground': '144 100% 10%',
      '--warning': '38 65% 50%',
      '--warning-foreground': '40 100% 10%',
      '--info': `${hue} ${Math.max(40, primaryS - 20)}% ${Math.min(primaryL + 5, 65)}%`,
      '--info-foreground': `${hue} 100% 10%`,
      '--danger': '0 50% 48%',
      '--danger-foreground': '0 0% 98%',
      '--brand-primary': `var(--primary)`,
      '--brand-secondary': `var(--secondary)`,
      '--brand-accent': `var(--accent)`,
      '--brand-primary-dark': `${hue} ${primaryS}% ${Math.min(primaryL + 20, 85)}%`,
      '--primary-color': 'hsl(var(--primary))',
    };
  }

  const primaryL = Math.max(30, Math.min(l, 55));
  const primaryS = Math.max(60, s);
  return {
    '--titlebar-background': `${hue} 6% 96%`,
    '--nav-background': `${hue} 6% 88%`,
    '--background': `${hue} 6% 92%`,
    '--foreground': `${hue} 10% 18%`,
    '--card': `${hue} 6% 94%`,
    '--card-foreground': `${hue} 10% 18%`,
    '--popover': `${hue} 6% 96%`,
    '--popover-foreground': `${hue} 10% 18%`,
    '--secondary': `${hue} 6% 89%`,
    '--secondary-foreground': `${hue} 10% 18%`,
    '--muted': `${hue} 6% 89%`,
    '--muted-foreground': `${hue} 6% 42%`,
    '--accent': `${hue} 6% 85%`,
    '--accent-foreground': `${hue} 10% 18%`,
    '--destructive': '0 65% 51%',
    '--destructive-foreground': '0 0% 100%',
    '--border': `${hue} 6% 82%`,
    '--input': `${hue} 6% 85%`,
    '--primary': `${hue} ${primaryS}% ${primaryL}%`,
    '--primary-foreground': '0 0% 100%',
    '--ring': `${hue} ${primaryS}% ${primaryL}%`,
    '--success': '152 60% 36%',
    '--success-foreground': '0 0% 100%',
    '--warning': '38 70% 45%',
    '--warning-foreground': '0 0% 100%',
    '--info': `${hue} ${Math.max(40, primaryS - 20)}% ${Math.min(primaryL + 10, 58)}%`,
    '--info-foreground': '0 0% 100%',
    '--danger': '0 55% 50%',
    '--danger-foreground': '0 0% 100%',
    '--brand-primary': `var(--primary)`,
    '--brand-secondary': `var(--secondary)`,
    '--brand-accent': `var(--accent)`,
    '--brand-primary-dark': `${hue} ${primaryS}% ${Math.max(primaryL - 15, 18)}%`,
    '--primary-color': 'hsl(var(--primary))',
  };
}

const CUSTOM_THEME_VARS = [
  '--titlebar-background', '--nav-background', '--background', '--foreground',
  '--card', '--card-foreground', '--popover', '--popover-foreground',
  '--secondary', '--secondary-foreground', '--muted', '--muted-foreground',
  '--accent', '--accent-foreground', '--destructive', '--destructive-foreground',
  '--border', '--input', '--primary', '--primary-foreground', '--ring',
  '--success', '--success-foreground', '--warning', '--warning-foreground',
  '--info', '--info-foreground', '--danger', '--danger-foreground',
  '--brand-primary', '--brand-secondary', '--brand-accent',
  '--brand-primary-dark', '--primary-color',
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
