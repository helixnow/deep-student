import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InkBoardView, type InkBoardViewProps } from '../InkBoardView';
import {
  clearInkDiagnostics,
  getInkDiagnosticsSnapshot,
  setInkDiagnosticsEnabled,
} from '../inkDiagnostics';
import { collectPointerSamples } from '../input';

vi.mock('../boardRenderer', () => ({
  renderInkBoard: vi.fn(() => ({
    metrics: { cssWidth: 800, cssHeight: 600, dpr: 1, pixelRatio: 1, widthPx: 800, heightPx: 600 },
    worldRect: { x: 0, y: 0, width: 800, height: 600 },
    renderedObjectCount: 0,
  })),
}));

vi.mock('../input', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../input')>();
  return { ...actual, collectPointerSamples: vi.fn(actual.collectPointerSamples) };
});

const diagnosticsHooks = vi.hoisted(() => ({
  faults: { enabledRead: false, record: false, capture: false },
  captureOptions: [] as Array<{ includeCoalesced?: boolean } | undefined>,
}));

vi.mock('../inkDiagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../inkDiagnostics')>();
  return {
    ...actual,
    isInkDiagnosticsEnabled: () => {
      if (diagnosticsHooks.faults.enabledRead) throw new Error('enabled read failed');
      return actual.isInkDiagnosticsEnabled();
    },
    recordInkDiagnostic: (event: string, data?: Record<string, unknown>) => {
      if (diagnosticsHooks.faults.record) throw new Error('record failed');
      actual.recordInkDiagnostic(event, data);
    },
    captureInkPointerEvent: (
      event: PointerEvent,
      context: Record<string, unknown>,
      options?: { includeCoalesced?: boolean },
    ) => {
      diagnosticsHooks.captureOptions.push(options);
      if (diagnosticsHooks.faults.capture) throw new Error('capture failed');
      actual.captureInkPointerEvent(event, context, options);
    },
  };
});

let coalescedEnumerationCount = 0;

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly pressure: number;
  readonly getCoalescedEvents: () => TestPointerEvent[];

  constructor(
    type: string,
    init: MouseEventInit & { pointerId?: number; pointerType?: string; pressure?: number; timeStamp?: number } = {},
  ) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'pen';
    this.pressure = init.pressure ?? 0.5;
    Object.defineProperty(this, 'timeStamp', { configurable: true, value: init.timeStamp ?? 0 });
    this.getCoalescedEvents = () => {
      coalescedEnumerationCount += 1;
      return [this];
    };
  }
}

