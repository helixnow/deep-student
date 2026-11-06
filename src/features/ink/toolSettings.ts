/**
 * Data-driven ink tool defaults and presets.
 *
 * These values are UI-level choices only: persisted strokes keep the v1
 * `InkStrokeStyle` shape (`tool`, `color`, `width`, `pressure_enabled`).
 * Highlighter opacity is encoded in the color's alpha channel so old
 * documents remain readable without a schema change.
 */

export type InkToolName = 'pen' | 'highlighter';

export interface InkToolStyleSettings {
  /** Base color as a six-digit lowercase hex string. */
  color: string;
  /** Stroke width in logical page units. */
  width: number;
  /** Highlighter opacity in the 0..1 range. */
  opacity: number;
}

export interface InkColorPreset {
  id: string;
  value: string;
  labelKey: string;
  /** Legacy CT selector retained for pre-stage-B tests. */
  legacyTestId?: string;
}

export interface InkWidthPreset {
  value: number;
  /** Legacy CT selector retained for pre-stage-B tests. */
  legacyTestId?: string;
}

export const INK_COLOR_PRESETS: readonly InkColorPreset[] = [
  { id: 'black', value: '#000000', labelKey: 'colors.black', legacyTestId: 'ink-color-black' },
  { id: 'dark-gray', value: '#4b5563', labelKey: 'colors.dark-gray' },
  { id: 'white', value: '#ffffff', labelKey: 'colors.white' },
  { id: 'red', value: '#ff0000', labelKey: 'colors.red', legacyTestId: 'ink-color-red' },
  { id: 'orange', value: '#ff8c00', labelKey: 'colors.orange' },
  { id: 'yellow', value: '#ffd400', labelKey: 'colors.yellow' },
  { id: 'green', value: '#22c55e', labelKey: 'colors.green' },
  { id: 'cyan', value: '#06b6d4', labelKey: 'colors.cyan' },
  { id: 'blue', value: '#0000ff', labelKey: 'colors.blue', legacyTestId: 'ink-color-blue' },
  { id: 'indigo', value: '#4f46e5', labelKey: 'colors.indigo' },
  { id: 'purple', value: '#9333ea', labelKey: 'colors.purple' },
  { id: 'pink', value: '#ec4899', labelKey: 'colors.pink' },
] as const;

export const INK_PEN_WIDTH_PRESETS: readonly InkWidthPreset[] = [
  { value: 1 },
  { value: 2, legacyTestId: 'ink-width-small' },
  { value: 4 },
  { value: 6 },
  { value: 8, legacyTestId: 'ink-width-medium' },
  { value: 12, legacyTestId: 'ink-width-large' },
  { value: 18 },
  { value: 24 },
];

// The 2-unit entry is retained so the legacy `ink-width-small` control keeps
// working when the highlighter is selected; the other values follow the
// highlighter preset range from the roadmap.
export const INK_HIGHLIGHTER_WIDTH_PRESETS: readonly InkWidthPreset[] = [
  { value: 2, legacyTestId: 'ink-width-small' },
  { value: 4 },
  { value: 8, legacyTestId: 'ink-width-medium' },
  { value: 12, legacyTestId: 'ink-width-large' },
  { value: 18 },
  { value: 24 },
  { value: 32 },
];

export const INK_ERASER_SIZES = [4, 8, 16, 32, 64] as const;
export const INK_ERASER_SIZE_MIN = 4;
export const INK_ERASER_SIZE_MAX = 64;
export const DEFAULT_ERASER_SIZE = 16;

export const DEFAULT_TOOL_SETTINGS: Record<InkToolName, InkToolStyleSettings> = {
  pen: { color: '#000000', width: 8, opacity: 1 },
  // 0.5 rounds to the historical highlighter alpha byte 0x80.
  highlighter: { color: '#000000', width: 8, opacity: 0.5 },
};

export function widthPresetsFor(tool: InkToolName): readonly InkWidthPreset[] {
  return tool === 'highlighter' ? INK_HIGHLIGHTER_WIDTH_PRESETS : INK_PEN_WIDTH_PRESETS;
}

export function inkWidthBounds(tool: InkToolName): { min: number; max: number } {
  return { min: tool === 'pen' ? 0.5 : 2, max: 64 };
}

export function clampInkWidth(tool: InkToolName, width: number): number {
  const { min, max } = inkWidthBounds(tool);
  if (!Number.isFinite(width)) return DEFAULT_TOOL_SETTINGS[tool].width;
  return Math.min(max, Math.max(min, Math.round(width * 100) / 100));
}

export function clampInkOpacity(opacity: number): number {
  if (!Number.isFinite(opacity)) return DEFAULT_TOOL_SETTINGS.highlighter.opacity;
  return Math.min(1, Math.max(0.05, Math.round(opacity * 100) / 100));
}

