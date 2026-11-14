/**
 * FE-B9 evidence before `editor.blockMenu` exists: the two block menus as they are today.
 * - desktop: the block handle menu of the real `CrepeEditor` host (`CrepeEditor.tsx` BLOCK_MENU_ACTIONS and its portal),
 *   for a nested list item and a top-level paragraph: DOM, keyboard, what each row does to the document, how it closes;
 * - mobile: `openCrepeBlockCommandMenu` on a real ProseMirror view with the real pinned SlashProvider, as the slash
 *   stand-in (`actions = false`) and as the block menu (`actions = true`).
 * Only the Crepe bootstrap is a stand-in (a ProseMirror view on the shared block-command schema), as in
 * `components/crepe/__tests__/CrepeEditor.blockMenu.host.test.tsx`.
 *
 * FE_B9_CAPTURE_GOLDEN=1 writes the golden once (never overwrites).
 */
import React, { createRef } from 'react';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node as ProseNode } from '@milkdown/prose/model';
import { EditorState, TextSelection, type Transaction } from '@milkdown/prose/state';
import { EditorView as ProseView } from '@milkdown/prose/view';
import { history } from '@milkdown/prose/history';
import type { CrepeEditorApi } from '@/components/crepe/types';
import { bullet, doc, item, p, textPos, wrap } from '@/components/crepe/__tests__/blockCommandFixtures';
import { handleAndroidBack } from '@/app/navigation/androidBackCoordinator';

const GOLDEN = 'src/ui-plugins/official/editor/__tests__/__golden__/block-menus.json';
const original = doc(wrap('callout', bullet(item(p('first')), item(p('target')), item(p('last')))), p('outside'));
const instances: Array<{ view: ProseView; handle: HTMLElement }> = [];
const notify = vi.hoisted(() => vi.fn());

