/**
 * Liquid Glass 边缘折射单测（LeonardSEO 共享 map 路线）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachLiquidGlassLens,
  bucketRadius,
  buildDisplacementMapImageData,
  canUseLiquidGlassLens,
  getActiveLiquidGlassLensCount,
  getSharedDisplacementMap,
  resetLiquidGlassLensForTests,
  syncLiquidGlassCapability,
} from '../liquidGlassLens';
import { resetMaterialTierForTests, setMaterialTier } from '../materialTier';

const FAKE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function mockMatchMedia(matchingQueries: string[] = []): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: matchingQueries.includes(query),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function stubChromeUa(): void {
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    get: () =>
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  Object.defineProperty(window, 'chrome', {
    configurable: true,
    value: { runtime: {} },
  });
}

function stubEl(w = 80, h = 40, radius = '14px'): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'wb-glass-lens';
  el.style.borderRadius = radius;
  document.body.appendChild(el);
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    width: w,
    height: h,
    top: 0,
    left: 0,
    bottom: h,
    right: w,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  return el;
}

beforeEach(() => {
  mockMatchMedia();
  stubChromeUa();
  resetMaterialTierForTests();
  resetLiquidGlassLensForTests();
  setMaterialTier('full');
  if (typeof CSS === 'undefined') {
    (globalThis as { CSS?: unknown }).CSS = {};
  }
  (CSS as { supports: (p: string, v: string) => boolean }).supports = () => true;
  if (typeof ResizeObserver === 'undefined') {
    (globalThis as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(FAKE_PNG);
  const proto = HTMLCanvasElement.prototype as unknown as {
    getContext: (id: string, opts?: unknown) => CanvasRenderingContext2D | null;
  };
  const originalGetContext = proto.getContext;
  vi.spyOn(proto, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
    id: string,
    opts?: unknown,
  ) {
    const ctx = originalGetContext.call(this, id, opts) as CanvasRenderingContext2D | null;
    if (ctx && typeof ctx.createImageData !== 'function') {
      (ctx as unknown as { createImageData: (w: number, h: number) => ImageData }).createImageData = (
        w: number,
        h: number,
      ) =>
        ({
          width: w,
          height: h,
          data: new Uint8ClampedArray(w * h * 4),
          colorSpace: 'srgb',
        }) as ImageData;
      (ctx as unknown as { putImageData: () => void }).putImageData = () => undefined;
    }
    return (
      ctx ??
      ({
        createImageData: (w: number, h: number) =>
          ({
            width: w,
            height: h,
            data: new Uint8ClampedArray(w * h * 4),
            colorSpace: 'srgb',
          }) as ImageData,
        putImageData: () => undefined,
      } as unknown as CanvasRenderingContext2D)
    );
  });
});

afterEach(() => {
  resetLiquidGlassLensForTests();
  resetMaterialTierForTests();
  mockMatchMedia();
  vi.restoreAllMocks();
  mockMatchMedia();
});

describe('bucketRadius / shared map', () => {
  it('圆角就近分档', () => {
    expect(bucketRadius(13)).toBe(12);
    expect(bucketRadius(14)).toBe(14);
    expect(bucketRadius(17)).toBe(16);
    expect(bucketRadius(19)).toBe(18);
  });

  it('同档共享位移图缓存', () => {
    const a = getSharedDisplacementMap(14);
    const b = getSharedDisplacementMap(14);
    expect(a).toBe(b);
    expect(a.startsWith('data:image')).toBe(true);
  });
});

describe('buildDisplacementMapImageData', () => {
  it('边缘像素偏离 128，中心接近恒等', () => {
    const { width, height, data } = buildDisplacementMapImageData(64, 64, 12);
    expect(width).toBe(64);
    expect(height).toBe(64);
    const ci = (32 * width + 32) * 4;
    expect(data[ci]).toBe(128);
    expect(data[ci + 1]).toBe(128);
    const edge = (4 * width + 32) * 4;
    const edgeDelta = Math.abs(data[edge] - 128) + Math.abs(data[edge + 1] - 128);
    expect(edgeDelta).toBeGreaterThan(0);
  });
});

describe('attachLiquidGlassLens', () => {
  it('挂载后写入共享 filter id', () => {
    const el = stubEl(80, 40, '14px');
    const detach = attachLiquidGlassLens(el);
    syncLiquidGlassCapability();
    const filter = document.getElementById('wb-liquid-glass-defs')?.querySelector('filter');
    const filterId = filter?.getAttribute('id') ?? '';
    expect(filterId).toBe('wb-liquid-lens-r14');
    expect(el.style.getPropertyValue('--wb-lens-filter')).toContain(`url(#${filterId})`);
    detach();
    el.remove();
  });

  it('同圆角两元素共享同一 filter，并发不超过 2', () => {
    const a = stubEl(100, 40, '14px');
    const b = stubEl(120, 48, '14px');
    const c = stubEl(90, 36, '14px');
    const d1 = attachLiquidGlassLens(a);
    const d2 = attachLiquidGlassLens(b);
    const d3 = attachLiquidGlassLens(c);
    expect(getActiveLiquidGlassLensCount()).toBe(2);
    // 第三个挤掉最早的 a
    expect(a.style.getPropertyValue('--wb-lens-filter')).toBe('');
    expect(b.style.getPropertyValue('--wb-lens-filter')).toContain('url(#');
    expect(c.style.getPropertyValue('--wb-lens-filter')).toContain('url(#');
    const filters = document.getElementById('wb-liquid-glass-defs')?.querySelectorAll('filter');
    expect(filters?.length).toBe(1);
    d1();
    d2();
    d3();
    a.remove();
    b.remove();
    c.remove();
  });

  it('入口帧后降级为无 displacement 的静态毛玻璃', () => {
    vi.useFakeTimers();
    const el = stubEl(80, 40, '14px');
    const detach = attachLiquidGlassLens(el);
    syncLiquidGlassCapability();
    const entrance = el.style.getPropertyValue('--wb-lens-filter');
    expect(entrance).toContain('url(#');
    // 入口底模糊须与静态档同量级，避免「先透后糊」
    expect(entrance).toContain('blur(18px)');
    vi.advanceTimersByTime(400);
    const filter = el.style.getPropertyValue('--wb-lens-filter');
    expect(filter).not.toContain('url(#');
    expect(filter).toContain('blur(18px)');
    // 静态降级后让出真折射并发槽（不再占 MAX_ACTIVE_LENSES 名额）
    expect(getActiveLiquidGlassLensCount()).toBe(0);
    detach();
    el.remove();
    vi.useRealTimers();
  });

  it('staticOnly：首帧即静态毛玻璃，不占折射并发槽', () => {
    const el = stubEl(80, 40, '14px');
    const detach = attachLiquidGlassLens(el, { staticOnly: true });
    syncLiquidGlassCapability();
    const filter = el.style.getPropertyValue('--wb-lens-filter');
    expect(filter).toContain('blur(18px)');
    expect(filter).not.toContain('url(#');
    expect(getActiveLiquidGlassLensCount()).toBe(0);
    expect(document.getElementById('wb-liquid-glass-defs')?.querySelector('filter')).toBeNull();
    detach();
    el.remove();
  });
});

describe('canUseLiquidGlassLens / 材质降级', () => {
  it('full + Chromium → true', () => {
    expect(canUseLiquidGlassLens()).toBe(true);
  });

  it('reduced 档 → false，并清掉 inline filter', () => {
    const el = stubEl();
    const detach = attachLiquidGlassLens(el);
    syncLiquidGlassCapability();
    expect(el.style.getPropertyValue('--wb-lens-filter')).toContain('url(#');

    setMaterialTier('reduced');
    syncLiquidGlassCapability();
    expect(canUseLiquidGlassLens()).toBe(false);
    expect(document.documentElement.getAttribute('data-wb-lens')).toBe('off');
    expect(el.style.getPropertyValue('--wb-lens-filter')).toBe('');

    detach();
    el.remove();
  });

  it('prefers-reduced-transparency → false', () => {
    mockMatchMedia(['(prefers-reduced-transparency: reduce)']);
    resetLiquidGlassLensForTests();
    expect(canUseLiquidGlassLens()).toBe(false);
  });
});
