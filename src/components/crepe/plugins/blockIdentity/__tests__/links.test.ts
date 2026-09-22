import { describe, expect, it, vi } from 'vitest';
import type { EditorView } from '@milkdown/prose/view';
import { buildBlockLink, parseBlockLink, handleBlockLinkClick, BLOCK_LINK_OPEN_EVENT,
  installBlockLinkBridge, resolveBlockLinkOwner } from '../links';

describe('block link routing', () => {
  it('encodes note IDs without relying on a title and handles actual link clicks', () => {
    const target = { noteId: 'note/中文 #', blockId: 'blk_123' };
    const href = buildBlockLink(target);
    expect(parseBlockLink(href)).toEqual(target);
    expect(parseBlockLink('https://example.com')).toBeNull();
    const anchor = document.createElement('a'); anchor.href = href; anchor.textContent = 'block';
    document.body.append(anchor);
    const listener = vi.fn(); window.addEventListener(BLOCK_LINK_OPEN_EVENT, listener);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor.addEventListener('click', e => handleBlockLinkClick({} as EditorView, e));
    anchor.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual(target);
    window.removeEventListener(BLOCK_LINK_OPEN_EVENT, listener); anchor.remove();
  });

  it('resolves moved IDs, opens the new note and focuses only after its editor is ready', async () => {
    const focusBlock = vi.fn(() => true), onMissing = vi.fn(), onError = vi.fn();
    const openNote = vi.fn(async () => ({ focusBlock }));
    const dispose = installBlockLinkBridge({ resolveTarget: async target => ({ ...target, noteId: 'new-owner' }), openNote, onMissing, onError });
    window.dispatchEvent(new CustomEvent(BLOCK_LINK_OPEN_EVENT, { detail: { noteId: 'old-owner', blockId: 'stable' } }));
    await vi.waitFor(() => expect(focusBlock).toHaveBeenCalledWith('stable'));
    expect(openNote).toHaveBeenCalledWith('new-owner'); expect(onMissing).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
    dispose();
  });

  it('reports a deleted block and never navigates to an arbitrary fallback', async () => {
    const onMissing = vi.fn(), openNote = vi.fn();
    const dispose = installBlockLinkBridge({ resolveTarget: async () => null, openNote, onMissing, onError: vi.fn() });
    const target = { noteId: 'note', blockId: 'deleted' };
    window.dispatchEvent(new CustomEvent(BLOCK_LINK_OPEN_EVENT, { detail: target }));
    await vi.waitFor(() => expect(onMissing).toHaveBeenCalledWith(target));
    expect(openNote).not.toHaveBeenCalled(); dispose();
  });

  it('looks up moved blocks from Markdown and refuses ambiguous imported IDs', async () => {
    const notes: Record<string, string> = { old: '', moved: '<!-- ds:block-id=stable -->\ntext' };
    const source = {
      readMarkdown: async (id: string) => notes[id] ?? null,
      listNoteIds: async () => Object.keys(notes),
      parse: (markdown: string) => ({ children: markdown ? [{ type: 'html', value: markdown.split('\n')[0] }, { type: 'paragraph' }] : [] }),
    };
    expect(await resolveBlockLinkOwner({ noteId: 'old', blockId: 'stable' }, source)).toEqual({ noteId: 'moved', blockId: 'stable' });
    notes.collision = notes.moved;
    await expect(resolveBlockLinkOwner({ noteId: 'old', blockId: 'stable' }, source)).rejects.toThrow('Ambiguous');
  });
});
