/**
 * FE-B5 host wiring of the two editor menu slots:
 * - `editor.selectionToolbar`: the bubble toolbar is built once per editor instance from the official entries plus the
 *   community slot, ordered by `order` (a community entry at 15 lands between the command wiring at 10 and the host
 *   actions at 20); unload drops it for later editors; a throwing entry is reported and the official groups stay.
 * - `editor.blockMenu`: the desktop handle menu and the programmatic mobile menu append community rows after the
 *   official ones, run them after closing and refocusing the editor, ignore a stale target, and report a throwing or
 *   rejecting row against its plugin; a throwing `rows()` only drops that entry.
 */
import React, { createRef } from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { EditorState, TextSelection } from '@milkdown/prose/state';
import { EditorView as ProseView } from '@milkdown/prose/view';
import { history } from '@milkdown/prose/history';
import type { EditorBlockMenuRow, EditorBlockMenuTarget, SelectionToolbarBuilder } from '@/ui-sdk';
import type { CrepeEditorApi, CrepeSelectionAction } from '../types';
import { bullet, doc, item, p, textPos, wrap } from './blockCommandFixtures';

const original = doc(wrap('callout', bullet(item(p('first')), item(p('target')), item(p('last')))), p('outside'));
const instances: Array<{ options: Record<string, any>; view: ProseView; handle: HTMLElement }> = [];

const HOST_ACTIONS: CrepeSelectionAction[] = [
  {
    key: 'add-to-chat',
    label: '引用到聊天',
    icon: '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>',
    run: () => undefined,
  },
];

vi.mock('@milkdown/crepe', () => ({
  CrepeFeature: new Proxy({}, { get: (_, key) => key }),
  Crepe: class {
    view!: ProseView;
    readonly = false;
    ctx = { get: () => this.view, update: vi.fn() };
    editor = {
      ctx: this.ctx,
      action: (fn: (ctx: unknown) => unknown) => fn(this.ctx),
      config: (fn: (ctx: unknown) => void) => { fn(this.ctx); return this.editor; },
      use: () => this.editor,
    };
    constructor(private options: Record<string, any>) {}
    async create() {
      this.view = new ProseView(this.options.root, {
        state: EditorState.create({
          doc: original,
          plugins: [history()],
          selection: TextSelection.create(original, textPos(original, 'target')),
        }),
        dispatchTransaction: (tr) => this.view.updateState(this.view.state.apply(tr)),
        handleScrollToSelection: () => true,
      });
      this.view.coordsAtPos = () => ({ left: 30, right: 30, top: 60, bottom: 80 });
      const handle = document.createElement('div');
      handle.className = 'milkdown-block-handle';
      for (let i = 0; i < 2; i += 1) {
        const operation = document.createElement('div');
        operation.className = 'operation-item';
        handle.appendChild(operation);
      }
      this.options.root.appendChild(handle);
      instances.push({ options: this.options, view: this.view, handle });
    }
    getMarkdown() { return this.view.state.doc.textContent; }
    setReadonly(value: boolean) { this.readonly = value; this.view?.setProps({ editable: () => !value }); }
    async destroy() { if (this.view && !this.view.isDestroyed) this.view.destroy(); }
  },
}));
vi.mock('@/components/crepe/plugins', () => ({ applyCrepePlugins: vi.fn() }));
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
import { CrepeEditor } from '../CrepeEditor';
import { openCrepeBlockCommandMenu } from '../blockCommandMenu';

let kernel: UiKernel;
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = this.classList.contains('milkdown-block-handle') ? 60 : this.textContent === 'target' ? 60 : 200;
    return { x: 30, y: top, left: 30, top, right: 330, bottom: top + 30, width: 300, height: 30, toJSON() {} };
  });
  vi.stubGlobal('PointerEvent', MouseEvent);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
});
afterEach(async () => {
  fireEvent.keyDown(document, { key: 'Escape' });
  cleanup();
  instances.splice(0).forEach(({ view }) => { if (!view.isDestroyed) view.destroy(); });
  document.body.replaceChildren();
  await kernel?.dispose();
  kernel = undefined as unknown as UiKernel;
  vi.unstubAllGlobals();
});
afterAll(() => { vi.restoreAllMocks(); });

