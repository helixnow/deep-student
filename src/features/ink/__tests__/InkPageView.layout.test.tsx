import React, { createRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InkPageView, type InkPageViewHandle, type InkPageViewProps } from '../InkPageView';
import type { InkPage, InkPageRef } from '../types';

vi.mock('../renderer', () => ({ renderInkPage: vi.fn() }));

const pageRef: InkPageRef = {
  page_id: 'page-1',
  width: 794,
  height: 1123,
  background: { kind: 'blank', ruling: 'blank' },
  page_blob_hash: 'page-hash-1',
};
const page: InkPage = { schema_version: 1, page_id: 'page-1', objects: [] };

function props(overrides: Partial<InkPageViewProps> = {}): InkPageViewProps {
  return {
    documentId: 'document-1',
    pageRef,
    page,
    tool: {
      tool: 'pen', color: '#000000', width: 4, pressure_enabled: true,
      touchDrawing: false, zoom: 0.4, panX: 0, panY: 0, eraserSize: 16,
    },
    erasing: false,
    onPageChange: vi.fn(async () => undefined),
    ariaLabel: 'Ink page',
    ...overrides,
  };
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('InkPageView constrained viewport', () => {
  it('reports padded available width on resize and preserves user navigation callbacks', () => {
    const resizeCallbacks: Array<() => void> = [];
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resizeCallbacks.push(callback); }
      observe() {}
      disconnect = disconnect;
    });
    const onViewportWidthChange = vi.fn();
    const onViewportInteraction = vi.fn();
    const { unmount } = render(<InkPageView {...props({ onViewportWidthChange, onViewportInteraction })} />);
    const viewport = screen.getByTestId('ink-page-viewport');
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 390 });
    viewport.style.padding = '12px';

    act(() => resizeCallbacks[0]());
    expect(onViewportWidthChange).toHaveBeenLastCalledWith(366);
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 360 });
    fireEvent(window, new Event('resize'));
    expect(onViewportWidthChange).toHaveBeenLastCalledWith(336);
    expect(viewport).toHaveClass('min-h-0', 'min-w-0', 'flex-1', 'overflow-auto');
    fireEvent.pointerDown(screen.getByTestId('ink-page-surface'));
    fireEvent.wheel(viewport);
    fireEvent.keyDown(viewport, { key: 'PageDown' });
    expect(onViewportInteraction).toHaveBeenCalledTimes(3);

    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('resets scroll only on page navigation, not a save or zoom update', () => {
    const initial = props();
    const { rerender } = render(<InkPageView {...initial} />);
    const viewport = screen.getByTestId('ink-page-viewport');
    viewport.scrollTop = 240;
    viewport.scrollLeft = 32;

    rerender(<InkPageView {...initial} page={{ ...page, objects: [] }} tool={{ ...initial.tool, zoom: 0.65 }} />);
    expect(viewport.scrollTop).toBe(240);
    expect(viewport.scrollLeft).toBe(32);

    rerender(<InkPageView {...initial} pageRef={{ ...pageRef, page_id: 'page-2' }} page={{ ...page, page_id: 'page-2' }} />);
    expect(viewport.scrollTop).toBe(0);
    expect(viewport.scrollLeft).toBe(0);
  });

  it('keeps paste center in logical page coordinates after fit, padding, and scrolling', () => {
    const ref = createRef<InkPageViewHandle>();
    render(<InkPageView ref={ref} {...props()} />);
    const viewport = screen.getByTestId('ink-page-viewport');
    const canvas = screen.getByTestId('ink-page-canvas');
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 390 },
      clientHeight: { configurable: true, value: 300 },
    });
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect(0, 100, 390, 300));
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(rect(36.2, 20, 317.6, 449.2));

    const center = ref.current?.getViewportCenter();
    expect(center?.x).toBeCloseTo(397);
    expect(center?.y).toBeCloseTo(575);
  });
});
