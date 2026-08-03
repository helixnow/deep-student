import type { BrowserSurfaceBounds, BrowserSurfaceOcclusion } from './types';

export interface BrowserSurfaceViewport {
  width: number;
  height: number;
}

export interface BrowserSurfaceVisibilityState {
  isVisible: boolean;
  hasSession: boolean;
  overlayOpen: boolean;
  suspended: boolean;
}

export interface BrowserSurfaceShellMotionState {
  globalDragging: boolean;
  globalSettling: boolean;
  ownWindowDragging: boolean;
}

type RectLike = Pick<DOMRectReadOnly, 'left' | 'top' | 'width' | 'height'>;

interface NormalizedRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// Keep this in step with BrowserService::MAX_SURFACE_OCCLUSIONS. The fallback
// below over-occludes rather than letting native content draw above the DOM.
const MAX_NATIVE_SURFACE_OCCLUSIONS = 64;

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * Keep coordinates in logical CSS pixels. Rust receives the viewport too and
 * owns platform-specific clipping / scale-factor conversion.
 */
export function browserSurfaceBoundsFromRect(
  rect: RectLike,
  viewport: BrowserSurfaceViewport,
): BrowserSurfaceBounds | null {
  const values = [
    rect.left,
    rect.top,
    rect.width,
    rect.height,
    viewport.width,
    viewport.height,
  ];
  if (!values.every(Number.isFinite)) return null;
  if (!isPositiveFinite(rect.width) || !isPositiveFinite(rect.height)) return null;
  if (!isPositiveFinite(viewport.width) || !isPositiveFinite(viewport.height)) return null;

  const right = rect.left + rect.width;
  const rawBottom = rect.top + rect.height;
  if (!Number.isFinite(right) || !Number.isFinite(rawBottom)) return null;

  // Keep the original frame while it still intersects the native window. The
  // OS clips the child WebView at the outer window edge, preserving page width,
  // scroll position, and the correct content origin during partial overflow.
  if (
    right <= 0 ||
    rect.left >= viewport.width ||
    rawBottom <= 0 ||
    rect.top >= viewport.height
  ) {
    return null;
  }

  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
  };
}

function normalizedRect(rect: RectLike): NormalizedRect | null {
  if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) return null;
  if (!isPositiveFinite(rect.width) || !isPositiveFinite(rect.height)) return null;
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  if (!Number.isFinite(right) || !Number.isFinite(bottom)) return null;
  return { left: rect.left, top: rect.top, right, bottom };
}

function intersectRects(a: NormalizedRect, b: NormalizedRect): NormalizedRect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

/**
 * Return a non-overlapping union. The macOS native mask uses an even-odd fill
 * rule, so intersecting input rectangles would otherwise re-expose their
 * overlap instead of cutting a single hole through the browser surface.
 */
function unionRects(rects: NormalizedRect[]): NormalizedRect[] {
  const yEdges = [...new Set(rects.flatMap((rect) => [rect.top, rect.bottom]))]
    .sort((a, b) => a - b);
  const rows: NormalizedRect[] = [];

  for (let index = 0; index < yEdges.length - 1; index += 1) {
    const top = yEdges[index];
    const bottom = yEdges[index + 1];
    if (bottom <= top) continue;
    const intervals = rects
      .filter((rect) => rect.top < bottom && rect.bottom > top)
      .map((rect) => ({ left: rect.left, right: rect.right }))
      .sort((a, b) => a.left - b.left || a.right - b.right);
    const merged: Array<{ left: number; right: number }> = [];
    for (const interval of intervals) {
      const previous = merged.at(-1);
      if (previous && interval.left <= previous.right) {
        previous.right = Math.max(previous.right, interval.right);
      } else {
        merged.push({ ...interval });
      }
    }
    rows.push(...merged.map(({ left, right }) => ({ left, top, right, bottom })));
  }

  const result: NormalizedRect[] = [];
  for (const row of rows) {
    const previous = result.at(-1);
    if (
      previous &&
      previous.left === row.left &&
      previous.right === row.right &&
      previous.bottom === row.top
    ) {
      previous.bottom = row.bottom;
    } else {
      result.push(row);
    }
  }
  return result;
}

function containingRect(rects: NormalizedRect[]): NormalizedRect | null {
  if (rects.length === 0) return null;
  return rects.reduce<NormalizedRect>(
    (bounds, rect) => ({
      left: Math.min(bounds.left, rect.left),
      top: Math.min(bounds.top, rect.top),
      right: Math.max(bounds.right, rect.right),
      bottom: Math.max(bounds.bottom, rect.bottom),
    }),
    { ...rects[0] },
  );
}

/**
 * Intersect DOM elements above the browser slot with the visible native
 * viewport. The result preserves the browser's full frame and only describes
 * pixel regions that the native host must let the DOM paint and receive input.
 */
export function browserSurfaceOcclusionsFromRects(
  surface: RectLike,
  viewport: BrowserSurfaceViewport,
  occluders: Iterable<RectLike>,
): BrowserSurfaceOcclusion[] {
  const surfaceRect = normalizedRect(surface);
  const viewportRect = normalizedRect({
    left: 0,
    top: 0,
    width: viewport.width,
    height: viewport.height,
  });
  if (!surfaceRect || !viewportRect) return [];
  const visibleSurface = intersectRects(surfaceRect, viewportRect);
  if (!visibleSurface) return [];

  const clipped = Array.from(occluders, normalizedRect)
    .filter((rect): rect is NormalizedRect => rect != null)
    .map((rect) => intersectRects(rect, visibleSurface))
    .filter((rect): rect is NormalizedRect => rect != null);

  const union = unionRects(clipped);
  // A large number of intersecting windows can produce more rectangular
  // bands than the native command accepts. One containing hole is visually
  // conservative, but never exposes browser pixels above DOM UI.
  const bounded =
    union.length <= MAX_NATIVE_SURFACE_OCCLUSIONS
      ? union
      : (() => {
          const bounds = containingRect(union);
          return bounds ? [bounds] : [];
        })();

  return bounded.map((rect) => ({
    x: rect.left,
    y: rect.top,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
  }));
}

export function shouldShowBrowserSurface(state: BrowserSurfaceVisibilityState): boolean {
  return (
    state.isVisible &&
    state.hasSession &&
    !state.overlayOpen &&
    !state.suspended
  );
}

/**
 * A moving browser window can keep its native child WebView aligned live.
 * Resize/settle and gestures owned by another internal window still suspend it
 * because the child WebView cannot be clipped or occluded by the React shell.
 */
export function shouldSuspendBrowserSurfaceForShellMotion(
  state: BrowserSurfaceShellMotionState,
): boolean {
  // Moving either this browser window or another internal window is mirrored
  // to the native mask at animation-frame cadence. Only layout settle needs a
  // short suspension while transformed DOM geometry becomes authoritative.
  return state.globalSettling;
}
