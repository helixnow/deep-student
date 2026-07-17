import { describe, expect, it } from 'vitest';
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

  it('exposes event name constants for the host contract', () => {
    expect(WIKILINK_EVENTS.OPEN_NOTE).toBe('DSTU_OPEN_NOTE');
    expect(WIKILINK_EVENTS.CREATE_FROM_WIKILINK).toBe('notes:create-from-wikilink');
  });
});
