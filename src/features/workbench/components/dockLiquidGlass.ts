/**
 * Dock Liquid Glass 实景光学折射适配层
 * ---------------------------------------------------------------------------
 * 委托统一的 core/liquidGlassSurface.ts 引擎，使用 'clear' 清透高穿透档位。
 */
import type { RefObject } from 'react';
import {
  buildSurfaceDisplacementImageData,
  buildSurfaceDisplacementMapDataUrl,
  useLiquidGlassSurfaceFilter,
} from '../core/liquidGlassSurface';

export function buildPillDisplacementImageData(
  cssWidth: number,
  cssHeight: number,
  radiusCss: number,
): { width: number; height: number; data: Uint8ClampedArray } {
  return buildSurfaceDisplacementImageData(cssWidth, cssHeight, radiusCss, 'clear');
}

export function buildPillDisplacementMapDataUrl(
  cssWidth: number,
  cssHeight: number,
  radiusCss: number,
): string | null {
  return buildSurfaceDisplacementMapDataUrl(cssWidth, cssHeight, radiusCss, 'clear');
}

export function useDockLiquidGlassFilter(
  dockRef: RefObject<HTMLElement | null>,
  enabled = true,
): void {
  useLiquidGlassSurfaceFilter(dockRef, enabled, { variant: 'clear' });
}
