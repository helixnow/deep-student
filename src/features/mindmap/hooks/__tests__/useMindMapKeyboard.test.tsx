/**
 * useMindMapKeyboard 键盘心流升级回归测试：
 * 1. Space 在非背诵态放行给画布抓手平移（不进入编辑，不 preventDefault）；
 *    背诵态仍揭示下一个未翻开的挖空。
 * 2. 选中节点直接打字即进入编辑（Type-to-edit）：首字符注入 textarea 且光标在末尾，
 *    Escape 恢复原文；中文 IME Process / keyCode=229 立即进入编辑挂载 textarea。
 * 3. Mod+/ 切换当前焦点节点折叠/展开。
 */
import React, { useLayoutEffect, useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMindMapStore, MindMapStoreContext, useMindMapStore } from '../../store';
import { MindMapActiveContext } from '../../MindMapActiveContext';
import {
  clearPendingTypeToEditChar,
  consumePendingTypeToEditChar,
  useMindMapKeyboard,
} from '../useMindMapKeyboard';
import type { MindMapDocument } from '../../types';

function createSampleDoc(): MindMapDocument {
  return {
    version: '1.0',
    root: {
      id: 'root',
      text: '中心主题',
      children: [
        {
          id: 'n1',
          text: '原始标题',
          blankedRanges: [{ start: 0, end: 2 }],
          children: [
            { id: 'n1_1', text: '子节点', children: [] },
          ],
        },
        { id: 'n2', text: '兄弟节点', children: [] },
      ],
    },
    meta: { createdAt: '2026-01-01T00:00:00.000Z' },
  };
}

const KeyboardCanvasHarness: React.FC<{ nodeId?: string }> = ({ nodeId = 'n1' }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useMindMapKeyboard({ containerRef });
  const editingNodeId = useMindMapStore((s) => s.editingNodeId);
  const setEditingNodeId = useMindMapStore((s) => s.setEditingNodeId);
  const nodeText = useMindMapStore(
    (s) => s.document.root.children.find((c) => c.id === nodeId)?.text ?? '',
  );
  const [draft, setDraft] = useState(nodeText);

  const isEditing = editingNodeId === nodeId;

  useLayoutEffect(() => {
    if (!isEditing) return;
    const pending = consumePendingTypeToEditChar(nodeId);
    if (pending !== null) {
      setDraft(pending);
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.value = pending;
        textareaRef.current.setSelectionRange(pending.length, pending.length);
      }
    }
  }, [isEditing, nodeId]);

  return (
    <div ref={containerRef}>
      <div className="react-flow__node" data-id={nodeId}>
        {isEditing ? (
          <textarea
            ref={textareaRef}
            aria-label="node-editor"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setDraft(nodeText);
                setEditingNodeId(null);
              }
            }}
          />
        ) : (
          <span>{nodeText}</span>
        )}
      </div>
    </div>
  );
};

function setupStore(overrides?: Partial<ReturnType<ReturnType<typeof createMindMapStore>['getState']>>) {
  const store = createMindMapStore();
  store.setState({
    document: JSON.parse(JSON.stringify(createSampleDoc())) as MindMapDocument,
    focusedNodeId: 'n1',
    editingNodeId: null,
    editingNoteNodeId: null,
    selection: ['n1'],
    reciteMode: false,
    revealedBlanks: {},
    ...overrides,
  });
  return store;
}

