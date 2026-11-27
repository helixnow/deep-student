/**
 * 自适应液态玻璃前景色（Adaptive Liquid Glass Ink）
 * ---------------------------------------------------------------------------
 * 对标 macOS Tahoe / iOS 26：极透玻璃落在亮雾天空上使用深色字，落在深绿松林/夜景等
 * 暗区壁纸上自动为该组件挂上 `data-wb-glass-tone="dark"` 切换为清透亮白字，
 * 无需往玻璃里塞突兀的实心白块即可保证全场景高可读性。
 */
import { useLayoutEffect, type RefObject } from 'react';
import { getMaterialTier } from './materialTier';

const SAMPLE_W = 96;
const SAMPLE_H = 54;
const DARK_LUMINANCE_THRESHOLD = 0.62;
const REDUCED_TRANSPARENCY_QUERY = '(prefers-reduced-transparency: reduce)';
/** 明亮主题下本身仍为深色基调的纯渐变壁纸预设 */
const DARK_GRADIENT_PRESETS = new Set(['nebula']);

interface CachedWallpaperSample {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

const imagePromiseCache = new Map<string, Promise<HTMLImageElement | null>>();
const sampleBitmapCache = new Map<string, CachedWallpaperSample>();
const MAX_SAMPLE_CACHE = 12;

export function parseCssUrl(backgroundImage: string): string | null {
  if (!backgroundImage || backgroundImage === 'none') return null;
  const match = backgroundImage.match(/url\(["']?([^"')]+)["']?\)/i);
  return match?.[1] ?? null;
}

export function parseBgPositionRatio(raw: string): [number, number] {
  const parts = raw.trim().split(/\s+/);
  const toRatio = (token: string | undefined, fallback: number): number => {
    if (!token) return fallback;
    if (token === 'left' || token === 'top') return 0;
    if (token === 'center') return 0.5;
    if (token === 'right' || token === 'bottom') return 1;
    if (token.endsWith('%')) {
      const n = Number.parseFloat(token);
      if (Number.isFinite(n)) return Math.max(0, Math.min(1, n / 100));
    }
    return fallback;
  };
  return [toRatio(parts[0], 0.5), toRatio(parts[1], 0.5)];
}

/** 按区域采样均值计算感知亮度（0 = 纯黑，1 = 纯白） */
export function computeRegionLuminance(
  sample: CachedWallpaperSample,
  normLeft: number,
  normTop: number,
  normWidth: number,
  normHeight: number,
): number | null {
  const x0 = Math.max(0, Math.min(sample.width - 1, Math.floor(normLeft * sample.width)));
  const y0 = Math.max(0, Math.min(sample.height - 1, Math.floor(normTop * sample.height)));
  const x1 = Math.max(x0 + 1, Math.min(sample.width, Math.ceil((normLeft + normWidth) * sample.width)));
  const y1 = Math.max(y0 + 1, Math.min(sample.height, Math.ceil((normTop + normHeight) * sample.height)));

  let sum = 0;
  let count = 0;
  const { data, width } = sample;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const idx = (y * width + x) * 4;
      const a = data[idx + 3] / 255;
      if (a <= 0.01) continue;
      const lum = (0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2]) / 255;
      sum += lum;
      count += 1;
    }
  }
  return count > 0 ? sum / count : null;
}

function loadWallpaperImage(url: string): Promise<HTMLImageElement | null> {
  const cached = imagePromiseCache.get(url);
  if (cached) return cached;

  const promise = new Promise<HTMLImageElement | null>((resolve) => {
    if (typeof Image === 'undefined') {
      resolve(null);
      return;
    }
    const img = new Image();
    try {
      const resolved = new URL(url, window.location.href);
      if (/^https?:$/i.test(resolved.protocol) && resolved.origin !== window.location.origin) {
        img.crossOrigin = 'anonymous';
      }
    } catch {
      // 保留默认加载策略
    }
    img.onload = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        resolve(img);
      } else {
        imagePromiseCache.delete(url);
        resolve(null);
      }
    };
    img.onerror = () => {
      imagePromiseCache.delete(url);
      resolve(null);
    };
    img.src = url;
  });

  imagePromiseCache.set(url, promise);
  return promise;
}

