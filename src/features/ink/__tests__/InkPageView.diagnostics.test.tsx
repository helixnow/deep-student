import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InkPageView, type InkPageViewProps } from '../InkPageView';
import type { InkObject, InkPage, InkPageRef, InkSample } from '../types';

const diagnostics = vi.hoisted(() => ({
  captureCalls: [] as Array<{
    event: PointerEvent;
    context: Record<string, unknown>;
    options?: { includeCoalesced?: boolean };
  }>,
  recordCalls: [] as Array<{ event: string; data?: Record<string, unknown> }>,
  faults: { enabledRead: false, record: false, capture: false },
}));

vi.mock('../inkDiagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../inkDiagnostics')>();
  return {
    ...actual,
    isInkDiagnosticsEnabled: () => {
      if (diagnostics.faults.enabledRead) throw new Error('enabled read failed');
      return actual.isInkDiagnosticsEnabled();
    },
    recordInkDiagnostic: (event: string, data?: Record<string, unknown>) => {
      diagnostics.recordCalls.push({ event, data });
      if (diagnostics.faults.record) throw new Error('record failed');
      actual.recordInkDiagnostic(event, data);
    },
    captureInkPointerEvent: (
      event: PointerEvent,
      context: Record<string, unknown>,
      options?: { includeCoalesced?: boolean },
    ) => {
      diagnostics.captureCalls.push({ event, context, options });
      if (diagnostics.faults.capture) throw new Error('capture failed');
      actual.captureInkPointerEvent(event, context, options);
    },
  };
});

vi.mock('../renderer', () => ({
  renderInkPage: vi.fn(() => ({ width_px: 794, height_px: 1123 })),
}));

vi.mock('../input', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../input')>();
  return { ...actual, collectPointerSamples: vi.fn(actual.collectPointerSamples) };
});

import { clearInkDiagnostics, getInkDiagnosticsSnapshot, setInkDiagnosticsEnabled } from '../inkDiagnostics';
import { collectPointerSamples } from '../input';

const pageRef: InkPageRef = {
  page_id: 'page-1',
  width: 794,
  height: 1123,
  background: { kind: 'blank', ruling: 'blank' },
  page_blob_hash: 'page-hash-1',
};
const page: InkPage = { schema_version: 1, page_id: 'page-1', objects: [] };

