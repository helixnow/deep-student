/**
 * FE-B5 evidence: what CrepeEditor assembles for each editor instance.
 *
 * - `plugins`: the Milkdown plugins handed to `crepe.editor.use`, flattened in order, with the options each factory was
 *   called with, for the default options and every `plugins` prop variant; two instances per variant record that the
 *   factories run once per editor.
 * - `slashMenu`: the slash menu after `featureConfigs[BlockEdit].buildMenu` ran on a builder that already holds Crepe's
 *   built-in groups (same GroupBuilder semantics as @milkdown/crepe 7.22): groups, items, labels, icon hashes and the
 *   editor command each item runs, in zh-CN and en-US; plus the built-in group labels CrepeEditor configures.
 *
 * Every case is rendered without and with a UI kernel holding the official plugins. Captured before FE-B5; the golden
 * is never rewritten.
 */
import React, { createRef } from 'react';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { EditorState } from '@milkdown/prose/state';
import { EditorView as ProseView } from '@milkdown/prose/view';
import { doc, p } from './blockCommandFixtures';

const recorded = vi.hoisted(() => ({
  instances: [] as Array<{ options: Record<string, any>; uses: unknown[] }>,
  executed: [] as Array<{ id: string; options: unknown }>,
}));

const tagged = vi.hoisted(() => {
  const value = (name: string) => ({ __plugin: name });
  const factory = (name: string) => (...args: unknown[]) => ({ __plugin: name, args });
  return { value, factory };
});

vi.mock('@milkdown/plugin-automd', () => ({ automd: tagged.value('automd') }));
vi.mock('../plugins/searchHighlight', async (load) => ({ ...(await load<object>()), searchHighlightPlugin: tagged.value('searchHighlight') }));
vi.mock('../plugins/agentHighlight', async (load) => ({ ...(await load<object>()), agentHighlightPlugin: tagged.value('agentHighlight') }));
vi.mock('../plugins/pasteLink', async (load) => ({ ...(await load<object>()), pasteLinkPlugin: tagged.factory('pasteLink') }));
vi.mock('../plugins/callout', async (load) => ({ ...(await load<object>()), calloutPlugin: tagged.factory('callout') }));
vi.mock('../plugins/toggle', async (load) => ({ ...(await load<object>()), togglePlugin: tagged.factory('toggle') }));
vi.mock('../plugins/wikilink', async (load) => ({ ...(await load<object>()), wikilinkPlugin: tagged.factory('wikilink') }));
vi.mock('../plugins/mention', async (load) => ({ ...(await load<object>()), mentionPlugin: tagged.factory('mention') }));
vi.mock('../plugins/imageLightbox', async (load) => ({ ...(await load<object>()), imageLightboxPlugin: tagged.factory('imageLightbox') }));
vi.mock('../plugins/linkKeymap', async (load) => ({ ...(await load<object>()), linkKeymapPlugin: tagged.factory('linkKeymap') }));
vi.mock('../plugins/internalLinkSchemes', async (load) => ({ ...(await load<object>()), internalLinkSchema: tagged.value('internalLinkSchema') }));
vi.mock('../plugins/pdfRef', async (load) => ({ ...(await load<object>()), pdfRefPlugin: tagged.factory('pdfRef') }));
vi.mock('../plugins/mediaRef', async (load) => ({ ...(await load<object>()), mediaRefPlugin: tagged.factory('mediaRef') }));
vi.mock('../plugins/columns', async (load) => ({ ...(await load<object>()), columnsPlugin: tagged.factory('columns') }));
vi.mock('../plugins/blockIdentity', async (load) => ({ ...(await load<object>()), blockIdentityPlugin: tagged.factory('blockIdentity') }));
vi.mock('../plugins/blockSelection', async (load) => ({ ...(await load<object>()), blockSelectionPlugin: tagged.factory('blockSelection') }));
vi.mock('../plugins/typedPlaceholder', async (load) => ({ ...(await load<object>()), typedPlaceholderPlugin: tagged.factory('typedPlaceholder') }));
vi.mock('../plugins/listItemHasChecked', async (load) => ({ ...(await load<object>()), listItemHasCheckedPlugin: tagged.factory('listItemHasChecked') }));
vi.mock('../canonicalDocument', async (load) => ({ ...(await load<object>()), canonicalDocumentPlugin: tagged.value('canonicalDocument') }));
vi.mock('../commandRegistry', async (load) => ({
  ...(await load<object>()),
  crepeExecuteCommand: tagged.value('crepeExecuteCommand'),
  crepeCommandBindingsPlugin: tagged.value('crepeCommandBindings'),
  executeCrepeCommand: (_view: unknown, id: string, options: unknown) => {
    recorded.executed.push({ id, options: options ?? null });
    return Promise.resolve(true);
  },
}));

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

