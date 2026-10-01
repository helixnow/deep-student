import { describe, expect, it } from 'vitest';
import { isNoteEditorHot, NOTE_HOT_INPUT_WINDOW_MS } from '../drivers/noteDriver';

describe('isNoteEditorHot (human/agent arbitration)', () => {
  const now = 100_000;
  it('is hot only while focused and recently typing', () => {
    const api = (lastInputAt: number, focused = true) => ({
      hasFocus: () => focused,
      getUserActivity: () => ({ lastInputAt, composing: false }),
    });
    expect(isNoteEditorHot(api(now - 500), now)).toBe(true);
    expect(isNoteEditorHot(api(now - NOTE_HOT_INPUT_WINDOW_MS - 1), now)).toBe(false);
    expect(isNoteEditorHot(api(now - 500, false), now)).toBe(false);
  });

  it('is always hot during IME composition', () => {
    expect(isNoteEditorHot({ hasFocus: () => false, getUserActivity: () => ({ lastInputAt: 0, composing: true }) }, now)).toBe(true);
  });

  it('falls back to focus when the host provides no activity signal', () => {
    expect(isNoteEditorHot({ hasFocus: () => true }, now)).toBe(true);
    expect(isNoteEditorHot({ hasFocus: () => false }, now)).toBe(false);
  });
});
