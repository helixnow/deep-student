import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InkPageView, type InkPageViewProps } from '../InkPageView';
import type { InkObject, InkPage, InkPageRef, InkSample } from '../types';

vi.mock('../renderer', () => ({ renderInkPage: vi.fn(() => ({ width_px: 794, height_px: 1123 })) }));

const pageRef: InkPageRef = {
  page_id: 'page-1',
  width: 794,
  height: 1123,
  background: { kind: 'blank', ruling: 'blank' },
  page_blob_hash: 'page-hash-1',
};
const page: InkPage = { schema_version: 1, page_id: 'page-1', objects: [] };

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly pressure: number;

  getCoalescedEvents(): PointerEvent[] {
    return [this];
  }

  constructor(
    type: string,
    init: MouseEventInit & { pointerId?: number; pointerType?: string; pressure?: number; timeStamp?: number } = {},
  ) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'pen';
    this.pressure = init.pressure ?? 0.5;
    Object.defineProperty(this, 'timeStamp', { configurable: true, value: init.timeStamp ?? 0 });
  }
}

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

function mockCanvasRects() {
  const canvas = screen.getByTestId('ink-page-canvas');
  const overlay = screen.getByTestId('ink-active-stroke-canvas');
  const canvasRect = vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(rect(10, 20, 397, 561.5));
  const overlayRect = vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(rect(10, 20, 397, 561.5));
  return { canvas, overlay, canvasRect, overlayRect };
}

const pointerInit = (pointerId: number, pointerType: string, x: number, y: number, timeStamp: number) => ({
  pointerId,
  pointerType,
  button: 0,
  buttons: 1,
  clientX: x,
  clientY: y,
  pressure: 0.5,
  isPrimary: true,
  timeStamp,
});

type Target = HTMLElement | Element;

function pointerDown(target: Target, id: number, type: string, x: number, y: number, timeStamp: number) {
  fireEvent.pointerDown(target, pointerInit(id, type, x, y, timeStamp));
}

function pointerMove(target: Target, id: number, type: string, x: number, y: number, timeStamp: number) {
  fireEvent.pointerMove(target, { ...pointerInit(id, type, x, y, timeStamp), buttons: 1 });
}

function pointerUp(target: Target, id: number, type: string, x: number, y: number, timeStamp: number) {
  fireEvent.pointerUp(target, { ...pointerInit(id, type, x, y, timeStamp), buttons: 0 });
}

function pointerCancel(target: Target, id: number, type: string, x: number, y: number, timeStamp: number) {
  fireEvent.pointerCancel(target, { ...pointerInit(id, type, x, y, timeStamp), buttons: 0 });
}

function savedStroke(pageValue: InkPage): InkObject {
  const stroke = pageValue.objects.find((object) => object.content.kind === 'stroke');
  if (!stroke) throw new Error('missing saved stroke');
  return stroke;
}

function savedSamples(pageValue: InkPage): InkSample[] {
  const stroke = savedStroke(pageValue);
  return stroke.content.kind === 'stroke' ? stroke.content.samples : [];
}

function lastSavedSamples(pageValue: InkPage): InkSample[] {
  const stroke = [...pageValue.objects].reverse().find((object) => object.content.kind === 'stroke');
  if (!stroke || stroke.content.kind !== 'stroke') throw new Error('missing saved stroke');
  return stroke.content.samples;
}

