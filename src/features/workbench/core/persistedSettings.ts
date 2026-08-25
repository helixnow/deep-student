import type { WallpaperConfig } from '../components/WallpaperLayer';

export interface PersistedTileMargins {
  enabled: boolean;
  px: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Parse wallpaper settings from either the settings backend/localStorage JSON
 * or the workbench settings-changed event payload.
 */
export function parsePersistedWallpaper(
  value: unknown,
  fallback: WallpaperConfig,
): WallpaperConfig {
  const parsed = parseRecord(value);
  if (
    !parsed
    || (parsed.kind !== 'theme' && parsed.kind !== 'image')
    || typeof parsed.value !== 'string'
    || parsed.value.length === 0
  ) {
    return { ...fallback };
  }

  if (parsed.kind === 'theme') {
    return { kind: 'theme', value: parsed.value };
  }

  const result: WallpaperConfig = { kind: 'image', value: parsed.value };
  const imageBlur = finiteNumber(parsed.imageBlur);
  const imageDim = finiteNumber(parsed.imageDim);
  if (imageBlur !== null) result.imageBlur = clamp(imageBlur, 0, 40);
  if (imageDim !== null) result.imageDim = clamp(imageDim, 0, 0.6);
  if (typeof parsed.imageVignette === 'boolean') {
    result.imageVignette = parsed.imageVignette;
  }
  return result;
}

/** Parse and clamp the workbench tiling margin preference field-by-field. */
export function parsePersistedTileMargins(
  value: unknown,
  fallback: PersistedTileMargins,
): PersistedTileMargins {
  const parsed = parseRecord(value);
  if (!parsed) return { ...fallback };
  const px = finiteNumber(parsed.px);
  return {
    enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : fallback.enabled,
    px: px === null ? fallback.px : clamp(px, 0, 32),
  };
}
