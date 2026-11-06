import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { objectHitTest, objectHitTestSweep, screenToPage, type InkViewport } from './geometry';
import { collectPointerSamples } from './input';
import { captureInkPointerEvent, isInkDiagnosticsEnabled, recordInkDiagnostic } from './inkDiagnostics';
import { renderInkPage } from './renderer';
import { selectionBounds } from './selection';
import type { InkObject, InkPage, InkPageRef, InkPoint, InkRect, InkSample, InkStrokeStyle } from './types';

const diagnosticsEnabled = (): boolean => {
  try {
    return isInkDiagnosticsEnabled();
  } catch {
    return false;
  }
};

const safeCaptureInkPointerEvent = (event: PointerEvent, data: () => Record<string, unknown>): void => {
  try {
    if (!isInkDiagnosticsEnabled()) return;
    captureInkPointerEvent(event, data(), { includeCoalesced: false });
  } catch {
    // Diagnostics are a pure side channel and must never affect input.
  }
};

const safeRecordInkDiagnostic = (event: string, data: () => Record<string, unknown>): void => {
  try {
    if (!isInkDiagnosticsEnabled()) return;
    recordInkDiagnostic(event, data());
  } catch {
    // Diagnostics are a pure side channel and must never affect input.
  }
};

const diagnosticsNow = (): number => {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
    return Date.now();
  } catch {
    return Date.now();
  }
};

const diagnosticError = (error: unknown): string => {
  try {
    if (error instanceof Error && typeof error.name === 'string' && error.name) return error.name;
    return typeof error === 'string' ? 'Error' : typeof error;
  } catch {
    return 'Error';
  }
};

const PAGE_TOUCH_ACTION = 'none' as const;

export type InkSelectionMode = 'none' | 'rectangle' | 'lasso';

export interface InkSelectionRegion {
  polygon: InkPoint[];
  bounds: InkRect;
}

export interface InkToolSettings extends InkStrokeStyle {
  touchDrawing: boolean;
  zoom: number;
  panX: number;
  panY: number;
  eraserSize: number;
}

export interface InkPageViewHandle {
  finishStroke(): Promise<void>;
  eraseAt(point: { x: number; y: number }): Promise<void>;
  /** Logical page point at the center of the actually visible canvas/viewport intersection. */
  getViewportCenter(): InkPoint;
}

export interface InkPageViewProps {
  documentId: string;
  pageRef: InkPageRef;
  page: InkPage;
  background?: CanvasImageSource;
  tool: InkToolSettings;
  erasing: boolean;
  selectionMode?: InkSelectionMode;
  selectionBounds?: InkRect | null;
  onPageChange(page: InkPage): Promise<void>;
  onActiveStrokeChange?(active: boolean): void;
  onSelectionChange?(selection: InkSelectionRegion | null): void;
  onViewportWidthChange?(width: number): void;
  onViewportInteraction?(): void;
  onError?(error: unknown): void;
  ariaLabel: string;
}

interface ActiveStroke {
  pointerId: number;
  startedAt: number;
  pointerType: string;
  samples: InkSample[];
  style: InkStrokeStyle;
}

interface EraserGesture {
  pointerId: number;
  basePage: InkPage;
  lastPoint: InkPoint;
  hitIds: Set<string>;
  radius: number;
}

interface SelectionGesture {
  pointerId: number;
  mode: Exclude<InkSelectionMode, 'none'>;
  points: InkPoint[];
}

interface PanGesture {
  pointerId: number;
  lastClientX: number;
  lastClientY: number;
}

