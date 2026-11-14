/**
 * FE-B9 evidence before `editor.selectionToolbar` exists: the bubble toolbar `CrepeEditor` hands to Crepe.
 *
 * Crepe builds its toolbar once per editor instance (`featureConfigs[Toolbar].buildToolbar`), so this records the
 * builder contract rather than the rendered buttons (the real rendered toolbar is `editor.<variant>.toolbar.dom.txt`
 * in the W16 evidence). For each variant:
 * - `configKeys`: the toolbar config keys the host sets;
 * - `groups`: group keys and labels, item keys, labels, icon hashes, `active` presence and what each item's `onRun`
 *   does — a Crepe built-in left alone (`builtin`), a rewritten editor command (`executeCrepeCommand` id + options), or
 *   a host action receiving the selected text;
 *
 * Covered: no host actions and two host actions, zh-CN and en-US (the 「更多」 group label), without and with a UI
 * kernel holding the official plugins. Captured before the migration; the golden is never rewritten.
 */
import React, { createRef } from 'react';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { EditorState, TextSelection } from '@milkdown/prose/state';
import { EditorView as ProseView } from '@milkdown/prose/view';
import { editorViewCtx } from '@milkdown/kit/core';
import type { CrepeEditorApi, CrepeSelectionAction } from '../types';
import { doc, p, textPos } from './blockCommandFixtures';

const GOLDEN = 'src/components/crepe/__tests__/__golden__/selection-toolbar.json';
const capture = process.env.W18_CAPTURE_GOLDEN === '1';

const recorded = vi.hoisted(() => ({
  instances: [] as Array<{ options: Record<string, any>; instance?: { view?: ProseView } }>,
  executed: [] as Array<{ id: string; options: unknown }>,
  hostCalls: [] as string[],
}));

