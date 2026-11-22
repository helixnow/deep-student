/**
 * liquidGlassAppearanceStore — macOS 27 Liquid Glass 连续通透度滑块 store
 * ---------------------------------------------------------------------------
 * - 维护 `clarity`（0–100，默认 55），持久化于 localStorage；
 * - 0 = 磨砂护眼（较高不透明底 + 柔和深模糊 + 低边光），
 *   100 = 极透液态玻璃（低不透明底 + 锐利通透模糊 + 高折射边光）；
 * - 应用到 `:root` 时实时调节 `--wb-glass-clarity`、`--wb-dock-bg`、
 *   `--wb-menubar-bg`、`--wb-glass-bg`、`--wb-glass-bg-strong`、
 *   `--wb-glass-blur`、`--wb-glass-blur-strong`、`--wb-glass-rim` 等；
 * - 尊重 `prefers-reduced-transparency: reduce` 及 `reduced`/`minimal` 材质档：
 *   降级态下清除内联覆写，由 workbench.tokens.css 的降级块全权接管。
 */
import { create } from 'zustand';

export const GLASS_CLARITY_STORAGE_KEY = 'desktop.workbenchGlassClarity';
export const DEFAULT_GLASS_CLARITY = 55;
export const MIN_GLASS_CLARITY = 0;
export const MAX_GLASS_CLARITY = 100;

const REDUCED_TRANSPARENCY_QUERY = '(prefers-reduced-transparency: reduce)';

const DYNAMIC_GLASS_VARS = [
  '--wb-glass-bg',
  '--wb-glass-bg-strong',
  '--wb-dock-bg',
  '--wb-menubar-bg',
  '--wb-glass-blur',
  '--wb-glass-blur-strong',
  '--wb-glass-rim',
  '--wb-glass-highlight',
] as const;

function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

function roundTo(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

/** 归一到 [0, 100] 整数；非法/NaN 回退默认值 55 */
export function clampGlassClarity(value: unknown): number {
  const num =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(num)) return DEFAULT_GLASS_CLARITY;
  return Math.round(Math.min(MAX_GLASS_CLARITY, Math.max(MIN_GLASS_CLARITY, num)));
}

export function readStoredGlassClarity(): number {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_GLASS_CLARITY;
    const raw = localStorage.getItem(GLASS_CLARITY_STORAGE_KEY);
    if (raw === null) return DEFAULT_GLASS_CLARITY;
    return clampGlassClarity(raw);
  } catch {
    return DEFAULT_GLASS_CLARITY;
  }
}

function persistGlassClarity(clarity: number): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(GLASS_CLARITY_STORAGE_KEY, String(clarity));
    }
  } catch {
    // 隐私模式或存储配额满时保持会话内生效
  }
}

export function isReducedTransparencyPreferred(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return Boolean(window.matchMedia(REDUCED_TRANSPARENCY_QUERY)?.matches);
  } catch {
    return false;
  }
}

export interface ComputedGlassAppearance {
  clarity: number;
  ratio: number;
  reduced: boolean;
  vars: Record<string, string>;
}

/**
 * 纯函数：根据 clarity（0–100）与明暗/降透明状态计算 `:root` CSS 变量表。
 */
export function computeGlassAppearanceTokens(
  clarity: number,
  options?: { isDark?: boolean; reducedTransparency?: boolean },
): ComputedGlassAppearance {
  const clamped = clampGlassClarity(clarity);
  const ratio = roundTo(clamped / 100, 2);
  const reduced = Boolean(options?.reducedTransparency);
  const isDark = Boolean(options?.isDark);

  if (reduced) {
    return {
      clarity: clamped,
      ratio,
      reduced: true,
      vars: {
        '--wb-glass-clarity': String(clamped),
        '--wb-glass-clarity-ratio': String(ratio),
      },
    };
  }

  const glassAlpha = roundTo(isDark ? lerp(0.56, 0.18, ratio) : lerp(0.42, 0.10, ratio), 3);
  const glassStrongAlpha = roundTo(isDark ? lerp(0.66, 0.26, ratio) : lerp(0.54, 0.18, ratio), 3);
  const dockAlpha = roundTo(isDark ? lerp(0.62, 0.24, ratio) : lerp(0.50, 0.16, ratio), 3);
  const menubarAlpha = roundTo(isDark ? lerp(0.36, 0.08, ratio) : lerp(0.26, 0.04, ratio), 3);

  const blurPx = Math.round(lerp(26, 12, ratio));
  const blurStrongPx = Math.round(lerp(32, 16, ratio));
  const saturate = roundTo(isDark ? lerp(1.4, 2.05, ratio) : lerp(1.45, 2.1, ratio), 2);
  const saturateStrong = roundTo(saturate + 0.05, 2);
  const brightness = roundTo(isDark ? lerp(0.95, 0.9, ratio) : lerp(1.03, 1.12, ratio), 2);
  const rimAlpha = roundTo(isDark ? lerp(0.14, 0.36, ratio) : lerp(0.28, 0.72, ratio), 2);

  return {
    clarity: clamped,
    ratio,
    reduced: false,
    vars: {
      '--wb-glass-clarity': String(clamped),
      '--wb-glass-clarity-ratio': String(ratio),
      '--wb-glass-bg': `hsl(var(--card) / ${glassAlpha})`,
      '--wb-glass-bg-strong': `hsl(var(--card) / ${glassStrongAlpha})`,
      '--wb-dock-bg': `hsl(var(--card) / ${dockAlpha})`,
      '--wb-menubar-bg': `hsl(var(--card) / ${menubarAlpha})`,
      '--wb-glass-blur': `blur(${blurPx}px) saturate(${saturate}) brightness(${brightness})`,
      '--wb-glass-blur-strong': `blur(${blurStrongPx}px) saturate(${saturateStrong}) brightness(${brightness})`,
      '--wb-glass-rim': `rgba(255, 255, 255, ${rimAlpha})`,
      '--wb-glass-highlight': 'var(--wb-glass-rim)',
    },
  };
}

