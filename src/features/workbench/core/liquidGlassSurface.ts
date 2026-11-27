/**
 * 统一多表面 Liquid Glass 实景光学折射引擎（Chromium / Electron 专属，非 Chromium 自动回退 CSS blur）
 * ---------------------------------------------------------------------------
 * 复用并泛化 Dock 验证通过的 macOS Tahoe 液态玻璃物理模型，支持同屏任意数量玻璃表面共存：
 *   1. 按宿主元素实时 CSS 宽高 (W×H) 与圆角 R 烘焙等厚倒角位移图（四周倒角厚度一致，
 *      大面板自动 0.5x 降采样并由 GPU 双线性平滑拉伸，烘焙耗时 < 1.5ms）；
 *   2. 折射向量按 u^2.2 凸面弯液曲线严格指向内部，配合 feGaussianBlur edgeMode="duplicate"，
 *      绝不采样框外透明像素导致暗边；
 *   3. 滤镜顺序为「低模糊清透柔化 → 外圈倒角三通道微色散折射」，直接挂在元素真实 backdrop-filter 上，
 *      背后壁纸与活动窗口实时穿透并沿边缘弯曲；
 *   4. 按元素引用计数去重（同一元素同时调用 useLiquidGlassLens 与 WallpaperReplica 只挂一枚 filter）；
 *      降级档（reduced / minimal / prefers-reduced-transparency）自动撤除内联滤镜。
 */
import { useLayoutEffect, type RefObject } from 'react';
import { getMaterialTier } from './materialTier';
import { useLiquidGlassClarity } from './liquidGlassAppearanceStore';

const SURFACE_SVG_HOST_ID = 'wb-liquid-surface-svg';
const REDUCED_TRANSPARENCY_QUERY = '(prefers-reduced-transparency: reduce)';

export type LiquidGlassSurfaceVariant = 'clear' | 'surface' | 'widget';

interface VariantProfile {
  bezelRatio: number;
  bezelMinPx: number;
  bezelMaxPx: number;
  blurMinStdDev: number;
  blurMaxStdDev: number;
  scales: readonly [number, number, number];
  lightPostFilter: string;
  darkPostFilter: string;
}

const VARIANT_PROFILES: Record<LiquidGlassSurfaceVariant, VariantProfile> = {
  // Dock / 悬浮胶囊：极低模糊 + 鲜明边缘弯折
  clear: {
    bezelRatio: 0.24,
    bezelMinPx: 10,
    bezelMaxPx: 15,
    blurMinStdDev: 0.8,
    blurMaxStdDev: 4.2,
    scales: [16, 19, 22],
    lightPostFilter: 'saturate(1.55) brightness(1.06)',
    darkPostFilter: 'saturate(1.65) brightness(0.96)',
  },
  // 菜单 / 浮层 / 面板：更高柔润模糊保证文字可读性 + 保留边缘液态倒角折射
  surface: {
    bezelRatio: 0.16,
    bezelMinPx: 12,
    bezelMaxPx: 16,
    blurMinStdDev: 10.5,
    blurMaxStdDev: 17.5,
    scales: [15, 18, 21],
    lightPostFilter: 'saturate(1.75) brightness(1.06)',
    darkPostFilter: 'saturate(1.75) brightness(0.95)',
  },
  // 桌面小组件（对标 macOS Tahoe Clear Widgets）：柔润高模糊化开背景杂讯 + 提饱和色彩光晕 + 边缘液态折射
  widget: {
    bezelRatio: 0.14,
    bezelMinPx: 14,
    bezelMaxPx: 20,
    blurMinStdDev: 8.5,
    blurMaxStdDev: 14.5,
    scales: [14, 17, 20],
    lightPostFilter: 'saturate(1.75) brightness(1.03)',
    darkPostFilter: 'saturate(1.75) brightness(0.95)',
  },
};

const mapDataUrlCache = new Map<string, string>();
const MAX_MAP_CACHE_ENTRIES = 32;
const HIGH_RES_PIXEL_BUDGET = 45_000;

