/**
 * TASK009: executable, test-only Milkdown 7.22.1 integration prototype.
 * No mock editor/schema/diff: commands, decorations and uploads run in Crepe.
 * Tests labelled LIMITATION reproduce missing support, not acceptance criteria.
 */
import { Crepe, CrepeFeature } from '@milkdown/crepe';
import { commandsCtx, editorViewCtx, parserCtx } from '@milkdown/kit/core';
import { diffComponent, diffComponentConfig } from '@milkdown/kit/component/diff';
import {
  acceptAllDiffsCmd, acceptDiffChunkCmd, clearDiffReviewCmd, diff,
  diffPluginKey, getPendingChanges, rejectDiffChunkCmd,
  startDiffReviewCmd, startDiffReviewFromDocCmd,
} from '@milkdown/kit/plugin/diff';
import { uploadConfig } from '@milkdown/kit/plugin/upload';
import type { Node as ProseNode } from '@milkdown/prose/model';
import { TextSelection, type Plugin } from '@milkdown/prose/state';
import type { DecorationSet, EditorView } from '@milkdown/prose/view';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';

import { calloutPlugin } from '../plugins/callout';
import { togglePlugin } from '../plugins/toggle';
import { createUploadLifecycle } from '../uploadLifecycle';

const customBlockTypes = ['table', 'image-block', 'code_block', 'toggle', 'callout'];
const fixtures: Array<{ crepe: Crepe; root: HTMLElement; uploads: ReturnType<typeof createUploadLifecycle> }> = [];
beforeAll(async () => { await i18next.init({ lng: 'zh-CN', resources: {} }); });
afterEach(async () => {
  for (const { crepe, root, uploads } of fixtures.splice(0)) {
    uploads.dispose();
    await crepe.destroy();
    root.remove();
  }
});

async function setup(markdown: string, upload: (file: File) => Promise<string> = async file => `notes_assets/${file.name}`) {
  const root = document.createElement('div');
  document.body.append(root);
  let view: EditorView | null = null;
  const uploads = createUploadLifecycle({
    container: root, getView: () => view, isCurrent: () => true,
    validate: async () => {}, upload,
  });
  const crepe = new Crepe({
    root, defaultValue: markdown,
    features: {
      [CrepeFeature.AI]: false, // explicitly install only official diff + component
      [CrepeFeature.Toolbar]: false,
      [CrepeFeature.BlockEdit]: false,
      [CrepeFeature.LinkTooltip]: false,
    },
  });
  fixtures.push({ crepe, root, uploads });
  crepe.editor.use(calloutPlugin()).use(togglePlugin()).use(diff).use(diffComponent);
  crepe.editor.config(ctx => {
    ctx.update(diffComponentConfig.key, value => ({ ...value, customBlockTypes, acceptLabel: '接受', rejectLabel: '拒绝' }));
    ctx.update(uploadConfig.key, value => ({ ...value, uploadWidgetFactory: uploads.widgetFactory }));
  });
  await crepe.create();
  view = crepe.editor.ctx.get(editorViewCtx);
  const updateState = view.updateState.bind(view);
  view.updateState = state => { updateState(state); uploads.pruneDeleted(); };
  const commands = crepe.editor.ctx.get(commandsCtx);
  const parse = crepe.editor.ctx.get(parserCtx);
  const pending = () => {
    const state = diffPluginKey.getState(view!.state);
    return state ? getPendingChanges(state) : [];
  };
  const buttons = (action: 'accept' | 'reject') => Array.from(root.querySelectorAll<HTMLButtonElement>(`.milkdown-diff-${action}`));
  const start = (candidate: string) => {
    expect(commands.call(startDiffReviewCmd.key, candidate)).toBe(true);
    expect(diffPluginKey.getState(view!.state)?.active).toBe(true);
  };
  return { crepe, root, view, uploads, commands, parse, pending, buttons, start };
}

