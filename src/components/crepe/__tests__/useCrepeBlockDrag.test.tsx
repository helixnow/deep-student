import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState, TextSelection } from '@milkdown/prose/state';
import { EditorView } from '@milkdown/prose/view';
import { history, undoDepth } from '@milkdown/prose/history';
import type { Crepe } from '@milkdown/crepe';
import { useCrepeBlockDrag } from '../hooks/useCrepeBlockDrag';
import { blockTargetsAtY } from '../blockTarget';
import { bullet, doc, item, p, textPos, wrap } from './blockCommandFixtures';

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

function setup() {
  const original = doc(wrap('callout', bullet(item(p('a')), item(p('b')), item(p('c')))), p('outside'));
  const wrapper = document.createElement('div');
  document.body.appendChild(wrapper);
  const view = new EditorView(wrapper, {
    state: EditorState.create({ doc: original, plugins: [history()],
      selection: TextSelection.create(original, textPos(original, 'b')) }),
    dispatchTransaction(tr) { view.updateState(view.state.apply(tr)); },
    handleScrollToSelection: () => true,
  });
  const rect = (top: number) => ({ x: 20, y: top, top, bottom: top + 30, left: 20, right: 300, width: 280, height: 30, toJSON() {} });
  original.descendants((node, pos) => {
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return;
    const y = node.textContent === 'a' ? 10 : node.textContent === 'b' ? 60 : node.textContent === 'c' ? 110 : 160;
    vi.spyOn(dom, 'getBoundingClientRect').mockReturnValue(rect(y));
  });
  const handle = document.createElement('div');
  handle.className = 'milkdown-block-handle';
  vi.spyOn(handle, 'getBoundingClientRect').mockReturnValue(rect(60));
  wrapper.appendChild(handle);
  wrapper.setPointerCapture = vi.fn();
  wrapper.hasPointerCapture = vi.fn(() => false);
  const indicator = document.createElement('div');
  wrapper.appendChild(indicator);
  const crepe = { editor: { action: (action: (ctx: unknown) => void) => action({ get: () => view }) } } as unknown as Crepe;
  const options = { crepeRef: { current: crepe }, wrapperRef: { current: wrapper },
    containerRef: { current: wrapper }, dropIndicatorRef: { current: indicator } };
  const hook = renderHook(() => useCrepeBlockDrag(options));
  const pointer = (x: number, y: number) => ({ target: handle, clientX: x, clientY: y,
    pointerId: 1, button: 0, preventDefault: vi.fn(), stopPropagation: vi.fn() }) as unknown as React.PointerEvent;
  const start = () => {
    act(() => hook.result.current.handlers.onPointerDown(pointer(10, 75)));
    act(() => hook.result.current.handlers.onPointerMove(pointer(25, 75)));
  };
  const dispose = () => { hook.unmount(); view.destroy(); };
  return { original, view, hook, pointer, start, dispose, indicator };
}

describe('nested block drag wiring', () => {
  it('uses the same nested item from handle hit-testing through pointer-up movement', () => {
    const { original, view, hook, pointer, start, dispose } = setup();
    expect(blockTargetsAtY(view, 75)?.nodes[0].textContent).toBe('b');
    start();
    expect(hook.result.current.dragState?.sourceTarget.type).toBe('list_item');
    expect(hook.result.current.dragState?.sourceTarget.depth).toBe(3);
    act(() => hook.result.current.handlers.onPointerMove(pointer(25, 139)));
    act(() => hook.result.current.handlers.onPointerUp(pointer(25, 139)));
    expect(view.state.doc.eq(doc(wrap('callout', bullet(item(p('a')), item(p('c')), item(p('b')))), p('outside')))).toBe(true);
    expect(undoDepth(view.state)).toBe(1);
    expect(view.state.doc.textContent.length).toBe(original.textContent.length);
    dispose();
  });

  it('document edits during drag invalidate the captured source instead of moving a new node', () => {
    const { view, hook, pointer, start, dispose, indicator } = setup();
    start();
    expect(hook.result.current.dragState).not.toBeNull();
    view.dispatch(view.state.tr.insertText('changed', textPos(view.state.doc, 'a')));
    const changed = view.state.doc;
    act(() => hook.result.current.handlers.onPointerMove(pointer(25, 139)));
    expect(indicator.dataset.visible).toBeUndefined();
    act(() => hook.result.current.handlers.onPointerUp(pointer(25, 139)));
    expect(view.state.doc).toBe(changed);
    dispose();
  });

  it('Escape cancels a nested drag without document history', () => {
    const { view, original, hook, start, dispose } = setup();
    start();
    expect(hook.result.current.dragState).not.toBeNull();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(hook.result.current.dragState).toBeNull();
    expect(view.state.doc).toBe(original);
    expect(undoDepth(view.state)).toBe(0);
    dispose();
  });

  it('a selected range of sibling items is consumed by the actual drag entry point', () => {
    const { view, original, hook, pointer, start, dispose } = setup();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(original,
      textPos(original, 'a'), textPos(original, 'b') + 1)));
    start();
    expect(hook.result.current.dragState?.sourceTarget.nodes.map((node) => node.textContent)).toEqual(['a', 'b']);
    act(() => hook.result.current.handlers.onPointerMove(pointer(25, 139)));
    act(() => hook.result.current.handlers.onPointerUp(pointer(25, 139)));
    expect(view.state.doc.textContent).toBe('caboutside');
    expect(undoDepth(view.state)).toBe(1);
    dispose();
  });
});