vi.mock('@milkdown/crepe', () => ({
  CrepeFeature: new Proxy({}, { get: (_, key) => key }),
  Crepe: class {
    view!: ProseView;
    ctx = { get: () => this.view, update: vi.fn() };
    editor = { ctx: this.ctx, action: (fn: (ctx: unknown) => unknown) => fn(this.ctx),
      config: (fn: (ctx: unknown) => void) => { fn(this.ctx); return this.editor; } };
    constructor(private options: { root: HTMLElement }) {}
    async create() {
      this.view = new ProseView(this.options.root, {
        state: EditorState.create({ doc: original, plugins: [history()],
          selection: TextSelection.create(original, textPos(original, 'target')) }),
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
      instances.push({ view: this.view, handle });
    }
    getMarkdown() { return this.view.state.doc.textContent; }
    setReadonly(value: boolean) { this.view?.setProps({ editable: () => !value }); }
    async destroy() { if (this.view && !this.view.isDestroyed) this.view.destroy(); }
  },
}));
vi.mock('@/components/crepe/plugins', () => ({ applyCrepePlugins: vi.fn() }));
vi.mock('@/components/crepe/features/imageUpload', () => ({
  createImageBlockConfig: () => ({}), createImageUploader: () => vi.fn(),
  createTransientBlobUrlRegistry: () => ({ register: vi.fn(), releaseAll: vi.fn() }),
  pickImageWithTauriDialog: vi.fn(), validateImageFile: vi.fn(),
}));
vi.mock('@/components/crepe/features/mermaidPreview', () => ({ createMermaidObserver: vi.fn() }));
vi.mock('@/components/crepe/useCrepeEditor', () => ({ createAgentInsertTransaction: vi.fn() }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: notify }));
vi.mock('@/shared/debug/channels/crepeEditor', () => ({ emitCrepeDebug: vi.fn(), captureDOMSnapshot: vi.fn() }));
vi.mock('@/shared/debug/channels/crepeImageUpload', () => ({
  emitImageUploadDebug: vi.fn(), captureDOMInfo: vi.fn(), captureImageBlockSnapshot: vi.fn(),
}));
vi.mock('@/debug-panel/events/NotesOutlineDebugChannel', () => ({ emitOutlineDebugLog: vi.fn(), emitOutlineDebugSnapshot: vi.fn() }));
vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugMasterSwitch: { isEnabled: () => false },
  debugLog: { log: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { CrepeEditor } from '@/components/crepe/CrepeEditor';
import { openCrepeBlockCommandMenu } from '@/components/crepe/blockCommandMenu';

/** Which text the block handle sits next to; the stand-in layout puts each block 50px apart. */
let handleAt = 'target';
const TOPS: Record<string, number> = { first: 10, target: 60, last: 110, outside: 160 };
const rect = (top: number) => ({ x: 30, y: top, left: 30, top, right: 330, bottom: top + 30, width: 300, height: 30, toJSON() {} });

beforeEach(() => {
  handleAt = 'target';
  notify.mockClear();
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return rect(this.classList.contains('milkdown-block-handle') ? TOPS[handleAt] : TOPS[this.textContent ?? ''] ?? 200);
  });
  vi.stubGlobal('PointerEvent', MouseEvent);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
});
afterEach(() => {
  fireEvent.keyDown(document, { key: 'Escape' });
  cleanup();
  instances.splice(0).forEach(({ view }) => { if (!view.isDestroyed) view.destroy(); });
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Compact document shape: node types with non-default attributes, text in quotes. */
function shape(node: ProseNode): string {
  if (node.isText) return JSON.stringify(node.text);
  const specAttrs = node.type.spec.attrs ?? {};
  const attrs = Object.entries(node.attrs)
    .filter(([key, value]) => value !== (specAttrs[key] as { default?: unknown } | undefined)?.default)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  const children: string[] = [];
  node.forEach((child) => children.push(shape(child)));
  return `${node.type.name}${attrs.length ? `[${attrs.join(',')}]` : ''}${children.length ? `(${children.join(',')})` : ''}`;
}
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const notifications = () => notify.mock.calls.map((call) => call.map(String));
const describeFocus = () => {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return 'body';
  return el.dataset.blockCommand ?? el.dataset.command ?? (el.classList.contains('ProseMirror') ? 'editor' : el.tagName);
};

// ---- desktop: the block handle menu of the CrepeEditor host ----

const desktopMenu = () => document.querySelector<HTMLElement>('[role="menu"].crepe-block-menu');
const highlights = () => document.querySelectorAll('[data-block-menu-target-pos]').length;
const activeCommand = () => desktopMenu()?.querySelector<HTMLElement>('[data-active="true"]')?.dataset.blockCommand ?? null;

async function mountHost() {
  const ref = createRef<CrepeEditorApi>();
  const ready = vi.fn();
  render(<CrepeEditor ref={ref} noteId="note-a" onReady={ready} />);
  await waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
  const { view, handle } = instances.at(-1)!;
  const open = (keyboard = false) => {
    const operation = handle.children[1];
    if (keyboard) fireEvent.keyDown(operation, { key: 'Enter' });
    else {
      fireEvent.pointerDown(operation, { clientX: 10, clientY: 75, button: 0 });
      fireEvent.pointerUp(operation, { clientX: 10, clientY: 75, button: 0 });
    }
  };
  return { ref, view, open };
}

function desktopDom() {
  const menu = desktopMenu();
  if (!menu) return null;
  return {
    ariaLabel: menu.getAttribute('aria-label'),
    style: menu.getAttribute('style'),
    children: Array.from(menu.children, (el) => {
      if (el.classList.contains('crepe-block-menu__separator')) return { separator: true };
      if (el.classList.contains('crepe-block-menu__label')) return { label: el.textContent };
      const button = el as HTMLButtonElement;
      return {
        command: button.dataset.blockCommand, text: button.textContent, disabled: button.disabled,
        title: button.getAttribute('title'), destructive: button.dataset.destructive === 'true',
        tabIndex: button.tabIndex, icon: Boolean(button.querySelector('svg.crepe-block-menu__icon')),
      };
    }),
  };
}

async function desktopTarget(at: string) {
  handleAt = at;
  const host = await mountHost();
  host.open();
  const dom = desktopDom()!;
  const keyboard: Array<{ key: string; active: string | null; open: boolean }> = [];
  cleanup();
  handleAt = at;
  const keyed = await mountHost();
  keyed.open(true);
  keyboard.push({ key: 'open with Enter on the handle', active: activeCommand(), open: Boolean(desktopMenu()) });
  for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp', 'End', 'Home', 'ArrowUp', 'd', 'x']) {
    fireEvent.keyDown(window, { key });
    keyboard.push({ key, active: activeCommand(), open: Boolean(desktopMenu()) });
  }
  cleanup();

  const rows: Record<string, unknown> = {};
  handleAt = at;
  const { view: rowView, open: openRow } = await mountHost();
  for (const row of dom.children) {
    if (!('command' in row) || row.disabled) continue;
    act(() => rowView.updateState(EditorState.create({ doc: original, plugins: [history()],
      selection: TextSelection.create(original, textPos(original, 'target')) })));
    notify.mockClear();
    openRow();
    fireEvent.click(desktopMenu()!.querySelector(`[data-block-command="${row.command}"]`)!);
    const closedAtOnce = !desktopMenu();
    await flush();
    rows[row.command!] = { closedAtOnce, highlights: highlights(), doc: shape(rowView.state.doc), notifications: notifications() };
  }
  cleanup();

  const enter: Record<string, unknown> = {};
  {
    handleAt = at;
    const { view, open } = await mountHost();
    open(true);
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'Enter' });
    await flush();
    Object.assign(enter, { open: Boolean(desktopMenu()), doc: shape(view.state.doc) });
    cleanup();
  }
  return { dom, keyboard, rows, enter };
}

