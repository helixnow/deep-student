/**
 * FE-B5: CrepeEditor assembles `editor.extensions` / `editor.slashMenu` from the UI kernel. Community extensions land
 * at their order and are created once per editor instance; the slash menu follows the live slot; a throwing community
 * entry is reported to the plugin's error budget and the editor still opens.
 */
import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { MilkdownPlugin } from '@milkdown/ctx';
import type { Ctx } from '@milkdown/kit/ctx';
import { EditorState } from '@milkdown/prose/state';
import { EditorView as ProseView } from '@milkdown/prose/view';
import { doc, p } from './blockCommandFixtures';

const recorded = vi.hoisted(() => ({ instances: [] as Array<{ options: Record<string, any>; uses: unknown[] }> }));

vi.mock('@milkdown/crepe', () => ({
  CrepeFeature: new Proxy({}, { get: (_, key) => key }),
  Crepe: class {
    view!: ProseView;
    readonly = false;
    ctx = { get: () => this.view, update: () => {} };
    record: { options: Record<string, any>; uses: unknown[] };
    editor = {
      ctx: this.ctx,
      action: (fn: (ctx: unknown) => unknown) => fn(this.ctx),
      config: (fn: (ctx: unknown) => void) => { fn(this.ctx); return this.editor; },
      use: (plugin: unknown) => { this.record.uses.push(plugin); return this.editor; },
    };
    constructor(private options: { root: HTMLElement } & Record<string, any>) {
      this.record = { options, uses: [] };
      recorded.instances.push(this.record);
    }
    async create() {
      const state = EditorState.create({ doc: doc(p('fixture')) });
      this.view = new ProseView(this.options.root, { state, dispatchTransaction: (tr) => this.view.updateState(this.view.state.apply(tr)) });
    }
    getMarkdown() { return this.view.state.doc.textContent; }
    setReadonly(value: boolean) { this.readonly = value; }
    async destroy() { if (this.view && !this.view.isDestroyed) this.view.destroy(); }
  },
}));
vi.mock('../features/imageUpload', () => ({
  createImageBlockConfig: () => ({}), createImageUploader: () => vi.fn(),
  createTransientBlobUrlRegistry: () => ({ register: vi.fn(), releaseAll: vi.fn() }),
  pickImageWithTauriDialog: vi.fn(), validateImageFile: vi.fn(),
}));
vi.mock('../features/mermaidPreview', () => ({ createMermaidObserver: vi.fn() }));
vi.mock('../useCrepeEditor', () => ({ createAgentInsertTransaction: vi.fn() }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/shared/debug/channels/crepeEditor', () => ({ emitCrepeDebug: vi.fn(), captureDOMSnapshot: vi.fn() }));
vi.mock('@/shared/debug/channels/crepeImageUpload', () => ({
  emitImageUploadDebug: vi.fn(), captureDOMInfo: vi.fn(), captureImageBlockSnapshot: vi.fn(),
}));
vi.mock('@/debug-panel/events/NotesOutlineDebugChannel', () => ({ emitOutlineDebugLog: vi.fn(), emitOutlineDebugSnapshot: vi.fn() }));
vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugMasterSwitch: { isEnabled: () => false },
  debugLog: { log: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { defineUiPlugin, UiKernel, type UiPlugin } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import { installOfficialUiPlugins } from '@/ui-plugins/official/install';
import { memoryRegistryAdapters } from '@/ui-plugins/testing/registries';
import { resolveEditorExtensions, type EditorInstanceContext, type SlashMenuBuilder } from '@/ui-plugins/official/editor/editorSlots';
import { officialEditorExtensionEntries } from '../plugins';
import type { CrepePluginsOptions } from '../types';
import { CrepeEditor } from '../CrepeEditor';

let kernel: UiKernel | undefined;
beforeAll(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(300);
});
afterEach(async () => {
  cleanup();
  recorded.instances = [];
  await kernel?.dispose();
  kernel = undefined;
});
afterAll(() => {
  vi.restoreAllMocks();
});

async function boot() {
  kernel = new UiKernel(memoryRegistryAdapters());
  await installOfficialUiPlugins(kernel);
  return kernel;
}

async function install(k: UiKernel, plugin: UiPlugin<any>) {
  await act(async () => { await k.install(plugin); });
}

async function unload(k: UiKernel, id: string) {
  await act(async () => { await k.unload(id); });
}

async function mount(k: UiKernel, plugins?: CrepePluginsOptions) {
  const ready = vi.fn();
  render(<UiKernelProvider kernel={k}><CrepeEditor noteId="note-a" onReady={ready} plugins={plugins} /></UiKernelProvider>);
  await waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
  const record = recorded.instances[recorded.instances.length - 1];
  return { record, uses: record.uses.flat(Infinity) as MilkdownPlugin[] };
}

function marked(name: string, run: () => unknown = () => undefined): MilkdownPlugin {
  return Object.assign((() => async () => run()) as unknown as MilkdownPlugin, { pluginName: name });
}

const named = (name: string) => (plugin: MilkdownPlugin) => (plugin as { pluginName?: string }).pluginName === name;

const officialCount = (editor: EditorInstanceContext, below = Infinity) =>
  resolveEditorExtensions(officialEditorExtensionEntries.filter((entry) => entry.order < below), editor, vi.fn()).length;

/** Crepe 7.22 `getGroups`: built-in groups, then `config.buildMenu(builder)`. */
function slashMenuKeys(record: { options: Record<string, any> }) {
  const groups: { key: string; items: { key: string }[] }[] = [];
  const handle = (group: { items: { key: string }[] }) => {
    const self = {
      addItem: (key: string) => { group.items.push({ key }); return self; },
      clear: () => { group.items = []; return self; },
    };
    return self;
  };
  const menu: SlashMenuBuilder = {
    addGroup: (key) => { const group = { key, items: [] }; groups.push(group); return handle(group); },
    getGroup: (key) => {
      const group = groups.find((item) => item.key === key);
      if (!group) throw new Error(`Group with key ${key} not found`);
      return handle(group);
    },
    build: () => groups,
  };
  const builtin = (key: string, items: string[]) => {
    const group = menu.addGroup(key, key);
    for (const item of items) group.addItem(item, { label: item, icon: '' });
  };
  builtin('text', ['text', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'quote', 'divider']);
  builtin('list', ['bullet-list', 'ordered-list', 'task-list']);
  builtin('advanced', ['image', 'code', 'table', 'math']);
  record.options.featureConfigs.BlockEdit.buildMenu(menu);
  return groups.map((group) => [group.key, group.items.map((item) => item.key)]);
}

it('assembles a community extension at its order, once per editor instance, until its plugin unloads', async () => {
  const k = await boot();
  const create = vi.fn((_editor: EditorInstanceContext) => marked('community:stamp'));
  await install(k, defineUiPlugin({ meta: { id: 'example.editor' }, apply(ctx) {
    ctx.ui.contribute('editor.extensions', { id: 'stamp', order: 105, value: { create } });
  } }));

  const first = await mount(k, { automd: false });
  const second = await mount(k, { automd: false });
  expect(create).toHaveBeenCalledTimes(2);
  const editor = create.mock.calls[0][0];
  expect(editor.options).toMatchObject({ automd: false, columns: { canWrite: expect.any(Function) } });
  for (const { uses } of [first, second]) {
    expect(uses).toHaveLength(officialCount(editor) + 1);
    expect(uses.findIndex(named('community:stamp'))).toBe(officialCount(editor, 105));
  }
  expect(first.uses.find(named('community:stamp'))).not.toBe(second.uses.find(named('community:stamp')));

  await unload(k, 'example.editor');
  const third = await mount(k, { automd: false });
  expect(third.uses).toHaveLength(officialCount(editor));
  expect(third.uses.some(named('community:stamp'))).toBe(false);
});

it('builds the slash menu from the live slot, so open editors pick up community items and lose them on unload', async () => {
  const k = await boot();
  const { record } = await mount(k);
  const official = slashMenuKeys(record);
  expect(official.map(([key]) => key)).toEqual(expect.arrayContaining(['text', 'list', 'advanced']));

  await install(k, defineUiPlugin({ meta: { id: 'example.slash' }, apply(ctx) {
    ctx.ui.contribute('editor.slashMenu', { id: 'stamp', order: 30, value: { build: (menu) => {
      menu.getGroup('text').addItem('stamp', { label: 'Stamp', icon: '' });
      menu.addGroup('community', 'Community').addItem('note', { label: 'Note', icon: '' });
    } } });
  } }));
  const withCommunity = slashMenuKeys(record);
  expect(withCommunity).toEqual([
    ...official.map(([key, items]) => [key, key === 'text' ? [...items, 'stamp'] : items]),
    ['community', ['note']],
  ]);

  await unload(k, 'example.slash');
  expect(slashMenuKeys(record)).toEqual(official);
});

it('reports throwing community entries to their plugin and still opens the editor with the official stack', async () => {
  const k = await boot();
  const baseline = await mount(k);
  const officialMenu = slashMenuKeys(baseline.record);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  await install(k, defineUiPlugin({ meta: { id: 'example.broken-factory' }, apply(ctx) {
    ctx.ui.contribute('editor.extensions', { id: 'broken', order: 5, value: { create: () => { throw new Error('factory'); } } });
  } }));
  await install(k, defineUiPlugin({ meta: { id: 'example.broken-run' }, apply(ctx) {
    ctx.ui.contribute('editor.extensions', { id: 'throws', order: 205, value: { create: () => marked('community:throws', () => { throw new Error('run'); }) } });
  } }));
  await install(k, defineUiPlugin({ meta: { id: 'example.broken-slash' }, apply(ctx) {
    ctx.ui.contribute('editor.slashMenu', { id: 'broken', order: 5, value: { build: () => { throw new Error('slash'); } } });
  } }));

  const { record, uses } = await mount(k);
  const editor = { options: {} } as EditorInstanceContext;
  expect(uses).toHaveLength(officialCount(editor) + 1);
  expect(k.errors.list('example.broken-factory')[0]).toMatchObject({ slot: 'editor.extensions', entryId: 'broken', phase: 'render' });

  const throws = uses.find(named('community:throws'))!;
  await expect(throws({} as Ctx)()).resolves.toBeUndefined();
  expect(k.errors.list('example.broken-run')[0]).toMatchObject({ slot: 'editor.extensions', entryId: 'throws', phase: 'render' });

  expect(slashMenuKeys(record)).toEqual(officialMenu);
  expect(k.errors.list('example.broken-slash')[0]).toMatchObject({ slot: 'editor.slashMenu', entryId: 'broken', phase: 'render' });
  error.mockRestore();
});
