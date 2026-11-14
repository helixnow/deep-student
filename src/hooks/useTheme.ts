/**
 * 主题管理 Hook
 *
 * 职责：只负责切换主题，不定义颜色值
 * - 颜色值由 CSS (shadcn-variables.css) 定义
 * - 文本由 i18n (locales) 定义
 * - 自选色号 (custom) 由运行时动态注入 CSS 变量
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useEventRegistry } from './useEventRegistry';
import { getSetting, saveSetting } from '@/utils/settingsApi';

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
  | 'bright-pink' // 明亮粉
  | 'teal'       // 青碧色
  | 'muted'      // 柔和色调
  | 'paper'      // 纸纹质感
  | 'custom';    // 自选色号

/** 预设调色板（不含 custom） */
export const PRESET_PALETTES: ThemePalette[] = [
  'default', 'purple', 'green', 'orange', 'pink', 'bright-pink', 'teal', 'muted', 'paper'
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
  'bright-pink': '#fb7299',
  teal: '#247078',
  muted: '#445a7e',
  paper: '#473c37',
};

// ============ 颜色工具函数 ============

function hexToHsl(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return [217, 91, 40];
  const r = parseInt(result[1], 16) / 255;
  const g = parseInt(result[2], 16) / 255;
  const b = parseInt(result[3], 16) / 255;
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

/**
 * SQLite `settings` 中的自选色号副本。
 *
 * localStorage 仍是运行时权威源；SQLite 副本用于 Tauri→Electron origin 变更、
 * Android WebView 缓存清理等 localStorage 整块丢失后的回填。
 */
const THEME_CUSTOM_COLOR_SETTING_KEY = 'theme_custom_color';

/** 校验 #RRGGBB（回填只接受与 color input 同格式的值） */
const isHexColor = (value: unknown): value is string =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

/** 全页共享一次 SQLite 读取（多个 useTheme 实例复用同一 Promise） */
let customColorSqliteRead: Promise<string | null> | null = null;

function readCustomColorFromSettings(): Promise<string | null> {
  if (!customColorSqliteRead) {
    customColorSqliteRead = getSetting(THEME_CUSTOM_COLOR_SETTING_KEY)
      .then((stored) => (isHexColor(stored) ? stored : null))
      .catch((error: unknown) => {
        console.warn('[useTheme] Failed to hydrate theme_custom_color:', error);
        return null;
      });
  }
  return customColorSqliteRead;
}

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

const isValidThemeMode = (value: unknown): value is ThemeMode =>
  value === 'light' || value === 'dark' || value === 'auto';

function readStoredThemeSnapshot(): Pick<ThemeState, 'mode' | 'palette' | 'customColor'> {
  const rawMode = localStorage.getItem(STORAGE_KEYS.mode);
  const mode: ThemeMode = isValidThemeMode(rawMode) ? rawMode : 'auto';
  let storedPalette = localStorage.getItem(STORAGE_KEYS.palette);

  // 兼容旧版：colorsafe/accessible 统一迁移到 muted
  if (storedPalette === 'colorsafe' || storedPalette === 'accessible') {
    storedPalette = 'muted';
  }

  const palette = isValidPalette(storedPalette) ? storedPalette : 'default';
  const customColor = localStorage.getItem(STORAGE_KEYS.customColor) || DEFAULT_CUSTOM_COLOR;
  return { mode, palette, customColor };
}

const DARK_CLASS = 'dark';

const THEME_TRANSITION_CLASS = 'theme-transitioning';
const THEME_TRANSITION_FALLBACK_MS = 220;

let themeTransitionTimer: ReturnType<typeof setTimeout> | null = null;

/** 读取 CSS 变量中的主题过渡时长（毫秒），解析失败时使用兜底值 */
const readThemeTransitionDurationMs = (root: HTMLElement): number => {
  const raw = getComputedStyle(root).getPropertyValue('--theme-transition-dur').trim();
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return THEME_TRANSITION_FALLBACK_MS;
  // 兼容 "220ms" 与 "0.22s" 两种写法
  return raw.endsWith('ms') ? parsed : raw.endsWith('s') ? parsed * 1000 : parsed;
};

/**
 * 亮暗切换瞬间在 <html> 上挂临时 class（样式见 src/shared/styles/app.css），
 * 让全局颜色属性短暂平滑过渡；过渡结束后移除，避免常驻 transition 拖慢其他交互。
 * prefers-reduced-motion 下直接跳过。
 */
const runThemeSwitchTransition = (root: HTMLElement) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  root.classList.add(THEME_TRANSITION_CLASS);
  if (themeTransitionTimer !== null) {
    clearTimeout(themeTransitionTimer);
  }
  themeTransitionTimer = setTimeout(() => {
    root.classList.remove(THEME_TRANSITION_CLASS);
    themeTransitionTimer = null;
  }, readThemeTransitionDurationMs(root) + 50);
};