let nextFilterSeq = 1;

interface SurfaceBinding {
  el: HTMLElement;
  filterId: string;
  refs: number;
  variant: LiquidGlassSurfaceVariant;
  clarity: number;
  lastKey: string;
  rafId: number;
  ro: ResizeObserver | null;
  mo: MutationObserver | null;
  mq: MediaQueryList | null;
  onMqChange: (() => void) | null;
}

const surfaceBindings = new WeakMap<HTMLElement, SurfaceBinding>();

export function isLiquidSurfaceChromium(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/CriOS|FxiOS/.test(ua)) return false;
  return (
    /Chrome\/|Chromium\/|Edg\//.test(ua) ||
    Boolean((window as unknown as { chrome?: unknown }).chrome)
  );
}

function isReducedTransparency(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return Boolean(window.matchMedia(REDUCED_TRANSPARENCY_QUERY)?.matches);
  } catch {
    return false;
  }
}

/** 圆角矩形 Signed Distance Field（外正内负） */
function sdRoundedBox(px: number, py: number, hw: number, hh: number, r: number): number {
  const qx = Math.abs(px) - hw + r;
  const qy = Math.abs(py) - hh + r;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * 为指定尺寸与倒角配置生成等厚凸面位移图像素（R=dx, G=dy, 128=恒等）。
 */
export function buildSurfaceDisplacementImageData(
  cssWidth: number,
  cssHeight: number,
  radiusCss: number,
  variant: LiquidGlassSurfaceVariant = 'clear',
): { width: number; height: number; data: Uint8ClampedArray } {
  const profile = VARIANT_PROFILES[variant];
  const fullW = Math.max(16, Math.round(cssWidth));
  const fullH = Math.max(16, Math.round(cssHeight));
  // 大面板按 0.5x 生成平滑位移图，由 GPU 双线性插值拉伸到精确 CSS 尺寸，保持 <1.5ms 烘焙
  const scaleFactor = fullW * fullH > HIGH_RES_PIXEL_BUDGET ? 0.5 : 1;
  const w = Math.max(16, Math.round(fullW * scaleFactor));
  const h = Math.max(16, Math.round(fullH * scaleFactor));
  const radius = Math.max(0, Math.min(radiusCss * scaleFactor, Math.min(w, h) / 2));
  const rawBezel = Math.min(
    profile.bezelMaxPx,
    Math.max(profile.bezelMinPx, Math.min(fullW, fullH) * profile.bezelRatio),
  );
  const bezel = Math.max(4, rawBezel * scaleFactor);

  const data = new Uint8ClampedArray(w * h * 4);
  const hw = w * 0.5;
  const hh = h * 0.5;
  const eps = 0.75;

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const px = x + 0.5 - hw;
      const py = y + 0.5 - hh;
      const d = sdRoundedBox(px, py, hw, hh, radius);
      const inside = -d;

      let dx = 0;
      let dy = 0;

      if (inside > 0 && inside < bezel) {
        const ddx =
          sdRoundedBox(px + eps, py, hw, hh, radius) - sdRoundedBox(px - eps, py, hw, hh, radius);
        const ddy =
          sdRoundedBox(px, py + eps, hw, hh, radius) - sdRoundedBox(px, py - eps, hw, hh, radius);
        const len = Math.hypot(ddx, ddy) || 1;
        const u = 1 - inside / bezel;
        const bend = u ** 2.2;
        dx = -(ddx / len) * bend;
        dy = -(ddy / len) * bend;
      }

      const idx = (y * w + x) * 4;
      data[idx] = Math.max(0, Math.min(255, Math.round(128 + dx * 127)));
      data[idx + 1] = Math.max(0, Math.min(255, Math.round(128 + dy * 127)));
      data[idx + 2] = 128;
      data[idx + 3] = 255;
    }
  }

  return { width: w, height: h, data };
}

