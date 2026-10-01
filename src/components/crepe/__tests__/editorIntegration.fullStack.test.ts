import { Crepe, CrepeFeature } from '@milkdown/crepe';
import { editorViewCtx, parserCtx, serializerCtx, commandsCtx } from '@milkdown/kit/core';
import { TextSelection, NodeSelection } from '@milkdown/prose/state';
import { undo, redo, undoDepth } from '@milkdown/prose/history';
import { replaceAll } from '@milkdown/kit/utils';
import { uploadConfig } from '@milkdown/kit/plugin/upload';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { applyCrepePlugins } from '../plugins';
import { normalizeMarkdown } from '../normalizeMarkdown';
import { canExecuteCrepeCommand, executeCrepeCommand, runCrepeCommand, bindCrepeCommandHost, crepeExecuteCommand } from '../commandRegistry';
import { resolveBlockTarget, resolveBlockSelection } from '../blockTarget';
import { moveCrepeBlocks, prepareCrepeBlockMove } from '../blockMenuCommands';
import { createBlockTransferCodec, planBlockIdentityUpgrade, planBlockTransfer } from '../blockTransfer/service';
import { createUploadLifecycle } from '../uploadLifecycle';
import { exportColumnsPlainMarkdown } from '../plugins/columns';
import { copyBlockWithFreshIdentity } from '../plugins/blockIdentity';
import { wireCrepeCommandMenu } from '../commandMenus';
import { resolveCrepeBlockDrop } from '../blockDrop';

beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
async function mount(markdown: string, initialGrant = false) {
  let granted = initialGrant;
  const root = document.createElement('div'); document.body.append(root);
  const crepe = new Crepe({ root, defaultValue: markdown, features: {
    [CrepeFeature.CodeMirror]: true, [CrepeFeature.Toolbar]: true, [CrepeFeature.BlockEdit]: true,
    [CrepeFeature.LinkTooltip]: true,
  }, featureConfigs: {
    [CrepeFeature.Toolbar]: { buildToolbar: builder => wireCrepeCommandMenu(builder, 'bubble') },
    [CrepeFeature.BlockEdit]: { buildMenu: builder => wireCrepeCommandMenu(builder, 'slash') },
  } });
  applyCrepePlugins(crepe, { automd: true, columns: { canWrite: () => granted } });
  await crepe.create();
  const view = crepe.editor.ctx.get(editorViewCtx);
  return { crepe, view, root, grant(value: boolean) { granted = value; },
    destroy: async () => { await crepe.destroy(); root.remove(); } };
}
const mark = (id: string, text: string) => `<!-- ds:block-id=${id} -->\n\n${text}\n`;
const layout = `:::ds-columns{version=1 layout=equal}\n\n:::column\n\nLeft **bold**\n\n:::end-column\n\n:::column\n\nRight\n\n:::end-column\n\n:::end-ds-columns`;
const rootIds = (f: Awaited<ReturnType<typeof mount>>) => {
  const ids: string[] = []; f.view.state.doc.forEach(node => { if (node.attrs.dsBlockId) ids.push(node.attrs.dsBlockId); }); return ids;
};
function posOf(f: Awaited<ReturnType<typeof mount>>, text: string) {
  let result = -1;
  f.view.state.doc.descendants((node, pos) => { if (node.isText && node.text === text) result = pos; });
  if (result < 0) throw new Error(`Missing text: ${text}`);
  return result;
}