async function boot() {
  kernel = new UiKernel(memoryRegistryAdapters());
  await installOfficialUiPlugins(kernel);
  return kernel;
}

async function install(plugin: UiPlugin<any>) {
  await act(async () => { await kernel.install(plugin); });
}
async function unload(id: string) {
  await act(async () => { await kernel.unload(id); });
}

async function mount(actions?: CrepeSelectionAction[]) {
  const ref = createRef<CrepeEditorApi>();
  const ready = vi.fn();
  render(
    <UiKernelProvider kernel={kernel}>
      <CrepeEditor ref={ref} noteId="note-a" selectionActions={actions} onReady={ready} />
    </UiKernelProvider>,
  );
  await waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
  return { ref: ref.current!, ...instances.at(-1)! };
}

/** Crepe 7.22 `getGroups`: built-in formatting / function groups, then `buildToolbar(builder)`. */
class GroupBuilder {
  private groups: Array<{ key: string; label: string; items: Array<Record<string, any>> }> = [];
  private handle(group: { items: Array<Record<string, any>> }) {
    const self = {
      addItem: (key: string, item: Record<string, any>) => { group.items.push({ ...item, key }); return self; },
      clear: () => { group.items = []; return self; },
    };
    return self;
  }
  addGroup = (key: string, label: string) => {
    const group = { key, label, items: [] as Array<Record<string, any>> };
    this.groups.push(group);
    return this.handle(group);
  };
  getGroup = (key: string) => {
    const group = this.groups.find((entry) => entry.key === key);
    if (!group) throw new Error(`Group with key ${key} not found`);
    return this.handle(group);
  };
  build = () => this.groups;
}

function toolbarGroups(options: Record<string, any>) {
  const builder = new GroupBuilder();
  for (const [key, keys] of [['formatting', ['bold', 'italic']], ['function', ['code', 'link']]] as const) {
    const group = builder.addGroup(key, key);
    for (const item of keys) group.addItem(item, { label: item, icon: `builtin:${item}`, active: () => false });
  }
  options.featureConfigs.Toolbar.buildToolbar(builder);
  return builder.build().map((group) => ({ key: group.key, items: group.items.map((item) => item.key) }));
}

