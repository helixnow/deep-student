/**
 * Bounded v2 board viewport.
 *
 * The board renderer owns the visible world rectangle and the 16M-pixel canvas
 * cap; this component only maps DOM input into world coordinates and keeps the
 * camera as `{x, y, zoom}`. Camera state itself lives in `useInkBoardDocument`
 * (`{x, y, scale}`); this file converts at that boundary and never stores a
 * second persistent camera.
 */
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  cameraViewportRect,
  panCameraBy,
  screenToWorld,
  worldToScreen,
  zoomCameraAt,
  type Camera,
} from './camera';
import { collectPointerSamples } from './input';
import {
  captureInkPointerEvent,
  isInkDiagnosticsEnabled,
  recordInkDiagnostic,
} from './inkDiagnostics';
import { objectHitTestSweep } from './geometry';
import { objectIntersectsPolygon, selectionBounds } from './selection';
import { renderInkBoard } from './boardRenderer';
import type { InkToolName } from './toolSettings';
import type {
  InkBoardBounds,
  InkBoardObject,
  InkBoardSurface,
  InkObjectContent,
  InkPoint,
  InkRect,
  InkSample,
} from './types';

export type InkBoardSelectionMode = 'none' | 'rectangle' | 'lasso';

export interface InkBoardToolSettings {
  tool: InkToolName;
  color: string;
  width: number;
  eraserSize: number;
  touchDrawing: boolean;
}

export interface InkBoardSelection {
  polygon: InkPoint[];
  bounds: InkRect;
  objectIds: string[];
}

export interface InkBoardViewHandle {
  /** Signed world rectangle currently visible through the CSS viewport. */
  getViewportWorldRect(): InkBoardBounds;
  /** CSS-pixel viewport size used for anchored zoom and paste centering. */
  getViewportSize(): { width: number; height: number };
  /** Finishes pen/eraser input and waits for pending gesture commits before a host action. */
  finishStroke(): Promise<void>;
  focus(): void;
}

export interface InkBoardViewProps {
  surface: InkBoardSurface;
  objects: InkBoardObject[];
  camera: Camera;
  tool: InkBoardToolSettings;
  erasing: boolean;
  selectionMode: InkBoardSelectionMode;
  selection: InkBoardSelection | null;
  spaceDown: boolean;
  className?: string;
  ariaLabel: string;
  onCameraChange(camera: Camera): void;
  onCommitStroke(content: Extract<InkObjectContent, { kind: 'stroke' }>): void | boolean | Promise<void | boolean>;
  onErase(objectIds: string[]): void | Promise<void>;
  onSelectionChange(selection: InkBoardSelection | null): void;
  onError(error: unknown): void;
}

interface ActiveStroke {
  pointerId: number;
  pointerType: string;
  startedAt: number;
  samples: Extract<InkObjectContent, { kind: 'stroke' }>['samples'];
  style: Extract<InkObjectContent, { kind: 'stroke' }>['style'];
}

interface EraserGesture {
  pointerId: number;
  lastPoint: InkPoint;
  hitIds: Set<string>;
}

interface SelectionGesture {
  pointerId: number;
  mode: Exclude<InkBoardSelectionMode, 'none'>;
  points: InkPoint[];
}

interface PanGesture {
  pointerId: number;
  last: { x: number; y: number };
}

interface PinchGesture {
  ids: [number, number];
  startDistance: number;
  startCenter: InkPoint;
  startCamera: Camera;
}

interface PointerPosition {
  clientX: number;
  clientY: number;
}

function finiteCamera(camera: Camera): Camera {
  if (!Number.isFinite(camera.x) || !Number.isFinite(camera.y) || !Number.isFinite(camera.zoom)) {
    return { x: 0, y: 0, zoom: 1 };
  }
  return camera;
}

function distance(left: InkPoint, right: InkPoint): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function midpoint(left: InkPoint, right: InkPoint): InkPoint {
  return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
}

type DiagnosticData = Record<string, unknown>;

function diagnosticsEnabled(): boolean {
  try {
    return isInkDiagnosticsEnabled();
  } catch {
    return false;
  }
}

function diagnosticNow(): number {
  try {
    const perf = globalThis.performance;
    return perf && typeof perf.now === 'function' ? perf.now() : Date.now();
  } catch {
    return Date.now();
  }
}

