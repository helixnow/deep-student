import React, { createRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InkBoardView, type InkBoardViewHandle, type InkBoardViewProps } from '../InkBoardView';
import type { InkBoardObject } from '../types';
import { renderInkBoard } from '../boardRenderer';

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
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return {
      clearRect: () => { renderInkBoard(this, props().surface, [], props().camera, { transparent: true }); },
    } as unknown as CanvasRenderingContext2D;
  });
  vi.mocked(renderInkBoard).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('InkBoardView host flush boundary', () => {
  it.each(['pointerup', 'pointercancel', 'lostpointercapture', 'flush'] as const)('reports a pen stroke as active through its pending %s commit', async (terminal) => {
    const gate = deferred();
    const onActiveStrokeChange = vi.fn();
    const onCommitStroke = vi.fn<InkBoardViewProps['onCommitStroke']>(() => gate.promise);
    const ref = createRef<InkBoardViewHandle>();
    render(<InkBoardView ref={ref} {...props({ onActiveStrokeChange, onCommitStroke })} />);
    const canvas = startGesture();
    expect(onActiveStrokeChange.mock.calls).toEqual([[true]]);
    let pending: Promise<void> | undefined;
    if (terminal === 'flush') {
      act(() => { pending = ref.current!.finishStroke(); });
    } else {
      fireEvent(canvas, new TestPointerEvent(terminal, { bubbles: true, pointerId: 7, clientX: 40, clientY: 40 }));
    }
    await act(async () => undefined);
    expect(onActiveStrokeChange.mock.calls).toEqual([[true]]);
    await act(async () => { gate.resolve(); await pending; });
    expect(onActiveStrokeChange.mock.calls).toEqual([[true], [false]]);
  });

  it('does not clear a newer active stroke when an older commit resolves', async () => {
    const first = deferred();
    const second = deferred();
    const onActiveStrokeChange = vi.fn();
    const onCommitStroke = vi.fn<InkBoardViewProps['onCommitStroke']>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    render(<InkBoardView {...props({ onActiveStrokeChange, onCommitStroke })} />);
    const canvas = startGesture();
    fireEvent.pointerUp(canvas, { pointerId: 7, clientX: 40, clientY: 40 });
    fireEvent.pointerDown(canvas, { pointerId: 8, buttons: 1, clientX: 60, clientY: 60 });
    await act(async () => { first.resolve(); await first.promise; });
    expect(onActiveStrokeChange.mock.calls).toEqual([[true]]);
    fireEvent.pointerUp(canvas, { pointerId: 8, clientX: 80, clientY: 80 });
    await act(async () => { second.resolve(); await second.promise; });
    expect(onActiveStrokeChange.mock.calls).toEqual([[true], [false]]);
  });

  it('keeps rejected input active until a host retry succeeds', async () => {
    const onActiveStrokeChange = vi.fn();
    const onCommitStroke = vi.fn<InkBoardViewProps['onCommitStroke']>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(undefined);
    const ref = createRef<InkBoardViewHandle>();
    render(<InkBoardView ref={ref} {...props({ onActiveStrokeChange, onCommitStroke })} />);
    const canvas = startGesture();
    fireEvent.pointerUp(canvas, { pointerId: 7, clientX: 40, clientY: 40 });
    await act(async () => undefined);
    expect(onActiveStrokeChange.mock.calls).toEqual([[true]]);
    await act(async () => { await ref.current!.finishStroke(); });
    expect(onActiveStrokeChange.mock.calls).toEqual([[true], [false]]);
  });

  it('reports erasing as active through delayed removal, but not after an empty sweep', async () => {
    const gate = deferred();
    const onActiveStrokeChange = vi.fn();
    const onErase = vi.fn(() => gate.promise);
    render(<InkBoardView {...props({ objects: [object], erasing: true, onActiveStrokeChange, onErase })} />);
    const canvas = startGesture();
    expect(onActiveStrokeChange.mock.calls).toEqual([[true]]);
    fireEvent.pointerUp(canvas, { pointerId: 7, clientX: 40, clientY: 40 });
    await act(async () => undefined);
    expect(onActiveStrokeChange.mock.calls).toEqual([[true]]);
    await act(async () => { gate.resolve(); await gate.promise; });
    expect(onActiveStrokeChange.mock.calls).toEqual([[true], [false]]);
    fireEvent.pointerDown(canvas, { pointerId: 8, buttons: 1, clientX: 500, clientY: 500 });
    fireEvent.pointerUp(canvas, { pointerId: 8, clientX: 520, clientY: 520 });
    expect(onActiveStrokeChange.mock.calls).toEqual([[true], [false], [true], [false]]);
    expect(onErase).toHaveBeenCalledOnce();
  });

  it('notifies the latest active-input callback without clearing unfinished input on unmount', async () => {
    const firstCallback = vi.fn();
    const latestCallback = vi.fn();
    const initial = props({ onActiveStrokeChange: firstCallback });
    const { rerender, unmount } = render(<InkBoardView {...initial} />);
    const canvas = startGesture();
    expect(firstCallback.mock.calls).toEqual([[true]]);
    rerender(<InkBoardView {...initial} onActiveStrokeChange={latestCallback} />);
    fireEvent.pointerUp(canvas, { pointerId: 7, clientX: 40, clientY: 40 });
    await act(async () => undefined);
    expect(latestCallback.mock.calls).toEqual([[false]]);
    fireEvent.pointerDown(canvas, { pointerId: 8, buttons: 1, clientX: 60, clientY: 60 });
    expect(latestCallback.mock.calls).toEqual([[false], [true]]);
    unmount();
    expect(latestCallback.mock.calls).toEqual([[false], [true]]);
  });

  it('reports pinch cancellation without marking navigation or selection as dirty input', async () => {
    const onActiveStrokeChange = vi.fn();
    const initial = props({ onActiveStrokeChange });
    const { rerender } = render(<InkBoardView {...initial} />);
    const canvas = screen.getByTestId('ink-board-canvas');
    fireEvent.pointerDown(canvas, { pointerId: 9, pointerType: 'touch', buttons: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(canvas, { pointerId: 9, pointerType: 'touch', clientX: 30, clientY: 30 });
    expect(onActiveStrokeChange).not.toHaveBeenCalled();
    rerender(<InkBoardView {...initial} selectionMode="rectangle" />);
    startGesture();
    fireEvent.pointerUp(canvas, { pointerId: 7, clientX: 40, clientY: 40 });
    expect(onActiveStrokeChange).not.toHaveBeenCalled();
    rerender(<InkBoardView {...initial} tool={{ ...initial.tool, touchDrawing: true }} />);
    fireEvent.pointerDown(canvas, { pointerId: 9, pointerType: 'touch', buttons: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerDown(canvas, { pointerId: 10, pointerType: 'touch', buttons: 1, clientX: 80, clientY: 80 });
    await act(async () => undefined);
    expect(onActiveStrokeChange.mock.calls).toEqual([[true], [false]]);
    expect(initial.onCommitStroke).not.toHaveBeenCalled();
  });

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

  it('keeps finished ink visible through delayed commits and a second active stroke', async () => {
    const first = deferred();
    const second = deferred();
    const onCommitStroke = vi.fn<InkBoardViewProps['onCommitStroke']>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const initial = props({ onCommitStroke });
    const { rerender } = render(<InkBoardView {...initial} />);
    const canvas = startGesture();
    const overlay = screen.getByTestId('ink-board-active-stroke-canvas');
    fireEvent.pointerUp(canvas, { pointerId: 7, clientX: 30, clientY: 30 });
    const content = onCommitStroke.mock.calls[0][0];
    const visibleContents = () => [canvas, overlay].flatMap((target) => {
      const call = vi.mocked(renderInkBoard).mock.calls.filter(([element]) => element === target).at(-1);
      return call?.[2].map((item) => item.content) ?? [];
    });
    expect(visibleContents()).toContainEqual(content);

    rerender(<InkBoardView {...initial} objects={[...initial.objects]} />);
    fireEvent.pointerDown(canvas, { pointerId: 8, button: 0, buttons: 1, clientX: 60, clientY: 60 });
    fireEvent.pointerMove(canvas, { pointerId: 8, buttons: 1, clientX: 80, clientY: 80 });
    expect(visibleContents()).toHaveLength(2);
    expect(visibleContents()).toContainEqual(content);
    await act(async () => { first.resolve(); await first.promise; });
    expect(visibleContents()).toHaveLength(2);

    rerender(<InkBoardView {...initial} objects={[{ ...object, content }]} />);
    expect(visibleContents()).toHaveLength(2);
    fireEvent.pointerUp(canvas, { pointerId: 8, clientX: 90, clientY: 90 });
    expect(onCommitStroke).toHaveBeenCalledTimes(2);
    expect(onCommitStroke.mock.calls[1][0].samples).toMatchObject([
      { x: 60, y: 60 }, { x: 80, y: 80 }, { x: 90, y: 90 },
    ]);
    expect(visibleContents()).toHaveLength(2);
    await act(async () => { second.resolve(); await second.promise; });
  });

  it('keeps rejected input separate from the next stroke and retries it on host flush', async () => {
    let reject!: (error: Error) => void;
    const failed = new Promise<void>((_resolve, fail) => { reject = fail; });
    const onCommitStroke = vi.fn<InkBoardViewProps['onCommitStroke']>()
      .mockImplementationOnce(() => failed)
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const ref = createRef<InkBoardViewHandle>();
    render(<InkBoardView ref={ref} {...props({ onCommitStroke, onError })} />);
    const canvas = startGesture();
    fireEvent.pointerUp(canvas, { pointerId: 7, clientX: 30, clientY: 30 });
    const first = onCommitStroke.mock.calls[0][0];
    fireEvent.pointerDown(canvas, { pointerId: 8, button: 0, buttons: 1, clientX: 60, clientY: 60 });
    fireEvent.pointerMove(canvas, { pointerId: 8, buttons: 1, clientX: 80, clientY: 80 });
    await act(async () => { reject(new Error('Delayed rejection')); await failed.catch(() => undefined); });
    expect(onError).toHaveBeenCalledOnce();
    fireEvent.pointerUp(canvas, { pointerId: 8, clientX: 90, clientY: 90 });
    expect(onCommitStroke).toHaveBeenCalledTimes(2);
    expect(onCommitStroke.mock.calls[1][0].samples[0]).toMatchObject({ x: 60, y: 60 });
    await act(async () => { await ref.current!.finishStroke(); });
    expect(onCommitStroke).toHaveBeenCalledTimes(3);
    expect(onCommitStroke.mock.calls[2][0]).toBe(first);
  });

  it('blocks a rejected host flush and retries with the latest callback', async () => {
    const onError = vi.fn();
    const onCommitStroke = vi.fn<InkBoardViewProps['onCommitStroke']>().mockResolvedValue(false);
    const initial = props({ onCommitStroke, onError });
    const ref = createRef<InkBoardViewHandle>();
    const { rerender } = render(<InkBoardView ref={ref} {...initial} />);
    startGesture();
    await act(async () => { await expect(ref.current!.finishStroke()).rejects.toThrow('not queued'); });
    expect(onError).toHaveBeenCalledOnce();
    const replacement = vi.fn<InkBoardViewProps['onCommitStroke']>();
    rerender(<InkBoardView ref={ref} {...initial} onCommitStroke={replacement} />);
    await act(async () => { await ref.current!.finishStroke(); });
    expect(replacement).toHaveBeenCalledOnce();
    expect(replacement.mock.calls[0][0]).toBe(onCommitStroke.mock.calls[0][0]);
  });

  it('promotes two touch pointers to a captured pinch without committing their draft stroke', async () => {
    const onCommitStroke = vi.fn<InkBoardViewProps['onCommitStroke']>();
    const onCameraChange = vi.fn();
    const initial = props({ onCommitStroke, onCameraChange });
    render(<InkBoardView {...initial} tool={{ ...initial.tool, touchDrawing: true }} />);
    const canvas = screen.getByTestId('ink-board-canvas');
    const capture = vi.spyOn(canvas, 'setPointerCapture');
    fireEvent.pointerDown(canvas, { pointerId: 7, pointerType: 'touch', buttons: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { pointerId: 7, pointerType: 'touch', buttons: 1, clientX: 30, clientY: 30 });
    fireEvent.pointerDown(canvas, { pointerId: 8, pointerType: 'touch', buttons: 1, clientX: 80, clientY: 80 });
    expect(capture).toHaveBeenCalledWith(7);
    expect(capture).toHaveBeenCalledWith(8);
    fireEvent.pointerMove(canvas, { pointerId: 8, pointerType: 'touch', buttons: 1, clientX: 100, clientY: 100 });
    expect(onCameraChange).toHaveBeenCalledOnce();
    fireEvent.pointerUp(canvas, { pointerId: 7, pointerType: 'touch', clientX: 30, clientY: 30 });
    fireEvent.pointerUp(canvas, { pointerId: 8, pointerType: 'touch', clientX: 100, clientY: 100 });
    await act(async () => undefined);
    expect(onCommitStroke).not.toHaveBeenCalled();
  });

  it('ignores palm contact without discarding or overwriting an active pen stroke', async () => {
    const onCommitStroke = vi.fn<InkBoardViewProps['onCommitStroke']>();
    const onCameraChange = vi.fn();
    render(<InkBoardView {...props({ onCommitStroke, onCameraChange })} />);
    const canvas = startGesture();
    fireEvent.pointerDown(canvas, { pointerId: 9, pointerType: 'touch', buttons: 1, clientX: 70, clientY: 70 });
    fireEvent.pointerMove(canvas, { pointerId: 9, pointerType: 'touch', buttons: 1, clientX: 90, clientY: 90 });
    fireEvent.pointerMove(canvas, { pointerId: 7, pointerType: 'pen', buttons: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerUp(canvas, { pointerId: 7, pointerType: 'pen', clientX: 60, clientY: 60 });
    await act(async () => undefined);
    expect(onCommitStroke).toHaveBeenCalledOnce();
    expect(onCommitStroke.mock.calls[0][0].samples).toMatchObject([
      { x: 10, y: 10 }, { x: 30, y: 30 }, { x: 50, y: 50 }, { x: 60, y: 60 },
    ]);
    expect(onCameraChange).not.toHaveBeenCalled();
  });

  it.each([false, true])('lets the pen take over earlier palm contact (touch drawing: %s)', async (touchDrawing) => {
    const onCommitStroke = vi.fn<InkBoardViewProps['onCommitStroke']>();
    const onCameraChange = vi.fn();
    const initial = props({ onCommitStroke, onCameraChange });
    render(<InkBoardView {...initial} tool={{ ...initial.tool, touchDrawing }} />);
    const canvas = screen.getByTestId('ink-board-canvas');
    fireEvent.pointerDown(canvas, { pointerId: 9, pointerType: 'touch', buttons: 1, clientX: 70, clientY: 70 });
    fireEvent.pointerDown(canvas, { pointerId: 7, pointerType: 'pen', buttons: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { pointerId: 9, pointerType: 'touch', buttons: 1, clientX: 90, clientY: 90 });
    fireEvent.pointerMove(canvas, { pointerId: 7, pointerType: 'pen', buttons: 1, clientX: 30, clientY: 30 });
    fireEvent.pointerUp(canvas, { pointerId: 7, pointerType: 'pen', clientX: 40, clientY: 40 });
    await act(async () => undefined);
    expect(onCommitStroke).toHaveBeenCalledOnce();
    expect(onCommitStroke.mock.calls[0][0].samples).toMatchObject([
      { x: 10, y: 10 }, { x: 30, y: 30 }, { x: 40, y: 40 },
    ]);
    expect(onCameraChange).not.toHaveBeenCalled();
  });

  it('does not replace a pen stroke with another pointerdown', async () => {
    const onCommitStroke = vi.fn<InkBoardViewProps['onCommitStroke']>();
    render(<InkBoardView {...props({ onCommitStroke })} />);
    const canvas = startGesture();
    fireEvent.pointerDown(canvas, { pointerId: 9, pointerType: 'pen', buttons: 1, clientX: 90, clientY: 90 });
    fireEvent.pointerUp(canvas, { pointerId: 7, pointerType: 'pen', clientX: 40, clientY: 40 });
    await act(async () => undefined);
    expect(onCommitStroke).toHaveBeenCalledOnce();
    expect(onCommitStroke.mock.calls[0][0].samples[0]).toMatchObject({ x: 10, y: 10 });
  });

  it('finishes lost capture without adding its origin coordinates', async () => {
    const onCommitStroke = vi.fn<InkBoardViewProps['onCommitStroke']>();
    render(<InkBoardView {...props({ onCommitStroke })} />);
    const canvas = startGesture();
    fireEvent(canvas, new TestPointerEvent('lostpointercapture', { bubbles: true, pointerId: 7 }));
    await act(async () => undefined);
    expect(onCommitStroke).toHaveBeenCalledOnce();
    expect(onCommitStroke.mock.calls[0][0].samples).toMatchObject([
      { x: 10, y: 10 }, { x: 30, y: 30 },
    ]);
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
