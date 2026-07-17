import { REACTFLOW_CONFIG } from '../constants';

export interface MindMapViewport {
  x: number;
  y: number;
  zoom: number;
}

export const DEFAULT_MINDMAP_VIEWPORT: MindMapViewport = {
  x: 0,
  y: 0,
  zoom: 1,
};

export function normalizeMindMapViewport(
  viewport: Partial<MindMapViewport> | null | undefined,
): MindMapViewport | null {
  if (
    !viewport ||
    !Number.isFinite(viewport.x) ||
    !Number.isFinite(viewport.y) ||
    !Number.isFinite(viewport.zoom) ||
    Number(viewport.zoom) <= 0
  ) {
    return null;
  }

  return {
    x: Number(viewport.x),
    y: Number(viewport.y),
    zoom: Math.min(
      REACTFLOW_CONFIG.maxZoom,
      Math.max(REACTFLOW_CONFIG.minZoom, Number(viewport.zoom)),
    ),
  };
}

export function mergeMindMapViewport(
  previous: Partial<MindMapViewport> | null | undefined,
  partial: Partial<MindMapViewport>,
): MindMapViewport {
  const safePrevious = normalizeMindMapViewport(previous) ?? DEFAULT_MINDMAP_VIEWPORT;
  return normalizeMindMapViewport({
    x: Number.isFinite(partial.x) ? partial.x : safePrevious.x,
    y: Number.isFinite(partial.y) ? partial.y : safePrevious.y,
    zoom: Number.isFinite(partial.zoom) && Number(partial.zoom) > 0
      ? partial.zoom
      : safePrevious.zoom,
  }) ?? { ...DEFAULT_MINDMAP_VIEWPORT };
}
