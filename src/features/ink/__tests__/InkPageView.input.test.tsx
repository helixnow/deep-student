import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InkPageView, type InkPageViewProps } from '../InkPageView';
import { renderInkPage } from '../renderer';

vi.mock('../renderer', () => ({ renderInkPage: vi.fn() }));

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly pressure: number;

  constructor(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string; pressure?: number } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 7;
    this.pointerType = init.pointerType ?? 'pen';
    this.pressure = init.pressure ?? 0.5;
  }
}

function props(overrides: Partial<InkPageViewProps> = {}): InkPageViewProps {
  return {
    documentId: 'document-1',
    pageRef: {
      page_id: 'page-1', width: 200, height: 160,
      background: { kind: 'blank', ruling: 'blank' }, page_blob_hash: 'page-hash',
    },
    page: { schema_version: 1, page_id: 'page-1', objects: [] },
    tool: {
      tool: 'pen', color: '#000000', width: 4, pressure_enabled: true,
      touchDrawing: true, zoom: 1, panX: 0, panY: 0, eraserSize: 16,
    },
    erasing: false,
    onPageChange: vi.fn(async () => undefined),
    ariaLabel: 'Ink page',
    ...overrides,
  };
}

function inputCanvas() {
  const bounds = { left: 40, top: 60, width: 200, height: 160, right: 240, bottom: 220, x: 40, y: 60, toJSON: () => ({}) };
  const canvas = screen.getByTestId('ink-page-canvas');
  const input = screen.getByTestId('ink-active-stroke-canvas');
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(bounds);
  vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(bounds);
  return input;
}

