import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { objectHitTest, objectHitTestSweep, screenToPage } from './geometry';
import { collectPointerSamples } from './input';
import { renderInkPage } from './renderer';
import { selectionBounds } from './selection';
import type { InkObject, InkPage, InkPageRef, InkPoint, InkRect, InkSample, InkStrokeStyle } from './types';

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
  }, [documentId, pageRef.page_id]);

  const render = (target: HTMLCanvasElement, page: InkPage, transparent = false) => {
    const current = currentRef.current;
    const scale = Math.min(current.tool.zoom, Math.sqrt(16_000_000 / (current.pageRef.width * current.pageRef.height)));
    return renderInkPage(target, current.pageRef, page, {
      background: transparent ? undefined : current.background,
      scale,
      max_pixels: 16_000_000,
      transparent,
    });
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
    activeStrokeRef.current = null;
    callbacksRef.current.onActiveStrokeChange?.(false);
    renderActiveStroke();
    if (!active.samples.length) return;

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
    await callbacksRef.current.onPageChange(nextPage);
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

  const samplesFor = (event: React.PointerEvent<HTMLCanvasElement>, active: ActiveStroke, terminal = false) => {
    const element = canvasRef.current;
    if (!element) return [];
    return collectPointerSamples(event.nativeEvent, viewport(element), active.startedAt,
      active.pointerType === 'pen' && currentRef.current.tool.pressure_enabled, {
        terminal,
        cancelled: event.type === 'pointercancel',
        pageBounds: { width: currentRef.current.pageRef.width, height: currentRef.current.pageRef.height },
      });
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
    const selectionTouch = event.pointerType === 'touch' && current.selectionMode !== 'none';
    if (activeStrokeRef.current || eraserGestureRef.current || selectionGestureRef.current
      || (event.pointerType === 'touch' && !current.tool.touchDrawing && !selectionTouch)) return;
    if (event.pointerType === 'touch') event.preventDefault();
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
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Synthetic input may not support capture. */ }
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
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Synthetic input may not support capture. */ }
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
    active.samples.push(...samplesFor(event, active));
    activeStrokeRef.current = active;
    callbacksRef.current.onActiveStrokeChange?.(true);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Synthetic input may not support capture. */ }
    renderActiveStroke();
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
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
    active.samples.push(...samplesFor(event, active));
    renderActiveStroke();
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const selection = selectionGestureRef.current;
    if (selection && selection.pointerId === event.pointerId) {
      const cancelled = event.type === 'pointercancel';
      if (!cancelled) {
        const point = selectionPoint(event);
        const previous = selection.points[selection.points.length - 1];
        if (!previous || previous.x !== point.x || previous.y !== point.y) {
          selection.points.push(point);
        }
      }
      finalizeSelectionGesture(cancelled);
      return;
    }
    const gesture = eraserGestureRef.current;
    if (gesture && gesture.pointerId === event.pointerId) {
      if (event.type !== 'pointercancel') {
        const point = screenToPage({ x: event.clientX, y: event.clientY }, viewport(event.currentTarget));
        collectEraserHits(gesture, gesture.lastPoint, point);
        gesture.lastPoint = point;
        renderEraserPreview();
      }
      void finishEraserGesture().catch((error) => callbacksRef.current.onError?.(error));
      return;
    }
    const active = activeStrokeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    active.samples.push(...samplesFor(event, active, true));
    void finishStroke().catch((error) => callbacksRef.current.onError?.(error));
  };

  const previewPoints = selectionDraft ?? selectionRegion?.polygon ?? null;
  const previewBounds = previewPoints ? selectionBounds(previewPoints) : null;
  const canvasTouchAction = tool.touchDrawing || selectionMode !== 'none' ? 'none' : 'pan-x pan-y';

  return (
    <div
      ref={viewportRef}
      className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain bg-muted/40 p-3 sm:p-6"
      data-testid="ink-page-viewport"
      tabIndex={0}
      aria-label={ariaLabel}
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
          touchAction: canvasTouchAction,
        }}
      >
        <canvas
          ref={canvasRef}
          data-testid="ink-page-canvas"
          data-document-id={documentId}
          data-page-id={pageRef.page_id}
          className="absolute inset-0 block max-w-none"
          style={{ width: pageRef.width * tool.zoom, height: pageRef.height * tool.zoom }}
          aria-label={ariaLabel}
        />
        <canvas
          ref={overlayRef}
          data-testid="ink-active-stroke-canvas"
          className="absolute inset-0 block max-w-none touch-pan-y"
          style={{
            width: pageRef.width * tool.zoom,
            height: pageRef.height * tool.zoom,
            touchAction: canvasTouchAction,
            mixBlendMode: activeStrokeRef.current?.style.tool === 'highlighter' ? 'multiply' : 'normal',
          }}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerEnter={updateEraserCursor}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
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