async function desktopDismissal() {
  const steps: Record<string, unknown> = {};
  const { view: stepView, open: openStep } = await mountHost();
  const run = async (name: string, act_: (view: ProseView) => void) => {
    act(() => stepView.updateState(EditorState.create({ doc: original, plugins: [history()],
      selection: TextSelection.create(original, textPos(original, 'target')) })));
    (document.activeElement as HTMLElement | null)?.blur();
    openStep();
    act(() => act_(stepView));
    await flush();
    steps[name] = { open: Boolean(desktopMenu()), highlights: highlights(), focus: describeFocus(), doc: shape(stepView.state.doc) === shape(original) ? 'unchanged' : shape(stepView.state.doc) };
    if (desktopMenu()) fireEvent.keyDown(window, { key: 'Escape' });
  };
  await run('Escape', () => { fireEvent.keyDown(window, { key: 'Escape' }); });
  await run('Tab', () => { fireEvent.keyDown(window, { key: 'Tab' }); });
  await run('pointerdown outside', () => { fireEvent.pointerDown(document.body); });
  await run('pointerdown inside the menu', () => { fireEvent.pointerDown(desktopMenu()!.querySelector('.crepe-block-menu__label')!); });
  await run('window resize', () => { fireEvent(window, new Event('resize')); });
  await run('beforeinput in the editor', (view) => { fireEvent(view.dom, new Event('beforeinput', { bubbles: true })); });
  await run('Android back', () => { steps['Android back consumed'] = handleAndroidBack(); });
  await run('printable key without a label match (z)', () => { fireEvent.keyDown(window, { key: 'z' }); });
  cleanup();
  {
    const { ref, open } = await mountHost();
    open();
    act(() => ref.current!.setReadonly(true));
    steps['editor turns readonly'] = { open: Boolean(desktopMenu()), highlights: highlights() };
    cleanup();
  }
  {
    const { ref, open } = await mountHost();
    act(() => ref.current!.setReadonly(true));
    open();
    steps['handle in a readonly editor'] = { open: Boolean(desktopMenu()) };
    cleanup();
  }
  return steps;
}

// ---- mobile: openCrepeBlockCommandMenu with the real pinned SlashProvider ----

const mobileMenu = () => document.querySelector<HTMLElement>('.crepe-block-menu');
function mobileView(at = 'target') {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const view = new ProseView(element, {
    state: EditorState.create({ doc: original, plugins: [history()],
      selection: TextSelection.create(original, textPos(original, at) + 2) }),
    dispatchTransaction(tr: Transaction) { view.updateState(view.state.apply(tr)); },
    handleScrollToSelection: () => true,
  });
  vi.spyOn(view, 'coordsAtPos').mockReturnValue({ left: 20, right: 20, top: 20, bottom: 40 });
  instances.push({ view, handle: element });
  return view;
}
async function showMobile(view: ProseView, actions: boolean) {
  let opened = false;
  await act(async () => { opened = openCrepeBlockCommandMenu(view, actions); await new Promise((resolve) => setTimeout(resolve, 25)); });
  return opened;
}
const closeMobile = () => { fireEvent.keyDown(document, { key: 'Escape' }); };

