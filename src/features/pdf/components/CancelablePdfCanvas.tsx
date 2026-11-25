import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PDFPageProxy, RenderTask } from 'pdfjs-dist';
import { computeSafeRenderDpr } from '../pdfViewportEnhance';

/**
 * 可见视口优先页上下文：
 * 供虚拟化多页同时挂载（尤其是深页跳转）时，让当前可见页零延迟先入 PDF.js 渲染队列，
 * overscan 预渲染页短暂让行，避免被前后预加载页挤占导致目标页长时间空白。
 * 默认 null（独立挂载或单元测试下保持 0 延迟立即渲染）。
 */
export const PdfViewportPriorityContext = createContext<number | null>(null);

const OVERSCAN_PRIORITY_STEP_DELAY_MS = 24;
const MAX_OVERSCAN_PRIORITY_STEPS = 3;

export function computeCanvasRenderPriorityDelayMs(
  pageNumber: number,
  priorityPage: number | null,
): number {
  if (priorityPage === null) return 0;
  const distance = Math.abs(pageNumber - priorityPage);
  if (distance <= 0) return 0;
  return Math.min(distance, MAX_OVERSCAN_PRIORITY_STEPS) * OVERSCAN_PRIORITY_STEP_DELAY_MS;
}

/**
 * Minimal page context shape matching react-pdf's PageRenderProps.
 * Defined locally so this component never needs extra named imports from 'react-pdf'
 * (preserving compatibility with lightweight react-pdf test mocks).
 */
export interface CancelablePdfCanvasPageContext {
  _className?: string;
  canvasBackground?: string;
  devicePixelRatio?: number;
  onRenderError?: (error: Error) => void;
  onRenderSuccess?: (page: PDFPageProxy & {
    width: number;
    height: number;
    originalWidth: number;
    originalHeight: number;
  }) => void;
  page: PDFPageProxy;
  pageColors?: { background: string; foreground: string };
  pageNumber: number;
  renderForms?: boolean;
  rotate: number;
  scale: number;
}

export interface CancelablePdfCanvasProps {
  pageContext: CancelablePdfCanvasPageContext;
  /** Delay before revealing the non-blocking slow-page indicator (ms). */
  slowRenderDelayMs?: number;
}

const DEFAULT_SLOW_RENDER_DELAY_MS = 350;
// Matches pdfjs.AnnotationMode (ENABLE = 1, ENABLE_FORMS = 2) without extra runtime imports.
const ANNOTATION_MODE_ENABLE = 1;
const ANNOTATION_MODE_ENABLE_FORMS = 2;

function isCancelledRenderError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'RenderingCancelledException' || name === 'AbortException';
}

function makePageCallback(page: PDFPageProxy, scale: number) {
  const wrapped = page as PDFPageProxy & {
    width: number;
    height: number;
    originalWidth: number;
    originalHeight: number;
  };
  try {
    Object.defineProperty(wrapped, 'width', {
      get() {
        return this.getViewport({ scale }).width;
      },
      configurable: true,
    });
    Object.defineProperty(wrapped, 'height', {
      get() {
        return this.getViewport({ scale }).height;
      },
      configurable: true,
    });
    Object.defineProperty(wrapped, 'originalWidth', {
      get() {
        return this.getViewport({ scale: 1 }).width;
      },
      configurable: true,
    });
    Object.defineProperty(wrapped, 'originalHeight', {
      get() {
        return this.getViewport({ scale: 1 }).height;
      },
      configurable: true,
    });
  } catch {
    // Non-extensible test mock page object
  }
  return wrapped;
}

/**
 * Cancel-safe PDF page canvas renderer for heavy vector/CAD sheets:
 * 1. Immediately cancels stale `renderTask` on page/zoom/rotation/DPR change and awaits
 *    settlement before starting a new render on the same canvas (zero overlapping corruption).
 * 2. Caps canvas pixel dimensions per page (both edge length and total pixel area) so
 *    massive A1/A0 CAD blueprints never OOM or freeze the tab.
 * 3. Shows a subtle shimmer while rendering and a non-blocking status badge when a heavy
 *    page exceeds `slowRenderDelayMs`, clearing cleanly on completion, cancel, or error.
 */
