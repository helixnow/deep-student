/**
 * Media Keyframe Snapshot & Transcript Cue Branch Tint Helper (C7 §2.2).
 *
 * Pure, cross-origin-safe helper module:
 * 1. `captureVideoKeyframeDataUrl(videoEl, { maxWidth: 320, quality: 0.78 })`:
 *    Synchronously captures a scaled thumbnail from `<video>` onto an offscreen canvas;
 *    gracefully returns `null` (never throws) on unready video, missing 2D context, or
 *    CORS/tainted-canvas `SecurityError`.
 * 2. `enrichMediaExcerptWithKeyframe`:
 *    Upgrades a media transcript excerpt (`ExcerptDragInput` / `ExcerptDragPayload`) with
 *    an optional keyframe snapshot (`excerptKind: 'region-image'`), falling back cleanly
 *    to `'transcript-cue'` when capture is unavailable or disabled.
 * 3. `resolveCueBranchTintMap`:
 *    Derives MindMap Mineral branch accent colors & subtle wash tints per media locator
 *    (`ms:<startMs>`) or transcript cue index (`cue.idx`), supporting explicit branch
 *    colors/tokens, URI metadata, and deterministic Mineral Zen celadon fallbacks.
 */
import {
  useEffect,
  useState,
} from 'react';
import {
  fnv1a64Hex,
  parseSemanticAnchor,
  type AnchorEdgeRecord,
  type ExcerptDragInput,
} from '@/ui-kernel/contracts/interop';
import {
  CUE_NEAREST_TOLERANCE_MS,
  findCueIndexForMs,
  type TranscriptCue,
} from './mediaInteropBridge';

export const DEFAULT_KEYFRAME_MAX_WIDTH = 320;
export const DEFAULT_KEYFRAME_QUALITY = 0.78;
export const DEFAULT_KEYFRAME_MIME_TYPE = 'image/jpeg';
/** 缩略图超过此大小时宁可保留文字摘录，不让 MIME 写入失败丢失整段字幕。 */
export const MAX_KEYFRAME_DATA_URL_LENGTH = 512 * 1024;

export function useMediaTintDarkTheme(): boolean {
  const detect = () => typeof document !== 'undefined'
    && (document.documentElement.classList.contains('dark') || document.documentElement.dataset.theme === 'dark');
  const [dark, setDark] = useState(detect);
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(detect()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    setDark(detect());
    return () => observer.disconnect();
  }, []);
  return dark;
}

/**
 * Mineral Zen 7-tone light & dark palettes (aligned with MindMap Mineral palettes,
 * zero cross-feature import).
 */
export const MINERAL_LIGHT_BRANCH_PALETTE = [
  '#B55A52', // Terracotta Red
  '#C27D48', // Warm Ochre Orange
  '#A6893E', // Bronze Amber
  '#2A6F5E', // Primary Celadon Green
  '#3B6E8C', // Porcelain Slate Blue
  '#6A5D8E', // Mist Amethyst Purple
  '#A85D74', // Dusk Plum Rose
] as const;

export const MINERAL_DARK_BRANCH_PALETTE = [
  '#D4857D',
  '#D99E6C',
  '#C9B168',
  '#5EA893',
  '#6B9EBD',
  '#9689BA',
  '#C9879C',
] as const;

const MINERAL_TOKEN_TO_INDEX: Readonly<Record<string, number>> = {
  red: 0,
  terracotta: 0,
  'branch-0': 0,
  '0': 0,
  orange: 1,
  ochre: 1,
  'branch-1': 1,
  '1': 1,
  amber: 2,
  yellow: 2,
  gold: 2,
  'branch-2': 2,
  '2': 2,
  green: 3,
  celadon: 3,
  mineral: 3,
  teal: 3,
  'branch-3': 3,
  '3': 3,
  blue: 4,
  slate: 4,
  porcelain: 4,
  'branch-4': 4,
  '4': 4,
  purple: 5,
  amethyst: 5,
  violet: 5,
  'branch-5': 5,
  '5': 5,
  pink: 6,
  rose: 6,
  plum: 6,
  'branch-6': 6,
  '6': 6,
};

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const SAFE_FUNCTIONAL_COLOR_RE =
  /^(?:rgb|rgba|hsl|hsla)\(\s*[-\d.%deg,\s/]+\)$|^var\(--[a-zA-Z0-9_-]+\)$/;