const syncedRootBackgrounds = new WeakMap<HTMLElement, string>();
const syncedBodyBackgrounds = new WeakMap<HTMLElement, string>();

function isTransparentOrEmptyColor(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'transparent') return true;
  if (/^(?:rgba|hsla)\(\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*0(?:\.0+)?\s*\)$/.test(normalized)) {
    return true;
  }
  if (/\/\s*0(?:\.0+)?%?\s*\)$/.test(normalized)) {
    return true;
  }
  return false;
}

/**
 * 采样根元素真实渲染背景色并同步浏览器外壳与状态栏颜色：
 * - 读取 getComputedStyle(doc.documentElement).backgroundColor 真实渲染色
 * - 移除 <meta name="theme-color"> 的 media 属性并动态更新 content（不存在则创建）
 * - 同步 doc.documentElement.style.backgroundColor 与 doc.body.style.backgroundColor，
 *   消除移动端状态栏与底部 Home Indicator 区域橡皮筋露白/露黑
 */
export function syncBrowserChromeColor(doc?: Document): string | null {
  const targetDoc = doc ?? (typeof document !== 'undefined' ? document : undefined);
  if (!targetDoc || !targetDoc.documentElement) {
    return null;
  }

  const win = targetDoc.defaultView ?? (typeof window !== 'undefined' ? window : undefined);
  if (!win || typeof win.getComputedStyle !== 'function') {
    return null;
  }

  const root = targetDoc.documentElement;
  const body = targetDoc.body;

  // 若内联背景色由上一次 syncBrowserChromeColor 写入，先临时剥离以读取最新主题 CSS 规则；
  // 若外部主动指定了新的内联背景色，则保留外部值直接采样
  const prevSyncedRoot = syncedRootBackgrounds.get(root);
  const hadOwnRootInline =
    prevSyncedRoot !== undefined && root.style.backgroundColor === prevSyncedRoot;
  if (hadOwnRootInline) {
    root.style.removeProperty('background-color');
  }

  const prevSyncedBody = body ? syncedBodyBackgrounds.get(body) : undefined;
  const hadOwnBodyInline = Boolean(
    body && prevSyncedBody !== undefined && body.style.backgroundColor === prevSyncedBody,
  );
  if (body && hadOwnBodyInline) {
    body.style.removeProperty('background-color');
  }

  let resolvedColor = win.getComputedStyle(root).backgroundColor?.trim() ?? '';
  if (isTransparentOrEmptyColor(resolvedColor) && body) {
    resolvedColor = win.getComputedStyle(body).backgroundColor?.trim() ?? '';
  }
  if (isTransparentOrEmptyColor(resolvedColor) && hadOwnRootInline && prevSyncedRoot) {
    resolvedColor = prevSyncedRoot;
  }

  if (isTransparentOrEmptyColor(resolvedColor)) {
    return null;
  }

  const existingMetas = Array.from(
    targetDoc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
  );
  if (existingMetas.length === 0) {
    const meta = targetDoc.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    meta.setAttribute('content', resolvedColor);
    (targetDoc.head ?? root).appendChild(meta);
  } else {
    for (const meta of existingMetas) {
      meta.removeAttribute('media');
      meta.setAttribute('content', resolvedColor);
    }
  }

  root.style.backgroundColor = resolvedColor;
  syncedRootBackgrounds.set(root, root.style.backgroundColor);

  if (body) {
    body.style.backgroundColor = resolvedColor;
    syncedBodyBackgrounds.set(body, body.style.backgroundColor);
  }

  return resolvedColor;
}

/**
 * 应用主题到 DOM
 * 只设置属性和类名，颜色由 CSS 规则匹配
 * custom 调色板额外注入动态 CSS 变量，并同步浏览器外壳色
 */
const applyThemeToDom = (isDark: boolean, palette: ThemePalette, customColor?: string) => {
  const root = document.documentElement;

  // 仅在初始化完成后（data-theme 已存在）且亮暗真正翻转时播放全局颜色过渡，
  // 避免应用启动首次应用主题时出现无意义的整屏过渡
  const previousTheme = root.getAttribute('data-theme');
  if (previousTheme !== null && (previousTheme === 'dark') !== isDark) {
    runThemeSwitchTransition(root);
  }

  root.setAttribute('data-boot-theme', isDark ? 'dark' : 'light');
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

  syncBrowserChromeColor(document);
};

