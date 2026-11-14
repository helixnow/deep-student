/**
 * FE-B5: `applyCrepePlugins` registers the official stack with one `editor.use` per `editor.extensions` entry (21 calls,
 * 54 Milkdown plugins). Registering the same flattened list with a single `use` builds the same editor on real
 * Crepe 7.22: before `create()` Milkdown's `use` only appends to its plugin store, and `create()` prepares and runs
 * that store in insertion order. Compared here: plugin setup / run / ready order relative to `create()`, ProseMirror
 * plugin order (priority), schema, remark chain, input rules, node and mark views, key handling, the parsed document,
 * and error isolation (community errors reported per entry, an official factory error aborts before any `use`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Crepe } from '@milkdown/crepe';
import { editorViewCtx, inputRulesCtx, markViewCtx, nodeViewCtx, remarkPluginsCtx, schemaCtx } from '@milkdown/kit/core';
import type { MilkdownPlugin } from '@milkdown/ctx';
import type { Ctx } from '@milkdown/kit/ctx';
import type { EditorView } from '@milkdown/prose/view';
import { TextSelection, type EditorState, type Plugin } from '@milkdown/prose/state';
import type { SlotEntry } from '@/ui-kernel/slots';
import {
  resolveEditorExtensions,
  type EditorContributionError,
  type EditorExtensionContribution,
} from '@/ui-plugins/official/editor/editorSlots';
import { applyCrepePlugins, defaultPluginOptions, officialEditorExtensionEntries, type CrepePluginsOptions } from '../plugins';

type Entries = readonly SlotEntry<EditorExtensionContribution>[];
type Assemble = (crepe: Crepe, options: CrepePluginsOptions, entries: Entries, onError: EditorContributionError) => void;

const perEntry: Assemble = applyCrepePlugins;
const singleUse: Assemble = (crepe, options, entries, onError) => {
  const plugins = resolveEditorExtensions(entries, { options }, onError);
  if (plugins.length) crepe.editor.use(plugins);
};

const SAMPLE = [
  '# 特征值', '', '设 **A** 为方阵，*非零* 向量 `x`。', '', '- 第一条', '- [ ] 待办', '', '> 引用', '',
  '```ts', 'const x = 1;', '```', '', '[[线性代数]] 与 [链接](https://example.com)', '',
].join('\n');

const KEY_PROBES: [string, KeyboardEventInit][] = [
  ['Enter', { key: 'Enter' }], ['Shift-Enter', { key: 'Enter', shiftKey: true }], ['Mod-Enter', { key: 'Enter', ctrlKey: true }],
  ['Backspace', { key: 'Backspace' }], ['Tab', { key: 'Tab' }], ['Escape', { key: 'Escape' }],
  ['ArrowUp', { key: 'ArrowUp' }], ['Shift-ArrowDown', { key: 'ArrowDown', shiftKey: true }],
  ['Mod-a', { key: 'a', ctrlKey: true }], ['Mod-b', { key: 'b', ctrlKey: true }], ['Mod-k', { key: 'k', ctrlKey: true }],
  ['Mod-d', { key: 'd', ctrlKey: true }], ['Mod-z', { key: 'z', ctrlKey: true }], ['Mod-Alt-1', { key: '1', ctrlKey: true, altKey: true }],
  ['Mod-Shift-8', { key: '8', ctrlKey: true, shiftKey: true }], ['Mod-/', { key: '/', ctrlKey: true }],
];

/** PluginKey names carry a per-process counter (`name$3`); instances differ only in that suffix. */
const maskKey = (key: string) => key.replace(/\$\d*$/, '$');

function describePlugin(plugin: Plugin): string {
  const spec = plugin.spec as Record<string, unknown> & { props?: Record<string, unknown> };
  const hooks = ['state', 'view', 'appendTransaction', 'filterTransaction'].filter((hook) => spec[hook]);
  return `${maskKey((plugin as unknown as { key: string }).key)} props[${Object.keys(spec.props ?? {}).sort().join(',')}] hooks[${hooks.join(',')}]`;
}

