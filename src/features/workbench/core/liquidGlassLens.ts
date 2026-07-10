/**
 * Liquid Glass 边缘折射（LeonardSEO / kube 路线）
 * ---------------------------------------------------------------------------
 * 对标 macOS Tahoe：边缘透镜弯曲背景。性能优先：
 *   - 位移图按圆角档位预烘焙并缓存（不按元素尺寸每帧 SDF）
 *   - 同档位共享同一个 SVG filter id
 *   - 并发真折射上限（默认 2）；超出的挂起方保持毛玻璃
 *   - 动画/强度只改 feDisplacementMap.scale，不重算图
 *   - Dock 等常驻大面不挂真折射（调用方决定）
 *
 * 能力门控：Chromium + materialTier=full；其余回退 blur+sheen。
 *
 * 用法：元素加 `wb-glass-lens`，再 `useLiquidGlassLens(ref)` /
 * `attachLiquidGlassLens(el)`。
 */
import { useLayoutEffect, type RefObject } from 'react';
import { getMaterialTier } from './materialTier';

const HTML_LENS_ATTR = 'data-wb-lens';
const SVG_HOST_ID = 'wb-liquid-glass-defs';
/** 预烘焙位移图边长（固定；拉伸到元素，避免按尺寸重生） */
const MAP_SIZE = 128;
/** 边缘折射带厚度（相对短边） */
const BEZEL_RATIO = 0.22;
const BEZEL_MIN = 10;
const BEZEL_MAX = 28;
/** feDisplacementMap scale（负值 = 放大透镜） */
const DISPLACE_SCALE = -28;
/** 折射面薄 blur：露出边缘弯光，避免牛奶磨砂 */
const LENS_BLUR = 'blur(3px)';
/** 同时允许的真折射表面数（Dock 不计入） */
const MAX_ACTIVE_LENSES = 2;
/**
 * 真折射展示时长：入口帧用 displacement 读出透镜感，之后降级为普通玻璃 blur，
 * 静态浮层视觉几乎不变，避免 backdrop 每帧重采样 SVG 位移图。
 */
const LENS_STATIC_DEGRADE_MS = 320;
/** 降级后的轻量毛玻璃（与 token 玻璃接近，无 url(#filter)） */
const LENS_STATIC_FILTER = 'blur(18px) saturate(1.8) brightness(1.08)';
/** 圆角档位（px）：同档共享 map + filter */
const RADIUS_BUCKETS = [8, 12, 14, 16, 18, 20, 24, 28] as const;
const REDUCED_TRANSPARENCY_QUERY = '(prefers-reduced-transparency: reduce)';

const NEUTRAL_MAP_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export type LensOptions = {
  /** 圆角 px；默认读 computed border-radius */
  radius?: number;
  /** 覆盖位移强度（负值透镜） */
  scale?: number;
};

type LensBinding = {
  el: HTMLElement;
  options: LensOptions;
  bucket: number;
  filterId: string;
  active: boolean;
  /** 已降级为静态毛玻璃（仍算「占用」并发槽，直到 detach） */
  staticMode: boolean;
  degradeTimer: ReturnType<typeof setTimeout> | null;
  ro: ResizeObserver;
  lastBucket: number;
};

let capability: boolean | null = null;
const bindings = new Map<HTMLElement, LensBinding>();
/** bucket → 预烘焙 data URL */
const mapCache = new Map<number, string>();
/** bucket → 引用计数（共享 filter 生命周期） */
const filterRefs = new Map<string, number>();
let materialWatchInstalled = false;
/** 当前真正挂了 url(#filter) 的元素（FIFO 抢占） */
const activeEls: HTMLElement[] = [];

function isChromiumLike(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/CriOS|FxiOS/.test(ua)) return false;
  return (
    /Chrome|Chromium|Edg|EdgA|EdgiOS|WebView|Tauri/i.test(ua) ||
    Boolean((window as unknown as { chrome?: unknown }).chrome)
  );
}

export function canUseLiquidGlassLens(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (!isChromiumLike()) return false;
  try {
    if (window.matchMedia?.(REDUCED_TRANSPARENCY_QUERY)?.matches) return false;
  } catch {
    /* ignore */
  }
  if (getMaterialTier() !== 'full') return false;
  return (
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    (CSS.supports('backdrop-filter', 'blur(1px)') ||
      CSS.supports('-webkit-backdrop-filter', 'blur(1px)'))
  );
}

export function getLiquidGlassCapability(): boolean {
  if (capability === null) capability = canUseLiquidGlassLens();
  return capability;
}