export interface KeyframeCaptureOptions {
  /** Maximum thumbnail width in pixels (default: 320). */
  maxWidth?: number;
  /** Optional maximum thumbnail height in pixels while preserving aspect ratio. */
  maxHeight?: number;
  /** Lossy encoder quality in [0.05, 1] (default: 0.78). */
  quality?: number;
  /** Output image MIME type (default: 'image/jpeg'). */
  mimeType?: 'image/jpeg' | 'image/webp' | 'image/png';
  /** Optional canvas factory for deterministic headless tests. */
  createCanvas?: () => HTMLCanvasElement;
}

export function computeKeyframeDimensions(
  videoWidth: number,
  videoHeight: number,
  maxWidth = DEFAULT_KEYFRAME_MAX_WIDTH,
  maxHeight = Number.POSITIVE_INFINITY,
): { width: number; height: number } | null {
  if (
    !Number.isFinite(videoWidth) ||
    !Number.isFinite(videoHeight) ||
    videoWidth <= 0 ||
    videoHeight <= 0
  ) {
    return null;
  }
  const safeMaxW =
    Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : DEFAULT_KEYFRAME_MAX_WIDTH;
  const safeMaxH =
    Number.isFinite(maxHeight) && maxHeight > 0 ? maxHeight : Number.POSITIVE_INFINITY;
  const scale = Math.min(1, safeMaxW / videoWidth, safeMaxH / videoHeight);
  return {
    width: Math.max(1, Math.round(videoWidth * scale)),
    height: Math.max(1, Math.round(videoHeight * scale)),
  };
}

/**
 * Captures the current `<video>` frame into a compact data URL (`image/jpeg` by default).
 * Cross-origin tainted canvases, unready decoders (`readyState < 2`), or missing canvas
 * contexts return `null` cleanly without throwing.
 */
export function captureVideoKeyframeDataUrl(
  videoEl: HTMLVideoElement | null | undefined,
  options?: KeyframeCaptureOptions,
): string | null {
  if (!videoEl) return null;
  if (typeof videoEl.readyState === 'number' && videoEl.readyState < 2) {
    return null;
  }

  const dims = computeKeyframeDimensions(
    videoEl.videoWidth,
    videoEl.videoHeight,
    options?.maxWidth,
    options?.maxHeight,
  );
  if (!dims) return null;

  if (!options?.createCanvas && typeof document === 'undefined') {
    return null;
  }

  const qualityRaw = options?.quality;
  const quality =
    typeof qualityRaw === 'number' && Number.isFinite(qualityRaw)
      ? Math.min(1, Math.max(0.05, qualityRaw))
      : DEFAULT_KEYFRAME_QUALITY;
  const mimeType = options?.mimeType ?? DEFAULT_KEYFRAME_MIME_TYPE;

  try {
    const canvas = options?.createCanvas
      ? options.createCanvas()
      : document.createElement('canvas');
    canvas.width = dims.width;
    canvas.height = dims.height;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(videoEl, 0, 0, dims.width, dims.height);
    const dataUrl =
      mimeType === 'image/png'
        ? canvas.toDataURL(mimeType)
        : canvas.toDataURL(mimeType, quality);

    if (
      typeof dataUrl !== 'string' ||
      !dataUrl.startsWith('data:image/') ||
      dataUrl === 'data:,' ||
      dataUrl.length <= 'data:image/png;base64,'.length ||
      dataUrl.length > MAX_KEYFRAME_DATA_URL_LENGTH
    ) {
      return null;
    }
    return dataUrl;
  } catch {
    // Gracefully swallow SecurityError (tainted cross-origin video) or canvas encoder errors.
    return null;
  }
}

export interface EnrichMediaExcerptOptions extends KeyframeCaptureOptions {
  /** When false, leaves the excerpt untouched without capturing a keyframe (default: true). */
  includeKeyframe?: boolean;
  /** Optional pre-captured keyframe data URL; if omitted, captures from `videoEl`. */
  keyframeDataUrl?: string | null;
}

/**
 * Enriches a transcript excerpt with a video keyframe thumbnail when available.
 * Falls back non-destructively to the original text/cue excerpt if capture returns `null`.
 */
