/**
 * FE-B5 evidence: the note editor's Milkdown assembly as `CrepeEditor` builds it (production component, real
 * Crepe, real `applyCrepePlugins`), for the notes editor (wikilink host config) and the plain template editor.
 * - `editor.<variant>.assembly.json`: Crepe constructor config, the ordered `editor.use` calls, and what the
 *   editor ends up with: schema nodes/marks, ProseMirror plugins in order (masked key + props), remark plugins,
 *   input rules, node/mark views, and which plugin handles each probed key.
 * - `editor.<variant>.slash-menu.dom.txt` / `editor.<variant>.toolbar.dom.txt`: the slash menu and selection
 *   toolbar as Crepe renders them.
 * After FE-B5 the extensions arrive through `editor.extensions` / `editor.slashMenu`; these must stay equal.
 */
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupMilkdownTimers } from '@/components/crepe/__tests__/milkdownTimers';
setupMilkdownTimers();
import { Editor, editorViewCtx, inputRulesCtx, markViewCtx, nodeViewCtx, remarkPluginsCtx, schemaCtx } from '@milkdown/kit/core';
import type { EditorView } from '@milkdown/prose/view';
import { TextSelection, type EditorState, type Plugin } from '@milkdown/prose/state';
import { getCtInvokeCalls, resetCtInvokeHandlers } from '../../../../../tests/ct/mocks/tauri-core-mock';
import { serializeDom } from '../../dom-snapshot';
import { bootAppUi, callShape, expectGolden, type AppUi } from './harness';

vi.mock('react-i18next', () => import('./i18nMock'));

interface RecordedCrepe {
  options: Record<string, unknown>;
  crepe: { editor: { ctx: { get<T>(slice: unknown): T } } };
}
const created: RecordedCrepe[] = [];

vi.mock('@milkdown/crepe', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@milkdown/crepe')>();
  class RecordingCrepe extends mod.Crepe {
    constructor(options: ConstructorParameters<typeof mod.Crepe>[0]) {
      super(options);
      created.push({ options: options as unknown as Record<string, unknown>, crepe: this as unknown as RecordedCrepe['crepe'] });
    }
  }
  return { ...mod, Crepe: RecordingCrepe };
});

const SAMPLE = [
  '# 特征值与特征向量',
  '',
  '设 **A** 为 n 阶方阵，若存在 *非零* 向量 `x` 使 Ax = λx。',
  '',
  '- 第一条',
  '- [ ] 待办',
  '',
  '> 引用',
  '',
  '```ts',
  'const x = 1;',
  '```',
  '',
  '[[线性代数]] 与 [链接](https://example.com)',
  '',
].join('\n');

/** Keys probed against the plugin chain; Mod is Ctrl in jsdom (non-mac platform). */
const KEY_PROBES: [string, KeyboardEventInit][] = [
  ['Enter', { key: 'Enter' }], ['Shift-Enter', { key: 'Enter', shiftKey: true }], ['Mod-Enter', { key: 'Enter', ctrlKey: true }],
  ['Backspace', { key: 'Backspace' }], ['Delete', { key: 'Delete' }], ['Tab', { key: 'Tab' }], ['Shift-Tab', { key: 'Tab', shiftKey: true }],
  ['Escape', { key: 'Escape' }], ['ArrowUp', { key: 'ArrowUp' }], ['ArrowDown', { key: 'ArrowDown' }],
  ['Shift-ArrowUp', { key: 'ArrowUp', shiftKey: true }], ['Shift-ArrowDown', { key: 'ArrowDown', shiftKey: true }],
  ['Mod-a', { key: 'a', ctrlKey: true }], ['Mod-b', { key: 'b', ctrlKey: true }], ['Mod-i', { key: 'i', ctrlKey: true }],
  ['Mod-e', { key: 'e', ctrlKey: true }], ['Mod-k', { key: 'k', ctrlKey: true }], ['Mod-d', { key: 'd', ctrlKey: true }],
  ['Mod-z', { key: 'z', ctrlKey: true }], ['Mod-Shift-z', { key: 'z', ctrlKey: true, shiftKey: true }], ['Mod-y', { key: 'y', ctrlKey: true }],
  ['Mod-Shift-x', { key: 'x', ctrlKey: true, shiftKey: true }], ['Mod-Alt-0', { key: '0', ctrlKey: true, altKey: true }],
  ['Mod-Alt-1', { key: '1', ctrlKey: true, altKey: true }], ['Mod-Alt-2', { key: '2', ctrlKey: true, altKey: true }],
  ['Mod-Alt-3', { key: '3', ctrlKey: true, altKey: true }], ['Mod-Alt-c', { key: 'c', ctrlKey: true, altKey: true }],
  ['Mod-Shift-7', { key: '7', ctrlKey: true, shiftKey: true }], ['Mod-Shift-8', { key: '8', ctrlKey: true, shiftKey: true }],
  ['Mod-[', { key: '[', ctrlKey: true }], ['Mod-]', { key: ']', ctrlKey: true }], ['Mod-/', { key: '/', ctrlKey: true }],
];