export function syncLiquidGlassCapability(): void {
  if (typeof document === 'undefined') return;
  capability = canUseLiquidGlassLens();
  const html = document.documentElement;
  if (capability) {
    html.setAttribute(HTML_LENS_ATTR, 'on');
    ensureSvgHost();
    for (const binding of bindings.values()) updateBinding(binding);
  } else {
    html.setAttribute(HTML_LENS_ATTR, 'off');
    for (const binding of bindings.values()) {
      deactivateBinding(binding);
      clearElementFilter(binding.el);
    }
  }
}

function ensureMaterialWatch(): void {
  if (materialWatchInstalled || typeof document === 'undefined') return;
  materialWatchInstalled = true;
  const mo = new MutationObserver(() => {
    try {
      syncLiquidGlassCapability();
    } catch {
      /* ignore */
    }
  });
  mo.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-wb-material'],
  });
  if (typeof window !== 'undefined' && window.matchMedia) {
    try {
      const mq = window.matchMedia(REDUCED_TRANSPARENCY_QUERY);
      const onChange = () => {
        try {
          syncLiquidGlassCapability();
        } catch {
          /* ignore */
        }
      };
      if (mq && typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
      else if (mq && typeof mq.addListener === 'function') mq.addListener(onChange);
    } catch {
      /* ignore */
    }
  }
  syncLiquidGlassCapability();
}

function ensureSvgHost(): SVGSVGElement {
  let host = document.getElementById(SVG_HOST_ID) as unknown as SVGSVGElement | null;
  if (host) return host;
  host = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  host.setAttribute('id', SVG_HOST_ID);
  host.setAttribute('aria-hidden', 'true');
  host.setAttribute('width', '0');
  host.setAttribute('height', '0');
  Object.assign(host.style, {
    position: 'absolute',
    width: '0',
    height: '0',
    overflow: 'hidden',
    pointerEvents: 'none',
  });
  host.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'defs'));
  document.body.appendChild(host);
  return host;
}

function getDefs(): SVGDefsElement {
  return ensureSvgHost().querySelector('defs') as SVGDefsElement;
}

/** 圆角矩形 SDF（外正内负） */
function sdRoundedBox(px: number, py: number, hw: number, hh: number, r: number): number {
  const qx = Math.abs(px) - hw + r;
  const qy = Math.abs(py) - hh + r;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 最近圆角档位 */
export function bucketRadius(radiusCss: number): number {
  const r = Math.max(0, radiusCss);
  let best: number = RADIUS_BUCKETS[0];
  let bestDist = Math.abs(r - best);
  for (const b of RADIUS_BUCKETS) {
    const d = Math.abs(r - b);
    if (d < bestDist) {
      best = b;
      bestDist = d;
    }
  }
  return best;
}

function filterIdForBucket(bucket: number): string {
  return `wb-liquid-lens-r${bucket}`;
}

/**
 * 生成 R=dx / G=dy 位移图像素（128=恒等）。
 * 固定正方形画布 + 指定圆角；拉伸到任意元素尺寸。
 */
export function buildDisplacementMapImageData(
  cssWidth: number,
  cssHeight: number,
  radiusCss: number,
): { width: number; height: number; data: Uint8ClampedArray } {
  const mw = Math.max(8, Math.round(cssWidth));
  const mh = Math.max(8, Math.round(cssHeight));
  const radius = Math.max(0, Math.min(radiusCss, Math.min(mw, mh) / 2));
  const bezel = Math.min(BEZEL_MAX, Math.max(BEZEL_MIN, Math.min(mw, mh) * BEZEL_RATIO));

  const data = new Uint8ClampedArray(mw * mh * 4);
  const hw = mw * 0.5;
  const hh = mh * 0.5;
  const eps = 0.75;

  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
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
        const t = 1 - inside / bezel;
        const strength = t * t * (3 - 2 * t);
        dx = (ddx / len) * strength;
        dy = (ddy / len) * strength;
      }
      const i = (y * mw + x) * 4;
      data[i] = Math.max(0, Math.min(255, Math.round(128 + dx * 127)));
      data[i + 1] = Math.max(0, Math.min(255, Math.round(128 + dy * 127)));
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  }
  return { width: mw, height: mh, data };
}

export function generateDisplacementMapDataUrl(
  cssWidth: number,
  cssHeight: number,
  radiusCss: number,
): string {
  const { width: mw, height: mh, data } = buildDisplacementMapImageData(
    cssWidth,
    cssHeight,
    radiusCss,
  );
  try {
    const canvas = document.createElement('canvas');
    canvas.width = mw;
    canvas.height = mh;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return NEUTRAL_MAP_PNG;
    const img = ctx.createImageData(mw, mh);
    img.data.set(data);
    ctx.putImageData(img, 0, 0);
    const url = canvas.toDataURL('image/png');
    return url && url.startsWith('data:image') ? url : NEUTRAL_MAP_PNG;
  } catch {
    return NEUTRAL_MAP_PNG;
  }
}

