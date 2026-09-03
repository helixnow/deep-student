/**
 * useMindMapKeyboard 收口回归：
 * 1. Esc 在无编辑/无背诵/无选中/无焦点时必须放行（不 preventDefault /
 *    stopPropagation），让外层窗口/命令系统处理；有可退出状态时保持拦截。
 * 2. 空间导航（canvasNavigation=spatial）候选节点查询限定本实例
 *    containerRef，分屏双画布互不串扰。
 */
import React, { useRef } from 'react';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMindMapKeyboard } from '@/features/mindmap/hooks/useMindMapKeyboard';
import { useMindMapStore } from '@/features/mindmap/store/mindmapStore';
import type { MindMapDocument } from '@/features/mindmap/types';

const PREFS_KEY = 'deep-student:mindmap-preferences:v1';

function createDocument(): MindMapDocument {
  return {
    version: '1.0',
    root: {
      id: 'root_kbd',
      text: 'Root',
      children: [
        { id: 'n1', text: 'One', children: [] },
        { id: 'n2', text: 'Two', children: [] },
        { id: 'n3', text: 'Three', children: [] },
      ],
    },
    meta: { createdAt: '2026-01-01T00:00:00.000Z' },
  };
}

function seedStore(partial: Partial<{ focusedNodeId: string | null }> = {}): void {
  useMindMapStore.setState({
    mindmapId: null,
    metadata: null,
    document: JSON.parse(JSON.stringify(createDocument())) as MindMapDocument,
    focusedNodeId: null,
    editingNodeId: null,
    editingNoteNodeId: null,
    selection: [],
    history: { past: [], future: [] },
    clipboard: null,
    reciteMode: false,
    revealedBlanks: {},
    hideCompleted: false,
    searchFilterMode: false,
    viewports: {},
    ...partial,
  });
}

const HookHost: React.FC<{ container?: HTMLElement }> = ({ container }) => {
  const ref = useRef<HTMLElement | null>(container ?? null);
  useMindMapKeyboard(container ? { containerRef: ref } : undefined);
  return null;
};

function dispatchKey(key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  return event;
}

function mockRect(element: HTMLElement, rect: { left: number; top: number; width: number; height: number }): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => rect,
    }),
  });
}

function buildCanvasNode(parent: HTMLElement, id: string, rect: { left: number; top: number; width: number; height: number }): HTMLElement {
  const element = document.createElement('div');
  element.className = 'react-flow__node';
  element.dataset.id = id;
  mockRect(element, rect);
  parent.appendChild(element);
  return element;
}

afterEach(() => {
  useMindMapStore.getState().reset();
  window.localStorage.removeItem(PREFS_KEY);
  document.querySelectorAll('[data-test-canvas]').forEach((element) => element.remove());
});

describe('Escape passthrough', () => {
  it('does not swallow Esc when there is nothing to escape', () => {
    seedStore({ focusedNodeId: null });
    render(<HookHost />);

    const windowSpy = vi.fn();
    window.addEventListener('keydown', windowSpy);
    const event = dispatchKey('Escape');
    window.removeEventListener('keydown', windowSpy);

    // 无编辑/背诵/选中/焦点：放行给外层（不 preventDefault、不 stopPropagation）
    expect(event.defaultPrevented).toBe(false);
    expect(windowSpy).toHaveBeenCalledTimes(1);
  });

  it('still intercepts Esc to clear focus when a node is focused', () => {
    seedStore({ focusedNodeId: 'n1' });
    render(<HookHost />);

    const windowSpy = vi.fn();
    window.addEventListener('keydown', windowSpy);
    const event = dispatchKey('Escape');
    window.removeEventListener('keydown', windowSpy);

    expect(event.defaultPrevented).toBe(true);
    expect(windowSpy).not.toHaveBeenCalled();
    expect(useMindMapStore.getState().focusedNodeId).toBeNull();
  });
});

describe('spatial navigation instance scoping', () => {
  beforeEach(() => {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify({ canvasNavigation: 'spatial' }));
  });

  function buildTwoCanvases(): { canvasA: HTMLElement; canvasB: HTMLElement } {
    // 画布 A：n1（焦点）与右侧较远的 n2；画布 B：右侧更近的 n3（另一实例）
    const canvasA = document.createElement('div');
    canvasA.dataset.testCanvas = 'a';
    const canvasB = document.createElement('div');
    canvasB.dataset.testCanvas = 'b';
    document.body.append(canvasA, canvasB);
    buildCanvasNode(canvasA, 'n1', { left: 0, top: 0, width: 100, height: 40 });
    buildCanvasNode(canvasA, 'n2', { left: 300, top: 0, width: 100, height: 40 });
    buildCanvasNode(canvasB, 'n3', { left: 150, top: 0, width: 100, height: 40 });
    return { canvasA, canvasB };
  }

  it('only considers nodes inside this instance container', () => {
    const { canvasA } = buildTwoCanvases();
    seedStore({ focusedNodeId: 'n1' });
    render(<HookHost container={canvasA} />);

    dispatchKey('ArrowRight');

    // 若全局查询，会命中另一画布中更近的 n3（跨实例串扰）
    expect(useMindMapStore.getState().focusedNodeId).toBe('n2');
  });

  it('demonstrates the cross-talk that global queries would cause (control case)', () => {
    buildTwoCanvases();
    seedStore({ focusedNodeId: 'n1' });
    render(<HookHost />);

    dispatchKey('ArrowRight');

    expect(useMindMapStore.getState().focusedNodeId).toBe('n3');
  });
});