export const useTheme = () => {
  const [themeState, setThemeState] = useState<ThemeState>(() => {
    migrateLegacyStorageKeys();

    const { mode: savedMode, palette: savedPalette, customColor: savedCustomColor } =
      readStoredThemeSnapshot();
    const isSystemDark =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? Boolean(window.matchMedia('(prefers-color-scheme: dark)')?.matches)
        : false;

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
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    if (!mediaQuery) return undefined;
    const handler = (e: MediaQueryListEvent) => {
      setThemeState(prev => ({ ...prev, isSystemDark: e.matches }));
    };

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handler);
    } else {
      mediaQuery.addListener?.(handler);
    }
    return () => {
      if (typeof mediaQuery.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', handler);
      } else {
        mediaQuery.removeListener?.(handler);
      }
    };
  }, []);

  // ★ BUG-11: 自选色号 SQLite 回填 —— localStorage 是权威源，只有它缺失时才用副本
  // （Tauri→Electron origin 变更、Android WebView 缓存清理都会让 localStorage 整块丢失）
  useEffect(() => {
    let cancelled = false;
    void readCustomColorFromSettings().then((stored) => {
      if (cancelled || !stored) return;
      try {
        if (localStorage.getItem(STORAGE_KEYS.customColor) !== null) return;
        localStorage.setItem(STORAGE_KEYS.customColor, stored);
      } catch {
        // localStorage 不可用时仍更新内存状态
      }
      setThemeState(prev => {
        if (prev.customColor === stored) return prev;
        const next = { ...prev, customColor: stored };
        if (prev.palette === 'custom') {
          const isDark = prev.mode === 'dark' ? true : prev.mode === 'light' ? false : prev.isSystemDark;
          applyThemeToDom(isDark, 'custom', stored);
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleThemeModeChanged = useCallback((event: Event) => {
    const mode = (event as CustomEvent<{ mode?: ThemeMode }>).detail?.mode;
    if (mode !== 'light' && mode !== 'dark' && mode !== 'auto') return;
    setThemeState(prev => ({ ...prev, mode }));
  }, []);

  const handleThemePaletteChanged = useCallback((event: Event) => {
    const detail = (event as CustomEvent<{ palette?: string; customColor?: string }>).detail;
    const palette = detail?.palette;
    if (!isValidPalette(palette ?? null)) return;
    setThemeState(prev => ({
      ...prev,
      palette: palette as ThemePalette,
      // custom 调色板需要同时同步色号，避免其他实例用旧色号重新覆盖 DOM 变量
      customColor: typeof detail?.customColor === 'string' ? detail.customColor : prev.customColor,
    }));
  }, []);

  const handleStorageChange = useCallback((event: Event) => {
    const storageEvent = event as StorageEvent;
    if (storageEvent.storageArea && storageEvent.storageArea !== window.localStorage) return;
    if (
      storageEvent.key !== null &&
      storageEvent.key !== STORAGE_KEYS.mode &&
      storageEvent.key !== STORAGE_KEYS.palette &&
      storageEvent.key !== STORAGE_KEYS.customColor
    ) {
      return;
    }
    const next = readStoredThemeSnapshot();
    setThemeState(prev => {
      if (
        prev.mode === next.mode &&
        prev.palette === next.palette &&
        prev.customColor === next.customColor
      ) {
        return prev;
      }
      return { ...prev, ...next };
    });
  }, []);

  useEventRegistry(
    [
      { target: 'window', type: 'dstu-theme-mode-changed', listener: handleThemeModeChanged },
      { target: 'window', type: 'dstu-theme-palette-changed', listener: handleThemePaletteChanged },
      { target: 'window', type: 'storage', listener: handleStorageChange },
    ],
    [handleThemeModeChanged, handleThemePaletteChanged, handleStorageChange],
  );

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
    // 广播给其他 useTheme 实例（每个实例持有独立 state，仅靠 DOM 副作用会失同步）
    window.dispatchEvent(new CustomEvent('dstu-theme-mode-changed', { detail: { mode } }));
  }, []);

  const setThemePalette = useCallback((palette: ThemePalette) => {
    setThemeState(prev => {
      const isDark = prev.mode === 'dark' ? true : prev.mode === 'light' ? false : prev.isSystemDark;
      applyThemeToDom(isDark, palette, prev.customColor);
      return { ...prev, palette };
    });
    try { localStorage.setItem(STORAGE_KEYS.palette, palette); } catch {}
    window.dispatchEvent(new CustomEvent('dstu-theme-palette-changed', { detail: { palette } }));
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
    // ★ BUG-11: 镜像到 SQLite settings，localStorage 整块丢失后仍能回填自选色号
    void saveSetting(THEME_CUSTOM_COLOR_SETTING_KEY, color).catch((error: unknown) => {
      console.warn('[useTheme] Failed to persist theme_custom_color:', error);
    });
    window.dispatchEvent(
      new CustomEvent('dstu-theme-palette-changed', { detail: { palette: 'custom', customColor: color } }),
    );
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
