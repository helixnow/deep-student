import { parserCtx } from '@milkdown/kit/core';
import { DOMSerializer, Slice, Fragment } from '@milkdown/prose/model';
import { undo, redo } from '@milkdown/prose/history';
import { describe, it, expect, beforeAll } from 'vitest';
import { BLOCK_ID_ATTR, focusBlockId } from '../index';
import { ensureRootBlockIds } from '../commands';
import { identityEditor } from './fixture';
import { duplicateCrepeBlock, moveCrepeBlocks, deleteCrepeBlock, turnCrepeBlockInto } from '../../../blockMenuCommands';
import { resolveBlockTarget } from '../../../blockTarget';
import { normalizeMarkdown } from '../../../normalizeMarkdown';

const marker = (id: string, body: string) => `<!-- ds:block-id=${id} -->\n\n${body}\n`;
beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
const ids = (env: Awaited<ReturnType<typeof identityEditor>>) => {
  const result: string[] = [];
  env.view.state.doc.forEach(node => { if (node.attrs.dsBlockId) result.push(node.attrs.dsBlockId); });
  return result;
};

describe('root block identity schema + remark pair', () => {
  it('opens legacy notes without generating identities or transactions', async () => {
    const env = await identityEditor('# Legacy\n\nplain\n\n- nested');
    try {
      expect(ids(env)).toEqual([]);
      expect(env.crepe.getMarkdown()).not.toContain('ds:block-id');
    } finally { await env.destroy(); }
  });

  it('roundtrips every root shape with formatting, toggle and callout', async () => {
    const shapes = ['# Heading', '**bold** and [link](https://example.com)', '- one\n- two',
      '> quote', '```ts\nx()\n```', '---', '> [!toggle]- Title\n> **inside**', '> [!note] Title\n> body',
      '| a | b |\n| - | - |\n| x | y |'];
    const source = shapes.map((shape, index) => marker(`block_${index}`, shape)).join('\n');
    const env = await identityEditor(source);
    try {
      expect(ids(env)).toEqual(shapes.map((_, i) => `block_${i}`));
      expect(() => env.crepe.editor.action(ctx => normalizeMarkdown(ctx, source))).not.toThrow();
      const output = env.crepe.getMarkdown();
      const reopened = await identityEditor(output);
      try {
        expect(ids(reopened)).toEqual(ids(env));
        expect(reopened.crepe.getMarkdown()).toBe(output);
        env.view.state.doc.descendants((node, _pos, parent) => {
          if (parent !== env.view.state.doc) expect(node.attrs[BLOCK_ID_ATTR]).toBeFalsy();
        });
      } finally { await reopened.destroy(); }
    } finally { await env.destroy(); }
  });

  it('explicitly upgrades the complete note after preflight and returns the selected ID', async () => {
    const source = 'one\n\ntwo\n';
    const env = await identityEditor(source);
    try {
      const target = resolveBlockTarget(env.view, 0)!;
      const result = env.crepe.editor.action(ctx => ensureRootBlockIds(ctx, target, source, source));
      expect(result).toHaveLength(1);
      expect(ids(env)).toHaveLength(2);
      expect(ids(env)[0]).toBe(result[0]);
      const reopened = await identityEditor(env.crepe.getMarkdown());
      try { expect(ids(reopened)).toEqual(ids(env)); } finally { await reopened.destroy(); }
    } finally { await env.destroy(); }
  });

  it('rejects unknown full-document suffix, lossy original input and nested addressing before mutation', async () => {
    const env = await identityEditor('one\n\n> nested');
    try {
      const doc = env.view.state.doc;
      for (const source of ['one\n\n> nested\n\n```js unsupported-metadata\nx\n```', 'one\n\n> nested\n\n<div>unknown</div>']) {
        expect(() => env.crepe.editor.action(ctx => ensureRootBlockIds(ctx, resolveBlockTarget(env.view, 0)!, source, source))).toThrow();
        expect(env.view.state.doc).toBe(doc);
      }
      const nested = resolveBlockTarget(env.view, doc.firstChild!.nodeSize + 1)!;
      expect(() => env.crepe.editor.action(ctx => ensureRootBlockIds(ctx, nested, env.crepe.getMarkdown(), env.crepe.getMarkdown()))).toThrow(/top-level/);
      expect(ids(env)).toEqual([]);
    } finally { await env.destroy(); }
  });

  it('copy assigns new ID, same-page move retains ID, reopen retains it, delete invalidates it', async () => {
    const env = await identityEditor(marker('original', 'one') + '\n' + marker('second', 'two'));
    try {
      expect(duplicateCrepeBlock(env.view, resolveBlockTarget(env.view, 0)!)).toBe(true);
      const [original, copied, second] = ids(env);
      expect(original).toBe('original'); expect(copied).not.toBe(original); expect(second).toBe('second');
      expect(moveCrepeBlocks(env.view, resolveBlockTarget(env.view, 0)!, env.view.state.doc.content.size)).toBe(true);
      expect(ids(env)).toEqual([copied, second, original]);
      const reopened = await identityEditor(env.crepe.getMarkdown());
      try {
        expect(ids(reopened)).toEqual([copied, second, original]);
        expect(focusBlockId(reopened.view, copied)).toBe(true);
        expect(deleteCrepeBlock(reopened.view, resolveBlockTarget(reopened.view, 0)!)).toBe(true);
        expect(focusBlockId(reopened.view, copied)).toBe(false);
      } finally { await reopened.destroy(); }
    } finally { await env.destroy(); }
  });

  it('keeps identity on root conversion without advertising nested identities', async () => {
    const env = await identityEditor(marker('stable', 'one'));
    try {
      expect(turnCrepeBlockInto(env.view, resolveBlockTarget(env.view, 0)!, 'quote')).toBe(true);
      expect(ids(env)).toEqual(['stable']);
      expect(env.view.state.doc.firstChild!.firstChild!.attrs.dsBlockId).toBeNull();
      expect(env.crepe.getMarkdown().match(/ds:block-id=/g)).toHaveLength(1);
    } finally { await env.destroy(); }
  });

  it('serializes ID into clipboard HTML and rekeys pasted content', async () => {
    const env = await identityEditor(marker('clipboard', 'one'));
    try {
      const node = env.view.state.doc.firstChild!;
      const html = DOMSerializer.fromSchema(env.view.state.schema).serializeNode(node) as HTMLElement;
      expect(html.getAttribute('data-ds-block-id')).toBe('clipboard');
      let copied = new Slice(Fragment.from(node), 0, 0);
      env.view.someProp('transformPasted', transform => { copied = transform(copied, env.view, false); });
      expect(copied.content.firstChild!.attrs.dsBlockId).not.toBe('clipboard');
      expect(copied.content.firstChild!.attrs.dsBlockId).toMatch(/^blk_/);
    } finally { await env.destroy(); }
  });

  it('preserves identities through user undo/redo and assigns IDs to new blocks only after upgrade', async () => {
    const env = await identityEditor(marker('first', 'one'));
    try {
      expect(duplicateCrepeBlock(env.view, resolveBlockTarget(env.view, 0)!)).toBe(true);
      const copiedIds = ids(env);
      expect(undo(env.view.state, env.view.dispatch)).toBe(true);
      expect(ids(env)).toEqual(['first']);
      expect(redo(env.view.state, env.view.dispatch)).toBe(true);
      expect(ids(env)).toEqual(copiedIds);
      env.view.dispatch(env.view.state.tr.insert(env.view.state.doc.content.size,
        env.view.state.schema.nodes.paragraph.create(null, env.view.state.schema.text('new'))));
      expect(ids(env)).toHaveLength(3);
      expect(new Set(ids(env)).size).toBe(3);
    } finally { await env.destroy(); }
  });

  it('preserves an identified empty paragraph without leaving an orphan marker', async () => {
    const env = await identityEditor(marker('empty', '<br />'));
    try {
      expect(ids(env)).toEqual(['empty']);
      const markdown = env.crepe.getMarkdown();
      expect(markdown).toContain('<br />');
      expect(() => env.crepe.editor.action(ctx => normalizeMarkdown(ctx, markdown))).not.toThrow();
      const reopened = await identityEditor(markdown);
      try { expect(ids(reopened)).toEqual(['empty']); } finally { await reopened.destroy(); }
    } finally { await env.destroy(); }
  });

  it('clipboard paste cannot implicitly upgrade a legacy destination', async () => {
    const env = await identityEditor('legacy');
    try {
      const identified = env.view.state.schema.nodes.paragraph.create({ dsBlockId: 'external' }, env.view.state.schema.text('copied'));
      let slice = new Slice(Fragment.from(identified), 0, 0);
      env.view.someProp('transformPasted', transform => { slice = transform(slice, env.view, false); });
      expect(slice.content.firstChild!.attrs.dsBlockId).toBeNull();
      expect(slice.content.firstChild!.textContent).toBe('copied');
      expect(ids(env)).toEqual([]);
    } finally { await env.destroy(); }
  });

  it('rejects duplicate imports and orphan markers; ignores fenced marker examples', async () => {
    const env = await identityEditor('plain');
    try {
      expect(() => env.crepe.editor.action(ctx => normalizeMarkdown(ctx, marker('same', 'one') + '\n' + marker('same', 'two')))).toThrow(/Duplicate/);
      expect(() => env.crepe.editor.action(ctx => normalizeMarkdown(ctx, '<!-- ds:block-id=orphan -->'))).toThrow();
      const parsed = env.crepe.editor.ctx.get(parserCtx)('```\n<!-- ds:block-id=example -->\n```');
      expect(parsed!.firstChild!.attrs.dsBlockId).toBeNull();
    } finally { await env.destroy(); }
  });
});