const makeObjectId = (): string => globalThis.crypto?.randomUUID?.()
  ?? `ink-object-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const InkPageView = forwardRef<InkPageViewHandle, InkPageViewProps>(function InkPageView(
  {
    documentId,
    pageRef,
    page,
    background,
    tool,
    erasing,
    selectionMode = 'none',
    selectionBounds: selectionBoundsProp,
    onPageChange,
    onActiveStrokeChange,
    onSelectionChange,
    onViewportWidthChange,
    onViewportInteraction,
    onError,
    ariaLabel,
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const activeStrokeRef = useRef<ActiveStroke | null>(null);
  const eraserGestureRef = useRef<EraserGesture | null>(null);
  const selectionGestureRef = useRef<SelectionGesture | null>(null);
  const panGestureRef = useRef<PanGesture | null>(null);
  const renderSequenceRef = useRef(0);
  const [eraserCursor, setEraserCursor] = useState<{ x: number; y: number } | null>(null);
  const [selectionDraft, setSelectionDraft] = useState<InkPoint[] | null>(null);
  const [selectionRegion, setSelectionRegion] = useState<InkSelectionRegion | null>(null);
  const callbacksRef = useRef({ onPageChange, onActiveStrokeChange, onSelectionChange, onViewportWidthChange, onViewportInteraction, onError });
  const currentRef = useRef({ pageRef, page, background, tool, erasing, selectionMode });
  callbacksRef.current = { onPageChange, onActiveStrokeChange, onSelectionChange, onViewportWidthChange, onViewportInteraction, onError };
  currentRef.current = { pageRef, page, background, tool, erasing, selectionMode };

  const reportViewportWidth = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const style = window.getComputedStyle(viewport);
    const width = viewport.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    if (width > 0) callbacksRef.current.onViewportWidthChange?.(width);
  }, []);
  useEventRegistry([{ target: 'window', type: 'resize', listener: reportViewportWidth }], [reportViewportWidth]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    reportViewportWidth();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(reportViewportWidth);
    observer?.observe(viewport);
    return () => observer?.disconnect();
  }, [documentId, pageRef.page_id, pageRef.width, reportViewportWidth]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
    panGestureRef.current = null;
  }, [documentId, pageRef.page_id]);

  const render = (target: HTMLCanvasElement, page: InkPage, transparent = false) => {
    const current = currentRef.current;
    const scale = Math.min(current.tool.zoom, Math.sqrt(16_000_000 / (current.pageRef.width * current.pageRef.height)));
    const diagnosticsOn = diagnosticsEnabled();
    const renderId = diagnosticsOn ? ++renderSequenceRef.current : 0;
    const renderStartedAt = diagnosticsOn ? diagnosticsNow() : 0;
    const renderTarget = target === canvasRef.current ? 'page' : target === overlayRef.current ? 'overlay' : 'other';
    if (diagnosticsOn) {
      safeRecordInkDiagnostic('page.render.start', () => ({
        renderId,
        documentId,
        pageId: page.page_id,
        target: renderTarget,
        transparent,
        scale,
        objectCount: page.objects.length,
        backgroundPresent: Boolean(current.background),
        backgroundDrawn: !transparent && Boolean(current.background),
        pageWidth: current.pageRef.width,
        pageHeight: current.pageRef.height,
        canvasWidth: target.width,
        canvasHeight: target.height,
        activePointerId: activeStrokeRef.current?.pointerId ?? null,
        activeSamples: activeStrokeRef.current?.samples.length ?? 0,
      }));
    }
    try {
      const result = renderInkPage(target, current.pageRef, page, {
        background: transparent ? undefined : current.background,
        scale,
        max_pixels: 16_000_000,
        transparent,
      });
      if (diagnosticsOn) {
        safeRecordInkDiagnostic('page.render.end', () => ({
          renderId,
          documentId,
          pageId: page.page_id,
          target: renderTarget,
          transparent,
          durationMs: diagnosticsNow() - renderStartedAt,
          widthPx: result.width_px,
          heightPx: result.height_px,
          objectCount: page.objects.length,
          backgroundPresent: Boolean(current.background),
          backgroundDrawn: !transparent && Boolean(current.background),
          pageWidth: current.pageRef.width,
          pageHeight: current.pageRef.height,
          activePointerId: activeStrokeRef.current?.pointerId ?? null,
          activeSamples: activeStrokeRef.current?.samples.length ?? 0,
        }));
      }
      return result;
    } catch (error) {
      if (diagnosticsOn) {
        safeRecordInkDiagnostic('page.render.error', () => ({
          renderId,
          documentId,
          pageId: page.page_id,
          target: renderTarget,
          transparent,
          durationMs: diagnosticsNow() - renderStartedAt,
          objectCount: page.objects.length,
          errorType: diagnosticError(error),
        }));
      }
      throw error;
    }
  };

  const renderActiveStroke = () => {
    const overlay = overlayRef.current;
    const active = activeStrokeRef.current;
    if (!overlay) return;
    const current = currentRef.current;
    overlay.style.mixBlendMode = active?.style.tool === 'highlighter' ? 'multiply' : 'normal';
    if (!active?.samples.length) {
      const context = overlay.getContext('2d');
      context?.clearRect(0, 0, overlay.width, overlay.height);
      return;
    }
    const preview: InkObject = {
      id: 'active-stroke-preview',
      author: 'user',
      created_at: 0,
      content: { kind: 'stroke', samples: active.samples, style: active.style },
    };
    const previewPage: InkPage = { schema_version: current.page.schema_version, page_id: current.page.page_id, objects: [preview] };
    renderPageRef.current(overlay, previewPage, true);
  };

  const clearEraserPreview = () => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const context = overlay.getContext('2d');
    context?.clearRect(0, 0, overlay.width, overlay.height);
    overlay.style.mixBlendMode = 'normal';
  };

  const renderEraserPreview = () => {
    const overlay = overlayRef.current;
    const gesture = eraserGestureRef.current;
    if (!overlay) return;
    overlay.style.mixBlendMode = 'normal';
    if (!gesture || gesture.hitIds.size === 0) {
      clearEraserPreview();
      return;
    }
    const previewPage: InkPage = {
      ...gesture.basePage,
      objects: gesture.basePage.objects.filter((object) => !gesture.hitIds.has(object.id)),
    };
    renderPageRef.current(overlay, previewPage, false);
  };

  const collectEraserHits = (gesture: EraserGesture, start: InkPoint, end: InkPoint) => {
    for (const object of gesture.basePage.objects) {
      if (gesture.hitIds.has(object.id)) continue;
      if (objectHitTestSweep(object, start, end, gesture.radius)) gesture.hitIds.add(object.id);
    }
  };

  const finishEraserGesture = async () => {
    const gesture = eraserGestureRef.current;
    if (!gesture) return;
    eraserGestureRef.current = null;
    callbacksRef.current.onActiveStrokeChange?.(false);
    clearEraserPreview();
    if (!gesture.hitIds.size) return;

    const current = currentRef.current;
    // A remote reload advanced the page while the gesture was active. Never
    // apply stroke ids captured from the older page to the newer one.
    if (current.page !== gesture.basePage) return;

    const nextPage: InkPage = {
      ...current.page,
      objects: current.page.objects.filter((object) => !gesture.hitIds.has(object.id)),
    };
    if (nextPage.objects.length === current.page.objects.length) return;
    currentRef.current = { ...current, page: nextPage };
    await callbacksRef.current.onPageChange(nextPage);
  };

  const finishStroke = async () => {
    if (eraserGestureRef.current) {
      await finishEraserGesture();
      return;
    }
    const active = activeStrokeRef.current;
    if (!active) return;
    const diagnosticsOn = diagnosticsEnabled();
    const finishStartedAt = diagnosticsOn ? diagnosticsNow() : 0;
    if (diagnosticsOn) {
      safeRecordInkDiagnostic('page.stroke.finish.start', () => ({
        documentId,
        pageId: currentRef.current.pageRef.page_id,
        pointerId: active.pointerId,
        startedAt: active.startedAt,
        samples: active.samples.length,
        objectCount: currentRef.current.page.objects.length,
        activePointerId: active.pointerId,
        backgroundPresent: Boolean(currentRef.current.background),
        pageWidth: currentRef.current.pageRef.width,
        pageHeight: currentRef.current.pageRef.height,
      }));
    }
    activeStrokeRef.current = null;
    callbacksRef.current.onActiveStrokeChange?.(false);
    renderActiveStroke();
    if (!active.samples.length) {
      safeRecordInkDiagnostic('page.stroke.finish.empty', () => ({
        documentId,
        pageId: currentRef.current.pageRef.page_id,
        pointerId: active.pointerId,
        startedAt: active.startedAt,
        samples: 0,
      }));
      return;
    }

    const current = currentRef.current;
    const stroke: InkObject = {
      id: makeObjectId(),
      author: 'user',
      created_at: Date.now(),
      content: {
        kind: 'stroke',
        samples: active.samples,
        style: active.style,
      },
    };
    const nextPage = { ...current.page, objects: [...current.page.objects, stroke] };
    currentRef.current = { ...current, page: nextPage };
    try {
      await callbacksRef.current.onPageChange(nextPage);
    } catch (error) {
      safeRecordInkDiagnostic('page.stroke.finish.error', () => ({
        documentId,
        pageId: current.pageRef.page_id,
        pointerId: active.pointerId,
        startedAt: active.startedAt,
        strokeId: stroke.id,
        lastObjectId: stroke.id,
        samples: active.samples.length,
        objectCount: nextPage.objects.length,
        durationMs: diagnosticsOn ? diagnosticsNow() - finishStartedAt : 0,
        errorType: diagnosticError(error),
      }));
      throw error;
    }
    safeRecordInkDiagnostic('page.stroke.finish.commit', () => ({
      documentId,
      pageId: current.pageRef.page_id,
      pointerId: active.pointerId,
      startedAt: active.startedAt,
      strokeId: stroke.id,
      lastObjectId: stroke.id,
      samples: active.samples.length,
      objectCount: nextPage.objects.length,
      addedObjects: nextPage.objects.length - current.page.objects.length,
      durationMs: diagnosticsOn ? diagnosticsNow() - finishStartedAt : 0,
      backgroundPresent: Boolean(currentRef.current.background),
      pageWidth: current.pageRef.width,
      pageHeight: current.pageRef.height,
      activePointerId: activeStrokeRef.current?.pointerId ?? null,
      activeSamples: activeStrokeRef.current?.samples.length ?? 0,
    }));
  };

  const eraseAt = async (point: InkPoint) => {
    const current = currentRef.current;
    const radius = Math.max(0, current.tool.eraserSize) / 2;
    for (let index = current.page.objects.length - 1; index >= 0; index -= 1) {
      if (objectHitTest(current.page.objects[index], point, radius)) {
        const nextPage = { ...current.page, objects: current.page.objects.filter((_, objectIndex) => objectIndex !== index) };
        currentRef.current = { ...current, page: nextPage };
        await callbacksRef.current.onPageChange(nextPage);
        return;
      }
    }
  };

  const getViewportCenter = (): InkPoint => {
    const current = currentRef.current;
    const fallback = {
      x: Math.max(0, Math.min(current.pageRef.width, current.pageRef.width / 2)),
      y: Math.max(0, Math.min(current.pageRef.height, current.pageRef.height / 2)),
    };
    const canvas = canvasRef.current;
    const container = viewportRef.current;
    if (!canvas || !container || typeof window === 'undefined') return fallback;

    const canvasRect = canvas.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    if (canvasRect.width <= 0 || container.clientWidth <= 0 || container.clientHeight <= 0) return fallback;

    const containerLeft = containerRect.left + container.clientLeft;
    const containerTop = containerRect.top + container.clientTop;
    const containerRight = containerLeft + container.clientWidth;
    const containerBottom = containerTop + container.clientHeight;
    const left = Math.max(containerLeft, canvasRect.left, 0);
    const top = Math.max(containerTop, canvasRect.top, 0);
    const right = Math.min(containerRight, canvasRect.right, window.innerWidth);
    const bottom = Math.min(containerBottom, canvasRect.bottom, window.innerHeight);
    if (right <= left || bottom <= top) return fallback;

    const scale = canvasRect.width / current.pageRef.width;
    const center = screenToPage(
      { x: (left + right) / 2, y: (top + bottom) / 2 },
      { left: canvasRect.left, top: canvasRect.top, scale, pan_x: 0, pan_y: 0 },
    );
    return {
      x: Math.max(0, Math.min(current.pageRef.width, center.x)),
      y: Math.max(0, Math.min(current.pageRef.height, center.y)),
    };
  };

  const finishStrokeRef = useRef(finishStroke);
  const eraseAtRef = useRef(eraseAt);
  const getViewportCenterRef = useRef(getViewportCenter);
  const renderPageRef = useRef(render);
  const renderActiveStrokeRef = useRef(renderActiveStroke);
  const renderEraserPreviewRef = useRef(renderEraserPreview);
  finishStrokeRef.current = finishStroke;
  eraseAtRef.current = eraseAt;
  getViewportCenterRef.current = getViewportCenter;
  renderPageRef.current = render;
  renderActiveStrokeRef.current = renderActiveStroke;
  renderEraserPreviewRef.current = renderEraserPreview;
  useImperativeHandle(ref, () => ({
    finishStroke: () => finishStrokeRef.current(),
    eraseAt: (point) => eraseAtRef.current(point),
    getViewportCenter: () => getViewportCenterRef.current(),
  }), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;
    renderPageRef.current(canvas, page);
    if (activeStrokeRef.current) renderActiveStrokeRef.current();
    if (eraserGestureRef.current) renderEraserPreviewRef.current();
  }, [pageRef, page, background, tool.zoom]);

  // 翻页/页面对象变化后 transient selection 失效，不写入 page/manifest。
  useEffect(() => {
    selectionGestureRef.current = null;
    setSelectionDraft(null);
    setSelectionRegion(null);
  }, [pageRef.page_id, page]);

  useEffect(() => {
    if (selectionMode !== 'none') return;
    selectionGestureRef.current = null;
    setSelectionDraft(null);
    setSelectionRegion(null);
  }, [selectionMode]);

  useEffect(() => {
    panGestureRef.current = null;
  }, [tool.touchDrawing, selectionMode]);

  // 宿主清空选区（切模式/翻页/发 Chat 后）时同步清掉本地预览；
  // 拖拽过程中宿主仍为 null，不能误清 draft。
  useEffect(() => {
    if (selectionBoundsProp || selectionGestureRef.current) return;
    setSelectionDraft(null);
    setSelectionRegion(null);
  }, [selectionBoundsProp]);

  useEffect(() => () => {
    if (activeStrokeRef.current || eraserGestureRef.current) {
      void finishStrokeRef.current().catch((error) => callbacksRef.current.onError?.(error));
    }
  }, []);

  const viewport = (element: HTMLCanvasElement) => {
    const rect = element.getBoundingClientRect();
    const current = currentRef.current;
    const scale = rect.width / current.pageRef.width;
    return {
      left: rect.left,
      top: rect.top,
      scale,
      pan_x: 0,
      pan_y: 0,
    };
  };

  const pointerDiagnosticData = (event: React.PointerEvent<HTMLElement>, extra: Record<string, unknown> = {}) => {
    const current = currentRef.current;
    const active = activeStrokeRef.current;
    const selection = selectionGestureRef.current;
    const eraser = eraserGestureRef.current;
    const pan = panGestureRef.current;
    const viewportElement = viewportRef.current;
    return {
      documentId,
      pageId: current.pageRef.page_id,
      tool: current.tool.tool,
      touchDrawing: current.tool.touchDrawing,
      touchAction: PAGE_TOUCH_ACTION,
      scrollLeft: viewportElement?.scrollLeft ?? 0,
      scrollTop: viewportElement?.scrollTop ?? 0,
      panActive: Boolean(pan),
      panPointerId: pan?.pointerId ?? null,
      erasing: current.erasing,
      selectionMode: current.selectionMode,
      mode: active ? 'stroke' : eraser ? 'eraser' : selection ? 'selection' : pan ? 'pan' : 'idle',
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      eventType: event.type,
      activePointerId: active?.pointerId ?? eraser?.pointerId ?? selection?.pointerId ?? pan?.pointerId ?? null,
      samples: active?.samples.length ?? 0,
      selectionPoints: selection?.points.length ?? 0,
      eraserHits: eraser?.hitIds.size ?? 0,
      ...(event.type === 'pointercancel' ? { cancelSampled: false } : {}),
      ...extra,
    };
  };

  const recordPointerCaptureRequest = (
    event: React.PointerEvent<HTMLElement>,
    gesture: 'stroke' | 'eraser' | 'selection' | 'pan',
    result: 'got' | 'lost',
  ) => {
    safeRecordInkDiagnostic('page.pointer.capture.request', () => ({
      ...pointerDiagnosticData(event, { gesture }),
      result,
    }));
  };

  const recordPointerCaptureLifecycle = (event: React.PointerEvent<HTMLElement>, phase: 'got' | 'lost') => {
    safeRecordInkDiagnostic(`page.pointer.capture.${phase}`, () => ({
      ...pointerDiagnosticData(event, {
        gesture: activeStrokeRef.current ? 'stroke' : eraserGestureRef.current ? 'eraser' : selectionGestureRef.current ? 'selection' : panGestureRef.current ? 'pan' : null,
      }),
      capturePhase: phase,
    }));
  };

  const startPan = (event: React.PointerEvent<HTMLElement>) => {
    event.preventDefault();
    panGestureRef.current = {
      pointerId: event.pointerId,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
      recordPointerCaptureRequest(event, 'pan', 'got');
    } catch {
      recordPointerCaptureRequest(event, 'pan', 'lost');
    }
  };

  const movePan = (event: React.PointerEvent<HTMLElement>): boolean => {
    const pan = panGestureRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return false;
    const viewportElement = viewportRef.current;
    if (viewportElement) {
      viewportElement.scrollLeft -= event.clientX - pan.lastClientX;
      viewportElement.scrollTop -= event.clientY - pan.lastClientY;
    }
    pan.lastClientX = event.clientX;
    pan.lastClientY = event.clientY;
    return true;
  };

  const endPan = (pointerId: number): boolean => {
    if (panGestureRef.current?.pointerId !== pointerId) return false;
    panGestureRef.current = null;
    return true;
  };

  const recordSampleBatch = (
    phase: 'down' | 'move' | 'up' | 'cancel',
    event: React.PointerEvent<HTMLCanvasElement>,
    active: ActiveStroke,
    batch: InkSample[],
    previousLast: InkSample | undefined,
    view: InkViewport | null,
    terminal = false,
  ) => {
    if (!diagnosticsEnabled()) return;
    safeRecordInkDiagnostic('page.stroke.samples', () => {
      const first = batch[0];
      const last = batch[batch.length - 1];
      const prior = batch.length >= 2 ? batch[batch.length - 2] : previousLast;
      const jump = (from: InkSample | undefined, to: InkSample | undefined) => {
        if (!from || !to) return null;
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        return { dx, dy, distance: Math.hypot(dx, dy) };
      };
      const sampleData = (sample: InkSample) => ({
        x: sample.x,
        y: sample.y,
        pressure: sample.pressure,
        elapsed_ms: sample.elapsed_ms,
      });
      return {
        ...pointerDiagnosticData(event, {
          phase,
          terminal,
          cancelled: event.type === 'pointercancel',
          mode: 'stroke',
          activePointerId: active.pointerId,
          samples: active.samples.length,
        }),
        batchCount: batch.length,
        first: first ? sampleData(first) : null,
        last: last ? sampleData(last) : null,
        previousLast: previousLast ? { x: previousLast.x, y: previousLast.y } : null,
        firstJump: jump(previousLast, first),
        tailJump: jump(prior, last),
        viewport: view,
      };
    });
  };

  const samplesFor = (event: React.PointerEvent<HTMLCanvasElement>, active: ActiveStroke, terminal = false) => {
    const element = canvasRef.current;
    if (!element) return { samples: [] as InkSample[], viewport: null };
    const view = viewport(element);
    return {
      samples: collectPointerSamples(event.nativeEvent, view, active.startedAt,
        active.pointerType === 'pen' && currentRef.current.tool.pressure_enabled, {
          terminal,
          cancelled: event.type === 'pointercancel',
          pageBounds: { width: currentRef.current.pageRef.width, height: currentRef.current.pageRef.height },
        }),
      viewport: view,
    };
  };

  const updateEraserCursor = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!currentRef.current.erasing) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setEraserCursor({ x: event.clientX - rect.left, y: event.clientY - rect.top });
  };

  const selectionPoint = (event: React.PointerEvent<HTMLCanvasElement>): InkPoint => {
    const point = screenToPage({ x: event.clientX, y: event.clientY }, viewport(event.currentTarget));
    const { width, height } = currentRef.current.pageRef;
    return {
      x: Math.max(0, Math.min(width, point.x)),
      y: Math.max(0, Math.min(height, point.y)),
    };
  };

  const finalizeSelectionGesture = (cancelled = false) => {
    const gesture = selectionGestureRef.current;
    if (!gesture) return;
    selectionGestureRef.current = null;
    setSelectionDraft(null);
    const minimumPoints = gesture.mode === 'rectangle' ? 2 : 3;
    if (cancelled || gesture.points.length < minimumPoints) {
      setSelectionRegion(null);
      callbacksRef.current.onSelectionChange?.(null);
      return;
    }

    const rawBounds = selectionBounds(gesture.points);
    if (!rawBounds || rawBounds.width <= 0 || rawBounds.height <= 0) {
      setSelectionRegion(null);
      callbacksRef.current.onSelectionChange?.(null);
      return;
    }

    const polygon: InkPoint[] = gesture.mode === 'rectangle'
      ? [
          { x: rawBounds.x, y: rawBounds.y },
          { x: rawBounds.x + rawBounds.width, y: rawBounds.y },
          { x: rawBounds.x + rawBounds.width, y: rawBounds.y + rawBounds.height },
          { x: rawBounds.x, y: rawBounds.y + rawBounds.height },
        ]
      : gesture.points;
    const bounds = selectionBounds(polygon);
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      setSelectionRegion(null);
      callbacksRef.current.onSelectionChange?.(null);
      return;
    }

    const region = { polygon, bounds };
    setSelectionRegion(region);
    callbacksRef.current.onSelectionChange?.(region);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const current = currentRef.current;
    const touch = event.pointerType === 'touch';
    const activePan = panGestureRef.current;
    if (activePan && !touch) panGestureRef.current = null;
    const touchPan = touch && !current.tool.touchDrawing && current.selectionMode === 'none';
    const ignored = activeStrokeRef.current ? 'active'
      : eraserGestureRef.current ? 'eraser'
      : selectionGestureRef.current ? 'selection'
      : activePan && touch ? 'pan-active'
      : null;
    safeCaptureInkPointerEvent(event.nativeEvent, () => pointerDiagnosticData(event, { phase: 'down', ignored }));
    if (activeStrokeRef.current || eraserGestureRef.current || selectionGestureRef.current
      || (activePan && touch)) return;
    if (touch) event.preventDefault();
    if (touchPan) {
      startPan(event);
      return;
    }
    updateEraserCursor(event);
    const point = screenToPage({ x: event.clientX, y: event.clientY }, viewport(event.currentTarget));
    if (current.erasing) {
      const gesture: EraserGesture = {
        pointerId: event.pointerId,
        basePage: current.page,
        lastPoint: point,
        hitIds: new Set<string>(),
        radius: Math.max(0, current.tool.eraserSize) / 2,
      };
      collectEraserHits(gesture, point, point);
      eraserGestureRef.current = gesture;
      callbacksRef.current.onActiveStrokeChange?.(true);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
        recordPointerCaptureRequest(event, 'eraser', 'got');
      } catch {
        recordPointerCaptureRequest(event, 'eraser', 'lost');
        /* Synthetic input may not support capture. */
      }
      renderEraserPreview();
      return;
    }

    if (current.selectionMode !== 'none') {
      const start = selectionPoint(event);
      selectionGestureRef.current = {
        pointerId: event.pointerId,
        mode: current.selectionMode,
        points: [start],
      };
      setSelectionRegion(null);
      setSelectionDraft([start]);
      callbacksRef.current.onSelectionChange?.(null);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
        recordPointerCaptureRequest(event, 'selection', 'got');
      } catch {
        recordPointerCaptureRequest(event, 'selection', 'lost');
        /* Synthetic input may not support capture. */
      }
      return;
    }

    const active: ActiveStroke = {
      pointerId: event.pointerId,
      startedAt: event.timeStamp,
      pointerType: event.pointerType,
      samples: [],
      style: {
        tool: current.tool.tool,
        color: current.tool.color,
        width: current.tool.width,
        pressure_enabled: current.tool.tool === 'pen' && event.pointerType === 'pen' && current.tool.pressure_enabled,
      },
    };
    const previousLast = active.samples[active.samples.length - 1];
    const collected = samplesFor(event, active);
    active.samples.push(...collected.samples);
    recordSampleBatch('down', event, active, collected.samples, previousLast, collected.viewport);
    activeStrokeRef.current = active;
    callbacksRef.current.onActiveStrokeChange?.(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
      recordPointerCaptureRequest(event, 'stroke', 'got');
    } catch {
      recordPointerCaptureRequest(event, 'stroke', 'lost');
      /* Synthetic input may not support capture. */
    }
    renderActiveStroke();
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    safeCaptureInkPointerEvent(event.nativeEvent, () => pointerDiagnosticData(event, { phase: 'move' }));
    if (movePan(event)) return;
    updateEraserCursor(event);
    const selection = selectionGestureRef.current;
    if (selection && selection.pointerId === event.pointerId) {
      const point = selectionPoint(event);
      const previous = selection.points[selection.points.length - 1];
      if (!previous || previous.x !== point.x || previous.y !== point.y) {
        selection.points.push(point);
        setSelectionDraft([...selection.points]);
      }
      return;
    }
    const gesture = eraserGestureRef.current;
    if (gesture && gesture.pointerId === event.pointerId) {
      const point = screenToPage({ x: event.clientX, y: event.clientY }, viewport(event.currentTarget));
      collectEraserHits(gesture, gesture.lastPoint, point);
      gesture.lastPoint = point;
      renderEraserPreview();
      return;
    }
    const active = activeStrokeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const previousLast = active.samples[active.samples.length - 1];
    const collected = samplesFor(event, active);
    active.samples.push(...collected.samples);
    recordSampleBatch('move', event, active, collected.samples, previousLast, collected.viewport);
    renderActiveStroke();
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    safeCaptureInkPointerEvent(event.nativeEvent, () => pointerDiagnosticData(event, { phase: 'up' }));
    if (endPan(event.pointerId)) return;
    const selection = selectionGestureRef.current;
    if (selection && selection.pointerId === event.pointerId) {
      const point = selectionPoint(event);
      const previous = selection.points[selection.points.length - 1];
      if (!previous || previous.x !== point.x || previous.y !== point.y) {
        selection.points.push(point);
      }
      finalizeSelectionGesture();
      return;
    }
    const gesture = eraserGestureRef.current;
    if (gesture && gesture.pointerId === event.pointerId) {
      const point = screenToPage({ x: event.clientX, y: event.clientY }, viewport(event.currentTarget));
      collectEraserHits(gesture, gesture.lastPoint, point);
      gesture.lastPoint = point;
      renderEraserPreview();
      void finishEraserGesture().catch((error) => callbacksRef.current.onError?.(error));
      return;
    }
    const active = activeStrokeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const previousLast = active.samples[active.samples.length - 1];
    const collected = samplesFor(event, active, true);
    active.samples.push(...collected.samples);
    recordSampleBatch('up', event, active, collected.samples, previousLast, collected.viewport, true);
    void finishStroke().catch((error) => callbacksRef.current.onError?.(error));
  };

  const onPointerCancel = (event: React.PointerEvent<HTMLCanvasElement>) => {
    safeCaptureInkPointerEvent(event.nativeEvent, () => pointerDiagnosticData(event, { phase: 'cancel', cancelled: true }));
    if (endPan(event.pointerId)) return;
    const selection = selectionGestureRef.current;
    if (selection && selection.pointerId === event.pointerId) {
      finalizeSelectionGesture(true);
      return;
    }
    const gesture = eraserGestureRef.current;
    if (gesture && gesture.pointerId === event.pointerId) {
      void finishEraserGesture().catch((error) => callbacksRef.current.onError?.(error));
      return;
    }
    const active = activeStrokeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const previousLast = active.samples[active.samples.length - 1];
    recordSampleBatch('cancel', event, active, [], previousLast, null, true);
    void finishStroke().catch((error) => callbacksRef.current.onError?.(error));
  };

  const onLostPointerCapture = (event: React.PointerEvent<HTMLCanvasElement>) => {
    recordPointerCaptureLifecycle(event, 'lost');
    endPan(event.pointerId);
  };

  const onViewportPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.pointerType !== 'touch') return;
    const ignored = activeStrokeRef.current ? 'active'
      : eraserGestureRef.current ? 'eraser'
      : selectionGestureRef.current ? 'selection'
      : panGestureRef.current ? 'pan-active'
      : null;
    safeCaptureInkPointerEvent(event.nativeEvent, () => pointerDiagnosticData(event, { phase: 'down', ignored, area: 'padding' }));
    if (!ignored) startPan(event);
  };

  const onViewportPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.pointerType !== 'touch') return;
    safeCaptureInkPointerEvent(event.nativeEvent, () => pointerDiagnosticData(event, { phase: 'move', area: 'padding' }));
    movePan(event);
  };

  const onViewportPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.pointerType !== 'touch') return;
    const cancelled = event.type === 'pointercancel';
    safeCaptureInkPointerEvent(event.nativeEvent, () => pointerDiagnosticData(event, { phase: cancelled ? 'cancel' : 'up', cancelled, area: 'padding' }));
    endPan(event.pointerId);
  };

  const onViewportCaptureChange = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const phase = event.type === 'lostpointercapture' ? 'lost' : 'got';
    recordPointerCaptureLifecycle(event, phase);
    if (phase === 'lost') endPan(event.pointerId);
  };

  const previewPoints = selectionDraft ?? selectionRegion?.polygon ?? null;
  const previewBounds = previewPoints ? selectionBounds(previewPoints) : null;

  return (
    <div
      ref={viewportRef}
      className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain bg-muted/40 p-3 sm:p-6"
      data-testid="ink-page-viewport"
      tabIndex={0}
      aria-label={ariaLabel}
      style={{ touchAction: PAGE_TOUCH_ACTION }}
      onPointerDown={onViewportPointerDown}
      onPointerMove={onViewportPointerMove}
      onPointerUp={onViewportPointerEnd}
      onPointerCancel={onViewportPointerEnd}
      onGotPointerCapture={onViewportCaptureChange}
      onLostPointerCapture={onViewportCaptureChange}
      onPointerDownCapture={() => callbacksRef.current.onViewportInteraction?.()}
      onWheel={() => callbacksRef.current.onViewportInteraction?.()}
      onKeyDown={(event) => {
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
          callbacksRef.current.onViewportInteraction?.();
        }
      }}
    >
      <div
        className="relative mx-auto bg-white shadow-md"
        data-testid="ink-page-surface"
        style={{
          width: pageRef.width * tool.zoom,
          height: pageRef.height * tool.zoom,
          left: tool.panX,
          top: tool.panY,
          touchAction: PAGE_TOUCH_ACTION,
        }}
      >
        <canvas
          ref={canvasRef}
          data-testid="ink-page-canvas"
          data-document-id={documentId}
          data-page-id={pageRef.page_id}
          className="absolute inset-0 block max-w-none"
          style={{ width: pageRef.width * tool.zoom, height: pageRef.height * tool.zoom, touchAction: PAGE_TOUCH_ACTION }}
          aria-label={ariaLabel}
        />
        <canvas
          ref={overlayRef}
          data-testid="ink-active-stroke-canvas"
          className="absolute inset-0 block max-w-none"
          style={{
            width: pageRef.width * tool.zoom,
            height: pageRef.height * tool.zoom,
            touchAction: PAGE_TOUCH_ACTION,
            mixBlendMode: activeStrokeRef.current?.style.tool === 'highlighter' ? 'multiply' : 'normal',
          }}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerEnter={updateEraserCursor}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onGotPointerCapture={(event) => recordPointerCaptureLifecycle(event, 'got')}
          onLostPointerCapture={onLostPointerCapture}
          onPointerLeave={() => setEraserCursor(null)}
        />
        {previewPoints && previewBounds && previewBounds.width > 0 && previewBounds.height > 0 && (
          <svg
            data-testid="ink-selection-overlay"
            aria-hidden
            className="pointer-events-none absolute inset-0 z-10"
            width={pageRef.width * tool.zoom}
            height={pageRef.height * tool.zoom}
            viewBox={`0 0 ${pageRef.width} ${pageRef.height}`}
          >
            <rect
              x={previewBounds.x}
              y={previewBounds.y}
              width={previewBounds.width}
              height={previewBounds.height}
              fill="rgba(59, 130, 246, 0.12)"
              stroke="#3b82f6"
              strokeWidth={1}
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />
            {selectionMode !== 'rectangle' && (
              <polygon
                points={previewPoints.map((point) => `${point.x},${point.y}`).join(' ')}
                fill="rgba(59, 130, 246, 0.06)"
                stroke="#3b82f6"
                strokeWidth={1}
                strokeOpacity={0.45}
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
        )}
        {erasing && eraserCursor && (
          <div
            data-testid="ink-eraser-cursor"
            aria-hidden
            className="pointer-events-none absolute z-10 rounded-full border border-foreground/60 bg-background/20"
            style={{
              left: eraserCursor.x,
              top: eraserCursor.y,
              width: Math.max(0, tool.eraserSize * tool.zoom),
              height: Math.max(0, tool.eraserSize * tool.zoom),
              transform: 'translate(-50%, -50%)',
            }}
          />
        )}
      </div>
    </div>
  );
});
