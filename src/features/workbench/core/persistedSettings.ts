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

/** 桌面（Space）名称长度上限（按 Unicode 码点计，超出截断） */
export const DESKTOP_NAME_MAX_LENGTH = 24;

/**
 * Parse the persisted desktop (space) name — Spaces 最小命名桌面的解析层。
 *
 * 返回清洗后的自定义名称；未设置 / 非字符串 / 清洗后为空 → null
 * （调用方回退默认品牌名 `menubar.appName`）。清洗规则：
 * 控制字符（含换行）替换为空格 → 连续空白折叠为单空格 → 两端去空 →
 * 按码点截断到 DESKTOP_NAME_MAX_LENGTH（Array.from 保证不劈开代理对）。
 */
export function parsePersistedDesktopName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  const points = Array.from(cleaned);
  return points.length > DESKTOP_NAME_MAX_LENGTH
    ? points.slice(0, DESKTOP_NAME_MAX_LENGTH).join('').trimEnd()
    : cleaned;
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
