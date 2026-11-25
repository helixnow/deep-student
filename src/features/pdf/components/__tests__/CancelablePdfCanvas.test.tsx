import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFPageProxy, RenderTask } from 'pdfjs-dist';
import {
  CancelablePdfCanvas,
  PdfViewportPriorityContext,
  PdfWindowActiveContext,
  computeCanvasRenderPriorityDelayMs,
  type CancelablePdfCanvasPageContext,
} from '../CancelablePdfCanvas';
import {
  LARGE_FORMAT_MAX_CANVAS_EDGE_PX,
  LARGE_FORMAT_MAX_CANVAS_PIXELS,
} from '../../pdfViewportEnhance';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}));

interface DeferredRenderTask {
  task: RenderTask;
  cancel: ReturnType<typeof vi.fn>;
  resolve: () => void;
  reject: (err: Error) => void;
  params: Parameters<PDFPageProxy['render']>[0];
}

function createMockPage(widthPt: number, heightPt: number) {
  const tasks: DeferredRenderTask[] = [];
  let inFlight = 0;
  let maxConcurrent = 0;

  const page = {
    pageNumber: 1,
    getViewport: ({ scale, rotation = 0 }: { scale: number; rotation?: number }) => {
      const swapped = rotation % 180 !== 0;
      return {
        width: (swapped ? heightPt : widthPt) * scale,
        height: (swapped ? widthPt : heightPt) * scale,
        scale,
        rotation,
      };
    },
    render: vi.fn((params: Parameters<PDFPageProxy['render']>[0]) => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      let resolveFn!: () => void;
      let rejectFn!: (err: Error) => void;
      let settled = false;
      const promise = new Promise<void>((res, rej) => {
        resolveFn = () => {
          if (settled) return;
          settled = true;
          inFlight -= 1;
          res();
        };
        rejectFn = (err: Error) => {
          if (settled) return;
          settled = true;
          inFlight -= 1;
          rej(err);
        };
      });
      const cancel = vi.fn(() => {
        const err = new Error('Rendering cancelled');
        err.name = 'RenderingCancelledException';
        // Simulate asynchronous PDF.js cancellation settling on a microtask
        queueMicrotask(() => rejectFn(err));
      });
      const task = { promise, cancel } as unknown as RenderTask;
      const entry: DeferredRenderTask = {
        task,
        cancel,
        resolve: resolveFn,
        reject: rejectFn,
        params,
      };
      tasks.push(entry);
      return task;
    }),
  } as unknown as PDFPageProxy;

  return {
    page,
    tasks,
    getMaxConcurrent: () => maxConcurrent,
  };
}

function makePageContext(
  page: PDFPageProxy,
  overrides: Partial<CancelablePdfCanvasPageContext> = {},
): CancelablePdfCanvasPageContext {
  return {
    _className: 'react-pdf__Page',
    devicePixelRatio: 2,
    page,
    pageNumber: 1,
    rotate: 0,
    scale: 1,
    ...overrides,
  };
}