export function enrichMediaExcerptWithKeyframe<T extends ExcerptDragInput>(
  excerpt: T,
  videoEl: HTMLVideoElement | null | undefined,
  options?: EnrichMediaExcerptOptions,
): T {
  if (options?.includeKeyframe === false) {
    return excerpt;
  }

  let dataUrl: string | null = null;
  if (options?.keyframeDataUrl !== undefined) {
    const candidate = options.keyframeDataUrl?.trim() ?? '';
    dataUrl =
       candidate.startsWith('data:image/') && candidate.length > 'data:image/png;base64,'.length
         && candidate.length <= MAX_KEYFRAME_DATA_URL_LENGTH
        ? candidate
        : null;
  } else {
    dataUrl = captureVideoKeyframeDataUrl(videoEl, options);
  }

  if (!dataUrl) {
    return excerpt;
  }

  return {
    ...excerpt,
    excerptKind: 'region-image',
    imageDataUrl: dataUrl,
  };
}

export type CueTintEdgeInput = AnchorEdgeRecord & {
  branchColor?: string | null;
  branchColorToken?: string | null;
  tintColor?: string | null;
  color?: string | null;
};

export interface CueBranchTint {
  /** Solid Mineral branch color for the left accent bar (`2px`–`3px`). */
  accentColor: string;
  /** Subtle low-saturation background wash (`~10%` opacity). */
  tintBackground: string;
  /** Raw or canonical token name when derived from a semantic branch token. */
  branchColorToken: string;
  /** Primary MindMap resource ID owning this tint. */
  sourceResourceId: string;
  /** MindMap node ID (`sourceSubId`). */
  sourceSubId: string;
  /** Human-readable MindMap node title. */
  sourceLabel: string;
  /** Canonical locator key (`ms:<startMs>`). */
  locatorKey: string;
  /** Resolved start timestamp in ms. */
  startMs: number;
  /** Optional end timestamp in ms when the excerpt spans a window. */
  endMs: number | null;
  /** Number of MindMap edges mapped to this cue/locator. */
  edgeCount: number;
  /** Distinct accent colors across all MindMap edges on this cue/locator. */
  allAccentColors: string[];
}

export interface ResolveCueBranchTintOptions {
  /** Select night-stone Mineral palette for dark surfaces (default: false). */
  dark?: boolean;
  /** Nearest-cue tolerance in ms when mapping point timestamps to cues (default: 2000). */
  toleranceMs?: number;
}

