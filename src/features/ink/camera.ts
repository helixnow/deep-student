/**
 * E1 board camera.
 *
 * Canonical transform is {x, y, zoom}: (x, y) is the world coordinate shown
 * at the viewport's top-left corner. Screen coordinates are CSS pixels local to
 * the canvas. Device-pixel-ratio scaling is owned by the renderer only.
 *
 * View state is local machine state. Persisting it never touches canonical
 * revisions and must not trigger sync conflicts.
 */
import type { InkBoardBounds } from './types';

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export const DEFAULT_CAMERA: Camera = Object.freeze({ x: 0, y: 0, zoom: 1 });
export const CAMERA_MIN_ZOOM = 0.05;
export const CAMERA_MAX_ZOOM = 32;
/** v2 signed world safety range from the roadmap; camera is clamped inside it. */
export const CAMERA_WORLD_LIMIT = 10_000_000;
export const CAMERA_STORAGE_PREFIX = 'dstu.ink.board.view:';

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function worldToScreen(point: { x: number; y: number }, camera: Camera): { x: number; y: number } {
  return {
    x: (point.x - camera.x) * camera.zoom,
    y: (point.y - camera.y) * camera.zoom,
  };
}

export function screenToWorld(point: { x: number; y: number }, camera: Camera): { x: number; y: number } {
  return {
    x: point.x / camera.zoom + camera.x,
    y: point.y / camera.zoom + camera.y,
  };
}

/**
 * Changes zoom while keeping the world point currently under `anchorScreen`
 * under the same screen point. Zoom is clamped to the finite range.
 */
export function zoomCameraAt(camera: Camera, anchorScreen: { x: number; y: number }, zoom: number): Camera {
  const current = clampCamera(camera);
  if (!finite(anchorScreen.x) || !finite(anchorScreen.y)) return current;
  const nextZoom = finite(zoom) && zoom > 0
    ? clamp(zoom, CAMERA_MIN_ZOOM, CAMERA_MAX_ZOOM)
    : current.zoom;
  const world = screenToWorld(anchorScreen, current);
  return clampCamera({
    x: world.x - anchorScreen.x / nextZoom,
    y: world.y - anchorScreen.y / nextZoom,
    zoom: nextZoom,
  });
}

/** Drags the content by a CSS-pixel delta: moving content right moves camera left. */
export function panCameraBy(camera: Camera, dxScreen: number, dyScreen: number): Camera {
  const current = clampCamera(camera);
  if (!finite(dxScreen) || !finite(dyScreen)) return current;
  return clampCamera({
    x: current.x - dxScreen / current.zoom,
    y: current.y - dyScreen / current.zoom,
    zoom: current.zoom,
  });
}

export function clampCamera(camera: Camera, fallback: Camera = DEFAULT_CAMERA): Camera {
  const fallbackZoom = finite(fallback.zoom) && fallback.zoom > 0
    ? clamp(fallback.zoom, CAMERA_MIN_ZOOM, CAMERA_MAX_ZOOM)
    : DEFAULT_CAMERA.zoom;
  const zoom = finite(camera.zoom) && camera.zoom > 0
    ? clamp(camera.zoom, CAMERA_MIN_ZOOM, CAMERA_MAX_ZOOM)
    : fallbackZoom;
  const x = finite(camera.x) ? clamp(camera.x, -CAMERA_WORLD_LIMIT, CAMERA_WORLD_LIMIT) : fallback.x;
  const y = finite(camera.y) ? clamp(camera.y, -CAMERA_WORLD_LIMIT, CAMERA_WORLD_LIMIT) : fallback.y;
  return { x, y, zoom };
}

export function cameraViewportRect(camera: Camera, viewport: ViewportSize): InkBoardBounds {
  const current = clampCamera(camera);
  if (!finite(viewport.width) || !finite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) {
    return { x: current.x, y: current.y, width: 0, height: 0 };
  }
  return {
    x: current.x,
    y: current.y,
    width: viewport.width / current.zoom,
    height: viewport.height / current.zoom,
  };
}

export function cameraStorageKey(documentId: string): string {
  return `${CAMERA_STORAGE_PREFIX}${documentId}`;
}

export function loadCameraState(
  documentId: string,
  storage: Pick<Storage, 'getItem'> = localStorage,
): Camera | null {
  try {
    const raw = storage.getItem(cameraStorageKey(documentId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = parsed as Partial<Camera>;
    if (!finite(value.x as number) || !finite(value.y as number) || !finite(value.zoom as number)) return null;
    if ((value.zoom as number) <= 0) return null;
    return clampCamera(value as Camera);
  } catch {
    return null;
  }
}

export function saveCameraState(
  documentId: string,
  camera: Camera,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  try {
    const value = clampCamera(camera);
    storage.setItem(cameraStorageKey(documentId), JSON.stringify(value));
  } catch {
    // Local view state is best-effort; a full/denied storage must not break editing.
  }
}
