import { describe, expect, it, vi } from 'vitest';
import { setupMilkdownTimers } from '../../../__tests__/milkdownTimers';
setupMilkdownTimers();
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { automd } from '@milkdown/plugin-automd';
import { getMarkdown } from '@milkdown/kit/utils';
import { TextSelection } from '@milkdown/prose/state';
import { EditorView } from '@milkdown/prose/view';

import { wikilinkPlugin } from '../index';
import { WIKILINK_NODE_NAME } from '../schema';
import { WIKILINK_EVENTS, normalizeResolve } from '../types';
import { addTypedEventListener } from '@/events';

async function createEditor(
  markdown: string,
  pluginConfig?: Parameters<typeof wikilinkPlugin>[0],
  options?: { withAutomd?: boolean },
) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  let builder = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark);
  if (options?.withAutomd) {
    builder = builder.use(automd);
  }
  const editor = await builder
    .use(wikilinkPlugin(pluginConfig))
    .create();
  return { editor, root };
}

function collectWikilinks(view: EditorView): Array<{ target: string; label: string }> {
  const links: Array<{ target: string; label: string }> = [];
  view.state.doc.descendants((node) => {
    if (node.type.name === WIKILINK_NODE_NAME) {
      links.push({
        target: String(node.attrs.target ?? ''),
        label: String(node.attrs.label ?? ''),
      });
    }
  });
  return links;
}