export function clampEraserSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_ERASER_SIZE;
  return Math.min(INK_ERASER_SIZE_MAX, Math.max(INK_ERASER_SIZE_MIN, Math.round(size)));
}

/**
 * Accepts `#rgb` or `#rrggbb` (hash optional) and returns lowercase `#rrggbb`.
 * Highlighter opacity is kept separate, so an eight-digit value is rejected
 * instead of silently discarding or reinterpreting its alpha byte.
 */
export function normalizeHexColor(value: string): string | undefined {
  const raw = value.trim();
  const withHash = raw.startsWith('#') ? raw : `#${raw}`;
  if (/^#[\da-f]{3}$/i.test(withHash)) {
    return `#${withHash.slice(1).split('').map((character) => `${character}${character}`).join('')}`.toLowerCase();
  }
  if (/^#[\da-f]{6}$/i.test(withHash)) return withHash.toLowerCase();
  return undefined;
}

function alphaHex(opacity: number): string {
  return Math.round(clampInkOpacity(opacity) * 255).toString(16).padStart(2, '0');
}

/** Resolves the v1 style color for the current tool. */
export function inkStyleColor(settings: InkToolStyleSettings, tool: InkToolName): string {
  return tool === 'highlighter' ? `${settings.color}${alphaHex(settings.opacity)}` : settings.color;
}

export interface InkToolPreferences {
  settings: Record<InkToolName, InkToolStyleSettings>;
  eraserSize: number;
}

export interface InkPreferencesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const INK_TOOL_PREFERENCES_STORAGE_KEY = 'deep-student.ink.tool-settings.v1';
const INK_TOOL_PREFERENCES_VERSION = 1;

export function defaultInkToolPreferences(): InkToolPreferences {
  return {
    settings: {
      pen: { ...DEFAULT_TOOL_SETTINGS.pen },
      highlighter: { ...DEFAULT_TOOL_SETTINGS.highlighter },
    },
    eraserSize: DEFAULT_ERASER_SIZE,
  };
}

function sanitizeStoredToolSettings(raw: unknown, tool: InkToolName): InkToolStyleSettings {
  const defaults = DEFAULT_TOOL_SETTINGS[tool];
  if (!raw || typeof raw !== 'object') return { ...defaults };
  const value = raw as Record<string, unknown>;
  const color = typeof value.color === 'string' ? normalizeHexColor(value.color) : undefined;
  const width = typeof value.width === 'number' ? clampInkWidth(tool, value.width) : defaults.width;
  const opacity = typeof value.opacity === 'number' ? clampInkOpacity(value.opacity) : defaults.opacity;
  return {
    color: color ?? defaults.color,
    width,
    opacity,
  };
}

/**
 * Validates an untrusted localStorage payload field-by-field. Unknown versions
 * fall back completely; malformed individual fields fall back only themselves.
 */
export function sanitizeInkToolPreferences(raw: unknown): InkToolPreferences {
  const fallback = defaultInkToolPreferences();
  if (!raw || typeof raw !== 'object') return fallback;
  const value = raw as Record<string, unknown>;
  if (value.version !== INK_TOOL_PREFERENCES_VERSION) return fallback;
  return {
    settings: {
      pen: sanitizeStoredToolSettings(value.pen, 'pen'),
      highlighter: sanitizeStoredToolSettings(value.highlighter, 'highlighter'),
    },
    eraserSize: typeof value.eraserSize === 'number'
      ? clampEraserSize(value.eraserSize)
      : fallback.eraserSize,
  };
}

function resolveStorage(storage?: InkPreferencesStorage): InkPreferencesStorage | undefined {
  if (storage) return storage;
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function loadInkToolPreferences(storage?: InkPreferencesStorage): InkToolPreferences {
  const target = resolveStorage(storage);
  if (!target) return defaultInkToolPreferences();
  try {
    const raw = target.getItem(INK_TOOL_PREFERENCES_STORAGE_KEY);
    if (!raw) return defaultInkToolPreferences();
    return sanitizeInkToolPreferences(JSON.parse(raw));
  } catch {
    return defaultInkToolPreferences();
  }
}

export function saveInkToolPreferences(
  preferences: InkToolPreferences,
  storage?: InkPreferencesStorage,
): void {
  const target = resolveStorage(storage);
  if (!target) return;
  try {
    target.setItem(INK_TOOL_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: INK_TOOL_PREFERENCES_VERSION,
      pen: preferences.settings.pen,
      highlighter: preferences.settings.highlighter,
      eraserSize: preferences.eraserSize,
    }));
  } catch {
    // Preference persistence is best-effort; editing must still work when
    // storage is unavailable or full.
  }
}
