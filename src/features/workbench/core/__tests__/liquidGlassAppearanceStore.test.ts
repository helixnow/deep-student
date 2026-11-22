import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  applyLiquidGlassAppearance,
  clampGlassClarity,
  computeGlassAppearanceTokens,
  DEFAULT_GLASS_CLARITY,
  GLASS_CLARITY_STORAGE_KEY,
  initLiquidGlassAppearance,
  readStoredGlassClarity,
  resetLiquidGlassAppearanceForTests,
  useLiquidGlassAppearanceStore,
} from '../liquidGlassAppearanceStore';

describe('liquidGlassAppearanceStore', () => {
  beforeEach(() => {
    resetLiquidGlassAppearanceForTests();
    document.documentElement.classList.remove('dark');
    document.documentElement.removeAttribute('data-wb-material');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetLiquidGlassAppearanceForTests();
    document.documentElement.classList.remove('dark');
    document.documentElement.removeAttribute('data-wb-material');
  });

  it('默认通透度为 55 并正确钳制边界与非法值', () => {
    expect(useLiquidGlassAppearanceStore.getState().clarity).toBe(DEFAULT_GLASS_CLARITY);
    expect(clampGlassClarity(-20)).toBe(0);
    expect(clampGlassClarity(150)).toBe(100);
    expect(clampGlassClarity(62.6)).toBe(63);
    expect(clampGlassClarity('80')).toBe(80);
    expect(clampGlassClarity(Number.NaN)).toBe(DEFAULT_GLASS_CLARITY);
    expect(clampGlassClarity('')).toBe(DEFAULT_GLASS_CLARITY);
    expect(clampGlassClarity(null)).toBe(DEFAULT_GLASS_CLARITY);
  });

  it('setClarity 持久化到 localStorage 并实时写入 :root 玻璃变量', () => {
    useLiquidGlassAppearanceStore.getState().setClarity(90);

    expect(useLiquidGlassAppearanceStore.getState().clarity).toBe(90);
    expect(localStorage.getItem(GLASS_CLARITY_STORAGE_KEY)).toBe('90');
    expect(readStoredGlassClarity()).toBe(90);

    const style = document.documentElement.style;
    expect(style.getPropertyValue('--wb-glass-clarity')).toBe('90');
    expect(style.getPropertyValue('--wb-dock-bg')).toContain('hsl(var(--card) /');
    expect(style.getPropertyValue('--wb-menubar-bg')).toContain('hsl(var(--card) /');
    expect(style.getPropertyValue('--wb-glass-bg')).toContain('hsl(var(--card) /');
    expect(style.getPropertyValue('--wb-glass-blur')).toContain('blur(');
    expect(style.getPropertyValue('--wb-glass-rim')).toContain('rgba(255, 255, 255,');
  });

  it('0（磨砂护眼）与 100（极透液态玻璃）平滑过渡：fill 与 blur 降低、rim 增强', () => {
    const frosted = computeGlassAppearanceTokens(0, { isDark: false });
    const crystal = computeGlassAppearanceTokens(100, { isDark: false });

    expect(frosted.vars['--wb-glass-bg']).toBe('hsl(var(--card) / 0.42)');
    expect(crystal.vars['--wb-glass-bg']).toBe('hsl(var(--card) / 0.1)');
    expect(frosted.vars['--wb-dock-bg']).toBe('hsl(var(--card) / 0.5)');
    expect(crystal.vars['--wb-dock-bg']).toBe('hsl(var(--card) / 0.16)');
    expect(frosted.vars['--wb-menubar-bg']).toBe('hsl(var(--card) / 0.26)');
    expect(crystal.vars['--wb-menubar-bg']).toBe('hsl(var(--card) / 0.04)');
    expect(frosted.vars['--wb-glass-blur']).toContain('blur(26px)');
    expect(crystal.vars['--wb-glass-blur']).toContain('blur(12px)');
    expect(frosted.vars['--wb-glass-rim']).toBe('rgba(255, 255, 255, 0.28)');
    expect(crystal.vars['--wb-glass-rim']).toBe('rgba(255, 255, 255, 0.72)');
  });

  it('暗色主题切换后自动采用暗色通透曲线', () => {
    applyLiquidGlassAppearance(55);
    const lightGlassBg = document.documentElement.style.getPropertyValue('--wb-glass-bg');

    document.documentElement.classList.add('dark');
    applyLiquidGlassAppearance(55);
    const darkGlassBg = document.documentElement.style.getPropertyValue('--wb-glass-bg');

    expect(darkGlassBg).not.toBe(lightGlassBg);
    expect(darkGlassBg).toBe('hsl(var(--card) / 0.351)');
  });

  it('尊重 prefers-reduced-transparency 与 reduced/minimal 材质档：撤除内联覆写', () => {
    applyLiquidGlassAppearance(85);
    expect(document.documentElement.style.getPropertyValue('--wb-glass-blur')).toContain('blur(');

    const matchMediaSpy = vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-transparency: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    }));

    applyLiquidGlassAppearance(85);
    expect(document.documentElement.style.getPropertyValue('--wb-glass-blur')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--wb-dock-bg')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--wb-menubar-bg')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--wb-glass-clarity')).toBe('85');
    matchMediaSpy.mockRestore();

    applyLiquidGlassAppearance(85);
    expect(document.documentElement.style.getPropertyValue('--wb-dock-bg')).not.toBe('');

    document.documentElement.setAttribute('data-wb-material', 'reduced');
    applyLiquidGlassAppearance(85);
    expect(document.documentElement.style.getPropertyValue('--wb-dock-bg')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--wb-glass-blur')).toBe('');
  });

  it('initLiquidGlassAppearance 监听 dark 类变化并自动刷新 :root 变量', async () => {
    const teardown = initLiquidGlassAppearance();
    const initialBg = document.documentElement.style.getPropertyValue('--wb-glass-bg');

    document.documentElement.classList.add('dark');
    await Promise.resolve();
    const updatedBg = document.documentElement.style.getPropertyValue('--wb-glass-bg');
    expect(updatedBg).not.toBe(initialBg);

    teardown();
  });
});
