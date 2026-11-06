import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ERASER_SIZE,
  DEFAULT_TOOL_SETTINGS,
  INK_COLOR_PRESETS,
  INK_HIGHLIGHTER_WIDTH_PRESETS,
  INK_PEN_WIDTH_PRESETS,
  INK_TOOL_PREFERENCES_STORAGE_KEY,
  clampEraserSize,
  clampInkOpacity,
  clampInkWidth,
  defaultInkToolPreferences,
  inkStyleColor,
  loadInkToolPreferences,
  normalizeHexColor,
  sanitizeInkToolPreferences,
  saveInkToolPreferences,
  type InkPreferencesStorage,
} from '../toolSettings';

function memoryStorage(initial?: string): InkPreferencesStorage & { read(): string | null } {
  let value = initial ?? null;
  return {
    getItem(key) {
      return key === INK_TOOL_PREFERENCES_STORAGE_KEY ? value : null;
    },
    setItem(key, next) {
      if (key === INK_TOOL_PREFERENCES_STORAGE_KEY) value = next;
    },
    read() {
      return value;
    },
  };
}

describe('ink tool settings', () => {
  it('keeps the legacy defaults: black pen width 8 and highlighter alpha 80', () => {
    expect(DEFAULT_TOOL_SETTINGS.pen).toEqual({ color: '#000000', width: 8, opacity: 1 });
    expect(DEFAULT_TOOL_SETTINGS.highlighter).toEqual({ color: '#000000', width: 8, opacity: 0.5 });
    expect(inkStyleColor(DEFAULT_TOOL_SETTINGS.highlighter, 'highlighter')).toBe('#00000080');
  });

  it('retains the twelve presets and the legacy selector aliases used by older tests', () => {
    expect(INK_COLOR_PRESETS).toHaveLength(12);
    const byId = new Map(INK_COLOR_PRESETS.map((preset) => [preset.id, preset]));
    expect(byId.get('black')?.legacyTestId).toBe('ink-color-black');
    expect(byId.get('red')?.legacyTestId).toBe('ink-color-red');
    expect(byId.get('blue')?.legacyTestId).toBe('ink-color-blue');
    expect(INK_PEN_WIDTH_PRESETS.find((preset) => preset.value === 2)?.legacyTestId).toBe('ink-width-small');
    expect(INK_PEN_WIDTH_PRESETS.find((preset) => preset.value === 8)?.legacyTestId).toBe('ink-width-medium');
    expect(INK_PEN_WIDTH_PRESETS.find((preset) => preset.value === 12)?.legacyTestId).toBe('ink-width-large');
    expect(INK_HIGHLIGHTER_WIDTH_PRESETS.some((preset) => preset.value === 2)).toBe(true);
  });

  it('normalizes three- and six-digit hex colors and rejects alpha/short forms', () => {
    expect(normalizeHexColor('#ABC')).toBe('#aabbcc');
    expect(normalizeHexColor('FF0000')).toBe('#ff0000');
    expect(normalizeHexColor('  #00ff00  ')).toBe('#00ff00');
    expect(normalizeHexColor('#ff000080')).toBeUndefined();
    expect(normalizeHexColor('not-a-color')).toBeUndefined();
    expect(normalizeHexColor('#ff00')).toBeUndefined();
  });

  it('clamps widths, highlighter opacity, and eraser diameter to their documented ranges', () => {
    expect(clampInkWidth('pen', 0.1)).toBe(0.5);
    expect(clampInkWidth('pen', 999)).toBe(64);
    expect(clampInkWidth('highlighter', 0.5)).toBe(2);
    expect(clampInkWidth('highlighter', Number.NaN)).toBe(8);
    expect(clampInkOpacity(0)).toBe(0.05);
    expect(clampInkOpacity(2)).toBe(1);
    expect(clampInkOpacity(Number.NaN)).toBe(0.5);
    expect(clampEraserSize(1)).toBe(4);
    expect(clampEraserSize(100)).toBe(64);
    expect(clampEraserSize(Number.NaN)).toBe(DEFAULT_ERASER_SIZE);
  });

  it('encodes highlighter opacity in the alpha byte without changing pen colors', () => {
    expect(inkStyleColor({ color: '#ff0000', width: 4, opacity: 1 }, 'pen')).toBe('#ff0000');
    expect(inkStyleColor({ color: '#ff8800', width: 16, opacity: 0.4 }, 'highlighter')).toBe('#ff880066');
    expect(inkStyleColor({ color: '#ff8800', width: 16, opacity: 0.5 }, 'highlighter')).toBe('#ff880080');
  });

  it('sanitizes a versioned stored preference payload field by field', () => {
    const sanitized = sanitizeInkToolPreferences({
      version: 1,
      pen: { color: '#AABBCC', width: 0.1, opacity: 2 },
      highlighter: { color: '#123', width: 999, opacity: -1 },
      eraserSize: 1000,
    });

    expect(sanitized.settings.pen).toEqual({ color: '#aabbcc', width: 0.5, opacity: 1 });
    expect(sanitized.settings.highlighter).toEqual({ color: '#112233', width: 64, opacity: 0.05 });
    expect(sanitized.eraserSize).toBe(64);
  });

  it('falls back completely for unknown versions and malformed JSON', () => {
    expect(sanitizeInkToolPreferences({ version: 2, pen: { color: '#ff0000', width: 12, opacity: 1 } }))
      .toEqual(defaultInkToolPreferences());
    expect(loadInkToolPreferences(memoryStorage('{'))).toEqual(defaultInkToolPreferences());
    expect(loadInkToolPreferences(memoryStorage())).toEqual(defaultInkToolPreferences());
  });

  it('round-trips preferences through storage and returns fresh defaults each time', () => {
    const storage = memoryStorage();
    const preferences = {
      settings: {
        pen: { color: '#ff0000', width: 12, opacity: 1 },
        highlighter: { color: '#00ff00', width: 18, opacity: 0.75 },
      },
      eraserSize: 32,
    };
    saveInkToolPreferences(preferences, storage);
    expect(loadInkToolPreferences(storage)).toEqual(preferences);

    const defaults = defaultInkToolPreferences();
    defaults.settings.pen.width = 99;
    expect(defaultInkToolPreferences().settings.pen.width).toBe(8);
  });

  it('does not let unavailable preference storage break editing', () => {
    const throwing: InkPreferencesStorage = {
      getItem() {
        throw new Error('storage unavailable');
      },
      setItem() {
        throw new Error('storage full');
      },
    };
    expect(loadInkToolPreferences(throwing)).toEqual(defaultInkToolPreferences());
    expect(() => saveInkToolPreferences(defaultInkToolPreferences(), throwing)).not.toThrow();
  });
});