/** 按圆角档取/生成共享位移图（只算一次） */
export function getSharedDisplacementMap(bucket: number): string {
  const cached = mapCache.get(bucket);
  if (cached) return cached;
  // 正方形 map：半径按 MAP_SIZE 比例缩放，使 18px@任意尺寸 与 18/短边 视觉接近
  const radiusOnMap = Math.min(bucket, MAP_SIZE / 2);
  const url = generateDisplacementMapDataUrl(MAP_SIZE, MAP_SIZE, radiusOnMap);
  mapCache.set(bucket, url);
  return url;
}

function parseRadiusPx(el: HTMLElement): number {
  const raw = getComputedStyle(el).borderTopLeftRadius || '0';
  const match = raw.match(/([\d.]+)px/);
  return match ? Number(match[1]) : 14;
}

function clearElementFilter(el: HTMLElement): void {
  el.style.removeProperty('-webkit-backdrop-filter');
  el.style.removeProperty('backdrop-filter');
  el.style.removeProperty('--wb-lens-filter');
}

function ensureSharedFilter(filterId: string, bucket: number, scale: number): void {
  const defs = getDefs();
  let filter = defs.querySelector(`#${CSS.escape(filterId)}`) as SVGFilterElement | null;
  const mapUrl = getSharedDisplacementMap(bucket);

  if (!filter) {
    filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
    filter.setAttribute('id', filterId);
    filter.setAttribute('x', '-8%');
    filter.setAttribute('y', '-8%');
    filter.setAttribute('width', '116%');
    filter.setAttribute('height', '116%');
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    // 默认 userSpaceOnUse：scale 以 CSS px 计；objectBoundingBox 会把 -28 解成整框比例而炸掉

    const feImage = document.createElementNS('http://www.w3.org/2000/svg', 'feImage');
    feImage.setAttribute('result', 'map');
    feImage.setAttribute('preserveAspectRatio', 'none');

    const feDisp = document.createElementNS('http://www.w3.org/2000/svg', 'feDisplacementMap');
    feDisp.setAttribute('in', 'SourceGraphic');
    feDisp.setAttribute('in2', 'map');
    feDisp.setAttribute('xChannelSelector', 'R');
    feDisp.setAttribute('yChannelSelector', 'G');
    feDisp.setAttribute('scale', String(scale));

    filter.appendChild(feImage);
    filter.appendChild(feDisp);
    defs.appendChild(filter);
  }

  const feImage = filter.querySelector('feImage');
  const feDisp = filter.querySelector('feDisplacementMap');
  if (feImage) {
    feImage.setAttribute('href', mapUrl);
    feImage.setAttributeNS('http://www.w3.org/1999/xlink', 'href', mapUrl);
  }
  if (feDisp) feDisp.setAttribute('scale', String(scale));
}

function retainFilter(filterId: string): void {
  filterRefs.set(filterId, (filterRefs.get(filterId) ?? 0) + 1);
}

function releaseFilter(filterId: string): void {
  const next = (filterRefs.get(filterId) ?? 1) - 1;
  if (next <= 0) {
    filterRefs.delete(filterId);
    getDefs().querySelector(`#${CSS.escape(filterId)}`)?.remove();
  } else {
    filterRefs.set(filterId, next);
  }
}

function applyFilterToElement(el: HTMLElement, filterId: string): void {
  const filterValue = `${LENS_BLUR} url(#${filterId}) saturate(1.85) brightness(1.1)`;
  el.style.setProperty('--wb-lens-filter', filterValue);
  el.style.setProperty('-webkit-backdrop-filter', filterValue);
  el.style.setProperty('backdrop-filter', filterValue);
}

function applyStaticFilter(el: HTMLElement): void {
  el.style.setProperty('--wb-lens-filter', LENS_STATIC_FILTER);
  el.style.setProperty('-webkit-backdrop-filter', LENS_STATIC_FILTER);
  el.style.setProperty('backdrop-filter', LENS_STATIC_FILTER);
}

function clearDegradeTimer(binding: LensBinding): void {
  if (binding.degradeTimer != null) {
    clearTimeout(binding.degradeTimer);
    binding.degradeTimer = null;
  }
}

function scheduleStaticDegrade(binding: LensBinding): void {
  clearDegradeTimer(binding);
  if (binding.staticMode) return;
  binding.degradeTimer = setTimeout(() => {
    binding.degradeTimer = null;
    if (!binding.active || binding.staticMode) return;
    // 释放昂贵的 SVG displacement，保留毛玻璃观感
    releaseFilter(binding.filterId);
    binding.staticMode = true;
    applyStaticFilter(binding.el);
  }, LENS_STATIC_DEGRADE_MS);
}