function expectDocument(f: Awaited<ReturnType<typeof setup>>, markdown: string) {
  const expected = f.parse(markdown)!;
  f.view.state.doc.check();
  expect(f.view.state.doc.eq(expected)).toBe(true);
  // Check serialization with the same actual schema, including attrs and marks.
  expect(f.parse(f.crepe.getMarkdown())!.eq(expected)).toBe(true);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function uploadDecorations(view: EditorView) {
  const plugins = view.state.plugins.filter(p => (p as Plugin & { key: string }).key.startsWith('MILKDOWN_UPLOAD$'));
  expect(plugins).toHaveLength(1); // reuse Crepe's registered plugin
  return (plugins[0] as Plugin<DecorationSet>).getState(view.state)!.find();
}

function imageSources(doc: ProseNode) {
  const result: string[] = [];
  doc.descendants(node => { if (['image', 'image-block'].includes(node.type.name)) result.push(node.attrs.src); });
  return result;
}

const original = 'Alpha old.\n\nUnchanged anchor.\n\nGamma old.';
const candidate = 'Alpha fresh.\n\nUnchanged anchor.\n\nGamma fresh.';

describe('TASK009 official diff / ordinary paragraphs', () => {
  it('accepts one real chunk, recomputes pending indices, rejects the remaining chunk', async () => {
    const f = await setup(original);
    const baseline = f.view.state.doc;
    f.start(candidate);
    expect(f.view.state.doc).toBe(baseline);
    expect(f.pending()).toHaveLength(2);
    expect(f.commands.call(acceptDiffChunkCmd.key, 0)).toBe(true);
    expectDocument(f, 'Alpha fresh.\n\nUnchanged anchor.\n\nGamma old.');
    expect(f.pending()).toHaveLength(1);
    expect(f.commands.call(rejectDiffChunkCmd.key, 0)).toBe(true);
    expect(diffPluginKey.getState(f.view.state)).toBeNull();
    expectDocument(f, 'Alpha fresh.\n\nUnchanged anchor.\n\nGamma old.');
  });

  it('rejects first, then accept-all applies only the remaining changes', async () => {
    const f = await setup(original);
    f.start(candidate);
    expect(f.commands.call(rejectDiffChunkCmd.key, 0)).toBe(true);
    expect(f.pending()).toHaveLength(1);
    expect(f.commands.call(acceptAllDiffsCmd.key)).toBe(true);
    expectDocument(f, 'Alpha old.\n\nUnchanged anchor.\n\nGamma fresh.');
    expect(diffPluginKey.getState(f.view.state)).toBeNull();
  });

  it('uses the official component buttons for mixed decisions', async () => {
    const f = await setup(original);
    f.start(candidate);
    expect(f.buttons('accept')).toHaveLength(2);
    expect(f.buttons('reject')[1].textContent).toBe('拒绝');
    f.buttons('reject')[1].click();
    expect(f.buttons('accept')).toHaveLength(1);
    f.buttons('accept')[0].click();
    expectDocument(f, 'Alpha fresh.\n\nUnchanged anchor.\n\nGamma old.');
    expect(diffPluginKey.getState(f.view.state)).toBeNull();
    expect(f.buttons('accept')).toHaveLength(0);
  });

  it('uses refreshed component controls after accepting the first group', async () => {
    const f = await setup(original);
    f.start(candidate);
    f.buttons('accept')[0].click();
    expect(f.pending()).toHaveLength(1);
    expect(f.buttons('reject')).toHaveLength(1);
    f.buttons('reject')[0].click();
    expectDocument(f, 'Alpha fresh.\n\nUnchanged anchor.\n\nGamma old.');
    expect(diffPluginKey.getState(f.view.state)).toBeNull();
  });

  it('has finer-than-paragraph granularity for separated inline replacements', async () => {
    const f = await setup('red with a long unchanged middle phrase and cold');
    f.start('blue with a long unchanged middle phrase and warm');
    expect(f.pending()).toHaveLength(2);
    f.commands.call(acceptDiffChunkCmd.key, 0);
    f.commands.call(rejectDiffChunkCmd.key, 0);
    expectDocument(f, 'blue with a long unchanged middle phrase and cold');
  });

  it('accepts a paragraph insertion and deletion through real chunk commands', async () => {
    const f = await setup('Keep.\n\nRemove.\n\nAnchor.');
    f.start('Keep.\n\nAnchor.\n\nAdded.');
    expect(f.pending()).toHaveLength(2);
    f.commands.call(acceptDiffChunkCmd.key, 0);
    expectDocument(f, 'Keep.\n\nAnchor.');
    f.commands.call(acceptDiffChunkCmd.key, 0);
    expectDocument(f, 'Keep.\n\nAnchor.\n\nAdded.');
    expect(diffPluginKey.getState(f.view.state)).toBeNull();
  });

  it.each(['chunk command', 'component range button'] as const)('LIMITATION: pure deletion rejected via %s stays pending', async route => {
    const f = await setup('Keep.\n\nRemove.\n\nAnchor.');
    f.start('Keep.\n\nAnchor.');
    const [deletion] = f.pending();
    expect(f.pending()).toHaveLength(1);
    expect(deletion.fromB).toBe(deletion.toB);
    if (route === 'chunk command') expect(f.commands.call(rejectDiffChunkCmd.key, 0)).toBe(true);
    else {
      expect(f.buttons('reject')).toHaveLength(1);
      f.buttons('reject')[0].click();
    }
    expect(f.pending()).toHaveLength(1); // NOT successful rejection
    expect(diffPluginKey.getState(f.view.state)?.active).toBe(true);
    f.commands.call(acceptAllDiffsCmd.key);
    expectDocument(f, 'Keep.\n\nAnchor.'); // rejected deletion is still applied
  });
});

const structures = [
  {
    name: 'toggle attrs + nested callout/table/math', type: 'toggle',
    before: '> [!toggle]- Old title\n>\n> > [!note] Inner\n> >\n> > | A | B |\n> > | - | - |\n> > | old | $x^2$ |',
    after: '> [!toggle] New title\n>\n> > [!note] Inner\n> >\n> > | A | B |\n> > | - | - |\n> > | fresh | $x^3$ |',
  },
  {
    name: 'callout type/title/body', type: 'callout',
    before: '> [!note] Old title\n>\n> Old body.',
    after: '> [!warning] New title\n>\n> Fresh body.',
  },
  {
    name: 'table multiple cells', type: 'table',
    before: '| A | B |\n| - | - |\n| old | cold |',
    after: '| A | B |\n| - | - |\n| fresh | warm |',
  },
  { name: 'block math (Crepe latex code_block)', type: 'code_block', before: '$$\nx^2 + y^2\n$$', after: '$$\nx^3 + y^3\n$$' },
];

describe('TASK009 official component / complex structures', () => {
  it.each(structures)('accepts $name as one configured block group', async ({ before, after, type }) => {
    const f = await setup(`${before}\n\nUnchanged suffix.`);
    expect(f.view.state.doc.firstChild?.type.name).toBe(type);
    if (type === 'toggle') {
      const descendants: string[] = [];
      f.view.state.doc.firstChild!.descendants(node => { descendants.push(node.type.name); });
      expect(descendants).toEqual(expect.arrayContaining(['callout', 'table', 'math_inline']));
    }
    const suffix = f.view.state.doc.lastChild!;
    f.start(`${after}\n\nUnchanged suffix.`);
    expect(f.pending().length).toBeGreaterThan(0);
    expect(f.buttons('accept')).toHaveLength(1);
    expect(f.root.querySelector('.milkdown-diff-added-block')).not.toBeNull();
    f.buttons('accept')[0].click(); // official range command, not our own grouping algorithm
    expectDocument(f, `${after}\n\nUnchanged suffix.`);
    expect(f.view.state.doc.lastChild!.eq(suffix)).toBe(true);
    expect(diffPluginKey.getState(f.view.state)).toBeNull();
  });

  it.each(structures)('rejects $name without changing document or serialized baseline', async ({ before, after }) => {
    const f = await setup(`${before}\n\nUnchanged suffix.`);
    const baseline = f.view.state.doc;
    const markdown = f.crepe.getMarkdown();
    f.start(`${after}\n\nUnchanged suffix.`);
    expect(f.buttons('reject')).toHaveLength(1);
    f.buttons('reject')[0].click();
    expect(f.view.state.doc).toBe(baseline);
    expect(f.crepe.getMarkdown()).toBe(markdown);
    expect(diffPluginKey.getState(f.view.state)).toBeNull();
  });

  it('computes cell-level changes but merges the table into one UI decision', async () => {
    const table = structures[2];
    const f = await setup(`${table.before}\n\nSuffix.`);
    f.start(`${table.after}\n\nSuffix.`);
    expect(f.pending()).toHaveLength(2);
    expect(f.buttons('accept')).toHaveLength(1);
    f.commands.call(acceptDiffChunkCmd.key, 0);
    expectDocument(f, '| A | B |\n| - | - |\n| fresh | cold |\n\nSuffix.');
    expect(f.pending()).toHaveLength(1);
    f.commands.call(rejectDiffChunkCmd.key, 0);
    expect(diffPluginKey.getState(f.view.state)).toBeNull();
  });

  it('mixes decisions across nested toggle, callout, table and block math without collateral edits', async () => {
    const documentFor = (accepted: number[]) => structures.map((entry, index) =>
      `${accepted.includes(index) ? entry.after : entry.before}\n\nBoundary ${index}.`,
    ).join('\n\n');
    const f = await setup(documentFor([]));
    f.start(documentFor([0, 1, 2, 3]));
    expect(f.buttons('accept')).toHaveLength(4);
    f.buttons('accept')[0].click();
    expect(f.buttons('reject')).toHaveLength(3);
    f.buttons('reject')[0].click();
    expect(f.buttons('reject')).toHaveLength(2);
    f.buttons('reject')[0].click();
    expect(f.buttons('accept')).toHaveLength(1);
    f.buttons('accept')[0].click();
    expectDocument(f, documentFor([0, 3]));
    expect(diffPluginKey.getState(f.view.state)).toBeNull();
  });

  it('accepts inline math atom attrs without replacing surrounding prose', async () => {
    const f = await setup('Formula $x^2$ stays here.');
    f.start('Formula $x^3$ stays here.');
    expect(f.pending()).toHaveLength(1);
    const change = f.pending()[0];
    expect(change.toA - change.fromA).toBe(1);
    f.buttons('accept')[0].click();
    expectDocument(f, 'Formula $x^3$ stays here.');
    expect(diffPluginKey.getState(f.view.state)).toBeNull();
  });

  it('renders toggle title content while the raw callout preview still exposes only title attrs', async () => {
    const f = await setup('> [!toggle]- Old title\n>\n> Body.\n\nSeparator.\n\n> [!note] Old callout\n>\n> Body.');
    f.start('> [!toggle] New title\n>\n> Body.\n\nSeparator.\n\n> [!tip] New callout\n>\n> Body.');
    const togglePreview = f.root.querySelector('.milkdown-diff-added [data-type="toggle"]')!;
    const calloutPreview = f.root.querySelector('.milkdown-diff-added [data-type="callout"]')!;
    expect(togglePreview.textContent).toContain('New title');
    expect(calloutPreview.getAttribute('data-callout-title')).toBe('New callout');
    expect(calloutPreview.textContent).not.toContain('New callout');
    expect(f.buttons('accept')).toHaveLength(2);
  });
});

describe('TASK009 review transaction lock and exit semantics', () => {
  it('blocks ordinary text/replace/attribute transactions but allows selection and metadata', async () => {
    const f = await setup(original);
    f.start(candidate);
    const baseline = f.view.state.doc;
    const blocked = [
      f.view.state.tr.insertText('intrusion', 1),
      f.view.state.tr.replaceWith(0, baseline.content.size, f.parse('Other writer.')!.content),
      f.view.state.tr.setNodeMarkup(0, f.view.state.schema.nodes.heading, { level: 2 }),
    ];
    for (const tr of blocked) {
      expect(tr.docChanged).toBe(true);
      expect(f.view.state.applyTransaction(tr).transactions).toHaveLength(0);
      f.view.dispatch(tr);
      expect(f.view.state.doc).toBe(baseline);
    }
    f.view.dispatch(f.view.state.tr.setSelection(TextSelection.create(baseline, 3)));
    expect(f.view.state.selection.from).toBe(3);
    const metaOnly = f.view.state.tr.setMeta('prototype-observation', true);
    expect(f.view.state.applyTransaction(metaOnly).transactions).toHaveLength(1);
    f.view.dispatch(metaOnly);
    expect(f.view.editable).toBe(true); // filterTransaction is NOT editable:false
    f.commands.call(clearDiffReviewCmd.key);
    f.view.dispatch(f.view.state.tr.insertText('allowed ', 1));
    expect(f.view.state.doc.firstChild?.textContent).toBe('allowed Alpha old.');
  });

  it('clear exits review but does not roll back accepted groups or preserve rejected decisions', async () => {
    const f = await setup(original);
    f.start(candidate);
    f.commands.call(acceptDiffChunkCmd.key, 0);
    f.commands.call(clearDiffReviewCmd.key);
    expectDocument(f, 'Alpha fresh.\n\nUnchanged anchor.\n\nGamma old.');
    expect(diffPluginKey.getState(f.view.state)).toBeNull();
    expect(f.commands.call(startDiffReviewFromDocCmd.key, f.parse(candidate)!)).toBe(true);
    expect(f.pending()).toHaveLength(1);
    f.commands.call(rejectDiffChunkCmd.key, 0);
    f.start(candidate);
    expect(f.pending()).toHaveLength(1); // starting again has no rejection memory
  });
});

describe('TASK009 official diff + production Upload pending lifecycle', () => {
  it('LIMITATION: completion during review loses insertion and leaves an orphan upload decoration', async () => {
    const gate = deferred<string>();
    const upload = vi.fn(() => gate.promise);
    const f = await setup(original, upload);
    f.uploads.start([{ name: 'pending.png', read: async () => new File(['image'], 'pending.png', { type: 'image/png' }) }], { pos: 1 });
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(uploadDecorations(f.view)).toHaveLength(1);
    f.start(candidate);
    const baseline = f.view.state.doc;
    gate.resolve('notes_assets/pending.png');
    await vi.waitFor(() => expect(f.root.querySelector('[role="status"]')).toBeNull());
    expect(f.view.state.doc).toBe(baseline);
    expect(imageSources(f.view.state.doc)).toEqual([]); // completion was filtered
    expect(uploadDecorations(f.view)).toHaveLength(1); // remove meta shared the filtered transaction
    f.commands.call(clearDiffReviewCmd.key);
    f.uploads.cancelAll(); // task has already been forgotten by finish()
    expect(uploadDecorations(f.view)).toHaveLength(1);
    expect(imageSources(f.view.state.doc)).toEqual([]);
  });

  it('explicit cancelAll before review removes anchors and prevents late completion', async () => {
    const gate = deferred<string>();
    const upload = vi.fn(() => gate.promise);
    const f = await setup(original, upload);
    f.uploads.start([{ name: 'pending.png', read: async () => new File(['image'], 'pending.png', { type: 'image/png' }) }], { pos: 1 });
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    f.uploads.cancelAll(); // test-only orchestration, not wired into the production editor
    expect(uploadDecorations(f.view)).toHaveLength(0);
    f.start(candidate);
    gate.resolve('notes_assets/late.png');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(imageSources(f.view.state.doc)).toEqual([]);
    expect(uploadDecorations(f.view)).toHaveLength(0);
    f.commands.call(acceptAllDiffsCmd.key);
    expectDocument(f, candidate);
  });

  it('LIMITATION: uploaded image Markdown reparses with invalid null caption in the official schema', async () => {
    const f = await setup(original);
    f.uploads.start([{ name: 'done.png', read: async () => new File(['image'], 'done.png', { type: 'image/png' }) }], { pos: 0 });
    await vi.waitFor(() => expect(imageSources(f.view.state.doc)).toEqual(['notes_assets/done.png']));
    expect(uploadDecorations(f.view)).toHaveLength(0);
    const completedBaseline = f.crepe.getMarkdown();
    expect(() => f.view.state.doc.check()).not.toThrow();
    const parsed = f.parse(completedBaseline)!;
    expect(parsed.firstChild?.attrs.caption).toBeNull();
    expect(() => parsed.check()).toThrow('Expected value of type string for attribute caption');
    const withImage = completedBaseline.replace('Alpha old.', 'Alpha fresh.');
    f.start(withImage);
    f.commands.call(acceptAllDiffsCmd.key);
    expect(() => f.view.state.doc.check()).toThrow('Expected value of type string for attribute caption');
    expect(imageSources(f.view.state.doc)).toEqual(['notes_assets/done.png']);
  });

  it('after upload completion, the pre-parsed-document API preserves valid image attrs', async () => {
    const f = await setup(original);
    f.uploads.start([{ name: 'done.png', read: async () => new File(['image'], 'done.png', { type: 'image/png' }) }], { pos: 0 });
    await vi.waitFor(() => expect(imageSources(f.view.state.doc)).toEqual(['notes_assets/done.png']));
    expect(uploadDecorations(f.view)).toHaveLength(0);
    let paragraphPos = -1;
    f.view.state.doc.descendants((node, pos) => { if (node.isText && node.text === 'Alpha old.') paragraphPos = pos; });
    expect(paragraphPos).toBeGreaterThan(0);
    const target = f.view.state.tr.insertText('fresh', paragraphPos + 6, paragraphPos + 9).doc;
    expect(() => target.check()).not.toThrow();
    expect(f.commands.call(startDiffReviewFromDocCmd.key, target)).toBe(true);
    expect(f.pending()).toHaveLength(1);
    f.commands.call(acceptAllDiffsCmd.key);
    expect(f.view.state.doc.eq(target)).toBe(true);
    expect(() => f.view.state.doc.check()).not.toThrow();
    expect(imageSources(f.view.state.doc)).toEqual(['notes_assets/done.png']);
    expect(diffPluginKey.getState(f.view.state)).toBeNull();
    // This only verifies the doc API. Markdown round-trip remains blocked above.
  });
});