describe('formal toggle + identity + columns + command registry', () => {
  it('reads one outer identity for a complete columns envelope and normalizes/reopens without loss', async () => {
    const f = await mount(mark('layout', layout) + '\n' + mark('tail', 'Tail'));
    try {
      expect(f.view.state.doc.firstChild!.type.name).toBe('ds_columns');
      expect(rootIds(f)).toEqual(['layout', 'tail']);
      f.view.state.doc.firstChild!.descendants(node => expect(node.attrs.dsBlockId).toBeFalsy());
      const canonical = normalizeMarkdown(f.crepe.editor.ctx, f.crepe.getMarkdown());
      const parsed = f.crepe.editor.ctx.get(parserCtx)(canonical)!; parsed.check();
      expect(parsed.firstChild!.attrs.dsBlockId).toBe('layout');
      expect(parsed.firstChild!.textContent).toBe('Left boldRight');
      const codec = createBlockTransferCodec(f.crepe.editor.ctx);
      expect(codec.parse(canonical).children.filter(node => node.type === 'ds_columns')).toHaveLength(1);
      const plan = planBlockTransfer(canonical, mark('dest', 'Destination'), ['layout'], codec);
      expect(plan.sourceContent).not.toContain(':::column');
      expect(plan.targetContent).toContain(':::end-ds-columns');
      const upgrade = planBlockIdentityUpgrade(layout + '\n\nSummary\n', codec);
      expect(upgrade.blockIds).toHaveLength(2);
      expect(upgrade.content.match(/ds:block-id=/g)).toHaveLength(2);
    } finally { await f.destroy(); }
  });

  it('constructs formal toggle children, promotes title targets, and keeps body targets nested', async () => {
    const f = await mount(mark('first', '**Body**'));
    try {
      expect(runCrepeCommand(f.view, 'toggle')).toBe(true);
      const toggle = f.view.state.doc.firstChild!;
      expect(toggle.child(0).type.name).toBe('toggleTitle');
      expect(toggle.child(1).type.name).toBe('toggleBody');
      expect(toggle.attrs.dsBlockId).toBe('first');
      f.view.state.doc.check();
      f.view.dispatch(f.view.state.tr.setSelection(TextSelection.create(f.view.state.doc, 2)));
      expect(resolveBlockSelection(f.view)?.pos).toBe(0);
      expect(canExecuteCrepeCommand(f.view, 'bold')).toBe(false);
      const body = posOf(f, 'Body');
      expect(resolveBlockTarget(f.view, body)?.depth).toBe(3);
      expect(runCrepeCommand(f.view, 'paragraph', { target: resolveBlockTarget(f.view, 0)! })).toBe(true);
      expect(f.view.state.doc.firstChild!.type.name).toBe('paragraph');
      expect(rootIds(f)[0]).toBe('first');
      expect(f.view.state.doc.textContent).toContain('Body');
    } finally { await f.destroy(); }
  });

  it('requires a host grant for layout writes, inherits the first ID, gives new roots unique IDs and rekeys copies', async () => {
    const f = await mount(mark('first', 'Alpha') + '\n' + mark('second', 'Beta'));
    try {
      expect(canExecuteCrepeCommand(f.view, 'convert-cornell')).toBe(false);
      const before = f.view.state.doc;
      expect(await executeCrepeCommand(f.view, 'convert-cornell')).toBe(false);
      expect(f.view.state.doc).toBe(before);
      const request = vi.fn(async () => { f.grant(true); return true; });
      bindCrepeCommandHost(f.view, { ctx: f.crepe.editor.ctx, canWriteLayout: () => false, requestLayoutCapability: request });
      expect(await executeCrepeCommand(f.view, 'convert-cornell')).toBe(true);
      expect(request).toHaveBeenCalledTimes(1);
      expect(f.view.state.doc.firstChild!.type.name).toBe('ds_columns');
      expect(f.view.state.doc.firstChild!.attrs.dsBlockId).toBe('first');
      expect(new Set(rootIds(f)).size).toBe(rootIds(f).length);
      expect(rootIds(f)).toContain('second');
      expect(rootIds(f).length).toBeGreaterThan(2);
      const target = resolveBlockTarget(f.view, 0)!;
      expect(runCrepeCommand(f.view, 'duplicate', { target })).toBe(true);
      expect(f.view.state.doc.child(1).attrs.dsBlockId).not.toBe('first');
      const output = f.crepe.getMarkdown();
      expect(() => normalizeMarkdown(f.crepe.editor.ctx, output)).not.toThrow();
      f.crepe.editor.action(replaceAll(output));
      expect(f.crepe.getMarkdown()).toBe(output);
      const plain = exportColumnsPlainMarkdown(copyBlockWithFreshIdentity(f.view.state.doc, false), f.crepe.editor.ctx.get(serializerCtx));
      expect(plain).not.toContain(':::ds-columns'); expect(plain).not.toContain('ds:block-id'); expect(plain).toContain('Alpha');
    } finally { await f.destroy(); }
  });

  it('shares pure canExecute and execution across registered Milkdown and slash commands', async () => {
    const f = await mount('/toggle');
    try {
      const original = f.view.state.doc;
      f.view.dispatch(f.view.state.tr.setSelection(TextSelection.create(original, 8)));
      expect(canExecuteCrepeCommand(f.view, 'insert-toggle', { slash: true })).toBe(true);
      expect(f.view.state.doc).toBe(original);
      const items = [{ key: 'toggle', onRun: undefined as undefined | ((ctx: typeof f.crepe.editor.ctx) => void) }];
      const builder = { build: () => [{ key: 'advanced', items }], addGroup: () => ({ addItem: () => {} }) };
      wireCrepeCommandMenu(builder, 'slash'); items[0].onRun!(f.crepe.editor.ctx);
      expect(f.view.state.doc.firstChild!.type.name).toBe('toggle');
      expect(f.view.state.doc.textContent).not.toContain('/toggle');
      expect(undoDepth(f.view.state)).toBe(1);
      expect(undo(f.view.state, f.view.dispatch)).toBe(true);
      expect(f.view.state.doc.eq(original)).toBe(true);
      expect(f.crepe.editor.ctx.get(commandsCtx).call(crepeExecuteCommand.key, { id: 'heading-2' })).toBe(true);
      expect(f.view.state.doc.firstChild!.attrs.level).toBe(2);
      f.crepe.setReadonly(true);
      expect(canExecuteCrepeCommand(f.view, 'delete')).toBe(false);
      expect(runCrepeCommand(f.view, 'delete')).toBe(false);
    } finally { await f.destroy(); }
  });

  it.each([
    ['math', 'code_block'], ['table', 'table'], ['image', 'image-block'],
    ['hr', 'hr'], ['insert-callout', 'callout'],
  ] as const)('inserts %s through the actual slash command with one undo step', async (id, type) => {
    const f = await mount(`/${id}`);
    try {
      const original = f.view.state.doc;
      f.view.dispatch(f.view.state.tr.setSelection(TextSelection.create(original, id.length + 2)));
      expect(canExecuteCrepeCommand(f.view, id, { slash: true })).toBe(true);
      expect(runCrepeCommand(f.view, id, { slash: true })).toBe(true);
      let inserted = false;
      f.view.state.doc.descendants(node => {
        if (node.type.name === type) {
          inserted = true;
          if (id === 'math') expect(node.attrs.language).toBe('LaTeX');
        }
      });
      expect(inserted).toBe(true);
      expect(f.view.state.doc.textContent).not.toContain(`/${id}`);
      f.view.state.doc.check();
      expect(undoDepth(f.view.state)).toBe(1);
      expect(undo(f.view.state, f.view.dispatch)).toBe(true);
      expect(f.view.state.doc.eq(original)).toBe(true);
    } finally { await f.destroy(); }
  });

  it.each(['denied', 'selection', 'document', 'review', 'host'] as const)(
    'does not apply a pending layout request after %s changes', async reason => {
      const f = await mount('Alpha\n\nBeta');
      let grant!: (value: boolean) => void;
      let review = false;
      const host = { ctx: f.crepe.editor.ctx, canWriteLayout: () => false,
        isReviewActive: () => review,
        requestLayoutCapability: () => new Promise<boolean>(resolve => { grant = resolve; }) };
      bindCrepeCommandHost(f.view, host);
      try {
        const pending = executeCrepeCommand(f.view, 'convert-columns');
        if (reason === 'selection') f.view.dispatch(f.view.state.tr.setSelection(TextSelection.create(f.view.state.doc, posOf(f, 'Beta'))));
        if (reason === 'document') f.view.dispatch(f.view.state.tr.insertText('changed', posOf(f, 'Alpha')));
        if (reason === 'review') review = true;
        if (reason === 'host') bindCrepeCommandHost(f.view, { ctx: f.crepe.editor.ctx, canWriteLayout: () => true });
        const before = f.view.state.doc;
        f.grant(reason !== 'denied'); grant(reason !== 'denied');
        expect(await pending).toBe(false);
        expect(f.view.state.doc).toBe(before);
      } finally { await f.destroy(); }
    },
  );

  it('reports commands disabled while a loaded columns document lacks a write grant', async () => {
    const f = await mount(layout);
    try {
      f.view.dispatch(f.view.state.tr.setSelection(TextSelection.create(f.view.state.doc, posOf(f, 'Right'), posOf(f, 'Right') + 5)));
      const before = f.view.state.doc;
      expect(canExecuteCrepeCommand(f.view, 'bold')).toBe(false);
      expect(runCrepeCommand(f.view, 'bold')).toBe(false);
      expect(f.view.state.doc).toBe(before);
      f.grant(true);
      expect(canExecuteCrepeCommand(f.view, 'bold')).toBe(true);
    } finally { await f.destroy(); }
  });

  it('preflights the real layout command before requesting a capability', async () => {
    const f = await mount('Alpha');
    const request = vi.fn(async () => true);
    bindCrepeCommandHost(f.view, { ctx: f.crepe.editor.ctx, canWriteLayout: () => false, requestLayoutCapability: request });
    try {
      expect(canExecuteCrepeCommand(f.view, 'insert-columns')).toBe(true);
      expect(canExecuteCrepeCommand(f.view, 'convert-cornell-template')).toBe(false);
      f.view.dispatch(f.view.state.tr.setSelection(NodeSelection.create(f.view.state.doc, 0)));
      expect(canExecuteCrepeCommand(f.view, 'insert-columns')).toBe(false);
      expect(canExecuteCrepeCommand(f.view, 'convert-columns')).toBe(true);
      expect(await executeCrepeCommand(f.view, 'insert-columns')).toBe(false);
      expect(request).not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });

  it('hit-tests both column axes and distinguishes inside, before, after and invalid self drops', async () => {
    const f = await mount('Source\n\n' + layout, true);
    try {
      const source = resolveBlockTarget(f.view, 0)!;
      const layoutPos = source.to;
      const columns = f.view.state.doc.nodeAt(layoutPos)!;
      const left = layoutPos + 1, right = left + columns.child(0).nodeSize;
      const bounds = (pos: number, x: number, y: number, width: number, height: number) => {
        vi.spyOn(f.view.nodeDOM(pos) as HTMLElement, 'getBoundingClientRect').mockReturnValue(new DOMRect(x, y, width, height));
      };
      bounds(0, 0, 0, 420, 20); bounds(layoutPos, 0, 40, 420, 180);
      bounds(left, 0, 40, 200, 180); bounds(right, 220, 40, 200, 180);
      bounds(left + 1, 12, 50, 176, 20); bounds(right + 1, 232, 50, 176, 20);
      expect(resolveCrepeBlockDrop(f.view, source, { x: 100, y: 150 })).toMatchObject({ kind: 'inside', containerPos: left, valid: true });
      expect(resolveCrepeBlockDrop(f.view, source, { x: 300, y: 150 })).toMatchObject({ kind: 'inside', containerPos: right, valid: true });
      expect(resolveCrepeBlockDrop(f.view, source, { x: 300, y: 51 })).toMatchObject({ kind: 'before', pos: right + 1, valid: true });
      expect(resolveCrepeBlockDrop(f.view, source, { x: 300, y: 69 })).toMatchObject({ kind: 'after', valid: true });
      expect(resolveCrepeBlockDrop(f.view, source, { x: 100, y: 10 })).toMatchObject({ valid: false, reason: 'self' });
    } finally { await f.destroy(); }
  });

  it('moves across toggle bodies and columns without widening; self-containment and nested columns are rejected', async () => {
    const f = await mount('> [!toggle] First\n> A\n\n> [!toggle] Second\n> B\n\n' + layout, true);
    try {
      const first = f.view.state.doc.firstChild!;
      const secondPos = first.nodeSize;
      const second = f.view.state.doc.child(1);
      const bodyEnd = secondPos + 1 + second.child(0).nodeSize + 1 + second.child(1).content.size;
      const target = resolveBlockTarget(f.view, posOf(f, 'A'))!;
      expect(moveCrepeBlocks(f.view, target, bodyEnd)).toBe(true);
      expect(f.view.state.doc.child(0).child(1).firstChild!.textContent).toBe('');
      expect(f.view.state.doc.child(1).child(1).textContent).toBe('BA');
      expect(undo(f.view.state, f.view.dispatch)).toBe(true);
      expect(redo(f.view.state, f.view.dispatch)).toBe(true);
      const toggleTarget = resolveBlockTarget(f.view, 0)!;
      expect(prepareCrepeBlockMove(f.view, toggleTarget, 1 + f.view.state.doc.firstChild!.child(0).nodeSize + 1)).toBeNull();
      let columnsPos = -1;
      f.view.state.doc.forEach((node, pos) => { if (node.type.name === 'ds_columns') columnsPos = pos; });
      expect(resolveBlockTarget(f.view, columnsPos + 1)).toBeNull();
      const columnsTarget = resolveBlockTarget(f.view, columnsPos)!;
      expect(prepareCrepeBlockMove(f.view, columnsTarget, 1 + f.view.state.doc.firstChild!.child(0).nodeSize + 1)).toBeNull();
      const nested = resolveBlockTarget(f.view, posOf(f, 'A'))!;
      const column = f.view.state.doc.nodeAt(columnsPos)!.child(0);
      expect(moveCrepeBlocks(f.view, nested, columnsPos + 2 + column.content.size)).toBe(true);
      expect(f.view.state.doc.nodeAt(columnsPos - nested.nodes[0].nodeSize)!.child(0).textContent).toContain('A');
      f.view.state.doc.check();
    } finally { await f.destroy(); }
  });

  it('normalizes image captions in the actual parser and full-document save/reload path', async () => {
    // Crepe's persisted image-block uses the Markdown alt slot for its ratio.
    const markdown = '![1.00](asset://image.png)\n';
    const f = await mount(markdown);
    try {
      f.view.state.doc.check();
      const image = f.view.state.doc.firstChild!;
      expect(image.type.name).toBe('image-block'); expect(image.attrs.caption).toBe('');
      const canonical = normalizeMarkdown(f.crepe.editor.ctx, markdown);
      f.crepe.editor.action(replaceAll(canonical)); f.view.state.doc.check();
      expect(f.view.state.doc.firstChild!.attrs.caption).toBe('');
      expect(normalizeMarkdown(f.crepe.editor.ctx, f.crepe.getMarkdown())).toBe(canonical);
      // The caption repair must not bless unrelated upstream loss of textual alt.
      expect(() => normalizeMarkdown(f.crepe.editor.ctx, '![meaningful alt](asset://image.png)')).toThrow(/lose content/);
    } finally { await f.destroy(); }
  });
});

describe('upload review leases on the same real editor', () => {
  it('blocks new user commands/uploads while an existing upload still commits; releasing nested leases restores commands', async () => {
    const f = await mount('Body');
    let complete!: (url: string) => void;
    const upload = vi.fn(() => new Promise<string>(resolve => { complete = resolve; }));
    const lifecycle = createUploadLifecycle({ getView: () => f.view, isCurrent: () => true, container: f.root,
      validate: async () => {}, upload });
    f.crepe.editor.ctx.update(uploadConfig.key, config => ({ ...config, uploadWidgetFactory: lifecycle.widgetFactory }));
    bindCrepeCommandHost(f.view, { ctx: f.crepe.editor.ctx, isReviewActive: () => lifecycle.getState().reviewLeases > 0 });
    try {
      const file = new File(['png'], 'image.png', { type: 'image/png' });
      lifecycle.start([{ name: file.name, read: async () => file }], { pos: f.view.state.doc.content.size });
      await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
      const releaseA = lifecycle.acquireReviewLease(), releaseB = lifecycle.acquireReviewLease();
      expect(lifecycle.getState()).toEqual({ pending: 1, running: 1, failed: 0, reviewLeases: 2 });
      expect(f.view.editable).toBe(true); expect(f.view.dom.inert).toBe(true);
      expect(canExecuteCrepeCommand(f.view, 'bold')).toBe(false); expect(runCrepeCommand(f.view, 'delete')).toBe(false);
      expect(lifecycle.start([{ name: file.name, read: async () => file }], { pos: 1 })).toBeNull();
      complete('asset://saved.png');
      await vi.waitFor(() => expect(lifecycle.getState().pending).toBe(0));
      expect(f.crepe.getMarkdown()).toContain('asset://saved.png');
      releaseA(); expect(canExecuteCrepeCommand(f.view, 'bold')).toBe(false);
      releaseB(); expect(canExecuteCrepeCommand(f.view, 'bold')).toBe(true);
      expect(f.view.dom.inert).toBeFalsy();
    } finally { lifecycle.dispose(); await f.destroy(); }
  });
});