export function buildSurfaceDisplacementMapDataUrl(
  cssWidth: number,
  cssHeight: number,
  radiusCss: number,
  variant: LiquidGlassSurfaceVariant = 'clear',
): string | null {
  const w = Math.max(16, Math.round(cssWidth));
  const h = Math.max(16, Math.round(cssHeight));
  const r = Math.max(0, Math.round(radiusCss));
  const key = `${variant}:${w}x${h}r${r}`;
  const cached = mapDataUrlCache.get(key);
  if (cached) return cached;

  try {
    const { width, height, data } = buildSurfaceDisplacementImageData(w, h, r, variant);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    const img = ctx.createImageData(width, height);
    img.data.set(data);
    ctx.putImageData(img, 0, 0);
    const url = canvas.toDataURL('image/png');
    if (!url || !url.startsWith('data:image')) return null;

    if (mapDataUrlCache.size >= MAX_MAP_CACHE_ENTRIES) {
      const oldestKey = mapDataUrlCache.keys().next().value;
      if (oldestKey) mapDataUrlCache.delete(oldestKey);
    }
    mapDataUrlCache.set(key, url);
    return url;
  } catch {
    return null;
  }
}

function ensureSvgDefs(): SVGDefsElement | null {
  if (typeof document === 'undefined' || !document.body) return null;
  let host = document.getElementById(SURFACE_SVG_HOST_ID) as unknown as SVGSVGElement | null;
  if (!host) {
    host = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    host.setAttribute('id', SURFACE_SVG_HOST_ID);
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('width', '0');
    host.setAttribute('height', '0');
    Object.assign(host.style, {
      position: 'fixed',
      width: '0',
      height: '0',
      overflow: 'hidden',
      pointerEvents: 'none',
    });
    host.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'defs'));
    document.body.appendChild(host);
  }
  return host.querySelector('defs') as SVGDefsElement | null;
}

