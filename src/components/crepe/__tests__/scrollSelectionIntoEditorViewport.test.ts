import { afterEach, describe, expect, it, vi } from 'vitest';
import { scrollSelectionIntoEditorViewport } from '../scrollSelectionIntoEditorViewport';

describe('scrollSelectionIntoEditorViewport', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('scrolls only the nearest editor viewport', () => {
    const viewport = document.createElement('div');
    viewport.setAttribute('data-overlayscrollbars-viewport', '');
    const editor = document.createElement('div');
    viewport.append(editor);
    document.body.append(viewport);
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1000 },
    });
    viewport.scrollTop = 100;
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, bottom: 200, left: 0, right: 400, width: 400, height: 200,
      toJSON: () => ({}),
    });

    const handled = scrollSelectionIntoEditorViewport({
      dom: editor,
      state: { selection: { head: 5 } },
      coordsAtPos: () => ({ top: 210, bottom: 230, left: 20, right: 21 }),
    });

    expect(handled).toBe(true);
    expect(viewport.scrollTop).toBe(142);
  });

  it('lets ProseMirror use its fallback when no editor viewport exists', () => {
    const editor = document.createElement('div');
    expect(scrollSelectionIntoEditorViewport({
      dom: editor,
      state: { selection: { head: 0 } },
      coordsAtPos: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    })).toBe(false);
  });
});