async function mobileSurface(actions: boolean, at = 'target', withRows = true) {
  const view = mobileView(at);
  const opened = await showMobile(view, actions);
  const menu = mobileMenu()!;
  const dom = {
    opened, role: menu.getAttribute('role'), ariaLabel: menu.getAttribute('aria-label'), hidden: menu.hidden,
    focus: describeFocus(),
    buttons: Array.from(menu.querySelectorAll<HTMLButtonElement>('button'), (button) => ({
      command: button.dataset.command, text: button.textContent, disabled: button.disabled,
      destructive: button.dataset.destructive === 'true', role: button.getAttribute('role'),
    })),
  };
  const keyboard: Array<{ key: string; focus: string }> = [];
  for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp', 'End', 'Home', 'ArrowUp']) {
    fireEvent.keyDown(document.activeElement ?? document, { key });
    keyboard.push({ key, focus: describeFocus() });
  }
  closeMobile();
  view.destroy();
  document.body.replaceChildren();
  if (!withRows) return { dom, keyboard };

  const rows: Record<string, unknown> = {};
  for (const button of dom.buttons) {
    if (button.disabled) continue;
    notify.mockClear();
    const rowView = mobileView();
    await showMobile(rowView, actions);
    fireEvent.click(mobileMenu()!.querySelector(`[data-command="${button.command}"]`)!);
    const closedAtOnce = !mobileMenu();
    await flush();
    rows[button.command!] = { closedAtOnce, doc: shape(rowView.state.doc), focus: describeFocus(), notifications: notifications() };
    rowView.destroy();
    document.body.replaceChildren();
  }
  return { dom, keyboard, rows };
}

async function mobileDismissal() {
  const steps: Record<string, unknown> = {};
  const run = async (name: string, act_: (view: ProseView) => void) => {
    const view = mobileView();
    await showMobile(view, true);
    act(() => act_(view));
    await flush();
    steps[name] = { open: Boolean(mobileMenu()), focus: describeFocus(), doc: shape(view.state.doc) === shape(original) ? 'unchanged' : shape(view.state.doc) };
    closeMobile();
    view.destroy();
    document.body.replaceChildren();
  };
  await run('Escape', () => { fireEvent.keyDown(document, { key: 'Escape' }); });
  await run('Tab', () => { fireEvent.keyDown(document, { key: 'Tab' }); });
  await run('pointerdown outside', () => { fireEvent.pointerDown(document.body); });
  await run('pointerdown inside the menu', () => { fireEvent.pointerDown(mobileMenu()!.querySelector('button')!); });
  await run('window blur', () => { fireEvent.blur(window); });
  await run('composition starts in the editor', (view) => { fireEvent.compositionStart(view.dom); });
  await run('document edit moves the target', (view) => { view.dispatch(view.state.tr.insertText('x', 1)); });
  {
    const view = mobileView();
    await showMobile(view, true);
    const first = mobileMenu();
    await showMobile(view, false);
    steps['reopening replaces the open menu'] = { menus: document.querySelectorAll('.crepe-block-menu').length, firstStillConnected: Boolean(first?.isConnected) };
    closeMobile();
    view.destroy();
    document.body.replaceChildren();
  }
  {
    const view = mobileView();
    view.setProps({ editable: () => false });
    steps['readonly editor'] = { opened: await showMobile(view, true), menu: Boolean(mobileMenu()) };
    view.destroy();
    document.body.replaceChildren();
  }
  return steps;
}

const capturing = process.env.FE_B9_CAPTURE_GOLDEN === '1';
const captured: Record<string, unknown> = { document: shape(original) };
const golden = capturing ? null : JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
afterAll(() => {
  if (capturing) writeFileSync(GOLDEN, `${JSON.stringify(captured, null, 2)}\n`, { flag: 'wx' });
});
const matchGolden = (key: string, result: unknown) => {
  captured[key] = result;
  if (golden) expect(result).toEqual(golden[key]);
};

describe('block menus before editor.blockMenu', () => {
  it('golden document', () => { if (golden) expect(golden.document).toBe(shape(original)); });
  it('desktop handle menu on a nested list item', async () => { matchGolden('desktop.nestedListItem', await desktopTarget('target')); });
  it('desktop handle menu on a top-level paragraph', async () => { matchGolden('desktop.topLevelParagraph', await desktopTarget('outside')); });
  it('desktop handle menu: how it closes', async () => { matchGolden('desktop.dismissal', await desktopDismissal()); });
  it('mobile menu as the slash stand-in', async () => { matchGolden('mobile.slashStandIn', await mobileSurface(false)); });
  it('mobile block menu', async () => { matchGolden('mobile.blockMenu', await mobileSurface(true)); });
  // The first row (paragraph) is disabled on a paragraph, so nothing in the menu takes focus and the arrow keys do nothing.
  it('mobile block menu on a top-level paragraph', async () => { matchGolden('mobile.blockMenuOnParagraph', await mobileSurface(true, 'outside', false)); });
  it('mobile menu: how it closes', async () => { matchGolden('mobile.dismissal', await mobileDismissal()); });
});