function upsertSurfaceFilter(
  filterId: string,
  mapUrl: string,
  width: number,
  height: number,
  blurStdDev: number,
  scales: readonly [number, number, number],
): boolean {
  const defs = ensureSvgDefs();
  if (!defs) return false;

  let filter = defs.querySelector(`#${CSS.escape(filterId)}`) as SVGFilterElement | null;
  if (!filter) {
    filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
    filter.setAttribute('id', filterId);
    filter.setAttribute('filterUnits', 'userSpaceOnUse');
    filter.setAttribute('primitiveUnits', 'userSpaceOnUse');
    filter.setAttribute('x', '0');
    filter.setAttribute('y', '0');
    filter.setAttribute('color-interpolation-filters', 'sRGB');

    const feBlur = document.createElementNS('http://www.w3.org/2000/svg', 'feGaussianBlur');
    feBlur.setAttribute('in', 'SourceGraphic');
    feBlur.setAttribute('edgeMode', 'duplicate');
    feBlur.setAttribute('result', 'soft');

    const feImg = document.createElementNS('http://www.w3.org/2000/svg', 'feImage');
    feImg.setAttribute('x', '0');
    feImg.setAttribute('y', '0');
    feImg.setAttribute('preserveAspectRatio', 'none');
    feImg.setAttribute('result', 'dispMap');

    const makeChannel = (
      channelTag: string,
      dispResult: string,
      matrixValues: string,
      colorResult: string,
    ) => {
      const disp = document.createElementNS('http://www.w3.org/2000/svg', 'feDisplacementMap');
      disp.setAttribute('data-channel', channelTag);
      disp.setAttribute('in', 'soft');
      disp.setAttribute('in2', 'dispMap');
      disp.setAttribute('xChannelSelector', 'R');
      disp.setAttribute('yChannelSelector', 'G');
      disp.setAttribute('result', dispResult);

      const mat = document.createElementNS('http://www.w3.org/2000/svg', 'feColorMatrix');
      mat.setAttribute('in', dispResult);
      mat.setAttribute('type', 'matrix');
      mat.setAttribute('values', matrixValues);
      mat.setAttribute('result', colorResult);
      return [disp, mat] as const;
    };

    const [dispR, matR] = makeChannel(
      'r',
      'dispR',
      '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0',
      'chanR',
    );
    const [dispG, matG] = makeChannel(
      'g',
      'dispG',
      '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0',
      'chanG',
    );
    const [dispB, matB] = makeChannel(
      'b',
      'dispB',
      '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0',
      'chanB',
    );

    const blendRG = document.createElementNS('http://www.w3.org/2000/svg', 'feBlend');
    blendRG.setAttribute('in', 'chanR');
    blendRG.setAttribute('in2', 'chanG');
    blendRG.setAttribute('mode', 'screen');
    blendRG.setAttribute('result', 'rg');

    const blendRGB = document.createElementNS('http://www.w3.org/2000/svg', 'feBlend');
    blendRGB.setAttribute('in', 'rg');
    blendRGB.setAttribute('in2', 'chanB');
    blendRGB.setAttribute('mode', 'screen');
    blendRGB.setAttribute('result', 'refracted');

    filter.append(feBlur, feImg, dispR, matR, dispG, matG, dispB, matB, blendRG, blendRGB);
    defs.appendChild(filter);
  }

  filter.setAttribute('width', String(width));
  filter.setAttribute('height', String(height));

  const feBlur = filter.querySelector('feGaussianBlur');
  const feImg = filter.querySelector('feImage');
  const dispR = filter.querySelector('feDisplacementMap[data-channel="r"]');
  const dispG = filter.querySelector('feDisplacementMap[data-channel="g"]');
  const dispB = filter.querySelector('feDisplacementMap[data-channel="b"]');

  if (feBlur) feBlur.setAttribute('stdDeviation', blurStdDev.toFixed(2));
  if (feImg) {
    feImg.setAttribute('width', String(width));
    feImg.setAttribute('height', String(height));
    feImg.setAttribute('href', mapUrl);
    feImg.setAttributeNS('http://www.w3.org/1999/xlink', 'href', mapUrl);
  }
  if (dispR) dispR.setAttribute('scale', String(scales[0]));
  if (dispG) dispG.setAttribute('scale', String(scales[1]));
  if (dispB) dispB.setAttribute('scale', String(scales[2]));
  return true;
}

function removeSurfaceFilter(filterId: string): void {
  if (typeof document === 'undefined') return;
  const host = document.getElementById(SURFACE_SVG_HOST_ID);
  host?.querySelector(`#${CSS.escape(filterId)}`)?.remove();
}

function clearSurfaceInlineFilter(el: HTMLElement): void {
  el.style.removeProperty('backdrop-filter');
  el.style.removeProperty('-webkit-backdrop-filter');
  el.removeAttribute('data-wb-liquid-surface');
}

function computeBlurStdDev(clarity: number, variant: LiquidGlassSurfaceVariant): number {
  const profile = VARIANT_PROFILES[variant];
  const ratio = Math.max(0, Math.min(1, clarity / 100));
  return profile.blurMaxStdDev - ratio * (profile.blurMaxStdDev - profile.blurMinStdDev);
}

