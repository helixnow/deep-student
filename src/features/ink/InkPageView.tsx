import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { objectHitTest, screenToPage } from './geometry';
import { collectPointerSamples } from './input';
import { renderInkPage } from './renderer';
import type { InkObject, InkPage, InkPageRef, InkSample, InkStrokeStyle } from './types';

export interface InkToolSettings extends InkStrokeStyle {
  touchDrawing: boolean;
  zoom: number;
  panX: number;
  panY: number;
}

export interface InkPageViewHandle {
  finishStroke(): Promise<void>;
  eraseAt(point: { x: number; y: number }): Promise<void>;
}

export interface InkPageViewProps {
  documentId: string;
  pageRef: InkPageRef;
  page: InkPage;
  background?: CanvasImageSource;
  tool: InkToolSettings;
  erasing: boolean;
  onPageChange(page: InkPage): Promise<void>;
  onActiveStrokeChange?(active: boolean): void;
  ariaLabel: string;
}

interface ActiveStroke {
  pointerId: number;
  startedAt: number;
  pointerType: string;
  samples: InkSample[];
  style: InkStrokeStyle;
}

const makeObjectId = (): string => globalThis.crypto?.randomUUID?.()
  ?? `ink-object-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const InkPageView = forwardRef<InkPageViewHandle, InkPageViewProps>(function InkPageView(
  { documentId, pageRef, page, background, tool, erasing, onPageChange, onActiveStrokeChange, ariaLabel },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const activeStrokeRef = useRef<ActiveStroke | null>(null);
  const callbacksRef = useRef({ onPageChange, onActiveStrokeChange });
  const currentRef = useRef({ pageRef, page, background, tool, erasing });
  callbacksRef.current = { onPageChange, onActiveStrokeChange };
  currentRef.current = { pageRef, page, background, tool, erasing };

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

  const finishStroke = async () => {
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

  const eraseAt = async (point: { x: number; y: number }) => {
    const current = currentRef.current;
    for (let index = current.page.objects.length - 1; index >= 0; index -= 1) {
      if (objectHitTest(current.page.objects[index], point, 8)) {
        const nextPage = { ...current.page, objects: current.page.objects.filter((_, objectIndex) => objectIndex !== index) };
        currentRef.current = { ...current, page: nextPage };
        await callbacksRef.current.onPageChange(nextPage);
        return;
      }
    }
  };

  const finishStrokeRef = useRef(finishStroke);
  const eraseAtRef = useRef(eraseAt);
  const renderPageRef = useRef(render);
  const renderActiveStrokeRef = useRef(renderActiveStroke);
  finishStrokeRef.current = finishStroke;
  eraseAtRef.current = eraseAt;
  renderPageRef.current = render;
  renderActiveStrokeRef.current = renderActiveStroke;
  useImperativeHandle(ref, () => ({
    finishStroke: () => finishStrokeRef.current(),
    eraseAt: (point) => eraseAtRef.current(point),
  }), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;
    renderPageRef.current(canvas, page);
    if (activeStrokeRef.current) renderActiveStrokeRef.current();
  }, [pageRef, page, background, tool.zoom]);

  useEffect(() => () => {
    if (activeStrokeRef.current) void finishStrokeRef.current();
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

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const current = currentRef.current;
    if (activeStrokeRef.current || (event.pointerType === 'touch' && !current.tool.touchDrawing)) return;
    if (event.pointerType === 'touch') event.preventDefault();
    const point = screenToPage({ x: event.clientX, y: event.clientY }, viewport(event.currentTarget));
    if (current.erasing) {
      void eraseAtRef.current(point);
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
    const active = activeStrokeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    active.samples.push(...samplesFor(event, active));
    renderActiveStroke();
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const active = activeStrokeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    active.samples.push(...samplesFor(event, active, true));
    void finishStroke();
  };

  return (
    <div className="overflow-auto overscroll-contain" data-testid="ink-page-viewport">
      <div
        className="relative mx-auto"
        data-testid="ink-page-surface"
        style={{
          width: pageRef.width * tool.zoom,
          height: pageRef.height * tool.zoom,
          left: tool.panX,
          top: tool.panY,
          touchAction: tool.touchDrawing ? 'none' : 'pan-x pan-y',
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
            touchAction: tool.touchDrawing ? 'none' : 'pan-x pan-y',
            mixBlendMode: activeStrokeRef.current?.style.tool === 'highlighter' ? 'multiply' : 'normal',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>
    </div>
  );
});
