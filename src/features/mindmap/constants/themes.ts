import type { Theme } from '../types';

export const DARK_THEME: Theme = {
  id: 'dark',
  name: 'themes.notionDark',
  colors: {
    background: '#191919',
    foreground: 'rgba(255, 255, 255, 0.9)',
    primary: '#2EAADC',
    primaryForeground: '#FFFFFF',
    secondary: '#252525',
    secondaryForeground: 'rgba(255, 255, 255, 0.65)',
    muted: '#2F2F2F',
    mutedForeground: 'rgba(255, 255, 255, 0.45)',
    border: 'rgba(255, 255, 255, 0.09)',
    accent: '#2EAADC',
  },
  node: {
    root: {
      background: '#2EAADC',
      foreground: '#FFFFFF',
      border: 'transparent',
      borderRadius: 6,
      fontSize: 16,
      fontWeight: '600',
      padding: '10px 20px',
    },
    branch: {
      background: '#252525',
      foreground: 'rgba(255, 255, 255, 0.9)',
      border: 'rgba(255, 255, 255, 0.09)',
      borderRadius: 4,
      fontSize: 14,
      padding: '6px 12px',
    },
    leaf: {
      background: 'transparent',
      foreground: 'rgba(255, 255, 255, 0.9)',
      border: 'transparent',
      borderRadius: 4,
      fontSize: 14,
      padding: '4px 8px',
    },
  },
  edge: {
    stroke: 'rgba(255, 255, 255, 0.15)',
    strokeWidth: 1.5,
  },
};

export const LIGHT_THEME: Theme = {
  id: 'light',
  name: 'themes.notionLight',
  colors: {
    background: '#FFFFFF',
    foreground: '#37352F',
    primary: '#2EAADC',
    primaryForeground: '#FFFFFF',
    secondary: '#F7F6F3',
    secondaryForeground: 'rgba(55, 53, 47, 0.65)',
    muted: '#F7F6F3',
    mutedForeground: 'rgba(55, 53, 47, 0.45)',
    border: 'rgba(55, 53, 47, 0.09)',
    accent: '#2EAADC',
  },
  node: {
    root: {
      background: '#FFFFFF',
      foreground: '#37352F',
      border: '2px solid #37352F',
      borderRadius: 6,
      fontSize: 18,
      fontWeight: '600',
      padding: '10px 20px',
    },
    branch: {
      background: '#FFFFFF',
      foreground: '#37352F',
      border: '1px solid rgba(55, 53, 47, 0.16)',
      borderRadius: 4,
      fontSize: 15,
      padding: '6px 12px',
    },
    leaf: {
      background: 'transparent',
      foreground: '#37352F',
      border: 'transparent',
      borderRadius: 4,
      fontSize: 14,
      padding: '4px 8px',
    },
  },
  edge: {
    stroke: 'rgba(55, 53, 47, 0.16)',
    strokeWidth: 1.5,
  },
};

export const MINIMAL_THEME: Theme = {
  id: 'minimal',
  name: 'themes.minimalWhite',
  colors: {
    background: '#FFFFFF',
    foreground: '#37352F',
    primary: '#000000',
    primaryForeground: '#FFFFFF',
    secondary: '#F7F6F3',
    secondaryForeground: '#787774',
    muted: '#F7F6F3',
    mutedForeground: '#9B9A97',
    border: '#E0E0E0',
    accent: '#000000',
  },
  node: {
    root: {
      background: '#000000',
      foreground: '#FFFFFF',
      border: 'transparent',
      borderRadius: 4,
      fontSize: 16,
      fontWeight: '600',
      padding: '8px 16px',
    },
    branch: {
      background: '#FFFFFF',
      foreground: '#37352F',
      border: '1px solid #E0E0E0',
      borderRadius: 4,
      fontSize: 14,
      padding: '6px 12px',
    },
    leaf: {
      background: 'transparent',
      foreground: '#37352F',
      border: 'transparent',
      borderRadius: 4,
      fontSize: 14,
      padding: '4px 8px',
    },
  },
  edge: {
    stroke: '#E0E0E0',
    strokeWidth: 1,
  },
};

/** 极简主题 - 暗色变体 */
export const MINIMAL_DARK_THEME: Theme = {
  id: 'minimal-dark',
  name: 'themes.minimalBlack',
  colors: {
    background: '#1a1a1a',
    foreground: 'rgba(255, 255, 255, 0.9)',
    primary: '#FFFFFF',
    primaryForeground: '#000000',
    secondary: '#2a2a2a',
    secondaryForeground: 'rgba(255, 255, 255, 0.6)',
    muted: '#2a2a2a',
    mutedForeground: 'rgba(255, 255, 255, 0.45)',
    border: 'rgba(255, 255, 255, 0.12)',
    accent: '#FFFFFF',
  },
  node: {
    root: {
      background: '#FFFFFF',
      foreground: '#000000',
      border: 'transparent',
      borderRadius: 4,
      fontSize: 16,
      fontWeight: '600',
      padding: '8px 16px',
    },
    branch: {
      background: '#252525',
      foreground: 'rgba(255, 255, 255, 0.9)',
      border: '1px solid rgba(255, 255, 255, 0.12)',
      borderRadius: 4,
      fontSize: 14,
      padding: '6px 12px',
    },
    leaf: {
      background: 'transparent',
      foreground: 'rgba(255, 255, 255, 0.9)',
      border: 'transparent',
      borderRadius: 4,
      fontSize: 14,
      padding: '4px 8px',
    },
  },
  edge: {
    stroke: 'rgba(255, 255, 255, 0.12)',
    strokeWidth: 1,
  },
};

export const BUILTIN_THEMES: Theme[] = [
  LIGHT_THEME,
  DARK_THEME,
  MINIMAL_THEME,
  MINIMAL_DARK_THEME,
];

/** @deprecated 使用 getThemeForMode 代替 */
export function getTheme(id: string): Theme {
  return BUILTIN_THEMES.find(t => t.id === id) || LIGHT_THEME;
}

/**
 * 暗色变体映射：themeId → 对应的暗色变体 id
 * 已经是暗色的主题不需要映射
 */
const DARK_VARIANT_MAP: Record<string, string> = {
  light: 'dark',
  minimal: 'minimal-dark',
};

/**
 * 根据应用主题模式获取合适的思维导图主题
 *
 * @param id     用户选择的主题 id（如 'light', 'dark', 'minimal'）
 * @param isDark 当前应用是否处于暗色模式
 * @returns      适配当前模式的 Theme 对象
 */
export function getThemeForMode(id: string, isDark: boolean): Theme {
  if (isDark) {
    const darkId = DARK_VARIANT_MAP[id];
    if (darkId) {
      return BUILTIN_THEMES.find(t => t.id === darkId) || DARK_THEME;
    }
  }
  return BUILTIN_THEMES.find(t => t.id === id) || (isDark ? DARK_THEME : LIGHT_THEME);
}