async function openDesktopMenu(handle: HTMLElement) {
  const operation = handle.children[1];
  await act(async () => {
    fireEvent.pointerDown(operation, { clientX: 10, clientY: 75, button: 0 });
    fireEvent.pointerUp(operation, { clientX: 10, clientY: 75, button: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return document.querySelector<HTMLElement>('[role="menu"].crepe-block-menu');
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const desktopRows = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menu"].crepe-block-menu button'));

it('RF-W18-block-menu-contributions B1: End/Enter never executes a disabled community row', async () => {
  await boot();
  const run = vi.fn();
  await install(defineUiPlugin({ meta: { id: 'example.disabled' }, apply(ctx) {
    ctx.ui.contribute('editor.blockMenu', { id: 'disabled', order: 100, value: {
      rows: () => [{ id: 'disabled', label: 'Disabled', disabled: true, run }],
    } });
  } }));
  const { handle } = await mount();
  await openDesktopMenu(handle);
  fireEvent.keyDown(window, { key: 'End' });
  fireEvent.keyDown(window, { key: 'Enter' });
  expect(run).not.toHaveBeenCalled();
});

it.each(['desktop', 'mobile'] as const)('RF-W18-block-menu-contributions B3: an already open %s menu cannot run an unloaded entry', async (surface) => {
  await boot();
  const run = vi.fn();
  await install(defineUiPlugin({ meta: { id: 'example.unload-open' }, apply(ctx) {
    ctx.ui.contribute('editor.blockMenu', { id: 'old', order: 100, value: {
      rows: () => [{ id: 'old', label: 'Old', run }],
    } });
  } }));
  const { handle, view } = await mount();
  if (surface === 'desktop') await openDesktopMenu(handle);
  else await act(async () => { openCrepeBlockCommandMenu(view, true); await new Promise(resolve => setTimeout(resolve, 25)); });
  const button = document.querySelector<HTMLButtonElement>('.crepe-block-menu [data-command="old"]')!;
  expect(button).toBeTruthy();
  await unload('example.unload-open');
  fireEvent.click(button);
  expect(run).not.toHaveBeenCalled();
});

it('RF-W18-selection-toolbar-contributions B2: toolbar callbacks are attributed and a partial failed build leaves no output or mutation', async () => {
  const k = await boot();
  const { buildEditorSelectionToolbar } = await import('@/ui-plugins/official/editor/editorSlots');
  const builder = new GroupBuilder();
  const officialRun = vi.fn();
  builder.addGroup('formatting', 'Formatting').addItem('bold', { label: 'Bold', icon: '', onRun: officialRun });
  const report = vi.fn();
  buildEditorSelectionToolbar([
    { id: 'partial', owner: 'example.partial', origin: 'community', order: 1, value: { build(toolbar) {
      toolbar.build()[0].items[0].onRun = () => { throw new Error('changed'); };
      toolbar.getGroup('formatting').addItem('leaked', { label: 'Leaked', icon: '' });
      toolbar.addGroup('leaked-group', 'Leaked');
      throw new Error('partial');
    } } },
    { id: 'callbacks', owner: 'example.callbacks', origin: 'community', order: 2, value: { build(toolbar) {
      toolbar.getGroup('formatting').addItem('throws', { label: 'Throws', icon: '',
        onRun: () => { throw new Error('click'); }, active: () => { throw new Error('active'); } });
    } } },
  ], builder, { options: {} }, report);
  const groups = builder.build();
  expect(groups.map(group => group.key)).toEqual(['formatting']);
  expect(groups[0].items.map(item => item.key)).toEqual(['bold', 'throws']);
  expect(groups[0].items[0].onRun).toBe(officialRun);
  const item = groups[0].items[1];
  expect(() => item.onRun({})).not.toThrow();
  expect(item.active({})).toBe(false);
  expect(report.mock.calls.map(([entry]) => entry.id)).toEqual(['partial', 'callbacks', 'callbacks']);
  void k;
});

it('RF-W18-selection-toolbar-contributions B2: successful builds isolate click, async rejection and active callbacks with plugin attribution', async () => {
  const { buildEditorSelectionToolbar } = await import('@/ui-plugins/official/editor/editorSlots');
  const builder = new GroupBuilder();
  const report = vi.fn();
  buildEditorSelectionToolbar([{ id: 'callbacks', owner: 'example.callbacks', origin: 'community', order: 1,
    value: { build(toolbar) {
      const group = toolbar.addGroup('community', 'Community');
      group.addItem('sync', { label: 'Sync', icon: '', onRun() { throw new Error('sync'); },
        active() { throw new Error('active'); } });
      group.addItem('async', { label: 'Async', icon: '', onRun: () => Promise.reject(new Error('async')) });
    } },
  }], builder, { options: {} }, report);
  const [sync, asyncItem] = builder.build()[0].items;
  expect(() => sync.onRun({})).not.toThrow();
  expect(sync.active({})).toBe(false);
  asyncItem.onRun({});
  await Promise.resolve();
  expect(report).toHaveBeenCalledTimes(3);
  expect(report.mock.calls.every(([entry]) => entry.owner === 'example.callbacks' && entry.id === 'callbacks')).toBe(true);
});

it.each(['desktop', 'mobile'] as const)('RF-W18-block-menu-contributions B4: %s merges official segments with community order 15/35', async (surface) => {
  await boot();
  await install(defineUiPlugin({ meta: { id: 'example.segments' }, apply(ctx) {
    for (const order of [15, 35]) ctx.ui.contribute('editor.blockMenu', { id: `at-${order}`, order, value: {
      rows: () => [{ id: `at-${order}`, label: `At ${order}`, run() {} }],
    } });
  } }));
  const { handle, view } = await mount();
  if (surface === 'desktop') await openDesktopMenu(handle);
  else await act(async () => { openCrepeBlockCommandMenu(view, false); await new Promise(resolve => setTimeout(resolve, 25)); });
  const ids = Array.from(document.querySelectorAll<HTMLButtonElement>('.crepe-block-menu button'), b => b.dataset.command ?? b.dataset.blockCommand);
  expect(ids.indexOf('at-15')).toBeLessThan(ids.indexOf('paragraph'));
  expect(ids.indexOf('at-35')).toBeGreaterThan(ids.indexOf('toggle'));
  const layout = ids.indexOf('unwrap-columns');
  expect(layout).toBeGreaterThan(ids.indexOf('at-35'));
});

// ---- editor.selectionToolbar ----

it('merges community selection-toolbar entries by order and drops them on unload', async () => {
  const k = await boot();
  await install(defineUiPlugin({ meta: { id: 'example.toolbar' }, apply(ctx) {
    ctx.ui.contribute('editor.selectionToolbar', { id: 'stamp', order: 15, value: { build: (toolbar: SelectionToolbarBuilder) => {
      toolbar.addGroup('community', 'Community').addItem('stamp', { label: 'Stamp', icon: '<svg/>' });
    } } });
  } }));

  const first = await mount(HOST_ACTIONS);
  expect(toolbarGroups(first.options)).toEqual([
    { key: 'formatting', items: ['bold', 'italic'] },
    { key: 'function', items: ['code', 'link'] },
    { key: 'community', items: ['stamp'] },
    { key: 'host-actions', items: ['add-to-chat'] },
  ]);

  await unload('example.toolbar');
  cleanup();
  const second = await mount(HOST_ACTIONS);
  expect(toolbarGroups(second.options).map((group) => group.key)).toEqual(['formatting', 'function', 'host-actions']);
});

it('reports a throwing selection-toolbar entry and keeps the official groups', async () => {
  const k = await boot();
  await install(defineUiPlugin({ meta: { id: 'example.broken-toolbar' }, apply(ctx) {
    ctx.ui.contribute('editor.selectionToolbar', { id: 'broken', order: 15, value: { build: () => { throw new Error('toolbar'); } } });
  } }));
  const { options } = await mount(HOST_ACTIONS);
  expect(toolbarGroups(options).map((group) => group.key)).toEqual(['formatting', 'function', 'host-actions']);
  expect(k.errors.list('example.broken-toolbar')[0]).toMatchObject({
    slot: 'editor.selectionToolbar', entryId: 'broken', phase: 'render',
  });
});

// ---- editor.blockMenu: desktop handle menu ----

it('RF-W18-block-menu-contributions: appends community block-menu rows after the official rows, runs them after refocusing, and ignores stale targets', async () => {
  const k = await boot();
  const runs: Array<{ focused: boolean; surface?: string }> = [];
  const targets: Array<{ surface: string; nodeTypes: string[]; editable: boolean }> = [];
  await install(defineUiPlugin({ meta: { id: 'example.block-menu' }, apply(ctx) {
    ctx.ui.contribute('editor.blockMenu', { id: 'stamp', order: 100, value: { rows: (target: EditorBlockMenuTarget): EditorBlockMenuRow[] => {
      targets.push(target);
      return [{ id: 'stamp', label: 'Stamp block', run: (view: ProseView) => {
        runs.push({ focused: document.activeElement === view.dom, surface: target.surface });
      } }];
    } } });
  } }));

  const { view, handle } = await mount();
  const menu = await openDesktopMenu(handle);
  expect(menu).toBeTruthy();
  const community = desktopRows().find((button) => button.dataset.command === 'stamp')!;
  expect(community).toBeTruthy();
  expect(community.textContent).toBe('Stamp block');
  expect(community.previousElementSibling?.classList.contains('crepe-block-menu__separator')).toBe(true);
  expect(desktopRows().at(-1)).toBe(community);
  expect(targets[0]).toMatchObject({ surface: 'desktop-handle', editable: true });
  expect(targets[0].nodeTypes).toEqual(expect.arrayContaining(['list_item', 'bullet_list']));

  expect(community.isConnected).toBe(true);
  expect(community.disabled).toBe(false);
  fireEvent.click(community);
  await flush();
  expect(document.querySelector('[role="menu"].crepe-block-menu')).toBeNull();
  expect(runs).toEqual([{ focused: true, surface: 'desktop-handle' }]);

  const reopened = await openDesktopMenu(handle);
  expect(reopened).toBeTruthy();
  act(() => { view.dispatch(view.state.tr.insertText('x', textPos(view.state.doc, 'target'))); });
  await flush();
  expect(document.querySelector('[role="menu"].crepe-block-menu')).toBeNull();
  expect(runs).toHaveLength(1);
  void k;
});

it('reports a throwing or rejecting desktop row against its plugin, and a throwing rows() drops only that entry', async () => {
  const k = await boot();
  await install(defineUiPlugin({ meta: { id: 'example.failing-rows' }, apply(ctx) {
    ctx.ui.contribute('editor.blockMenu', { id: 'throws', order: 10, value: {
      rows: () => { throw new Error('rows'); },
    } });
  } }));
  await install(defineUiPlugin({ meta: { id: 'example.failing-run' }, apply(ctx) {
    ctx.ui.contribute('editor.blockMenu', { id: 'rows', order: 20, value: { rows: (): EditorBlockMenuRow[] => [
      { id: 'throws', label: 'Throws', run: () => { throw new Error('run'); } },
      { id: 'rejects', label: 'Rejects', run: () => Promise.reject(new Error('rejected')) },
    ] } });
  } }));

  const { handle } = await mount();
  expect(await openDesktopMenu(handle)).toBeTruthy();
  expect(k.errors.list('example.failing-rows')[0]).toMatchObject({
    slot: 'editor.blockMenu', entryId: 'throws', phase: 'report',
  });
  fireEvent.click(desktopRows().find((button) => button.dataset.command === 'throws')!);
  await flush();
  expect(k.errors.list('example.failing-run')[0]).toMatchObject({
    slot: 'editor.blockMenu', entryId: 'rows', phase: 'report',
  });

  expect(await openDesktopMenu(handle)).toBeTruthy();
  fireEvent.click(desktopRows().find((button) => button.dataset.command === 'rejects')!);
  await flush();
  expect(k.errors.list('example.failing-run')).toHaveLength(2);
  expect(k.errors.list('example.failing-run')[1]).toMatchObject({ entryId: 'rows', phase: 'report' });
});

// ---- editor.blockMenu: programmatic mobile menu ----

it('appends the same community rows to the mobile menu and drops them when the plugin unloads', async () => {
  const k = await boot();
  const surfaces: string[] = [];
  await install(defineUiPlugin({ meta: { id: 'example.mobile-menu' }, apply(ctx) {
    ctx.ui.contribute('editor.blockMenu', { id: 'stamp', order: 100, value: { rows: (target: EditorBlockMenuTarget): EditorBlockMenuRow[] => {
      surfaces.push(target.surface);
      return [{ id: 'stamp', label: 'Stamp block', run: () => undefined }];
    } } });
  } }));

  const { view } = await mount();
  await act(async () => { openCrepeBlockCommandMenu(view, true); await new Promise((resolve) => setTimeout(resolve, 25)); });
  const menu = document.querySelector<HTMLElement>('.crepe-block-menu')!;
  const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('button'));
  expect(buttons.at(-1)?.dataset.command).toBe('stamp');
  expect(surfaces).toEqual(['mobile-block']);
  fireEvent.keyDown(document, { key: 'Escape' });

  await unload('example.mobile-menu');
  await act(async () => { openCrepeBlockCommandMenu(view, true); await new Promise((resolve) => setTimeout(resolve, 25)); });
  const after = document.querySelector<HTMLElement>('.crepe-block-menu')!;
  expect(Array.from(after.querySelectorAll<HTMLButtonElement>('button')).some((button) => button.dataset.command === 'stamp')).toBe(false);
  fireEvent.keyDown(document, { key: 'Escape' });
  void k;
});

it('reports a mobile row error against its plugin and still opens with the official rows', async () => {
  const k = await boot();
  await install(defineUiPlugin({ meta: { id: 'example.mobile-errors' }, apply(ctx) {
    ctx.ui.contribute('editor.blockMenu', { id: 'row', order: 20, value: { rows: (): EditorBlockMenuRow[] => [
      { id: 'throws', label: 'Throws', run: () => { throw new Error('mobile'); } },
    ] } });
  } }));

  const { view } = await mount();
  await act(async () => { openCrepeBlockCommandMenu(view, true); await new Promise((resolve) => setTimeout(resolve, 25)); });
  expect(document.querySelectorAll('.crepe-block-menu button').length).toBeGreaterThan(1);
  fireEvent.click(document.querySelector('.crepe-block-menu [data-command="throws"]')!);
  await flush();
  expect(k.errors.list('example.mobile-errors')[0]).toMatchObject({
    slot: 'editor.blockMenu', entryId: 'row', phase: 'report',
  });
});
