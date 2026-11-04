import { describe, expect, it } from 'vitest';
import {
  CAMERA_MAX_ZOOM,
  CAMERA_MIN_ZOOM,
  DEFAULT_CAMERA,
  cameraViewportRect,
  clampCamera,
  loadCameraState,
  panCameraBy,
  saveCameraState,
  screenToWorld,
  worldToScreen,
  zoomCameraAt,
  type Camera,
} from './camera';

const close = (actual: { x: number; y: number }, expected: { x: number; y: number }) => {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
};

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('board camera', () => {
  it('maps signed world coordinates through a non-default camera', () => {
    const camera: Camera = { x: -1250, y: 830, zoom: 2.5 };
    close(worldToScreen({ x: -100, y: -200 }, camera), { x: 2875, y: -2575 });
  });

  it('round-trips negative world coordinates and inverts a non-default camera', () => {
    const camera: Camera = { x: -4000, y: -2500, zoom: 0.75 };
    const world = { x: -3200, y: -1800 };
    const screen = worldToScreen(world, camera);

    expect(screen.x).not.toBe(world.x);
    close(screenToWorld(screen, camera), world);
  });

  it('keeps the world point under the anchor fixed while zooming', () => {
    const camera: Camera = { x: -120, y: 40, zoom: 1.5 };
    const anchor = { x: 320, y: 240 };
    const worldAtAnchor = screenToWorld(anchor, camera);
    const next = zoomCameraAt(camera, anchor, 3);

    expect(next.zoom).toBe(3);
    close(worldToScreen(worldAtAnchor, next), anchor);
    close({ x: next.x, y: next.y }, { x: -13.3333333333, y: 120 });
    expect(next.x).toBeGreaterThan(camera.x);
    expect(next.y).toBeGreaterThan(camera.y);
  });

  it('anchors zoom around a viewport point that is not the origin', () => {
    const camera: Camera = { x: 10, y: -20, zoom: 2 };
    const anchor = { x: 0, y: 0 };
    const next = zoomCameraAt(camera, anchor, 4);

    close(screenToWorld(anchor, next), screenToWorld(anchor, camera));
  });

  it('pans the content by screen pixels regardless of zoom', () => {
    const camera: Camera = { x: 100, y: -50, zoom: 2 };
    expect(panCameraBy(camera, 40, -20)).toEqual({ x: 80, y: -40, zoom: 2 });
    expect(panCameraBy({ ...camera, zoom: 0.5 }, 40, -20)).toEqual({ x: 20, y: -10, zoom: 0.5 });
  });

  it('clamps non-finite input and enforces finite zoom and world ranges', () => {
    const low = clampCamera({ x: Number.NaN, y: Number.POSITIVE_INFINITY, zoom: 0 });
    expect(low).toEqual(DEFAULT_CAMERA);

    const high = clampCamera({ x: 1e12, y: -1e12, zoom: 1e12 });
    expect(Number.isFinite(high.x)).toBe(true);
    expect(Number.isFinite(high.y)).toBe(true);
    expect(high.zoom).toBeLessThanOrEqual(CAMERA_MAX_ZOOM);
    expect(high.zoom).toBeGreaterThanOrEqual(CAMERA_MIN_ZOOM);
    expect(Math.abs(high.x)).toBeLessThanOrEqual(10_000_000);
    expect(Math.abs(high.y)).toBeLessThanOrEqual(10_000_000);
  });

  it('returns the signed world rect visible through a viewport', () => {
    expect(cameraViewportRect({ x: -100, y: -50, zoom: 2 }, { width: 400, height: 300 }))
      .toEqual({ x: -100, y: -50, width: 200, height: 150 });
    expect(cameraViewportRect({ x: 500, y: 700, zoom: 0.5 }, { width: 100, height: 80 }))
      .toEqual({ x: 500, y: 700, width: 200, height: 160 });
  });

  it('round-trips per-document view state and ignores corrupt entries', () => {
    const storage = new MemoryStorage();
    const camera: Camera = { x: -1234.5, y: 987.25, zoom: 3.5 };

    saveCameraState('doc-a', camera, storage);
    expect(loadCameraState('doc-a', storage)).toEqual(camera);
    expect(loadCameraState('doc-b', storage)).toBeNull();

    storage.setItem('dstu.ink.board.view:doc-a', '{not valid json');
    expect(loadCameraState('doc-a', storage)).toBeNull();
  });
});