function keyMatrix(view: EditorView, baseline: EditorState): Record<string, string> {
  let textStart = -1;
  baseline.doc.descendants((node, at) => { if (textStart < 0 && node.isText && /方阵/.test(node.text ?? '')) textStart = at + 2; });
  const result: Record<string, string> = {};
  for (const [label, init] of KEY_PROBES) {
    view.updateState(baseline);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textStart)));
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    const index = view.state.plugins.findIndex((plugin) => {
      const handle = (plugin.props as { handleKeyDown?: (v: EditorView, e: KeyboardEvent) => boolean }).handleKeyDown;
      return Boolean(handle?.call(plugin, view, event));
    });
    result[label] = index < 0 ? 'unhandled' : `#${index} ${maskKey((view.state.plugins[index] as unknown as { key: string }).key)}`;
  }
  view.updateState(baseline);
  return result;
}

function snapshot(crepe: Crepe) {
  const ctx = crepe.editor.ctx;
  const view = ctx.get(editorViewCtx);
  const schema = ctx.get(schemaCtx);
  const nodes: string[] = [];
  schema.spec.nodes.forEach((name) => { nodes.push(name); });
  const marks: string[] = [];
  schema.spec.marks.forEach((name) => { marks.push(name); });
  const baseline = view.state;
  return {
    nodes,
    marks,
    prosePlugins: baseline.plugins.map(describePlugin),
    remark: ctx.get(remarkPluginsCtx).map(({ plugin, options }) => `${(plugin as { name?: string })?.name || '·'}(${Object.keys(options ?? {}).sort().join(',')})`),
    inputRules: ctx.get(inputRulesCtx).length,
    nodeViews: ctx.get(nodeViewCtx).map(([name]) => name),
    markViews: ctx.get(markViewCtx).map(([name]) => name),
    keys: keyMatrix(view, baseline),
    doc: baseline.doc.toJSON(),
    markdown: crepe.getMarkdown(),
  };
}

/** The same Milkdown plugin, recording when Milkdown prepares (`setup`), starts (`run`) and finishes (`ready`) it. */
function traced(plugin: MilkdownPlugin, label: string, events: string[]): MilkdownPlugin {
  const wrapped = ((ctx: Ctx) => {
    events.push(`setup ${label}`);
    const run = plugin(ctx);
    return async () => {
      events.push(`run ${label}`);
      const cleanup = await run();
      events.push(`ready ${label}`);
      return cleanup;
    };
  }) as MilkdownPlugin;
  return Object.assign(wrapped, plugin);
}

function tracedEntries(entries: Entries, events: string[]): Entries {
  return entries.map((entry) => ({
    ...entry,
    value: {
      create: (editor) => {
        const created = entry.value.create(editor);
        if (!created) return null;
        return ([created] as unknown[]).flat(Infinity).map((plugin, index) => traced(plugin as MilkdownPlugin, `${entry.id}#${index}`, events));
      },
    },
  }));
}

const roots: HTMLElement[] = [];
const editors: Crepe[] = [];

interface Built {
  crepe: Crepe;
  /** Deep-flattened size of every `editor.use` the assembly made. */
  uses: number[];
  errors: string[];
}

async function build(assemble: Assemble, options: CrepePluginsOptions, entries: Entries, events?: string[]): Promise<Built> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  roots.push(root);
  const crepe = new Crepe({ root, defaultValue: SAMPLE });
  editors.push(crepe);
  const uses: number[] = [];
  const errors: string[] = [];
  const register = crepe.editor.use;
  (crepe.editor as { use: typeof register }).use = (plugins) => {
    uses.push(([plugins] as unknown[]).flat(Infinity).length);
    events?.push('use');
    return register(plugins);
  };
  assemble(crepe, options, entries, (entry, error) => { errors.push(`${entry.id}: ${(error as Error).message}`); });
  events?.push('create');
  await crepe.create();
  events?.push('created');
  return { crepe, uses, errors };
}

function community(id: string, order: number, create: EditorExtensionContribution['create']): SlotEntry<EditorExtensionContribution> {
  return { id, order, owner: 'example.editor', origin: 'community', value: { create } };
}

function withEntries(...extra: SlotEntry<EditorExtensionContribution>[]): Entries {
  return [...officialEditorExtensionEntries, ...extra].sort((a, b) => a.order - b.order);
}

const OPTION_VARIANTS: Record<string, CrepePluginsOptions> = {
  defaults: defaultPluginOptions,
  'no automd / wikilink / mention': { ...defaultPluginOptions, automd: false, wikilink: false, mention: false },
};

