import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Crepe } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/kit/core';
import type { EditorView as ProseEditorView } from '@milkdown/prose/view';
import {
  isLiveCrepeEditorView,
  resolveCrepeEditorView,
  resolveCrepeEditorViewWithSource,
  resolveViewFromCtx,
  withCrepeEditorView,
  type EditorViewRef,
} from '../crepeViewAccess';

function createFakeView(overrides: Partial<ProseEditorView> = {}): ProseEditorView {
  return {
    state: {} as ProseEditorView['state'],
    dispatch: vi.fn(),
    isDestroyed: false,
    ...overrides,
  } as unknown as ProseEditorView;
}

describe('crepeViewAccess', () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__MILKDOWN_VIEW__;
  });

  describe('isLiveCrepeEditorView', () => {
    it('accepts live views and rejects null, partial objects, and destroyed views', () => {
      expect(isLiveCrepeEditorView(createFakeView())).toBe(true);
      expect(isLiveCrepeEditorView(createFakeView({ isDestroyed: true }))).toBe(false);
      expect(isLiveCrepeEditorView(null)).toBe(false);
      expect(isLiveCrepeEditorView({ state: {} })).toBe(false);
    });
  });

  describe('resolveViewFromCtx', () => {
    it('prefers string key editorView and falls back to editorViewCtx symbol', () => {
      const stringView = createFakeView();
      const symbolView = createFakeView();

      const ctxBoth = {
        get: (key: unknown) => (key === 'editorView' ? stringView : key === editorViewCtx ? symbolView : null),
      };
      expect(resolveViewFromCtx(ctxBoth)).toBe(stringView);

      const ctxSymbolOnly = {
        get: (key: unknown) => {
          if (key === 'editorView') throw new Error('missing string slice');
          if (key === editorViewCtx) return symbolView;
          return null;
        },
      };
      expect(resolveViewFromCtx(ctxSymbolOnly)).toBe(symbolView);
    });
  });

  describe('resolveCrepeEditorView & resolveCrepeEditorViewWithSource', () => {
    it('returns cached live view first and clears destroyed cached view', () => {
      const live = createFakeView();
      const destroyed = createFakeView({ isDestroyed: true });
      const ref: EditorViewRef = { current: live };

      expect(resolveCrepeEditorViewWithSource(null, ref)).toEqual({ view: live, source: 'viewRef' });

      ref.current = destroyed;
      const fresh = createFakeView();
      const crepe = {
        editor: {
          ctx: { get: (key: unknown) => (key === editorViewCtx ? fresh : null) },
        },
      } as unknown as Crepe;

      expect(resolveCrepeEditorViewWithSource(crepe, ref)).toEqual({ view: fresh, source: 'ctx-symbol' });
      expect(ref.current).toBe(fresh);
    });

    it('falls back to crepe.editor.action when ctx.get directly fails', () => {
      const actionView = createFakeView();
      const ref: EditorViewRef = { current: null };
      const crepe = {
        editor: {
          ctx: {
            get: () => {
              throw new Error('not ready');
            },
          },
          action: (cb: (ctx: { get: (k: unknown) => unknown }) => void) => {
            cb({ get: (key: unknown) => (key === 'editorView' ? actionView : null) });
          },
        },
      } as unknown as Crepe;

      expect(resolveCrepeEditorViewWithSource(crepe, ref)).toEqual({
        view: actionView,
        source: 'action-string',
      });
      expect(ref.current).toBe(actionView);
    });

    it('NEVER falls back to window.__MILKDOWN_VIEW__ (multi-instance split-pane isolation)', () => {
      const otherPaneView = createFakeView();
      (window as unknown as Record<string, unknown>).__MILKDOWN_VIEW__ = otherPaneView;

      const crepe = {
        editor: {
          ctx: { get: () => null },
          action: (cb: (ctx: { get: () => null }) => void) => cb({ get: () => null }),
        },
      } as unknown as Crepe;

      const ref: EditorViewRef = { current: null };
      expect(resolveCrepeEditorView(crepe, ref)).toBeNull();
      expect(ref.current).toBeNull();
    });
  });

  describe('withCrepeEditorView', () => {
    it('passes resolved view and ctx to callback, caches view, and returns callback value', () => {
      const view = createFakeView();
      const ctx = { get: (key: unknown) => (key === editorViewCtx ? view : null) };
      const crepe = {
        editor: {
          ctx,
          action: (cb: (c: unknown) => void) => cb(ctx),
        },
      } as unknown as Crepe;
      const ref: EditorViewRef = { current: null };

      const result = withCrepeEditorView(crepe, ref, (v, c) => {
        expect(v).toBe(view);
        expect(c).toBe(ctx);
        return 42;
      });

      expect(result).toBe(42);
      expect(ref.current).toBe(view);
    });

    it('propagates errors thrown inside the callback without invoking twice', () => {
      const view = createFakeView();
      const ctx = { get: () => view };
      const crepe = {
        editor: {
          ctx,
          action: (cb: (c: unknown) => void) => cb(ctx),
        },
      } as unknown as Crepe;
      const fn = vi.fn(() => {
        throw new Error('boom');
      });

      expect(() => withCrepeEditorView(crepe, null, fn)).toThrow('boom');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('returns undefined when crepe is null', () => {
      const fn = vi.fn();
      expect(withCrepeEditorView(null, null, fn)).toBeUndefined();
      expect(fn).not.toHaveBeenCalled();
    });
  });
});