vi.mock('@milkdown/crepe', () => ({
  CrepeFeature: new Proxy({}, { get: (_, key) => key }),
  Crepe: class {
    view!: ProseView;
    ctx = { get: () => this.view, update: () => {} };
    editor = {
      ctx: this.ctx,
      action: (fn: (ctx: unknown) => unknown) => fn(this.ctx),
      config: (fn: (ctx: unknown) => void) => { fn(this.ctx); return this.editor; },
      use: () => this.editor,
    };
    constructor(private options: { root: HTMLElement } & Record<string, any>) {
      recorded.instances.push({ options, instance: this });
    }
    async create() {
      const content = doc(p('target'));
      this.view = new ProseView(this.options.root, {
        state: EditorState.create({
          doc: content,
          selection: TextSelection.create(content, textPos(content, 'target'), textPos(content, 'target') + 'target'.length),
        }),
        dispatchTransaction: (tr) => this.view.updateState(this.view.state.apply(tr)),
      });
    }
    getMarkdown() { return this.view.state.doc.textContent; }
    setReadonly() {}
    async destroy() { if (this.view && !this.view.isDestroyed) this.view.destroy(); }
  },
}));
vi.mock('../commandRegistry', async (load) => ({
  ...(await load<object>()),
  executeCrepeCommand: (view: unknown, id: string, options: unknown) => {
    recorded.executed.push({ id, options: options ?? null });
    return Promise.resolve(true);
  },
}));
vi.mock('../features/imageUpload', () => ({
  createImageBlockConfig: () => ({}), createImageUploader: () => vi.fn(),
  createTransientBlobUrlRegistry: () => ({ register: vi.fn(), releaseAll: vi.fn() }),
  pickImageWithTauriDialog: vi.fn(), readLocalImageFile: vi.fn(), validateImageFile: vi.fn(),
}));
vi.mock('../features/mermaidPreview', () => ({ createMermaidObserver: vi.fn() }));
vi.mock('../useCrepeEditor', () => ({ createAgentInsertTransaction: vi.fn() }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/shared/debug/channels/crepeEditor', () => ({ emitCrepeDebug: vi.fn(), captureDOMSnapshot: vi.fn() }));
vi.mock('@/shared/debug/channels/crepeImageUpload', () => ({
  emitImageUploadDebug: vi.fn(), captureDOMInfo: vi.fn(), captureImageBlockSnapshot: vi.fn(),
}));
vi.mock('@/debug-panel/events/NotesOutlineDebugChannel', () => ({
  emitOutlineDebugLog: vi.fn(), emitOutlineDebugSnapshot: vi.fn(),
}));
vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugMasterSwitch: { isEnabled: () => false },
  debugLog: { log: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import i18n from '@/i18n';
import { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import { installOfficialUiPlugins } from '@/ui-plugins/official/install';
import { memoryRegistryAdapters } from '@/ui-plugins/testing/registries';
import { CrepeEditor } from '../CrepeEditor';

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

const HOST_ACTIONS: CrepeSelectionAction[] = [
  {
    key: 'add-to-chat',
    label: '引用到聊天',
    icon: '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>',
    run: (text) => { recorded.hostCalls.push(`add-to-chat:${text}`); },
  },
  {
    key: 'make-cards',
    label: '制卡',
    icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>',
    run: (text) => { recorded.hostCalls.push(`make-cards:${text}`); },
  },
];

const BUILTIN_ONRUN = Symbol('builtin');
const hash = (text: unknown) => (typeof text === 'string' ? createHash('sha256').update(text).digest('hex').slice(0, 16) : typeof text);

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

/** Crepe 7.22 `getGroups`: formatting (bold / italic / strikethrough), function (code / latex / link), then buildToolbar. */
function buildToolbar(config: Record<string, any>, view: ProseView) {
  const builder = new GroupBuilder();
  const add = (group: string, label: string, keys: string[]) => {
    const handle = builder.addGroup(group, label);
    for (const key of keys) handle.addItem(key, { label: key, icon: `builtin:${key}`, active: () => false, onRun: BUILTIN_ONRUN });
  };
  add('formatting', 'Formatting', ['bold', 'italic', 'strikethrough']);
  add('function', 'Function', ['code', 'latex', 'link']);
  recorded.hostCalls = [];
  config.buildToolbar(builder);
  const ctx = { get: (slice: unknown) => (slice === editorViewCtx ? view : undefined) };
  const groups = builder.build().map((group) => ({
    key: group.key,
    label: group.label,
    items: group.items.map((item) => {
      const run = (() => {
        if (item.onRun === BUILTIN_ONRUN) return 'builtin';
        if (typeof item.onRun !== 'function') return typeof item.onRun;
        recorded.executed = [];
        recorded.hostCalls = [];
        item.onRun(ctx);
        if (recorded.executed.length) return recorded.executed.map((call) => ({ command: call.id, options: call.options }));
        if (recorded.hostCalls.length) return recorded.hostCalls.map((text) => ({ hostText: text }));
        return 'other';
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
  return { configKeys: Object.keys(config).sort(), groups };
}

async function mount(actions: CrepeSelectionAction[] | undefined, withKernel: boolean) {
  const ref = createRef<CrepeEditorApi>();
  const ready = vi.fn();
  const editor = <CrepeEditor ref={ref} noteId="note-a" selectionActions={actions} onReady={ready} />;
  const view = render(withKernel ? <UiKernelProvider kernel={kernel}>{editor}</UiKernelProvider> : editor);
  await waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
  return view;
}

async function recordSurface(actions: CrepeSelectionAction[] | undefined, withKernel: boolean) {
  const result: Record<string, unknown> = {};
  for (const language of ['zh-CN', 'en-US']) {
    await act(async () => { await i18n.changeLanguage(language); });
    recorded.instances = [];
    const view = await mount(actions, withKernel);
    const config = recorded.instances[0].options.featureConfigs.Toolbar;
    const editorView = recorded.instances[0].instance?.view;
    expect(editorView, 'fake Crepe created a ProseMirror view').toBeTruthy();
    result[language] = buildToolbar(config, editorView as ProseView);
    view.unmount();
  }
  await act(async () => { await i18n.changeLanguage('zh-CN'); });
  return result;
}

it('records the selection toolbar builder (no host actions, host actions; lightweight window and UI kernel)', async () => {
  const result: Record<string, unknown> = {};
  for (const withKernel of [false, true]) {
    const surface: Record<string, unknown> = {};
    for (const [variant, actions] of Object.entries({ 'no-host-actions': undefined, 'host-actions': HOST_ACTIONS })) {
      surface[variant] = await recordSurface(actions, withKernel);
    }
    result[withKernel ? 'kernel' : 'lightweight'] = surface;
  }
  cleanup();
  if (capture) {
    try {
      writeFileSync(GOLDEN, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    } catch (error) {
      throw new Error(`could not write ${GOLDEN}: ${String(error)}`);
    }
  }
  expect(result).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
}, 60_000);