function rasterizeCoverSample(
  img: HTMLImageElement,
  vw: number,
  vh: number,
  posX: number,
  posY: number,
  cacheKey: string,
): CachedWallpaperSample | null {
  const cached = sampleBitmapCache.get(cacheKey);
  if (cached) return cached;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_W;
    canvas.height = SAMPLE_H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    const scale = Math.max(vw / img.naturalWidth, vh / img.naturalHeight);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    const ox = (vw - dw) * posX;
    const oy = (vh - dh) * posY;
    const sx = SAMPLE_W / vw;
    const sy = SAMPLE_H / vh;

    ctx.drawImage(img, ox * sx, oy * sy, dw * sx, dh * sy);
    const imgData = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
    const entry: CachedWallpaperSample = {
      data: imgData.data,
      width: SAMPLE_W,
      height: SAMPLE_H,
    };
    if (sampleBitmapCache.size >= MAX_SAMPLE_CACHE) {
      const oldest = sampleBitmapCache.keys().next().value;
      if (oldest) sampleBitmapCache.delete(oldest);
    }
    sampleBitmapCache.set(cacheKey, entry);
    return entry;
  } catch {
    return null;
  }
}

function isReducedTransparency(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return Boolean(window.matchMedia(REDUCED_TRANSPARENCY_QUERY)?.matches);
  } catch {
    return false;
  }
}

/**
 * 采样桌面壁纸在组件所在区域的真实明度，暗背景自动挂 `data-wb-glass-tone="dark"`。
 */