function logDiagnostic(event: string, data?: DiagnosticData): void {
  if (!diagnosticsEnabled()) return;
  try {
    recordInkDiagnostic(event, data);
  } catch {
    /* Diagnostics are observational and must never affect input. */
  }
}

function capturePointerDiagnostic(
  event: React.PointerEvent<HTMLCanvasElement>,
  context: () => DiagnosticData,
): void {
  if (!diagnosticsEnabled()) return;
  try {
    // Sampling already records the real coalesced batch; capture stays metadata-only.
    captureInkPointerEvent(event.nativeEvent, context(), { includeCoalesced: false });
  } catch {
    /* Diagnostics are observational and must never affect input. */
  }
}

function sampleEdge(sample: InkSample | undefined): DiagnosticData | null {
  if (!sample) return null;
  return {
    x: sample.x,
    y: sample.y,
    pressure: sample.pressure,
    elapsed_ms: sample.elapsed_ms ?? null,
  };
}

function errorSummary(error: unknown): DiagnosticData {
  try {
    if (error instanceof Error) {
      const code = (error as Error & { code?: unknown }).code;
      return {
        errorName: error.name,
        ...(typeof code === 'string' || typeof code === 'number' ? { errorCode: code } : {}),
      };
    }
    return { errorType: typeof error };
  } catch {
    return { errorType: 'unknown' };
  }
}

