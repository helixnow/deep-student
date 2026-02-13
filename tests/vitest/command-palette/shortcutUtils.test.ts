import { describe, expect, it } from 'vitest';

import {
  normalizeShortcut,
  formatShortcut,
  buildShortcutString,
  SPECIAL_KEYS,
} from '@/command-palette/registry/shortcutUtils';

// ==================== normalizeShortcut ====================

describe('normalizeShortcut', () => {
  it('sorts parts alphabetically and lowercases', () => {
    expect(normalizeShortcut('mod+shift+k')).toBe('k+mod+shift');
    expect(normalizeShortcut('Mod+Shift+K')).toBe('k+mod+shift');
  });

  it('is idempotent', () => {
    const once = normalizeShortcut('mod+shift+k');
    expect(normalizeShortcut(once)).toBe(once);
  });

  it('normalizes different orderings to the same result', () => {
    expect(normalizeShortcut('shift+mod+k')).toBe(normalizeShortcut('mod+shift+k'));
    expect(normalizeShortcut('alt+mod+s')).toBe(normalizeShortcut('mod+alt+s'));
  });

  it('strips whitespace', () => {
    expect(normalizeShortcut('mod + shift + k')).toBe('k+mod+shift');
  });

  it('handles single key', () => {
    expect(normalizeShortcut('f1')).toBe('f1');
    expect(normalizeShortcut('F1')).toBe('f1');
  });
});

// ==================== formatShortcut ====================

describe('formatShortcut', () => {
  it('replaces mod/shift/alt with platform symbols (non-mac fallback)', () => {
    // formatShortcut uses isMacOS() internally; in test environment it's likely non-mac
    const result = formatShortcut('mod+shift+k');
    // Should contain either ⌘ or Ctrl
    expect(result).toMatch(/⌘|Ctrl/);
    // Should contain either ⇧ or Shift
    expect(result).toMatch(/⇧|Shift/);
    // Should contain K (uppercased)
    expect(result).toMatch(/K/);
  });

  it('uppercases single-letter keys', () => {
    const result = formatShortcut('mod+s');
    expect(result).toMatch(/S/);
  });
});

// ==================== buildShortcutString ====================

describe('buildShortcutString', () => {
  const createKeyboardEvent = (overrides: Partial<KeyboardEvent>): KeyboardEvent => {
    return {
      key: '',
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      ...overrides,
    } as KeyboardEvent;
  };

  it('returns null for plain character keys', () => {
    expect(buildShortcutString(createKeyboardEvent({ key: 'a' }))).toBeNull();
    expect(buildShortcutString(createKeyboardEvent({ key: '1' }))).toBeNull();
  });

  it('returns null for modifier-only keypresses', () => {
    expect(buildShortcutString(createKeyboardEvent({ key: 'Meta', metaKey: true }))).toBeNull();
    expect(buildShortcutString(createKeyboardEvent({ key: 'Control', ctrlKey: true }))).toBeNull();
    expect(buildShortcutString(createKeyboardEvent({ key: 'Shift', shiftKey: true }))).toBeNull();
    expect(buildShortcutString(createKeyboardEvent({ key: 'Alt', altKey: true }))).toBeNull();
  });

  it('returns shortcut string for modifier + key combos', () => {
    expect(buildShortcutString(createKeyboardEvent({ key: 's', metaKey: true }))).toBe('mod+s');
    expect(buildShortcutString(createKeyboardEvent({ key: 's', ctrlKey: true }))).toBe('mod+s');
    expect(buildShortcutString(createKeyboardEvent({ key: 'k', metaKey: true, shiftKey: true }))).toBe('mod+shift+k');
  });

  it('returns shortcut string for special keys without modifier', () => {
    expect(buildShortcutString(createKeyboardEvent({ key: 'F1' }))).toBe('f1');
    expect(buildShortcutString(createKeyboardEvent({ key: 'F12' }))).toBe('f12');
    expect(buildShortcutString(createKeyboardEvent({ key: 'Delete' }))).toBe('delete');
    expect(buildShortcutString(createKeyboardEvent({ key: 'Backspace' }))).toBe('backspace');
  });

  it('normalizes arrow keys', () => {
    expect(buildShortcutString(createKeyboardEvent({ key: 'ArrowUp', ctrlKey: true }))).toBe('mod+up');
    expect(buildShortcutString(createKeyboardEvent({ key: 'ArrowLeft', altKey: true }))).toBe('alt+left');
  });

  it('normalizes space', () => {
    expect(buildShortcutString(createKeyboardEvent({ key: ' ', ctrlKey: true }))).toBe('mod+space');
    // bare space without modifier → null (not in SPECIAL_KEYS)
    expect(buildShortcutString(createKeyboardEvent({ key: ' ' }))).toBeNull();
  });

  it('handles alt modifier', () => {
    expect(buildShortcutString(createKeyboardEvent({ key: 's', altKey: true }))).toBe('alt+s');
  });

  it('handles triple modifier', () => {
    const result = buildShortcutString(createKeyboardEvent({
      key: 'r',
      metaKey: true,
      altKey: true,
      shiftKey: false,
    }));
    expect(result).toBe('mod+alt+r');
  });
});

// ==================== SPECIAL_KEYS ====================

describe('SPECIAL_KEYS', () => {
  it('contains function keys f1-f12', () => {
    for (let i = 1; i <= 12; i++) {
      expect(SPECIAL_KEYS.has(`f${i}`)).toBe(true);
    }
  });

  it('contains delete and backspace', () => {
    expect(SPECIAL_KEYS.has('delete')).toBe(true);
    expect(SPECIAL_KEYS.has('backspace')).toBe(true);
  });

  it('does not contain escape, enter, tab', () => {
    expect(SPECIAL_KEYS.has('escape')).toBe(false);
    expect(SPECIAL_KEYS.has('enter')).toBe(false);
    expect(SPECIAL_KEYS.has('tab')).toBe(false);
  });

  it('does not contain space', () => {
    expect(SPECIAL_KEYS.has('space')).toBe(false);
  });
});