let coalescedCalls = 0;

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly pressure: number;

  getCoalescedEvents(): PointerEvent[] {
    coalescedCalls += 1;
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
    onError: vi.fn(),
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

const pointerInit = (pointerId: number, type: string, x: number, y: number, timeStamp: number) => ({
  pointerId,
  pointerType: type,
  button: 0,
  buttons: 1,
  clientX: x,
  clientY: y,
  pressure: 0.5,
  isPrimary: true,
  timeStamp,
});

function fireStroke(
  overlay: HTMLCanvasElement,
  options: { pointerId?: number; pointerType?: string; end?: 'pointerup' | 'pointercancel' } = {},
) {
  const pointerId = options.pointerId ?? 7;
  const pointerType = options.pointerType ?? 'pen';
  fireEvent.pointerDown(overlay, pointerInit(pointerId, pointerType, 110, 120, 1000));
  fireEvent.pointerMove(overlay, { ...pointerInit(pointerId, pointerType, 130, 140, 1016), buttons: 1 });
  const endInit = { ...pointerInit(pointerId, pointerType, 150, 160, 1032), buttons: 0 };
  if (options.end === 'pointercancel') fireEvent.pointerCancel(overlay, endInit);
  else fireEvent.pointerUp(overlay, endInit);
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

async function runStroke(options: { enabled: boolean; cancel?: boolean; background?: CanvasImageSource } = { enabled: false }) {
  coalescedCalls = 0;
  setInkDiagnosticsEnabled(options.enabled);
  const onPageChange = vi.fn(async (_next: InkPage) => undefined);
  const onError = vi.fn();
  const view = render(<InkPageView {...props({ onPageChange, onError, background: options.background })} />);
  const { overlay, canvasRect } = mockCanvasRects();
  fireStroke(overlay, { end: options.cancel ? 'pointercancel' : 'pointerup' });
  await waitFor(() => expect(onPageChange).toHaveBeenCalledOnce());
  const nextPage = onPageChange.mock.calls[0][0];
  view.unmount();
  return {
    nextPage,
    samples: savedSamples(nextPage),
    onPageChange,
    onError,
    coalescedCalls,
    canvasLayoutCalls: canvasRect.mock.calls.length,
  };
}

beforeEach(() => {
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  setInkDiagnosticsEnabled(false);
  clearInkDiagnostics();
  diagnostics.captureCalls.length = 0;
  diagnostics.recordCalls.length = 0;
  diagnostics.faults.enabledRead = false;
  diagnostics.faults.record = false;
  diagnostics.faults.capture = false;
  vi.mocked(collectPointerSamples).mockClear();
});

afterEach(() => {
  setInkDiagnosticsEnabled(false);
  clearInkDiagnostics();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('InkPageView diagnostics side channel', () => {
  it('keeps committed samples identical with diagnostics disabled or enabled', async () => {
    const disabled = await runStroke({ enabled: false });
    expect(disabled.samples).toHaveLength(3);
    expect(disabled.onError).not.toHaveBeenCalled();
    expect(collectPointerSamples).toHaveBeenCalledTimes(3);
    expect(diagnostics.captureCalls).toHaveLength(0);
    expect(diagnostics.recordCalls).toHaveLength(0);

    vi.mocked(collectPointerSamples).mockClear();
    diagnostics.captureCalls.length = 0;
    diagnostics.recordCalls.length = 0;

    const enabled = await runStroke({ enabled: true });
    expect(enabled.samples).toEqual(disabled.samples);
    expect(enabled.onError).not.toHaveBeenCalled();
    expect(collectPointerSamples).toHaveBeenCalledTimes(3);
    expect(diagnostics.captureCalls.length).toBeGreaterThanOrEqual(3);
    expect(diagnostics.captureCalls.find((call) => call.context.phase === 'down')?.context).toMatchObject({
      documentId: 'document-1',
      pageId: 'page-1',
      tool: 'pen',
      mode: 'idle',
      samples: 0,
    });
    expect(diagnostics.captureCalls.find((call) => call.context.phase === 'move')?.context).toMatchObject({
      documentId: 'document-1',
      pageId: 'page-1',
      mode: 'stroke',
      activePointerId: 7,
      samples: 1,
    });
  });

  it('keeps coalesced and layout reads at baseline while diagnostics are enabled', async () => {
    const disabled = await runStroke({ enabled: false });
    expect(disabled.coalescedCalls).toBe(3);
    expect(disabled.canvasLayoutCalls).toBe(3);

    const enabled = await runStroke({ enabled: true });
    expect(enabled.samples).toEqual(disabled.samples);
    expect(enabled.coalescedCalls).toBe(disabled.coalescedCalls);
    expect(enabled.canvasLayoutCalls).toBe(disabled.canvasLayoutCalls);
    expect(diagnostics.captureCalls.length).toBeGreaterThan(0);
    expect(diagnostics.captureCalls.every((call) => call.options?.includeCoalesced === false)).toBe(true);

    const cancelDisabled = await runStroke({ enabled: false, cancel: true });
    expect(cancelDisabled.coalescedCalls).toBe(2);
    expect(cancelDisabled.canvasLayoutCalls).toBe(2);

    const cancelEnabled = await runStroke({ enabled: true, cancel: true });
    expect(cancelEnabled.samples).toEqual(cancelDisabled.samples);
    expect(cancelEnabled.coalescedCalls).toBe(cancelDisabled.coalescedCalls);
    expect(cancelEnabled.canvasLayoutCalls).toBe(cancelDisabled.canvasLayoutCalls);
  });

  it('finishes pointercancel from existing samples without sampling cancel coordinates', async () => {
    const up = await runStroke({ enabled: true });
    expect(up.samples).toHaveLength(3);
    expect(up.onPageChange).toHaveBeenCalledOnce();
    diagnostics.captureCalls.length = 0;
    diagnostics.recordCalls.length = 0;

    const cancel = await runStroke({ enabled: true, cancel: true });
    expect(cancel.samples).toHaveLength(2);
    expect(cancel.samples).toEqual(up.samples.slice(0, 2));
    expect(cancel.samples.some((sample) => sample.x === 280 && sample.y === 280)).toBe(false);
    expect(cancel.onPageChange).toHaveBeenCalledOnce();
    expect(cancel.onError).not.toHaveBeenCalled();

    const cancelCapture = diagnostics.captureCalls.find((call) => call.context.phase === 'cancel');
    expect(cancelCapture?.context).toMatchObject({
      phase: 'cancel',
      cancelled: true,
      cancelSampled: false,
      touchDrawing: false,
      touchAction: 'none',
      panActive: false,
      panPointerId: null,
    });
    const cancelBatch = diagnostics.recordCalls.find(
      (record) => record.event === 'page.stroke.samples' && record.data?.phase === 'cancel',
    );
    expect(cancelBatch?.data).toMatchObject({
      phase: 'cancel',
      cancelled: true,
      terminal: true,
      batchCount: 0,
      samples: 2,
    });
  });

  it('records the specific reason for ignored pointerdown events', async () => {
    setInkDiagnosticsEnabled(true);

    const activeView = render(<InkPageView {...props()} />);
    const activeCanvas = mockCanvasRects();
    fireEvent.pointerDown(activeCanvas.overlay, pointerInit(1, 'pen', 110, 120, 1000));
    fireEvent.pointerDown(activeCanvas.overlay, pointerInit(2, 'pen', 111, 121, 1001));
    expect(diagnostics.captureCalls.at(-1)?.context.ignored).toBe('active');
    fireEvent.pointerUp(activeCanvas.overlay, { ...pointerInit(1, 'pen', 110, 120, 1002), buttons: 0 });
    activeView.unmount();

    const eraserView = render(<InkPageView {...props({ erasing: true })} />);
    const eraserCanvas = mockCanvasRects();
    fireEvent.pointerDown(eraserCanvas.overlay, pointerInit(3, 'pen', 110, 120, 1000));
    fireEvent.pointerDown(eraserCanvas.overlay, pointerInit(4, 'pen', 111, 121, 1001));
    expect(diagnostics.captureCalls.at(-1)?.context.ignored).toBe('eraser');
    eraserView.unmount();

    const selectionView = render(<InkPageView {...props({ selectionMode: 'rectangle' })} />);
    const selectionCanvas = mockCanvasRects();
    fireEvent.pointerDown(selectionCanvas.overlay, pointerInit(5, 'pen', 110, 120, 1000));
    fireEvent.pointerDown(selectionCanvas.overlay, pointerInit(6, 'pen', 111, 121, 1001));
    expect(diagnostics.captureCalls.at(-1)?.context.ignored).toBe('selection');
    selectionView.unmount();

    const touchView = render(<InkPageView {...props()} />);
    const touchCanvas = mockCanvasRects();
    fireEvent.pointerDown(touchCanvas.overlay, pointerInit(8, 'touch', 110, 120, 1000));
    const touchDown = diagnostics.captureCalls.at(-1)?.context;
    expect(touchDown).toMatchObject({
      pointerId: 8,
      pointerType: 'touch',
      touchDrawing: false,
      touchAction: 'none',
    });
    expect(touchDown?.ignored).toBeNull();
    const panRequest = diagnostics.recordCalls.find(
      (record) => record.event === 'page.pointer.capture.request' && record.data?.gesture === 'pan',
    );
    expect(panRequest?.data).toMatchObject({
      gesture: 'pan',
      panActive: true,
      panPointerId: 8,
      mode: 'pan',
    });

    fireEvent.pointerDown(touchCanvas.overlay, pointerInit(9, 'touch', 111, 121, 1001));
    expect(diagnostics.captureCalls.at(-1)?.context.ignored).toBe('pan-active');
    touchView.unmount();
  });

  it('records touch pan state, fixed touch action, and viewport scroll', () => {
    setInkDiagnosticsEnabled(true);
    const view = render(<InkPageView {...props()} />);
    const { overlay } = mockCanvasRects();
    const viewport = screen.getByTestId('ink-page-viewport');
    viewport.scrollLeft = 200;
    viewport.scrollTop = 150;

    fireEvent.pointerDown(overlay, pointerInit(8, 'touch', 100, 100, 1000));
    expect(diagnostics.captureCalls.at(-1)?.context).toMatchObject({
      phase: 'down',
      touchDrawing: false,
      touchAction: 'none',
      scrollLeft: 200,
      scrollTop: 150,
      ignored: null,
    });

    fireEvent.pointerMove(overlay, { ...pointerInit(8, 'touch', 140, 130, 1016), buttons: 1 });
    expect(diagnostics.captureCalls.at(-1)?.context).toMatchObject({
      phase: 'move',
      mode: 'pan',
      panActive: true,
      panPointerId: 8,
      touchAction: 'none',
      scrollLeft: 200,
      scrollTop: 150,
    });
    expect(viewport.scrollLeft).toBe(160);
    expect(viewport.scrollTop).toBe(120);

    fireEvent.pointerMove(overlay, { ...pointerInit(8, 'touch', 160, 150, 1032), buttons: 1 });
    expect(diagnostics.captureCalls.at(-1)?.context).toMatchObject({
      phase: 'move',
      panActive: true,
      scrollLeft: 160,
      scrollTop: 120,
    });
    expect(viewport.scrollLeft).toBe(140);
    expect(viewport.scrollTop).toBe(100);
    expect(diagnostics.recordCalls.some((record) => record.event === 'page.stroke.samples')).toBe(false);

    fireEvent.pointerUp(overlay, { ...pointerInit(8, 'touch', 160, 150, 1048), buttons: 0 });
    view.unmount();
  });

  it('does not let diagnostics exceptions change input or committed samples', async () => {
    const baseline = await runStroke({ enabled: false });

    diagnostics.faults.record = true;
    diagnostics.faults.capture = true;
    const recordFailure = await runStroke({ enabled: true });
    expect(recordFailure.samples).toEqual(baseline.samples);
    expect(recordFailure.onError).not.toHaveBeenCalled();

    diagnostics.faults.record = false;
    diagnostics.faults.capture = false;
    diagnostics.faults.enabledRead = true;
    const enabledReadFailure = await runStroke({ enabled: true });
    expect(enabledReadFailure.samples).toEqual(baseline.samples);
    expect(enabledReadFailure.onError).not.toHaveBeenCalled();
  });

  it('records sample batches, stroke finish correlation, and render timing', async () => {
    const background = document.createElement('canvas');
    const result = await runStroke({ enabled: true, background });
    const stroke = savedStroke(result.nextPage);

    const sampleRecords = diagnostics.recordCalls.filter((record) => record.event === 'page.stroke.samples');
    expect(sampleRecords).toHaveLength(3);
    expect(sampleRecords[0]?.data).toMatchObject({
      phase: 'down',
      batchCount: 1,
      samples: 1,
      viewport: { left: 10, top: 20, scale: 0.5 },
    });
    expect(sampleRecords[0]?.data?.first).toMatchObject({ x: 200, y: 200, elapsed_ms: 0 });
    expect(sampleRecords[1]?.data?.last).toMatchObject({ x: 240, y: 240, elapsed_ms: 16 });
    expect(sampleRecords[2]?.data).toMatchObject({ phase: 'up', terminal: true, samples: 3 });

    const finishStart = diagnostics.recordCalls.find((record) => record.event === 'page.stroke.finish.start');
    expect(finishStart?.data).toMatchObject({
      pointerId: 7,
      startedAt: 1000,
      samples: 3,
      objectCount: 0,
    });
    const finishCommit = diagnostics.recordCalls.find((record) => record.event === 'page.stroke.finish.commit');
    expect(finishCommit?.data).toMatchObject({
      pointerId: 7,
      startedAt: 1000,
      strokeId: stroke.id,
      lastObjectId: stroke.id,
      samples: 3,
      objectCount: 1,
    });
    expect(typeof finishCommit?.data?.durationMs).toBe('number');

    const renderStart = diagnostics.recordCalls.find(
      (record) => record.event === 'page.render.start' && record.data?.target === 'page',
    );
    expect(renderStart?.data).toMatchObject({
      pageId: 'page-1',
      pageWidth: 794,
      pageHeight: 1123,
      backgroundPresent: true,
      backgroundDrawn: true,
      objectCount: 0,
    });
    const renderEnd = diagnostics.recordCalls.find(
      (record) => record.event === 'page.render.end' && record.data?.target === 'page',
    );
    expect(renderEnd?.data).toMatchObject({ widthPx: 794, heightPx: 1123 });
    expect(typeof renderEnd?.data?.durationMs).toBe('number');

    const pointerRecords = getInkDiagnosticsSnapshot().records.filter((record) => record.event === 'pointer');
    const downPointer = pointerRecords.find((record) => (record.data?.context as Record<string, unknown> | undefined)?.phase === 'down');
    expect(downPointer?.data?.context).toMatchObject({
      documentId: 'document-1',
      pageId: 'page-1',
      tool: 'pen',
      selectionMode: 'none',
      phase: 'down',
    });
    expect(downPointer?.data?.coalescedSkipped).toBe(true);
    expect(downPointer?.data?.coalescedSamples).toBeUndefined();
  });

  it('logs stroke commit failure without changing the onError chain', async () => {
    setInkDiagnosticsEnabled(true);
    const failure = new Error('save failed');
    const onPageChange = vi.fn(async (_next: InkPage): Promise<void> => { throw failure; });
    const onError = vi.fn();
    render(<InkPageView {...props({ onPageChange, onError })} />);
    const { overlay } = mockCanvasRects();

    fireStroke(overlay);
    await waitFor(() => expect(onError).toHaveBeenCalledWith(failure));

    const finishError = diagnostics.recordCalls.find((record) => record.event === 'page.stroke.finish.error');
    expect(finishError?.data).toMatchObject({
      pointerId: 7,
      startedAt: 1000,
      objectCount: 1,
      errorType: 'Error',
    });
    expect(finishError?.data?.strokeId).toEqual(expect.any(String));
    expect(finishError?.data?.lastObjectId).toEqual(finishError?.data?.strokeId);
    expect(diagnostics.recordCalls.some((record) => record.event === 'page.stroke.finish.commit')).toBe(false);
  });

  it('observes got/lost pointer capture without finishing or cancelling the stroke', async () => {
    setInkDiagnosticsEnabled(true);
    const onPageChange = vi.fn(async (_next: InkPage) => undefined);
    const view = render(<InkPageView {...props({ onPageChange })} />);
    const { overlay } = mockCanvasRects();

    fireEvent.pointerDown(overlay, pointerInit(7, 'pen', 110, 120, 1000));
    fireEvent.gotPointerCapture(overlay, { pointerId: 7 });
    fireEvent.lostPointerCapture(overlay, { pointerId: 7 });
    fireEvent.pointerMove(overlay, { ...pointerInit(7, 'pen', 130, 140, 1016), buttons: 1 });
    fireEvent.pointerUp(overlay, { ...pointerInit(7, 'pen', 150, 160, 1032), buttons: 0 });

    await waitFor(() => expect(onPageChange).toHaveBeenCalledOnce());
    expect(savedSamples(onPageChange.mock.calls[0][0])).toHaveLength(3);
    expect(diagnostics.recordCalls.some((record) => record.event === 'page.pointer.capture.got')).toBe(true);
    expect(diagnostics.recordCalls.some((record) => record.event === 'page.pointer.capture.lost')).toBe(true);
    view.unmount();
  });
});