function strokeObject(id: string, x: number, y: number): InkObject {
  return {
    id,
    author: 'user',
    created_at: 0,
    content: {
      kind: 'stroke',
      samples: [{ x, y, pressure: 0.5 }],
      style: { tool: 'pen', color: '#000000', width: 4, pressure_enabled: true },
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('InkPageView pen input', () => {
  it('finishes pointercancel from existing samples and keeps the next stroke independent', async () => {
    const onPageChange = vi.fn(async (_next: InkPage) => undefined);
    const onActiveStrokeChange = vi.fn();
    render(<InkPageView {...props({ onPageChange, onActiveStrokeChange })} />);
    const { overlay } = mockCanvasRects();

    pointerDown(overlay, 7, 'pen', 110, 120, 1000);
    pointerMove(overlay, 7, 'pen', 130, 140, 1016);
    pointerCancel(overlay, 7, 'pen', 0, 0, 1032);

    await waitFor(() => expect(onPageChange).toHaveBeenCalledOnce());
    const cancelled = savedSamples(onPageChange.mock.calls[0][0]);
    expect(cancelled).toHaveLength(2);
    expect(cancelled.at(-1)).toMatchObject({ x: 240, y: 240, elapsed_ms: 16 });
    expect(cancelled.some((sample) => sample.x === 0 && sample.y === 0)).toBe(false);
    expect(onActiveStrokeChange.mock.calls).toEqual([[true], [false]]);

    pointerDown(overlay, 8, 'pen', 160, 180, 2000);
    pointerMove(overlay, 8, 'pen', 180, 200, 2016);
    pointerUp(overlay, 8, 'pen', 200, 220, 2032);

    await waitFor(() => expect(onPageChange).toHaveBeenCalledTimes(2));
    const nextPage = onPageChange.mock.calls[1][0];
    expect(nextPage.objects).toHaveLength(2);
    const nextSamples = lastSavedSamples(nextPage);
    expect(nextSamples).toHaveLength(3);
    expect(nextSamples[0]).toMatchObject({ x: 300, y: 320, elapsed_ms: 0 });
    expect(nextSamples.at(-1)).toMatchObject({ x: 380, y: 400, elapsed_ms: 32 });
  });

  it('does not lose the next stroke while the previous save is pending', async () => {
    let resolveFirst!: () => void;
    const firstSave = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const onPageChange = vi.fn()
      .mockImplementationOnce(() => firstSave)
      .mockImplementation(async () => undefined);
    render(<InkPageView {...props({ onPageChange })} />);
    const { overlay } = mockCanvasRects();

    pointerDown(overlay, 7, 'pen', 110, 120, 1000);
    pointerMove(overlay, 7, 'pen', 130, 140, 1016);
    pointerUp(overlay, 7, 'pen', 150, 160, 1032);
    await waitFor(() => expect(onPageChange).toHaveBeenCalledTimes(1));

    pointerDown(overlay, 8, 'pen', 160, 180, 2000);
    pointerMove(overlay, 8, 'pen', 180, 200, 2016);
    pointerUp(overlay, 8, 'pen', 200, 220, 2032);

    await waitFor(() => expect(onPageChange).toHaveBeenCalledTimes(2));
    expect(onPageChange.mock.calls[1][0].objects).toHaveLength(2);
    expect(lastSavedSamples(onPageChange.mock.calls[1][0])).toHaveLength(3);

    await act(async () => { resolveFirst(); });
  });
});

describe('InkPageView touch pan', () => {
  it.each([false, true])('pans the viewport padding without drawing when touch drawing is %s', (touchDrawing) => {
    const initial = props();
    const onPageChange = vi.fn(async () => undefined);
    const onActiveStrokeChange = vi.fn();
    render(<InkPageView {...initial} tool={{ ...initial.tool, touchDrawing }} onPageChange={onPageChange} onActiveStrokeChange={onActiveStrokeChange} />);
    mockCanvasRects();
    const viewport = screen.getByTestId('ink-page-viewport');
    viewport.scrollLeft = 200;
    viewport.scrollTop = 150;

    expect(viewport.style.touchAction).toBe('none');
    pointerDown(viewport, 11, 'touch', 100, 100, 1000);
    pointerMove(viewport, 11, 'touch', 140, 130, 1016);
    expect(viewport.scrollLeft).toBe(160);
    expect(viewport.scrollTop).toBe(120);
    pointerUp(viewport, 11, 'touch', 140, 130, 1032);
    pointerMove(viewport, 11, 'touch', 180, 160, 1048);
    expect(viewport.scrollLeft).toBe(160);
    expect(viewport.scrollTop).toBe(120);
    expect(onPageChange).not.toHaveBeenCalled();
    expect(onActiveStrokeChange).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'lostcapture'])('ends a padding pan on %s without using terminal coordinates', (end) => {
    render(<InkPageView {...props()} />);
    mockCanvasRects();
    const viewport = screen.getByTestId('ink-page-viewport');
    viewport.scrollTop = 150;
    pointerDown(viewport, 11, 'touch', 100, 100, 1000);
    pointerMove(viewport, 11, 'touch', 100, 130, 1016);
    expect(viewport.scrollTop).toBe(120);
    if (end === 'cancel') pointerCancel(viewport, 11, 'touch', 0, 0, 1032);
    else fireEvent.lostPointerCapture(viewport, { pointerId: 11 });
    pointerMove(viewport, 11, 'touch', 100, 180, 1048);
    expect(viewport.scrollTop).toBe(120);
  });

  it('prioritizes a pen over padding pan and ignores old or new palm movement', async () => {
    const onPageChange = vi.fn(async (_next: InkPage) => undefined);
    render(<InkPageView {...props({ onPageChange })} />);
    const { overlay } = mockCanvasRects();
    const viewport = screen.getByTestId('ink-page-viewport');
    viewport.scrollTop = 150;
    pointerDown(viewport, 11, 'touch', 100, 100, 1000);
    pointerMove(viewport, 11, 'touch', 100, 130, 1016);
    expect(viewport.scrollTop).toBe(120);

    pointerDown(overlay, 7, 'pen', 110, 120, 1020);
    pointerMove(viewport, 11, 'touch', 100, 180, 1024);
    pointerDown(viewport, 12, 'touch', 100, 100, 1028);
    pointerMove(viewport, 12, 'touch', 100, 180, 1032);
    pointerCancel(viewport, 12, 'touch', 0, 0, 1036);
    pointerMove(overlay, 7, 'pen', 130, 140, 1040);
    pointerUp(overlay, 7, 'pen', 150, 160, 1056);
    await waitFor(() => expect(onPageChange).toHaveBeenCalledOnce());
    expect(savedSamples(onPageChange.mock.calls[0][0])).toHaveLength(3);
    pointerMove(viewport, 11, 'touch', 100, 240, 1060);
    pointerUp(viewport, 11, 'touch', 100, 240, 1064);
    expect(viewport.scrollTop).toBe(120);
    expect(onPageChange).toHaveBeenCalledOnce();
  });

  it('pans the viewport on both axes without stroke, active state, or save', async () => {
    const onPageChange = vi.fn(async (_next: InkPage) => undefined);
    const onActiveStrokeChange = vi.fn();
    render(<InkPageView {...props({ onPageChange, onActiveStrokeChange })} />);
    const { overlay } = mockCanvasRects();
    const viewport = screen.getByTestId('ink-page-viewport');
    viewport.scrollLeft = 200;
    viewport.scrollTop = 150;

    pointerDown(overlay, 11, 'touch', 100, 100, 1000);
    pointerMove(overlay, 11, 'touch', 140, 130, 1016);
    expect(viewport.scrollLeft).toBe(160);
    expect(viewport.scrollTop).toBe(120);

    pointerUp(overlay, 11, 'touch', 140, 130, 1032);
    pointerMove(overlay, 11, 'touch', 200, 200, 1048);
    expect(viewport.scrollLeft).toBe(160);
    expect(viewport.scrollTop).toBe(120);
    expect(onActiveStrokeChange).not.toHaveBeenCalled();
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it('clears a cancelled pan without jumping the viewport toward the cancel origin', () => {
    render(<InkPageView {...props()} />);
    const { overlay } = mockCanvasRects();
    const viewport = screen.getByTestId('ink-page-viewport');
    viewport.scrollLeft = 200;
    viewport.scrollTop = 150;

    pointerDown(overlay, 11, 'touch', 100, 100, 1000);
    pointerMove(overlay, 11, 'touch', 140, 130, 1016);
    expect(viewport.scrollLeft).toBe(160);
    expect(viewport.scrollTop).toBe(120);

    pointerCancel(overlay, 11, 'touch', 0, 0, 1032);
    expect(viewport.scrollLeft).toBe(160);
    expect(viewport.scrollTop).toBe(120);

    pointerMove(overlay, 11, 'touch', 60, 60, 1048);
    expect(viewport.scrollLeft).toBe(160);
    expect(viewport.scrollTop).toBe(120);
  });

  it('stops panning after pointerup and lost pointer capture', () => {
    render(<InkPageView {...props()} />);
    const { overlay } = mockCanvasRects();
    const viewport = screen.getByTestId('ink-page-viewport');
    viewport.scrollLeft = 200;
    viewport.scrollTop = 150;

    pointerDown(overlay, 11, 'touch', 100, 100, 1000);
    pointerMove(overlay, 11, 'touch', 140, 130, 1016);
    fireEvent.lostPointerCapture(overlay, { pointerId: 11 });
    pointerMove(overlay, 11, 'touch', 180, 160, 1032);
    expect(viewport.scrollLeft).toBe(160);
    expect(viewport.scrollTop).toBe(120);

    pointerUp(overlay, 11, 'touch', 180, 160, 1048);
    pointerDown(overlay, 12, 'touch', 100, 100, 1100);
    pointerMove(overlay, 12, 'touch', 120, 110, 1116);
    pointerUp(overlay, 12, 'touch', 120, 110, 1132);
    pointerMove(overlay, 12, 'touch', 200, 200, 1148);
    expect(viewport.scrollLeft).toBe(140);
    expect(viewport.scrollTop).toBe(110);
  });

  it('keeps the existing pan when an additional touch arrives (no pinch)', () => {
    render(<InkPageView {...props()} />);
    const { overlay } = mockCanvasRects();
    const viewport = screen.getByTestId('ink-page-viewport');
    viewport.scrollLeft = 200;
    viewport.scrollTop = 150;

    pointerDown(overlay, 11, 'touch', 100, 100, 1000);
    pointerMove(overlay, 11, 'touch', 140, 130, 1016);
    pointerDown(overlay, 12, 'touch', 300, 300, 1020);
    pointerMove(overlay, 12, 'touch', 360, 340, 1024);
    expect(viewport.scrollLeft).toBe(160);
    expect(viewport.scrollTop).toBe(120);

    pointerMove(overlay, 11, 'touch', 120, 110, 1032);
    expect(viewport.scrollLeft).toBe(180);
    expect(viewport.scrollTop).toBe(140);
  });

  it('lets a pen take over an active touch pan and ignores the stale touch afterwards', async () => {
    const onPageChange = vi.fn(async (_next: InkPage) => undefined);
    render(<InkPageView {...props({ onPageChange })} />);
    const { overlay } = mockCanvasRects();
    const viewport = screen.getByTestId('ink-page-viewport');
    viewport.scrollLeft = 200;
    viewport.scrollTop = 150;

    pointerDown(overlay, 11, 'touch', 100, 100, 1000);
    pointerMove(overlay, 11, 'touch', 140, 130, 1016);
    expect(viewport.scrollLeft).toBe(160);

    pointerDown(overlay, 7, 'pen', 110, 120, 1020);
    pointerMove(overlay, 7, 'pen', 130, 140, 1036);
    pointerUp(overlay, 7, 'pen', 150, 160, 1052);
    await waitFor(() => expect(onPageChange).toHaveBeenCalledOnce());
    expect(savedSamples(onPageChange.mock.calls[0][0])).toHaveLength(3);

    pointerMove(overlay, 11, 'touch', 180, 160, 1060);
    pointerUp(overlay, 11, 'touch', 180, 160, 1064);
    expect(viewport.scrollLeft).toBe(160);
    expect(viewport.scrollTop).toBe(120);
    expect(onPageChange).toHaveBeenCalledOnce();
  });

  it('does not let another touch truncate or take over an active pen stroke', async () => {
    const onPageChange = vi.fn(async (_next: InkPage) => undefined);
    render(<InkPageView {...props({ onPageChange })} />);
    const { overlay } = mockCanvasRects();
    const viewport = screen.getByTestId('ink-page-viewport');
    viewport.scrollLeft = 200;
    viewport.scrollTop = 150;

    pointerDown(overlay, 7, 'pen', 110, 120, 1000);
    pointerMove(overlay, 7, 'pen', 130, 140, 1016);
    pointerDown(overlay, 11, 'touch', 100, 100, 1020);
    pointerMove(overlay, 11, 'touch', 160, 150, 1024);
    pointerUp(overlay, 11, 'touch', 160, 150, 1028);
    pointerMove(overlay, 7, 'pen', 150, 160, 1036);
    pointerUp(overlay, 7, 'pen', 170, 180, 1052);

    await waitFor(() => expect(onPageChange).toHaveBeenCalledOnce());
    expect(savedSamples(onPageChange.mock.calls[0][0])).toHaveLength(4);
    expect(viewport.scrollLeft).toBe(200);
    expect(viewport.scrollTop).toBe(150);
  });
});

describe('InkPageView touch drawing and mode semantics', () => {
  it('draws normally with touch drawing enabled and never pans', async () => {
    const onPageChange = vi.fn(async (_next: InkPage) => undefined);
    const initial = props({ onPageChange });
    render(<InkPageView {...initial} tool={{ ...initial.tool, touchDrawing: true }} />);
    const { overlay } = mockCanvasRects();
    const viewport = screen.getByTestId('ink-page-viewport');
    viewport.scrollLeft = 200;
    viewport.scrollTop = 150;

    pointerDown(overlay, 11, 'touch', 110, 120, 1000);
    pointerMove(overlay, 11, 'touch', 130, 140, 1016);
    pointerUp(overlay, 11, 'touch', 150, 160, 1032);

    await waitFor(() => expect(onPageChange).toHaveBeenCalledOnce());
    expect(savedSamples(onPageChange.mock.calls[0][0])).toHaveLength(3);
    expect(viewport.scrollLeft).toBe(200);
    expect(viewport.scrollTop).toBe(150);
  });

  it('keeps selection cancellation and eraser cancellation semantics', async () => {
    const onSelectionChange = vi.fn();
    const onSelectionSave = vi.fn(async (_next: InkPage) => undefined);
    const selectionView = render(<InkPageView {...props({
      selectionMode: 'rectangle',
      onSelectionChange,
      onPageChange: onSelectionSave,
    })} />);
    const selectionCanvas = mockCanvasRects();
    pointerDown(selectionCanvas.overlay, 7, 'pen', 110, 120, 1000);
    pointerMove(selectionCanvas.overlay, 7, 'pen', 210, 220, 1016);
    pointerCancel(selectionCanvas.overlay, 7, 'pen', 0, 0, 1032);
    expect(onSelectionChange).toHaveBeenLastCalledWith(null);
    expect(onSelectionSave).not.toHaveBeenCalled();
    selectionView.unmount();

    const onPageChange = vi.fn(async (_next: InkPage) => undefined);
    const pageWithStroke: InkPage = { ...page, objects: [strokeObject('stroke-1', 200, 200)] };
    render(<InkPageView {...props({ page: pageWithStroke, erasing: true, onPageChange })} />);
    const eraserCanvas = mockCanvasRects();
    pointerDown(eraserCanvas.overlay, 9, 'pen', 110, 120, 2000);
    pointerCancel(eraserCanvas.overlay, 9, 'pen', 0, 0, 2016);

    await waitFor(() => expect(onPageChange).toHaveBeenCalledOnce());
    expect(onPageChange.mock.calls[0][0].objects).toHaveLength(0);
  });

  it('does not let touch take over an active eraser or selection gesture', async () => {
    const onPageChange = vi.fn(async (_next: InkPage) => undefined);
    const pageWithStroke: InkPage = { ...page, objects: [strokeObject('stroke-2', 200, 200)] };
    const eraserView = render(<InkPageView {...props({ page: pageWithStroke, erasing: true, onPageChange })} />);
    const eraserCanvas = mockCanvasRects();
    pointerDown(eraserCanvas.overlay, 9, 'pen', 110, 120, 1000);
    pointerDown(eraserCanvas.overlay, 11, 'touch', 120, 130, 1004);
    pointerMove(eraserCanvas.overlay, 11, 'touch', 160, 170, 1008);
    pointerUp(eraserCanvas.overlay, 11, 'touch', 160, 170, 1012);
    pointerUp(eraserCanvas.overlay, 9, 'pen', 110, 120, 1016);
    await waitFor(() => expect(onPageChange).toHaveBeenCalledOnce());
    expect(onPageChange.mock.calls[0][0].objects).toHaveLength(0);
    eraserView.unmount();

    const onSelectionChange = vi.fn();
    render(<InkPageView {...props({
      selectionMode: 'rectangle',
      onSelectionChange,
      onPageChange: vi.fn(async () => undefined),
    })} />);
    const selectionCanvas = mockCanvasRects();
    pointerDown(selectionCanvas.overlay, 7, 'pen', 110, 120, 2000);
    pointerMove(selectionCanvas.overlay, 7, 'pen', 210, 220, 2016);
    pointerDown(selectionCanvas.overlay, 11, 'touch', 120, 130, 2020);
    pointerMove(selectionCanvas.overlay, 11, 'touch', 160, 170, 2024);
    pointerUp(selectionCanvas.overlay, 11, 'touch', 160, 170, 2028);
    pointerUp(selectionCanvas.overlay, 7, 'pen', 210, 220, 2032);

    await waitFor(() => expect(onSelectionChange).toHaveBeenLastCalledWith(expect.objectContaining({
      polygon: expect.any(Array),
      bounds: expect.any(Object),
    })));
  });

  it('clears an active pan on page change and mode changes', () => {
    const initial = props();
    const { rerender } = render(<InkPageView {...initial} />);
    const { overlay } = mockCanvasRects();
    const viewport = screen.getByTestId('ink-page-viewport');
    viewport.scrollLeft = 200;
    viewport.scrollTop = 150;

    pointerDown(overlay, 11, 'touch', 100, 100, 1000);
    pointerMove(overlay, 11, 'touch', 140, 130, 1016);
    expect(viewport.scrollLeft).toBe(160);
    expect(viewport.scrollTop).toBe(120);

    rerender(<InkPageView {...initial} pageRef={{ ...pageRef, page_id: 'page-2' }} page={{ ...page, page_id: 'page-2' }} />);
    expect(viewport.scrollLeft).toBe(0);
    expect(viewport.scrollTop).toBe(0);
    pointerMove(overlay, 11, 'touch', 180, 160, 1032);
    expect(viewport.scrollLeft).toBe(0);
    expect(viewport.scrollTop).toBe(0);

    viewport.scrollLeft = 200;
    viewport.scrollTop = 150;
    pointerDown(overlay, 12, 'touch', 100, 100, 1100);
    pointerMove(overlay, 12, 'touch', 140, 130, 1116);
    expect(viewport.scrollLeft).toBe(160);
    rerender(<InkPageView {...initial} pageRef={{ ...pageRef, page_id: 'page-2' }} page={{ ...page, page_id: 'page-2' }} tool={{ ...initial.tool, touchDrawing: true }} />);
    pointerMove(overlay, 12, 'touch', 180, 160, 1132);
    expect(viewport.scrollLeft).toBe(160);
    expect(viewport.scrollTop).toBe(120);

    rerender(<InkPageView {...initial} pageRef={{ ...pageRef, page_id: 'page-2' }} page={{ ...page, page_id: 'page-2' }} tool={{ ...initial.tool, touchDrawing: false }} />);
    viewport.scrollLeft = 200;
    viewport.scrollTop = 150;
    pointerDown(overlay, 13, 'touch', 100, 100, 1200);
    pointerMove(overlay, 13, 'touch', 140, 130, 1216);
    expect(viewport.scrollLeft).toBe(160);
    rerender(<InkPageView {...initial} pageRef={{ ...pageRef, page_id: 'page-2' }} page={{ ...page, page_id: 'page-2' }} selectionMode="rectangle" />);
    pointerMove(overlay, 13, 'touch', 180, 160, 1232);
    expect(viewport.scrollLeft).toBe(160);
    expect(viewport.scrollTop).toBe(120);
  });

  it('clears an active pan when the document changes', () => {
    const initial = props();
    const { rerender } = render(<InkPageView {...initial} />);
    const { overlay } = mockCanvasRects();
    const viewport = screen.getByTestId('ink-page-viewport');
    viewport.scrollLeft = 200;
    viewport.scrollTop = 150;

    pointerDown(overlay, 11, 'touch', 100, 100, 1000);
    pointerMove(overlay, 11, 'touch', 140, 130, 1016);
    expect(viewport.scrollLeft).toBe(160);
    expect(viewport.scrollTop).toBe(120);

    rerender(<InkPageView {...initial} documentId="document-2" />);
    expect(viewport.scrollLeft).toBe(0);
    expect(viewport.scrollTop).toBe(0);
    pointerMove(overlay, 11, 'touch', 180, 160, 1032);
    expect(viewport.scrollLeft).toBe(0);
    expect(viewport.scrollTop).toBe(0);
  });

  it('keeps the drawing surface and overlay at touch-action none in every mode', () => {
    const initial = props();
    const { rerender, unmount } = render(<InkPageView {...initial} />);
    const assertFixedNone = () => {
      const surface = screen.getByTestId('ink-page-surface');
      const overlay = screen.getByTestId('ink-active-stroke-canvas');
      expect(surface.style.touchAction).toBe('none');
      expect(overlay.style.touchAction).toBe('none');
      expect(overlay).not.toHaveClass('touch-pan-y');
    };

    assertFixedNone();
    rerender(<InkPageView {...initial} tool={{ ...initial.tool, touchDrawing: true }} />);
    assertFixedNone();
    rerender(<InkPageView {...initial} tool={{ ...initial.tool, touchDrawing: false }} selectionMode="rectangle" />);
    assertFixedNone();
    unmount();
  });
});
