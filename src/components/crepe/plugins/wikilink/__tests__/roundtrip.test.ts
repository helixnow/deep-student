import { describe, expect, it, vi } from 'vitest';
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { getMarkdown } from '@milkdown/kit/utils';

import { wikilinkPlugin } from '../index';
import { WIKILINK_NODE_NAME } from '../schema';
import { WIKILINK_EVENTS, normalizeResolve } from '../types';

async function createEditor(markdown: string, pluginConfig?: Parameters<typeof wikilinkPlugin>[0]) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark)
    .use(wikilinkPlugin(pluginConfig))
    .create();
  return { editor, root };
}

async function destroyEditor(editor: Editor, root: HTMLElement) {
  await editor.destroy();
  root.remove();
}

describe('wikilink markdown roundtrip', () => {
  it.each([
    'Hello [[Note]] world',
    'See [[目标|别名]] here',
    'Link [[带 空格的标题]] ok',
    '[[a|b]] and [[c]]',
    'Jump to [[Note#Section one]] or [[Note#Other|label]]',
  ])('roundtrips without escaping brackets: %s', async (md) => {
    const { editor, root } = await createEditor(md);
    try {
      const out = editor.action(getMarkdown());
      expect(out.trim()).toBe(md.trim());
      // Milkdown#1278 regression: must not degrade to \[\[
      expect(out).not.toMatch(/\\\[/);
    } finally {
      await destroyEditor(editor, root);
    }
  });

  it('resolves and opens a heading link against its note destination', async () => {
    const resolve = vi.fn(() => ({ resolved: true, noteId: 'note-1' }));
    const onOpen = vi.fn();
    window.addEventListener(WIKILINK_EVENTS.OPEN_NOTE, onOpen);
    const { editor, root } = await createEditor('[[Note#Section one]]', { resolve });
    try {
      const link = root.querySelector<HTMLElement>('.crepe-wikilink');
      expect(link?.dataset.heading).toBe('Section one');
      link?.click();
      expect(resolve).toHaveBeenCalledWith('Note');
      expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({
        detail: expect.objectContaining({
          noteId: 'note-1',
          source: 'wikilink',
          target: 'Note',
          heading: 'Section one',
        }),
      }));
      expect(editor.action(getMarkdown()).trim()).toBe('[[Note#Section one]]');
    } finally {
      window.removeEventListener(WIKILINK_EVENTS.OPEN_NOTE, onOpen);
      await destroyEditor(editor, root);
    }
  });

  it('opens an anchored candidate picker instead of navigating for ambiguous titles (B13)', async () => {
    const resolve = vi.fn(() => ({
      resolved: true,
      noteId: 'n1',
      ambiguous: true,
      candidateIds: ['n1', 'n2'],
    }));
    const getNotes = vi.fn(() => [
      { id: 'n1', title: 'Same', path: '/folder-a/n1' },
      { id: 'n2', title: 'Same', path: '/folder-b/n2' },
    ]);
    const onOpen = vi.fn();
    window.addEventListener(WIKILINK_EVENTS.OPEN_NOTE, onOpen);
    const { editor, root } = await createEditor('[[Same]]', { resolve, getNotes });
    try {
      const link = root.querySelector<HTMLElement>('.crepe-wikilink');
      expect(link?.dataset.ambiguous).toBe('true');
      expect(link?.classList.contains('crepe-wikilink--ambiguous')).toBe(true);

      link?.click();
      // 歧义点击不直接导航
      expect(onOpen).not.toHaveBeenCalled();

      // 候选浮层异步渲染（等待 getNotes）
      await new Promise((resolveTick) => setTimeout(resolveTick, 0));
      const picker = document.querySelector('.crepe-wikilink-candidates');
      expect(picker).not.toBeNull();
      const rows = picker!.querySelectorAll<HTMLElement>('.crepe-wikilink-candidates__item');
      expect(rows).toHaveLength(2);

      rows[1].click();
      expect(onOpen).toHaveBeenCalledTimes(1);
      expect((onOpen.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
        noteId: 'n2',
        source: 'wikilink',
        target: 'Same',
      });
    } finally {
      window.removeEventListener(WIKILINK_EVENTS.OPEN_NOTE, onOpen);
      // NodeView destroy 会关闭（隐藏）候选浮层单例，无需手动移除 DOM
      await destroyEditor(editor, root);
    }
  });

  it('keeps [[...]] inside inline code as literal code (B9)', async () => {
    const md = 'Inline `[[not a link]]` stays code';
    const { editor, root } = await createEditor(md);
    try {
      const hasWikilinkNode = editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        let found = false;
        view.state.doc.descendants((node) => {
          if (node.type.name === WIKILINK_NODE_NAME) found = true;
        });
        return found;
      });
      expect(hasWikilinkNode).toBe(false);
      expect(editor.action(getMarkdown()).trim()).toBe(md);
    } finally {
      await destroyEditor(editor, root);
    }
  });

  it('parses wikilink nodes into the document', async () => {
    const { editor, root } = await createEditor('X [[Node]] Y');
    try {
      const hasNode = editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        let found = false;
        view.state.doc.descendants((node) => {
          if (node.type.name === WIKILINK_NODE_NAME) {
            expect(node.attrs.target).toBe('Node');
            found = true;
          }
        });
        return found;
      });
      expect(hasNode).toBe(true);
    } finally {
      await destroyEditor(editor, root);
    }
  });

  it('second serialize still stays unescaped (no degradation)', async () => {
    const first = await createEditor('[[Stable]]');
    let once: string;
    try {
      once = first.editor.action(getMarkdown()).trim();
    } finally {
      await destroyEditor(first.editor, first.root);
    }

    const second = await createEditor(once);
    try {
      const twice = second.editor.action(getMarkdown()).trim();
      expect(twice).toBe('[[Stable]]');
      expect(twice).not.toMatch(/\\\[/);
    } finally {
      await destroyEditor(second.editor, second.root);
    }
  });
});

describe('wikilink resolve helpers', () => {
  it('defaults to resolved when no resolver is provided', () => {
    expect(normalizeResolve(undefined, 'Any')).toEqual({
      resolved: true,
      noteId: 'Any',
    });
  });

  it('accepts boolean and object resolvers', () => {
    expect(normalizeResolve(() => false, 'Missing')).toEqual({
      resolved: false,
      noteId: null,
    });
    expect(
      normalizeResolve(() => ({ resolved: true, noteId: 'id-1' }), 'Title'),
    ).toEqual({ resolved: true, noteId: 'id-1' });
  });

  it('passes ambiguous candidates through object resolvers (B13)', () => {
    expect(
      normalizeResolve(
        () => ({ resolved: true, noteId: 'a', ambiguous: true, candidateIds: ['a', 'b'] }),
        'Same',
      ),
    ).toEqual({ resolved: true, noteId: 'a', ambiguous: true, candidateIds: ['a', 'b'] });
    // 单候选不算歧义：扩展字段不透传，保持既有形状
    expect(
      normalizeResolve(
        () => ({ resolved: true, noteId: 'a', ambiguous: true, candidateIds: ['a'] }),
        'Only',
      ),
    ).toEqual({ resolved: true, noteId: 'a' });
  });

  it('exposes event name constants for the host contract', () => {
    expect(WIKILINK_EVENTS.OPEN_NOTE).toBe('DSTU_OPEN_NOTE');
    expect(WIKILINK_EVENTS.CREATE_FROM_WIKILINK).toBe('notes:create-from-wikilink');
  });
});