/** 将当前通透度应用到 `:root`；降透明或 reduced/minimal 材质档下自动撤除内联玻璃覆写 */
export function applyLiquidGlassAppearance(clarity?: number): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  const root = document.documentElement;
  const targetClarity = clampGlassClarity(
    clarity ?? useLiquidGlassAppearanceStore.getState().clarity,
  );
  const material = root.getAttribute('data-wb-material');
  const reduced =
    isReducedTransparencyPreferred() || material === 'reduced' || material === 'minimal';
  const isDark = root.classList.contains('dark');

  const computed = computeGlassAppearanceTokens(targetClarity, {
    isDark,
    reducedTransparency: reduced,
  });

  root.dataset.wbGlassClarity = String(computed.clarity);

  if (computed.reduced) {
    for (const key of DYNAMIC_GLASS_VARS) {
      root.style.removeProperty(key);
    }
    root.style.setProperty('--wb-glass-clarity', String(computed.clarity));
    root.style.setProperty('--wb-glass-clarity-ratio', String(computed.ratio));
    return;
  }

  for (const [key, value] of Object.entries(computed.vars)) {
    if (root.style.getPropertyValue(key) !== value) {
      root.style.setProperty(key, value);
    }
  }
}

interface LiquidGlassAppearanceState {
  clarity: number;
  setClarity: (value: number) => void;
  resetClarity: () => void;
}

export const useLiquidGlassAppearanceStore = create<LiquidGlassAppearanceState>((set) => ({
  clarity: readStoredGlassClarity(),
  setClarity: (value: number) => {
    const clamped = clampGlassClarity(value);
    persistGlassClarity(clamped);
    set({ clarity: clamped });
    applyLiquidGlassAppearance(clamped);
  },
  resetClarity: () => {
    persistGlassClarity(DEFAULT_GLASS_CLARITY);
    set({ clarity: DEFAULT_GLASS_CLARITY });
    applyLiquidGlassAppearance(DEFAULT_GLASS_CLARITY);
  },
}));

let observerCleanup: (() => void) | null = null;

/**
 * 初始化 `:root` 同步观察器（幂等）：
 * - 立即应用持久化通透度；
 * - 监听 `<html class="dark">` 与 `data-wb-material` 变化自动重算；
 * - 监听 `prefers-reduced-transparency: reduce` 媒体查询变化自动降级/恢复。
 */
export function initLiquidGlassAppearance(): () => void {
  applyLiquidGlassAppearance();
  if (observerCleanup) return observerCleanup;

  const cleanups: Array<() => void> = [];

  if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && document.documentElement) {
    const observer = new MutationObserver(() => {
      applyLiquidGlassAppearance();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-wb-material'],
    });
    cleanups.push(() => observer.disconnect());
  }

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const mq = window.matchMedia(REDUCED_TRANSPARENCY_QUERY);
    if (mq) {
      const onChange = () => applyLiquidGlassAppearance();
      if (typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', onChange);
        cleanups.push(() => mq.removeEventListener('change', onChange));
      } else if (typeof mq.addListener === 'function') {
        mq.addListener(onChange);
        cleanups.push(() => mq.removeListener(onChange));
      }
    }
  }

  const teardown = () => {
    for (const fn of cleanups) fn();
    observerCleanup = null;
  };
  observerCleanup = teardown;
  return teardown;
}

/** React 订阅 hook：读取当前通透度与更新函数 */
export function useLiquidGlassClarity(): {
  clarity: number;
  setClarity: (value: number) => void;
  resetClarity: () => void;
} {
  const clarity = useLiquidGlassAppearanceStore((s) => s.clarity);
  const setClarity = useLiquidGlassAppearanceStore((s) => s.setClarity);
  const resetClarity = useLiquidGlassAppearanceStore((s) => s.resetClarity);
  return { clarity, setClarity, resetClarity };
}

/** 仅供单元测试：清理持久化、内联 CSS 变量与观察器 */
export function resetLiquidGlassAppearanceForTests(): void {
  observerCleanup?.();
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(GLASS_CLARITY_STORAGE_KEY);
    }
  } catch {
    // noop
  }
  if (typeof document !== 'undefined' && document.documentElement) {
    const root = document.documentElement;
    delete root.dataset.wbGlassClarity;
    root.style.removeProperty('--wb-glass-clarity');
    root.style.removeProperty('--wb-glass-clarity-ratio');
    for (const key of DYNAMIC_GLASS_VARS) {
      root.style.removeProperty(key);
    }
  }
  useLiquidGlassAppearanceStore.setState({ clarity: DEFAULT_GLASS_CLARITY });
}