const maskKey = (key: string) => key.replace(/\$\d*$/, '$');

function describePlugin(plugin: Plugin): string {
  const spec = plugin.spec as { key?: unknown; props?: Record<string, unknown>; view?: unknown; state?: unknown; appendTransaction?: unknown; filterTransaction?: unknown };
  const props = Object.keys(spec.props ?? {}).sort();
  const hooks = ['state', 'view', 'appendTransaction', 'filterTransaction'].filter((hook) => (spec as Record<string, unknown>)[hook]);
  return `${maskKey((plugin as unknown as { key: string }).key)} props[${props.join(',')}] hooks[${hooks.join(',')}]`;
}

function describeEditorUse(plugin: unknown): string {
  const list = Array.isArray(plugin) ? plugin.flat(Infinity) : [plugin];
  const names = list.map((item) => {
    const meta = (item as { meta?: { displayName?: string; package?: string } }).meta;
    if (meta?.displayName) return `${meta.package ? `${meta.package}:` : ''}${meta.displayName}`;
    const name = (item as { name?: string }).name;
    return name && name !== 'anonymous' ? name : '·';
  });
  return `${list.length}× ${names.join(' ')}`;
}

function projectConfig(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'function') return 'ƒ';
  if (typeof value !== 'object') return value;
  if (typeof Node !== 'undefined' && value instanceof Node) return `<${(value as Element).tagName?.toLowerCase() ?? 'node'}>`;
  if (depth > 4) return '…';
  if (Array.isArray(value)) return value.map((item) => projectConfig(item, depth + 1));
  const proto = Object.getPrototypeOf(value);
  if (proto && proto !== Object.prototype) return `[${proto.constructor?.name ?? 'object'}]`;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, projectConfig((value as Record<string, unknown>)[key], depth + 1)]));
}

function keyMatrix(view: EditorView, baseline: EditorState): Record<string, string> {
  const result: Record<string, string> = {};
  const textStart = (() => {
    let pos = -1;
    baseline.doc.descendants((node, at) => { if (pos < 0 && node.isText && /方阵/.test(node.text ?? '')) pos = at + 2; });
    return pos;
  })();
  for (const [label, init] of KEY_PROBES) {
    view.updateState(baseline);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textStart)));
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    let handler = 'unhandled';
    view.state.plugins.some((plugin, index) => {
      const handle = (plugin.props as { handleKeyDown?: (v: EditorView, e: KeyboardEvent) => boolean }).handleKeyDown;
      if (handle && handle.call(plugin, view, event)) { handler = `#${index} ${maskKey((plugin as unknown as { key: string }).key)}`; return true; }
      return false;
    });
    result[label] = handler;
  }
  view.updateState(baseline);
  return result;
}

let app: AppUi;
const uses: string[] = [];
const realMake = Editor.make;

