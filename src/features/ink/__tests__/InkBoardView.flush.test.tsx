import React, { createRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InkBoardView, type InkBoardViewHandle, type InkBoardViewProps } from '../InkBoardView';
import type { InkBoardObject } from '../types';

vi.mock('../boardRenderer', () => ({ renderInkBoard: vi.fn() }));

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly pressure: number;

  constructor(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string; pressure?: number } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'pen';
    this.pressure = init.pressure ?? 0.5;
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const object: InkBoardObject = {
  id: 'stroke-1',
  author: 'user',
  created_at: 1,
  z_index: 0,
  content: {
    kind: 'stroke',
    samples: [
      { x: 10, y: 10, pressure: 0.5, elapsed_ms: 0 },
      { x: 30, y: 30, pressure: 0.5, elapsed_ms: 4 },
    ],
    style: { tool: 'pen', color: '#000000', width: 2, pressure_enabled: true },
  },
};

function props(overrides: Partial<InkBoardViewProps> = {}): InkBoardViewProps {
  return {
    surface: {
      kind: 'board', page_id: 'page-1', ruling: 'blank',
      bounds: { x: -1000, y: -1000, width: 2000, height: 2000 },
    },
    objects: [],
    camera: { x: 0, y: 0, zoom: 1 },
    tool: { tool: 'pen', color: '#000000', width: 2, eraserSize: 16, touchDrawing: false },
    erasing: false,
    selectionMode: 'none',
    selection: null,
    spaceDown: false,
    ariaLabel: 'Board',
    onCameraChange: vi.fn(),
    onCommitStroke: vi.fn(),
    onErase: vi.fn(),
    onSelectionChange: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

function startGesture() {
  const canvas = screen.getByTestId('ink-board-canvas');
  fireEvent.pointerDown(canvas, { pointerId: 7, pointerType: 'pen', button: 0, buttons: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(canvas, { pointerId: 7, pointerType: 'pen', buttons: 1, clientX: 30, clientY: 30 });
  return canvas;
}

beforeEach(() => {
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('InkBoardView host flush boundary', () => {
  it('finishes an unlifted stroke once and awaits its commit', async () => {
    const gate = deferred();
    const onCommitStroke = vi.fn((_content: Parameters<InkBoardViewProps['onCommitStroke']>[0]) => gate.promise);
    const ref = createRef<InkBoardViewHandle>();
    render(<InkBoardView ref={ref} {...props({ onCommitStroke })} />);
    const canvas = startGesture();
    let finished = false;
    let pending!: Promise<void>;
    act(() => { pending = ref.current!.finishStroke().then(() => { finished = true; }); });
    expect(onCommitStroke).toHaveBeenCalledOnce();
    expect(onCommitStroke.mock.calls[0][0].samples).toHaveLength(2);
    await act(async () => undefined);
    expect(finished).toBe(false);
    await act(async () => { gate.resolve(); await pending; });
    fireEvent.pointerUp(canvas, { pointerId: 7, pointerType: 'pen', button: 0, clientX: 30, clientY: 30 });
    expect(onCommitStroke).toHaveBeenCalledOnce();
  });

  it('waits for a stroke commit already started by pointerup', async () => {
    const gate = deferred();
    const onCommitStroke = vi.fn((_content: Parameters<InkBoardViewProps['onCommitStroke']>[0]) => gate.promise);
    const ref = createRef<InkBoardViewHandle>();
    render(<InkBoardView ref={ref} {...props({ onCommitStroke })} />);
    const canvas = startGesture();
    fireEvent.pointerUp(canvas, { pointerId: 7, pointerType: 'pen', button: 0, clientX: 30, clientY: 30 });
    let finished = false;
    let pending!: Promise<void>;
    act(() => { pending = ref.current!.finishStroke().then(() => { finished = true; }); });
    await act(async () => undefined);
    expect(finished).toBe(false);
    await act(async () => { gate.resolve(); await pending; });
    expect(onCommitStroke).toHaveBeenCalledOnce();
  });

  it('finishes an unlifted eraser and awaits the removal', async () => {
    const gate = deferred();
    const onErase = vi.fn(() => gate.promise);
    const ref = createRef<InkBoardViewHandle>();
    render(<InkBoardView ref={ref} {...props({ objects: [object], erasing: true, onErase })} />);
    const canvas = startGesture();
    let finished = false;
    let pending!: Promise<void>;
    act(() => { pending = ref.current!.finishStroke().then(() => { finished = true; }); });
    expect(onErase).toHaveBeenCalledWith(['stroke-1']);
    await act(async () => undefined);
    expect(finished).toBe(false);
    await act(async () => { gate.resolve(); await pending; });
    fireEvent.pointerUp(canvas, { pointerId: 7, pointerType: 'pen', button: 0, clientX: 30, clientY: 30 });
    expect(onErase).toHaveBeenCalledOnce();
  });

  it('finishes an OS-cancelled stroke without appending cancellation coordinates', async () => {
    const onCommitStroke = vi.fn<InkBoardViewProps['onCommitStroke']>();
    render(<InkBoardView {...props({ onCommitStroke })} />);
    const canvas = startGesture();
    fireEvent.pointerCancel(canvas, { pointerId: 7, pointerType: 'pen' });
    await act(async () => undefined);

    expect(onCommitStroke).toHaveBeenCalledOnce();
    expect(onCommitStroke.mock.calls[0][0].samples).toMatchObject([
      { x: 10, y: 10, pressure: 0.5 },
      { x: 30, y: 30, pressure: 0.5 },
    ]);
    fireEvent.pointerUp(canvas, { pointerId: 7, pointerType: 'pen', button: 0, clientX: 30, clientY: 30 });
    expect(onCommitStroke).toHaveBeenCalledOnce();
  });

  it('waits for an eraser removal already started by pointerup', async () => {
    const gate = deferred();
    const onErase = vi.fn(() => gate.promise);
    const ref = createRef<InkBoardViewHandle>();
    render(<InkBoardView ref={ref} {...props({ objects: [object], erasing: true, onErase })} />);
    const canvas = startGesture();
    fireEvent.pointerUp(canvas, { pointerId: 7, pointerType: 'pen', button: 0, clientX: 30, clientY: 30 });
    let finished = false;
    let pending!: Promise<void>;
    act(() => { pending = ref.current!.finishStroke().then(() => { finished = true; }); });
    await act(async () => undefined);
    expect(finished).toBe(false);
    await act(async () => { gate.resolve(); await pending; });
    expect(onErase).toHaveBeenCalledOnce();
  });
});