beforeEach(() => {
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.mocked(renderInkPage).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('InkPageView pointer samples', () => {
  it.each(['pen', 'touch', 'mouse'])('starts a %s stroke at the pointer without an origin sample', (pointerType) => {
    render(<InkPageView {...props()} />);
    const input = inputCanvas();
    fireEvent.pointerDown(input, { pointerType, clientX: 160, clientY: 140, buttons: 1 });

    const preview = vi.mocked(renderInkPage).mock.calls.at(-1);
    expect(preview?.[0]).toBe(input);
    expect(preview?.[2].objects[0].content).toMatchObject({
      kind: 'stroke', samples: [{ x: 120, y: 80, pressure: 0.5, elapsed_ms: 0 }],
    });
    expect(preview?.[3]).toMatchObject({ transparent: true });
  });

  it.each([false, true])('keeps the last pen sample on cancellation without an origin ray (moved: %s)', async (moved) => {
    const onPageChange = vi.fn<InkPageViewProps['onPageChange']>(async () => undefined);
    const onActiveStrokeChange = vi.fn();
    render(<InkPageView {...props({ onPageChange, onActiveStrokeChange })} />);
    const input = inputCanvas();
    const samples = [{ x: 120, y: 80, pressure: 0.5 }];
    fireEvent.pointerDown(input, { clientX: 160, clientY: 140, buttons: 1 });
    if (moved) {
      fireEvent.pointerMove(input, { clientX: 180, clientY: 160, buttons: 1 });
      samples.push({ x: 140, y: 100, pressure: 0.5 });
    }
    fireEvent.pointerCancel(input);
    await act(async () => undefined);

    expect(onPageChange).toHaveBeenCalledOnce();
    expect(onPageChange.mock.calls[0][0].objects[0].content).toMatchObject({ kind: 'stroke', samples });
    expect(onActiveStrokeChange.mock.calls).toEqual([[true], [false]]);
    fireEvent.pointerUp(input, { clientX: 180, clientY: 160 });
    expect(onPageChange).toHaveBeenCalledOnce();

    fireEvent.pointerDown(input, { clientX: 80, clientY: 100, buttons: 1 });
    const preview = vi.mocked(renderInkPage).mock.calls.at(-1);
    expect(preview?.[2].objects[0].content).toMatchObject({
      kind: 'stroke', samples: [{ x: 40, y: 40, pressure: 0.5, elapsed_ms: 0 }],
    });
  });

  it.each(['before', 'after'])('lets the pen take over palm input without committing the touch (cancel %s pen up)', async (cancelTouch) => {
    const onPageChange = vi.fn<InkPageViewProps['onPageChange']>(async () => undefined);
    render(<InkPageView {...props({ onPageChange })} />);
    const input = inputCanvas();
    fireEvent.pointerDown(input, { pointerId: 9, pointerType: 'touch', clientX: 180, clientY: 180, buttons: 1 });
    fireEvent.pointerMove(input, { pointerId: 9, pointerType: 'touch', clientX: 200, clientY: 200, buttons: 1 });
    fireEvent.pointerDown(input, { pointerId: 7, pointerType: 'pen', clientX: 80, clientY: 100, buttons: 1 });
    expect(onPageChange).not.toHaveBeenCalled();
    if (cancelTouch === 'before') fireEvent.pointerCancel(input, { pointerId: 9, pointerType: 'touch' });
    fireEvent(input, new TestPointerEvent('lostpointercapture', { bubbles: true, pointerId: 9, pointerType: 'touch' }));
    fireEvent.pointerMove(input, { pointerId: 7, pointerType: 'pen', clientX: 100, clientY: 120, buttons: 1 });
    fireEvent.pointerUp(input, { pointerId: 7, pointerType: 'pen', clientX: 120, clientY: 140 });
    fireEvent.pointerCancel(input, { pointerId: 9, pointerType: 'touch' });
    await act(async () => undefined);

    expect(onPageChange).toHaveBeenCalledOnce();
    expect(onPageChange.mock.calls[0][0].objects).toHaveLength(1);
    expect(onPageChange.mock.calls[0][0].objects[0].content).toMatchObject({
      kind: 'stroke',
      samples: [{ x: 40, y: 40 }, { x: 60, y: 60 }, { x: 80, y: 80 }],
      style: { pressure_enabled: true },
    });
  });

  it.each(['document', 'page'])('does not move an active stroke into another %s after palm takeover', async (navigation) => {
    const oldChange = vi.fn<InkPageViewProps['onPageChange']>(async () => undefined);
    const nextChange = vi.fn<InkPageViewProps['onPageChange']>(async () => undefined);
    const initial = props({ onPageChange: oldChange });
    const { rerender } = render(<InkPageView {...initial} />);
    const input = inputCanvas();
    fireEvent.pointerDown(input, { pointerId: 9, pointerType: 'touch', clientX: 180, clientY: 180, buttons: 1 });
    fireEvent.pointerDown(input, { pointerId: 7, pointerType: 'pen', clientX: 80, clientY: 100, buttons: 1 });
    fireEvent.pointerMove(input, { pointerId: 7, pointerType: 'pen', clientX: 100, clientY: 120, buttons: 1 });
    const nextPageId = navigation === 'page' ? 'page-2' : initial.page.page_id;
    rerender(<InkPageView
      {...initial}
      documentId={navigation === 'document' ? 'document-2' : initial.documentId}
      pageRef={{ ...initial.pageRef, page_id: nextPageId }}
      page={{ ...initial.page, page_id: nextPageId }}
      onPageChange={nextChange}
    />);
    fireEvent.pointerMove(input, { pointerId: 7, pointerType: 'pen', clientX: 120, clientY: 140, buttons: 1 });
    fireEvent.pointerUp(input, { pointerId: 7, pointerType: 'pen', clientX: 140, clientY: 160 });
    fireEvent.pointerCancel(input, { pointerId: 9, pointerType: 'touch' });
    await act(async () => undefined);
    expect(oldChange).not.toHaveBeenCalled();
    expect(nextChange).not.toHaveBeenCalled();

    fireEvent.pointerDown(input, { pointerId: 8, pointerType: 'pen', clientX: 160, clientY: 80, buttons: 1 });
    fireEvent.pointerUp(input, { pointerId: 8, pointerType: 'pen', clientX: 180, clientY: 100 });
    expect(nextChange).toHaveBeenCalledOnce();
    expect(nextChange.mock.calls[0][0]).toMatchObject({
      page_id: nextPageId,
      objects: [{ content: { kind: 'stroke', samples: [{ x: 120, y: 20 }, { x: 140, y: 40 }] } }],
    });
  });

  it('paints a finished stroke on the main canvas before a delayed page callback completes', async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => { resolve = done; });
    const onPageChange = vi.fn<InkPageViewProps['onPageChange']>(() => pending);
    render(<InkPageView {...props({ onPageChange })} />);
    const input = inputCanvas();
    const main = screen.getByTestId('ink-page-canvas');
    fireEvent.pointerDown(input, { clientX: 80, clientY: 100, buttons: 1 });
    fireEvent.pointerUp(input, { clientX: 100, clientY: 120 });

    const mainFrame = vi.mocked(renderInkPage).mock.calls.filter(([target]) => target === main).at(-1);
    expect(mainFrame?.[2].objects).toHaveLength(1);
    expect(mainFrame?.[2]).toBe(onPageChange.mock.calls[0][0]);
    const clear = vi.mocked(input.getContext('2d')!.clearRect);
    const paintOrder = vi.mocked(renderInkPage).mock.invocationCallOrder.at(-1)!;
    expect(paintOrder).toBeLessThan(clear.mock.invocationCallOrder.at(-1)!);
    await act(async () => { resolve(); await pending; });
  });

  it('keeps rapid strokes across old-prop rerenders and delayed acknowledgements', async () => {
    const onPageChange = vi.fn<InkPageViewProps['onPageChange']>(() => new Promise(() => {}));
    const initial = props({ onPageChange });
    const { rerender } = render(<InkPageView {...initial} />);
    const input = inputCanvas();
    const main = screen.getByTestId('ink-page-canvas');
    const draw = (x: number) => {
      fireEvent.pointerDown(input, { clientX: x, clientY: 100, buttons: 1 });
      fireEvent.pointerUp(input, { clientX: x + 10, clientY: 110 });
    };
    draw(60);
    rerender(<InkPageView {...initial} tool={{ ...initial.tool }} />);
    draw(90);
    const firstPage = onPageChange.mock.calls[0][0];
    const secondPage = onPageChange.mock.calls[1][0];
    expect(secondPage.objects).toHaveLength(2);

    rerender(<InkPageView {...initial} page={firstPage} />);
    const mainFrame = vi.mocked(renderInkPage).mock.calls.filter(([target]) => target === main).at(-1);
    expect(mainFrame?.[2]).toBe(secondPage);
    draw(120);
    const thirdPage = onPageChange.mock.calls[2][0];
    expect(thirdPage.objects).toHaveLength(3);

    rerender(<InkPageView {...initial} page={thirdPage} />);
    rerender(<InkPageView {...initial} page={secondPage} />);
    draw(150);
    expect(onPageChange.mock.calls[3][0].objects).toHaveLength(3);
  });

  it('discards pending local pages on document navigation or an external page replacement', () => {
    const onPageChange = vi.fn<InkPageViewProps['onPageChange']>(() => new Promise(() => {}));
    const initial = props({ onPageChange });
    const { rerender } = render(<InkPageView {...initial} />);
    const input = inputCanvas();
    const draw = () => {
      fireEvent.pointerDown(input, { clientX: 80, clientY: 100, buttons: 1 });
      fireEvent.pointerUp(input, { clientX: 100, clientY: 120 });
    };
    draw();
    rerender(<InkPageView {...initial} documentId="document-2" />);
    draw();
    expect(onPageChange.mock.calls[1][0].objects).toHaveLength(1);
    rerender(<InkPageView {...initial} documentId="document-2" page={{ ...initial.page, objects: [] }} />);
    draw();
    expect(onPageChange.mock.calls[2][0].objects).toHaveLength(1);
  });

  it('finishes lost capture at the last sample and accepts the next stroke', async () => {
    const onPageChange = vi.fn<InkPageViewProps['onPageChange']>(async () => undefined);
    render(<InkPageView {...props({ onPageChange })} />);
    const input = inputCanvas();
    const capture = vi.spyOn(input, 'setPointerCapture');
    fireEvent.pointerDown(input, { clientX: 80, clientY: 100, buttons: 1 });
    fireEvent.pointerMove(input, { clientX: 100, clientY: 120, buttons: 1 });
    expect(capture).toHaveBeenCalledWith(7);
    fireEvent(input, new TestPointerEvent('lostpointercapture', { bubbles: true }));
    await act(async () => undefined);
    expect(onPageChange).toHaveBeenCalledOnce();
    expect(onPageChange.mock.calls[0][0].objects[0].content).toMatchObject({
      kind: 'stroke', samples: [{ x: 40, y: 40 }, { x: 60, y: 60 }],
    });
    fireEvent.pointerDown(input, { clientX: 120, clientY: 140, buttons: 1 });
    fireEvent.pointerUp(input, { clientX: 140, clientY: 160 });
    expect(onPageChange).toHaveBeenCalledTimes(2);
    expect(onPageChange.mock.calls[1][0].objects).toHaveLength(2);
  });

  it('preserves the final pointerup endpoint', async () => {
    const onPageChange = vi.fn<InkPageViewProps['onPageChange']>(async () => undefined);
    render(<InkPageView {...props({ onPageChange })} />);
    const input = inputCanvas();
    fireEvent.pointerDown(input, { clientX: 160, clientY: 140, buttons: 1 });
    fireEvent.pointerMove(input, { clientX: 180, clientY: 160, buttons: 1 });
    fireEvent.pointerUp(input, { clientX: 200, clientY: 180 });
    await act(async () => undefined);

    expect(onPageChange.mock.calls[0][0].objects[0].content).toMatchObject({
      kind: 'stroke',
      samples: [
        { x: 120, y: 80 },
        { x: 140, y: 100 },
        { x: 160, y: 120 },
      ],
    });
  });
});