export const InkBoardView = forwardRef<InkBoardViewHandle, InkBoardViewProps>(function InkBoardView(
  {
    surface,
    objects,
    camera,
    tool,
    erasing,
    selectionMode,
    selection,
    spaceDown,
    className,
    ariaLabel,
    onCameraChange,
    onCommitStroke,
    onErase,
    onSelectionChange,
    onError,
  },
  ref,
) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const objectsRef = useRef(objects);
  objectsRef.current = objects;
  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const erasingRef = useRef(erasing);
  erasingRef.current = erasing;
  const selectionModeRef = useRef(selectionMode);
  selectionModeRef.current = selectionMode;
  const spaceDownRef = useRef(spaceDown);
  spaceDownRef.current = spaceDown;

  const pointersRef = useRef(new Map<number, PointerPosition>());
  const activeStrokeRef = useRef<ActiveStroke | null>(null);
  const eraserGestureRef = useRef<EraserGesture | null>(null);
  const selectionGestureRef = useRef<SelectionGesture | null>(null);
  const panGestureRef = useRef<PanGesture | null>(null);
  const pinchGestureRef = useRef<PinchGesture | null>(null);
  const [selectionDraft, setSelectionDraft] = useState<InkPoint[] | null>(null);
  const [eraserCursor, setEraserCursor] = useState<InkPoint | null>(null);

  const logBoardDiagnostic = (event: string, data?: DiagnosticData): void => {
    logDiagnostic(event, {
      scope: 'board',
      surfaceId: surfaceRef.current.page_id,
      ...data,
    });
  };

  const renderFrame = useCallback((reason = 'unspecified') => {
    const diagnostics = diagnosticsEnabled();
    const startedAt = diagnostics ? diagnosticNow() : 0;
    const main = canvasRef.current;
    const overlay = overlayRef.current;
    if (!main || !overlay) {
      if (diagnostics) {
        logBoardDiagnostic('board.render', { reason, skipped: 'missing-canvas' });
      }
      return;
    }
    const currentSurface = surfaceRef.current;
    const currentCamera = finiteCamera(cameraRef.current);
    const currentObjects = objectsRef.current;
    const dpr = globalThis.devicePixelRatio || 1;

    const mainRender = renderInkBoard(main, currentSurface, currentObjects, currentCamera, { dpr });

    const active = activeStrokeRef.current;
    if (active?.samples.length) {
      const preview: InkBoardObject = {
        id: 'ink-board-active-stroke',
        author: 'user',
        created_at: 0,
        z_index: 0,
        content: { kind: 'stroke', samples: active.samples, style: active.style },
      };
      renderInkBoard(overlay, currentSurface, [preview], currentCamera, { dpr, transparent: true });
      if (diagnostics) {
        logBoardDiagnostic('board.render', {
          reason,
          durationMs: diagnosticNow() - startedAt,
          objectCount: currentObjects.length,
          sampleCount: active.samples.length,
          overlay: 'preview',
          camera: { x: currentCamera.x, y: currentCamera.y, zoom: currentCamera.zoom },
          viewport: mainRender?.metrics
            ? { width: mainRender.metrics.cssWidth, height: mainRender.metrics.cssHeight }
            : { width: main.clientWidth, height: main.clientHeight },
          dpr,
        });
      }
      return;
    }
    const context = overlay.getContext('2d');
    context?.clearRect(0, 0, overlay.width, overlay.height);
    if (diagnostics) {
      logBoardDiagnostic('board.render', {
        reason,
        durationMs: diagnosticNow() - startedAt,
        objectCount: currentObjects.length,
        sampleCount: 0,
        overlay: 'cleared',
        camera: { x: currentCamera.x, y: currentCamera.y, zoom: currentCamera.zoom },
        viewport: mainRender?.metrics
          ? { width: mainRender.metrics.cssWidth, height: mainRender.metrics.cssHeight }
          : { width: main.clientWidth, height: main.clientHeight },
        dpr,
      });
    }
  }, []);

  const cameraForEvent = (): Camera => finiteCamera(cameraRef.current);

  const viewportForCanvas = useCallback((canvas: HTMLCanvasElement, currentCamera: Camera) => {
    const rect = canvas.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      scale: currentCamera.zoom,
      pan_x: -currentCamera.x * currentCamera.zoom,
      pan_y: -currentCamera.y * currentCamera.zoom,
    };
  }, []);

  const pointFromEvent = useCallback((event: React.PointerEvent<HTMLCanvasElement>): InkPoint => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return screenToWorld(
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      cameraForEvent(),
    );
  }, []);

  const updateCamera = useCallback((next: Camera) => {
    cameraRef.current = next;
    onCameraChange(next);
    renderFrame('camera');
  }, [onCameraChange, renderFrame]);

  const collectSamples = useCallback((
    event: React.PointerEvent<HTMLCanvasElement>,
    active: ActiveStroke,
    terminal = false,
  ) => {
    const canvas = canvasRef.current;
    if (!canvas) return [];
    const pressureEnabled = active.style.tool === 'pen' && active.pointerType === 'pen';
    return collectPointerSamples(
      event.nativeEvent,
      viewportForCanvas(canvas, cameraForEvent()),
      active.startedAt,
      pressureEnabled,
      { terminal, cancelled: event.type === 'pointercancel' },
    );
  }, [viewportForCanvas]);

  const activeGestureName = (): string => {
    if (pinchGestureRef.current) return 'pinch';
    if (panGestureRef.current) return 'pan';
    if (selectionGestureRef.current) return 'selection';
    if (eraserGestureRef.current) return 'eraser';
    if (activeStrokeRef.current) return 'stroke';
    return 'idle';
  };

  const pointerDiagnosticContext = (phase: string): DiagnosticData => {
    const currentCamera = finiteCamera(cameraRef.current);
    return {
      scope: 'board',
      surfaceId: surfaceRef.current.page_id,
      phase,
      gesture: activeGestureName(),
      pointerCount: pointersRef.current.size,
      camera: { x: currentCamera.x, y: currentCamera.y, zoom: currentCamera.zoom },
    };
  };

  const logPointerAction = (
    phase: string,
    action: string,
    reason: string,
    event: React.PointerEvent<HTMLCanvasElement>,
    extra?: () => DiagnosticData,
  ): void => {
    if (!diagnosticsEnabled()) return;
    try {
      recordInkDiagnostic('board.pointer.action', {
        scope: 'board',
        surfaceId: surfaceRef.current.page_id,
        phase,
        action,
        reason,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        button: event.button,
        gesture: activeGestureName(),
        ...(extra ? extra() : {}),
      });
    } catch {
      /* Diagnostics are observational and must never affect input. */
    }
  };

  const logSampleBatch = (
    phase: string,
    samples: readonly InkSample[],
    pointerId: number,
    terminal: boolean,
  ): void => {
    if (!diagnosticsEnabled()) return;
    try {
      recordInkDiagnostic('board.stroke.samples', {
        scope: 'board',
        surfaceId: surfaceRef.current.page_id,
        phase,
        pointerId,
        terminal,
        count: samples.length,
        first: sampleEdge(samples[0]),
        last: sampleEdge(samples[samples.length - 1]),
      });
    } catch {
      /* Diagnostics are observational and must never affect input. */
    }
  };

  const clearOverlay = () => {
    const overlay = overlayRef.current;
    const context = overlay?.getContext('2d');
    if (overlay) context?.clearRect(0, 0, overlay.width, overlay.height);
  };

  const cancelActiveGesture = () => {
    logBoardDiagnostic('board.gesture.cancel', {
      gesture: activeGestureName(),
      strokeSamples: activeStrokeRef.current?.samples.length ?? 0,
      pointerCount: pointersRef.current.size,
    });
    activeStrokeRef.current = null;
    eraserGestureRef.current = null;
    selectionGestureRef.current = null;
    panGestureRef.current = null;
    setSelectionDraft(null);
    setEraserCursor(null);
    clearOverlay();
  };

  const finishSelection = (cancelled: boolean) => {
    const gesture = selectionGestureRef.current;
    selectionGestureRef.current = null;
    setSelectionDraft(null);
    logBoardDiagnostic('board.selection.finish', {
      cancelled,
      mode: gesture?.mode ?? null,
      pointCount: gesture?.points.length ?? 0,
    });
    if (!gesture) {
      onSelectionChange(null);
      return;
    }
    if (cancelled) {
      onSelectionChange(null);
      return;
    }
    const points = gesture.mode === 'rectangle'
      ? (() => {
          const bounds = selectionBounds(gesture.points);
          if (!bounds || bounds.width <= 0 || bounds.height <= 0) return [];
          return [
            { x: bounds.x, y: bounds.y },
            { x: bounds.x + bounds.width, y: bounds.y },
            { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
            { x: bounds.x, y: bounds.y + bounds.height },
          ];
        })()
      : gesture.points;
    if (points.length < 3) {
      onSelectionChange(null);
      return;
    }
    const bounds = selectionBounds(points);
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      onSelectionChange(null);
      return;
    }
    const objectIds = objectsRef.current
      .filter((object) => objectIntersectsPolygon(object, points))
      .map((object) => object.id);
    logBoardDiagnostic('board.selection.commit', {
      mode: gesture.mode,
      pointCount: points.length,
      objectCount: objectIds.length,
    });
    onSelectionChange({ polygon: points, bounds, objectIds });
  };

  const pendingCommitsRef = useRef(new Set<Promise<void>>());
  const trackCommit = (commit: () => void | Promise<void>): Promise<void> => {
    let pending: Promise<void>;
    try {
      pending = Promise.resolve(commit());
    } catch (error) {
      pending = Promise.reject(error);
    }
    pendingCommitsRef.current.add(pending);
    void pending.then(
      () => { pendingCommitsRef.current.delete(pending); },
      (error: unknown) => {
        pendingCommitsRef.current.delete(pending);
        onError(error);
      },
    );
    return pending;
  };

  const finishStroke = (cancelled: boolean): Promise<void> => {
    const active = activeStrokeRef.current;
    activeStrokeRef.current = null;
    clearOverlay();
    if (!active || cancelled || active.samples.length === 0) {
      logBoardDiagnostic('board.stroke.finish', {
        cancelled,
        reason: !active ? 'no-active' : cancelled ? 'cancelled' : 'empty',
        pointerId: active?.pointerId ?? null,
        pointerType: active?.pointerType ?? null,
        sampleCount: active?.samples.length ?? 0,
      });
      return Promise.resolve();
    }
    logBoardDiagnostic('board.stroke.finish', {
      cancelled: false,
      reason: 'commit',
      pointerId: active.pointerId,
      pointerType: active.pointerType,
      sampleCount: active.samples.length,
      first: sampleEdge(active.samples[0]),
      last: sampleEdge(active.samples[active.samples.length - 1]),
    });
    return trackCommit(async () => {
      logBoardDiagnostic('board.stroke.commit', {
        phase: 'start',
        pointerId: active.pointerId,
        sampleCount: active.samples.length,
      });
      try {
        const accepted = await onCommitStroke({ kind: 'stroke', samples: active.samples, style: active.style });
        if (accepted === false) {
          logBoardDiagnostic('board.stroke.commit', {
            phase: 'rejected',
            pointerId: active.pointerId,
            sampleCount: active.samples.length,
          });
          throw new Error('Ink board stroke was not queued.');
        }
        logBoardDiagnostic('board.stroke.commit', {
          phase: 'settled',
          pointerId: active.pointerId,
          sampleCount: active.samples.length,
          accepted: true,
        });
      } catch (error) {
        logBoardDiagnostic('board.stroke.commit', {
          phase: 'error',
          pointerId: active.pointerId,
          sampleCount: active.samples.length,
          ...errorSummary(error),
        });
        if (!activeStrokeRef.current) {
          activeStrokeRef.current = active;
          renderFrame('commit-restore');
          logBoardDiagnostic('board.stroke.restore', {
            pointerId: active.pointerId,
            sampleCount: active.samples.length,
          });
        }
        throw error;
      }
    });
  };

  const finishEraser = (cancelled: boolean): Promise<void> => {
    const gesture = eraserGestureRef.current;
    eraserGestureRef.current = null;
    clearOverlay();
    if (!gesture || cancelled || gesture.hitIds.size === 0) {
      logBoardDiagnostic('board.eraser.finish', {
        cancelled,
        reason: !gesture ? 'no-active' : cancelled ? 'cancelled' : 'empty',
        pointerId: gesture?.pointerId ?? null,
        hitCount: gesture?.hitIds.size ?? 0,
      });
      return Promise.resolve();
    }
    logBoardDiagnostic('board.eraser.finish', {
      cancelled: false,
      reason: 'commit',
      pointerId: gesture.pointerId,
      hitCount: gesture.hitIds.size,
    });
    return trackCommit(async () => {
      logBoardDiagnostic('board.eraser.commit', {
        phase: 'start',
        pointerId: gesture.pointerId,
        hitCount: gesture.hitIds.size,
      });
      try {
        await onErase([...gesture.hitIds]);
        logBoardDiagnostic('board.eraser.commit', {
          phase: 'settled',
          pointerId: gesture.pointerId,
          hitCount: gesture.hitIds.size,
        });
      } catch (error) {
        logBoardDiagnostic('board.eraser.commit', {
          phase: 'error',
          pointerId: gesture.pointerId,
          hitCount: gesture.hitIds.size,
          ...errorSummary(error),
        });
        if (!eraserGestureRef.current) eraserGestureRef.current = gesture;
        throw error;
      }
    });
  };

  const finishInput = async (): Promise<void> => {
    const stroke = finishStroke(false);
    const eraser = finishEraser(false);
    await Promise.all([stroke, eraser, ...pendingCommitsRef.current]);
  };
  const finishInputRef = useRef(finishInput);
  finishInputRef.current = finishInput;

  const localPoint = (event: React.PointerEvent<HTMLCanvasElement>): InkPoint => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const localFromClient = (clientX: number, clientY: number): InkPoint => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: clientX, y: clientY };
    const rect = canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const beginPinch = () => {
    const positions = [...pointersRef.current.entries()];
    if (positions.length < 2) return;
    const [firstId, first] = positions[0];
    const [secondId, second] = positions[1];
    const firstLocal = localFromClient(first.clientX, first.clientY);
    const secondLocal = localFromClient(second.clientX, second.clientY);
    pinchGestureRef.current = {
      ids: [firstId, secondId],
      startDistance: Math.max(1, distance(firstLocal, secondLocal)),
      startCenter: midpoint(firstLocal, secondLocal),
      startCamera: cameraForEvent(),
    };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    capturePointerDiagnostic(event, () => pointerDiagnosticContext('down'));
    const currentTool = toolRef.current;
    pointersRef.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
    if (event.pointerType === 'touch') {
      event.preventDefault();
      const touchCount = [...pointersRef.current.keys()].length;
      if (touchCount >= 2) {
        logPointerAction('down', 'pinch', 'second-touch', event, () => ({ touchCount }));
        cancelActiveGesture();
        beginPinch();
        return;
      }
      if (!currentTool.touchDrawing && selectionModeRef.current === 'none') {
        logPointerAction('down', 'pan', 'touch-pan', event, () => ({ touchCount }));
        panGestureRef.current = { pointerId: event.pointerId, last: { x: event.clientX, y: event.clientY } };
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic input */ }
        return;
      }
    }

    if (event.button === 1 || (event.pointerType === 'mouse' && (spaceDownRef.current || event.button === 2))) {
      event.preventDefault();
      logPointerAction('down', 'pan', spaceDownRef.current ? 'space-pan' : event.button === 1 ? 'middle-button-pan' : 'right-button-pan', event);
      panGestureRef.current = { pointerId: event.pointerId, last: { x: event.clientX, y: event.clientY } };
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic input */ }
      return;
    }
    if (event.pointerType !== 'touch' && event.button !== 0) {
      logPointerAction('down', 'ignore', 'non-primary-button', event);
      return;
    }

    if (erasingRef.current) {
      logPointerAction('down', 'erase', 'eraser-active', event);
      const point = pointFromEvent(event);
      const gesture: EraserGesture = { pointerId: event.pointerId, lastPoint: point, hitIds: new Set() };
      for (const object of objectsRef.current) {
        if (objectHitTestSweep(object, point, point, currentTool.eraserSize / 2)) gesture.hitIds.add(object.id);
      }
      eraserGestureRef.current = gesture;
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic input */ }
      renderFrame('pointer-down');
      return;
    }

    if (selectionModeRef.current !== 'none') {
      logPointerAction('down', 'selection', `selection-${selectionModeRef.current}`, event);
      const start = pointFromEvent(event);
      selectionGestureRef.current = {
        pointerId: event.pointerId,
        mode: selectionModeRef.current,
        points: [start],
      };
      setSelectionDraft([start]);
      onSelectionChange(null);
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic input */ }
      return;
    }

    const pressureEnabled = currentTool.tool === 'pen' && event.pointerType === 'pen';
    logPointerAction('down', 'stroke', 'pen-or-touch-draw', event, () => ({ tool: currentTool.tool, pressureEnabled }));
    const active: ActiveStroke = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startedAt: event.timeStamp,
      samples: [],
      style: {
        tool: currentTool.tool,
        color: currentTool.color,
        width: currentTool.width,
        pressure_enabled: pressureEnabled,
      },
    };
    const downSamples = collectSamples(event, active);
    active.samples.push(...downSamples);
    logSampleBatch('down', downSamples, active.pointerId, false);
    activeStrokeRef.current = active;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic input */ }
    renderFrame('pointer-down');
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    capturePointerDiagnostic(event, () => pointerDiagnosticContext('move'));
    const pointer = pointersRef.current.get(event.pointerId);
    if (pointer) {
      pointer.clientX = event.clientX;
      pointer.clientY = event.clientY;
    }
    if (erasingRef.current) setEraserCursor(localPoint(event));

    const pinch = pinchGestureRef.current;
    if (pinch) {
      const first = pointersRef.current.get(pinch.ids[0]);
      const second = pointersRef.current.get(pinch.ids[1]);
      if (!first || !second) {
        logPointerAction('move', 'ignore', 'pinch-pointer-missing', event);
        return;
      }
      const firstLocal = localFromClient(first.clientX, first.clientY);
      const secondLocal = localFromClient(second.clientX, second.clientY);
      const center = midpoint(firstLocal, secondLocal);
      const factor = distance(firstLocal, secondLocal) / pinch.startDistance;
      let next = zoomCameraAt(pinch.startCamera, pinch.startCenter, pinch.startCamera.zoom * factor);
      next = panCameraBy(next, center.x - pinch.startCenter.x, center.y - pinch.startCenter.y);
      updateCamera(next);
      return;
    }

    const pan = panGestureRef.current;
    if (pan && pan.pointerId === event.pointerId) {
      const dx = event.clientX - pan.last.x;
      const dy = event.clientY - pan.last.y;
      pan.last = { x: event.clientX, y: event.clientY };
      updateCamera(panCameraBy(cameraForEvent(), dx, dy));
      return;
    }

    const selectionGesture = selectionGestureRef.current;
    if (selectionGesture && selectionGesture.pointerId === event.pointerId) {
      const point = pointFromEvent(event);
      const previous = selectionGesture.points[selectionGesture.points.length - 1];
      if (!previous || previous.x !== point.x || previous.y !== point.y) {
        selectionGesture.points.push(point);
        setSelectionDraft([...selectionGesture.points]);
      }
      return;
    }

    const eraserGesture = eraserGestureRef.current;
    if (eraserGesture && eraserGesture.pointerId === event.pointerId) {
      const point = pointFromEvent(event);
      const radius = toolRef.current.eraserSize / 2;
      for (const object of objectsRef.current) {
        if (!eraserGesture.hitIds.has(object.id)
          && objectHitTestSweep(object, eraserGesture.lastPoint, point, radius)) {
          eraserGesture.hitIds.add(object.id);
        }
      }
      eraserGesture.lastPoint = point;
      renderFrame('pointer-move');
      return;
    }

    const active = activeStrokeRef.current;
    if (active && active.pointerId === event.pointerId) {
      const moveSamples = collectSamples(event, active);
      active.samples.push(...moveSamples);
      logSampleBatch('move', moveSamples, active.pointerId, false);
      renderFrame('pointer-move');
      return;
    }
    logPointerAction(
      'move',
      'ignore',
      activeGestureName() === 'idle' ? 'no-active-gesture' : 'active-pointer-mismatch',
      event,
    );
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    capturePointerDiagnostic(event, () => pointerDiagnosticContext('up'));
    pointersRef.current.delete(event.pointerId);
    if (activeStrokeRef.current?.pointerId === event.pointerId) {
      const active = activeStrokeRef.current;
      if (active && event.type !== 'pointercancel') {
        const upSamples = collectSamples(event, active, true);
        active.samples.push(...upSamples);
        logSampleBatch('up', upSamples, active.pointerId, true);
      }
      logPointerAction(
        'up',
        event.type === 'pointercancel' ? 'stroke-cancel' : 'stroke-commit',
        event.type === 'pointercancel' ? 'pointercancel' : 'pointerup',
        event,
        () => ({ sampleCount: active?.samples.length ?? 0 }),
      );
      void finishStroke(event.type === 'pointercancel');
      return;
    }
    if (eraserGestureRef.current?.pointerId === event.pointerId) {
      const gesture = eraserGestureRef.current;
      if (gesture && event.type !== 'pointercancel') {
        const point = pointFromEvent(event);
        const radius = toolRef.current.eraserSize / 2;
        for (const object of objectsRef.current) {
          if (!gesture.hitIds.has(object.id)
            && objectHitTestSweep(object, gesture.lastPoint, point, radius)) {
            gesture.hitIds.add(object.id);
          }
        }
        gesture.lastPoint = point;
      }
      logPointerAction(
        'up',
        event.type === 'pointercancel' ? 'eraser-cancel' : 'eraser-commit',
        event.type === 'pointercancel' ? 'pointercancel' : 'pointerup',
        event,
        () => ({ hitCount: gesture?.hitIds.size ?? 0 }),
      );
      finishEraser(event.type === 'pointercancel');
      return;
    }
    if (selectionGestureRef.current?.pointerId === event.pointerId) {
      logPointerAction(
        'up',
        event.type === 'pointercancel' ? 'selection-cancel' : 'selection-commit',
        event.type === 'pointercancel' ? 'pointercancel' : 'pointerup',
        event,
      );
      finishSelection(event.type === 'pointercancel');
      return;
    }
    if (panGestureRef.current?.pointerId === event.pointerId) {
      logPointerAction('up', 'pan-end', 'pointerup', event);
      panGestureRef.current = null;
      return;
    }
    if (pinchGestureRef.current) {
      logPointerAction('up', 'pinch-end', 'pointerup', event);
      pinchGestureRef.current = null;
      return;
    }
    logPointerAction('up', 'ignore', 'no-active-gesture', event);
  };

  const onPointerCancel = (event: React.PointerEvent<HTMLCanvasElement>) => {
    capturePointerDiagnostic(event, () => pointerDiagnosticContext('cancel'));
    pointersRef.current.delete(event.pointerId);
    pinchGestureRef.current = null;
    if (activeStrokeRef.current?.pointerId === event.pointerId) {
      // An OS pointercancel ends the gesture at its last sample. Only the
      // explicit pinch promotion path discards an active stroke.
      logPointerAction('cancel', 'stroke-commit', 'os-pointercancel-continues-stroke', event, () => ({
        sampleCount: activeStrokeRef.current?.samples.length ?? 0,
      }));
      void finishStroke(false);
      return;
    }
    if (eraserGestureRef.current?.pointerId === event.pointerId) {
      logPointerAction('cancel', 'eraser-commit', 'os-pointercancel-continues-eraser', event, () => ({
        hitCount: eraserGestureRef.current?.hitIds.size ?? 0,
      }));
      finishEraser(false);
      return;
    }
    if (selectionGestureRef.current?.pointerId === event.pointerId) {
      logPointerAction('cancel', 'selection-cancel', 'os-pointercancel', event);
      finishSelection(true);
      return;
    }
    if (panGestureRef.current?.pointerId === event.pointerId) {
      logPointerAction('cancel', 'pan-cancel', 'os-pointercancel', event);
      panGestureRef.current = null;
      return;
    }
    logPointerAction('cancel', 'ignore', 'no-active-gesture', event);
  };

  const onPointerLeave = (event: React.PointerEvent<HTMLCanvasElement>) => {
    capturePointerDiagnostic(event, () => pointerDiagnosticContext('leave'));
    if (diagnosticsEnabled()) {
      logBoardDiagnostic('board.pointer.leave', {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        gesture: activeGestureName(),
      });
    }
    setEraserCursor(null);
  };

  const onGotPointerCapture = (event: React.PointerEvent<HTMLCanvasElement>) => {
    capturePointerDiagnostic(event, () => pointerDiagnosticContext('gotcapture'));
  };

  const onLostPointerCapture = (event: React.PointerEvent<HTMLCanvasElement>) => {
    capturePointerDiagnostic(event, () => pointerDiagnosticContext('lostcapture'));
  };

  useEffect(() => {
    renderFrame('effect');
  }, [renderFrame, surface, objects, camera]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => renderFrame('resize'));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [renderFrame]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const factor = Math.exp(-event.deltaY * 0.0015);
      updateCamera(zoomCameraAt(cameraForEvent(), anchor, cameraForEvent().zoom * factor));
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [updateCamera]);

  useEffect(() => {
    setSelectionDraft(null);
  }, [selection]);

  useImperativeHandle(ref, () => ({
    getViewportWorldRect() {
      const canvas = canvasRef.current;
      const width = canvas?.clientWidth ?? 1;
      const height = canvas?.clientHeight ?? 1;
      return cameraViewportRect(cameraForEvent(), {
        width: Math.max(1, width),
        height: Math.max(1, height),
      });
    },
    getViewportSize() {
      const canvas = canvasRef.current;
      return {
        width: Math.max(1, canvas?.clientWidth ?? 1),
        height: Math.max(1, canvas?.clientHeight ?? 1),
      };
    },
    finishStroke: () => finishInputRef.current(),
    focus() {
      canvasRef.current?.focus();
    },
  }), []);

  const previewPolygon = selectionDraft ?? selection?.polygon ?? null;
  const previewPoints = previewPolygon?.map((point) => {
    const screen = worldToScreen(point, camera);
    return `${screen.x},${screen.y}`;
  }).join(' ');
  const cursorSize = Math.max(4, tool.eraserSize * camera.zoom);

  return (
    <div
      ref={viewportRef}
      data-testid="ink-board-viewport"
      className={`relative h-full min-h-0 w-full overflow-hidden bg-[var(--surface-panel)] ${className ?? ''}`}
    >
      <canvas
        ref={canvasRef}
        data-testid="ink-board-canvas"
        data-camera={JSON.stringify({ x: camera.x, y: camera.y, zoom: camera.zoom })}
        aria-label={ariaLabel}
        tabIndex={0}
        className="block h-full w-full touch-none outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary/60"
        style={{
          cursor: erasing ? 'none' : selectionMode !== 'none' ? 'crosshair' : spaceDown ? 'grab' : 'crosshair',
          touchAction: 'none',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerLeave}
        onGotPointerCapture={onGotPointerCapture}
        onLostPointerCapture={onLostPointerCapture}
        onContextMenu={(event) => event.preventDefault()}
      />
      <canvas
        ref={overlayRef}
        data-testid="ink-board-active-stroke-canvas"
        className="pointer-events-none absolute inset-0 block h-full w-full"
        aria-hidden
      />
      {previewPoints && (
        <svg
          className="pointer-events-none absolute inset-0"
          width="100%"
          height="100%"
          aria-hidden
        >
          <polygon
            points={previewPoints}
            fill="rgba(59, 130, 246, 0.12)"
            stroke="rgba(59, 130, 246, 0.9)"
            strokeWidth={1.5}
          />
        </svg>
      )}
      {erasing && eraserCursor && (
        <div
          data-testid="ink-board-eraser-cursor"
          className="pointer-events-none absolute rounded-full border border-destructive/80 bg-destructive/10"
          style={{
            left: eraserCursor.x - cursorSize / 2,
            top: eraserCursor.y - cursorSize / 2,
            width: cursorSize,
            height: cursorSize,
          }}
        />
      )}
    </div>
  );
});