async function mountEditor(variant: 'notes' | 'plain') {
  created.length = 0;
  uses.length = 0;
  resetCtInvokeHandlers();
  const [{ CrepeEditor }, wikilink] = await Promise.all([
    import('@/components/crepe/CrepeEditor'),
    import('@/features/notes/wikilinkNotesCache'),
  ]);
  let ready = false;
  const view = render(app.wrap(
    variant === 'notes'
      ? <CrepeEditor noteId="note_evidence" defaultValue={SAMPLE} onReady={() => { ready = true; }} plugins={{ wikilink: wikilink.buildWikilinkPluginHostConfig() }} />
      : <CrepeEditor defaultValue={SAMPLE} onReady={() => { ready = true; }} />,
  ));
  const deadline = Date.now() + 30_000;
  while (!ready) {
    if (Date.now() > deadline) throw new Error(`${variant} editor never became ready`);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  }
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(created).toHaveLength(1);
  return { view, recorded: created[0]! };
}

describe('FE-B5 evidence: editor extensions', () => {
  beforeAll(async () => {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    // `use` is an instance property on Milkdown's Editor, so wrap it on every editor `Editor.make()` returns.
    Editor.make = function make() {
      const editor = realMake.call(Editor);
      const use = editor.use;
      editor.use = (plugins) => {
        uses.push(describeEditorUse(plugins));
        use.call(editor, plugins);
        return editor;
      };
      return editor;
    };
    app = await bootAppUi();
  });
  afterAll(async () => {
    Editor.make = realMake;
    await app.dispose();
  });

  for (const variant of ['notes', 'plain'] as const) {
    it(`assembles the ${variant} editor the same way`, async () => {
      const { view, recorded } = await mountEditor(variant);
      const ctx = recorded.crepe.editor.ctx;
      const editorView = ctx.get<EditorView>(editorViewCtx);
      const schema = ctx.get<{ spec: { nodes: { forEach(fn: (name: string) => void): void }; marks: { forEach(fn: (name: string) => void): void } } }>(schemaCtx);
      const nodes: string[] = []; schema.spec.nodes.forEach((name) => nodes.push(name));
      const marks: string[] = []; schema.spec.marks.forEach((name) => marks.push(name));
      const remark = ctx.get<{ plugin: { name?: string }; options: unknown }[]>(remarkPluginsCtx)
        .map(({ plugin, options }) => `${plugin?.name || '·'}${options && typeof options === 'object' && Object.keys(options).length ? `(${Object.keys(options).sort().join(',')})` : ''}`);
      const baseline = editorView.state;
      const assembly = {
        crepe: projectConfig({ features: recorded.options.features, featureConfigs: recorded.options.featureConfigs }),
        uses: [...uses],
        schema: { nodes, marks },
        prosePlugins: baseline.plugins.map(describePlugin),
        remark,
        inputRules: ctx.get<unknown[]>(inputRulesCtx).length,
        nodeViews: ctx.get<[string, unknown][]>(nodeViewCtx).map(([name]) => name),
        markViews: ctx.get<[string, unknown][]>(markViewCtx).map(([name]) => name),
        keys: keyMatrix(editorView, baseline),
        ipcOnMount: [...new Set(getCtInvokeCalls().map((call) => callShape(call.command, call.payload)))].sort(),
      };
      expectGolden(`editor.${variant}.assembly.json`, assembly);
      const slash = view.container.ownerDocument.querySelector('.milkdown-slash-menu');
      const toolbar = view.container.ownerDocument.querySelector('.milkdown-toolbar');
      expect(slash, 'slash menu mounted').not.toBeNull();
      expectGolden(`editor.${variant}.slash-menu.dom.txt`, serializeDom(slash!));
      expectGolden(`editor.${variant}.toolbar.dom.txt`, toolbar ? serializeDom(toolbar) : '(no toolbar element)');
      view.unmount();
      cleanup();
    }, 90_000);
  }
});
