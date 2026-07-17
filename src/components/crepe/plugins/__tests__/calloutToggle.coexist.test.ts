/**
 * Callout + Toggle 共存：确认 remark 互不吞噬、两种注册顺序均可。
 *
 * Callout 白名单 note|tip|warning|danger|info；Toggle 仅 [!toggle]。
 */

import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { getMarkdown } from '@milkdown/utils';
import { describe, expect, it } from 'vitest';

import { calloutPlugin } from '../callout';
import { TOGGLE_TYPE, togglePlugin } from '../toggle';

const MIXED_MD = [
  '> [!note] 笔记高亮',
  '>',
  '> callout body',
  '',
  '> [!toggle]- 折叠标题',
  '>',
  '> toggle body',
  '',
  '> [!tip] 提示',
  '>',
  '> tip body',
  '',
  '> [!toggle] 展开标题',
  '>',
  '> open body',
  '',
  '> plain quote',
  '',
].join('\n');

async function createEditor(
  markdown: string,
  order: 'callout-first' | 'toggle-first',
) {
  const root = document.createElement('div');
  document.body.appendChild(root);

  const editor = Editor.make();
  editor.config((ctx) => {
    ctx.set(rootCtx, root);
    ctx.set(defaultValueCtx, markdown);
  });
  editor.use(commonmark).use(gfm);

  if (order === 'callout-first') {
    editor.use(calloutPlugin()).use(togglePlugin());
  } else {
    editor.use(togglePlugin()).use(calloutPlugin());
  }

  await editor.create();
  return {
    editor,
    root,
    view: editor.ctx.get(editorViewCtx),
    destroy: async () => {
      await editor.destroy();
      root.remove();
    },
  };
}

function collectBlockTypes(view: { state: { doc: { descendants: (f: (n: { type: { name: string }; attrs: Record<string, unknown> }) => void) => void } } }) {
  const types: Array<{ name: string; typeAttr?: string; title?: string; open?: boolean }> = [];
  view.state.doc.descendants((node) => {
    if (node.type.name === 'callout') {
      types.push({
        name: 'callout',
        typeAttr: String(node.attrs.type ?? ''),
        title: String(node.attrs.title ?? ''),
      });
    } else if (node.type.name === TOGGLE_TYPE) {
      types.push({
        name: TOGGLE_TYPE,
        title: String(node.attrs.title ?? ''),
        open: Boolean(node.attrs.open),
      });
    } else if (node.type.name === 'blockquote') {
      types.push({ name: 'blockquote' });
    }
  });
  return types;
}

describe.each([
  ['callout-first' as const],
  ['toggle-first' as const],
])('callout + toggle coexistence (%s)', (order) => {
  it('parses callouts and toggles without swallowing each other', async () => {
    const { view, destroy } = await createEditor(MIXED_MD, order);
    try {
      const blocks = collectBlockTypes(view);

      const callouts = blocks.filter((b) => b.name === 'callout');
      const toggles = blocks.filter((b) => b.name === TOGGLE_TYPE);
      const quotes = blocks.filter((b) => b.name === 'blockquote');

      expect(callouts).toHaveLength(2);
      expect(callouts.map((c) => c.typeAttr).sort()).toEqual(['note', 'tip']);
      expect(callouts.find((c) => c.typeAttr === 'note')?.title).toBe('笔记高亮');
      expect(callouts.find((c) => c.typeAttr === 'tip')?.title).toBe('提示');

      expect(toggles).toHaveLength(2);
      expect(toggles.find((t) => t.title === '折叠标题')?.open).toBe(false);
      expect(toggles.find((t) => t.title === '展开标题')?.open).toBe(true);

      // 普通引用保留
      expect(quotes.length).toBeGreaterThanOrEqual(1);
    } finally {
      await destroy();
    }
  });

  it('roundtrips mixed markdown without marker loss', async () => {
    const { editor, destroy } = await createEditor(MIXED_MD, order);
    try {
      const out = editor.action(getMarkdown());
      expect(out).toContain('[!note]');
      expect(out).toContain('[!tip]');
      expect(out).toContain('[!toggle]-');
      expect(out).toMatch(/\[!toggle](?!-)/);
      expect(out).toContain('plain quote');
      // 不应把 toggle 误序列化成 callout 类型
      expect(out).not.toMatch(/\[!toggle].*\[!note]/);
    } finally {
      await destroy();
    }
  });
});

describe('trigger character isolation (wikilink vs mention)', () => {
  it('detectWikilinkTrigger ignores @ and detectMentionTrigger ignores [[', async () => {
    const { detectWikilinkTrigger } = await import('../wikilink/autocomplete');
    const { detectMentionTrigger } = await import('../mention/detectTrigger');

    expect(detectWikilinkTrigger('hello @note')).toBeNull();
    expect(detectWikilinkTrigger('hello [[note')).toEqual({
      triggerStartInText: 6,
      query: 'note',
    });

    // mention: 行首 / 空白后 @；[[ 不触发
    expect(detectMentionTrigger('hello [[note')).toBeNull();
    expect(detectMentionTrigger('@alice')).toEqual({
      triggerStartInText: 0,
      query: 'alice',
    });
    expect(detectMentionTrigger('hi @bob')).toEqual({
      triggerStartInText: 3,
      query: 'bob',
    });
  });
});