function props(overrides: Partial<InkBoardViewProps> = {}): InkBoardViewProps {
  return {
    surface: {
      kind: 'board',
      page_id: 'page-diagnostics',
      ruling: 'blank',
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

function drawStroke() {
  const canvas = screen.getByTestId('ink-board-canvas');
  fireEvent.pointerDown(canvas, {
    pointerId: 7,
    pointerType: 'pen',
    button: 0,
    buttons: 1,
    clientX: 10,
    clientY: 10,
    pressure: 0.4,
    timeStamp: 1000,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 7,
    pointerType: 'pen',
    buttons: 1,
    clientX: 20,
    clientY: 20,
    pressure: 0.6,
    timeStamp: 1016,
  });
  fireEvent.pointerUp(canvas, {
    pointerId: 7,
    pointerType: 'pen',
    button: 0,
    clientX: 30,
    clientY: 30,
    pressure: 0.8,
    timeStamp: 1032,
  });
}

type StrokeContent = Parameters<InkBoardViewProps['onCommitStroke']>[0];

beforeEach(() => {
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  diagnosticsHooks.faults.enabledRead = false;
  diagnosticsHooks.faults.record = false;
  diagnosticsHooks.faults.capture = false;
  setInkDiagnosticsEnabled(false);
  clearInkDiagnostics();
  vi.mocked(collectPointerSamples).mockClear();
  coalescedEnumerationCount = 0;
  diagnosticsHooks.captureOptions.length = 0;
});

afterEach(() => {
  setInkDiagnosticsEnabled(false);
  clearInkDiagnostics();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('InkBoardView diagnostics side path', () => {
  it('records board pointer/sample/commit events without changing the committed stroke', async () => {
    setInkDiagnosticsEnabled(true);
    const enabledCommit = vi.fn();
    const enabledRender = render(<InkBoardView {...props({ onCommitStroke: enabledCommit })} />);
    drawStroke();
    await act(async () => undefined);

    expect(enabledCommit).toHaveBeenCalledOnce();
    const enabledPayload = enabledCommit.mock.calls[0][0] as StrokeContent;
    expect(enabledPayload.samples).toHaveLength(3);
    expect(collectPointerSamples).toHaveBeenCalledTimes(3);

    const records = getInkDiagnosticsSnapshot().records;
    const eventNames = records.map((record) => record.event);
    expect(eventNames.filter((event) => event === 'pointer')).toHaveLength(3);
    expect(records.some((record) => record.event === 'board.render')).toBe(true);

    const downAction = records.find(
      (record) => record.event === 'board.pointer.action'
        && record.data?.phase === 'down'
        && record.data?.action === 'stroke',
    );
    expect(downAction?.data?.reason).toBe('pen-or-touch-draw');
    expect(downAction?.data?.pointerId).toBe(7);
    expect(records.some((record) => record.event === 'board.pointer.capture')).toBe(false);
    expect(diagnosticsHooks.captureOptions).toHaveLength(3);
    expect(diagnosticsHooks.captureOptions.every((options) => options?.includeCoalesced === false)).toBe(true);

    const sampleCounts = records
      .filter((record) => record.event === 'board.stroke.samples')
      .map((record) => record.data?.count);
    expect(sampleCounts).toEqual([1, 1, 1]);

    const finish = records.find(
      (record) => record.event === 'board.stroke.finish' && record.data?.reason === 'commit',
    );
    expect(finish?.data?.sampleCount).toBe(3);
    expect(records.some(
      (record) => record.event === 'board.stroke.commit' && record.data?.phase === 'settled',
    )).toBe(true);

    const pointerRecords = records.filter((record) => record.event === 'pointer');
    for (const record of pointerRecords) {
      expect(record.data?.context).toMatchObject({
        scope: 'board',
        surfaceId: 'page-diagnostics',
      });
    }

    enabledRender.unmount();

    setInkDiagnosticsEnabled(false);
    clearInkDiagnostics();
    vi.mocked(collectPointerSamples).mockClear();
    const disabledCommit = vi.fn();
    render(<InkBoardView {...props({ onCommitStroke: disabledCommit })} />);
    drawStroke();
    await act(async () => undefined);

    expect(disabledCommit).toHaveBeenCalledOnce();
    expect(collectPointerSamples).toHaveBeenCalledTimes(3);
    const disabledPayload = disabledCommit.mock.calls[0][0] as StrokeContent;
    expect(disabledPayload).toEqual(enabledPayload);
    expect(getInkDiagnosticsSnapshot().records).toHaveLength(0);
  });

  it('enumerates the same coalesced events and layout reads with logging enabled or disabled', async () => {
    const run = async (enabled: boolean) => {
      setInkDiagnosticsEnabled(enabled);
      clearInkDiagnostics();
      const onCommitStroke = vi.fn();
      const view = render(<InkBoardView {...props({ onCommitStroke })} />);
      const canvas = screen.getByTestId('ink-board-canvas');
      let clientWidthReads = 0;
      let clientHeightReads = 0;
      let rectReads = 0;
      Object.defineProperty(canvas, 'clientWidth', {
        configurable: true,
        get: () => {
          clientWidthReads += 1;
          return 800;
        },
      });
      Object.defineProperty(canvas, 'clientHeight', {
        configurable: true,
        get: () => {
          clientHeightReads += 1;
          return 600;
        },
      });
      vi.spyOn(canvas, 'getBoundingClientRect').mockImplementation(() => {
        rectReads += 1;
        return {
          left: 0,
          top: 0,
          right: 800,
          bottom: 600,
          width: 800,
          height: 600,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      });

      coalescedEnumerationCount = 0;
      drawStroke();
      await act(async () => undefined);
      expect(onCommitStroke).toHaveBeenCalledOnce();
      const result = { coalescedEnumerationCount, clientWidthReads, clientHeightReads, rectReads };
      view.unmount();
      return result;
    };

    const disabled = await run(false);
    const enabled = await run(true);
    expect(enabled).toEqual(disabled);
    expect(disabled).toEqual({
      coalescedEnumerationCount: 3,
      clientWidthReads: 0,
      clientHeightReads: 0,
      rectReads: 3,
    });
    expect(diagnosticsHooks.captureOptions.length).toBeGreaterThan(0);
    expect(diagnosticsHooks.captureOptions.every((options) => options?.includeCoalesced === false)).toBe(true);
  });

  it('leaves pointercancel commit semantics unchanged while logging the reason', async () => {
    setInkDiagnosticsEnabled(true);
    const onCommitStroke = vi.fn();
    render(<InkBoardView {...props({ onCommitStroke })} />);
    const canvas = screen.getByTestId('ink-board-canvas');
    fireEvent.pointerDown(canvas, {
      pointerId: 9,
      pointerType: 'pen',
      button: 0,
      buttons: 1,
      clientX: 5,
      clientY: 5,
      pressure: 0.5,
    });
    fireEvent.pointerMove(canvas, {
      pointerId: 9,
      pointerType: 'pen',
      buttons: 1,
      clientX: 15,
      clientY: 15,
      pressure: 0.5,
    });
    fireEvent.pointerCancel(canvas, {
      pointerId: 9,
      pointerType: 'pen',
      clientX: 15,
      clientY: 15,
      pressure: 0.5,
    });
    await act(async () => undefined);

    expect(onCommitStroke).toHaveBeenCalledOnce();
    const records = getInkDiagnosticsSnapshot().records;
    expect(records.some(
      (record) => record.event === 'board.pointer.action'
        && record.data?.action === 'stroke-commit'
        && record.data?.reason === 'os-pointercancel-continues-stroke',
    )).toBe(true);
    expect(records.some(
      (record) => record.event === 'board.stroke.commit' && record.data?.phase === 'settled',
    )).toBe(true);
  });

  it('keeps input and commits working when diagnostics hooks throw', async () => {
    setInkDiagnosticsEnabled(true);
    diagnosticsHooks.faults.record = true;
    diagnosticsHooks.faults.capture = true;
    const onCommitStroke = vi.fn();
    const view = render(<InkBoardView {...props({ onCommitStroke })} />);
    drawStroke();
    await act(async () => undefined);

    expect(onCommitStroke).toHaveBeenCalledOnce();
    expect(onCommitStroke.mock.calls[0][0].samples).toHaveLength(3);
    expect(getInkDiagnosticsSnapshot().records).toHaveLength(0);
    view.unmount();

    diagnosticsHooks.faults.record = false;
    diagnosticsHooks.faults.capture = false;
    diagnosticsHooks.faults.enabledRead = true;
    const enabledReadCommit = vi.fn();
    render(<InkBoardView {...props({ onCommitStroke: enabledReadCommit })} />);
    drawStroke();
    await act(async () => undefined);

    expect(enabledReadCommit).toHaveBeenCalledOnce();
    expect(enabledReadCommit.mock.calls[0][0].samples).toHaveLength(3);
  });
});
