import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { EditorView } from '@milkdown/prose/view';
import { wikilinkPlugin } from '../index';
import { wikilinkAutocompleteKey } from '../autocomplete';
import { mentionPlugin, mentionAutocompleteKey } from '../../mention';

beforeEach(() => {
  vi.spyOn(EditorView.prototype, 'coordsAtPos').mockReturnValue({ left: 0, right: 1, top: 0, bottom: 20 });
});
afterEach(() => vi.restoreAllMocks());

describe.each(['wikilink', 'mention'] as const)('%s autocomplete IME', (kind) => {
  it.each([{ isComposing: true }, { keyCode: 229 }, { viewComposing: true }])('keeps candidates and document intact until composition ends (%j)', async (composition) => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const notes = [{ id: 'note-1', title: '中文' }];
    const editor = await Editor.make().config((ctx) => { ctx.set(rootCtx, root); ctx.set(defaultValueCtx, ''); })
      .use(commonmark)
      .use(kind === 'wikilink' ? wikilinkPlugin({ getNotes: () => notes }) : mentionPlugin({ searchNotes: async () => notes, debounceMs: 0 }))
      .create();
    try {
      const view = editor.action((ctx) => ctx.get(editorViewCtx));
      view.dispatch(view.state.tr.insertText(kind === 'wikilink' ? '[[中文' : '@中文'));
      // Each plugin owns its DOM overlay; destroyed instances retain a hidden
      // shell, so target the live instance rather than a previous test's shell.
      const selector = `.crepe-${kind}-suggest:not([style*="display: none"])`;
      await waitFor(() => expect(document.querySelector(`${selector} [role="option"]`)).toBeTruthy());
      const plugin = (kind === 'wikilink' ? wikilinkAutocompleteKey : mentionAutocompleteKey).get(view.state)!;
      const baseline = view.state.doc;
      const composing = vi.spyOn(view, 'composing', 'get').mockReturnValue('viewComposing' in composition);
      for (const key of ['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp']) {
        const event = new KeyboardEvent('keydown', { key, cancelable: true, ...composition });
        expect(plugin.props.handleKeyDown?.call(plugin, view, event)).toBe(false);
        expect(event.defaultPrevented).toBe(false);
        expect(view.state.doc.eq(baseline)).toBe(true);
        expect(document.querySelector<HTMLElement>(selector)?.style.display).not.toBe('none');
      }
      composing.mockReturnValue(false);
      expect(plugin.props.handleKeyDown?.call(plugin, view, new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))).toBe(true);
      expect(view.state.doc.eq(baseline)).toBe(false);
    } finally { await editor.destroy(); root.remove(); }
  });
});