describe('CancelablePdfCanvas heavy vector / CAD lifecycle', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;

  beforeEach(() => {
    vi.useFakeTimers();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      fillRect: vi.fn(),
      clearRect: vi.fn(),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  });

  afterEach(() => {
    vi.useRealTimers();
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  it('cancels stale renderTask on zoom/page change without overlapping renders or stuck spinners', async () => {
    const mock = createMockPage(600, 800);
    const onRenderSuccess = vi.fn();
    const { rerender, unmount } = render(
      <CancelablePdfCanvas
        pageContext={makePageContext(mock.page, { scale: 1, onRenderSuccess })}
        slowRenderDelayMs={300}
      />,
    );

    // Flush startRender microtask
    await act(async () => {
      await Promise.resolve();
    });
    expect(mock.tasks).toHaveLength(1);
    expect(screen.queryByRole('status')).toBeNull();

    // After slowRenderDelayMs, non-blocking slow-page indicator appears
    act(() => {
      vi.advanceTimersByTime(320);
    });
    expect(screen.getByRole('status')).toHaveTextContent('正在渲染复杂页面…');

    // Rapid zoom change (1.0 -> 1.5 -> 2.0): previous task must be cancelled immediately
    // and intermediate stale zoom (1.5) must not overlap on the canvas
    rerender(
      <CancelablePdfCanvas
        pageContext={makePageContext(mock.page, { scale: 1.5, onRenderSuccess })}
        slowRenderDelayMs={300}
      />,
    );
    rerender(
      <CancelablePdfCanvas
        pageContext={makePageContext(mock.page, { scale: 2.0, onRenderSuccess })}
        slowRenderDelayMs={300}
      />,
    );

    expect(mock.tasks[0]!.cancel).toHaveBeenCalledTimes(1);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Only the latest render (scale=2.0) runs after task 0 settled — never overlapping!
    expect(mock.getMaxConcurrent()).toBe(1);
    const latestTask = mock.tasks[mock.tasks.length - 1]!;
    expect(latestTask.params.viewport.width).toBeGreaterThan(600);

    // Finish latest render -> spinner clears and onRenderSuccess fires once
    await act(async () => {
      latestTask.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByRole('status')).toBeNull();
    expect(onRenderSuccess).toHaveBeenCalledTimes(1);

    // Start another slow render and unmount -> must cancel active task & release canvas
    const mockPage2 = createMockPage(600, 800);
    rerender(
      <CancelablePdfCanvas
        pageContext={makePageContext(mockPage2.page, { scale: 1, pageNumber: 2 })}
        slowRenderDelayMs={300}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockPage2.tasks).toHaveLength(1);

    const canvas = document.querySelector('canvas.react-pdf__Page__canvas') as HTMLCanvasElement;
    expect(canvas).not.toBeNull();
    unmount();
    expect(mockPage2.tasks[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it('clears the loading overlay cleanly when page.render() rejects with a real error', async () => {
    const mock = createMockPage(600, 800);
    const onRenderError = vi.fn();
    render(
      <CancelablePdfCanvas
        pageContext={makePageContext(mock.page, { onRenderError })}
        slowRenderDelayMs={200}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.getByRole('status')).toBeInTheDocument();

    await act(async () => {
      mock.tasks[0]!.reject(new Error('Corrupt operator stream'));
      await Promise.resolve();
    });

    expect(screen.queryByRole('status')).toBeNull();
    expect(onRenderError).toHaveBeenCalledTimes(1);
  });

  it('caps rendered canvas pixel dimensions on massive A1 CAD blueprints at high zoom', async () => {
    // A1 landscape blueprint: 2384 x 1684 pt, zoomed so viewport is ~2860 x 2020 CSS px
    const mock = createMockPage(2384, 1684);
    render(
      <CancelablePdfCanvas
        pageContext={makePageContext(mock.page, { scale: 1.2, devicePixelRatio: 2 })}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(mock.tasks).toHaveLength(1);
    const canvas = document.querySelector('canvas.react-pdf__Page__canvas') as HTMLCanvasElement;
    expect(canvas.width).toBeLessThanOrEqual(LARGE_FORMAT_MAX_CANVAS_EDGE_PX);
    expect(canvas.height).toBeLessThanOrEqual(LARGE_FORMAT_MAX_CANVAS_EDGE_PX);
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(LARGE_FORMAT_MAX_CANVAS_PIXELS);
  });

  it('prioritizes visible viewport page ahead of overscan pages and never hides canvas indefinitely', async () => {
    expect(computeCanvasRenderPriorityDelayMs(65, 65)).toBe(0);
    expect(computeCanvasRenderPriorityDelayMs(64, 65)).toBeGreaterThan(0);
    expect(computeCanvasRenderPriorityDelayMs(63, 65)).toBeGreaterThan(
      computeCanvasRenderPriorityDelayMs(64, 65),
    );
    expect(computeCanvasRenderPriorityDelayMs(10, null)).toBe(0);

    const visibleMock = createMockPage(600, 800);
    const overscanMock = createMockPage(600, 800);
    render(
      <PdfViewportPriorityContext.Provider value={65}>
        <CancelablePdfCanvas pageContext={makePageContext(overscanMock.page, { pageNumber: 63 })} />
        <CancelablePdfCanvas pageContext={makePageContext(visibleMock.page, { pageNumber: 65 })} />
      </PdfViewportPriorityContext.Provider>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    // Visible page 65 claims the render queue immediately while overscan page 63 defers briefly
    expect(visibleMock.tasks).toHaveLength(1);
    expect(overscanMock.tasks).toHaveLength(0);

    const canvases = document.querySelectorAll('canvas.react-pdf__Page__canvas');
    expect((canvases[1] as HTMLCanvasElement).style.visibility).not.toBe('hidden');

    await act(async () => {
      vi.advanceTimersByTime(100);
      await Promise.resolve();
    });
    expect(overscanMock.tasks).toHaveLength(1);
  });

  it('preserves previous painted frame via double-buffered swap on zoom re-render', async () => {
    const drawImage = vi.fn();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      fillRect: vi.fn(),
      clearRect: vi.fn(),
      drawImage,
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    const mock = createMockPage(600, 800);
    const { rerender } = render(
      <CancelablePdfCanvas pageContext={makePageContext(mock.page, { scale: 1, pageNumber: 12 })} />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      mock.tasks[0]!.resolve();
      await Promise.resolve();
    });

    const stage = document.querySelector('.ds-pdf__canvas-stage') as HTMLElement;
    const canvas = document.querySelector('canvas.react-pdf__Page__canvas') as HTMLCanvasElement;
    expect(stage.dataset.hasFrame).toBe('true');
    expect(canvas.style.visibility).toBe('');

    // Zoom to 1.5x -> previous frame stays visible (revalidating overlay, not hidden white frame)
    rerender(
      <CancelablePdfCanvas pageContext={makePageContext(mock.page, { scale: 1.5, pageNumber: 12 })} />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(canvas.style.visibility).toBe('');
    expect(document.querySelector('.ds-pdf__page-rendering-overlay--revalidating')).not.toBeNull();
    expect(mock.tasks).toHaveLength(2);
    // Staging canvas is rendered off-DOM, not directly clobbering visible canvas before resolve
    expect(mock.tasks[1]!.params.canvas).not.toBe(canvas);

    await act(async () => {
      mock.tasks[1]!.resolve();
      await Promise.resolve();
    });
    expect(drawImage).toHaveBeenCalledTimes(1);
  });

  it('defers unpainted background window renders and cancels in-flight renders when PdfWindowActiveContext is false', async () => {
    const mock = createMockPage(2384, 1684);
    const pageCtx = makePageContext(mock.page, { scale: 1, pageNumber: 1 });

    // Mount in inactive background window: must NOT start page.render()
    const { rerender } = render(
      <PdfWindowActiveContext.Provider value={false}>
        <CancelablePdfCanvas pageContext={pageCtx} slowRenderDelayMs={200} />
      </PdfWindowActiveContext.Provider>,
    );

    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(500);
    });
    expect(mock.tasks).toHaveLength(0);
    expect(screen.queryByRole('status')).toBeNull();

    // Activate window: render starts immediately
    rerender(
      <PdfWindowActiveContext.Provider value={true}>
        <CancelablePdfCanvas pageContext={pageCtx} slowRenderDelayMs={200} />
      </PdfWindowActiveContext.Provider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(mock.tasks).toHaveLength(1);

    // Deactivate window mid-render: in-flight heavy render task must be cancelled immediately
    rerender(
      <PdfWindowActiveContext.Provider value={false}>
        <CancelablePdfCanvas pageContext={pageCtx} slowRenderDelayMs={200} />
      </PdfWindowActiveContext.Provider>,
    );
    expect(mock.tasks[0]!.cancel).toHaveBeenCalledTimes(1);

    // Re-activate window: restarts and completes cleanly
    rerender(
      <PdfWindowActiveContext.Provider value={true}>
        <CancelablePdfCanvas pageContext={pageCtx} slowRenderDelayMs={200} />
      </PdfWindowActiveContext.Provider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mock.tasks).toHaveLength(2);
    await act(async () => {
      mock.tasks[1]!.resolve();
      await Promise.resolve();
    });

    // Toggling inactive -> active after a completed frame must NOT redundantly re-render
    rerender(
      <PdfWindowActiveContext.Provider value={false}>
        <CancelablePdfCanvas pageContext={pageCtx} slowRenderDelayMs={200} />
      </PdfWindowActiveContext.Provider>,
    );
    rerender(
      <PdfWindowActiveContext.Provider value={true}>
        <CancelablePdfCanvas pageContext={pageCtx} slowRenderDelayMs={200} />
      </PdfWindowActiveContext.Provider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(mock.tasks).toHaveLength(2);
  });
});

describe('EnhancedPdfViewer narrow 420–560px split-window container CSS contract', () => {
  const cssSource = readFileSync(
    resolve(process.cwd(), 'src/features/pdf/styles/enhanced-pdf.css'),
    'utf8',
  );

  it('defines dedicated @container rules at 560px and 440px for split-window responsiveness', () => {
    expect(cssSource).toContain('@container (max-width: 560px)');
    expect(cssSource).toContain('@container (max-width: 440px)');
    expect(cssSource).toContain('max-width: calc(100cqi - 16px)');
    expect(cssSource).toContain('.ds-pdf__page-rendering-badge');
  });

  it('preserves 44px touch targets in @media (pointer: coarse) after narrow container rules', () => {
    const idx440 = cssSource.indexOf('@container (max-width: 440px)');
    const coarseAfter = cssSource.indexOf('@media (pointer: coarse)', idx440);
    expect(idx440).toBeGreaterThan(-1);
    expect(coarseAfter).toBeGreaterThan(idx440);
    const coarseTail = cssSource.slice(coarseAfter);
    expect(coarseTail).toContain('height: 44px;');
  });
});