import { setupMilkdownTimers } from './milkdownTimers';

setupMilkdownTimers();

describe('FE-B5: one editor.use per entry or one editor.use for the whole stack', () => {
  beforeAll(() => {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
  });
  afterAll(async () => {
    for (const crepe of editors) await crepe.destroy();
    for (const root of roots) root.remove();
  });

  it('hands Milkdown the same 54 plugins, as 21 calls or as one', async () => {
    const grouped = await build(perEntry, defaultPluginOptions, officialEditorExtensionEntries);
    const single = await build(singleUse, defaultPluginOptions, officialEditorExtensionEntries);
    expect(grouped.uses).toHaveLength(21);
    expect(grouped.uses.reduce((sum, size) => sum + size, 0)).toBe(54);
    expect(single.uses).toEqual([54]);
  }, 60_000);

  for (const [name, options] of Object.entries(OPTION_VARIANTS)) {
    it(`builds the same editor (${name})`, async () => {
      const grouped = await build(perEntry, options, officialEditorExtensionEntries);
      const single = await build(singleUse, options, officialEditorExtensionEntries);
      expect(single.uses).toHaveLength(1);
      expect(snapshot(single.crepe)).toEqual(snapshot(grouped.crepe));
    }, 60_000);
  }

  it('prepares, starts and finishes every plugin in the same order, all inside create()', async () => {
    const groupedEvents: string[] = [];
    const singleEvents: string[] = [];
    await build(perEntry, defaultPluginOptions, tracedEntries(officialEditorExtensionEntries, groupedEvents), groupedEvents);
    await build(singleUse, defaultPluginOptions, tracedEntries(officialEditorExtensionEntries, singleEvents), singleEvents);
    for (const events of [groupedEvents, singleEvents]) {
      const create = events.indexOf('create');
      expect(events.slice(0, create).every((event) => event === 'use')).toBe(true);
      expect(events.at(-1)).toBe('created');
      expect(events.filter((event) => event.startsWith('setup '))).toHaveLength(54);
      expect(events.filter((event) => event.startsWith('ready '))).toHaveLength(54);
    }
    expect(groupedEvents.filter((event) => event === 'use')).toHaveLength(21);
    expect(singleEvents.filter((event) => event === 'use')).toHaveLength(1);
    const withoutUse = (events: string[]) => events.filter((event) => event !== 'use');
    expect(withoutUse(singleEvents)).toEqual(withoutUse(groupedEvents));
  }, 60_000);

  it('isolates community errors the same way and still builds the same editor', async () => {
    const entries = withEntries(
      community('broken-factory', 5, () => { throw new Error('factory'); }),
      community('broken-setup', 105, () => [(() => { throw new Error('setup'); }) as unknown as MilkdownPlugin]),
      community('broken-run', 205, () => (() => async () => { throw new Error('run'); }) as unknown as MilkdownPlugin),
    );
    const grouped = await build(perEntry, defaultPluginOptions, entries);
    const single = await build(singleUse, defaultPluginOptions, entries);
    expect(grouped.errors).toEqual(['broken-factory: factory', 'broken-setup: setup', 'broken-run: run']);
    expect(single.errors).toEqual(grouped.errors);
    expect(grouped.uses).toHaveLength(23);
    expect(single.uses).toEqual([56]);
    expect(snapshot(single.crepe)).toEqual(snapshot(grouped.crepe));
  }, 60_000);

  it('aborts on an official factory error before registering anything, either way', () => {
    const failing: SlotEntry<EditorExtensionContribution> = {
      id: 'editor:failing', order: 105, owner: 'dstu.ui.editor', origin: 'builtin',
      value: { create: () => { throw new Error('official'); } },
    };
    for (const assemble of [perEntry, singleUse]) {
      const root = document.createElement('div');
      roots.push(root);
      const crepe = new Crepe({ root, defaultValue: '' });
      editors.push(crepe);
      const uses: unknown[] = [];
      const register = crepe.editor.use;
      (crepe.editor as { use: typeof register }).use = (plugins) => { uses.push(plugins); return register(plugins); };
      expect(() => assemble(crepe, defaultPluginOptions, withEntries(failing), () => {})).toThrow('official');
      expect(uses).toEqual([]);
    }
  });
});