import i18n from '@/i18n';
import { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import { installOfficialUiPlugins } from '@/ui-plugins/official/install';
import { memoryRegistryAdapters } from '@/ui-plugins/testing/registries';
import { defaultWikilinkGetNotes } from '../plugins/wikilink/defaultGetNotes';
import type { CrepeEditorApi, CrepePluginsOptions } from '../types';
import { CrepeEditor } from '../CrepeEditor';

const GOLDEN = 'src/components/crepe/__tests__/__golden__/editor-assembly.json';

let kernel: UiKernel;
beforeAll(async () => {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(300);
  for (let i = 0; i < 200 && !(i18n.hasResourceBundle('zh-CN', 'notes') && i18n.hasResourceBundle('en-US', 'notes')); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  kernel = new UiKernel(memoryRegistryAdapters());
  await installOfficialUiPlugins(kernel);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await kernel.dispose();
  await act(async () => { await i18n.changeLanguage('zh-CN'); });
});

const getNotes = async () => [];
const resolveNote = () => true;
const searchNotes = async () => [];

const VARIANTS: Record<string, CrepePluginsOptions | undefined> = {
  default: undefined,
  'all-off': {
    automd: false, wikilink: false, mention: false, callout: false, toggle: false, pasteLink: false,
    imageLightbox: false, linkKeymap: false, pdfRefLink: false, mediaRefLink: false,
  },
  'all-on': {
    automd: true, wikilink: true, mention: true, callout: true, toggle: true, pasteLink: true,
    imageLightbox: true, linkKeymap: true, pdfRefLink: true, mediaRefLink: true,
  },
  'wikilink-config': { wikilink: { getNotes, resolve: resolveNote, maxSuggestions: 5 } },
  'wikilink-partial': { wikilink: { resolve: resolveNote } },
  'mention-config': { mention: { searchNotes, maxSuggestions: 3, debounceMs: 50 } },
  'columns-ignored': { columns: { canWrite: () => false } },
};

function describeValue(value: unknown): unknown {
  if (value === defaultWikilinkGetNotes) return 'defaultWikilinkGetNotes';
  if (value === getNotes) return 'host:getNotes';
  if (value === resolveNote) return 'host:resolve';
  if (value === searchNotes) return 'host:searchNotes';
  if (typeof value === 'function') return 'function';
  if (Array.isArray(value)) return value.map(describeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, describeValue(entry)]));
  }
  return value ?? null;
}

function describeUses(uses: unknown[]) {
  return uses.flat(Infinity).map((plugin) => {
    const tag = plugin as { __plugin?: string; args?: unknown[] };
    if (!tag?.__plugin) return { plugin: 'untagged' };
    return tag.args ? { plugin: tag.__plugin, args: describeValue(tag.args) } : { plugin: tag.__plugin };
  });
}

async function mount(props: { plugins?: CrepePluginsOptions }, withKernel: boolean) {
  const ref = createRef<CrepeEditorApi>();
  const ready = vi.fn();
  const editor = <CrepeEditor ref={ref} noteId="note-a" onReady={ready} {...props} />;
  const view = render(withKernel ? <UiKernelProvider kernel={kernel}>{editor}</UiKernelProvider> : editor);
  await waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
  return view;
}

