import React, { createRef } from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState, TextSelection } from '@milkdown/prose/state';
import { EditorView as ProseView } from '@milkdown/prose/view';
import { history, undo, undoDepth } from '@milkdown/prose/history';
import type { CrepeEditorApi } from '../types';
import { bullet, doc, item, p, schema, textPos, wrap } from './blockCommandFixtures';
import { resolveBlockHandleTarget } from '../blockTarget';

// Mount the actual React host and use real PM state/view/commands. Only the heavy
// Crepe bootstrap and unrelated integrations are replaced; menu and drag are real.
const original = doc(wrap('callout', bullet(item(p('first')), item(p('target')), item(p('last')))), p('outside'));
const instances: Array<{ view: ProseView; handle: HTMLElement }> = [];
vi.mock('@milkdown/crepe', () => ({
  CrepeFeature: new Proxy({}, { get: (_, key) => key }),
  Crepe: class {
    view!: ProseView;
    readonly = false;
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
    setReadonly(value: boolean) {
      this.readonly = value;
      this.view?.setProps({ editable: () => !value });
    }
    async destroy() { if (this.view && !this.view.isDestroyed) this.view.destroy(); }
  },
}));
vi.mock('../plugins', () => ({ applyCrepePlugins: vi.fn() }));
vi.mock('../features/imageUpload', () => ({
  createImageBlockConfig: () => ({}), createImageUploader: () => vi.fn(),
  createTransientBlobUrlRegistry: () => ({ register: vi.fn(), releaseAll: vi.fn() }),
  pickImageWithTauriDialog: vi.fn(), validateImageFile: vi.fn(),
}));
vi.mock('../features/mermaidPreview', () => ({ createMermaidObserver: vi.fn() }));
vi.mock('../useCrepeEditor', () => ({ createAgentInsertTransaction: vi.fn() }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/debug-panel/plugins/CrepeEditorDebugPlugin', () => ({ emitCrepeDebug: vi.fn(), captureDOMSnapshot: vi.fn() }));
vi.mock('@/debug-panel/plugins/CrepeImageUploadDebugPlugin', () => ({
  emitImageUploadDebug: vi.fn(), captureDOMInfo: vi.fn(), captureImageBlockSnapshot: vi.fn(),
}));
vi.mock('@/debug-panel/events/NotesOutlineDebugChannel', () => ({ emitOutlineDebugLog: vi.fn(), emitOutlineDebugSnapshot: vi.fn() }));
vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugMasterSwitch: { isEnabled: () => false },
  debugLog: { log: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { CrepeEditor } from '../CrepeEditor';

function rect(top: number) {
  return { x: 30, y: top, left: 30, top, right: 330, bottom: top + 30,
    width: 300, height: 30, toJSON() {} };
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return rect(this.classList.contains('milkdown-block-handle') || this.textContent === 'target' ? 60
      : this.textContent === 'first' ? 10 : this.textContent === 'last' ? 110 : 160);
  });
  vi.stubGlobal('PointerEvent', MouseEvent);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
});
afterEach(() => {
  cleanup();
  instances.splice(0).forEach(({ view }) => { if (!view.isDestroyed) view.destroy(); });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountHost() {
  const ref = createRef<CrepeEditorApi>();
  const ready = vi.fn();
  const host = render(<CrepeEditor ref={ref} noteId="note-a" onReady={ready} />);
  await waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
  const { view, handle } = instances.at(-1)!;
  const dispatch = vi.spyOn(view, 'dispatch');
  const openSelection = () => act(() => ref.current!.openBlockMenuAtSelection!());
  const openHandle = (keyboard = false) => {
    const operation = handle.children[1];
    if (keyboard) fireEvent.keyDown(operation, { key: 'Enter' });
    else {
      fireEvent.pointerDown(operation, { clientX: 10, clientY: 75, button: 0 });
      fireEvent.pointerUp(operation, { clientX: 10, clientY: 75, button: 0 });
    }
  };
  return { ...host, ref, ready, view, handle, dispatch, openSelection, openHandle };
}
const menu = () => document.querySelector('[role="menu"].crepe-block-menu');
const highlights = () => Array.from(document.querySelectorAll<HTMLElement>('[data-block-menu-target-pos]'));
const action = (name: string) => document.querySelector<HTMLButtonElement>(`[data-block-command="${name}"]`)!;

describe('CrepeEditor desktop block menu host wiring', () => {
  it.each(['duplicate', 'delete', 'heading-2'])('handle %s targets the nested list item and highlights that exact unit', async (command) => {
    const { view, handle, dispatch, openHandle } = await mountHost();
    const expected = resolveBlockHandleTarget(view, handle)!;
    expect(expected.type).toBe('list_item');
    openHandle(command === 'heading-2');
    expect(menu()).not.toBeNull();
    expect(highlights().map((el) => Number(el.dataset.blockMenuTargetPos))).toEqual([expected.pos]);
    expect(highlights()[0].style.outline).toContain('2px');
    expect(highlights()[0].style.pointerEvents).toBe('none');
    expect(dispatch).not.toHaveBeenCalled();
    fireEvent.click(action(command));
    expect(menu()).toBeNull();
    expect(highlights()).toHaveLength(0);
    expect(view.state.doc.firstChild!.type.name).toBe('callout');
    expect(view.state.doc.textContent).toBe(command === 'duplicate' ? 'firsttargettargetlastoutside'
      : command === 'delete' ? 'firstlastoutside' : original.textContent);
    if (command === 'heading-2') expect(view.state.doc.firstChild!.child(1).type.name).toBe('heading');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(undoDepth(view.state)).toBe(1);
    act(() => { undo(view.state, view.dispatch); });
    expect(view.state.doc.eq(original)).toBe(true);
  });

  it('selection entry preserves the captured multi-item range after the live selection changes', async () => {
    const { view, dispatch, openSelection } = await mountHost();
    act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(original,
      textPos(original, 'first'), textPos(original, 'target') + 2))));
    dispatch.mockClear();
    openSelection();
    const positions = highlights().map((el) => el.dataset.blockMenuTargetPos);
    expect(positions).toHaveLength(2);
    expect(dispatch).not.toHaveBeenCalled();
    act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(original, textPos(original, 'outside')))));
    expect(highlights().map((el) => el.dataset.blockMenuTargetPos)).toEqual(positions);
    expect(menu()).not.toBeNull();
    dispatch.mockClear();
    fireEvent.click(action('delete'));
    expect(view.state.doc.eq(doc(wrap('callout', bullet(item(p('last')))), p('outside')))).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('a collapsed nested toggle header targets the full toggle instead of adjacent visible text', async () => {
    const { view, handle, dispatch, openHandle } = await mountHost();
    const toggle = schema.node('toggle', { title: 'closed', open: false }, p('hidden body'));
    const document = doc(wrap('callout', p('first'), toggle, p('last')), p('outside'));
    act(() => view.updateState(EditorState.create({ doc: document, plugins: [history()],
      selection: TextSelection.create(document, textPos(document, 'first')) })));
    const togglePos = 1 + p('first').nodeSize;
    const toggleDom = view.nodeDOM(togglePos) as HTMLElement;
    vi.spyOn(toggleDom, 'getBoundingClientRect').mockReturnValue(rect(60));
    (view.nodeDOM(togglePos + 1) as HTMLElement).hidden = true;
    dispatch.mockClear();
    expect(resolveBlockHandleTarget(view, handle)?.pos).toBe(togglePos);
    openHandle();
    expect(highlights().map((el) => Number(el.dataset.blockMenuTargetPos))).toEqual([togglePos]);
    fireEvent.click(action('duplicate'));
    expect(view.state.doc.firstChild!.child(1).eq(toggle)).toBe(true);
    expect(view.state.doc.firstChild!.child(2).eq(toggle)).toBe(true);
    expect(view.state.doc.lastChild!.eq(p('outside'))).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('handle menu and actual drag consume the same selected sibling range', async () => {
    const { view, handle, openHandle } = await mountHost();
    act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(original,
      textPos(original, 'first'), textPos(original, 'target') + 2))));
    openHandle();
    expect(highlights()).toHaveLength(2);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(undoDepth(view.state)).toBe(0);
    const operation = handle.children[1];
    fireEvent.pointerDown(operation, { clientX: 10, clientY: 75, button: 0 });
    fireEvent.pointerMove(operation, { clientX: 25, clientY: 75, button: 0 });
    fireEvent.pointerMove(operation, { clientX: 25, clientY: 139, button: 0 });
    fireEvent.pointerUp(operation, { clientX: 25, clientY: 139, button: 0 });
    expect(view.state.doc.textContent).toBe('lastfirsttargetoutside');
    expect(undoDepth(view.state)).toBe(1);
    expect(menu()).toBeNull();
  });

  it('invalidates synchronously on any document version change, even if the original snapshot returns before render', async () => {
    const { view, openSelection, dispatch } = await mountHost();
    openSelection();
    const oldState = view.state;
    const deleteButton = action('delete');
    act(() => {
      view.dispatch(view.state.tr.insertText('edit'));
      view.updateState(oldState);
      dispatch.mockClear();
      fireEvent.click(deleteButton);
    });
    expect(view.state.doc).toBe(original);
    expect(dispatch).not.toHaveBeenCalled();
    expect(menu()).toBeNull();
    expect(highlights()).toHaveLength(0);
  });

  it('note switches clear the menu/highlight and old buttons cannot act on a new view with the same doc', async () => {
    const { view, ref, ready, openSelection, rerender } = await mountHost();
    openSelection();
    const oldButton = action('delete');
    rerender(<CrepeEditor ref={ref} noteId="note-b" onReady={ready} />);
    expect(menu()).toBeNull();
    expect(highlights()).toHaveLength(0);
    await waitFor(() => expect(ready).toHaveBeenCalledTimes(2));
    const current = instances.at(-1)!.view;
    expect(current).not.toBe(view);
    fireEvent.click(oldButton);
    expect(current.state.doc).toBe(original);
    expect(undoDepth(current.state)).toBe(0);
    openSelection();
    fireEvent.click(action('delete'));
    expect(current.state.doc.textContent).toBe('firstlastoutside');
  });

  it('Escape and readonly transitions clear the range without editing, and the retained API refuses readonly opens', async () => {
    const { view, ref, ready, dispatch, openSelection, rerender } = await mountHost();
    openSelection();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(highlights()).toHaveLength(0);
    expect(view.state.doc).toBe(original);
    openSelection();
    act(() => ref.current!.setReadonly(true));
    expect(menu()).toBeNull();
    expect(highlights()).toHaveLength(0);
    act(() => ref.current!.setReadonly(false));
    openSelection();
    rerender(<CrepeEditor ref={ref} noteId="note-a" onReady={ready} readonly />);
    expect(menu()).toBeNull();
    expect(highlights()).toHaveLength(0);
    openSelection();
    expect(menu()).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
    expect(undoDepth(view.state)).toBe(0);
  });
});