function expandShortHex(hex: string): string {
  if (hex.length === 4) {
    const r = hex[1];
    const g = hex[2];
    const b = hex[3];
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  return hex.slice(0, 7).toUpperCase();
}

function buildSubtleWash(accentColor: string, alpha = 0.1): string {
  if (HEX_COLOR_RE.test(accentColor)) {
    const hex6 = expandShortHex(accentColor);
    const r = Number.parseInt(hex6.slice(1, 3), 16);
    const g = Number.parseInt(hex6.slice(3, 5), 16);
    const b = Number.parseInt(hex6.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const pct = Math.round(alpha * 100);
  return `color-mix(in srgb, ${accentColor} ${pct}%, transparent)`;
}

function extractColorHintFromUri(uri: string): string | null {
  if (!uri || !uri.includes('?')) return null;
  const qIdx = uri.indexOf('?');
  const rawQuery = uri.slice(qIdx + 1);
  for (const part of rawQuery.split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    let key = '';
    let val = '';
    try {
      key = decodeURIComponent(part.slice(0, eq));
      val = decodeURIComponent(part.slice(eq + 1));
    } catch {
      continue;
    }
    if (
      key === 'branchColor' ||
      key === 'branchColorToken' ||
      key === 'color' ||
      key === 'p.branchColor' ||
      key === 'p.branchColorToken' ||
      key === 'p.color'
    ) {
      const trimmed = val.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

export function resolveEdgeBranchColor(
  edge: CueTintEdgeInput,
  dark = false,
): { accentColor: string; branchColorToken: string } {
  const palette = dark ? MINERAL_DARK_BRANCH_PALETTE : MINERAL_LIGHT_BRANCH_PALETTE;
  const rawCandidates = [
    edge.branchColorToken,
    edge.branchColor,
    edge.tintColor,
    edge.color,
    extractColorHintFromUri(edge.sourceAnchorUri),
  ];

  for (const candidate of rawCandidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;

    const lower = trimmed.toLowerCase();
    const mappedIdx = MINERAL_TOKEN_TO_INDEX[lower];
    if (mappedIdx !== undefined) {
      return {
        accentColor: palette[mappedIdx],
        branchColorToken: lower,
      };
    }

    if (HEX_COLOR_RE.test(trimmed)) {
      const normalizedHex = expandShortHex(trimmed);
      return {
        accentColor: normalizedHex,
        branchColorToken: normalizedHex,
      };
    }

    if (SAFE_FUNCTIONAL_COLOR_RE.test(trimmed)) {
      return {
        accentColor: trimmed,
        branchColorToken: trimmed,
      };
    }
  }

  // Deterministic Mineral Zen palette selection by MindMap node/resource identity.
  const seed = `${edge.sourceResourceId}:${edge.sourceSubId || edge.sourceAnchorUri}`;
  const hashHex = fnv1a64Hex(seed);
  const bucket = Number(BigInt(`0x${hashHex}`) % BigInt(palette.length));
  return {
    accentColor: palette[bucket],
    branchColorToken: `branch-${bucket}`,
  };
}

function resolveMediaTiming(
  edge: AnchorEdgeRecord,
): { startMs: number; endMs: number | null; locatorKey: string } | null {
  let startMs: number | null =
    typeof edge.targetStartMs === 'number' &&
    Number.isFinite(edge.targetStartMs) &&
    edge.targetStartMs >= 0
      ? Math.round(edge.targetStartMs)
      : null;
  let endMs: number | null =
    typeof edge.targetEndMs === 'number' &&
    Number.isFinite(edge.targetEndMs) &&
    edge.targetEndMs >= 0
      ? Math.round(edge.targetEndMs)
      : null;

  if (startMs === null || endMs === null) {
    const parsed = parseSemanticAnchor(edge.targetAnchorUri);
    if (parsed && parsed.kind === 'media') {
      if (startMs === null) startMs = parsed.startMs;
      if (endMs === null && parsed.endMs !== undefined) endMs = parsed.endMs;
    }
  }

  if (startMs === null && typeof edge.targetLocatorKey === 'string') {
    const match = /^ms:(\d+)$/.exec(edge.targetLocatorKey.trim());
    if (match) {
      startMs = Number(match[1]);
    }
  }

  if (startMs === null || !Number.isFinite(startMs) || startMs < 0) {
    return null;
  }

  const normalizedEnd = endMs !== null ? Math.max(startMs, endMs) : null;
  const locatorKey =
    edge.targetLocatorKey && edge.targetLocatorKey.startsWith('ms:')
      ? edge.targetLocatorKey
      : `ms:${startMs}`;

  return { startMs, endMs: normalizedEnd, locatorKey };
}

interface InternalTintAccumulator {
  primaryEdge: CueTintEdgeInput;
  accentColor: string;
  branchColorToken: string;
  locatorKey: string;
  startMs: number;
  endMs: number | null;
  edgeCount: number;
  allAccentColors: string[];
}

function upsertTintAccumulator<K>(
  map: Map<K, InternalTintAccumulator>,
  key: K,
  edge: CueTintEdgeInput,
  colorInfo: { accentColor: string; branchColorToken: string },
  timing: { startMs: number; endMs: number | null; locatorKey: string },
): void {
  const existing = map.get(key);
  if (!existing) {
    map.set(key, {
      primaryEdge: edge,
      accentColor: colorInfo.accentColor,
      branchColorToken: colorInfo.branchColorToken,
      locatorKey: timing.locatorKey,
      startMs: timing.startMs,
      endMs: timing.endMs,
      edgeCount: 1,
      allAccentColors: [colorInfo.accentColor],
    });
    return;
  }

  existing.edgeCount += 1;
  if (!existing.allAccentColors.includes(colorInfo.accentColor)) {
    existing.allAccentColors.push(colorInfo.accentColor);
  }

  // Prefer the most recently updated MindMap edge when branch color was changed.
  if ((edge.updatedAt ?? 0) > (existing.primaryEdge.updatedAt ?? 0)
    || ((edge.updatedAt ?? 0) === (existing.primaryEdge.updatedAt ?? 0)
      && edge.edgeId < existing.primaryEdge.edgeId)) {
    existing.primaryEdge = edge;
    existing.accentColor = colorInfo.accentColor;
    existing.branchColorToken = colorInfo.branchColorToken;
    existing.locatorKey = timing.locatorKey;
    existing.startMs = timing.startMs;
    existing.endMs = timing.endMs;
  }
}

function finalizeTintMap<K>(
  accumulators: Map<K, InternalTintAccumulator>,
  dark: boolean,
): Map<K, CueBranchTint> {
  const alpha = dark ? 0.14 : 0.1;
  const out = new Map<K, CueBranchTint>();
  for (const [key, item] of accumulators.entries()) {
    out.set(key, {
      accentColor: item.accentColor,
      tintBackground: buildSubtleWash(item.accentColor, alpha),
      branchColorToken: item.branchColorToken,
      sourceResourceId: item.primaryEdge.sourceResourceId,
      sourceSubId: item.primaryEdge.sourceSubId,
      sourceLabel: item.primaryEdge.sourceLabel,
      locatorKey: item.locatorKey,
      startMs: item.startMs,
      endMs: item.endMs,
      edgeCount: item.edgeCount,
      allAccentColors: item.allAccentColors,
    });
  }
  return out;
}

/**
 * Resolves MindMap branch accent bars & subtle wash tints from `vfs_anchor_edges`.
 * - Called as `resolveCueBranchTintMap(edges, options?)`: returns `Map<string, CueBranchTint>`
 *   keyed by canonical media locator (`ms:<startMs>`).
 * - Called as `resolveCueBranchTintMap(edges, cues, options?)`: returns `Map<number, CueBranchTint>`
 *   keyed by `cue.idx` (matching both `[startMs, endMs)` spans and `±toleranceMs` nearest cue).
 */
export function resolveCueBranchTintMap(
  edges: readonly CueTintEdgeInput[],
  options?: ResolveCueBranchTintOptions,
): Map<string, CueBranchTint>;
export function resolveCueBranchTintMap(
  edges: readonly CueTintEdgeInput[],
  cues: readonly TranscriptCue[],
  options?: ResolveCueBranchTintOptions,
): Map<number, CueBranchTint>;
export function resolveCueBranchTintMap(
  edges: readonly CueTintEdgeInput[],
  cuesOrOptions?: readonly TranscriptCue[] | ResolveCueBranchTintOptions,
  maybeOptions?: ResolveCueBranchTintOptions,
): Map<string, CueBranchTint> | Map<number, CueBranchTint> {
  const hasCues = Array.isArray(cuesOrOptions);
  const cues = hasCues ? (cuesOrOptions as readonly TranscriptCue[]) : null;
  const options = hasCues
    ? maybeOptions
    : (cuesOrOptions as ResolveCueBranchTintOptions | undefined);

  const dark = Boolean(options?.dark);
  const toleranceMs = options?.toleranceMs ?? CUE_NEAREST_TOLERANCE_MS;
  const latestById = new Map<string, CueTintEdgeInput>();
  for (const edge of edges) {
    if (!edge || edge.sourceKind !== 'mindmap' || edge.targetKind !== 'media') continue;
    const previous = latestById.get(edge.edgeId);
    if (!previous || edge.updatedAt >= previous.updatedAt) latestById.set(edge.edgeId, edge);
  }

  if (!cues) {
    const byLocator = new Map<string, InternalTintAccumulator>();
    for (const edge of latestById.values()) {
      const timing = resolveMediaTiming(edge);
      if (!timing) continue;
      const colorInfo = resolveEdgeBranchColor(edge, dark);
      upsertTintAccumulator(byLocator, timing.locatorKey, edge, colorInfo, timing);
    }
    return finalizeTintMap(byLocator, dark);
  }

  const byCueIndex = new Map<number, InternalTintAccumulator>();
  if (cues.length === 0) return finalizeTintMap(byCueIndex, dark);

  for (const edge of latestById.values()) {
    const timing = resolveMediaTiming(edge);
    if (!timing) continue;

    const colorInfo = resolveEdgeBranchColor(edge, dark);
    const matchedCueIndices: number[] = [];

    if (timing.endMs !== null && timing.endMs > timing.startMs) {
      for (const cue of cues) {
        if (cue.endMs > timing.startMs && cue.startMs < timing.endMs) {
          matchedCueIndices.push(cue.idx);
        }
      }
    } else {
      // 重叠字幕（如双语轨）的同一时间点可能属于多行，不应只染第一行。
      for (const cue of cues) {
        if (cue.startMs <= timing.startMs && timing.startMs < cue.endMs) matchedCueIndices.push(cue.idx);
      }
    }

    if (matchedCueIndices.length === 0) {
      const nearestIdx = findCueIndexForMs(cues, timing.startMs, toleranceMs);
      if (nearestIdx !== null) {
        matchedCueIndices.push(nearestIdx);
      }
    }

    for (const cueIdx of matchedCueIndices) {
      upsertTintAccumulator(byCueIndex, cueIdx, edge, colorInfo, timing);
    }
  }

  return finalizeTintMap(byCueIndex, dark);
}