describe('useMindMapKeyboard flow upgrades', () => {
  let rafQueue: FrameRequestCallback[] = [];

  beforeEach(() => {
    rafQueue = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(() => {
    clearPendingTypeToEditChar();
    cleanup();
    vi.restoreAllMocks();
  });

  function flushRaf() {
    const pending = [...rafQueue];
    rafQueue = [];
    pending.forEach((cb) => cb(16));
  }

  it('passes Space through in non-recite mode for canvas pan hand instead of editing', () => {
    const store = setupStore();
    render(
      <MindMapStoreContext.Provider value={store}>
        <MindMapActiveContext.Provider value={{ isActive: true, resourceId: null }}>
          <KeyboardCanvasHarness />
        </MindMapActiveContext.Provider>
      </MindMapStoreContext.Provider>,
    );

    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(store.getState().editingNodeId).toBeNull();
  });

  it('keeps Space revealing the next unrevealed blank in recite mode', () => {
    const store = setupStore({ reciteMode: true });
    render(
      <MindMapStoreContext.Provider value={store}>
        <MindMapActiveContext.Provider value={{ isActive: true, resourceId: null }}>
          <KeyboardCanvasHarness />
        </MindMapActiveContext.Provider>
      </MindMapStoreContext.Provider>,
    );

    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(store.getState().revealedBlanks.n1?.[0]).toBe(true);
  });

  it('still enters editing mode on F2', () => {
    const store = setupStore();
    render(
      <MindMapStoreContext.Provider value={store}>
        <MindMapActiveContext.Provider value={{ isActive: true, resourceId: null }}>
          <KeyboardCanvasHarness />
        </MindMapActiveContext.Provider>
      </MindMapStoreContext.Provider>,
    );

    const event = new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(store.getState().editingNodeId).toBe('n1');
  });

  it('supports type-to-edit with printable character, puts caret at end, and lets Escape restore original text', () => {
    const store = setupStore();
    render(
      <MindMapStoreContext.Provider value={store}>
        <MindMapActiveContext.Provider value={{ isActive: true, resourceId: null }}>
          <KeyboardCanvasHarness />
        </MindMapActiveContext.Provider>
      </MindMapStoreContext.Provider>,
    );

    const event = new KeyboardEvent('keydown', { key: 'A', shiftKey: true, bubbles: true, cancelable: true });
    act(() => {
      document.body.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(store.getState().editingNodeId).toBe('n1');
    // store 原文尚未被覆写，Escape 可安全恢复
    expect(store.getState().document.root.children[0].text).toBe('原始标题');

    act(() => {
      flushRaf();
    });

    const textarea = screen.getByLabelText('node-editor') as HTMLTextAreaElement;
    expect(textarea.value).toBe('A');
    expect(textarea.selectionStart).toBe(1);
    expect(textarea.selectionEnd).toBe(1);

    // 按 Escape 退出编辑后原文保持完好
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(store.getState().editingNodeId).toBeNull();
    expect(store.getState().document.root.children[0].text).toBe('原始标题');
  });

  it('starts editing immediately on CJK IME Process / keyCode 229 without preventing default', () => {
    const store = setupStore();
    render(
      <MindMapStoreContext.Provider value={store}>
        <MindMapActiveContext.Provider value={{ isActive: true, resourceId: null }}>
          <KeyboardCanvasHarness />
        </MindMapActiveContext.Provider>
      </MindMapStoreContext.Provider>,
    );

    const imeEvent = new KeyboardEvent('keydown', {
      key: 'Process',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(imeEvent, 'keyCode', { value: 229 });

    act(() => {
      document.body.dispatchEvent(imeEvent);
    });

    expect(imeEvent.defaultPrevented).toBe(false);
    expect(store.getState().editingNodeId).toBe('n1');
  });

  it('toggles node collapse/expand with Mod+/', () => {
    const store = setupStore();
    render(
      <MindMapStoreContext.Provider value={store}>
        <MindMapActiveContext.Provider value={{ isActive: true, resourceId: null }}>
          <KeyboardCanvasHarness />
        </MindMapActiveContext.Provider>
      </MindMapStoreContext.Provider>,
    );

    const collapseEvent = new KeyboardEvent('keydown', {
      key: '/',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.body.dispatchEvent(collapseEvent);
    });
    expect(collapseEvent.defaultPrevented).toBe(true);
    expect(store.getState().document.root.children[0].collapsed).toBe(true);

    const expandEvent = new KeyboardEvent('keydown', {
      key: '/',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.body.dispatchEvent(expandEvent);
    });
    expect(expandEvent.defaultPrevented).toBe(true);
    expect(store.getState().document.root.children[0].collapsed).toBe(false);
  });

  it('accumulates rapid consecutive type-to-edit characters without dropping the 2nd char or touching unrelated activeElement', () => {
    const store = setupStore();
    const { container } = render(
      <div>
        <textarea data-testid="unrelated-editor" defaultValue="DO_NOT_MUTATE" />
        <MindMapStoreContext.Provider value={store}>
          <MindMapActiveContext.Provider value={{ isActive: true, resourceId: null }}>
            <KeyboardCanvasHarness />
          </MindMapActiveContext.Provider>
        </MindMapStoreContext.Provider>
      </div>,
    );

    const unrelated = container.querySelector('[data-testid="unrelated-editor"]') as HTMLTextAreaElement;

    // Two printable keys dispatched back-to-back before React flushes intermediate render
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'A', shiftKey: true, bubbles: true, cancelable: true }),
      );
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'B', shiftKey: true, bubbles: true, cancelable: true }),
      );
    });

    const textarea = screen.getByLabelText('node-editor') as HTMLTextAreaElement;
    expect(textarea.value).toBe('AB');
    expect(textarea.selectionStart).toBe(2);
    expect(textarea.selectionEnd).toBe(2);
    expect(unrelated.value).toBe('DO_NOT_MUTATE');

    // Escape restores original node text cleanly
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(store.getState().editingNodeId).toBeNull();
    expect(store.getState().document.root.children[0].text).toBe('原始标题');
  });

  it('lets Escape pass through to close open menus/popovers/lightboxes without clearing node selection first', () => {
    const store = setupStore();
    const { rerender } = render(
      <div>
        <div role="menu" data-state="open">
          <button type="button" data-testid="menu-item">Item</button>
        </div>
        <MindMapStoreContext.Provider value={store}>
          <MindMapActiveContext.Provider value={{ isActive: true, resourceId: null }}>
            <KeyboardCanvasHarness />
          </MindMapActiveContext.Provider>
        </MindMapStoreContext.Provider>
      </div>,
    );

    const esc1 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      document.body.dispatchEvent(esc1);
    });
    expect(esc1.defaultPrevented).toBe(false);
    expect(store.getState().focusedNodeId).toBe('n1');
    expect(store.getState().selection).toEqual(['n1']);

    // Settings popover open -> still passes Escape through
    rerender(
      <div>
        <div className="mm-settings-popover">Settings</div>
        <MindMapStoreContext.Provider value={store}>
          <MindMapActiveContext.Provider value={{ isActive: true, resourceId: null }}>
            <KeyboardCanvasHarness />
          </MindMapActiveContext.Provider>
        </MindMapStoreContext.Provider>
      </div>,
    );
    const esc2 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      document.body.dispatchEvent(esc2);
    });
    expect(esc2.defaultPrevented).toBe(false);
    expect(store.getState().focusedNodeId).toBe('n1');

    // Lightbox open -> still passes Escape through
    rerender(
      <div>
        <div data-testid="mm-image-lightbox">Lightbox</div>
        <MindMapStoreContext.Provider value={store}>
          <MindMapActiveContext.Provider value={{ isActive: true, resourceId: null }}>
            <KeyboardCanvasHarness />
          </MindMapActiveContext.Provider>
        </MindMapStoreContext.Provider>
      </div>,
    );
    const esc3 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      document.body.dispatchEvent(esc3);
    });
    expect(esc3.defaultPrevented).toBe(false);
    expect(store.getState().focusedNodeId).toBe('n1');

    // No overlay open -> clears focus and selection as normal
    rerender(
      <div>
        <MindMapStoreContext.Provider value={store}>
          <MindMapActiveContext.Provider value={{ isActive: true, resourceId: null }}>
            <KeyboardCanvasHarness />
          </MindMapActiveContext.Provider>
        </MindMapStoreContext.Provider>
      </div>,
    );
    const esc4 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      document.body.dispatchEvent(esc4);
    });
    expect(esc4.defaultPrevented).toBe(true);
    expect(store.getState().focusedNodeId).toBeNull();
    expect(store.getState().selection).toEqual([]);
  });

  it('keeps consecutive Mod+B and Mod+I style toggles as separate undo steps', () => {
    const store = setupStore({ selection: ['n1', 'n2'], focusedNodeId: 'n1' });
    render(
      <MindMapStoreContext.Provider value={store}>
        <MindMapActiveContext.Provider value={{ isActive: true, resourceId: null }}>
          <KeyboardCanvasHarness />
        </MindMapActiveContext.Provider>
      </MindMapStoreContext.Provider>,
    );

    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true, cancelable: true }),
      );
    });
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'i', metaKey: true, bubbles: true, cancelable: true }),
      );
    });

    expect(store.getState().document.root.children[0].style?.fontWeight).toBe('bold');
    expect(store.getState().document.root.children[0].style?.fontStyle).toBe('italic');
    expect(store.getState().document.root.children[1].style?.fontStyle).toBe('italic');

    // First undo should revert only italic, keeping bold intact
    act(() => {
      store.getState().undo();
    });
    expect(store.getState().document.root.children[0].style?.fontWeight).toBe('bold');
    expect(store.getState().document.root.children[0].style?.fontStyle).toBeUndefined();

    // Second undo reverts bold across the whole selection
    act(() => {
      store.getState().undo();
    });
    expect(store.getState().document.root.children[0].style?.fontWeight).toBeUndefined();
    expect(store.getState().document.root.children[1].style?.fontWeight).toBeUndefined();
  });
});