export const CancelablePdfCanvas: React.FC<CancelablePdfCanvasProps> = ({
  pageContext,
  slowRenderDelayMs = DEFAULT_SLOW_RENDER_DELAY_MS,
}) => {
  const { t } = useTranslation(['pdf']);
  const {
    _className = 'react-pdf__Page',
    canvasBackground,
    devicePixelRatio,
    onRenderError,
    onRenderSuccess,
    page,
    pageColors,
    pageNumber,
    renderForms = false,
    rotate,
    scale,
  } = pageContext;

  const priorityPage = useContext(PdfViewportPriorityContext);
  const priorityPageRef = useRef(priorityPage);
  priorityPageRef.current = priorityPage;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const paintedPageRef = useRef<PDFPageProxy | null>(null);
  const activeTaskRef = useRef<{
    task: RenderTask;
    settled: Promise<void>;
    cancelled: boolean;
  } | null>(null);
  const renderGenRef = useRef(0);
  const onRenderSuccessRef = useRef(onRenderSuccess);
  const onRenderErrorRef = useRef(onRenderError);
  onRenderSuccessRef.current = onRenderSuccess;
  onRenderErrorRef.current = onRenderError;

  const [renderState, setRenderState] = useState<'rendering' | 'ready' | 'error'>('rendering');
  const [hasPaintedFrame, setHasPaintedFrame] = useState(false);
  const [isSlowRender, setIsSlowRender] = useState(false);

  const intrinsicViewport = useMemo(
    () => page.getViewport({ scale: 1, rotation: rotate }),
    [page, rotate],
  );

  const viewport = useMemo(
    () => page.getViewport({ scale, rotation: rotate }),
    [page, rotate, scale],
  );

  const safeDpr = useMemo(() => {
    const requested =
      devicePixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
    return computeSafeRenderDpr({
      renderWidth: viewport.width,
      renderHeight: viewport.height,
      requestedDpr: requested,
      intrinsicWidth: intrinsicViewport.width,
      intrinsicHeight: intrinsicViewport.height,
    });
  }, [
    devicePixelRatio,
    intrinsicViewport.height,
    intrinsicViewport.width,
    viewport.height,
    viewport.width,
  ]);

  const renderViewport = useMemo(
    () => page.getViewport({ scale: scale * safeDpr, rotation: rotate }),
    [page, rotate, safeDpr, scale],
  );

  const cssWidth = Math.max(1, Math.floor(viewport.width));
  const cssHeight = Math.max(1, Math.floor(viewport.height));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gen = ++renderGenRef.current;
    let disposed = false;
    let priorityTimer: number | null = null;
    const preservePreviousFrame = paintedPageRef.current === page;
    if (!preservePreviousFrame) {
      paintedPageRef.current = null;
      setHasPaintedFrame(false);
    }
    setRenderState('rendering');
    setIsSlowRender(false);

    const slowTimer = window.setTimeout(() => {
      if (!disposed && renderGenRef.current === gen) {
        setIsSlowRender(true);
      }
    }, slowRenderDelayMs);

    const cancelEntry = (entry: { task: RenderTask; cancelled: boolean } | null) => {
      if (!entry || entry.cancelled) return;
      entry.cancelled = true;
      try {
        entry.task.cancel();
      } catch {
        // Ignore cancel errors from already-settled tasks
      }
    };

    // Immediately cancel any in-flight render task for this canvas (strictly once per task).
    const previous = activeTaskRef.current;
    cancelEntry(previous);

    const startRender = async () => {
      // Wait for the cancelled task to unwind before mutating canvas dimensions or
      // calling page.render() again (prevents PDF.js "Cannot use the same canvas" errors).
      if (previous) {
        await previous.settled;
      }
      if (disposed || renderGenRef.current !== gen) return;

      const delayMs = computeCanvasRenderPriorityDelayMs(pageNumber, priorityPageRef.current);
      if (delayMs > 0) {
        await new Promise<void>((resolve) => {
          priorityTimer = window.setTimeout(() => {
            priorityTimer = null;
            resolve();
          }, delayMs);
        });
        if (disposed || renderGenRef.current !== gen) return;
      }

      const currentCanvas = canvasRef.current;
      if (!currentCanvas) return;

      const ctx = currentCanvas.getContext('2d', { alpha: false });
      if (!ctx) {
        window.clearTimeout(slowTimer);
        if (!disposed && renderGenRef.current === gen) {
          setIsSlowRender(false);
          setRenderState('error');
        }
        return;
      }

      const pixelWidth = Math.max(1, Math.floor(renderViewport.width));
      const pixelHeight = Math.max(1, Math.floor(renderViewport.height));
      currentCanvas.style.width = `${cssWidth}px`;
      currentCanvas.style.height = `${cssHeight}px`;

      // 当同一页已有已绘制帧（例如缩放 / DPR 切换）且支持 drawImage 时，使用离屏双缓冲画布渲染，
      // 期间保留上一帧可见画面（CSS 缩放到新尺寸），完成后原子换帧，避免重绘白闪。
      let stagingCanvas: HTMLCanvasElement | null = null;
      let targetCanvas: HTMLCanvasElement = currentCanvas;
      let targetCtx: CanvasRenderingContext2D = ctx;
      const canDoubleBuffer =
        preservePreviousFrame &&
        currentCanvas.width > 0 &&
        currentCanvas.height > 0 &&
        typeof ctx.drawImage === 'function' &&
        typeof document !== 'undefined';

      if (canDoubleBuffer) {
        const offscreen = document.createElement('canvas');
        offscreen.width = pixelWidth;
        offscreen.height = pixelHeight;
        const offCtx = offscreen.getContext('2d', { alpha: false });
        if (offCtx) {
          stagingCanvas = offscreen;
          targetCanvas = offscreen;
          targetCtx = offCtx;
        }
      }

      if (!stagingCanvas) {
        currentCanvas.width = pixelWidth;
        currentCanvas.height = pixelHeight;
      }
      // 绝不把 canvas 设为 visibility: hidden 后长期悬空；未首帧绘完前由可见 shimmer 遮罩覆盖
      currentCanvas.style.visibility = '';

      const releaseStaging = () => {
        if (stagingCanvas) {
          stagingCanvas.width = 0;
          stagingCanvas.height = 0;
          stagingCanvas = null;
        }
      };

      const renderContext: Parameters<PDFPageProxy['render']>[0] = {
        annotationMode: renderForms ? ANNOTATION_MODE_ENABLE_FORMS : ANNOTATION_MODE_ENABLE,
        canvas: targetCanvas,
        canvasContext: targetCtx,
        viewport: renderViewport,
        ...(canvasBackground ? { background: canvasBackground } : {}),
        ...(pageColors ? { pageColors } : {}),
      };

      let task: RenderTask;
      try {
        task = page.render(renderContext);
      } catch (err) {
        releaseStaging();
        window.clearTimeout(slowTimer);
        if (!disposed && renderGenRef.current === gen) {
          setIsSlowRender(false);
          if (!isCancelledRenderError(err)) {
            setRenderState('error');
            onRenderErrorRef.current?.(err instanceof Error ? err : new Error(String(err)));
          }
        }
        return;
      }

      const settled = task.promise.then(
        () => undefined,
        () => undefined,
      );
      const entry = { task, settled, cancelled: false };
      activeTaskRef.current = entry;

      try {
        await task.promise;
        window.clearTimeout(slowTimer);
        if (activeTaskRef.current === entry) {
          activeTaskRef.current = null;
        }
        if (disposed || renderGenRef.current !== gen) {
          releaseStaging();
          return;
        }
        if (stagingCanvas) {
          currentCanvas.width = pixelWidth;
          currentCanvas.height = pixelHeight;
          ctx.drawImage(stagingCanvas, 0, 0);
          releaseStaging();
        }
        paintedPageRef.current = page;
        currentCanvas.style.visibility = '';
        setHasPaintedFrame(true);
        setIsSlowRender(false);
        setRenderState('ready');
        onRenderSuccessRef.current?.(makePageCallback(page, scale));
      } catch (err) {
        releaseStaging();
        window.clearTimeout(slowTimer);
        if (activeTaskRef.current === entry) {
          activeTaskRef.current = null;
        }
        if (disposed || renderGenRef.current !== gen || isCancelledRenderError(err)) {
          return;
        }
        setIsSlowRender(false);
        setRenderState('error');
        onRenderErrorRef.current?.(err instanceof Error ? err : new Error(String(err)));
      }
    };

    void startRender();

    return () => {
      disposed = true;
      renderGenRef.current += 1;
      window.clearTimeout(slowTimer);
      if (priorityTimer !== null) {
        window.clearTimeout(priorityTimer);
      }
      cancelEntry(activeTaskRef.current);
    };
  }, [
    canvasBackground,
    cssHeight,
    cssWidth,
    page,
    pageColors,
    pageNumber,
    renderForms,
    renderViewport,
    scale,
    slowRenderDelayMs,
  ]);

  // Release GPU backing buffer on unmount
  useEffect(() => {
    const canvas = canvasRef.current;
    return () => {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }, []);

  return (
    <div
      className="ds-pdf__canvas-stage"
      data-render-state={renderState}
      data-has-frame={hasPaintedFrame ? 'true' : 'false'}
      style={{ width: `${cssWidth}px`, height: `${cssHeight}px` }}
    >
      <canvas
        ref={canvasRef}
        className={`${_className}__canvas`}
        dir="ltr"
        style={{
          display: 'block',
          width: `${cssWidth}px`,
          height: `${cssHeight}px`,
          userSelect: 'none',
        }}
      />
      {renderState === 'rendering' && (
        <div
          className={`ds-pdf__page-rendering-overlay${hasPaintedFrame ? ' ds-pdf__page-rendering-overlay--revalidating' : ''}${isSlowRender ? ' ds-pdf__page-rendering-overlay--slow' : ''}`}
          aria-hidden={!isSlowRender}
        >
          {isSlowRender && (
            <div
              className="ds-pdf__page-rendering-badge"
              role="status"
              aria-live="polite"
            >
              <span className="ds-pdf__page-rendering-spinner" aria-hidden="true" />
              <span>
                {t('pdf:page_rendering_slow', {
                  page: pageNumber,
                  defaultValue: '正在渲染复杂页面…',
                })}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/** Stable module-level render prop for `<MemoPage renderMode="none">` to preserve React.memo. */
export function renderCancelablePdfCanvas(pageContext: CancelablePdfCanvasPageContext) {
  return <CancelablePdfCanvas pageContext={pageContext} />;
}

export default CancelablePdfCanvas;