export function useAdaptiveGlassTone(
  ref: RefObject<HTMLElement | null>,
  enabled = true,
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    if (!enabled) {
      el.removeAttribute('data-wb-glass-tone');
      return undefined;
    }

    let cancelled = false;
    let rafId = 0;
    let evalSeq = 0;
    let observedWallpaperRoot: HTMLElement | null = null;
    let wpMo: MutationObserver | null = null;
    const observedResizeTargets = new Set<Element>();

    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => scheduleEvaluate()) : null;

    const observeResizeTarget = (node: Element | null) => {
      if (!ro || !node || observedResizeTargets.has(node)) return;
      observedResizeTargets.add(node);
      ro.observe(node);
    };

    const syncSiblingResizeTargets = () => {
      if (!ro) return;
      observeResizeTarget(el);
      const parent = el.parentElement;
      if (!parent) return;
      observeResizeTarget(parent);
      for (const child of Array.from(parent.children)) {
        observeResizeTarget(child);
      }
    };

    const ensureWallpaperObserved = (): HTMLElement | null => {
      const root = document.querySelector<HTMLElement>('.wb-wallpaper-root');
      if (root === observedWallpaperRoot) return root;
      wpMo?.disconnect();
      wpMo = null;
      observedWallpaperRoot = root;
      if (root) {
        observeResizeTarget(root);
        if (typeof MutationObserver === 'function') {
          wpMo = new MutationObserver(() => scheduleEvaluate());
          wpMo.observe(root, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'class', 'data-wb-wallpaper-preset', 'data-wb-wallpaper-kind'],
          });
        }
      }
      return root;
    };

    const evaluate = () => {
      rafId = 0;
      const target = ref.current;
      if (!target || cancelled) return;
      const seq = ++evalSeq;

      // 暗色主题本身已是浅字；降级实色档走主题实底，无需翻转
      if (
        document.documentElement.classList.contains('dark') ||
        getMaterialTier() !== 'full' ||
        isReducedTransparency()
      ) {
        target.removeAttribute('data-wb-glass-tone');
        return;
      }

      const wallpaperRoot = ensureWallpaperObserved();
      if (!wallpaperRoot) {
        target.removeAttribute('data-wb-glass-tone');
        return;
      }

      const panes = wallpaperRoot.querySelectorAll<HTMLElement>('.wb-wallpaper-pane');
      const activePane = panes.length > 0 ? panes[panes.length - 1] : wallpaperRoot;
      const imgLayer = activePane.querySelector<HTMLElement>('.wb-wallpaper-image');
      if (!imgLayer) {
        const presetId = activePane.getAttribute('data-wb-wallpaper-preset') ?? '';
        if (DARK_GRADIENT_PRESETS.has(presetId)) {
          target.setAttribute('data-wb-glass-tone', 'dark');
        } else {
          target.removeAttribute('data-wb-glass-tone');
        }
        return;
      }

      const cs = getComputedStyle(imgLayer);
      const url = parseCssUrl(cs.backgroundImage);
      if (!url) {
        target.removeAttribute('data-wb-glass-tone');
        return;
      }

      const wRect = wallpaperRoot.getBoundingClientRect();
      const tRect = target.getBoundingClientRect();
      if (wRect.width < 32 || wRect.height < 32 || tRect.width < 8 || tRect.height < 8) return;

      const [posX, posY] = parseBgPositionRatio(cs.backgroundPosition || '50% 50%');
      const dimmer = activePane.querySelector<HTMLElement>('.wb-wallpaper-dimmer');
      const dimOpacity = dimmer ? Number.parseFloat(getComputedStyle(dimmer).opacity) || 0 : 0;

      void loadWallpaperImage(url).then((img) => {
        if (cancelled || seq !== evalSeq || !img || !target.isConnected) return;
        const freshWRect = wallpaperRoot.getBoundingClientRect();
        const freshTRect = target.getBoundingClientRect();
        if (freshWRect.width < 32 || freshWRect.height < 32 || freshTRect.width < 8 || freshTRect.height < 8) {
          return;
        }
        const freshKey = `${url}|${posX.toFixed(2)},${posY.toFixed(2)}|${Math.round(freshWRect.width / 32)}x${Math.round(freshWRect.height / 32)}`;
        const sample = rasterizeCoverSample(img, freshWRect.width, freshWRect.height, posX, posY, freshKey);
        if (!sample) return;

        const normLeft = (freshTRect.left - freshWRect.left) / freshWRect.width;
        const normTop = (freshTRect.top - freshWRect.top) / freshWRect.height;
        const normW = freshTRect.width / freshWRect.width;
        const normH = freshTRect.height / freshWRect.height;
        const rawLum = computeRegionLuminance(sample, normLeft, normTop, normW, normH);
        if (rawLum === null) return;

        const effectiveLum = rawLum * (1 - Math.max(0, Math.min(0.6, dimOpacity)));
        if (effectiveLum < DARK_LUMINANCE_THRESHOLD) {
          target.setAttribute('data-wb-glass-tone', 'dark');
        } else {
          target.removeAttribute('data-wb-glass-tone');
        }
      });
    };

    const scheduleEvaluate = () => {
      if (rafId || cancelled) return;
      rafId =
        typeof window.requestAnimationFrame === 'function'
          ? window.requestAnimationFrame(evaluate)
          : (window.setTimeout(evaluate, 0) as unknown as number);
    };

    syncSiblingResizeTargets();
    ensureWallpaperObserved();
    evaluate();

    const htmlMo =
      typeof MutationObserver === 'function' ? new MutationObserver(scheduleEvaluate) : null;
    htmlMo?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-wb-material'],
    });

    // 监听同列父容器与兄弟组件折叠/展开/高度变动，避免自身尺寸未变但纵向位移后明度过期
    const parentEl = el.parentElement;
    const parentMo =
      parentEl && typeof MutationObserver === 'function'
        ? new MutationObserver(() => {
            syncSiblingResizeTargets();
            scheduleEvaluate();
          })
        : null;
    if (parentEl && parentMo) {
      parentMo.observe(parentEl, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-collapsed', 'style', 'class'],
      });
    }

    // 兜底监听桌面根节点：若壁纸节点晚于小组件挂载或被替换，立刻补挂观察器
    const desktopRoot = el.closest<HTMLElement>('[data-wb-desktop]');
    const desktopMo =
      desktopRoot && typeof MutationObserver === 'function'
        ? new MutationObserver(() => {
            ensureWallpaperObserved();
            scheduleEvaluate();
          })
        : null;
    if (desktopRoot && desktopMo) {
      desktopMo.observe(desktopRoot, { childList: true });
    }

    const mq =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(REDUCED_TRANSPARENCY_QUERY)
        : null;
    mq?.addEventListener?.('change', scheduleEvaluate);

    return () => {
      cancelled = true;
      evalSeq += 1;
      if (rafId) {
        if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(rafId);
        else window.clearTimeout(rafId);
      }
      ro?.disconnect();
      observedResizeTargets.clear();
      htmlMo?.disconnect();
      parentMo?.disconnect();
      desktopMo?.disconnect();
      wpMo?.disconnect();
      mq?.removeEventListener?.('change', scheduleEvaluate);
      el.removeAttribute('data-wb-glass-tone');
    };
  }, [ref, enabled]);
}