async function flushAnimationFrames() {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
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

  it('never leaks automd sentinel ⁂ (U+2042) or swallows ]] when typing \\n[[ before an existing wikilink (S1-06)', async () => {
    const coordsSpy = vi
      .spyOn(EditorView.prototype, 'coordsAtPos')
      .mockReturnValue({ left: 0, right: 1, top: 0, bottom: 20 });
    const initial = '后续需要研究 [[S106_马尔可夫链平稳分布]] 这一主题。';
    const { editor, root } = await createEditor(
      initial,
      { resolve: (target) => target === 'S106_马尔可夫链平稳分布' },
      { withAutomd: true },
    );
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    const focusSpy = vi.spyOn(view, 'hasFocus').mockReturnValue(true);
    try {
      // Simulate Enter (\n) followed by typing "[[" right before the paragraph containing the existing wikilink.
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
      view.dispatch(view.state.tr.split(1));
      view.dispatch(view.state.tr.insertText('['));
      await flushAnimationFrames();
      view.dispatch(view.state.tr.insertText('['));
      await flushAnimationFrames();

      const markdown = editor.action(getMarkdown());
      const domText = root.textContent ?? '';
      expect(markdown).not.toMatch(/[\u2042\u2234\u2205]/);
      expect(domText).not.toMatch(/[\u2042\u2234\u2205]/);
      expect(markdown).toContain('[[S106_马尔可夫链平稳分布]]');
      expect(collectWikilinks(view)).toEqual([
        { target: 'S106_马尔可夫链平稳分布', label: '' },
      ]);
      const linkEl = root.querySelector<HTMLElement>('.crepe-wikilink');
      expect(linkEl?.dataset.resolved).toBe('true');
      expect(linkEl?.textContent).toBe('S106_马尔可夫链平稳分布');
    } finally {
      focusSpy.mockRestore();
      coordsSpy.mockRestore();
      await destroyEditor(editor, root);
    }
  });

  it('keeps existing wikilinks intact when typing literal \\n[[, [[ after a wikilink, or triggering automd on the same line (S1-06)', async () => {
    const coordsSpy = vi
      .spyOn(EditorView.prototype, 'coordsAtPos')
      .mockReturnValue({ left: 0, right: 1, top: 0, bottom: 20 });
    const initial = '后续需要研究 [[S106_马尔可夫链平稳分布]] 这一主题。';
    const { editor, root } = await createEditor(
      initial,
      { resolve: (target) => target === 'S106_马尔可夫链平稳分布' },
      { withAutomd: true },
    );
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    const focusSpy = vi.spyOn(view, 'hasFocus').mockReturnValue(true);
    try {
      // 1. Insert literal "\n[[" before the existing wikilink in the same paragraph.
      view.dispatch(view.state.tr.insertText('\n[[', 1));
      await flushAnimationFrames();

      // 2. Also trigger automd inline sync via **强调** on the same paragraph so runReplacer actively runs with placeholder.
      const insertBoldAt = view.state.doc.content.size - 1;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, insertBoldAt)));
      view.dispatch(view.state.tr.insertText(' **强调** [['));
      await flushAnimationFrames();

      const markdown = editor.action(getMarkdown());
      const domText = root.textContent ?? '';
      expect(markdown).not.toMatch(/[\u2042\u2234\u2205]/);
      expect(domText).not.toMatch(/[\u2042\u2234\u2205]/);
      expect(markdown).toContain('[[S106_马尔可夫链平稳分布]]');
      let hasStrong = false;
      view.state.doc.descendants((node) => {
        if (node.isText && node.text === '强调' && node.marks.some((m) => m.type.name === 'strong')) {
          hasStrong = true;
        }
      });
      expect(hasStrong).toBe(true);
      expect(collectWikilinks(view)).toEqual([
        { target: 'S106_马尔可夫链平稳分布', label: '' },
      ]);
    } finally {
      focusSpy.mockRestore();
      coordsSpy.mockRestore();
      await destroyEditor(editor, root);
    }
  });

  it('never leaks automd cursor placeholder when typing [[ before literal closing brackets ]] (S1-06)', async () => {
    const coordsSpy = vi
      .spyOn(EditorView.prototype, 'coordsAtPos')
      .mockReturnValue({ left: 0, right: 1, top: 0, bottom: 20 });
    const { editor, root } = await createEditor('foo]]', undefined, { withAutomd: true });
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    const focusSpy = vi.spyOn(view, 'hasFocus').mockReturnValue(true);
    try {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
      view.dispatch(view.state.tr.insertText('['));
      await flushAnimationFrames();
      view.dispatch(view.state.tr.insertText('['));
      await flushAnimationFrames();

      const markdown = editor.action(getMarkdown());
      const domText = root.textContent ?? '';
      expect(markdown).not.toMatch(/[\u2042\u2234\u2205]/);
      expect(domText).not.toMatch(/[\u2042\u2234\u2205]/);
      expect(collectWikilinks(view)).toEqual([]);
    } finally {
      focusSpy.mockRestore();
      coordsSpy.mockRestore();
      await destroyEditor(editor, root);
    }
  });

  it('promotes pasted/inserted plain-text [[target]] and [[target|label]] into wikilink atoms without bracket escaping (G06)', async () => {
    const resolve = vi.fn(() => ({ resolved: true, noteId: 'target-id' }));
    const { editor, root } = await createEditor('', { resolve });
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    try {
      view.dispatch(
        view.state.tr.insertText('See [[Target Note]] and [[Target Note|Custom Label]] here'),
      );

      expect(collectWikilinks(view)).toEqual([
        { target: 'Target Note', label: '' },
        { target: 'Target Note', label: 'Custom Label' },
      ]);

      const domLinks = root.querySelectorAll<HTMLElement>('.crepe-wikilink');
      expect(domLinks).toHaveLength(2);
      expect(domLinks[0]?.textContent).toBe('Target Note');
      expect(domLinks[1]?.textContent).toBe('Custom Label');
      expect(root.textContent ?? '').not.toContain('[[');
      expect(root.textContent ?? '').not.toContain(']]');

      const md = editor.action(getMarkdown()).trim();
      expect(md).toBe('See [[Target Note]] and [[Target Note|Custom Label]] here');
      expect(md).not.toMatch(/\\\[/);
    } finally {
      await destroyEditor(editor, root);
    }
  });

  it('promotes remaining plain-text [[...]] when switching to reading mode even if cursor was inside it (G06)', async () => {
    const resolve = vi.fn(() => ({ resolved: true, noteId: 'foo-id' }));
    const onOpen = vi.fn();
    const disposeOpen = addTypedEventListener(
      WIKILINK_EVENTS.OPEN_NOTE,
      (_detail, event) => onOpen(event),
    );
    const { editor, root } = await createEditor('foo]]', { resolve });
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    try {
      // Typing `[[` before `foo]]` keeps cursor inside the span (pos 3), so edit mode leaves it plain text.
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
      view.dispatch(view.state.tr.insertText('[['));
      expect(collectWikilinks(view)).toEqual([]);

      // Switching to reading mode (`crepe.setReadonly(true)` -> `view.setProps({ editable: () => false })`)
      // must promote remaining valid plain-text wikilinks so no literal `[[...]]` renders in reading view.
      view.setProps({ editable: () => false });

      expect(collectWikilinks(view)).toEqual([{ target: 'foo', label: '' }]);
      const link = root.querySelector<HTMLElement>('.crepe-wikilink');
      expect(link).not.toBeNull();
      expect(link?.textContent).toBe('foo');
      expect(root.textContent ?? '').not.toContain('[[');
      expect(root.textContent ?? '').not.toContain(']]');

      link?.click();
      expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({
        detail: expect.objectContaining({ noteId: 'foo-id', target: 'foo', source: 'wikilink' }),
      }));
    } finally {
      disposeOpen();
      await destroyEditor(editor, root);
    }
  });

  it('keeps [[...]] inside inline code and fenced code blocks literal in reading mode (G06)', async () => {
    const md = 'Inline `[[inline_code]]` stays literal.\n\n```\n[[fenced_code]]\n```';
    const { editor, root } = await createEditor(md);
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    try {
      view.setProps({ editable: () => false });
      expect(collectWikilinks(view)).toEqual([]);
      expect(root.querySelectorAll('.crepe-wikilink')).toHaveLength(0);
    } finally {
      await destroyEditor(editor, root);
    }
  });

  it('ignores real HTML markup containing [[...]] while promoting standalone wikilinks (G06)', async () => {
    const md = 'Link [[Real Note]] and <span data-note="[[raw]]">plain</span>';
    const { editor, root } = await createEditor(md);
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    try {
      expect(collectWikilinks(view)).toEqual([{ target: 'Real Note', label: '' }]);
    } finally {
      await destroyEditor(editor, root);
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