function syncBinding(binding: SurfaceBinding): void {
  binding.rafId = 0;
  const { el } = binding;
  if (!el.isConnected) return;

  if (!isLiquidSurfaceChromium() || getMaterialTier() !== 'full' || isReducedTransparency()) {
    clearSurfaceInlineFilter(el);
    binding.lastKey = '';
    return;
  }

  const rect = el.getBoundingClientRect();
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  if (w < 32 || h < 20) return;

  const rawRadius = getComputedStyle(el).borderTopLeftRadius || '14px';
  const radiusMatch = rawRadius.match(/([\d.]+)px/);
  const radius = Math.round(radiusMatch ? Number(radiusMatch[1]) : 14);
  const isDark = document.documentElement.classList.contains('dark');
  const key = `${binding.variant}:${w}x${h}r${radius}c${binding.clarity}d${isDark ? 1 : 0}`;
  if (key === binding.lastKey) return;

  const profile = VARIANT_PROFILES[binding.variant];
  const mapUrl = buildSurfaceDisplacementMapDataUrl(w, h, radius, binding.variant);
  const stdDev = computeBlurStdDev(binding.clarity, binding.variant);

  if (!mapUrl || !upsertSurfaceFilter(binding.filterId, mapUrl, w, h, stdDev, profile.scales)) {
    clearSurfaceInlineFilter(el);
    return;
  }

  const post = isDark ? profile.darkPostFilter : profile.lightPostFilter;
  const expr = `url(#${binding.filterId}) ${post}`;
  el.style.setProperty('backdrop-filter', expr);
  el.style.setProperty('-webkit-backdrop-filter', expr);
  el.setAttribute('data-wb-liquid-surface', binding.variant);
  binding.lastKey = key;
}

function scheduleBindingSync(binding: SurfaceBinding): void {
  if (binding.rafId) return;
  binding.rafId =
    typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame(() => syncBinding(binding))
      : (window.setTimeout(() => syncBinding(binding), 0) as unknown as number);
}

function retainSurfaceBinding(
  el: HTMLElement,
  variant: LiquidGlassSurfaceVariant,
  clarity: number,
): () => void {
  let binding = surfaceBindings.get(el);
  if (binding) {
    binding.refs += 1;
    // clear 优先级高于 surface（如 Dock / Switcher）
    if (variant === 'clear') binding.variant = 'clear';
    binding.clarity = clarity;
    scheduleBindingSync(binding);
  } else {
    const filterId = `wb-liquid-surface-${nextFilterSeq++}`;
    binding = {
      el,
      filterId,
      refs: 1,
      variant,
      clarity,
      lastKey: '',
      rafId: 0,
      ro: null,
      mo: null,
      mq: null,
      onMqChange: null,
    };
    const b = binding;
    surfaceBindings.set(el, b);

    b.ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => scheduleBindingSync(b)) : null;
    b.ro?.observe(el);

    b.mo =
      typeof MutationObserver === 'function'
        ? new MutationObserver(() => scheduleBindingSync(b))
        : null;
    b.mo?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-wb-material'],
    });

    const mq =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(REDUCED_TRANSPARENCY_QUERY)
        : null;
    if (mq) {
      b.mq = mq;
      b.onMqChange = () => scheduleBindingSync(b);
      mq.addEventListener?.('change', b.onMqChange);
    }

    syncBinding(b);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = surfaceBindings.get(el);
    if (!current) return;
    current.refs -= 1;
    if (current.refs > 0) return;

    if (current.rafId) {
      if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(current.rafId);
      else window.clearTimeout(current.rafId);
    }
    current.ro?.disconnect();
    current.mo?.disconnect();
    if (current.mq && current.onMqChange) {
      current.mq.removeEventListener?.('change', current.onMqChange);
    }
    removeSurfaceFilter(current.filterId);
    clearSurfaceInlineFilter(el);
    surfaceBindings.delete(el);
  };
}

export interface LiquidGlassSurfaceOptions {
  variant?: LiquidGlassSurfaceVariant;
}

/**
 * 为任意玻璃态容器挂载等厚倒角实景折射滤镜（Chromium / Electron 且 full 档生效）。
 */
export function useLiquidGlassSurfaceFilter(
  ref: RefObject<HTMLElement | null>,
  enabled = true,
  options?: LiquidGlassSurfaceOptions,
): void {
  const { clarity } = useLiquidGlassClarity();
  const variant = options?.variant ?? 'surface';

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    if (!enabled || !isLiquidSurfaceChromium() || getMaterialTier() !== 'full' || isReducedTransparency()) {
      const existing = surfaceBindings.get(el);
      if (!existing) clearSurfaceInlineFilter(el);
      return undefined;
    }

    return retainSurfaceBinding(el, variant, clarity);
  }, [ref, enabled, variant, clarity]);
}