function deactivateBinding(binding: LensBinding): void {
  if (!binding.active) return;
  binding.active = false;
  clearDegradeTimer(binding);
  const idx = activeEls.indexOf(binding.el);
  if (idx >= 0) activeEls.splice(idx, 1);
  if (!binding.staticMode) {
    releaseFilter(binding.filterId);
  }
  binding.staticMode = false;
  clearElementFilter(binding.el);
}

function activateBinding(binding: LensBinding): void {
  if (!getLiquidGlassCapability()) {
    clearElementFilter(binding.el);
    return;
  }

  if (binding.active) {
    if (binding.staticMode) {
      applyStaticFilter(binding.el);
      return;
    }
    const scale = binding.options.scale ?? DISPLACE_SCALE;
    ensureSharedFilter(binding.filterId, binding.bucket, scale);
    applyFilterToElement(binding.el, binding.filterId);
    scheduleStaticDegrade(binding);
    return;
  }

  // 并发上限：挤掉最早激活的（通常是已关但仍挂着的浮层）
  while (activeEls.length >= MAX_ACTIVE_LENSES) {
    const victimEl = activeEls[0];
    const victim = bindings.get(victimEl);
    if (victim) deactivateBinding(victim);
    else activeEls.shift();
  }

  const scale = binding.options.scale ?? DISPLACE_SCALE;
  ensureSharedFilter(binding.filterId, binding.bucket, scale);
  retainFilter(binding.filterId);
  binding.active = true;
  binding.staticMode = false;
  activeEls.push(binding.el);
  applyFilterToElement(binding.el, binding.filterId);
  scheduleStaticDegrade(binding);
}

function updateBinding(binding: LensBinding): void {
  if (!getLiquidGlassCapability()) {
    deactivateBinding(binding);
    clearElementFilter(binding.el);
    return;
  }

  const rect = binding.el.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return;

  const radius = binding.options.radius ?? parseRadiusPx(binding.el);
  const bucket = bucketRadius(radius);
  const filterId = filterIdForBucket(bucket);

  if (binding.active && !binding.staticMode && binding.filterId !== filterId) {
    // 圆角档变了：换共享 filter（静态降级后不再换 displacement）
    releaseFilter(binding.filterId);
    binding.filterId = filterId;
    binding.bucket = bucket;
    retainFilter(filterId);
  } else {
    binding.bucket = bucket;
    binding.filterId = filterId;
  }
  binding.lastBucket = bucket;
  activateBinding(binding);
}

/**
 * 把元素挂上液态玻璃透镜；返回卸载函数。
 * 元素应同时带 `wb-glass-lens`（无能力时 CSS 仍走普通玻璃）。
 */
export function attachLiquidGlassLens(el: HTMLElement, options: LensOptions = {}): () => void {
  ensureMaterialWatch();
  const existing = bindings.get(el);
  if (existing) {
    existing.options = options;
    updateBinding(existing);
    return () => detachLiquidGlassLens(el);
  }

  const radius = options.radius ?? parseRadiusPx(el);
  const bucket = bucketRadius(radius);
  const binding: LensBinding = {
    el,
    options,
    bucket,
    filterId: filterIdForBucket(bucket),
    active: false,
    staticMode: false,
    degradeTimer: null,
    lastBucket: -1,
    ro: new ResizeObserver(() => {
      // 尺寸变化不重生 map；仅在圆角计算样式可能变时刷新档位
      updateBinding(binding);
    }),
  };
  bindings.set(el, binding);
  binding.ro.observe(el);
  updateBinding(binding);
  return () => detachLiquidGlassLens(el);
}

export function detachLiquidGlassLens(el: HTMLElement): void {
  const binding = bindings.get(el);
  if (!binding) return;
  binding.ro.disconnect();
  clearDegradeTimer(binding);
  deactivateBinding(binding);
  clearElementFilter(el);
  bindings.delete(el);
}

/** React：对 ref 启用透镜 */
export function useLiquidGlassLens(
  ref: RefObject<HTMLElement | null>,
  enabled = true,
  options?: LensOptions,
): void {
  const radius = options?.radius;
  const scale = options?.scale;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    return attachLiquidGlassLens(el, {
      ...(radius !== undefined ? { radius } : {}),
      ...(scale !== undefined ? { scale } : {}),
    });
  }, [ref, enabled, radius, scale]);
}

/** 单测：重置 */
export function resetLiquidGlassLensForTests(): void {
  capability = null;
  for (const el of [...bindings.keys()]) detachLiquidGlassLens(el);
  bindings.clear();
  mapCache.clear();
  filterRefs.clear();
  activeEls.length = 0;
  materialWatchInstalled = false;
  if (typeof document !== 'undefined') {
    document.getElementById(SVG_HOST_ID)?.remove();
    document.documentElement.removeAttribute(HTML_LENS_ATTR);
  }
}

/** 单测/诊断：当前激活折射面数量 */
export function getActiveLiquidGlassLensCount(): number {
  return activeEls.length;
}