class GroupBuilder {
  private groups: Array<{ key: string; label: string; items: Array<Record<string, any>> }> = [];
  private instance(group: { items: Array<Record<string, any>> }) {
    const handle = {
      group,
      addItem: (key: string, item: Record<string, any>) => { group.items.push({ ...item, key }); return handle; },
      clear: () => { group.items = []; return handle; },
    };
    return handle;
  }
  addGroup = (key: string, label: string) => {
    const group = { key, label, items: [] as Array<Record<string, any>> };
    this.groups.push(group);
    return this.instance(group);
  };
  getGroup = (key: string) => {
    const group = this.groups.find((entry) => entry.key === key);
    if (!group) throw new Error(`Group with key ${key} not found`);
    return this.instance(group);
  };
  build = () => this.groups;
  clear = () => { this.groups = []; return this; };
}

const BUILTIN_ONRUN = Symbol('builtin');
const hash = (text: unknown) => (typeof text === 'string' ? createHash('sha256').update(text).digest('hex').slice(0, 16) : typeof text);

/** Crepe 7.22 `getGroups`: built-in groups (all features enabled), then `config.buildMenu(builder)`. */
function buildSlashMenu(config: Record<string, any>) {
  const builder = new GroupBuilder();
  const builtin = (group: string, label: string, keys: string[]) => {
    const handle = builder.addGroup(group, config[`${group}Group`]?.label ?? label);
    for (const key of keys) handle.addItem(key, { label: key, icon: `builtin:${key}`, onRun: BUILTIN_ONRUN });
  };
  builtin('text', 'Text', ['text', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'quote', 'divider']);
  builtin('list', 'List', ['bullet-list', 'ordered-list', 'task-list']);
  builtin('advanced', 'Advanced', ['image', 'code', 'table', 'math']);
  config.buildMenu?.(builder);
  return builder.build().map((group) => ({
    key: group.key,
    label: group.label,
    items: group.items.map((item) => {
      const run = (() => {
        if (item.onRun === BUILTIN_ONRUN) return 'builtin';
        if (typeof item.onRun !== 'function') return typeof item.onRun;
        recorded.executed = [];
        item.onRun({ get: () => ({}) });
        return recorded.executed.length ? recorded.executed.map((call) => ({ command: call.id, options: call.options })) : 'other';
      })();
      return {
        key: item.key,
        label: typeof item.icon === 'string' && item.icon.startsWith('builtin:') ? null : item.label,
        icon: typeof item.icon === 'string' && item.icon.startsWith('builtin:') ? 'builtin' : hash(item.icon),
        ...(Object.keys(item).filter((key) => !['key', 'label', 'icon', 'onRun'].includes(key)).length
          ? { extra: Object.keys(item).filter((key) => !['key', 'label', 'icon', 'onRun'].includes(key)).sort() }
          : {}),
        run,
      };
    }),
  }));
}

function builtinGroupConfig(config: Record<string, any>) {
  const { buildMenu: _buildMenu, blockHandle, ...groups } = config;
  return { blockHandle: describeValue(blockHandle), groups: describeValue(groups) };
}

it('records the per-instance plugin assembly and the slash menu (lightweight window and UI kernel)', async () => {
  const result: Record<string, unknown> = {};
  for (const withKernel of [false, true]) {
    const plugins: Record<string, unknown> = {};
    for (const [variant, options] of Object.entries(VARIANTS)) {
      recorded.instances = [];
      const first = await mount({ plugins: options }, withKernel);
      const second = await mount({ plugins: options }, withKernel);
      const [a, b] = recorded.instances;
      plugins[variant] = { first: describeUses(a.uses), sameAsSecondInstance: JSON.stringify(describeUses(a.uses)) === JSON.stringify(describeUses(b.uses)) };
      first.unmount();
      second.unmount();
    }

    const slashMenu: Record<string, unknown> = {};
    for (const language of ['zh-CN', 'en-US']) {
      await act(async () => { await i18n.changeLanguage(language); });
      recorded.instances = [];
      const view = await mount({}, withKernel);
      const config = recorded.instances[0].options.featureConfigs.BlockEdit;
      slashMenu[language] = { config: builtinGroupConfig(config), groups: buildSlashMenu(config) };
      view.unmount();
    }
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    result[withKernel ? 'kernel' : 'lightweight'] = { plugins, slashMenu };
  }
  cleanup();
  if (process.env.FE_B5_CAPTURE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  expect(result).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
}, 60_000);
