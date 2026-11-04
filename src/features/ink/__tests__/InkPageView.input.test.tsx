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
